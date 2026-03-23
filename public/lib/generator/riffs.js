/**
 * riffs.js — Drum and melody riff variant generators.
 * Port of petri-note/internal/generator/riffs.go
 */

import { euclidean } from './euclidean.js';
import { markovMelody } from './markov.js';
import { createRng } from './core.js';

/**
 * drumRiff generates a drum pattern variant.
 * variant "A" = base pattern, "B" = more energy, "C" = less energy.
 * Drums keep the same hits/rotation across all variants for musical consistency.
 * If style is non-null, it overrides the hardcoded A/B/C adjustments.
 *
 * @param {string} variant - "A", "B", or "C"
 * @param {number} hits - Number of hits (K in Euclidean)
 * @param {number} steps - Total steps (N in Euclidean)
 * @param {number} rotation - Pattern rotation
 * @param {number} note - MIDI note number
 * @param {Object} params - Generator params (channel, velocity, duration, accent, etc.)
 * @param {Object} [style] - DrumVariant { hitsAdd, hitsMul, rotationAdd }
 * @returns {import('../pflow.js').NetBundle}
 */
export function drumRiff(variant, hits, steps, rotation, note, params, style) {
    // Copy params so we don't mutate the caller's object
    params = Object.assign({}, params);

    if (style && variant !== 'A') {
        hits = hits + (style.hitsAdd || 0);
        if (style.hitsMul && style.hitsMul !== 1.0) {
            hits = Math.floor(hits * style.hitsMul);
        }
        rotation = (rotation + (style.rotationAdd || 0)) % steps;
        if (hits < 1) hits = 1;
        if (hits > steps) hits = steps;
    } else {
        // Same pattern, vary velocity/duration for feel
        switch (variant) {
        case 'B':
            params.velocity = Math.min(127, params.velocity + 15);
            params.duration = Math.floor(params.duration * 1.4);
            break;
        case 'C':
            params.velocity = Math.max(40, params.velocity - 20);
            params.duration = Math.floor(params.duration * 0.6);
            break;
        }
    }

    const result = euclidean(hits, steps, rotation, note, params);
    return result.bundle;
}

/**
 * melodyRiff generates a melody pattern variant.
 * variant "A" = base, "B" = higher density, "C" = sparse/longer notes.
 *
 * @param {string} variant - "A", "B", or "C"
 * @param {Object} params - Generator params (scale, rootNote, channel, velocity, duration, density, seed, steps, chords, durationVariation, syncopation)
 * @returns {import('../pflow.js').NetBundle}
 */
export function melodyRiff(variant, params) {
    // Copy params so we don't mutate the caller's object
    params = Object.assign({}, params);

    const rng = createRng(params.seed);

    switch (variant) {
    case 'B':
        // Higher density, slight seed variation
        params.density = params.density * 1.4;
        if (params.density > 1.0) params.density = 1.0;
        params.seed = params.seed + 1000 + Math.floor(rng.float64() * 1000);
        break;
    case 'C':
        // Sparse, longer notes
        params.density = params.density * 0.5;
        params.duration = Math.floor(params.duration * 1.5);
        params.seed = params.seed + 2000 + Math.floor(rng.float64() * 1000);
        break;
    }

    const result = markovMelody(params);
    return result.bundle;
}
