// audioHost: the studio's Web Audio host now that Tone.js is gone.
//
// The djrust engine (public/djrust/, djwasm.wasm in an AudioWorklet) makes
// every sample. This module only owns what a host has to own: the native
// AudioContext, the master gain the worklet connects to, the phone
// <audio> sink that keeps iOS playing through screen lock, output-device
// selection and a read-only analyser tap.
//
//   worklet ─► master (GainNode, master volume) ─► ctx.destination
//                                                └► MediaStream ─► <audio> (phones / chosen device)
//
// Everything Tone used to do beyond that (per-channel instruments, the
// master FX chain, per-channel filters/decay/pan, one-shot synths) is not
// on djrust yet. Those methods stay here as named no-ops so call sites keep
// working; each warns once. They are the rebuild list in
// docs/MIGRATION-djrust-wasm.md §12 — remove a stub when its feature lands
// in djwasm.

const isMobile = () => typeof navigator !== 'undefined'
    && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || '');

const warned = new Set();
function notYet(name) {
    if (warned.has(name)) return;
    warned.add(name);
    console.info(`[audio] ${name}: not available on the djrust engine yet (docs/MIGRATION-djrust-wasm.md §12)`);
}

class AudioHost {
    constructor() {
        this._ctx = null;
        this._master = null;      // GainNode: master volume; engines connect here
        this._masterSink = null;  // { streamDest, audioEl } on phones / a chosen device
        this._masterDb = -12;
        this._analysers = {};
        this._started = false;
        this._initPromise = null;
        this._micPermissionRequested = false;
    }

    /** The native AudioContext, created on first use (not started). */
    getContext() {
        if (this._ctx) return this._ctx;
        if (typeof AudioContext === 'undefined') return null;
        // 'playback' on phones: larger render quanta between deadlines,
        // which a generative player can afford.
        const latencyHint = isMobile() ? 'playback' : 'interactive';
        try { this._ctx = new AudioContext({ latencyHint }); }
        catch { this._ctx = new AudioContext(); }
        return this._ctx;
    }

    /** The node an engine connects its output to (the master gain). */
    get output() {
        this._buildGraph();
        return this._master;
    }

    _buildGraph() {
        if (this._master) return;
        const ctx = this.getContext();
        if (!ctx) return;
        this._master = ctx.createGain();
        this._master.gain.value = Math.pow(10, this._masterDb / 20);
        if (isMobile()) this._attachSink();
        else this._master.connect(ctx.destination);
    }

    // iOS Safari only keeps audio through screen lock when it comes out of
    // an <audio>/<video> element; Android treats the tab as media playback
    // too. Also the fallback for output-device selection.
    _attachSink() {
        const ctx = this._ctx;
        const streamDest = ctx.createMediaStreamDestination();
        const audioEl = document.createElement('audio');
        audioEl.srcObject = streamDest.stream;
        audioEl.autoplay = true;
        audioEl.playsInline = true;
        audioEl.style.display = 'none';
        document.body.appendChild(audioEl);
        audioEl.play().catch(() => {});
        try { this._master.disconnect(); } catch {}
        this._master.connect(streamDest);
        this._masterSink = { streamDest, audioEl };
    }

    _detachSink() {
        if (!this._masterSink) return;
        try { this._master.disconnect(); } catch {}
        this._masterSink.audioEl.srcObject = null;
        this._masterSink.audioEl.remove();
        this._masterSink = null;
        this._master.connect(this._ctx.destination);
    }

    async init() {
        if (this._started) return;
        if (this._initPromise) return this._initPromise;
        this._initPromise = (async () => {
            this._buildGraph();
            try { await this._ctx?.resume(); } catch {}
            this._started = true;
        })();
        return this._initPromise;
    }

    /** Call synchronously inside a user gesture (autoplay policy). */
    resumeContext() {
        const ctx = this.getContext();
        if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
        if (this._masterSink?.audioEl?.paused) this._masterSink.audioEl.play().catch(() => {});
    }

    isContextRunning() { return this._ctx?.state === 'running'; }

    now() { return this._ctx ? this._ctx.currentTime : 0; }

    setMasterVolume(db) {
        this._masterDb = Math.max(-60, Math.min(0, db));
        if (this._master) this._master.gain.value = Math.pow(10, this._masterDb / 20);
    }

    getMasterVolume() { return this._masterDb; }

