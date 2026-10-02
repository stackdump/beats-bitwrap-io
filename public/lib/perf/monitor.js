// Live performance monitor — "is the visualization making playback lag?"
//
// Runs only while playing. Every window (2 s) it combines:
//   frames   rAF pacing: median / p95 frame interval, dropped frames
//   long     long-animation-frame (LoAF) blocking time, longtask fallback
//   viz      ms spent inside the visualization itself, per path:
//            timeline canvas · Stage loop · net canvas · per-fire flashes
//   notes    default (Tone) engine: scheduling margin of every note —
//            late (scheduled in the past → the audio grid re-anchors, an
//            audible hiccup) and tight (< 10 ms of margin)
//   waveLag  wave engine: how far the page's view trails the audio thread
// into a verdict:
//   cause = 'visualization'  the main thread janks AND the visuals are a
//                            large share of it
//           'other'          janks, but not because of the visuals
//           'none'
// In auto mode (default) the visual level steps down
//   0 full → 1 reduced → 2 minimal → 3 paused
// after two consecutive 'visualization' windows, and back up after a
// clean stretch. A level that had to be re-entered soon after stepping up
// becomes the floor for the session, so it doesn't oscillate.
//
// Note: in the wave engine, audio runs on the audio thread and visual jank
// cannot delay it; the monitor still reports it (and reduces visuals) for
// smoothness, but `notes` stays empty there.

export const VIZ = { TIMELINE: 0, STAGE: 1, NET: 2, FIRE: 3 };
const VIZ_NAMES = ['timeline', 'stage', 'net', 'fire'];
export const LEVELS = ['full', 'reduced', 'minimal', 'paused'];
const PREF_KEY = 'pn-viz-quality'; // 'auto' | 'full' | 'reduced' | 'minimal'

const DEFAULTS = {
    windowMs: 2000,
    downAfter: 2,        // consecutive 'visualization' windows to step down
    upAfter: 8,          // consecutive clean windows to step up (16 s)
    vizShare: 0.12,      // viz ms / window ms counted as "heavy"
    jankP95Factor: 2.0,  // p95 frame interval > 2× median
    jankDropped: 0.15,   // > 15% dropped frames
    jankBlockingMsPerS: 50,
    minFps: 30,          // uniformly slow frames count too, not just spikes
    tightMs: 10,
};

// Accumulators written from hot paths: typed, so timing them allocates nothing.
const vizMs = new Float64Array(4);
const vizCalls = new Float64Array(4);

/** performance.now() at the start of a visual path; pass it to vizEnd. */
export const vizBegin = () => performance.now();
export function vizEnd(key, t0) {
    vizMs[key] += performance.now() - t0;
    vizCalls[key] += 1;
}

export function vizPreference() {
    try { return localStorage.getItem(PREF_KEY) || 'auto'; } catch { return 'auto'; }
}
export function setVizPreference(el, pref) {
    try { localStorage.setItem(PREF_KEY, pref); } catch {}
    const m = el._perf;
    if (m) { m.pref = pref; m.floor = 0; m.clean = 0; m.bad = 0; }
    el._vizLevel = pref === 'auto' ? (m ? m.level : 0) : Math.max(0, LEVELS.indexOf(pref));
    if (m) m.level = el._vizLevel;
}

function median(sorted) { return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0; }

export function perfStart(el) {
    if (el._perf?.running) return;
    const cfg = { ...DEFAULTS, ...(el._perfConfig || {}) };
    const pref = vizPreference();
    const m = el._perf = el._perf || {
        level: pref === 'auto' ? 0 : Math.max(0, LEVELS.indexOf(pref)),
        floor: 0, history: [], lastStepUpAt: -Infinity,
    };
    Object.assign(m, {
        cfg, pref, running: true, bad: 0, clean: 0,
        frames: new Float64Array(2048), frameCount: 0, lastFrame: 0,
        blockingMs: 0, longCount: 0, vizAttributedMs: 0,
        notes: 0, late: 0, tight: 0, minMarginMs: Infinity,
        waveLagMax: 0, waveLagSum: 0, waveLagN: 0,
        windowStart: performance.now(),
    });
    el._vizLevel = m.level;
    vizMs.fill(0); vizCalls.fill(0);

    const loop = (now) => {
        if (!m.running) return;
        if (m.lastFrame && m.frameCount < m.frames.length) m.frames[m.frameCount++] = now - m.lastFrame;
        m.lastFrame = now;
        m.raf = requestAnimationFrame(loop);
    };
    m.raf = requestAnimationFrame(loop);

    // Long animation frames, with script attribution where supported.
    try {
        const types = PerformanceObserver.supportedEntryTypes || [];
        const type = types.includes('long-animation-frame') ? 'long-animation-frame'
            : types.includes('longtask') ? 'longtask' : null;
        if (type) {
            m.observer = new PerformanceObserver((list) => {
                for (const e of list.getEntries()) {
                    m.longCount++;
                    m.blockingMs += e.blockingDuration ?? Math.max(0, e.duration - 50);
                    if (e.scripts) {
                        for (const s of e.scripts) {
                            if (/\/lib\/ui\/(stage|canvas)\.js|vizDraw|renderFrame/.test(`${s.sourceURL} ${s.sourceFunctionName}`)) {
                                m.vizAttributedMs += s.duration;
                            }
                        }
                    }
                }
            });
            m.observer.observe({ type, buffered: false });
            m.longType = type;
        }
    } catch {}

    m.timer = setInterval(() => closeWindow(el), cfg.windowMs);
}

