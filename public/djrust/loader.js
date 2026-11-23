/**
 * loader.js — the JS half of djwasm's C ABI (stackdump/djrust, cabi/).
 *
 * djwasm is the djrust Rust engine compiled to WebAssembly. It is a plain C ABI, not
 * wasm-bindgen: an AudioWorklet's global scope has no TextEncoder / TextDecoder, which
 * wasm-bindgen's glue needs, and this site has no bundler. So this file is the whole glue:
 * text goes in and out through linear memory, and UTF-8 is converted here (with the
 * built-in codec when the scope has one, by hand when it does not).
 *
 * Pure ES module, no DOM, no Node API: it runs in the page, a Worker, an AudioWorklet and
 * Node (scripts/test-djrust-wasm.mjs).
 *
 *   const dj = await instantiate(bytesOrModule);
 *   dj.init(sampleRate);                       // one runner per instance
 *   dj.load(projectJsonOrObject); dj.play();
 *   const ticks = dj.process(128);             // renders; allocation free
 *   dj.copyOut(left, right, 128);              // into the worklet's output arrays
 *   const report = ticks && dj.report();       // {tick, fired, controls} of the last tick
 *
 * The ABI version this file speaks is ABI; instantiate() refuses a module that differs.
 *
 * Studio controls (djwasm 0.3.0 and later; ABI 1, additive). Every one is feature-detected
 * by its export, so this loader still drives djwasm 0.2.0: there `features` is 0, the reads
 * return 0 / [] and the controls answer ERR_UNSUPPORTED ("the page does it") or do nothing.
 *
 *   dj.features & FEATURE.NET_MACROS           // what the module runs (djw_features)
 *   dj.initWith(sampleRate, FLAG.GROOVE);      // construction flags (djw_init_with)
 *   dj.fireMacro('drop', -1);                  // 0, or ERR_UNSUPPORTED: the page runs it
 *   dj.releaseMacro(id); dj.panic();
 *   dj.macroMask; dj.frame; dj.tempo;          // scalar reads, allocation free
 *   dj.setControlMacros(true); dj.setMacroDisabled('cut', true);
 *   dj.eventCount && dj.events();              // [{k, id, src, res, frame, tick[, bpm]}]
 *   dj.seek(tick); dj.setGroove(swing, humanize);
 *   dj.keys();                                 // the key tables (djw_keys), once, cached
 *   dj.setInstrument('lead', 'vibes');         // FEATURE.INSTRUMENT: live, the song keeps going
 *
 * Nothing here is called on the default path: an instance that never uses them renders
 * djwasm 0.2.0's bytes.
 */

export const ABI = 1;

/** Error codes of the C ABI. */
export const ERR_ARG = -1;
export const ERR_NOT_READY = -2;
/** A catalog id (or flag) the module knows but does not run, or an export it lacks. */
export const ERR_UNSUPPORTED = -3;

/** djw_features() bits (djrust wave::studio::feature). A module without the export: all 0. */
export const FEATURE = Object.freeze({
    SEEK: 1, NET_MACROS: 2, CONTROL_MACROS: 4, GROOVE: 8, FRAME_CLOCK: 16, EVENTS: 32,
    FX: 64, MASTER_MACROS: 128, AUX_MACROS: 256, VOICE: 512, STRIKE: 1024, INSTRUMENT: 2048,
    TRANSPOSE: 4096, LOOP: 8192, STINGER_VOICES: 16384, ROUTES: 32768,
});

/** djw_init_with() flags. */
export const FLAG = Object.freeze({ GROOVE: 1, STINGER_VOICES: 2 });

// --- UTF-8 -----------------------------------------------------------------------------

/** UTF-8 bytes of a string. Lone surrogates become U+FFFD, as TextEncoder does. */
export function utf8EncodeManual(s) {
    const out = new Uint8Array(s.length * 3); // worst case: a BMP char is 3 bytes
    let o = 0;
    for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
            const d = s.charCodeAt(i + 1);
            if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
        }
        if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
        if (c < 0x80) out[o++] = c;
        else if (c < 0x800) { out[o++] = 0xc0 | (c >> 6); out[o++] = 0x80 | (c & 63); }
        else if (c < 0x10000) { out[o++] = 0xe0 | (c >> 12); out[o++] = 0x80 | ((c >> 6) & 63); out[o++] = 0x80 | (c & 63); }
        else {
            out[o++] = 0xf0 | (c >> 18); out[o++] = 0x80 | ((c >> 12) & 63);
            out[o++] = 0x80 | ((c >> 6) & 63); out[o++] = 0x80 | (c & 63);
        }
    }
    return out.subarray(0, o);
}

