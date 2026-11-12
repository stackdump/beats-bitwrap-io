# Moving beats.bitwrap.io onto the djrust engine (WASM), and off Tone.js

**Status 2026-11-12: plan + phase 1 on branch `djrust-wasm-phase1`. Nothing is pushed or deployed.**

One engine everywhere: the Rust engine in [`djrust-vevr-se`](https://github.com/stackdump/djrust-vevr-se)
(`djengine`) already runs the Swift DJ app's generator and wave engine on Linux. This plan runs
the same code in the browser as WebAssembly, so `public/lib/generator/*.js`, the JS wave engine
and `tone-engine.js` stop being three more copies to keep in lockstep by hand.

This file sits beside `ROADMAP-wave.md`, which already plans "every instrument on the wave engine"
(W-1 … W-13, decision D-1 on Tone). The two fit: **djrust-WASM is the implementation of the wave
engine that W-1 … W-10 would otherwise write again in JS**, and this file adds the parts
`ROADMAP-wave.md` does not cover (the generator, shares and CIDs, the build, licensing). Where a phase
below is a W-phase, it says so.

## 1. Constraints and how each is held

| Constraint | How it is held | Evidence today |
|---|---|---|
| **Shares stay deterministic** | The note stream is a pure function of `(genre, seed, structure, overrides)`; djengine has no clock and uses `libm` for every transcendental, so the audio is a pure function too — bit-identical on every target and every browser, which the JS wave engine cannot promise (`ROADMAP-wave.md` "Cross-engine float"). | 5 of 6 test renders bit-identical to the JS wave engine, the 6th within 6e-8; two wasm instances render identical bytes; Chrome's offline render equals Node's byte for byte. Firefox / Safari **not yet run** (§9). |
| **`BeatsShare` v1 envelope and the CID scheme stay compatible** | Nothing in the envelope, the schema or the canonicalisation changes. The engine choice is a URL flag, never a payload field. The Rust CID code (CIDv1, dag-json, sha2-256, base58btc; model CID = hex sha256 of `canonicalProjectJSON`) is the same bytes as `codec.js` / `seal.go`. | 152 compositions (19 genres × 2 seeds × loop/standard × default/`v1` cohesion) return the same project document **byte for byte** and the same model CID as this repo's live JS. djrust's own fixtures add the 304-project matrix, trait overrides and 542 Go-generator cases. **No CID changes anywhere in phases 1–5.** §6 lists exactly where one could. |
| **Go/JS parity tests keep passing until the JS path is retired** | Nothing Go or JS under test is edited. `go test ./...`, `make test-wave`, `make test-model-parity` / `//tools/parity`, `//scripts:cohesion_parity_test` are the gate on every phase. When the JS generator is retired (phase 7) the parity legs move to Go↔Rust, which djrust already has as `go.json` (§5.1). | `go test ./...` green; `test-wave-engine`, `test-sw`, `test-cohesion-parity`, `test-wave-browser` green on this branch. |
| **Only public, reuse-licensed sources** | Nothing was copied from outside the two repos. The wasm's dependency closure is `sha2`, `miniz_oxide`, `libm`, `once_cell` and their dependencies: all MIT, Apache-2.0, Zlib or 0BSD (checked with `cargo metadata`, 2026-11-12). No SoundFonts, Apple content or samples are in the browser build (`djhost`'s SF2 / EXS code is not in `djwasm`). The A/B harness (phase 3) renders from the two engines themselves, so it needs no third-party audio either. | The one thing that is **not** public and reuse-licensed is djrust itself (private, `UNLICENSED`): §8. |

## 2. What is where today

**beats-bitwrap-io (public, MIT).** The studio is `<petri-note>` + modules under `public/lib/`.
`sequencer-worker.js` (818 lines) composes and, by default, ticks the nets; the main thread plays
each fire through Tone.js (`audio/tone-engine.js`, 2,703 lines, 72 instrument configs). In
`?engine=wave` the worker keeps composing but never plays: an AudioWorklet (`wave-engine/worklet.js`)
is the clock and the sound, and its ticks are replayed into the normal handlers
(`lib/backend/wave.js`). The generator is ~6,000 lines of JS (`lib/generator/`) with a Go twin
(`internal/generator`).

