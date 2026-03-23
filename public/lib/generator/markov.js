/**
 * markov.js — Markov-chain melody generator for Petri net rings.
 * Port of petri-note/internal/generator/markov.go
 */

import { NetBundle } from '../pflow.js';
import { ringLayout } from './euclidean.js';
import { clampVelocity, createRng } from './core.js';

/**
 * composeSequence builds a slice of scale degree indices (or -1 for rests).
 */
export function composeSequence(steps, scaleLen, chordTones, isBass, density, rng) {
    const seq = new Array(steps);

    // Start on root
    let current = 0;
    seq[0] = current;

    for (let i = 1; i < steps; i++) {
        const beatPos = i % 4;

        if (isBass) {
            current = composeBassStep(current, beatPos, scaleLen, rng);
        } else {
            current = composeMelodyStep(current, beatPos, scaleLen, chordTones, rng);
        }
        seq[i] = current;
    }

    // Apply rests based on density
    let noteCount = Math.floor(density * steps);
    if (noteCount < 1) noteCount = 1;
    if (noteCount >= steps) return seq; // no rests needed

    const restsNeeded = steps - noteCount;

    // Score each step: strong beats get high scores (protected from rests)
    const candidates = [];
    for (let i = 0; i < steps; i++) {
        let s = 0;
        switch (i % 4) {
        case 0:
            s = 100; // strong beat — protect
            break;
        case 2:
            s = 50;  // medium beat
            break;
        default:
            s = 0;   // weak beat — rest candidate
            break;
        }
        // Protect beat 0 always
        if (i === 0) s = 200;
        candidates.push({ idx: i, score: s });
    }

    // Sort by score ascending (weakest first) — insertion sort for stability
    for (let i = 1; i < candidates.length; i++) {
        for (let j = i; j > 0 && candidates[j].score < candidates[j - 1].score; j--) {
            const tmp = candidates[j];
            candidates[j] = candidates[j - 1];
            candidates[j - 1] = tmp;
        }
    }

    // Apply rests to weakest positions
    for (let i = 0; i < restsNeeded && i < candidates.length; i++) {
        const idx = candidates[i].idx;
        if (idx === 0) continue; // never rest on beat 0
        seq[idx] = -1;
    }

    return seq;
}

/** composeMelodyStep picks the next scale degree based on beat strength. */
export function composeMelodyStep(current, beatPos, scaleLen, chordTones, rng) {
    switch (beatPos) {
    case 0: // strong beat: land on nearest chord tone
        return nearestChordTone(current, scaleLen, chordTones);
    case 2: // medium beat: 70% chord tone, 30% stepwise
        if (rng.float64() < 0.7) {
            return nearestChordTone(current, scaleLen, chordTones);
        }
        return stepwise(current, scaleLen, 1, rng);
    default: { // weak beat: stepwise motion
        const r = rng.float64();
        if (r < 0.60) {          // step of 1
            return stepwise(current, scaleLen, 1, rng);
        } else if (r < 0.85) {   // step of 2
            return stepwise(current, scaleLen, 2, rng);
        }
        return current;           // repeat
    }
    }
}

/** composeBassStep picks bass notes emphasizing root and fifth. */
function composeBassStep(current, beatPos, scaleLen, rng) {
    switch (beatPos) {
    case 0: // strong beat: root
        return 0;
    case 2: // medium beat: fifth (degree 4) or root
        if (scaleLen > 4 && rng.float64() < 0.6) {
            return 4;
        }
        return 0;
    default: // weak beat: stepwise from current or repeat
        if (rng.float64() < 0.5) {
            return current;
        }
        return stepwise(current, scaleLen, 1, rng);
    }
}

/** nearestChordTone finds the closest chord tone to the current degree. */
export function nearestChordTone(current, scaleLen, chordTones) {
    if (chordTones.has(current)) return current;
    for (let dist = 1; dist < scaleLen; dist++) {
        const up = current + dist;
        const down = current - dist;
        if (up < scaleLen && chordTones.has(up)) return up;
        if (down >= 0 && chordTones.has(down)) return down;
    }
    return 0; // fallback to root
}

/** stepwise moves current by the given interval up or down. */
export function stepwise(current, scaleLen, interval, rng) {
    if (rng.float64() < 0.5) {
        let next = current + interval;
        if (next >= scaleLen) next = current - interval;
        if (next < 0) next = 0;
        return next;
    }
    let next = current - interval;
    if (next < 0) next = current + interval;
    if (next >= scaleLen) next = scaleLen - 1;
    return next;
}