/** The string of UTF-8 bytes. The engine only writes valid UTF-8; invalid bytes become U+FFFD. */
export function utf8DecodeManual(b) {
    let s = '';
    const units = [];
    const flush = () => { s += String.fromCharCode.apply(null, units); units.length = 0; };
    for (let i = 0; i < b.length;) {
        const c = b[i];
        let cp = 0xfffd, n = 1;
        if (c < 0x80) cp = c;
        else if (c >= 0xc2 && c < 0xe0 && (b[i + 1] & 0xc0) === 0x80) { cp = ((c & 31) << 6) | (b[i + 1] & 63); n = 2; }
        else if (c >= 0xe0 && c < 0xf0 && (b[i + 1] & 0xc0) === 0x80 && (b[i + 2] & 0xc0) === 0x80) {
            cp = ((c & 15) << 12) | ((b[i + 1] & 63) << 6) | (b[i + 2] & 63); n = 3;
            if (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff)) { cp = 0xfffd; n = 1; }
        } else if (c >= 0xf0 && c < 0xf5 && (b[i + 1] & 0xc0) === 0x80 && (b[i + 2] & 0xc0) === 0x80 && (b[i + 3] & 0xc0) === 0x80) {
            cp = ((c & 7) << 18) | ((b[i + 1] & 63) << 12) | ((b[i + 2] & 63) << 6) | (b[i + 3] & 63); n = 4;
            if (cp < 0x10000 || cp > 0x10ffff) { cp = 0xfffd; n = 1; }
        }
        i += n;
        if (cp >= 0x10000) { cp -= 0x10000; units.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023)); }
        else units.push(cp);
        if (units.length >= 8192) flush();
    }
    flush();
    return s;
}

const nativeCodec = () => typeof TextEncoder === 'function' && typeof TextDecoder === 'function'
    ? { enc: new TextEncoder(), dec: new TextDecoder('utf-8') } : null;

// --- The module ------------------------------------------------------------------------

/**
 * Instantiate djwasm.wasm. `source` is the bytes (ArrayBuffer / typed array) or an already
 * compiled WebAssembly.Module. `opts.manualUtf8` forces the hand-written codec (tests use it
 * to stand in for an AudioWorklet scope).
 */
export async function instantiate(source, opts = {}) {
    const instance = source instanceof WebAssembly.Module
        ? await WebAssembly.instantiate(source, {})
        : (await WebAssembly.instantiate(source, {})).instance;
    return new DjWasm(instance.exports, opts);
}

/**
 * The same, synchronously: `source` is a compiled WebAssembly.Module (the page compiles it with
 * WebAssembly.compile and hands it to the worklet in processorOptions) or bytes. For the
 * worklet constructor, which cannot wait: an OfflineAudioContext starts rendering the moment
 * it is told to, so an engine that is not ready by then renders silence.
 */
export function instantiateSync(source, opts = {}) {
    const module = source instanceof WebAssembly.Module ? source : new WebAssembly.Module(source);
    return new DjWasm(new WebAssembly.Instance(module, {}).exports, opts);
}

export class DjWasm {
    constructor(exports, opts = {}) {
        this.x = exports;
        const abi = exports.djw_abi();
        if (abi !== ABI) throw new Error(`djwasm ABI ${abi}, loader speaks ${ABI}: rebuild with scripts/build-djrust-wasm.sh`);
        const codec = opts.manualUtf8 ? null : nativeCodec();
        this._enc = codec ? (s) => codec.enc.encode(s) : utf8EncodeManual;
        this._dec = codec ? (b) => codec.dec.decode(b) : utf8DecodeManual;
        this._buf = null; // memory.buffer the cached views belong to
        this._l = this._r = null;
        this.maxBlock = 0;
        this.flags = 0; // the construction flags the instance runs with
        // A wasm i64 arrives as a BigInt; a module without the export is djwasm 0.2.0.
        this.features = exports.djw_features ? Number(exports.djw_features()) : 0;
        this._keys = undefined;
        if (exports.djw_install_panic_hook) exports.djw_install_panic_hook();
    }

    /** Does the module run `bit` (a FEATURE value)? */
    has(bit) { return (this.features & bit) !== 0; }

    /** The out buffer as a string (valid until the next call that writes it). */
    _out() {
        const x = this.x;
        return this._dec(new Uint8Array(x.memory.buffer, x.djw_out_ptr(), x.djw_out_len()));
    }

    /** Pass `text` to `fn(ptr, len)`; frees the block after. */
    _withText(text, fn) {
        const x = this.x;
        const b = this._enc(text);
        const p = x.djw_alloc(b.length);
        new Uint8Array(x.memory.buffer, p, b.length).set(b);
        try { return fn(p, b.length); } finally { x.djw_free(p, b.length); }
    }

