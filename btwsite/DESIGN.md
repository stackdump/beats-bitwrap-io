# btw.bitwrap.io — design and contracts

One page, one Go service, one Rust renderer, one wasm module. This file is the contract the parts are
built against in parallel; if you must deviate, change this file in the same commit and say so.

Readers: Matt in the morning, and the agents building the parts. Keep it true.

## What it is

`https://btw.bitwrap.io` — a **code-centric** web view of the btw language (docs/BTW.md in
`stackdump/djrust-vevr-se`, branch `feat/btw-language`): a full-height editor, eval/stop, firing
markers like the desktop's, fmt / share / open-by-CID, examples, a slim transport bar. Plus:

- `POST /api/compose` — Gemini Flash writes a program (signed-in, rate-limited, capped).
- `GET /api/render/<cid>?format=opus|wav` — streams the Rust offline render as it renders.
- `GET /api/render/<cid>.<packed>?format=opus|wav` — the same stream with the program in the URL (the share link's
  `<CID>.<packed>`), nothing stored first: it is opened and checked against the CID (a mismatch is 422 `cid_mismatch`),
  stored like an anonymous `PUT /api/programs/<cid>` (same per-address limit; restricted/asset programs refused), then
  rendered. Audio only, no page: `<audio src>`, `curl`, `mpv`, a phone or djapp can play it directly.
- `https://btw.bitwrap.io/mcp` — MCP (streamable HTTP) over the same things.
- `/llms.txt`, `/llms-full.txt`, `/docs/*`, `/examples/*.btw`.

## Repos, branches, worktrees (do not touch anything else)

| repo | branch | worktree | holds |
|---|---|---|---|
| `stackdump/djrust-vevr-se` (private) | `feat/btw-web` (off `origin/feat/btw-language`) | a checkout of the engine repo | Rust: `crates/btwapi`, `crates/btwd`, `crates/djweb` |
| `stackdump/beats-bitwrap-io` | `feat/btw-site` (off `feat/btw-link`) | a checkout of this repo | Go service, static site, tests, deploy files |

Off limits: the running djapp, the engine repo's other working branches, the
main checkouts, `beats.bitwrap.io`'s own server code (`main.go`, `internal/mcp`, ...: read, do not edit,
except the one exported wrapper noted under Auth). Never `git stash`; commit WIP instead. Commits are
GPG-signed on this Mac (just `git commit`). End commit messages with the attribution line the harness gave.

Licence / provenance rule (Matt): only public sources with reuse-friendly licences; **nothing from his
employer**. Programs shipped as examples or put in a prompt must be his own CC0 ones (public, no
`use restricted`, no `sample`/`loop` assets). Never send private or restricted assets to the model.

