// The "up next" queue, page side (DESIGN.md "Up next"). The queue lives on the server with this tab's session and is
// written only over MCP (there is no button that adds to it); the page shows it read-only and, when the playing
// program is over, asks the server for the next item: POST /api/session/<id>/queue/next {reason, presence}.
//
// The server decides that answer under the presence rules (it is the one place they are enforced). The page applies the
// same rules first, so it never asks when it knows the answer, and it is what shows "Still listening? Press play to
// continue". Nothing here composes, renders or calls a model: an item is a program that already exists.
//
// Pure: the clock, the document and the network are passed in, so test/unit.mjs runs it on a fake clock.

export const PAUSE = Object.freeze({
  idleHidden: 'idle_hidden',
  audioSuspended: 'audio_suspended',
  maxAuto: 'max_auto_advance',
  noReport: 'no_listener_report',
});

export const DEFAULTS = Object.freeze({ idleMinutes: 30, maxAuto: 8 });

/** The events that count as a person on the page. Media keys arrive as mediaSession actions (see PresenceTracker.attach). */
export const INTERACTION_EVENTS = ['keydown', 'pointerdown', 'touchstart', 'wheel'];

/**
 * What the page knows about its listener. `now` is ms on the page's clock; `doc` has visibilityState and hasFocus();
 * `audio` answers the AudioContext's state ('running' | 'suspended' | 'closed') or 'none' before there is one.
 */
export class PresenceTracker {
  constructor({ now = () => Date.now(), doc = null, audio = () => 'none' } = {}) {
    this.now = now;
    this.doc = doc;
    this.audio = audio;
    this.lastInteraction = now();
  }

  /** A key, pointer, touch, wheel or media key: someone is here. */
  touch() {
    this.lastInteraction = this.now();
  }

  /** Listen on a window (and navigator.mediaSession, when there is one) for interactions. Returns a detach function. */
  attach(win) {
    if (!win || !win.addEventListener) return () => {};
    const on = () => this.touch();
    for (const t of INTERACTION_EVENTS) win.addEventListener(t, on, { capture: true, passive: true });
    const ms = win.navigator && win.navigator.mediaSession;
    if (ms && ms.setActionHandler) {
      for (const a of ['play', 'pause', 'nexttrack', 'previoustrack', 'stop']) {
        try { ms.setActionHandler(a, () => { this.touch(); if (this.onMediaKey) this.onMediaKey(a); }); } catch { /* not supported */ }
      }
    }
    return () => { for (const t of INTERACTION_EVENTS) win.removeEventListener(t, on, { capture: true }); };
  }

  /** The report the server takes ({visible, focused, audio, idle_ms}). idle_ms is on this page's clock alone. */
  snapshot() {
    const d = this.doc;
    return {
      visible: d ? d.visibilityState === 'visible' : true,
      focused: d && d.hasFocus ? !!d.hasFocus() : false,
      audio: String(this.audio() || 'none'),
      idle_ms: Math.max(0, Math.round(this.now() - this.lastInteraction)),
    };
  }
}

/**
 * The server's rule (internal/btwsite/server/queue.go verdict), page side: why a track boundary now would pause, or ''.
 * `auto` is the advances made since the last interaction, as the queue's view says (auto_advanced).
 */
export function pauseReason(presence, { auto = 0, interactedSinceAdvance = false } = {}, cfg = DEFAULTS) {
  if (!presence) return PAUSE.noReport;
  if (presence.audio !== 'running') return PAUSE.audioSuspended;
  const idleMin = cfg.idleMinutes ?? DEFAULTS.idleMinutes;
  if (!presence.visible && presence.idle_ms >= idleMin * 60000) return PAUSE.idleHidden;
  if (auto >= (cfg.maxAuto ?? DEFAULTS.maxAuto) && !interactedSinceAdvance) return PAUSE.maxAuto;
  return '';
}

/** The words on the page for a pause. */
export function pauseMessage(reason) {
  switch (reason) {
    case PAUSE.maxAuto: return 'Still listening? Press play to continue. (The queue stops after a run of tracks nobody touched.)';
    case PAUSE.idleHidden: return 'Still listening? Press play to continue. (The tab was in the background with nobody at it.)';
    case PAUSE.audioSuspended: return 'Still listening? Press play to continue. (The browser is holding the sound.)';
    default: return 'Still listening? Press play to continue.';
  }
}

/** Seconds in one bar (16 steps = 4 beats). */
export const barSeconds = (tempo) => 240 / (tempo > 0 ? tempo : 120);

/** One pass of the arrangement in bars: the song length, else the sections' total, else 32 bars. */
export function passBars(report) {
  if (!report) return 32;
  if (report.song_bars > 0) return report.song_bars;
  const s = (report.sections || []).reduce((n, x) => n + (x.bars || 0), 0);
  return s > 0 ? s : 32;
}

