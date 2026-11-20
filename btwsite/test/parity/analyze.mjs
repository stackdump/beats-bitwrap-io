// analyze.mjs: compare two renders of one btw program bar by bar (no npm: plain JS DSP).
//
//   import { compare } from './analyze.mjs';
//   const r = compare(streamPcm, enginePcm, { sr: 48000, bpm: 140, bars: 16 });
//
// Inputs are interleaved stereo Int16Array (what btwd's s16le render and parity.html's capture both are). The
// engine's render is aligned on the stream's first downbeat (cross-correlation of the two onset envelopes over the
// first bars), then each bar is measured on both:
//   rms      dBFS of the bar (both channels)
//   lufs     BS.1770 K-weighted loudness of the bar, ungated (a momentary-ish loudness at bar length), in LUFS
//   peak     sample peak, dBFS;  tp: true peak, dBFS (4x oversampled, 48-tap windowed sinc)
//   mel      mean |log-mel difference| in dB over the bar (64 bands 30 Hz .. 16 kHz, 2048-point frames, hop 1024)
//   onsetMs  where the bar's onsets sit in the engine relative to the stream (local cross-correlation, +-40 ms)
//   onsetCorr the correlation of the two onset envelopes in the bar (1 = the same hits)
// and a bar is flagged when |dLUFS| > 3 LU, mel > 6 dB, |onsetMs| > 15 ms or onsetCorr < 0.6 (both not silent).

export const THRESHOLDS = { lufs: 3, mel: 6, onsetMs: 15, onsetCorr: 0.6 };
const SILENT_DB = -60;

export function toFloat(pcm) {
    const n = pcm.length >> 1;
    const L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) { L[i] = pcm[2 * i] / 32768; R[i] = pcm[2 * i + 1] / 32768; }
    return { L, R, n };
}

const db = (x) => (x > 1e-12 ? 10 * Math.log10(x) : -120);

// ---------------------------------------------------------------- FFT (radix 2, in place)
function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let k = 0; k < len / 2; k++) {
                const a = i + k, b = a + len / 2;
                const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
                const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
            }
        }
    }
}

const FFT_N = 2048, HOP = 1024, MELS = 64;
function melBank(sr) {
    const mel = (f) => 2595 * Math.log10(1 + f / 700), inv = (m) => 700 * (10 ** (m / 2595) - 1);
    const lo = mel(30), hi = mel(Math.min(16000, sr / 2 - 1));
    const pts = Array.from({ length: MELS + 2 }, (_, i) => inv(lo + ((hi - lo) * i) / (MELS + 1)));
    const bins = pts.map((f) => (f * FFT_N) / sr);
    return Array.from({ length: MELS }, (_, m) => {
        const w = new Float32Array(FFT_N / 2 + 1);
        for (let k = 0; k <= FFT_N / 2; k++) {
            if (k > bins[m] && k <= bins[m + 1]) w[k] = (k - bins[m]) / (bins[m + 1] - bins[m]);
            else if (k > bins[m + 1] && k < bins[m + 2]) w[k] = (bins[m + 2] - k) / (bins[m + 2] - bins[m + 1]);
        }
        return w;
    });
}

/** Log-mel frames (dB) and a spectral-flux onset envelope at HOP, for mono x. */
function spectro(x, sr, bank) {
    const frames = Math.max(0, Math.floor((x.length - FFT_N) / HOP) + 1);
    const win = Float32Array.from({ length: FFT_N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_N));
    const mel = new Array(frames);
    const flux = new Float32Array(frames);
    const re = new Float64Array(FFT_N), im = new Float64Array(FFT_N);
    let prev = null;
    for (let f = 0; f < frames; f++) {
        const o = f * HOP;
        for (let i = 0; i < FFT_N; i++) { re[i] = x[o + i] * win[i]; im[i] = 0; }
        fft(re, im);
        const mag = new Float32Array(FFT_N / 2 + 1);
        for (let k = 0; k <= FFT_N / 2; k++) mag[k] = re[k] * re[k] + im[k] * im[k];
        const m = new Float32Array(MELS);
        for (let b = 0; b < MELS; b++) {
            let s = 0; const w = bank[b];
            for (let k = 0; k <= FFT_N / 2; k++) if (w[k]) s += w[k] * mag[k];
            m[b] = Math.max(-100, db(s / (FFT_N * FFT_N / 4)));
        }
        mel[f] = m;
        if (prev) { let s = 0; for (let b = 0; b < MELS; b++) { const d = m[b] - prev[b]; if (d > 0) s += d; } flux[f] = s; }
        prev = m;
    }
    return { mel, flux };
}

