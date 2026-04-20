/**
 * composer.js — Main composition orchestrator.
 * Port of petri-note/internal/generator/composer.go
 */

import {
    createRng, drumSeed, Major, Minor, Dorian, Mixolydian, Phrygian,
    HarmonicMin, Pentatonic, MinPentatonic, Blues,
    scaleNotes, MajorScale, MinorScale, PentatonicScale,
    MinPentatonicScale, BluesScale,
    AccentNone, AccentKick, AccentSnare, AccentHihat,
    MinorChordProg, MajorChordProg,
} from './core.js';
import { GenreTheories } from './theory.js';
import { euclidean, euclideanMelodic } from './euclidean.js';
import { markovMelody } from './markov.js';
import { drumRiff, melodyRiff } from './riffs.js';
import { ghostNoteHihat, walkingBassLine, callResponseMelody, applyModalInterchange, drumFillNet, chorus } from './variety.js';
import { fadeIn, fadeOut, drumBreak } from './arrange.js';
import { generateStructure, songStructure, extractSlotIndex } from './structure.js';
import { genrePhrases } from './theory.js';
import { shuffleInstruments } from './shuffle.js';

// Scale helper functions matching Go's func(int) []int pattern
const MixolydianScale = (root) => scaleNotes(root, Mixolydian, 2);
const PhrygianScale = (root) => scaleNotes(root, Phrygian, 2);
const HarmonicMinScale = (root) => scaleNotes(root, HarmonicMin, 2);
const DorianScale = (root) => scaleNotes(root, Dorian, 2);

