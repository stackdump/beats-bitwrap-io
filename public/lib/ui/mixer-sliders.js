// Mixer slider config + frequency-curve helpers.
// Extracted from petri-note.js (Phase A.1). Each MIXER_SLIDERS entry is
// [cssClass, stateKey, applyFactory(channel, drumRole) -> fn(value)] —
// the row renderer wires each slider to its per-channel apply fn.

import { audioEngine, volumeTweak, decayTweak, cutoffTweak } from '../../audio/engine.js';

// 0–100 slider → audio-engine value. Exponential curves so the knob top
// lands at a musically-useful extreme (~5 kHz HP, ~20 kHz LP, Q~50).
export function hpFreq(val) { return 20 * Math.pow(250, val / 100); }
export function lpFreq(val) { return 100 * Math.pow(200, val / 100); }
export function qCurve(val) { return 0.5 + (Math.pow(val / 100, 2) * 49.5); }

// Format a slider's raw 0–max value into a display string the user
// recognizes (Hz for filters, ms for decay, L/C/R for pan, plain %
// for volume, Q-like number for resonance). Used by the on-hover
// readout.
export function formatSliderReadout(cls, v) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return '';
    if (cls.includes('pn-mixer-pan')) {
        if (n === 64) return 'C';
        if (n < 64) return `L${64 - n}`;
        return `R${n - 64}`;
    }
    if (cls.includes('pn-mixer-vol'))   return `${n}`;
    if (cls.includes('pn-mixer-locut')) return fmtHz(hpFreq(n));
    if (cls.includes('pn-mixer-cutoff'))return fmtHz(lpFreq(n));
    if (cls.includes('pn-mixer-loreso') || cls.includes('pn-mixer-reso')) return `Q${qCurve(n).toFixed(1)}`;
    if (cls.includes('pn-mixer-decay')) return `${n}ms`;
    return String(n);
}

function fmtHz(hz) {
    if (hz >= 1000) return `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)}k`;
    return `${Math.round(hz)}`;
}

// Each slider's apply fn. Volume, high cut and decay shape the channel's djrust voice; pan,
// lo-cut and the two resonances have no live djrust equivalent (lib/backend/djrust.js hides
// them), so they only keep their value for the share and the presets.
const none = () => () => {};
export const MIXER_SLIDERS = [
    ['pn-mixer-vol',    'vol',   (ch) => v => audioEngine.voice(ch, volumeTweak(v))],
    ['pn-mixer-pan',    'pan',   none],
    ['pn-mixer-locut',  'locut', none],
    ['pn-mixer-loreso', 'lores', none],
    ['pn-mixer-cutoff', 'cut',   (ch) => v => audioEngine.voice(ch, cutoffTweak(lpFreq(v)))],
    ['pn-mixer-reso',   'res',   none],
    ['pn-mixer-decay',  'dec',   (ch) => v => audioEngine.voice(ch, decayTweak(v, ch))],
];
