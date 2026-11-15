// Offline render — faster-than-realtime audio, from the djrust engine.
//
// Companion to client-render.js. Same input (a loaded petri-note element)
// and the same result shape (a Blob in window.__renderBlob via
// render-mode.js), but the audio is computed into an OfflineAudioContext
// at full CPU speed instead of being recorded from a realtime context.
//
// The djrust worklet (public/djrust/) runs here exactly as it does live:
// the compiled wasm Module goes in through processorOptions, so the
// project is loaded and playing before the first render quantum. The
// engine is a pure function of the project, so this render is the bytes
// the live page computes (test-djrust-browser checks Chrome's offline
// render against Node's, byte for byte).
//
// This replaces the Tone.Offline renderer, which re-simulated the project
// in JS and scheduled Tone synths, macros and FX against Tone.Transport.
// What that path had and this one does not (rebuild items,
// docs/MIGRATION-djrust-wasm.md §12): master FX and envelope fx overrides,
// Auto-DJ, feel curves.
//
// What reaches the engine beside the project (offlineEngineOptions, R-16).
// Everything goes in processorOptions, applied before the first quantum:
//   mutes           render-mode solo/mute and the share's initialMutes as the
//                   worker reports them (el._mutedNets + el._manualMutedNets).
//   controlMacros   control nets' fire-macro actions run in the engine
//   macrosDisabled  (djwasm 0.3.0 NET_MACROS) — ONLY when the render opts in:
//                   opts.controlMacros, or ?render-macros=1 on the page. The
//                   disabled list is the page's (el._disabledMacros, which a
//                   share's macrosDisabled sets). Off by default: a macroCurve
//                   or hand-authored macro share would otherwise bake
//                   different audio than djwasm 0.2.0, and feed audio is
//                   frozen until Matt decides (studio plan decision 5).
//   flags/swing/    groove (FLAG.GROOVE) — ONLY on an explicit render option
//   humanize        or a session move: opts.groove, or el._grooveOverride when
//                   its source is 'session' (a slider move in this page). A
//                   share's own swing/humanize fields are NOT an override here,
//                   even off the genre default: lib/backend/wave.js
//                   setShareGroove records those (source 'share') for the live
//                   engine, and an offline bake ignores them, so the farm's
//                   ?render=offline bake of a share is djwasm 0.2.0's audio
//                   whatever its swing/humanize say (decision 1: two house
//                   feed envelopes sealed at 0/10 would otherwise re-groove).
// With no opt-in the processorOptions are {project, play, tempo, quiet,
// mutes?}: exactly the djwasm 0.2.0 call sequence, which
// scripts/test-djrust-render-freeze.mjs holds to scripts/djrust-golden.json
// for the whole feed corpus (the render-farm freeze).
//
// Encoding: uncompressed 16-bit stereo WAV (~10 MB per minute at 48 kHz).
// The server transcodes WAV → Opus/WebM via ffmpeg before the cached file
// lands, so the on-disk shape matches realtime renders.

import { createDjrustEngine } from '../../djrust/node.js';
import { FLAG } from '../../djrust/loader.js';

const PPQ = 4;
const SAMPLE_RATE = 48000;
const TAIL_SECONDS = 1.5;     // capture release tails past the last note
const LOOP_FALLBACK_TICKS = 1024;

export function isOfflineRenderMode() {
    try {
        return new URLSearchParams(location.search).get('render') === 'offline';
    } catch {
        return false;
    }
}

// The page's ?djrust-wasm=URL override (the browser test uses it to
// prove the fallback), or undefined.
export function wasmUrlFromPage() {
    try { return new URLSearchParams(location.search).get('djrust-wasm') || undefined; }
    catch { return undefined; }
}

// The page's ?render-macros=1 opt-in (control nets fire their macros in an
// offline render), or false. Absent on every farm URL today, so the farm's
// offline bakes stay on the 0.2.0 call sequence.
export function controlMacrosFromPage() {
    try {
        const v = new URLSearchParams(location.search).get('render-macros');
        return v === '1' || v === 'on' || v === 'true';
    } catch {
        return false;
    }
}

const clampPct = (v) => Math.max(0, Math.min(100, Number(v) || 0));

// What an offline render of `el` sends the engine beside the project and
// tempo: the processorOptions keys renderProjectOffline takes (see the
// header). Pure apart from reading `el` and the page URL.
//   opts.controlMacros  true/false overrides ?render-macros
//   opts.groove         {swing, humanize} | null overrides the session groove
export function offlineEngineOptions(el, opts = {}) {
    const out = {};
    const mutes = new Set([...(el._mutedNets || []), ...(el._manualMutedNets || [])]);
    if (mutes.size) out.mutes = [...mutes];
    const macros = opts.controlMacros !== undefined ? !!opts.controlMacros : controlMacrosFromPage();
    if (macros) {
        out.controlMacros = true;
        out.macrosDisabled = [...(el._disabledMacros || [])].map(String);
    }
    // A share-sourced override is the live engine's business, never a bake's.
    const session = el._grooveOverride && el._grooveOverride.source === 'session' ? el._grooveOverride : null;
    const g = opts.groove !== undefined ? opts.groove : session;
    if (g && typeof g === 'object' && (Number.isFinite(Number(g.swing)) || Number.isFinite(Number(g.humanize)))) {
        out.flags = FLAG.GROOVE;
        out.swing = clampPct(g.swing);
        out.humanize = clampPct(g.humanize);
    }
    return out;
}

