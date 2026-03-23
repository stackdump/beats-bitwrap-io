/**
 * shuffle.js — Random instrument assignment for project nets.
 * Port of petri-note/internal/generator/shuffle.go
 */

import { createRng } from './core.js';

/**
 * shuffleInstruments picks a random instrument from each net's instrumentSet.
 * Returns a map of netId -> chosen instrument name.
 *
 * @param {Object} proj - Parsed project with proj.nets[netId].track.instrumentSet
 * @param {number} seed - RNG seed (0 or falsy uses Date.now())
 * @returns {Object.<string, string>} Map of netId -> chosen instrument name
 */
export function shuffleInstruments(proj, seed) {
    if (!seed) seed = Date.now();
    const rng = createRng(seed);

    const result = {};
    for (const [netId, bundle] of Object.entries(proj.nets)) {
        const instrumentSet = bundle.track && bundle.track.instrumentSet;
        if (!instrumentSet || instrumentSet.length === 0) continue;

        const chosen = instrumentSet[Math.floor(rng.float64() * instrumentSet.length)];
        bundle.track.instrument = chosen;
        result[netId] = chosen;
    }
    return result;
}