    /**
     * Read-only analyser on the master. Returns { getValue(), node } with
     * Tone.Analyser's contract: 'fft' → dB per bin (size bins), 'waveform' →
     * time-domain samples.
     */
    getMasterAnalyser(type = 'waveform', size = 1024) {
        const key = type === 'fft' ? 'fft' : 'waveform';
        if (this._analysers[key]) return this._analysers[key];
        const out = this.output;
        if (!out) return null;
        const node = this._ctx.createAnalyser();
        node.fftSize = Math.max(32, key === 'fft' ? size * 2 : size);
        node.smoothingTimeConstant = key === 'fft' ? 0.4 : 0;
        out.connect(node);
        const buf = new Float32Array(key === 'fft' ? node.frequencyBinCount : node.fftSize);
        const a = {
            node,
            getValue() {
                if (key === 'fft') node.getFloatFrequencyData(buf);
                else node.getFloatTimeDomainData(buf);
                return buf;
            },
        };
        this._analysers[key] = a;
        return a;
    }

    async listOutputDevices() {
        if (!navigator.mediaDevices?.enumerateDevices) return [];
        let devices = await navigator.mediaDevices.enumerateDevices();
        let outputs = devices.filter(d => d.kind === 'audiooutput');
        // Chrome hides non-default outputs and labels until mic permission is granted.
        const needsPermission = !this._micPermissionRequested &&
            (outputs.length <= 1 || outputs.some(d => !d.label));
        if (needsPermission) {
            this._micPermissionRequested = true;
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                stream.getTracks().forEach(t => t.stop());
                devices = await navigator.mediaDevices.enumerateDevices();
                outputs = devices.filter(d => d.kind === 'audiooutput');
            } catch (err) {
                console.warn('Mic permission denied — output device list limited:', err);
            }
        }
        return outputs;
    }

    /** Route the whole master to an output device ('' = default). */
    async setOutputDevice(deviceId) {
        await this.init();
        const ctx = this._ctx;
        if (typeof ctx.setSinkId === 'function') {
            await ctx.setSinkId(deviceId || '');
            if (!isMobile()) this._detachSink();
            return;
        }
        if (typeof HTMLAudioElement.prototype.setSinkId !== 'function') {
            throw new Error('Neither AudioContext.setSinkId nor HTMLAudioElement.setSinkId is supported');
        }
        if (!deviceId) { if (!isMobile()) this._detachSink(); return; }
        if (!this._masterSink) this._attachSink();
        await this._masterSink.audioEl.setSinkId(deviceId);
    }

    /** Stop sounding notes. The engine owns its voices; nothing to do here. */
    panic() {}

    // --- Not on djrust yet (rebuild items; each is a named no-op) ---------

    // An instrument change is the engine's (djw_set_instrument, routed by
    // lib/backend/wave.js 'instrument-change'): there is nothing to load here.
    // On a module without it the dropdown is a label (lib/ui/engine-gaps.js).
    loadInstrument(_ch, _name) { return Promise.resolve(); }
    preloadInstrument() { return Promise.resolve(); }
    promotePooledInstrument() { return true; }
    clearPool() {}
    recycleVoices() {}
    getChannelInstrument() { return null; }
    controlChange(_ch, cc) { notYet(cc === 10 ? 'channel pan' : cc === 7 ? 'channel volume' : `CC ${cc}`); }
    setChannelDecay() { notYet('channel decay'); }
    setChannelCutoff() { notYet('channel filter'); }
    setChannelResonance() { notYet('channel filter'); }
    setChannelLoCut() { notYet('channel filter'); }
    setChannelLoResonance() { notYet('channel filter'); }
    hasDrumVoiceFilters() { return false; }
    setDrumVoiceCutoff() { notYet('drum-voice filter'); }
    setDrumVoiceResonance() { notYet('drum-voice filter'); }
    setDrumVoiceLoCut() { notYet('drum-voice filter'); }
    setDrumVoiceLoResonance() { notYet('drum-voice filter'); }
    async setChannelOutputDevice(_ch, deviceId) {
        if (deviceId) throw new Error('per-channel audio output is not available on the djrust engine yet');
    }
    playOneShot() { notYet('one-shot synths'); }
    playOneShotInstrument() { notYet('one-shot synths'); }
    playNote() {}
    setReverbSize() { notYet('master FX'); }
    setReverbDampening() { notYet('master FX'); }
    setReverbWet() { notYet('master FX'); }
    setDelayTime() { notYet('master FX'); }
    setDelayFeedback() { notYet('master FX'); }
    setDelayWet() { notYet('master FX'); }
    setDistortion() { notYet('master FX'); }
    setMasterPitch() { notYet('master FX'); }
    setHighpassFreq() { notYet('master FX'); }
    setLowpassFreq() { notYet('master FX'); }
    setPhaserFreq() { notYet('master FX'); }
    setPhaserDepth() { notYet('master FX'); }
    setPhaserWet() { notYet('master FX'); }
    setCrush() { notYet('master FX'); }
}

export const audioHost = new AudioHost();
