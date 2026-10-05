// Scope model — the forward model behind the Scope tab's band heatmap and
// spectrogram. Nothing here listens to the output.
//
// Pre-tanh the master is a filtered marked point process
//
//     x(t) = Σ_k (h_k * μ_k)(t)        μ_k = fired events of part k
//
// and for events that don't overlap coherently the energy in a band b is
// the incoherent sum
//
//     E_b ≈ Σ_events v² · ‖H_k‖²_b · |H_fx|²_b
//
// so three tables are enough:
//   kernel table  ‖H_k‖²_b per instrument (and per note for tonal parts) —
//                 one hit of the real patch rendered offline, FFT'd once,
//                 cached in memory + localStorage by instrument + patch hash
//   FX response   |H_fx|²_b from the live filter state (master HP/LP, the
//                 per-channel strip HP/LP, channel volume) — analytic biquad
//                 magnitude, so macro-driven sweeps show up as they happen
//   events        the fires the worker / worklet already posts
//
// Band edges match beats-py analysis.py (and scripts/analyze-audio.py).

import { toneEngine, INSTRUMENT_CONFIGS, INSTRUMENT_GAIN, isDrumChannel } from '../../audio/tone-engine.js';

export const BANDS = [[20, 80], [80, 250], [250, 2000], [2000, 6000], [6000, 16000]];
export const BAND_LABELS = ['sub', 'low', 'lomid', 'himid', 'high'];
export const NB = BANDS.length;
// Coarse log-frequency grid for the spectrogram: NS bins, 30 Hz – 16 kHz.
export const NS = 28;
export const SPEC_EDGES = new Float64Array(NS + 1);
for (let i = 0; i <= NS; i++) SPEC_EDGES[i] = 30 * Math.pow(16000 / 30, i / NS);
// Bands first, then spectrogram bins: one row of NR values per kernel.
export const NR = NB + NS;
const EDGES = [];
for (const [lo, hi] of BANDS) EDGES.push([lo, hi]);
for (let i = 0; i < NS; i++) EDGES.push([SPEC_EDGES[i], SPEC_EDGES[i + 1]]);

const SR = 44100;
const FFT_N = 32768;           // 0.743 s per hit at 44.1 kHz
const SEG_S = 0.8;             // hit spacing in the offline render
const HIT_AT = 0.02;
const CACHE_KEY = 'pn-scope-kernels-v2';
const CACHE_MAX = 400;

// --- kernel cache -----------------------------------------------------------

const mem = new Map();          // key → { r: Float32Array(NR) energies, tau }
let lsLoaded = false;

function strHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = Math.imul(31, h) + str.charCodeAt(i) | 0;
    return (h >>> 0).toString(36);
}

const patchHashes = new Map();
function patchHash(inst) {
    let h = patchHashes.get(inst);
    if (!h) {
        let src = '';
        // 'custom' patches are a `create(dest)` function: hash its source too,
        // and the normalisation gain, so editing either invalidates the cache.
        try {
            src = JSON.stringify(INSTRUMENT_CONFIGS[inst] || inst, (k, v) => typeof v === 'function' ? String(v) : v)
                + '|' + (INSTRUMENT_GAIN[inst] || 0);
        } catch { src = String(inst); }
        h = strHash(src);
        patchHashes.set(inst, h);
    }
    return h;
}

export function kernelKey(inst, note, durMs) {
    return `${inst}|${note}|${durMs}|${patchHash(inst)}`;
}

function loadLocal() {
    if (lsLoaded) return;
    lsLoaded = true;
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return;
        const obj = JSON.parse(raw);
        for (const [k, v] of Object.entries(obj || {})) {
            if (Array.isArray(v?.r) && v.r.length === NR && Number.isFinite(v.tau)) {
                mem.set(k, { r: Float32Array.from(v.r), tau: v.tau });
            }
        }
    } catch {}
}

