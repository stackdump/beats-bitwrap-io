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
 */

export const ABI = 1;

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
        if (exports.djw_install_panic_hook) exports.djw_install_panic_hook();
    }

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
}
