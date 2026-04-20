// Pure MIDI note ↔ name utilities used by the MIDI editor and the
// canvas transition badge. No element coupling.

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function noteToName(note) {
    const octave = Math.floor(note / 12) - 1;
    return NAMES[note % 12] + octave;
}

export function nameToNote(name) {
    if (typeof name !== 'string') return null;
    const m = name.trim().match(/^([A-Ga-g])([#b]?)(-?\d+)$/);
    if (!m) return null;
    const base = BASE[m[1].toUpperCase()];
    const accidental = m[2] === '#' ? 1 : (m[2] === 'b' ? -1 : 0);
    const octave = parseInt(m[3], 10);
    const note = base + accidental + (octave + 1) * 12;
    if (note < 0 || note > 127) return null;
    return note;
}
