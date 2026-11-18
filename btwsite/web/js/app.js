// The page. One App wires the editor, the checker, the driver (BtwRun + a clock), the marker painter,
// the header, the transport and the server. The same renderFrame(now) paints every frame: in the page
// it is called from requestAnimationFrame with the wall clock, in record mode (?clock=manual) from
// window.__btw.frame() with a fake clock, and nothing in it depends on which.

import { loadBtw } from './wasm.js';
import { makeApi } from './api.js';
import { Editor } from './editor.js';
import { MarkerPainter } from './markers.js';
import { deriveModel } from './markers-model.js';
import { Follow } from './follow.js';
import { Driver, EngineSource, VirtualSource, ManualClock } from './driver.js';
import { StreamPlayer } from './stream-player.js';
import { headerModel, programName } from './header-model.js';
import { describeError, diagLine, diagDetails, summary, ApiError } from './errors.js';
import { h, debounce, fmtTime, shortCid, mapCaret, clamp, CID_RE, MAX_LOAD_TEXT, trunc, cleanName, isLoopbackHost, marksPrivate } from './util.js';
import { fragmentOf, guardLink } from './link.js';
import { lineStarts, lineOf, makeByteMapper, spanRange } from './geometry.js';
import { early, install } from './record.js';

const STARTER = `# a first program: drums on deck A, harmony and an arpeggio on deck B.
tempo 126
key am

deck A: kick e(5,8) | snare ~ x ~ x | bass markov(am, 0.7) | hihat x*8 vel=60..90
deck B: harmony chord(am7) | arp arp(am7, up, 8)

on phrase: deck A: filter lp 12k -> 400 over 4 bars
master: filter lp 2k -> 8k over 8 bars
`;

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window */ } },
};

export class App {
  constructor() {
    const q = new URLSearchParams(location.search);
    this.q = q;
    // the JS stand-in for the module (no real CIDs, a line-shape check) is for development: a link cannot switch it on elsewhere
    this.mock = q.get('mock') === '1' && isLoopbackHost(location.hostname);
    this.record = q.get('record') === '1';
    this.manual = q.get('clock') === 'manual';
    this.reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.api = makeApi();
    this.btw = null;
    this.driver = null;
    this.follow = new Follow();
    this.follow.on = store.get('btw-follow', '1') !== '0';
    this.ctx = null; this.master = null; this.analyser = null;
    this.engine = null; this.engineSrc = null; this.engineState = 'idle'; this.engineError = '';
    this.sourcePref = 'auto';
    this.info = null; this.examples = [];
    this.report = null; // the check of the text in the editor
    this.evalReport = null; // the check of the text the running program was evaluated from
    this.cid = null; this.name = ''; this.stored = new Set();
    this.user = null;
    this.player = null;
    this.clock = null; // ManualClock in record mode
    this.runId = 0; this._lastRun = null;
    this.busy = false;
    this.timeScale = 1;
    this.edgesSig = '';
    this._last = {};
    this.listeners = new Set();
  }

  // ---- boot --------------------------------------------------------------------------------------------

  async start() {
    document.documentElement.classList.toggle('record', this.record);
    early(this);
    this.dom();
    const mod = $('k-mod');
    if (mod && !/Mac|iPhone|iPad/.test(navigator.platform || '')) mod.textContent = 'Ctrl';
    this.editor = new Editor($('ed'), {
      onInput: (t, o) => this.onInput(t, o),
      onEval: () => this.play('eval'),
      onStop: () => this.stop(),
      onCursor: (l, c, d) => this.onCursor(l, c, d),
    });
    this.painter = new MarkerPainter(this.editor);
    this.wire();
    this.setProgram(STARTER, { name: 'starter', quiet: true, keepHash: true });
    this.renderHeader(null, true);
    this.updateTransport();

    const boot = [this.loadWasm(), this.loadInfo()];
    if (!this.record) boot.push(this.loadAuth());
    await Promise.all(boot);
    await this.loadInitial();
    if (!this.manual) this.loop();
    await install(this);
    if (!this.manual) this.startSession();
  }

  dom() {
    const ids = ['top', 'hdr', 'h-sec', 'h-sec-txt', 'h-bar', 'h-phrase', 'h-gen', 'h-state', 'h-prog-fill', 'btn-follow', 'banner', 'problems', 'pr-sum', 'pr-sum-txt', 'pr-first', 'pr-dot', 'pr-list', 'decks', 'btn-play', 'btn-decks', 't-source', 'src-engine', 'src-stream', 't-status', 't-bpm', 't-time', 'level', 'meter', 'examples', 'h-name', 'toasts', 'btn-fmt', 'btn-share', 'btn-open', 'btn-compose', 'btn-mcp', 'btn-user', 'user-lbl', 'drawer', 'drawer-title', 'drawer-body', 'drawer-close', 't-hint'];
    this.el = {};
    for (const id of ids) this.el[id] = $(id);
    this.lights = [...this.el['h-phrase'].children];
  }

