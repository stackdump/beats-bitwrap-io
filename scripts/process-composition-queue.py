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
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


def hex_digest_short(s: str) -> str:
    """8-char hex digest of s — used to slug variant queries into
    stable per-track WAV filenames in the worker tempdir."""
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:8]


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


def render_ingredient_to_webm(local: str, cid: str, dst: str, query: str = "") -> bool:
    """Trigger chromedp realtime render via the local server, save to dst.

    `query` carries the per-track variant params (?solo=…&mute=…&transpose=
    …&tempoMatch=…&sourceBpm=…&masterBpm=…) so two composition tracks
    referencing the same ingredient with different shapings each cache to
    a distinct {cid}-{hash}.webm on the local server.
    """
    url = f"{local}/audio/{cid}.webm"
    if query:
        url += ("&" if "?" in url else "?") + query.lstrip("?&")
    code, body = http("GET", url, timeout=900)
    if code != 200 or not body:
        print(f"  ! render {cid} HTTP {code} ({len(body)} bytes)", file=sys.stderr)
        return False
    with open(dst, "wb") as f:
        f.write(body)
    return True


def build_variant_query(track: dict, master_bpm: int, source_bpm: int) -> tuple[str, bool]:
    """Build the URL query string for a track's per-track ops.

    Returns (query, hasOps). hasOps=False means the track is a vanilla
    bare-CID render and the worker can reuse the cache key without any
    suffix; True means the resulting wav file is a variant and must be
    keyed distinctly so two tracks referencing the same ingredient with
    different shapings don't collide on disk.
    """
    parts: list[str] = []
    solo = [s for s in (track.get("soloRoles") or []) if s]
    mute = [s for s in (track.get("mute") or []) if s]
    transpose = int(track.get("transposeSemis") or 0)
    tempo_match = (track.get("tempoMatch") or "").strip()
    if solo:
        parts.append("solo=" + ",".join(solo))
    if mute:
        parts.append("mute=" + ",".join(mute))
    if transpose:
        parts.append(f"transpose={transpose}")
    if tempo_match and tempo_match != "none":
        parts.append(f"tempoMatch={tempo_match}")
        if source_bpm > 0:
            parts.append(f"sourceBpm={source_bpm}")
        if master_bpm > 0:
            parts.append(f"masterBpm={master_bpm}")
    has_ops = bool(parts)
    return ("&".join(parts), has_ops)


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

    master_bpm = int(env.get("tempo") or 0)
    tracks = env.get("tracks", [])
    if not tracks:
        print(f"  ! {cid} has no tracks", file=sys.stderr)
        return False

    # Source BPM cache: each ingredient envelope is fetched at most once
    # and we read its tempo (if present) so the assembler can compute
    # tempoMatch ratios without re-fetching.
    source_bpm: dict[str, int] = {}

    # Per-track variant key: same ingredient with different ops becomes
    # a distinct WAV under a different filename so the assembler picks
    # them up via separate ingredient_paths entries. The map key is
    # `{cid}#{queryString}` so vanilla renders reuse the bare-CID slot.
    ingredient_variants: dict[str, tuple[str, str, dict]] = {}  # variant_key → (cid, query, track)
    for t in tracks:
        src = t.get("source", {}).get("cid")
        if not src:
            print(f"  ! track without source.cid in {cid}", file=sys.stderr)
            return False
        # We need the source BPM before we can build the query (the
        # query embeds sourceBpm for the server-side hash to match the
        # assembler's ratio).
        if src not in source_bpm:
            ing_env_bytes = fetch_envelope(args.remote, "/o", src)
            if not ing_env_bytes:
                return False
            try:
                ing = json.loads(ing_env_bytes)
                source_bpm[src] = int(ing.get("tempo") or 0)
            except json.JSONDecodeError:
                source_bpm[src] = 0
            # Stash for the seal+render loop below; avoids a second GET.
            ingredient_variants.setdefault(f"__env__::{src}", (src, "", {"_envBytes": ing_env_bytes}))
        query, _ = build_variant_query(t, master_bpm, source_bpm[src])
        variant_key = f"{src}#{query}"
        if variant_key not in ingredient_variants:
            ingredient_variants[variant_key] = (src, query, t)

    with tempfile.TemporaryDirectory(prefix=f"comp-{cid}-") as tmp:
        ingredient_paths: dict[str, str] = {}      # variant_key → wav path
        sealed: set[str] = set()
        for variant_key, (ing_cid, query, track) in ingredient_variants.items():
            if variant_key.startswith("__env__::"):
                continue
            if ing_cid not in sealed:
                env_bytes_for_ing = ingredient_variants[f"__env__::{ing_cid}"][2]["_envBytes"]
                if not seal_local(args.local, "/o", ing_cid, env_bytes_for_ing, secret):
                    print(f"  ! local seal {ing_cid} failed", file=sys.stderr)
                    return False
                sealed.add(ing_cid)
            # Stable per-variant local filename so two tracks
            # referencing the same ingredient with different ops cache
            # to distinct wavs on disk.
            slug = "vanilla" if not query else hex_digest_short(query)
            webm = os.path.join(tmp, f"{ing_cid}-{slug}.webm")
            if not render_ingredient_to_webm(args.local, ing_cid, webm, query):
                return False
            wav = os.path.join(tmp, f"{ing_cid}-{slug}.wav")
            if not webm_to_wav(webm, wav):
                return False
            ingredient_paths[variant_key] = wav

        # Inject source BPM into each track BEFORE writing the envelope
        # the CLI reads. The composition envelope on disk is canonical
        # bytes (CID-stable), so we mutate a parsed copy instead and
        # also rewrite source.cid → variant key so the CLI sees one
        # ingredient per track.
        env_for_cli = json.loads(env_bytes)
        for i, t in enumerate(env_for_cli.get("tracks", [])):
            src = t.get("source", {}).get("cid", "")
            t["sourceBpm"] = source_bpm.get(src, 0)
            query, _ = build_variant_query(t, master_bpm, source_bpm.get(src, 0))
            t["source"]["cid"] = f"{src}#{query}"  # variant key for ingredients map
            # The CLI's struct doesn't use variant keys directly — it
            # passes source.cid into ingredients[]. By using the variant
            # key here, we keep the CLI mapping correct.
            env_for_cli["tracks"][i] = t

        env_path = os.path.join(tmp, "envelope.json")
        with open(env_path, "w") as f:
            json.dump(env_for_cli, f)
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