**djrust-vevr-se (private).** `djengine` is a pure `no_std + alloc` crate: generator, arrange, share
codec, CIDs, project model, wave engine (`wave::runner`, 5,157 lines), master FX chain, macros,
musicality passes. It builds for `wasm32-unknown-unknown`, and `PORTING.md` records parity with the
Swift app, which is itself pinned to beats' JS. `PORTING.md` listed `djwasm` as *planned*; phase 1
adds it.

**The seam.** The JS wave engine's worklet is already the right shape: project JSON in, `wave-tick`
messages out, a transport/tempo/mute protocol. Phase 1 puts the Rust runner behind the same protocol,
so the studio does not change.

**What still depends on Tone** (`git grep -c "Tone\."`, 2026-11-12): `audio/tone-engine.js` 303,
`lib/share/offline-render.js` 32, `lib/backend/index.js` 15, `lib/macros/sched.js` 13, `jog/demo.js` 11,
`lib/test-hooks.js` 10, `client-render.js` 6, `insert-render.js` 5, `backend/audio-io.js` 5,
`scope-model.js` 4, a handful in `petri-note.js`, `scope.js`, `dialogs.js`, `macros/runtime.js`,
`backend/wave.js`, `sw.js`, `sequencer-worker.js`, `share/url.js`, `render-mode.js`, `project/sync.js`.
`ROADMAP-wave.md` has the table of what replaces each.

## 3. Parity gaps

Three different gaps, with different weight. The generator is closed; the engine is closed *for the
beats-parity voices*; the sound of Tone's 72 instruments is the large open one.

### 3.1 Generator: djrust vs the beats JS generator

**Proven equal** (live, `scripts/test-djrust-wasm.mjs`, and djrust's fixtures): `compose` for every
genre including the fallback preset, seeds, `structure`, `cohesion` v1 and v2, trait overrides,
`arrange` (all directives, 595 cases incl. where the JS throws), counter-melody, share envelope →
project, canonical bytes, model CID, project document bytes. beats' generator, pflow, share and wave-engine
sources have **not changed since the commit djrust's JS fixtures were written from** (`668978e`,
2026-10-04). The 5 commits since touch the scope tab's gain animation, HTML SEO tags, `/api/save` limits
and a doc scrub; none edits a generator, pflow, share-codec or wave-engine `.js` file (`git diff --stat`
over those paths shows two 3-line HTML edits). So the fixtures are current, as well as the live test.

**Module by module** (`public/lib/generator/` → `djengine/src`):

