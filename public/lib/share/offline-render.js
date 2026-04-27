// Offline render — faster-than-realtime audio rendering via Tone.Offline.
//
// Companion to client-render.js. Same input (a loaded petri-note element)
// and same output shape (a Blob in window.__renderBlob via render-mode.js),
// but the audio is synthesized into an OfflineAudioContext at maximum CPU
// speed instead of being recorded from a realtime AudioContext at 1×.
//
// On a fast machine this typically yields 5–15× realtime; on a slow one
// it's still bounded by single-core synthesis cost but with no realtime
// constraint, so you never get the "MediaRecorder dropped samples" failure
// mode that haunts the chromedp realtime path.
//
// MVP STATUS — proof-of-concept fidelity only:
//
// This module currently builds a SIMPLIFIED synth graph inside Tone.Offline:
// one Tone.PolySynth per channel (no per-instrument tone shaping, no master
// FX chain, no per-channel filters / decay / pan). It walks the project's
// nets via lib/pflow.js to collect note events, then schedules them via
// triggerAttackRelease at audio time. Result: the rhythmic + melodic
// content matches live, but the timbre and mix do NOT match the live
// chromedp render.
//
// Production-quality fidelity needs the full synth graph rebuilt against
// the offline context. Concretely, that means calling toneEngine's
// instrument-loading code inside the Tone.Offline callback so each
// channel's Sampler / FMSynth / MetalSynth / etc. lands on the offline
// context, then connecting the master FX chain (Reverb, Delay, Phaser,
// Compressor, master volume) the same way it's wired in real-time. This
// requires a refactor of tone-engine.js to make graph construction
// idempotent against an externally-supplied context. Tracked separately;
// the macro / sweep refactor (see lib/macros/sched.js) is the prerequisite
// that's already landed.
//
// Caveats / gaps to close before this replaces the realtime path:
//   - Per-instrument timbre (use loadInstrument inside the offline cb)
//   - Master FX chain (reverb / delay / phaser / compressor / master vol)
//   - Per-channel FX (filters, decay, pan)
//   - Macros + Auto-DJ (the audio scheduler is offline-safe now, but the
//     macro fire dispatcher still goes through el._fireMacro on the
//     element, which doesn't currently know to write into the offline
//     graph)
//   - Drift / swing / humanize — driven by the worker; PoC's tick
//     simulator skips these.
//   - Per-genre instrument override / shuffle state.
//
// Encoding: outputs uncompressed 16-bit stereo WAV (~10 MB per minute at
// 48 kHz). Production should transcode to Opus on the server, or wire an
// Opus encoder library client-side. WAV keeps the MVP dependency-free.

import { parseProject } from '../pflow.js';
import { ToneEngine } from '../../audio/tone-engine.js';
import { hpFreq, lpFreq } from '../ui/mixer-sliders.js';

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

