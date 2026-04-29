#!/usr/bin/env python3
"""Seed the prod feed with N tracks per genre, rendered locally on this Mac.

Per-track pipeline (one job = one track, run inside a worker pool):
  1. POST /api/generate     (local) — compose project from genre+seed
  2. POST /api/project-share (local) — seal envelope (with macrosDisabled +
                                       autoDj.run=false baked in) and
                                       mirror to prod
  3. GET  /audio/{cid}.webm  (local) — chromedp realtime render, served back
  4. PUT  /audio/{cid}.webm  (prod)  — upload the .webm so the feed picks it up

Stages 1+2 share one local-server lock (/api/generate mutates the in-memory
project, so two parallel generates would race). Stage 3 (the heavy bit) runs
fully parallel up to --workers, since each render is its own chromedp tab
and the local server is wired with -audio-concurrent N.

Local server requirements:
  ./beats-bitwrap-io -authoring -audio-render -audio-concurrent 4 \\
      -addr :18090 -data /tmp/beats-seed-data

Throttling: prod enforces 10 PUT/min/IP; we send 2 PUTs per track (envelope
mirror + .webm upload). Throttles run independently for each.

Macros: by default we bake macrosDisabled into the envelope so any Mute/Tempo
macro stays off — the seed batch sounds clean. Auto-DJ stays disengaged via
autoDj.run=false. Override with --enable-macro <id> ... or --no-disable.

Usage:
  ./scripts/seed-feed.py
  ./scripts/seed-feed.py --per-genre 3 --workers 4
  ./scripts/seed-feed.py --upload-host https://staging.example.com
  ./scripts/seed-feed.py --dry-run --genres techno house dnb
  ./scripts/seed-feed.py --no-disable               # don't bake macrosDisabled
"""
import argparse
import concurrent.futures
import json
import sys
import threading
import time
import urllib.error
import urllib.request

GENRES = [
    "ambient", "blues", "bossa", "country", "dnb", "dubstep", "edm",
    "funk", "garage", "house", "jazz", "lofi", "metal", "reggae",
    "speedcore", "synthwave", "techno", "trance", "trap",
]

# Mute and tempo macros distort the listening experience for a curated
# seed batch — drops, breakdowns, half-time, tape-stop all introduce
# silences or pitch artifacts that aren't appropriate for "background
# feed" tracks. Bake these into macrosDisabled so even if a listener
# engages Auto-DJ later they stay off.
DEFAULT_DISABLED_MACROS = [
    # Mute group
    "drop", "breakdown", "solo-drums", "cut", "beat-repeat", "double-drop",
    # Tempo group
    "half-time", "tape-stop", "tempo-anchor",
]


# Deterministic per-genre seeds — keeps re-runs idempotent (same CIDs).
def seeds_for(genre: str, n: int) -> list[int]:
    base = sum(ord(c) for c in genre) * 1000
    return [base + i for i in range(n)]


def http(method: str, url: str, body: bytes | None = None,
         headers: dict | None = None, timeout: float = 600) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, method=method,
                                 headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read() if e.fp else b""


def post_json(url: str, payload: dict, timeout: float = 60) -> tuple[int, dict]:
    body = json.dumps(payload).encode()
    code, raw = http("POST", url, body, {"Content-Type": "application/json"},
                     timeout=timeout)
    try:
        return code, json.loads(raw or b"{}")
    except json.JSONDecodeError:
        return code, {"_raw": raw.decode("utf-8", "replace")}


class Throttle:
    """Per-target rate limiter: at most `n` events per `period_s`."""
    def __init__(self, n: int, period_s: float):
        self.n = n
        self.period = period_s
        self.events: list[float] = []
        self.lock = threading.Lock()

    def acquire(self):
        with self.lock:
            now = time.monotonic()
            self.events = [t for t in self.events if now - t < self.period]
            if len(self.events) >= self.n:
                wait = self.period - (now - self.events[0]) + 0.05
                time.sleep(max(0, wait))
                now = time.monotonic()
                self.events = [t for t in self.events if now - t < self.period]
            self.events.append(time.monotonic())


