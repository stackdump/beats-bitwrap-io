/**
 * synth.js — pure synthesis functions for the wave engine.
 *
 * The model (see README.md in this directory for the full derivation):
 *
 *   A single-token ring is Z_n. The token sits on place p_j; transition
 *   t_i carries weight w_i (velocity / 127, 0 for a rest). Firing t_i
 *   starts a pulse, so the ring's gate is the periodic superposition
 *
 *       g(t) = Σ_i w_i · P(t − i·Δ)        (periodic in T = n·Δ)
 *
 *   with Δ one tick. P is a sum of decaying exponentials,
 *   P(t) = Σ_e α_e · exp(−t/τ_e) for t ≥ 0, which is what makes both the
 *   closed form below and the allocation-free recursion in runner.js exact.
 *
 *   The audible output of a lane is y(t) = g(t) · carrier(t).
 *
 * Everything in this file is a pure function of its arguments. The runner
 * realises the same functions incrementally (one multiply per exponential per
 * sample); the tests hold the two to each other.
 */

export const PPQ = 4;   // ticks per beat — fixed in the sequencer worker

export function tickSeconds(bpm) {
    return 60 / (bpm * PPQ);
}

export function midiToHz(note) {
    return 440 * Math.pow(2, (note - 69) / 12);
}

// --- Pulse shapes -------------------------------------------------------

/**
 * pulse(attack, decay) → { alpha: [..], tau: [..] }, P(t) = Σ α_e e^{−t/τ_e}.
 * A two-exponential pulse 1·e^{−t/decay} − 1·e^{−t/attack} rises from 0 in
 * ~attack seconds and decays with time constant `decay`: no click at onset.
 */
export function pulse(attack, decay) {
    if (!(attack > 0) || attack >= decay) return { alpha: [1], tau: [decay] };
    return { alpha: [1, -1], tau: [decay, attack] };
}

export function pulseAt(p, t) {
    if (t < 0) return 0;
    let s = 0;
    for (let e = 0; e < p.alpha.length; e++) s += p.alpha[e] * Math.exp(-t / p.tau[e]);
    return s;
}

// --- Rings ---------------------------------------------------------------

/**
 * ringOf(bundle, pick?) → { n, places, weights } for a single-cycle net, or
 * null when the net is not one (branching, inhibitors, ≠1 token). `pick`
 * filters which MIDI bindings contribute weight (e.g. one drum lane).
 *
 * places[i] is the label of p_i in cycle order; weights[i] is the weight of
 * the transition that consumes from places[i].
 */
export function ringOf(bundle, pick) {
    const placeIds = Object.keys(bundle.places);
    const n = placeIds.length;
    if (!n || Object.keys(bundle.transitions).length !== n) return null;
    let tokens = 0;
    for (const id of placeIds) tokens += bundle.state[id] || 0;
    if (tokens !== 1) return null;

    const consumer = {}, producer = {};
    for (const a of bundle.arcs) {
        if (a.inhibit) return null;
        if (a.source in bundle.places) {
            if (consumer[a.source]) return null;
            consumer[a.source] = a.target;
        } else {
            if (producer[a.source]) return null;
            producer[a.source] = a.target;
        }
    }
    // Start on the marked place so index 0 is where the token begins.
    let start = placeIds.find(id => (bundle.state[id] || 0) > 0);
    const places = [], trans = [];
    let p = start;
    for (let i = 0; i < n; i++) {
        const t = consumer[p];
        if (!t || !producer[t]) return null;
        places.push(p); trans.push(t);
        p = producer[t];
    }
    if (p !== start || new Set(places).size !== n) return null;

    const weights = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const b = bundle.bindings[trans[i]];
        if (b && (!pick || pick(b))) weights[i] = b.velocity / 127;
    }
    return { n, places, transitions: trans, weights };
}

/** Index j of the place holding the token, given a marking {label: tokens}. */
export function tokenPlace(ring, marking) {
    for (let j = 0; j < ring.n; j++) {
        if ((marking[ring.places[j]] || 0) > 0) return j;
    }
    return -1;
}

