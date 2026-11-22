# BeatScript player, self-contained

`<beatscript-track>` is a BeatScript program and its player in one element. Everything it needs is in this package:
the engine the editor at https://beatscript.app runs (WebAssembly, inlined as base64), its drum kits, voices and the
phoneme tables `sing` uses, the AudioWorklet and the composer. Nothing is fetched from beatscript.app: the program's
CID and "Open on beatscript.app" are plain links. Sound starts only from a click.

It is made for pages with a strict Content Security Policy, such as a Claude artifact: scripts from the page's own files
or a CDN, fetches only to the page's own origin, no frames.

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@beatscript/player@0.1.0/beatscript-track.js"></script>

<beatscript-track>
  <script type="text/beatscript">
tempo 120
deck A: kick x ~ x ~ | snare ~ x ~ x
  </script>
</beatscript-track>
```

Or the same files beside the page: `<script type="module" src="./beatscript-track.js">`. A page that loads classic
scripts only can use `beatscript-track.umd.js` (it imports the module from beside itself).

| attribute | |
|---|---|
| `text` | the program, instead of the child `<script type="text/beatscript">` |
| `cid` | the CID the text must have: a text that is not that program is refused |
| `compact` | a smaller card |
| `theme` | `dark` (the default) or `light` |
| `site` | where the plain links point (default `https://beatscript.app`) |

The element fires `play` and `stop` events.

**The page must allow WebAssembly.** A CSP whose `script-src` lacks `'wasm-unsafe-eval'` (or `'unsafe-eval'`) refuses
to compile any WebAssembly module, and no wasm engine can play under it; the element then says so instead of playing.
`test/csp.html` is a page under an artifact-like policy with `'wasm-unsafe-eval'` added.

Only programs written for this engine play: a program that names sample or loop assets (`uses_assets`) has nothing to
play them from here.