export function perfStop(el) {
    const m = el._perf;
    if (!m || !m.running) return;
    m.running = false;
    cancelAnimationFrame(m.raf);
    clearInterval(m.timer);
    try { m.observer?.disconnect(); } catch {}
}

/** Default engine: margin (s) between a note's scheduled time and now. */
export function perfNote(el, marginSec, reanchored) {
    const m = el._perf;
    if (!m || !m.running) return;
    const ms = marginSec * 1000;
    m.notes++;
    if (reanchored || ms < 0) { m.late++; el._telemetry?.late(ms); }
    else if (ms < m.cfg.tightMs) m.tight++;
    if (ms < m.minMarginMs) m.minMarginMs = ms;
}

/** Wave engine: how far the page trails the audio thread (ms). */
export function perfWaveLag(el, ms) {
    const m = el._perf;
    if (!m || !m.running || !(ms >= 0)) return;
    m.waveLagSum += ms; m.waveLagN++;
    if (ms > m.waveLagMax) m.waveLagMax = ms;
}

function closeWindow(el) {
    const m = el._perf, cfg = m.cfg;
    const now = performance.now();
    const span = now - m.windowStart;
    const deltas = Array.from(m.frames.subarray(0, m.frameCount)).sort((a, b) => a - b);
    const med = median(deltas);
    const p95 = deltas.length ? deltas[Math.floor(deltas.length * 0.95)] : 0;
    const dropped = med ? deltas.filter(d => d > med * 1.7).length / Math.max(1, deltas.length) : 0;
    const blockingPerS = m.blockingMs * 1000 / span;
    const viz = {};
    let vizTotal = 0;
    for (let i = 0; i < 4; i++) { viz[VIZ_NAMES[i]] = +vizMs[i].toFixed(1); vizTotal += vizMs[i]; }
    const vizShare = vizTotal / span;
    const jank = deltas.length > 5 && (p95 > med * cfg.jankP95Factor || dropped > cfg.jankDropped
            || med > 1000 / cfg.minFps)
        || blockingPerS > cfg.jankBlockingMsPerS;
    // Visuals are the cause when they are a heavy share of main-thread time,
    // or when the browser attributes most long-frame time to them.
    const vizHeavy = vizShare > cfg.vizShare || (m.blockingMs > 0 && m.vizAttributedMs > 0.5 * m.blockingMs);
    const audioLate = m.late > 0;
    const cause = (jank || audioLate) ? (vizHeavy ? 'visualization' : 'other') : 'none';

    const w = {
        at: Date.now(), spanMs: Math.round(span), level: m.level, cause,
        fps: med ? +(1000 / med).toFixed(1) : 0, p95FrameMs: +p95.toFixed(1), dropped: +dropped.toFixed(3),
        longFrames: m.longCount, blockingMsPerS: +blockingPerS.toFixed(1),
        vizMs: viz, vizSharePct: +(vizShare * 100).toFixed(1),
        notes: m.notes, late: m.late, tight: m.tight,
        minMarginMs: Number.isFinite(m.minMarginMs) ? +m.minMarginMs.toFixed(1) : null,
        waveLagMs: m.waveLagN ? +(m.waveLagSum / m.waveLagN).toFixed(1) : null,
    };
    m.history.push(w);
    el._telemetry?.win(w);
    if (m.history.length > 60) m.history.shift();
    m.last = w;

    // Adapt (auto only).
    if (m.pref === 'auto') {
        if (cause === 'visualization') {
            m.bad++; m.clean = 0;
            if (m.bad >= cfg.downAfter && m.level < LEVELS.length - 1) {
                // Re-entering a level we left recently: make it the floor.
                if (now - m.lastStepUpAt < 30000) m.floor = Math.max(m.floor, m.level + 1);
                m.level++; m.bad = 0;
                el._vizLevel = m.level;
                notify(el, `Visuals reduced (${LEVELS[m.level]}) to keep playback smooth`);
            }
        } else {
            m.bad = 0;
            if (cause === 'none') m.clean++; else m.clean = 0;
            if (m.clean >= cfg.upAfter && m.level > m.floor) {
                m.level--; m.clean = 0; m.lastStepUpAt = now;
                el._vizLevel = m.level;
            }
        }
    }
    if (el._perfHud) renderHud(el);

    // Reset the window.
    m.frameCount = 0; m.blockingMs = 0; m.longCount = 0; m.vizAttributedMs = 0;
    m.notes = m.late = m.tight = 0; m.minMarginMs = Infinity;
    m.waveLagMax = m.waveLagSum = m.waveLagN = 0;
    vizMs.fill(0); vizCalls.fill(0);
    m.windowStart = now;
}