/**
 * envelope(ring, marking, phase, p, tick) — the stationary gate value.
 *
 * With the token on p_j, the transition that fired at the start of the
 * current tick was t_(j−1); the hit m ticks before that was t_(j−1−m), now
 * (m + phase)·tick old. Summing every past period in closed form:
 *
 *   g = Σ_e α_e e^{−phase·Δ/τ_e} · Σ_{m<n} w_(j−1−m) a_e^m / (1 − a_e^n),
 *   a_e = e^{−Δ/τ_e}.
 *
 * `phase` ∈ [0,1) is the fraction of the current tick elapsed.
 */
export function envelope(ring, marking, phase, p, tick) {
    const j = typeof marking === 'number' ? marking : tokenPlace(ring, marking);
    if (j < 0) return 0;
    const n = ring.n;
    let g = 0;
    for (let e = 0; e < p.alpha.length; e++) {
        const a = Math.exp(-tick / p.tau[e]);
        let acc = 0, am = 1;
        for (let m = 0; m < n; m++) {
            acc += ring.weights[(((j - 1 - m) % n) + n) % n] * am;
            am *= a;
        }
        g += p.alpha[e] * Math.exp(-phase * tick / p.tau[e]) * acc / (1 - am);
    }
    return g;
}

/**
 * ringSpectrum(weights, p, samplesPerTick, sampleRate, K) — predicted
 * Fourier coefficients c_k (k = 0..K−1) of the sampled gate over one ring
 * period N = n·M samples, with time origin at the onset of t_0:
 *
 *   c_k = P̂(k) · (1/n) Σ_i w_i e^{−2πi k i / n}
 *   P̂(k) = (1/M) Σ_e α_e / (1 − m_e e^{−2πi k / N}),   m_e = e^{−1/(τ_e·sr)}
 *
 * P̂ is the exact transform of the sampled, periodised pulse, so a DFT of
 * the rendered gate must match to rounding. The second factor is the DFT
 * of the place weights: the characters of Z_n, made audible.
 * Returns { re: Float64Array, im: Float64Array }.
 */
export function ringSpectrum(weights, p, samplesPerTick, sampleRate, K) {
    const n = weights.length, M = samplesPerTick, N = n * M;
    const re = new Float64Array(K), im = new Float64Array(K);
    for (let k = 0; k < K; k++) {
        // (1/n) Σ w_i e^{−2πi k i/n}
        let wr = 0, wi = 0;
        for (let i = 0; i < n; i++) {
            const ang = -2 * Math.PI * k * i / n;
            wr += weights[i] * Math.cos(ang);
            wi += weights[i] * Math.sin(ang);
        }
        wr /= n; wi /= n;
        // P̂(k)
        let pr = 0, pi = 0;
        for (let e = 0; e < p.alpha.length; e++) {
            const m = Math.exp(-1 / (p.tau[e] * sampleRate));
            const ang = -2 * Math.PI * k / N;
            const dr = 1 - m * Math.cos(ang), di = -m * Math.sin(ang);
            const d2 = dr * dr + di * di;
            pr += p.alpha[e] * dr / d2;
            pi += p.alpha[e] * -di / d2;
        }
        pr /= M; pi /= M;
        re[k] = pr * wr - pi * wi;
        im[k] = pr * wi + pi * wr;
    }
    return { re, im };
}

// --- Voices ----------------------------------------------------------------

