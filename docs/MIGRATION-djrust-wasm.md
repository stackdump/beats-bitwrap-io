# Moving beats.bitwrap.io onto the djrust engine (WASM), and off Tone.js

**Status 2026-11-14 (branch `djrust-only`): Tone.js is gone. djrust is the studio's only engine.**
Matt decided the flip no longer waits for phases 3–5. Losing features for a while is acceptable;
they are rebuilt on djrust afterwards. Every feature switched off for this is listed in **§12** with
what it needs. Not merged to main; merging deploys.

**Pin 2026-11-15 (branch `djrust-net-clock`, studio plan step 3): `public/djrust/pin.js` names
`djwasm@0.3.0`** (sha256 `6c4f006f…`, 901,807 B), built from djrust `beats-studio` 44a6eda. Until
it is on npm the page falls back to the local build; see "Re-pinned to 0.3.0" at the end of §12.

*Earlier: plan + phase 1 on `djrust-wasm-phase1` (2026-11-12), the default-flip re-assessment on
`djrust-default`, CDN delivery on `djrust-cdn`. `djrust-only` is built on `djrust-cdn`.*

**2026-11-14:** the module now comes from the public, MIT [`stackdump/djrust`](https://github.com/stackdump/djrust)
(`cabi/`, npm package `djwasm`) and the page loads it from jsDelivr with a pinned SRI hash (§4, §8).
No private source is compiled into it any more.

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
| **Only public, reuse-licensed sources** | Nothing was copied from outside the two repos. The wasm's dependency closure is `sha2`, `miniz_oxide`, `libm`, `once_cell` and their dependencies: all MIT, Apache-2.0, Zlib or 0BSD (checked with `cargo metadata`, 2026-11-12). No SoundFonts, Apple content or samples are in the browser build (`djhost`'s SF2 / EXS code is not in `djwasm`). The A/B harness (phase 3) renders from the two engines themselves, so it needs no third-party audio either. | Since 2026-11-14 the module is built from public, MIT `stackdump/djrust` only (§8). |

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

`cabi/` in the public [`stackdump/djrust`](https://github.com/stackdump/djrust) (MIT) is a `cdylib` over the
`djrust` crate (`default-features = false`). It is the phase-1 `crates/djwasm` (private djrust-vevr-se,
`0f8f11d`) moved there unchanged except that `djw_info` reports `"engine":"djrust"`; built against public
djrust 0.2.0 it passes every `make test-djrust` and `make test-djrust-browser` check.

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
- **Delivery (§10 #6, decided 2026-11-14):** the npm package `djwasm` (built by djrust's `cabi/build.sh`,
  versioned to djrust: `djwasm@0.2.0` is djrust 0.2.0) holds `djwasm.wasm`, `loader.js`, `worklet.js`,
  `node.js` and `hashes.json` (sha256 + SRI of each). The page fetches the wasm from
  `https://cdn.jsdelivr.net/npm/djwasm@<version>/djwasm.wasm` with the `integrity` in
  `public/djrust/pin.js` — the same pattern as `@pflow-xyz/engine` — so pflow.dev's `make build` never
  needs Rust. `loader.js` / `worklet.js` here are the package's own files, vendored byte for byte (an
  AudioWorklet module cannot be loaded with SRI, so the glue is served same-origin); `pin.js` records their
  sha256 and `make check-djrust-pin` (part of `make test`) fails on an in-place edit. If the CDN fetch fails
  the page tries a local `public/djrust/djwasm.wasm` (`make djrust-wasm`, git-ignored), then the JS wave
  engine. jsDelivr rather than cdnjs.com: cdnjs only lists libraries that pass its popularity/curation
  review and mirrors them on its own schedule, so a new version could not be published and pinned in one
  step; jsDelivr serves any npm version within minutes and is the CDN the ecosystem already pins.
- **Build / publish:** `make djrust-wasm` (build `../djrust`, `$DJRUST_DIR`), `make djrust-pin` (re-pin to that
  build), `make djrust-publish` (djrust's `cabi/publish.sh`: `npm publish`, wait for jsDelivr, then
  `make djrust-verify-cdn`). The build is reproducible: no `wasm-opt`, `--remap-path-prefix` on the checkout,
  cargo registry and sysroot; two checkouts at different paths gave the same sha256 (`cfcd9cf4…`). Publish
  from the toolchain the pin was built with, or `djrust-verify-cdn` will catch the difference.
