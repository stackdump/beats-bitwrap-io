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
- `https://btw.bitwrap.io/mcp` — MCP (streamable HTTP) over the same things.
- `/llms.txt`, `/llms-full.txt`, `/docs/*`, `/examples/*.btw`.

## Repos, branches, worktrees (do not touch anything else)

| repo | branch | worktree | holds |
|---|---|---|---|
| `stackdump/djrust-vevr-se` (private) | `feat/btw-web` (off `origin/feat/btw-language`) | `~/Workspace/.val-worktrees/djrust-vevr-se/btw-web` | Rust: `crates/btwapi`, `crates/btwd`, `crates/djweb` |
| `stackdump/beats-bitwrap-io` | `feat/btw-site` (off `feat/btw-link`) | `~/Workspace/.val-worktrees/beats-bitwrap-io/btw-site` | Go service, static site, tests, deploy files |

Off limits: the running djapp, `~/Workspace/.val-worktrees/djrust-vevr-se/{6014eced,btw-ext*,center-fit,...}`, the
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
    Now func() time.Time                                              // tests
}
func (s *compose.Service) Handler(a api.Authenticator) http.Handler   // POST /api/compose (401 without a user; never anonymous)
func (s *compose.Service) AdminHandler(adminToken string) http.Handler // POST /api/admin/compose {enabled}, GET /api/admin/stats
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
`-max-prompt-chars 800`, `-max-program-bytes 16384`, `-max-repair 3`, `-render-ip-hour 30`, `-render-concurrency 2`,
`-render-max-bars 256`, `BTW_ADMIN_TOKEN`, `BTW_COMPOSE_ENABLED=0|1`, `BTW_SESSION_SECRET` (else generated into `-data`).
Compose is **"not configured"** (503 `not_configured`) when there is no key and the model is not `fake`.

### HTTP API
| route | auth | notes |
|---|---|---|
| `GET /` `/js/* /css/* /wasm/*` … | – | static from `-web` (`Cache-Control: no-cache` + ETag); `/p` → redirect to `/` keeping the fragment is done in JS |
| `GET /healthz` `GET /api/info` | – | info: name, version, model, compose `{enabled,configured,limits}`, render limits, auth kinds |
| `GET /api/examples` `GET /examples/<name>.btw` | – | list `[{name,title,description,cid,bpm,bars,license}]`, raw text |
| `GET /api/instruments` | – | btwd instruments JSON |
| `POST /api/check` `/api/fmt` `/api/share` `/api/open` | – | body `{"text":…}` (or `{"url":…}` for open); rate-limited per IP |
| `PUT /api/programs/<cid>` | – | body = program text; accepted iff its canonical CID is `<cid>`, it checks ok, is not restricted/asset-using, ≤ max bytes; stored content-addressed; per-IP limited. `GET /api/programs/<cid>` → `{cid,text,meta}`; `GET /api/programs/<cid>.btw` → text with `#!` header |
| `GET /api/render/<cid>?format=opus\|wav&sr=44100` | – | chunked stream, see Render; `GET …/status` |
| `POST /api/session` / `GET /api/session/<id>/events` (SSE) / `POST /api/session/<id>/report` / `POST …/reply` | cookie optional | the browser ↔ MCP bridge, see Sessions |
| `GET /api/auth/challenge` `POST /api/auth/login` `POST /api/auth/logout` `GET /api/auth/me` `POST /api/auth/token` `DELETE /api/auth/token` | – / cookie | see Auth |
| `POST /api/compose` | **cookie or bearer** | see Compose |
| `POST /mcp` (+`GET` landing, SSE) | tools: write tools need bearer | see MCP |
| `POST /api/admin/compose` `GET /api/admin/stats` | `Authorization: Bearer $BTW_ADMIN_TOKEN` | kill switch `{"enabled":false}`; counters |
| `GET /c/<cid>` · `/c/<cid>.<packed>` · `GET /card/<cid>.png` · `/card/<cid>.square.png` · `/card/default.png` | – | share cards, see Cards |
| `GET /llms.txt` `/llms-full.txt` `/docs/BTW.md` `/docs/cheatsheet.md` `/docs/api.md` | – | generated/served by G3's package; every link in `llms.txt` must return 200 (test) |

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
Page: `POST /api/session` → `{"id":"<22 chars>","user":…}` then `GET /api/session/<id>/events` (SSE; `event: eval|load|stop|get|ping`, `data: JSON`). The page
sends `POST /api/session/<id>/report` every ~500 ms while it matters (`{"text","cid","playing","source":"engine|stream","section","bar","bars_in_section","phase","marks":{…},"diagnostics":[…],"ts"}`)
and `POST …/reply` `{"request_id","state"}` for a `get` event. Server keeps the latest report per session (in memory, 10 min TTL).
An MCP write tool targets `session` (explicit) or else every live session owned by the caller; a session is owned by the user that created it with a cookie/bearer,
or is anonymous (then only the explicit id, which the page shows in its MCP panel as a capability, works — and the caller must still be authenticated).

### MCP (G3) at `/mcp`
Tools (names exact): `compose` (auth) · `check` · `fmt` · `eval` (auth: push text into a session, optionally `play:true`) · `load` (auth: by `cid` / `example` name / url) ·
`get` (current program, section, bar, marks of a session) · `share` · `open` · `render` (returns `{stream_url, status_url, cid, seconds}`) · `list_examples` ·
`instruments` · `stop` (auth) . Unauthenticated calls to an auth tool return an MCP tool error `auth_required` that says how to get a token (the page's "MCP token" button).
Descriptions are written for an LLM: they say to run `check` first and fix `line:col` errors.

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

## docs and llms.txt (G3)
Served by the site: `/llms.txt` (llmstxt.org: H1, `>` summary, short key facts, `##` sections of links), `/llms-full.txt` (the complete grammar and cheat-sheet inlined), `/docs/BTW.md` (verbatim from `djrust-vevr-se/docs/BTW.md`, copied by a make target),
`/docs/cheatsheet.md` (**`btwd cheatsheet` output — the same text the compose system prompt uses**), `/docs/api.md`, `/api/instruments`, `/examples/*.btw` (hand-dubstep-140-v4, matrix-130, trance-138, the rest of `btwsite/examples/`).
A test fetches every link in `llms.txt` and demands 200. Matt's draft for `llms.txt` (adjust paths to what is served):
```
# btw
> btw (bitwrap) is a small, total, deterministic language for writing whole music tracks as text. Programs compile to Petri nets, play in the browser and the djrust desktop app, and are content-addressed: the same canonical text always has the same CID. Programs are CC0 by default and remixable by fork.
Key facts: one line per deck with |-separated parts and 16 steps a bar; mini-notation (x hit, ~ rest, [..] group, <..> per-bar alternation, c2! accent, e2^ slide, chord(am)); structure (let, def with no recursion, repeat N, section, arrange, end after); control lines (ramps a -> b over N bars, at bar, every, before <section>, do <noun> <verb>); seeded transforms; evolve with a reported tail and period; only instruments from /api/instruments; always run check and fix line:column errors before playing.
## Docs: BTW.md, cheatsheet.md, instruments. ## Examples: the three named above. ## API: /mcp tools, POST /api/compose (signed in, rate-limited), GET /api/render/<cid> (streams), share-link format p#<CID>.<deflate(canonical)>. ## Optional: https://blog.stackdump.com/posts/generator-you-can-read and https://ontology.bitwrap.io.
```
(Write it properly in llmstxt.org shape: sections as `## Docs`, `## Examples`, `## API`, `## Optional` with `- [name](url): note` lines.)

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
