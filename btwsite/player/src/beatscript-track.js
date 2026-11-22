// <beatscript-track>: a BeatScript program and its player, self-contained (project-datum 6669).
//
//   <script type="module" src="https://cdn.jsdelivr.net/npm/<package>@<version>/beatscript-track.js"></script>
//   <beatscript-track>
//     <script type="text/beatscript">
//   tempo 120
//   deck A: kick x ~ x ~
//     </script>
//   </beatscript-track>
//
// or `text="…"` instead of the child script, or the files beside the page (`./beatscript-track.js`). Attributes:
// compact, theme (dark | light), cid (optional: the CID the text must have; a text that is not it is refused), site
// (where the plain links point, default https://beatscript.app).
//
// Everything the player needs is in the package: the engine (the same wasm the editor runs, its kits, voices and the
// sing phoneme tables built in, the module inlined as base64 so it is never fetched: a page whose connect-src is 'self'
// can still load it from a CDN), the worklet, the composer, this element. Nothing is fetched from beatscript.app: the
// CID and "Open on beatscript.app" are plain links. Sound starts only from a click. The styles are a constructed
// stylesheet in the shadow root (no <style>, no style attribute), so a page whose style-src is 'self' shows them.
//
// The page's CSP must allow WebAssembly: script-src needs 'wasm-unsafe-eval' (or 'unsafe-eval'); without it no wasm
// engine can run, and the element says so.

import { makeFacade } from './js/wasm.js';
import { createEngine } from './js/engine.js';
import { positionModel } from './js/embed-model.js';

const TICK_MS = 25;
const SITE = 'https://beatscript.app';
const CID_RE = /^z[1-9A-HJ-NP-Za-km-z]{20,120}$/;

const CSS = `
:host { display: block; max-width: 480px; font: 14px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --bg: #16213e; --ink: #eceef6; --dim: #8d95b0; --line: #243055; --btn: #0f3460; --btn-hover: #1a4a7a; --accent: #e94560; --link: #88aaff; }
:host([theme="light"]) { --bg: #f6f7fb; --ink: #1a1a2e; --dim: #5d6585; --line: #d6d9e6; --btn: #dfe6f7; --btn-hover: #c9d5f2; --accent: #c2304a; --link: #2b4fb3; }
.card { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; padding: 14px 16px; background: var(--bg); color: var(--ink);
  border: 1px solid var(--line); border-radius: 4px; min-height: 152px; box-sizing: border-box; align-items: center; }
:host([compact]) .card { min-height: 80px; padding: 8px 12px; }
button { grid-row: 1 / span 2; width: 64px; height: 64px; border-radius: 50%; border: 0; background: var(--btn); color: var(--ink); cursor: pointer; font-size: 24px; }
:host([compact]) button { width: 44px; height: 44px; font-size: 16px; }
button:hover:not(:disabled) { background: var(--btn-hover); }
button:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
button:disabled { opacity: .45; cursor: default; }
button.playing { color: var(--accent); }
.body { min-width: 0; }
.name { font-size: 16px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin: 0; }
p { margin: 2px 0 0; }
.pos { font-variant-numeric: tabular-nums; }
.dim, .state { color: var(--dim); }
.links { font-size: 12px; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
a { color: var(--link); }
.state:empty { display: none; }
`;

let sheet = null;
function styles() {
  if (!sheet && typeof CSSStyleSheet === 'function') {
    try { sheet = new CSSStyleSheet(); sheet.replaceSync(CSS); } catch { sheet = null; }
  }
  return sheet;
}

/** The module, once per page: compiled from the inlined bytes (a dynamic import, so nothing loads before a click). */
let shared = null;
function loadModule() {
  if (!shared) {
    shared = (async () => {
      const [{ WASM_BASE64 }, glue] = await Promise.all([import('./wasm/btw_bg.wasm.b64.js'), import('./wasm/btw.js')]);
      const bin = atob(WASM_BASE64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      let module;
      try {
        module = await WebAssembly.compile(bytes);
      } catch (e) {
        throw new Error(/unsafe-eval|Content Security/i.test(String(e)) ? 'this page does not allow WebAssembly (its CSP needs \'wasm-unsafe-eval\'), so it cannot play here' : String(e.message || e));
      }
      glue.initSync({ module });
      return { module, btw: makeFacade(glue) };
    })();
    shared.catch(() => { shared = null; });
  }
  return shared;
}

/** The program text: the `text` attribute, else the first child <script type="text/beatscript">, else the element's text. */
function sourceOf(el) {
  const a = el.getAttribute('text');
  if (a != null) return a;
  const s = el.querySelector('script[type="text/beatscript"], script[type="text/x-beatscript"]');
  const t = s ? s.textContent : el.textContent;
  // the indentation of the markup is not part of the program
  const lines = String(t || '').replace(/^\n+/, '').replace(/\s+$/, '').split('\n');
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
  return lines.map((l) => l.slice(Number.isFinite(ind) ? ind : 0)).join('\n') + '\n';
}

/** `#! name:`, else ''. */
function nameOf(text) {
  const m = /^#!\s*name:\s*(.+)$/m.exec(text);
  return m ? m[1].trim() : '';
}

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
};

