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

Use `git ls-files` / `grep` for the file-by-file map. The non-obvious bits:

- **Worker / engine** — `public/sequencer-worker.js` runs the tick loop; `public/lib/pflow.js` is the Petri-net engine; `public/audio/tone-engine.js` holds the 40+ instrument configs and master FX. **Don't split tone-engine.js** — the instrument lookup is cohesive and fragmenting hurts it.
- **Generator** (`public/lib/generator/`) — composer / euclidean / markov / theory / structure / variety / regenerate / macros / genre-instruments. `arrange.js` is a **full JS port of `internal/generator/arrange.go`** with byte-identical Go parity. All arrange DSL directives (structure / variants / fadeIn / drumBreak / feelCurve / macroCurve / sections / overlayOnly) run in-process so production hosts without `-authoring` reconstitute the full arrangement client-side. Client prefers this path over `/api/arrange`.
- **Main-thread modules** (`public/lib/{ui,macros,backend,project,share,feel,audio}/`) — every method on the `PetriNote` class is a one-line wrapper around a same-named function in one of these modules. Edit the module.
- **Server** (`main.go` + `internal/`) — `share/` is the content-addressed seal/store + JSON-LD/Schema endpoint; `sequencer/` is the authoritative Petri-net executor; `ws/` mirrors the in-page worker protocol; `routes/` is `/api/*`; `midiout/` is CoreMIDI/ALSA fanout; `mcp/` is the stdio MCP server; `generator/` is the Go side of the composer with byte-identical output to JS.

## How Petri nets drive everything

1. **Drum patterns** — Euclidean rhythms become circular token rings; a single token moves step-to-step, firing at hit positions.
2. **Melodies** — Markov-generated note sequences encoded as token rings with MIDI bindings on transitions.
3. **Song structure** — Linear control nets fire `mute-track` / `unmute-track` / `activate-slot` actions at section boundaries.
4. **Riff variants** — Multiple nets share a `riffGroup`; `activate-slot` switches which variant is active.
5. **Conflict resolution** — When multiple transitions compete for tokens from one place, one wins randomly.
6. **Seek** — Replays all ticks silently from tick 0 to target (control events applied, MIDI suppressed).
7. **Live performance macros** — `fire-macro` message injects a short linear-chain control net per target; its terminal transition carries the restore action. Exhausted macro nets (token reached terminal place) are auto-pruned from `project.nets` each tick to prevent accumulation.
8. **Dynamic ring resize** — Each track stores its `generator` recipe (`euclidean`, `markov`, etc.) on `track`; changing Size/Hits sends `update-track-pattern` which rebuilds the subnet and swaps it in at the next bar boundary (`pendingNetUpdates`).

## Front-end UI

The studio is built from a panel toggle row (FX / Macros / Beats / Auto-DJ / Arrange / MIDI / Note) plus modals (Feel ◈, Stage ▣, MIDI Monitor, Trait editor, MIDI binding editor, per-track Preset Manager ★). All wiring lives in `public/lib/ui/` (panels, sliders, modals, mixer) and `public/lib/macros/` (catalog, runtime, effects). Live FX/macro panels expose ~35 macros across Mute / FX / Pitch / Tempo / Pan / Shape groups; Auto-DJ fires random macros from checked pools every N bars with optional regen + animate-only modes.

Mixer sections are driven by each net's `track.group` (`drums`/`bass`/`melody`/`harmony`/`arp`/`pad`/`stinger`, freeform). Section precedence: `drums`, `percussion`, `bass`, `chords`, `harmony`, `lead`, `melody`, `arp`, `pad`, `texture`, `stinger`, unknown last. Legacy fallback: missing `track.group` → `hitN` IDs bucket as `stinger`, everything else falls into `main`.

Keyboard shortcuts (full list in the in-app Help modal): `Space` play/stop · `G` generate · `S` shuffle · `F` Feel · `M` Stage · `J` Auto-DJ · `A` animate · `P` panic · `B` FX bypass · `R` FX reset · `T` tap tempo · `,`/`.` BPM ∓1 · `1`–`4` toggle hit tracks · `[`/`]` prev/next track · `←↑→↓` nudge hovered slider · `?` help · `Esc` close.

