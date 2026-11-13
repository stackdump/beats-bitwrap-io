// The Vocoder panel: djrust's vocoder with its three-oscillator synth as the carrier and the
// track as the modulator, so the track's rhythm and sound shape the chord ("talking drums").
// The chord pads are the seven triads of the genre's key; hold one to play it (or latch it).
// "Vocoder only" pulls the track out of the mix while it still shapes the synth (the modulator
// is taken before the track's fader).
//
// Live performance only: nothing here goes into a share.

import { audioEngine } from '../../audio/engine.js';
import { Genres } from '../generator/composer.js';
import { Major, Minor, Dorian, Mixolydian, Phrygian, HarmonicMin,
    MajorScale, MinorScale, PentatonicScale, MinPentatonicScale, BluesScale } from '../generator/core.js';

// djrust's synth factory sounds (fx/eurosynth.rs FACTORY_PRESETS), loaded by name.
const SOUNDS = ['classic', 'acid', 'pad', 'sync lead', 'ring bell', 'noise sweep'];
const TRACK_DEFAULT = 0.8;   // djrust's deck volume when nothing has moved it
const LEVEL_DEFAULT = 0.5;   // the vocoder's own level when first switched on (its default is louder than the track)

// The knobs up front: [name, label, min, max, default, log travel]
const KNOBS = [
    ['volume', 'Level', 0, 1, LEVEL_DEFAULT, false],
    ['mix', 'Mix', 0, 1, 1, false],
    ['shift', 'Formant', -12, 12, 0, false],
    ['release', 'Release', 5, 1000, 70, true],
    ['cutoff', 'Cutoff', 30, 18000, 18000, true],
];

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii'];

/**
 * The genre's key as seven chord pads: the triads stacked from its scale (a pentatonic or blues
 * scale stacks from its parent major or minor), voiced around C3 where a vocoder sits best.
 */
export function chordPads(genre) {
    const g = Genres[genre] || Genres.techno;
    const parent = new Map([
        [MajorScale, [Major, 'major']], [PentatonicScale, [Major, 'major']],
        [MinorScale, [Minor, 'minor']], [MinPentatonicScale, [Minor, 'minor']], [BluesScale, [Minor, 'minor']],
    ]);
    let [steps, mode] = parent.get(g.scale) || [null, null];
    if (!steps) {
        // the composer's own Dorian / Mixolydian / Phrygian / harmonic-minor helpers: read the
        // intervals off the notes they make
        const notes = g.scale(0).slice(0, 7);
        const sets = [[Dorian, 'dorian'], [Mixolydian, 'mixolydian'], [Phrygian, 'phrygian'], [HarmonicMin, 'harmonic minor'], [Major, 'major']];
        [steps, mode] = sets.find(([s]) => s.every((x, i) => x === notes[i])) || [Major, 'major'];
    }
    const root = 48 + (((g.rootNote % 12) + 12) % 12);   // the key's root in the C3 octave
    const pads = [];
    for (let d = 0; d < 7; d++) {
        const at = (k) => root + steps[(d + k) % 7] + 12 * Math.floor((d + k) / 7);
        const notes = [at(0), at(2), at(4)];
        const third = notes[1] - notes[0], fifth = notes[2] - notes[0];
        const quality = third === 4 ? (fifth === 8 ? '+' : '') : (fifth === 6 ? '°' : 'm');
        const name = NOTE_NAMES[notes[0] % 12] + quality;
        const degree = third === 4 ? ROMAN[d].toUpperCase() : ROMAN[d];
        pads.push({ name, degree: degree + (quality === '°' ? '°' : quality === '+' ? '+' : ''), notes });
    }
    return { key: `${NOTE_NAMES[root % 12]} ${mode}`, pads };
}

function toSlider([, , lo, hi, , log], v) {
    return log ? Math.round(100 * Math.log(v / lo) / Math.log(hi / lo)) : Math.round(100 * (v - lo) / (hi - lo));
}

function fromSlider([, , lo, hi, , log], s) {
    const t = s / 100;
    const v = log ? lo * Math.pow(hi / lo, t) : lo + t * (hi - lo);
    return Math.round(v * 1000) / 1000;
}

