// The page in the background (the decisions are in background-model.js; this is the part that touches the page).
//
//  1. Keeps the program runtime serviced when the frame loop is not running: from the engine's audio-thread reports (an event,
//     not a timer), with a coarse interval as the fallback. Painting is not done while the page is hidden.
//  2. Resyncs when the page comes back: resumes a suspended AudioContext, paints at once, and (when the engine did not keep up,
//     or on Android) offers the streamed render, which keeps time on its own and plays with the screen off.
//  3. Media Session: the lock screen and the notification show the program's name, with play and stop.
//     Chrome only treats a page as media (notification, lock-screen controls, kept alive in the background) when a media element
//     is playing, and ours is Web Audio, so a silent looping <audio> plays beside the sound for as long as a program does.
//
// ?keepalive=0 turns the silent element off; ?pump=0 turns the background service off (test/background-browser.mjs uses it to show
// that the test fails without it).

import { needsPump, pumpDue, offerStream, isAndroid, clockKeptUp, mediaInfo, mediaState } from './background-model.js';

export class Background {
  constructor(app, { doc = document, nav = navigator, now = () => performance.now() } = {}) {
    this.app = app;
    this.doc = doc;
    this.nav = nav;
    this.now = now;
    this.lastFrameAt = null;
    this.lastPumpAt = null;
    this.hiddenAt = null;
    this.hidden = { ctxTime: null, wasPlaying: false, source: null };
    this.offered = false;
    this.android = isAndroid(nav.userAgent);
    this.silent = null;
    this.mediaKey = '';
    this.stats = { pumps: 0, hiddenPumps: 0, frames: 0, hiddenMs: 0, lastHidden: null };
  }

  start() {
    this.doc.addEventListener('visibilitychange', () => (this.doc.hidden ? this.onHidden() : this.onVisible()));
    this.doc.addEventListener('freeze', () => { this.hiddenAt = this.hiddenAt ?? this.now(); });
    this.doc.addEventListener('resume', () => { this.lastPumpAt = null; });
    window.addEventListener('pagehide', () => this.stopSilent());
    this.timer = setInterval(() => this.pump(), 250);
    this.mediaSession();
    if (this.doc.hidden) this.onHidden();
  }

  /** The frame loop calls this every frame. */
  frame() {
    this.lastFrameAt = this.now();
    this.stats.frames++;
  }

  /** Service the runtime from every report the engine's audio thread makes. */
  attachEngine(engine) {
    if (engine && typeof engine.on === 'function') engine.on('grid', () => this.pump());
  }

  /** Service the runtime if nobody else is. Returns whether it did. */
  pump() {
    if (this.app.q.get('pump') === '0') return false; // test switch: the runtime goes back to being serviced by the frame loop alone
    const t = this.now();
    if (!needsPump({ hidden: this.doc.hidden, now: t, lastFrameAt: this.lastFrameAt })) return false;
    if (!pumpDue({ now: t, lastPumpAt: this.lastPumpAt })) return false;
    this.lastPumpAt = t;
    this.stats.pumps++;
    if (this.doc.hidden) this.stats.hiddenPumps++;
    try { this.app.serviceOnly(); } catch (e) { console.error('btw: background service', e); }
    return true;
  }

  // ---- hidden and back ------------------------------------------------------------------------------------------

  onHidden() {
    const a = this.app;
    this.hiddenAt = this.now();
    this.hidden = { ctxTime: a.ctx ? a.ctx.currentTime : null, wasPlaying: a.isPlaying(), source: a.driver && a.driver.kind };
  }

  onVisible() {
    const a = this.app;
    const since = this.hiddenAt;
    this.hiddenAt = null;
    this.lastPumpAt = null;
    if (since == null) return;
    const hiddenMs = this.now() - since;
    this.stats.hiddenMs += hiddenMs;
    const h = this.hidden;
    const ctxState = a.ctx ? a.ctx.state : null;
    const audioS = a.ctx && h.ctxTime != null ? a.ctx.currentTime - h.ctxTime : null;
    const degraded = audioS != null && h.wasPlaying && !clockKeptUp({ audioS, wallS: hiddenMs / 1000 });
    this.stats.lastHidden = { hiddenMs, audioS, ctxState, degraded };
    if (a.ctx && a.ctx.state !== 'running') a.ensureAudio(); // a context the browser suspended in the background
    a.resync();
    const reason = offerStream({ hiddenMs, wasPlaying: h.wasPlaying, source: a.driver && a.driver.kind, canStream: a.canStream(a.evalReport || a.report), android: this.android, ctxState, degraded, offered: this.offered });
    if (reason) this.offer(reason);
  }

  offer(reason) {
    const a = this.app;
    this.offered = true;
    a.banner({
      kind: 'info',
      text: `${reason} The streamed render keeps time on its own and plays with the screen off.`,
      actions: [
        { label: 'Use stream', primary: true, run: () => { if (a.sourcePref !== 'stream') a.setSourcePref('stream'); a.banner(null); } },
        { label: 'Dismiss', run: () => a.banner(null) },
      ],
    });
  }

  // ---- the lock screen ------------------------------------------------------------------------------------------------

  mediaSession() {
    const ms = this.nav.mediaSession;
    if (!ms) return;
    const on = (action, fn) => { try { ms.setActionHandler(action, fn); } catch { /* an action this browser does not have */ } };
    on('play', () => { this.app.play('eval'); });
    on('pause', () => { this.app.stop(); });
    on('stop', () => { this.app.stop(); });
  }

  /** The app calls this when what is playing, or its name, changes. */
  sync() {
    const a = this.app;
    const playing = a.isPlaying();
    const ms = this.nav.mediaSession;
    if (ms) {
      const state = mediaState({ playing, loaded: !!(a.report && a.report.ok) });
      const g = a.driver && a.driver.last && a.driver.last.grid;
      const info = mediaInfo({ name: a.progName, source: a.driver && a.driver.kind, tempo: (g && g.bpm) || (a.report && a.report.tempo) });
      const key = `${state}|${info.title}|${info.album}`;
      if (key !== this.mediaKey) {
        this.mediaKey = key;
        try {
          if (typeof MediaMetadata === 'function') ms.metadata = new MediaMetadata(info);
          ms.playbackState = state;
        } catch { /* a browser with half a Media Session */ }
      }
    }
    if (playing) this.startSilent(); else this.stopSilent();
  }

  startSilent() {
    if (this.silent === false || this.app.manual || this.app.record || this.app.q.get('keepalive') === '0') return;
    try {
      if (!this.silent) {
        const el = new Audio();
        el.loop = true;
        el.preload = 'auto';
        el.setAttribute('aria-hidden', 'true');
        el.src = new URL('../silence.wav', import.meta.url).href;
        this.silent = el;
      }
      if (this.silent.paused) this.silent.play().catch(() => {});
    } catch { this.silent = false; }
  }

  stopSilent() {
    if (this.silent && !this.silent.paused) this.silent.pause();
  }
}
