// The studio's audio engine: djrust (github.com/stackdump/djrust, MIT), the pinned npm package
// in public/djrust/version.js, running in an AudioWorklet. lib/backend/djrust.js boots it and
// feeds it the project the sequencer Worker composed; this module is what the views and panels
// talk to: one AudioContext, the master volume, analysers, the output device, and the studio's
// controls (FX panel, macros, Beats pads, mixer strips) as djrust commands.
//
// Every control is kept here as well as sent, so djrust.js can replay it onto the worklet when
// the engine starts and after every project load (a new project starts from its own voices).
//
// Values are the studio's own slider units: the FX panel's 0–100 (master pitch −12…12), which
// djrust's master FX and aux (reverb / delay) bus take as they are.

// Every instrument the mixer offers (the share schema's `tracks.*.instrument`). djrust plays
// each: by name (its instrument table, ported from beats' presets) or by its family's voice.
export const INSTRUMENT_NAMES = [
    '808-bass', 'acid', 'acoustic-guitar', 'am-bell', 'am-pad', 'bass', 'big-saw', 'brass',
    'bright-pluck', 'chiptune', 'choir', 'clavinet', 'dark-pad', 'detuned-saw',
    'distorted-guitar', 'distorted-lead', 'drop-bass', 'drums', 'drums-808', 'drums-breakbeat',
    'drums-cr78', 'drums-lofi', 'drums-v8', 'duo-bass', 'duo-lead', 'edm-pluck', 'edm-stab',
    'electric-guitar', 'electric-piano', 'flute', 'fm-bass', 'fm-bell', 'glass-pad',
    'harpsichord', 'hoover', 'kalimba', 'laser', 'lead', 'marimba', 'metallic', 'music-box',
    'muted-pluck', 'noise-hit', 'organ', 'pad', 'piano', 'pluck', 'pwm-lead', 'rave-organ',
    'rave-stab', 'reese', 'rubber-bass', 'sax', 'scream-lead', 'screech', 'sine', 'sitar',
    'square-lead', 'steel-drum', 'strings', 'sub-bass', 'supersaw', 'sync-lead', 'talkbox',
    'tape-lead', 'trance-lead', 'trumpet', 'unbound', 'vibes', 'warm-pad', 'wobble-bass',
    'wobble-lead',
];

// GM-style drum bus: channels 10–15 carry the drum roles (kick / snare / hihat / clap…), each
// on its own mixer strip.
export function isDrumChannel(ch) {
    return ch >= 10 && ch <= 15;
}

// The FX panel's sliders: djrust's master FX keys and its aux bus keys.
export const MASTER_FX = ['hp-freq', 'lp-freq', 'phaser-freq', 'phaser-depth', 'phaser-wet',
    'crush-bits', 'distortion', 'master-pitch'];
export const AUX_FX = ['reverb-size', 'reverb-damp', 'reverb-wet', 'delay-time', 'delay-feedback',
    'delay-wet'];

// The beats macros djrust runs itself, on the deck's bar (the rest animate the studio's own
// sliders and tempo, which reach djrust as above).
export const NATIVE_MACRO_KINDS = new Set(['mute', 'beat-repeat', 'compound', 'pan-move', 'decay-move']);

const isMobile = () => typeof navigator !== 'undefined'
    && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || '');

class AudioEngine {
    constructor() {
        this.ctx = null;
        this.output = null;      // master GainNode: djrust's node → this → destination / sink
        this._sink = null;       // phones: MediaStream → hidden <audio> (keeps iOS playing locked)
        this._volumeDb = -12;
        this._analysers = new Map();
        this._post = null;       // set by djrust.js once the worklet is up
        // what is set now, replayed onto the worklet (djrust.js `replay`)
        this.fxValues = new Map();   // key → slider value, only the ones moved from djrust's own
        this.voices = new Map();     // channel → tweak object
        this.auxOn = false;          // the reverb / delay bus is in use (see fx())
    }

