#!/usr/bin/env python3
"""Seed the prod feed with N tracks per genre, rendered locally on this Mac.

Pipeline per track:
  1. POST /api/generate     (local) — compose project from genre+seed
  2. POST /api/project-share (local) — seal + mirror envelope to prod
  3. GET  /audio/{cid}.webm  (local) — chromedp realtime render, served back
  4. PUT  /audio/{cid}.webm  (prod)  — upload the .webm so the feed picks it up

Local server requirements:
  ./beats-bitwrap-io -authoring -audio-render -audio-concurrent 4 \\
      -addr :18090 -data /tmp/beats-seed-data

Throttling: prod enforces 10 PUT/min/IP; we send 2 PUTs per track. Stage 1
seals run serially with a delay; stage 2 audio uploads run after their local
render finishes (each render is realtime, ≥30s) so they self-pace below the
limit. Use --dry-run first to confirm what will be sent.

Usage:
  ./scripts/seed-feed.py
  ./scripts/seed-feed.py --per-genre 3 --workers 4
  ./scripts/seed-feed.py --upload-host https://staging.example.com
  ./scripts/seed-feed.py --dry-run --genres techno house dnb
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
    """Simple per-IP rate limiter: at most `n` events per `period_s`."""
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


def seal_and_mirror(local: str, upload: str, genre: str, seed: int,
                    dry_run: bool) -> str | None:
    if dry_run:
        print(f"  [dry] generate {genre}/{seed}")
        return None

    code, _ = post_json(f"{local}/api/generate",
                       {"genre": genre, "params": {"seed": seed}})
    if code != 200:
        print(f"  ! generate {genre}/{seed} HTTP {code}", file=sys.stderr)
        return None

    code, body = post_json(f"{local}/api/project-share",
                          {"mirror": [upload]})
    if code != 200:
        print(f"  ! project-share {genre}/{seed} HTTP {code}: {body}",
              file=sys.stderr)
        return None

    cid = body.get("cid")
    mirrors = body.get("mirrors") or []
    mirror_status = mirrors[0].get("status") if mirrors else "?"
    print(f"  ✓ {genre:<10} seed={seed:<6} cid={cid}  mirror={mirror_status}")
    return cid


def render_and_upload(local: str, upload: str, cid: str, genre: str,
                      seed: int, throttle: Throttle, dry_run: bool) -> bool:
    if dry_run:
        print(f"  [dry] render+upload {cid}")
        return True

    # Local GET blocks until chromedp render completes.
    t0 = time.monotonic()
    code, webm = http("GET", f"{local}/audio/{cid}.webm",
                      headers={"Accept": "audio/webm"}, timeout=900)
    if code != 200:
        print(f"  ! local render {cid} HTTP {code}", file=sys.stderr)
        return False
    render_s = time.monotonic() - t0

    throttle.acquire()
    code, body = http("PUT", f"{upload}/audio/{cid}.webm", webm,
                      {"Content-Type": "audio/webm"}, timeout=120)
    if code not in (200, 201):
        print(f"  ! prod audio PUT {cid} HTTP {code}: "
              f"{body[:200].decode('utf-8', 'replace')}", file=sys.stderr)
        return False
    print(f"  ✓ {genre:<10} seed={seed:<6} cid={cid[:14]}…  "
          f"render={render_s:.1f}s  bytes={len(webm):,}")
    return True


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
                    help="Concurrent audio renders (match -audio-concurrent)")
    ap.add_argument("--seal-delay", type=float, default=7.0,
                    help="Seconds between seal+mirror calls (rate-limit pacing)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    genres = args.genres or GENRES
    plan = [(g, s) for g in genres for s in seeds_for(g, args.per_genre)]
    print(f"Plan: {len(plan)} tracks ({len(genres)} genres × {args.per_genre})")
    print(f"Local:  {args.local_host}")
    print(f"Upload: {args.upload_host}")
    print()

    # Stage 1: seal + mirror (serial, paced).
    print("== Stage 1: seal envelopes + mirror to prod ==")
    pairs: list[tuple[str, int, str]] = []
    last_seal = 0.0
    for genre, seed in plan:
        elapsed = time.monotonic() - last_seal
        if elapsed < args.seal_delay:
            time.sleep(args.seal_delay - elapsed)
        cid = seal_and_mirror(args.local_host, args.upload_host,
                              genre, seed, args.dry_run)
        last_seal = time.monotonic()
        if cid:
            pairs.append((genre, seed, cid))

    if args.dry_run or not pairs:
        return

    # Stage 2: render locally + upload .webm to prod (parallel, throttled).
    print()
    print(f"== Stage 2: render audio + upload ({args.workers} workers) ==")
    audio_throttle = Throttle(n=8, period_s=60)  # leave 2/min headroom
    failures = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = [pool.submit(render_and_upload, args.local_host,
                           args.upload_host, cid, g, s, audio_throttle, False)
                for (g, s, cid) in pairs]
        for fut in concurrent.futures.as_completed(futs):
            if not fut.result():
                failures += 1

    print()
    print(f"Done. {len(pairs) - failures}/{len(pairs)} tracks uploaded.")
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
