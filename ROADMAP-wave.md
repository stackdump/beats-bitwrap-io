# Wave engine roadmap — every instrument on the wave engine

The goal is to move all 72 instruments in `tone-engine.js` onto the wave engine
(`public/wave-engine/`, opt-in `?engine=wave`) and make wave the default.
Whether Tone.js is then removed entirely, kept as a thin audio-graph layer,
or kept as a "classic" engine is **a decision (D-1), not an assumption**; it
gets made with data once the instruments are converted. Read `public/wave-engine/NOTES.md` and `README.md`
first; this file sequences the remaining work.

## Status snapshot

| Phase | Title | Status |
|---|---|---|
| W-0 | Engine core: executor in worklet, ring gates, offline WAV, tests | ✅ `b0a896d` (branch `wave-engine`) |
| P-0 | Mobile: on-device bench (standalone + in-app), lean output path, `playback` latency, `Tone.context` fix | ✅ (branch `wave-engine`) |
| P-1 | Reference devices + budget gate on every phase | 🟡 high-end Android measured (`docs/perf/`); in-app submissions + `/wave-engine/results.html` collect the rest |
| P-2 | Quality tiers (full / lite / eco), deterministic per setting | 🔜 |
| P-3 | Live underrun detection + auto step-down | 🔜 |
| P-5 | Field telemetry: taps / focus / ctx / late notes / stops → `/api/telemetry/summary` | ✅ (branch `telemetry`) |
| P-4 | Main-thread + battery: live visual-lag detection + adaptive visuals ✅ (branch `perf-monitor`); idle suspend 🔜 | 🟡 |
| W-1 | Voice spec format, A/B fidelity harness, coverage gate | 🔜 |
| W-2 | Channel strip in the worklet (vol/pan/LP/HP/decay/accent, per-drum-voice filters) | 🔜 |
| W-3 | Drum kits — all 6, faithful | 🔜 |
| W-4 | Subtractive voices — oscillators, ADSR, filter envelope | 🔜 |
| W-5 | FM / AM voices | 🔜 |
| W-6 | Plucked strings (Karplus–Strong) | 🔜 |
| W-7 | Insert effects as rings (chorus, vibrato, tremolo, phaser, autofilter, delay, drive, crush) | 🔜 |
| W-8 | Stingers, noise-hit, unbound | 🔜 |
| W-9 | Studio parity in wave mode (macros, loop/seek, swing, transpose, routing) | 🔜 |
| W-10 | Master chain + capture in the wave graph | 🔜 |
| W-11 | Render farm on the offline renderer (no chromedp) | 🔜 |
| W-12 | Default flip | 🔜 |
| D-1 | Decide: remove, slim or keep Tone.js | ⏸ decided after W-8 + W-10 measurements |
| W-13 | Execute D-1 | 🔜 |

## Could Tone.js be removed now? No.

Today the wave engine **converts 6 of 72 instruments, approximately**: the
drum kits. Every other instrument plays as a generic family voice (saw, soft,
bell, square or sine wavetable) picked by a regex on its name. Wave mode also
still leans on Tone. Tone owns the AudioContext and the phone `<audio>` sink.
The lean path skips Tone's master chain, but master FX, the recorder and the
render-farm tap only exist as Tone nodes (`&fx=tone`).

What still depends on Tone (`git grep -c "Tone\.\|toneEngine"`, Oct 2026).
The last column says which phase would take each item off Tone *if* D-1
chooses full removal; under "slim", the W-10/W-11 rows can stay on Tone.