function saveLocal() {
    try {
        const obj = {};
        const keys = [...mem.keys()].slice(-CACHE_MAX);
        for (const k of keys) {
            const v = mem.get(k);
            obj[k] = { r: Array.from(v.r, x => +x.toPrecision(5)), tau: +v.tau.toFixed(4) };
        }
        localStorage.setItem(CACHE_KEY, JSON.stringify(obj));
    } catch {}
}

export function getKernel(key) {
    loadLocal();
    return mem.get(key) || null;
}

// --- FFT (radix-2, in place) -------------------------------------------------

let fftRe = null, fftIm = null, fftCos = null, fftSin = null, fftRev = null;
function fftInit() {
    if (fftRe) return;
    fftRe = new Float64Array(FFT_N); fftIm = new Float64Array(FFT_N);
    fftCos = new Float64Array(FFT_N / 2); fftSin = new Float64Array(FFT_N / 2);
    for (let i = 0; i < FFT_N / 2; i++) {
        fftCos[i] = Math.cos(2 * Math.PI * i / FFT_N);
        fftSin[i] = -Math.sin(2 * Math.PI * i / FFT_N);
    }
    fftRev = new Uint32Array(FFT_N);
    const bits = Math.log2(FFT_N);
    for (let i = 0; i < FFT_N; i++) {
        let r = 0;
        for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
        fftRev[i] = r;
    }
}

function fft() {
    const re = fftRe, im = fftIm, n = FFT_N;
    for (let i = 0; i < n; i++) {
        const j = fftRev[i];
        if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let start = 0; start < n; start += size) {
            for (let k = 0; k < half; k++) {
                const c = fftCos[k * step], s = fftSin[k * step];
                const a = start + k, b = a + half;
                const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
                re[b] = re[a] - tr; im[b] = im[a] - ti;
                re[a] += tr; im[a] += ti;
            }
        }
    }
}

/** Energies per NR row and energy-centroid decay time of one rendered hit. */
function analyseHit(data, start, sr) {
    fftInit();
    let e = 0, et = 0;
    for (let i = 0; i < FFT_N; i++) {
        const x = start + i < data.length ? data[start + i] : 0;
        fftRe[i] = x; fftIm[i] = 0;
        const x2 = x * x;
        e += x2; et += x2 * i;
    }
    const tau = e > 0 ? Math.max(0.02, et / e / sr) : 0.1;
    fft();
    const r = new Float32Array(NR);
    const df = sr / FFT_N;
    for (let j = 0; j < NR; j++) {
        const k0 = Math.max(1, Math.floor(EDGES[j][0] / df));
        const k1 = Math.min(FFT_N / 2, Math.max(k0 + 1, Math.floor(EDGES[j][1] / df)));
        let p = 0;
        for (let k = k0; k < k1; k++) p += fftRe[k] * fftRe[k] + fftIm[k] * fftIm[k];
        r[j] = 2 * p / FFT_N;
    }
    return { r, tau };
}

/**
 * Render every missing kernel in one Tone.Offline pass: a fresh ToneEngine
 * (the same patches, INSTRUMENT_GAIN normalisation and channel strip as
 * live) with the reverb/delay sends at 0, one hit per SEG_S.
 *
 * Tone.Offline swaps Tone's global context for the duration of its
 * callback. That is safe for the live engine only because the callback
 * never yields to the event loop (every instrument here is a synth or a
 * 'custom' graph — no sample fetches), so no worker message can run while
 * the offline context is current. Sampler/players patches are skipped.
 *
 * specs: [{ key, inst, channel, note, durMs }]
 */