// --- Genre definitions ---
export const Genres = {
    techno: {
        name: 'techno', bpm: 128, scale: MajorScale, rootNote: 48,
        kick: [4, 16, 0, 36], snare: [2, 16, 4, 38], hihat: [5, 8, 0, 42],
        melodyChannel: 4, melodyDensity: 0.4, melodyDuration: 150,
        bassChannel: 6, bassDensity: 0.5, bassDuration: 200,
        swing: 0, humanize: 10, durationVariation: 0.2,
        theory: GenreTheories.techno,
        syncopation: 0.1, ghostNotes: 0.3,
    },
    house: {
        name: 'house', bpm: 124, scale: MinorScale, rootNote: 48,
        kick: [4, 16, 0, 36], snare: [3, 8, 0, 38], hihat: [6, 8, 0, 42],
        melodyChannel: 4, melodyDensity: 0.5, melodyDuration: 120,
        bassChannel: 6, bassDensity: 0.6, bassDuration: 180,
        swing: 20, humanize: 15, durationVariation: 0.25,
        theory: GenreTheories.house,
        syncopation: 0.2, ghostNotes: 0.4,
    },
    jazz: {
        name: 'jazz', bpm: 110, scale: DorianScale, rootNote: 55,
        kick: [3, 12, 0, 36], snare: [2, 12, 3, 38], hihat: [5, 12, 0, 42],
        melodyChannel: 4, melodyDensity: 0.6, melodyDuration: 100,
        bassChannel: 6, bassDensity: 0.4, bassDuration: 250,
        swing: 60, humanize: 40, durationVariation: 0.6,
        theory: GenreTheories.jazz,
        drumFills: true, walkingBass: true, syncopation: 0.5,
        callResponse: true, tensionCurve: true, modalInterchange: 0.3, ghostNotes: 0.6,
    },
    ambient: {
        name: 'ambient', bpm: 72, scale: PentatonicScale, rootNote: 60,
        kick: [2, 16, 0, 36], snare: [1, 16, 8, 38], hihat: [3, 16, 0, 42],
        melodyChannel: 4, melodyDensity: 0.3, melodyDuration: 400,
        bassChannel: 6, bassDensity: 0.2, bassDuration: 500,
        swing: 0, humanize: 25, durationVariation: 0.4,
        theory: GenreTheories.ambient,
        tensionCurve: true, modalInterchange: 0.2,
    },
    dnb: {
        name: 'dnb', bpm: 174, scale: MinorScale, rootNote: 43,
        kick: [3, 16, 0, 36], snare: [2, 8, 2, 38], hihat: [7, 8, 0, 42],
        melodyChannel: 4, melodyDensity: 0.5, melodyDuration: 80,
        bassChannel: 6, bassDensity: 0.7, bassDuration: 120,
        swing: 10, humanize: 15, durationVariation: 0.3,
        theory: GenreTheories.dnb,
        drumFills: true, polyrhythm: 6, syncopation: 0.3, tensionCurve: true, ghostNotes: 0.5,
    },
    edm: {
        name: 'edm', bpm: 138, scale: MinorScale, rootNote: 45,
        kick: [4, 16, 0, 36], snare: [2, 16, 4, 40], hihat: [8, 16, 0, 42],
        melodyChannel: 4, melodyDensity: 0.6, melodyDuration: 100,
        bassChannel: 6, bassDensity: 0.5, bassDuration: 150,
        swing: 0, humanize: 8, durationVariation: 0.15,
        theory: GenreTheories.edm,
        drumFills: true, syncopation: 0.15, tensionCurve: true, modalInterchange: 0.1, ghostNotes: 0.3,
    },
    speedcore: {
        name: 'speedcore', bpm: 220, scale: MinorScale, rootNote: 40,
        kick: [8, 16, 0, 36], snare: [4, 16, 2, 40], hihat: [12, 16, 0, 42],
        melodyChannel: 4, melodyDensity: 0.7, melodyDuration: 50,
        bassChannel: 6, bassDensity: 0.8, bassDuration: 60,
        swing: 0, humanize: 5, durationVariation: 0.1,
        theory: GenreTheories.speedcore,
        syncopation: 0.05, ghostNotes: 0.2,
    },
    dubstep: {
        name: 'dubstep', bpm: 140, scale: MinorScale, rootNote: 38,
        kick: [3, 16, 0, 36], snare: [2, 16, 4, 38], hihat: [5, 16, 0, 42],
        melodyChannel: 4, melodyDensity: 0.4, melodyDuration: 120,
        bassChannel: 6, bassDensity: 0.6, bassDuration: 200,
        swing: 15, humanize: 12, durationVariation: 0.3,
        theory: GenreTheories.dubstep,
        drumFills: true, syncopation: 0.3, tensionCurve: true, modalInterchange: 0.15, ghostNotes: 0.4,
    },
    country: {
        name: 'country', bpm: 110, scale: MajorScale, rootNote: 48,
        kick: [4, 16, 0, 36], snare: [4, 16, 4, 38], hihat: [8, 16, 0, 42],
        melodyChannel: 4, melodyDensity: 0.5, melodyDuration: 140,
        bassChannel: 6, bassDensity: 0.5, bassDuration: 200,
        swing: 15, humanize: 20, durationVariation: 0.3,
        theory: GenreTheories.country,
        walkingBass: true, syncopation: 0.2, callResponse: true, modalInterchange: 0.1, ghostNotes: 0.3,
    },
    blues: {
        name: 'blues', bpm: 95, scale: BluesScale, rootNote: 48,
        kick: [3, 16, 0, 36], snare: [2, 16, 4, 38], hihat: [6, 16, 0, 42],
        melodyChannel: 4, melodyDensity: 0.5, melodyDuration: 160,
        bassChannel: 6, bassDensity: 0.4, bassDuration: 250,
        swing: 50, humanize: 35, durationVariation: 0.5,
        theory: GenreTheories.blues,
        drumFills: true, walkingBass: true, syncopation: 0.4,
        callResponse: true, tensionCurve: true, modalInterchange: 0.2, ghostNotes: 0.5,
    },
    synthwave: {
        name: 'synthwave', bpm: 108, scale: MinorScale, rootNote: 48,
        kick: [4, 16, 0, 36], snare: [2, 16, 4, 38], hihat: [4, 8, 0, 42],
        melodyChannel: 4, melodyDensity: 0.4, melodyDuration: 200,
        bassChannel: 6, bassDensity: 0.6, bassDuration: 300,
        swing: 0, humanize: 5, durationVariation: 0.2,
        theory: GenreTheories.synthwave,
        syncopation: 0.05, ghostNotes: 0.15, tensionCurve: true, modalInterchange: 0.1,
    },
    trance: {
        name: 'trance', bpm: 140, scale: MinorScale, rootNote: 45,
        kick: [4, 16, 0, 36], snare: [2, 16, 4, 40], hihat: [8, 16, 0, 42],
        melodyChannel: 4, melodyDensity: 0.5, melodyDuration: 150,
        bassChannel: 6, bassDensity: 0.6, bassDuration: 180,
        swing: 0, humanize: 5, durationVariation: 0.15,
        theory: GenreTheories.trance,
        tensionCurve: true, syncopation: 0.1, ghostNotes: 0.2, modalInterchange: 0.15,
    },
    lofi: {
        name: 'lofi', bpm: 82, scale: MinPentatonicScale, rootNote: 55,
        kick: [3, 16, 0, 36], snare: [2, 16, 4, 38], hihat: [5, 8, 0, 42],
        melodyChannel: 4, melodyDensity: 0.35, melodyDuration: 250,
        bassChannel: 6, bassDensity: 0.3, bassDuration: 350,
        swing: 35, humanize: 40, durationVariation: 0.5,
        theory: GenreTheories.lofi,
        syncopation: 0.2, ghostNotes: 0.6, modalInterchange: 0.15,
    },
    reggae: {
        name: 'reggae', bpm: 75, scale: MajorScale, rootNote: 48,
        kick: [3, 16, 0, 36], snare: [2, 16, 6, 37], hihat: [8, 16, 0, 42],
        melodyChannel: 4, melodyDensity: 0.4, melodyDuration: 180,
        bassChannel: 6, bassDensity: 0.5, bassDuration: 250,
        swing: 25, humanize: 25, durationVariation: 0.35,
        theory: GenreTheories.reggae,
        syncopation: 0.4, ghostNotes: 0.3, walkingBass: true,
    },
    funk: {
        name: 'funk', bpm: 108, scale: MixolydianScale, rootNote: 48,
        kick: [5, 16, 0, 36], snare: [4, 16, 4, 38], hihat: [8, 16, 0, 42],
        melodyChannel: 4, melodyDensity: 0.55, melodyDuration: 100,
        bassChannel: 6, bassDensity: 0.6, bassDuration: 150,
        swing: 30, humanize: 25, durationVariation: 0.4,
        theory: GenreTheories.funk,
        syncopation: 0.5, ghostNotes: 0.6, walkingBass: true,
        callResponse: true, drumFills: true,
    },
    bossa: {
        name: 'bossa', bpm: 88, scale: DorianScale, rootNote: 53,
        kick: [3, 16, 0, 36], snare: [5, 16, 3, 37], hihat: [6, 8, 0, 42],
        melodyChannel: 4, melodyDensity: 0.45, melodyDuration: 160,
        bassChannel: 6, bassDensity: 0.5, bassDuration: 220,
        swing: 40, humanize: 30, durationVariation: 0.45,
        theory: GenreTheories.bossa,
        syncopation: 0.35, ghostNotes: 0.5, walkingBass: true,
        callResponse: true, modalInterchange: 0.25,
    },
    trap: {
        name: 'trap', bpm: 140, scale: MinorScale, rootNote: 38,
        kick: [3, 16, 0, 36], snare: [2, 16, 4, 40], hihat: [10, 16, 0, 42],
        melodyChannel: 4, melodyDensity: 0.35, melodyDuration: 120,
        bassChannel: 6, bassDensity: 0.5, bassDuration: 250,
        swing: 10, humanize: 8, durationVariation: 0.2,
        theory: GenreTheories.trap,
        syncopation: 0.3, ghostNotes: 0.4, drumFills: true, tensionCurve: true,
    },
    garage: {
        name: 'garage', bpm: 130, scale: MinorScale, rootNote: 45,
        kick: [3, 16, 0, 36], snare: [3, 16, 2, 38], hihat: [7, 8, 0, 42],
        melodyChannel: 4, melodyDensity: 0.45, melodyDuration: 110,
        bassChannel: 6, bassDensity: 0.6, bassDuration: 160,
        swing: 30, humanize: 18, durationVariation: 0.3,
        theory: GenreTheories.garage,
        syncopation: 0.35, ghostNotes: 0.45, drumFills: true,
    },
    metal: {
        name: 'metal', bpm: 180, scale: PhrygianScale, rootNote: 40,
        kick: [8, 16, 0, 36], snare: [4, 16, 4, 38], hihat: [8, 8, 0, 42],
        melodyChannel: 4, melodyDensity: 0.6, melodyDuration: 70,
        bassChannel: 6, bassDensity: 0.7, bassDuration: 80,
        swing: 0, humanize: 8, durationVariation: 0.15,
        theory: GenreTheories.metal,
        syncopation: 0.15, ghostNotes: 0.2, drumFills: true, tensionCurve: true,
    },
};