// Render a project JSON object through the djrust worklet in an
// OfflineAudioContext. The project is loaded and playing before the
// first render quantum (the compiled Module goes in through
// processorOptions, and so does everything else), so the result is a pure
// function of (project, options, durationSec, sampleRate, module).
//   opts.durationSec     required; frames = ceil(durationSec × sampleRate)
//   opts.sampleRate      default 48000
//   opts.tempo           processorOptions.tempo (falsy = the project's)
//   opts.mutes           iterable of net ids muted before rendering starts
//   opts.controlMacros   control nets' fire-macro run in the engine (0.3.0)
//   opts.macrosDisabled  ids a control net may not fire (with controlMacros)
//   opts.flags           init flags (FLAG.GROOVE)
//   opts.swing, opts.humanize   0..100, groove (move notes only with FLAG.GROOVE)
//   opts.wasmUrl         module override (see node.js)
// A key left out is not sent, so a render with none of the 0.3.0 keys runs
// the djwasm 0.2.0 call sequence (load, mutes, tempo, play).
// Returns { buffer: AudioBuffer, wallMs } — wallMs times startRendering only.
export async function renderProjectOffline(project, opts = {}) {
    if (!project) throw new Error('no project');
    if (typeof OfflineAudioContext === 'undefined') {
        throw new Error('OfflineAudioContext unsupported');
    }
    const sampleRate = opts.sampleRate || SAMPLE_RATE;
    if (!(opts.durationSec > 0)) throw new Error('renderProjectOffline: durationSec must be > 0');

    const processorOptions = { project, play: true, tempo: opts.tempo, quiet: true };
    const mutes = [...new Set(opts.mutes || [])];
    if (mutes.length) processorOptions.mutes = mutes;
    if (opts.controlMacros) {
        processorOptions.controlMacros = true;
        processorOptions.macrosDisabled = [...(opts.macrosDisabled || [])].map(String);
    }
    if (opts.flags) processorOptions.flags = opts.flags | 0;
    if (opts.swing !== undefined || opts.humanize !== undefined) {
        processorOptions.swing = clampPct(opts.swing);
        processorOptions.humanize = clampPct(opts.humanize);
    }

    const ctx = new OfflineAudioContext(2, Math.ceil(opts.durationSec * sampleRate), sampleRate);
    const dj = await createDjrustEngine(ctx, null, { wasmUrl: opts.wasmUrl, processorOptions });

    const wallStart = performance.now();
    const buffer = await ctx.startRendering();
    const wallMs = performance.now() - wallStart;
    dj.dispose();
    return { buffer, wallMs };
}

// Render the currently-loaded project to an uncompressed WAV Blob.
//   opts.maxMs          cap the track part of the render (the tail is added)
//   opts.controlMacros  opts.groove   see offlineEngineOptions
//   opts.wasmUrl        module override (default: the page's ?djrust-wasm)
// Returns the same shape as client-render.js::renderToBlob plus timing:
//   { blob, mimeType, durationMs, totalSteps, offlineWallMs, speedupX, eventCount }
export async function renderToBlobOffline(el, opts = {}) {
    const project = el._lastProjectJSON || el._waveProject;
    if (!el._project || !project) throw new Error('no project loaded');
    if (typeof OfflineAudioContext === 'undefined') {
        throw new Error('OfflineAudioContext unsupported');
    }

    const totalSteps = el._totalSteps > 0 ? el._totalSteps : LOOP_FALLBACK_TICKS;
    const tempo = el._tempo || 120;
    const tickIntervalMs = 60_000 / (tempo * PPQ);
    let durationMs = totalSteps * tickIntervalMs;
    if (opts.maxMs > 0 && durationMs > opts.maxMs) durationMs = opts.maxMs;
    const durationSec = durationMs / 1000 + TAIL_SECONDS;

    const { buffer, wallMs: wallElapsedMs } = await renderProjectOffline(project, {
        durationSec,
        sampleRate: SAMPLE_RATE,
        tempo,
        ...offlineEngineOptions(el, opts),
        wasmUrl: opts.wasmUrl !== undefined ? opts.wasmUrl : wasmUrlFromPage(),
    });
    const speedup = (durationSec * 1000) / Math.max(1, wallElapsedMs);

    return {
        blob: audioBufferToWavBlob(buffer),
        mimeType: 'audio/wav',
        durationMs,
        totalSteps,
        offlineWallMs: Math.round(wallElapsedMs),
        speedupX: Math.round(speedup * 10) / 10,
        eventCount: 0, // the engine does not report fires in quiet mode
    };
}

export function audioBufferToWavBlob(audioBuffer) {
    const numChannels = Math.min(2, audioBuffer.numberOfChannels);
    const sampleRate = audioBuffer.sampleRate;
    const numFrames = audioBuffer.length;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = numFrames * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    // RIFF header
    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeAscii(view, 8, 'WAVE');
    // fmt chunk
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);              // chunk size
    view.setUint16(20, 1, true);               // PCM format
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bytesPerSample * 8, true);
    // data chunk
    writeAscii(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    // Interleave channel data, clamp + convert float → int16
    const channels = [];
    for (let c = 0; c < numChannels; c++) channels.push(audioBuffer.getChannelData(c));
    let off = 44;
    for (let i = 0; i < numFrames; i++) {
        for (let c = 0; c < numChannels; c++) {
            const s = Math.max(-1, Math.min(1, channels[c][i] || 0));
            view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
            off += 2;
        }
    }
    return new Blob([buffer], { type: 'audio/wav' });
}

function writeAscii(view, offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}
