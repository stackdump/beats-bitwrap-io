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


def resolve_ingredient_envelope(remote: str, cid: str) -> tuple[str, bytes] | None:
    """Returns ('share', bytes) if cid is at /o/{cid}, ('composition',
    bytes) if at /c/{cid}, or None if neither. Lets PR-7.3 nested
    compositions reference each other without the worker having to
    know upfront which prefix any given track points at."""
    code, body = http("GET", f"{remote}/o/{cid}", timeout=30)
    if code == 200:
        return ('share', body)
    code, body = http("GET", f"{remote}/c/{cid}", timeout=30)
    if code == 200:
        return ('composition', body)
    return None


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


def render_insert(binary: str, spec: dict, dst: str) -> bool:
    """Generate a generative-insert WAV (riser/etc.) via the Go subcommand."""
    spec_bytes = json.dumps(spec).encode("utf-8")
    spec_path = dst + ".spec.json"
    with open(spec_path, "wb") as f:
        f.write(spec_bytes)
    cmd = [binary, "render-insert", "--spec", spec_path, "--out", dst]
    r = subprocess.run(cmd, capture_output=True)
    try:
        os.remove(spec_path)
    except OSError:
        pass
    if r.returncode != 0:
        print(f"  ! render-insert: {r.stderr.decode().strip()}", file=sys.stderr)
        return False
    return True


def canon_for_hash(v):
    """Stable canonicalisation matching seal-share.py for hashing.
    Used to derive a synthetic ingredient key for a generate spec."""
    if isinstance(v, dict):
        return {k: canon_for_hash(v[k]) for k in sorted(v)}
    if isinstance(v, list):
        return [canon_for_hash(x) for x in v]
    return v


def generate_source_key(spec_with_duration: dict) -> str:
    """Synthetic, content-addressed key for a generate-source ingredient.
    Two tracks asking for the same {type, params, durationSec} share a
    rendered WAV across the composition."""
    body = json.dumps(canon_for_hash(spec_with_duration), separators=(",", ":")).encode()
    return "gen-" + hashlib.sha256(body).hexdigest()[:16]


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
    """PUT a master file via curl. Python's urllib.request races
    Go's http.Server on multi-MB PUTs (BrokenPipe before headers
    finish writing — reproducible at ~3 MB+ on darwin/Python 3.12).
    curl handles the same upload reliably, so we shell out."""
    cmd = [
        "curl", "-sS", "-X", "PUT",
        "-H", f"X-Rebuild-Secret: {secret}",
        "-H", "Content-Type: application/octet-stream",
        "--data-binary", f"@{path}",
        "-w", "%{http_code}",
        "-o", "/dev/null",
        f"{remote}/audio-master/{cid}.{ext}",
    ]
    r = subprocess.run(cmd, capture_output=True, timeout=600)
    if r.returncode != 0:
        print(f"  ! upload {cid}.{ext} curl exit={r.returncode}: {r.stderr.decode().strip()}", file=sys.stderr)
        return False
    code = r.stdout.decode().strip()
    if code not in ("200", "201"):
        print(f"  ! upload {cid}.{ext} HTTP {code}", file=sys.stderr)
        return False
    return True


def post_clear(remote: str, cid: str) -> None:
    body = json.dumps({"cid": cid}).encode()
    http("POST", f"{remote}/api/composition-clear", body=body,
         headers={"Content-Type": "application/json"}, timeout=30)


MAX_COMPOSITION_DEPTH = 3