  wire() {
    const el = this.el;
    el['btn-play'].addEventListener('click', () => (this.isPlaying() ? this.stop() : this.play('eval')));
    el['btn-fmt'].addEventListener('click', () => this.fmt());
    el['btn-share'].addEventListener('click', () => this.panel('share'));
    el['btn-open'].addEventListener('click', () => this.panel('open'));
    el['btn-compose'].addEventListener('click', () => this.panel('compose'));
    el['btn-mcp'].addEventListener('click', () => this.panel('mcp'));
    el['btn-user'].addEventListener('click', () => this.panel('user'));
    el['drawer-close'].addEventListener('click', () => this.closePanel());
    el['btn-follow'].addEventListener('click', () => this.setFollow(!this.follow.on));
    el['btn-decks'].addEventListener('click', () => {
      const open = el.decks.hidden;
      el.decks.hidden = !open;
      el['btn-decks'].setAttribute('aria-expanded', String(open));
    });
    el['pr-sum'].addEventListener('click', () => {
      const open = el['pr-list'].hidden;
      el['pr-list'].hidden = !open;
      el['pr-sum'].setAttribute('aria-expanded', String(open));
    });
    el.examples.addEventListener('change', () => this.loadExample(el.examples.value));
    for (const b of el['t-source'].querySelectorAll('button')) b.addEventListener('click', () => this.setSourcePref(b.dataset.src));
    el.level.value = store.get('btw-level', '0.8');
    el.level.addEventListener('input', () => {
      store.set('btw-level', el.level.value);
      this.applyLevel();
    });
    // the user's scrolling pauses the follow
    this.editor.scroller.addEventListener('scroll', () => {
      if (!this.record && this.follow.observe(this.editor.scroller.scrollTop, this.clockNow())) this.updateFollowButton();
    }, { passive: true });
    // the first gesture makes the AudioContext (it may not start before one)
    const gesture = () => { if (!this.manual && !this.ctx && this.audioWanted()) this.ensureAudio(); };
    document.addEventListener('pointerdown', gesture, { capture: true });
    document.addEventListener('keydown', (e) => this.globalKey(e), { capture: true });
    window.addEventListener('hashchange', () => this.openHash().catch((e) => this.showError(e)));
    window.addEventListener('resize', () => this.editor.measureNow());
    this.updateFollowButton();
  }

  audioWanted() {
    return true;
  }