| JS | Rust | State |
|---|---|---|
| `core`, `euclidean` (+ `riffs`), `markov`, `theory`, `structure`, `theme` (cohesion v2), `variety`, `composer`, `arrange`, `countermelody`, `groove` (`grooveLock`) | `gen::{core, euclidean, markov, tables` (`theory`)`, structure, theme` (incl. `groove_lock`)`, variety, composer, arrange, counter_melody}` | equal (above) |
| `threering.js` | — | **not ported and not needed**: nothing imports it (dead in JS) |
| `genre-instruments.js` | `djengine/data` tables | UI-side lookup used by `petri-note.js` / `project/sync.js`; stays JS until the mixer moves (phase 3) |
| `shuffle.js` (`shuffleInstruments`) | — | **gap**: used by the worker's `shuffle-instruments`; seeds from `Date.now()` when no seed is given |
| `regenerate.js` (`regenerateTrack`) | — | **gap**: the worker's `update-track-pattern` (per-track ring resize); uses euclidean / variety / markov, all of which are ported, so this is glue, not new maths |
| `macros.js` (restore nets, `pruneMacroNets`) | `wave::macros`, `WaveRunner::fire_macro` | **different design**: the worker injects control nets, djrust runs macros natively in the runner. Same audible contract (held to `macro-fx.json`, beats' own macro code, 666 cases), different mechanism, so the worker's `fire-macro` message needs a runner call, not a port |

**Deliberate differences** (not bugs, but the phase-2 ABI has to account for them):

- *No clock.* JS `compose` with no `seed` uses `Date.now()`; `arrangeSeeded` and `shuffleInstruments` the same. Rust composes with seed 0. The wasm `compose` therefore **requires the caller to pass a seed** in phase 2 (the page already has one: shares carry it; "Generate" can pick one in JS and pass it).
- *Share overrides.* djrust applies only `tracks` and `initialMutes` of a share (`PORTING.md` open decision 7); `tempo`, `swing`, `humanize`, `fx`, `feel`, `autoDj`, `macrosDisabled`, `hits`, `ui`, `loop` are UI state that `lib/share/apply.js` sets on the element. They stay in JS; the engine only needs tempo, mutes and macros pushed to it.
- *Old envelopes pin cohesion `v1`* at the boot path (`lib/share/url.js`), because JS `compose` defaults to `v2`. The Rust matrix covers both, so this stays a JS decision in the share loader and passes `cohesion` through.
- *djrust-only generator options* (`melodyDensity`, `bassDensity`, `humanize`, `keyLock`, `hook`, …, `Fixes`) default off and leave the 525 parity cases untouched. beats must not turn them on without a CID decision (§6).

### 3.2 Engine: what plays the notes

**Beats-parity voices (what the JS wave engine plays today): closed.** `WaveRunner` in djengine is a
port of `net.js` / `runner.js` / `synth.js`: executor traces tick for tick, markings, controls and
audio equal to the JS engine (§7 has the numbers); 8 songs and 12 float32 renders in `wave.json` too.

**Tone's 72 instruments: open, for both wave engines.** `ROADMAP-wave.md` says the JS wave engine
converts the 6 drum kits and plays everything else as a generic family voice picked by a regex on the
name. djrust is further along but not done: `djengine/data/instruments.json` overlays 50 of the 72
beats instrument names (42 family voices with Tone-preset parameters and calibrated levels, 8 plucked
strings, all taken from `tone-engine.js`). The 22 with no entry fall back to the name regex / drum
kits: `sub-bass acid reese square-lead supersaw wobble-bass fm-bell metallic noise-hit 808-bass
rubber-bass duo-bass drop-bass fm-bass sine unbound` and the drum sets `drums drums-breakbeat
drums-cr78 drums-v8 drums-808 drums-lofi`. None of this has been A/B'd against Tone. That is W-1's
harness, and it is the gate for the default flip whichever engine implements it.

**In djrust, not yet reachable from the browser** (phase 1 loads `WaveOptions::default()` on purpose;
each of these needs an ABI export and a studio message): `WaveOptions::extended()` (room / echo / groove /
loudness gain / ducking / curated Hits, 53 `Fixes`), macros (`fire_macro`, `NetMacro`, `MasterMacro`),
`catch_up` / `align` (seek, loop), live keys, stingers, tempo effects, per-lane voice settings. The
JS wave engine's own README lists what it lacks in wave mode (macros, loop/seek, swing/humanize, live
transpose, per-channel MIDI routing, Tone instrument choice, offline export); the Rust runner has
engine-side equivalents for most, which is the main reason to take it instead of writing W-9 in JS.

### 3.3 FX, macros, offline, scope

| Area | Beats today | djrust | Gap |
|---|---|---|---|
| Master chain (volume → HP → phaser → LP → crush → drive → pitch-shift → compressor, reverb, delay) | Tone nodes, ~8× the wave engine's cost even idle (lean path bypasses it) | `fx::master_chain`, `fx::periodic_wave` (Tone's pitch-shifter tables); held to **Chrome rendering Tone's own nodes** (`master-chain-chrome.json`), within Swift's tolerances | not exposed in `djwasm`; must cost nothing when idle (`ROADMAP-wave.md` W-10) |
| ~35 macros | `lib/macros/` + Tone param scheduling + worker restore nets | ported; 666 cases, 29,392 mid-run probes, worst relative error 4e-16 vs beats' own macro code and Tone's Param timeline | phase 4 messages |
| Offline / client / insert renders, render farm | `share/offline-render.js` on Tone.Offline; chromedp records real time | the runner renders offline natively (`djctl render`) and in wasm | W-11: a `wasm` render mode needs no chromedp |
| Scope tab (model-based bands, per-hit kernels via `Tone.Offline`) | `ui/scope*.js` | **`Scopes/*` and `ModelEngineKernels` are not ported** (`PORTING.md` §G) | the kernel render becomes "one hit through the wasm runner"; untested in djrust mode |
| Recorder, analysers, `<audio>` sink, output-device routing | Tone + native | n/a (host concerns) | stay native Web Audio; Tone-free once `prepareWaveContext` is a plain `AudioContext` |
| Telemetry | `engine ∈ {default, wave}` is validated server-side (`internal/telemetry/telemetry.go:155`) | — | djrust mode reports as `wave` until the server accepts `djrust`; needs a server change, so deliberately not done in phase 1 |

