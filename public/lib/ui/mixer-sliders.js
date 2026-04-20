// Mixer slider config + frequency-curve helpers.
// Extracted from petri-note.js (Phase A.1). Each MIXER_SLIDERS entry is
// [cssClass, stateKey, applyFactory(channel, drumRole) -> fn(value)] —
// the row renderer wires each slider to its per-channel apply fn.

import { toneEngine } from '../../audio/tone-engine.js';

// 0–100 slider → audio-engine value. Exponential curves so the knob top
// lands at a musically-useful extreme (~5 kHz HP, ~20 kHz LP, Q~50).
export function hpFreq(val) { return 20 * Math.pow(250, val / 100); }
export function lpFreq(val) { return 100 * Math.pow(200, val / 100); }
export function qCurve(val) { return 0.5 + (Math.pow(val / 100, 2) * 49.5); }

export const MIXER_SLIDERS = [
    ['pn-mixer-vol',    'vol',   (ch) => v => toneEngine.controlChange(ch, 7, Math.round(v * 127 / 100))],
    ['pn-mixer-pan',    'pan',   (ch) => v => toneEngine.controlChange(ch, 10, v)],
    ['pn-mixer-locut',  'locut', (ch, role) => v => {
        if (role && toneEngine.hasDrumVoiceFilters(ch)) toneEngine.setDrumVoiceLoCut(ch, role, hpFreq(v));
        else toneEngine.setChannelLoCut(ch, hpFreq(v));
    }],
    ['pn-mixer-loreso', 'lores', (ch, role) => v => {
        if (role && toneEngine.hasDrumVoiceFilters(ch)) toneEngine.setDrumVoiceLoResonance(ch, role, qCurve(v));
        else toneEngine.setChannelLoResonance(ch, qCurve(v));
    }],
    ['pn-mixer-cutoff', 'cut',   (ch, role) => v => {
        if (role && toneEngine.hasDrumVoiceFilters(ch)) toneEngine.setDrumVoiceCutoff(ch, role, lpFreq(v));
        else toneEngine.setChannelCutoff(ch, lpFreq(v));
    }],
    ['pn-mixer-reso',   'res',   (ch, role) => v => {
        if (role && toneEngine.hasDrumVoiceFilters(ch)) toneEngine.setDrumVoiceResonance(ch, role, qCurve(v));
        else toneEngine.setChannelResonance(ch, qCurve(v));
    }],
    ['pn-mixer-decay',  'dec',   (ch) => v => toneEngine.setChannelDecay(ch, v / 100)],
];
