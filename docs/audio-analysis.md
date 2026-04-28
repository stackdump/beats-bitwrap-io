# Audio analysis — measuring the genre fleet

How to pull a slice of cached `.webm` renders off prod, run an offline
spectral / loudness analysis, and read the numbers. Used to find
mix-bus problems (loudness, spectral balance) and per-genre composition
problems (instrument brightness, dynamic range) without listening to
hundreds of tracks by ear.

This doc is the "how" — the actual findings and their planned fixes
live in TODO.md / commit messages, since the numbers move every time
genre defaults or master FX change.

## Why this exists

Two distinct failure modes hide in the rendered audio:

1. **Mix-bus problems** — every track is too quiet, every track is
   muddy, the limiter is squashing dynamics. One fix lifts the whole
   fleet. Lives in `public/audio/tone-engine.js` (master chain) or
   `public/lib/share/apply.js` (default `fx` overrides).
2. **Per-genre composition problems** — dubstep is darker than
   ambient (wrong); trap pads hit polyphony ceiling; metal lead is
   too thin. Genre-specific fix in `public/lib/generator/genre-instruments.js`
   or the genre's tunable params in `composer.go`.

You can't tell them apart by listening to one track. You need numbers
across genres so you can see "all 19 are at −33 LUFS" (mix-bus) vs
"only dubstep's centroid is below ambient's" (composition).

## Pipeline

```
prod data/audio/2026/MM/{cid}.webm
    │  scp
    ▼
/tmp/beats-analysis/<genre>/{cid}.webm
    │  ffmpeg → mono 44.1k float32
    ▼
librosa + pyloudnorm
    │
    ▼
JSON per-track + per-genre means table
```

No browser, no Tone.js — we analyze what listeners actually hear (the
cached `.webm` the feed serves), not what we'd render fresh today.
This matters because old CIDs are pinned to old genre defaults; the
audio they ship is what was rendered at seal time.

## Step 1 — pick the slice

Three contrasting genres at a time is the right granularity for
comparison. The full 19-genre fleet is too noisy to read at a
glance; one genre alone has nothing to compare against.

Good triplets to start from:

| Triplet | What it surfaces |
|---|---|
| `ambient`, `techno`, `dubstep` | sparse vs. driving vs. heavy bass — biggest spectral / loudness contrast |
| `lofi`, `house`, `metal` | broadly "chill / club / aggressive" — broadest energy contrast |
| `trap`, `dnb`, `dubstep` | bass-music family — checks if our "bass genres" actually share a profile |
| `jazz`, `bossa`, `blues` | acoustic / restrained genres — checks if our quieter genres are *too* quiet |

Pull CIDs from prod's index:

```bash
ssh pflow.dev "cd ~/Workspace/beats-bitwrap-io && \
    sqlite3 data/index.db \"SELECT genre, cid FROM tracks \
        WHERE genre IN ('ambient','techno','dubstep') ORDER BY genre;\""
```

## Step 2 — pull the audio

```bash
mkdir -p /tmp/beats-analysis/{ambient,techno,dubstep}
for cid in <CIDs>; do
    scp -q pflow.dev:~/Workspace/beats-bitwrap-io/data/audio/2026/04/${cid}.webm \
        /tmp/beats-analysis/<genre>/
done
```

Files are bucketed by `YYYY/MM/` on prod (`internal/routes/audio.go`).
Bump the path when crossing months.

3 tracks × 3 genres ≈ 25 MB and runs through the analyzer in under a
minute. Don't pull the whole `data/audio/` — it's hundreds of MB and
the means are stable at n=3.

## Step 3 — run the analyzer

