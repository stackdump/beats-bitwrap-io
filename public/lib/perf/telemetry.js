// Anonymous playback diagnostics → POST /api/telemetry (internal/telemetry).
//
// Purpose: find out what makes playback erratic on phones — do late notes
// or unexpected stops follow taps, focus / visibility changes, page
// freezes, audio-context state changes or worker catch-up?
//
// Sent: a random session id made per page load (never stored), coarse
// device fields (UA, client-hint model, cores, memory), audio-context
// latency, and timestamped events (ms since page load):
//   tap {on: area}           which UI area, never coordinates or text
//   vis {s} focus blur pagehide pageshow freeze resume
//   ctx {s}  sink {e}  banner   audio context / <audio> sink state
//   play  stop {r: user|hidden|end}
//   win {…}                  perf monitor 2 s window summary
//   late {m}                 a note scheduled after its time (ms)
//   catchup {n}              worker advanced n missed ticks at once
// Not sent at all when the browser signals Global Privacy Control or Do
// Not Track, after "Turn off" in Help (localStorage pn-telemetry=off), or
// with ?telemetry=0. No IP is stored server-side.

import { toneEngine } from '../../audio/tone-engine.js';

const ENDPOINT = '/api/telemetry';
const FLUSH_MS = 20000;
const MAX_BUFFER = 800;
const MAX_BATCHES = 400;
const MAX_LATE_PER_WINDOW = 20;
const OPT_KEY = 'pn-telemetry';

export function telemetryAllowed() {
    try {
        if (navigator.globalPrivacyControl === true) return false;
        if (navigator.doNotTrack === '1' || window.doNotTrack === '1') return false;
        if (localStorage.getItem(OPT_KEY) === 'off') return false;
        if (new URLSearchParams(location.search).get('telemetry') === '0') return false;
    } catch { return false; }
    return true;
}

export function setTelemetryEnabled(el, on) {
    try { localStorage.setItem(OPT_KEY, on ? 'on' : 'off'); } catch {}
    if (!on && el._telemetry) { el._telemetry.dispose(); el._telemetry = null; }
}

function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

const AREAS = [
    ['.pn-play, .pn-play-btn', 'play'],
    ['.pn-stage-overlay, .pn-stage', 'stage'],
    ['.pn-mixer, .pn-mixer-row', 'mixer'],
    ['.pn-help-overlay', 'modal'],
    ['canvas, svg', 'canvas'],
    ['button, select, input, a', 'control'],
];
function areaOf(target) {
    if (!(target instanceof Element)) return 'other';
    for (const [sel, name] of AREAS) if (target.closest(sel)) return name;
    return 'page';
}

async function deviceInfo() {
    const d = { ua: navigator.userAgent };
    if (navigator.hardwareConcurrency) d.cores = navigator.hardwareConcurrency;
    if (navigator.deviceMemory) d.memoryGB = navigator.deviceMemory;
    try {
        const h = await navigator.userAgentData?.getHighEntropyValues?.(['model']);
        if (h) {
            if (h.model) d.model = h.model;
            if (h.platform) d.platform = h.platform;
            if (typeof h.mobile === 'boolean') d.mobile = h.mobile;
        }
    } catch {}
    return d;
}

class Telemetry {
    constructor(el) {
        this.el = el;
        this.sid = uuid();
        this.seq = 0;
        this.buf = [];
        this.lateInWindow = 0;
        this.listeners = [];
        this.hookedCtx = new WeakSet();
        this.hookedSink = new WeakSet();
        this.devicePromise = deviceInfo().then(d => { this.device = d; });
        const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); this.listeners.push([target, type, fn, opts]); };
        on(window, 'pointerdown', (e) => this.add('tap', { on: areaOf(e.target), p: e.pointerType || '' }), { capture: true, passive: true });
        on(document, 'visibilitychange', () => {
            this.add('vis', { s: document.visibilityState });
            if (document.visibilityState === 'hidden') this.flush(true);
        });
        on(window, 'focus', () => this.add('focus'));
        on(window, 'blur', () => this.add('blur'));
        on(window, 'pagehide', (e) => { this.add('pagehide', { p: !!e.persisted }); this.flush(true); });
        on(window, 'pageshow', (e) => this.add('pageshow', { p: !!e.persisted }));
        on(document, 'freeze', () => { this.add('freeze'); this.flush(true); });
        on(document, 'resume', () => this.add('resume'));
        this.timer = setInterval(() => this.flush(false), FLUSH_MS);
    }

    add(kind, data) {
        if (this.seq >= MAX_BATCHES) return;
        const ev = [Math.round(performance.now()), kind];
        if (data) ev.push(data);
        this.buf.push(ev);
        if (this.buf.length >= MAX_BUFFER) this.flush(false);
    }

    // Audio context + <audio> sink listeners; re-run on every play since
    // the context can be replaced (wave mode installs its own).
    hookAudio() {
        const ctx = window.Tone?.getContext?.()?.rawContext;
        if (ctx && !this.hookedCtx.has(ctx)) {
            this.hookedCtx.add(ctx);
            ctx.addEventListener('statechange', () => this.add('ctx', { s: ctx.state }));
            this.audio = {
                sampleRate: ctx.sampleRate,
                baseLatency: +(ctx.baseLatency || 0).toFixed(4),
                outputLatency: +(ctx.outputLatency || 0).toFixed(4),
            };
        }
        const sinkEl = toneEngine._masterSink?.audioEl;
        if (sinkEl && !this.hookedSink.has(sinkEl)) {
            this.hookedSink.add(sinkEl);
            for (const t of ['play', 'pause', 'stalled', 'waiting']) {
                sinkEl.addEventListener(t, () => this.add('sink', { e: t }));
            }
        }
    }

    play() { this.hookAudio(); this.add('play', { engine: this.el._waveEngine ? 'wave' : 'default' }); }
    stop(reason) { this.add('stop', { r: reason || 'user' }); this.flush(false); }

    win(w) {
        this.lateInWindow = 0;
        this.add('win', {
            fps: w.fps, p95: w.p95FrameMs, drop: w.dropped, blk: w.blockingMsPerS,
            viz: w.vizSharePct, n: w.notes, late: w.late, tight: w.tight, c: w.cause, lvl: w.level,
        });
    }

    late(marginMs) {
        if (this.lateInWindow++ >= MAX_LATE_PER_WINDOW) return;
        this.add('late', { m: Math.round(marginMs) });
    }

    async flush(beacon) {
        if (!this.buf.length || this.seq >= MAX_BATCHES) return;
        if (!this.device) { if (beacon) return; await this.devicePromise; }
        const events = this.buf.splice(0, 1000);
        const body = JSON.stringify({
            v: 1, sid: this.sid, seq: this.seq++,
            engine: this.el._waveEngine ? 'wave' : 'default',
            device: this.device, audio: this.audio || {}, events,
        });
        try {
            if (beacon && navigator.sendBeacon) {
                navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
            } else {
                await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true });
            }
        } catch {}
    }

    dispose() {
        clearInterval(this.timer);
        for (const [t, type, fn, opts] of this.listeners) t.removeEventListener(type, fn, opts);
        this.listeners = [];
        this.buf = [];
    }
}

/** Start telemetry on first play (no-op when not allowed). */
export function telemetryOnPlay(el) {
    if (!el._telemetry) {
        if (!telemetryAllowed()) return;
        el._telemetry = new Telemetry(el);
    }
    el._telemetry.play();
}

export function telemetryOnStop(el, reason) {
    el._telemetry?.stop(reason);
}

export function telemetryEvent(el, kind, data) {
    el._telemetry?.add(kind, data);
}
