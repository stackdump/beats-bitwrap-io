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

    // Master FX settings from the project envelope. These values mirror
    // tone-engine.js defaults; envelope overrides win when present. The
    // perceptual gap between "dry triangles into destination" and
    // "triangles into a real master chain with reverb + delay + comp"
    // is huge — closing this is the single biggest fidelity win short
    // of full per-instrument port.
    const fx = el._project?.fx || {};
    const reverbWet  = pct(fx['reverb-wet'],   20) / 100;
    const reverbSize = pct(fx['reverb-size'],  50) / 100;
    const reverbDamp = mapDamp(fx['reverb-damp'], 30);
    const delayWet   = pct(fx['delay-wet'],    15) / 100;
    const delayTime  = mapDelayTime(fx['delay-time'], 25);
    const delayFb    = pct(fx['delay-feedback'], 25) / 100;
    const masterVol  = mapMasterVol(fx['master-vol'], 80);

    const wallStart = performance.now();
    const buffer = await Tone.Offline(({ transport }) => {
        // === Master FX chain (mirrors tone-engine.js init() topology) ===
        //   PolySynth(s) → channel volume → master comp → reverb send + delay send → destination
        // Stripped vs live: no phaser, no lp/hp filter, no distortion,
        // no bitcrusher, no pitch-shift, no per-channel filter / pan /
        // decay. Production fidelity needs full toneEngine refactor.
        const masterComp = new Tone.Compressor(-12, 3).toDestination();
        const masterVolume = new Tone.Volume(masterVol).connect(masterComp);
        const reverb = new Tone.Freeverb({
            roomSize: reverbSize,
            dampening: reverbDamp,
            wet: reverbWet,
        }).connect(masterVolume);
        const delay = new Tone.FeedbackDelay({
            delayTime,
            feedback: delayFb,
            wet: delayWet,
        }).connect(masterVolume);

        // Each unique channel gets a PolySynth → channel-volume node
        // → both master sends. Channel volume is unity for now (per-net
        // mixer settings live on el._project but the offline mvp doesn't
        // wire them yet).
        const synths = new Map();
        const ensureSynth = (channel) => {
            if (synths.has(channel)) return synths.get(channel);
            // -18 dB per-channel headroom: with N PolySynths summing into
            // the master, full-velocity hits across all channels sum to
            // a hot mix without per-channel attenuation. Real
            // tone-engine.js sets per-instrument gain (INSTRUMENT_GAIN
            // map); the offline mvp uses a flat fallback. Tracking
            // separately.
            const chanVol = new Tone.Volume(-18);
            chanVol.fan(masterVolume, reverb, delay);
            const s = new Tone.PolySynth(Tone.Synth, {
                oscillator: { type: 'triangle' },
                envelope: { attack: 0.01, decay: 0.2, sustain: 0.5, release: 0.4 },
            }).connect(chanVol);
            synths.set(channel, s);
            return s;
        };
        for (const ev of events) {
            const synth = ensureSynth(ev.channel);
            const t = ev.tick * (tickIntervalMs / 1000);
            const noteName = midiToNoteName(ev.midi);
            const dur = Math.max(0.05, (ev.durationMs || 100) / 1000);
            const vel = Math.max(0.1, Math.min(1, (ev.velocity || 90) / 127));
            try {
                synth.triggerAttackRelease(noteName, dur, t, vel);
            } catch {
                // Some synths reject overlapping notes on the same pitch;
                // skip rather than abort the whole render.
            }
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

// Slider value (0-100 by convention) → 0-100 with sane fallback.
function pct(v, def) {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
}

// FX damping slider 0-100 → frequency 500-8000 Hz (mirrors tone-engine.js
// dampening curve: low = darker tail, high = brighter tail).
function mapDamp(v, def) {
    const p = pct(v, def);
    return 500 + (p / 100) * 7500;
}

// Delay time slider 0-100 → seconds 0.05-1.0.
function mapDelayTime(v, def) {
    const p = pct(v, def);
    return 0.05 + (p / 100) * 0.95;
}

// Master volume slider 0-100 → dB -40..+6 (mirrors live curve).
function mapMasterVol(v, def) {
    const p = pct(v, def);
    return -40 + (p / 100) * 46;
}
