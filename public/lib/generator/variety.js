/**
 * variety.js — Port of Go variety.go
 * Riff variants, ghost note hihat, walking bass, call/response melody,
 * modal interchange, drum fills, and chorus harmony.
 */

import { bjorklund, ringLayout } from './euclidean.js';
import { accentVelocity, clampVelocity, createRng, MajorScale } from './core.js';
import {
    composeSequence, composeMelodyStep, computeVelocity, computeDuration,
    nearestChordTone, stepwise, markovMelody,
} from './markov.js';
import { NetBundle } from '../pflow.js';

// --- tensionForVariant ---

/**
 * Returns tension scaling for a riff variant letter.
 * @param {string} variant - "A", "B", or "C"
 * @returns {{ densityMul: number, velocityAdd: number, registerShift: number }}
 */
export function tensionForVariant(variant) {
    switch (variant) {
    case 'B':
        return { densityMul: 1.3, velocityAdd: 10, registerShift: 2 };
    case 'C':
        return { densityMul: 0.6, velocityAdd: -10, registerShift: -3 };
    default: // "A"
        return { densityMul: 1.0, velocityAdd: 0, registerShift: 0 };
    }
}

// --- ghostNoteHihat ---

/**
 * Generates a hihat ring with ghost notes filling gaps.
 * @param {number} hits
 * @param {number} steps
 * @param {number} rotation
 * @param {number} note - MIDI note
 * @param {object} params - { channel, velocity, duration, accent, seed }
 * @param {number} ghostDensity - 0.0-1.0 probability of ghost in gap
 * @returns {{ bundle: NetBundle, netId: string }}
 */
