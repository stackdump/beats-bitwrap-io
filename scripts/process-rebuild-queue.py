#!/usr/bin/env python3
"""Process the rebuild queue exposed by a beats-bitwrap-io server
running with -rebuild-queue.

Loop:
  1. GET   {remote}/api/rebuild-queue            — list of CIDs to redo
  2. GET   {remote}/o/{cid}                      — pull canonical envelope
  3. PUT   {local}/o/{cid}                       — seal locally
  4. GET   {local}/audio/{cid}.webm              — chromedp realtime render
  5. PUT   {remote}/audio/{cid}.webm             — replace broken audio
  6. POST  {remote}/api/rebuild-clear {cid}      — drop the queue row

The local server must be started with -audio-render so the GET in step 4
actually runs chromedp. Recommended:

  ./beats-bitwrap-io -authoring -audio-render -audio-auto-enqueue=false \\
      -audio-concurrent 2 -audio-max-duration 6m -audio-render-timeout 15m \\
      -addr :18090 -data /tmp/beats-worker-data

Refuses to upload anything below --min-bytes (default 50 kB) so the
race that produced the original 110-byte stubs can't overwrite a good
file with another bad one.

Usage:
  ./scripts/process-rebuild-queue.py                       # one-shot
  ./scripts/process-rebuild-queue.py --watch               # poll forever
  ./scripts/process-rebuild-queue.py --watch --interval 60
  ./scripts/process-rebuild-queue.py --remote https://staging.example.com
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request


def http(method, url, body=None, headers=None, timeout=900):
    req = urllib.request.Request(url, data=body, method=method,
                                 headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read() if e.fp else b""


def fetch_queue(remote: str) -> list[str]:
    code, body = http("GET", f"{remote}/api/rebuild-queue?limit=200", timeout=30)
    if code != 200:
        print(f"  ! queue HTTP {code}", file=sys.stderr)
        return []
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return []


def fetch_archive_missing(remote: str, limit: int = 200) -> tuple[list[str], dict]:
    """Return (cids, stats) for share-store CIDs that have no audio yet."""
    code, body = http("GET", f"{remote}/api/archive-missing?limit={limit}", timeout=30)
    if code != 200:
        print(f"  ! archive-missing HTTP {code}", file=sys.stderr)
        return [], {}
    try:
        payload = json.loads(body)
        return payload.get("missing", []), {
            "totalShares": payload.get("totalShares", 0),
            "totalAudio":  payload.get("totalAudio", 0),
            "truncated":   payload.get("truncated", False),
        }
    except json.JSONDecodeError:
        return [], {}


def post_rebuild_clear(remote: str, cid: str) -> None:
    """Best-effort clear; archive mode skips this since archive CIDs
    were never enqueued, so there's no row to drop."""
    pass


def process_one(cid: str, local: str, remote: str, min_bytes: int,
                rebuild_secret: str = "") -> bool:
    print(f"--- {cid}")
    code, envelope = http("GET", f"{remote}/o/{cid}", timeout=30)
    if code != 200 or not envelope:
        print(f"  ! prod GET envelope HTTP {code}", file=sys.stderr)
        return False
    code, _ = http("PUT", f"{local}/o/{cid}", envelope,
                   {"Content-Type": "application/ld+json"}, timeout=30)
    if code not in (200, 201):
        print(f"  ! local seal HTTP {code}", file=sys.stderr)
        return False
    t0 = time.monotonic()
    code, webm = http("GET", f"{local}/audio/{cid}.webm", timeout=900)
    if code != 200:
        print(f"  ! local render HTTP {code}", file=sys.stderr)
        return False
    render_s = time.monotonic() - t0
    if len(webm) < min_bytes:
        print(f"  ! render produced {len(webm)} bytes (< {min_bytes}) — refusing upload",
              file=sys.stderr)
        return False
    print(f"  render: {render_s:.1f}s, {len(webm):,} bytes")
    headers = {"Content-Type": "audio/webm"}
    if rebuild_secret:
        headers["X-Rebuild-Secret"] = rebuild_secret
    code, body = http("PUT", f"{remote}/audio/{cid}.webm", webm,
                      headers, timeout=120)
    if code not in (200, 201):
        print(f"  ! remote PUT HTTP {code}: {body[:200].decode('utf-8','replace')}",
              file=sys.stderr)
        return False
    code, _ = http("POST", f"{remote}/api/rebuild-clear",
                   json.dumps({"cid": cid}).encode(),
                   {"Content-Type": "application/json"}, timeout=15)
    if code not in (200, 201):
        print(f"  ! clear HTTP {code} (remote will re-list this CID next poll)",
              file=sys.stderr)
        # Don't fail overall — the audio is up; the queue row is cosmetic.
    print(f"  ✓ rebuilt + cleared")
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--local", default="http://localhost:18090",
                    help="Local authoring server (-audio-render required)")
    ap.add_argument("--remote", default="https://beats.bitwrap.io",
                    help="Remote host running -rebuild-queue")
    ap.add_argument("--min-bytes", type=int, default=50_000,
                    help="Reject local renders smaller than this (default 50 kB)")
    ap.add_argument("--watch", action="store_true",
                    help="Poll the queue forever instead of one-shot")
    ap.add_argument("--interval", type=float, default=30.0,
                    help="Seconds between polls in --watch mode (default 30)")
    ap.add_argument("--secret",
                    help="X-Rebuild-Secret header value (overrides BEATS_REBUILD_SECRET env). "
                         "Reads from data/.rebuild-secret on the server.")
    ap.add_argument("--archive", action="store_true",
                    help="Archive mode: drive renders for every share-store CID that "
                         "has no audio yet (sweeps /api/archive-missing). Use with "
                         "--watch to keep the catalogue caught up as new shares arrive.")
    ap.add_argument("--archive-limit", type=int, default=200,
                    help="Page size for /api/archive-missing in --archive mode (default 200)")
    args = ap.parse_args()

    rebuild_secret = (args.secret or os.environ.get("BEATS_REBUILD_SECRET", "")).strip()
    if rebuild_secret:
        print(f"auth: X-Rebuild-Secret set ({len(rebuild_secret)} chars) — overwrites enabled")
    else:
        print("auth: no secret — uploads will fall under first-write-wins (won't replace stuck audio)")

    while True:
        if args.archive:
            cids, stats = fetch_archive_missing(args.remote, args.archive_limit)
            if stats:
                print(f"archive: {stats['totalAudio']}/{stats['totalShares']} audio/shares; "
                      f"{len(cids)} missing this page" + (" (truncated)" if stats.get("truncated") else ""))
            if not cids:
                print(f"collection fully archived ({args.remote})")
            for cid in cids:
                process_one(cid, args.local, args.remote, args.min_bytes, rebuild_secret)
        else:
            queue = fetch_queue(args.remote)
            if not queue:
                print(f"queue empty ({args.remote})")
            else:
                print(f"queue: {len(queue)} CIDs")
                for cid in queue:
                    process_one(cid, args.local, args.remote, args.min_bytes, rebuild_secret)
        if not args.watch:
            return
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
