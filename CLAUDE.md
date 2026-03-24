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
| `public/petri-note.js` | Custom HTMLElement: mixer, timeline, diagram, genre selector |
| `public/petri-note.css` | Dark theme, responsive layout (phone/tablet/desktop) |

## How Petri Nets Drive Everything

1. **Drum patterns**: Euclidean rhythms become circular token rings — a single token moves step-to-step, firing at hit positions
2. **Melodies**: Markov-generated note sequences encoded as token rings with MIDI bindings on transitions
3. **Song structure**: Linear control nets fire `mute-track`/`unmute-track`/`activate-slot` actions at section boundaries
4. **Riff variants**: Multiple nets share a `riffGroup`; `activate-slot` switches which variant is active
5. **Conflict resolution**: When multiple transitions compete for tokens from one place, one wins randomly
6. **Seek**: Replays all ticks silently from tick 0 to target (control events applied, MIDI suppressed)

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
