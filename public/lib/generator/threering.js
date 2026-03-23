/**
 * threering.js — Two interlocking ring melody generator.
 * Port of petri-note/internal/generator/threering.go
 */

import { NetBundle } from '../pflow.js';
import { ringLayout } from './euclidean.js';
import { clampVelocity, createRng } from './core.js';
import {
    composeSequence,
    computeVelocity,
    computeDuration,
    applySyncopation,
} from './markov.js';

/**
 * threeRingMelody generates a melody net with 2 interlocking circular loops.
 * Ring A is the theme, Ring B is a transposed variation. At the midpoint of
 * each ring, a crossover transition lets the token jump to the other ring,
 * creating melodic phrases that alternate between theme and variation.
 *
 * @param {Object} params
 * @param {number[]} params.scale - MIDI note numbers in scale
 * @param {number} params.rootNote - Root MIDI note
 * @param {number} params.channel - MIDI channel
 * @param {number} params.velocity - Default velocity
 * @param {number} params.duration - Note duration ms
 * @param {number} params.density - 0.0-1.0
 * @param {number} params.seed - RNG seed
 * @param {number} [params.steps=8] - Steps per ring (forced even)
 * @param {Object} [params.chords] - { chords: [{ tones: [int] }] }
 * @param {number} [params.durationVariation] - 0.0-1.0
 * @param {number} [params.syncopation] - 0.0-1.0
 * @returns {{ bundle: NetBundle, netId: string }}
 */
export function threeRingMelody(params) {
    let notes = params.scale;
    if (!notes || notes.length === 0) {
        const major = [0, 2, 4, 5, 7, 9, 11];
        notes = [];
        for (let oct = 0; oct < 2; oct++) {
            for (const interval of major) {
                const n = params.rootNote + oct * 12 + interval;
                if (n <= 127) notes.push(n);
            }
        }
    }
    let n = notes.length;
    if (n > 12) {
        n = 12;
        notes = notes.slice(0, n);
    }

    const rng = createRng(params.seed);

    // Each ring has this many steps (keep even for beat alignment)
    let stepsPerRing = params.steps || 8;
    if (stepsPerRing <= 0) stepsPerRing = 8;
    if (stepsPerRing % 2 !== 0) stepsPerRing++; // force even

    // Build chord tone set
    const chordToneSet = new Set();
    if (params.chords && params.chords.chords) {
        for (const chord of params.chords.chords) {
            if (chord.tones) {
                for (const t of chord.tones) {
                    if (t < n) chordToneSet.add(t);
                }
            }
        }
    }
    if (chordToneSet.size === 0) {
        for (const deg of [0, 2, 4]) {
            if (deg < n) chordToneSet.add(deg);
        }
    }

    const isBass = params.rootNote < 48;

    // Compose base melody (Ring A = theme)
    const seqA = composeSequence(stepsPerRing, n, chordToneSet, isBass, params.density, rng);
    if (params.syncopation > 0) {
        applySyncopation(seqA, params.syncopation, rng);
    }

    // Ring B = transposition: shift up by a 3rd (2 scale degrees)
    const seqB = new Array(stepsPerRing);
    for (let i = 0; i < stepsPerRing; i++) {
        if (seqA[i] < 0) {
            seqB[i] = -1;
        } else {
            seqB[i] = (seqA[i] + 2) % n;
        }
    }

    const seqs = [seqA, seqB];
    const ringNames = ['a', 'b'];

    const bundle = new NetBundle();

    // Layout: 2 circles side by side
    let ringRadius = (stepsPerRing * 60.0) / (2 * Math.PI * 0.7);
    if (ringRadius < 120) ringRadius = 120;

    const spacing = ringRadius * 2.6;
    const ringCenters = [
        [ringRadius + 60, ringRadius + 60],                   // A: left
        [ringRadius + 60 + spacing, ringRadius + 60],         // B: right
    ];

    // Crossover at the midpoint of each ring
    const crossoverStep = Math.floor(stepsPerRing / 2);

    for (let ring = 0; ring < 2; ring++) {
        const cx = ringCenters[ring][0];
        const cy = ringCenters[ring][1];
        const prefix = ringNames[ring];
        const seq = seqs[ring];

        for (let i = 0; i < stepsPerRing; i++) {
            // Place
            const initial = (ring === 0 && i === 0) ? [1] : [0];
            const angle = (i / stepsPerRing) * 2 * Math.PI;
            const px = cx + ringRadius * 0.7 * Math.cos(angle);
            const py = cy + ringRadius * 0.7 * Math.sin(angle);
            const pLabel = `${prefix}_p${i}`;
            bundle.places[pLabel] = { initial, x: px, y: py };

            // Main transition (stays in this ring)
            const tLabel = `${prefix}_t${i}`;
            const tAngle = ((i + 0.5) / stepsPerRing) * 2 * Math.PI;
            const tx = cx + ringRadius * Math.cos(tAngle);
            const ty = cy + ringRadius * Math.sin(tAngle);
            bundle.transitions[tLabel] = { x: tx, y: ty };

            // Arcs: place -> transition -> next place
            bundle.arcs.push({ source: pLabel, target: tLabel, weight: [1], inhibit: false });
            const nextP = `${prefix}_p${(i + 1) % stepsPerRing}`;
            bundle.arcs.push({ source: tLabel, target: nextP, weight: [1], inhibit: false });

            // MIDI binding
            const deg = seq[i];
            if (deg >= 0) {
                const vel = computeVelocity(i, deg, params.velocity, chordToneSet);
                const dur = computeDuration(deg, params.duration, params.durationVariation || 0, chordToneSet, rng);
                bundle.bindings[tLabel] = {
                    note: notes[deg],
                    channel: params.channel,
                    velocity: clampVelocity(vel),
                    duration: dur,
                };
            }

            // At crossover step, add a transition that jumps to the other ring
            if (i === crossoverStep) {
                const otherRing = 1 - ring;
                const otherPrefix = ringNames[otherRing];

                // Crossover transition: positioned between the two ring centers
                const crossLabel = `x_${prefix}_${otherPrefix}`;
                const ocx = ringCenters[otherRing][0];
                const ocy = ringCenters[otherRing][1];
                const crossX = (cx + ocx) / 2;
                const crossY = (cy + ocy) / 2;
                bundle.transitions[crossLabel] = { x: crossX, y: crossY };

                // Arc: source place -> crossover transition -> other ring's entry
                bundle.arcs.push({ source: pLabel, target: crossLabel, weight: [1], inhibit: false });
                const entryP = `${otherPrefix}_p0`;
                bundle.arcs.push({ source: crossLabel, target: entryP, weight: [1], inhibit: false });

                // Crossover binding: play the destination ring's first note
                const crossDeg = seqs[otherRing][0];
                if (crossDeg >= 0) {
                    bundle.bindings[crossLabel] = {
                        note: notes[crossDeg],
                        channel: params.channel,
                        velocity: clampVelocity(params.velocity + 10),
                        duration: params.duration,
                    };
                }
            }
        }
    }

    bundle.track = {
        channel: params.channel,
        defaultVelocity: params.velocity,
        instrument: '',
        instrumentSet: [],
    };

    bundle.buildArcIndex();
    bundle.resetState();

    return { bundle, netId: 'melody' };
}
