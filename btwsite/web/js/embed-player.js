// The embed player (/embed/<CID>, btwserve cards/embed.rs): one stored program, played in the browser by the same wasm
// engine the editor uses (wasm.js + engine.js), started only by a click. The page carries the program as the editor's
// <beatscript-view> block; this reads it, checks that its text is its CID, and plays and stops it. Nothing is written,
// stored or signed: an embed only listens.

import { readProgramView } from './program-ld.js';
import { loadBtw } from './wasm.js';
import { createEngine } from './engine.js';
import { Resolver } from './closure.js';
import { positionModel, sectionDoc } from './embed-model.js';

const TICK_MS = 25;
const $ = (id) => document.getElementById(id);

class EmbedPlayer {
  constructor() {
    this.btn = $('bsp-play');
    this.sec = $('bsp-sec');
    this.bar = $('bsp-bar');
    this.state = $('bsp-state');
    // the section's doc line: only on a page whose program documents a section; the server writes the first one's
    this.doc = $('bsp-doc');
    this.idleDoc = this.doc ? this.doc.textContent : '';
    this.docs = [];
    this.program = null;
    this.ctx = null;
    this.btw = null;
    this.engine = null;
    this.run = null;
    this.sections = [];
    this.timer = 0;
    this.playing = false;
    this.busy = false;
  }

  init() {
    try {
      this.program = readProgramView(document);
    } catch (e) {
      return this.say(String(e.message || e));
    }
    if (!this.program) return this.say('this page has no program');
    this.docs = Array.isArray(this.program.doc.section) ? this.program.doc.section : [];
    if (!window.AudioContext || !('audioWorklet' in AudioContext.prototype)) return this.say('this browser cannot play it here: open it in BeatScript');
    this.btn.disabled = false;
    this.btn.addEventListener('click', () => this.toggle());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.playing) this.stop();
    });
  }

  say(text) {
    this.state.textContent = text;
  }

  paint() {
    const st = this.run && this.playing ? this.run.status() : null;
    const m = positionModel(st, this.sections, this.playing);
    this.sec.textContent = m.sec;
    this.bar.textContent = m.bar;
    if (this.doc) this.doc.textContent = this.playing ? sectionDoc(st, this.sections, this.docs) : this.idleDoc;
    this.btn.classList.toggle('playing', this.playing);
    this.btn.setAttribute('aria-pressed', String(this.playing));
    this.btn.setAttribute('aria-label', `${this.playing ? 'Stop' : 'Play'} ${this.program ? this.program.name || 'the program' : ''}`.trim());
  }

  toggle() {
    if (this.busy) return;
    if (this.playing) this.stop();
    else this.start();
  }

  /** The module and the engine, once: only after the click (no wasm is fetched for an embed nobody plays). */
  async ready() {
    if (!this.btw) {
      this.btw = await loadBtw();
      // a program that imports: what it draws on is fetched by CID from this site, as the editor does (closure.js)
      this.resolver = new Resolver({
        fetchProgram: async (cid) => {
          const r = await fetch(`/api/programs/${encodeURIComponent(cid)}`);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        },
        know: this.btw.know,
      });
    }
    this.resolver.want(this.program.text);
    await this.resolver.settled();
    if (!this.engine) {
      this.engine = await createEngine({ context: this.ctx });
      this.engine.on('error', (e) => this.say(e.message));
      // the worklet's own report keeps the runtime serviced while timers are throttled (a hidden tab)
      this.engine.on('grid', () => this.tick());
    }
  }

  async start() {
    this.busy = true;
    // the context is made and resumed inside the click: the browser's autoplay rule
    if (!this.ctx) this.ctx = new AudioContext({ latencyHint: 'playback' });
    const resumed = this.ctx.resume();
    this.say('loading…');
    try {
      await resumed;
      await this.ready();
      if (!this.run) this.run = this.btw.newRun();
      const ev = this.run.eval(this.program.text);
      if (!ev || !ev.ok) throw new Error('it does not play here: open it in BeatScript');
      if (ev.cid && ev.cid !== this.program.cid) throw new Error('refused: the page\'s program is not its CID');
      // the sections, for `name n/m`: the check's (eval does not list them)
      const rep = this.btw.check(this.program.text);
      this.sections = (rep && rep.sections) || [];
      this.playing = true;
      this.say('');
      this.timer = setInterval(() => this.tick(), TICK_MS);
      this.tick();
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
    if (this.run && this.engine) this.engine.apply(this.run.stop());
    this.playing = false;
    this.paint();
  }
}

const player = new EmbedPlayer();
window.__bsp = player; // for the browser tests
player.init();