def process_track(local: str, upload: str, genre: str, seed: int,
                  disabled_macros: list[str], no_auto_dj: bool,
                  generate_lock: threading.Lock,
                  seal_throttle: Throttle, audio_throttle: Throttle,
                  dry_run: bool, rebuild_secret: str = "") -> dict | None:
    if dry_run:
        print(f"  [dry] {genre:<10} seed={seed:<6}")
        return {"genre": genre, "seed": seed, "cid": None, "ok": True}

    # Stage 1+2: generate must hold the local lock because /api/generate
    # mutates the server's in-memory project (two parallel generates
    # would race and one would seal the other's project).
    payload_share = {"mirror": [upload]}
    if disabled_macros:
        payload_share["macrosDisabled"] = disabled_macros
    if no_auto_dj:
        payload_share["autoDj"] = {"run": False}

    with generate_lock:
        code, _ = post_json(f"{local}/api/generate",
                           {"genre": genre, "params": {"seed": seed}})
        if code != 200:
            print(f"  ! generate {genre}/{seed} HTTP {code}", file=sys.stderr)
            return None
        seal_throttle.acquire()
        code, body = post_json(f"{local}/api/project-share", payload_share)
        if code != 200:
            print(f"  ! project-share {genre}/{seed} HTTP {code}: {body}",
                  file=sys.stderr)
            return None

    cid = body.get("cid")
    mirrors = body.get("mirrors") or []
    mirror_status = mirrors[0].get("status") if mirrors else "?"
    print(f"  ✓ sealed   {genre:<10} seed={seed:<6} cid={cid[:14]}…  mirror={mirror_status}")

    # Stage 3: render (parallel — heavy work, separate chromedp tab per call).
    t0 = time.monotonic()
    code, webm = http("GET", f"{local}/audio/{cid}.webm",
                      headers={"Accept": "audio/webm"}, timeout=900)
    if code != 200:
        print(f"  ! local render {cid} HTTP {code}", file=sys.stderr)
        return None
    render_s = time.monotonic() - t0

    # Stage 4: upload to prod (throttled — separate budget from seal).
    audio_throttle.acquire()
    audio_headers = {"Content-Type": "audio/webm"}
    if rebuild_secret:
        audio_headers["X-Rebuild-Secret"] = rebuild_secret
    code, body = http("PUT", f"{upload}/audio/{cid}.webm", webm,
                      audio_headers, timeout=120)
    if code not in (200, 201):
        print(f"  ! prod audio PUT {cid} HTTP {code}: "
              f"{body[:200].decode('utf-8', 'replace')}", file=sys.stderr)
        return {"genre": genre, "seed": seed, "cid": cid, "ok": False}
    print(f"  ✓ uploaded {genre:<10} seed={seed:<6} cid={cid[:14]}…  "
          f"render={render_s:.1f}s  bytes={len(webm):,}")
    return {"genre": genre, "seed": seed, "cid": cid, "ok": True}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--local-host", default="http://localhost:18090",
                    help="Local authoring server with -audio-render enabled")
    ap.add_argument("--upload-host", default="https://beats.bitwrap.io",
                    help="Prod host to receive envelopes + .webm")
    ap.add_argument("--per-genre", type=int, default=3,
                    help="Tracks per genre (default 3)")
    ap.add_argument("--genres", nargs="+", help="Subset of genres (default: all 19)")
    ap.add_argument("--workers", type=int, default=4,
                    help="Concurrent track jobs (match -audio-concurrent)")
    ap.add_argument("--no-disable", action="store_true",
                    help="Don't bake macrosDisabled into envelopes")
    ap.add_argument("--enable-macro", action="append", default=[],
                    help="Allow this macro id (remove from disabled list). Repeatable.")
    ap.add_argument("--no-auto-dj-off", action="store_true",
                    help="Don't bake autoDj.run=false (default: bakes it)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--rebuild-secret", default="",
                    help="X-Rebuild-Secret to bypass first-write-wins on the audio "
                         "PUT — required when re-seeding deterministic CIDs whose "
                         ".webm already exists on prod (e.g. recovering from a "
                         "broken render path). Read from stdin if value is '-'.")
    args = ap.parse_args()
    if args.rebuild_secret == "-":
        args.rebuild_secret = sys.stdin.readline().strip()

    genres = args.genres or GENRES
    plan = [(g, s) for g in genres for s in seeds_for(g, args.per_genre)]

    if args.no_disable:
        disabled = []
    else:
        disabled = [m for m in DEFAULT_DISABLED_MACROS if m not in args.enable_macro]

    print(f"Plan:    {len(plan)} tracks ({len(genres)} genres × {args.per_genre})")
    print(f"Local:   {args.local_host}")
    print(f"Upload:  {args.upload_host}")
    print(f"Workers: {args.workers}")
    if disabled:
        print(f"Disabled macros: {', '.join(disabled)}")
    if not args.no_auto_dj_off:
        print("Auto-DJ: baked off (autoDj.run=false)")
    print()

    # /api/generate touches in-memory state on the local server, so it
    # has to be serialized. Audio renders are parallel-safe (chromedp
    # gives each its own tab; the server semaphore caps concurrency).
    generate_lock = threading.Lock()
    # Two prod budgets: envelope mirror PUTs and audio PUTs. Both
    # share the same 10 PUT/min/IP cap on prod, so the budgets must
    # sum to ≤ 10/min — not 10/min each. 4/min × 2 = 8/min combined,
    # 20% headroom under the cap. The 8-worker run on 04-28 hit 429s
    # at the prior 8/min/budget setting because the budgets aren't
    # coordinated and a burst could send 16 PUTs in under a minute.
    seal_throttle  = Throttle(n=4, period_s=60)
    audio_throttle = Throttle(n=4, period_s=60)

    print(f"== Seeding {len(plan)} tracks ({args.workers} workers) ==")
    results: list[dict] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = [
            pool.submit(process_track,
                        args.local_host, args.upload_host, g, s,
                        disabled, not args.no_auto_dj_off,
                        generate_lock, seal_throttle, audio_throttle,
                        args.dry_run, args.rebuild_secret)
            for (g, s) in plan
        ]
        for fut in concurrent.futures.as_completed(futs):
            r = fut.result()
            if r:
                results.append(r)

    ok = sum(1 for r in results if r.get("ok"))
    print()
    print(f"Done. {ok}/{len(plan)} tracks uploaded.")
    if ok < len(plan):
        sys.exit(1)


if __name__ == "__main__":
    main()
