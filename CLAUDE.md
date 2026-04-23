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
| `main.go` | Flag parsing, static file server, CORS, share-store wiring, `-authoring`-gated mount of sequencer/ws/routes/MIDI |
| `internal/share/seal.go` | Content-addressed share store (`PUT /o/{cid}`), HMAC-anonymized per-IP rate limit, global rate limit, JSON-Schema validation |
| `internal/share/canonical.go` | Go port of JS `_canonicalizeJSON` so Go can mint CIDs identical to the browser |
| `internal/share/schema_handler.go` | `/schema/beats-share` serves JSON-LD / JSON-Schema / HTML glossary based on Accept header |
| `internal/share/{share_page,share_card_png,qr}*.go` | Decorated root, OG share-card PNGs, QR codes |
| `internal/share/seal_test.go` | End-to-end store tests + canonical-JSON parity test |
| `internal/sequencer/sequencer.go` | Authoritative Petri-net executor — Play/Stop/Pause, Seek, SetLoop/GetLoop, CropProject, SetDeterministicLoop, FireTransition, SetMuted/SetGroupMuted, SetInstrument, ShuffleInstruments |
| `internal/ws/{hub,protocol,sequencer}.go` | `/ws` hub + JSON message protocol mirroring the in-page worker; broadcasts `transition-fired` / `state-sync` / `mute-state` / `loop-changed` / `preview-ready` |
| `internal/routes/routes.go` | All `/api/*` HTTP handlers (catalog, generate, transport, share-gallery) |
| `internal/routes/eth.go` | EIP-191 signature verify backing the `/api/vote` upvote path |
| `internal/midiout/midiout.go` | CoreMIDI/ALSA output — single-port, per-net virtual ports, fanout with role-priority pre-assignment, `AllNotesOff` panic |
| `internal/mcp/server.go` | `./beats-bitwrap-io mcp` stdio MCP server (11 tools) |
| `internal/pflow/{adapter,cid}.go` | Project model + JSON round-trip + CID hashing shared between sequencer and share path |
| `internal/generator/*` | Go port of the 19-genre composer (composer/euclidean/markov/theory/structure/arrange/variety/riffs/stingers/threering) |
| `public/schema/beats-share.{context.jsonld,schema.json}` | JSON-LD context + Draft 2020-12 schema for the share-v1 envelope (the wire format) |
| `public/schema/petri-note.schema.json` | JSON-Schema describing the *worker project* shape (nets/places/transitions/arcs) — what `nets:` round-trips through |
| `schema/petri-note.schema.json` + `schema/README.md` | **Reference** petri-note v1 JSON-LD (with Scenes / inter-net connections) inherited from the petri-note merge. Test-only — `internal/pflow/schema_test.go` validates the bundled `schema/example-*.json` fixtures against it. Not the wire format. |

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
      "track": { "channel": 4, "defaultVelocity": 90, "instrument": "bright-pluck" },
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

**Seal + publish end-to-end from an agent — no petri-note server required**:

```python
import hashlib, json, urllib.request

payload = { "@context": "...", "@type": "BeatsShare", "v": 1,
            "genre": "custom", "seed": 0, "nets": {...} }

# Canonical JSON: recursively sort object keys, compact separators.
def canon(v):
    if isinstance(v, dict):  return {k: canon(v[k]) for k in sorted(v)}
    if isinstance(v, list):  return [canon(x) for x in v]
    return v
canonical = json.dumps(canon(payload), separators=(',', ':'), ensure_ascii=False).encode()

# CID: "z" + base58btc(0x01 0xa9 0x02 0x12 0x20 + sha256(canonical))
h = hashlib.sha256(canonical).digest()
cid_bytes = bytes([0x01, 0xa9, 0x02, 0x12, 0x20]) + h
alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
n = int.from_bytes(cid_bytes, 'big')
out = ""
while n: n, r = divmod(n, 58); out = alphabet[r] + out
cid = "z" + ("1" * next((i for i, b in enumerate(cid_bytes) if b), 0)) + out

# PUT the bytes; server re-canonicalizes + verifies the CID match.
urllib.request.urlopen(urllib.request.Request(
    f"https://beats.bitwrap.io/o/{cid}",
    data=canonical, method="PUT",
    headers={"Content-Type": "application/ld+json"}))

print(f"https://beats.bitwrap.io/?cid={cid}")
```