/** Summary of the session so far, for the bench modal and tests. */
export function perfReport(el) {
    const h = el._perf?.history || [];
    if (!h.length) return null;
    const n = (f) => h.filter(f).length;
    const avg = (k) => +(h.reduce((s, w) => s + (w[k] || 0), 0) / h.length).toFixed(1);
    return {
        windows: h.length, level: LEVELS[el._perf.level], pref: el._perf.pref,
        engine: el._waveEngine ? 'wave' : 'default',
        vizWindows: n(w => w.cause === 'visualization'), otherWindows: n(w => w.cause === 'other'),
        lateNotes: h.reduce((s, w) => s + w.late, 0), notes: h.reduce((s, w) => s + w.notes, 0),
        avgFps: avg('fps'), avgVizSharePct: avg('vizSharePct'), avgBlockingMsPerS: avg('blockingMsPerS'),
        last: h[h.length - 1],
    };
}

/** One-line plain-language verdict for a report. */
export function perfVerdict(r) {
    if (!r) return 'No live data yet — play a track for a few seconds.';
    const pct = (a) => Math.round(100 * a / r.windows);
    // In the wave engine audio runs on the audio thread: visual jank can't
    // delay it, so say what actually suffered.
    const what = r.engine === 'wave' ? 'the visuals (audio unaffected in the wave engine)' : 'playback';
    const significant = (k) => k >= 2 && pct(k) >= 20;
    if (significant(r.vizWindows) || (r.vizWindows && r.lateNotes)) {
        return `The visualization slowed ${what} in ${pct(r.vizWindows)}% of the session`
            + (r.lateNotes ? ` (${r.lateNotes} late notes)` : '') + `; visuals are now ${r.level}.`;
    }
    if (significant(r.otherWindows) || r.lateNotes) {
        return `${r.engine === 'wave' ? 'The page' : 'Playback'} stuttered in ${pct(r.otherWindows + r.vizWindows)}% of the session, but not because of the visualization`
            + ` (visuals use ${r.avgVizSharePct}% of the main thread)`
            + (r.lateNotes ? `; ${r.lateNotes} late notes.` : '.');
    }
    return `Smooth: ${r.avgFps} fps, visuals use ${r.avgVizSharePct}% of the main thread`
        + (r.notes ? `, ${r.lateNotes} late notes of ${r.notes}.` : '.');
}

// --- notice + ?perf=1 HUD ----------------------------------------------------

function notify(el, text) {
    if (el._perfConfig?.silent) return;
    el.querySelector('.pn-perf-toast')?.remove();
    const t = document.createElement('div');
    t.className = 'pn-perf-toast';
    t.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:9999;'
        + 'background:#222;color:#eee;border:1px solid #444;border-radius:8px;padding:8px 12px;font:13px system-ui;'
        + 'box-shadow:0 4px 16px #0008';
    t.innerHTML = `${text} · <a href="#" style="color:#7cc4ff">keep full visuals</a>`;
    t.querySelector('a').addEventListener('click', (e) => {
        e.preventDefault();
        setVizPreference(el, 'full');
        t.remove();
    });
    el.appendChild(t);
    setTimeout(() => t.remove(), 8000);
}

export function perfHudEnable(el) {
    el._perfHud = true;
    renderHud(el);
}

function renderHud(el) {
    let hud = el.querySelector('.pn-perf-hud');
    if (!hud) {
        hud = document.createElement('pre');
        hud.className = 'pn-perf-hud';
        hud.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:9999;margin:0;padding:6px 8px;'
            + 'background:#000c;color:#9f9;font:11px/1.35 ui-monospace,monospace;border-radius:6px;pointer-events:none';
        el.appendChild(hud);
    }
    const w = el._perf?.last;
    if (!w) { hud.textContent = 'perf: waiting for playback…'; return; }
    const v = w.vizMs;
    hud.textContent =
        `fps ${w.fps}  p95 ${w.p95FrameMs}ms  drop ${(w.dropped * 100).toFixed(0)}%\n` +
        `long ${w.longFrames} (${w.blockingMsPerS}ms/s blocking)\n` +
        `viz ${w.vizSharePct}%  tl ${v.timeline} st ${v.stage} net ${v.net} fire ${v.fire} ms\n` +
        (w.notes ? `notes ${w.notes}  late ${w.late}  tight ${w.tight}  min ${w.minMarginMs}ms\n` : '') +
        (w.waveLagMs != null ? `wave view lag ${w.waveLagMs}ms\n` : '') +
        `cause ${w.cause}  visuals ${LEVELS[w.level]} (${el._perf.pref})`;
}
