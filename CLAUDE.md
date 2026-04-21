# beats-bitwrap-io

Deterministic beat generator where the sequencer IS a Petri net executor. Every note is a transition firing, every rhythm is tokens circulating through places.

## Architecture

```
Browser main thread                                 Web Worker
───────────────────                                 ──────────────
<petri-note> element (petri-note.js, ~1.4k lines)    sequencer-worker.js (tick loop)
  ├── lib/ui/*            — mixer, modals, canvas    ├── lib/pflow.js (Petri net engine)
  ├── lib/macros/*        — runtime, effects, catalog└── lib/generator/* (composition)
  ├── lib/share/*         — CID-addressed shares
  ├── lib/backend/*       — transport + worker/WS + MIDI I/O + viz
  ├── lib/project/*       — serialize/download + apply-project-sync
  ├── lib/feel/*          — 4-axis performance sliders
  ├── lib/audio/*         — note-name, oneshots, tone-engine
  └── lib/generator/*     — genre instruments
```

- **Worker** runs the Petri net tick loop at `60000 / (BPM × PPQ)` ms intervals.
- Each tick: check enabled transitions → resolve conflicts → fire → post MIDI events.
- **Main thread** receives `transition-fired` messages → plays sound via Tone.js.
- Communication is `postMessage` — no WebSocket, no server involvement during playback.

## Extraction pattern (READ THIS FIRST)

`public/petri-note.js` is intentionally small (~1.4k lines). **Almost every method on the `PetriNote` class is a one-line wrapper** that delegates to an imported module function of the same name:

```js
// In petri-note.js
_fireMacro(id) { return fireMacro(this, id); }
```

```js
// In lib/macros/runtime.js
export function fireMacro(el, id) { /* actual implementation */ }
```

**When adding / changing behavior, edit the module, not the wrapper.** The wrapper exists so `el._fireMacro(…)` call sites — tests, Playwright probes, browser devtools — keep working unchanged. If you need a new method: add it to the appropriate module first, then add a one-line wrapper on the class.

**When adding a new cluster of helpers**, follow the pattern: create `public/lib/<area>/<name>.js`, export `function fn(el, ...args)`, import it at the top of `petri-note.js`, add `_fn(...args) { return fn(this, ...args); }` on the class. See `lib/share/codec.js` for the simplest reference example.

## Key subsystems

### Worker / core engine
| Path | Role |
|------|------|
| `public/sequencer-worker.js` | Tick loop, transport, seek (fast-forward replay), loop, mute state |
| `public/lib/pflow.js` | Petri net engine — places, transitions, arcs, inhibitors, token firing |
| `public/audio/tone-engine.js` | 40+ instrument configs, per-channel synths, master FX chain. **Don't split it** — the instrument lookup is cohesive and fragmenting hurts it. |

### Generator (composition pipeline)
| Path | Role |
|------|------|
| `public/lib/generator/composer.js` | Orchestrates full track composition from genre preset + seed |
| `public/lib/generator/euclidean.js` | Bjorklund algorithm → token rings for drum patterns |
| `public/lib/generator/markov.js` | Markov-chain melodies with chord-tone targeting |
| `public/lib/generator/theory.js` | Scales, chord progressions, voice leading, modal interchange |
| `public/lib/generator/structure.js` | Song sections (intro/verse/chorus/drop/bridge/outro) |
| `public/lib/generator/arrange.js` | Control nets that mute/unmute tracks at section boundaries |
| `public/lib/generator/variety.js` | Ghost notes, walking bass, call/response, tension curves |
| `public/lib/generator/regenerate.js` | Rebuild a single track's subnet from its `track.generator` recipe (drives live Size/Hits dropdowns) |
| `public/lib/generator/macros.js` | `buildMacroRestoreNet` — transient linear-chain control nets that fire restore actions on a terminal transition |
| `public/lib/generator/genre-instruments.js` | Per-genre channel→instrument default maps |

