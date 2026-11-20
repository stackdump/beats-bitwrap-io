# BeatScript API

`https://btw.bitwrap.io` is a code-centric web view of **BeatScript**, AI-assisted algorithmic composition: a small language for writing whole music tracks as text
(reference: [BTW.md](https://btw.bitwrap.io/docs/BTW.md), compact grammar: [cheatsheet.md](https://btw.bitwrap.io/docs/cheatsheet.md),
index for models: [llms.txt](https://btw.bitwrap.io/llms.txt)). This page documents everything the service answers: the HTTP routes,
sign-in, composing with a model, streaming renders, driving a browser tab, and the MCP server.

Conventions. Bodies are JSON unless noted; programs are plain UTF-8 text. A program is at most **16384 bytes**. Every program the
service stores or shares is **CC0-1.0** (public domain); programs that use `sample` / `loop` assets or `use restricted` are private
and are refused by every route that stores, shares or renders. A program's **CID** (`z4EBG9j...`) is the hash of its *canonical text*
(the parse printed again: spacing, comments, number and note spellings do not change it), so the same program is always the same CID.

**Privacy and licence.** Everything generated here is published: a composed program, its CID, share link, social card and every render or
audio stream made from it are stored publicly and released under CC0-1.0, and anyone with the link can play, copy and reuse them. A compose
prompt goes to a third-party model provider, so never put anything private in one. Responses that carry generated work send
`X-Content-License: CC0-1.0` and a `Link: </privacy>; rel="privacy-policy"` header, a compose result has a `notice` field, and the human
version is `/privacy`. `GET /.well-known/btw-site` names the site (`site_id`, its origins, `moved_to` once it has moved).

## Routes

| route | auth | does |
|---|---|---|
| `GET /` and `/js/*`, `/css/*`, `/wasm/*` | | the page |
| `GET /healthz`, `GET /api/info` | | liveness; name, version, model, compose `{enabled, configured, limits}`, render limits, auth kinds |
| `GET /api/examples`, `GET /examples/<name>.btw` | | the public example programs: list as JSON, text as written |
| `GET /api/instruments` | | the voices, families, drum kits and palettes a program may name |
| `POST /api/check`, `/api/fmt`, `/api/share`, `/api/open` | | the language tools, below; limited per IP |
| `PUT /api/programs/<cid>`, `GET /api/programs/<cid>[.btw]` | | store and read programs |
| `PUT /api/shares/<cid>` | cookie, bearer or paired phone | store a public program with its rights for a CID-only share link, [Share links](#share-links) |
| `GET /api/render/<cid>?format=opus\|wav` | | stream the offline render, [Render](#render) |
| `POST /api/session`, `GET /api/session/<id>/events`, `POST /api/session/<id>/report`, `POST /api/session/<id>/reply` | cookie optional | the browser to MCP bridge, [Sessions](#sessions) |
| `GET /api/auth/challenge`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/token`, `DELETE /api/auth/token` | | [Sign-in and tokens](#sign-in-and-tokens) |
| `POST /api/compose` | cookie or bearer | [Compose](#compose) |
| `POST /mcp` (and a landing page on `GET`) | write tools need a bearer token | [MCP](#mcp) |
| `GET /c/<cid>`, `GET /c/<cid>.<packed>`, `GET /p/<cid>`, `GET /card/<cid>.png` | | share pages with link previews, and their card images; `/p/<cid>` is the CID-only short link |
| `GET /llms.txt`, `/llms-full.txt`, `/docs/BTW.md`, `/docs/cheatsheet.md`, `/docs/api.md` | | the docs |

## Errors and limits

Every error is JSON with the HTTP status of the failure:

```json
{"error": {"code": "rate_limited", "message": "10 composes an hour is the limit", "retry_after": 30}}
```

`retry_after` (seconds, also the `Retry-After` header) is there when waiting helps. Some errors carry `details` (the diagnostics and
attempts of an `unrepairable` compose). Codes: `auth_required` 401, `bad_signature` 401, `challenge_stale` 401, `bad_request` 400,
`not_found` 404, `no_session` 404, `too_large` 413, `prompt_too_long` 413, `rate_limited` 429, `busy` 429 (all render slots taken),
`cid_mismatch` 422 (a link or body whose CID is not its text's), `restricted` 422, `unrepairable` 422, `model_error` 502,
`spend_cap` 503 (the day's money limit is spent), `disabled` 503 (the compose kill switch is off), `not_configured` 503 (no model key).

Limits are per client address (IPv6 per /64) and, when signed in, per user. `GET /api/info` says the current compose limits.
Ask for `retry_after` seconds and try again; do not loop.

## Sign-in and tokens

Identity is a key, not an account: an Ethereum wallet (`personal_sign`, EIP-191) or a browser-local Ed25519 key. The same wallet identity
works on beats.bitwrap.io. Sign-in is challenge and response:

1. `GET /api/auth/challenge` gives `{"nonce": "...", "message": "btw.bitwrap.io sign-in\nnonce: ...\nissued: ...\nexpires: ...", "expires": "..."}`.
   The nonce is single use and lives 5 minutes.
2. Sign `message` (its UTF-8 bytes). Ethereum: `personal_sign(message)`. Ed25519: the raw signature over the bytes.
3. `POST /api/auth/login` with `{"type": "eth", "address": "0x...", "signature": "0x...", "nonce": "..."}`
   (`"type": "ed25519"` takes the 64-hex public key and a 128-hex signature). The answer sets the cookie `btw_session`
   (HttpOnly, Secure, SameSite=Lax, 7 days) and gives the user: `GET /api/auth/me` answers `{"user": {"id", "kind", "address"}}` or `{"user": null}`.
   The user id is `eip155:0xabc...` (lower case) or `ed25519:<hex>`.
4. **Bearer tokens**, for MCP and scripts: with the cookie, `POST /api/auth/token` answers `{"token": "btw_<43 characters>"}` **once**
   (only its SHA-256 is kept; at most 5 per user). The page's **MCP token** button does exactly this. `DELETE /api/auth/token` revokes them all.
   Send it as `Authorization: Bearer btw_...` wherever the cookie is accepted.

Anonymous callers can read, check, format, share, open, render (limited) and play. Signed-in callers can also compose, use MCP's write
tools and drive their own browser tabs.

## Check, format, share, open

`POST /api/check` with `{"text": "<program>"}` answers (always 200; a program with errors is `ok: false`):

```json
{"ok": true, "errors": 0, "warnings": 1,
 "diagnostics": [{"severity": "warning", "line": 3, "col": 14, "end_col": 15, "start": 42, "end": 43,
                  "message": "...", "expected": ["..."], "found": "...", "help": "...", "render": "warning: ...caret form..."}],
 "cid": "z4EBG9j...", "canonical": "tempo 140\n...", "nets": {"A": "z4EB..."}, "song_nets": {"A": "z..."},
 "tempo": 140, "key": "fm", "swing": null, "arranged": true, "song_bars": 64, "ends": true, "loops": false,
 "sections": [{"name": "intro", "start": 0, "bars": 8}], "decks": ["A", "B"], "evolve": [], "lineage": [],
 "uses_assets": false, "restricted": false, "seconds": 109.7}
```

`line` and `col` are 1-based; `start` and `end` are UTF-8 byte offsets into the text you sent; `help` says what would fix it; `render` is the
error in caret form. `cid` and `canonical` are null when `ok` is false. **Always check before you play, share or render, and fix every
error at its line:col**; a program with an error is refused whole.

- `POST /api/fmt` `{"text"}` gives `{"ok", "canonical", "cid", "comments": [...], "diagnostics": [...]}`: the canonical form and the comments it dropped.
- `POST /api/open` `{"url": "<link, #fragment, <CID>.<packed> or CID>"}` gives `{"ok", "cid", "canonical", "verified", "warnings", "notes_unverified", "error"}`.
  A link whose CID is not its text's is refused (`verified: false`, never trust its text).
- `POST /api/share` `{"text"}` gives `{"ok", "url", "social_url", "beats_url", "cid", "chars", "canonical", "warnings"}`, see [Share links](#share-links).

```bash
curl -s https://btw.bitwrap.io/api/check -H 'content-type: application/json' \
  -d '{"text":"tempo 126\nkey am\ndeck A: kick x ~ x ~ | snare ~ x ~ x\n"}'
```

## Programs

- `PUT /api/programs/<cid>`: the body is the program text. Accepted iff its canonical CID is `<cid>`, it checks ok, it is not restricted
  or asset-using and it is at most 16384 bytes; stored content-addressed (idempotent), limited per IP. Answers the stored program.
- `GET /api/programs/<cid>`: `{"cid", "text", "meta": {"license": "CC0-1.0", "visibility", "name", "composed_by", "forked_from", ...}}`.
- `GET /api/programs/<cid>.btw`: the program as a `.btw` file with its `#!` header (name, license, composed-by, forked-from).

## Examples and instruments

`GET /api/examples` lists `[{"name", "title", "description", "cid", "bpm", "bars", "license"}]`; `GET /examples/<name>.btw` is the text as written.
All examples are CC0-1.0, the work of the site's author, and a good second read after the cheat-sheet: `first-beat` is four lines,
`acid-line` shows an accent, a slide and a filter ramp, `evolve-demo` a program that changes itself, and `hand-dubstep-140-v4`, `matrix-130`
and `trance-138` are whole tracks.

`GET /api/instruments` answers `{"voices": [...], "families": [...], "kits": [...], "palettes": [...]}`. A part names a voice with `inst=NAME`
and a drum kit with `kit=NAME`. A name that is not a voice is a check error with the nearest names; a family word (`inst=reese`) is accepted
with a warning that it plays the family's generic voice.

## Compose

`POST /api/compose` writes a program with a language model (Gemini Flash), checks it, and repairs it. **Signed in only**, rate limited,
and the service has a daily spend cap.

```bash
curl -s https://btw.bitwrap.io/api/compose -H 'Authorization: Bearer btw_...' -H 'content-type: application/json' \
  -d '{"prompt": "dark techno at 128 with an acid line and a long breakdown", "genre": "techno", "bpm": 128, "key": "am", "length": "medium"}'
```

Request: `prompt` (required, at most 800 characters), `genre`, `bpm` (40 to 300), `key` (`am`, `f#m`, `d:dorian`), `length`
(`short`, `medium`, `long`, or a number of bars), `base_cid` (the CID of a public program, an example or a stored one, to edit instead of starting fresh).

Response 200:

```json
{"program": "<canonical text>", "text": "<as the model wrote it, repaired>", "cid": "z4EBG9j...",
 "check": {"ok": true, "...": "a check report"},
 "attempts": [{"n": 1, "ok": false, "errors": 2, "diagnostics": [], "tokens_in": 4100, "tokens_out": 900}, {"n": 2, "ok": true, "errors": 0}],
 "model": "gemini-3.8-flash", "forkedFrom": null, "license": "CC0-1.0", "composedBy": "gemini-3.8-flash",
 "header": ["#! license: CC0-1.0", "#! composed-by: gemini-3.8-flash"],
 "render_url": "/api/render/z4EBG9j...?format=opus", "share_url": "https://btw.bitwrap.io/#z4EBG9j....<packed>",
 "cost_usd": 0.0007, "usage": {"in": 4100, "out": 1700}}
```

What happens: the request is validated and limited (kill switch, per user per hour and per day, per IP per day, the global daily spend); the
model gets the cheat-sheet, the instruments and two or three public CC0 examples; its program is checked, and while it has errors the
diagnostics go back to the model, at most 3 repair rounds. A program that never checks is **422 `unrepairable`** with the last diagnostics
and every attempt in `details`. The result is stored as a public CC0-1.0 program with `composedBy` and `forkedFrom`; the `#!` header lines live in the
stored object and the `.btw` download, never in the canonical text. A call takes about 5 to 60 seconds. Errors: `auth_required`,
`rate_limited` (with `retry_after`), `spend_cap`, `disabled`, `not_configured`, `bad_request`, `prompt_too_long`, `model_error`, `unrepairable`.
Never put anything private in a prompt: it goes to Google's model, and what comes back is published as CC0.

## Render

`GET /api/render/<cid>?format=opus|wav&sr=44100` renders a stored program offline and **streams** it as it renders: the first bytes
come within about a second for a typical program and the response is chunked, so a page or a player can start at once.

- `wav`: a streaming WAV header (RIFF and data sizes `0xFFFFFFFF`), then 16-bit stereo PCM. A page can decode it chunk by chunk.
- `opus`: Ogg Opus at 96 kb/s, smaller, for download or an `<audio>` element.
- Headers: `X-Btw-Cid`, `X-Btw-Seconds` (the length of the program), `X-Btw-Cache: hit|miss|joined` (`joined`: another request was already rendering it
  and this one follows the same file). Once complete, `Cache-Control: public, max-age=31536000, immutable`, and `Range` works.
- A render in progress is shared: later requests for the same `(cid, format, sr)` read the growing file from the start.
- The offline render plays the notes and sounds. It does **not** play control lines (filters, reverb, `do ...` lines), so it can sound plainer
  than the browser. A program with no end is cut at the bar limit (256 bars); give it `end at bar N`.
- Limits: uncached renders per IP per hour, a few renders at once (more get `busy` with `retry_after`), a maximum length, and a disk cap
  with eviction of the least recently used. A program must be stored first (`PUT /api/programs/<cid>`, the MCP `render` tool, or compose).
- `GET /api/render/<cid>/status` says how far a render is.

```bash
curl -s https://btw.bitwrap.io/api/examples | head -c 300          # find a CID
curl -sL 'https://btw.bitwrap.io/api/render/z4EBG9j...?format=opus' -o track.opus
```

## Sessions

The browser and MCP meet in a **session**. The page does `POST /api/session` (answers `{"id": "<22 characters>", "user": ...}`), then opens
`GET /api/session/<id>/events`, a server-sent event stream with the events `eval`, `load`, `stop`, `get`, `queue` and `ping` (`data` is JSON:
`text`, `cid`, `play`, and for `get` a `request_id`). While it matters the page posts its state to `POST /api/session/<id>/report` about every
500 ms (`text`, `cid`, `playing`, `source` engine or stream, `section`, `bar`, `bars_in_section`, `phase`, `marks`, `diagnostics`, `presence`, `ts`), and answers a `get`
with `POST /api/session/<id>/reply` `{"request_id", "state"}`. The server keeps the latest report of each session for 10 minutes.

A session belongs to the user that created it (cookie or token) or is anonymous. An MCP write tool targets the `session` you name, or else every live
session owned by the caller. An anonymous tab is reached only by its explicit id, which the page shows in its **MCP** panel (top bar), and the caller
must still hold a token. This is how `eval`, `load`, `stop` and `get` work.

**Up next.** A session can hold a queue of programs that MCP's `queue` tool writes (the page only shows it). When the playing program ends, or a
looping one has played its length (an item's `bars` or `minutes`, else one pass of its arrangement), the page asks
`POST /api/session/<id>/queue/next` `{"reason": "ended|length|skip|resume", "presence": {"visible", "focused", "audio", "idle_ms"}}` and plays the
`item` it is given from bar 1; `GET /api/session/<id>/queue` reads the queue. The server advances it only while a listener is plausibly present:
it pauses at the boundary (`paused_reason`) when the audio is suspended, when the tab has been hidden with no key, pointer, touch or media key for
30 minutes, or after 8 tracks in a row with no interaction, and the page shows "Still listening? Press play to continue". Only a person on the page
lifts a pause. The queue never composes or renders anything, holds at most 50 items, and goes with its session.

## MCP

`https://btw.bitwrap.io/mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server over streamable HTTP (stateless: each request stands alone, there is no event stream: a `GET` that asks for one gets 405).
A browser `GET` shows a page that lists the tools.

```bash
claude mcp add --transport http btw https://btw.bitwrap.io/mcp --header 'Authorization: Bearer btw_...'
```

Without the header the read tools still work; `eval`, `load`, `get`, `stop`, `devices` and `queue` answer an MCP tool error `auth_required` that says how to get a token
(sign in on the page and press **Create an MCP token**). Other clients take the same URL and header, for example
`{"mcpServers": {"btw": {"type": "http", "url": "https://btw.bitwrap.io/mcp", "headers": {"Authorization": "Bearer btw_..."}}}}`.

There is **no `compose` tool**: an MCP client is already a model, so it writes the program itself ([Compose](#compose) is the web app's).
The loop: read [cheatsheet.md](https://btw.bitwrap.io/docs/cheatsheet.md) and one or two `list_examples` programs, call `instruments`, write the program, call `check`
and fix every `line:col` error until `ok`, then `eval` / `load` to play it and `share` to store it. A voice whose name starts with a digit
(`808-bass`) cannot be written: `inst=808-bass` reads as the sum `808 - bass` and a quoted `inst="808-bass"` is refused ("expected a number or a
name"), so use a voice that starts with a letter (`inst=sub-bass` for a deep bass).

| tool | needs a token | arguments | does |
|---|---|---|---|
| `check` | | `text`, `same_as`? | check a program: diagnostics with line:col, cid, canonical text. **Run it before anything else and fix the errors**. With `same_as` (a CID or another program's text) it also answers whether the two are the same song by their compiled nets and song-level settings, and, when they are not, a `diff` saying what changed in music: song settings, sections inserted/removed/moved/repeated/renamed, and per part a transform (transposed, rotated, reversed, ...) or the notes changed at bar:step, each with a one-line summary |
| `fmt` | | `text` | the canonical form and its CID |
| `share` | for the short links | `text`, `license`, `forked_from`, `credits`, `name` | the self-sealing link, the social link, the CID; with a token also stores the program and gives the CID-only `short_url`, `short_social_url`, `short_beats_url` and `fetch_url` |
| `open` | | `url` | decode a link (self-sealing or CID-only: `/p/<CID>`, `/c/<CID>`, `#<CID>`, a bare CID), verified, with its rights |
| `render` | | `text` or `cid` or `example`, `format` | store the program and answer `stream_url`, `status_url`, `cid`, `seconds` |
| `record` | | `text` or `cid` or `example` | store the program and answer the demo-recording setup: `record_url` (the page in record mode), `record_url_manual_clock` (a fake clock a script steps frame by frame), `audio_url`, and the `recipe` for `btwsite/tools/record-demo.mjs` (captures nothing itself) |
| `list_examples` | | `name` | the example programs (and one's text) |
| `instruments` | | | voices, families, kits, palettes |
| `eval` | yes | `text`, `play`, `session` | send a program to a browser tab, as Cmd+Enter; lands on the next bar |
| `load` | yes | `cid` or `example` or `url`, `play`, `session` | put a stored, example or linked program into a tab |
| `get` | yes | `session` | what a tab is playing: program, cid, section n of m, bar, phase, marks, diagnostics |
| `stop` | yes | `session` | stop the tab |
| `devices` | yes | | your paired phones (pass one's id as `device` to `eval`, `load`, `get`, `stop`, `queue`) |
| `queue` | yes | `action` (list, add, remove, clear, skip), `items`, `item`, `session` | an up-next list on a tab of programs that already exist (`{cid}`, `{example}`, `{url}`, with `bars` or `minutes`); never composes; advances only while a listener is present, else `paused_reason` |

`eval`, `load`, `stop` and `get` need a browser tab open at https://btw.bitwrap.io (signed in as the token's account), or the session id from
the page's MCP panel; with no tab connected they answer `no_session` and say so. Tool failures are MCP tool results with `isError: true`
whose text is the error body above (`{"error": {"code", "message", "retry_after", "details"}}`), so a client reads the code and the words.
Calls to the checker are limited per client (about 60 a minute), programs for `render` per hour.

A raw call, to see the wire:

```bash
curl -s https://btw.bitwrap.io/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check","arguments":{"text":"tempo 126\ndeck A: kick x ~ x ~\n"}}}'
```

## Linked data (JSON-LD)

A program is also published as linked data, in the same convention as pflow.xyz: a stable, versioned `@context` URL.

```text
https://btw.bitwrap.io/context/v1.jsonld      the @context (application/ld+json, CORS *, immutable; a change is a new version, v2)
https://btw.bitwrap.io/context.jsonld         the latest version (cached five minutes)
https://btw.bitwrap.io/c/<CID>.jsonld         a program: @id, @type djrust:Program, cid, name, key, tempo, sections, licenseId
https://btw.bitwrap.io/c/<CID>.<packed>.jsonld   the same for a program the site has not stored (the link carries it)
```

`/c/<CID>` embeds that document in a `<script type="application/ld+json">` block and answers with `Link: <.../c/<CID>.jsonld>; rel="describedby"`.
The context's vocabulary is the bitwrap ontology (`https://ontology.bitwrap.io/ns#`); the MCP `share` tool returns `jsonld_url` and `context`, and `get` does too.
`btw jsonld` (djctl) names the same context URL. Genre, tags and Euclidean rhythms need the engine's ontology, so only `btw jsonld` adds them.

## Share links

```text
https://btw.bitwrap.io/#<CID>.<base64url(deflate(canonical text))>
https://beats.bitwrap.io/p#<CID>.<base64url(deflate(canonical text))>      (the same sealed part on beats.bitwrap.io)
https://btw.bitwrap.io/c/<CID>.<base64url(deflate(canonical text))>        (for posts: link unfurlers can fetch it, and it has a card image)
```

The program is **in** the link: nothing is stored for it to work, and whoever opens it recomputes the CID from the text and refuses a link
where they differ. Optional `~<base64url(deflate(notes))>` after the sealed part carries the comments, which are in neither the CID nor the
signature and are shown as unverified; an optional `.<sig>` is the author's signature over the CID. Links over about 2000 characters
may be cut by some apps; `POST /api/share` and the MCP `share` tool report `chars`. `GET /c/<CID>` shows a card for a program the site has stored.

**CID-only short links** keep the program on the site instead of in the link:

```text
https://btw.bitwrap.io/p/<CID>        (opens the page; it fetches the program and checks it against the CID)
https://beats.bitwrap.io/p/<CID>      (the same, on beats.bitwrap.io)
https://btw.bitwrap.io/c/<CID>        (for posts: the link-preview page of a stored program)
```

Store one with `PUT /api/shares/<CID>` (signed in with a cookie or `Authorization: Bearer btw_...`, or from a paired phone), body
`{"text": "<the program>", "license": "CC0-1.0", "forked_from": "<CID>", "credits": ["..."], "name": "..."}` (all but `text` optional;
at most 8 credits of 80 characters). The text must check and hash to `<CID>`; only public programs are stored (`use restricted`,
`sample`/`loop` and `#! visibility:` anything but public are refused with `restricted` and stay inline-only); the first share's
rights stay. It is limited per account (60 an hour) and per address. The MCP `share` tool does the same when called with a token.
Reading is public: `GET /api/programs/<CID>` answers `{"cid", "text", "meta"}` (the canonical text and its rights), cross-origin, and the
reader recomputes the CID from the text and refuses a mismatch, exactly as for a self-sealing link. A CID the site has not stored is `404`.

## For models

Start at [llms.txt](https://btw.bitwrap.io/llms.txt) (or [llms-full.txt](https://btw.bitwrap.io/llms-full.txt), which has the cheat-sheet and the grammar inlined),
read the [cheat-sheet](https://btw.bitwrap.io/docs/cheatsheet.md) and two or three [examples](https://btw.bitwrap.io/api/examples), take the voices from
[`/api/instruments`](https://btw.bitwrap.io/api/instruments), write, `check`, fix, then `share` or `render`.
