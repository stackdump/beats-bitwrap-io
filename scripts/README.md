# scripts/

One-off diagnostics that orbit the share + render pipeline. Not load-bearing
for the build or for production — runtime tools for debugging timing,
auditing renders, or scripting bulk seal/download flows from outside the
repo.

Everything assumes Python 3.10+, ffmpeg/ffprobe on `PATH`, and (for the
jitter analyzer) numpy. No other deps.

## seal-share.py

Compute the CIDv1 of a share-v1 envelope and (optionally) `PUT` it to a
host. Mirrors the canonical Python recipe in `examples/README.md` so
script flows don't have to inline 30 lines of CID math.

```bash
./scripts/seal-share.py examples/metronome.json
# CID:   z4EBG…
# BYTES: 2441

./scripts/seal-share.py examples/metronome.json --host https://beats.bitwrap.io
# CID:   z4EBG…
# PUT:   HTTP 201
# PLAY:  https://beats.bitwrap.io/?cid=z4EBG…
# AUDIO: https://beats.bitwrap.io/audio/z4EBG….webm
```

`--quiet` prints only the CID — easy to capture into shell vars.

## fetch-render.sh

Block-download `/audio/{cid}.webm`. The server's GET handler clears its
write deadline and waits for the headless render to finish, single-flight
with any in-flight render (auto-enqueued on seal, kicked off by POST,
or another GET). Cold renders take 1-3 minutes — that's intentional.

```bash
./scripts/fetch-render.sh "$CID"                              # → /tmp/$CID.webm
./scripts/fetch-render.sh "$CID" http://localhost:18090       # local server
./scripts/fetch-render.sh "$CID" https://beats.bitwrap.io ./out.webm
```

## measure-jitter.py

Measure inter-onset-interval jitter on a rendered .webm. Decodes via
ffmpeg, runs an envelope-threshold transient detector, prints IOI
mean/stddev, cumulative drift, worst outliers, and a delta histogram.

Designed for **clean drum metronomes only** (sharp transients, no
reverb, no melody). For arbitrary tracks the detector will overcount
or miss onsets.

```bash
./scripts/measure-jitter.py /tmp/$CID.webm                    # default 120 BPM, quarter notes
./scripts/measure-jitter.py /tmp/$CID.webm --bpm 140 --subdivision eighth
```

## seed-feed.py

Bulk-seed the prod feed from a local server. For each (genre × N seeds)
generates a project locally, mirrors the envelope to the upload host,
then renders + uploads audio in a worker pool. Deterministic seeds per
genre so re-runs are idempotent — but composer non-determinism across
sessions can produce different CIDs for the same (genre, seed), so a
mid-run retry leaves duplicate-genre rows in the prod feed (use
`repair-audio.py` for those instead).

```bash
# Local server with parallel chromedp:
./beats-bitwrap-io -authoring -audio-render -audio-concurrent 4 \
    -addr :18090 -data /tmp/beats-seed-data

./scripts/seed-feed.py --dry-run                                  # preview
./scripts/seed-feed.py --workers 4                                # all 19 × 3 = 57 tracks
./scripts/seed-feed.py --genres techno house --per-genre 5
```

## repair-audio.py

One-shot re-render + re-upload of explicit CIDs. Use when specific
tracks have broken audio (e.g. 110-byte WebM stubs from a chromedp
race) and a `seed-feed.py` retry would mint new CIDs instead of fixing
the existing ones. Pulls the canonical envelope from prod, renders
locally, refuses uploads under `--min-bytes` (default 50 kB).

```bash
# Local server with -audio-auto-enqueue=false to break the race:
./beats-bitwrap-io -authoring -audio-render -audio-auto-enqueue=false \
    -audio-concurrent 2 -audio-max-duration 6m -audio-render-timeout 15m \
    -addr :18090 -data /tmp/beats-repair-data

./scripts/repair-audio.py z4EBG9j... z4EBG9j... ...
```

If prod's audio cache already has a stub for those CIDs, the PUT will
return `wrote:false` (first-write-wins). Either pass `BEATS_REBUILD_SECRET`
(see below) to force overwrite, or `ssh pflow.dev "rm <path>"` first.

## process-rebuild-queue.py

Long-running worker for the rebuild queue exposed by a server with
`-rebuild-queue` (production has this on). Listeners click the ⟳
button on a feed card → server records the CID in `rebuild_queue` →
this worker pulls the queue, re-renders each CID locally, uploads,
and clears the row.

The auth secret bypasses first-write-wins, so this is the canonical
way to replace stuck/broken audio in production:

```bash
ssh pflow.dev "cat ~/Workspace/beats-bitwrap-io/data/.rebuild-secret"
# … then locally:
BEATS_REBUILD_SECRET=$(...) ./scripts/process-rebuild-queue.py --watch --interval 30
```

`--watch` polls forever; omit for one-shot. `--remote` defaults to
`https://beats.bitwrap.io`. The local server requirements are the same
as `repair-audio.py` (auto-enqueue off to avoid the chromedp race).

## End-to-end timing diagnostic (the recipe that birthed this folder)

```bash
CID=$(./scripts/seal-share.py examples/metronome.json \
        --host https://beats.bitwrap.io --quiet)
./scripts/fetch-render.sh "$CID"
./scripts/measure-jitter.py "/tmp/$CID.webm"
```

If `cumulative drift` trends nonzero or the worst-IOI cluster shows
±100ms+ outliers, the headless renderer is throttling the worker's
`setInterval` and the audio-clock compensation can't fully recover —
exactly the symptom that motivated `examples/metronome.json`.
