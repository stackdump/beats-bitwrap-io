// Scope tab — the track as a filtered marked point process,
//
//     x(t) = tanh(g · Σ_k (h_k * μ_k)(t))
//
// μ_k = the events part k's nets fire, h_k = that part's instrument kernel.
// Backport of beats-py's describe/plot views (wave_py/viz.py) into the live
// studio. Four views, one canvas, a sub-toggle between them:
//
//   Scope    x and μ on one time axis: master waveform (min/max + RMS) from
//            an AnalyserNode time-domain read, the fired events per part as
//            spikes / a piano roll underneath, bar/beat grid, ~4 bars rolling
//   Spectro  log-frequency spectrogram — MODEL by default: each fire deposits
//            v²·‖H_k‖²·|H_fx|² into its part's per-bin state, which decays
//            with the kernel's own decay time; no FFT
//   Bands    per-bar energy in the 5 beats-py bands (+E), quantised 0-9 like
//            the IR (4 dB/step below that band's loudest bar) — MODEL by
//            default: Σ over the bar's events of the same product
//   Raster   μ for the whole arrangement: the project's nets ticked offline
//            (wave-engine/net.js, the worker's deterministic executor),
//            sections marked; computed lazily, once per project
//
// "measured" (off by default) adds the analyser's FFT: measured bands and
// spectrogram beside the model, and the residual (measured − model, dB per
// band after removing each side's per-band mean) — what reverb, delay,
// compression and the master chain add on top of Σ h*μ.
//
// Runs only while the tab is visible and the transport plays: the rAF loop
// starts from scopeSync() (called by vizStartLoop/vizStopLoop and the tab
// button), honours el._vizLevel and is timed as VIZ.SCOPE for the perf
// monitor. The model's per-fire deposits are cheap (≈40 multiply-adds) and
// keep accumulating while playing once the kernel table exists, so the
// bands are complete when the tab is reopened. Hot paths reuse typed arrays.

import { toneEngine, isDrumChannel } from '../../audio/tone-engine.js';
import { vizBegin, vizEnd, VIZ } from '../perf/monitor.js';
import { vizColorForNet } from '../backend/audio-io.js';
import { sectionGroupForNet } from './mixer.js';
import {
    NB, NS, NR, BANDS, BAND_LABELS, SPEC_EDGES,
    laneKernelSpecs, laneKernelTable, kernelFor, renderKernels, getKernel, fxResponse,
} from './scope-model.js';

const VIEWS = [
    ['live', 'Scope', 'Waveform x and fired events μ on one time axis (rolling 4 bars)'],
    ['spectro', 'Spectro', 'Log-frequency spectrogram — model (Σ events × kernel × FX); measured below when on'],
    ['bands', 'Bands', 'Per-bar band energy, IR digits 0-9 (4 dB/step below each band\'s loudest bar)'],
    ['raster', 'Raster', 'Score raster μ of the whole arrangement, sections marked'],
];
const VIZ_MIN_FRAME_MS = [1000 / 30, 1000 / 15, 1000 / 8, 1000 / 4];
const GROUP_ORDER = ['drums', 'percussion', 'bass', 'chords', 'harmony', 'lead', 'melody', 'arp', 'pad', 'texture', 'stinger'];
const FALLBACK_COLORS = ['#00d2ff', '#2ecc71', '#9b59b6', '#f5a623', '#4a90d9', '#ff6b6b', '#1abc9c', '#e67e22'];
const FONT = '10px ui-monospace, SFMono-Regular, monospace';
const BG = '#050a14', GRID = '#1a2a3a', BARLINE = '#2f4a6a', SECTION = '#e94560', TEXT = '#8899aa';
const WINDOW_STEPS = 64;            // 4 bars
const MAX_BARS = 1024;
const EV_CAP = 4096, AN_CAP = 64, WF_CAP = 8192, SPEC_CAP = 2048, MSPEC_CAP = 512;
const FFT_SIZE = 4096, BLOCK = 256;
const LEVEL_DB = 4;                 // one IR digit
const ROWS = NB + 1;                // bands + E

// --- colour maps (256-entry RGB LUTs, built once) ---------------------------

function lut(stops) {
    const out = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
        const x = i / 255 * (stops.length - 1);
        const a = Math.min(stops.length - 2, Math.floor(x)), f = x - a;
        for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(stops[a][c] + (stops[a + 1][c] - stops[a][c]) * f);
    }
    return out;
}
const MAGMA = lut([[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 253, 191]]);
const VIRIDIS = lut([[68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142], [31, 158, 137], [53, 183, 121], [110, 206, 88], [181, 222, 43], [253, 231, 37]]);
const RDBU = lut([[33, 102, 172], [103, 169, 207], [209, 229, 240], [247, 247, 247], [253, 219, 199], [239, 138, 98], [178, 24, 43]]);
const lutCss = (L, i) => { i = Math.max(0, Math.min(255, i | 0)) * 3; return `rgb(${L[i]},${L[i + 1]},${L[i + 2]})`; };
// Digit colours precomputed so the bands view assigns strings, not builds them.
const DIGIT_CSS = Array.from({ length: 10 }, (_, d) => lutCss(VIRIDIS, d / 9 * 255));
const RES_CSS = Array.from({ length: 33 }, (_, i) => lutCss(RDBU, i / 32 * 255));

const fin = (v) => Number.isFinite(v);

// --- state --------------------------------------------------------------------

function state(el) {
    if (el._scope) return el._scope;
    el._scope = {
        view: 'live', measured: false, opened: false,
        running: false, raf: 0, lastDraw: 0, lastT: 0,
        lanes: [], laneOf: new Map(), channels: [], sections: [],
        // live event ring
        evT: new Float64Array(EV_CAP), evLane: new Uint8Array(EV_CAP), evNote: new Uint8Array(EV_CAP),
        evVel: new Uint8Array(EV_CAP), evDur: new Float32Array(EV_CAP), evHead: 0, evCount: 0,
        // (audio time, song step) anchors from fires
        anT: new Float64Array(AN_CAP), anS: new Float64Array(AN_CAP), anHead: 0, anCount: 0, lastStep: -1,
        // waveform blocks
        wfT: new Float64Array(WF_CAP), wfMin: new Float32Array(WF_CAP), wfMax: new Float32Array(WF_CAP),
        wfSq: new Float32Array(WF_CAP), wfHead: 0, wfCount: 0, readT: 0, peak: 0.1,
        // analyser
        an: null, anSrc: null, td: new Float32Array(FFT_SIZE), fd: new Float32Array(FFT_SIZE / 2),
        binLo: new Int32Array(NR), binHi: new Int32Array(NR), binSr: 0,
        // model
        laneTables: [], kbuf: new Float32Array(NR), fx: new Float32Array(32 * NR).fill(1), fxAt: 0,
        kernelStatus: 'model idle', kernelJob: null, kernelMs: 0, kernelCount: 0,
        modelBars: new Float64Array(MAX_BARS * ROWS), measBars: new Float64Array(MAX_BARS * ROWS),
        measCnt: new Float32Array(MAX_BARS), maxBar: -1, modelFrom: Infinity, measFrom: Infinity, measAt: -1,
        // model spectrogram: per-lane decaying state, finalised one column per step
        laneState: new Float32Array(0), laneDecay: new Float32Array(0), laneMean: new Float32Array(0),
        specTickSec: 0, specCol: new Float32Array(SPEC_CAP * NS), specStep: new Int32Array(SPEC_CAP).fill(-1),
        specCur: -1,
        // measured spectrogram frames
        mspT: new Float64Array(MSPEC_CAP), mspV: new Float32Array(MSPEC_CAP * NS), mspHead: 0, mspCount: 0,
        mpow: new Float32Array(NR),
        // drawing scratch, resized with the canvas
        colMin: new Float32Array(0), colMax: new Float32Array(0), colSq: new Float32Array(0), colN: new Uint16Array(0),
        mCan: null, mImg: null, sCan: null, sImg: null, rCan: null, rKey: '',
        raster: null, rasterKey: '', projectGen: 0,
        cost: { live: 0, spectro: 0, bands: 0, raster: 0, measured: 0, model: 0 }, fires: 0,
        stats: null,
    };
    return el._scope;
}