def render_composition_to_wav(cid: str, env_bytes: bytes, args, secret: str,
                              tmp: str, depth: int = 0) -> dict | None:
    """Render a single composition (top-level or nested) into a WAV
    file inside `tmp` and return the path. Top-level callers pass
    depth=0 and run upload + queue-clear afterwards; recursive calls
    from PR-7.3 nested ingredients pass depth+1 and just consume the
    returned WAV as if it were a share-rendered ingredient.

    Returns None on any failure (errors already logged).
    """
    if depth > MAX_COMPOSITION_DEPTH:
        print(f"  ! composition recursion depth {depth} > {MAX_COMPOSITION_DEPTH} — aborting", file=sys.stderr)
        return None
    indent = "  " + "    " * depth
    print(f"{indent}↳ rendering composition {cid[:14]}… (depth {depth})")
    try:
        env = json.loads(env_bytes)
    except json.JSONDecodeError:
        print(f"{indent}! envelope parse failed", file=sys.stderr)
        return None

    master_bpm = int(env.get("tempo") or 0)
    tracks = env.get("tracks", [])
    if not tracks:
        print(f"{indent}! {cid} has no tracks", file=sys.stderr)
        return None
    bar_sec = (4.0 * 60.0) / master_bpm if master_bpm > 0 else 0.5

    # First pass: id → cid map for counterMelody.of resolution.
    track_id_to_cid: dict[str, str] = {}
    for t in tracks:
        tid = t.get("id")
        src_cid = (t.get("source") or {}).get("cid")
        if tid and src_cid:
            track_id_to_cid[tid] = src_cid

    source_bpm: dict[str, int] = {}
    cid_envelopes: dict[str, bytes] = {}
    composition_envelopes: dict[str, bytes] = {}  # PR-7.3 nested compositions
    track_source_keys: list[str] = [None] * len(tracks)
    source_resolution: dict[str, tuple] = {}

    for i, t in enumerate(tracks):
        src = t.get("source") or {}
        if "cid" in src:
            ing_cid = src["cid"]
            # PR-7.3: probe both /o/ and /c/ to discover whether this
            # ingredient is a share (chromedp render) or a composition
            # (recursive render via the assembler).
            if ing_cid not in cid_envelopes and ing_cid not in composition_envelopes:
                resolved = resolve_ingredient_envelope(args.remote, ing_cid)
                if not resolved:
                    print(f"{indent}! ingredient {ing_cid} not found at /o/ or /c/", file=sys.stderr)
                    return None
                kind, body = resolved
                if kind == 'share':
                    cid_envelopes[ing_cid] = body
                    try:
                        source_bpm[ing_cid] = int(json.loads(body).get("tempo") or 0)
                    except json.JSONDecodeError:
                        source_bpm[ing_cid] = 0
                else:  # composition
                    composition_envelopes[ing_cid] = body
                    source_bpm[ing_cid] = int(json.loads(body).get("tempo") or 0)
            if ing_cid in composition_envelopes:
                # Nested composition — variant query is meaningless;
                # the composition is its own master.
                key = f"comp:{ing_cid}"
                track_source_keys[i] = key
                source_resolution.setdefault(key, ("nested", ing_cid))
            else:
                query, _ = build_variant_query(t, master_bpm, source_bpm[ing_cid])
                key = f"{ing_cid}#{query}"
                track_source_keys[i] = key
                source_resolution.setdefault(key, ("cid", ing_cid, query))
        elif "generate" in src:
            spec = dict(src["generate"])
            if spec.get("type") == "counterMelody":
                sibling_id = spec.get("of")
                if not sibling_id:
                    print(f"{indent}! counterMelody track missing `of`", file=sys.stderr)
                    return None
                sibling_cid = track_id_to_cid.get(sibling_id)
                if not sibling_cid:
                    print(f"{indent}! counterMelody.of={sibling_id!r} unresolved", file=sys.stderr)
                    return None
                if sibling_cid not in cid_envelopes:
                    sib_env_bytes = fetch_envelope(args.remote, "/o", sibling_cid)
                    if not sib_env_bytes:
                        return None
                    cid_envelopes[sibling_cid] = sib_env_bytes
                spec["_siblingCid"] = sibling_cid
            spec_with_duration = dict(spec)
            spec_with_duration["durationSec"] = float(t.get("len", 1)) * bar_sec
            spec_for_key = {k: v for k, v in spec_with_duration.items() if not k.startswith("_")}
            key = generate_source_key(spec_for_key)
            track_source_keys[i] = key
            source_resolution.setdefault(key, ("gen", spec_with_duration))
        else:
            print(f"{indent}! track {i} has neither source.cid nor source.generate", file=sys.stderr)
            return None

    # Materialize each unique source into a WAV inside this depth's
    # tempdir (sub-compositions get their own subdir to avoid name
    # collisions with the parent's ingredient WAVs).
    sub_tmp = os.path.join(tmp, f"d{depth}-{cid[:14]}")
    os.makedirs(sub_tmp, exist_ok=True)
    ingredient_paths: dict[str, str] = {}
    sealed: set[str] = set()
    for key, info in source_resolution.items():
        kind = info[0]
        if kind == "cid":
            _, ing_cid, query = info
            if ing_cid not in sealed:
                if not seal_local(args.local, "/o", ing_cid, cid_envelopes[ing_cid], secret):
                    print(f"{indent}! local seal {ing_cid} failed", file=sys.stderr)
                    return None
                sealed.add(ing_cid)
            slug = "vanilla" if not query else hex_digest_short(query)
            webm = os.path.join(sub_tmp, f"{ing_cid}-{slug}.webm")
            if not render_ingredient_to_webm(args.local, ing_cid, webm, query):
                return None
            wav = os.path.join(sub_tmp, f"{ing_cid}-{slug}.wav")
            if not webm_to_wav(webm, wav):
                return None
            ingredient_paths[key] = wav
        elif kind == "nested":
            # PR-7.3: recursive composition render. Returns the
            # nested master.wav which we plug in as if it were a
            # share-derived ingredient.
            _, sub_cid = info
            sub_env = composition_envelopes[sub_cid]
            nested_outputs = render_composition_to_wav(sub_cid, sub_env, args, secret, sub_tmp, depth + 1)
            if not nested_outputs or not nested_outputs.get("wav"):
                return None
            ingredient_paths[key] = nested_outputs["wav"]
        elif kind == "gen":
            _, spec = info
            spec_to_render = {k: v for k, v in spec.items() if not k.startswith("_")}
            if spec.get("type") == "counterMelody":
                sibling_cid = spec.get("_siblingCid")
                sib_env_bytes = cid_envelopes.get(sibling_cid)
                if not sib_env_bytes:
                    print(f"{indent}! counterMelody sibling envelope missing", file=sys.stderr)
                    return None
                sib_path = os.path.join(sub_tmp, f"src-{sibling_cid[:14]}.json")
                with open(sib_path, "wb") as f:
                    f.write(sib_env_bytes)
                spec_to_render["sourceEnvelopePath"] = sib_path
                spec_to_render["_baseURL"] = args.local
                spec_to_render["_rebuildSecret"] = secret
            wav = os.path.join(sub_tmp, f"{key}.wav")
            if not render_insert(args.binary, spec_to_render, wav):
                return None
            ingredient_paths[key] = wav
            print(f"{indent}  ↳ generated {spec.get('type')} ({spec.get('durationSec'):.2f}s) → {key}")

    # Rewrite envelope for the CLI: each track's source becomes the
    # variant key (so the assembler's ingredient lookup matches),
    # and sourceBpm carries the matched ingredient tempo.
    env_for_cli = json.loads(env_bytes)
    for i, t in enumerate(env_for_cli.get("tracks", [])):
        key = track_source_keys[i]
        kind = source_resolution[key][0]
        if kind == "cid":
            ing_cid = source_resolution[key][1]
            t["sourceBpm"] = source_bpm.get(ing_cid, 0)
        elif kind == "nested":
            t["sourceBpm"] = 0  # nested already master-rendered, no further tempo work
        else:
            t["sourceBpm"] = 0
        t["source"] = {"cid": key}
        env_for_cli["tracks"][i] = t
    # Nested compositions only need a single WAV format — the parent
    # assembler decodes and re-mixes. Skip mp3/flac/webm fan-out for
    # depth > 0 to save render time.
    if depth > 0:
        env_for_cli.setdefault("master", {})["format"] = ["wav"]

    env_path = os.path.join(sub_tmp, "envelope.json")
    with open(env_path, "w") as f:
        json.dump(env_for_cli, f)
    ingest_path = os.path.join(sub_tmp, "ingredients.json")
    with open(ingest_path, "w") as f:
        json.dump(ingredient_paths, f)
    out_dir = os.path.join(sub_tmp, "out")
    os.makedirs(out_dir, exist_ok=True)
    outputs = render_composition(args.binary, env_path, ingest_path, out_dir)
    if not outputs:
        return None
    return outputs


