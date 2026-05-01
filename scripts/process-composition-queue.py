#!/usr/bin/env python3
"""Process the BeatsComposition render queue exposed by a beats-bitwrap-io
server running with -rebuild-queue.

Loop:
  1. GET   {remote}/api/composition-queue                  — list of CIDs to render
  2. GET   {remote}/c/{cid}                                — composition envelope
  3. for each track[i].source.cid:
       GET   {remote}/o/{cid_i}                            — ingredient envelope
       PUT   {local}/o/{cid_i}                             — seal locally
       GET   {local}/audio/{cid_i}.webm                    — chromedp realtime render
       ffmpeg .webm → .wav (worker-local, lossless)
  4. {binary} render-composition --envelope env.json \\
            --ingredients ingest.json --out workdir   — Go assembler
  5. for each format produced:
       PUT   {remote}/audio-master/{cid}.{ext}             — X-Rebuild-Secret
  6. POST  {remote}/api/composition-clear {cid}             — drop the queue row

The local server must be started with -authoring -audio-render so the GET
in step 3 actually runs chromedp. The worker must have ffmpeg on PATH and
the beats-bitwrap-io binary built (--binary defaults to ./beats-bitwrap-io).

Set BEATS_REBUILD_SECRET=$(ssh prod 'cat ~/Workspace/beats-bitwrap-io/data/.rebuild-secret')
so the master uploads can bypass first-write-wins on the remote.

Recommended local server:
  ./beats-bitwrap-io -authoring -audio-render -audio-auto-enqueue=false \\
      -audio-concurrent 2 -audio-max-duration 6m -audio-render-timeout 15m \\
      -addr :18090 -data /tmp/beats-comp-worker

Usage:
  ./scripts/process-composition-queue.py                 # one-shot
  ./scripts/process-composition-queue.py --watch          # poll forever
  ./scripts/process-composition-queue.py --watch --interval 30
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


def http(method, url, body=None, headers=None, timeout=900):
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read() if e.fp else b""


def fetch_queue(remote: str) -> list[str]:
    code, body = http("GET", f"{remote}/api/composition-queue?limit=200", timeout=30)
    if code != 200:
        print(f"  ! queue HTTP {code}", file=sys.stderr)
        return []
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return []


def fetch_envelope(base: str, prefix: str, cid: str) -> bytes | None:
    code, body = http("GET", f"{base}{prefix}/{cid}", timeout=30)
    if code != 200:
        print(f"  ! GET {prefix}/{cid} HTTP {code}", file=sys.stderr)
        return None
    return body


def seal_local(local: str, prefix: str, cid: str, body: bytes, secret: str) -> bool:
    headers = {"Content-Type": "application/ld+json"}
    # source=official envelopes (operator-signed shares from prod) need
    # the local rebuild-secret to pass the provenance gate. Anonymous
    # envelopes ignore the header.
    if secret:
        headers["X-Rebuild-Secret"] = secret
    code, _ = http("PUT", f"{local}{prefix}/{cid}", body=body,
                   headers=headers, timeout=60)
    return code in (200, 201)


def render_ingredient_to_webm(local: str, cid: str, dst: str) -> bool:
    """Trigger chromedp realtime render via the local server, save to dst."""
    code, body = http("GET", f"{local}/audio/{cid}.webm", timeout=900)
    if code != 200 or not body:
        print(f"  ! render {cid} HTTP {code} ({len(body)} bytes)", file=sys.stderr)
        return False
    with open(dst, "wb") as f:
        f.write(body)
    return True


def webm_to_wav(src: str, dst: str) -> bool:
    """Decode the rendered .webm to a worker-local .wav for the assembler."""
    cmd = ["ffmpeg", "-y", "-loglevel", "error",
           "-i", src,
           "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2",
           dst]
    r = subprocess.run(cmd, stderr=subprocess.PIPE)
    if r.returncode != 0:
        print(f"  ! ffmpeg decode {src}: {r.stderr.decode().strip()}", file=sys.stderr)
        return False
    return True


def render_composition(binary: str, env_path: str, ingredients_path: str, out_dir: str) -> dict | None:
    cmd = [binary, "render-composition",
           "--envelope", env_path,
           "--ingredients", ingredients_path,
           "--out", out_dir]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        print(f"  ! render-composition: {r.stderr.decode().strip()}", file=sys.stderr)
        return None
    try:
        return json.loads(r.stdout).get("paths", {})
    except json.JSONDecodeError:
        print(f"  ! render-composition non-JSON stdout: {r.stdout!r}", file=sys.stderr)
        return None


def upload_master(remote: str, cid: str, ext: str, path: str, secret: str) -> bool:
    with open(path, "rb") as f:
        body = f.read()
    code, _ = http("PUT", f"{remote}/audio-master/{cid}.{ext}",
                   body=body,
                   headers={"X-Rebuild-Secret": secret,
                            "Content-Type": "application/octet-stream"},
                   timeout=300)
    if code not in (200, 201):
        print(f"  ! upload {cid}.{ext} HTTP {code}", file=sys.stderr)
        return False
    return True


def post_clear(remote: str, cid: str) -> None:
    body = json.dumps({"cid": cid}).encode()
    http("POST", f"{remote}/api/composition-clear", body=body,
         headers={"Content-Type": "application/json"}, timeout=30)


def process_one(cid: str, args, secret: str) -> bool:
    print(f"  · {cid}")
    env_bytes = fetch_envelope(args.remote, "/c", cid)
    if not env_bytes:
        return False
    try:
        env = json.loads(env_bytes)
    except json.JSONDecodeError:
        print(f"  ! envelope parse failed for {cid}", file=sys.stderr)
        return False

    ingredient_cids = []
    for t in env.get("tracks", []):
        src = t.get("source", {}).get("cid")
        if src and src not in ingredient_cids:
            ingredient_cids.append(src)
    if not ingredient_cids:
        print(f"  ! {cid} has no ingredients", file=sys.stderr)
        return False

    with tempfile.TemporaryDirectory(prefix=f"comp-{cid}-") as tmp:
        ingredient_paths: dict[str, str] = {}
        for ing_cid in ingredient_cids:
            ing_env = fetch_envelope(args.remote, "/o", ing_cid)
            if not ing_env:
                return False
            if not seal_local(args.local, "/o", ing_cid, ing_env, secret):
                print(f"  ! local seal {ing_cid} failed", file=sys.stderr)
                return False
            webm = os.path.join(tmp, f"{ing_cid}.webm")
            if not render_ingredient_to_webm(args.local, ing_cid, webm):
                return False
            wav = os.path.join(tmp, f"{ing_cid}.wav")
            if not webm_to_wav(webm, wav):
                return False
            ingredient_paths[ing_cid] = wav

        env_path = os.path.join(tmp, "envelope.json")
        with open(env_path, "wb") as f:
            f.write(env_bytes)
        ingest_path = os.path.join(tmp, "ingredients.json")
        with open(ingest_path, "w") as f:
            json.dump(ingredient_paths, f)
        out_dir = os.path.join(tmp, "out")
        os.makedirs(out_dir, exist_ok=True)

        outputs = render_composition(args.binary, env_path, ingest_path, out_dir)
        if not outputs:
            return False

        for ext, path in outputs.items():
            if not upload_master(args.remote, cid, ext, path, secret):
                return False
            print(f"    ✓ {ext}: {os.path.getsize(path):,} bytes")

    post_clear(args.remote, cid)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--remote", default="https://beats.bitwrap.io",
                    help="server hosting the composition queue")
    ap.add_argument("--local", default="http://127.0.0.1:18090",
                    help="local server doing the chromedp ingredient renders")
    ap.add_argument("--binary", default="./beats-bitwrap-io",
                    help="path to the beats-bitwrap-io binary (for render-composition subcommand)")
    ap.add_argument("--watch", action="store_true", help="poll forever")
    ap.add_argument("--interval", type=int, default=30, help="poll seconds when --watch")
    ap.add_argument("--once", action="store_true", help="exit after one drain pass")
    args = ap.parse_args()

    secret = os.environ.get("BEATS_REBUILD_SECRET", "").strip()
    if not secret:
        print("BEATS_REBUILD_SECRET not set; master uploads will be rejected.",
              file=sys.stderr)

    while True:
        cids = fetch_queue(args.remote)
        if cids:
            print(f"queue: {len(cids)} pending")
            for cid in cids:
                ok = process_one(cid, args, secret)
                if not ok:
                    print(f"  ✗ {cid} failed", file=sys.stderr)
        elif not args.watch:
            print("queue empty")
        if args.once or not args.watch:
            return
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
