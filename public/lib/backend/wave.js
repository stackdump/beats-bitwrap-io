// Wave engine glue (`?engine=wave`). The default engine is untouched: every
// function here is a no-op unless el._waveEngine is set.
//
// In wave mode the AudioWorklet in public/wave-engine/ is the clock and the
// sound source. The sequencer worker keeps composing (generate, shuffle,
// arrange, project-sync) but is never told to play; transport goes to the
// worklet instead, and the worklet's ticks are replayed into the normal
// handlers so the canvas, mixer and Stage visualizers read the marking the
// audio is being computed from. Not yet routed in wave mode: macros, loop,
// seek, swing/humanize, per-channel MIDI routing, Tone instrument choice.

import { toneEngine } from '../../audio/tone-engine.js';
import { createWaveEngine } from '../../wave-engine/node.js';

export function waveEngineRequested() {
    try { return new URLSearchParams(location.search).get('engine') === 'wave'; }
    catch { return false; }
}

/**
 * Give Tone a native AudioContext before any Tone node exists. Tone's
 * default context is a standardized-audio-context wrapper whose
 * audioWorklet.addModule re-wraps the module source as a classic script,
 * which breaks the ES `import`s in worklet.js. A native context is used by
 * Tone unchanged, so the whole studio graph shares it. Wave mode only.
 */
export function prepareWaveContext() {
    const T = window.Tone;
    if (!T || typeof AudioContext === 'undefined') return;
    try { T.setContext(new T.Context(new AudioContext({ latencyHint: 'interactive' }))); }
    catch (err) { console.warn('wave engine: could not install a native AudioContext', err); }
}

function ensureWave(el) {
    if (el._wave) return el._wave;
    el._wave = (async () => {
        await el._ensureToneStarted?.();
        const ctx = window.Tone.getContext().rawContext;
        const wave = await createWaveEngine(ctx, (node) => {
            // Into the master chain, so master volume, the master bus and
            // the recorder / render-farm tap all still apply.
            if (toneEngine._masterVolume) window.Tone.connect(node, toneEngine._masterVolume);
            else node.connect(ctx.destination);
        });
        wave.onmessage = (msg) => onWaveMessage(el, msg);
        if (el._waveProject) wave.post({ type: 'load', project: el._waveProject });
        wave.post({ type: 'tempo', bpm: el._tempo || 120 });
        return wave;
    })();
    return el._wave;
}

/**
 * routeToWave(el, msg) — called by sendWs. Returns true when the message
 * was consumed (must not reach the worker), false to forward it as usual.
 */
export function routeToWave(el, msg) {
    if (!el._waveEngine) return false;
    switch (msg.type) {
    case 'transport':
        ensureWave(el).then(w => w.post(msg)).catch(err => console.warn('wave engine:', err));
        return true; // the worker never plays in wave mode
    case 'tempo':
    case 'mute':
        if (el._wave) el._wave.then(w => w.post(msg));
        return false;
    }
    return false;
}

/** Called on every project-sync from the worker. */
export function waveLoadProject(el, project) {
    if (!el._waveEngine) return;
    el._waveProject = project;
    if (el._wave) el._wave.then(w => w.post({ type: 'load', project }));
}

function onWaveMessage(el, msg) {
    if (msg.type === 'playback-complete') {
        el._handleWsMessage?.({ type: 'playback-complete' });
        return;
    }
    if (msg.type !== 'wave-tick') return;
    for (const [netId, transitionId, control] of msg.controls) {
        el._handleWsMessage?.({ type: 'control-fired', netId, transitionId, control });
    }
    if (msg.mutedNets) el._handleWsMessage?.({ type: 'mute-state', mutedNets: msg.mutedNets, mutedNotes: {} });
    for (const [netId, transitionId, midi] of msg.fired) {
        // Visuals only — onRemoteTransitionFired skips Tone in wave mode.
        el._handleWsMessage?.({ type: 'transition-fired', netId, transitionId, midi });
    }
    if (msg.state) el._handleWsMessage?.({ type: 'state-sync', state: msg.state, tick: msg.tick });
}