// --- Genre instrument sets ---
export const GenreInstrumentSets = {
    techno: {
        kick: ['drums', 'drums-v8'], snare: ['drums', 'drums-v8'], hihat: ['drums', 'drums-v8'],
        bass: ['acid', 'reese', 'sub-bass', 'fm-bass', 'drop-bass'],
        melody: ['supersaw', 'square-lead', 'pwm-lead', 'sync-lead', 'trance-lead', 'big-saw'],
    },
    house: {
        kick: ['drums', 'drums-v8'], snare: ['drums', 'drums-v8'], hihat: ['drums', 'drums-v8'],
        bass: ['bass', 'sub-bass', 'acid', 'duo-bass'],
        melody: ['electric-piano', 'piano', 'organ', 'brass', 'sax', 'rave-organ'],
    },
    jazz: {
        kick: ['drums-cr78', 'drums'], snare: ['drums-cr78', 'drums'], hihat: ['drums-cr78', 'drums'],
        bass: ['sub-bass', 'bass', 'reese'],
        melody: ['vibes', 'electric-piano', 'piano', 'marimba', 'trumpet', 'sax', 'flute'],
    },
    ambient: {
        kick: ['drums', 'drums-v8'], snare: ['drums', 'drums-v8'], hihat: ['drums', 'drums-v8'],
        bass: ['sub-bass', 'dark-pad', 'bass', 'reese'],
        melody: ['warm-pad', 'pad', 'fm-bell', 'strings', 'glass-pad', 'choir', 'music-box', 'kalimba', 'sitar', 'flute', 'am-bell', 'am-pad'],
    },
    dnb: {
        kick: ['drums-breakbeat', 'drums'], snare: ['drums-breakbeat', 'drums'], hihat: ['drums-breakbeat', 'drums'],
        bass: ['reese', 'acid', 'sub-bass', 'rubber-bass', 'drop-bass'],
        melody: ['square-lead', 'supersaw', 'bright-pluck', 'pwm-lead', 'sync-lead', 'lead', 'duo-lead', 'edm-pluck'],
    },
    edm: {
        kick: ['drums', 'drums-v8'], snare: ['drums', 'drums-v8'], hihat: ['drums', 'drums-v8'],
        clap: ['drums', 'drums-v8'], arp: ['bright-pluck', 'pluck', 'muted-pluck', 'edm-pluck'],
        bass: ['acid', 'reese', 'sub-bass', 'drop-bass', 'fm-bass'],
        melody: ['supersaw', 'hoover', 'pwm-lead', 'lead', 'sync-lead', 'big-saw', 'trance-lead', 'edm-stab'],
    },
    speedcore: {
        kick: ['drums-v8', 'drums'], snare: ['drums-v8', 'drums'], hihat: ['drums-v8', 'drums'],
        bass: ['acid', 'reese', 'sub-bass', 'rubber-bass', 'drop-bass'],
        melody: ['scream-lead', 'distorted-lead', 'hoover', 'distorted-guitar', 'screech', 'laser'],
    },
    dubstep: {
        kick: ['drums-v8', 'drums'], snare: ['drums-v8', 'drums'], hihat: ['drums-v8', 'drums'],
        bass: ['wobble-bass', 'reese', 'acid', '808-bass', 'rubber-bass', 'drop-bass', 'fm-bass'],
        melody: ['detuned-saw', 'distorted-lead', 'rave-stab', 'supersaw', 'hoover', 'wobble-lead', 'screech'],
    },
    country: {
        kick: ['drums', 'drums-cr78'], snare: ['drums', 'drums-cr78'], hihat: ['drums', 'drums-cr78'],
        bass: ['bass', 'sub-bass', 'acoustic-guitar', 'reese'],
        melody: ['piano', 'electric-piano', 'bright-pluck', 'acoustic-guitar', 'electric-guitar', 'steel-drum', 'harpsichord'],
    },
    blues: {
        kick: ['drums-cr78', 'drums'], snare: ['drums-cr78', 'drums'], hihat: ['drums-cr78', 'drums'],
        bass: ['bass', 'sub-bass', 'reese', 'acid'],
        melody: ['electric-guitar', 'acoustic-guitar', 'electric-piano', 'piano', 'organ', 'trumpet', 'sax', 'brass'],
    },
    synthwave: {
        kick: ['drums-v8', 'drums'], snare: ['drums-v8', 'drums'], hihat: ['drums-v8', 'drums'],
        arp: ['pluck', 'bright-pluck', 'muted-pluck', 'edm-pluck'],
        bass: ['sub-bass', 'dark-pad', 'reese', 'duo-bass'],
        melody: ['warm-pad', 'dark-pad', 'pad', 'strings', 'tape-lead', 'glass-pad', 'am-pad', 'duo-lead'],
    },
    trance: {
        kick: ['drums-v8', 'drums'], snare: ['drums-v8', 'drums'], hihat: ['drums-v8', 'drums'],
        arp: ['bright-pluck', 'pluck', 'muted-pluck', 'edm-pluck'],
        bass: ['acid', 'sub-bass', 'reese', 'fm-bass'],
        melody: ['supersaw', 'pad', 'warm-pad', 'lead', 'glass-pad', 'choir', 'sync-lead', 'trance-lead', 'big-saw'],
    },
    lofi: {
        kick: ['drums-lofi', 'drums-cr78', 'drums'], snare: ['drums-lofi', 'drums-cr78', 'drums'], hihat: ['drums-lofi', 'drums-cr78', 'drums'],
        bass: ['sub-bass', 'bass', 'reese', 'dark-pad'],
        melody: ['electric-piano', 'piano', 'vibes', 'fm-bell', 'music-box', 'kalimba', 'tape-lead', 'acoustic-guitar'],
    },
    reggae: {
        kick: ['drums', 'drums-cr78'], snare: ['drums', 'drums-cr78'], hihat: ['drums', 'drums-cr78'],
        bass: ['bass', 'sub-bass', 'reese', 'acid'],
        melody: ['organ', 'electric-piano', 'clavinet', 'piano', 'acoustic-guitar', 'steel-drum', 'brass', 'sax', 'kalimba'],
    },
    funk: {
        kick: ['drums', 'drums-breakbeat'], snare: ['drums', 'drums-breakbeat'], hihat: ['drums', 'drums-breakbeat'],
        bass: ['bass', 'acid', 'sub-bass'],
        melody: ['clavinet', 'organ', 'electric-piano', 'electric-guitar', 'bright-pluck', 'talkbox', 'trumpet', 'sax', 'brass'],
    },
    bossa: {
        kick: ['drums-cr78', 'drums'], snare: ['drums-cr78', 'drums'], hihat: ['drums-cr78', 'drums'],
        bass: ['bass', 'sub-bass', 'reese', 'acoustic-guitar'],
        melody: ['vibes', 'electric-piano', 'piano', 'marimba', 'flute', 'sax', 'kalimba', 'acoustic-guitar', 'trumpet', 'steel-drum'],
    },
    trap: {
        kick: ['drums-808', 'drums-v8', 'drums'], snare: ['drums-808', 'drums-v8', 'drums'], hihat: ['drums-808', 'drums-v8', 'drums'],
        bass: ['808-bass', 'sub-bass', 'reese', 'wobble-bass', 'drop-bass'],
        melody: ['dark-pad', 'detuned-saw', 'pluck', 'fm-bell', 'sync-lead', 'chiptune', 'laser'],
    },
    garage: {
        kick: ['drums', 'drums-v8'], snare: ['drums', 'drums-v8'], hihat: ['drums', 'drums-v8'],
        bass: ['sub-bass', 'reese', 'bass', 'rubber-bass', 'duo-bass'],
        melody: ['bright-pluck', 'pluck', 'electric-piano', 'lead', 'brass', 'edm-pluck'],
    },
    metal: {
        kick: ['drums-v8', 'drums'], snare: ['drums-v8', 'drums'], hihat: ['drums-v8', 'drums'],
        bass: ['reese', 'acid', 'distorted-lead', 'rubber-bass', 'drop-bass'],
        melody: ['distorted-guitar', 'distorted-lead', 'scream-lead', 'hoover', 'supersaw', 'screech'],
    },
};

