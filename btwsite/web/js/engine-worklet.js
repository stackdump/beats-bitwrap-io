/**
 * engine-worklet.js: AudioWorkletProcessor 'btw-engine'. The djrust engine (`Dj`, from the one btw wasm module) runs
 * here, on the audio thread. engine.js (main thread) drives it; this file is the audio thread's half.
 *
 * Rules of the scope: no TextEncoder / TextDecoder (engine-polyfill.js gives the glue its own, and is imported
 * first), no fetch, no performance, no crypto. The compiled WebAssembly.Module comes in processorOptions.module
 * (or, for a browser that will not clone a Module into a worklet, as {type:'wasm', bytes} on the port).
 *
 *   page -> worklet (port messages)
 *     {type:'install', id, deck, bytes}     DjComposer.prepare_share's bytes: Dj.begin_install; Dj.install_step takes it in
 *                                           a few KB per render quantum, so the audio never stops for a track.
 *                                           The track lands on the next bar when the deck plays, at once when it is stopped.
 *     {type:'load_share', id, deck, text}   the fallback with no composer: Dj.load_share compiles HERE, on the audio thread
 *                                           (the audio stops for the length of the compile)
 *     {type:'play', deck, on}               Dj.set_playing
 *     {type:'param', deck, name, value}     Dj.set_param (volume, gain, filter, eqLow, eqMid, eqHigh, mute, reverbWet ...)
 *     {type:'crossfader', value}            Dj.set_crossfader
 *     {type:'perform', deck, json}          Dj.perform (any DeckAction JSON: masterFx, master, setKit, setRoleVoice ...)
 *     {type:'dispose'}
 *   worklet -> page
 *     {type:'ready', version}               the module is up
 *     {type:'grid', t, frame, decks:{A:{loaded,playing,beat,bpm,tick,bar,section}, B:{...}}}   about every 25 ms
 *     {type:'installed', id, deck, answer, kb, steps, quanta}     the track is in the engine
 *     {type:'install-failed', id, deck, error}
 *     {type:'warn', message}   a call the engine refused
 *     {type:'error', message}  the engine is gone (a trap): the output is silent from here
 */

import './engine-polyfill.js';
import * as glue from '../wasm/btw.js';

const QUANTUM = 128;
const TICK_EVERY = 4; // quanta between Dj.tick() (the beat clock, landed composes, song ends): ~10.7 ms at 48 kHz; the cadence of render_offline
const GRID_SECONDS = 0.025; // how often the page hears where the decks are
const DEFAULT_BUDGET = 12 * 1024; // bytes of an install taken in per render quantum (a frame is never split: the biggest take 5-15 ms)