/** A fine onset envelope (hop 128): positive differences of the log energy, for alignment. */
function onsetEnv(x, hop = 128) {
    const n = Math.floor(x.length / hop);
    const e = new Float32Array(n);
    let prev = -120;
    for (let i = 0; i < n; i++) {
        let s = 0;
        for (let j = 0; j < hop; j++) { const v = x[i * hop + j]; s += v * v; }
        const d = db(s / hop + 1e-10);
        e[i] = Math.max(0, d - prev);
        prev = d;
    }
    return e;
}

/** The lag (in env steps) of b behind a that best lines them up, searched in [-maxLag, maxLag] over a's [from, to). */
function xcorrLag(a, b, from, to, maxLag) {
    let best = 0, bestV = -Infinity;
    for (let lag = -maxLag; lag <= maxLag; lag++) {
        let s = 0;
        for (let i = from; i < to; i++) { const j = i + lag; if (j >= 0 && j < b.length) s += a[i] * b[j]; }
        if (s > bestV) { bestV = s; best = lag; }
    }
    return best;
}

function corr(a, b, from, to, lag) {
    let sa = 0, sb = 0, n = 0;
    for (let i = from; i < to; i++) { const j = i + lag; if (j < 0 || j >= b.length || i >= a.length) continue; sa += a[i]; sb += b[j]; n++; }
    if (!n) return 0;
    const ma = sa / n, mb = sb / n;
    let num = 0, da = 0, dbb = 0;
    for (let i = from; i < to; i++) { const j = i + lag; if (j < 0 || j >= b.length || i >= a.length) continue; const x = a[i] - ma, y = b[j] - mb; num += x * y; da += x * x; dbb += y * y; }
    return da > 0 && dbb > 0 ? num / Math.sqrt(da * dbb) : (da === 0 && dbb === 0 ? 1 : 0);
}

// ---------------------------------------------------------------- K-weighting (BS.1770, 48 kHz coefficients)
function biquad(x, b, a) {
    const y = new Float32Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
        const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
        x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
}
function kweight(x, sr) {
    if (sr !== 48000) throw new Error('analyze: the K-weighting here is the 48 kHz one (render at --sr 48000)');
    const s1 = biquad(x, [1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585]);
    return biquad(s1, [1, -2, 1], [1, -1.99004745483398, 0.99007225036621]);
}

// ---------------------------------------------------------------- true peak (4x)
const TP_TAPS = 48;
const TP_FIR = (() => {
    const phases = [];
    for (let p = 0; p < 4; p++) {
        const h = new Float32Array(TP_TAPS);
        for (let k = 0; k < TP_TAPS; k++) {
            const t = k - TP_TAPS / 2 + p / 4;
            const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
            const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * (k + p / 4)) / TP_TAPS) + 0.08 * Math.cos((4 * Math.PI * (k + p / 4)) / TP_TAPS);
            h[k] = sinc * w;
        }
        phases.push(h);
    }
    return phases;
})();
function truePeak(x, from, to) {
    let m = 0;
    for (let i = Math.max(from, TP_TAPS); i < Math.min(to, x.length - TP_TAPS); i++) {
        const a = Math.abs(x[i]);
        if (a > m) m = a;
        // only near a large sample is an inter-sample peak worth computing
        if (a < 0.5 * m) continue;
        for (let p = 1; p < 4; p++) {
            const h = TP_FIR[p];
            let s = 0;
            for (let k = 0; k < TP_TAPS; k++) s += h[k] * x[i - TP_TAPS / 2 + k];
            if (Math.abs(s) > m) m = Math.abs(s);
        }
    }
    return m;
}

// ---------------------------------------------------------------- the comparison

function measure(sig, sr, bank) {
    const mono = new Float32Array(sig.n);
    for (let i = 0; i < sig.n; i++) mono[i] = 0.5 * (sig.L[i] + sig.R[i]);
    return { sig, mono, kL: kweight(sig.L, sr), kR: kweight(sig.R, sr), spec: spectro(mono, sr, bank), env: onsetEnv(mono) };
}