    // --- context -------------------------------------------------------------------------------

    /** The AudioContext, made on first use (a user gesture should be on the stack to resume it). */
    context() {
        if (this.ctx) return this.ctx;
        const latencyHint = isMobile() ? 'playback' : 'interactive';
        this.ctx = new AudioContext({ latencyHint });
        this.output = this.ctx.createGain();
        this.output.gain.value = this._muted ? 0 : Math.pow(10, this._volumeDb / 20);
        if (isMobile()) {
            const streamDest = this.ctx.createMediaStreamDestination();
            const audioEl = document.createElement('audio');
            audioEl.srcObject = streamDest.stream;
            audioEl.autoplay = true;
            audioEl.playsInline = true; // without it iOS Safari opens a fullscreen player
            audioEl.style.display = 'none';
            document.body.appendChild(audioEl);
            audioEl.play().catch(() => {});
            this.output.connect(streamDest);
            this._sink = { streamDest, audioEl };
        } else {
            this.output.connect(this.ctx.destination);
        }
        return this.ctx;
    }

    async init() {
        const ctx = this.context();
        if (ctx.state !== 'running') {
            try { await ctx.resume(); } catch {}
        }
    }

    resumeContext() {
        const ctx = this.context();
        if (ctx.state !== 'running') ctx.resume().catch(() => {});
        // phones: the <audio> sink pauses with the context when the OS suspends the tab
        if (this._sink?.audioEl?.paused) this._sink.audioEl.play().catch(() => {});
    }

    isContextRunning() {
        return !!this.ctx && this.ctx.state === 'running';
    }

    /** The audio clock, seconds. */
    now() {
        return this.ctx ? this.ctx.currentTime : 0;
    }

    // --- master --------------------------------------------------------------------------------

    setMasterVolume(db) {
        this._volumeDb = db;
        this._applyGain();
    }

    /** Heard or not (the Web Audio output mode); the engine keeps running either way. */
    setAudible(on) {
        this._muted = !on;
        this._applyGain();
    }

    _applyGain() {
        if (!this.output) return;
        const db = this._volumeDb;
        const g = this._muted || db <= -60 ? 0 : Math.pow(10, db / 20);
        this.output.gain.setTargetAtTime(g, this.ctx.currentTime, 0.01);
    }

    /** Master analyser with Tone.Analyser's getValue(): waveform (−1…1) or FFT (dB). */
    getMasterAnalyser(type = 'waveform', size = 1024) {
        if (!this.output) return null;
        const fft = type === 'fft';
        const key = `${fft ? 'fft' : 'waveform'}:${size}`;
        if (this._analysers.has(key)) return this._analysers.get(key);
        const node = this.ctx.createAnalyser();
        node.fftSize = Math.max(32, fft ? size * 2 : size);
        node.smoothingTimeConstant = fft ? 0.6 : 0;
        this.output.connect(node);
        const buf = new Float32Array(fft ? node.frequencyBinCount : node.fftSize);
        const a = {
            node,
            size,
            getValue() {
                if (fft) node.getFloatFrequencyData(buf);
                else node.getFloatTimeDomainData(buf);
                return buf;
            },
        };
        this._analysers.set(key, a);
        return a;
    }

    async listOutputDevices() {
        if (!navigator.mediaDevices?.enumerateDevices) return [];
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter(d => d.kind === 'audiooutput');
    }

    /** The master output device ('' = the system default), where the browser supports it. */
    async setOutputDevice(deviceId) {
        const ctx = this.context();
        if (typeof ctx.setSinkId === 'function') {
            await ctx.setSinkId(deviceId || '');
            return;
        }
        if (this._sink?.audioEl && typeof this._sink.audioEl.setSinkId === 'function') {
            await this._sink.audioEl.setSinkId(deviceId || '');
            return;
        }
        throw new Error('this browser cannot pick an audio output');
    }

    // --- controls → djrust ------------------------------------------------------------------------