const ema = (prev, v) => prev ? prev * 0.9 + v * 0.1 : v;
const tickSecOf = (el) => { const t = el._tempo; return 60 / ((fin(t) && t > 0 ? t : 120) * 4); };
function rawCtx() { try { return window.Tone?.getContext?.()?.rawContext || null; } catch { return null; } }
function ctxNow() { const c = rawCtx(); return c && fin(c.currentTime) ? c.currentTime : 0; }

// --- project → lanes ------------------------------------------------------

function durMsOf(m, tempo) {
    const bpm = fin(tempo) && tempo > 0 ? tempo : 120;
    if (m.durationSteps > 0) return m.durationSteps * 60000 / bpm / 4;
    return fin(m.duration) && m.duration > 0 ? m.duration : 100;
}

function buildLanes(el) {
    const s = state(el);
    const nets = el._project?.nets || {};
    const byKey = new Map();
    let fb = 0;
    for (const [id, net] of Object.entries(nets)) {
        if (!net || net.role === 'control' || !net.track || id.startsWith('macro:')) continue;
        const key = net.riffGroup || id.replace(/-\d+$/, '');
        let lane = byKey.get(key);
        if (!lane) {
            const ch = net.track.channel ?? 1;
            let color = vizColorForNet(id);
            if (color === '#888') color = FALLBACK_COLORS[fb++ % FALLBACK_COLORS.length];
            lane = { key, ids: [], channel: ch, group: sectionGroupForNet(id, net), drum: isDrumChannel(ch),
                inst: net.track.instrument || '', notes: new Set(), durs: [], lo: 127, hi: 0, color };
            byKey.set(key, lane);
        }
        lane.ids.push(id);
        for (const t of Object.values(net.transitions || {})) {
            const m = t?.midi;
            if (!m || !fin(m.note)) continue;
            lane.notes.add(m.note);
            if (lane.durs.length < 256) lane.durs.push(durMsOf(m, el._tempo));
            if (m.note < lane.lo) lane.lo = m.note;
            if (m.note > lane.hi) lane.hi = m.note;
        }
    }
    const rank = (g) => { const i = GROUP_ORDER.indexOf(g); return i < 0 ? GROUP_ORDER.length : i; };
    const lanes = [...byKey.values()].sort((a, b) => (b.drum - a.drum) || rank(a.group) - rank(b.group) || a.key.localeCompare(b.key));
    s.lanes = lanes.slice(0, 32);
    s.laneOf = new Map();
    s.lanes.forEach((l, i) => { for (const id of l.ids) s.laneOf.set(id, i); if (l.lo > l.hi) { l.lo = 48; l.hi = 72; } });
    s.channels = [...new Set(s.lanes.map(l => l.channel))];
    const L = s.lanes.length;
    s.laneState = new Float32Array(L * NS);
    s.laneDecay = new Float32Array(L);
    s.laneMean = new Float32Array(L);
    s.specTickSec = 0;
    s.laneTables = new Array(L).fill(null);
    // Section starts in song steps.
    s.sections = [];
    let at = 0;
    for (const sec of el._structure || []) {
        s.sections.push({ step: at, name: sec.name || '' });
        at += sec.steps || 0;
    }
}

function laneInstrument(lane) {
    return toneEngine.getChannelInstrument?.(lane.channel) || lane.inst || (lane.drum ? 'drums' : 'piano');
}

/** Build the per-lane kernel tables; render whatever the cache lacks. */
function ensureKernels(el) {
    const s = state(el);
    if (!s.opened || !s.lanes.length) return;
    const specsByLane = s.lanes.map(l => laneKernelSpecs(l, laneInstrument(l)));
    const assemble = () => {
        let ready = 0;
        specsByLane.forEach((specs, i) => {
            const t = laneKernelTable(specs, s.lanes[i].drum);
            s.laneTables[i] = t;
            if (t) ready++;
        });
        s.kernelCount = specsByLane.reduce((n, x) => n + x.length, 0);
        s.kernelStatus = ready === s.lanes.length ? `model · ${s.kernelCount} kernels`
            : `model · ${ready}/${s.lanes.length} parts`;
        return ready;
    };
    if (assemble() === s.lanes.length) return;
    const missing = specsByLane.flat().filter(sp => !getKernel(sp.key));
    s.kernelStatus = `model · rendering ${missing.length} kernels…`;
    const gen = s.projectGen;
    const job = (s.kernelJob || Promise.resolve()).then(async () => {
        const t0 = performance.now();
        await renderKernels(missing);
        s.kernelMs = Math.round(performance.now() - t0);
        if (gen === s.projectGen) { assemble(); s.kernelStatus += ` (${s.kernelMs} ms)`; }
        updateStatus(el);
    }).catch(err => {
        console.warn('scope: kernel render failed', err);
        s.kernelStatus = 'model unavailable (kernel render failed)';
        updateStatus(el);
    });
    s.kernelJob = job;
}

/** Project sync hook: rebuild lanes; a new track (not an echo) resets the history. */
export function scopeOnProject(el, isNew) {
    const s = state(el);
    s.projectGen++;
    buildLanes(el);
    if (isNew) resetHistory(s);
    s.raster = null;
    if (s.opened) ensureKernels(el);
    if (el._showScope) { renderScopePanel(el); scopeSync(el); }
}

function resetHistory(s) {
    s.modelBars.fill(0); s.measBars.fill(0); s.measCnt.fill(0); s.maxBar = -1;
    // First step each side saw since the reset, and the latest measured step:
    // bars either side only partly covered are left out of the residual.
    s.modelFrom = Infinity; s.measFrom = Infinity; s.measAt = -1;
    s.anCount = 0; s.lastStep = -1;
    s.specStep.fill(-1); s.specCur = -1; s.laneState.fill(0);
    s.mspCount = 0; s.stats = null;
}

// --- events -----------------------------------------------------------------

function pushAnchor(s, t, step) {
    if (s.anCount && s.anS[(s.anHead + AN_CAP - 1) % AN_CAP] === step) return;
    s.anT[s.anHead] = t; s.anS[s.anHead] = step;
    s.anHead = (s.anHead + 1) % AN_CAP;
    if (s.anCount < AN_CAP) s.anCount++;
}

/** Latest anchor at or before t (else the oldest). Returns ring index or -1. */
function anchorAt(s, t) {
    if (!s.anCount) return -1;
    let idx = -1;
    for (let k = 1; k <= s.anCount; k++) {
        const i = (s.anHead - k + AN_CAP) % AN_CAP;
        idx = i;
        if (s.anT[i] <= t) break;
    }
    return idx;
}