/**
 * How many bars an item plays before the queue advances, or null for "until it ends". An item's bars win, then its
 * minutes (rounded up to a whole bar, so the change lands on a bar line); a looping program without either plays one
 * pass of its arrangement. A program that ends by itself plays to its end unless the item gives a length.
 */
export function playBars(item, report) {
  if (item && item.bars > 0) return Math.round(item.bars);
  if (item && item.minutes > 0) return Math.max(1, Math.ceil((item.minutes * 60) / barSeconds(report && report.tempo)));
  if (report && report.loops) return passBars(report);
  return null;
}

/**
 * The advance controller. The app gives it the queue's view (from the session's "queue" events), calls startTrack when
 * a program starts and frame on every frame, and plays what it is handed:
 *   request({reason, presence}) -> Promise<{item, queue}>    POST …/queue/next
 *   play(item) -> Promise                                     load and start the item (a fresh run, from bar 1)
 *   paused(reason)                                            show "Still listening?"; the app stops at the end
 */
export class UpNext {
  constructor({ presence, request, play, paused, onChange } = {}) {
    this.presence = presence;
    this.requestFn = request;
    this.playFn = play;
    this.pausedFn = paused;
    this.onChange = onChange;
    this.view = null;
    this.track = null; // {item, target, startBar, asked}
    this.pending = null; // the request in flight
  }

  setView(v) {
    this.view = v && typeof v === 'object' ? v : null;
    if (this.onChange) this.onChange(this.view);
  }

  get items() { return (this.view && Array.isArray(this.view.up_next)) ? this.view.up_next : []; }
  get pausedReason() { return (this.view && this.view.paused_reason) || ''; }
  get cfg() {
    const v = this.view || {};
    return { idleMinutes: v.idle_minutes || DEFAULTS.idleMinutes, maxAuto: v.max_auto_advance || DEFAULTS.maxAuto };
  }

  /** True when the end of the playing program should go to the queue rather than stop. */
  wants() {
    return this.items.length > 0;
  }

  /** What a boundary now would decide, page side ('' = advance). */
  verdict() {
    // a pause lifts only on an interaction after it (the server sees it in the next request's idle_ms)
    if (this.pausedReason && !(this.pausedAt != null && this.presence && this.presence.lastInteraction > this.pausedAt)) return this.pausedReason;
    const p = this.presence ? this.presence.snapshot() : null;
    const interacted = this.presence && this.lastAdvanceAt != null && this.presence.lastInteraction > this.lastAdvanceAt;
    return pauseReason(p, { auto: (this.view && this.view.auto_advanced) || 0, interactedSinceAdvance: !!interacted }, this.cfg);
  }

  /** A program started playing: item is the queue item it came from (null: something else, e.g. an MCP load). */
  startTrack(item, report, bar = 0) {
    this.track = { item: item || null, target: playBars(item, report), startBar: bar, asked: false };
  }

  /** One frame: {bar, ended}. Advances when the play length is reached (on the bar line) or the program has ended. */
  frame({ bar = 0, ended = false } = {}) {
    if (!this.track || this.track.asked || !this.wants()) return false;
    if (ended) return this.advance('ended');
    const t = this.track.target;
    if (t != null && bar - this.track.startBar >= t) return this.advance('length');
    return false;
  }

  /**
   * Ask for the next item and play it. reason: ended | length | skip | resume. Always asked of the server, even when
   * verdict() already says pause: the server records the pause, and MCP's list and get report it.
   */
  advance(reason) {
    if (this.pending) return true;
    if (this.track) this.track.asked = true;
    this.pending = this.ask(reason).finally(() => { this.pending = null; });
    return true;
  }

  async ask(reason) {
    const presence = this.presence ? this.presence.snapshot() : null;
    let res;
    try {
      res = await this.requestFn({ reason, presence });
    } catch (e) {
      if (this.pausedFn) this.pausedFn('', e);
      return null;
    }
    if (res && res.queue) this.setView(res.queue);
    const item = res && res.item;
    if (item) {
      this.lastAdvanceAt = this.presence ? this.presence.now() : 0;
      this.pausedAt = null;
      await this.playFn(item);
      return item;
    }
    const why = this.pausedReason;
    if (why) {
      this.pausedAt = this.presence ? this.presence.now() : 0;
      if (this.pausedFn) this.pausedFn(why);
    } else if (this.pausedFn) this.pausedFn(''); // the queue ran out: the app stops as it always has
    return null;
  }

  /** The person pressed play on "Still listening?": an interaction, then the next item. */
  resume() {
    if (this.presence) this.presence.touch();
    if (this.track) this.track.asked = false;
    return this.advance('resume');
  }
}