- **Not done:** Bazel target (needs a Rust toolchain in the graph; `make` only); a CI job for the wasm here
  (djrust's own `cargo test` in `cabi/` covers the surface).
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
- *Tone is gone* (branch `djrust-only`). `public/audio/host.js` owns the native `AudioContext`, the
  master gain the worklet connects to, the phone `<audio>` sink, output-device choice and a read-only
  analyser. There is no JS wave engine fallback any more: if the module cannot be fetched (CDN and
  local both fail), the page shows "Audio engine failed to load" and nothing plays.

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

## 8. Licence and visibility (decided 2026-11-14)

- beats-bitwrap-io is MIT and public. Phase 1's module compiled in two crates from the private,
  `UNLICENSED` djrust-vevr-se: `djengine` and `djwasm`. Decision: djrust is MIT. `djengine`'s public twin is
  [`stackdump/djrust`](https://github.com/stackdump/djrust) (MIT; npm `djrust`), and `djwasm` moved into it as
  `cabi/` (with Matt's go-ahead), so the module served to visitors is built from public, MIT source only.
- The `.wasm` is still not committed here: it is fetched from the pinned npm version (§4).
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

### 9.1 Re-assessment before a default flip (2026-11-14)

Asked to make djrust the default and remove Tone. Re-ran the phase-1 gates on a fresh build
(`make djrust-wasm` reproduced the locked sha256 `a98d5ee5…`; `make test-djrust`, `make test-djrust-browser`,
`go test ./...` all green), then measured which studio controls take audible effect in each engine
(`scripts/probe-djrust-gaps.mjs`, headless Chrome, techno/42, RMS + spectral centroid of the output
before/after; ratio after/before):

| Control | Tone (default) | djrust | Verdict |
|---|---|---|---|
| FX `lp-freq` → 5 | centroid ×0.63 | ×1.03 | **no effect** in djrust |
| FX `distortion` → 100 | RMS ×4.75 | ×1.00 | **no effect** |
| FX `master-vol` → 5 | RMS ×0.006 | ×0.006 | works |
| macro `cut` (8 ticks) | RMS ×0.008 | ×1.06 | **no effect** |
| macro `sweep-lp` | centroid ×0.61 | ×1.06 | **no effect** |
| macro `solo-drums` | RMS ×0.75 | ×1.01 | **no effect** |
| mute every music net | RMS ×0.02 | ×0.10 | works |
| tempo 120 → 60 | works | works | works |
| 19 genres, seed 7 | — | all play, no errors | works |
| Stage opens | — | no exceptions | works |

Further, from the code: `client-render.js` (render farm + "Download audio") and `test-hooks.js` record
from `Tone.getDestination()`, which the lean djrust path bypasses (worklet → gain → `ctx.destination`),
so a flipped render farm would bake **silent** `.webm`s; `instrument-change`, `seek`, swing/humanize,
transpose and hit pads are not routed to the worklet; the scope kernels still use `Tone.Offline`.

**Conclusion:** phase 1 does what it claims (a working flag), but phases 3–5 are the prerequisites of a
flip, not polish. Removing Tone today would delete the FX panel, every macro and Auto-DJ, and the render
farm's audio. The flip stays blocked on §10 #1 (licence), §10 #6 (where the wasm is built for deploy —
it is git-ignored, so pflow.dev's `make build` would serve a page that silently falls back to the JS wave
engine) and phases 3–5. *(Later the same day #1 and #6 were decided and done: §8, §4. Phases 3–5 still block the flip; Tone stays.)*

## 10. Decisions for Matt

1. ~~Licence / visibility of djrust~~ — **decided 2026-11-14:** MIT; the module is built from public
   `stackdump/djrust` (§8).
2. **Which engine plays an existing share** (`ROADMAP-wave.md` W-12): everything flips and the converge
   sweep rebakes the feed, or an `engine` envelope field pins old shares to Tone (the only case where a share
   CID would change, §6). Changing this *before public release* is cheap; after it the field is a permanent
   part of the envelope.
3. **Telemetry:** allow `engine: "djrust"` server-side (`internal/telemetry/telemetry.go:155`), so field
   data can be split per engine. One-line change, but it is a server deploy.
4. **D-1 re-decision** with `djwasm` in the measurements (§7).
5. **Go generator's future** after the JS one is retired (§7): keep as an oracle, or replace by the wasm.
6. ~~Where the wasm is built for deploy~~ — **decided 2026-11-14:** built from `stackdump/djrust`, published as
   npm `djwasm`, loaded from jsDelivr at the version + SRI in `public/djrust/pin.js` (§4).

## 11. Running it

```bash
make djrust-wasm                 # builds ../djrust (cabi/) → public/djrust/djwasm.wasm (local fallback + tests)
make djrust-pin                  # …and re-pin public/djrust/pin.js + the vendored glue to that build
make djrust-publish              # npm publish djwasm@<djrust version>, then check jsDelivr serves the pin
make check-djrust-pin            # offline: vendored glue = the pin (in make test)
make djrust-verify-cdn           # online: jsDelivr serves the pinned bytes
make test-djrust                 # node: parity against this repo's live JS
make test-djrust-browser         # headless Chrome over CDP (builds the server first)
make dev                         # then open  http://localhost:8089/?engine=djrust&genre=techno&seed=42
```

djrust side: `cargo test -p djwasm`; `tools/build-wasm.sh`; `tools/gates.sh full` builds the module for wasm32.

## 12. Tone removed: what was switched off, and what each needs to come back (2026-11-14)

Branch `djrust-only` (from `djrust-cdn`) deletes `public/audio/tone-engine.js` and the Tone.js `<script>`
on every page (studio, `wave-engine/bench.html`, `jog/demo.html`). djrust is the only engine on every
studio URL; the old `?engine=djrust` / `?engine=wave` links still open it. Nothing in the share
envelope, schema or canonicalisation changed, so **no share or model CID changed** (§6).

### What replaced Tone

| Was | Now |
|---|---|
| `tone-engine.js` (AudioContext, master chain, 71 instruments) | `public/audio/host.js` (`audioHost`): native AudioContext, master gain, phone `<audio>` sink, output device, analyser. Every other old method is a named no-op that logs once, so call sites keep working. |
| `INSTRUMENT_CONFIGS` (names + patches) | `public/audio/instruments.js`: `INSTRUMENT_NAMES` (the same 71 names, so every saved share keeps a valid name) + `isDrumChannel`. `category_doc_test.go` counts this list. |
| JS wave engine as fallback | none. `public/wave-engine/` stays as the parity oracle for `make test-djrust` and the bench. |
| `lib/share/offline-render.js` (Tone.Offline, 880 lines) | the djrust worklet in an `OfflineAudioContext` (~140 lines), WAV out. `?render=offline` works and matches the live engine byte for byte. |
| `lib/share/client-render.js` / `?render=1` / "Download audio" | records `audioHost.output` (the djrust output). **Works**, so the render farm's realtime path now bakes djrust audio. |
| `lib/test-hooks.js` (Tone.Recorder) | MediaRecorder on `audioHost.output`. |
| `lib/macros/sched.js` (Tone.Transport) | wall-clock timers (macros are off, see below). |
| Jog lab (`public/jog/`) Tone synths | a native Web Audio kit (kick, snare, hat, bass) in an OfflineAudioContext. |
| Group mutes | now expanded per net and sent to the worklet (`mute-group` never reached it before); lock mutes are re-sent after each project load; the worker's mute state is handed over when the engine starts (render-mode solo/mute). |

### Switched off: the rebuild list

Hidden by one stylesheet and guarded in code, all from `public/lib/ui/engine-gaps.js`. **Net macros, Auto-DJ, seek, groove routing and offline macros are wired on 0.3.0:** see "Page wired to 0.3.0" at the end of this section. To bring a
feature back, route it to the engine and delete its entry there. Share collectors and appliers are
untouched, so a share carrying `fx` / `autoDj` / macro settings still round-trips byte for byte; the
settings just do nothing yet.

| # | Feature | State now | What it needs from djrust / djwasm |
|---|---|---|---|
| R-1 | **Macros** (~35, Macros panel, Panic, MIDI-pad / key / control-net `fire-macro`, `macroCurve`) | panel hidden on a module without macros; `fireMacro` returns early for a macro the engine does not run. **0.3.0: the 9 net macros run in the engine** ("Page wired to 0.3.0"). | export `WaveRunner::fire_macro` (`NetMacro` / `MasterMacro`) in the C ABI, a `fire-macro` worklet message; restore `sched.js` to the audio clock or drop it. `make test-audio` comes back (it is parked; `make test-audio-parked` runs it). |
| R-2 | **Auto-DJ** (panel, regen, transition macros in shuffle mode) | panel hidden; `autoDjTick` returns early (still gated by `engine-gaps.js` until the 0.3.0 wiring). **Page part done (djrust-gates):** `wave.js` `feedWaveTick` runs `_autoDjTick` and `_fireRepeatingOneShots` once per wave-tick (first tick after a transport change is a baseline; a lower tick is a wrap, passed through as `(prev, tick)`), and the forwarded state-sync (`fromWave`) no longer runs them a second time; the worker's `mute-state` yields to the worklet's `mutedNets` (only its own changes since its last report are applied), so mutes the engine's control nets hold are not overwritten. Gate: `make test-wave-tick-feed` (in `make test`). | R-1 (Mute/Tempo pools, busy check = `macroMask != 0`). Regen (a new Generate) could return before R-1. |
| R-3 | **Master FX**: reverb, delay, drive, pitch, HP/LP, phaser, crush, Bypass, Reset | groups hidden; master volume stays (it is the host gain) | export `fx::master_chain` + `WaveOptions::extended()` and per-param messages; idle cost ≈ 0 (W-10). Feel's lp blend and `feelCurve` ride on this. |
| R-4 | **Channel strip**: per-channel pan / volume / HP / HPR / LP / LPR / decay | slider groups hidden | per-lane voice settings in djwasm. Default role pans (`applyDefaultPans`) are no-ops until then. |
| R-5 | **Live instrument change** (mixer dropdown, `»` rotate, Shuffle's `instruments-changed`) | on a module without `INSTRUMENT` (djwasm 0.3.0): dropdown shown as a label, not clickable, `»` hidden, shuffle updates the UI only. **Page wired:** on a module that reports `INSTRUMENT` (2048) the dropdown and `»` are live; `mixer.js` `changeInstrument` sends `instrument-change`, `wave.js` posts `{type:'instrument', netId, instrument}` per net (a grouped row's every net; Shuffle's too, `engineSetInstruments`), the worker keeps its project in step. Gate: `make test-djrust-page-instrument`. | djrust `djw_set_instrument` (branch `feat/live-instrument`): the net's lanes rebuilt as a load with that instrument would build them and swapped in, tick and marking untouched. Needs a djwasm release with it, then a re-pin. |
| R-6 | **Instrument tone tools**: test note ♫, tone presets ★, tone reset / prev / random | hidden | a "play one note on lane N" message; presets need per-lane voice settings (R-4). |
| R-7 | **One-shot synths** (airhorn, laser, …; `kind: 'custom'` / `'note'` in `lib/audio/oneshots.js`) | silent (no-op) | stinger voices in the engine. Hit pads that unmute stinger *nets* still work. |
| R-8 | **Swing / humanize, live transpose, hit-pad pitch** | not applied to audio (they never reached the wave engine either); still applied to Web MIDI out | engine-side swing/humanize/transpose (`WaveOptions` / live keys). |
| R-9 | **Seek, loop region, crop** | the worker seeks, the worklet does not. **Crop works** and needs nothing from the engine: the worker's crop is an ordinary project-sync, `waveLoadProject` loads it, and the engine applies it at the next bar line with its tick back to 0. `make test-crop` (in `make test`) drives the real worker, `handleWsMessage` and `waveLoadProject` into a djwasm engine mid-play and checks the net count, the tick reset at the bar, the initial mutes, and that the net stream equals opening the cropped track fresh (pin 0.2.0 and the 0.3.0 pkg both pass). | seek and loop: `catch_up` / `align` in the ABI (seek in 0.3.0, loop in 0.5.0). |
| R-10 | **Per-channel audio output devices** | throws, logged; per-channel MIDI routing still works | multiple worklet outputs or one engine per output. Whole-master output device works. |
| R-11 | **Scope model views** (kernels, model bands/spectrogram, residual) | **Kernels done (djrust-gates):** model views are back and *measured* is off by default again. Each kernel is a one-net, one-hit project rendered from a fresh `djw_init` in a module Worker through `loader.js` (`public/lib/ui/scope-kernel-worker.js`; 32768 frames at 44.1 kHz), keyed by instrument + group + note + duration + djwasm version (`pn-scope-kernels-v4`, persisted only for the pinned module). Gates: `make test-scope-kernels` (91 kernels from 6 genres, each Worker f32 sha = a fresh Node loader render; also bit-identical on the 0.3.0 pkg) and `make test-scope-browser` (model checks restored; every browser-Worker kernel sha = Node). | **Still open:** the FX response |H_fx|² is flat, because djwasm exposes no filter state. |
| R-12 | **Insert render** (`?insert=counterMelody`, Go `internal/audiorender` inserts) | **Done (djrust-gates).** `renderNotesOffline` in `insert-render.js` builds one net per simultaneous-note layer with the arrange path's own `countermelody.buildMusicNet` (ring longer than the render, so nothing repeats) and renders it through `renderProjectOffline`, which `renderToBlobOffline` now delegates to. Go `synthesizeNotesViaTone` is renamed `synthesizeNotesViaBrowser` (comments only otherwise). Gates: `make test-insert-render` (two worklet renders = one WAV sha = the Node loader's f32, chords split into layers) and `make test-djrust-browser` (`renderProjectOffline` = the Node sha, so the refactor is byte-identical; two browser `renderNotesOffline` renders give one WAV sha and equal the Node f32). | nothing. |
| R-13 | **Benchmark** | **Done (djrust-gates).** New cases G (djrust worklet → destination, 48 kHz), H (same at 24 kHz) and I (djrust DSP-only on the main thread); the quick run is G; reports carry `engineVersion: "djrust@<crate>"`. `internal/bench` adds the columns with an idempotent `PRAGMA table_info`-guarded migration, builds Insert/List from `Cases`, and a test keeps `bench-core.js`'s case ids a subset of `bench.Cases`. Gates: `go test ./internal/bench` (old-schema migration, fresh = migrated, client-subset) and `make test-wave-browser` (bench modal: quick run is G, report and stored row name `djrust@…`). **Deploy order:** the server must ship before clients send G/H/I (one binary, so one deploy of main is safe). | nothing. |
| R-14 | **Telemetry engine label** | **Done (djrust-gates).** The server accepts `djrust` (`telemetry.Engines` = default / wave / djrust); the client sends it via `engineLabel(el)` (`lib/perf/monitor.js`), and the perf verdict treats djrust like wave (audio off the main thread). Old rows keep their `wave` label until the 30-day retention ages them out. Gates: `go test ./internal/telemetry` (`TestEngineLabels`) and `make test-wave-browser` (the summary has a `desktop × djrust` group). | nothing. |
| R-15 | **WS backend** (`data-backend="ws"`, Go sequencer) | **compose-only, by decision (option a, 2026-11-14).** `/ws` (authoring only) generates, shuffles, arranges and loads projects; transport is consumed by `routeToWave` and plays in the worklet, so the Go sequencer never plays and server-side MIDI out (`-midi*`) is not clocked from a `/ws` page. | nothing. Option (b), streaming the worklet's ticks to `/ws` for hardware MIDI, only if Matt asks; a Go clock (c) is rejected (two clocks drift). |
| R-16 | **Offline render extras** (master FX, macros, swing in `?render=offline`) | **0.3.0: mutes always, net macros + `macrosDisabled` on an opt-in, groove on an explicit override** ("Page wired to 0.3.0"); master FX not rendered | R-3 (master FX). |

**Before merging this to main:** `djwasm@0.2.0` is live on jsDelivr (verified 2026-11-14,
`make djrust-verify-cdn`), so production loads the module without a local build. Then decide §10 #2:
the feed's cached `.webm`s were baked from Tone, and the render farm will now bake djrust audio
(take `/api/snapshot-persist?label=pre-djrust-flip&audio=1` first).

### Gates on `djrust-only` (valoper, 2026-11-14)

| Gate | Result |
|---|---|
| `go test ./...` | pass |
| `bazel test //...` (16 targets) + `bazel run //:gazelle -- -mode=diff` | pass, clean (the djrust and scope files were missing from `embedsrcs` since `djrust-cdn`; added) |
| `make test-djrust` (Node parity vs this repo's JS) | pass |
| `make test-djrust-browser` (rewritten: no Tone on the page, module from `cdn djwasm@0.2.0`, offline bytes = Node, no-module error, bytes path, gaps hidden, master volume and mutes reach the engine, legacy links) | 18/18 pass |
| `make test-wave` (wave-engine oracle + service worker), `test-cohesion-parity`, `test-model-parity`, `check-djrust-pin`, `djrust-verify-cdn` | pass |
| `make test-wave-browser` (studio smoke: playback, phone `<audio>` sink, perf monitor, telemetry, visibility, welcome card, bench) | pass. Also fixed its data-dir mismatch for the telemetry secret. |
| `make test-scope-browser` | pass (model checks swapped for "model off, measured on") |
| `make test-e2e` | 43/43 (macro / one-shot / FX / Auto-DJ / interrupt sections replaced by "is off" checks; bring them back from history as R-1…R-7 land) |
| `scripts/probe-djrust-gaps.mjs` (now the rebuild scoreboard) | master volume ×0.006, mute all ×0.11, tempo 60 ×0.73 work; lp-freq, distortion, cut, sweep-lp, solo-drums read ~1.0 (R-1, R-3); all 19 genres play, no errors; Stage opens |

Not run: Firefox, Safari, phones (same caveat as §9).

### Status after steps 0-2 (branch `djrust-gates`, 2026-11-14)

Steps 0-2 of the djrust studio plan are in: the gates (step 0), the beats-only gaps (step 1) and the
djwasm 0.3.0 "net clock" candidate (step 2, djrust worktree `djrust-beats-studio`, branch
`beats-studio`). **The pin has not moved:** the page still loads `djwasm@0.2.0` (sha256
`cfcd9cf4…`), so nothing audible changed and no share or model CID changed.

- **Closed by this work:** R-11 kernels (FX response still open), R-12, R-13, R-14, R-15 (option a,
  documented), the R-9 crop, and the page part of R-2 (Auto-DJ stays hidden until the 0.3.0 wiring).
- **Gates that hold the default path:** `make test-djrust-golden` (282 renders bit-identical to
  0.2.0 on audio, ticks, report, marking and muted; in `make test`), `make test-djrust-neutral`,
  `make cid-freeze` (in `make test`), the tri-render in `make test-djrust-browser` (Node direct = Node
  worklet = OfflineAudioContext = live AudioContext on 4 live scripts, all quanta 128), and
  `make test-djrust-cpu` (idle cost and memory measured side by side against the pin).
  Step 1's Node checks run as `make test-djrust-node` (in `make test`).
- **0.3.0 candidate** (`cabi/pkg`, sha256 `2f80a4fb…`, 884,981 B, ABI 1, 45 exports): with
  `DJRUST_WASM=…/cabi/pkg/djwasm.wasm`, golden and neutral are 282/282 bit-identical to 0.2.0 and
  `make test-djrust` passes; `cargo test -p djwasm` (golden, idle, host_oracle, control, seek, alloc,
  surface) is green. It adds net macros (R-1 mute/tempo half), control-net macro dispatch, seek (R-9),
  groove (R-8 swing/humanize), a frame clock and an event ring. **It is not pinned or wired yet**
  (step 3), and it is not published.
- **Blocking the 0.3.0 re-pin, each needs a decision:** (1) `seek(3000)` costs about 45-48 ms on
  the audio thread against the 2.0 ms per-quantum gate (O(tick × nets); options: the deferred
  graph-snapshot cache, an off-thread seek, or a seek spread over quanta); (2) memory per
  `djw_load` is one 64 KiB page worse than the pin (11,258,633 vs 11,256,373 B per load, not
  proportional to loads); (3) mechanism parity with beats' page code differs for double-drop at a
  non-default duration (beats holds drop's default for the second half; the engine holds the chosen
  duration) and for tape-stop (the page rounds bpm to an integer, max |Δ| ≈ 0.49 bpm; the engine's
  ease curve is otherwise exact). All other net macros match the worker tick for tick.

### Re-pinned to 0.3.0 (branch `djrust-net-clock`, 2026-11-15)

`DJRUST_DIR=../djrust-beats-studio make djrust-pin` rebuilt djrust `beats-studio` 44a6eda to the
bytes staged for npm: `djwasm.wasm` sha256 `6c4f006f12e8cd57…` (901,807 B, SRI
`sha384-U3nH5yAO…`), `loader.js` `e8bc8964…`, `worklet.js` `c8610a03…`, each equal to `cabi/pkg`.
`public/djrust/node.js` is beats' own page handle (CDN + SRI, local fallback, `loadDjwasmModule`),
not the package's `node.js`, so it is not in `pin.js`'s glue list and stays as it is.

- **0.2.0 is now a reference, not the pin.** `test-djrust-golden` / `test-djrust-neutral` still hold
  every render to `scripts/djrust-golden.json` (0.2.0 bytes). The two gates that run the 0.2.0
  module itself, `test-djrust-cpu` (idle cost and memory side by side) and `test-djwasm-030`
  (compat), read it from `.djrust-ref/djwasm@0.2.0/` (wasm + its own glue; git-ignored, outside
  `public/`, never served). `make djrust-ref` (`scripts/djrust-ref.mjs fetch`) downloads it from
  jsDelivr; every use re-checks its three sha256s, and a wrong file fails rather than skips.
- **Wiring:** see "Page wired to 0.3.0" below. The re-pin alone kept the 0.2.0 call sequence; the
  wiring keeps the default path bit-identical too (golden, neutral and render-freeze gates).
- **Before merging:** `make djrust-verify-cdn` must pass. On 2026-11-15 it fails with HTTP 404:
  npm `djwasm` dist-tags are `latest: 0.2.0`; 0.3.0 is not published yet.

| Gate (on the 0.3.0 pin) | Result |
|---|---|
| `make check-djrust-pin` | ok, djwasm@0.3.0, glue matches |
| `make test-djrust` | all checks passed (worklet ready says crate 0.3.0) |
| `make test-djrust-golden`, `make test-djrust-neutral` | 282/282 bit-identical to 0.2.0; neutral with 7 controls present |
| `make test-djrust-cpu` / `djrust-cpu.mjs --check` against 0.2.0 | idle within ×0.985–1.011; memory 0 B growth under churn, 1,430,493 vs 11,256,373 B per load; seek worst 0.57–0.61 ms in 3 of 4 runs, **1 of 4 runs red** on one outlier (3.73 ms on a feed track, median there 0.32 ms) |
| `make test-djrust-browser` | all pass, tri-render = golden; module source `local` (CDN 404) |
| `make test-e2e`, `go test ./...`, `scripts/cid-freeze.sh` | 43/43, pass, pass |
| `make djrust-verify-cdn` | **fails** (HTTP 404, not published) |

### Page wired to 0.3.0 (branch `djrust-net-clock`, studio plan step 3, 2026-11-15)

- **Engine gaps follow the module, not the version.** `wave.js` `probeEngineFeatures` reads
  `djw_features` from the same module the engine loads (and the running worklet's `ready` message,
  `node.js` `handle.features`, wins over that probe); `engine-gaps.js` hides exactly the macros
  `catalog.js` `engineRunsMacro(id, features)` says it cannot run. Mask 0 (0.2.0) gives the old
  stylesheet; 0.3.0 shows the 9 net macros, Auto-DJ and Panic; master / aux macros unhide by
  themselves once a module reports MASTER_MACROS / AUX_MACROS. The Beats pads (hit1-hit4: Fire,
  Repeat) are page work on every engine (a stinger unmute for N bars, `catalog.js`
  `macroRunnable`) and are never sent to the engine as a fire.
- **R-1a.** A timed fire is one `{type:'fire-macro', id, duration}` to the worklet and the UI only
  pulses; it never falls back to the worker. A permanent (∞) fire stays page-side (plain per-target
  mutes, the old tempo path). The serial slot is released by `macro-restored` (or a mask of 0 for 3
  ticks, with a wall-timer backstop). Panic sends `panic`. The engine gets `control-macros {on,
  disabled}` at start and on every disabled-set change; `control-fired` in `backend/index.js` is
  then UI-only, so nothing fires twice, and control fires show from the engine's `macro-fired`.
  Behaviour change: control and macroCurve fires bypass the page's serial `_macroQueue`.
  A stop, or Panic while stopped, with an engine macro held puts the page's own state back, since a
  stopped engine posts no tick: the mutes become the worker's set plus manual mutes, and `el._tempo`
  / the BPM box become `el._project.tempo` (`wave.js` `settleStoppedEngine`); the engine's
  `engine-tempo` events are followed too. While the engine holds a macro its mutes are not mirrored
  into `el._project.initialMutes`, which the share collector reads.
- **R-2.** Auto-DJ picks only macros the engine runs; busy = engine `macroMask` != 0 or a running /
  queued slot. It draws only from pools `engine-gaps.js` shows (`catalog.js` `autoDjPoolLive`):
  the Transition pool is offered once the engine runs at least half of its curated spread, so on
  0.3.0 (tape-stop only) it is hidden and unused rather than "tape-stop at every track change"; the
  Beats pool shows (the pads are page work). **Auto-DJ never runs on a render page** (`?render=1`,
  `?render=offline`; `wave.js` `isRenderPage`): 9 feed envelopes carry `autoDj.run=true` (one,
  `z4EBG9j2iDv3LU…` ambient, with the Transition pool and no `macrosDisabled`; seven with a 32/64-bar
  regen), and a realtime farm bake records the live engine, so with Auto-DJ on, those bakes would
  carry random macros and a regenerated track. Live listeners get Auto-DJ back on 0.3.0, as R-2
  intends. **Whether a farm bake should ever carry Auto-DJ is a decision for Matt** (with 1 and 5).
- **R-9.** A seek while playing goes to the engine (answered by `seeked`); stopped, it goes to the
  worker as before; Play from a playhead past 0 seeks the engine first.
- **R-8.** Groove (FLAG.GROOVE via processorOptions) engages live only on an explicit override:
  `grooveOverride` in `wave.js` (a share's swing / humanize off the genre's composed default, or a
  slider move). Every share carries both fields, so the schema cannot tell a choice from a stale
  value; under this rule 2 of the 52 feed envelopes (house, 0/10 against 20/15:
  `z4EBG9jA6NzmRN…`, `z4EBG9j6vq5meg…`) engage groove live. **Decision 1 for Matt.** A render
  page never takes a share's groove (the realtime farm records this live engine), so their farm
  bakes stay 0.2.0's.
- **R-16.** `offline-render.js` puts everything in processorOptions (`offlineEngineOptions`; the
  50 ms mute sleep is gone). With no opt-in it sends the 0.2.0 call sequence. Control macros and
  `macrosDisabled` go in only on `opts.controlMacros` or `?render-macros=1`; groove only on
  `opts.groove` / a session slider move (`el._grooveOverride.source === 'session'`), never from a
  share's fields, even off the genre default (that would re-groove 33 of 52 feed bakes at their
  fields' values, and the two house envelopes even under the live rule). An earlier cut of this
  wiring did take a share-sourced override in the farm's `renderToBlobOffline(el, {maxMs})` call;
  `test-djrust-render-freeze` now boots every envelope through `waveLoadProject` and makes exactly
  that call, and `test-djrust-browser` FARM BOOT checks the worklet's processorOptions keys on the
  real `?render=offline` boot of all 52. Only `examples/voltage-rush.json` (a control net firing `beat-repeat`) would bake
  differently with control macros on. **Decision 5 for Matt**; no farm URL opts in today.
- **Still hidden** (need djwasm 0.4.0): master FX, the FX / Pitch / Feel / Pan / Shape macros and
  their Auto-DJ pools.

| Gate (step 3, 0.3.0 pin, wiring in place) | Result |
|---|---|
| `make check-djrust-pin` | ok, djwasm@0.3.0, glue matches |
| `go test ./... -count=1`, `make test-model-parity`, `make test-cohesion-parity` | pass |
| `scripts/cid-freeze.sh` | pass (7 examples, 52 feed envelopes) |
| `make test-djrust` | all checks passed |
| `make test-djrust-golden`, `make test-djrust-neutral` | 282/282 bit-identical to 0.2.0 (neutral: 7 controls) |
| `node scripts/djrust-cpu.mjs --check` | all cpu gates passed |
| `make test-djrust-page-macros` (now in `test-djrust-node`) | all pass (26 cases, incl. Beats pads, pool rule, render page, stop / Panic settle, offline groove) |
| `make test-djrust-render-freeze` (feed corpus booted through `waveLoadProject`, the farm's own `renderToBlobOffline(el, {maxMs})` call) | 277 checks = the 0.2.0 golden (incl. 52 "farm opts: only `mutes`") |
| `make test-djrust-browser` | all pass: gaps (0.3.0 and the 0.2.0 reference), page fire, Beats pads, stop mid macro, double-fire guard, offline macros, tri-render = golden, FARM BOOT (52 envelopes × `?render=offline` and `?render=1`) |
| `make test-wave-browser`, `make test-scope-browser` | pass |
| `make test-e2e` | 47/47 (engine-gaps follow the feature mask) |
| `make test-audio TEST_AUDIO_WORKERS=8` | 4/4: cut, breakdown, drop, half-time take effect, recover, run once, held for the length asked (during windows 3.36 / 3.35 / 3.05 / 1.46 s) |
| `make probe-djrust-gaps` (trap:42) | cut 0.75 (unfired control 1.03), solo-drums 0.84 (control 0.97): < 1.0, ≥ 0.05 below control, one page macro-fired each |
| `bazel test //...`, `bazel run //:gazelle -- -mode=diff` | 16 pass; no diff |
| `make djrust-verify-cdn` | **fails** (HTTP 404: 0.3.0 not on npm yet) |