export async function renderKernels(specs) {
    loadLocal();
    const todo = [];
    const seen = new Set();
    for (const s of specs) {
        if (mem.has(s.key) || seen.has(s.key)) continue;
        const type = INSTRUMENT_CONFIGS[s.inst]?.type;
        if (type === 'sampler' || type === 'players') continue;
        seen.add(s.key);
        todo.push(s);
    }
    if (!todo.length || typeof Tone === 'undefined' || !Tone.Offline) return 0;
    const { ToneEngine } = await import('../../audio/tone-engine.js');
    const buffer = await Tone.Offline(async () => {
        const engine = new ToneEngine();
        engine._offline = true;
        await engine.init();
        engine.setReverbWet?.(0);
        engine.setDelayWet?.(0);
        const chans = new Map();
        for (const s of todo) if (!chans.has(s.channel)) chans.set(s.channel, s.inst);
        // Two parts on one channel share its instrument live too.
        await Promise.all([...chans].map(([ch, inst]) => engine.loadInstrument(ch, inst)));
        todo.forEach((s, i) => {
            engine.playNote({ channel: s.channel, note: s.note, velocity: 100, duration: s.durMs }, i * SEG_S + HIT_AT);
        });
    }, todo.length * SEG_S + 0.1, 1, SR);
    const data = buffer.getChannelData(0);
    todo.forEach((s, i) => {
        const k = analyseHit(data, Math.round(i * SEG_S * SR), SR);
        mem.set(s.key, k);
    });
    saveLocal();
    return todo.length;
}

// --- FX response ------------------------------------------------------------

// A few log-spaced probe frequencies per row; |H|² is averaged over them.
const PROBES = 4;
const PROBE_F = new Float64Array(NR * PROBES);
for (let j = 0; j < NR; j++) {
    const [lo, hi] = EDGES[j];
    for (let p = 0; p < PROBES; p++) PROBE_F[j * PROBES + p] = lo * Math.pow(hi / lo, (p + 0.5) / PROBES);
}

// |H(f)|² of one WebAudio lowpass/highpass biquad. Q is in dB for these
// types (Web Audio spec), so α = sin(w0) / (2·10^(Q/20)).
function biquadMag2(type, fc, qDb, f, sr) {
    if (!(fc > 0) || !(fc < sr / 2)) return 1;
    const w0 = 2 * Math.PI * fc / sr;
    const cw = Math.cos(w0), alpha = Math.sin(w0) / (2 * Math.pow(10, (Number.isFinite(qDb) ? qDb : 0) / 20));
    let b0, b1;
    if (type === 'lowpass') { b0 = (1 - cw) / 2; b1 = 1 - cw; }
    else { b0 = (1 + cw) / 2; b1 = -(1 + cw); }
    const b2 = b0, a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
    const w = 2 * Math.PI * f / sr;
    const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
    const dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
    const d = dr * dr + di * di;
    return d > 0 ? (nr * nr + ni * ni) / d : 1;
}

function readParam(p, fallback) {
    try {
        const v = p?.value;
        return Number.isFinite(v) ? v : fallback;
    } catch { return fallback; }
}

function filterState(f, type, fallbackFc) {
    if (!f) return null;
    const fc = readParam(f.frequency, fallbackFc);
    const q = readParam(f.Q, 1);
    const roll = Number(f.rolloff);
    const stages = Number.isFinite(roll) && roll < 0 ? Math.max(1, Math.round(-roll / 12)) : 1;
    return { type, fc, q, stages };
}

function applyFilter(out, off, st, sr) {
    if (!st) return;
    // Skip filters parked at the edges (the default "open" state).
    if (st.type === 'lowpass' && st.fc >= 19000) return;
    if (st.type === 'highpass' && st.fc <= 25) return;
    for (let j = 0; j < NR; j++) {
        let m = 0;
        for (let p = 0; p < PROBES; p++) m += biquadMag2(st.type, st.fc, st.q, PROBE_F[j * PROBES + p], sr);
        out[off + j] *= Math.pow(m / PROBES, st.stages);
    }
}

/**
 * Fill out[ch*NR + j] with |H_fx|² (× channel gain²) for every channel in
 * `channels`. Reads the live engine; no allocation besides the small
 * filter-state objects.
 */
