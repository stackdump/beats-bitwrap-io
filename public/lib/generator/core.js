/**
 * core.js — Port of generator.go.
 * Seeded PRNG, scale definitions, accent logic, chord progressions, defaults.
 */

// --- Seeded PRNG (mulberry32) ---

export function createRng(seed) {
    let s = seed | 0;
    const rng = {
        next() {
            s |= 0; s = s + 0x6D2B79F5 | 0;
            let t = Math.imul(s ^ s >>> 15, 1 | s);
            t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        },
        nextInt(max) { return Math.floor(rng.next() * max); },
        nextInt63() { return Math.floor(rng.next() * 2147483647); },
        // Go-style aliases used by ported modules
        float64() { return rng.next(); },
        int63() { return rng.nextInt63(); },
        intn(max) { return rng.nextInt(max); },
    };
    return rng;
}

// --- Scale definitions (semitone offsets from root) ---

export const Major         = [0, 2, 4, 5, 7, 9, 11];
export const Minor         = [0, 2, 3, 5, 7, 8, 10];
export const Dorian        = [0, 2, 3, 5, 7, 9, 10];
export const Mixolydian    = [0, 2, 4, 5, 7, 9, 10];
export const Phrygian      = [0, 1, 3, 5, 7, 8, 10];
export const HarmonicMin   = [0, 2, 3, 5, 7, 8, 11];
export const Pentatonic    = [0, 2, 4, 7, 9];
export const MinPentatonic = [0, 3, 5, 7, 10];
export const Blues         = [0, 3, 5, 6, 7, 10];
export const Chromatic     = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

// --- Scale note generators ---

/** Generate MIDI note numbers spanning multiple octaves. */
export function scaleNotes(root, intervals, octaves = 2) {
    const notes = [];
    for (let oct = 0; oct < octaves; oct++) {
        for (const interval of intervals) {
            const note = root + oct * 12 + interval;
            if (note <= 127) {
                notes.push(note);
            }
        }
    }
    return notes;
}

export function MajorScale(root)        { return scaleNotes(root, Major, 2); }
export function MinorScale(root)        { return scaleNotes(root, Minor, 2); }
export function PentatonicScale(root)   { return scaleNotes(root, Pentatonic, 2); }
export function MinPentatonicScale(root){ return scaleNotes(root, MinPentatonic, 2); }
export function BluesScale(root)        { return scaleNotes(root, Blues, 2); }
export function MixolydianScale(root)   { return scaleNotes(root, Mixolydian, 2); }
export function PhrygianScale(root)     { return scaleNotes(root, Phrygian, 2); }
export function HarmonicMinScale(root)  { return scaleNotes(root, HarmonicMin, 2); }

// --- Accent types ---

export const AccentNone  = 0;
export const AccentKick  = 1;
export const AccentSnare = 2;
export const AccentHihat = 3;

/**
 * accentVelocity returns the velocity for a given step position and accent type.
 * Uses wider offsets and deterministic jitter via step hash for natural feel.
 */
export function accentVelocity(step, totalSteps, baseVelocity, accent) {
    // Deterministic jitter: hash step position for +/-5 variation
    const jitter = ((step * 7 + 13) % 11) - 5;

    switch (accent) {
    case AccentKick: {
        // Downbeat emphasis: beats 1 and 3 strong
        const beat = step % 4;
        switch (beat) {
        case 0: // downbeat
            return baseVelocity + 20 + jitter;
        case 2: // beat 3
            return baseVelocity + 8 + jitter;
        default:
            return baseVelocity - 15 + jitter;
        }
    }
    case AccentSnare:
        // Snare hits are already placed by Euclidean -- just add slight jitter
        return baseVelocity + jitter;
    case AccentHihat:
        // Alternating strong/weak for groove -- ghost notes on off-beats
        if (step % 2 === 0) {
            return baseVelocity + 10 + jitter;
        }
        return baseVelocity - 30 + jitter; // ghost notes
    }
    return baseVelocity + jitter;
}

/** Clamp velocity to MIDI range 1-127. */
export function clampVelocity(v) {
    if (v < 1) return 1;
    if (v > 127) return 127;
    return v;
}

// --- Chord progression types and defaults ---

/**
 * ChordDegree: { root: int, tones: [int] }
 * ChordProg:   { chords: [ChordDegree], stepsPer: int }
 */

// Minor key: i-VI-III-VII (Am-F-C-G in A minor)
export const MinorChordProg = {
    chords: [
        { root: 0, tones: [0, 2, 4] }, // i   (root, 3rd, 5th)
        { root: 5, tones: [5, 0, 2] }, // VI  (6th, root, 2nd)
        { root: 2, tones: [2, 4, 6] }, // III (3rd, 5th, 7th)
        { root: 4, tones: [4, 6, 1] }, // VII (5th, 7th, 2nd)
    ],
    stepsPer: 4,
};

// Major key: I-V-vi-IV
export const MajorChordProg = {
    chords: [
        { root: 0, tones: [0, 2, 4] }, // I
        { root: 4, tones: [4, 6, 1] }, // V
        { root: 5, tones: [5, 0, 2] }, // vi
        { root: 3, tones: [3, 5, 0] }, // IV
    ],
    stepsPer: 4,
};

// --- Default generation parameters ---

export function DefaultParams() {
    return {
        scale:             MajorScale(60), // C major
        rootNote:          60,
        channel:           1,
        velocity:          100,
        duration:          100,
        density:           0.5,
        steps:             16,
        bpm:               120,
        seed:              0,
        accent:            AccentNone,
        chords:            null,
        durationVariation: 0,
        syncopation:       0,
    };
}

// --- drumSeed: FNV-1a hash of genre string ---

export function drumSeed(genre) {
    let h = 0xcbf29ce484222325n;
    for (let i = 0; i < genre.length; i++) {
        h ^= BigInt(genre.charCodeAt(i));
        h = BigInt.asIntN(64, h * 0x100000001b3n);
    }
    return Number(BigInt.asIntN(53, h));
}
