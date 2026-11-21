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
 *     {type:'play', deck, on, atBar?}       Dj.set_playing; with atBar, on the next bar line of the deck that keeps the time
 *     {type:'param', deck, name, value}     Dj.set_param (volume, gain, filter, eqLow, eqMid, eqHigh, mute, reverbWet ...)
 *     {type:'crossfader', value}            Dj.set_crossfader
 *     {type:'perform', deck, json}          Dj.perform (any DeckAction JSON: masterFx, master, setKit, setRoleVoice ...)
 *     {type:'batch', msgs:[...]}           any of the above (not install / load_share), acted on in one quantum
 *     {type:'dispose'}
 *   worklet -> page
 *     {type:'ready', version}               the module is up
 *     {type:'grid', t, frame, decks:{A:{loaded,playing,beat,bpm,tick,bar,section}, B:{...}}}   about every 25 ms
 *     {type:'installed', id, deck, answer, kb, steps, quanta}     the track is in the engine
 *     {type:'install-failed', id, deck, error}
 *     {type:'warn', message}   a call the engine refused
 *     {type:'error', message}  the engine is gone (a trap): the output is silent from here
 *     {type:'perf', blocks, slow:[{t, ms, install, bars, render, tick, grid, did}]}   with processorOptions.perf only (test), every second
 */

import './engine-polyfill.js';
import * as glue from '../wasm/btw.js';

const QUANTUM = 128;
const CROSSFADER_CENTRE = 0.5; // both decks at full level, as on the desktop
const TICK_EVERY = 4; // quanta between Dj.tick() (the beat clock, landed composes, song ends): ~10.7 ms at 48 kHz; the cadence of render_offline
const GRID_SECONDS = 0.025; // how often the page hears where the decks are
const DEFAULT_BUDGET = 12 * 1024; // bytes of an install taken in per render quantum (a frame is never split: the biggest take 5-15 ms)