/**
 * Fire hook (lib/backend/index.js). t = when the note sounds (audio-context
 * seconds), gridT = the unswung grid time, tick = the worker / worklet tick
 * the fire happened on (step = tick − 1; absent on the WS backend).
 */
export function scopeOnFire(el, netId, midi, t, gridT, tick) {
    const s = el._scope;
    if (!s || !midi) return;
    const li = s.laneOf.get(netId);
    if (li === undefined) return;
    const tickSec = tickSecOf(el);
    const now = ctxNow();
    if (!fin(t)) t = now;
    if (!fin(gridT)) gridT = t;
    let step;
    if (fin(tick)) step = tick - 1;
    else {
        const tickMs = tickSec * 1000;
        const el2 = el._tickTimestamp > 0 ? (performance.now() - el._tickTimestamp) / tickMs : 0;
        step = Math.round((el._tick || 0) - 1 + Math.min(6, Math.max(0, el2)));
    }
    if (!fin(step)) return;
    // A restart from the top (repeat / re-play) without a loop region: start the bars afresh.
    const looping = (el._loopStart > 0) || (el._loopEnd > 0 && el._totalSteps > 0 && el._loopEnd < el._totalSteps);
    if (s.lastStep >= 0 && step < s.lastStep - 32 && !looping) resetHistory(s);
    s.lastStep = step;
    pushAnchor(s, gridT, step);

    const durMs = durMsOf(midi, el._tempo);
    const i = s.evHead;
    s.evT[i] = t; s.evLane[i] = li; s.evNote[i] = (midi.note | 0) & 127;
    s.evVel[i] = Math.max(1, Math.min(127, midi.velocity || 100));
    s.evDur[i] = durMs / 1000;
    s.evHead = (i + 1) % EV_CAP;
    if (s.evCount < EV_CAP) s.evCount++;
    s.fires++;

    const kt = s.laneTables[li];
    if (kt) modelDeposit(el, s, li, kt, s.evNote[i], s.evVel[i], durMs, step, tickSec);
}

function modelDeposit(el, s, li, kt, note, vel, durMs, step, tickSec) {
    const t0 = performance.now();
    if (t0 - s.fxAt > 200) { fxResponse(s.fx, s.channels, rawCtx()?.sampleRate || 44100); s.fxAt = t0; }
    const k = s.kbuf;
    kernelFor(kt, note, k);
    let e = (vel / 100) * (vel / 100);
    if (!kt.drum) e *= Math.max(0.25, Math.min(4, durMs / kt.durMs));
    const off = (s.lanes[li].channel & 31) * NR;
    const fx = s.fx;
    const bar = Math.floor(step / 16);
    if (bar >= 0 && bar < MAX_BARS) {
        let sum = 0;
        const o = bar * ROWS;
        for (let b = 0; b < NB; b++) {
            const v = e * k[b] * fx[off + b];
            s.modelBars[o + b] += v; sum += v;
        }
        s.modelBars[o + NB] += sum;
        if (bar > s.maxBar) s.maxBar = bar;
        if (step < s.modelFrom) s.modelFrom = step;
    }
    // Spectrogram state: energy rate e/τ, decaying with the kernel.
    specAdvance(s, step, tickSec);
    const lo = li * NS, inv = 1 / kt.tau;
    for (let j = 0; j < NS; j++) s.laneState[lo + j] += e * k[NB + j] * fx[off + NB + j] * inv;
    s.cost.model = ema(s.cost.model, performance.now() - t0);
}

function specAdvance(s, step, tickSec) {
    const L = s.lanes.length;
    if (s.specTickSec !== tickSec) {
        for (let l = 0; l < L; l++) {
            const tau = s.laneTables[l]?.tau || 0.1;
            const d = Math.exp(-tickSec / tau);
            s.laneDecay[l] = d;
            s.laneMean[l] = tau / tickSec * (1 - d);   // mean of e^{-t/τ} over one step
        }
        s.specTickSec = tickSec;
    }
    if (s.specCur >= 0 && (step < s.specCur - 8 || step > s.specCur + SPEC_CAP)) {
        s.laneState.fill(0); s.specCur = -1;
    }
    if (s.specCur < 0) { s.specCur = step; return; }
    while (s.specCur < step) {
        const c = s.specCur, o = (c % SPEC_CAP) * NS;
        for (let j = 0; j < NS; j++) s.specCol[o + j] = 0;
        for (let l = 0; l < L; l++) {
            const m = s.laneMean[l], d = s.laneDecay[l], lo = l * NS;
            for (let j = 0; j < NS; j++) { s.specCol[o + j] += s.laneState[lo + j] * m; s.laneState[lo + j] *= d; }
        }
        s.specStep[c % SPEC_CAP] = c;
        s.specCur++;
    }
}

// --- analyser (live waveform always; FFT only when "measured" is on) -------

function analyserSource() {
    // Wave engine (lean): worklet → _waveGain → out, Tone's master unhooked.
    return toneEngine._waveGain || toneEngine._masterComp || null;
}

function ensureAnalyser(s) {
    const src = analyserSource();
    if (!src) return null;
    if (s.an && s.anSrc === src) return s.an;
    detachAnalyser(s);
    try {
        const ctx = window.Tone.getContext();
        const an = ctx.createAnalyser();
        an.fftSize = FFT_SIZE;
        an.smoothingTimeConstant = 0;
        // Read-only tap: an AnalyserNode has no outputs connected, so the
        // audio path is unchanged.
        window.Tone.connect(src, an);
        s.an = an; s.anSrc = src; s.readT = 0;
        const sr = ctx.sampleRate || 44100;
        if (s.binSr !== sr) {
            const df = sr / FFT_SIZE, edges = [];
            for (const [lo, hi] of BANDS) edges.push([lo, hi]);
            for (let i = 0; i < NS; i++) edges.push([SPEC_EDGES[i], SPEC_EDGES[i + 1]]);
            edges.forEach(([lo, hi], j) => {
                const a = Math.max(1, Math.round(lo / df));
                s.binLo[j] = a; s.binHi[j] = Math.min(FFT_SIZE / 2, Math.max(a + 1, Math.round(hi / df)));
            });
            s.binSr = sr;
        }
        return an;
    } catch (err) {
        console.warn('scope: analyser unavailable', err);
        return null;
    }
}

function detachAnalyser(s) {
    if (!s.an) return;
    try { window.Tone.disconnect(s.anSrc, s.an); } catch { try { s.anSrc?.disconnect?.(s.an); } catch {} }
    s.an = null; s.anSrc = null;
}

function readWaveform(s, an, tNow, sr) {
    an.getFloatTimeDomainData(s.td);
    let n = s.readT > 0 ? Math.round((tNow - s.readT) * sr) : FFT_SIZE;
    if (!(n > 0)) return;
    if (n > FFT_SIZE) { n = FFT_SIZE; s.readT = tNow - n / sr; }
    const nb = Math.floor(n / BLOCK);
    if (!nb) return;
    const start = FFT_SIZE - nb * BLOCK;
    for (let b = 0; b < nb; b++) {
        let mn = 1, mx = -1, sq = 0;
        const a = start + b * BLOCK;
        for (let i = a; i < a + BLOCK; i++) {
            const x = s.td[i];
            if (x < mn) mn = x;
            if (x > mx) mx = x;
            sq += x * x;
        }
        const w = s.wfHead;
        s.wfT[w] = tNow - (FFT_SIZE - (a + BLOCK)) / sr;
        s.wfMin[w] = mn; s.wfMax[w] = mx; s.wfSq[w] = sq / BLOCK;
        s.wfHead = (w + 1) % WF_CAP;
        if (s.wfCount < WF_CAP) s.wfCount++;
        const pk = Math.max(-mn, mx);
        if (pk > s.peak) s.peak = pk;
    }
    s.readT += nb * BLOCK / sr;
}

