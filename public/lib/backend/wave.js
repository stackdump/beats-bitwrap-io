// Engine glue: the djrust engine (public/djrust/, djwasm.wasm in an
// AudioWorklet) is the studio's only audio engine.
//
// The worklet is the clock and the sound source. The sequencer worker keeps
// composing (generate, shuffle, arrange, project-sync) but is never told to
// play; transport goes to the worklet instead, and the worklet's ticks are
// replayed into the normal handlers so the canvas, mixer and Stage
// visualizers read the marking the audio is being computed from.
//
// Not routed to the engine yet (rebuild items, docs/MIGRATION-djrust-wasm.md
// §12): macros, loop/seek, swing/humanize, live transpose, instrument change,
// per-channel mixer settings, master FX.
//
// The JS wave engine (public/wave-engine/) is no longer a runtime fallback; it
// stays in the repo as the parity oracle `make test-djrust` compares against.

import { audioHost } from '../../audio/host.js';
import { createDjrustEngine } from '../../djrust/node.js';
import { perfWaveLag } from '../perf/monitor.js';

/** Always true: every studio page plays through the djrust worklet. */
export function waveEngineRequested() { return true; }

function djrustWasmUrl() {
    try { return new URLSearchParams(location.search).get('djrust-wasm') || undefined; }
    catch { return undefined; }
}

function showEngineError(el, message) {
    if (el._engineErrorBanner || typeof document === 'undefined') return;
    const banner = document.createElement('div');
    banner.className = 'pn-audio-lock-banner pn-engine-error';
    banner.textContent = `Audio engine failed to load: ${message}`;
    el.appendChild?.(banner);
    el._engineErrorBanner = banner;
}

async function createEngine(el, ctx) {
    try {
        const dj = await createDjrustEngine(ctx, (node) => node.connect(audioHost.output),
            { wasmUrl: djrustWasmUrl() });
        el._engineName = 'djrust';
        el._djrustInfo = dj.info;
        el._djrustSource = dj.wasmSource;
        return dj;
    } catch (err) {
        el._djrustError = String((err && err.message) || err);
        console.error('djrust engine unavailable:', err);
        showEngineError(el, el._djrustError);
        throw err;
    }
}

function ensureWave(el) {
    if (el._wave) return el._wave;
    const p = (async () => {
        await el._ensureToneStarted?.();
        const ctx = audioHost.getContext();
        const wave = await createEngine(el, ctx);
        wave.onmessage = (msg) => onWaveMessage(el, msg);
        if (el._waveProject) wave.post({ type: 'load', project: el._waveProject });
        wave.post({ type: 'tempo', bpm: el._tempo || 120 });
        // The worker's mute state at this point is the loaded project's
        // (plus render-mode solo/mute and lock mutes); hand it over once.
        postMutes(wave, new Set([...(el._mutedNets || []), ...(el._manualMutedNets || [])]));
        return wave;
    })();
    el._wave = p;
    // A failed start may be retried on the next Play.
    p.catch(() => { if (el._wave === p) el._wave = null; });
    return p;
}

/**
 * routeToWave(el, msg) — called by sendWs. Returns true when the message
 * was consumed (must not reach the worker), false to forward it as usual.
 */
function postMutes(wave, ids) {
    for (const netId of ids) wave.post({ type: 'mute', netId, muted: true });
}

export function routeToWave(el, msg) {
    switch (msg.type) {
    case 'mute-group': {
        // The worker expands a riff group itself; the engine only takes
        // per-net mutes, so expand it the same way (sequencer-worker.js).
        if (!el._wave || !el._project?.nets) return false;
        const ids = Object.entries(el._project.nets)
            .filter(([, nb]) => nb.riffGroup === msg.riffGroup).map(([id]) => id);
        el._wave.then(w => {
            if (msg.muted) { for (const netId of ids) w.post({ type: 'mute', netId, muted: true }); }
            else if (ids.length) w.post({ type: 'mute', netId: ids[0], muted: false });
        }).catch(() => {});
        return false;
    }
    case 'transport':
        ensureWave(el).then(w => w.post(msg)).catch(err => console.warn('djrust engine:', err));
        return true; // the worker never plays
    case 'tempo':
    case 'mute':
        if (el._wave) el._wave.then(w => w.post(msg)).catch(() => {});
        return false;
    }
    return false;
}

/** Called on every project-sync from the worker. */
export function waveLoadProject(el, project) {
    el._waveProject = project;
    if (!el._wave) return;
    el._wave.then(w => {
        w.post({ type: 'load', project });
        // Lock mutes persist across regenerates (mixer "lock" checkbox).
        postMutes(w, el._manualMutedNets || []);
    }).catch(() => {});
}

function onWaveMessage(el, msg) {
    if (msg.type === 'error') {
        console.warn('djrust engine:', msg.message, msg.op ? `(${msg.op})` : '');
        return;
    }
    if (msg.type === 'playback-complete') {
        el._handleWsMessage?.({ type: 'playback-complete' });
        return;
    }
    if (msg.type !== 'wave-tick') return;
    if (typeof msg.t === 'number') {
        const ctx = audioHost.getContext();
        if (ctx) perfWaveLag(el, (ctx.currentTime - msg.t) * 1000);
    }
    for (const [netId, transitionId, control] of msg.controls) {
        el._handleWsMessage?.({ type: 'control-fired', netId, transitionId, control });
    }
    if (msg.mutedNets) el._handleWsMessage?.({ type: 'mute-state', mutedNets: msg.mutedNets, mutedNotes: {} });
    for (const [netId, transitionId, midi] of msg.fired) {
        el._handleWsMessage?.({ type: 'transition-fired', netId, transitionId, midi, tick: msg.tick, audioT: msg.t });
    }
    if (msg.state) el._handleWsMessage?.({ type: 'state-sync', state: msg.state, tick: msg.tick });
}