## 4. The WASM build

`crates/djwasm` in djrust (branch `djwasm-phase1`, commit `0f8f11d`) is a `cdylib` over `djengine`.

- **Plain C ABI, no wasm-bindgen, no npm.** An `AudioWorkletGlobalScope` has no `TextEncoder` /
  `TextDecoder`, which wasm-bindgen's generated glue needs, and this repo has no bundler. The whole glue
  is `public/djrust/loader.js` (UTF-8 by hand when the built-in codec is absent; tested with the
  built-ins deleted). Text goes in through `djw_alloc`, comes out through one *out buffer*; errors are
  negative return codes with a message, not traps; a panic hook keeps the message of a trap.
- **Surface (ABI 1):** `djw_compose(spec)` → `{name, modelCid, canonicalBytes, doc}` where `doc` is
  `JSON.stringify(projectToJSON(compose(...)))` byte for byte; `djw_model_cid(doc)`;
  `djw_init(sampleRate)`, `djw_load`, `play`/`pause`/`stop`, `set_tempo`, `set_mute`, `djw_process(frames)`
  (allocation free; stereo buffers in linear memory), `djw_report()` (the tick's fires with their MIDI
  bindings and its controls, as the JS worklet posts them), `djw_marking`, `djw_muted`,
  `djw_take_stopped`. One runner per instance.
- **Size:** 853,454 bytes, 239,182 gzipped (profile `wasm`: `opt-level="s"`, fat LTO, one codegen unit,
  `panic="abort"`, stripped; `wasm-opt` is not installed and not used, so there is probably 10–20% left).
  The whole `djengine` is in it (decks, journal, session models are dead-code-eliminated only as far as
  the linker can prove).
- **Build:** `make djrust-wasm` → `scripts/build-djrust-wasm.sh` → djrust's `tools/build-wasm.sh`
  (`$DJRUST_DIR`, default `../djrust-vevr-se`). Output `public/djrust/djwasm.wasm` is **git-ignored**; the
  committed `public/djrust/djrust.lock` names the djrust commit and the sha256 the tests ran against
  (`scripts/build-djrust-wasm.sh --check`). Not claimed reproducible across machines: panic strings embed
  paths; `--remap-path-prefix` is the fix and has not been tried.