    /** djrust.js: the worklet is up; send it what was set before it was. */
    attach(post) {
        this._post = post;
    }

    send(m) {
        this._post?.(m);
    }

    /**
     * An FX panel slider (`data-fx`): master volume here, the rest in djrust. The reverb / delay
     * bus is djrust's aux send/return, which a deck does not send to by default: the first
     * reverb or delay move turns deck A's send up, and from then on all six bus sliders hold.
     */
    fx(key, value) {
        if (key === 'master-vol') {
            this.setMasterVolume(value === 0 ? -60 : -60 + (value / 100) * 60);
            return;
        }
        if (!MASTER_FX.includes(key) && !AUX_FX.includes(key)) return;
        this.fxValues.set(key, value);
        if (AUX_FX.includes(key) && !this.auxOn) {
            this.auxOn = true;
            this.send({ t: 'aux', params: { strip: 'A', send: 1 } });
        }
        this.send(fxCommand(key, value));
    }

    /** The commands that put every FX slider moved so far back on a fresh engine. */
    fxCommands() {
        const out = [];
        if (this.auxOn) out.push({ t: 'aux', params: { strip: 'A', send: 1 } });
        for (const [k, v] of this.fxValues) out.push(fxCommand(k, v));
        return out;
    }

    /** FX Reset: djrust's own reset (bus and master FX back to beats' defaults). */
    fxReset() {
        this.fxValues.clear();
        this.send({ t: 'perform', action: { op: 'fxReset' } });
        this.send({ t: 'aux', params: { reset: true } });
    }

    /** A beats macro djrust runs itself, for `bars` (0: its own length). */
    fireMacro(id, bars = 0) {
        this.macrosSent = (this.macrosSent || 0) + 1;
        this.send({ t: 'macro', id, bars });
    }

    /** Stop what macros left sounding (Panic). */
    panic() {
        this.send({ t: 'perform', action: { op: 'panic' } });
    }

    /**
     * A mixer strip's voice on MIDI `channel`: `{gainDB, decayMul, lowpass, …}` (null: the
     * instrument's own). Kept, so a new project's voices get it too.
     */
    voice(channel, tweak) {
        const cur = { ...(this.voices.get(channel) || {}) };
        for (const [k, v] of Object.entries(tweak)) {
            if (v == null) delete cur[k]; else cur[k] = v;
        }
        if (Object.keys(cur).length) this.voices.set(channel, cur); else this.voices.delete(channel);
        this.send({ t: 'voice', channel, tweak });
    }

    voiceCommands() {
        return [...this.voices].map(([channel, tweak]) => ({ t: 'voice', channel, tweak }));
    }
}

function fxCommand(key, value) {
    return MASTER_FX.includes(key)
        ? { t: 'perform', action: { op: 'masterFx', key, value } }
        : { t: 'aux', params: { [key]: value } };
}

// Mixer sliders → voice tweaks, relative to each slider's default so an untouched mixer is
// djrust's own voices: volume (0–100, default 80) is 0.6 dB a step from the default (0 = the
// floor, −48 dB); decay (5–300, default 100 on a drum channel and 5 on the rest) scales the
// instrument's own decay by value / default; high cut is the voice's low-pass.
export const VOLUME_DEFAULT = 80;

export function volumeTweak(v) {
    if (v === VOLUME_DEFAULT) return { gainDB: null };
    return { gainDB: v <= 0 ? -48 : Math.max(-48, Math.min(24, (v - VOLUME_DEFAULT) * 0.6)) };
}

export function decayDefault(channel) {
    return isDrumChannel(channel) ? 100 : 5;
}

export function decayTweak(v, channel) {
    const def = decayDefault(channel);
    return { decayMul: v === def ? null : Math.max(0.05, Math.min(3, v / def)) };
}

export function cutoffTweak(hz) {
    return { lowpass: hz >= 19000 ? null : hz };
}

export const audioEngine = new AudioEngine();