// --- Track name generator ---
function generateTrackName(genre, rng) {
    const adjectives = [
        'Neon', 'Velvet', 'Crystal', 'Midnight', 'Golden',
        'Electric', 'Cosmic', 'Faded', 'Phantom', 'Solar',
        'Liquid', 'Frozen', 'Burning', 'Silent', 'Digital',
        'Hollow', 'Iron', 'Violet', 'Crimson', 'Silver',
        'Amber', 'Azure', 'Jade', 'Obsidian', 'Ivory',
        'Rusted', 'Wired', 'Broken', 'Floating', 'Endless',
    ];
    const nouns = [
        'Drift', 'Pulse', 'Echo', 'Haze', 'Bloom',
        'Wave', 'Storm', 'Glow', 'Shade', 'Vibe',
        'Circuit', 'Signal', 'Mirage', 'Orbit', 'Tide',
        'Vapor', 'Ember', 'Fracture', 'Horizon', 'Spine',
        'Flicker', 'Reverb', 'Cipher', 'Arc', 'Lattice',
        'Prism', 'Rust', 'Grain', 'Thread', 'Void',
    ];
    const adj = adjectives[rng.nextInt(adjectives.length)];
    const noun = nouns[rng.nextInt(nouns.length)];
    return `${genre} \u00b7 ${adj} ${noun}`;
}

