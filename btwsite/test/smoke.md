# Browser smoke run

`node btwsite/test/smoke.mjs` executes this file: headless Chrome driven by a 100-line CDP client
(`cdp.mjs`, no npm: Node's global `fetch` and `WebSocket`) against `mock-server.mjs`, a stand-in for the Go
service that speaks the routes of DESIGN.md "HTTP API" (and runs the **real wasm** for check/fmt/share/open when
`btwsite/web/wasm/` is built, else the page's JS mock). Screenshots land in `btwsite/test/shots/`.

```
node btwsite/test/smoke.mjs                            everything, against the mock server
node btwsite/test/smoke.mjs --only 2,3                 only those steps
node btwsite/test/smoke.mjs --mock-wasm                page and server on the JS mock of the wasm (?mock=1)
node btwsite/test/smoke.mjs --server http://127.0.0.1:18197   against the real Go server (btwsite -btwd ... -model fake);
                                                       the compose error cases (FAIL, LIMIT, NOKEY prompts) and the
                                                       pushed-event checks are the mock's, the real server gets the
                                                       MCP JSON-RPC variant of step 7
node --test btwsite/test/unit.mjs                      the pure-JS unit tests (no browser)
node btwsite/test/engine-decks.mjs                     each deck is heard on its own through the engine (needs the built wasm)
node btwsite/test/download-browser.mjs --server URL    the download button against a real btwsite (-btwd): links, WAV header, the bar limit, the phone path
node btwsite/test/mobile.mjs [--shots DIR]             the phone layout (412 x 915, touch) and that the desktop one is unchanged
node btwsite/test/mobile-shots.mjs --prefix before     screenshots of the page as a phone shows it, for before/after
node btwsite/test/background-browser.mjs [--seconds 30] [--mode frozen] [--without-pump]
                                                       a hidden tab keeps time (see DESIGN.md "A phone, and the page in the background")
BTW_CHROME_ARGS="--disable-audio-output" ...           extra Chrome flags for every launch: a null audio sink when the sound card is busy
node btwsite/test/mock-server.mjs --port 18197         the mock alone, to open the page by hand
```

Chrome is `/Applications/Google Chrome.app/...` (override with `CHROME=`), started with
`--autoplay-policy=no-user-gesture-required`; a click or Cmd+Enter still makes the AudioContext, as in a real
browser. Exit code 1 if any check fails or the page logs a console error.

## Steps

1. **Load.** The page loads, the module comes up, the editor shows syntax-coloured code (spans from
   `btw_highlight`), the example picker is filled from `/api/examples`, the gutter has a number per line.
   Shot `01-load.png`.
2. **A broken program.** Type `deck A: kick | snare ~ x` and `foo bar`. A red squiggle under the span, a red mark in
   the gutter, "2 errors" in the problems bar; its row reads `2:14 error: ...`, `expected: ...` and
   `did you mean: kick x ~ x ~`; hovering the squiggle shows the message; clicking the row puts the caret on the span.
   Fix the text: squiggles gone, "no problems". Shot `02-error.png`.
3. **An example, evaluated.** Pick an example (nothing plays). Cmd+Enter: it plays; the header says
   `section n/m`; gutter dots light on playing lines, a token flashes (a lamp behind it), the section bar is under
   the section's header line, one phrase light is current. Typing afterwards hides the markers (they wait for the next
   eval) and the header says so. Esc stops. With the engine loaded (it loads behind the first stream), Cmd+Enter plays
   on the engine, the header names the section again after a stop and a play, the next edit hot-reloads on the same
   runtime (no restart), and the decks panel (the chevron) lists each deck's roles (`15-decks.png`). Shot `03-playing.png`.
4. **Sections advance and the editor follows.** A 4-section program at 240 bpm with the second section far below
   the fold: the header goes to the second section, the editor scrolls down to it; `L` toggles follow off and on.
   Shot `04-follow.png`.
5. **fmt, share, open.** fmt puts the canonical text in the editor and Cmd+Z restores the old text; share shows
   the self-sealing link (`https://.../#<CID>.<packed>`, its character count, the social `/c/` form) and puts it in the
   address bar; a fresh load of that link shows the program, a verified banner and a Play button and does **not**
   play; the banner's Play starts the stream; a link with a wrong CID is refused loudly and its text not loaded;
   a bare `#<CID>` is fetched and verified. Shots `05-share.png`, `06-open-link.png`.
6. **Compose, sign-in, MCP** (mock server only). Compose is visible but disabled until signed in, with the reason;
   sign in with a browser-local Ed25519 key (`btw-ed25519-v1` in localStorage); compose with the fake model puts the
   program in the editor and starts the stream at once; `FAIL`, `LIMIT` and `NOKEY` prompts show
   "unrepairable: see attempts" (with the attempts and their diagnostics), "rate limited, try again in 38 s" and "compose
   is not configured"; the MCP panel shows the session id and a created token once, with the `claude mcp add` line.
   Shots `07` to `11`.
7. **The MCP bridge.** Mock server: the page opens a session and an event stream; a pushed `eval` (with `play`) sets
   the text and plays; the page's report carries text, cid, playing, source and marks; a pushed `get` is answered with
   a reply; a pushed `stop` stops. Real server: the page signs in, makes a token in its MCP panel, and JSON-RPC to
   `/mcp` (`eval` with `play`, `get`, `stop`) drives the tab.
8. **A phone and a failed module.** At 390 x 844 nothing overflows horizontally and the editor keeps most of the
   screen (`12-phone.png`). With `?wasm=off` the page says the module could not be loaded and stays a working plain
   editor (`13-no-wasm.png`).
9. **Record mode.** `?record=1&clock=manual&example=hand-dubstep-140-v4` at 1920 x 1080: `window.__btw.ready`,
   `info()`; no AudioContext is made; the chrome is hidden; stepping the fake clock (`setTime`, `frame`) to the same
   times twice gives byte-identical screenshots; bar 0 is at t = 0 (section 2 begins at 13.714 s, no bar of lag);
   `?record=1&cid=<CID>` works too; a new generation flashes the evolve block and says `gen N`
   (`16-evolve-flash-record.png`); `prefers-reduced-motion` is read. Shot `14-record-1920x1080.png`.
10. **No console errors** on any page (the deliberate 4xx/5xx of the compose error cases excepted).
11. **Hostile input and secrets** (the SEC-3 review; runs on the mock and on the real server): a mangled link (`#%`) does not
   stop the page from starting and a link that turns mangled later is refused in words with no unhandled rejection; a 33 KB link
   that inflates to ~1 MiB of program (minutes of checking in the page's one thread) and a 64 MiB deflate bomb are refused before
   the module is asked; hostile program text, names and a hostile `#! name:` are text (only the page's own `c-*` spans in the
   highlighted layer, no handlers, no images, a cleaned title); pushed events (over-long text, path tricks in a CID or example
   name, a `javascript:` URL, another origin) make the page fetch nothing and do nothing; a `#! visibility: private` program is
   never streamed or reported to an assistant (no text, CID, section, marks or diagnostics) and has no share link; streaming a
   public program says the server keeps it; the browser key is a non-extractable CryptoKey in IndexedDB with only its public half
   in localStorage, it signs again after a reload, "Forget this key" removes it everywhere, and a challenge that is not this
   site's sign-in message is never signed; a shown MCP token survives the panel's re-renders, leaves the DOM when the panel
   closes and is nowhere else; `?mock=1` does nothing off this machine; on the real server (and under `--strict-csp`) the
   headers say no framing, no plugins, no `unsafe-inline`/`unsafe-eval` scripts; every control has an accessible name and each
   panel takes the focus, closes on Esc and gives the focus back.

## What it does not cover

Real audio output (headless Chrome plays into nowhere): the stream's scheduling is covered by the unit tests on a
fake AudioContext, the engine's sound by R2's own tests. `?mock=1` pages use a silent mock engine. Wallet sign-in
(`window.ethereum`) is unit-tested with a fake provider only.

When the Mac's audio device is stuck, headless Chrome's AudioContext clock stands still and steps 3 and 4 time out (the markers
never advance). That is the machine, not the page: run with `CHROME=<a script that execs Chrome with --disable-audio-output "$@">`,
which gives the page a null audio sink driven by the wall clock.
