# Wave engine (`?engine=wave`)

Audio as a function of the Petri-net marking, computed sample by sample in an
AudioWorklet, instead of Tone.js instruments triggered by transition fires.
The net stays the source of truth; the wave is a projection of it. The
default engine is unchanged; this one is opt-in with `?engine=wave`.

Read `NOTES.md` first. It covers how the existing sequencer works and what
that implies for this engine.

## Files

| file | what |
|---|---|
| `synth.js` | pure functions: pulse shapes, `ringOf`, `envelope(ring, marking, phase)`, `ringSpectrum`, `carrier`, `mix`, voice specs, wavetables |
| `net.js` | the executor compiled to typed arrays (`compileProject`, `tick`), plus `incidenceMatrix` / `pInvariants` |
| `runner.js` | `WaveRunner`: tick clock + lanes + mix; allocation-free `process(L, R, frames)` |
| `worklet.js` | `AudioWorkletProcessor` `'wave-engine'` wrapping a `WaveRunner` |
| `node.js` | page-side `createWaveEngine(ctx, connectTo)` |
| `offline.js` | `renderOffline({genre, seed, structure, seconds})`, `encodeWav` |
| `../lib/backend/wave.js` | studio glue: transport routing, project hand-off, tick replay into the UI |

## The model

**A ring is Z_n.** Every music net the composer emits is a single-token
cycle `p_i → t_i → p_(i+1)` (verified in NOTES.md). Give `t_i` the weight
`w_i = velocity/127`, or 0 for a rest. The ring's gate is the periodic
superposition of one pulse per firing:

    g(t) = Σ_i w_i · P(t − i·Δ)            Δ = one tick, T = n·Δ

with `P(t) = Σ_e α_e e^{−t/τ_e}`. The default is two exponentials, a 1 ms
attack and a decay, so onsets don't click.

**Its spectrum is the DFT of the place weights:**

    c_k = P̂(k) · (1/n) Σ_i w_i e^{−2πi k i/n}

These are the characters of Z_n. `ringSpectrum` evaluates the sampled form
exactly, `P̂(k) = (1/M) Σ_e α_e / (1 − m_e e^{−2πik/N})` with M samples per
tick, N = n·M and m_e = e^{−1/(τ_e·sr)}. The test then checks it against a
DFT of a rendered gate.

**Rings modulate; they are not tones.** 1/T is sub-audio, so each lane
outputs `y = g(t) · carrier(t)`:

- kick: a sine swept from `f1·octaves` down to `f1`, using the same octave
  constants as each kit in `tone-engine.js`;
- snare: band-passed noise plus a 180 Hz body;
- clap: band-passed noise;
- hats: high-passed noise;
- melodic rings: a band-limited wavetable at the pitch bound to the
  transition that just fired. Pitch is therefore a function of the marking,
  because the token's place determines which transition fired. Each melodic
  ring has a small deterministic voice pool (4, or 6 for harmony) so that
  strummed pads can overlap.

**Closed form vs realisation.** `envelope(ring, marking, phase)` is the
stationary closed form. With the token on `p_j` and a fraction `phase` of the
current tick elapsed,

    g = Σ_e α_e e^{−phase·Δ/τ_e} · Σ_{m<n} w_(j−1−m) a_e^m / (1 − a_e^n),   a_e = e^{−Δ/τ_e}

The runner computes the same gate as its IIR realisation: one state per
exponential, multiplied by `m_e` each sample and bumped by `α_e·w` at each
onset. That costs O(1) per sample, is exact once a ring period has passed, and
keeps tails continuous across control switches.

**Where the picture stops being exact.** Shared transitions, inhibitor arcs
and choice points break pure periodicity. In the composer's output they occur
only in control nets: `struct-*` gates with inhibitor arcs and drained delay
places, firing `mute-track` / `unmute-track` / `activate-slot`. They are
applied as seeded, deterministic switches of the ring weights at tick
boundaries. A muted ring makes no new onsets, and what is already sounding
decays. Conflicts are resolved with the worker's own
`deterministicRand(tick, strHash(place))`.

**Rings of rings.** `opts.mods = [{target, source, kind: 'am'|'fm', depth,
silentSource}]` lets an outer ring's gate scale (AM) or bend (FM) an inner
one. Nothing in the composer's output uses it yet; it is tested and opt-in.

## Determinism