function knobText([name], v) {
    if (name === 'shift') return `${v > 0 ? '+' : ''}${Math.round(v)} st`;
    if (name === 'release') return `${Math.round(v)} ms`;
    if (name === 'cutoff') return v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`;
    return `${Math.round(v * 100)}%`;
}

/** Fill `panel` (the .pn-vocoder-panel). */
export function buildVocoderPanel(el, panel) {
    if (!panel) return;
    const st = (el._voc ||= { on: false, sound: 'classic', latch: false, only: false, pad: null, knobs: {} });
    const genre = () => el.querySelector?.('.pn-genre-select')?.value || el._currentGen?.genre || 'techno';
    const render = () => {
        const { key, pads } = chordPads(genre());
        panel.innerHTML = `
            <div class="pn-voc-group">
                <div class="pn-macro-group-label">Vocoder <span class="pn-pads-note">the synth, shaped by the track</span></div>
                <label class="pn-voc-switch"><input type="checkbox" class="pn-voc-on" ${st.on ? 'checked' : ''}> On</label>
                <label class="pn-voc-switch" title="Take the track out of the mix; it still shapes the synth"><input type="checkbox" class="pn-voc-only" ${st.only ? 'checked' : ''}> Vocoder only</label>
                <label class="pn-voc-switch"><input type="checkbox" class="pn-voc-latch" ${st.latch ? 'checked' : ''}> Latch chords</label>
                <select class="pn-voc-sound" title="The synth's sound">
                    ${SOUNDS.map((s) => `<option value="${s}"${s === st.sound ? ' selected' : ''}>${s}</option>`).join('')}
                </select>
                <div class="pn-voc-meter" title="Vocoder output"><div class="pn-voc-meter-fill"></div></div>
            </div>
            <div class="pn-voc-group pn-voc-chords">
                <div class="pn-macro-group-label">Chords · ${key} <span class="pn-pads-note">${st.latch ? 'tap: keeps sounding · tap again: stops' : 'hold a chord to play it'}</span></div>
                <div class="pn-pads-row">${pads.map((p, i) => `<button type="button" class="pn-pad pn-voc-pad${st.pad === i ? ' held' : ''}" data-pad="${i}"
                    title="${p.name} (${p.degree})">${p.name}<small>${p.degree}</small></button>`).join('')}</div>
            </div>
            <div class="pn-voc-group pn-voc-knobs">
                <div class="pn-macro-group-label">Sound</div>
                ${KNOBS.map((k) => {
                    const v = st.knobs[k[0]] ?? k[4];
                    return `<label class="pn-voc-knob">${k[1]}
                        <input type="range" min="0" max="100" value="${toSlider(k, v)}" data-voc="${k[0]}">
                        <span class="pn-voc-val">${knobText(k, v)}</span></label>`;
                }).join('')}
            </div>`;
        panel._pads = pads;
    };
    render();
    el._renderVocoder = render;

    const fill = () => panel.querySelector('.pn-voc-meter-fill');
    el._vocUnsub?.();
    el._vocUnsub = audioEngine.on('voc', (m) => {
        const f = fill();
        if (f) f.style.width = `${Math.min(100, Math.round((m.levels?.output || 0) * 100))}%`;
    });

    const switchOn = (on) => {
        st.on = on;
        if (on) {
            const knobs = Object.fromEntries(KNOBS.map((k) => [k[0], st.knobs[k[0]] ?? k[4]]));
            audioEngine.vocoderSound(st.sound);
            audioEngine.vocoder({ modulator: 'deck:A', carrier: 'synth', ...knobs, on: true });
        } else {
            st.pad = null;
            audioEngine.vocoder({ notes: [], on: false });
            if (st.only) audioEngine.trackLevel(TRACK_DEFAULT);
            panel.querySelectorAll('.pn-voc-pad.held').forEach((p) => p.classList.remove('held'));
            const f = fill(); if (f) f.style.width = '0%';
        }
        if (on && st.only) audioEngine.trackLevel(0);
        const box = panel.querySelector('.pn-voc-on'); if (box) box.checked = on;
    };
    const play = (i) => {
        if (!st.on) switchOn(true);
        st.pad = i;
        audioEngine.vocoder({ notes: panel._pads[i].notes });
        panel.querySelectorAll('.pn-voc-pad').forEach((p) => p.classList.toggle('held', +p.dataset.pad === i));
    };
    const stop = () => {
        st.pad = null;
        audioEngine.vocoder({ notes: [] });
        panel.querySelectorAll('.pn-voc-pad.held').forEach((p) => p.classList.remove('held'));
    };

    panel.addEventListener('change', (ev) => {
        const t = ev.target;
        if (t.classList.contains('pn-voc-on')) switchOn(t.checked);
        else if (t.classList.contains('pn-voc-only')) {
            st.only = t.checked;
            if (st.on) audioEngine.trackLevel(st.only ? 0 : TRACK_DEFAULT);
        } else if (t.classList.contains('pn-voc-latch')) {
            st.latch = t.checked;
            if (!st.latch && st.pad != null) stop();
            const note = panel.querySelector('.pn-voc-chords .pn-pads-note');
            if (note) note.textContent = st.latch ? 'tap: keeps sounding · tap again: stops' : 'hold a chord to play it';
        } else if (t.classList.contains('pn-voc-sound')) {
            st.sound = t.value;
            audioEngine.vocoderSound(st.sound);
        }
    });
    panel.addEventListener('input', (ev) => {
        const t = ev.target;
        const k = KNOBS.find((x) => x[0] === t.dataset?.voc);
        if (!k) return;
        const v = fromSlider(k, +t.value);
        st.knobs[k[0]] = v;
        t.parentElement.querySelector('.pn-voc-val').textContent = knobText(k, v);
        if (st.on) audioEngine.vocoder({ [k[0]]: v });
    });
    panel.addEventListener('pointerdown', (ev) => {
        const pad = ev.target.closest('.pn-voc-pad');
        if (!pad) return;
        ev.preventDefault();
        const i = +pad.dataset.pad;
        if (st.latch) {
            if (st.pad === i) stop(); else play(i);
            return;
        }
        try { pad.setPointerCapture(ev.pointerId); } catch { /* not an active pointer: the lift still lands on the pad */ }
        play(i);
        const up = () => {
            if (st.pad === i) stop();
            pad.removeEventListener('pointerup', up);
            pad.removeEventListener('pointercancel', up);
        };
        pad.addEventListener('pointerup', up);
        pad.addEventListener('pointercancel', up);
    });
    panel.addEventListener('keydown', (ev) => {
        const pad = ev.target.closest('.pn-voc-pad');
        if (!pad || (ev.key !== 'Enter' && ev.key !== ' ')) return;
        ev.preventDefault();
        const i = +pad.dataset.pad;
        if (st.pad === i) stop(); else play(i);
    });
}