// Drum kit constants mirror tone-engine.js::_synthDrumKit's per-kit options
// so a kit swap changes the same knobs on both engines.
const KITS = {
    'drums':           { kickDecay: 0.30, kickOctaves: 6, snareDecay: 0.15, hihatDecay: 0.05 },
    'drums-breakbeat': { kickDecay: 0.20, kickOctaves: 4, snareDecay: 0.20, hihatDecay: 0.08 },
    'drums-cr78':      { kickDecay: 0.25, kickOctaves: 3, snareDecay: 0.12, hihatDecay: 0.04 },
    'drums-v8':        { kickDecay: 0.35, kickOctaves: 8, snareDecay: 0.18, hihatDecay: 0.06 },
    'drums-808':       { kickDecay: 0.60, kickOctaves: 8, snareDecay: 0.20, hihatDecay: 0.04 },
    'drums-lofi':      { kickDecay: 0.25, kickOctaves: 4, snareDecay: 0.15, hihatDecay: 0.05 },
};

export function isDrumChannel(ch) { return ch >= 10 && ch <= 15; }

/** Same note → drum-role dispatch as _synthDrumKit. */
export function drumKind(note) {
    if (note === 36 || note === 35) return 'kick';
    if (note === 38 || note === 40 || note === 37) return 'snare';
    if (note === 39) return 'clap';
    if (note >= 42 && note <= 46) return 'hat';
    if (note === 49 || note === 57) return 'openhat';
    return 'kick';
}

/**
 * drumVoice(kind, instrument) → voice spec. Carriers:
 *   kick  — sine swept from f1·octaves down to f1 (MembraneSynth's sweep)
 *   snare — band-passed noise + 180 Hz body
 *   clap  — band-passed noise
 *   hat   — high-passed noise
 */
export function drumVoice(kind, instrument) {
    const k = KITS[instrument] || KITS.drums;
    switch (kind) {
    case 'kick':
        return { kind, carrier: 'sweep', f1: 48, f0: 48 * k.kickOctaves, sweepTau: 0.03,
                 pulse: pulse(0.001, k.kickDecay / 2.5), level: 0.9 };
    case 'snare':
        return { kind, carrier: 'noise+tone', filter: 'bandpass', fc: 3000, q: 0.9, tone: 180, toneMix: 0.35,
                 pulse: pulse(0.001, k.snareDecay / 2.5), level: 0.6 };
    case 'clap':
        return { kind, carrier: 'noise', filter: 'bandpass', fc: 1400, q: 1.2,
                 pulse: pulse(0.002, 0.06), level: 0.6 };
    case 'openhat':
        return { kind, carrier: 'noise', filter: 'highpass', fc: 7000, q: 0.7,
                 pulse: pulse(0.001, k.hihatDecay * 2.5), level: 0.28 };
    default: // hat
        return { kind: 'hat', carrier: 'noise', filter: 'highpass', fc: 7000, q: 0.7,
                 pulse: pulse(0.001, k.hihatDecay / 2), level: 0.32 };
    }
}

/**
 * tonalVoice(instrument, group) → voice spec for melodic rings. The carrier
 * is a band-limited wavetable at the pitch bound to the firing transition,
 * i.e. pitch = f(marking). Families are matched by name so every one of the
 * ~60 tone-engine instrument ids lands somewhere sensible.
 */
export function tonalVoice(instrument, group) {
    const name = instrument || '';
    let wave = 'saw', attack = 0.003, decayScale = 0.5, level = 0.22, maxDecay = 1.5;
    if (/pad|strings|choir|organ/.test(name) || group === 'harmony' || group === 'pad') {
        wave = 'soft'; attack = 0.06; decayScale = 0.8; level = 0.12; maxDecay = 3;
    } else if (/sub|808/.test(name)) {
        wave = 'sine'; level = 0.42;
    } else if (/bass|reese|acid/.test(name) || group === 'bass') {
        wave = 'saw'; level = 0.26;
    } else if (/bell|vibes|marimba|kalimba|music-box|steel|glass/.test(name)) {
        wave = 'bell'; attack = 0.001; decayScale = 1.2; level = 0.2;
    } else if (/square|chiptune|pwm|clav/.test(name)) {
        wave = 'square'; level = 0.16;
    } else if (/pluck|stab|piano|guitar|harpsi/.test(name)) {
        wave = 'saw'; attack = 0.002; decayScale = 0.35; level = 0.2;
    }
    return { kind: 'tonal', carrier: 'table', wave, attack, decayScale, maxDecay, level };
}