    /** A call that returns a text length or a negative code: the text, or throws its message. */
    _text(n) {
        if (n < 0) throw new Error(`djwasm: ${this._out() || 'error ' + n}`);
        return this._out();
    }

    /** The message of the last panic, if the module trapped. */
    panicMessage() {
        const x = this.x;
        return this._dec(new Uint8Array(x.memory.buffer, x.djw_panic_ptr(), x.djw_panic_len()));
    }

    info() { return JSON.parse(this._text(this.x.djw_info())); }

    // --- generator ---

    /**
     * compose({genre, seed, structure, ...overrides}) → {name, modelCid, canonicalBytes, doc}.
     * `doc` is JSON.stringify(projectToJSON(compose(genre, params))) parsed back; pass
     * `{raw: true}` as the second argument to get `docText` (the exact bytes) beside it.
     */
    compose(spec, { raw = false } = {}) {
        const text = this._text(this._withText(typeof spec === 'string' ? spec : JSON.stringify(spec),
            (p, n) => this.x.djw_compose(p, n)));
        const r = JSON.parse(text);
        if (raw) {
            const i = text.indexOf('"doc":') + 6;
            r.docText = text.slice(i, text.length - 1);
        }
        return r;
    }

    /** Model CID (hex sha256 of canonicalProjectJSON) of a project document. */
    modelCid(doc) {
        return this._text(this._withText(typeof doc === 'string' ? doc : JSON.stringify(doc),
            (p, n) => this.x.djw_model_cid(p, n)));
    }

    // --- runner ---

    init(sampleRate) {
        const n = this.x.djw_init(sampleRate);
        if (n < 0) throw new Error(`djwasm: ${this._out()}`);
        this.maxBlock = n;
        this.flags = 0;
        this._buf = null;
        return n;
    }

    /**
     * init() with construction flags (FLAG.GROOVE). Flags 0 is exactly init(). A module without
     * djw_init_with (0.2.0) is initialised plainly: `this.flags` then says 0, and the caller can
     * tell the flag did not take.
     */
    initWith(sampleRate, flags = 0) {
        if (!flags || !this.x.djw_init_with) return this.init(sampleRate);
        const n = this.x.djw_init_with(sampleRate, flags >>> 0);
        if (n < 0) throw new Error(`djwasm: ${this._out()}`);
        this.maxBlock = n;
        this.flags = flags >>> 0;
        this._buf = null;
        return n;
    }

    /** Load a project document (object or JSON text). Returns the net count. */
    load(project) {
        const n = this._withText(typeof project === 'string' ? project : JSON.stringify(project),
            (p, len) => this.x.djw_load(p, len));
        if (n < 0) throw new Error(`djwasm: ${this._out()}`);
        return n;
    }

    play() { this.x.djw_play(); }
    pause() { this.x.djw_pause(); }
    stop() { this.x.djw_stop(); }
    setTempo(bpm) { this.x.djw_set_tempo(bpm); }
    setMute(netId, muted) {
        return this._withText(netId, (p, n) => this.x.djw_set_mute(p, n, muted ? 1 : 0));
    }

    /** Render `frames` (≤ maxBlock). Returns the ticks that began in the block. Allocation free. */
    process(frames) { return this.x.djw_process(frames); }

    _views() {
        const x = this.x;
        if (this._buf !== x.memory.buffer) { // first call, or memory grew and detached the old views
            this._buf = x.memory.buffer;
            this._l = new Float32Array(this._buf, x.djw_left_ptr(), this.maxBlock);
            this._r = new Float32Array(this._buf, x.djw_right_ptr(), this.maxBlock);
        }
    }

    /** Copy the last block into `left` / `right` (the worklet's output arrays; `right` may be null). */
    copyOut(left, right, frames) {
        this._views();
        const l = this._l, r = this._r;
        for (let i = 0; i < frames; i++) left[i] = l[i];
        if (right) for (let i = 0; i < frames; i++) right[i] = r[i];
    }

    /** Views onto the last block (valid until the next process or memory growth). */
    blocks(frames) {
        this._views();
        return [this._l.subarray(0, frames), this._r.subarray(0, frames)];
    }

    /** {tick, fired:[[netId, transId, midi]], controls:[[netId, transId, control]]}, or null. */
    report() {
        const n = this.x.djw_report();
        if (n < 0) throw new Error(`djwasm: ${this._out()}`);
        return n === 0 ? null : JSON.parse(this._out());
    }

    marking() { return JSON.parse(this._text(this.x.djw_marking())); }
    muted() { return JSON.parse(this._text(this.x.djw_muted())); }
    takeStopped() { return this.x.djw_take_stopped() === 1; }
    get tick() { return this.x.djw_tick(); }
    get tempo() { return this.x.djw_tempo(); }
    get playing() { return this.x.djw_playing() === 1; }