def process_one(cid: str, args, secret: str) -> bool:
    """Top-level worker entry: fetch composition envelope, dispatch
    to the recursive renderer, then upload masters + emit stems +
    clear queue. The render-composition CLI handles ffmpeg assembly;
    PR-7.3's render_composition_to_wav handles ingredient resolution
    (including nested compositions); PR-7.4 emits per-group stems."""
    print(f"  · {cid}")
    env_bytes = fetch_envelope(args.remote, "/c", cid)
    if not env_bytes:
        return False
    with tempfile.TemporaryDirectory(prefix=f"comp-{cid}-") as tmp:
        outputs = render_composition_to_wav(cid, env_bytes, args, secret, tmp, depth=0)
        if not outputs:
            return False
        for ext, path in outputs.items():
            if not upload_master(args.remote, cid, ext, path, secret):
                return False
            print(f"    ✓ {ext}: {os.path.getsize(path):,} bytes")

        # PR-7.4: per-group stems. master.stems lists track-group
        # names; each one re-renders the composition with every cid
        # track soloed to that group (and generative inserts dropped),
        # uploads as /audio-stems/{cid}/{group}.{ext}.
        try:
            env = json.loads(env_bytes)
        except json.JSONDecodeError:
            env = {}
        stems = ((env.get("master") or {}).get("stems") or [])
        for group in stems:
            if not isinstance(group, str) or not group.strip():
                continue
            print(f"    ↳ stem render: {group}")
            stem_outputs = render_stem(cid, env_bytes, group, args, secret, tmp)
            if not stem_outputs:
                print(f"    ! stem {group} render failed", file=sys.stderr)
                continue
            for ext, path in stem_outputs.items():
                if not upload_stem(args.remote, cid, group, ext, path, secret):
                    print(f"    ! stem upload {group}.{ext} failed", file=sys.stderr)
                    continue
                print(f"      ✓ stem {group}.{ext}: {os.path.getsize(path):,} bytes")
    post_clear(args.remote, cid)
    return True