  globalKey(e) {
    const typing = e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.isContentEditable);
    const mod = e.metaKey || e.ctrlKey;
    if (!this.ctx && !this.manual && (mod || e.key === 'Enter')) this.ensureAudio();
    if (e.target === this.editor.ta) return; // the editor handles its own keys
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      this.play('eval');
    } else if (e.key === 'Escape') {
      if (!this.el.drawer.hidden || this.pop) this.closePanel();
      else this.stop();
    } else if (mod && e.key === '.') {
      e.preventDefault();
      this.stop();
    } else if (!typing && !mod && !e.altKey && (e.key === 'l' || e.key === 'L')) {
      this.setFollow(!this.follow.on);
    }
  }

  // ---- wasm, server info, auth ----------------------------------------------------------------------------

  async loadWasm() {
    try {
      if (this.q.get('wasm') === 'off') throw new Error('the module is switched off by ?wasm=off');
      this.btw = await loadBtw({ mock: this.mock });
      this.driver = new Driver(this.btw);
      this.editor.setHighlighter((t) => this.btw.highlight(t));
      this.wasmOk = true;
      this.updateTransport();
    } catch (e) {
      this.wasmOk = false;
      console.warn('btw: the module did not load', e);
      this.banner({ kind: 'error', text: 'The btw module could not be loaded, so checking, formatting and sound are off. You can still edit text.', detail: String(e && e.message ? e.message : e) });
      this.el['btn-play'].disabled = true;
      this.el['btn-fmt'].disabled = true;
      this.el['btn-share'].disabled = true;
    }
  }

  async loadInfo() {
    try {
      this.info = await this.api.info();
      this.serverOk = true;
    } catch {
      this.serverOk = false;
    }
    try {
      this.examples = (await this.api.examples()) || [];
      if (!Array.isArray(this.examples)) this.examples = this.examples.examples || [];
    } catch { this.examples = []; }
    const sel = this.el.examples;
    for (const ex of this.examples) sel.append(h('option', { value: ex.name, title: ex.description || '' }, ex.title || ex.name));
    this.updateTransport();
  }

  async loadAuth() {
    try {
      const r = await this.api.me();
      this.user = (r && r.user) || null;
    } catch { this.user = null; }
    this.updateUser();
  }

  updateUser() {
    const u = this.user;
    this.el['user-lbl'].textContent = u ? `${(u.address || u.id || '').slice(0, 6)}…${(u.address || '').slice(-4)}` : 'sign in';
    this.el['btn-user'].title = u ? `Signed in as ${u.id}` : 'Sign in';
    this.emit('user');
  }

  // ---- loading programs ---------------------------------------------------------------------------------

  async loadInitial() {
    const q = this.q;
    try {
      if (q.get('example')) return await this.loadExample(q.get('example'), { quiet: true });
      if (q.get('cid')) return await this.loadByCid(q.get('cid'));
    } catch (e) {
      this.showError(e);
      return;
    }
    if (location.hash.length > 1) return this.openHash();
    // no link: the first example makes a better page than an empty editor
    if (this.examples.length && !this.record) {
      const ex = this.examples.find((e) => /dubstep|matrix|trance/.test(e.name)) || this.examples[0];
      try { await this.loadExample(ex.name, { quiet: true }); } catch { /* the starter stays */ }
    }
  }

  /** Put `text` in the editor. It does not play: sound waits for an eval. */
  setProgram(text, { name, cid, quiet, keepHash, example } = {}) {
    if (typeof text !== 'string') throw new ApiError({ code: 'bad_request', message: 'there was no program text' });
    if (text.length > MAX_LOAD_TEXT) throw new ApiError({ code: 'bad_request', message: `that program is ${text.length.toLocaleString('en-US')} characters; the page loads programs of at most ${MAX_LOAD_TEXT.toLocaleString('en-US')} from a link, the server or an assistant (type or paste it in to work on something larger)` });
    // a link in the address bar names the program that was opened or shared, not the one loaded now
    if (!keepHash && location.hash.length > 1) history.replaceState(null, '', location.pathname + location.search);
    this.editor.setText(text);
    if (!example) this.el.examples.value = '';
    this.editor.scroller.scrollTop = 0;
    this.follow.reset();
    this.name = name || '';
    this.runCheckNow();
    this.cid = (this.report && this.report.cid) || cid || null;
    this.updateName();
    if (!quiet) this.emit('program');
  }

  updateName() {
    const n = this.name && this.name !== 'starter' ? cleanName(this.name) : programName(this.editor.text, this.cid);
    this.el['h-name'].textContent = n;
    this.progName = n;
    document.title = this.name && this.name !== 'starter' ? `${n} · btw` : 'btw, the bitwrap language';
  }

  async loadExample(name, { play, quiet } = {}) {
    if (!name) return;
    const text = await this.api.exampleText(name);
    const ex = this.examples.find((e) => e.name === name);
    this.setProgram(String(text), { name: (ex && ex.title) || name, cid: ex && ex.cid, quiet, example: true });
    this.el.examples.value = name;
    if (play) await this.play('load');
  }

  async loadByCid(cid, { play } = {}) {
    if (!CID_RE.test(cid)) throw new ApiError({ code: 'bad_request', message: `${trunc(JSON.stringify(String(cid)), 80)} is not a CID` });
    const p = await this.api.getProgram(cid);
    const text = p.text;
    this.setProgram(text, { name: (p.meta && p.meta.name) || '', cid });
    if (!this.report || !this.report.ok || this.report.cid !== cid) {
      const got = this.report && this.report.cid;
      this.banner({ kind: 'error', text: `Refused: the server's text for ${shortCid(cid)} is a different program${got ? ` (${shortCid(got)})` : ''}. It was not loaded to play.` });
      throw new Error('cid mismatch');
    }
    this.stored.add(cid);
    if (play) await this.play('load');
  }

  /** #<CID>.<packed> (decode and verify, never play by itself) or a bare #<CID> (fetch it). */
  async openHash() {
    const frag = fragmentOf(location.hash); // a malformed %-escape (#%) is a mangled link, not a crash
    if (!frag) return;
    await this.openAny(frag, { from: 'link' });
  }

  async openAny(input, { from } = {}) {
    const s = String(input || '').trim();
    if (!s) return;
    try {
      if (CID_RE.test(s)) {
        const p = await this.api.getProgram(s);
        this.setProgram(p.text, { name: (p.meta && p.meta.name) || '', cid: s, keepHash: true });
        if (!this.report.ok || this.report.cid !== s) {
          this.banner({ kind: 'error', text: `Refused: the server's program for ${shortCid(s)} hashes to ${shortCid(this.report.cid || 'nothing')}. Not loaded.` });
          return;
        }
        this.openedBanner(s, 'fetched by CID and checked');
        return;
      }
      if (!this.btw) throw new Error('the module is not loaded, so a link cannot be opened');
      // what a link inflates to is looked at before the module checks it: a few KB can say a megabyte of program
      const g = await guardLink(s);
      if (!g.ok) {
        this.banner({ kind: 'error', text: `Refused: ${g.error}.` });
        return;
      }
      const r = this.btw.open(s);
      if (!r.ok || !r.verified) {
        this.banner({ kind: 'error', text: `Refused: ${String(r.error || 'the link does not match its own CID').replace(/^refused:\s*/i, '')}.` });
        return;
      }
      this.setProgram(r.canonical, { cid: r.cid, keepHash: true });
      this.openedBanner(r.cid, 'link verified: its text hashes to its CID', r.warnings);
    } catch (e) {
      this.showError(e);
    } finally {
      void from;
    }
  }

  openedBanner(cid, how, warnings) {
    this.banner({
      kind: 'ok',
      html: [h('span', { class: 'grow' }, h('b', {}, 'Opened. '), `${how} · `, h('code', {}, shortCid(cid, 8, 8)), ' · nothing is playing until you press Play.', warnings && warnings.length ? ` (${warnings.join('; ')})` : '')],
      actions: [{ label: 'Play', primary: true, run: () => this.play('load') }, { label: 'Dismiss', run: () => this.banner(null) }],
    });
  }

  // ---- editor events ----------------------------------------------------------------------------------------

  onInput(_text, opts) {
    // the address bar named the program that was opened or shared; once the text is edited it names a different one
    if (!(opts && opts.programmatic) && location.hash.length > 1) history.replaceState(null, '', location.pathname + location.search);
    this.checkSoon();
    this.updateName();
    this.updateStale();
    this.emit('edit');
  }

  checkSoon() {
    if (!this._checkSoon) this._checkSoon = debounce(() => this.runCheckNow(), 220);
    this._checkSoon();
  }

  runCheckNow() {
    if (this._checkSoon) this._checkSoon.cancel();
    if (!this.btw) return null;
    const text = this.editor.text;
    let r;
    try { r = this.btw.check(text); } catch (e) { console.warn('btw: check failed', e); return null; }
    this.report = r;
    this.reportText = text;
    this.editor.setDiagnostics(r.diagnostics || []);
    this.renderProblems();
    this.emit('check');
    return r;
  }

  onCursor(line, vcol, diag) {
    const rows = this.el['pr-list'].children;
    const diags = (this.report && this.report.diagnostics) || [];
    for (let i = 0; i < rows.length; i++) rows[i].firstChild && rows[i].firstChild.classList.toggle('cur', diags[i] === diag);
  }

  renderProblems() {
    const r = this.report;
    const ds = (r && r.diagnostics) || [];
    const sumEl = this.el['pr-sum-txt'];
    sumEl.textContent = r ? summary(r) : '';
    const errs = ds.filter((d) => d.severity !== 'warning');
    this.el['pr-dot'].className = `pr-dot ${errs.length ? 'error' : ds.length ? 'warn' : ''}`;
    const first = errs[0] || ds[0];
    this.el['pr-first'].textContent = first ? `${first.line}:${first.col} ${first.message}` : '';
    const list = this.el['pr-list'];
    list.replaceChildren(...ds.map((d) => {
      const b = h('button', { type: 'button', class: 'pr-row', title: 'Jump to this' }, h('span', { class: 'pos' }, `${d.line}:${d.col}`), h('span', { class: `sev-${d.severity || 'error'}` }, `${d.severity || 'error'}: `), d.message,
        ...diagDetails(d).map((t) => h('span', { class: `more${t.startsWith('did you mean') ? ' help' : ''}` }, t)));
      b.addEventListener('click', () => this.editor.jumpTo(d.line, d.col, d.end_col));
      return h('li', {}, b);
    }));
    if (!ds.length && !list.hidden) {
      list.hidden = true;
      this.el['pr-sum'].setAttribute('aria-expanded', 'false');
    }
  }

  // ---- audio ------------------------------------------------------------------------------------------------

  ensureAudio() {
    if (this.manual) return null;
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return this.ctx;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
      this.ctx = new Ctx({ latencyHint: 'interactive' });
    } catch (e) {
      console.warn('btw: no audio', e);
      return null;
    }
    this.master = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.master.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.applyLevel();
    this.ctx.resume().catch(() => {});
    this.loadEngine();
    return this.ctx;
  }

  applyLevel() {
    if (!this.master) return;
    const v = Number(this.el.level.value);
    this.master.gain.value = v * v;
  }

  async loadEngine() {
    if (this.engineState !== 'idle') return;
    this.engineState = 'loading';
    this.updateTransport();
    try {
      let engine;
      if (this.mock) {
        const m = await import('./wasm-mock.js');
        engine = await m.createMockEngine({ context: this.ctx, destination: this.master });
      } else {
        const m = await import('./engine.js');
        engine = await m.createEngine({ context: this.ctx, destination: this.master, wasmUrl: this.btw && this.btw.wasmUrl });
      }
      await engine.ready;
      if (engine.on) engine.on('error', (e) => { if (e && e.message) this.toast(`Engine: ${e.message}`, 'error'); });
      this.engine = engine;
      this.engineSrc = new EngineSource(engine);
      this.engineState = 'ready';
    } catch (e) {
      this.engineState = 'failed';
      this.engineError = e && e.message ? e.message : String(e);
      console.warn('btw: the engine did not load', e);
    }
    this.updateTransport();
  }

  // ---- playing ------------------------------------------------------------------------------------------------

  isPlaying() {
    return !!(this.driver && this.driver.src);
  }

  canStream(report) {
    return !!(report && report.ok && !report.restricted && !report.uses_assets && !marksPrivate(this.editor.text) && this.serverOk !== false && !this.manual);
  }

  /** A program that must stay in this page: restricted, uses sample/loop assets, or says `#! visibility: private`. */
  isPrivate(text, report) {
    return marksPrivate(text) || !!(report && (report.restricted || report.uses_assets));
  }

  /** Which source plays this program: 'engine' | 'stream' | null. `trigger`: 'eval' (an edit, Cmd+Enter) or 'load' (open, compose). */
  pickSource(trigger, report) {
    const e = !!this.engineSrc;
    const s = this.canStream(report);
    const pref = this.sourcePref;
    if (pref === 'engine') return e ? 'engine' : null;
    if (pref === 'stream') return s ? 'stream' : null;
    if (trigger === 'load') return s ? 'stream' : e ? 'engine' : null;
    if (e) return 'engine';
    return s ? 'stream' : null;
  }

  async play(trigger = 'eval') {
    if (!this.btw) {
      this.toast(this.wasmOk === false ? 'The language module did not load, so nothing can play.' : 'Still loading the language module (about 6 MB). Try again in a moment.', 'warn');
      return;
    }
    if (this.busy) return;
    this.busy = true;
    try {
      this.ensureAudio();
      this.watchAudio();
      const text = this.editor.text;
      const report = this.runCheckNow();
      if (!report || !report.ok) {
        const n = report ? report.errors : 0;
        this.toast(`Not applied: ${n} error${n === 1 ? '' : 's'}. The last good program keeps playing.`, 'warn');
        const first = (report.diagnostics || []).find((d) => d.severity !== 'warning');
        if (first) this.editor.jumpTo(first.line, first.col, first.end_col);
        return;
      }
      const want = this.pickSource(trigger, report);
      if (want === 'engine') await this.playEngine(text, report);
      else if (want === 'stream') await this.playStream(text, report);
      else if (this.engineState === 'loading') this.toast(this.isPrivate(text, report) ? 'The engine is still loading. This program is private (it never goes to the server to stream), so it plays on the engine only: try again in a moment.' : 'The engine is still loading. Try again in a moment, or use stream.', 'warn');
      else this.toast(this.isPrivate(text, report) ? 'This program is private (restricted sounds, assets or #! visibility: private): it stays in this page and is never sent to the server to stream, so it plays on the engine only.' : 'No sound source is available: the engine did not load and the server is not reachable.', 'warn');
    } catch (e) {
      this.showError(e);
    } finally {
      this.busy = false;
    }
  }

  /** The browser keeps an AudioContext silent until a click or key. When it is still suspended after a play, say so. */
  watchAudio() {
    if (this.manual || !this.ctx || this.ctx.state === 'running') return;
    setTimeout(() => {
      if (!this.ctx || this.ctx.state === 'running' || !this.isPlaying()) return;
      this.banner({ kind: 'info', html: [h('span', { class: 'grow' }, 'The browser is holding the sound until you interact with the page.')], actions: [{ label: 'Enable sound', primary: true, run: () => { this.ctx.resume().then(() => this.banner(null)); } }] });
    }, 600);
  }

  async playEngine(text, report) {
    const res = this.driver.evaluate(text, this.engineSrc);
    if (!res.ok) {
      this.editor.setDiagnostics(res.diagnostics || []);
      this.toast('Not applied: the program was refused. The last good one keeps playing.', 'warn');
      return;
    }
    if (this.player) { this.player = null; }
    this.afterEval(text, report, res);
  }

  async playStream(text, report) {
    await this.ensureStored(report);
    const player = new StreamPlayer({ context: this.ctx, destination: this.master, url: this.api.renderUrl(report.cid), bpm: report.tempo || 120, onChange: () => this.updateTransport() });
    this.pendingPlayer = player;
    try {
      await player.start();
    } finally {
      if (this.pendingPlayer === player) this.pendingPlayer = null;
    }
    if (player.stopped) return; // Esc while the render was starting
    const res = this.driver.evaluate(text, new VirtualSource(player, 'stream'));
    if (!res.ok) {
      player.stop();
      this.editor.setDiagnostics(res.diagnostics || []);
      return;
    }
    this.player = player;
    this.afterEval(text, report, res);
  }

  async ensureStored(report) {
    if (this.stored.has(report.cid)) return;
    await this.api.putProgram(report.cid, report.canonical);
    this.stored.add(report.cid);
    // streaming is the server rendering the program, so the server keeps it: say so once (an example is the server's own)
    if (!this._toldStored && !this.examples.some((e) => e.cid === report.cid)) {
      this._toldStored = true;
      this.toast('The server keeps the programs it streams: this one is now stored publicly as CC0-1.0, found by its CID. (A program marked #! visibility: private is never sent.)', 'info');
    }
  }

  afterEval(text, report, res) {
    this.evalReport = report;
    this.cid = report.cid;
    if (this.driver.run !== this._lastRun) {
      this._lastRun = this.driver.run;
      this.runId++;
      this.follow.reset();
      this.roles = null;
    }
    this.banner(null);
    this.updateName();
    this.updateStale();
    this.updateTransport();
    this.emit('eval', res);
  }

  stop() {
    if (this.pendingPlayer) {
      this.pendingPlayer.stop();
      this.pendingPlayer = null;
    }
    if (!this.driver || !this.driver.src) return;
    this.driver.stopSound();
    this.player = null;
    this._lastRun = null;
    this.painter.clear();
    this.renderEdges([]);
    this.renderHeader(null, true);
    this.updateTransport();
    this.emit('stop');
  }

  setSourcePref(src) {
    this.sourcePref = this.sourcePref === src ? 'auto' : src;
    this.updateTransport();
    if (this.isPlaying()) this.play('switch');
  }

  setFollow(on) {
    this.follow.setOn(on);
    store.set('btw-follow', on ? '1' : '0');
    this.updateFollowButton();
  }

  updateFollowButton() {
    this.el['btn-follow'].setAttribute('aria-pressed', String(this.follow.on));
  }

  // ---- the frame ------------------------------------------------------------------------------------------------------

  clockNow() {
    return this.manual && this.clock ? this.clock.t : performance.now() / 1000;
  }

  loop() {
    const step = () => {
      try { this.renderFrame(this.clockNow()); } catch (e) { console.error('btw: frame', e); }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** One pass at time `now` (seconds on the page's clock): service the runtime, then paint everything from its marks. */
  renderFrame(now) {
    this.meter();
    const d = this.driver;
    const f = d ? d.tick() : null;
    if (!f) {
      this.updateTime(null);
      return null;
    }
    const text = this.editor.text;
    const fresh = text === f.evalText;
    const sections = this.evalReport ? this.evalReport.sections : null;
    const head = headerModel(f.status, f.marks, sections);
    this.renderHeader(head, fresh);
    if (fresh) {
      const ed = this.editor;
      const sc = ed.scroller;
      const frame = { marks: f.marks, text, layout: ed.layout(), offset: sc.scrollTop, fresh, now };
      const defFlash = this.follow.defFlash(frame);
      const v = this.follow.update(frame);
      if (v != null) {
        sc.scrollTop = v;
        frame.offset = sc.scrollTop;
      }
      this.painter.paint(deriveModel(f.marks, text, { reduced: this.reduced, now, defFlash }));
      this.renderEdges(this.follow.edges(frame));
    } else {
      this.painter.clear();
      this.renderEdges([]);
    }
    this.renderDecks(f.marks);
    const live = !!(f.grid && f.grid.playing && (f.grid.playing.A || f.grid.playing.B));
    if (live !== this._engineLive) {
      this._engineLive = live;
      this.updateTransport();
    }
    this.updateTime(f);
    this.afterFrame(f, head);
    return f;
  }

  afterFrame(f, head) {
    // the song ended, or the streamed render ran out of audio and nothing more is coming
    const over = head.ended || (this.player && this.player.state === 'ended');
    if (over && !this._ended && this.driver.src) {
      this._ended = true;
      setTimeout(() => this.songEnded(), 1500);
    } else if (!over) this._ended = false;
    this.emit('frame', f);
  }

  songEnded() {
    if (this.driver && this.driver.src && !this.record) {
      this.toast(this.player ? 'The render ended.' : 'The song ended.', 'info');
      this.stop();
    }
  }

  setText(el, s) {
    if (el.textContent !== s) el.textContent = s;
  }

  renderHeader(hm, fresh) {
    const el = this.el;
    const rep = this.evalReport;
    if (!hm || !hm.running) {
      this._last.sec = null; // the running branch caches what it wrote; this one overwrites it
      this.setText(el['h-sec-txt'], this.report && this.report.ok ? 'ready' : 'not playing');
      el['h-bar'].hidden = true; el['h-phrase'].hidden = true; el['h-gen'].hidden = true;
      el['h-prog-fill'].style.width = '0%';
      this.setText(el['h-state'], '');
      return;
    }
    const pre = hm.section ? `section${hm.secN != null ? ` ${hm.secN}/${hm.secM}` : ''}` : rep && rep.loops ? 'loop' : 'playing';
    const secTxt = hm.section ? `${pre} · ${hm.section}` : pre;
    if (this._last.sec !== secTxt) {
      this._last.sec = secTxt;
      el['h-sec-txt'].replaceChildren(pre, ...(hm.section ? [' · ', h('span', { class: 'nm' }, hm.section)] : []));
    }
    el['h-bar'].hidden = false;
    this.setText(el['h-bar'], hm.songBars ? `bar ${hm.songBar}/${hm.songBars}` : `bar ${hm.bar}`);
    el['h-phrase'].hidden = false;
    const bip = hm.barInPhrase || 1;
    this.lights.forEach((l, i) => {
      const cls = i + 1 === bip ? 'now' : i + 1 < bip ? 'on' : '';
      if (l.className !== cls) l.className = cls;
    });
    el['h-gen'].hidden = hm.gen == null;
    if (hm.gen != null) this.setText(el['h-gen'], `gen ${hm.gen}`);
    el['h-prog-fill'].style.width = `${clamp((hm.progress || 0) * 100, 0, 100).toFixed(2)}%`;
    const state = hm.ended ? 'ended' : !fresh ? 'edited since eval: ⌘↵ to apply' : '';
    this.setText(el['h-state'], state);
    el['h-state'].classList.toggle('stale', !fresh);
  }

  updateStale() {
    if (!this.driver || !this.driver.src) return;
    const fresh = this.editor.text === this.driver.evalText;
    this.setText(this.el['h-state'], fresh ? '' : 'edited since eval: ⌘↵ to apply');
    this.el['h-state'].classList.toggle('stale', !fresh);
  }

  renderEdges(edges) {
    const sig = edges.map((e) => `${e.line}${e.above ? 'u' : 'd'}`).join(',');
    if (sig === this.edgesSig) return;
    this.edgesSig = sig;
    const box = this.editor.edges;
    box.replaceChildren();
    let up = 0;
    let down = 0;
    for (const e of edges) {
      const b = h('button', { type: 'button', class: `edge ${e.above ? 'up' : 'down'}`, 'aria-label': `line ${e.line} fired off-screen, jump to it` }, `${e.above ? '▲' : '▼'} ${e.line}`);
      b.style[e.above ? 'top' : 'bottom'] = `${6 + (e.above ? up++ : down++) * 26}px`;
      b.addEventListener('click', () => this.editor.revealLine(e.line - 1, true));
      box.append(b);
    }
  }

  renderDecks(marks) {
    if (this.el.decks.hidden) return;
    const text = this.driver.evalText || '';
    if (!this.roles || this.roles.text !== text) {
      const roles = { A: new Set(), B: new Set() };
      for (const m of text.matchAll(/deck\s+([AB])\s*:([^\n]*(?:\n\s*\|[^\n]*)*)/g)) {
        for (const r of m[2].matchAll(/(?:^|\|)\s*(kick|snare|hihat|clap|bass|melody|harmony|arp)\b/g)) roles[m[1]].add(r[1]);
      }
      for (const f of (marks && marks.fires) || []) if (roles[f.deck]) roles[f.deck].add(f.role);
      this.roles = { text, roles, els: {} };
      for (const d of ['A', 'B']) {
        const ul = $(`deck-${d}`).querySelector('ul');
        ul.replaceChildren(...[...roles[d]].map((r) => {
          const b = h('b', {});
          const li = h('li', {}, r, h('i', {}, b));
          this.roles.els[`${d}:${r}`] = { li, b };
          return li;
        }));
      }
    }
    const lvl = {};
    for (const f of marks.fires || []) {
      const k = clamp(1 - f.age_beats / 1, 0, 1);
      const key = `${f.deck}:${f.role}`;
      lvl[key] = Math.max(lvl[key] || 0, k);
    }
    for (const [key, e] of Object.entries(this.roles.els)) {
      const k = lvl[key] || 0;
      const w = `${Math.round(k * 100)}%`;
      if (e.b.style.width !== w) e.b.style.width = w;
      e.li.classList.toggle('on', k > 0);
    }
  }

  meter() {
    if (!this.analyser) return;
    if (!this._buf) this._buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(this._buf);
    let s = 0;
    for (let i = 0; i < this._buf.length; i++) s += this._buf[i] * this._buf[i];
    const w = clamp(Math.sqrt(s / this._buf.length) * 3.2, 0, 1);
    this.el.meter.style.width = `${(w * 100).toFixed(0)}%`;
  }

  // ---- the transport bar -----------------------------------------------------------------------------------------------

  updateTransport() {
    const el = this.el;
    const playing = this.isPlaying();
    el['btn-play'].classList.toggle('on', playing);
    el['btn-play'].setAttribute('aria-label', playing ? 'Stop' : 'Play');
    el['btn-play'].title = playing ? 'Stop (Esc)' : 'Evaluate and play (Cmd/Ctrl+Enter)';
    const eng = this.engineSrc ? 'ready' : this.engineState;
    const kind = playing ? this.driver.kind : this.sourcePref === 'auto' ? (this.engineSrc ? 'engine' : 'stream') : this.sourcePref;
    const be = el['src-engine'];
    const bs = el['src-stream'];
    be.setAttribute('aria-pressed', String(kind === 'engine'));
    bs.setAttribute('aria-pressed', String(kind === 'stream'));
    be.disabled = eng === 'failed';
    be.title = eng === 'failed' ? `The engine did not load: ${this.engineError}` : eng === 'ready' ? 'Live engine in this page: edits land on the next bar' : 'The engine loads when you first press play';
    bs.disabled = this.serverOk === false;
    bs.title = this.serverOk === false ? 'The server is not reachable' : "The server's render, streamed";
    // status words
    let status = '';
    let busy = false;
    if (this.record) status = this.progName || '';
    else if (playing && this.player) {
      const st = this.player.state;
      if (st === 'connecting') { status = 'stream · rendering…'; busy = true; }
      else if (st === 'buffering') { status = 'stream · buffering…'; busy = true; }
      else if (st === 'error') status = `stream error: ${this.player.error && this.player.error.message}`;
      else status = `stream · ${this.player.buffered().toFixed(1)} s ahead`;
    } else if (playing) {
      const g = this.driver.last && this.driver.last.grid;
      const sounding = !!(g && g.playing && (g.playing.A || g.playing.B));
      status = sounding ? 'engine · live: edits land on the next bar' : 'engine · preparing the song…';
      busy = !sounding;
    }
    else if (this.engineState === 'loading') { status = 'engine loading…'; busy = true; }
    else if (this.engineState === 'failed') status = 'engine unavailable: using stream';
    else if (this.wasmOk === undefined) { status = 'loading the module…'; busy = true; }
    else status = this.wasmOk === false ? 'module not loaded' : 'stopped';
    this.setText(el['t-status'], status);
    el['t-status'].classList.toggle('busy', busy);
    const bpm = (this.driver && this.driver.last && this.driver.last.grid && this.driver.last.grid.bpm) || (this.report && this.report.tempo);
    this.setText(el['t-bpm'], bpm ? `${Math.round(bpm * 10) / 10} bpm` : '');
  }

  updateTime(f) {
    const el = this.el['t-time'];
    if (!f) { this.setText(el, ''); return; }
    const secs = (this.evalReport && this.evalReport.seconds) || null;
    let cur = null;
    if (this.player) cur = this.player.mediaTime();
    else if (f.status && f.status.bar != null && f.grid && f.grid.bpm) cur = (f.status.bar * 4 * 60) / f.grid.bpm;
    this.setText(el, cur == null ? '' : secs ? `${fmtTime(cur)} / ${fmtTime(secs)}` : fmtTime(cur));
    if (this.player && this.player.state !== this._lastPlayerState) {
      this._lastPlayerState = this.player.state;
      this.updateTransport();
    } else if (this.player && this.player.state === 'playing') {
      const b = this.player.buffered().toFixed(1);
      if (b !== this._lastBuf) { this._lastBuf = b; this.updateTransport(); }
    }
  }

  // ---- fmt, share, open ------------------------------------------------------------------------------------------------------

  fmt() {
    if (!this.btw) return;
    const text = this.editor.text;
    let r;
    try { r = this.btw.fmt(text); } catch (e) { this.showError(e); return; }
    if (!r.ok) {
      this.runCheckNow();
      this.toast('Cannot format: fix the errors first.', 'warn');
      const first = (r.diagnostics || [])[0];
      if (first) this.editor.jumpTo(first.line, first.col, first.end_col);
      return;
    }
    const caret = this.editor.ta.selectionStart;
    // `#!` lines at the top (name, license, forked-from) say what the program is; they are comments to the language,
    // so they are not in the CID and canonical form drops them, but a format should not strip them from the page
    const head = (/^(?:#![^\n]*\n)+/.exec(text) || [''])[0];
    const out = head + r.canonical;
    if (out === text) { this.toast('Already in canonical form.', 'ok'); return; }
    this.editor.replaceUndoable(out);
    const at = head.length + mapCaret(head ? text.slice(head.length) : text, Math.max(0, caret - head.length), r.canonical);
    this.editor.ta.setSelectionRange(at, at);
    const n = (r.comments || []).filter((c) => !/^#!/.test(String(c).trim())).length;
    this.toast(`Formatted · ${shortCid(r.cid)}${n ? ` · ${n} comment${n === 1 ? '' : 's'} dropped (the canonical form has none; Cmd/Ctrl+Z restores them)` : ''}`, 'ok');
    this.runCheckNow();
  }

  // ---- panels (compose, share, open, MCP, sign-in): loaded when first asked for ----------------------------------------------------

  async panel(which) {
    try {
      const m = await import('./panels.js');
      this.panels = this.panels || new m.Panels(this);
      this.panels.show(which);
    } catch (e) {
      this.showError(e);
    }
  }

  closePanel() {
    if (this.panels) this.panels.close();
    else this.el.drawer.hidden = true;
  }

  async startSession() {
    if (this.record || this.serverOk === false) return;
    try {
      const m = await import('./session.js');
      this.session = new m.SessionLink(this);
      this.session.start();
    } catch (e) {
      console.warn('btw: no session link', e);
    }
  }

  // ---- words on the page ---------------------------------------------------------------------------------------------------------

  toast(msg, kind = 'info', detail) {
    if (this.record) return;
    const t = h('div', { class: `toast ${kind}` }, trunc(msg), ...(detail && detail.length ? [h('pre', {}, trunc(detail.slice(0, 60).join('\n'), 4000))] : []));
    this.el.toasts.append(t);
    setTimeout(() => t.remove(), kind === 'error' ? 9000 : 5000);
  }

  showError(e) {
    const d = describeError(e);
    this.toast(d.title, d.kind, d.lines);
    return d;
  }

  /** The strip under the header: {kind, text|html, actions:[{label, run, primary}]}; null clears it. */
  banner(b) {
    const el = this.el.banner;
    if (!b || this.record) {
      el.hidden = true;
      el.replaceChildren();
      return;
    }
    el.className = `banner ${b.kind || ''}`;
    const kids = b.html || [h('span', { class: 'grow' }, b.text, ...(b.detail ? [h('code', {}, ` ${b.detail}`)] : []))];
    el.replaceChildren(...kids, ...(b.actions || []).map((a) => {
      const btn = h('button', { type: 'button', class: `tb tb-sm${a.primary ? ' primary' : ''}` }, a.label);
      btn.addEventListener('click', a.run);
      return btn;
    }));
    el.hidden = false;
  }

  // ---- events for the session link and the panels ---------------------------------------------------------------------------------------

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type, data) {
    for (const fn of this.listeners) {
      try { fn(type, data); } catch (e) { console.warn('btw: listener', e); }
    }
  }

  // ---- record mode: ?record=1 [&clock=manual], window.__btw ---------------------------------------------------------------------------------

  /** What a report to the server says (session link, MCP get). */
  reportState() {
    const d = this.driver;
    const f = d && d.last;
    const st = (f && f.status) || {};
    const text = this.editor.text;
    // a private program (restricted, assets, `#! visibility: private`) is not reported: no text, no CID, none of the diagnostics (they quote it)
    const checked = this.btw ? (this.reportText === text ? this.report : this.runCheckNow()) : null;
    const withheld = this.isPrivate(text, checked);
    return {
      text: withheld ? '' : text,
      withheld,
      cid: withheld ? '' : this.cid || '',
      playing: this.isPlaying(),
      source: d && d.kind ? d.kind : '',
      section: withheld ? '' : st.section || '',
      section_num: this.evalReport && st.song_bar != null ? 1 + (this.evalReport.sections || []).findIndex((s) => st.song_bar - 1 >= s.start && st.song_bar - 1 < s.start + s.bars) : 0,
      sections_total: this.evalReport ? (this.evalReport.sections || []).length : 0,
      bar: st.song_bar ?? st.bar ?? 0,
      bars_in_section: st.section_bars ?? 0,
      phase: st.bar_in_phrase ?? 0,
      marks: f && !withheld ? f.marks : null,
      diagnostics: withheld ? [] : (this.report && this.report.diagnostics) || [],
      ts: new Date().toISOString(),
    };
  }

  lineText(i) {
    const s = lineStarts(this.editor.text);
    return this.editor.text.slice(s[i], s[i + 1] ?? undefined);
  }
}

void lineOf; void makeByteMapper; void spanRange; void diagLine; void ManualClock;
