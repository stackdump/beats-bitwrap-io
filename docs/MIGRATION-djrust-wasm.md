# Moving beats.bitwrap.io onto the djrust engine (WASM), and off Tone.js

**Status 2026-11-14 (branch `djrust-only`): Tone.js is gone. djrust is the studio's only engine.**
Matt decided the flip no longer waits for phases 3–5. Losing features for a while is acceptable;
they are rebuilt on djrust afterwards. Every feature switched off for this is listed in **§12** with
what it needs. Not merged to main; merging deploys.

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

Hidden by one stylesheet and guarded in code, all from `public/lib/ui/engine-gaps.js`. To bring a
feature back, route it to the engine and delete its entry there. Share collectors and appliers are
untouched, so a share carrying `fx` / `autoDj` / macro settings still round-trips byte for byte; the
settings just do nothing yet.

| # | Feature | State now | What it needs from djrust / djwasm |
|---|---|---|---|
| R-1 | **Macros** (~35, Macros panel, Panic, MIDI-pad / key / control-net `fire-macro`, `macroCurve`) | panel hidden; `fireMacro` returns early | export `WaveRunner::fire_macro` (`NetMacro` / `MasterMacro`) in the C ABI, a `fire-macro` worklet message; restore `sched.js` to the audio clock or drop it. `make test-audio` comes back (it is parked; `make test-audio-parked` runs it). |
| R-2 | **Auto-DJ** (panel, regen, transition macros in shuffle mode) | panel hidden; `autoDjTick` returns early | R-1. Regen (a new Generate) could return before R-1. |
| R-3 | **Master FX**: reverb, delay, drive, pitch, HP/LP, phaser, crush, Bypass, Reset | groups hidden; master volume stays (it is the host gain) | export `fx::master_chain` + `WaveOptions::extended()` and per-param messages; idle cost ≈ 0 (W-10). Feel's lp blend and `feelCurve` ride on this. |
| R-4 | **Channel strip**: per-channel pan / volume / HP / HPR / LP / LPR / decay | slider groups hidden | per-lane voice settings in djwasm. Default role pans (`applyDefaultPans`) are no-ops until then. |
| R-5 | **Live instrument change** (mixer dropdown, `»` rotate, Shuffle's `instruments-changed`) | dropdown shown as a label, not clickable; shuffle updates the UI only | a worklet message that swaps one lane's voice without a project reload (a reload resets the tick at the next bar). |
| R-6 | **Instrument tone tools**: test note ♫, tone presets ★, tone reset / prev / random | hidden | a "play one note on lane N" message; presets need per-lane voice settings (R-4). |
| R-7 | **One-shot synths** (airhorn, laser, …; `kind: 'custom'` / `'note'` in `lib/audio/oneshots.js`) | silent (no-op) | stinger voices in the engine. Hit pads that unmute stinger *nets* still work. |
| R-8 | **Swing / humanize, live transpose, hit-pad pitch** | not applied to audio (they never reached the wave engine either); still applied to Web MIDI out | engine-side swing/humanize/transpose (`WaveOptions` / live keys). |
| R-9 | **Seek, loop region, crop** | the worker seeks, the worklet does not | `catch_up` / `align` in the ABI (phase 4). |
| R-10 | **Per-channel audio output devices** | throws, logged; per-channel MIDI routing still works | multiple worklet outputs or one engine per output. Whole-master output device works. |
| R-11 | **Scope model views** (kernels, model bands/spectrogram, residual) | model off; **measured on by default**; the status says so | render kernels as one hit per instrument through the worklet in an OfflineAudioContext (`renderKernels` in `scope-model.js`); expose filter state for the FX response. |
| R-12 | **Insert render** (`?insert=counterMelody`, Go `internal/audiorender` inserts) | page reports an error | wrap the note list in a one-net project and render it like `offline-render.js` (`renderNotesOffline` in `insert-render.js`). |
| R-13 | **Benchmark** | Tone cases A/B/F removed from the page (server still accepts them for old rows); C/D/E run the JS wave engine, which is not the studio engine any more | a djrust case: new id in `internal/bench` (schema column) and `bench-core.js`. |
| R-14 | **Telemetry engine label** | djrust reports as `wave` | §10 #3: accept `djrust` server-side. |
| R-15 | **WS backend** (`data-backend="ws"`, Go sequencer) | composes only; the Go sequencer is never told to play | stream the worklet's ticks to `/ws` or drop the WS playback path. |
| R-16 | **Offline render extras** (master FX, macros, swing in `?render=offline`) | not rendered (the Tone renderer had them) | R-1, R-3, R-8. |

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