| Dependency | Where | Phase that would remove it |
|---|---|---|
| 72 instrument configs + per-channel strips | `audio/tone-engine.js` (306 refs) | W-2 … W-8 |
| Master FX chain: volume → HP → phaser → LP → crush → drive → pitch-shift → compressor, plus reverb/delay | `tone-engine.js` init / `set*` | W-10 |
| FX macros scheduled on Tone params (sweeps, tape-stop, beat-repeat) | `lib/macros/sched.js`, `runtime.js`, `effects.js` | W-9 |
| Stinger one-shots (`_renderOneShot`: airhorn, laser, subdrop, booj) | `tone-engine.js`, `lib/audio/oneshots.js` | W-8 |
| Mixer sliders → `toneEngine.setChannel*` | `lib/ui/mixer*.js`, `controllers.js` | W-2 |
| Audio-grid scheduling against `Tone.now()` | `lib/backend/index.js` | W-12 (wave owns the clock) |
| Offline / client / insert renders via Tone OfflineAudioContext | `lib/share/offline-render.js`, `client-render.js`, `insert-render.js` | W-11 |
| Recorder + `?test=1` capture hooks | `lib/test-hooks.js`, `make test-audio` | W-10 |
| Render farm: chromedp records Tone in real time | `internal/audiorender`, `scripts/process-rebuild-queue.py` | W-11 |
| Per-channel output device routing, mobile `<audio>` sink | `tone-engine.js` `setChannelOutputDevice`, init | W-10 |
| Analysers for visualizers | `getMasterAnalyser` | W-10 |
| Jog lab | `public/jog/demo.js` | W-13 (port or keep a local copy) |
| CDN script tag + SRI pin | `public/index.html` | W-13 |

There's also a product question no code change answers. **Existing share
links and every `.webm` in the feed sound like Tone.** The share CID hashes
the envelope, not the audio, so flipping engines changes what an old
`?cid=` link sounds like without changing its CID. W-12 has to decide that
deliberately.

## Principle: a voice is an impulse response

W-0 used `y = gate × carrier`. The general form, which covers every Tone
instrument, is:

    y(t) = Σ_i w_i · h_v(t − iΔ; note_i, dur_i)

The ring supplies a weighted impulse train; voice `v` supplies a per-hit
response `h_v`. As long as each hit restarts its own voice state, output is
**linear in the place weights**, so the W-0 spectral result
(`c_k = Ĥ(k) · DFT(w)`) keeps holding with `Ĥ` computed numerically.
Nonlinear stages (drive, crush, compressor) stay *after* the sum, as static
or deterministic per-lane processors, and are documented as such. A test
that only holds for the linear part says so.

Determinism rules, carried from W-0: no `Math.random`, no wall clock;
LFOs are phase-locked to the tick clock; noise is seeded per lane; the
per-sample path allocates nothing.

## Performance track — mobile and low-powered devices

The goal: **beats plays without crackle on a cheap phone.** Issue #2 was filed
after the Hacker News traffic (~60% phones) reported no sound, late kicks and
crackle. This track is not a phase that runs once. Its budget **gates every
W-phase**: a converted instrument family that blows the low-end budget isn't
done.

### Where things stand (P-0, measured)

`public/wave-engine/bench.html` renders the same deterministic track (techno,
seed 42, `standard`, 20 s) through each engine into an OfflineAudioContext,
i.e. the same audio graph a live session runs, as fast as the device can.
The result, **×realtime**, is audio-thread headroom. Desktop (valoper, headless
Chrome):

| case | ×realtime |
|---|---|
| A · Tone instruments + Tone master chain (**the default engine today**) | **1.7×** |
| B · wave engine → Tone master chain (`?engine=wave` before P-0) | 4.5× |
| F · wave engine, Tone master unhooked (**`?engine=wave` now**) | **25×** |
| C · wave engine alone | 36–39× |
| D · wave engine alone @ 24 kHz | 55–66× |
| E · wave DSP only, main thread, no audio graph | 48–50× |

What it says:

- The default engine barely clears realtime on valoper (a loaded, shared
  desktop). On the first real phone, an 8 GB Android, it reaches 4.25×,
  while the lean wave path reaches 50×. **Phones are not uniformly slower
  than valoper**: that one was ~2× faster. The ratios are what hold across
  devices: lean wave ≈ 12–15× cheaper than the Tone default. #2's crackle
  points at budget phones, where the default's margin, after live UI and GC
  load, falls below the 3× line. All runs are in `docs/perf/`.
- Tone's master chain costs **~8× the whole wave engine** (B vs C). It runs
  its DSP at `wet: 0`: phase-vocoder pitch shift, −48 dB filters, phaser,
  crusher, reverb and delay buses. #2's fix #1 was exactly this.