// Render the currently-loaded project to an uncompressed WAV Blob via
// Tone.Offline. Returns the same shape as client-render.js::renderToBlob:
//   { blob, mimeType, durationMs, totalSteps }
//
// Throws on missing project, missing Tone, or missing OfflineAudioContext
// support (very old browsers).
export async function renderToBlobOffline(el, opts = {}) {
    const Tone = window.Tone;
    if (!Tone) throw new Error('Tone.js not loaded');
    if (!el._project) throw new Error('no project loaded');
    if (typeof OfflineAudioContext === 'undefined') {
        throw new Error('OfflineAudioContext unsupported');
    }

    const totalSteps = el._totalSteps > 0 ? el._totalSteps : LOOP_FALLBACK_TICKS;
    const tempo = el._tempo || 120;
    const tickIntervalMs = 60_000 / (tempo * PPQ);
    let durationMs = totalSteps * tickIntervalMs;
    if (opts.maxMs > 0 && durationMs > opts.maxMs) durationMs = opts.maxMs;
    const durationSec = durationMs / 1000 + TAIL_SECONDS;

    // Pre-compute every note event the project will fire over `totalSteps`
    // ticks. Walks pflow.NetBundle forward deterministically — same engine
    // the worker uses, just driven by a for-loop instead of setInterval.
    const events = simulateProjectNotes(el._project, totalSteps);

    // Build the per-channel instrument map from the project's nets so
    // we know which Sampler / FMSynth / MetalSynth / etc. to load for
    // each channel inside the Tone.Offline callback. Net.track.channel
    // → instrument name. Drum channels (10, 20, 21, 22, 23) get the
    // 'drums' kit. Channels with no track are skipped.
    const channelInstruments = collectChannelInstruments(el._project);
    // Per-track FX settings from the envelope feed straight into the
    // engine via the same setters the live UI uses.
    const fx = el._project?.fx || {};

    const wallStart = performance.now();
    const buffer = await Tone.Offline(async ({ transport }) => {
        // Spin up a fresh ToneEngine inside the Tone.Offline callback.
        // Tone.context is the OfflineAudioContext for the duration of
        // this callback, so any new Tone.X() (including the synths
        // ToneEngine creates internally) lands on the offline graph.
        // _offline=true skips the mobile audio-element path and
        // Tone.start() — both meaningless in an offline context.
        const engine = new ToneEngine();
        engine._offline = true;
        await engine.init();

        // Apply project-level FX values BEFORE any notes fire so the
        // recorded tail reflects them. Mirrors how the live UI applies
        // overrides on project-load.
        applyFxToEngine(engine, fx);

        // Load each channel's instrument. loadInstrument is async
        // (samplers fetch SoundFont files); await the whole batch
        // before scheduling notes so sample buffers are warm.
        await Promise.all(
            [...channelInstruments].map(([ch, inst]) => engine.loadInstrument(ch, inst))
        );

        // Schedule every note via engine.playNote(midi, playAt). The
        // second argument is an absolute audio-clock time; inside
        // Tone.Offline this corresponds to offline-context time, so
        // each note lands at the right beat in the rendered buffer.
        for (const ev of events) {
            const t = ev.tick * (tickIntervalMs / 1000);
            engine.playNote({
                channel: ev.channel,
                note: ev.midi,
                velocity: ev.velocity,
                duration: ev.durationMs,
            }, t);
        }
        transport.start();
    }, durationSec, 2, SAMPLE_RATE);
    const wallElapsedMs = performance.now() - wallStart;
    const speedup = (durationSec * 1000) / Math.max(1, wallElapsedMs);

    const blob = audioBufferToWavBlob(buffer);
    return {
        blob,
        mimeType: 'audio/wav',
        durationMs,
        totalSteps,
        offlineWallMs: Math.round(wallElapsedMs),
        speedupX: Math.round(speedup * 10) / 10,
        eventCount: events.length,
    };
}

// --- Project simulation ---------------------------------------------------
//
// Walk every music net forward `totalSteps` ticks, firing enabled
// transitions and recording any MIDI events. This is a stripped-down
// subset of sequencer-worker.js — only enough to populate the offline
// render's event list. Misses: drift, swing, humanize, conflict
// resolution beyond first-enabled, control-net actions (mute/unmute),
// macros, fire-macro injection. Sufficient for a vibes-check render.

function simulateProjectNotes(projectMap, totalSteps) {
    const proj = parseProject(projectMap);
    const events = [];
    const musicNets = [];
    for (const [id, nb] of Object.entries(proj.nets)) {
        if (nb.role === 'control') continue;
        nb.resetState();
        musicNets.push([id, nb]);
    }
    for (let tick = 0; tick < totalSteps; tick++) {
        for (const [id, nb] of musicNets) {
            const enabled = [];
            for (const tLabel of Object.keys(nb.transitions || {})) {
                if (nb.isEnabled(tLabel)) enabled.push(tLabel);
            }
            if (enabled.length === 0) continue;
            // Naive: fire the first enabled. Worker does deterministic
            // pseudo-random selection seeded by tick — close enough for PoC.
            const tLabel = enabled[0];
            const result = nb.fire(tLabel);
            const binding = result?.midi;
            if (binding && typeof binding.note === 'number') {
                events.push({
                    tick,
                    channel: binding.channel ?? nb.track?.channel ?? 0,
                    midi: binding.note,
                    velocity: binding.velocity ?? nb.track?.defaultVelocity ?? 90,
                    durationMs: binding.duration ?? 100,   // binding.duration is ms
                });
            }
        }
    }
    return events;
}