### Main-thread element modules (all talk through `el`)
| Path | Role | LOC |
|------|------|-----|
| `public/petri-note.js` | Custom element class + constructor + lifecycle + thin wrappers + top-level orchestration | ~1,400 |
| `public/lib/ui/build.js` | `buildUI(el)` — every DOM template (header / transport / mixer container / macro panels / traits / timeline / modals) | 870 |
| `public/lib/macros/runtime.js` | Fire/execute + serial queue + Auto-DJ tick loop + one-shot row favorites + panic | 725 |
| `public/lib/ui/mixer.js` | `renderMixer` + event delegation + preset manager + tone nav + mixer-state save/restore | 700 |
| `public/lib/backend/index.js` | Transport (play/tempo/wake-lock/media-session) + worker+WS plumbing + `handleWsMessage` dispatch + remote fire + humanize/swing | 560 |
| `public/lib/ui/controllers.js` | Trait chip row + trait editor modal + Feel modal + FX slider helpers + `macroPulse` + `channelParamMove` | 530 |
| `public/lib/backend/audio-io.js` | Tone.js bootstrap + Web MIDI I/O + CC/pad bindings + mute + playback routing + viz dots | 360 |
| `public/lib/ui/canvas.js` | Net diagram (places/transitions/arcs) + timeline + playhead + loop markers | 360 |
| `public/lib/ui/dialogs.js` | MIDI-binding editor + manual transition fire + help + quickstart | 350 |
| `public/lib/macros/effects.js` | fx-sweep / fx-hold + tempo-hold / tempo-sweep + beat-repeat + compound + cancel-all | 280 |
| `public/lib/project/sync.js` | `applyProjectSync` orchestrator (cancels anims → state → `_buildUI` → restore → kick playback) + instrument apply + role-based pan spread | 265 |
| `public/lib/share/url.js` | Parse incoming `?cid=…&z=…` URLs + `buildShareUrlForms` + server upload + Share modal with storage dropdown | 230 |
| `public/lib/project/serialize.js` | Upload → load · live → JSON download (strips x/y, defaults) | 165 |
| `public/lib/share/collect.js` | DOM/state → plain-object collectors + `buildSharePayload` | 145 |
| `public/lib/share/codec.js` | Canonical JSON + sha256 + base58btc + CIDv1 + gzip↔base64url (mirrors `seal.go`) | 130 |
| `public/lib/macros/catalog.js` | `MACROS` array (~30 entries) + target selectors + `TRANSITION_MACRO_IDS` | 130 |
| `public/lib/share/apply.js` | Share payload → DOM/state appliers + `applyShareOverrides` | 110 |
| `public/lib/feel/axes.js` | `FEEL_AXES` + `FEEL_MAP` (4 abstract sliders → FX/AutoDJ/trait overrides) | 90 |
| `public/lib/audio/oneshots.js` | `ONESHOT_INSTRUMENTS` catalog + `oneShotSpec` + `prettifyInstrumentName` | 65 |
| `public/lib/ui/mixer-sliders.js` | `MIXER_SLIDERS` config + `hpFreq`/`lpFreq`/`qCurve` | 35 |
| `public/lib/audio/note-name.js` | MIDI note ↔ name (C4 / F#3 / Bb5) | 20 |

### Server (Go)
| Path | Role |
|------|------|
| `main.go` | Static file server, CORS, `/schema/beats-share` content-negotiated handler |
| `seal.go` | Content-addressed share store (`PUT /o/{cid}`), HMAC-anonymized per-IP rate limit, global rate limit, JSON-Schema validation |
| `canonical.go` | Go port of JS `_canonicalizeJSON` so Go can mint CIDs identical to the browser |
| `schema_handler.go` | `/schema/beats-share` serves JSON-LD / JSON-Schema / HTML glossary based on Accept header |
| `seal_test.go` | End-to-end store tests + canonical-JSON parity test |
| `public/schema/beats-share.{context.jsonld,schema.json}` | JSON-LD context + Draft 2020-12 schema for the share-v1 envelope |
| `public/schema/petri-note.schema.json` | JSON-Schema describing the *project* shape (nets/places/transitions) |

## How Petri nets drive everything

1. **Drum patterns** — Euclidean rhythms become circular token rings; a single token moves step-to-step, firing at hit positions.
2. **Melodies** — Markov-generated note sequences encoded as token rings with MIDI bindings on transitions.
3. **Song structure** — Linear control nets fire `mute-track` / `unmute-track` / `activate-slot` actions at section boundaries.
4. **Riff variants** — Multiple nets share a `riffGroup`; `activate-slot` switches which variant is active.
5. **Conflict resolution** — When multiple transitions compete for tokens from one place, one wins randomly.
6. **Seek** — Replays all ticks silently from tick 0 to target (control events applied, MIDI suppressed).
7. **Live performance macros** — `fire-macro` message injects a short linear-chain control net per target; its terminal transition carries the restore action. Exhausted macro nets (token reached terminal place) are auto-pruned from `project.nets` each tick to prevent accumulation.
8. **Dynamic ring resize** — Each track stores its `generator` recipe (`euclidean`, `markov`, etc.) on `track`; changing Size/Hits sends `update-track-pattern` which rebuilds the subnet and swaps it in at the next bar boundary (`pendingNetUpdates`).

## Front-end UI features

- **Tabs** (toggle bar above the mixer, stack independently top-to-bottom in order FX → Macros → Beats → Auto-DJ): **FX** (master chain sliders), **Macros** (live-performance tricks, see below), **Beats** (hit1–hit4 stinger Fire pads that mirror schema-reserved muted tracks living on channels 20–23), **Auto-DJ**.
- **Macros panel**: ~35 tricks across groups — Mute / FX / Pitch / Tempo / Pan (per-channel non-drum) / Shape (per-channel decay: Tighten / Loosen / Pulse). Serial queue with visible depth badge. Right-click any tile to toggle its Auto-DJ-disabled mark (persists to `localStorage['pn-macro-disabled']`). Hover + MIDI pad press binds pad-note to macro. Every macro pulses its target UI (slider / mute button / FX slider) with a chase-light and restores the target to its pre-macro value on release. In-flight pulse tokens / pan snapshots / decay snapshots are cancelled on `applyProjectSync` so project regeneration doesn't leak animations onto new DOM nodes.
- **Auto-DJ**: armed with `Run`; fires random macros from checked pools every N bars (1–1024, powers of 2). `Stack` (1–3) fires multiple concurrently. `Regen` (off / 8–1024 bars) generates a fresh track on a timer with a one-bar-early pre-render for seamless swaps. `Animate only` spins the ring on cadence without touching macros. Tick-wrap guard on `curTick < prevTick` avoids double-regen after a reset. Ring rotates ±90° per fire (arrowheads flip on CCW so token flow matches the spin). Settings are DOM-only (in the `.pn-effects` panel) and survive `renderMixer` / project regen.
- **Beats panel**: four `hitN` Fire pads route through the track's channel (vol/pan/filter apply, bypasses mute). Each pad has a Pit dropdown (transposes test-note + fire), an FX dropdown (pair any macro with the click), and picks from a curated stinger instrument set including the reserved `unbound` (silent slot that still triggers paired FX macros).
- **Feel modal** (◈ next to genre): 4 abstract sliders — Energy / Groove / Chop / Space — map deterministically onto FX / Auto-DJ / trait overrides. Engage/disengage + preview → apply/cancel semantics (Cancel fully restores the pre-open state).
- **Per-track Preset Manager** (`★` button): save/apply/delete mixer panels (vol/pan/filters/decay) scoped by channel. Persists to `localStorage['pn-instrument-presets']`.
- **Trait editor modal**: click any genre trait chip (Ghosts, Syncopation, etc.) to toggle on/off or tune percentage. Triggers regeneration with updated params.
- **MIDI binding editor**: click any note badge on a transition to edit note / channel / velocity / duration. Bidirectional C4 ↔ integer sync. Scroll to nudge any field.
- **Universal hover-scroll**: every `<input type="number|range">` and `<select>` adjusts by 1 on wheel — capture-phase listener on the host element.
- **MIDI toggle** (top-right): enables Web MIDI I/O. Per-track audio-output dropdowns only appear when MIDI is enabled.

## Share URLs (CID-addressed)

- Share button opens a modal with a **Store** dropdown:
  - **Server (short link)** — default. Uploads canonical JSON to `PUT /o/{cid}`; URL is `?cid=z…` (~80 chars).
  - **URL (self-contained)** — inline gzipped payload: `?cid=z…&z=<base64url-gzip>` (~1.5 KB). Works offline / from a local copy / if the store is ever purged.
- The CID is `base58btc(CIDv1(dag-json, sha256(canonical-JSON(payload))))` — produced by `lib/share/codec.js` on the client and re-verified on the server (`seal.go`). **JS and Go canonicalize identically** — parity test in `seal_test.go::TestCanonicalJSONRoundTrip` guards drift.
- Payload envelope: `@context` + `@type: BeatsShare` + `v: 1` + genre + seed + optional tempo/swing/humanize/structure/traits/tracks/fx/feel/autoDj/macrosDisabled/initialMutes/hits/ui/loop. Validated by `public/schema/beats-share.schema.json` (Draft 2020-12).

### What belongs in a share payload (and what doesn't)

A share reproduces the **track + how to listen to it**, not a specific session. Decisions follow two rules:

1. **Include it if it changes what someone hears when they open the link.** Genre/seed/traits regenerate the nets; overrides (`tracks`, `fx`, `feel`, `autoDj`, `hits`, `initialMutes`, `loop`) carry anything a listener wouldn't recover by regenerating from defaults.
2. **Include it if it reflects the *author's intent for the listen.* ** Panel toggles (`ui.showFx`/`showMacros`/`showOneShots`) and `ui.playbackMode` are author signal — "open the track with these panels visible, in shuffle mode."

Everything else is **transient by design** and intentionally omitted:

| Excluded | Why |
|---|---|
| MIDI CC / pad learn bindings | Per-user hardware; bindings aren't portable to someone else's MIDI surface. |
| Tone presets (`pn-instrument-presets`) | `localStorage`-scoped per browser; portable preset export is a different feature, not a share concern. |
| Wake-lock / MIDI enable | Device / session settings; nothing to do with the track. |
| `_spaceHeld` / hover state / `_macroQueue` | Live UI state; exists only during playback. |
| Auto-DJ regen timer / pre-rendered next track | Performance-side cache; rebuilt fresh on each session. |
| Service-worker / cache version | Deployment concern. |
| Tap-tempo history / active feel-preview puck | Transient input-state. |

When adding a new user-tunable knob: ask "would the author expect this setting to be preserved when they share?". If yes, add a collector in `lib/share/collect.js`, an applier in `lib/share/apply.js`, and a `$defs` / property entry in `public/schema/beats-share.schema.json`. Defaults should be **omitted from the payload** so unconfigured shares stay byte-identical for CID stability. Appliers run in dependency order in `applyShareOverrides` — DOM-touching appliers (`applyHitState`) run **after** the panel toggle that creates their DOM (`applyUiState`).

## Schema endpoints

- `GET /schema/beats-share` — content-negotiated:
  - default / `Accept: application/ld+json` → JSON-LD `@context`
  - `Accept: application/schema+json` → Draft 2020-12 JSON-Schema
  - `Accept: text/html` → rendered HTML term glossary
- Static paths always work: `/schema/beats-share.context.jsonld`, `/schema/beats-share.schema.json`.

## Build & Run

```bash
make build   # Build Go binary (embeds public/)
make run     # Build and serve embedded files on :8089
make dev     # Serve public/ from disk on :8089 — needed when iterating on JS/CSS
```

Requires Go 1.22+. No npm, no node_modules, no bundler. The embedded build is the right choice for production; `make dev` is faster for iteration because every file save is picked up without a rebuild.

When smoke-testing with Playwright against local, pass `-public public` so lib/* changes don't require a rebuild:

```bash
/tmp/beats-local -addr :18090 -data /tmp/beats-local-data -public public
```

## Deployment

```bash
ssh pflow.dev "cd ~/Workspace/beats-bitwrap-io && git pull && make build && ~/services restart beats-bitwrap"
```

Live at [beats.bitwrap.io](https://beats.bitwrap.io) on port 8089 behind nginx. Only restart `beats-bitwrap` — other services on pflow.dev are independent.

## Conventions

- **No npm/bundler** — vanilla ES modules, Tone.js from CDN.
- **No framework** — single custom HTMLElement (`<petri-note>`).
- **Deterministic** — same genre + seed = same track (seeded PRNG via `mulberry32`).
- **Worker does all sequencing** — main thread only handles UI and audio output.
- **Class methods on `PetriNote` are thin wrappers** — edit the module, not `petri-note.js`, unless you're touching the constructor, lifecycle, or wiring.
- **No behavioral changes in extraction passes** — every refactor should produce byte-identical share payloads and identical DOM output. Round-trip a share through Playwright to verify.
- **Content addressing never changes retroactively** — if you modify what `_buildSharePayload` returns, existing `?cid=…` links still point at the OLD bytes (which were hashed into those CIDs). Plan feature rollouts around that.

## Testing

- `go test ./...` — covers share store, rate limit, CID parity between JS and Go canonicalization. **Must be green before any commit.**
- Playwright via MCP — smoke-test changes that touch the DOM or share pipeline:
  ```
  make dev  # or: /tmp/beats-local -public public
  # Playwright: navigate, wait for _project + _currentGen.params.seed, exercise _buildShareUrlForms + the specific feature you changed.
  ```
- Manual: click Share → copy URL → open in a fresh tab → confirm genre/seed/tempo/tracks match.

## Roadmap — Remote Conductor (WS backend)

Planned: allow the front-end to be *played* (driven) by a WebSocket connection from a separate service. The element already supports `data-backend="ws"` — when set, `connectWebSocket(el)` opens `ws://<host>/ws` and sends/receives the same JSON message types as the in-page worker.

- **Go server in this repo is NOT the WS endpoint** — it's a pure static file server + share store. The conductor / endpoint implementation lives in a separate repo (end-to-end tested there), and `beats.bitwrap.io` acts as a **client** that connects to that conductor's `/ws`.
- The WS path needs to proxy every worker message type the client sends (`generate`, `project-load`, `transport`, `tempo`, `mute`, `mute-group`, `fire-macro`, `update-track-pattern`, `cancel-macros`, `transition-fire`, `loop`, `seek`, `crop`, `deterministic-loop`, `shuffle-instruments`) and emit the responses the client expects (`ready`, `project-sync`, `state-sync`, `mute-state`, `tempo-changed`, `transition-fired`, `control-fired`, `instruments-changed`, `track-pattern-updated`, `track-pattern-error`, `preview-ready`, `playback-complete`). Full message catalogue lives in `lib/backend/index.js::handleWsMessage`.
- Motivation: let a remote sequencer or an agent conduct the browser — useful for live sets driven by external hardware, collaborative jams, or headless rendering where the tone engine is just an audio sink.
- Today: the WS client code exists but has no paired server in this repo, so leaving `data-backend="ws"` unset (the default) is correct for local use.
