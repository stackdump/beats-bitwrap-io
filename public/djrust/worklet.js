/**
 * worklet.js — AudioWorkletProcessor 'djrust-engine'.
 *
 * The djrust Rust engine (djwasm.wasm) runs here, on the audio thread, one WaveRunner per
 * processor. It speaks the same port protocol as wave-engine/worklet.js, so lib/backend/wave.js
 * drives either one:
 *
 *   page → worklet  {type:'wasm', bytes: ArrayBuffer}        (transferred; sent once, first)
 *                   {type:'load', project | json}            project object, or its JSON text
 *                   {type:'transport', action}               'play' | 'stop' | 'pause'
 *                   {type:'tempo', bpm}
 *                   {type:'mute', netId, muted}
 *   worklet → page  {type:'ready', info}  {type:'error', message}
 *                   {type:'wave-tick', tick, t, fired, controls, state?, mutedNets?}
 *                   {type:'playback-complete'}
 *
 * The module arrives one of two ways. processorOptions.module is a compiled WebAssembly.Module
 * (the page compiled it): instantiated synchronously in the constructor, so the engine is ready
 * before the first render quantum (what an OfflineAudioContext needs; processorOptions.project /
 * .play / .tempo then load and start it, as wave-engine/worklet.js's do). The {type:'wasm'}
 * message carries the bytes instead, for a browser that will not clone a Module into a worklet:
 * compiled here, asynchronously.
 *
 * Until the module is up the processor outputs silence and queues the messages that arrive
 * (load, transport, tempo, mute), then replays them in order.
 *
 * This file must not touch TextEncoder / TextDecoder, fetch, performance or anything else an
 * AudioWorkletGlobalScope lacks; scripts/test-djrust-wasm.mjs loads it in Node with those
 * globals deleted to hold that.
 */

import { instantiate, instantiateSync } from './loader.js';

const STATE_EVERY = 6; // ticks between marking posts, as in the sequencer worker

class DjrustProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const o = (options && options.processorOptions) || {};
        this.quiet = !!o.quiet; // no UI messages (benchmarks, offline)
        this.dj = null;
        this.queue = [];
        this.failed = false;
        this.port.onmessage = (e) => this.onMessage(e.data);
        this.initial = o;
        if (o.module) {
            try { this.up(instantiateSync(o.module)); } catch (err) { this.fail(err); }
        } else if (o.wasm) this.start(o.wasm);
    }

    start(bytes) {
        instantiate(bytes).then((dj) => this.up(dj)).catch((err) => this.fail(err));
    }

    up(dj) {
        dj.init(sampleRate);
        this.dj = dj;
        this.port.postMessage({ type: 'ready', info: dj.info() });
        const o = this.initial;
        if (o.project || o.json) this.apply({ type: 'load', project: o.project, json: o.json });
        if (o.tempo) this.apply({ type: 'tempo', bpm: o.tempo });
        if (o.play) this.apply({ type: 'transport', action: 'play' });
        const q = this.queue; this.queue = [];
        for (const m of q) this.apply(m);
    }

    fail(err) {
        this.failed = true;
        this.dj = null;
        this.port.postMessage({ type: 'error', message: String((err && err.message) || err) });
    }

    onMessage(msg) {
        if (msg.type === 'wasm') { this.start(msg.bytes); return; }
        if (this.failed) return;
        if (!this.dj) { this.queue.push(msg); return; }
        this.apply(msg);
    }

    apply(msg) {
        const dj = this.dj;
        try {
            switch (msg.type) {
            case 'load': dj.load(msg.json !== undefined ? msg.json : msg.project); break;
            case 'transport':
                if (msg.action === 'play') dj.play();
                else if (msg.action === 'pause') dj.pause();
                else dj.stop();
                break;
            case 'tempo': dj.setTempo(msg.bpm); break;
            case 'mute': dj.setMute(msg.netId, msg.muted); break;
            }
        } catch (err) {
            // A bad project must not take the audio thread down: say so and keep the old one.
            this.port.postMessage({ type: 'error', message: String((err && err.message) || err), op: msg.type });
        }
    }

    process(inputs, outputs) {
        const out = outputs[0];
        const dj = this.dj;
        if (!out || !out[0] || !dj) return true;
        let ticks;
        try {
            const n = out[0].length;
            ticks = dj.process(n);
            dj.copyOut(out[0], out[1] || null, n);
        } catch (err) {
            // A trap (a panic in the engine) leaves the instance unusable: go silent, say why.
            let why = String((err && err.message) || err);
            try { why += ' — ' + dj.panicMessage(); } catch { /* memory may be gone */ }
            this.fail(why);
            return true;
        }
        if (ticks > 0 && !this.quiet) this.report(dj);
        return true;
    }

    report(dj) {
        const rep = dj.report();
        if (!rep) return;
        // t: audio-thread time of this tick; the page compares it with its own context time to
        // measure how far the visuals trail.
        const msg = { type: 'wave-tick', tick: rep.tick, t: currentTime, fired: rep.fired, controls: rep.controls };
        if (rep.tick % STATE_EVERY === 0) msg.state = dj.marking();
        if (rep.controls.length) msg.mutedNets = dj.muted();
        this.port.postMessage(msg);
        if (dj.takeStopped()) this.port.postMessage({ type: 'playback-complete' });
    }
}

registerProcessor('djrust-engine', DjrustProcessor);