export function fxResponse(out, channels, sr = SR) {
    const master = [
        filterState(toneEngine._hpFilter, 'highpass', 20),
        filterState(toneEngine._lpFilter, 'lowpass', 20000),
    ];
    for (const ch of channels) {
        const off = (ch & 31) * NR;
        for (let j = 0; j < NR; j++) out[off + j] = 1;
        const strip = toneEngine._channelStrips?.get(ch);
        if (strip) {
            const db = readParam(strip.volume?.volume, 0);
            const g2 = Math.pow(10, db / 10);
            for (let j = 0; j < NR; j++) out[off + j] = g2;
            applyFilter(out, off, filterState(strip.hpFilter, 'highpass', 20), sr);
            applyFilter(out, off, filterState(strip.filter, 'lowpass', 20000), sr);
        }
        applyFilter(out, off, master[0], sr);
        applyFilter(out, off, master[1], sr);
    }
}

// --- per-lane kernel sets ----------------------------------------------------

/**
 * Kernel specs for a lane: drums → one per distinct kit note; tonal → up to
 * three representative notes (low / median / high) interpolated in log
 * energy by pitch.
 */
export function laneKernelSpecs(lane, inst) {
    const notes = [...lane.notes].sort((a, b) => a - b);
    if (!notes.length) notes.push(lane.drum ? 36 : 60);
    let reps;
    if (lane.drum) reps = notes.slice(0, 8);
    else reps = [...new Set([notes[0], notes[notes.length >> 1], notes[notes.length - 1]])];
    const durs = [...lane.durs].sort((a, b) => a - b);
    let dur = durs.length ? durs[durs.length >> 1] : 200;
    dur = Math.max(40, Math.min(700, Math.round(dur / 10) * 10));
    return reps.map(note => ({ key: kernelKey(inst, note, dur), inst, channel: lane.channel, note, durMs: dur }));
}

/** Assemble a lane's interpolation table from cached kernels (null if any is missing). */
export function laneKernelTable(specs, drum) {
    const n = specs.length;
    const notes = new Int16Array(n);
    const logR = new Float32Array(n * NR);
    let tau = 0;
    for (let i = 0; i < n; i++) {
        const k = mem.get(specs[i].key);
        if (!k) return null;
        notes[i] = specs[i].note;
        for (let j = 0; j < NR; j++) logR[i * NR + j] = Math.log(Math.max(1e-20, k.r[j]));
        tau += k.tau;
    }
    return { notes, logR, n, drum, durMs: specs[0]?.durMs || 200, tau: Math.max(0.03, tau / Math.max(1, n)) };
}

/** Write the kernel energies for `note` into out[0..NR). No allocation. */
export function kernelFor(table, note, out) {
    const { notes, logR, n } = table;
    if (n === 1 || note <= notes[0]) { for (let j = 0; j < NR; j++) out[j] = Math.exp(logR[j]); return; }
    if (note >= notes[n - 1]) { const o = (n - 1) * NR; for (let j = 0; j < NR; j++) out[j] = Math.exp(logR[o + j]); return; }
    if (table.drum) {
        // Kit notes are different voices — nearest, never a blend.
        let best = 0, bd = Infinity;
        for (let i = 0; i < n; i++) { const d = Math.abs(notes[i] - note); if (d < bd) { bd = d; best = i; } }
        const o = best * NR;
        for (let j = 0; j < NR; j++) out[j] = Math.exp(logR[o + j]);
        return;
    }
    let i = 0;
    while (i < n - 2 && note > notes[i + 1]) i++;
    const w = (note - notes[i]) / Math.max(1, notes[i + 1] - notes[i]);
    const a = i * NR, b = (i + 1) * NR;
    for (let j = 0; j < NR; j++) out[j] = Math.exp(logR[a + j] + (logR[b + j] - logR[a + j]) * w);
}

export { isDrumChannel };