function readMeasured(el, s, an, tNow, tickSec) {
    const t0 = performance.now();
    an.getFloatFrequencyData(s.fd);
    const fd = s.fd, p = s.mpow;
    for (let j = 0; j < NR; j++) {
        let sum = 0;
        for (let k = s.binLo[j]; k < s.binHi[j]; k++) { const db = fd[k]; if (db > -200) sum += Math.pow(10, db / 10); }
        p[j] = sum;
    }
    // Bars: mean power per bar, mapped through the step anchors.
    const ai = anchorAt(s, tNow);
    if (ai >= 0) {
        const step = s.anS[ai] + (tNow - s.anT[ai]) / tickSec;
        const bar = Math.floor(step / 16);
        if (bar >= 0 && bar < MAX_BARS && fin(step)) {
            const o = bar * ROWS;
            let sum = 0;
            for (let b = 0; b < NB; b++) { s.measBars[o + b] += p[b]; sum += p[b]; }
            s.measBars[o + NB] += sum;
            s.measCnt[bar]++;
            if (bar > s.maxBar) s.maxBar = bar;
            if (step < s.measFrom) s.measFrom = step;
            s.measAt = step;
        }
    }
    const w = s.mspHead, o = w * NS;
    s.mspT[w] = tNow;
    for (let j = 0; j < NS; j++) s.mspV[o + j] = 10 * Math.log10(p[NB + j] + 1e-20);
    s.mspHead = (w + 1) % MSPEC_CAP;
    if (s.mspCount < MSPEC_CAP) s.mspCount++;
    s.cost.measured = ema(s.cost.measured, performance.now() - t0);
}

// --- panel ---------------------------------------------------------------------

export function renderScopePanel(el) {
    const panel = el.querySelector('.pn-scope-panel');
    if (!panel) return;
    const s = state(el);
    if (!panel.firstChild) {
        panel.innerHTML = `
            <div class="pn-scope-bar">
                <span class="pn-scope-views">${VIEWS.map(([id, label, title]) =>
                    `<button type="button" data-view="${id}" title="${title}">${label}</button>`).join('')}</span>
                <label class="pn-scope-measured" title="Also read the master through an AnalyserNode: measured bands / spectrogram beside the model, and the residual (measured − model) per band">
                    <input type="checkbox"> measured</label>
                <span class="pn-scope-status"></span>
            </div>
            <div class="pn-scope-wrap"><canvas class="pn-scope-canvas"></canvas></div>
            <div class="pn-scope-caption">x = tanh(g · Σ<sub>k</sub> h<sub>k</sub> * μ<sub>k</sub>) — μ<sub>k</sub>: fired events per part · h<sub>k</sub>: instrument kernels</div>`;
        panel.querySelector('.pn-scope-views').addEventListener('click', (e) => {
            const b = e.target.closest('button[data-view]');
            if (!b) return;
            s.view = b.dataset.view;
            syncPanel(el);
            drawOnce(el);
        });
        const cb = panel.querySelector('.pn-scope-measured input');
        cb.addEventListener('change', () => {
            s.measured = cb.checked;
            if (s.measured) s.measFrom = Infinity;   // a re-enable starts a fresh coverage window
            if (!s.measured) detachAnalyserIfIdle(s);
            syncPanel(el);
            drawOnce(el);
        });
        const canvas = panel.querySelector('.pn-scope-canvas');
        if (typeof ResizeObserver !== 'undefined') {
            // The panel is rebuilt with the UI on every project sync; drop the old observer.
            s.ro?.disconnect();
            s.ro = new ResizeObserver(() => { s.sizeDirty = true; if (!s.running) drawOnce(el); });
            s.ro.observe(canvas);
        }
    }
    syncPanel(el);
}

function detachAnalyserIfIdle(s) {
    if (!s.running) detachAnalyser(s);
}

function viewHeight(s) {
    switch (s.view) {
    case 'spectro': return s.measured ? 300 : 170;
    case 'bands': return s.measured ? 300 : 124;
    case 'raster': return Math.max(90, Math.min(560, s.lanes.length * 18 + 32));
    default: return Math.max(170, Math.min(320, 110 + s.lanes.length * 12));
    }
}

function syncPanel(el) {
    const s = state(el);
    const panel = el.querySelector('.pn-scope-panel');
    if (!panel) return;
    panel.querySelectorAll('.pn-scope-views button').forEach(b => b.classList.toggle('active', b.dataset.view === s.view));
    const cb = panel.querySelector('.pn-scope-measured input');
    if (cb) cb.checked = s.measured;
    // The canvas is absolutely positioned inside the wrapper so its pixel
    // size never feeds back into the flex layout (it would widen the panel).
    const wrap = panel.querySelector('.pn-scope-wrap');
    const h = viewHeight(s) + 'px';
    if (wrap && wrap.style.height !== h) { wrap.style.height = h; s.sizeDirty = true; }
    updateStatus(el);
}

function updateStatus(el) {
    const s = state(el);
    const st = el.querySelector('.pn-scope-status');
    if (!st) return;
    let txt = s.kernelStatus;
    if (s.view === 'raster' && s.raster) txt = `raster · ${s.raster.n} events · ${s.raster.steps / 16} bars · ${s.raster.ms} ms`;
    if (!s.running && s.view !== 'raster') txt += ' · paused (plays when transport runs)';
    st.textContent = txt;
}

/** Start/stop the loop: runs only while the tab is open and the transport plays. */
export function scopeSync(el) {
    const s = state(el);
    const want = !!(el._showScope && el._playing);
    if (el._showScope && !s.opened) { s.opened = true; if (!s.lanes.length) buildLanes(el); ensureKernels(el); }
    if (want && !s.running) {
        s.running = true;
        s.lastDraw = 0;
        const loop = (now) => {
            if (!s.running) return;
            s.raf = requestAnimationFrame(loop);
            if (now - s.lastDraw < VIZ_MIN_FRAME_MS[Math.min(3, el._vizLevel | 0)]) return;
            s.lastDraw = now;
            const t0 = vizBegin();
            try { frame(el, s); } catch (err) {
                if (!s.warned) { s.warned = true; console.warn('scope frame failed', err); }
            }
            vizEnd(VIZ.SCOPE, t0);
        };
        s.raf = requestAnimationFrame(loop);
        updateStatus(el);
    } else if (!want && s.running) {
        s.running = false;
        cancelAnimationFrame(s.raf);
        detachAnalyser(s);
        updateStatus(el);
        drawOnce(el);
    } else if (!want && el._showScope) {
        drawOnce(el);
    }
}

function drawOnce(el) {
    const s = state(el);
    if (!el._showScope) return;
    try { draw(el, s, false); } catch (err) { console.warn('scope draw failed', err); }
    updateStatus(el);
}