// --- WAV encoding ---------------------------------------------------------
//
// 16-bit linear PCM WAV. Trivially decodeable by any audio tool, no
// dependencies. Stereo interleaved. Supports any sample rate the
// AudioBuffer carries.

function audioBufferToWavBlob(audioBuffer) {
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

// MIDI note number → scientific pitch notation. Tone.PolySynth accepts
// note names like "C4", "F#5". Falls back to "A4" (440Hz) on weird input.
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function midiToNoteName(midi) {
    if (!Number.isFinite(midi) || midi < 0 || midi > 127) return 'A4';
    const octave = Math.floor(midi / 12) - 1;
    const name = NOTE_NAMES[midi % 12];
    return `${name}${octave}`;
}

// Walk every music net and build channel → instrument-name map.
// Falls back to 'piano' / 'drums' for missing instruments so a half-
// authored project still renders something audible.
function collectChannelInstruments(projectMap) {
    const out = new Map();
    const nets = projectMap?.nets || {};
    for (const net of Object.values(nets)) {
        if (net.role === 'control') continue;
        const ch = net.track?.channel;
        if (ch == null) continue;
        if (out.has(ch)) continue; // first net wins per channel
        const inst = net.track?.instrument;
        if (inst) {
            out.set(ch, inst);
        } else {
            // Drum channels (10, 20-23 in this codebase) get 'drums'.
            out.set(ch, isDrumCh(ch) ? 'drums' : 'piano');
        }
    }
    return out;
}

function isDrumCh(ch) { return ch === 10 || (ch >= 20 && ch <= 23); }

// Apply project envelope's `fx` overrides to the engine. Mirrors the
// switch in lib/ui/build.js applyFx() — same scaling, same setters,
// same default values when a key is missing. Only applied keys touch
// the engine, so unspecified values keep tone-engine.js init() defaults.
function applyFxToEngine(engine, fx) {
    if (!fx) return;
    const v = (key) => {
        const n = Number(fx[key]);
        return Number.isFinite(n) ? n : null;
    };
    let n;
    if ((n = v('reverb-size'))    !== null) engine.setReverbSize(n / 100);
    if ((n = v('reverb-damp'))    !== null) engine.setReverbDampening(10000 - (n / 100) * 9800);
    if ((n = v('reverb-wet'))     !== null) engine.setReverbWet(n / 100);
    if ((n = v('delay-time'))     !== null) engine.setDelayTime(n / 100);
    if ((n = v('delay-feedback')) !== null) engine.setDelayFeedback(n / 100);
    if ((n = v('delay-wet'))      !== null) engine.setDelayWet(n / 100);
    if ((n = v('master-vol'))     !== null) engine.setMasterVolume(n === 0 ? -60 : -60 + (n / 100) * 60);
    if ((n = v('distortion'))     !== null) engine.setDistortion(n / 100);
    if ((n = v('master-pitch'))   !== null) engine.setMasterPitch(n);
    if ((n = v('hp-freq'))        !== null) engine.setHighpassFreq(hpFreq(n));
    if ((n = v('lp-freq'))        !== null) engine.setLowpassFreq(lpFreq(n));
    if ((n = v('phaser-freq'))    !== null) engine.setPhaserFreq(n === 0 ? 0 : 0.1 + (n / 100) * 9.9);
    if ((n = v('phaser-depth'))   !== null) engine.setPhaserDepth(n / 100);
    if ((n = v('phaser-wet'))     !== null) engine.setPhaserWet(n / 100);
    if ((n = v('crush-bits'))     !== null) engine.setCrush(n / 100);
}