export function ghostNoteHihat(hits, steps, rotation, note, params, ghostDensity) {
    let pattern = bjorklund(hits, steps);

    // Apply rotation
    if (rotation !== 0) {
        let rot = rotation % steps;
        if (rot < 0) rot += steps;
        const rotated = new Array(steps);
        for (let i = 0; i < steps; i++) {
            rotated[i] = pattern[(i + rot) % steps];
        }
        pattern = rotated;
    }

    // Seeded RNG (simple LCG)
    let rngState = params.seed || 0;
    function rngFloat() {
        rngState = (rngState * 1664525 + 1013904223) & 0x7fffffff;
        return (rngState >>> 0) / 0x80000000;
    }
    function rngIntn(n) {
        return Math.floor(rngFloat() * n);
    }

    const bundle = new NetBundle();
    const { cx, cy, radius } = ringLayout(steps);

    for (let i = 0; i < steps; i++) {
        const initial = i === 0 ? 1 : 0;
        const angle = (i / steps) * 2 * Math.PI;
        const px = cx + radius * 0.7 * Math.cos(angle);
        const py = cy + radius * 0.7 * Math.sin(angle);
        const pLabel = `p${i}`;
        bundle.places[pLabel] = { initial: [initial], x: px, y: py };

        const tLabel = `t${i}`;
        const tAngle = ((i + 0.5) / steps) * 2 * Math.PI;
        const tx = cx + radius * Math.cos(tAngle);
        const ty = cy + radius * Math.sin(tAngle);
        bundle.transitions[tLabel] = { x: tx, y: ty };

        bundle.arcs.push(
            { source: pLabel, target: tLabel, weight: [1], inhibit: false },
            { source: tLabel, target: `p${(i + 1) % steps}`, weight: [1], inhibit: false },
        );

        if (pattern[i] === 1) {
            // Main hit with accent
            const vel = accentVelocity(i, steps, params.velocity, params.accent);
            bundle.bindings[tLabel] = {
                note,
                channel: params.channel,
                velocity: clampVelocity(vel),
                duration: params.duration,
            };
        } else if (rngFloat() < ghostDensity) {
            // Ghost note: very low velocity 30-50
            const ghostVel = 30 + rngIntn(20);
            bundle.bindings[tLabel] = {
                note,
                channel: params.channel,
                velocity: clampVelocity(ghostVel),
                duration: params.duration,
            };
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

    return { bundle, netId: 'hihat' };
}

// --- walkingBassLine ---

/**
 * Generates a walking bass line with chromatic approach notes between chord roots.
 * @param {object} params - Params object
 * @returns {{ bundle: NetBundle, netId: string }}
 */
export function walkingBassLine(params) {
    let notes = params.scale;
    if (!notes || notes.length === 0) {
        notes = MajorScale(params.rootNote);
    }

    let steps = params.steps;
    if (!steps || steps <= 0) steps = 16;

    // Seeded RNG
    let rngState = params.seed || 0;
    function rngFloat() {
        rngState = (rngState * 1664525 + 1013904223) & 0x7fffffff;
        return (rngState >>> 0) / 0x80000000;
    }
    function rngIntn(n) {
        return Math.floor(rngFloat() * n);
    }

    // Build chord root sequence in MIDI notes
    const chordRoots = new Array(steps);
    if (params.chords && params.chords.chords && params.chords.chords.length > 0) {
        let stepsPer = params.chords.stepsPer;
        if (!stepsPer || stepsPer <= 0) stepsPer = 4;
        for (let i = 0; i < steps; i++) {
            const chordIdx = Math.floor(i / stepsPer) % params.chords.chords.length;
            const rootDeg = params.chords.chords[chordIdx].root;
            if (rootDeg < notes.length) {
                chordRoots[i] = notes[rootDeg];
            } else {
                chordRoots[i] = params.rootNote;
            }
        }
    } else {
        for (let i = 0; i < steps; i++) {
            chordRoots[i] = params.rootNote;
        }
    }

    // Build walking bass sequence as MIDI note numbers
    const seq = new Array(steps);
    seq[0] = chordRoots[0];

    for (let i = 1; i < steps; i++) {
        const beatPos = i % 4;
        const currentNote = seq[i - 1];
        const targetRoot = chordRoots[i];

        if (beatPos === 0) {
            // Strong beat: land on chord root
            seq[i] = targetRoot;
        } else {
            // Find next strong beat target
            const nextStrongBeat = (Math.floor(i / 4) + 1) * 4;
            let nextTarget = targetRoot;
            if (nextStrongBeat < steps) {
                nextTarget = chordRoots[nextStrongBeat];
            }

            const diff = nextTarget - currentNote;
            if (diff === 0) {
                // On target — add neighbor tone
                if (rngFloat() < 0.5) {
                    seq[i] = currentNote + 1;
                } else {
                    seq[i] = currentNote - 1;
                }
            } else {
                const stepsLeft = 4 - beatPos;
                let stepSize = Math.trunc(diff / stepsLeft);
                if (stepSize === 0) {
                    stepSize = diff > 0 ? 1 : -1;
                }
                if (rngFloat() < 0.3) {
                    // Chromatic half-step approach
                    seq[i] = diff > 0 ? currentNote + 1 : currentNote - 1;
                } else {
                    seq[i] = currentNote + stepSize;
                }
            }
        }

        // Clamp to MIDI range
        if (seq[i] < 24) seq[i] = 24;
        if (seq[i] > 72) seq[i] = 72;
    }

    // Apply density-based rests
    let noteCount = Math.floor(params.density * steps);
    if (noteCount < 1) noteCount = 1;

    const restPositions = new Set();
    if (noteCount < steps) {
        let restsNeeded = steps - noteCount;
        for (let r = 0; r < restsNeeded; r++) {
            let bestIdx = -1;
            let bestScore = 1000;
            for (let j = 1; j < steps; j++) { // never rest on beat 0
                if (restPositions.has(j)) continue;
                let score = 100;
                switch (j % 4) {
                case 0: score = 100; break;
                case 2: score = 50; break;
                default: score = 0; break;
                }
                if (score < bestScore) {
                    bestScore = score;
                    bestIdx = j;
                }
            }
            if (bestIdx >= 0) {
                restPositions.add(bestIdx);
            }
        }
    }

    // Build the ring net
    const bundle = new NetBundle();
    const { cx, cy, radius } = ringLayout(steps);

    for (let i = 0; i < steps; i++) {
        const initial = i === 0 ? 1 : 0;
        const angle = (i / steps) * 2 * Math.PI;
        const px = cx + radius * 0.7 * Math.cos(angle);
        const py = cy + radius * 0.7 * Math.sin(angle);
        const pLabel = `p${i}`;
        bundle.places[pLabel] = { initial: [initial], x: px, y: py };

        const tLabel = `t${i}`;
        const tAngle = ((i + 0.5) / steps) * 2 * Math.PI;
        const tx = cx + radius * Math.cos(tAngle);
        const ty = cy + radius * Math.sin(tAngle);
        bundle.transitions[tLabel] = { x: tx, y: ty };

        bundle.arcs.push(
            { source: pLabel, target: tLabel, weight: [1], inhibit: false },
            { source: tLabel, target: `p${(i + 1) % steps}`, weight: [1], inhibit: false },
        );

        if (restPositions.has(i)) continue;

        let dur = params.duration;
        if (params.durationVariation > 0) {
            dur = Math.floor(dur * (0.8 + rngFloat() * 0.4 * params.durationVariation));
            if (dur < 20) dur = 20;
        }

        let vel = params.velocity;
        switch (i % 4) {
        case 0: vel += 15; break;
        case 2: vel += 5; break;
        default: vel -= 10; break;
        }

        bundle.bindings[tLabel] = {
            note: seq[i],
            channel: params.channel,
            velocity: clampVelocity(vel),
            duration: dur,
        };
    }

    bundle.track = {
        channel: params.channel,
        defaultVelocity: params.velocity,
        instrument: '',
        instrumentSet: [],
    };

    bundle.buildArcIndex();
    bundle.resetState();

    return { bundle, netId: 'bass' };
}

// --- callResponseMelody ---

/**
 * Generates a 32-step call/response melody ring.
 * @param {object} params - Params object
 * @returns {{ bundle: NetBundle, netId: string }}
 */
export function callResponseMelody(params) {
    let notes = params.scale;
    if (!notes || notes.length === 0) {
        notes = MajorScale(params.rootNote);
    }
    let n = notes.length;
    if (n > 12) {
        n = 12;
        notes = notes.slice(0, n);
    }

    // Seeded RNG
    let rngState = params.seed || 0;
    function rngFloat() {
        rngState = (rngState * 1664525 + 1013904223) & 0x7fffffff;
        return (rngState >>> 0) / 0x80000000;
    }
    const rng = { float64: rngFloat };

    // Build chord tone set
    const chordToneSet = new Set();
    if (params.chords) {
        for (const chord of (params.chords.chords || [])) {
            for (const t of (chord.tones || [])) {
                if (t < n) chordToneSet.add(t);
            }
        }
    }
    if (chordToneSet.size === 0) {
        for (const deg of [0, 2, 4]) {
            if (deg < n) chordToneSet.add(deg);
        }
    }

    // Generate call phrase (16 steps)
    const callSeq = composeSequence(16, n, chordToneSet, false, params.density, rng);

    // Generate response: same rhythm (rest positions), different notes resolving to tonic
    const responseSeq = new Array(16);
    let current = callSeq[0]; // start from same place
    for (let i = 0; i < 16; i++) {
        if (callSeq[i] < 0) {
            responseSeq[i] = -1; // preserve rest positions
            continue;
        }

        if (i >= 12) {
            // Last 4 steps: resolve toward root
            const dist = current;
            if (dist > 0) {
                current--;
            } else if (dist < 0) {
                current++;
            }
            responseSeq[i] = current;
        } else {
            // Mirror call rhythm but with different notes
            current = composeMelodyStep(current, i % 4, n, chordToneSet, rng);
            responseSeq[i] = current;
        }
    }
    // Final note is always root
    if (responseSeq[15] !== -1) {
        responseSeq[15] = 0;
    }

    // Combine into 32-step sequence
    const totalSteps = 32;
    const seq = new Array(totalSteps);
    for (let i = 0; i < 16; i++) seq[i] = callSeq[i];
    for (let i = 0; i < 16; i++) seq[16 + i] = responseSeq[i];

    // Build the ring net
    const bundle = new NetBundle();
    const { cx, cy, radius } = ringLayout(totalSteps);

    for (let i = 0; i < totalSteps; i++) {
        const initial = i === 0 ? 1 : 0;
        const angle = (i / totalSteps) * 2 * Math.PI;
        const px = cx + radius * 0.7 * Math.cos(angle);
        const py = cy + radius * 0.7 * Math.sin(angle);
        const pLabel = `p${i}`;
        bundle.places[pLabel] = { initial: [initial], x: px, y: py };

        const tLabel = `t${i}`;
        const tAngle = ((i + 0.5) / totalSteps) * 2 * Math.PI;
        const tx = cx + radius * Math.cos(tAngle);
        const ty = cy + radius * Math.sin(tAngle);
        bundle.transitions[tLabel] = { x: tx, y: ty };

        bundle.arcs.push(
            { source: pLabel, target: tLabel, weight: [1], inhibit: false },
            { source: tLabel, target: `p${(i + 1) % totalSteps}`, weight: [1], inhibit: false },
        );

        const deg = seq[i];
        if (deg < 0) continue;

        const vel = computeVelocity(i % 16, deg, params.velocity, chordToneSet);
        const dur = computeDuration(deg, params.duration, params.durationVariation, chordToneSet, rng);

        bundle.bindings[tLabel] = {
            note: notes[deg],
            channel: params.channel,
            velocity: clampVelocity(vel),
            duration: dur,
        };
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

// --- applyModalInterchange ---

/**
 * Probabilistically substitutes chords from the parallel key.
 * @param {object} chordProg - { chords: [{ root, tones }], stepsPer }
 * @param {number[]} scale - MIDI note array
 * @param {number} probability - 0.0-1.0
 * @param {{ float64: Function }} rng - RNG with float64() method
 * @returns {object} new ChordProg
 */
export function applyModalInterchange(chordProg, scale, probability, rng) {
    if (probability <= 0 || !chordProg) {
        return chordProg;
    }

    // Determine major/minor by checking the 3rd interval
    let isMajor = false;
    if (scale.length >= 3) {
        const interval = scale[2] - scale[0];
        if (interval === 4) { // major 3rd
            isMajor = true;
        }
    }

    const result = {
        chords: chordProg.chords.map(c => ({
            root: c.root,
            tones: c.tones.slice(),
        })),
        stepsPer: chordProg.stepsPer,
    };

    for (let i = 0; i < result.chords.length; i++) {
        if (i === 0) continue; // never borrow the tonic

        if (rng.float64() < probability) {
            const chord = result.chords[i];
            const newTones = chord.tones.slice();

            // Alter the 3rd of the chord (second tone) by +/-1 scale degree
            if (newTones.length >= 2) {
                if (isMajor) {
                    // Borrowing from minor: flatten the 3rd
                    if (newTones[1] > 0) {
                        newTones[1] = newTones[1] - 1;
                    }
                } else {
                    // Borrowing from major: raise the 3rd
                    newTones[1] = newTones[1] + 1;
                }
            }
            result.chords[i] = { root: chord.root, tones: newTones };
        }
    }

    return result;
}

// --- drumFillNet ---

/**
 * Creates a linear drum fill net with crescendo before a boundary.
 * @param {number} boundaryStep
 * @param {number} fillLength
 * @param {{ float64: Function }} rng
 * @returns {NetBundle} with role='control'
 */
export function drumFillNet(boundaryStep, fillLength, rng) {
    if (fillLength < 2) fillLength = 4;

    const fillNotes = [38, 45, 48, 43, 38, 48]; // snare, low tom, high tom, floor tom

    const totalSteps = boundaryStep < 1 ? 1 : boundaryStep;

    const bundle = new NetBundle();
    const { cx, cy, radius } = ringLayout(totalSteps + 1);

    // Linear chain: totalSteps+1 places, totalSteps transitions
    for (let i = 0; i <= totalSteps; i++) {
        const initial = i === 0 ? 1 : 0;
        const angle = (i / (totalSteps + 1)) * 2 * Math.PI;
        const x = cx + radius * 0.7 * Math.cos(angle);
        const y = cy + radius * 0.7 * Math.sin(angle);
        bundle.places[`p${i}`] = { initial: [initial], x, y };
    }

    for (let i = 0; i < totalSteps; i++) {
        const tLabel = `t${i}`;
        const angle = ((i + 0.5) / (totalSteps + 1)) * 2 * Math.PI;
        const tx = cx + radius * Math.cos(angle);
        const ty = cy + radius * Math.sin(angle);
        bundle.transitions[tLabel] = { x: tx, y: ty };

        // Linear: p[i] -> t[i] -> p[i+1]  (no wrap-around)
        bundle.arcs.push(
            { source: `p${i}`, target: tLabel, weight: [1], inhibit: false },
            { source: tLabel, target: `p${i + 1}`, weight: [1], inhibit: false },
        );

        // Fill in the last fillLength steps before boundary
        const fillStart = totalSteps - fillLength;
        if (i >= fillStart) {
            const fillPos = i - fillStart;
            // Crescendo velocity
            let vel = 60 + Math.floor(fillPos * 50 / fillLength);
            if (vel > 127) vel = 127;
            const noteVal = fillNotes[fillPos % fillNotes.length];
            bundle.bindings[tLabel] = {
                note: noteVal,
                channel: 10,
                velocity: clampVelocity(vel),
                duration: 40,
            };
        }
    }

    bundle.track = { channel: 10, defaultVelocity: 100, instrument: '', instrumentSet: [] };
    bundle.role = 'control';
    // controlBindings left empty as in Go source

    bundle.buildArcIndex();
    bundle.resetState();

    return bundle;
}

// --- chorus ---

/**
 * Adds a harmony net to proj — melody root + 12 + 7, channel 7, density * 0.8.
 * @param {object} proj - project with .nets map
 * @param {object} genre - { rootNote, scale(), melodyDuration, melodyDensity, name }
 * @param {{ float64: Function, int63: Function }} rng
 */
export function chorus(proj, genre, rng) {
    // Import markovMelody dynamically to avoid circular deps — it should be
    // available via the markov module. We import at top level instead.
    // Since we import from markov.js, we use markovMelody from there.
    const melodyRoot = genre.rootNote + 12 + 7; // one octave up + perfect 5th
    const harmonyParams = {
        scale: genre.scale(melodyRoot),
        rootNote: melodyRoot,
        channel: 7,
        velocity: 75,
        duration: genre.melodyDuration,
        density: genre.melodyDensity * 0.8,
        seed: rng.int63 ? rng.int63() : Math.floor(rng.float64() * 0x7fffffff),
        steps: 16,
        durationVariation: 0,
        syncopation: 0,
    };

    const harmony = markovMelody(harmonyParams);
    proj.nets['harmony'] = harmony.bundle;

    // Assign instrument set from genre if available
    if (genre.instrumentSets) {
        const sets = genre.instrumentSets;
        if (sets.melody && sets.melody.length > 0) {
            proj.nets['harmony'].track.instrumentSet = sets.melody;
            proj.nets['harmony'].track.instrument =
                sets.melody[Math.floor(rng.float64() * sets.melody.length)];
        }
    }
}