/** First frame whose 10 ms window is above -50 dBFS (the first sound), or -1. */
function firstSound(mono, sr) {
    const w = Math.round(sr / 100);
    for (let i = 0; i + w <= mono.length; i += w) {
        let s = 0;
        for (let j = 0; j < w; j++) s += mono[i + j] * mono[i + j];
        if (db(s / w) > -50) return i;
    }
    return -1;
}

/**
 * compare(stream, engine, {sr, bpm, bars, sections}) -> {offsetMs, bars:[...], summary}
 * `sections`: [{name, start, bars}] from the check report, to name each bar.
 */
export function compare(streamPcm, enginePcm, { sr = 48000, bpm, bars, sections = [] }) {
    const bank = melBank(sr);
    const A = measure(toFloat(streamPcm), sr, bank);
    // align the engine: the first sound gives a coarse offset, the onset envelopes over the first 4 bars refine it
    const E0 = toFloat(enginePcm);
    const fa = firstSound(A.mono, sr);
    const monoE = new Float32Array(E0.n);
    for (let i = 0; i < E0.n; i++) monoE[i] = 0.5 * (E0.L[i] + E0.R[i]);
    const fe = firstSound(monoE, sr);
    let offset = fa >= 0 && fe >= 0 ? fe - fa : 0;
    const envA = A.env, envE = onsetEnv(monoE);
    const barFrames = (4 * 60 * sr) / bpm;
    const hop = 128;
    const refine = xcorrLag(envA, envE, Math.max(0, Math.floor(fa / hop)), Math.min(envA.length, Math.floor((Math.max(fa, 0) + 4 * barFrames) / hop)), Math.round((0.12 * sr) / hop));
    // take the refinement only when the coarse offset was not already right (a soft first note fools firstSound)
    const coarseLag = Math.round(offset / hop);
    const lagAt = (lag) => corr(envA, envE, Math.max(0, Math.floor(fa / hop)), Math.min(envA.length, Math.floor((Math.max(fa, 0) + 4 * barFrames) / hop)), lag);
    if (lagAt(refine) > lagAt(coarseLag) + 0.02) offset = refine * hop;
    if (offset < 0) offset = 0; // the engine never starts before the stream (it waits for a compile); a negative lag is noise
    const n = Math.max(0, Math.min(E0.n - offset, A.sig.n));
    const E = measure({ L: E0.L.subarray(offset, offset + n), R: E0.R.subarray(offset, offset + n), n }, sr, bank);

    const sectionAt = (bar) => { for (const s of sections) if (bar >= s.start && bar < s.start + s.bars) return `${s.name} ${bar - s.start + 1}/${s.bars}`; return null; };
    const rows = [];
    for (let b = 0; b < bars; b++) {
        const from = Math.round(b * barFrames), to = Math.round((b + 1) * barFrames);
        if (to > A.sig.n || to > E.sig.n) break;
        const row = { bar: b + 1, section: sectionAt(b) };
        for (const [k, M] of [['s', A], ['e', E]]) {
            let ss = 0, kk = 0, pk = 0;
            for (let i = from; i < to; i++) {
                const l = M.sig.L[i], r = M.sig.R[i];
                ss += l * l + r * r;
                kk += M.kL[i] * M.kL[i] + M.kR[i] * M.kR[i];
                const a = Math.max(Math.abs(l), Math.abs(r)); if (a > pk) pk = a;
            }
            const len = to - from;
            row[`rms_${k}`] = +db(ss / (2 * len)).toFixed(2);
            row[`lufs_${k}`] = +(-0.691 + db(kk / len)).toFixed(2);
            row[`peak_${k}`] = +(20 * Math.log10(pk || 1e-9)).toFixed(2);
            row[`tp_${k}`] = +(20 * Math.log10(Math.max(truePeak(M.sig.L, from, to), truePeak(M.sig.R, from, to)) || 1e-9)).toFixed(2);
        }
        // spectra: frames whose start is in the bar
        const f0 = Math.ceil(from / HOP), f1 = Math.min(Math.floor((to - FFT_N) / HOP), A.spec.mel.length - 1, E.spec.mel.length - 1);
        let d = 0, cnt = 0;
        for (let f = f0; f <= f1; f++) {
            const ma = A.spec.mel[f], me = E.spec.mel[f];
            for (let m = 0; m < MELS; m++) {
                // below -90 dB on both sides is silence on both: not a difference
                const x = Math.max(-90, ma[m]), y = Math.max(-90, me[m]);
                if (x === -90 && y === -90) continue;
                d += Math.abs(x - y); cnt++;
            }
        }
        row.mel = cnt ? +(d / cnt).toFixed(2) : 0;
        const ef = Math.floor(from / hop), et = Math.floor(to / hop);
        const lag = xcorrLag(A.env, E.env, ef, et, Math.round((0.04 * sr) / hop));
        row.onsetMs = +((lag * hop * 1000) / sr).toFixed(1);
        row.onsetCorr = +corr(A.env, E.env, ef, et, 0).toFixed(3);
        const silentS = row.rms_s < SILENT_DB, silentE = row.rms_e < SILENT_DB;
        row.dLufs = +(row.lufs_e - row.lufs_s).toFixed(2);
        const why = [];
        if (silentS !== silentE) why.push(silentS ? 'engine sounds, stream silent' : 'stream sounds, engine silent');
        else if (!silentS) {
            if (Math.abs(row.dLufs) > THRESHOLDS.lufs) why.push(`loudness ${row.dLufs > 0 ? '+' : ''}${row.dLufs} LU`);
            if (row.mel > THRESHOLDS.mel) why.push(`spectrum ${row.mel} dB`);
            if (Math.abs(row.onsetMs) > THRESHOLDS.onsetMs) why.push(`onsets ${row.onsetMs} ms`);
            if (row.onsetCorr < THRESHOLDS.onsetCorr) why.push(`hits differ (corr ${row.onsetCorr})`);
        }
        row.flags = why;
        // one number to rank bars by: each measure over its threshold, the largest
        row.score = silentS !== silentE ? 10 : silentS ? 0 : +Math.max(Math.abs(row.dLufs) / THRESHOLDS.lufs, row.mel / THRESHOLDS.mel, Math.abs(row.onsetMs) / THRESHOLDS.onsetMs, (1 - row.onsetCorr) / (1 - THRESHOLDS.onsetCorr)).toFixed(2);
        rows.push(row);
    }
    const flagged = rows.filter((r) => r.flags.length);
    const mean = (k) => (rows.length ? rows.reduce((s, r) => s + Math.abs(r[k]), 0) / rows.length : 0);
    return {
        offsetMs: +((offset * 1000) / sr).toFixed(2),
        bars: rows,
        summary: {
            bars: rows.length,
            flagged: flagged.length,
            meanAbsDLufs: +mean('dLufs').toFixed(2),
            meanMel: +mean('mel').toFixed(2),
            meanAbsOnsetMs: +mean('onsetMs').toFixed(2),
            maxScore: rows.reduce((m, r) => Math.max(m, r.score), 0),
            meanScore: +(rows.length ? rows.reduce((s, r) => s + r.score, 0) / rows.length : 0).toFixed(3),
            lufsStream: integrated(A, sr), lufsEngine: integrated(E, sr),
            tpStream: +Math.max(...rows.map((r) => r.tp_s)).toFixed(2), tpEngine: +Math.max(...rows.map((r) => r.tp_e)).toFixed(2),
        },
    };
}

/** Integrated loudness (BS.1770-4: 400 ms blocks, 75% overlap, absolute -70 and relative -10 gates). */
function integrated(M, sr) {
    const blk = Math.round(0.4 * sr), step = Math.round(0.1 * sr);
    const z = [];
    for (let i = 0; i + blk <= M.sig.n; i += step) {
        let s = 0;
        for (let j = i; j < i + blk; j++) s += M.kL[j] * M.kL[j] + M.kR[j] * M.kR[j];
        z.push(s / blk);
    }
    const l = (v) => -0.691 + db(v);
    const abs = z.filter((v) => l(v) > -70);
    if (!abs.length) return -120;
    const g = l(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
    const rel = abs.filter((v) => l(v) > g);
    return +l(rel.reduce((a, b) => a + b, 0) / rel.length).toFixed(2);
}