/** `BeatState::of_net`: ticks from the top of the net for a deck's `state()` (tick, and position = tick + phase while it plays). */
function ticksOf(s) {
    const tick = Number(s.tick) || 0;
    return tick === 0 ? 0 : Math.max(0, (Number(s.position) || tick) - 1);
}

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
        this.pending = []; // plays waiting for a bar line: {deck, on, leader, last, bar}
        this.phrased = []; // live ops waiting for a phrase line: {method, params, deck, ticks, last, block}
        this.perf = o.perf ? { slow: [], n: 0 } : null; // ?perf=1 (test only): blocks of 3 ms or more on Date.now(), with what they did
        this.port.onmessage = (e) => this.onMessage(e.data);
        if (o.module) {
            try { this.up(o.module); } catch (err) { this.fail(err); }
        }
    }

    up(moduleOrBytes) {
        glue.initSync({ module: moduleOrBytes });
        this.dj = new glue.Dj(sampleRate);
        // The engine starts with its crossfader at 0 (all deck A). The desktop centres it when its audio starts (djapp
        // audio_io.rs) and the offline render mixes both decks; without this every part on deck B was faded out here.
        // A program's own `crossfader` still moves it from the centre.
        this.dj.set_crossfader(CROSSFADER_CENTRE);
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
            case 'batch':
                // what one pass of the page sent (engine.js `send`): acted on together, in this quantum
                for (const m of msg.msgs) this.onMessage(m);
                break;
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
            case 'play': {
                // atBar: on the next bar line of the deck that keeps the time (another playing deck for a start, the deck itself for a stop)
                const other = msg.deck === 'A' ? 'B' : 'A';
                const leader = msg.atBar ? (msg.on ? other : msg.deck) : null;
                const pos = leader ? this.position(dj, leader) : null;
                if (pos === null) { dj.set_playing(msg.deck, !!msg.on); break; }
                this.pending = this.pending.filter((p) => p.deck !== msg.deck);
                this.pending.push({ deck: msg.deck, on: !!msg.on, leader, last: pos, bar: Math.floor(pos / 16) });
                break;
            }
            case 'live': {
                if (msg.reset) {
                    // the program stopped: every vocoder instance in use goes off, the extra ones away
                    this.phrased = [];
                    let inst = [];
                    try { inst = (JSON.parse(dj.vocoders()).instances || []).map((v) => v.instance); } catch { /* none */ }
                    for (const k of inst) dj.live_op('vocoder', JSON.stringify(k === 0 ? { instance: 0, on: false } : { instance: k, remove: true }));
                    break;
                }
                if (msg.phrase) {
                    // on the next phrase line of the deck (a move armed a phrase ahead), else at once
                    const ticks = 16 * (msg.phrase.bars || 8);
                    const pos = this.position(dj, msg.phrase.deck);
                    if (pos !== null) { this.phrased.push({ method: msg.method, params: msg.params, deck: msg.phrase.deck, ticks, last: pos, block: Math.floor(pos / ticks) }); break; }
                }
                dj.live_op(msg.method, msg.params);
                break;
            }
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

    /**
     * A deck's place in its net, in ticks (16 to the bar), or null when it does not play. As `Engine::beat_state` (BeatState::of_net)
     * reads it: the transport's tick counts the step being played from 1, so the place is (tick - 1) + how far into it; 0 before the first.
     */
    position(dj, deck) {
        try {
            const s = JSON.parse(dj.state(deck));
            return s.playing ? ticksOf(s) : null;
        } catch { return null; }
    }

    /** Apply the plays that were waiting for a bar line: the leader has crossed one (or wrapped to the top of a new net) since the last quantum. */
    bars(dj) {
        const keep = [];
        for (const p of this.pending) {
            const pos = this.position(dj, p.leader);
            const crossed = pos === null || pos < p.last || Math.floor(pos / 16) !== p.bar;
            if (crossed) dj.set_playing(p.deck, p.on);
            else { p.last = pos; keep.push(p); }
        }
        this.pending = keep;
    }

    /** Apply the live ops that were waiting for a phrase line of their deck. */
    phrases(dj) {
        const keep = [];
        for (const p of this.phrased) {
            const pos = this.position(dj, p.deck);
            const crossed = pos === null || pos < p.last || Math.floor(pos / p.ticks) !== p.block;
            if (crossed) {
                try { dj.live_op(p.method, p.params); } catch (err) { this.port.postMessage({ type: 'warn', message: `${p.method}: ${String((err && err.message) || err)}` }); }
            } else { p.last = pos; keep.push(p); }
        }
        this.phrased = keep;
    }

    /** One state of a deck as the grid wants it. */
    deckGrid(dj, deck) {
        let s;
        try { s = JSON.parse(dj.state(deck)); } catch { return null; }
        return {
            loaded: !!s.loaded,
            playing: !!s.playing,
            // 16 ticks to the bar, 4 beats to the bar: a tick is a quarter beat
            beat: ticksOf(s) / 4,
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
        const pf = this.perf;
        let t0 = 0, tI = 0, tB = 0, tR = 0, tT = 0, did = '';
        try {
            if (pf) t0 = Date.now();
            if (dj.installing()) {
                const r = dj.install_step(this.budget);
                for (const m of this.installing.values()) m.quanta++;
                if (r) { this.landed(JSON.parse(r)); if (pf) did += 'L'; }
                if (pf) did += 'I';
            }
            if (pf) tI = Date.now();
            if (this.pending.length) { this.bars(dj); if (pf) did += 'B'; }
            if (this.phrased.length) this.phrases(dj);
            if (pf) tB = Date.now();
            dj.render(out[0], out[1] || out[0]);
            if (pf) tR = Date.now();
            this.frames += n;
            this.quanta++;
            this.sinceGrid += n;
            if (this.quanta % TICK_EVERY === 0) { dj.tick(); if (pf) did += 'T'; }
            if (pf) tT = Date.now();
            if (this.sinceGrid >= GRID_SECONDS * sampleRate) {
                this.sinceGrid = 0;
                this.port.postMessage({ type: 'grid', t: currentTime, frame: this.frames, decks: { A: this.deckGrid(dj, 'A'), B: this.deckGrid(dj, 'B') } });
                if (pf) did += 'G';
            }
            if (pf) this.perfBlock(t0, tI, tB, tR, tT, did);
        } catch (err) {
            // a trap (a panic in the engine) leaves the instance unusable: go silent and say why
            this.fail(err);
        }
        return true;
    }

    /** ?perf=1: keep the slow blocks (3 ms or more by Date.now(), which has 1 ms steps) with where the time went, and report them every second. */
    perfBlock(t0, tI, tB, tR, tT, did) {
        const pf = this.perf;
        const end = Date.now();
        if (end - t0 >= 3) pf.slow.push({ t: currentTime, ms: end - t0, install: tI - t0, bars: tB - tI, render: tR - tB, tick: tT - tR, grid: end - tT, did });
        if (++pf.n >= sampleRate / QUANTUM) {
            this.port.postMessage({ type: 'perf', blocks: pf.n, slow: pf.slow });
            pf.n = 0;
            pf.slow = [];
        }
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