The analyzer is `scripts/analyze-audio.py` (in-repo). It decodes each
file via ffmpeg piped to `f32le mono 44.1k`, **applies a 30 Hz
4th-order Butterworth HPF before band-ratio computation** (so DC +
sub-rumble doesn't dominate the bass-band bin), then computes:

| Metric | What it tells you | Reference |
|---|---|---|
| **LUFS** (integrated) | Perceived loudness | Spotify −14 · YouTube −14 · EBU broadcast −23. Below −25 = "barely audible" relative to anything else in the listener's tab. |
| **Peak / RMS / Crest** | Dynamic range | Crest > 18 dB = dynamic; 10–14 dB = moderately compressed; < 10 dB = brick-walled. |
| **Spectral centroid** | Brightness ("center of mass" of the spectrum) | 1.5 kHz = dark/mellow · 2.5 kHz = balanced · 4 kHz+ = bright. |
| **Spectral rolloff (85%)** | Where the high end actually rolls off | 3 kHz = closed/dull · 6 kHz = open · 10 kHz+ = airy. |
| **Onset rate (Hz)** | Note / hit density per second | Genre-relative; ambient ~2/s, techno ~6/s, dnb ~10/s. |
| **Tempo (BPM)** | librosa estimate | **Don't trust** for genres without strong kick patterns (ambient, jazz). Use for sanity-check on percussion-driven genres only. |
| **Band-energy ratios** | sub / low / lo-mid / hi-mid / high split (5 bands, 20Hz–16kHz) | Sums to ~1. **Note:** sub-band is dominated by DC/rumble unless you HPF first. |

Required deps (one-time):

```bash
pip install librosa pyloudnorm numpy scipy
```

ffmpeg via brew. No node, no Go binary needed — the analyzer reads
files directly.

Each analyzed file emits a **BeatsAudioAnalysis** JSON-LD envelope on
stdout (one per line). Schema is at
`public/schema/beats-audio-analysis.schema.json` and served
content-negotiated at `/schema/beats-audio-analysis` (JSON-LD
default, `Accept: application/schema+json` for JSON-Schema, HTML for
the term glossary).

Pass `--upload --secret $S` to PUT each envelope to
`{host}/api/analysis/{cid}`. The server-side upsert merges non-null
fields with whatever the renderer's loudnorm pass already wrote,
keyed by CID:

```bash
S=$(ssh pflow.dev "cat ~/Workspace/beats-bitwrap-io/data/.rebuild-secret")
python3 scripts/analyze-audio.py --upload --secret "$S" \
    --host https://beats.bitwrap.io \
    /tmp/beats-analysis/*/*.webm
```

GET is public:

```bash
curl -fsS https://beats.bitwrap.io/api/analysis/z4EBG9... | jq .
```

## Step 4 — read the table

Output is a markdown-shaped means table per genre, e.g.

```
genre       dur   LUFS  crest  centroid  rolloff85  onset/s  BPM   sub  low  lomid  himid  high
ambient   215s  -34.0  18.5    1635 Hz    3090 Hz    2.3    144  .75  .20   .01   .002   .001
techno    121s  -29.8  14.2    2222 Hz    4808 Hz    6.4    129  .76  .18   .02   .003   .002
dubstep   111s  -33.5  13.2    1407 Hz    2878 Hz    7.9    125  .84  .12   .01   .002   .001
```

Read it as three questions:

1. **Are all genres in the same loudness ballpark, and is that ballpark reasonable?**
   - All within ~5 LU of each other = consistent mix bus. Good.
   - All ≪ −20 LUFS = master gain too low. Fix at the bus, not per-genre.
   - One genre 6+ LU louder/quieter than the others = that genre's
     instrument set is hot/cold; check `genre-instruments.js`.
2. **Does the centroid / rolloff ranking match genre intuition?**
   - "Dark" genres (ambient, lofi, dub-anything) should have the
     lowest centroids; "bright" genres (edm, trance, metal, dnb)
     should have the highest. Inversions are diagnostic.
3. **Is the dynamic range what the genre wants?**
   - Ambient / jazz: crest > 16 dB. If lower, the limiter or
     compressor is over-applied for genres that need air.
   - Dubstep / dnb / metal: crest 11–14 dB is fine. < 9 dB = pumped.
   - Crest *inversion* (dubstep more compressed than ambient) =
     usually fine; dubstep wants control. Worry if ambient drops
     below 14 dB.

## Step 5 — disambiguate before changing code

Three traps the raw numbers fall into. Re-run with the qualifier
before deciding the metric is real:

- **Sub-band rumble.** The 20–80 Hz bin captures DC offset, opus
  encoding artifacts, and (legitimate) sub-bass. If sub-band > 70%
  across every genre regardless of style, HPF at 30 Hz before
  computing band ratios. Add `y = librosa.effects.preemphasis(y)`
  or a one-line scipy `butter(4, 30, 'hp')` to the analyzer.
- **librosa tempo.** Always check the BPM column against the genre
  default. If ambient reports 144 BPM, the estimator latched onto a
  hi-hat pattern, not the actual pulse. Don't use BPM to infer
  composition issues unless onset_rate also confirms.
- **Single-track outliers.** n=3 means one weird track moves the mean
  4–6%. Spot-check the per-track JSON before committing to a fix.
  The script writes both: per-genre means to stderr, per-track JSON
  to stdout (redirect with `> report.json`).

## Step 6 — close the loop

A finding is only useful if it points to a specific file:

| Finding | Likely fix location |
|---|---|
| All genres too quiet (LUFS) | `public/audio/tone-engine.js` master limiter / output gain |
| All genres bass-heavy (sub > 70% after HPF) | Master EQ shelf in `tone-engine.js`; check default `fx.hipassFreq` in `share/apply.js` |
| One genre's centroid wrong | `public/lib/generator/genre-instruments.js` — its instrument picks |
| One genre's crest wrong | Genre's macro defaults / tempo curve in `composer.go` (compression-equivalent) |
| Onset rate wildly off genre | Composer params in `composer.go` (note density / Euclidean hits) |

**Important:** any change to `genre-instruments.js` defaults or
`tone-engine.js` master FX **changes the audio that future renders
produce, but does NOT update the .webm files already on prod**. Old
CIDs render the old way (the renderer reads the share envelope, which
is frozen). Plan: change the code → re-seed the feed (or wait for
listeners to ⟳-flag stuck tracks) → re-run analyzer → confirm the
intended shift.

### Per-genre mastering targets

`internal/audiorender/mastering.go` holds a genre→`{LUFS, LRA}` table
the renderer consults via `LookupGenre(cid)` before each loudnorm
pass. Three buckets:

- **Spacious** (ambient, lofi, jazz, blues, bossa, country, reggae):
  −17 to −18 LUFS / LRA 13–15. Preserves crest; aiming hotter
  squashes the things that make these genres readable.
- **Club / driving** (techno, house, trance, garage, edm, dnb,
  dubstep, trap, speedcore): −13 to −14 LUFS / LRA 5–7. Streaming-
  tier loud, tight LRA matching how DJs master these.
- **Mid** (metal, funk, synthwave): −14 to −15 LUFS / LRA 8–9.

Unmapped genres fall back to the global `-audio-loudnorm-lufs` /
`-audio-loudnorm-lra` flags. Updates to the table take effect on the
next render — past CIDs are pinned.

**04-28 simulation** (per-genre loudnorm applied offline to the
baseline 9 webms; same analyzer):

| genre | LUFS before → after | crest before → after |
|---|---|---|
| ambient (target −18 / LRA 15) | −34.1 → **−19.3** | 19.0 → 19.5 |
| dubstep (target −13 / LRA 6)  | −31.4 → **−15.0** | 14.7 → 13.1 |
| techno  (target −14 / LRA 7)  | −24.9 → **−15.5** | 13.5 → 13.5 |

Single-pass dynamic loudnorm typically undershoots the target by
1–2 LU; that's why the LUFS column lands ~1.5 LU shy. Acceptable —
the spread tightened from 9.2 LU to 4.3 LU and the genre ordering
is now correct (dubstep loudest, ambient quietest). Spectral fields
(centroid / rolloff / band ratios) were unchanged, as expected —
loudnorm only normalizes loudness, it doesn't EQ. If post-deploy
analyzer runs on freshly-rendered tracks confirm a similar shift,
the spread + ranking are real fleet-wide.

### Render-time loudnorm pass

The renderer applies a single-pass `ffmpeg loudnorm` filter after
capture — target −16 LUFS / −1 dBTP by default (see `-audio-loudnorm-lufs`
and `-audio-loudnorm-truepeak` flags in `main.go`). This lifts the
fleet from its un-normalized −30-ish baseline to streaming-tier
loudness uniformly without per-genre tuning. Disable with
`-audio-loudnorm-lufs 0`.

Side effect: every successful loudnorm pass projects the parsed
integrated-LUFS measurement into `track_analysis` as a partial row
with `source='loudnorm'`. The off-host analyzer worker fills in the
spectral fields later via `PUT /api/analysis/{cid}` — the upsert
COALESCEs by column, so loudnorm's LUFS survives an analyzer run
that omits the field, and vice versa.

The loudnorm pass changes the audio bytes, so existing CIDs are
**unaffected** (they're pinned to the bytes hashed into them). Future
renders only — re-seed or use the rebuild queue to re-render the
catalogue.

## Caveats

- **Opus encoding.** The cached `.webm` files are Opus-encoded. Opus
  applies its own perceptual pre-filtering; the .webm spectrum is
  *not* the source spectrum the browser produced. Treat the analyzer
  as measuring what listeners hear (which is what we care about), not
  what Tone.js generated.
- **No stereo info.** We collapse to mono before analysis. Stereo
  width / phase issues are invisible. Add per-channel decode if
  panning ever becomes a focus.
- **Render variability.** Production runs without `-audio-render`;
  cached audio comes from off-host workers (`scripts/process-rebuild-queue.py`)
  which run chromedp at 1× playback. Same envelope re-rendered = not
  byte-identical (timing jitter, AudioContext drift). Means absorb
  this; single-track comparisons should not.
- **Composer non-determinism.** Same `(genre, seed)` can yield
  different CIDs across server restarts (see memory:
  `composer non-determinism across runs`). Don't try to use this
  analyzer to compare "the same composition before/after a code
  change" by re-seeding — generate fresh CIDs both sides instead.

## Next step (revisit)

The 2026-04-27 baseline run on `(ambient, techno, dubstep)` flagged
three things. Pick up here next time:

1. **Universal LUFS deficit.** All three genres at −30 to −34 LUFS.
   Decide: do we lift master gain (one-line fix, lifts everything
   uniformly, churns no CIDs) or add a final brickwall limiter at
   the bus (richer dynamics control, also a one-line fix)? Either
   way only future renders benefit.
2. **Sub-band dominance (75–84%) — measure first.** Re-run analyzer
   with a 30 Hz HPF before band ratios. If sub stays > 60%, our
   masters are genuinely bass-blob heavy and a high-shelf or gentle
   HPF default belongs in `share/apply.js`. If sub drops below 30%,
   the rumble was the artifact, no action needed.
3. **Dubstep darker than ambient (centroid 1407 < 1635 Hz).**
   Inspect `genre-instruments.js` for dubstep's lead/bass picks.
   Hypothesis: `lead` slot is defaulting to a sub-bass-only patch
   instead of a brighter wobble; or master Hi-Cut default for
   dubstep is over-closing. A/B by ear before changing.

When picking up: re-pull the same 9 CIDs (paths above), re-run
`analyze.py`, confirm the baseline still reproduces, *then* try
fixes one at a time.

### 2026-04-28 datapoint — re-run with 30 Hz HPF, 9 fresh CIDs

Pulled 3 newest-per-genre from prod for `ambient / techno / dubstep`
(top of `tracks` ordered by `rendered_at DESC`, not the same 04-27
CIDs — those weren't pinned). Analyzer now applies a 4th-order
Butterworth HPF at 30 Hz before band-ratio computation; LUFS still
measured on the raw signal.

| genre | n | dur | LUFS | crest | centroid | rolloff85 | onset/s | sub | low | lomid | himid | high |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ambient | 3 | 215s | −34.1 | 19.0 | 2663 Hz | 5067 Hz | 2.5 | .722 | .252 | .017 | .003 | .005 |
| dubstep | 3 | 111s | −31.4 | 14.7 | 2116 Hz | 4418 Hz | 7.9 | .571 | .376 | .042 | .007 | .005 |
| techno  | 3 | 121s | −24.9 | 13.5 | 1991 Hz | 4149 Hz | 7.2 | .523 | .415 | .055 | .004 | .002 |

Read against the three baseline questions:

1. **LUFS deficit — partially holds.** Ambient/dubstep still at
   −31 to −34. Techno mean shifted to −24.9 but it's a single-track
   artifact: one of the 3 techno CIDs ships at **−15.4 LUFS** (sub
   0.10, very different mix from its siblings at −29.5/−29.8 with
   sub ~0.73). Genuine techno baseline ≈ −29.7. Treat the universal
   −30-ish deficit as still real; investigate the −15 outlier
   separately (likely a different `fx` override or a render-path
   regression).
2. **Sub-band post-HPF — bias is real, not all rumble.** Was 75–84%
   pre-HPF; now 52–72% post-HPF. Roughly 10–25 percentage points
   were DC/sub-rumble. What remains is a genuine bass-heavy mix:
   `lomid` (250–2k Hz, the body of every instrument) sits at .02–.06
   across all three genres, which is structurally low. A high-shelf
   or default Hi-Cut adjustment in `share/apply.js` is warranted —
   the rumble fraction is no longer the primary excuse.
3. **Centroid inversion — flipped sign, not fixed.** Old: dubstep
   1407 < ambient 1635 (dubstep too dark). Now: ambient 2663 >
   dubstep 2116 > techno 1991 — ambient is now the *brightest*,
   which is the wrong direction (ambient should be the darkest of
   the three). Likely a side-effect of the bass-light/`lomid`-empty
   spectrum: with no instrument body, ambient's high pad shimmer
   dominates the centroid. Re-check after the bus-EQ change in #2.

Per-track JSON saved to `/tmp/beats-analysis/report.json`; means
table to `/tmp/beats-analysis/means.md`. Outlier to investigate:
`z4EBG9j5kjuqjiQYsxHCSDTxSzTd14e9tBJyFkEBKpM8LPSagXA` (techno,
−15.4 LUFS).
