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
