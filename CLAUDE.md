# beats-bitwrap-io

Deterministic beat generator where the sequencer IS a Petri net executor. Every note is a transition firing, every rhythm is tokens circulating through places.

## Architecture

```
Browser Main Thread                    Web Worker
──────────────────                    ──────────────
petri-note.js (UI + controls)  ◄───► sequencer-worker.js (tick loop)
tone-engine.js (Tone.js audio)         ├── pflow.js (Petri net engine)
                                       └── generator/ (composition)
```

- **Worker** runs the Petri net tick loop at `60000 / (BPM × PPQ)` ms intervals
- Each tick: check enabled transitions → resolve conflicts → fire → post MIDI events
- **Main thread** receives `transition-fired` messages → plays sound via Tone.js
- Communication is `postMessage` — no WebSocket, no server involvement during playback

## Key Subsystems

| Path | What it does |
|------|-------------|
| `public/lib/pflow.js` | Petri net engine: places, transitions, arcs, inhibitors, token firing |
| `public/sequencer-worker.js` | Tick loop, transport, seek (fast-forward replay), loop, mute state |
| `public/audio/tone-engine.js` | 40+ instrument configs, per-channel synths, master FX chain |
| `public/lib/generator/composer.js` | Orchestrates full track composition from genre preset + seed |
| `public/lib/generator/euclidean.js` | Bjorklund algorithm → token rings for drum patterns |
| `public/lib/generator/markov.js` | Markov chain melodies with chord-tone targeting |
| `public/lib/generator/theory.js` | Scales, chord progressions, voice leading, modal interchange |
| `public/lib/generator/structure.js` | Song sections (intro/verse/chorus/drop/bridge/outro) |
| `public/lib/generator/arrange.js` | Control nets that mute/unmute tracks at section boundaries |
| `public/lib/generator/variety.js` | Ghost notes, walking bass, call/response, tension curves |
| `public/lib/generator/regenerate.js` | Rebuild a single track's subnet from stored `track.generator` recipe (drives live Size/Hits dropdowns) |
| `public/lib/generator/macros.js` | `buildMacroRestoreNet` — transient linear-chain control nets that fire restore actions on terminal transition |
| `public/petri-note.js` | Custom HTMLElement: mixer, timeline, diagram, macros panel, preset manager |
| `public/petri-note.css` | Dark theme, responsive layout (phone/tablet/desktop) |

## How Petri Nets Drive Everything

1. **Drum patterns**: Euclidean rhythms become circular token rings — a single token moves step-to-step, firing at hit positions
2. **Melodies**: Markov-generated note sequences encoded as token rings with MIDI bindings on transitions
3. **Song structure**: Linear control nets fire `mute-track`/`unmute-track`/`activate-slot` actions at section boundaries
4. **Riff variants**: Multiple nets share a `riffGroup`; `activate-slot` switches which variant is active
5. **Conflict resolution**: When multiple transitions compete for tokens from one place, one wins randomly
6. **Seek**: Replays all ticks silently from tick 0 to target (control events applied, MIDI suppressed)
7. **Live performance macros**: `fire-macro` message injects a short linear-chain control net per target; its terminal transition carries the restore action. Exhausted macro nets (token reached terminal place) are auto-pruned from `project.nets` each tick to prevent accumulation.
8. **Dynamic ring resize**: Each track stores its `generator` recipe (`euclidean`, `markov`, etc.) on `track`; changing Size/Hits sends `update-track-pattern` which rebuilds the subnet and swaps it in at the next bar boundary (`pendingNetUpdates`).

## Front-end UI features

- **Macros panel** (next to FX): 15 tricks in 3 groups — Mute / FX / Tempo. Serial queue with visible depth badge; hover + MIDI pad press binds pad-note to macro.
- **Per-track Preset Manager** (`★` button): save/apply/delete mixer panels (vol/pan/filters/decay) scoped by channel. Persists to `localStorage['pn-instrument-presets']`.
- **Trait editor modal**: click any genre trait chip (Ghosts, Syncopation, etc.) to toggle on/off or tune percentage. Triggers regeneration with updated params.
- **MIDI binding editor**: click any note badge on a transition to edit note / channel / velocity / duration. Bidirectional C4 ↔ integer sync. Scroll to nudge any field.
- **Universal hover-scroll**: every `<input type="number|range">` and `<select>` adjusts by 1 on wheel — capture-phase listener on the host element.
- **MIDI toggle** (top-right): enables Web MIDI I/O. Per-track audio-output dropdowns only appear when MIDI is enabled.

## Build & Run

```bash
make build   # Build Go binary (embeds public/)
make run     # Build and serve on :8089
make dev     # Serve from disk (go run, hot reload) on :8089
```

Requires Go 1.22+. No npm, no node_modules, no bundler.

## Deployment

```bash
ssh pflow.dev "cd ~/Workspace/beats-bitwrap-io && git pull && make build && ~/services restart beats-bitwrap"
```

Live at [beats.bitwrap.io](https://beats.bitwrap.io) on port 8089 behind nginx.

## Conventions

- **No npm/bundler** — vanilla ES modules, Tone.js from CDN
- **No framework** — single custom HTMLElement (`<petri-note>`)
- **Deterministic** — same genre + seed = same track (seeded PRNG via `mulberry32`)
- **Worker does all sequencing** — main thread only handles UI and audio output
- **JSON-LD schema** at `public/schema/petri-note.schema.json` defines project format

## Roadmap — Remote Conductor (WS backend)

Planned: allow the front-end to be *played* (driven) by a WebSocket connection
from a separate service. The element already supports `data-backend="ws"` —
when set, `_connectWebSocket()` opens `ws://<host>/ws` and sends/receives the
same JSON message types as the in-page worker.

- **Go server in this repo is NOT the WS endpoint** — it's a pure static file
  server. The conductor / endpoint implementation lives in a separate repo
  (end-to-end tested there), and `beats.bitwrap.io` acts as a **client** that
  connects to that conductor's `/ws`.
- The WS path needs to proxy every worker message type the client sends
  (`generate`, `project-load`, `transport`, `tempo`, `mute`, `mute-group`,
  `fire-macro`, `update-track-pattern`, `cancel-macros`, `transition-fire`,
  `loop`, `seek`, `crop`, `deterministic-loop`, `shuffle-instruments`) and
  emit the responses the client expects (`ready`, `project-sync`,
  `state-sync`, `mute-state`, `tempo-changed`, `transition-fired`,
  `control-fired`, `instruments-changed`, `track-pattern-updated`,
  `track-pattern-error`, `preview-ready`, `playback-complete`).
- Motivation: let a remote sequencer or an agent conduct the browser — useful
  for live sets driven by external hardware, collaborative jams, or headless
  rendering where the tone engine is just an audio sink.
- Today: the WS client code exists but has no paired server in this repo, so
  leaving `data-backend="ws"` unset (the default) is correct for local use.
