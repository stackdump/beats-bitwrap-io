/**
 * regenerate.js — Rebuild a single track's Petri net from its stored recipe.
 * Dispatches on track.generator so any ring-based net can be resized.
 */

import { euclidean, euclideanMelodic } from './euclidean.js';
import { ghostNoteHihat, walkingBassLine, callResponseMelody } from './variety.js';
import { markovMelody } from './markov.js';

function clampInt(v, lo, hi) {
    v = Math.round(v);
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

/**
 * Regenerate a track given a previous NetBundle and pattern overrides.
 *
 * @param {NetBundle} prev - existing bundle with a populated track.generator
 * @param {{ ringSize: number, beats: number, rotation?: number, note?: number }} overrides
 * @returns {NetBundle} new bundle, with track assignment fields copied from prev
 */
export function regenerateTrack(prev, overrides) {
    const prevTrack = prev.track || {};
    const gen = prevTrack.generator;
    if (!gen) throw new Error('regenerateTrack: track has no generator recipe');

    const size = clampInt(overrides.ringSize, 2, 32);
    const hits = clampInt(overrides.beats, 2, size);
    const gp = prevTrack.generatorParams || {};
    const rotation = overrides.rotation ?? prevTrack.rotation ?? 0;
    const note = overrides.note ?? prevTrack.note;

    const channel = prevTrack.channel;
    const velocity = prevTrack.defaultVelocity;

    let result;
    switch (gen) {
        case 'euclidean':
            result = euclidean(hits, size, rotation, note, {
                channel,
                velocity,
                duration: gp.duration ?? 50,
                seed: gp.seed ?? 0,
                accent: gp.accent ?? 0,
            });
            break;

        case 'euclidean-ghost':
            result = ghostNoteHihat(hits, size, rotation, note, {
                channel,
                velocity,
                duration: gp.duration ?? 50,
                seed: gp.seed ?? 0,
                accent: gp.accent ?? 0,
            }, gp.ghostDensity ?? 0.5);
            break;

        case 'euclidean-melodic':
            result = euclideanMelodic(gp.scale || [60], size, gp.seed ?? 0, {
                channel,
                velocity,
                duration: gp.duration ?? 60,
            });
            break;

        case 'markov':
            result = markovMelody({
                scale: gp.scale,
                rootNote: gp.rootNote,
                chords: gp.chords,
                seed: gp.seed ?? 0,
                channel,
                velocity,
                duration: gp.duration ?? 100,
                density: hits / size,
                steps: size,
                durationVariation: gp.durationVariation ?? 0,
                syncopation: gp.syncopation ?? 0,
            });
            break;

        case 'walking-bass':
            result = walkingBassLine({
                scale: gp.scale,
                rootNote: gp.rootNote,
                chords: gp.chords,
                seed: gp.seed ?? 0,
                channel,
                velocity,
                duration: gp.duration ?? 100,
                density: hits / size,
                steps: size,
                durationVariation: gp.durationVariation ?? 0,
            });
            break;

        case 'call-response':
            result = callResponseMelody({
                scale: gp.scale,
                rootNote: gp.rootNote,
                chords: gp.chords,
                seed: gp.seed ?? 0,
                channel,
                velocity,
                duration: gp.duration ?? 100,
                density: hits / size,
                steps: size,
                durationVariation: gp.durationVariation ?? 0,
            });
            break;

        default:
            throw new Error(`regenerateTrack: unsupported generator "${gen}"`);
    }

    const nb = result.bundle;
    // Preserve assignment-level state (not recipe)
    nb.track.instrument = prevTrack.instrument || '';
    nb.track.instrumentSet = prevTrack.instrumentSet || [];
    if (prevTrack.mix) nb.track.mix = prevTrack.mix;
    nb.role = prev.role;
    nb.riffGroup = prev.riffGroup;
    nb.riffVariant = prev.riffVariant;

    return nb;
}
