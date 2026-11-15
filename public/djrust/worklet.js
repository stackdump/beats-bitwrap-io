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
 *   worklet → page  {type:'ready', info, features, flags}  {type:'error', message}
 *                   {type:'wave-tick', tick, t, fired, controls, state?, mutedNets?,
 *                    macroMask?, tempo?, frame?}
 *                   {type:'playback-complete'}
 *
 * Studio messages (djwasm 0.3.0 and later). On a module without the export they do nothing,
 * and a fire answers result -3 (ERR_UNSUPPORTED) so the page runs the macro itself:
 *
 *   page → worklet  {type:'fire-macro', id, duration?}       duration in the macro's unit, -1 default
 *                   {type:'release-macro', id}
 *                   {type:'panic'}
 *                   {type:'control-macros', on?, disabled?: [ids]}   disabled replaces the list
 *                   {type:'seek', tick}                       then a state tick at once
 *                   {type:'groove', swing, humanize}          kept for later loads too
 *   worklet → page  {type:'macro-fired', id, source: 'page'|'control', result, frame?, tick?}
 *                   {type:'macro-skipped', id, source, result, frame, tick}   (disabled list)
 *                   {type:'macro-restored', id, source, result, frame, tick}  (effect ended)
 *                   {type:'engine-tempo', bpm, frame, tick}   (the engine moved the tempo)
 *                   {type:'macro-overflow', dropped}          (the engine's ring filled)
 *                   {type:'macro-released', id, result}       (only when result is not 0)
 *                   {type:'seeked', tick, requested}
 *
 * A control net's fire comes back as `macro-fired` with source 'control'. Result -3 there means
 * the page must run it (a master or aux macro in 0.3: sweep-lp, riser, ping-pong …); result 0
 * means the engine ran it, so the page must not fire it again. Every fire is reported exactly
 * once. On the wave-tick, macroMask and frame are sent whenever the module has them, tempo
 * only when it changed since the last tick posted, and mutedNets also while a macro is in
 * effect or when the mask changed.
 *
 * Any page message may carry `at` (an engine frame, djw_frame; the processor's own count of
 * rendered frames on a module without the clock) or `q` (a render quantum, counted from the
 * first quantum the engine rendered). It is then applied before the first block that starts
 * at or after that point, in stamp order, so a scripted action lands on the same sample in
 * every renderer. Unstamped messages apply between blocks, as they arrive.
 *
 * The module arrives one of two ways. processorOptions.module is a compiled WebAssembly.Module
 * (the page compiled it): instantiated synchronously in the constructor, so the engine is ready
 * before the first render quantum (what an OfflineAudioContext needs). The {type:'wasm'}
 * message carries the bytes instead, for a browser that will not clone a Module into a worklet:
 * compiled here, asynchronously.
 *
 * processorOptions, applied before the first quantum in this order: flags (init flags;
 * 1 = GROOVE), project | json, mutes [netIds], tempo, controlMacros + macrosDisabled [ids],
 * swing / humanize (they move notes only on a GROOVE instance), play; quiet (no UI messages).
 * Test hooks:
 *   script: [{q, msg}]   messages applied before quantum q (as if stamped `q`)
 *   tap: true            post the rendered blocks, {type:'tap', offset, data}: interleaved f32
 *                        L,R, transferred, tapBlocks (default 64) quanta per message
 *   tapHash: true        keep a running sha256 of those bytes instead; {type:'tap-digest'}
 *                        asks for it ({type:'tap-digest', sha, frames, quanta}), and with
 *                        tapFrames: N it is posted as {type:'tap-done', …} at N frames
 *   assertQuantum: 128   refuse any other render quantum (an error, then silence)
 *
 * Until the module is up the processor outputs silence and queues the messages that arrive,
 * then replays them in order.
 *
 * This file must not touch TextEncoder / TextDecoder, fetch, performance, crypto or anything
 * else an AudioWorkletGlobalScope lacks; scripts/test-djrust-wasm.mjs loads it in Node with
 * those globals deleted to hold that.
 */

import { instantiate, instantiateSync, ERR_ARG, ERR_NOT_READY, FEATURE } from './loader.js';

const STATE_EVERY = 6; // ticks between marking posts, as in the sequencer worker
const QUANTUM = 128;
const EVENT_TYPE = { fired: 'macro-fired', skipped: 'macro-skipped', restored: 'macro-restored', tempo: 'engine-tempo' };

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
        this.quantum = 0;   // quanta the engine has rendered
        this.frames = 0;    // frames the engine has rendered
        this.stamped = [];  // [{key, msg}] waiting for their block, in key order
        this.disabled = new Set();
        this.lastMask = 0;
        this.lastTempo = NaN;
        this.assertQuantum = o.assertQuantum | 0;
        this.tap = o.tapHash ? { hash: new Sha256(), frames: 0, quanta: {}, limit: o.tapFrames | 0, done: false }
            : o.tap ? { chunk: (o.tapBlocks || 64) * QUANTUM, buf: null, fill: 0, offset: 0 } : null;
        if (Array.isArray(o.script)) for (const st of o.script) this.stamp({ ...st.msg, q: st.q });
        if (o.module) {
            try { this.up(instantiateSync(o.module)); } catch (err) { this.fail(err); }
        } else if (o.wasm) this.start(o.wasm);
    }

    start(bytes) {
        instantiate(bytes).then((dj) => this.up(dj)).catch((err) => this.fail(err));
    }

    up(dj) {
        const o = this.initial;
        dj.initWith(sampleRate, o.flags | 0);
        this.dj = dj;
        this.port.postMessage({ type: 'ready', info: dj.info(), features: dj.features, flags: dj.flags });
        if (o.project || o.json) this.apply({ type: 'load', project: o.project, json: o.json });
        if (Array.isArray(o.mutes)) for (const id of o.mutes) this.apply({ type: 'mute', netId: id, muted: true });
        if (o.tempo) this.apply({ type: 'tempo', bpm: o.tempo });
        if (o.controlMacros || Array.isArray(o.macrosDisabled)) {
            this.apply({ type: 'control-macros', on: !!o.controlMacros, disabled: o.macrosDisabled || [] });
        }
        if (o.swing !== undefined || o.humanize !== undefined) {
            this.apply({ type: 'groove', swing: o.swing || 0, humanize: o.humanize || 0 });
        }
        if (o.play) this.apply({ type: 'transport', action: 'play' });
        const q = this.queue; this.queue = [];
        for (const m of q) this.onMessage(m);
    }

    fail(err) {
        this.failed = true;
        this.dj = null;
        this.port.postMessage({ type: 'error', message: String((err && err.message) || err) });
    }

    onMessage(msg) {
        if (msg.type === 'wasm') { this.start(msg.bytes); return; }
        if (msg.type === 'tap-digest') { this.digest(); return; }
        if (this.failed) return;
        if (!this.dj) { this.queue.push(msg); return; }
        if (msg.at !== undefined || msg.q !== undefined) { this.stamp(msg); return; }
        this.apply(msg);
    }

    /** Hold a stamped message for its block (stamp order, then arrival order). */
    stamp(msg) {
        const e = { q: msg.q, at: msg.at, msg };
        const key = (x) => (x.q !== undefined ? x.q * QUANTUM : x.at);
        let i = this.stamped.length;
        while (i > 0 && key(this.stamped[i - 1]) > key(e)) i--;
        this.stamped.splice(i, 0, e);
    }

    /** Apply every stamped message due before the block about to render. */
    due(dj) {
        let clock = -1;
        while (this.stamped.length) {
            const e = this.stamped[0];
            if (e.q !== undefined) {
                if (e.q > this.quantum) break;
            } else {
                if (clock < 0) clock = dj.has(FEATURE.FRAME_CLOCK) ? dj.frame : this.frames;
                if (e.at > clock) break;
            }
            this.stamped.shift();
            this.apply(e.msg);
            clock = -1; // a transport or seek message moves the engine clock
        }
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
            case 'tempo': dj.setTempo(msg.bpm); this.lastTempo = dj.tempo; break;
            case 'mute': dj.setMute(msg.netId, msg.muted); break;
            case 'fire-macro': {
                const d = msg.duration === undefined || msg.duration === null ? -1 : Number(msg.duration);
                const result = dj.fireMacro(msg.id, Number.isFinite(d) ? d : -1);
                // The engine reports an accepted id itself (djw_events); say so here when it cannot.
                if (!this.quiet && (!dj.has(FEATURE.EVENTS) || result === ERR_ARG || result === ERR_NOT_READY)) {
                    this.port.postMessage({ type: 'macro-fired', id: msg.id, source: 'page', result });
                }
                break;
            }
            case 'release-macro': {
                const result = dj.releaseMacro(msg.id);
                if (!this.quiet && result !== 0) this.port.postMessage({ type: 'macro-released', id: msg.id, result });
                break;
            }
            case 'panic': dj.panic(); break;
            case 'control-macros':
                if (Array.isArray(msg.disabled)) {
                    const next = new Set(msg.disabled.map(String));
                    for (const id of this.disabled) if (!next.has(id)) dj.setMacroDisabled(id, false);
                    for (const id of next) if (!this.disabled.has(id)) dj.setMacroDisabled(id, true);
                    this.disabled = next;
                }
                if (msg.on !== undefined) dj.setControlMacros(!!msg.on);
                break;
            case 'seek': {
                const reached = dj.seek(msg.tick);
                if (!this.quiet) {
                    this.port.postMessage({ type: 'seeked', tick: reached, requested: msg.tick });
                    if (reached >= 0) this.stateTick(dj);
                }
                break;
            }
            case 'groove': dj.setGroove(Number(msg.swing) || 0, Number(msg.humanize) || 0); break;
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
        const n = out[0].length;
        if (this.assertQuantum && n !== this.assertQuantum) {
            this.fail(`render quantum is ${n} frames, this processor requires ${this.assertQuantum}`);
            return true;
        }
        if (this.stamped.length) this.due(dj);
        let ticks;
        try {
            ticks = dj.process(n);
            dj.copyOut(out[0], out[1] || null, n);
        } catch (err) {
            // A trap (a panic in the engine) leaves the instance unusable: go silent, say why.
            let why = String((err && err.message) || err);
            try { why += ' — ' + dj.panicMessage(); } catch { /* memory may be gone */ }
            this.fail(why);
            return true;
        }
        this.quantum++;
        this.frames += n;
        if (this.tap) this.tapBlock(out[0], out[1] || out[0], n);
        if (!this.quiet) {
            if (ticks > 0) this.report(dj);
            if (dj.eventCount > 0) this.postEvents(dj);
        }
        return true;
    }

    report(dj) {
        const rep = dj.report();
        if (!rep) return;
        // t: audio-thread time of this tick; the page compares it with its own context time to
        // measure how far the visuals trail.
        const msg = { type: 'wave-tick', tick: rep.tick, t: currentTime, fired: rep.fired, controls: rep.controls };
        if (rep.tick % STATE_EVERY === 0) msg.state = dj.marking();
        const mask = dj.macroMask;
        if (rep.controls.length || mask !== 0 || mask !== this.lastMask) msg.mutedNets = dj.muted();
        if (dj.features) {
            msg.macroMask = mask;
            msg.frame = dj.frame;
            const t = dj.tempo;
            if (t !== this.lastTempo) { msg.tempo = t; this.lastTempo = t; }
        }
        this.lastMask = mask;
        this.port.postMessage(msg);
        if (dj.takeStopped()) this.port.postMessage({ type: 'playback-complete' });
    }

    /** After a seek: the marking, mutes and clock now, without waiting for the next tick. */
    stateTick(dj) {
        const msg = { type: 'wave-tick', tick: dj.tick, t: currentTime, fired: [], controls: [], seek: true,
            state: dj.marking(), mutedNets: dj.muted() };
        if (dj.features) {
            msg.macroMask = dj.macroMask; msg.frame = dj.frame; msg.tempo = dj.tempo;
            this.lastTempo = msg.tempo;
        }
        this.lastMask = msg.macroMask || 0;
        this.port.postMessage(msg);
    }

    postEvents(dj) {
        for (const e of dj.events()) {
            const type = EVENT_TYPE[e.k];
            if (!type) this.port.postMessage({ type: 'macro-overflow', dropped: e.res });
            else if (e.k === 'tempo') this.port.postMessage({ type, bpm: e.bpm, frame: e.frame, tick: e.tick });
            else this.port.postMessage({ type, id: e.id, source: e.src, result: e.res, frame: e.frame, tick: e.tick });
        }
    }

    // --- test hooks ---

    tapBlock(L, R, n) {
        const tap = this.tap;
        if (tap.hash) {
            if (tap.done) return;
            tap.quanta[n] = (tap.quanta[n] || 0) + 1;
            const take = tap.limit ? Math.min(n, tap.limit - tap.frames) : n;
            tap.hash.updateStereo(L, R, take);
            tap.frames += take;
            if (tap.limit && tap.frames >= tap.limit) {
                tap.done = true;
                this.port.postMessage({ type: 'tap-done', sha: tap.hash.hex(), frames: tap.frames, quanta: tap.quanta });
            }
            return;
        }
        if (!tap.buf) tap.buf = new Float32Array(2 * tap.chunk);
        for (let i = 0; i < n; i++) {
            tap.buf[2 * tap.fill] = L[i]; tap.buf[2 * tap.fill + 1] = R[i];
            if (++tap.fill === tap.chunk) this.tapFlush();
        }
    }

    tapFlush() {
        const tap = this.tap;
        if (!tap || tap.hash || !tap.fill) return;
        const data = tap.buf.slice(0, 2 * tap.fill);
        this.port.postMessage({ type: 'tap', offset: tap.offset, data }, [data.buffer]);
        tap.offset += tap.fill;
        tap.fill = 0;
    }

    digest() {
        const tap = this.tap;
        if (tap && tap.hash) this.port.postMessage({ type: 'tap-digest', sha: tap.hash.hex(), frames: tap.frames, quanta: tap.quanta });
        else { this.tapFlush(); this.port.postMessage({ type: 'tap-digest', sha: null, frames: this.frames }); }
    }
}