// Drum roles set
const drumRoles = { kick: true, snare: true, hihat: true, clap: true };

// --- expandVariants ---
function expandVariants(proj, tmpl, genre, rng, tensionCurve) {
    const { tensionForVariant } = (() => {
        // Inline import to avoid circular dependency
        return { tensionForVariant: (variant) => {
            switch (variant) {
                case 'B': return { densityMul: 1.3, velocityAdd: 10, registerShift: 2 };
                case 'C': return { densityMul: 0.6, velocityAdd: -10, registerShift: -3 };
                default: return { densityMul: 1.0, velocityAdd: 0, registerShift: 0 };
            }
        }};
    })();

    tmpl.slotMap = tmpl.slotMap || {};

    // Collect roles that appear in phrase patterns
    const rolesInPhrases = {};
    for (const sec of tmpl.sections) {
        if (sec.phrases) {
            for (const role of Object.keys(sec.phrases)) {
                rolesInPhrases[role] = true;
            }
        }
    }

    for (const role of Object.keys(rolesInPhrases)) {
        const baseBundle = proj.nets[role];
        if (!baseBundle) continue;

        const isDrum = !!drumRoles[role];

        const slotMap = [];
        let slotIdx = 0;
        let totalSlots = 0;
        const letterSlots = {}; // letter -> slot index (drums only)

        for (let si = 0; si < tmpl.sections.length; si++) {
            const sec = tmpl.sections[si];
            let phrases = (sec.phrases && sec.phrases[role]) || ['A'];
            const sectionSlots = [];

            if (sec.active && sec.active[role]) {
                for (const letter of phrases) {
                    if (isDrum) {
                        if (letter in letterSlots) {
                            sectionSlots.push(letterSlots[letter]);
                        } else {
                            letterSlots[letter] = slotIdx;
                            sectionSlots.push(slotIdx);
                            slotIdx++;
                            totalSlots++;
                        }
                    } else {
                        sectionSlots.push(slotIdx);
                        slotIdx++;
                        totalSlots++;
                    }
                }
            } else {
                for (let pi = 0; pi < phrases.length; pi++) {
                    sectionSlots.push(-1);
                }
            }
            slotMap.push(sectionSlots);
        }

        tmpl.slotMap[role] = slotMap;

        if (totalSlots <= 1) continue;

        // Generate one net per slot
        for (let si = 0; si < tmpl.sections.length; si++) {
            const sec = tmpl.sections[si];
            let phrases = (sec.phrases && sec.phrases[role]) || ['A'];

            for (let pi = 0; pi < phrases.length; pi++) {
                const letter = phrases[pi];
                const idx = slotMap[si][pi];
                if (idx < 0) continue;

                const slotNetId = `${role}-${idx}`;
                if (proj.nets[slotNetId]) continue; // already created

                if (isDrum) {
                    let hits, steps, rotation, note;
                    switch (role) {
                        case 'kick': [hits, steps, rotation, note] = genre.kick; break;
                        case 'snare': [hits, steps, rotation, note] = genre.snare; break;
                        case 'hihat': [hits, steps, rotation, note] = genre.hihat; break;
                        default: [hits, steps, rotation, note] = genre.snare; break;
                    }

                    const dSeed = drumSeed(`${genre.name}:${role}:${letter}`);
                    const params = {
                        channel: baseBundle.track.channel,
                        velocity: baseBundle.track.defaultVelocity,
                        duration: 50,
                        seed: dSeed,
                        accent: AccentNone,
                    };
                    switch (role) {
                        case 'kick': params.accent = AccentKick; break;
                        case 'snare': params.accent = AccentSnare; break;
                        case 'hihat': params.accent = AccentHihat; break;
                    }

                    let drumStyle = null;
                    if (genre.theory && genre.theory.drumStyles) {
                        const roleStyles = genre.theory.drumStyles[role];
                        if (roleStyles && roleStyles[letter]) {
                            drumStyle = roleStyles[letter];
                        }
                    }

                    const nb = drumRiff(letter, hits, steps, rotation, note, params, drumStyle);
                    nb.riffGroup = role;
                    nb.riffVariant = letter;
                    nb.track = { ...baseBundle.track };
                    proj.nets[slotNetId] = nb;
                } else {
                    let scale, rootNote, density, duration;
                    switch (role) {
                        case 'bass':
                            scale = genre.scale(genre.rootNote);
                            if (scale.length > Major.length) scale = scale.slice(0, Major.length);
                            rootNote = genre.rootNote;
                            density = genre.bassDensity;
                            duration = genre.bassDuration;
                            break;
                        case 'melody':
                            rootNote = genre.rootNote + 12;
                            scale = genre.scale(rootNote);
                            density = genre.melodyDensity;
                            duration = genre.melodyDuration;
                            break;
                        default:
                            rootNote = genre.rootNote + 12;
                            scale = genre.scale(rootNote);
                            density = genre.melodyDensity;
                            duration = genre.melodyDuration;
                            break;
                    }

                    let vel = baseBundle.track.defaultVelocity;

                    if (tensionCurve) {
                        const tension = tensionForVariant(letter);
                        density *= tension.densityMul;
                        if (density > 1.0) density = 1.0;
                        vel += tension.velocityAdd;
                        rootNote += tension.registerShift;
                        scale = genre.scale(rootNote);
                        if (role === 'bass' && scale.length > Major.length) {
                            scale = scale.slice(0, Major.length);
                        }
                    }

                    const params = {
                        scale, rootNote,
                        channel: baseBundle.track.channel,
                        velocity: vel,
                        duration, density,
                        seed: rng.nextInt63(),
                        durationVariation: genre.durationVariation,
                    };

                    const nb = melodyRiff(letter, params);
                    nb.riffGroup = role;
                    nb.riffVariant = letter;
                    nb.track = { ...baseBundle.track };
                    proj.nets[slotNetId] = nb;
                }
            }
        }

        // Remove the base net
        delete proj.nets[role];
    }
}