- **Not done:** Bazel target (needs a Rust toolchain in the graph; `make` only), CI job for it in this repo
  (it needs a checkout of a private repo; djrust's own CI builds the wasm).
- **Known cost carried over from the JS engine:** `load` compiles the project on the audio thread
  (JSON parse + lane build; a 3 MB arranged track is the worst case). djengine's `transfer` feature
  (compile in one instance, install in another, built for "a Web Worker running a second wasm
  instance") is the way off the audio thread; phase 4.

## 5. The AudioWorklet path

```
page (lib/backend/wave.js)                     AudioWorklet 'djrust-engine' (public/djrust/worklet.js)
  createDjrustEngine(ctx)
    fetch djwasm.wasm  ── WebAssembly.compile
    node = new AudioWorkletNode(…, {processorOptions:{module}})  ──►  instantiateSync(module); djw_init(sampleRate)
    ◄── {type:'ready', info}
  {type:'load', project}  ──►  JSON.stringify → djw_load        (queued if sent before ready)
  {type:'transport'|'tempo'|'mute'}  ──►  djw_play / set_tempo / set_mute
                                         every 128-frame quantum: djw_process → copy to outputs
                                         on a tick: djw_report (+ djw_marking every 6th, djw_muted on controls)
    ◄── {type:'wave-tick', tick, t, fired, controls, state?, mutedNets?}   (same as wave-engine/worklet.js)
    ◄── {type:'playback-complete'}  {type:'error', message}
  → onWaveMessage replays them as transition-fired / control-fired / state-sync into the canvas, mixer, Stage.
```

- *Same protocol* as `wave-engine/worklet.js`, so everything downstream (canvas, mixer, Stage, scope,
  perf monitor, the lean output path, the phone `<audio>` sink) is unchanged.
- *Delivering the module.* A compiled `WebAssembly.Module` in `processorOptions` is ready in the
  worklet constructor, i.e. before the first render quantum. That is what makes an `OfflineAudioContext`
  render work (it cannot wait for a message). Fallback if a browser will not clone a Module into a
  worklet: the page posts the bytes (transferred) and the worklet compiles them asynchronously,
  outputting silence and queueing messages meanwhile. Both paths pass in headless Chrome (the second
  with `WebAssembly.compile` forced to fail); **Safari and Firefox are untested.**
- *Failure handling.* `createDjrustEngine` rejects (node disconnected) when the module cannot be
  fetched, compiled or started within 10 s; `lib/backend/wave.js` then uses the JS wave engine and
  records `el._djrustError`. A bad project posts an `error` and keeps the previous one. A trap (a panic
  in the engine) silences that instance and reports the panic message.
- *Cost.* Node, shared host, techno/standard: 31–34 µs per 128-frame block for wasm vs 50–57 µs for the
  JS engine, against a 2,667 µs budget at 48 kHz (~1.2%). **Not measured on a phone** — the same caveat
  as `public/wave-engine/README.md`; `bench-core.js` should get a djrust column before any flip.
- *Allocation.* `djw_process` allocates nothing (buffers sized in `djw_init`); tick reporting allocates,
  about 8 times a second, like the JS worklet.
- *Tone is still loaded* in `?engine=djrust`: it owns the `AudioContext` (`prepareWaveContext`) and the
  mixer sliders. It plays no notes (tested). Removing it is phase 7.

## 6. Share compatibility, and exactly where a CID could change

The share CID hashes the canonical envelope; the model CID hashes the canonical project. The audio is in
neither.

| Change | Share CID | Model CID | Audio | Plan |
|---|---|---|---|---|
| Run the wave engine from wasm (phases 1, 3–5) | same | same | **changes** for every instrument not in the parity path (it is the engine's sound, not an encoding); bit-identical for what the JS wave engine already plays | The old-share-sound decision, §10 #2 (this is `ROADMAP-wave.md` W-12) |
| Compose in wasm (phase 2) | same | same, proven live | same | gate: `test-djrust-wasm` + the shadow check |
| Add an `engine` field to the envelope (W-12 option b) | **changes for shares that carry it only**; absent = unchanged | same | n/a | not planned; only if "keep Tone for old links" is chosen. Needs schema + `seal.go` + `codec.js` + `shareFromPayload` in lockstep |
| Turn on a djrust-only compose option or `Fixes` by default | same if the option is not written into the envelope | **changes** (different notes) | changes | forbidden by this plan; opt-in only, and not as a default |
| Fix a bug in JS `compose` that djrust ports literally ("oddities included") | same | **changes** for the affected seeds | changes | allowed only before public release, in Go, JS and Rust at once, with all three oracles regenerated; afterwards it needs a new generator version gate the way `cohesion v1/v2` already works |
| Rust-side behaviour that differs from JS for missing seeds (clock) | — | — | — | not a CID question: the caller passes the seed |

So: **nothing in phases 1–5 changes a share CID or a model CID.** The cached `.webm` renders in
`data/audio/` are keyed by share CID and were baked from Tone; after a flip they are stale in the sense of
W-12, not corrupt. Take `/api/snapshot-persist?label=pre-djrust-flip&audio=1` first (as `ROADMAP-wave.md` says).

## 7. Phases and the feature flag

The flag is the URL parameter `?engine=djrust` (and later `?generator=djrust`), never a payload field and
never something a share can set, so no flag state reaches a CID. Each phase ends with the previous
engine still one parameter away, and each has a gate that already exists or is named here.

| Phase | Ships | Flag | Gate (all must pass) | Rollback |
|---|---|---|---|---|
| **0** plan | this file; the gap inventory | — | — | — |
| **1** *(this branch)* | wasm runner in the worklet; the JS worker still composes; generator checked live from Node | `?engine=djrust` | `make test-djrust` (152 compositions + audio + ticks + markings + live ops + worklet-without-TextEncoder), `make test-djrust-browser`, `make test-wave`, `go test ./...`, `make test-wave-browser`; djrust: `cargo test -p djwasm` | drop the parameter |
| **2** generator | `djw_compose` replaces `generator/*.js` in the worker (or a wasm worker): same document bytes. Adds `djw_arrange`, `djw_share_*` if the boot path needs them. **Shadow mode first:** JS composes, wasm composes in the background, a mismatch is logged (needs a telemetry kind: server change) | `?generator=djrust` | the phase-1 gate + all 19 genres × the seed range of the seed-feed script; the Go↔JS tests still run (JS still exists) | drop the parameter |
| **3** voices and FX (`ROADMAP-wave.md` W-1 … W-8, W-10) | expose `WaveOptions` tiers, `instruments.json` voices (50/72 now), master chain, per-lane voice settings; the A/B harness against Tone; coverage gate 72/72; a djrust column in `bench-core.js`, run on the two reference phones | `?engine=djrust` | A/B within tolerance per family (W-1), P-1 budget met on both devices, master chain idle cost ≈ 0 | drop the parameter |
| **4** studio parity (W-9) | macros, seek / loop / crop (`catch_up`, `align`), swing / humanize, live transpose, mute-note, hit pads as messages; `transfer` so a project compiles off the audio thread; the worker stops being the clock (it keeps composing until phase 2 lands) | same | `test-e2e-controls`, `make test-audio` re-pointed at the engine, the scope browser test with `?engine=djrust` | same |
| **5** offline and render farm (W-11) | `scripts/wasm-render` + an `-audio-render-mode wasm` that uploads `.webm`s with provenance `renderfarm`; scope kernels through the runner | server flag | a baked feed card equals what the page plays | keep chromedp until phase 7 |
| **6** default flip (W-12) | djrust becomes the default; `?engine=tone` stays one release | default | everything above + the §10 #2 decision + snapshot taken | `?engine=tone` |
| **7** retire (W-13 / D-1) | delete `tone-engine.js`, the CDN tag and SRI pin, the sw entry; delete `lib/generator/*.js` (the worker or its replacement calls wasm); retire chromedp; the Go↔JS parity tests become Go↔Rust (`go.json` oracle, a wasm leg for `tools/parity`) | — | `git grep "Tone\b\|toneEngine" public internal` empty; Go generator parity green against the Rust oracle | revert; the snapshot |

Phase 3 is where this plan and `ROADMAP-wave.md` disagree on **D-1 "slim, pending measurements"**: with
the master chain and macros already in `djengine`, "remove" costs much less than the roadmap assumed,
since the hard item it lists (the phase-vocoder pitch shift) is ported and held to Tone's nodes. The
measurements D-1 asks for (page weight, phone CPU, offline/live parity, pitch-shift usage) should be taken
with `djwasm` in the comparison, and D-1 re-decided then.

The **Go generator** (`internal/generator`, used by `/api/generate`, the MCP `generate_share` and the
render farm's authoring server) is untouched by phases 1–6. It stays the second oracle and keeps its
byte-parity with JS until phase 7; after that it is held to Rust by the same fixtures. Replacing it with
the wasm module (Go can host it with a pure-Go wasm runtime) is possible and out of scope here.

## 8. Licence and visibility (needs a decision before anything ships)

- beats-bitwrap-io is MIT and public. `djrust-vevr-se` is private and its crates are `license =
  "UNLICENSED"`. A page that loads `djwasm.wasm` distributes a compiled form of that source to every
  visitor, so before deploy someone with the authority has to either license `djengine` + `djwasm`
  (MIT would match beats), or keep the module out of the public site. Not a technical question.
- Phase 1 therefore **does not commit the `.wasm` binary** (it is git-ignored) and the flag degrades to the
  JS wave engine when the file is absent. Nothing in this repo's history contains djrust source.
- `PORTING.md` records the EXS / Apple Loops / `MuseScore_General.sf2` constraints. None of those are in
  `djwasm`. If sampled voices are ever added to the browser build they must come from a public,
  reuse-licensed SoundFont.
- The data tables in `djengine/data` (`tables.json`, `grooves.json`, `melody-bigrams.json`,
  `instruments.json`) are derived from beats' own tables and presets.

## 9. What phase 1 verified, and what it did not

Verified (this branch, valoper, 2026-11-12):

| Check | Result |
|---|---|
| Generator: 152 compositions, project document bytes + model CID, vs live JS | all equal |
| Engine: 6 renders (techno, jazz, dnb at 44.1 kHz, ambient, bossa, speedcore), 6–10 s each | max difference 0 on five; 5.96e-8 on speedcore (one `Math.sin`/`libm` last-bit difference) |
| Ticks: fires + MIDI bindings + controls identical per tick; markings identical every 6th tick | equal |
| Live ops: tempo, mute/unmute, queued project swap at the bar, pause/play, stop/play | equal, 54 ticks |
| The gate can fail (different seed on one side) | max difference 1.17 |
| Worklet in Node with `TextEncoder`/`TextDecoder` deleted: queued messages, silence until ready, sync Module path, bad project | all pass |
| Headless Chrome: `?engine=djrust` plays techno/42, ticks reach the page, marking reaches the canvas, peak 0.76, 0 Tone notes | pass |
| Chrome's `OfflineAudioContext` render of the same project vs Node | same sha256 (5 s, 48 kHz, stereo) |
| Fallbacks: missing wasm → JS wave engine plays; no-Module path → bytes message plays | pass |
| `?engine=wave` and the default Tone path unchanged | pass |
| `go test ./...`, `make test-wave`, `test-sw`, `test-cohesion-parity` | pass |
| djrust: `cargo test -p djwasm` (9), clippy clean for the new crate, `djengine --no-default-features` builds | pass |

Not verified: **Firefox, Safari, phones** (Module cloning into a worklet, determinism across engines,
CPU); the scope tab, Stage, Auto-DJ and macros in djrust mode (macros, loop, seek, swing, transpose are not
routed in wave mode either — `wave-engine/README.md`); sustained playback beyond a few seconds; any audible
comparison with Tone; a production build (`make build` embeds `public/`, including the wasm if present);
the full djrust test suite (only `djwasm`'s own tests and the existing djengine checks were run; no
djengine file changed).

## 10. Decisions for Matt

1. **Licence / visibility of djrust** (§8). Blocks any deploy of the flag.
2. **Which engine plays an existing share** (`ROADMAP-wave.md` W-12): everything flips and the converge
   sweep rebakes the feed, or an `engine` envelope field pins old shares to Tone (the only case where a share
   CID would change, §6). Changing this *before public release* is cheap; after it the field is a permanent
   part of the envelope.
3. **Telemetry:** allow `engine: "djrust"` server-side (`internal/telemetry/telemetry.go:155`), so field
   data can be split per engine. One-line change, but it is a server deploy.
4. **D-1 re-decision** with `djwasm` in the measurements (§7).
5. **Go generator's future** after the JS one is retired (§7): keep as an oracle, or replace by the wasm.
6. **Where the wasm is built for deploy:** pflow.dev has no Rust toolchain in `make build` today. Either
   build on valoper and ship the `.wasm` (hash pinned by `djrust.lock`), or add the toolchain; plus
   whether the module is served from the app, or from `cdn.stackdump.com` like `wave-engine/bench.html`.

## 11. Running it

```bash
make djrust-wasm                 # builds ../djrust-vevr-se (branch djwasm-phase1) → public/djrust/djwasm.wasm + djrust.lock
make test-djrust                 # node: parity against this repo's live JS
make test-djrust-browser         # headless Chrome over CDP (builds the server first)
make dev                         # then open  http://localhost:8089/?engine=djrust&genre=techno&seed=42
```

djrust side: `cargo test -p djwasm`; `tools/build-wasm.sh`; `tools/gates.sh full` builds the module for wasm32.