def render_stem(cid: str, env_bytes: bytes, group: str, args, secret: str, tmp: str) -> dict | None:
    """Render a single per-group stem of the composition. Strategy:
    take the original envelope, override soloRoles=[group] on every
    cid track, drop every generative-insert track (they don't have a
    track.group concept), shrink format list to wav+webm, then run
    the same recursive renderer. Output goes into a stem-specific
    subdir so the parent's master files don't get clobbered."""
    try:
        env = json.loads(env_bytes)
    except json.JSONDecodeError:
        return None
    new_tracks = []
    for t in env.get("tracks", []):
        src = t.get("source") or {}
        if "cid" not in src:
            continue  # drop generative inserts from stem renders
        nt = dict(t)
        nt["soloRoles"] = [group]
        nt.pop("mute", None)
        new_tracks.append(nt)
    if not new_tracks:
        return None
    env["tracks"] = new_tracks
    master = dict(env.get("master") or {})
    master["format"] = ["wav", "webm"]
    master.pop("stems", None)
    env["master"] = master
    new_env_bytes = json.dumps(env).encode()

    stem_tmp = os.path.join(tmp, f"stem-{group}")
    os.makedirs(stem_tmp, exist_ok=True)
    return render_composition_to_wav(cid, new_env_bytes, args, secret, stem_tmp, depth=0)


