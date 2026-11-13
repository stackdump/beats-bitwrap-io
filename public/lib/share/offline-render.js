// Offline render (?render=offline): the loaded project rendered by djrust with no AudioContext
// (djrust-offline.js), faster than realtime and deterministic for one engine version: the same
// project and engine version always give the same samples. Output is a 48 kHz / 16-bit stereo
// WAV. What it renders is the project djrust plays (its nets, instruments and tempo); the
// studio's live FX moves, mixer voices and Auto-DJ are a live session's and are not in it
// (?render=1 records the live engine instead).

import { renderOffline, encodeWav } from './djrust-offline.js';

const PPQ = 4;                     // mirrors sequencer-worker.js
const TAIL_SECONDS = 1.5;          // reverb / release tail past the last tick
const LOOP_FALLBACK_TICKS = 1024;  // ~64 bars @ PPQ 4 — same as render-mode.js
const SAMPLE_RATE = 48000;

export function isOfflineRenderMode() {
    try {
        return new URLSearchParams(location.search).get('render') === 'offline';
    } catch {
        return false;
    }
}

/** The project text djrust plays for the studio (as lib/backend/djrust.js loads it). */
export function studioProjectText(el) {
    const genre = el.querySelector?.('.pn-genre-select')?.value || el._currentGen?.genre;
    const seed = el._currentGen?.params?.seed;
    const tempo = el._tempo || el._project.tempo;
    return JSON.stringify({ ...el._project, ...(tempo ? { tempo } : {}), genre,
        ...(Number.isFinite(seed) ? { seed } : {}) });
}

// Render the loaded project to a WAV Blob. Same shape as client-render.js::renderToBlob, plus
// timing: { blob, mimeType, durationMs, totalSteps, offlineWallMs, speedupX, engineVersion }.
export async function renderToBlobOffline(el, opts = {}) {
    if (!el._project) throw new Error('no project loaded');
    const totalSteps = el._totalSteps > 0 ? el._totalSteps : LOOP_FALLBACK_TICKS;
    const tempo = el._tempo || 120;
    const tickIntervalMs = 60_000 / (tempo * PPQ);
    let durationMs = totalSteps * tickIntervalMs;
    if (opts.maxMs > 0 && durationMs > opts.maxMs) durationMs = opts.maxMs;
    const seconds = durationMs / 1000 + TAIL_SECONDS;

    const t0 = performance.now();
    const { samples, version } = await renderOffline(studioProjectText(el), seconds, SAMPLE_RATE);
    const offlineWallMs = Math.round(performance.now() - t0);
    const blob = encodeWav(samples, SAMPLE_RATE);
    return {
        blob, mimeType: blob.type, durationMs, totalSteps,
        offlineWallMs,
        speedupX: +(seconds * 1000 / Math.max(1, offlineWallMs)).toFixed(2),
        eventCount: 0,
        engineVersion: version,
    };
}