Universal hover-scroll: every `<input type="number|range">` and `<select>` adjusts by 1 on wheel via a capture-phase listener on the host element. Cursor-anchored slider tip lives in `lib/ui/slider-tip.js` (`showSliderTip` / `hideSliderTip` / `syncSliderTip`).

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
| Tone presets (`pn-instrument-presets`) | `localStorage`-scoped per browser; portable preset export is a different feature. |
| Wake-lock / MIDI enable | Device / session settings; nothing to do with the track. |
| `_spaceHeld` / hover state / `_macroQueue` | Live UI state; exists only during playback. |
| Auto-DJ regen timer / pre-rendered next track | Performance-side cache; rebuilt fresh each session. |
| Service-worker / cache version | Deployment concern. |
| Tap-tempo history / active feel-preview puck | Transient input-state. |

When adding a new user-tunable knob: ask "would the author expect this setting to be preserved when they share?". If yes, add a collector in `lib/share/collect.js`, an applier in `lib/share/apply.js`, and a `$defs` / property entry in `public/schema/beats-share.schema.json`. Defaults should be **omitted from the payload** so unconfigured shares stay byte-identical for CID stability. Appliers run in dependency order in `applyShareOverrides` — DOM-touching appliers (`applyHitState`) run **after** the panel toggle that creates their DOM (`applyUiState`).

## Schemas

`GET /schema/beats-share` is content-negotiated: default / `application/ld+json` → JSON-LD `@context`; `application/schema+json` → Draft 2020-12 JSON-Schema; `text/html` → rendered glossary. Static paths always work: `/schema/beats-share.context.jsonld`, `/schema/beats-share.schema.json`.