function frame(el, s) {
    const tickSec = tickSecOf(el);
    const tNow = ctxNow();
    if (fin(tNow) && tNow > 0) s.lastT = tNow;
    const needWave = s.view === 'live';
    if (needWave || s.measured) {
        const an = ensureAnalyser(s);
        if (an) {
            const sr = rawCtx()?.sampleRate || 44100;
            if (needWave) readWaveform(s, an, s.lastT, sr);
            else s.readT = 0;
            if (s.measured) readMeasured(el, s, an, s.lastT, tickSec);
        }
    } else if (s.an) detachAnalyser(s);
    // Finalise model spectrogram columns up to (not including) the sounding step.
    const ai = anchorAt(s, s.lastT);
    if (ai >= 0 && s.specCur >= 0) {
        const step = Math.floor(s.anS[ai] + (s.lastT - s.anT[ai]) / tickSec) - 1;
        if (fin(step) && step > s.specCur && step - s.specCur < 64) specAdvance(s, step, tickSec);
    }
    // Bands change bar by bar: 4 Hz is plenty, and its per-cell text is the
    // priciest draw here.
    if (s.view === 'bands') {
        const now = performance.now();
        if (now - (s.bandsAt || 0) < 250) return;
        s.bandsAt = now;
    }
    draw(el, s, true);
}

function canvasCtx(el, s) {
    const canvas = el.querySelector('.pn-scope-canvas');
    if (!canvas) return null;
    if (s.canvas !== canvas) { s.canvas = canvas; s.sizeDirty = true; }
    if (s.sizeDirty) {
        const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
        const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
        s.cssW = w; s.cssH = h; s.dpr = dpr; s.sizeDirty = false;
        if (s.colMin.length < w) {
            s.colMin = new Float32Array(w); s.colMax = new Float32Array(w);
            s.colSq = new Float32Array(w); s.colN = new Uint16Array(w);
        }
        s.rKey = '';
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
    return ctx;
}

function draw(el, s, live) {
    const ctx = canvasCtx(el, s);
    if (!ctx || !(s.cssW > 0) || !(s.cssH > 0)) return;
    const t0 = performance.now();
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, s.cssW, s.cssH);
    ctx.font = FONT;
    ctx.textBaseline = 'top';
    switch (s.view) {
    case 'spectro': drawSpectro(el, s, ctx); break;
    case 'bands': drawBands(el, s, ctx); break;
    case 'raster': drawRaster(el, s, ctx); break;
    default: drawLive(el, s, ctx);
    }
    if (live) s.cost[s.view] = ema(s.cost[s.view], performance.now() - t0);
}

// Time axis shared by the live views: right edge = now, WINDOW_STEPS wide.
function timeAxis(el, s, x0, w) {
    const tickSec = tickSecOf(el);
    const win = WINDOW_STEPS * tickSec;
    const tNow = s.lastT;
    const ai = anchorAt(s, tNow);
    const ax = { tickSec, win, tNow, t0: tNow - win, x0, w, ok: fin(win) && win > 0 && fin(tNow),
        aT: ai >= 0 ? s.anT[ai] : NaN, aS: ai >= 0 ? s.anS[ai] : NaN };
    return ax;
}
const xOf = (ax, t) => ax.x0 + (t - ax.t0) / ax.win * ax.w;
const stepOf = (ax, t) => ax.aS + (t - ax.aT) / ax.tickSec;
const timeOf = (ax, st) => ax.aT + (st - ax.aS) * ax.tickSec;

function drawGrid(s, ctx, ax, y0, y1, labels) {
    if (!fin(ax.aT)) return;
    const sA = Math.ceil(stepOf(ax, ax.t0) / 4) * 4, sB = stepOf(ax, ax.tNow);
    if (!fin(sA) || !fin(sB) || sB - sA > 4096) return;
    for (let st = sA; st <= sB; st += 4) {
        const x = xOf(ax, timeOf(ax, st));
        if (!fin(x)) continue;
        const bar = st % 16 === 0;
        ctx.fillStyle = bar ? BARLINE : GRID;
        ctx.fillRect(Math.round(x), y0, 1, y1 - y0);
        if (bar && labels && st >= 0) { ctx.fillStyle = TEXT; ctx.fillText(String(st / 16 + 1), x + 3, y1 + 1); }
    }
    for (const sec of s.sections) {
        if (sec.step < stepOf(ax, ax.t0) || sec.step > sB) continue;
        const x = xOf(ax, timeOf(ax, sec.step));
        if (!fin(x)) continue;
        ctx.fillStyle = SECTION;
        ctx.fillRect(Math.round(x) - 1, y0, 2, y1 - y0);
        ctx.fillText(sec.name, x + 4, y0 + 2);
    }
}

function drawLive(el, s, ctx) {
    const W = s.cssW, H = s.cssH;
    const axisH = 12;
    const hTop = Math.round((H - axisH) * 0.5);
    const ax = timeAxis(el, s, 0, W);
    if (!ax.ok) return;
    drawGrid(s, ctx, ax, 0, H - axisH, true);
    // Waveform: per-pixel min/max and RMS from the block ring.
    const n = Math.min(W | 0, s.colMin.length);
    s.colMin.fill(1, 0, n); s.colMax.fill(-1, 0, n); s.colSq.fill(0, 0, n); s.colN.fill(0, 0, n);
    for (let k = 1; k <= s.wfCount; k++) {
        const i = (s.wfHead - k + WF_CAP) % WF_CAP;
        const t = s.wfT[i];
        if (t < ax.t0) break;
        const x = Math.floor(xOf(ax, t));
        if (!(x >= 0 && x < n)) continue;
        if (s.wfMin[i] < s.colMin[x]) s.colMin[x] = s.wfMin[i];
        if (s.wfMax[i] > s.colMax[x]) s.colMax[x] = s.wfMax[i];
        s.colSq[x] += s.wfSq[i]; s.colN[x]++;
    }
    s.peak = Math.max(0.05, s.peak * 0.998);
    const mid = hTop / 2, sc = (hTop / 2 - 3) / s.peak;
    ctx.fillStyle = 'rgba(74,144,217,0.6)';
    for (let x = 0; x < n; x++) {
        if (!s.colN[x]) continue;
        const top = mid - s.colMax[x] * sc, h = (s.colMax[x] - s.colMin[x]) * sc;
        if (fin(top) && fin(h)) ctx.fillRect(x, top, 1, Math.max(1, h));
    }
    ctx.strokeStyle = '#f5a623';
    ctx.lineWidth = 1.2;
    for (const sign of [-1, 1]) {
        ctx.beginPath();
        let started = false;
        for (let x = 0; x < n; x++) {
            if (!s.colN[x]) continue;
            const y = mid - sign * Math.sqrt(s.colSq[x] / s.colN[x]) * sc;
            if (!fin(y)) continue;
            if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
        }
        ctx.stroke();
    }
    ctx.fillStyle = TEXT;
    ctx.fillText(`x · ±${s.peak.toFixed(2)}`, W - 70, 2);
    if (!s.wfCount) ctx.fillText(s.running ? 'waiting for audio…' : 'press play', 6, mid - 5);
    // μ: one lane per part.
    const L = s.lanes.length;
    if (!L) return;
    const ly0 = hTop + 2, lh = (H - axisH - ly0) / L;
    ctx.fillStyle = GRID;
    for (let l = 0; l <= L; l++) ctx.fillRect(0, Math.round(ly0 + l * lh), W, 1);
    for (let k = 1; k <= s.evCount; k++) {
        const i = (s.evHead - k + EV_CAP) % EV_CAP;
        const t = s.evT[i];
        if (t < ax.t0 - 4) break;
        if (t > ax.tNow) continue;
        const lane = s.lanes[s.evLane[i]];
        if (!lane) continue;
        const x = xOf(ax, t);
        const yb = ly0 + (s.evLane[i] + 1) * lh;
        ctx.fillStyle = lane.color;
        if (lane.drum) {
            const h = s.evVel[i] / 127 * lh * 0.85;
            if (fin(x) && x >= 0) ctx.fillRect(x, yb - h, 1.5, h);
        } else {
            const span = Math.max(1, lane.hi - lane.lo);
            const y = yb - lh * (0.1 + 0.8 * (s.evNote[i] - lane.lo) / span);
            let w = s.evDur[i] / ax.win * W;
            const xs = Math.max(0, x);
            w = Math.min(w - (xs - x), ax.w - xs);
            if (fin(y) && fin(w) && w > 0) ctx.fillRect(xs, y - 1, Math.max(1.5, w - 1), 2);
        }
    }
    if (lh >= 8) {
        for (let l = 0; l < L; l++) {
            ctx.fillStyle = 'rgba(5,10,20,0.7)';
            const label = s.lanes[l].key;
            const tw = ctx.measureText(label).width;
            ctx.fillRect(2, ly0 + l * lh + 1, tw + 4, Math.min(11, lh - 1));
            ctx.fillStyle = s.lanes[l].color;
            ctx.fillText(label, 4, ly0 + l * lh + 1);
        }
    }
}