/**
 * SHA-256 over the little-endian f32 bytes of interleaved L,R frames (what djrust-golden.mjs
 * hashes), incremental, for the tapHash hook: an AudioWorkletGlobalScope has no crypto. hex()
 * does not end the stream.
 */
class Sha256 {
    constructor() {
        this.h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
        this.block = new Uint8Array(64);
        this.fill = 0;
        this.len = 0; // bytes
        this.w = new Uint32Array(64);
        this.f = new Float32Array(2);
        this.fb = new Uint8Array(this.f.buffer);
    }

    updateStereo(L, R, n) {
        const f = this.f, fb = this.fb, block = this.block;
        for (let i = 0; i < n; i++) {
            f[0] = L[i]; f[1] = R[i];
            for (let k = 0; k < 8; k++) {
                block[this.fill++] = fb[k];
                if (this.fill === 64) { Sha256.compress(this.h, block, this.w); this.fill = 0; }
            }
        }
        this.len += 8 * n;
    }

    hex() {
        const h = this.h.slice(), block = this.block.slice(), w = this.w;
        let fill = this.fill;
        block[fill++] = 0x80;
        if (fill > 56) { block.fill(0, fill); Sha256.compress(h, block, w); fill = 0; }
        block.fill(0, fill, 56);
        const bits = this.len * 8;
        const hi = Math.floor(bits / 0x100000000), lo = bits >>> 0;
        for (let k = 0; k < 4; k++) { block[56 + k] = (hi >>> (24 - 8 * k)) & 255; block[60 + k] = (lo >>> (24 - 8 * k)) & 255; }
        Sha256.compress(h, block, w);
        let s = '';
        for (let i = 0; i < 8; i++) s += h[i].toString(16).padStart(8, '0');
        return s;
    }

    static compress(h, b, w) {
        const K = SHA256_K;
        for (let i = 0; i < 16; i++) w[i] = (b[4 * i] << 24) | (b[4 * i + 1] << 16) | (b[4 * i + 2] << 8) | b[4 * i + 3];
        for (let i = 16; i < 64; i++) {
            const x = w[i - 15], y = w[i - 2];
            const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
            const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }
        let a = h[0], bb = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
        for (let i = 0; i < 64; i++) {
            const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
            const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            const t2 = (S0 + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
            hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
        }
        h[0] += a; h[1] += bb; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
}
const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

registerProcessor('djrust-engine', DjrustProcessor);