class BtwEngine extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const o = (options && options.processorOptions) || {};
        this.budget = o.installBudget | 0 || DEFAULT_BUDGET;
        this.dj = null;
        this.failed = false;
        this.queue = [];
        this.frames = 0;
        this.quanta = 0;
        this.sinceGrid = 0;
        this.installing = new Map(); // deck -> {id, quanta}
        this.port.onmessage = (e) => this.onMessage(e.data);
        if (o.module) {
            try { this.up(o.module); } catch (err) { this.fail(err); }
        }
    }

    up(moduleOrBytes) {
        glue.initSync({ module: moduleOrBytes });
        this.dj = new glue.Dj(sampleRate);
        this.port.postMessage({ type: 'ready', version: glue.engine_version() });
        const q = this.queue;
        this.queue = [];
        for (const m of q) this.onMessage(m);
    }

    fail(err) {
        this.failed = true;
        this.dj = null;
        this.port.postMessage({ type: 'error', message: String((err && err.message) || err) });
    }

    onMessage(msg) {
        if (msg.type === 'wasm') {
            try { this.up(msg.module || msg.bytes); } catch (err) { this.fail(err); }
            return;
        }
        if (msg.type === 'dispose') {
            try { if (this.dj) this.dj.free(); } catch { /* going away */ }
            this.dj = null;
            this.disposed = true;
            return;
        }
        if (this.failed) return;
        if (!this.dj) { this.queue.push(msg); return; }
        const dj = this.dj;
        try {
            switch (msg.type) {
            case 'install':
                this.installing.delete(msg.deck); // begin_install drops what the deck had pending
                try {
                    dj.begin_install(msg.deck, msg.bytes);
                    this.installing.set(msg.deck, { id: msg.id, quanta: 0 });
                } catch (err) {
                    this.port.postMessage({ type: 'install-failed', id: msg.id, deck: msg.deck, error: String((err && err.message) || err) });
                }
                break;
            case 'load_share':
                try {
                    const answer = dj.load_share(msg.deck, msg.text);
                    this.port.postMessage({ type: 'installed', id: msg.id, deck: msg.deck, answer, kb: 0, steps: 0, quanta: 0, inline: true });
                } catch (err) {
                    this.port.postMessage({ type: 'install-failed', id: msg.id, deck: msg.deck, error: String((err && err.message) || err) });
                }
                break;
            case 'play': dj.set_playing(msg.deck, !!msg.on); break;
            case 'param': dj.set_param(msg.deck, msg.name, Number(msg.value)); break;
            case 'crossfader': dj.set_crossfader(Number(msg.value)); break;
            case 'perform': {
                const r = dj.perform(msg.deck, msg.json);
                if (r !== 'done') this.port.postMessage({ type: 'warn', message: `${msg.json}: ${r}` });
                break;
            }
            }
        } catch (err) {
            this.port.postMessage({ type: 'warn', message: `${msg.type}: ${String((err && err.message) || err)}` });
        }
    }

    /** One state of a deck as the grid wants it. */
    deckGrid(dj, deck) {
        let s;
        try { s = JSON.parse(dj.state(deck)); } catch { return null; }
        return {
            loaded: !!s.loaded,
            playing: !!s.playing,
            // 16 ticks to the bar, 4 beats to the bar: a tick is a quarter beat; position has the phase in the tick
            beat: (Number(s.position) || 0) / 4,
            bpm: Number(s.tempo) || 0,
            tick: Number(s.tick) || 0,
            bar: Number(s.bar) || 0,
            section: s.section || null,
        };
    }

    process(inputs, outputs) {
        if (this.disposed) return false;
        const out = outputs[0];
        const dj = this.dj;
        if (!out || !out[0] || !dj) return true;
        const n = out[0].length;
        try {
            if (dj.installing()) {
                const r = dj.install_step(this.budget);
                for (const m of this.installing.values()) m.quanta++;
                if (r) this.landed(JSON.parse(r));
            }
            dj.render(out[0], out[1] || out[0]);
            this.frames += n;
            this.quanta++;
            this.sinceGrid += n;
            if (this.quanta % TICK_EVERY === 0) dj.tick();
            if (this.sinceGrid >= GRID_SECONDS * sampleRate) {
                this.sinceGrid = 0;
                this.port.postMessage({ type: 'grid', t: currentTime, frame: this.frames, decks: { A: this.deckGrid(dj, 'A'), B: this.deckGrid(dj, 'B') } });
            }
        } catch (err) {
            // a trap (a panic in the engine) leaves the instance unusable: go silent and say why
            this.fail(err);
        }
        return true;
    }

    landed(r) {
        if (r.offload || r.restore) return;
        const deck = r.deck;
        const pend = this.installing.get(deck);
        this.installing.delete(deck);
        const id = pend ? pend.id : undefined;
        if (r.error) this.port.postMessage({ type: 'install-failed', id, deck, error: r.error });
        else this.port.postMessage({ type: 'installed', id, deck, answer: r.answer, kb: r.kb, steps: r.steps, quanta: pend ? pend.quanta : 0 });
    }
}

registerProcessor('btw-engine', BtwEngine);