// --- spectrogram -----------------------------------------------------------

function ensureImg(s, which, w, h) {
    const can = which === 'm' ? 'mCan' : 'sCan', img = which === 'm' ? 'mImg' : 'sImg';
    if (!s[can]) s[can] = document.createElement('canvas');
    if (!s[img] || s[img].width !== w || s[img].height !== h) {
        s[can].width = w; s[can].height = h;
        s[img] = s[can].getContext('2d').createImageData(w, h);
    }
    return s[img];
}

function freqLabels(ctx, x, y0, h) {
    const lo = Math.log(SPEC_EDGES[0]), hi = Math.log(SPEC_EDGES[NS]);
    ctx.fillStyle = TEXT;
    for (const [f, label] of [[50, '50'], [200, '200'], [1000, '1k'], [4000, '4k'], [12000, '12k']]) {
        const y = y0 + h - (Math.log(f) - lo) / (hi - lo) * h;
        ctx.fillText(label, x, Math.max(y0, Math.min(y0 + h - 10, y - 5)));
    }
}

function drawSpectro(el, s, ctx) {
    const W = s.cssW, H = s.cssH, gut = 30, axisH = 12;
    const ax = timeAxis(el, s, gut, W - gut);
    if (!ax.ok) return;
    const blocks = s.measured ? 2 : 1;
    const bh = (H - axisH - (blocks - 1) * 6) / blocks;
    ctx.imageSmoothingEnabled = false;
    // Model: one column per step.
    if (fin(ax.aT)) {
        const first = Math.floor(stepOf(ax, ax.t0));
        const cols = WINDOW_STEPS + 2;
        const img = ensureImg(s, 'm', cols, NS);
        const d = img.data;
        let mx = -Infinity;
        for (let c = 0; c < cols; c++) {
            const st = first + c;
            if (st < 0 || st >= s.specCur || s.specStep[st % SPEC_CAP] !== st) continue;
            const o = (st % SPEC_CAP) * NS;
            for (let j = 0; j < NS; j++) { const v = s.specCol[o + j]; if (v > 0) { const db = 10 * Math.log10(v); if (db > mx) mx = db; } }
        }
        const floor = mx - 50;
        for (let c = 0; c < cols; c++) {
            const st = first + c;
            const valid = st >= 0 && st < s.specCur && s.specStep[st % SPEC_CAP] === st && fin(mx);
            const o = (st % SPEC_CAP) * NS;
            for (let j = 0; j < NS; j++) {
                const p = ((NS - 1 - j) * cols + c) * 4;
                let li = 0;
                if (valid) { const v = s.specCol[o + j]; li = v > 0 ? (10 * Math.log10(v) - floor) / 50 * 255 : 0; }
                li = Math.max(0, Math.min(255, li | 0)) * 3;
                d[p] = MAGMA[li]; d[p + 1] = MAGMA[li + 1]; d[p + 2] = MAGMA[li + 2]; d[p + 3] = 255;
            }
        }
        s.mCan.getContext('2d').putImageData(img, 0, 0);
        const xa = xOf(ax, timeOf(ax, first)), xb = xOf(ax, timeOf(ax, first + cols));
        if (fin(xa) && fin(xb) && xb > xa) {
            ctx.save();
            ctx.beginPath(); ctx.rect(gut, 0, W - gut, bh); ctx.clip();
            ctx.drawImage(s.mCan, 0, 0, cols, NS, xa, 0, xb - xa, bh);
            ctx.restore();
        }
    }
    drawGrid(s, ctx, ax, 0, bh, !s.measured);
    freqLabels(ctx, 2, 0, bh);
    ctx.fillStyle = TEXT;
    ctx.fillText(s.laneTables.some(Boolean) ? 'model' : 'model (warming up)', W - 110, 2);
    if (!s.measured) return;
    // Measured: COLS time slices from the frame ring.
    const y0 = bh + 6, COLS = 160;
    const img = ensureImg(s, 's', COLS, NS);
    const d = img.data;
    let mx = -Infinity;
    for (let k = 1; k <= s.mspCount; k++) {
        const i = (s.mspHead - k + MSPEC_CAP) % MSPEC_CAP;
        if (s.mspT[i] < ax.t0) break;
        for (let j = 0; j < NS; j++) if (s.mspV[i * NS + j] > mx) mx = s.mspV[i * NS + j];
    }
    const floor = mx - 50;
    // Walk frames oldest → newest alongside the slices.
    let k = s.mspCount;
    for (let c = 0; c < COLS; c++) {
        const tc = ax.t0 + (c + 1) * ax.win / COLS;
        while (k > 1) {
            const nxt = (s.mspHead - (k - 1) + MSPEC_CAP) % MSPEC_CAP;
            if (s.mspT[nxt] <= tc) k--; else break;
        }
        const i = (s.mspHead - k + MSPEC_CAP) % MSPEC_CAP;
        const valid = s.mspCount > 0 && fin(mx) && s.mspT[i] <= tc && s.mspT[i] >= tc - 0.25;
        for (let j = 0; j < NS; j++) {
            const p = ((NS - 1 - j) * COLS + c) * 4;
            let li = valid ? (s.mspV[i * NS + j] - floor) / 50 * 255 : 0;
            li = Math.max(0, Math.min(255, li | 0)) * 3;
            d[p] = MAGMA[li]; d[p + 1] = MAGMA[li + 1]; d[p + 2] = MAGMA[li + 2]; d[p + 3] = 255;
        }
    }
    s.sCan.getContext('2d').putImageData(img, 0, 0);
    ctx.drawImage(s.sCan, 0, 0, COLS, NS, gut, y0, W - gut, bh);
    drawGrid(s, ctx, ax, y0, y0 + bh, true);
    freqLabels(ctx, 2, y0, bh);
    ctx.fillStyle = TEXT;
    ctx.fillText('measured', W - 110, y0 + 2);
}