/** Decay time constant for a tonal note of the given sounding length. */
export function noteDecay(voice, durMs) {
    const d = (durMs > 0 ? durMs : 100) / 1000 * voice.decayScale;
    return Math.min(voice.maxDecay, Math.max(0.03, d));
}

// --- Wavetables -------------------------------------------------------------

export const TABLE_SIZE = 2048;

const PARTIALS = {
    sine:   [1],
    saw:    [1, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 6, 1 / 7, 1 / 8],
    square: [1, 0, 1 / 3, 0, 1 / 5, 0, 1 / 7],
    soft:   [1, 0.5, 0.25, 0.12],
    bell:   [1, 0, 0.45, 0, 0, 0.25, 0, 0, 0.12],
};

/** Normalised additive wavetable (TABLE_SIZE + 1 guard sample). */
export function buildTable(wave) {
    const amps = PARTIALS[wave] || PARTIALS.sine;
    const t = new Float32Array(TABLE_SIZE + 1);
    let peak = 0;
    for (let i = 0; i < TABLE_SIZE; i++) {
        let s = 0;
        for (let k = 0; k < amps.length; k++) {
            if (amps[k]) s += amps[k] * Math.sin(2 * Math.PI * (k + 1) * i / TABLE_SIZE);
        }
        t[i] = s;
        if (Math.abs(s) > peak) peak = Math.abs(s);
    }
    for (let i = 0; i < TABLE_SIZE; i++) t[i] /= peak;
    t[TABLE_SIZE] = t[0];
    return t;
}

/**
 * carrier(voice, note, t, age) — analytic carrier for the tonal and swept
 * voices: `t` is absolute time (s), `age` time since the last onset (s).
 * Noise carriers are not closed-form in t (their filters have state); the
 * runner realises them with seeded noise.
 */
export function carrier(voice, note, t, age) {
    if (voice.carrier === 'sweep') {
        // ∫ f1 + (f0 − f1) e^{−a/τ} da
        const ph = voice.f1 * age + (voice.f0 - voice.f1) * voice.sweepTau * (1 - Math.exp(-age / voice.sweepTau));
        return Math.sin(2 * Math.PI * ph);
    }
    if (voice.carrier === 'dc') return 1;
    const amps = PARTIALS[voice.wave] || PARTIALS.sine;
    const f = midiToHz(note);
    let s = 0;
    for (let k = 0; k < amps.length; k++) if (amps[k]) s += amps[k] * Math.sin(2 * Math.PI * (k + 1) * f * t);
    return s;
}

/** mix(values, gains, out?) — Σ_i gains_i · values_i, through the master curve. */
export function mix(values, gains) {
    let s = 0;
    for (let i = 0; i < values.length; i++) s += gains[i] * values[i];
    return softClip(s);
}

export function softClip(x) {
    return Math.tanh(x);
}

// --- Seeded noise (xorshift32), deterministic per lane ----------------------

export function noiseSeed(i) {
    let s = (0x9E3779B9 ^ Math.imul(i + 1, 0x85EBCA6B)) | 0;
    return s === 0 ? 1 : s;
}

// --- RBJ biquad coefficients (computed once per lane, not per sample) -------

export function biquad(type, fc, q, sr) {
    const w = 2 * Math.PI * Math.min(fc, sr * 0.45) / sr;
    const cw = Math.cos(w), sw = Math.sin(w), alpha = sw / (2 * q);
    let b0, b1, b2;
    if (type === 'highpass') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; }
    else if (type === 'lowpass') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; }
    else { b0 = alpha; b1 = 0; b2 = -alpha; } // bandpass, 0 dB peak
    const a0 = 1 + alpha;
    return new Float64Array([b0 / a0, b1 / a0, b2 / a0, (-2 * cw) / a0, (1 - alpha) / a0]);
}
