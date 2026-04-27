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

Use `git ls-files` / `grep` for the file-by-file map. The non-obvious bits worth knowing up front:

- **Worker / engine** — `public/sequencer-worker.js` runs the tick loop; `public/lib/pflow.js` is the Petri-net engine; `public/audio/tone-engine.js` holds the 40+ instrument configs and master FX. **Don't split tone-engine.js** — the instrument lookup is cohesive and fragmenting hurts it.
- **Generator** (`public/lib/generator/`) — composer / euclidean / markov / theory / structure / variety / regenerate / macros / genre-instruments. `arrange.js` is a **full JS port of `internal/generator/arrange.go`** — `arrangeWithOpts(proj, genre, size, opts)` with Go parity. All arrange DSL directives (structure / variants / fadeIn / drumBreak / feelCurve / macroCurve / sections / overlayOnly) run in-process, so production hosts without `-authoring` reconstitute the full arrangement client-side. Client prefers this path over `/api/arrange`.
- **Main-thread modules** (`public/lib/{ui,macros,backend,project,share,feel,audio}/`) — every method on the `PetriNote` class is a one-line wrapper that calls a same-named function in one of these modules (see "Extraction pattern" above). Edit the module.
- **Server** (`main.go` + `internal/`) — `share/` is the content-addressed seal/store + JSON-LD/Schema endpoint; `sequencer/` is the authoritative Petri-net executor; `ws/` mirrors the in-page worker protocol; `routes/` is `/api/*`; `midiout/` is CoreMIDI/ALSA fanout; `mcp/` is the stdio MCP server; `generator/` is the Go side of the composer with byte-identical output to JS.
- **Schemas** — three of them, see "Three schemas in this repo" below.

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
- **Mixer sections** are driven by each net's `track.group` (`drums`/`bass`/`melody`/`harmony`/`arp`/`pad`/`stinger`, or any freeform name). The composer tags its output explicitly; hand-authored tracks pick their own. The mixer renders a divider per distinct group in `sectionOrder` precedence (`drums`, `percussion`, `bass`, `chords`, `harmony`, `lead`, `melody`, `arp`, `pad`, `texture`, `stinger`, anything unknown last). Legacy fallback: if `track.group` is missing, `hitN` IDs are still bucketed as `stinger` so pre-attribute shares keep working; everything else falls into `main` (no divider).
- **Macros panel**: ~35 tricks across groups — Mute / FX / Pitch / Tempo / Pan (per-channel non-drum) / Shape (per-channel decay: Tighten / Loosen / Pulse). Serial queue with visible depth badge. Right-click any tile to toggle its Auto-DJ-disabled mark (persists to `localStorage['pn-macro-disabled']`). Hover + MIDI pad press binds pad-note to macro. Every macro pulses its target UI (slider / mute button / FX slider) with a chase-light and restores the target to its pre-macro value on release. In-flight pulse tokens / pan snapshots / decay snapshots are cancelled on `applyProjectSync` so project regeneration doesn't leak animations onto new DOM nodes.
- **Auto-DJ**: armed with `Run`; fires random macros from checked pools every N bars (1–1024, powers of 2). `Stack` (1–3) fires multiple concurrently. `Regen` (off / 8–1024 bars) generates a fresh track on a timer with a one-bar-early pre-render for seamless swaps. `Animate only` spins the ring on cadence without touching macros. Tick-wrap guard on `curTick < prevTick` avoids double-regen after a reset. Ring rotates ±90° per fire (arrowheads flip on CCW so token flow matches the spin). Settings are DOM-only (in the `.pn-effects` panel) and survive `renderMixer` / project regen.
- **Beats panel**: four `hitN` Fire pads arranged in a 2×2 grid. Each Fire is an **N-bar macro** (bars dropdown, default 2): unmutes the stinger track so its Petri ring pulses on every beat, then re-mutes on timer. Pit dropdown transposes the track during its unmute window (read live in `onRemoteTransitionFired` — so manual unmute via the `1`–`4` hotkey or mixer mute button respects the same pitch). FX dropdown pairs any macro with the Fire click at the same N-bar duration. Instruments come from a curated stinger set including reserved `unbound` (silent slot that still fires paired FX).
- **Feel modal** (◈ next to genre): XY morph pad with four corner snapshots — **Chill** (BL) / **Drive** (BR) / **Ambient** (TL) / **Euphoric** (TR). Dragging the puck bilinearly blends tempo, master FX, Auto-DJ, swing, humanize. **Genre constellation**: all 19 presets are plotted on the pad; hovering a star shows a dashed ghost puck preview, clicking snaps + engages. Engage/disengage + preview → apply/cancel semantics (Cancel fully restores the pre-open state).
- **Stage mode** (▣ pill next to Shuffle or `M` hotkey): full-page overlay that renders every unmuted music net as its own live sub-Petri ring, arranged as a meta-net with connector place-circles + arrows. Read-only view; audio keeps playing through the normal pipeline. Four stackable viz modes in the top-left menu: **Flow** (panels drift), **Pulse** (beat particles fly from panel centers to composition center — panels sit in front so particles appear to emerge from behind ring outlines), **Flame** (per-panel radial beam aimed at each panel's exact angle), **Tilt** (3D perspective rotation of the whole grid).
- **Playhead on the ring**: the last-fired transition keeps a soft gold `.playhead` class until the next one fires, so the beat position reads across the room during live playback.
- **Keyboard shortcuts** (documented inline in the Help modal): `Space` play/stop · `G` generate · `S` shuffle · `F` Feel · `M` Stage · `J` Auto-DJ Run · `A` animate only · `P` panic · `B` FX bypass · `R` FX reset · `T` tap tempo · `,` / `.` BPM ∓1 · `1`–`4` toggle hit tracks · `[` / `]` prev / next track · `←↑→↓` nudge hovered slider · `?` help · `Esc` close modal. Skipped when focus is in an input/select/textarea or a modal owns keys.
- **Cursor-anchored slider tip**: a single `.pn-slider-tip` element in `document.body` floats beside the pointer showing the hovered slider's live value (Hz for HP/LP, Q for resonance, L/C/R for pan, ms for decay, %, 0.25s for delay time, Off / `N-bit` for crush, etc.). No inline value spans means hover state never shifts row layout. Shared helpers in `lib/ui/slider-tip.js` (`showSliderTip` / `hideSliderTip` / `syncSliderTip`).
- **Per-track Preset Manager** (`★` button): save/apply/delete mixer panels (vol/pan/filters/decay) scoped by channel. Persists to `localStorage['pn-instrument-presets']`.
- **Trait editor modal**: click any genre trait chip (Ghosts, Syncopation, etc.) to toggle on/off or tune percentage. Triggers regeneration with updated params.
- **MIDI binding editor**: click any note badge on a transition to edit note / channel / velocity / duration. Bidirectional C4 ↔ integer sync. Scroll to nudge any field.
- **Universal hover-scroll**: every `<input type="number|range">` and `<select>` adjusts by 1 on wheel — capture-phase listener on the host element.
- **MIDI toggle** (top-right): enables Web MIDI I/O. Per-track audio-output dropdowns only appear when MIDI is enabled.
- **MIDI tab** (panel-toggle row, alongside FX / Macros / Beats / Auto-DJ / Arrange / Note): consolidates all MIDI input UI. Status row (connected devices + Monitor + Reset MIDI), Xpose pill (±48 semitone live transpose with a 🎹 listen-from-keybed toggle), CC bindings list (with `●`/`○` mute-state indicators when bound to mute targets), Notes bindings list (pads + keybed → macros / mute toggles). Hover-bind on every target type — slider, mute button, section divider, BPM input, macro tile.
- **Joystick defaults** (controllers with a 2-axis stick like the MPK Mini): pitch bend (X axis) drives Xpose live, ±12 semitones snap-to-semitone, springs to +0 on release. CC1 / modwheel (Y axis) drives BPM, 60..300 range, springs back to the pre-grab tempo on release. Both behave like temporary modulators rather than destructive setters; the tempo / transpose you had before grabbing the joystick is canonical. Explicit hover-bind on CC1 wins if the user wants the modwheel doing something else.
- **Feel pad** (◈ next to the genre dropdown): orthogonal tone × BPM XY pad. X axis = master Hi-Cut filter (left dark / 50% closed → right bright / 100% open); Y axis = BPM (bottom slow / base × 0.6 → top fast / base × 1.4). Spring-return on release: pointerdown snapshots the live tempo + LP value, pointerup restores them — the pad is a temporary modulator, not a setter. Other live FX / Auto-DJ / swing / humanize stay where they were set.
- **MIDI Monitor modal**: opened via the Monitor button on the MIDI tab. Logs every incoming MIDI message verbatim (Note On/Off, CC, Aftertouch, Pitch Bend, Program Change, Channel Pressure, raw hex for anything else). Last-event LCD readout + scrollable history (capped at 200 lines, newest on top) + Clear and Copy-to-clipboard buttons. Bindings still fire while the modal is open so the user sees raw message + bound action together.

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

### Three schemas in this repo (don't confuse them)

| Path | Status | Purpose |
|---|---|---|
| `public/schema/beats-share.{context.jsonld,schema.json}` | **Wire format.** Served at `/schema/beats-share`. | Validates the share-v1 envelope (`?cid=…` payloads). The contract for any agent producing playable links. |
| `public/schema/petri-note.schema.json` | **Runtime project shape.** | What `nets:` round-trips through — `parseNetBundle` consumes this. Used by `internal/share` to validate hand-authored `nets` blocks before sealing. |
| `schema/petri-note.schema.json` + `schema/README.md` | **Reference / vestigial.** Test-only. | The richer petri-note v1 JSON-LD shape (Scenes, inter-net `connections`, inhibitor arcs, silent transitions) inherited from the merged petri-note repo. `internal/pflow/schema_test.go` validates `schema/example-*.json` against it. Not served, not enforced at runtime — kept because `/api/song.jsonld` and a future Scenes-aware authoring path target this shape. |

## Generating a share payload (agents / LLMs / non-UI front-ends)

The share envelope is the IR. Any producer — a human, an LLM, a CLI — that emits valid JSON against `public/schema/beats-share.schema.json` gets the same deterministic playback, the same `?cid=…`, the same offline-playable artifact. The schema is the contract; CLAUDE.md is just a pointer.

**Minimum valid payload** (see `examples/minimal.json`):

```json
{
  "@context": "https://beats.bitwrap.io/schema/beats-share",
  "@type": "BeatsShare",
  "v": 1,
  "genre": "techno",
  "seed": 42
}
```

Everything else is an optional override. Omit defaults to keep CIDs stable across producers.

**Realistic payload with overrides**: `examples/overrides.json`.

**Valid `genre` values** are the options in `public/lib/ui/build.js` (`.pn-genre-select`): ambient · blues · bossa · country · dnb · dubstep · edm · funk · garage · house · jazz · lofi · metal · reggae · speedcore · synthwave · techno · trance · trap. A genre outside this list regenerates as the fallback preset.

**Playback**: POST the JSON to `PUT /o/{cid}` (server will re-verify the CID) or just open `?cid=z…&z=<base64url-gzip-json>`. No AI, no model, no backend call during playback.

## Hand-authored payloads (raw `nets`)

When a project can't be reduced to `(genre, seed)` + overrides — e.g. bespoke petri-net topologies, custom instrument routing, macro-scheduled control nets — the share envelope carries the literal nets in an optional `nets` field. On load, `public/lib/share/url.js::shareFromPayload` threads them through to the boot path, which dispatches `project-load` with the raw project instead of calling the composer. Inflates the URL (≈10-100 kB post-gzip), but is the only way to faithfully round-trip authored content.

**Shape** — keys are net IDs, values match the JSON the worker's `parseNetBundle` (`lib/pflow.js`) already consumes:

```json
{
  "@context": "https://beats.bitwrap.io/schema/beats-share.context.jsonld",
  "@type": "BeatsShare", "v": 1,
  "genre": "custom", "seed": 0,
  "tempo": 92, "humanize": 4,
  "fx": { "reverbWet": 55, "delayWet": 40, "phaserWet": 28 },
  "nets": {
    "arp": {
      "role": "music",
      "track": { "channel": 4, "defaultVelocity": 90, "instrument": "bright-pluck", "group": "arp" },
      "places": { "p0": { "initial": [1], "x": 0, "y": 0 }, "p1": { "initial": [0], "x": 10, "y": 0 } },
      "transitions": {
        "t0": { "x": 5, "y": 0, "midi": { "note": 60, "channel": 4, "velocity": 90, "duration": 140 } }
      },
      "arcs": [ { "source": "p0", "target": "t0", "weight": [1] },
                { "source": "t0", "target": "p1", "weight": [1] } ]
    }
  }
}
```

Control-only nets set `"role": "control"` and use `"control": { "action": "...", ... }` on transitions instead of `"midi"`. Supported actions: `mute-track`, `unmute-track`, `toggle-track`, `activate-slot`, `stop-transport`, `fire-macro` (with optional `macro`, `macroBars`, `macroParams`). See `lib/macros/catalog.js` for the curated macro ID list.

**Sealing the payload from an agent — no Go binary needed.** See `examples/README.md` for the end-to-end Python recipe (canonical JSON + CIDv1 + `PUT /o/{cid}`) and a tour of the worked examples (`minimal`, `overrides`, `hand-authored`, `macro-orchestrated`, `voltage-rush`, `phantom-aqueduct`).

Rate limits: 10 PUT/min/IP, 120 PUT/min global, 256 kB max per payload. Schema caps: at most 256 nets per payload, 2048 places / 2048 transitions / 8192 arcs per net, 64-char IDs matching `^[a-zA-Z0-9][a-zA-Z0-9_-]*$` (rejects `__proto__`, `constructor`, etc.). `control.action` is one of `mute-track`, `unmute-track`, `toggle-track`, `mute-note`, `unmute-note`, `toggle-note`, `activate-slot`, `stop-transport`, `fire-macro`. CIDs are immutable — same canonical bytes twice return 200 without a second disk write.

### Arrange-on-load and the polyphony ceiling

The share envelope carries an optional `structure` directive (values: `loop`, `ab`, `drop`, `build`, `jam`, `minimal`, `standard`, `extended`) plus `arrangeSeed`. When present and not `loop`, the boot path runs **in-process** via `arrangeWithOpts` from `public/lib/generator/arrange.js` (the full JS port of Go's `ArrangeWithOpts`) — a 1 kB envelope reconstitutes a 3 MB arranged track. `/api/arrange` still exists in authoring mode as a fallback / tooling path. `ArrangeWithOpts(proj, genre, size, opts)` is deterministic: same inputs → byte-identical output (map iteration order sorted, not ranged). The CID of the envelope uniquely addresses the exact listening experience; compression is free because the expansion rule is public code.

**Arrange vocab (envelope fields, also accepted by `/api/arrange` body):**
- `structure` — section blueprint. Values above.
- `arrangeSeed` — RNG seed for blueprint pick, phrase choice, velocity humanization.
- `velocityDeltas` — object mapping riff-variant letter to velocity offset, e.g. `{"A":0, "B":25, "C":-15}`. Default `{"A":0, "B":15, "C":-15}`.
- `maxVariants` — cap on distinct riff letters per role (1-8). Letters beyond the cap collapse back to `A`.
- `fadeIn` — array of role names that start muted and unmute mid-intro. Variant expansion handled: `"pad"` fans out to `pad-0`/`pad-1`/`pad-2` before the `FadeIn()` helper injects fade-in control nets.
- `drumBreak` — bars of drum-only break injected at the track midpoint. Non-drum roles mute for the duration (stingers excluded); drums keep playing; everyone returns. `0` disables.
- `sections` — author-supplied section blueprint replacing the built-in pick. Each entry `{name, steps, active: [roles]}`. Useful for bespoke forms the 19 blueprints don't cover.
- `feelCurve` — array of `{section, x, y}` entries. Injects a `feel-curve` control net whose transitions fire `set-feel` at section start ticks; the client's `control-fired` handler calls `_applyFeel([x, y])` to snap the Feel XY puck. Morphs tempo/FX/swing/humanize across sections.
- `macroCurve` — array of `{section, macro, bars}` entries. Injects a `macro-curve` control net that fires `fire-macro` at section start ticks — e.g. `reverb-wash` at `intro`, `riser` at `buildup`, `beat-repeat` at `drop`. Runtime dispatches through the frontend's existing `fire-macro` handler; any macro id in `catalog.js` is valid.
- **Overlay mode** — when the loaded project already has a `structure` field (composer output, prior arrange), pass `overlayOnly: true` to skip blueprint pick + variant expansion and only layer on the curves/fades/break. Wired automatically: the Arrange tab's apply button runs overlay when possible.

**Arrange tab (UI)** — fifth toggle in the panel row next to Auto-DJ. Exposes the DSL as UI: Structure dropdown, Fade-In checkboxes, Drum-Break bars, Feel-curve preset, Macro-curve preset, and an Arrange ⟳ button that applies the chosen overlay to the currently loaded track. Runs entirely client-side via the JS port — no authoring-mode server required.

Pattern for adding the next directive: schema field → embedded schema sync (`internal/share/beats-share.schema.json`) → envelope passthrough in `main.go::buildShareEnvelope` → `ArrangeOpts` field in Go (`internal/generator/arrange.go`) → JS port field in `public/lib/generator/arrange.js` → `/api/arrange` body in `internal/routes/routes.go` → client reader in `shareFromPayload` → boot-path wiring in `petri-note.js` + `backend/index.js`.

**Known limitation — per-channel polyphony.** Each channel gets one `Tone.PolySynth` with `maxPolyphony = 256` (bumped from 64; `public/audio/tone-engine.js:1604` + `:1655`). `playNote()` does not do explicit voice stealing — Tone reuses voices after release only. Long-tail instruments (pad, held reese) with multiple variants can still exceed 256 on very dense arrangements, logging `Max polyphony exceeded. Note dropped.`. Remaining fixes (tracked in TODO.md):

1. Voice stealing in `playNote()` — track `(note, releaseTime)` per channel and cancel the oldest release when at capacity.
2. Arrangement-aware release on mute — cancel in-flight notes on a channel when `mute-track` fires. Root-cause fix.

## Running locally for hand-authored tracks

The same binary that serves `beats.bitwrap.io` can run locally as a **full authoring engine** under a single `-authoring` flag. This wakes up:

- **Sequencer control** — `/api/project` (GET/POST current project), `/api/generate` (compose from genre+seed+params), `/api/transport` (play/stop/pause), `/api/tempo`, `/api/mute`, `/api/instrument`, `/api/shuffle-instruments`, `/api/arrange` (regenerate song structure).
- **Read-only catalog** — `/api/genres` (genres + their tunable parameters, drives the dropdown), `/api/instruments` (synth catalog), `/api/midi-routing` (current MIDI mode + net→port assignments when fanout is on).
- **Preview without loading** — `/api/generate-preview` renders a fresh project but does not swap it into the live sequencer; `/api/song.jsonld` is the JSON-LD-envelope variant of `/api/project` for interop with the petri-note v1 schema.
- **Local saved-track gallery** — `/api/save` (POST a project, stores it on disk under its CID with a tag and metadata), `/api/tracks` (list, sorted by upvotes), `/api/tracks/{cid}.jsonld` (load one back), `/api/vote` (record an EIP-191 / MetaMask-signed upvote — see `internal/routes/eth.go`).
- **Share + mirror** — `/api/project-share` seals the currently-loaded project as a share-v1 envelope with raw nets + optional mirror PUTs to remote hosts in one call. `/api/mirror-cid` replays an already-sealed local CID to `beats.bitwrap.io` (or any other seal host).
- `/ws` — the same message protocol the in-page worker speaks, so a browser pointed at `data-backend="ws"` drives its audio through the Go sequencer instead of Tone.js alone.
- Server-side MIDI output via `gitlab.com/gomidi/midi/v2` — stream sequencer fires to CoreMIDI (macOS), ALSA (Linux), or a virtual port so headless hosts can drive a DAW.
- `./beats-bitwrap-io mcp` — stdio MCP server so Claude Code can generate, audition, and seal tracks via 11 curated tools (`generate`, `transport`, `tempo`, `get_project`, `load_project`, `list_genres`, `list_instruments`, `shuffle_instruments`, `mute_track`, `set_instrument`, `get_midi_routing`).

### Start the server

```bash
make build
./beats-bitwrap-io -authoring -addr :8080
```

Server flags (apply with or without `-authoring`):
- `-addr ":8089"` — listen address.
- `-public ""` — serve from disk instead of embedded files (use this when iterating on `public/lib/*` so changes don't require a rebuild).
- `-data "./data"` — content-addressed share-store directory.
- `-max-store-bytes 268435456` — hard cap on total share-store bytes (default 256 MiB).
- `-put-per-min 10` / `-global-put-per-min 120` — share-store rate limits (per-IP, then global; `0` disables the global cap).

MIDI flags (mutually exclusive routing modes; require `-authoring`):
- `-midi "IAC"` — send to one multi-channel port, substring-matched. Add `-midi-virtual` to create a virtual port with that name when no existing port matches.
- `-midi-per-net` — create one virtual port per net. Name prefix is configurable via `-midi-prefix "petri-note"` (yielding `petri-note-kick`, `petri-note-bass`, …).
- `-midi-fanout "petri-note Bus"` — open every existing output port whose name starts with the given prefix and pin nets to ports by **musical role priority** (drums → bass → melody/lead → arp/pads → others alphabetical). Deterministic across restarts so in-DAW per-channel filters keep working. `GET /api/midi-routing` returns the live netID → port map.
- `-midi-list` — print available ports and exit (no server starts).

Without `-authoring` the same binary runs the production configuration (static + share store only); all authoring routes return 404 and MIDI flags emit a warning.

### Wire Claude Code to the MCP server

```bash
claude mcp add beats-btw ./beats-bitwrap-io mcp
```

Each tool talks to the HTTP server on `http://localhost:8080` by default — keep `-authoring` running in another shell. Override the target with `BEATS_BTW_URL=http://localhost:<port>` in the MCP entry's env (useful when `:8080` is taken by another service). The MCP tools are the same ones documented in the in-app help modal under **Using with AI**; `generate` takes a genre + seed + variety params, `load_project` accepts a raw petri-net JSON (the hand-authored shape documented above), and so on.

### Drive a track hand-to-hand

```bash
# 1. Hand-author: POST the raw project shape from examples/hand-authored.json.
curl -sX POST http://localhost:8080/api/project -d @examples/hand-authored.json

# 2. Seal + mirror to the public store so the ?cid= URL works anywhere.
curl -sX POST http://localhost:8080/api/project-share \
    -d '{"mirror":["https://beats.bitwrap.io"]}'
# → { "cid": "z…", "shortUrl": "http://localhost:8080/?cid=z…", "mirrors": [{"host":"…","status":200}] }

# 3. Share the returned shortUrl (with the beats.bitwrap.io host swapped in).
```

Everything that petri-note.git previously did now lives here. That repo is archived — use `-authoring` on this binary for the same functionality.

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

### Production data layout

Everything lives under `~/Workspace/beats-bitwrap-io/data/` on pflow.dev:

| Path | Purpose |
|---|---|
| `data/o/<cid>` | Content-addressed share store. Every `?cid=…` URL anyone has ever sealed. **Deleting these breaks share links permanently.** |
| `data/audio/` | Cached audio renders (wav/mp3) served to the feed. Safe to delete — server re-creates them on demand when audio-render is enabled. |
| `data/index.db` | SQLite track index. Drives `/feed`, `/feed.rss`, `/api/feed`, and (when `-rebuild-queue` is on) the `rebuild_queue` table. Recreated on startup from `schema.sql` if missing. Safe to delete. |
| `data/.rebuild-secret` | 32-byte hex secret generated on first boot (mode 0600). Worker uploads carrying this in `X-Rebuild-Secret` bypass first-write-wins on PUT `/audio/{cid}.webm`. Treat as a credential — don't commit, don't paste in chat. |

### Purge the feed without nuking shares

Clears the gallery / RSS feed but keeps every `?cid=…` link working. Existing audio renders are dropped; the server re-renders on the next visit:

```bash
# 1. Stop the service (NOTE: ~/services stop ignores its argument and stops
#    everything — record what was running first if you care).
ssh pflow.dev "~/services list"                 # snapshot before
ssh pflow.dev "~/services stop"

# 2. Wipe feed index + audio cache (leave data/o/ alone).
ssh pflow.dev "cd ~/Workspace/beats-bitwrap-io && rm -f data/index.db && rm -rf data/audio"

# 3. Bring services back. ~/services start only restarts the SERVICE_ORDER set,
#    so verify each one came back; restart any stragglers individually.
ssh pflow.dev "~/services start && ~/services list"
```

Verify the feed is empty: `curl -sS https://beats.bitwrap.io/api/feed` → `[]`.

To **also** purge every shared CID (much more destructive — every `?cid=…` URL anyone has ever made returns 404 forever): `rm -rf data/o`. Don't do this unless that's specifically what you want.

### Rebuild queue (off-host audio repair)

Listeners can flag a feed card with broken or stuck audio by tapping the
⟳ button — the server records the CID in `data/index.db.rebuild_queue`,
and an off-host worker (`scripts/process-rebuild-queue.py`) picks it
up, re-renders, uploads, and clears the row. Live in production
(prod's `~/services` script invokes the binary with `-rebuild-queue`);
the ⟳ button is hidden when the flag is off.

Routes (all open: anyone can mark, anyone can read, anyone can clear —
the cost of abuse is bounded by the worker's render budget and the
`X-Rebuild-Secret` gating on actual writes):

- `POST /api/rebuild-mark {cid}` — adds to queue (rate-limited via the
  share-store limiter).
- `GET  /api/rebuild-queue?limit=N` — JSON array of pending CIDs.
- `POST /api/rebuild-clear {cid}` — removes a row (worker calls after
  a successful upload).
- `GET  /api/features` — `{rebuildQueue, genreColors}`. Frontend
  feature-detects the ⟳ button visibility from this.

Worker (run on a MacBook with chromedp / Chrome):

```bash
ssh pflow.dev "cat ~/Workspace/beats-bitwrap-io/data/.rebuild-secret"
# in one terminal — local server with -audio-auto-enqueue=false to avoid
# the chromedp race that produced the original 110-byte stubs:
./beats-bitwrap-io -authoring -audio-render -audio-auto-enqueue=false \
    -audio-concurrent 2 -audio-max-duration 6m -audio-render-timeout 15m \
    -addr :18090 -data /tmp/beats-worker-data
# in another terminal:
BEATS_REBUILD_SECRET=$(...) ./scripts/process-rebuild-queue.py --watch
```

The worker sends `X-Rebuild-Secret` on every PUT `/audio/{cid}.webm`
which bypasses three checks: rate limit, faster-than-realtime, and
first-write-wins. That last one is what lets it replace stuck audio
without SSH-deleting the bad file. Without the secret, a worker can
still queue and render but its uploads fall back to the public path —
fine for fresh CIDs, useless for stuck ones.

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

Front-end supports `data-backend="ws"` — when set, `connectWebSocket(el)` opens `ws://<host>/ws` and speaks the same JSON message types as the in-page worker. Authoritative dispatch in `internal/ws/hub.go`; client-side handlers in `lib/backend/index.js::handleWsMessage`. Production `beats.bitwrap.io` does NOT run `/ws` (deployed without `-authoring` to keep attack surface minimal); run locally via `-authoring` to enable it. Motivation: let a remote sequencer or agent conduct the browser, or render headless via CoreMIDI/ALSA.
