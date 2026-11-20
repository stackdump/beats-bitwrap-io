# parity: does the ENGINE sound like the STREAM?

beatscript.app plays a program two ways (`pickSource`, `web/js/app.js`):

- **stream**: `GET /api/render/<cid>`, which pipes `btwd render` (djrust-vevr-se `crates/btwd`) through a WAV header or ffmpeg.
- **engine**: `web/js/engine.js` + `web/js/engine-calls.js` driving djrust's wasm facade (`Dj`) in an AudioWorklet.

This directory renders both from the same text, headlessly, and compares them bar by bar. Findings, ranked:
[`../../PARITY.md`](../../PARITY.md).

```
make parity                                   # repros + site examples, then the loop check (BTWD= the btwd binary)
node btwsite/test/parity/run.mjs --corpus repros,examples,<dir>... [--only REGEX] [--keep-wav] [--out DIR]
node btwsite/test/parity/loop.mjs             # `loop` in the engine vs the same arrangement written out
node btwsite/test/parity/loop-status.mjs [file.btw]   # the header's numbers through a looping program (Node only)
PARITY_WASM_DIR=<dir with btw.js, btw_bg.wasm> ...    # test another build of the module (the deployed one, say)
```

Needs `btwsite/web/wasm/` (djrust-vevr-se `scripts/build-web-wasm.sh btwsite/web/wasm`), Chrome (`CHROME=`, default
`/usr/bin/google-chrome` or the macOS path) and btwd (`--btwd`, `BTWD_BIN`, or `btwsite/bin/btwd`). Each script prints
SKIP and exits 0 when one is missing. Chrome must be able to open its DevTools port: inside a network sandbox that
blocks it, the launch fails with "Chrome did not come up".

## How

- **stream**: `btwd render --sr 48000 --format s16le --max-bars 512`, the same bytes the site serves (without the header).
- **engine**: `web/parity.html` runs the real `createEngine` into an `OfflineAudioContext`. The context is suspended every
  1024 frames (~21 ms, the page's 25 ms loop) and the loop body runs then: `engine.apply(run.service(engine.grid()))`.
  The worklet's grid reports are let in first; the composer's compile of a net is waited for (a live page hides it behind
  the bar of notice the runtime gives). The master is captured exactly and posted to the harness as s16.
- **align**: the engine's first sound against the stream's, refined by cross-correlating onset envelopes over 4 bars.
- **measure** (`analyze.mjs`), per bar: RMS, BS.1770 K-weighted loudness, sample and 4x true peak, mean |log-mel
  difference| (64 bands), local onset offset and onset-envelope correlation. A bar is flagged at |dLUFS| > 3 LU,
  mel > 6 dB, onsets > 15 ms or onset correlation < 0.6; each program also gets integrated LUFS (gated) for both.
- **stats.slow**: the page is opened with `?perf=1`, so the worklet reports every block of 3 ms or more with where the time went;
  each is placed in a bar of the render (`perf` per program and in `report.json`: slow bars, how many are flagged, section
  starts with a slow block and whether they landed late). Real-time slow blocks and underrun: `test/audio-perf.mjs`.
- **inventory**: every registry call the runtime hands the engine is recorded with the engine's `ignored` events and
  the console's `btw engine: ignoring ...` lines.

`--gate REGEX` (default `^00-base$`, the repro with no control lines) names programs that must not have a flagged bar;
the run exits 1 otherwise. With no control lines the two renders are sample-identical today, so the gate catches any
drift in the engine path (a message landing a quantum late, a different start, a changed voice).

## The repros

`repros/NN-*.btw`: one 8-bar base groove (kick, hats, clap on A; sub bass and pad on B) plus one feature each, so a
difference is the feature's. `00-base` has none.

## Outputs (git-ignored, `out*/`)

`report.json` (every program's summary, the engine's ignored calls, the calls it got), `RESULTS.md` (ranked table),
`<name>.json` (bars, runtime trace, deck starts), and with `--keep-wav` both renders, the engine's trimmed to the
stream's first downbeat.