// --- bands -------------------------------------------------------------------

const modelDb = (s, bar, r) => { const v = s.modelBars[bar * ROWS + r]; return v > 0 ? 10 * Math.log10(v) : NaN; };
const measDb = (s, bar, r) => { const n = s.measCnt[bar]; const v = n ? s.measBars[bar * ROWS + r] / n : 0; return v > 0 ? 10 * Math.log10(v) : NaN; };

function rowRefs(s, fn, out) {
    for (let r = 0; r < ROWS; r++) {
        let mx = -Infinity;
        for (let b = 0; b <= s.maxBar; b++) { const v = fn(s, b, r); if (v > mx) mx = v; }
        out[r] = mx;
    }
}
const refM = new Float64Array(ROWS), refX = new Float64Array(ROWS);
const meanM = new Float64Array(ROWS), meanX = new Float64Array(ROWS), cntR = new Float64Array(ROWS);

/** Both sides covered the whole bar (not the one either started in, not the one still playing). */
const fullBar = (s, b) => b * 16 >= Math.max(s.modelFrom, s.measFrom) && (b + 1) * 16 <= s.measAt;

/** Model vs measured agreement per band over bars where both exist. */
export function scopeStats(el) {
    const s = state(el);
    const out = { bars: 0, bands: [], model: s.kernelStatus, cost: { ...s.cost }, fires: s.fires };
    meanM.fill(0); meanX.fill(0); cntR.fill(0);
    for (let b = 0; b <= s.maxBar; b++) {
        if (!fullBar(s, b)) continue;
        for (let r = 0; r < ROWS; r++) {
            const m = modelDb(s, b, r), x = measDb(s, b, r);
            if (fin(m) && fin(x)) { meanM[r] += m; meanX[r] += x; cntR[r]++; }
        }
    }
    const labels = [...BAND_LABELS, 'E'];
    for (let r = 0; r < ROWS; r++) {
        const n = cntR[r];
        if (n < 2) { out.bands.push({ band: labels[r], bars: n }); continue; }
        const mm = meanM[r] / n, mx = meanX[r] / n;
        let sxy = 0, sxx = 0, syy = 0, se = 0;
        for (let b = 0; b <= s.maxBar; b++) {
            if (!fullBar(s, b)) continue;
            const m = modelDb(s, b, r), x = measDb(s, b, r);
            if (!fin(m) || !fin(x)) continue;
            const dm = m - mm, dx = x - mx;
            sxy += dm * dx; sxx += dm * dm; syy += dx * dx; se += (dx - dm) * (dx - dm);
        }
        out.bands.push({ band: labels[r], bars: n, corr: sxx > 0 && syy > 0 ? +(sxy / Math.sqrt(sxx * syy)).toFixed(3) : null,
            rmsResidualDb: +Math.sqrt(se / n).toFixed(2), offsetDb: +(mx - mm).toFixed(1) });
        out.bars = Math.max(out.bars, n);
    }
    // Spectral tilt: each band's mean offset relative to the across-band mean.
    const off = out.bands.slice(0, NB).map(b => b.offsetDb).filter(fin);
    if (off.length === NB) {
        const avg = off.reduce((a, b) => a + b, 0) / NB;
        out.tiltDb = Object.fromEntries(BAND_LABELS.map((l, i) => [l, +(off[i] - avg).toFixed(1)]));
    }
    s.stats = out;
    return out;
}