Three schemas in this repo (don't confuse them):

| Path | Status | Purpose |
|---|---|---|
| `public/schema/beats-share.{context.jsonld,schema.json}` | **Wire format.** Served at `/schema/beats-share`. | Validates the share-v1 envelope (`?cid=…` payloads). The contract for any agent producing playable links. |
| `public/schema/petri-note.schema.json` | **Runtime project shape.** | What `nets:` round-trips through — `parseNetBundle` consumes this. Used by `internal/share` to validate hand-authored `nets` blocks before sealing. |
| `schema/petri-note.schema.json` + `schema/README.md` | **Reference / vestigial.** Test-only. | The richer petri-note v1 JSON-LD shape (Scenes, inter-net `connections`, inhibitor arcs, silent transitions). `internal/pflow/schema_test.go` validates `schema/example-*.json` against it. Not served, not enforced at runtime — kept because `/api/song.jsonld` and a future Scenes-aware authoring path target this shape. |

## Generating a share payload (agents / LLMs / non-UI front-ends)

The share envelope is the IR. Any producer that emits valid JSON against `public/schema/beats-share.schema.json` gets the same deterministic playback, the same `?cid=…`, the same offline-playable artifact. The schema is the contract.

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

Everything else is an optional override. Omit defaults to keep CIDs stable across producers. Realistic payload with overrides: `examples/overrides.json`.

**Valid `genre` values** are the options in `public/lib/ui/build.js` (`.pn-genre-select`): ambient · blues · bossa · country · dnb · dubstep · edm · funk · garage · house · jazz · lofi · metal · reggae · speedcore · synthwave · techno · trance · trap. A genre outside this list regenerates as the fallback preset.

**Playback**: POST the JSON to `PUT /o/{cid}` (server will re-verify the CID) or open `?cid=z…&z=<base64url-gzip-json>`. No AI, no model, no backend call during playback.

## Hand-authored payloads (raw `nets`)

When a project can't be reduced to `(genre, seed)` + overrides — bespoke topologies, custom routing, macro-scheduled control nets — the envelope carries literal nets in an optional `nets` field. On load, `public/lib/share/url.js::shareFromPayload` threads them to the boot path which dispatches `project-load` with the raw project. Inflates the URL (≈10–100 kB post-gzip), but is the only way to faithfully round-trip authored content.

Shape: keys are net IDs, values match what `parseNetBundle` (`lib/pflow.js`) consumes — `role: music|control`, `track: {channel,instrument,group,...}`, `places: {pN: {initial, x, y}}`, `transitions: {tN: {x, y, midi: {...}}}`, `arcs: [{source, target, weight}]`. Control-only nets set `role: control` and use `control: {action, ...}` on transitions. See `examples/hand-authored.json` and `examples/macro-orchestrated.json`.

Supported `control.action`: `mute-track`, `unmute-track`, `toggle-track`, `mute-note`, `unmute-note`, `toggle-note`, `activate-slot`, `stop-transport`, `fire-macro` (with optional `macro`, `macroBars`, `macroParams`). See `lib/macros/catalog.js` for macro IDs.

**Sealing from an agent — no Go binary needed.** See `examples/README.md` for the end-to-end Python recipe (canonical JSON + CIDv1 + `PUT /o/{cid}`) and worked examples.

Rate limits: 10 PUT/min/IP, 120 PUT/min global, 256 kB max per payload. Schema caps: 256 nets per payload, 2048 places / 2048 transitions / 8192 arcs per net, 64-char IDs matching `^[a-zA-Z0-9][a-zA-Z0-9_-]*$` (rejects `__proto__`, `constructor`, etc.). CIDs are immutable — same canonical bytes twice return 200 without a second disk write.

### Arrange-on-load and the polyphony ceiling

The share envelope carries an optional `structure` directive (values: `loop`, `ab`, `drop`, `build`, `jam`, `minimal`, `standard`, `extended`) plus `arrangeSeed`. When present and not `loop`, the boot path runs **in-process** via `arrangeWithOpts` from `public/lib/generator/arrange.js` (the full JS port of Go's `ArrangeWithOpts`) — a 1 kB envelope reconstitutes a 3 MB arranged track. `/api/arrange` still exists in authoring mode as a fallback. `ArrangeWithOpts(proj, genre, size, opts)` is deterministic: same inputs → byte-identical output.

**Arrange vocab** (envelope fields, also accepted by `/api/arrange` body):
- `structure` — section blueprint (values above).
- `arrangeSeed` — RNG seed for blueprint pick, phrase choice, velocity humanization.
- `velocityDeltas` — riff-variant letter → velocity offset, e.g. `{"A":0,"B":25,"C":-15}`. Default `{"A":0,"B":15,"C":-15}`.
- `maxVariants` — cap on distinct riff letters per role (1-8). Letters beyond cap collapse to `A`.
- `fadeIn` — array of role names that start muted and unmute mid-intro. Variant expansion handled (`pad` → `pad-0`/`pad-1`/`pad-2`).
- `drumBreak` — bars of drum-only break injected at midpoint. Non-drum roles mute (stingers excluded); `0` disables.
- `sections` — author-supplied section blueprint replacing built-in pick: `{name, steps, active: [roles]}`.
- `feelCurve` — `[{section, x, y}]`. Injects a `feel-curve` control net firing `set-feel` at section starts; the client's `control-fired` handler calls `_applyFeel([x,y])`.
- `macroCurve` — `[{section, macro, bars}]`. Injects `macro-curve` firing `fire-macro` at section starts. Any macro id in `catalog.js` is valid.
- `counterMelody` — `[{section, mode, density, register, of?, instrument?}]`. **First arrange directive that synthesizes a music net** rather than a control net. Per entry: generates a counter line via `internal/generator/countermelody` (rule-based; no ML, no model — answer fills rest runs, harmony emits parallel 3rds, shadow emits 16th-late echoes), injects a `counter-melody-N` music net + a `gate-counter-melody-N` control net that mutes the counter outside the target section. Channel allocated as `max(existing music channel)+1` (skips 16). Default instrument: `electric-piano` for `register: above`, `sub-bass` for `register: below`. Note: dense `harmony` on a long-tail instrument can pressure the 256-voice/channel ceiling.
- **Overlay mode** — when the loaded project already has `structure`, pass `overlayOnly: true` to skip blueprint pick + variant expansion and only layer on curves/fades/break. The Arrange tab's apply button uses overlay automatically when possible.

Pattern for adding the next directive: schema field → embedded schema sync (`internal/share/beats-share.schema.json`) → envelope passthrough in `main.go::buildShareEnvelope` → `ArrangeOpts` field in Go (`internal/generator/arrange.go`) → JS port field in `public/lib/generator/arrange.js` → `/api/arrange` body in `internal/routes/routes.go` → client reader in `shareFromPayload` → boot-path wiring in `petri-note.js` + `backend/index.js`.

**Known limitation — per-channel polyphony.** Each channel gets one `Tone.PolySynth` with `maxPolyphony = 256` (bumped from 64; `public/audio/tone-engine.js:1604` + `:1655`). `playNote()` does not do explicit voice stealing — Tone reuses voices after release only. Long-tail instruments (pad, held reese) with multiple variants can still exceed 256 on dense arrangements (`Max polyphony exceeded. Note dropped.`). Voice stealing in `playNote()` and arrangement-aware release on mute were considered and rejected — the 256 ceiling is the chosen path (TODO.md).

## Running locally for hand-authored tracks

Same binary that serves `beats.bitwrap.io` runs locally as a **full authoring engine** under a single `-authoring` flag. This wakes up:

- **Sequencer control** — `/api/project`, `/api/generate`, `/api/transport`, `/api/tempo`, `/api/mute`, `/api/instrument`, `/api/shuffle-instruments`, `/api/arrange`.
- **Read-only catalog** — `/api/genres`, `/api/instruments`, `/api/midi-routing`.
- **Preview** — `/api/generate-preview`, `/api/song.jsonld`.
- **Local saved-track gallery** — `/api/save`, `/api/tracks`, `/api/tracks/{cid}.jsonld`, `/api/vote` (EIP-191 / MetaMask-signed; see `internal/routes/eth.go`).
- **Share + mirror** — `/api/project-share` seals the loaded project as share-v1 with raw nets + optional mirror PUTs in one call. `/api/mirror-cid` replays a sealed CID to remote hosts.
- `/ws` — same protocol as the in-page worker; a browser pointed at `data-backend="ws"` drives audio through the Go sequencer.
- Server-side MIDI output via `gitlab.com/gomidi/midi/v2` — CoreMIDI / ALSA / virtual port.
- `./beats-bitwrap-io mcp` — stdio MCP server (full toolset: `generate`, `transport`, `tempo`, `get_project`, `load_project`, `list_genres`, `list_instruments`, `shuffle_instruments`, `mute_track`, `set_instrument`, `get_midi_routing`, rebuild/archive tools, `generate_share`). The same toolset is also served over HTTP at `/mcp` under `-authoring`; production serves a curated public subset there. See "Wire Claude Code to the MCP server".

### Start the server

```bash
make build
./beats-bitwrap-io -authoring -addr :8080
```

Server flags (apply with or without `-authoring`):
- `-addr ":8089"` — listen address.
- `-public ""` — serve from disk (use when iterating on `public/lib/*`).
- `-data "./data"` — content-addressed share-store directory.
- `-max-store-bytes 268435456` — hard cap on share-store bytes (default 256 MiB).
- `-put-per-min 10` / `-global-put-per-min 120` — share-store rate limits.

MIDI flags (mutually exclusive; require `-authoring`):
- `-midi "IAC"` — send to one multi-channel port, substring-matched. Add `-midi-virtual` to create a virtual port if no existing port matches.
- `-midi-per-net` — one virtual port per net. Prefix configurable via `-midi-prefix "petri-note"`.
- `-midi-fanout "petri-note Bus"` — open every existing port whose name starts with prefix; pin nets by **musical role priority** (drums → bass → melody/lead → arp/pads → others alphabetical). Deterministic across restarts. `GET /api/midi-routing` returns the live netID → port map.
- `-midi-list` — print available ports and exit.

Without `-authoring` the same binary runs production config (static + share store only); authoring routes return 404 and MIDI flags warn.

### Wire Claude Code to the MCP server

Two transports expose the **same** tool builder (`mcp.NewServer`):

**stdio** (subprocess):
```bash
claude mcp add beats-btw ./beats-bitwrap-io mcp
```
Each tool talks to the HTTP server on `http://localhost:8080` by default — keep `-authoring` running. Override with `BEATS_BTW_URL=http://localhost:<port>`.

**HTTP / Streamable HTTP** (`internal/mcp/http.go`, mirrors petri-pilot's `/mcp` pattern) — a remote client drives a running server without a subprocess:
```bash
claude mcp add --transport http beats-btw http://localhost:8089/mcp   # authoring: full toolset
```
- **`-authoring` server** mounts the **full** toolset at `/mcp` (`RegisterHTTP`); proxy tools loop back to the server's own address.
- **Production** (no `-authoring`) mounts a **curated, stateless public subset** at `/mcp` (`RegisterHTTPPublic`): `generate_share`, `list_genres`, `get_song` — no sequencer control (none exists server-side in prod). `generate_share` builds a share-v1 envelope in-process, computes the CID (`share.CanonicalCID`), seals via public `PUT /o/{cid}`, and returns the `?cid=` URL. A guard test (`internal/mcp/public_test.go`) keeps control tools out of the public set.
- `GET /mcp` in a browser returns a landing page (tool list + the `claude mcp add` command); transport uses POST.

**`generate_share` with `render: true`** — predictable audio path. The handler (1) mirrors the envelope to `BEATS_MIRROR_HOST` (defaults to `https://beats.bitwrap.io`), (2) GETs the local server's `/audio/{cid}.webm` which synchronously renders the .webm, (3) PUTs the bytes to `{mirror}/audio/{cid}.webm` with `X-Rebuild-Secret`. Returns when the publish host serves the file — no waiting on the off-host render farm. Requires `BEATS_REBUILD_SECRET` in the MCP server's environment (the same value as the publish host's `data/.rebuild-secret`); without it, the tool seals the envelope but skips the render with a note. Without `render: true`, behaviour is unchanged (envelope-only seal).

**nginx for prod** — `/mcp` needs streaming, so proxy it explicitly (same gotcha as `/schema`):
```nginx
location = /mcp  { proxy_pass http://127.0.0.1:8089; proxy_buffering off; }
location /mcp/   { proxy_pass http://127.0.0.1:8089; proxy_buffering off; }
```

### Drive a track hand-to-hand

```bash
# 1. Hand-author: POST the raw project shape from examples/hand-authored.json.
curl -sX POST http://localhost:8080/api/project -d @examples/hand-authored.json

# 2. Seal + mirror to the public store so the ?cid= URL works anywhere.
curl -sX POST http://localhost:8080/api/project-share \
    -d '{"mirror":["https://beats.bitwrap.io"]}'
# → { "cid": "z…", "shortUrl": "...", "mirrors": [{"host":"…","status":200}] }
```

The archived `petri-note.git` repo's functionality lives here under `-authoring`.

## Build & Run

```bash
make build   # Build Go binary (embeds public/)
make run     # Build and serve embedded files on :8089
make dev     # Serve public/ from disk on :8089 — needed when iterating on JS/CSS
```

Requires Go 1.22+. No npm, no node_modules, no bundler. Embedded build is right for production; `make dev` is faster for iteration.

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
| `data/audio/` | Cached audio renders (`.webm`) served to the feed. Bucketed by `YYYY/MM/{cid}.webm`. Production runs without `-audio-render`, so deletion is **only** safe-to-delete when you have an off-host worker (`scripts/process-rebuild-queue.py`) ready to re-render — otherwise listeners get 404s for affected CIDs. |
| `data/index.db` | SQLite track index. Drives `/feed`, `/feed.rss`, `/api/feed`, and (when `-rebuild-queue` is on) the `rebuild_queue` table. Recreated on startup from `schema.sql` if missing. Safe to delete. |
| `data/.rebuild-secret` | 32-byte hex secret generated on first boot (mode 0600). Required by `X-Rebuild-Secret` on `PUT /audio/{cid}.webm` (bypasses first-write-wins), `GET /api/snapshot`, and `POST /api/archive-delete`. Treat as a credential — don't commit, don't paste in chat. |

### Purge the feed without nuking shares

Clears the gallery / RSS feed but keeps every `?cid=…` link working. Existing audio renders are dropped; the server re-renders on next visit:

```bash
ssh pflow.dev "~/services stop beats-bitwrap"
ssh pflow.dev "cd ~/Workspace/beats-bitwrap-io && rm -f data/index.db && rm -rf data/audio"
ssh pflow.dev "~/services start beats-bitwrap"
```

Verify empty: `curl -sS https://beats.bitwrap.io/api/feed` → `[]`.

To **also** purge every shared CID, follow the **belt-and-suspenders pattern** in the Archival section below — capture three independent backup copies first; auto-restore handles per-link recovery as users visit them. Don't bare-`rm -rf data/o` without that capture; deleting the share store is the only operation in this codebase that can produce permanently-unrecoverable state.

### Rebuild queue (off-host audio repair)

Listeners flag a feed card with broken/stuck audio via the ⟳ button — the server records the CID in `data/index.db.rebuild_queue`, and an off-host worker (`scripts/process-rebuild-queue.py`) picks it up, re-renders, uploads, and clears the row. Live in production (prod's `~/services` invokes the binary with `-rebuild-queue`); ⟳ is hidden when the flag is off.

Routes (all open: anyone can mark, read, clear — abuse cost bounded by worker render budget and `X-Rebuild-Secret` gating on actual writes):

- `POST /api/rebuild-mark {cid}` — adds to queue (rate-limited). Also publishes the CID to the SSE bus.
- `GET  /api/rebuild-queue?limit=N` — JSON array of pending CIDs.
- `POST /api/rebuild-clear {cid}` — removes a row (worker calls after upload).
- `GET  /api/rebuild-events` — **SSE push**, `X-Rebuild-Secret`-gated. Emits `event: rebuild\ndata: <cid>` per mark (+ heartbeat). Lets the worker react instantly instead of polling; `internal/rebuildbus` is the in-process pub/sub, best-effort over the durable queue. nginx must proxy it with `proxy_buffering off` (the handler also sets `X-Accel-Buffering: no`).
- `GET  /api/audio-suspect?limit=N&graceMins=M&includeUnknown=1` — CIDs whose latest `/audio/{cid}.webm` was uploaded by a browser (`audio_provenance='browser'`) and is older than the grace window. Drives the `--converge` worker mode. Public read-only; the worker re-renders + PUTs with `X-Rebuild-Secret` to overwrite. `includeUnknown=1` also returns pre-migration rows with `audio_provenance=''`.
- `GET  /api/features` — `{rebuildQueue, genreColors}`. Frontend feature-detects ⟳ visibility.

**Audio provenance.** Every `PUT /audio/{cid}.webm` is tagged on the `tracks` table's `audio_provenance` column: `'renderfarm'` when the request carries `X-Rebuild-Secret`, `'browser'` otherwise. Server-side chromedp renders also tag `'renderfarm'`. The `--converge` worker sweep finds `'browser'`-tagged rows and re-renders them so the feed eventually converges to render-farm canonical output (the browser's "Download audio" still captures live mixer state — that's intentional for personal exports, but the feed shouldn't reflect a user's tweaks). Pre-migration rows have `audio_provenance=''` and are skipped by default; pass `--converge-include-unknown` to backfill them too.

Worker (run on a MacBook with chromedp / Chrome):

```bash
ssh pflow.dev "cat ~/Workspace/beats-bitwrap-io/data/.rebuild-secret"
./beats-bitwrap-io -authoring -audio-render -audio-auto-enqueue=false \
    -audio-concurrent 2 -audio-max-duration 6m -audio-render-timeout 15m \
    -addr :18090 -data /tmp/beats-worker-data
BEATS_REBUILD_SECRET=$(...) ./scripts/process-rebuild-queue.py --subscribe   # SSE push (or --watch to poll)
```

`--subscribe` opens the SSE stream and renders on each pushed event (near-instant), gated by `X-Rebuild-Secret`; it drains on every (re)connect and keeps a slow full-drain backstop, so it degrades to ~polling if the stream drops. `--watch` is the plain 30s poll fallback. The off-host render farm is configured in `valoper-stackdump-com` (see its `RENDER-FARM.md`).

`--converge` sweeps `/api/audio-suspect` on its own cadence (`--converge-interval`, default 1800s / 30 min) and re-renders any browser-uploaded audio so the feed converges to canonical render-farm output. Composes with `--watch` (so a single worker process can drain the rebuild queue every 30 s AND run the converge sweep every 30 min). Requires `--secret` so PUTs carry `X-Rebuild-Secret` and overwrite the existing browser upload.

The worker sends `X-Rebuild-Secret` on every PUT `/audio/{cid}.webm`, bypassing rate-limit / faster-than-realtime / first-write-wins checks — that last one is what lets it replace stuck audio without SSH-deleting the bad file.

### Archival & restore

Production runs **without** `-audio-render` — the server stores client-uploaded renders but never spawns chromedp itself. Three archive surfaces live alongside, letting users (and the operator) recover purged tracks without coordination.

**Channel 1 — streaming snapshot (envelopes only, public):**
- `GET /api/snapshot` — `.tar.gz` of every envelope + JSON-LD `manifest.json`. Hundreds of KB even with thousands of shares. Audio + db variants gated by `X-Rebuild-Secret` (`?audio=1&db=1`).
- `GET /api/snapshot-manifest` — JSON-LD manifest standalone. Embedded inline on `/archive` so crawlers carry the catalogue.

**Channel 2 — persisted snapshots (operator-triggered, browsable):**
- `POST /api/snapshot-persist?label=<tag>` — gated. Writes `data/snapshots/beats-snapshot-{ts}-{label}.tgz` + sidecar `.json`. Use `label` to group experiments — `/archive` renders groups as headings. Optional `&audio=1&db=1`.
- `GET /api/snapshots` — public list (sidecar reads only).
- `GET /snapshots/{filename}` — public static download.
- `GET /archive.rss` — podcast-shaped RSS feed; `<enclosure>` carries the `.tgz`.
- `GET /api/snapshot-contents?file=<name>.tgz` — feed-card shape so `/feed?snapshot=X` renders the snapshot's tracks in the player UI.

**Channel 3 — per-CID lookup + restore (public, on-demand):**
- `GET /api/archive-lookup?cid=X` — which snapshots contain X + `live` flag.
- `POST /api/archive-restore?cid=X` — public, no auth (snapshots themselves are public). Walks newest-first, extracts `o/X.json`, re-seals via `Store.SealDirect` (re-verifies CID — tampered tarball can't poison the store).

When a `?cid=…` link 404s on the live store, the studio frontend silently checks if any persisted snapshot has the CID and restores before the user sees an error. Green "Restored from snapshot X" notice appears in the welcome card.

**Heavier tiers (`X-Rebuild-Secret`-gated):**
- `GET /api/snapshot?audio=1&db=1` — full tarball with cached `.webm` + sqlite.
- `POST /api/archive-delete {cid}` — cascade-removes a CID across all persistence layers. Idempotent.
- `POST /api/snapshot-persist?label=...&audio=1&db=1` — heavy tarball before risky migrations.
- `GET /api/archive-missing?limit=N` (no auth, read-only) — shares without an audio render. Drives the off-host worker's archive sweep.

#### Belt-and-suspenders pattern (recommended for destructive ops)

Hold the catalogue in **three independent locations** before any rm-rf-style purge. None depend on each other for integrity — every envelope's CID is re-verified on every read (`PUT /o/{cid}` recomputes the hash and rejects mismatches), so a tampered tarball can't poison anything that restores from it.

```bash
export S=$(ssh pflow.dev "cat ~/Workspace/beats-bitwrap-io/data/.rebuild-secret")

# 1. New persisted snapshot on the box (label what you're about to do).
curl -fsS -X POST -H "X-Rebuild-Secret: $S" \
     "https://beats.bitwrap.io/api/snapshot-persist?label=pre-<thing>"

# 2. Verify earlier snapshots still on the box.
ssh pflow.dev "ls -la ~/Workspace/beats-bitwrap-io/data/snapshots/"

# 3. Local copy off the box.
mkdir -p ~/beats-backups
scp pflow.dev:~/Workspace/beats-bitwrap-io/data/snapshots/beats-snapshot-*.tgz \
    ~/beats-backups/

# 4. Now purge. Stops only beats-bitwrap; preserves data/snapshots/ + .rebuild-secret.
ssh pflow.dev "~/services stop beats-bitwrap"
ssh pflow.dev "cd ~/Workspace/beats-bitwrap-io && rm -rf data/o data/audio data/index.db"
ssh pflow.dev "~/services start beats-bitwrap"

# 5. Verify empty + snapshots still listed.
curl -fsS https://beats.bitwrap.io/api/snapshot-manifest | jq '.envelopes.count'   # 0
curl -fsS https://beats.bitwrap.io/api/snapshots | jq '.count'                     # >= 2
```

Recovery is automatic: any `?cid=…` link triggers auto-restore from the newest matching snapshot. Bulk restore via `./scripts/process-rebuild-queue.py --restore ~/beats-backups/beats-snapshot-*.tgz`. Full purge + bulk-rebuild is rarely the right move now — the lazy path is cheaper, and listening to a track triggers an audio re-render via auto-render-on-share, so the feed self-heals.

Worker has additional flags for snapshot/restore/sweep — see `./scripts/process-rebuild-queue.py --help`.

#### Archive policy (user-visible)

The /help and /archive surfaces both state: **we may archive (purge from the live store) at any time and for any reason** — usually because we're rolling forward with changes that need older shares to be up-converted or re-rendered against newer software. Archived shares are not lost; they live in snapshot tarballs and auto-restore on visit.

## Conventions

- **No npm/bundler** — vanilla ES modules, Tone.js from CDN.
- **No framework** — single custom HTMLElement (`<petri-note>`).
- **Deterministic** — same genre + seed = same track (seeded PRNG via `mulberry32`).
- **Worker does all sequencing** — main thread only handles UI and audio output.
- **Class methods on `PetriNote` are thin wrappers** — edit the module, not `petri-note.js`, unless touching constructor / lifecycle / wiring.
- **No behavioral changes in extraction passes** — every refactor should produce byte-identical share payloads and identical DOM output. Round-trip a share through Playwright to verify.
- **Content addressing never changes retroactively** — modifying what `_buildSharePayload` returns means existing `?cid=…` links still point at the OLD bytes (which were hashed into those CIDs). Plan feature rollouts around that.

## Testing

- `go test ./...` — covers share store, rate limit, CID parity between JS and Go canonicalization. **Must be green before any commit.**
- Playwright via MCP — smoke-test changes that touch the DOM or share pipeline:
  ```
  make dev  # or: /tmp/beats-local -public public
  # Playwright: navigate, wait for _project + _currentGen.params.seed, exercise _buildShareUrlForms + the specific feature you changed.
  ```
- Manual: click Share → copy URL → open fresh tab → confirm genre/seed/tempo/tracks match.
- `make test-audio TEST_AUDIO_WORKERS=8` — headless macro→audio verification. Boots a local server, parallel Playwright tabs, captures Tone.Recorder output via `?test=1` (loads `public/lib/test-hooks.js`), Python (`scripts/test-macro-audio.py`) windows the PCM into pre/during/post slices and asserts the right metric (centroid for sweep-lp/sweep-hp/riser, RMS for cut/breakdown). Confirms macros both *take effect* AND *recover*. ~13 s for 5 macros at 8 workers.

## Bulk feed seeding

`scripts/seed-feed.py` is the parallel seeder. Local server runs `-authoring -audio-render -audio-concurrent N`, script runs `--workers N`. Generate+seal stages serialize on a lock; chromedp realtime renders run N-wide.

`-audio-render-mode realtime` is canonical (chromedp tab plays at 1× wall time, MediaRecorder captures Tone.js destination — exactly what the live studio plays). `-audio-render-mode offline` is experimental — see header comment in `public/lib/share/offline-render.js` for fidelity gaps. **Use realtime for production seeding.**

Quality knobs for feed seeding (the cached `.webm` is what listeners hear on feed cards, first-write-wins):
- **Default**: `macrosDisabled` covers disruptive groups (Mute: `drop`/`breakdown`/`solo-drums`/`cut`/`beat-repeat`/`double-drop`; Tempo: `half-time`/`tape-stop`/`tempo-anchor`) AND `autoDj.run=false`. Stable, predictable per CID.
- **Auto-DJ enabled** (`--no-auto-dj-off`): keeps disruptive macros disabled but lets Auto-DJ engage — only safe macros (FX/pitch/pan/shape) fire. Adds flavor without silences/pitch artifacts. Render no longer reproducible (envelope CID stays deterministic).
- **`--no-disable`**: skip macrosDisabled entirely. Only when intentionally seeding chaotic listening experiences.

A `--workers 4` realtime batch averages ≈ `(track length) / workers` per track; chromedp runs at 1× playback so a 3-min track ≈ 3 min wall time per worker.

## Roadmap — Remote Conductor (WS backend)

Front-end supports `data-backend="ws"` — `connectWebSocket(el)` opens `ws://<host>/ws` speaking the same JSON message types as the in-page worker. Authoritative dispatch in `internal/ws/hub.go`; handlers in `lib/backend/index.js::handleWsMessage`. Production does NOT run `/ws` (deployed without `-authoring`); run locally via `-authoring`.