function getBoolOverride(overrides, key) {
    return overrides && overrides[key] === true;
}

// --- Compose: main entry point ---
export function compose(genreName, overrides = {}) {
    let genre = Genres[genreName];
    if (!genre) genre = Genres.techno;

    let seed = Date.now();
    if (typeof overrides.seed === 'number') seed = overrides.seed;
    const rng = createRng(seed);

    let bpm = genre.bpm;
    if (typeof overrides.bpm === 'number') bpm = overrides.bpm;

    // Parse variety overrides
    let df = genre.drumFills || false;
    if (typeof overrides['drum-fills'] === 'boolean') df = overrides['drum-fills'];
    let wb = genre.walkingBass || false;
    if (typeof overrides['walking-bass'] === 'boolean') wb = overrides['walking-bass'];
    let polySteps = genre.polyrhythm || 0;
    if (typeof overrides.polyrhythm === 'number') polySteps = overrides.polyrhythm;
    let sync = genre.syncopation || 0;
    if (typeof overrides.syncopation === 'number') sync = overrides.syncopation;
    let cr = genre.callResponse || false;
    if (typeof overrides['call-response'] === 'boolean') cr = overrides['call-response'];
    let tc = genre.tensionCurve || false;
    if (typeof overrides['tension-curve'] === 'boolean') tc = overrides['tension-curve'];
    let mi = genre.modalInterchange || 0;
    if (typeof overrides['modal-interchange'] === 'number') mi = overrides['modal-interchange'];
    let gn = genre.ghostNotes || 0;
    if (typeof overrides['ghost-notes'] === 'number') gn = overrides['ghost-notes'];

    const proj = {
        name: generateTrackName(genre.name, rng),
        tempo: bpm,
        swing: genre.swing,
        humanize: genre.humanize,
        // Musical key: rootNote is a MIDI number; scaleName is the raw
        // function name (MajorScale / MinorScale / DorianScale / …) that
        // card renderers shorten to MAJ / MIN / DOR / etc.
        rootNote: genre.rootNote,
        scaleName: (genre.scale?.name || '').replace(/Scale$/, ''),
        nets: {},
        connections: [],
        initialMutes: [],
        structure: [],
    };

    // === Drums ===
    const dSeed = drumSeed(genreName);
    const kickParams = { channel: 10, velocity: 100, duration: 50, seed: dSeed, accent: AccentKick };
    proj.nets.kick = euclidean(genre.kick[0], genre.kick[1], genre.kick[2], genre.kick[3], kickParams).bundle;

    const snareParams = { channel: 11, velocity: 100, duration: 50, seed: dSeed + 1, accent: AccentSnare };
    proj.nets.snare = euclidean(genre.snare[0], genre.snare[1], genre.snare[2], genre.snare[3], snareParams).bundle;

    // Hihat
    let hihatHits = genre.hihat[0], hihatSteps = genre.hihat[1], hihatRotation = genre.hihat[2], hihatNote = genre.hihat[3];
    if (polySteps > 0) {
        hihatSteps = polySteps;
        hihatHits = Math.max(1, Math.floor(hihatHits * polySteps / genre.hihat[1]));
    }
    const hihatParams = { channel: 12, velocity: 100, duration: 50, seed: dSeed + 2, accent: AccentHihat };
    if (gn > 0) {
        proj.nets.hihat = ghostNoteHihat(hihatHits, hihatSteps, hihatRotation, hihatNote, hihatParams, gn).bundle;
    } else {
        proj.nets.hihat = euclidean(hihatHits, hihatSteps, hihatRotation, hihatNote, hihatParams).bundle;
    }

    // Chord progression
    let chordProg;
    if (genre.theory && genre.theory.chordProgs && genre.theory.chordProgs.length > 0) {
        chordProg = genre.theory.chordProgs[rng.nextInt(genre.theory.chordProgs.length)];
    } else {
        chordProg = MinorChordProg;
        const testScale = genre.scale(60);
        if (testScale.length >= 7 && testScale[2] - testScale[0] === 4) {
            chordProg = MajorChordProg;
        }
    }

    if (mi > 0) {
        const testScale = genre.scale(60);
        chordProg = applyModalInterchange(chordProg, testScale, mi, rng);
    }

    // Bass
    let bassScale = genre.scale(genre.rootNote);
    if (bassScale.length > Major.length) bassScale = bassScale.slice(0, Major.length);
    const bassParams = {
        scale: bassScale, rootNote: genre.rootNote,
        channel: genre.bassChannel, velocity: 90, duration: genre.bassDuration,
        density: genre.bassDensity, seed: rng.nextInt63(),
        chords: chordProg, durationVariation: genre.durationVariation,
        syncopation: sync,
    };
    if (wb) {
        proj.nets.bass = walkingBassLine(bassParams).bundle;
    } else {
        proj.nets.bass = markovMelody(bassParams).bundle;
    }

    // Melody
    const melodyRoot = genre.rootNote + 12;
    const melodyParams = {
        scale: genre.scale(melodyRoot), rootNote: melodyRoot,
        channel: genre.melodyChannel, velocity: 85, duration: genre.melodyDuration,
        density: genre.melodyDensity, seed: rng.nextInt63(),
        chords: chordProg, durationVariation: genre.durationVariation,
        syncopation: sync,
    };
    if (cr) {
        proj.nets.melody = callResponseMelody(melodyParams).bundle;
    } else {
        proj.nets.melody = markovMelody(melodyParams).bundle;
    }

    // Genre-specific extras
    if (genreName === 'edm' || genreName === 'synthwave' || genreName === 'trance') {
        if (genreName === 'edm') {
            const clapParams = { channel: 13, velocity: 100, duration: 50, seed: dSeed + 3, accent: AccentSnare };
            proj.nets.clap = euclidean(2, 16, 4, 39, clapParams).bundle;
        }
        let arpScale = genre.scale(genre.rootNote + 24);
        if (arpScale.length > 5) arpScale = arpScale.slice(0, 5);
        proj.nets.arp = euclideanMelodic(arpScale, 16, rng.nextInt63(), {
            channel: 5, velocity: 80, duration: 60,
        }).bundle;
    }

    // Assign instruments
    const sets = GenreInstrumentSets[genreName];
    if (sets) {
        const roleInstrument = {};
        for (const [role, instruments] of Object.entries(sets)) {
            roleInstrument[role] = instruments[rng.nextInt(instruments.length)];
        }
        for (const [netId, bundle] of Object.entries(proj.nets)) {
            const lookupKey = bundle.riffGroup || netId;
            const instruments = sets[lookupKey];
            if (instruments && instruments.length > 0) {
                bundle.track.instrumentSet = instruments;
                bundle.track.instrument = roleInstrument[lookupKey] || instruments[0];
            }
        }
    }

    // Override instruments
    if (overrides.instruments && typeof overrides.instruments === 'object') {
        for (const [netId, bundle] of Object.entries(proj.nets)) {
            const instName = overrides.instruments[netId] || (bundle.riffGroup && overrides.instruments[bundle.riffGroup]);
            if (instName && typeof instName === 'string') {
                bundle.track.instrument = instName;
            }
        }
    }

    // Chorus
    if (getBoolOverride(overrides, 'chorus')) {
        chorus(proj, genre, rng);
    }

    // Structure mode
    const structName = overrides.structure;
    if (typeof structName === 'string' && structName) {
        const tmpl = generateStructure(genreName, structName, rng);
        if (tmpl) {
            // Apply genre-specific phrase patterns
            if (genre.theory) {
                for (const sec of tmpl.sections) {
                    if (sec.phrases) {
                        for (const role of Object.keys(sec.phrases)) {
                            sec.phrases[role] = genrePhrases(genre.theory, sec.name);
                        }
                    }
                }
            }

            expandVariants(proj, tmpl, genre, rng, tc);

            // Drum fills
            if (df) {
                let pos = 0, fillIdx = 0;
                for (const sec of tmpl.sections) {
                    pos += sec.steps;
                    if (pos > 4) {
                        const fillLen = sec.steps >= 128 ? 8 : 4;
                        proj.nets[`fill-${fillIdx}`] = drumFillNet(pos, fillLen, rng);
                        fillIdx++;
                    }
                }
            }

            const musicNets = Object.keys(proj.nets);
            proj.initialMutes = songStructure(proj, tmpl, musicNets);
            addStingerTracks(proj, rng.nextInt63());
            return proj;
        }
    }

    // Loop mode: fade-in/out/break
    const melodicTargets = ['bass', 'melody'];
    if (proj.nets.arp) melodicTargets.push('arp');
    if (proj.nets.harmony) melodicTargets.push('harmony');

    if (getBoolOverride(overrides, 'fade-in')) {
        proj.initialMutes = fadeIn(proj, melodicTargets, 32, rng.nextInt63());
    }
    if (getBoolOverride(overrides, 'fade-out')) {
        fadeOut(proj, melodicTargets, 32, rng.nextInt63());
    }
    if (getBoolOverride(overrides, 'drum-break')) {
        const breakTargets = ['bass', 'melody'];
        if (proj.nets.harmony) breakTargets.push('harmony');
        drumBreak(proj, breakTargets, 64, 8, rng.nextInt63());
    }

    addStingerTracks(proj, rng.nextInt63());

    return proj;
}