/** computeVelocity applies beat-based accents. */
export function computeVelocity(step, deg, baseVel, chordTones) {
    let vel = baseVel;
    switch (step % 4) {
    case 0:
        vel += 15; // beat 1 accent
        break;
    case 2:
        vel += 5;  // beat 3 accent
        break;
    default:
        vel -= 10; // weak beat
        break;
    }
    if (chordTones.has(deg)) vel += 5;
    return vel;
}

/** computeDuration adjusts note length: chord tones longer, passing tones shorter. */
export function computeDuration(deg, baseDur, variation, chordTones, rng) {
    if (variation <= 0) return baseDur;
    let dur = baseDur;
    if (chordTones.has(deg)) {
        dur = Math.floor(dur * (1.2 + rng.float64() * 0.8 * variation));
    } else {
        dur = Math.floor(dur * (0.3 + rng.float64() * 0.5 * variation));
    }
    if (dur < 20) dur = 20;
    return dur;
}

/** applySyncopation shifts some notes one step earlier (anticipation). */
export function applySyncopation(seq, probability, rng) {
    for (let i = 2; i < seq.length; i++) {
        // Only syncopate notes on strong or medium beats
        if (i % 2 !== 0) continue;
        // Skip if this step is a rest or preceding step has a note
        if (seq[i] < 0 || seq[i - 1] >= 0) continue;
        if (rng.float64() < probability) {
            // Move note one step earlier
            seq[i - 1] = seq[i];
            seq[i] = -1; // rest where the note was
        }
    }
}

/**
 * markovMelody generates a deterministic melody ring net.
 * Pre-composes a note sequence using chord-aware rules, then encodes it
 * as a ring where each step has exactly one transition.
 *
 * @param {Object} params
 * @param {number[]} params.scale - MIDI note numbers in scale
 * @param {number} params.rootNote - Root MIDI note
 * @param {number} params.channel - MIDI channel
 * @param {number} params.velocity - Default velocity
 * @param {number} params.duration - Note duration ms
 * @param {number} params.density - 0.0-1.0
 * @param {number} params.seed - RNG seed
 * @param {number} [params.steps=16] - Pattern length
 * @param {Object} [params.chords] - { chords: [{ tones: [int] }] }
 * @param {number} [params.durationVariation] - 0.0-1.0
 * @param {number} [params.syncopation] - 0.0-1.0
 * @returns {{ bundle: NetBundle, netId: string }}
 */
export function markovMelody(params) {
    let notes = params.scale;
    if (!notes || notes.length === 0) {
        // MajorScale fallback: 2 octaves of major scale from rootNote
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

    let steps = params.steps || 16;
    if (steps <= 0) steps = 16;

    const rng = createRng(params.seed);

    // Build chord tone set (scale degree indices)
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
    // If no chords provided, treat root, 3rd, 5th as chord tones
    if (chordToneSet.size === 0) {
        for (const deg of [0, 2, 4]) {
            if (deg < n) chordToneSet.add(deg);
        }
    }

    const isBass = params.rootNote < 48;

    // Pre-compose the note sequence as scale degree indices
    const seq = composeSequence(steps, n, chordToneSet, isBass, params.density, rng);

    // Apply syncopation: shift some notes one step earlier
    if (params.syncopation > 0) {
        applySyncopation(seq, params.syncopation, rng);
    }

    // Build the ring net
    const bundle = new NetBundle();
    const { cx, cy, radius } = ringLayout(steps);

    for (let i = 0; i < steps; i++) {
        // Place
        const initial = i === 0 ? [1] : [0];
        const angle = (i / steps) * 2 * Math.PI;
        const px = cx + radius * 0.7 * Math.cos(angle);
        const py = cy + radius * 0.7 * Math.sin(angle);
        const pLabel = `p${i}`;
        bundle.places[pLabel] = { initial, x: px, y: py };

        // Transition (offset by half-step so it sits between places)
        const tLabel = `t${i}`;
        const tAngle = ((i + 0.5) / steps) * 2 * Math.PI;
        const tx = cx + radius * Math.cos(tAngle);
        const ty = cy + radius * Math.sin(tAngle);
        bundle.transitions[tLabel] = { x: tx, y: ty };

        // Arcs: pi -> ti -> p(i+1 mod steps)
        bundle.arcs.push({ source: pLabel, target: tLabel, weight: [1], inhibit: false });
        const nextP = `p${(i + 1) % steps}`;
        bundle.arcs.push({ source: tLabel, target: nextP, weight: [1], inhibit: false });

        // MIDI binding: rest steps get no binding (silent transition)
        const deg = seq[i];
        if (deg < 0) continue; // rest

        const vel = computeVelocity(i, deg, params.velocity, chordToneSet);
        const dur = computeDuration(deg, params.duration, params.durationVariation || 0, chordToneSet, rng);

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