function drawBands(el, s, ctx) {
    const W = s.cssW, gut = 44, rh = 14, title = 12, gap = 8;
    const nBars = s.maxBar + 1;
    ctx.fillStyle = TEXT;
    if (nBars <= 0) {
        ctx.fillText(s.laneTables.some(Boolean) ? 'bands fill in bar by bar as the track plays' : s.kernelStatus, 8, 8);
        return;
    }
    const avail = W - gut - 4;
    const cw = Math.max(3, Math.min(22, avail / nBars));
    const shown = Math.max(1, Math.min(nBars, Math.floor(avail / cw)));
    const b0 = nBars - shown;
    const labels = [...BAND_LABELS, 'E'];
    const block = (y, name, fn, ref) => {
        ctx.fillStyle = TEXT;
        ctx.fillText(name, gut, y);
        const yb = y + title;
        for (let r = 0; r < ROWS; r++) {
            const yy = yb + (ROWS - 1 - r) * rh;
            ctx.fillStyle = TEXT;
            ctx.fillText(labels[r], 2, yy + 2);
            for (let b = b0; b < nBars; b++) {
                const v = fn(s, b, r);
                const x = gut + (b - b0) * cw;
                if (!fin(v) || !fin(ref[r])) { ctx.fillStyle = '#0a1220'; ctx.fillRect(x, yy, cw - 1, rh - 1); continue; }
                const dgt = Math.max(0, Math.min(9, Math.round(9 - (ref[r] - v) / LEVEL_DB)));
                ctx.fillStyle = DIGIT_CSS[dgt];
                ctx.fillRect(x, yy, cw - 1, rh - 1);
                if (cw >= 11) { ctx.fillStyle = dgt < 6 ? '#fff' : '#000'; ctx.fillText(String(dgt), x + cw / 2 - 3, yy + 2); }
            }
        }
        return yb + ROWS * rh;
    };
    const sections = (y0, y1) => {
        ctx.fillStyle = SECTION;
        for (const sec of s.sections) {
            const bar = sec.step / 16;
            if (bar <= b0 || bar >= nBars) continue;
            ctx.fillRect(Math.round(gut + (bar - b0) * cw) - 1, y0, 2, y1 - y0);
        }
    };
    const axis = (y) => {
        ctx.fillStyle = TEXT;
        const every = cw >= 18 ? 1 : cw >= 8 ? 4 : 8;
        for (let b = b0; b < nBars; b++) if ((b + 1) % every === 0 || b === b0) ctx.fillText(String(b + 1), gut + (b - b0) * cw, y);
    };
    rowRefs(s, modelDb, refM);
    let y = 0;
    const yEnd = block(y, 'model  Σ v²·‖H_k‖²·|H_fx|²  (0-9, 4 dB/step below band max)', modelDb, refM);
    sections(y + title, yEnd);
    y = yEnd;
    if (!s.measured) { axis(y + 1); return; }
    rowRefs(s, measDb, refX);
    y += gap;
    const yEnd2 = block(y, 'measured  (AnalyserNode, mean power per bar)', measDb, refX);
    sections(y + title, yEnd2);
    y = yEnd2 + gap;
    // Residual: per-band gain-normalised dB difference.
    const st = scopeStats(el);
    ctx.fillStyle = TEXT;
    let lim = 6;
    const D = (b, r) => {
        if (!fullBar(s, b)) return NaN;
        const m = modelDb(s, b, r), x = measDb(s, b, r);
        if (!fin(m) || !fin(x) || cntR[r] < 1) return NaN;
        return (x - meanX[r] / cntR[r]) - (m - meanM[r] / cntR[r]);
    };
    for (let b = b0; b < nBars; b++) for (let r = 0; r < ROWS; r++) { const v = Math.abs(D(b, r)); if (fin(v) && v > lim) lim = v; }
    lim = Math.min(lim, 24);
    ctx.fillText(`residual  measured − model, dB (per-band mean removed) · ±${lim.toFixed(0)} dB`, gut, y);
    const yb = y + title;
    for (let r = 0; r < ROWS; r++) {
        const yy = yb + (ROWS - 1 - r) * rh;
        ctx.fillStyle = TEXT;
        ctx.fillText(labels[r], 2, yy + 2);
        for (let b = b0; b < nBars; b++) {
            const v = D(b, r);
            const x = gut + (b - b0) * cw;
            if (!fin(v)) { ctx.fillStyle = '#0a1220'; ctx.fillRect(x, yy, cw - 1, rh - 1); continue; }
            ctx.fillStyle = RES_CSS[Math.max(0, Math.min(32, Math.round((v / lim + 1) * 16)))];
            ctx.fillRect(x, yy, cw - 1, rh - 1);
        }
    }
    sections(yb, yb + ROWS * rh);
    axis(yb + ROWS * rh + 1);
    if (st.tiltDb) {
        ctx.fillStyle = TEXT;
        const txt = 'tilt ' + Object.entries(st.tiltDb).map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`).join('  ');
        ctx.fillText(txt, gut, yb + ROWS * rh + 13);
    }
}

// --- raster ------------------------------------------------------------------

async function computeRaster(el, s) {
    const { compileProject, tick } = await import('../../wave-engine/net.js');
    const t0 = performance.now();
    const g = compileProject(el._project);
    let total = el._totalSteps;
    if (!(total > 0)) total = (el._structure || []).reduce((n, x) => n + (x.steps || 0), 0);
    if (!(total > 0)) total = 16 * 16;
    total = Math.min(total, MAX_BARS * 16);
    const laneOfNet = new Int16Array(g.nets.length).fill(-1);
    g.nets.forEach((n, i) => { const l = s.laneOf.get(n.id); if (l !== undefined) laneOfNet[i] = l; });
    const cap = 262144;
    const r = { steps: total, n: 0, step: new Int32Array(cap), lane: new Uint8Array(cap), note: new Uint8Array(cap),
        vel: new Uint8Array(cap), dur: new Float32Array(cap), ms: 0 };
    const tickMs = tickSecOf(el) * 1000;
    let cur = 0;
    const onNote = (n, t) => {
        const l = laneOfNet[n.index];
        if (l < 0 || r.n >= cap) return;
        const i = r.n++;
        r.step[i] = cur; r.lane[i] = l; r.note[i] = n.note[t] & 127; r.vel[i] = Math.max(1, Math.min(127, n.vel[t] || 100));
        r.dur[i] = n.durSteps[t] > 0 ? n.durSteps[t] : Math.max(0.5, (n.durMs[t] || 100) / tickMs);
    };
    for (cur = 0; cur < total; cur++) {
        tick(g, onNote);
        if (g.stopRequested) break;
    }
    r.ms = Math.round(performance.now() - t0);
    return r;
}

function drawRaster(el, s, ctx) {
    const W = s.cssW, H = s.cssH, gut = 64, top = 14, axisH = 14;
    if (!s.raster) {
        ctx.fillStyle = TEXT;
        ctx.fillText('computing the arrangement…', 8, 8);
        if (!s.rasterPending && el._project) {
            s.rasterPending = true;
            const gen = s.projectGen;
            computeRaster(el, s).then(r => {
                if (gen === s.projectGen) { s.raster = r; s.cost.raster = r.ms; }
            }).catch(err => {
                console.warn('scope: raster failed', err);
                s.raster = { steps: 1, n: 0, ms: 0, failed: true };
            }).finally(() => { s.rasterPending = false; s.rKey = ''; drawOnce(el); });
        }
        return;
    }
    const r = s.raster, L = s.lanes.length;
    const pw = W - gut, total = Math.max(1, r.steps);
    const lh = L ? (H - top - axisH) / L : 0;
    const key = `${s.projectGen}|${W}|${H}|${s.dpr}`;
    if (s.rKey !== key) {
        // Static part, cached offscreen at device resolution.
        if (!s.rCan) s.rCan = document.createElement('canvas');
        s.rCan.width = Math.round(W * s.dpr); s.rCan.height = Math.round(H * s.dpr);
        const c = s.rCan.getContext('2d');
        c.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
        c.fillStyle = BG; c.fillRect(0, 0, W, H);
        c.font = FONT; c.textBaseline = 'top';
        const xs = (st) => gut + st / total * pw;
        const bars = total / 16, pxBar = pw / Math.max(1, bars);
        const lineEvery = pxBar >= 6 ? 1 : pxBar >= 1.5 ? 4 : 16;
        const labelEvery = [1, 2, 4, 8, 16, 32, 64].find(k => k * pxBar >= 26) || 128;
        for (let b = 0; b <= bars; b += lineEvery) {
            c.fillStyle = b % 4 === 0 ? BARLINE : GRID;
            c.fillRect(Math.round(xs(b * 16)), top, 1, H - top - axisH);
        }
        c.fillStyle = TEXT;
        for (let b = 0; b < bars; b += labelEvery) c.fillText(String(b + 1), xs(b * 16) + 2, H - axisH + 2);
        for (let l = 0; l < L; l++) {
            const y = top + l * lh;
            c.fillStyle = GRID; c.fillRect(gut, Math.round(y), pw, 1);
            const lane = s.lanes[l];
            c.fillStyle = lane.color;
            c.fillText(lane.key.slice(0, 9), 2, y + Math.max(0, lh / 2 - 5));
        }
        for (let i = 0; i < r.n; i++) {
            const lane = s.lanes[r.lane[i]];
            if (!lane) continue;
            const x = xs(r.step[i]);
            const yb = top + (r.lane[i] + 1) * lh;
            c.fillStyle = lane.color;
            if (lane.drum) {
                const h = r.vel[i] / 127 * lh * 0.8;
                c.fillRect(x, yb - h - 1, 1, h);
            } else {
                const span = Math.max(1, lane.hi - lane.lo);
                const y = yb - lh * (0.12 + 0.76 * (r.note[i] - lane.lo) / span);
                const w = Math.max(1, r.dur[i] / total * pw);
                if (fin(y)) c.fillRect(x, y - 1, w, 2);
            }
        }
        c.fillStyle = SECTION;
        for (const sec of s.sections) {
            if (sec.step >= total) continue;
            const x = xs(sec.step);
            c.fillRect(Math.round(x) - 1, top - 2, 2, H - top - axisH + 2);
            c.fillText(sec.name, x + 3, 1);
        }
        if (!L || r.failed) { c.fillStyle = TEXT; c.fillText(r.failed ? 'raster unavailable' : 'no music parts', gut + 6, top + 4); }
        s.rKey = key;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(s.rCan, 0, 0);
    ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
    // Playhead.
    if (el._playing || el._tick > 0) {
        let est = el._tick || 0;
        if (el._playing && el._tickTimestamp > 0) est += Math.min(6, (performance.now() - el._tickTimestamp) / (tickSecOf(el) * 1000));
        const x = gut + (est % total) / total * pw;
        if (fin(x)) { ctx.fillStyle = '#ffffff'; ctx.globalAlpha = 0.8; ctx.fillRect(x, top, 1, H - top - axisH); ctx.globalAlpha = 1; }
    }
}