// Stinger tracks — airhorn / laser / subdrop / booj as real tracks that
// fire on every beat (4 hits over 16 sixteenth-steps via euclidean). They
// start muted so new projects don't blast stingers on first play; the user
// unmutes via the mixer's mute checkbox or triggers manually via the Fire
// pad in the Stingers panel.
// Stinger track ids follow the reserved `hit` schema prefix so the project
// JSON can carry any number of stinger slots without their names colliding
// with standard track roles (kick/snare/…) or the instrument they happen to
// be loaded with. Defaults assign distinct stinger synths to each slot; the
// user can swap any slot to any instrument (or "hit" = no bound instrument)
// via the mixer row.
const STINGER_SPECS = [
    { id: 'hit1', channel: 20, defaultInstrument: 'airhorn' },
    { id: 'hit2', channel: 21, defaultInstrument: 'laser' },
    { id: 'hit3', channel: 22, defaultInstrument: 'subdrop' },
    { id: 'hit4', channel: 23, defaultInstrument: 'booj' },
];

// Curated non-percussion instruments suitable as stinger voices — the »
// rotate button on each stinger row cycles through this list. Excludes
// everything in the drum kit family; prioritises transient / stabby
// timbres that read as a "hit" rather than sustained melody.
const STINGER_INSTRUMENT_SET = [
    // Reserved — no bound instrument (silent slot, still fires paired macros)
    'unbound',
    // Custom stingers
    'airhorn', 'laser', 'subdrop', 'booj',
    // Bells / perc
    'fm-bell', 'am-bell', 'marimba', 'vibes', 'kalimba', 'steel-drum',
    'music-box', 'metallic', 'noise-hit',
    // Stabs / plucks
    'rave-stab', 'edm-stab', 'hoover', 'pluck', 'bright-pluck',
    'muted-pluck', 'edm-pluck', 'chiptune',
    // Bass hits
    '808-bass', 'sub-bass', 'drop-bass', 'fm-bass',
    // Short leads
    'square-lead', 'sync-lead', 'scream-lead',
];

export function addStingerTracks(proj, seed) {
    for (const spec of STINGER_SPECS) {
        if (proj.nets[spec.id]) continue;    // don't clobber manual additions
        const params = {
            channel: spec.channel, velocity: 95, duration: 80,
            seed, accent: AccentNone,
        };
        // 4 hits / 16 steps — token fires on the downbeat of every beat (quarter notes)
        const bundle = euclidean(4, 16, 0, 60, params).bundle;
        bundle.track = bundle.track || {};
        bundle.track.instrument = spec.defaultInstrument;
        bundle.track.instrumentSet = STINGER_INSTRUMENT_SET;
        proj.nets[spec.id] = bundle;
        if (!proj.initialMutes.includes(spec.id)) proj.initialMutes.push(spec.id);
    }
}

// Re-export for convenience
export { shuffleInstruments };
