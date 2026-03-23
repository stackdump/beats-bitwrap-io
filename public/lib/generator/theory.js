/**
 * theory.js — Port of theory.go.
 * Genre-specific music theory: chord progressions, drum variant styles, phrase patterns.
 */

import { MinorChordProg } from './core.js';

/**
 * DrumVariant: { hitsAdd: int, hitsMul: float, rotationAdd: int }
 * GenreTheory: { chordProgs: [ChordProg], drumStyles: { role: { variant: DrumVariant } }, phrasePatterns?: { sectionName: [string] } }
 */

export const GenreTheories = {
    country: {
        chordProgs: [
            // I-IV-V-I
            { chords: [
                { root: 0, tones: [0, 2, 4] },
                { root: 3, tones: [3, 5, 0] },
                { root: 4, tones: [4, 6, 1] },
                { root: 0, tones: [0, 2, 4] },
            ], stepsPer: 4 },
            // I-vi-IV-V
            { chords: [
                { root: 0, tones: [0, 2, 4] },
                { root: 5, tones: [5, 0, 2] },
                { root: 3, tones: [3, 5, 0] },
                { root: 4, tones: [4, 6, 1] },
            ], stepsPer: 4 },
        ],
        drumStyles: {
            kick:  { B: { hitsAdd: 1, hitsMul: 1.0, rotationAdd: 2 }, C: { hitsAdd: -1, hitsMul: 1.0, rotationAdd: 4 } },
            snare: { B: { hitsAdd: 1, hitsMul: 1.0, rotationAdd: 3 }, C: { hitsAdd: 0,  hitsMul: 0.5, rotationAdd: 2 } },
            hihat: { B: { hitsAdd: 2, hitsMul: 1.0, rotationAdd: 1 }, C: { hitsAdd: -1, hitsMul: 1.0, rotationAdd: 3 } },
        },
        phrasePatterns: {
            intro:  ['A', 'A'],
            verse:  ['A', 'A', 'B', 'A'],
            chorus: ['A', 'B', 'A', 'B'],
            bridge: ['C', 'C'],
            outro:  ['A', 'A'],
        },
    },
    blues: {
        chordProgs: [
            // 12-bar blues: I*4, IV*2, I*2, V, IV, I, V
            { chords: [
                { root: 0, tones: [0, 2, 4] }, // I
                { root: 0, tones: [0, 2, 4] }, // I
                { root: 0, tones: [0, 2, 4] }, // I
                { root: 0, tones: [0, 2, 4] }, // I
                { root: 3, tones: [3, 5, 0] }, // IV
                { root: 3, tones: [3, 5, 0] }, // IV
                { root: 0, tones: [0, 2, 4] }, // I
                { root: 0, tones: [0, 2, 4] }, // I
                { root: 4, tones: [4, 6, 1] }, // V
                { root: 3, tones: [3, 5, 0] }, // IV
                { root: 0, tones: [0, 2, 4] }, // I
                { root: 4, tones: [4, 6, 1] }, // V (turnaround)
            ], stepsPer: 4 },
        ],
        drumStyles: {
            kick:  { B: { hitsAdd: 0,  hitsMul: 1.0, rotationAdd: 3 }, C: { hitsAdd: -1, hitsMul: 1.0, rotationAdd: 5 } },
            snare: { B: { hitsAdd: 1,  hitsMul: 1.0, rotationAdd: 2 }, C: { hitsAdd: 0,  hitsMul: 0.5, rotationAdd: 3 } },
            hihat: { B: { hitsAdd: 1,  hitsMul: 1.0, rotationAdd: 2 }, C: { hitsAdd: -2, hitsMul: 1.0, rotationAdd: 4 } },
        },
        phrasePatterns: {
            intro:  ['A', 'A'],
            verse:  ['A', 'A', 'A', 'B'],
            chorus: ['A', 'B', 'A', 'B'],
            bridge: ['C', 'C'],
            outro:  ['A', 'A'],
        },
    },
    jazz: {
        chordProgs: [
            // ii-V-I-vi
            { chords: [
                { root: 1, tones: [1, 3, 5] },
                { root: 4, tones: [4, 6, 1] },
                { root: 0, tones: [0, 2, 4] },
                { root: 5, tones: [5, 0, 2] },
            ], stepsPer: 4 },
            // iii-VI-ii-V
            { chords: [
                { root: 2, tones: [2, 4, 6] },
                { root: 5, tones: [5, 0, 2] },
                { root: 1, tones: [1, 3, 5] },
                { root: 4, tones: [4, 6, 1] },
            ], stepsPer: 4 },
        ],
        drumStyles: {
            kick:  { B: { hitsAdd: 1, hitsMul: 1.0, rotationAdd: 2 }, C: { hitsAdd: -1, hitsMul: 1.0, rotationAdd: 3 } },
            snare: { B: { hitsAdd: 1, hitsMul: 1.0, rotationAdd: 1 }, C: { hitsAdd: 0,  hitsMul: 0.5, rotationAdd: 4 } },
            hihat: { B: { hitsAdd: 2, hitsMul: 1.0, rotationAdd: 2 }, C: { hitsAdd: -1, hitsMul: 1.0, rotationAdd: 3 } },
        },
        phrasePatterns: {
            intro:  ['A', 'A'],
            verse:  ['A', 'B', 'A', 'B'],
            chorus: ['A', 'B', 'B', 'A'],
            bridge: ['C', 'C'],
            outro:  ['A', 'A'],
        },
    },
    house: {
        chordProgs: [
            // i-VII-VI-VII
            { chords: [
                { root: 0, tones: [0, 2, 4] },
                { root: 6, tones: [6, 1, 3] },
                { root: 5, tones: [5, 0, 2] },
                { root: 6, tones: [6, 1, 3] },
            ], stepsPer: 4 },
            // i-iv-VI-VII
            { chords: [
                { root: 0, tones: [0, 2, 4] },
                { root: 3, tones: [3, 5, 0] },
                { root: 5, tones: [5, 0, 2] },
                { root: 6, tones: [6, 1, 3] },
            ], stepsPer: 4 },
        ],
        drumStyles: {
            kick:  { B: { hitsAdd: 0,  hitsMul: 1.0, rotationAdd: 4 }, C: { hitsAdd: -2, hitsMul: 1.0, rotationAdd: 2 } },
            snare: { B: { hitsAdd: 1,  hitsMul: 1.0, rotationAdd: 2 }, C: { hitsAdd: -1, hitsMul: 1.0, rotationAdd: 3 } },
            hihat: { B: { hitsAdd: 2,  hitsMul: 1.0, rotationAdd: 1 }, C: { hitsAdd: -2, hitsMul: 1.0, rotationAdd: 4 } },
        },
    },
    edm: {
        chordProgs: [
            // i-VI-III-VII (existing minor)
            MinorChordProg,
            // i-VII-vi-V
            { chords: [
                { root: 0, tones: [0, 2, 4] },
                { root: 6, tones: [6, 1, 3] },
                { root: 5, tones: [5, 0, 2] },
                { root: 4, tones: [4, 6, 1] },
            ], stepsPer: 4 },
        ],
        drumStyles: {
            kick:  { B: { hitsAdd: 0,  hitsMul: 1.0, rotationAdd: 4 }, C: { hitsAdd: -2, hitsMul: 1.0, rotationAdd: 2 } },
            snare: { B: { hitsAdd: 1,  hitsMul: 1.0, rotationAdd: 2 }, C: { hitsAdd: -1, hitsMul: 1.0, rotationAdd: 4 } },
            hihat: { B: { hitsAdd: 2,  hitsMul: 1.0, rotationAdd: 1 }, C: { hitsAdd: -3, hitsMul: 1.0, rotationAdd: 3 } },
            clap:  { B: { hitsAdd: 1,  hitsMul: 1.0, rotationAdd: 2 }, C: { hitsAdd: -1, hitsMul: 1.0, rotationAdd: 4 } },
        },
    },
    techno: {
        chordProgs: [
            // i-VII-i-VII (minimal)
            { chords: [
                { root: 0, tones: [0, 2, 4] },
                { root: 6, tones: [6, 1, 3] },
                { root: 0, tones: [0, 2, 4] },
                { root: 6, tones: [6, 1, 3] },
            ], stepsPer: 4 },
        ],
        drumStyles: {
            kick:  { B: { hitsAdd: 0,  hitsMul: 1.0, rotationAdd: 4 }, C: { hitsAdd: -2, hitsMul: 1.0, rotationAdd: 2 } },
            snare: { B: { hitsAdd: 1,  hitsMul: 1.0, rotationAdd: 4 }, C: { hitsAdd: -1, hitsMul: 1.0, rotationAdd: 2 } },
            hihat: { B: { hitsAdd: 2,  hitsMul: 1.0, rotationAdd: 2 }, C: { hitsAdd: -3, hitsMul: 1.0, rotationAdd: 4 } },
        },
    },
    ambient: {
        chordProgs: [
            // I-iii-vi-IV
            { chords: [
                { root: 0, tones: [0, 2, 4] },
                { root: 2, tones: [2, 4, 6] },
                { root: 5, tones: [5, 0, 2] },
                { root: 3, tones: [3, 5, 0] },
            ], stepsPer: 4 },
        ],
        drumStyles: {
            kick:  { B: { hitsAdd: 0,  hitsMul: 1.0, rotationAdd: 4 }, C: { hitsAdd: -1, hitsMul: 1.0, rotationAdd: 6 } },
            snare: { B: { hitsAdd: 0,  hitsMul: 1.0, rotationAdd: 4 }, C: { hitsAdd: -1, hitsMul: 1.0, rotationAdd: 6 } },
            hihat: { B: { hitsAdd: 1,  hitsMul: 1.0, rotationAdd: 3 }, C: { hitsAdd: -1, hitsMul: 1.0, rotationAdd: 5 } },
        },
    },
    dnb: {
        chordProgs: [
            // i-VI-III-VII
            MinorChordProg,
        ],
        drumStyles: {
            kick:  { B: { hitsAdd: 1,  hitsMul: 1.0, rotationAdd: 3 }, C: { hitsAdd: -1, hitsMul: 1.0, rotationAdd: 5 } },
            snare: { B: { hitsAdd: 1,  hitsMul: 1.0, rotationAdd: 2 }, C: { hitsAdd: 0,  hitsMul: 0.5, rotationAdd: 3 } },
            hihat: { B: { hitsAdd: 2,  hitsMul: 1.0, rotationAdd: 1 }, C: { hitsAdd: -2, hitsMul: 1.0, rotationAdd: 4 } },
        },
    },
    speedcore: {
        chordProgs: [
            // i-VII (two-chord)
            { chords: [
                { root: 0, tones: [0, 2, 4] },
                { root: 6, tones: [6, 1, 3] },
            ], stepsPer: 8 },
        ],
        drumStyles: {
            kick:  { B: { hitsAdd: 2,  hitsMul: 1.0, rotationAdd: 2 }, C: { hitsAdd: -2, hitsMul: 1.0, rotationAdd: 4 } },
            snare: { B: { hitsAdd: 2,  hitsMul: 1.0, rotationAdd: 1 }, C: { hitsAdd: -2, hitsMul: 1.0, rotationAdd: 3 } },
            hihat: { B: { hitsAdd: 3,  hitsMul: 1.0, rotationAdd: 1 }, C: { hitsAdd: -4, hitsMul: 1.0, rotationAdd: 5 } },
        },
    },
    dubstep: {
        chordProgs: [
            // i-VII-VI-v
            { chords: [
                { root: 0, tones: [0, 2, 4] },
                { root: 6, tones: [6, 1, 3] },
                { root: 5, tones: [5, 0, 2] },
                { root: 4, tones: [4, 6, 1] },
            ], stepsPer: 4 },
        ],
        drumStyles: {
            kick:  { B: { hitsAdd: 1,  hitsMul: 1.0, rotationAdd: 3 }, C: { hitsAdd: -1, hitsMul: 1.0, rotationAdd: 5 } },
            snare: { B: { hitsAdd: 1,  hitsMul: 1.0, rotationAdd: 2 }, C: { hitsAdd: 0,  hitsMul: 0.5, rotationAdd: 4 } },
            hihat: { B: { hitsAdd: 2,  hitsMul: 1.0, rotationAdd: 1 }, C: { hitsAdd: -2, hitsMul: 1.0, rotationAdd: 3 } },
        },
    },
    synthwave: {
        chordProgs: [
            // i-VI-III-VII (dark minor, Stranger Things vibe)
            { chords: [
                { root: 0, tones: [0, 2, 4] },
                { root: 5, tones: [5, 0, 2] },
                { root: 2, tones: [2, 4, 6] },
                { root: 6, tones: [6, 1, 3] },
            ], stepsPer: 4 },
            // i-iv-VII-III (atmospheric)
            { chords: [
                { root: 0, tones: [0, 2, 4] },
                { root: 3, tones: [3, 5, 0] },
                { root: 6, tones: [6, 1, 3] },
                { root: 2, tones: [2, 4, 6] },
            ], stepsPer: 4 },
        ],
        drumStyles: {
            kick:  { B: { hitsAdd: 0,  hitsMul: 1.0, rotationAdd: 4 }, C: { hitsAdd: -2, hitsMul: 1.0, rotationAdd: 2 } },
            snare: { B: { hitsAdd: 1,  hitsMul: 1.0, rotationAdd: 2 }, C: { hitsAdd: -1, hitsMul: 1.0, rotationAdd: 4 } },
            hihat: { B: { hitsAdd: 1,  hitsMul: 1.0, rotationAdd: 2 }, C: { hitsAdd: -2, hitsMul: 1.0, rotationAdd: 3 } },
        },
        phrasePatterns: {
            intro:  ['A', 'A'],
            verse:  ['A', 'A', 'B', 'A'],
            chorus: ['A', 'B', 'A', 'B'],
            bridge: ['C', 'C'],
            outro:  ['A', 'A'],
        },
    },
    trance: {
        chordProgs: [
            // i-VI-VII-i (classic trance)
            { chords: [
                { root: 0, tones: [0, 2, 4] },
                { root: 5, tones: [5, 0, 2] },
                { root: 6, tones: [6, 1, 3] },
                { root: 0, tones: [0, 2, 4] },
            ], stepsPer: 4 },
            // i-iv-VI-VII (euphoric trance)
            { chords: [
                { root: 0, tones: [0, 2, 4] },
                { root: 3, tones: [3, 5, 0] },
                { root: 5, tones: [5, 0, 2] },
                { root: 6, tones: [6, 1, 3] },
            ], stepsPer: 4 },
        ],
        drumStyles: {
            kick:  { B: { hitsAdd: 0,  hitsMul: 1.0, rotationAdd: 4 }, C: { hitsAdd: -2, hitsMul: 1.0, rotationAdd: 2 } },
            snare: { B: { hitsAdd: 1,  hitsMul: 1.0, rotationAdd: 2 }, C: { hitsAdd: -1, hitsMul: 1.0, rotationAdd: 4 } },
            hihat: { B: { hitsAdd: 2,  hitsMul: 1.0, rotationAdd: 1 }, C: { hitsAdd: -3, hitsMul: 1.0, rotationAdd: 3 } },
        },
        phrasePatterns: {
            intro:     ['A', 'A'],
            verse:     ['A', 'A', 'B', 'A'],
            chorus:    ['A', 'B', 'A', 'B'],
            buildup:   ['A', 'B'],
            drop:      ['A', 'B', 'A', 'B'],
            breakdown: ['C', 'C'],
            bridge:    ['C', 'C'],
            outro:     ['A', 'A'],
        },
    },
    lofi: {
        chordProgs: [
            // ii-V-I-vi (jazz-influenced)
            { chords: [
                { root: 1, tones: [1, 3, 5] },
                { root: 4, tones: [4, 6, 1] },
                { root: 0, tones: [0, 2, 4] },
                { root: 5, tones: [5, 0, 2] },
            ], stepsPer: 4 },
            // I-iii-IV-iv (chromatic mediant)
            { chords: [
                { root: 0, tones: [0, 2, 4] },
                { root: 2, tones: [2, 4, 6] },
                { root: 3, tones: [3, 5, 0] },
                { root: 3, tones: [3, 5, 0] },
            ], stepsPer: 4 },
        ],
        drumStyles: {
            kick:  { B: { hitsAdd: 0,  hitsMul: 1.0, rotationAdd: 3 }, C: { hitsAdd: -1, hitsMul: 1.0, rotationAdd: 5 } },
            snare: { B: { hitsAdd: 0,  hitsMul: 1.0, rotationAdd: 2 }, C: { hitsAdd: -1, hitsMul: 1.0, rotationAdd: 4 } },
            hihat: { B: { hitsAdd: 1,  hitsMul: 1.0, rotationAdd: 2 }, C: { hitsAdd: -2, hitsMul: 1.0, rotationAdd: 3 } },
        },
        phrasePatterns: {
            intro:  ['A', 'A'],
            verse:  ['A', 'A', 'B', 'A'],
            chorus: ['A', 'B', 'A', 'B'],
            bridge: ['C', 'C'],
            outro:  ['A', 'A'],
        },
    },
    reggae: {
        chordProgs: [
            // I-IV-V-I (roots reggae)
            { chords: [
                { root: 0, tones: [0, 2, 4] },
                { root: 3, tones: [3, 5, 0] },
                { root: 4, tones: [4, 6, 1] },
                { root: 0, tones: [0, 2, 4] },
            ], stepsPer: 4 },
            // I-vi-IV-V (dub)
            { chords: [
                { root: 0, tones: [0, 2, 4] },
                { root: 5, tones: [5, 0, 2] },
                { root: 3, tones: [3, 5, 0] },
                { root: 4, tones: [4, 6, 1] },
            ], stepsPer: 4 },
        ],
        drumStyles: {
            kick:  { B: { hitsAdd: 1,  hitsMul: 1.0, rotationAdd: 2 }, C: { hitsAdd: -1, hitsMul: 1.0, rotationAdd: 4 } },
            snare: { B: { hitsAdd: 1,  hitsMul: 1.0, rotationAdd: 3 }, C: { hitsAdd: 0,  hitsMul: 0.5, rotationAdd: 2 } },
            hihat: { B: { hitsAdd: 1,  hitsMul: 1.0, rotationAdd: 1 }, C: { hitsAdd: -2, hitsMul: 1.0, rotationAdd: 3 } },
        },
        phrasePatterns: {
            intro:  ['A', 'A'],
            verse:  ['A', 'A', 'B', 'A'],
            chorus: ['A', 'B', 'A', 'B'],
            bridge: ['C', 'C'],
            outro:  ['A', 'A'],
        },
    },
    funk: {
        chordProgs: [
            // I7-IV7 (one-chord funk / two-chord vamp)
            { chords: [
                { root: 0, tones: [0, 2, 4] },
                { root: 0, tones: [0, 2, 4] },
                { root: 3, tones: [3, 5, 0] },
                { root: 0, tones: [0, 2, 4] },
            ], stepsPer: 4 },
            // I-IV-I-V (classic funk)
            { chords: [
                { root: 0, tones: [0, 2, 4] },
                { root: 3, tones: [3, 5, 0] },
                { root: 0, tones: [0, 2, 4] },
                { root: 4, tones: [4, 6, 1] },
            ], stepsPer: 4 },
        ],
        drumStyles: {
            kick:  { B: { hitsAdd: 2, hitsMul: 1.0, rotationAdd: 1 }, C: { hitsAdd: -1, hitsMul: 1.0, rotationAdd: 3 } },
            snare: { B: { hitsAdd: 1, hitsMul: 1.0, rotationAdd: 2 }, C: { hitsAdd: 0,  hitsMul: 0.5, rotationAdd: 4 } },
            hihat: { B: { hitsAdd: 2, hitsMul: 1.0, rotationAdd: 1 }, C: { hitsAdd: -2, hitsMul: 1.0, rotationAdd: 3 } },
        },
        phrasePatterns: {
            intro:  ['A', 'A'],
            verse:  ['A', 'A', 'B', 'A'],
            chorus: ['A', 'B', 'B', 'A'],
            bridge: ['C', 'C'],
            outro:  ['A', 'A'],
        },
    },
    bossa: {
        chordProgs: [
            // ii-V-I-vi (bossa standard)
            { chords: [
                { root: 1, tones: [1, 3, 5] },
                { root: 4, tones: [4, 6, 1] },
                { root: 0, tones: [0, 2, 4] },
                { root: 5, tones: [5, 0, 2] },
            ], stepsPer: 4 },
            // I-vi-ii-V (turnaround)
            { chords: [
                { root: 0, tones: [0, 2, 4] },
                { root: 5, tones: [5, 0, 2] },
                { root: 1, tones: [1, 3, 5] },
                { root: 4, tones: [4, 6, 1] },
            ], stepsPer: 4 },
        ],
        drumStyles: {
            kick:  { B: { hitsAdd: 1, hitsMul: 1.0, rotationAdd: 2 }, C: { hitsAdd: -1, hitsMul: 1.0, rotationAdd: 4 } },
            snare: { B: { hitsAdd: 1, hitsMul: 1.0, rotationAdd: 1 }, C: { hitsAdd: 0,  hitsMul: 0.5, rotationAdd: 3 } },
            hihat: { B: { hitsAdd: 1, hitsMul: 1.0, rotationAdd: 2 }, C: { hitsAdd: -2, hitsMul: 1.0, rotationAdd: 4 } },
        },
        phrasePatterns: {
            intro:  ['A', 'A'],
            verse:  ['A', 'B', 'A', 'B'],
            chorus: ['A', 'B', 'B', 'A'],
            bridge: ['C', 'C'],
            outro:  ['A', 'A'],
        },
    },
    trap: {
        chordProgs: [
            // i-VII-VI-VII (dark minor)
            { chords: [
                { root: 0, tones: [0, 2, 4] },
                { root: 6, tones: [6, 1, 3] },
                { root: 5, tones: [5, 0, 2] },
                { root: 6, tones: [6, 1, 3] },
            ], stepsPer: 4 },
            // i-iv-i-VII (trap minor)
            { chords: [
                { root: 0, tones: [0, 2, 4] },
                { root: 3, tones: [3, 5, 0] },
                { root: 0, tones: [0, 2, 4] },
                { root: 6, tones: [6, 1, 3] },
            ], stepsPer: 4 },
        ],
        drumStyles: {
            kick:  { B: { hitsAdd: 1,  hitsMul: 1.0, rotationAdd: 3 }, C: { hitsAdd: -1, hitsMul: 1.0, rotationAdd: 5 } },
            snare: { B: { hitsAdd: 1,  hitsMul: 1.0, rotationAdd: 2 }, C: { hitsAdd: -1, hitsMul: 1.0, rotationAdd: 4 } },
            hihat: { B: { hitsAdd: 2,  hitsMul: 1.0, rotationAdd: 1 }, C: { hitsAdd: -3, hitsMul: 1.0, rotationAdd: 3 } },
        },
        phrasePatterns: {
            intro:  ['A', 'A'],
            verse:  ['A', 'A', 'B', 'A'],
            chorus: ['A', 'B', 'A', 'B'],
            bridge: ['C', 'C'],
            outro:  ['A', 'A'],
        },
    },
    garage: {
        chordProgs: [
            // i-VII-VI-VII (2-step classic)
            { chords: [
                { root: 0, tones: [0, 2, 4] },
                { root: 6, tones: [6, 1, 3] },
                { root: 5, tones: [5, 0, 2] },
                { root: 6, tones: [6, 1, 3] },
            ], stepsPer: 4 },
            // i-iv-VII-III
            { chords: [
                { root: 0, tones: [0, 2, 4] },
                { root: 3, tones: [3, 5, 0] },
                { root: 6, tones: [6, 1, 3] },
                { root: 2, tones: [2, 4, 6] },
            ], stepsPer: 4 },
        ],
        drumStyles: {
            kick:  { B: { hitsAdd: 1,  hitsMul: 1.0, rotationAdd: 3 }, C: { hitsAdd: -1, hitsMul: 1.0, rotationAdd: 5 } },
            snare: { B: { hitsAdd: 1,  hitsMul: 1.0, rotationAdd: 2 }, C: { hitsAdd: 0,  hitsMul: 0.5, rotationAdd: 3 } },
            hihat: { B: { hitsAdd: 2,  hitsMul: 1.0, rotationAdd: 1 }, C: { hitsAdd: -2, hitsMul: 1.0, rotationAdd: 4 } },
        },
        phrasePatterns: {
            intro:  ['A', 'A'],
            verse:  ['A', 'A', 'B', 'A'],
            chorus: ['A', 'B', 'A', 'B'],
            bridge: ['C', 'C'],
            outro:  ['A', 'A'],
        },
    },
    metal: {
        chordProgs: [
            // i-II-VII-i (phrygian metal)
            { chords: [
                { root: 0, tones: [0, 2, 4] },
                { root: 1, tones: [1, 3, 5] },
                { root: 6, tones: [6, 1, 3] },
                { root: 0, tones: [0, 2, 4] },
            ], stepsPer: 4 },
            // i-VI-VII-i (power chord)
            { chords: [
                { root: 0, tones: [0, 2, 4] },
                { root: 5, tones: [5, 0, 2] },
                { root: 6, tones: [6, 1, 3] },
                { root: 0, tones: [0, 2, 4] },
            ], stepsPer: 4 },
        ],
        drumStyles: {
            kick:  { B: { hitsAdd: 2,  hitsMul: 1.0, rotationAdd: 2 }, C: { hitsAdd: -2, hitsMul: 1.0, rotationAdd: 4 } },
            snare: { B: { hitsAdd: 2,  hitsMul: 1.0, rotationAdd: 1 }, C: { hitsAdd: -1, hitsMul: 1.0, rotationAdd: 3 } },
            hihat: { B: { hitsAdd: 2,  hitsMul: 1.0, rotationAdd: 1 }, C: { hitsAdd: -3, hitsMul: 1.0, rotationAdd: 4 } },
        },
        phrasePatterns: {
            intro:     ['A', 'A'],
            verse:     ['A', 'A', 'B', 'A'],
            chorus:    ['A', 'B', 'A', 'B'],
            breakdown: ['C', 'C'],
            bridge:    ['C', 'C'],
            outro:     ['A', 'A'],
        },
    },
};

/**
 * genrePhrases returns the phrase pattern for a section from the genre theory,
 * falling back to defaultPhrases if the genre has no specific pattern.
 */
export function genrePhrases(theory, sectionName) {
    if (theory && theory.phrasePatterns) {
        const pattern = theory.phrasePatterns[sectionName];
        if (pattern) return pattern;
    }
    return defaultPhrases(sectionName);
}

/** defaultPhrases returns fallback phrase patterns for common section names. */
export function defaultPhrases(sectionName) {
    switch (sectionName) {
    case 'intro':
    case 'outro':
        return ['A', 'A'];
    case 'verse':
        return ['A', 'A', 'B', 'A'];
    case 'chorus':
    case 'drop':
        return ['A', 'B', 'A', 'B'];
    case 'bridge':
    case 'breakdown':
        return ['C', 'C'];
    case 'buildup':
    case 'pre-chorus':
        return ['A', 'B'];
    case 'solo':
        return ['A', 'B', 'C', 'A'];
    default:
        return ['A', 'A'];
    }
}
