#!/usr/bin/env python3
"""Re-render and re-upload audio for specific CIDs that have broken/empty
.webm files on prod (e.g. 110-byte EBML stubs from a chromedp race).

For each CID:
  1. GET  https://beats.bitwrap.io/o/{cid}      — pull canonical envelope
  2. PUT  http://localhost:18090/o/{cid}        — seal locally
  3. GET  http://localhost:18090/audio/{cid}.webm — chromedp render
  4. PUT  https://beats.bitwrap.io/audio/{cid}.webm — replace broken audio

Local server requirements (auto-enqueue OFF to avoid the race that produced
the original stubs):

  ./beats-bitwrap-io -authoring -audio-render -audio-auto-enqueue=false \\
      -audio-concurrent 2 -audio-max-duration 6m -audio-render-timeout 15m \\
      -addr :18090 -data /tmp/beats-repair-data

Usage:
  ./scripts/repair-audio.py CID1 CID2 CID3 ...
  ./scripts/repair-audio.py --min-bytes 50000 CID...

Refuses to upload anything below --min-bytes (default 50 kB) so a repeat
of the original bug fails loudly instead of overwriting prod with another
stub.
"""
import argparse
import sys
import time
import urllib.error
import urllib.request

LOCAL = "http://localhost:18090"
PROD = "https://beats.bitwrap.io"


def http(method, url, body=None, headers=None, timeout=900):
    req = urllib.request.Request(url, data=body, method=method,
                                 headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read() if e.fp else b""


def repair(cid: str, min_bytes: int) -> bool:
    print(f"--- {cid}")
    code, envelope = http("GET", f"{PROD}/o/{cid}", timeout=30)
    if code != 200 or not envelope:
        print(f"  ! prod GET envelope HTTP {code}", file=sys.stderr)
        return False
    print(f"  envelope: {len(envelope):,} bytes")

    code, _ = http("PUT", f"{LOCAL}/o/{cid}", envelope,
                   {"Content-Type": "application/ld+json"}, timeout=30)
    if code not in (200, 201):
        print(f"  ! local seal HTTP {code}", file=sys.stderr)
        return False

    t0 = time.monotonic()
    code, webm = http("GET", f"{LOCAL}/audio/{cid}.webm", timeout=900)
    if code != 200:
        print(f"  ! local render HTTP {code}", file=sys.stderr)
        return False
    render_s = time.monotonic() - t0
    if len(webm) < min_bytes:
        print(f"  ! render produced {len(webm)} bytes (< {min_bytes}) — refusing upload",
              file=sys.stderr)
        return False
    print(f"  render: {render_s:.1f}s, {len(webm):,} bytes")

    code, body = http("PUT", f"{PROD}/audio/{cid}.webm", webm,
                      {"Content-Type": "audio/webm"}, timeout=120)
    if code not in (200, 201):
        print(f"  ! prod PUT HTTP {code}: "
              f"{body[:200].decode('utf-8','replace')}", file=sys.stderr)
        return False
    print(f"  ✓ uploaded ({code})")
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cids", nargs="+", help="CIDs to repair")
    ap.add_argument("--min-bytes", type=int, default=50_000,
                    help="Reject local renders smaller than this (default 50 kB)")
    args = ap.parse_args()

    ok = sum(repair(cid, args.min_bytes) for cid in args.cids)
    print(f"\n{ok}/{len(args.cids)} repaired")
    sys.exit(0 if ok == len(args.cids) else 1)


if __name__ == "__main__":
    main()