- 24 kHz is a ~1.6× cheaper tier (D vs C) for free.
- Side finding: case A peaks at 3.7 (> 0 dBFS). Tone's offline renders clip;
  the master compressor isn't a limiter.

P-0 shipped (all opt-in under `?engine=wave`):

- **Lean output path**: worklet → gain → destination (or Tone's `<audio>`
  stream sink on phones, which keeps iOS playing through screen lock). Tone's
  master chain is unhooked. `&fx=tone` restores the old routing. Master FX
  and FX macros are unavailable on the lean path until W-10.
- **`latencyHint: 'playback'` on phones** (#2 fix #2): the worklet is the
  clock, so only transport/mute response gets slightly slower.
- **`Tone.context` → `Tone.getContext()`**: the deprecated binding still points
  at Tone's original context after `setContext`. In wave mode that made
  Tone's phone init throw (silently: no master, no `<audio>` sink) and made
  `resumeContext`/`isContextRunning` look at the wrong context. It is
  identical on the default engine.
- `scripts/test-wave-browser.mjs` now also runs as an emulated iPhone:
  `playback` latency (baseLatency 21 ms vs 11 ms) and audio through the
  `<audio>` sink.

**In the app:** Help (`?`) → *Benchmark this device*, or `?bench=1`. It runs the
fixed reference track (comparable across devices) or the track currently
loaded, stops playback first, keeps a per-device history in `localStorage`,
and prints a recommendation ("try `?engine=wave`" when the default is
tight). Results can be **submitted** (opt-in, anonymous: timings, UA, model via
client hints, cores, memory, an optional device name; no IP stored) to
`/api/bench`. They are listed at `/wave-engine/results.html`, sortable and
filtered to the reference track by default. That turns P-1's "find a budget
phone" into "read the table". It reaches users when the branch merges.
Until then:

**Run it on a phone:** the bench is published on the CDN (branch build, no
deploy needed): `https://cdn.stackdump.com/ipfs/bafyreie6dbb396ae7f07f199bbdf693df1042e/wave-engine/bench.html`.
Run bench → Copy results; the JSON carries UA, cores and device memory.

### P-1 — Reference devices and the budget gate

- Pick **two reference devices**: one budget Android (a ~$150 Galaxy A / Moto
  G class, 4 GB) and the oldest iPhone worth supporting. Record their bench
  JSON in `docs/perf/` (or as CDN entries, `schema: BenchResult/v1`, so
  they're facets).
- **Budget: ≥ 3× realtime on both reference devices for case F**, for the
  heaviest built-in arrangement (`edm`/`ambient` + `extended`). 3× leaves room
  for GC, UI work and thermal throttling. 1.5–3× is "tight", < 1.5×
  "will crackle", the same verdicts the bench prints.
- `wave-bench.mjs` gets a `--budget` mode that fails CI when desktop
  ×realtime falls below `budget × measured desktop/phone ratio`. The ratio
  comes from P-1's *budget*-device runs. The bench's assumed 6× "phone
  column" is wrong for at least one real phone; drop it once a budget device
  is measured.
- Every W-phase adds its family's worst instrument to the bench before it
  lands.

### P-2 — Quality tiers

Converted voices get cheaper variants, selected per **setting**, never
silently per device. Determinism means "same setting → same bytes", so a
tier is an explicit, stored choice:

| tier | sample rate | voice pool (melodic / pad) | unison copies | oscillator | inserts |
|---|---|---|---|---|---|
| full | 48 kHz | 4 / 6 | as specified | polyBLEP | all |
| lite | 48 kHz | 3 / 4 | ≤ 3 | wavetable | chorus/phaser off |
| eco | 24 kHz | 2 / 3 | 1 | wavetable | none |

- Default: chosen once, at first play, by a 1–2 s main-thread probe (bench
  case E). Stored in `localStorage`, changeable in the UI. **Not** in the
  share envelope: a listener's device doesn't change what the author made.
- The offline renderer and the render farm always render `full`.
- The sound difference per tier goes in the W-1 A/B harness, so "eco"
  is known-acceptable rather than whatever the code happens to do.

### P-3 — Live underrun detection and auto step-down

OfflineAudioContext measures cost, but a phone also has thermal throttling,
background tabs and GC. In the live session:

- Use `AudioContext.playoutStats` where available (Chrome: underrun /
  fallback-frame counts). Elsewhere, a proxy: the worklet reports
  ticks rendered vs `currentTime` progress, so a late-tick count is visible.
- On sustained underruns, step down one tier at the next bar and show a small
  notice ("switched to lite for smooth playback"). Never step up mid-session.

### P-4 — Main thread and battery

**Done: live detection** (`public/lib/perf/monitor.js`). While playing, every
2 s window combines frame pacing, long animation frames (with Chrome's
script attribution), time inside each visual path (timeline, Stage, net
canvas, per-fire flashes), default-engine note scheduling margin (late /
tight), and wave-engine view lag. The verdict is `visualization` | `other` |
`none`. In `auto`, the visuals step full → reduced → minimal → paused only
when the *visualization* is the cause, and come back after a clean stretch.
`?perf=1` shows a readout; the benchmark modal shows the session verdict and
a Visual quality override.

Measured (headless Chrome, CPU throttled to simulate a phone, Stage open,
techno 42):

| engine, throttle | verdict | late notes |
|---|---|---|
| default, 1× | smooth; Stage ≈ 6% of main thread | 0 / 316 |
| default, 4× | visualization blamed in the first 4 windows → reduced → minimal; residual jank "other" | 1 / 315 |
| default, 6× | visualization blamed in 60% → paused; still 21 fps | 2 / 316 |
| wave, 4× | 20 fps, visuals 15% of main thread; audio unaffected (view lag 24 ms) | — |
| wave, 6× | visuals reduced; audio unaffected (view lag 52 ms) | — |

So on a slow main thread the visualization **is** a measurable cause of
lag, and in the default engine it costs notes. In the wave engine it can
only make the picture trail the sound.

Still to do:

- **Visuals** (#2 fix #4): coalesce `transition-fired` / `state-sync`
  rendering to `requestAnimationFrame`. Skip off-screen nets and the
  canvas entirely while the Stage is open. Under `max-width: 720px`, render
  the active net only.
- **Message volume**: the worklet already posts one batched message per tick
  and the marking every 6 ticks. On phones, send the marking every 16
  ticks (once a bar); the mandala interpolates.
- **Battery**: suspend the AudioContext after ~30 s stopped; `process()`
  returns early (no lane work) while stopped. Pause the Stage's rAF loop when
  the page is hidden.
- The default (Tone) engine keeps its own #2 mitigations independently
  (idle-FX bypass, polyphony cap) until W-12. Users are on it until then.

## W-1 — Voice spec format, fidelity harness, coverage gate

Everything after this is data plus a few DSP primitives, so build the
tooling first.

- **`WAVE_VOICES`** (`public/wave-engine/voices.js`): one declarative entry
  per instrument id, the same keys as `INSTRUMENT_CONFIGS`. Shape:
  `{ osc, unison, detune, env:{a,d,s,r}, filter:{type,fc,q,env}, fm:{ratio,index,env},
  pluck:{…}, inserts:[…], gain, poly }`. It replaces the regex in
  `synth.js::tonalVoice`. Instrument changes (mixer `»`, shuffle,
  `instruments-changed`) post `{type:'instrument', netId, name}` to the
  worklet, and the voice swaps on the next onset.
- **Coverage gate** in `test-wave-engine.mjs`: list every
  `INSTRUMENT_CONFIGS` key that lacks a `WAVE_VOICES` entry. It reports during
  migration and must reach 72/72 before W-12.
- **A/B harness** (`scripts/wave-ab.mjs` + a page under `public/wave-engine/ab.html`):
  for each instrument, render the same probes through Tone's
  OfflineAudioContext and through the wave engine. Probes are one note at
  C2/C4/C6 at velocity 64 and 127, a 16-step ring, and a held note.
  Compare features rather than samples: attack time, T60 decay, spectral
  centroid over time, harmonic amplitudes for the first 8 partials, RMS.
  Tolerances live per family. Output is a table plus WAV pairs.
- **Listening review**: publish each family's A/B pairs to the CDN
  (`schema: WaveAB/v1`, `parents:` → the W-0 renders), so judging by ear
  doesn't need a checkout.
- Bench grows a per-voice column (µs per active voice per block).

Done when the harness runs on the 6 drum kits and the gate prints coverage.

## W-2 — Channel strip in the worklet

**Where W-0 stands.** Internally the engine is polyphonic and per-net: one
lane per ring (per drum kind for kits), and a 4–6 voice pool on each melodic
ring. Techno/standard runs 40 lanes. But every lane is summed **inside the
worklet into one mono signal**, written identically to L and R, and leaves
through one AudioWorkletNode output. So the track does reach the speakers as
a single voice: there is no per-channel strip, pan, stem or device routing
after the sum. That is why mixer controls do nothing in wave mode yet.

Two ways to fix it, and they compose:

- **Multi-output worklet (do first).** `numberOfOutputs = channels in use`,
  one stereo output per MIDI channel, each connected to that channel's
  existing Tone (later native) strip. The mixer works unchanged, stems and
  per-channel device routing come for free, and it can ship before any
  in-worklet DSP. It is also the bridge during migration: unconverted
  instruments keep playing in Tone, converted ones arrive on their own
  output into the same strip. Cost: one graph edge per channel, and
  *live* channel processing lives outside the worklet, so it is not in
  the offline render.
- **In-worklet strip (the deterministic path).** The same strip as JS DSP,
  so the offline renderer and the render farm hear exactly what the live
  path plays. Needed before W-11, and before "remove" or "slim" in D-1.

The in-worklet strip maps the mixer controls so that converted instruments
respond the way they do today:

- volume, pan, mute/solo → lane gain and constant-power pan (stereo output);
- `setChannelCutoff` / `Resonance` / `LoCut` / `LoResonance` → per-channel SVF
  LP + HP (TPT form, coefficients recomputed only on change);
- `setDrumVoice*` → the same per drum role inside a kit;
- `setChannelDecay` / `Accent` → scale of the pulse decay `τ` / velocity curve;
- `INSTRUMENT_GAIN` table → voice `gain`.

Mixer code calls a thin `audioParam(channel, name, value)` that routes to Tone
or to the worklet, so `mixer*.js` stops importing `toneEngine` directly.
The message is `{type:'channel', ch, param, value}`; the worklet applies
it at the next block, deterministically.

## W-3 — Drum kits (6, ~49% of everything composed)

Usage, from 19 genres × 50 seeds: `drums` 24%, `drums-v8` 14%, `drums-cr78`
7%, `drums-breakbeat` 2.5%, `drums-808` 0.9%, `drums-lofi` 0.8%.

- Kick: MembraneSynth sweep is exponential from `note·octaves` to `note` over
  `pitchDecay`, plus the triangle click layer (`kickClick`, −12 dB).
- Snare: the noise envelope and the membrane body have *separate*
  envelopes (body 0.08 s), so model them as two lanes sharing one ring.
- Clap: three bursts at 0, 10 and 20 ms with velocities 0.5, 0.6 and 1.0,
  as one pulse made of three shifted exponentials. The impulse response stays
  linear, so the closed form survives.
- Open/closed hat by note (42–46 vs 49/57); hat choke is a deliberate
  nonlinearity, documented.
- `drums-lofi`: 8-bit crush + 3 kHz LP (W-7 primitives).

Done when the A/B harness is within tolerance for all six and they sound
right in the review.

## W-4 — Subtractive voices (the bulk: ~45 instruments)

New DSP primitives, each with a unit test:

- **Band-limited oscillators** — saw, square, pulse/PWM, triangle, sine;
  polyBLEP (no tables), so pitch never aliases. `fat*` / supersaw =
  N detuned copies (`unison`, `detune`) with deterministic start phases.
- **ADSR as a duration-gated pulse** — attack/decay/sustain exponentials
  until the note's resolved `durationSteps`, then release from the level
  reached. It is still linear in `w`, so the IIR form is exact; note-off is a
  per-voice countdown in samples.
- **Filter + filter envelope** (MonoSynth `filterEnvelope`) — per-voice SVF
  with cutoff `base · 2^(octaves·env)`, coefficients updated at control rate
  (every 16 samples).
- **Glide/portamento** where Tone's MonoSynth uses it.

Order by how often each instrument is heard:

1. **Pads** — `dark-pad` (16%, the second most-heard instrument), `warm-pad`,
   `pad`, `strings`, `glass-pad`, `choir`, `am-pad`*. Poly 6, slow attack,
   chorus (W-7).
2. **Basses** — `sub-bass`, `reese`, `bass`, `acid` (resonant filter env),
   `drop-bass`, `duo-bass`, `808-bass` (drive), `rubber-bass`*, `fm-bass`*.
3. **Leads** — `lead`, `square-lead`, `pwm-lead`, `sync-lead`, `trance-lead`,
   `tape-lead`, `duo-lead`, `distorted-lead`, `scream-lead`, `screech`,
   `hoover`, `chiptune`, `laser`.
4. **Stabs / poly saws** — `supersaw`, `big-saw`, `detuned-saw`, `rave-stab`,
   `edm-stab`, `edm-pluck`.
5. **Keys / organ / wind / brass** — `piano`, `clavinet`, `organ`, `rave-organ`,
   `brass`, `trumpet`, `sax`, `flute`, `sine`.
6. **LFO-driven** — `wobble-bass`, `wobble-lead`, `talkbox` (AutoFilter
   tempo-synced, so the LFO is a ring: W-7).

(* also needs W-5.)

## W-5 — FM / AM voices (12)

Two-operator FM/AM with a modulation-index envelope. Every operator is a
phase accumulator, so it stays closed-form in `t` and exactly deterministic.

`fm-bell`, `vibes`, `marimba`, `kalimba`, `music-box`, `steel-drum`,
`metallic`, `fm-bass`, `electric-piano` (fmsine + tremolo + chorus),
`rubber-bass` (fmsawtooth), `am-bell`, `am-pad`.

## W-6 — Plucked strings (8)

PluckSynth is Karplus–Strong: a delay line of length `sr/f` with a damping
filter, excited by a noise burst. The ring's impulse train *is* the
excitation, which is the cleanest fit to the model:
`y = KS_f * Σ w_i δ(t − iΔ)`, so `Ĥ` is the string's comb response. Seed the
burst noise per lane. Allocate the delay lines at load, sized for the lowest
note in the net.

`pluck`, `bright-pluck`, `muted-pluck` (dampening/resonance params),
`sitar` (+ vibrato), `harpsichord`, `acoustic-guitar` (+ filter),
`electric-guitar` / `distorted-guitar` (+ drive).

## W-7 — Insert effects as rings

Out of scope for W-0, but needed for timbre: chorus is half of what makes
`dark-pad` sound like `dark-pad`. Each insert is a per-lane processor after the
voice sum:

| Insert | Model | Note |
|---|---|---|
| Chorus, Vibrato | modulated fractional delay (≤ 30 ms) | LFO phase-locked to the tick clock: an LFO *is* a ring, i.e. W-0 nested FM |
| Tremolo | gain LFO | W-0 nested AM, already implemented |
| Phaser | 4–8 allpass stages, LFO-swept | |
| AutoFilter | SVF cutoff from an LFO | tempo-synced (`'8n'` etc. → whole ticks) |
| PingPongDelay | stereo delay, time in ticks (`'8n'` = 2 ticks) | pre-allocated buffers |
| Distortion | static waveshaper (Tone's curve) | nonlinear, post-sum |
| BitCrusher | sample-and-hold + quantise | nonlinear, deterministic |
| Compressor | feed-forward, deterministic envelope follower | nonlinear |

Free-running Tone LFOs (`chorus.start()`) depend on wall time. In wave mode
they lock to ticks, which changes the sound slightly and makes it
reproducible. Accept the difference.

## W-8 — Stingers, noise-hit, unbound

- `airhorn`, `laser`, `subdrop`, `booj`: port `_renderOneShot`'s layer recipes
  into voice specs. They become ordinary per-hit responses on the `hit1–4`
  rings, transposed by `note − 60` as now.
- `noise-hit`: seeded noise and an envelope.
- `unbound`: no lane, but the net still fires, so paired macros keep working.

## W-9 — Studio parity in wave mode

These are not instruments, but they must work before a default flip:

- **Macros**: the worker builds the restore net and posts it to the worklet
  (`{type:'add-net'}`); FX-param macros (sweeps, tape-stop, beat-repeat,
  half-time) become per-block parameter ramps in the worklet, scheduled in
  ticks, not seconds.
- **Loop / seek / crop**: port `fastForwardTo` (a silent replay; the compiled
  executor is fast enough, ~75 µs per tick for the largest song).
- **Swing / humanize**: deterministic per-tick sample offsets and velocity
  jitter seeded by `(tick, net)`; the drift path the same way.
- **Live transpose, hit-pad pitch, mute-note**: worklet messages.
- **Per-channel MIDI routing**: MIDI channels keep firing Web MIDI from the
  page using the wave tick stream; audio channels render in the worklet.
- Auto-DJ, Feel, macro/feel curves: these already arrive as control events;
  check each one.

## W-10 — Master chain and capture in the wave graph

- **Mobile constraint (from P-0):** the master chain must cost nothing when
  idle. Tone's runs full DSP at `wet: 0` and costs ~8× the whole engine.
  Instantiate an effect only while it is non-neutral, and crossfade it in
  and out at a bar boundary so connecting it doesn't click.
- Port the master chain (volume, HP, phaser, LP, crush, drive, pitch-shift,
  compressor, reverb, delay) into the worklet or into native Web Audio nodes
  (`BiquadFilterNode`, `DynamicsCompressorNode`, `ConvolverNode`, `DelayNode`).
  Native nodes are fine and cheaper, but they make the *offline* render depend
  on the browser. Default: native nodes for live playback, the same DSP in JS
  for the offline renderer, with an A/B test between them.
- Pitch-shift (phase vocoder) is the hard one. Decide whether to port it,
  replace it with a resampling pitch macro, or drop it.
- Recorder via `MediaStreamDestination` + `MediaRecorder` on the native
  context; analysers via `AnalyserNode`; output-device routing via
  `AudioContext.setSinkId` / the existing `<audio>` element sink for mobile.

## W-11 — Render farm on the offline renderer

This is the biggest operational win. The Node offline renderer runs at
~50× realtime on valoper; chromedp records in real time. Add
`-audio-render-mode wave`: render the share envelope with
`scripts/wave-render.mjs`, encode to `.webm`/Opus (ffmpeg), and upload through
the existing `X-Rebuild-Secret` path with `audio_provenance='renderfarm'`.
A 3-minute track goes from ~3 minutes per worker to a few seconds. Bake the
whole feed this way only after W-12 decides what old links should sound like.

## W-12 — Default flip

Preconditions: coverage gate at 72/72, A/B within tolerance for every
family, W-2/W-9/W-10 done, and the P-1 budget met on both reference devices. That covers
beats-bitwrap-io#2, which only has a desktop estimate so far.

The decision this phase must make: **which engine plays an existing share?**

- (a) everything flips; old links sound different and their feed `.webm`
  renders are rebaked by the converge sweep; or
- (b) add an `engine` field to the share envelope (new shares carry
  `"wave"`; absent means `"tone"`). Old CIDs keep their sound, but only until
  Tone is removed, at which point (b) collapses into (a).

(b) is only durable if D-1 keeps Tone's instruments ("keep" below);
under "remove" or "slim" it just delays (a). So W-12 and D-1 are decided
together. Whichever way it goes, take a snapshot first
(`/api/snapshot-persist?label=pre-wave-flip&audio=1`) so the Tone-era audio
stays retrievable, and announce it under the archive policy `/help` already
states.

Roll out behind `?engine=tone` as an escape hatch for one release.

## D-1 — Is removing Tone.js necessary?

Converting the instruments is valuable on its own: the polyphony ceiling goes,
renders become deterministic and phone CPU (#2) improves, and none of that
requires deleting Tone. Removal is a separate cost/benefit call. Make it
after W-8 (every instrument converted) and W-10 (master chain options
prototyped), when the numbers below exist.

**Options**

| | What stays on Tone | Cost | Benefit |
|---|---|---|---|
| **Remove** | nothing | port the master chain incl. the pitch-shift vocoder, recorder, analysers, device routing, jog lab; retire chromedp | one engine, one determinism story, no CDN dependency, smallest page |
| **Slim** | AudioContext ownership + master FX chain + recorder/analysers; **no instruments** | almost none beyond W-1…W-9; delete the 72 configs and PolySynth code | most of the gain for least work; the master chain (incl. pitch-shift) keeps working untouched |
| **Keep** | everything; Tone instruments remain as `engine: "tone"` for old shares | two engines maintained indefinitely; every new feature built twice or Tone-only | old `?cid=` links keep their original sound forever |

**Measure before deciding**

1. **Page weight / load**: Tone.js transfer size and parse + compile time
   on a mid-range phone, versus the wave modules.
2. **Phone CPU of the master chain**: run the wave engine with Tone's master
   chain against the same with native nodes, on a device. If Tone's chain
   is not what costs CPU, "slim" loses nothing.
3. **Offline/live parity**: can the offline renderer match the live master
   chain without Tone (W-10 A/B)? If not, "slim" leaves the render farm
   needing a browser, and W-11's no-chromedp win depends on "remove".
4. **Pitch-shift usage**: how often the pitch macros fire in real sessions and
   shares. That determines whether porting the vocoder is worth it.
5. **Old-share sound**: does anyone care that Tone-era links sound
   different? This is a product call, not a measurement. It only matters
   for "keep".
6. **Maintenance**: count Tone-path bug fixes and features over the last
   6 months as a proxy for what a second engine costs.

**Current lean: slim**, pending the measurements. It captures the
instrument-side wins without porting the pitch-shift vocoder. The one thing
that would push toward "remove" is (3): if the render farm can only drop
chromedp by dropping Tone, that operational win probably justifies it.

## W-13 — Execute D-1

- **Remove**: delete `audio/tone-engine.js`, the CDN `<script>` + SRI pin
  in `index.html`, the `sw.js` entry and the `?engine=tone` hatch;
  `prepareWaveContext` becomes a plain `new AudioContext()`;
  `internal/audiorender` (chromedp) and the realtime render mode retire;
  `make test-audio` re-targets the offline renderer; the jog lab ports or
  vendors its own copy. Done when `git grep -n "Tone\b\|toneEngine" public internal`
  returns nothing.
- **Slim**: delete the instrument configs, PolySynth/voice code,
  `loadInstrument`, `playNote` and stinger factories from `tone-engine.js`.
  What remains is the context, master chain, recorder and analysers,
  renamed to something like `audio/master-chain.js`. Done when
  `git grep` finds no `Tone.*Synth` in `public/`.
- **Keep**: add the `engine` envelope field (schema + Go/JS canonical
  parity + `shareFromPayload`), default new shares to `"wave"`, and give the
  Tone path a maintenance owner.

All three: remove the polyphony-ceiling note from CLAUDE.md. There are no
PolySynths on the default path and no 256-voice limit; voice pools are fixed
per lane.

## Risks

- **Timbre drift.** The A/B harness measures it and the review judges it.
  Some instruments will sound *different*, not worse: tick-locked LFOs, no
  free-running chorus. Decide per instrument, in the review, not in code.
- **Phone CPU with rich voices.** Supersaw unison × poly-6 pads is the worst
  case; budget it per voice in the bench, and fall back to fewer unison copies
  per device class if needed. That fallback must be deterministic per
  *setting*, not per device, or renders stop being reproducible.
- **Cross-engine float.** `Math.sin`/`exp` are not bit-specified, so the render
  farm must pin one runtime. Byte-identity is promised per engine, not across
  browsers.
- **Scope creep in W-7/W-10.** Effects are where a "DSP library" grows. Port
  exactly what the 72 configs and the master chain use, nothing speculative.