## Public repo (read this before committing)
`stackdump/beats-bitwrap-io` is **public (MIT)**; `stackdump/djrust-vevr-se` is **private and UNLICENSED**. So nothing built from or copied out of the private repo is committed here:
`btwsite/web/wasm/` (the wasm module and its JS glue), `btwsite/web/docs/BTW.md`, `btwsite/web/docs/cheatsheet.md`, `btwsite/bin/` (the `btwd` binary) and `btwsite/dist/` are in `.gitignore`.
They exist in the working tree (built or generated), tests that need them skip or use tiny fixtures when they are absent, and the deploy script copies them to the host. Never `git add -f` them.
Hand-written code, the CC0 example programs (Matt's own, public), card PNG samples of those programs, and fixtures are fine to commit.

## Directory ownership (beats-bitwrap-io worktree)

```
cmd/btwsite/main.go            G1   binary: flags + env, wiring
internal/btwsite/api/          lead shared types and interfaces (api.go) — already written; additive edits only
internal/btwsite/server/       G1   routes, static, programs store, sessions hub (SSE), render, config
internal/btwsite/auth/         G1   wallet sign-in, cookie sessions, bearer tokens
internal/btwsite/btwd/         G1   client for the btwd subprocess (+ a fake btwd for tests)
internal/btwsite/compose/      G2   Gemini client, fake model, prompt, repair loop, HTTP handler
internal/btwsite/limits/       G2   per-user / per-IP limiter, daily spend cap, kill switch, JSONL log
internal/btwsite/mcpsrv/       G3   MCP server (mark3labs/mcp-go, already in go.mod)
internal/btwsite/docs/         G3   llms.txt / llms-full.txt / docs generation + link test
internal/btwsite/card/         G4   share cards: PNG per CID (gg + gomono, as beats' share_card_png.go), /c/<cid> pages with OG/Twitter meta
btwsite/web/                   W1   the page: index.html, css/, js/ (editor, driver, stream player, ui)
btwsite/web/js/engine*.js, btwsite/web/wasm/   R2   in-browser engine glue and the built wasm
btwsite/examples/              G3   *.btw + index.json
btwsite/testdata/              each owner makes subdirs: testdata/{compose,render,mcp,corpus}
```
No new Go module dependencies (stdlib + what `go.mod` has). Port for tests: pick a random free port; the
deployed service listens on `:18097`.

## Rust side (R1, R2) — in the djrust-vevr-se worktree

### `crates/btwapi` (pure; no wasm-bindgen; builds native and wasm32)
Everything that turns text into the JSON the web and the CLI answer with, so **the wasm module and `btwd`
cannot disagree**. Wraps `djlive` with an `Env` that has the control registry and the engine's catalog as
static data (a snapshot generated from `djhost`'s registry/catalog by a test-checked generator, so the pure
crate does not depend on `djhost`). CIDs must equal what `djctl btw check` / the desktop give.

### JSON shapes (`btwapi` builds them; `btwd` prints them; the wasm returns them as strings)

`check(text) -> CheckReport`
```json
{
 "ok": true, "errors": 0, "warnings": 1,
 "diagnostics": [{"severity":"error|warning","line":3,"col":14,"end_col":15,"start":42,"end":43,
                  "message":"…","expected":["…"],"found":"…","help":"…","render":"error: …caret form…"}],
 "cid": "z4EBG9j…",                 // program CID of the canonical text; null when not ok
 "canonical": "tempo 140\n…",       // null when not ok
 "nets": {"A":"z4EB…","intro@0:A":"z…"},   // as the app's eval answers
 "song_nets": {"A":"z…","B":"z…"},          // longhand form; null when not computable
 "tempo": 140, "key": "fm", "swing": null,
 "arranged": true, "song_bars": 64, "ends": true, "loops": false,
 "sections": [{"name":"intro","start":0,"bars":8}],
 "decks": ["A","B"],
 "evolve": ["evolve in drop: …"], "lineage": [{"scope":"drop","gen":1,"cid":"…","forkedFrom":"…","start_bar":0,"bars":8}],
 "uses_assets": false,              // any `sample` / `loop` statement
 "restricted": false,               // `use restricted` or a restricted-private asset
 "seconds": 109.7                   // song_bars*4*60/tempo when known, else null
}
```
Byte offsets `start`/`end` are UTF-8 offsets into the text given; `line`/`col` are 1-based, `col` in chars.
(The wasm layer additionally gives `start16`/`end16` UTF-16 offsets so a JS string can be sliced.)

`fmt(text) -> {"ok":true,"canonical":"…","cid":"z…","comments":["…"],"diagnostics":[…]}`
`instruments() -> {"voices":[…],"families":[…],"kits":[…],"palettes":[…]}` (`djhost::btw_env::instruments_json()`)
`open(urlOrCidOrFragment) -> {"ok":true,"cid":"…","canonical":"…","verified":true,"warnings":[…],"notes_unverified":[…],"error":null}`
`share(text, sig?, notes?) -> {"ok":true,"url":"https://btw.bitwrap.io/#<CID>.<b64url(deflate)>","beats_url":"https://beats.bitwrap.io/p#…","cid":"…","chars":405,"canonical":"…","warnings":[…]}`
(the sealed part is identical to `djlive::share::encode`; only the origin differs.) **Social form:** for posts, the page/server also give `social_url` = `<origin>/c/<CID>.<packed>` (the fragment's sealed part moved into the path, **without** `~notes`), which link unfurlers can fetch; the fragment form stays the canonical self-sealing link.
`generation(text, scope?, n) -> {"ok":true,"cid":"…","scope":"drop","n":3}`

### `crates/btwd` (R1) — native CLI, the Go server's checker and renderer
No audio/midi features; must build on Linux x86_64 with no system libs. Program text on stdin (`-`) or `--file`.
Subcommands (stdout JSON unless noted; exit 0 whenever the tool ran, even for a program with errors; non-zero
only for usage/IO/panic):
- `btwd check` → CheckReport · `btwd fmt` → fmt JSON · `btwd instruments` · `btwd open <url|cid>` · `btwd share` · `btwd highlight` → `[[start,end,"class"],…]` (UTF-8 byte offsets, same classes as the wasm `btw_highlight`; the card renderer colours code with it)
- `btwd nets` → `{"cid":…,"decks":{"A":{"cid":…,"envelope":{…}}},"segments":[…]}` (for debugging/tests)
- `btwd cheatsheet` → markdown on stdout: the compact grammar **generated from `docs/BTW.md`** (`include_str!`),
  what the compose prompt and `/docs/cheatsheet.md` both serve.
- `btwd render [--sr 44100] [--format s16le|f32le] [--chunk-ms 250] [--max-bars 256] [--from-bar 0]` — **streams** raw
  interleaved stereo PCM to stdout as it renders (a write + flush per chunk; the first chunk after at most
  ~`chunk-ms` of audio), and **one JSON line on stderr first**: `{"event":"start","sample_rate":44100,"channels":2,
  "format":"s16le","seconds":109.7,"bars":64,"bpm":140}`; then `{"event":"progress","seconds_rendered":…}` lines at
  most 4/s; `{"event":"end","seconds":…}`; errors as `{"event":"error","message":"…"}` and exit 1. Refuses
  programs with `uses_assets`/`restricted` (error event). Control lines are not rendered (the desktop's offline
  render has the same limit: say so in `start.notes`).
- Reads/writes nothing on disk except what it is told. No network.
- Build recipe for pflow.dev (Ubuntu 24.04, glibc 2.39, x86_64): `scripts/build-btwd-linux.sh` in the djrust
  worktree, using docker on valoper (`ubuntu:24.04` or `debian:bookworm` + rustup) or musl; writes
  `dist/btwd-linux-x86_64` and its sha256. The binary is **not** committed anywhere.

### btwapi and btwd as built (R1) — what differs from, or adds to, the shapes above (all additive)
- **Checked against** a static snapshot of djhost's control registry and engine catalog (`crates/btwapi/data/snapshot.json`,
  generated by `cargo run -p btwapi --example gen_snapshot`; `cargo test -p btwapi --test snapshot` fails when it drifts).
  Same diagnostics and CIDs as the desktop (`BtwEnv::new(None)`), tested over the corpus, 11 extra programs and every verb of
  the registry, and against the real `djctl btw check|fmt|nets|share|instruments`. **No file is ever looked up** (`sample` / `loop`
  are read from the text; a restricted sample still needs `use restricted`). **`import` is an error on the web**: "`import` is not
  available on the web: there is no snippet store here" (help: paste the snippet's `let`/`def` lines).
- **CheckReport:** every diagnostic also has `start16`/`end16` (UTF-16 offsets; `found` is `""` and `help` `null` when there is none;
  `render` is the desktop's caret form). Extra field `end_bar` (the bar the program ends on, else null). `song_bars` is the
  timeline's length (a program with no sections: its `end at bar N`, else null); `seconds` is what actually plays at the tempo, to the
  millisecond (an `end` cuts a song short; one lap for a `loop`; null with no tempo or for a program that plays on). `sections`
  lists real `section` blocks only (an evolve's generations are one section; an evolve in a program with no sections lists none).
  `song_nets` is null when a part's instrument differs between sections (no longhand form). `uses_assets`/`restricted` are true for
  a program with errors too, when its text says so.
- **open** takes a link, a `#fragment`, `CID.packed`, the social form `<origin>/c/<CID>.<packed>` or a bare CID. Extra fields:
  `claimed_cid` (what the link says, verified or not), `has_text`, `sig` (carried, never checked). A forged link is `ok:false` with
  `error:"refused: the link says … but its text is …"`. A verified link whose program no longer checks is still `ok:true`, with a
  warning. `share` is `ok:false` (with `error` and `diagnostics`) for a program with errors or a private one (`restricted`); `chars` counts `url`.
- **btwd** flags: `share [--sig S] [--notes] [--origin URL]`, `generation -n N [--scope NAME]`, `nets [--brief]` (no envelopes),
  `open` takes the link as an argument or on stdin, `--file F`/`-`/stdin for the text, `selftest`, `--version`. Usage and I/O errors exit 2
  with `btwd: …` on stderr and nothing on stdout; everything else exits 0.
- **Highlight classes** (14): comment keyword role action deck number step rest generator param operator word string error.
- **Cheat sheet** (`btwd cheatsheet`, `btwapi::cheatsheet()`): about 15.6 KB, not the 7-12 KB aimed at: the sections the brief names are
  that long with the prose gone. The two EBNF blocks are merged into one grammar (later definitions replace earlier ones), the desktop
  booth's lines (`swap pairs`, `move`, `load`, `queue`, `crossfader`, `play`/`stop`/`sync`/`mute`) and `import` are left out, a short
  "On btw.bitwrap.io" note closes it. A test fails when BTW.md renames a heading or rewrites a paragraph the sheet takes.
- **Cost of a check:** a corpus program takes ~20 ms (release). It grows with generations x sections of any `evolve` (6 sections of
  256 generations: ~4 s in release, 6 s unoptimised), so the server's `btwd` timeout matters for hostile 16 KB programs.

### `crates/djweb` (R2) — the wasm module (wasm-bindgen, `--target web`)
`cdylib+rlib`, `crate-type`, thin wrappers over `btwapi` plus a re-export of `djrust::wasm::{Dj, DjComposer, …}`
(the public engine facade, feature `wasm`), so one `.wasm` is the language and the engine. Built by
`scripts/build-web-wasm.sh <outdir>` → `btw.js`, `btw_bg.wasm`, `btw.d.ts`, `hashes.json`; the beats worktree
commits the output in `btwsite/web/wasm/` (pflow.dev has no wasm toolchain; built here, committed, like windwheel's
`web/dist`).
JS surface (strings in, JSON strings out unless noted):
```
btw_check(text) / btw_fmt(text) / btw_instruments() / btw_open(s) / btw_share(text, sig, notes) / btw_generation(text, scope, n)
btw_highlight(text) -> JSON [[start16,end16,"class"],…]   classes (exactly these 14, text order, gaps are whitespace): comment keyword role action deck number step rest generator param operator word string error
                                       (keyword also covers let/def/section/arrange/evolve/…, action the evolve transforms, string a "quoted" text, param a `vel=` name or a `$x` of a def, error a character the language cannot read)
btw_cheatsheet() -> string
class BtwRun {                       // the Live runtime + a host that is a command queue
  constructor()
  eval(text) -> JSON                 // the app's eval answer (ok, diagnostics, cid, nets, changes, lands, lineage, kept…)
  stop() -> JSON commands            // puts back what lines held
  service(gridJson) -> JSON commands // gridJson: {"deck":"A","beat":12.5,"bpm":140,"playing":{"A":true,"B":false}} or null
  marks() -> JSON                    // Live::marks().to_json(): active_lines, header, fires, controls, generation… (spans: start,end,line,col,len; plus start16/end16)
  status() -> JSON                   // Live::status(): section, bar, ended, …
  running_cid() -> string|undefined
}
commands: [{"op":"load_net","deck":"A","envelope":{…}},{"op":"play","deck":"A","on":true},
           {"op":"sound","deck":"A","role":"bass","option":"synth:reese"},{"op":"call","noun":"inserts","params":{…}}]
```
Virtual mode (markers following a clock the page already has, e.g. a streamed render): the page calls
`service()` with the stream's beat and discards the commands, echoing `play` commands into its own `playing` flags.

### Engine in the browser (R2) — `btwsite/web/js/engine.js`, `engine-worklet.js`
```js
export async function createEngine({ context /*AudioContext*/, destination, wasmUrl })  -> engine
engine.ready                      // Promise
engine.apply(commands)            // the commands BtwRun.service()/stop() return, to the worklet's Dj (load_net lands on the next bar)
engine.grid()                     // {deck:"A",beat,bpm,playing:{A:true,B:false}} | null — what BtwRun.service() wants
engine.setLevel(0..1); engine.dispose()
```
The page owns the `BtwRun`, the clock loop and the markers; the engine owns the sound.

As built (R2; `btwsite/web/js/engine*.js`, tests `btwsite/test/wasm-parity.mjs` and `engine-browser.mjs`):
- `createEngine({context, destination, wasmUrl?, module?, composer?: 'worker'|'main'|'inline'})`. `module` is a compiled `WebAssembly.Module` the page already has (skips the fetch and compile).
  The worklet is `btw-engine` (`engine-worklet.js`, with `engine-polyfill.js` for the TextEncoder/TextDecoder the worklet scope lacks); nets are compiled in a module Worker (`engine-composer.js`, a second instance of the engine:
  `DjComposer.prepare_share`) and installed in the worklet 12 KB a render quantum (`Dj.begin_install` / `install_step`), so the audio thread never compiles. `composer:'main'` compiles on the page thread, `'inline'` on the audio thread (glitches).
- Also on the engine: `engine.on('installed'|'error'|'warn'|'ignored', fn)`, `engine.idle()` (resolves when nothing is loading), `engine.pending`, `engine.decks()` (both decks at the last report), `engine.stats`, `engine.info`, `engine.composer`.
- Order: commands for a deck run in order; a `play` waits for every load in the same `apply()` batch (the decks start together); a batch's installs start together once all are prepared (a section's decks land on the same bar line); a newer load for a deck drops an older one that has not begun to install.
- A deck that comes in or goes out while another plays does so on the next bar line of the deck that keeps the time (the runtime hands the next section's decks over a bar ahead: `Live::sync_nets` starts and pauses them at once, which on the desktop starts a deck a bar early); starting or stopping every deck at once (the first start, the end of the program) is immediate.
- `grid()` is advanced against the audio clock (shifted back by the output latency) and never runs past the next bar line by itself: the runtime counts a bar only when the worklet has reported it, so a section swap (the beat going back to the top) is not counted twice. The beat is `BeatState::of_net` (the transport's tick counts the step being played from 1: beat = (tick - 1 + phase) / 4), as the desktop's grid.
- Which registry calls the engine honours and which it ignores (with one console note each) is the table at the top of `js/engine-calls.js`. In short: mixer (strip knobs, crossfader, master), deck play/stop, inserts filter/reverb/crush mapped onto the strip and master FX unit; everything else (delay, moves, loops, queue, auto-DJ, ...) is ignored.
- `btw_share(text, sig, notes, origin?)` takes the site origin as an optional fourth argument; `btw_generation(text, scope|null, n)`; `BtwRun` also has `check(text)` (eval's answer without staging).
- Output buffer: the page's AudioContext asks for `latencyHint: 0.1` (was `'interactive'`). A quantum renders in ~0.3 ms, but the quantum in which a section's track lands (`install_step`'s last step) takes 20-26 ms on the audio thread, more than an interactive (~10 ms) or `'playback'` (~23 ms) buffer holds: every section change was a heard drop-out. `?latency=interactive|balanced|playback|<seconds>` overrides it. The landing step itself is the engine's (djrust) to split.
- Measuring: `test/audio-perf.mjs` plays a program on the real page and engine in headless Chrome and reads every `process()` call from a Chrome trace (wall and thread CPU time), `AudioContext.playbackStats` underruns, main-thread long tasks and, with `?perf=1` (`createEngine({perf})`, test only), the worklet's own report of its slow blocks and what they did. `test/engine-bench.mjs` times the same calls (render, tick, state, install_step, the landing step, prepare, BtwRun.service/marks/status) in Node.
- The wasm is built by `scripts/build-web-wasm.sh <dir>` (Rust worktree) into `btwsite/web/wasm/` and is **not committed** (see "Public repo").

## Package entry points (what G1's main wires; keep these names and shapes)
```go
// internal/btwsite/btwd (G1): the Rust subprocess as an api.Checker
func btwd.New(bin string, opts btwd.Options) (*btwd.Client, error)   // implements api.Checker; Options{Timeout, MaxConcurrent}
// internal/btwsite/auth (G1)
func auth.New(opts auth.Options) (*auth.Service, error)              // implements api.Authenticator; Options{DataDir, Secret []byte, Secure bool, Origin string}
func (s *auth.Service) Mount(mux *http.ServeMux)                      // /api/auth/*
// internal/btwsite/compose (G2)
func compose.New(o compose.Options) (*compose.Service, error)        // implements api.Composer
type compose.Options struct {
    Checker api.Checker; Store api.ProgramStore
    Examples func() []api.Example; ExampleText func(name string) (string, bool)   // public CC0 examples for prompts + base_cid lookups
    DataDir string; PublicURL string
    Model string; APIKey string; Endpoint string                     // Endpoint "" = Google; tests point at httptest
    FakeModel compose.Model                                           // non-nil (or Model=="fake") = the recorded-fixture model
    Limits limits.Config; MaxPromptChars, MaxProgramBytes, MaxRepair int
    MaxOutputTokens int; Thinking string                              // added by G2: 16384 / "LOW" (MINIMAL|LOW|MEDIUM|HIGH); thinking tokens count against maxOutputTokens
    Now func() time.Time                                              // tests
    Logger *log.Logger                                                // optional; nil = the standard logger
}
func (s *compose.Service) Handler(a api.Authenticator) http.Handler   // POST /api/compose (401 without a user; never anonymous)
func (s *compose.Service) AdminHandler(adminToken string) http.Handler // POST /api/admin/compose {enabled}, GET /api/admin/stats: mount it at "/api/admin/" (it routes by full path; no token configured = 503, wrong token = 401)
func (s *compose.Service) Close() error                                // closes the log file
// internal/btwsite/limits (G2)
type limits.Config struct{ UserHour, UserDay, IPDay int; DailySpendUSD, PriceInPerM, PriceOutPerM float64; DataDir string }
// internal/btwsite/mcpsrv (G3)
func mcpsrv.Handler(b api.Backend, a api.Authenticator, publicURL string) http.Handler   // mounted at /mcp and /mcp/
// internal/btwsite/docs (G3)
func docs.Mount(mux *http.ServeMux, o docs.Options) error             // /llms.txt /llms-full.txt /docs/* ; Options{DocsDir, Checker, Examples, ExampleText, PublicURL}
func docs.LoadExamples(dir string, c api.Checker) ([]api.Example, error)  // reads btwsite/examples/{*.btw,index.json}, fills CIDs via c
// internal/btwsite/card (G4)
func card.New(o card.Options) (*card.Service, error)                   // Options{Checker, Store api.ProgramStore, Examples..., PublicURL, CacheDir, WebDir}
func (s *card.Service) Mount(mux *http.ServeMux)                       // /c/ and /card/
func (s *card.Service) Render(text string, v card.Variant) ([]byte, error)  // pure, deterministic; used by tests and docs
// internal/btwsite/server (G1)
func server.New(cfg server.Config) (*server.Server, error)            // builds everything above; Handler() http.Handler; implements api.Backend
```
G1 wires G2/G3/G4 last, once their commits exist (`git log --oneline -- internal/btwsite/compose` etc.); until then stub with the interface.

## Go server (G1, G2, G3, G4) — `internal/btwsite/…`

Shared types, interfaces and the typed `*api.Error` are in `internal/btwsite/api/api.go`. All JSON errors are
`{"error":{"code":"…","message":"…","retry_after":30}}` with the HTTP status in `api.Error.Status`.

### Config (flags, each also an env var `BTW_<UPPER>`; env wins only where no flag is given)
`-addr :18097`, `-web btwsite/web`, `-examples btwsite/examples`, `-data ./data`, `-btwd /path/btwd`,
`-public-url https://btw.bitwrap.io`, `-model gemini-3.8-flash` (BTW_MODEL; `fake` selects the recorded fixture
model), `GEMINI_API_KEY` (env only, never a flag, never logged, never sent to a client), `-compose-user-hour 10`,
`-compose-user-day 50`, `-compose-ip-day 40`, `-daily-spend-usd 2.00`, `-price-in-per-m 1.50 -price-out-per-m 7.50`
(Google's 2027 list prices for `gemini-3.8-flash`: $1.50 / $7.50 per 1M tokens; $0.75 / $3.75 until 2026-12-31),
`-max-prompt-chars 800`, `-max-program-bytes 16384`, `-max-repair 3`, `-max-output-tokens 16384` (per model call, thinking included), `BTW_THINKING=LOW` (`MINIMAL|LOW|MEDIUM|HIGH`, passed as `thinkingLevel`), `-render-ip-hour 30`, `-render-concurrency 2`,
`-render-max-bars 256`, `-render-max-seconds 600`, `BTW_ADMIN_TOKEN`, `BTW_COMPOSE_ENABLED=0|1`, `BTW_SESSION_SECRET` (else generated into `-data`).
Compose is **"not configured"** (503 `not_configured`) when there is no key and the model is not `fake`.

### HTTP API
| route | auth | notes |
|---|---|---|
| `GET /` `/js/* /css/* /wasm/*` … | – | static from `-web` (`Cache-Control: no-cache` + ETag); `/p` → redirect to `/` keeping the fragment is done in JS |
| `GET /healthz` `GET /api/info` | – | info: name, version, model, compose `{enabled,configured,limits}`, render limits, auth kinds |
| `GET /api/examples` `GET /examples/<name>.btw` | – | list `[{name,title,description,cid,bpm,bars,license}]`, raw text |
| `GET /api/instruments` | – | btwd instruments JSON |
| `POST /api/check` `/api/fmt` `/api/share` `/api/open` | – | body `{"text":…}` (or `{"url":…}` for open); rate-limited per IP |
| `POST /api/qr` | – | body `{"text":<link>}`; only this site's `<public_url>/p#<CID>.<packed>` and `<public_url>/p/<CID>`, ≤ 2000 chars, else 400; per-IP limit shared with check. Reply `{qr: "data:image/svg+xml;base64,…", url, modules}`. The Share panel's QR, drawn by the pairing QR's encoder (skip2/go-qrcode, level L) |
| `GET /.well-known/assetlinks.json` | – | Android App Links verification: the file named by `-assetlinks-file` / `BTW_ASSETLINKS_FILE`, as `application/json`; 404 when unset. See `deploy/ASSETLINKS.md` |
| `PUT /api/programs/<cid>` | – | body = program text; accepted iff its canonical CID is `<cid>`, it checks ok, is not restricted/asset-using, ≤ max bytes; stored content-addressed; per-IP limited. `GET /api/programs/<cid>` → `{cid,text,meta}`; `GET /api/programs/<cid>.btw` → text with `#!` header |
| `PUT /api/shares/<cid>` | **cookie, bearer or `BtwDevice`** | the CID-only share link's write side: JSON `{text, license?, forked_from?, credits?, name?, visibility?}`; same store as `PUT /api/programs`, with rights, signed in, public programs only. See Short links |
| `GET /p/<cid>` | – | the short link's page: the card of the stored program; a person is sent to `/#<cid>`, which fetches and checks it. See Short links |
| `GET /api/render/<cid>?format=opus\|wav&sr=44100` | – | chunked stream, see Render; `GET …/status` |
| `GET /api/render/<cid>.<packed>?format=opus\|wav` | – | the same, the program carried in the URL (verified, then stored) |
| `POST /api/session` / `GET /api/session/<id>/events` (SSE) / `POST /api/session/<id>/report` / `POST …/reply` | cookie optional | the browser ↔ MCP bridge, see Sessions |
| `GET /api/auth/challenge` `POST /api/auth/login` `POST /api/auth/logout` `GET /api/auth/me` `POST /api/auth/token` `DELETE /api/auth/token` | – / cookie | see Auth |
| `POST /api/compose` | **cookie or bearer** | see Compose |
| `POST /mcp` (+`GET` landing, SSE) | tools: write tools need bearer | see MCP |
| `POST /api/admin/compose` `GET /api/admin/stats` | `Authorization: Bearer $BTW_ADMIN_TOKEN` | kill switch `{"enabled":false}`; counters |
| `GET /c/<cid>` · `/c/<cid>.<packed>` · `GET /card/<cid>.png` · `/card/<cid>.square.png` · `/card/default.png` | – | share cards, see Cards |
| `GET /llms.txt` `/llms-full.txt` `/docs/BTW.md` `/docs/cheatsheet.md` `/docs/api.md` | – | generated/served by G3's package; every link in `llms.txt` must return 200 (test) |

### Short links (CID-only) — `PUT /api/shares/<cid>`, `GET /p/<cid>`, `GET /api/programs/<cid>`
The self-sealing link (`/#<CID>.<packed>`, beats `/p#<CID>.<packed>`) is unchanged: the program is in the link. The CID-only forms keep the program on the site instead:
`https://btw.bitwrap.io/p/<CID>`, `https://beats.bitwrap.io/p/<CID>` (and `…/c/<CID>`, the link-preview page, which already existed). There is **one store**, `-data/programs/<cid>.json` (the one `PUT /api/programs` fills); nothing is duplicated.
- **Write**: `PUT /api/shares/<cid>`, JSON `{"text", "license"?, "forked_from"?, "credits"?, "name"?, "visibility"?}`, unknown fields refused. Credentials: a cookie or `btw_` bearer token (the account), or a paired phone's `Authorization: BtwDevice <device>.<ts>.<sig>` (the body's hash is signed; it acts as the pairing owner). No credential is `401`, and `PUT /api/programs/<cid>` stays anonymous and per-IP (what the page's stream uses, no rights: CC0, no credits).
  Limits: `-share-hour` (60) per account, and the address is held to `-put-ip-hour` too; `429` with `Retry-After`. Only **public** programs are stored: `#! visibility:` anything but public, `use restricted`, `sample`/`loop` assets and `"visibility":"private"` are `422 restricted` and stay inline-only. The text must check and hash to `<cid>` (`422 cid_mismatch`).
  First write wins (the store never overwrites): a second share of the same program answers `200 created:false` with the rights already in effect. Rights: `license` (SPDX-style id, default `CC0-1.0`), `forked_from` (a CID), `credits` (≤ 8 lines of ≤ 80 characters), `name`; all in `meta`, none in the CID.
  Answer `201`/`200`: `{cid, created, meta, warnings, short_url, short_social_url, short_beats_url, fetch_url}`.
- **Read** (public, CORS `*`, immutable): `GET /api/programs/<cid>` → `{cid, text, meta}`; `.btw` for the file with its `#!` header. The store re-hashes the text on every read: a file that does not hash to its CID is a `404`, not a program. This is the fetch-by-CID a phone or djapp calls.
- **Open**: `/p/<cid>` serves the card page (`og:` tags for the stored program, `og:url` = the short link) and sends a person to `/#<cid>`; the page fetches `GET /api/programs/<cid>`, recompiles the text, recomputes the CID and refuses a mismatch (`Refused: …`), then shows it. `/p/<cid>.<packed>` is not a link (404). On beats.bitwrap.io `/p/<cid>` serves `p.html`, which fetches from btw.bitwrap.io (CORS) and verifies the same way in the browser; there is no second store.
- **MCP**: `share` returns both forms when called with a token (it stores the program, idempotently, counted per account by `WithSharePerHour`, 60/h, plus a per-address ceiling) and only the self-sealing links, `short_url: null` and a note, when anonymous; `open` takes either form (`/p/<CID>`, `/c/<CID>`, `#<CID>` or a bare CID resolve from the store: recompiled by the checker, CID recomputed, `cid_mismatch` refused, `not_found` when nothing is stored, rights in `meta`), and `load` takes a short link as `url`.

### Auth (G1) — reuse beats' wallet identity, invent no new scheme
beats.bitwrap.io already has the identity: an **eth wallet** (EIP-191 `personal_sign`, address = identity,
the same secp256k1 `did:pkh:eip155:1:<addr>` the vevr-wallet core uses) or a **browser-local Ed25519 key**
(`public/lib/share/sign.js`, `pn-ed25519-keypair-v1`), both verified server-side by
`internal/share/sigverify.go`'s `verifySignature`. btw sign-in is a challenge–response on that:
1. `GET /api/auth/challenge` → `{"nonce":"…","message":"btw.bitwrap.io sign-in\nnonce: …\nissued: …\nexpires: …","expires":"…"}` (nonce single-use, 5 min, kept in memory).
2. The page signs `message` (UTF-8 bytes; eth: `personal_sign(message)`; ed25519: raw signature) and `POST /api/auth/login`
   `{"type":"eth|ed25519","address":"0x…|<64 hex>","signature":"0x…|<128 hex>","nonce":"…"}`.
3. Server verifies (add the one exported wrapper `share.VerifyPersonal(msg []byte, typ, address, sigHex string) error` over `verifySignature`
   in `internal/share/sigverify.go`; nothing else in `internal/share` changes) and sets cookie `btw_session`
   (HMAC-SHA256 over `{uid,exp}`, `HttpOnly; Secure; SameSite=Lax; Path=/`, 7 days). `uid` = `eip155:0xabc…` (lower-case) or `ed25519:<hex>`.
4. `GET /api/auth/me` → `{"user":{"id":…,"kind":"eth|ed25519","address":…}}` or `{"user":null}`.
5. **Bearer tokens for MCP / scripts:** `POST /api/auth/token` (cookie required) → `{"token":"btw_<43 base64url>"}` once; only its
   SHA-256 is stored (`-data/tokens.json`), max 5 per user; `DELETE` revokes all. `Authorization: Bearer btw_…` is accepted wherever the cookie is.
Anonymous: read, play, open, check, fmt, share, render (limited). Signed in: compose, MCP write tools, driving sessions.

### Compose (G2)
`POST /api/compose` `{"prompt":"…","genre":"…","bpm":128,"key":"am","length":"short|medium|long|<bars>","base_cid":"z…"}` (only `prompt` required).
Response 200:
```json
{"program":"<canonical text>","text":"<text as the model wrote it, repaired>","cid":"z…",
 "check":{…CheckReport…},"attempts":[{"n":1,"ok":false,"errors":2,"diagnostics":[…],"tokens_in":…,"tokens_out":…}, …],
 "model":"gemini-3.8-flash","forkedFrom":"z…|null","license":"CC0-1.0","composedBy":"gemini-3.8-flash",
 "header":["#! license: CC0-1.0","#! composed-by: gemini-3.8-flash","#! forked-from: z…"],
 "render_url":"/api/render/<cid>?format=opus","share_url":"https://btw.bitwrap.io/#…","cost_usd":0.0007,"usage":{"in":…,"out":…}}
```
Pipeline: validate → limits (kill switch, user/hour, user/day, ip/day, global spend) → system prompt = `btwd cheatsheet` + `btwd instruments`
+ 2–3 public CC0 example programs (never restricted, never private) → model → `check` → on errors send the diagnostics (`render` form) back, up to
`-max-repair` (3) repair rounds → success or `422 unrepairable` with the last diagnostics and every attempt. With `base_cid`: the base program (public,
unrestricted, from the programs store or examples) is given to the model as the program to edit; the result records `forkedFrom`.
Output is stored via the programs store with meta `{license:"CC0-1.0", composedBy:"gemini-<model>", forkedFrom, prompt_sha256, created}`.
The `#! composed-by:` etc. header lives in the **stored object / `.btw` download**, never in the canonical text (comments are not in the CID);
if the model's own text already has that comment line, keep it as is. Errors: `auth_required 401`, `rate_limited 429 (+Retry-After)`,
`spend_cap 503`, `disabled 503`, `not_configured 503`, `bad_request 400`, `prompt_too_long 413`, `model_error 502`, `unrepairable 422`.
Every attempt is logged (JSONL under `-data/log/compose-YYYYMMDD.jsonl`: ts, user, ip_hash, prompt_chars, model, tokens, cost, attempts, outcome — **never the key, never the prompt text beyond a hash + first 80 chars**).
**As built (G2).** Order inside `Compose`: auth (the handler answers 401 `auth_required` before anything else, for every method and body; the service refuses a nil user too) → validate (400/413; strict JSON; `length` may be a number) →
`base_cid` lookup (400 for unknown, private, non-CC0, restricted or asset-using: one message for all, so it says nothing about what exists) → kill switch (503 `disabled`; `BTW_COMPOSE_ENABLED=0`, the file `<data>/compose.off`, or the admin endpoint; the file is read on every request and survives restarts) →
not configured (503 `not_configured`; `Status().Reason` says to set `GEMINI_API_KEY` and restart, or `BTW_MODEL=fake`) → per-user hour, per-user day, per-IP day (sliding windows, 429 + `Retry-After`; a refused request spends no quota) → spend cap
(503 `spend_cap` + `Retry-After` to UTC midnight). Before **each** model call a worst-case cost (input estimate + the full `maxOutputTokens`, since thinking counts as output) is *held* against the day's cap and replaced by the real cost
(`promptTokenCount` in, `candidatesTokenCount + thoughtsTokenCount` out) after the call, so concurrent requests cannot overshoot by more than the calls in flight. The day's spend is persisted (`<data>/spend/YYYY-MM-DD.json`, atomic writes) and a new UTC day starts at zero.
A reply the model cut off (`finishReason: MAX_TOKENS`: thinking can eat the whole budget), an empty reply, one over `-max-program-bytes`, or one that uses `use restricted` / `sample` / `loop` assets is a **failed attempt**: the model is told why and asked for a shorter / clean program, like a checker error.
A refused prompt (`promptFeedback.blockReason`, `finishReason: SAFETY`...), an HTTP error from Google or no answer is a 502 `model_error` with a fixed message (Google's own words go to the log only, with the key redacted; an upstream 429 also sets `Retry-After`). `forkedFrom` is `null` in the HTTP answer when there is no parent.
The `422 unrepairable` body carries `details: {diagnostics (the last), attempts (all), last_text, cost_usd}`; other errors raised after a model call carry `details.attempts` too.
The log line (`-data/log/compose-YYYYMMDD.jsonl`) has `ts, user, ip_hash, prompt_chars, prompt_sha256, prompt_head (80 chars), model, tokens_in, tokens_out, cost_usd, attempts, outcome (ok or the error code), cid, forked_from, detail, ms`;
`ip_hash` is a salted SHA-256 of the address (the /64 for IPv6), the salt kept in `<data>/ip-salt`.
Recorded fixtures for `BTW_MODEL=fake` live in `btwsite/testdata/compose/*.json` and are embedded (a test keeps `internal/btwsite/compose/fixtures/` identical); pick a scenario by putting `fake-repair`, `fake-unrepairable`, `fake-error`, `fake-blocked`, `fake-max-tokens` or `fake-oversize` in the prompt (default: a good program on the first try).
`internal/btwsite/compose/live_test.go` (`-tags live`, `GEMINI_API_KEY` + `BTWD_BIN`) runs the three real prompts and writes `btwsite/testdata/compose/real-<UTC date>.json`.
Behind nginx, a compose with repairs can take a minute: give `/api/compose` a `proxy_read_timeout` of 180 s.
The Gemini call: `POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`, header `x-goog-api-key`,
body `systemInstruction`, `contents`, `generationConfig{maxOutputTokens, thinkingConfig{thinkingLevel:"LOW"}}` (temperature/topP/topK are ignored on 3.6+), response
`candidates[0].content.parts[].text` (skip `thought:true`), `usageMetadata{promptTokenCount,candidatesTokenCount,thoughtsTokenCount}`. The model is a config value.

### Render (G1 + R1)
`GET /api/render/<cid>?format=opus|wav` → program from the store → `btwd render` → chunked response **from the first chunk**.
`wav`: streaming WAV header (RIFF/data sizes `0xFFFFFFFF`), 16-bit stereo PCM, then PCM chunks, flushed per chunk.
`opus`: PCM piped through `ffmpeg -f s16le -ar 44100 -ac 2 -i - -c:a libopus -b:a 96k -f ogg -` (Ogg Opus, flushed per page; ffmpeg 6.1 with libopus is on pflow.dev).
Response headers: `X-Btw-Cid`, `X-Btw-Seconds`, `X-Btw-Cache: hit|miss|joined`, `Cache-Control: public, max-age=31536000, immutable` once complete.
Cache by `(cid, format, sr)` under `-data/render/`: a complete file is served with `http.ServeContent` (Range works); a render in progress is
shared (singleflight): late joiners read the growing file from byte 0 and follow it. Limits: per-IP uncached renders/hour, `-render-concurrency`
simultaneous `btwd` processes (others get 429 + Retry-After), max bars, disk cap with LRU eviction of the render dir.
Target: first byte < 1 s for an example (measured and recorded in the report).

### Sessions (G1) — how MCP drives a browser
Page: `POST /api/session` → `{"id":"<22 chars>","user":…}` then `GET /api/session/<id>/events` (SSE; `event: eval|load|stop|get|queue|ping`, `data: JSON`). The page
sends `POST /api/session/<id>/report` every ~500 ms while it matters (`{"text","cid","playing","source":"engine|stream","section","bar","bars_in_section","phase","marks":{…},"diagnostics":[…],"ts"}`)
and `POST …/reply` `{"request_id","state"}` for a `get` event. Server keeps the latest report per session (in memory, 10 min TTL).
An MCP write tool targets `session` (explicit) or else every live session owned by the caller; a session is owned by the user that created it with a cookie/bearer,
or is anonymous (then only the explicit id, which the page shows in its MCP panel as a capability, works — and the caller must still be authenticated).

### The server as built (G1) — `internal/btwsite/{server,auth,btwd}`, `cmd/btwsite`
Run it: `make btwsite-build` → `btwsite/bin/btwsite`; `make btwsite-test` (vet + `go test -race`; `BTWD_BIN=<btwd>` adds the real-binary tests); `make btwsite-run` (fake model unless `BTW_MODEL`/`GEMINI_API_KEY` say otherwise).
- **Client address — one rule everywhere.** `api.ClientIP(r)` (also `server.ClientIP`): if `RemoteAddr` is a loopback address (nginx on the same host) the address is `X-Real-IP` (nginx: `proxy_set_header X-Real-IP $remote_addr`), else the **last** `X-Forwarded-For` entry,
  else `RemoteAddr`; from any other peer those headers are ignored, so a direct client cannot spoof. IPv6 limiter buckets are the /64 (`api.IPKey`). The server wraps the whole handler in `api.ResolveClientIP`, which rewrites `r.RemoteAddr` to `<ip>:0` and drops the two headers, so
  compose, MCP (`mcpsrv.WithClientIP(api.ClientIP)`), cards, limits and the access log all see the client, never the proxy. **nginx must set `X-Real-IP`**; without it everyone is 127.0.0.1.
- **Config**: flags, each also `BTW_<NAME>` (dashes → `_`; a flag given on the command line beats the environment). Added to the list above: `-docs btwsite/web/docs`, `-ffmpeg ffmpeg`, `-thinking` (BTW_THINKING), `-compose-enabled` (BTW_COMPOSE_ENABLED=0|1: the kill switch's *initial* position;
  the data dir's `compose.off` and `POST /api/admin/compose` move it at run time), `-render-cache-mb 512`, `-put-ip-hour 60`, `-check-ip-min 120`, `-store-max-mb 256`. Env only (never flags): `GEMINI_API_KEY`, `BTW_ADMIN_TOKEN`, `BTW_SESSION_SECRET`.
  The cookie is `Secure` exactly when `-public-url` is https. The subprocess gets a minimal environment (never the server's, which holds the key).
- **Auth**: as specified. Added: login/challenge/token have per-IP limits; a nonce is burned by any login attempt (good or bad); expired/forged cookie → `/api/auth/me` says `{"user":null}` and clears it, but `UserFrom` returns a 401 `*api.Error` for it (compose etc. answer 401);
  a bearer token cannot mint tokens (cookie required); **minting a 6th token drops the user's oldest** (max 5 stays true; `DELETE` revokes all of that user's); `tokens.json` holds SHA-256 hashes only (0600); the cookie secret is `BTW_SESSION_SECRET` or `-data/session.secret` (0600, generated).
  The challenge's first line names the host of `-public-url` (`btw.bitwrap.io sign-in`).
- **Compose door**: `POST /api/compose` is mounted only behind `composeGate` (a signed-in user, else 401 before anything about the service is said) and `mountCompose` refuses to mount without an Authenticator; `/api/admin/` is mounted always and is closed (503) while `BTW_ADMIN_TOKEN` is empty.
- **Programs**: `PUT /api/programs/<cid>` takes the program text (`Content-Type` must not be JSON; ≤ `-max-program-bytes`), `201` new / `200` already there (first meta wins; stored object `-data/programs/<cid>.json`, written with `link(2)` so a race stores once). Errors: `413 too_large`, `422 bad_request` (diagnostics in `details`),
  `422 restricted`, `422 cid_mismatch`, `507 store_full` (`-store-max-mb`), `429`. A `#! name:` header line of the submitted text becomes `meta.name` (other header claims are ignored). `GET /api/programs/<cid>` and `.btw` also answer for the **public examples** (`meta.source:"example"`), so they render and have cards;
  `.btw` = `#! name|license|composed-by|forked-from|cid` lines + canonical text, `Cache-Control: immutable`, `ETag`. An example that does not check, or is restricted/asset-using, is left out of the list with a start-up warning (it does not stop the server).
- **Static**: `/` and `/p` are `index.html` (with the generic share-card meta injected by `card.InjectGeneric`); `no-cache` + a content-hash `ETag`; dotfiles and anything outside `-web` are 404. **Headers on every response**: `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, HSTS (https only) and a CSP
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: data:; connect-src 'self' blob: data:; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`
  (no inline script: the card pages use `/card/go.js`; a handler may set its own CSP). **CORS** (`*`, no credentials, `GET/HEAD/OPTIONS` only) on `/healthz /api/info /api/examples /api/instruments /llms*.txt /examples/* /docs/* /card/* /api/programs/* /api/render/*` and nothing else.
- **Render (as built)**: `format` defaults to `opus` when ffmpeg has libopus, else `wav`; `sr` ∈ {44100, 48000}. Opus pipeline: `ffmpeg -f s16le -ar <sr> -ac 2 -i - -c:a libopus -b:a 96k -application audio -page_duration 200000 -flush_packets 1 -f ogg -` (the last two so pages leave ffmpeg every 200 ms).
  Cache files `-data/render/<cid>.<sr>.<renderVersion>.<wav|opus>` (+ `.meta` seconds/bars; `renderVersion` in render.go is bumped when btwd starts making different audio for a CID, and other versions are removed at start); the cached WAV has its real RIFF/data sizes patched in (the streamed copy has `0xFFFFFFFF`). The child is killed when its **last** follower goes (a joiner keeps it alive); a render that fails mid-stream **aborts the connection**
  (the client sees a broken stream, never a short "success") and is not cached. Streams send `X-Accel-Buffering: no` and `Cache-Control: no-cache` (a complete copy is `public, immutable` with an `ETag`). Limits as specified; a joiner and a cache hit are not charged to the per-IP hour and take no slot.
  `HEAD` never starts a render (`X-Btw-Cache: hit|joined|miss`). `GET /api/render/<cid>/status` → `{cid, bars, seconds, formats:{opus|wav:{state:none|rendering|ready, bytes, seconds, seconds_rendered, url, available}}}`. Unknown CID 404; restricted/asset 422; over `-render-max-bars` 422 `too_large`.
- **Sessions (as built)**: `POST /api/session` → `{id, user}`. The page-side routes (events, report, reply) are addressed by the id alone (it is the capability), but a *signed-in other user* than the owner gets 404. Up to 4 streams per session (a reconnect retires the oldest), SSE ping every 20 s,
  reports ≤ 256 KiB and ≤ 10/s (burst 20), the server stamps `ts`, **an anonymous session is claimed by the first signed-in user whose cookie reports to (or streams from) it** (the page makes its session before sign-in and keeps the id, so "all my sessions" must find it), a session without a stream or report for 10 min is dropped, ≤ 20 per user (the least recently seen is retired), 120 creations/hour/IP. `State` returns a report younger than 1.5 s, else asks the page (`get`, 3 s) and falls back to the last report
  (its `ts` says how old it is), else 409 `no_session`. `Push` counts only sessions with a live stream. `SessionState.bars_in_section` was added (additive).
- **Logs**: `-data/log/access-YYYYMMDD.jsonl`, one line per request `{time,method,path,status,ms,bytes,ip,user}`: `ip` is an HMAC of the client address, `path` has no query and session ids are `:id`, no cookie/token/key/body ever; files older than 30 days are removed.
- **Tests without Rust**: `internal/btwsite/btwd/fakebtwd` is a fake `btwd` (check/fmt/open/share/highlight/instruments/cheatsheet/render over `fakecheck`, with `BTW_FAKE_*` knobs for delays, failures and a pid file); tests build `cmd/fakebtwd` once and run the real client over it.

### Security review SEC-1 (identity and authorization) — what it changed, what it left
Changes (each has a regression test, `sec1_test.go` in the package):
- **Cross-origin auth requests are refused (403 `cross_site`).** `POST /api/auth/login`, `POST /api/auth/logout`, `POST` and `DELETE /api/auth/token` look at `Origin` (must be this site's host: the request's `Host` or the `-public-url` host; `null` and any other origin fail) and, without one, `Sec-Fetch-Site` (`cross-site` and `same-site` fail). Before this a page on any origin could post a text/plain "form" with its own sign-in and the visitor's browser got the author's cookie; the visitor's open anonymous session was then claimed by the author at its next report (`claimLocked`), who read and drove it over MCP. A client with neither header (curl, scripts, MCP clients) is unaffected; the page's own fetches send `Origin`.
- **ed25519 small-order public keys are not identities** (`smallOrderKeys`, libsodium's list): with the identity point as the key, `R = identity, S = 0` verifies for every message under Go's `ed25519.Verify`, so anyone could sign in as that "user". (beats' own `verifySignature` has the same property for its share signer; `internal/share` is untouched.)
- **Compose spend:** a model call the caller abandons in flight (disconnect, our own timeout) is settled at the full output allowance (`ModelError.Aborted`), not the input cost; a refused connection still costs only the input. The kill switch is read before every model call of a repair loop. A model reply whose `#!` header says private or not CC0 is a failed attempt. A `base_cid` is checked once per CID and text (it is looked at before the windows and the cap).
- **MCP:** the per-user checker and render-store allowances also count per address (4 users' worth): a user costs nothing to make. Untyped backend errors are logged, not echoed.
- **Sessions:** at most 40 open SSE streams per address (`/64` for IPv6); the stored reports of all sessions share a 128 MiB budget (`maxStateBytes`: the least recently reported lose theirs, a live page reports again within a second; measured ~340 KiB per full report, 5000 sessions allowed).
- **`/api/info` `compose.reason`** is `ComposeStatus.PublicReason` (no data-dir path, flag-file name, environment variable or admin endpoint); the full `Reason` is in `GET /api/admin/stats`.

Left as they are (decide): a signed cookie cannot be revoked (logout only clears it; 7 days; rotate `session.secret` to end every session), tokens never expire (revoke-all only); the cookie is not `__Host-`-prefixed (a sibling `*.bitwrap.io` page that can set cookies could toss one; the prefix means renaming the cookie when `-public-url` is https and touching the auth tests); identities are free (any key signs in), so per-user limits are only as strong as the per-address and global ones under them (per-address compose 40/day, global `-daily-spend-usd`, kill switch); a sign-in challenge is not bound to the page that shows it (wallet phishing relay); `/api/admin/` is reachable through nginx `location /api/` and is closed only by the app (503 empty token, 401 wrong): `location /api/admin/ { allow 127.0.0.1; deny all; }` would close it at the edge.

### Up next (the `queue` tool) — a queue that cannot spend money
An "up next" list on one hub session (`internal/btwsite/server/queue.go`, `internal/btwsite/mcpsrv/queue.go`, page `btwsite/web/js/queue-model.js`).
**Written over MCP only**; the page shows it read-only (a strip under the banner) and has no control that adds to it.
- MCP: `queue {action: list|add|remove|clear|skip, items?, item?, session?, device?}`, token required, same targets as `load` (the named session or device, else the caller's most recently seen session: one tab, never all of them). `add` items are `{cid}` (stored or an example's), `{example}` or `{url}` (verified as `load` verifies it; a link to a stored program is queued by CID, any other keeps its verified text in memory) plus optional `bars` (1-1024) or `minutes` (0.1-120) and `title`. `remove` takes an item id (`q1`…) or a CID. Writes are limited per caller (`-queue-writes-min`, 30/min, address ceiling 4x); `list` is free.
- **Never composes.** No item can be a prompt, nothing in the queue path reaches `Composer`, a renderer or any goroutine: the queue changes only on an MCP call or a page request. To queue generated music an agent calls `compose` (rate limited, spend-capped) and queues the CIDs; the tool description says so in capitals.
- Page: SSE `event: queue` `{queue: QueueView, action?: "skip"}` on every change; `GET /api/session/<id>/queue` after a reconnect; at a track boundary `POST /api/session/<id>/queue/next {reason: ended|length|skip|resume, presence}` → `{item|null, queue}`. A track boundary is the program's end (no 1.5 s tail), or for an item with `bars`/`minutes`, or a looping program (one pass of its arrangement by default: `song_bars`, else the sections' total, else 32 bars), the bar line where that length is reached. The next item starts as a fresh run (stop, then load and play from bar 1).
- **Presence** (every report and every `next` carries `presence {visible, focused, audio, idle_ms}`; `idle_ms` is on the page's clock since the last key, pointer, touch, wheel or media key). The server decides each `next`: it pauses at that boundary with `paused_reason` = `audio_suspended` (AudioContext not running), `idle_hidden` (hidden and idle ≥ `-queue-idle-minutes`, 30), `max_auto_advance` (`-queue-max-auto`, 8, advances in a row with no interaction since the last one) or `no_listener_report`. The page stops and shows "Still listening? Press play to continue"; pressing play (or the banner's Play) is the interaction that lifts it. A pause is sticky: only an interaction newer than the pause clears it, so MCP `skip` is refused while paused (answered `skipped:false` with the reason, nothing pushed) and `load` still plays one program but does not resume the queue or reset the count.
- `list` and `get` report `paused_reason`, `listener` (what the next boundary would decide now), `position`, `now_playing`, `auto_advanced`; `get` adds `up_next` and `queue`.
- Caps: `-queue-max-items` 50 per session, `-queue-max-per-add` 20, link text 256 KiB per queue, and queue bytes count against the hub's 128 MiB state budget. The queue is in memory with its session and goes when the session is swept. A paired phone (djrust) is a valid target but does not run the page's advance yet, so its queue waits (`no_listener_report`).

### MCP (G3) at `/mcp`
Tools (names exact): `compose` (auth) · `check` · `fmt` · `eval` (auth: push text into a session, optionally `play:true`) · `load` (auth: by `cid` / `example` name / url) ·
`get` (current program, section, bar, marks of a session) · `share` · `open` · `render` (returns `{stream_url, status_url, cid, seconds}`) · `record` (stores the program; returns the record-mode URLs and the deterministic recorder's recipe) · `list_examples` ·
`instruments` · `stop` (auth) . Unauthenticated calls to an auth tool return an MCP tool error `auth_required` that says how to get a token (the page's "MCP token" button).
Descriptions are written for an LLM: they say to run `check` first and fix `line:col` errors.
- **As built (G3)** — `internal/btwsite/mcpsrv`, `mcpsrv.Handler(b, a, publicURL, opts ...mcpsrv.Option)` (the options are variadic, so the contract call still compiles):
  - Stateless streamable HTTP; one handler for `/mcp` and `/mcp/`. A browser `GET` is the landing page (tools, `claude mcp add ... --header`); a `GET` that asks for `text/event-stream` is **405** (a stateless server sends nothing unprompted). Request bodies are capped at 8 x max program bytes + 64 KiB.
  - Auth is the bearer token only (`Authorization: Bearer btw_...` through `Authenticator.UserFromToken`, every call); cookies are not read. **`get` needs a token too** (deviation from the list above): the hub refuses a nil user for any session, anonymous tabs included
    ("the caller must still be authenticated"), so an anonymous `get` could never work; it answers `auth_required` with `Backend.AuthHelp()`. The auth tools are `compose`, `eval`, `load`, `get`, `stop`, `devices`, `queue`.
  - Options: `WithClientIP(func(*http.Request) string)` (default `api.ClientIP`, so `X-Real-IP` behind nginx), `WithMaxProgramBytes` (16384), `WithMaxPromptChars` (800), `WithCheckPerMin` (60), `WithRenderPerHour` (30), `WithSharePerHour` (60), `WithComposeTimeout` (150 s), `WithNow`.
  - `Backend` has no caller, so mcpsrv has two small in-memory limiters of its own, keyed by user id else IP (/64 for IPv6): checker-backed calls (`check`, `fmt`, `share`, `open`, and the check inside `eval`/`load`/`render`) per minute, and programs it **stores** for `render` per hour. Compose and render streaming keep the backend's own limits.
  - Every failure is a tool result with `isError: true` whose text is `{"error":{"code","message","retry_after","details"}}` (a `retry_after` is also written into the message: "Retry after 30 seconds."); a program that does not check is `ok:false` from `check` (an answer), but a tool error with the diagnostics in `details` from `eval`, `render` and `share`.
  - `eval` checks first and refuses programs with errors, `restricted` and asset-using programs (nothing is pushed). It sends `SessionEvent{Type:"eval", Text: <as given>, CID, Play}`; `load` sends `{Type:"load", Text: <canonical>, CID, Play}` (text and cid both, so the page need not fetch); `stop` sends `{Type:"stop"}`. `session` is validated (`[A-Za-z0-9_-]{6,64}`), unknown arguments are refused by name (a typo must not mean "every tab"), `n == 0` delivered is `no_session` with words that say to open the page and where its MCP panel shows the session id.
  - `devices` (token required, read-only) lists the token account's paired phones (`api.Devices`: id, name, fingerprint, paired, connected, last_seen, session, state). `eval` / `load` / `get` / `stop` take `device` (a device id) to drive that phone alone: the server resolves it to the phone's hub session (`DeviceSession`), `not_found` when the account has no such phone, `no_session` when it is paired but not connected; `session` and `device` together are refused. Pairing is the grant (PAIRING.md): no new credential, the owner's token reaches the owner's phones and nobody else's.
  - `render` takes exactly one of `text` / `cid` / `example`, checks, refuses private programs, stores the program via `Backend.Put` (CC0-1.0, public) and answers `{cid, format, stream_url, status_url, seconds, license, note}` with absolute URLs. `open` also resolves a bare CID or a short link through the store and the examples (see Short links). `list_examples` takes an optional `name` and then also returns that program's text.
  - The full `tools/list` answer is pinned in `btwsite/testdata/mcp/tools-list.json` (`UPDATE_GOLDEN=1 go test ./internal/btwsite/mcpsrv` rewrites it): review it when a description changes.

## The page (W1) — code-centric by default
Full-height editor (a `<textarea>` under a highlighted `<pre>` overlay or a contenteditable; syntax classes from `btw_highlight`), a gutter with line numbers + firing dots, red/amber squiggles with
line:col messages and did-you-mean (`help`) from `check` on every pause, a header: **▸ section n/m · bar · phrase (8 lights) · gen**, a bar under it as far as the section is through,
token flashes, ramp bars under ramp lines, timed lines glowing when they fire, follow-scroll by section (the desktop's rules, docs/BTW.md "Seeing it play"),
Cmd/Ctrl+Enter eval, Esc/Cmd+. stop, `fmt`, **share** (self-sealing link into the clipboard and the hash), open by CID/link (`#<CID>.<text>`), an example picker, a Compose box (prompt, genre/bpm/key/length) behind sign-in,
sign-in (wallet or browser key), "MCP token", a slim transport bar (play/stop, source engine|stream, level, tempo readout) that expands into the two decks with their playing roles. Same look family as
beats.bitwrap.io (dark, its palette, type and spacing; read `public/petri-note.css` and `public/index.html` in this repo).
Two sound sources, one clock interface `{grid()}`: the in-browser **engine** (live coding: edits land on the next bar) and the **stream** (`/api/render/<cid>?format=wav` decoded chunk by chunk and scheduled gaplessly on
the AudioContext; opus for download/`<audio>`). Compose and open-by-link start the stream at once; the engine loads behind it and takes over for live edits. In both, the markers follow that source's clock.
Page state is driven by the SSE events from the server (so MCP `eval`/`load`/`stop` work) and reported back.

**As built (W1).** `btwsite/web/{index.html,css,js}`; tests in `btwsite/test/` (`node --test btwsite/test/unit.mjs`, `node btwsite/test/smoke.mjs [--server URL]`, `smoke.md`).
- *Source rule:* Cmd+Enter plays on the engine once it has loaded, else on the stream; Play after compose / open-by-link uses the stream; the transport's `engine|stream` buttons pin a source. A program is `PUT /api/programs/<cid>` (its canonical text) before it is streamed.
- *Virtual clock rule:* `BtwRun` puts a program's bar 0 on the first grid it sees *with a clock*, so a virtual source (stream, record mode) returns `grid() = null` until the runtime's own `play` commands have been echoed into its flags (the engine already does). Otherwise every section and generation comes a bar late.
- *`status()` is expensive* (it hashes every net: ~25 ms a call on a big song); the page asks for it at start, on a section change and every 8 bars, and carries bar/phrase/song_bar/section_bar/generation forward from `marks()` (~1 ms), so a frame costs ~1.5 ms.
- *Read from the server:* `/api/info` `public_url` (share links), `compose.limits.max_prompt_chars`; optional response header `X-Btw-Bpm` on `/api/render` (else the program's `tempo`, else 120: a program with no `tempo` plays at the render's own tempo, which the page cannot know without it).
- *Record mode* (the demo video; `btwsite/tools/record-demo.mjs`): `?record=1&cid=<CID>|example=<name>` hides the chrome (a header, the editor, a slim transport bar), follow on, plays; `&clock=manual` uses no audio and no wall clock. `window.__btw`: `ready` (Promise), `setTime(s)`, `frame([s])` (one service+marks+paint pass, synchronous), `info()` -> `{cid,name,bpm,bars,seconds,sections}`, `reset()` (the runtime only counts forward: a rewind is a reset), `recorder.start()/stop()` (MediaRecorder on the master gain; `stop()` resolves to base64 webm/opus). Markers are inline styles written from `marks()` by one function of (marks, text, time): no CSS animation, no rAF dependence, the follow-scroll ease is computed from the fake clock; the same fake times are the same pixels (smoke step 9 compares screenshot hashes). Frames must be rendered in increasing time order.

## Cards (G4) — share previews in a btw style
Reuse beats' mechanism (`internal/share/share_page.go` for the `og:` / `twitter:` meta page, `internal/share/share_card_png.go` for the PNG: `fogleman/gg` + `golang.org/x/image` fonts, all already in `go.mod`;
PNG because X/Mastodon/Bluesky drop SVG), but a distinct look: **code-first, no waveform/deck look**.
- **Card** (`/card/<cid>.png` 1200×630, `/card/<cid>.square.png` 1080×1080, `/card/default.png` generic): dark "code stage"; the program's most characteristic 8–12 lines
  in embedded **Go Mono** (`gofont/gomono`, `gomonobold`) with syntax colours from `btwd highlight`, frozen mid-play: green gutter dots on playing lines, 2–3 amber token lamps,
  one ramp bar part-filled (all chosen **deterministically from the CID**). Region rule: the section named `drop`, else the section with most parts, else the first `def`, else the first 12 lines;
  long lines are cut with `…`. Bottom strip: section timeline as proportional blocks (`intro|build|drop…`, each named), program name (`#! name:` or `btw <short cid>`), BPM, key, length (bars · m:ss),
  a **CC0** badge (license from the stored meta, default CC0-1.0), short CID `z4EBG9…7v`. Palette: near-black blue-grey with the btw accent colours (not beats' waveform palette).
- **Deterministic**: same CID → byte-identical PNG (no timestamps, fixed fonts, stable encoder settings); cached on disk by `(cid, variant)`; `Cache-Control: public, max-age=31536000, immutable`; a test pins a SHA-256 per example and keeps sample PNGs in `btwsite/testdata/cards/`.
- **Pages**: `GET /c/<cid>` (program in the store or examples) and `GET /c/<cid>.<packed>` (stateless: text carried in the path, verified `canonical CID == <cid>`) answer HTML with `og:title` (name + key facts: "hand-dubstep-140-v4 · fm · 140 BPM · 64 bars"),
  `og:description` (first comment line, else "a track in N lines of btw"), `og:image` (+`:width/:height/:alt/:type`), `og:url` = the canonical share link (the fragment form `https://btw.bitwrap.io/#<CID>.<packed>` when text is known, else `/c/<cid>`),
  `twitter:card=summary_large_image`, `twitter:image`, and JS/`<noscript>` that sends humans to `/#<CID>.<packed>`. `/` and `/p` (static) carry a generic card.
- **Safety**: a link whose CID does not match its text → **generic card**, `noindex`, never the program's content; `restricted` / asset-using / private programs → generic card (title "a private btw program"), nothing from the text; unknown CID → generic card (200) so unfurlers don't cache an error.
- Tests: a card per example (golden SHA-256 per CID, image decodes at the right size), meta tags on `/c/<cid>`, `/c/<cid>.<packed>` and `/` / `/p`, mismatch → generic, restricted → generic, cache hit, square variant.
- **As built (G4)** — `internal/btwsite/card`:
  - `card.Options{Checker, Store, Examples func() []api.Example, ExampleText func(name) (string,bool), PublicURL, CacheDir, WebDir (unused), MaxTextBytes 32 KiB, RenderConcurrency 2, CheckTimeout 15 s}`;
    wire `Examples: srv.Examples, ExampleText: srv.Example`, `CacheDir: <data>/cards`, then `cardSvc.Mount(mux)` (`GET /c/`, `GET /card/`). Variants are `card.Wide` (1200×630) and `card.Square` (1080×1080).
  - **One addition to the routes:** `GET /card/<cid>.<packed>.png` (and `.square.png`), the image of a stateless link whose program is not in the store or examples: the page `/c/<cid>.<packed>` points its
    `og:image` there (it is verified like the page: the text's canonical CID must be `<cid>`). A program that is stored/an example uses `/card/<cid>.png`. `GET /card/go.js` is the one-line redirect script the pages load (no inline handlers).
  - A card is drawn from the **canonical** text (comments are not in the CID), so the name comes from the stored `Meta.Name`, else the example's `#! name:`/name, else `btw <short cid>`. Disk cache file: `<cid>.<variant>.v<N>[.<name hash>].png`
    (written atomically; `ETag` = `"<cid>-<variant>[-<hash>]"`); the page is `public, max-age=3600`. A stand-in generic card for an unknown/mismatched/private CID is `public, max-age=300` (never immutable, so a CID stored later is not shadowed), mismatch/private/restricted/garbage carry `noindex` (tag and `X-Robots-Tag`).
  - `Render(text, v)` is pure and uncached (it refuses programs with errors, restricted, asset-using or `#! visibility: private` with an `*api.Error`; `Generic(v)` is the generic card). Renders are limited to 2 at once and one card is never rendered twice at the same time.
  - Static pages: `card.GenericMeta(origin)` / `GenericMetaAt(origin, "/p")` give the generic og:/twitter:/description/canonical tags as a fragment; `card.InjectGeneric(doc, origin, path)` puts them where `<!-- btw:card-meta -->` is in a page, else before `</head>`.
  - Highlight: spans from `Checker.Highlight` (the 14 classes) colour the code; with none (the fake checker, btwd failing) a small built-in lexer does. Key facts: `fm` is shown as "F minor" on the card, raw in `og:title`.

## docs and llms.txt (G3)
Served by the site: `/llms.txt` (llmstxt.org: H1, `>` summary, short key facts, `##` sections of links), `/llms-full.txt` (the complete grammar and cheat-sheet inlined), `/docs/BTW.md` (verbatim from `djrust-vevr-se/docs/BTW.md`, copied by a make target),
`/docs/cheatsheet.md` (**`btwd cheatsheet` output — the same text the compose system prompt uses**), `/docs/api.md`, `/api/instruments`, `/examples/*.btw` (hand-dubstep-140-v4, matrix-130, trance-138, the rest of `btwsite/examples/`).
A test fetches every link in `llms.txt` and demands 200. Matt's draft for `llms.txt` (adjust paths to what is served):
```
# btw
> BeatScript: AI-assisted algorithmic composition. btw (bitwrap) is its small, total, deterministic language for writing whole music tracks as text. Programs compile to Petri nets, play in the browser and the djrust desktop app, and are content-addressed: the same canonical text always has the same CID. Programs are CC0 by default and remixable by fork.
Key facts: one line per deck with |-separated parts and 16 steps a bar; mini-notation (x hit, ~ rest, [..] group, <..> per-bar alternation, c2! accent, e2^ slide, chord(am)); structure (let, def with no recursion, repeat N, section, arrange, end after); control lines (ramps a -> b over N bars, at bar, every, before <section>, do <noun> <verb>); seeded transforms; evolve with a reported tail and period; only instruments from /api/instruments; always run check and fix line:column errors before playing.
## Docs: BTW.md, cheatsheet.md, instruments. ## Examples: the three named above. ## API: /mcp tools, POST /api/compose (signed in, rate-limited), GET /api/render/<cid> (streams), share-link format p#<CID>.<deflate(canonical)>. ## Optional: https://blog.stackdump.com/posts/generator-you-can-read and https://ontology.bitwrap.io.
```
(Write it properly in llmstxt.org shape: sections as `## Docs`, `## Examples`, `## API`, `## Optional` with `- [name](url): note` lines.)
- **As built (G3)** — `internal/btwsite/docs`:
  - `docs.Mount(mux, docs.Options{DocsDir, Checker, Examples, ExampleText, PublicURL, FullExample})` registers **exact paths only** (`/llms.txt`, `/llms-full.txt`, `/docs/BTW.md`, `/docs/cheatsheet.md`, `/docs/api.md`; GET/HEAD, `ETag`, `Cache-Control: no-cache`, `text/plain` for the two `.txt`, `text/markdown` for the `.md`), so it cannot collide with `/` or with the server's own routes.
    `DocsDir` is where `scripts/btw-gen-docs.sh` writes: **`btwsite/web/docs`** (not `btwsite/docs`; set `-docs` accordingly). `BTW.md` and `cheatsheet.md` there are generated and gitignored (public repo); if `cheatsheet.md` is absent `Checker.Cheatsheet` answers instead; a document that is not installed is 404 **and is left out of llms.txt**, so every link in it is 200.
  - `api.md` is hand-written and embedded in the package (`internal/btwsite/docs/api.md`); `https://btw.bitwrap.io` in it is replaced by `PublicURL` when served. `llms.txt` is built from `PublicURL` and `Examples()` per request; `llms-full.txt` is `llms.txt` + the cheat-sheet + the `## The rules in one screen` and `## Grammar (EBNF)` sections of `BTW.md` (cut by heading, code fences respected) + one example (`markers-demo` by default), and is whatever of those exist when the generated files are missing.
  - `docs.LoadExamples(dir, checker)` is the contract loader; `docs.LoadExampleSet` also keeps the texts and tags; `docs.MountExamples(mux, list, text)` is an optional `GET /api/examples` + `GET /examples/{file}` pair (Mount does not call it; use it or the server's own, never both). An example that does not check, or uses samples / `use restricted`, is an error.
    The program's own tempo and length win over `index.json`. The eight examples' real CIDs are pinned in `btwsite/testdata/docs/example-cids.json` (checked with `BTWD_BIN`).
  - Tests that need the generated files use the toy stand-ins in `btwsite/testdata/docs/` when they are absent (`BTW_DOCS_FIXTURES=1` forces them); `BTWD_BIN` adds "the generated cheatsheet equals a fresh `btwd cheatsheet`" and "the examples check clean with the pinned CIDs"; `BTW_MD_SRC=<path to docs/BTW.md>` adds "BTW.md is a verbatim copy".

## Hardening (SEC-2: untrusted input, resources, the subprocess boundary) — as built
Measured against the real release `btwd`: a 12 KB `evolve` program takes 4 s to check (110 MB); a 128 KB one runs to the 10 s timeout (220 MB); one 400-byte program at 40 BPM and 256 bars is 1536 s of audio, 75 s of CPU and a 270 MB WAV (tempo is 40..300 and `--max-bars` is passed, so that is the ceiling); 30 000 junk lines are 17 MB of diagnostics.
- **btwd client.** stdout (4 MiB) and stderr (4 KiB) caps are real (`limitedBuffer` used to embed `bytes.Buffer`, whose `ReadFrom` io.Copy prefers: the caps in `Write` were never reached). An answer over the cap kills the child and is a 422. A check keeps at most 200 diagnostics (`errors`/`warnings` still count all) and each text is clipped (the caret form repeats the whole source line: 24 KB in, 2.5 MB out). A render's stderr lines are capped at 1 MiB.
- **Per address.** `server.checkerOwner` puts `api.IPKey(ClientIP(r))` on every request's context (`btwd.WithOwner`); the btwd client then allows an owner `MaxConcurrent/2` calls in flight and a budget of checker time (30 s banked, 0.5 s earned per second; a call is charged what it took; 429 `rate_limited` + `Retry-After` when it is spent). Before this, 24 requests a minute from one address held all four slots and four cores for good, and an honest user waited 8.5 s for a 4 ms check. Cards, MCP, compose, PUT and a render's check are all charged this way; a call with no owner (start-up, tests) is not limited.
- **Cards** (`internal/btwsite/card`). The disk cache is capped (`CacheMaxBytes`, 256 MiB, least recently used goes; it was 170 KB per distinct stateless link, unbounded). Work (a check of text not remembered, a card not drawn) is limited per address (`WorkPerMinute`, 120: about 60 new cards a minute; hits are free) and the cards have their own two checker slots (`CheckConcurrency`). A busy or limited checker is 503/429 with `no-store`, never a cached "invalid" card. What the memo keeps of a check is what a card needs (no diagnostics). Bidi controls are dropped from names and descriptions.
- **Programs.** Text must be UTF-8 (400, was 502). A `#! visibility:` header whose value is not `public` is refused in any spelling (`#!visibility:private`): btwd knows only the exact `#! visibility: private`, and a program that says it is private must never be stored, rendered or carded; an example that says so stops the server. The canonical text must hash to its CID (`btw.ProgramCID`, recomputed in Go). `Backend.Get` answers an example from the examples first: anyone may PUT an example's text before it is asked for, and first meta wins in the store.
- **Access log.** At most 100 MiB a day (one `note` line says when it was reached); retention is still 30 days.
- **Priority.** btwd and ffmpeg children are reniced to 10 after they start (`btwd.Renice`; `Options.Nice`, -1 leaves it), so they yield to the other services on the host. A cgroup limit would be firmer; there is none under `~/services`.
- **Not done, on purpose.** Two or more addresses can still keep both render slots busy (30 renders an hour each, up to 75 s of CPU apiece); a render-seconds cap would shrink that. A flood of distinct addresses (a botnet) is nginx's to stop: the app's limits are per address.

**A phone, and the page in the background (fix/btw-mobile).**
- *Narrow screens (under 480 px).* The transport bar is one row: play/stop, the status as an icon and a word (`live`, `stream`, `preparing`, `loading`, `stopped`, `offline`; the long text is still there at wider widths), the problems as a dot and a count (the strip above the bar is hidden; a tap on the dot and count opens the same list), and the caret. The caret opens a sheet in the same footer with the engine|stream toggle and the level (and the decks panel above it). Every control is at least 44 px; the footer pads by `env(safe-area-inset-*)`; the drawer and the toasts sit above whatever height the bar has (`--bar-h`, set from a ResizeObserver). Desktop (over 480 px) is unchanged: `smoke.mjs` and `mobile.mjs` both check it. `node btwsite/test/mobile.mjs` (412 x 915, touch) and `node btwsite/test/mobile-shots.mjs --prefix X` (screenshots).
- *The background.* The sound is made on the audio thread (the AudioWorklet), which a hidden tab does not stop. What stopped was the **program runtime** (`BtwRun`: sections, bar counts, `on phrase:`, ramps, the loads of the next section's nets), which was serviced only from `requestAnimationFrame`, which a hidden tab does not run: the audio looped the net it had and the program did not move until the tab came back. Now `js/background.js` services the runtime from the engine's own reports (`engine.on('grid')`: a message from the audio thread every ~25 ms of audio, an event, not a timer, so it is not throttled), with a 250 ms interval as the fallback (the stream has no such reports), and only while the page is hidden or the frame loop has stalled; painting is skipped while `document.hidden`; a worklet report that is already old when it is delivered (a page that was frozen) is not serviced one by one. On return: the AudioContext is resumed if the browser suspended it, the page paints at once, and, when the context came back suspended, the engine's clock fell behind, or (on Android) the engine played through more than 3 s of background, a banner offers the streamed render (`sourcePref = 'stream'`), once per page load.
- *The lock screen.* Media Session (title = the program's name, album = source and tempo; play, pause and stop handlers), and a silent looping `<audio src="silence.wav">` plays beside the sound while a program plays, because Chrome only treats a page as media (notification, lock-screen controls, not put to sleep) when a media element plays and ours is Web Audio. `?keepalive=0` turns it off, `?pump=0` turns the background service off (a test switch). Not verified on an Android device: the desktop-Chrome tests cover the timing, not the lock screen.
- *Test:* `node btwsite/test/background-browser.mjs [--seconds 30] [--mode hidden|frozen] [--without-pump]`: headless Chrome plays a sectioned program, a second tab is opened and activated so the page is really hidden (no frames, throttled timers), and over CDP the runtime's bar counter and section are read against wall time (within one bar), the engine is checked to have been handed each section's nets, and the return is watched for a catch-up burst. `--without-pump` is the negative control: the same run with the service off must stall (bar counter 0.01 in 30 s, the first section for ever). The headless run needs a clock-running null audio sink: `--disable-audio-output` (it is in the test's own launch; `BTW_CHROME_ARGS` adds flags to `cdp.mjs` launches, e.g. for `smoke.mjs` and `engine-browser.mjs` on a machine whose sound card is busy).

## Tests (each owner writes theirs; the lead runs all)
- Rust: `cargo test -p btwapi -p btwd -p djweb`; wasm↔Rust CID parity: Node loads the built wasm and compares CIDs (program, nets, song_nets) with `btwd check` for `examples/*.btw`, `docs/btw/*.btw`,
  and the public saved programs `hand-dubstep-140-v2`, `hand-dubstep-140-v4`, `matrix-130` (copied into `crates/djweb/tests/corpus/`, all CC0 public) — byte-equal JSON for `check`/`fmt`.
- Go: `go test ./internal/btwsite/...` — compose with the fake model (good, repairable, unrepairable → clean 422, auth refusal, rate limit, spend cap, kill switch, not-configured), limits, auth (challenge/login/tokens/cookie tamper),
  programs store, render streaming (first byte < 1 s against a real `btwd` when `BTWD_BIN` is set, else a fake; cache hit; join), MCP (tools/list, calls, auth required), every link in `llms.txt` returns 200.
- Browser smoke (Playwright MCP / headless Chrome): load the page, play an example, see markers (gutter dots, a flash), diagnostics for a broken program, compose with the fake model. Script in `btwsite/test/`.
- Real model: if a key is present, three composes ("dark techno 128 with an acid line", "happy hardcore 174", "ambient piano with evolving arp"): programs, CIDs, attempts, cost recorded in `btwsite/testdata/compose/real-<date>.json`.

## Deploy (lead)
pflow.dev, nginx vhost + Let's Encrypt like `windwheel.bitwrap.io`; service `btw-bitwrap` on `:18097` via `~/services` with env in `~/.env-services/btw-bitwrap` (0600; the Gemini key is copied there
on the host, never printed, never committed); `btwd` binary scp'd to `~/Workspace/btw-bitwrap-io/bin/btwd`; checkout of `feat/btw-site` (no merge to `main`).