export class BeatscriptTrack extends HTMLElement {
  constructor() {
    super();
    this.ctx = null;
    this.engine = null;
    this.run = null;
    this.btw = null;
    this.sections = [];
    this.timer = 0;
    this.playing = false;
    this.busy = false;
    /** The decks whose nets the engine has installed. */
    this.installed = new Set();
  }

  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: 'open' });
    const s = styles();
    if (s) root.adoptedStyleSheets = [s];
    this.text = sourceOf(this);
    const site = (this.getAttribute('site') || SITE).replace(/\/+$/, '');
    this.btn = h('button', { type: 'button', 'aria-label': 'Play', part: 'play' }, '▶');
    this.sec = h('span', {}, 'not playing');
    this.bar = h('span', { class: 'dim' });
    this.state = h('span', { class: 'state', role: 'status', 'aria-live': 'polite' });
    this.linkLine = h('p', { class: 'links' });
    const name = nameOf(this.text) || 'BeatScript';
    root.replaceChildren(h('div', { class: 'card', part: 'card' }, this.btn, h('div', { class: 'body' }, h('p', { class: 'name' }, name), h('p', { class: 'pos' }, this.sec, ' ', this.bar, ' ', this.state), this.linkLine)));
    this.site = site;
    this.btn.addEventListener('click', () => this.toggle());
    // the CID and the link are known once the module is loaded (its check names the CID); until then, the expected one
    const want = this.getAttribute('cid');
    if (want && CID_RE.test(want)) this.showLinks(want, null);
  }

  disconnectedCallback() {
    this.stop();
  }

  say(t) {
    this.state.textContent = t;
  }

  showLinks(cid, url) {
    const kids = [h('a', { href: `${this.site}/p/${cid}`, target: '_blank', rel: 'noopener' }, cid.slice(0, 10) + '…')];
    kids.push(' · ', h('a', { href: url || `${this.site}/p/${cid}`, target: '_blank', rel: 'noopener' }, 'Open on beatscript.app'));
    this.linkLine.replaceChildren(...kids);
  }

  paint() {
    const st = this.run && this.playing ? this.run.status() : null;
    const m = positionModel(st, this.sections, this.playing);
    this.sec.textContent = m.sec;
    this.bar.textContent = m.bar;
    this.btn.textContent = this.playing ? '■' : '▶';
    this.btn.classList.toggle('playing', this.playing);
    this.btn.setAttribute('aria-pressed', String(this.playing));
    this.btn.setAttribute('aria-label', this.playing ? 'Stop' : 'Play');
  }

  toggle() {
    if (this.busy) return;
    if (this.playing) this.stop();
    else this.start();
  }

  async start() {
    this.busy = true;
    if (!this.ctx) this.ctx = new AudioContext({ latencyHint: 'playback' });
    const resumed = this.ctx.resume();
    this.say('loading…');
    try {
      await resumed;
      const { module, btw } = await loadModule();
      this.btw = btw;
      const rep = btw.check(this.text);
      if (!rep || !rep.ok) {
        const d = rep && rep.diagnostics && rep.diagnostics.find((x) => x.severity === 'error');
        throw new Error(d ? `line ${d.line}: ${d.message}` : 'the program does not check');
      }
      const want = this.getAttribute('cid');
      if (want && want !== rep.cid) throw new Error(`refused: the text is ${rep.cid}, not ${want}`);
      const sh = btw.share(this.text);
      this.showLinks(rep.cid, sh && sh.ok ? sh.url.replace(/^https?:\/\/[^/#]+/, this.site) : null);
      this.sections = rep.sections || [];
      if (!this.engine) {
        this.engine = await createEngine({ context: this.ctx, module });
        this.engine.on('error', (e) => this.say(e.message));
        this.engine.on('grid', () => this.tick());
        this.engine.on('installed', (e) => this.installed.add(e.deck));
      }
      if (!this.run) this.run = btw.newRun();
      const ev = this.run.eval(this.text);
      if (!ev || !ev.ok) throw new Error('it does not play');
      this.playing = true;
      this.say('');
      this.timer = setInterval(() => this.tick(), TICK_MS);
      this.tick();
      this.dispatchEvent(new CustomEvent('play', { detail: { cid: rep.cid } }));
    } catch (e) {
      this.say(String(e.message || e));
    } finally {
      this.busy = false;
      this.paint();
    }
  }

  tick() {
    if (!this.playing || !this.run || !this.engine) return;
    this.engine.apply(this.run.service(this.engine.grid()));
    const st = this.run.status();
    if (st && st.ended) return this.stop();
    this.paint();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = 0;
    if (this.run && this.engine && this.playing) this.engine.apply(this.run.stop());
    if (this.playing) this.dispatchEvent(new CustomEvent('stop'));
    this.playing = false;
    if (this.btn) this.paint();
  }

  /** What the tests read: playing, the section and bar line, the engine's composer, the state line. */
  get report() {
    return { playing: this.playing, sec: this.sec && this.sec.textContent, bar: this.bar && this.bar.textContent, state: this.state && this.state.textContent, composer: this.engine ? this.engine.composer : null, installed: [...this.installed].sort(), cid: this.run ? this.run.cid() : null };
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('beatscript-track')) customElements.define('beatscript-track', BeatscriptTrack);