    // --- studio controls (0.3.0+; feature-detected, see the header) ---

    /** The key tables (djw_keys), parsed once; null on a module without them. Allocates. */
    keys() {
        if (this._keys === undefined) {
            this._keys = this.x.djw_keys ? JSON.parse(this._text(this.x.djw_keys())) : null;
        }
        return this._keys;
    }

    /** The engine frame clock (djw_frame); 0 on a module without one. */
    get frame() { return this.x.djw_frame ? this.x.djw_frame() : 0; }

    /** The net macros in effect, as bits (djw_macro_mask); 0 on a module without them. */
    get macroMask() { return this.x.djw_macro_mask ? Number(this.x.djw_macro_mask()) : 0; }

    /** Events waiting in the engine's ring (djw_event_count). */
    get eventCount() { return this.x.djw_event_count ? this.x.djw_event_count() : 0; }

    /**
     * Drain the event ring: [{k, id, src, res, frame, tick[, bpm]}], oldest first. [] when
     * nothing waits (no call into the module then) or the module has no ring. Allocates.
     */
    events() {
        const x = this.x;
        if (!x.djw_events || !x.djw_event_count || x.djw_event_count() === 0) return [];
        return JSON.parse(this._text(x.djw_events()));
    }

    /** `id` (a catalog string) to `fn(ptr, len)`, or ERR_UNSUPPORTED when the export is absent. */
    _idCall(name, id, ...rest) {
        const f = this.x[name];
        if (!f) return ERR_UNSUPPORTED;
        return this._withText(String(id), (p, n) => f(p, n, ...rest));
    }

    /**
     * Fire catalog macro `id` for `duration` in its own unit (bars; ticks for cut), -1 for its
     * default. 0: the engine runs it. ERR_UNSUPPORTED: the page must run it (a master or aux
     * macro in 0.3, a hit pad, a permanent net macro, or a module without macros). ERR_ARG: no
     * such id. ERR_NOT_READY: no project.
     */
    fireMacro(id, duration = -1) {
        const d = Number.isFinite(duration) ? Math.trunc(duration) : -1;
        return this._idCall('djw_fire_macro', id, d < -1 ? -2 : d);
    }

    /** Let go of a latched macro: 0, ERR_UNSUPPORTED (page-side) or ERR_ARG. */
    releaseMacro(id) { return this._idCall('djw_release_macro', id); }

    /** Restore every macro effect now (no-op with nothing running, or without the export). */
    panic() { if (this.x.djw_panic) this.x.djw_panic(); }

    /** Control nets' fire-macro run in the engine (true) or are only reported (false, default). */
    setControlMacros(on) {
        if (!this.x.djw_set_control_macros) return false;
        this.x.djw_set_control_macros(on ? 1 : 0);
        return true;
    }

    /** Put a catalog id on (or off) the list a control net may not fire. 0, ERR_ARG or ERR_UNSUPPORTED. */
    setMacroDisabled(id, disabled = true) { return this._idCall('djw_set_macro_disabled', id, disabled ? 1 : 0); }

    /**
     * Move the net to `tick` now (stop, cut tails, replay silently, resume if playing). The tick
     * reached, or ERR_ARG / ERR_NOT_READY, or ERR_UNSUPPORTED without the export. O(tick).
     */
    seek(tick) { return this.x.djw_seek ? this.x.djw_seek(Number(tick)) : ERR_UNSUPPORTED; }

    /**
     * Swing and humanize 0..100 for the playing project. They move notes only on an instance
     * made with initWith(sr, FLAG.GROOVE); a project swapped in later brings its own values, so
     * send them again after a swap. 0, ERR_ARG, ERR_NOT_READY or ERR_UNSUPPORTED.
     */
    setGroove(swing, humanize) {
        return this.x.djw_set_groove ? this.x.djw_set_groove(Number(swing), Number(humanize)) : ERR_UNSUPPORTED;
    }

    /**
     * Play net `netId` on `instrument` from the next block on (FEATURE.INSTRUMENT,
     * djw_set_instrument): its lanes are rebuilt as a load of the project with that
     * `track.instrument` would build them, and the tick, the marking and every other net play
     * on. Applies to a project queued for the bar too. 0, ERR_ARG (not a net with lanes, or an
     * empty name), ERR_NOT_READY (no project) or ERR_UNSUPPORTED (a module without it: the
     * instrument is then only what the next load carries). Allocates, like load().
     */
    setInstrument(netId, instrument) {
        const f = this.x.djw_set_instrument;
        if (!f) return ERR_UNSUPPORTED;
        return this._withText(String(netId), (ip, il) =>
            this._withText(String(instrument), (np, nl) => f(ip, il, np, nl)));
    }
}