`(genre, seed, structure)` → `compose` → project JSON → `WaveRunner` gives the
same bytes every run. Tested in-process and across two separate processes.
There is no `Math.random`, no wall clock and no `Date.now` on the render path.
Noise is per-lane xorshift32 seeded by lane index. Bytes are identical across
runs on the same JS engine. `Math.sin`/`exp`/`tanh` are not bit-specified
across engines, so cross-browser byte identity is not claimed.

## Tests

```bash
make test-wave           # node scripts/test-wave-engine.mjs (also run by `make test`)
make test-wave-browser   # headless Chrome over CDP against the real studio
bazel test //scripts:wave_engine_test
```

| check | result (techno seed 42 unless noted) |
|---|---|
| byte-identical WAV, same process and two processes | ✓ |
| every music ring has the all-ones P-invariant | 40/40 rings |
| y·M constant at every tick, every net, full `standard` song | 928 ticks × 60 nets, drift 0 |
| DFT of a rendered ring gate vs predicted c_k (hi-hat ring with ghost notes, n=8, 48 bins) | max rel. err 4.5e-10 |
| `envelope()` closed form vs rendered gate, every sample of a period | max abs err 3e-8 (float32 output) |
| compiled executor vs the worker's tick semantics, full song | identical markings + audible fires, 896 ticks |
| seeded conflict resolution vs the worker | identical over 400 ticks |
| AM-nested ring = inner × outer gate | max abs err 1e-7 |
| project loaded mid-play swaps on the next bar | ✓ |
| per-sample path allocation | ~0.2 B/block (none) |
| tick-boundary allocation | 66 B/tick (Node 25), 193 B/tick (Node 22) |

Seven control nets (`struct-snare`, `struct-kick`, …) have **no** P-invariant.
Their delay tokens are drained and the last gate is a sink, so they are not
conservative. The test reports them rather than failing on them.

On allocation: the per-sample loop (lanes, gates, carriers, mix) keeps every
mutable number in typed arrays, because V8 boxes a double that is written to
an object field. Tick-boundary work (firing plus note onsets, about 8 times a
second) is too cold for V8 to optimise, and its baseline tiers box double
temporaries. That costs a bounded few hundred bytes per tick, about 2 KB/s.
The worklet also allocates its UI messages on blocks that contain a tick.

## CPU per 128-sample block

`make wave-bench` (`scripts/wave-bench.mjs`) times `process()` block by block
in Node on valoper (desktop x86, shared host, load ≈ 3). The budget at 48 kHz
is 2667 µs.

| case | lanes | mean µs | p99 µs | mean % of budget |
|---|---|---|---|---|
| techno/loop | 10 | 43.5 | 63.1 | 1.6% |
| techno/standard | 40 | 57.0 | 106.1 | 2.1% |
| edm/standard | 53 | 68.3 | 136.7 | 2.6% |
| jazz/standard | 47 | 49.0 | 95.4 | 1.8% |
| ambient/extended | 53 | 101.6 | 364.9 | 3.8% |
| dnb/standard | 42 | 94.2 | 289.6 | 3.5% |

**Not measured on a phone.** The bench's "phone" column multiplies by an
assumed 6× slowdown, which puts the worst p99 at 31–82% of budget. Treat that
as an estimate to check on a device, not a result. Isolated max outliers of
13–22 ms appeared on this shared host. They are unattributed: they did not
reproduce from run to run, and the mean and p99 don't show them. The
comparison that matters for beats-bitwrap-io#2 is against the Tone path, which
builds a node graph per voice. That comparison still needs a device.

## Studio integration

In wave mode Tone gets a **native** `AudioContext`
(`prepareWaveContext`). Tone's default standardized-audio-context wrapper
re-wraps worklet modules as classic scripts, which breaks ES `import`. The
worklet's output joins `toneEngine._masterVolume`, so master volume, the
master bus and the recorder / render-farm tap still apply. The sequencer
worker keeps composing but never plays. Transport goes to the worklet, and its
ticks are replayed into `handleWsMessage` as `transition-fired`, `state-sync`,
`control-fired` and `mute-state`. The canvas, mixer and Stage visualizers
therefore read the marking the audio is computed from.
`onRemoteTransitionFired` skips Tone when `el._waveEngine` is set.

**Not yet in wave mode:** macros (`fire-macro` restore nets live in the
worker), loop/seek, swing/humanize, live transpose, per-channel MIDI/device
routing, Tone instrument choice (the wave voices are chosen by instrument
family), and offline export via `share/offline-render.js`. The master FX
chain sits downstream of `_masterVolume`, so it does apply.