def upload_stem(remote: str, cid: str, group: str, ext: str, path: str, secret: str) -> bool:
    """Upload a stem render via curl (same urllib-vs-Go-Server reason
    as upload_master)."""
    cmd = [
        "curl", "-sS", "-X", "PUT",
        "-H", f"X-Rebuild-Secret: {secret}",
        "-H", "Content-Type: application/octet-stream",
        "--data-binary", f"@{path}",
        "-w", "%{http_code}",
        "-o", "/dev/null",
        f"{remote}/audio-stems/{cid}/{group}.{ext}",
    ]
    r = subprocess.run(cmd, capture_output=True, timeout=600)
    if r.returncode != 0:
        return False
    return r.stdout.decode().strip() in ("200", "201")


def _legacy_process_one_unused(cid: str, args, secret: str) -> bool:
    """Pre-PR-7.3 implementation kept for reference during the
    migration; remove in a follow-up after the recursive path has
    soaked in production."""
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

    # 4 beats/bar at master tempo → seconds per bar. Used to convert a
    # generative track's bar length into the durationSec the insert
    # renderer needs. Mirrors the assembler's barSec computation.
    bar_sec = (4.0 * 60.0) / master_bpm if master_bpm > 0 else 0.5

    # First pass: build id → source.cid map so counterMelody specs
    # can resolve `of: "trackA"` to the sibling's source share. Only
    # tracks with both an id AND a cid source are eligible — generate
    # sources can't be answered (would require recursion).
    track_id_to_cid: dict[str, str] = {}
    for t in tracks:
        tid = t.get("id")
        src_cid = (t.get("source") or {}).get("cid")
        if tid and src_cid:
            track_id_to_cid[tid] = src_cid

    # Source BPM cache for cid-source tempo-match ratios.
    source_bpm: dict[str, int] = {}
    # Cached envelope bytes for cid sources so we don't re-fetch.
    cid_envelopes: dict[str, bytes] = {}
    # Each track gets a "source key" — for cid sources it's
    # `{cid}#{variantQuery}`; for generate sources it's `gen-{hash}`.
    # The assembler's ingredients map is keyed on these, and the
    # env_for_cli's source.cid is rewritten to match.
    track_source_keys: list[str] = [None] * len(tracks)
    # Per-key resolution data: ('cid', cid, query) or ('gen', spec_with_duration).
    source_resolution: dict[str, tuple] = {}

    for i, t in enumerate(tracks):
        src = t.get("source") or {}
        if "cid" in src:
            ing_cid = src["cid"]
            if ing_cid not in cid_envelopes:
                ing_env_bytes = fetch_envelope(args.remote, "/o", ing_cid)
                if not ing_env_bytes:
                    return False
                cid_envelopes[ing_cid] = ing_env_bytes
                try:
                    source_bpm[ing_cid] = int(json.loads(ing_env_bytes).get("tempo") or 0)
                except json.JSONDecodeError:
                    source_bpm[ing_cid] = 0
            query, _ = build_variant_query(t, master_bpm, source_bpm[ing_cid])
            key = f"{ing_cid}#{query}"
            track_source_keys[i] = key
            source_resolution.setdefault(key, ("cid", ing_cid, query))
        elif "generate" in src:
            spec = dict(src["generate"])
            # counterMelody needs the sibling's source share resolved
            # before render-insert runs. Pre-fetch the sibling
            # envelope here so the seal-on-render loop below has it
            # cached; the actual file path injection happens once we
            # have a tempdir.
            if spec.get("type") == "counterMelody":
                sibling_id = spec.get("of")
                if not sibling_id:
                    print(f"  ! counterMelody track missing `of`", file=sys.stderr)
                    return False
                sibling_cid = track_id_to_cid.get(sibling_id)
                if not sibling_cid:
                    print(f"  ! counterMelody.of={sibling_id!r} does not match any sibling track id with a cid source", file=sys.stderr)
                    return False
                if sibling_cid not in cid_envelopes:
                    sib_env_bytes = fetch_envelope(args.remote, "/o", sibling_cid)
                    if not sib_env_bytes:
                        return False
                    cid_envelopes[sibling_cid] = sib_env_bytes
                # Stash the sibling CID on the spec so the second
                # pass can locate the cached bytes; the field is
                # stripped before hashing the spec for the cache key.
                spec["_siblingCid"] = sibling_cid
            spec_with_duration = dict(spec)
            spec_with_duration["durationSec"] = float(t.get("len", 1)) * bar_sec
            # Don't include the worker-private _siblingCid hint in
            # the cache key — it's a path resolved at render time,
            # not part of the canonical spec.
            spec_for_key = {k: v for k, v in spec_with_duration.items() if not k.startswith("_")}
            key = generate_source_key(spec_for_key)
            track_source_keys[i] = key
            source_resolution.setdefault(key, ("gen", spec_with_duration))
        else:
            print(f"  ! track {i} has neither source.cid nor source.generate", file=sys.stderr)
            return False

    with tempfile.TemporaryDirectory(prefix=f"comp-{cid}-") as tmp:
        ingredient_paths: dict[str, str] = {}      # source_key → wav path
        sealed: set[str] = set()
        for key, info in source_resolution.items():
            kind = info[0]
            if kind == "cid":
                _, ing_cid, query = info
                if ing_cid not in sealed:
                    if not seal_local(args.local, "/o", ing_cid, cid_envelopes[ing_cid], secret):
                        print(f"  ! local seal {ing_cid} failed", file=sys.stderr)
                        return False
                    sealed.add(ing_cid)
                slug = "vanilla" if not query else hex_digest_short(query)
                webm = os.path.join(tmp, f"{ing_cid}-{slug}.webm")
                if not render_ingredient_to_webm(args.local, ing_cid, webm, query):
                    return False
                wav = os.path.join(tmp, f"{ing_cid}-{slug}.wav")
                if not webm_to_wav(webm, wav):
                    return False
                ingredient_paths[key] = wav
            elif kind == "gen":
                _, spec = info
                # counterMelody specs need the sibling's source share
                # written to a tmp file so the Go renderer can read
                # it. Strip the worker-private _siblingCid hint and
                # replace with sourceEnvelopePath for the CLI.
                spec_to_render = {k: v for k, v in spec.items() if not k.startswith("_")}
                if spec.get("type") == "counterMelody":
                    sibling_cid = spec.get("_siblingCid")
                    sib_env_bytes = cid_envelopes.get(sibling_cid)
                    if not sib_env_bytes:
                        print(f"  ! counterMelody sibling envelope missing for {sibling_cid}", file=sys.stderr)
                        return False
                    sib_path = os.path.join(tmp, f"src-{sibling_cid[:14]}.json")
                    with open(sib_path, "wb") as f:
                        f.write(sib_env_bytes)
                    spec_to_render["sourceEnvelopePath"] = sib_path
                    # PR-4.3.2: hand the local server's URL + rebuild
                    # secret to the CLI so it can route counterMelody
                    # through the Tone.js OfflineAudioContext path
                    # instead of plain ffmpeg sines. The CLI falls
                    # back to ffmpeg synthesis when these are empty.
                    spec_to_render["_baseURL"] = args.local
                    spec_to_render["_rebuildSecret"] = secret
                wav = os.path.join(tmp, f"{key}.wav")
                if not render_insert(args.binary, spec_to_render, wav):
                    return False
                ingredient_paths[key] = wav
                print(f"    ↳ generated {spec.get('type')} ({spec.get('durationSec'):.2f}s) → {key}")

        # Rewrite envelope for the CLI: each track's source becomes
        # `{cid: source_key}` and sourceBpm carries the matched
        # ingredient tempo (0 for generate sources, which the
        # assembler treats as "no tempo-match needed").
        env_for_cli = json.loads(env_bytes)
        for i, t in enumerate(env_for_cli.get("tracks", [])):
            key = track_source_keys[i]
            kind = source_resolution[key][0]
            if kind == "cid":
                ing_cid = source_resolution[key][1]
                t["sourceBpm"] = source_bpm.get(ing_cid, 0)
            else:
                t["sourceBpm"] = 0
            t["source"] = {"cid": key}
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