Rate limits: 10 PUT/min/IP, 120 PUT/min global, 256 kB max per payload. Schema caps: at most 256 nets per payload, 2048 places and 2048 transitions per net, 8192 arcs per net, 64-char net / place / transition IDs matching `^[a-zA-Z0-9][a-zA-Z0-9_-]*$` (rejects `__proto__`, `constructor`, etc.). `control.action` must be one of `mute-track`, `unmute-track`, `toggle-track`, `mute-note`, `unmute-note`, `toggle-note`, `activate-slot`, `stop-transport`, `fire-macro`. CIDs are immutable — same canonical bytes twice return 200 without a second disk write.

**Local-binary alternative**: the same repo can run in authoring mode (`./beats-bitwrap-io -authoring`; see "Running locally" below) which exposes `POST /api/project-share {"mirror":["https://beats.bitwrap.io"]}`. That wraps the current project in a share envelope, seals locally, and fans out the PUT to every listed host in one call. Convenience only — the Python recipe above is the canonical way and works from anywhere without the Go binary.

### Worked examples (`examples/*.json`)

Drop-in starting points for `curl -d @examples/<name>.json http://localhost:8080/api/project` (sequencer load) or `… /o/{cid}` (direct share-store seal):

| File | What it shows |
|---|---|
| `minimal.json` | Smallest valid share — just `genre` + `seed`. CID-stable across producers. |
| `overrides.json` | Realistic share with `tempo` / `fx` / `feel` / `tracks` overrides on top of `(genre, seed)`. |
| `hand-authored.json` | Raw-`nets` share — bespoke topology, no composer involvement. Use as the template when porting an external sequence. |
| `blade-blood-rave.json`, `ivory-circuit.json`, `jurassic-park.json`, `life-aquatic.json`, `stranger-things.json`, `tiesto-adagio.json`, `upside-down-ii.json` | Hand-authored full tracks shipped with the merge — useful regression fixtures and reference for the raw-`nets` shape at scale. |

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
claude mcp add petri-note ./beats-bitwrap-io mcp
```

Each tool talks to the HTTP server on `http://localhost:8080` by default — keep `-authoring` running in another shell. The MCP tools are the same ones documented in the in-app help modal under **Using with AI**; `generate` takes a genre + seed + variety params, `load_project` accepts a raw petri-net JSON (the hand-authored shape documented above), and so on.

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

Front-end supports `data-backend="ws"` — when set, `connectWebSocket(el)` opens `ws://<host>/ws` and sends/receives the same JSON message types as the in-page worker. Client→server: `generate`, `generate-preview`, `project-load`, `transport`, `tempo`, `mute`, `mute-group`, `instrument-change`, `shuffle-instruments`, `arrange`, `fire-macro`, `update-track-pattern`, `cancel-macros`, `transition-fire`, `loop`, `seek`, `crop`, `deterministic-loop`, `edit`. Server→client: `ready`, `project-sync`, `state-sync`, `mute-state`, `tempo-changed`, `transition-fired`, `control-fired`, `instruments-changed`, `track-pattern-updated`, `track-pattern-error`, `loop-changed`, `preview-ready`, `playback-complete`. Authoritative dispatch in `internal/ws/hub.go`; client-side handlers in `lib/backend/index.js::handleWsMessage`.

- **Production `beats.bitwrap.io` does NOT run the WS endpoint.** The deployed binary starts without `-authoring`, so `/ws` returns 404 and the frontend stays on the in-page worker. This keeps the public host's attack surface minimal.
- **Run it locally** with `./beats-bitwrap-io -authoring` (see "Running locally" above). The same binary then serves `/ws` backed by the Go sequencer in `internal/sequencer`, `internal/ws`, and `internal/routes`, and optionally streams server-side MIDI via `-midi*` flags — useful for live sets driven by external hardware, collaborative jams, or headless rendering.
- Motivation: let a remote sequencer or an agent conduct the browser. The Go sequencer + MCP stdio tools + CoreMIDI/ALSA output handle the "headless rendering where the tone engine is just an audio sink" case on every desktop that can run Go.
