# beats-bitwrap-io

100% client-side Petri net beat generator. Fork of petri-note with all server logic moved to browser.

## Architecture

- **Go server** (`main.go`): Embeds `public/` and serves static files on `:8089`
- **Web Worker** (`sequencer-worker.js`): Runs Petri net sequencer tick loop + beat generation
- **Main thread** (`petri-note.js`): UI rendering, audio playback via Tone.js
- **Communication**: Worker ↔ main thread via `postMessage` using same JSON protocol as original WebSocket

## Stack

- Go 1.23+ static file server with `embed`
- Vanilla JS/ES modules (no npm, no bundler)
- Tone.js v14 (CDN) for Web Audio synthesis
- ES Module Web Workers (`type: 'module'`)

## Build & Run

```bash
make build   # Build binary
make run     # Build and run on :8089
make dev     # Run from disk (go run) on :8089
```

## Deployment (beats.bitwrap.io)

```bash
ssh pflow.dev "cd ~/Workspace/beats-bitwrap-io && git pull && make build && ~/services restart beats-bitwrap"
```

## Key Files

| File | Purpose |
|------|---------|
| `public/petri-note.js` | Main UI component (custom HTMLElement) |
| `public/audio/tone-engine.js` | Tone.js audio engine |
| `public/sequencer-worker.js` | Web Worker: sequencer tick loop |
| `public/lib/pflow.js` | Petri net engine (discrete token firing) |
| `public/lib/generator/` | Beat generation (Euclidean, Markov, theory) |

## Petri Net Concepts

- **Place**: Holds tokens
- **Transition**: Fires when all input places have sufficient tokens (respecting inhibitors)
- **Arc**: Connects place↔transition with weight; `inhibit: true` blocks if tokens present
- Tokens circulate → transitions fire → MIDI events trigger sounds
