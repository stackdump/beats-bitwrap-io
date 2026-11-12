// AudioWorkletGlobalScope has no TextEncoder / TextDecoder, which the wasm-bindgen glue in the
// djrust package needs for every string it passes. UTF-8 only, as the glue asks for. Imported
// before the glue (module evaluation order) by the worklet bootstrap in lib/backend/djrust.js.
if (typeof globalThis.TextEncoder === 'undefined') {
    globalThis.TextEncoder = class TextEncoder {
        get encoding() { return 'utf-8'; }
        encode(s = '') {
            const out = [];
            for (const ch of String(s)) {
                let c = ch.codePointAt(0);
                if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd; // lone surrogate
                if (c < 0x80) out.push(c);
                else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
                else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
                else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
            }
            return new Uint8Array(out);
        }
        encodeInto(s, dest) {
            const b = this.encode(s);
            // never split a character: stop at the last whole one that fits
            let n = Math.min(b.length, dest.length);
            if (n < b.length) while (n > 0 && (b[n] & 0xc0) === 0x80) n--;
            dest.set(b.subarray(0, n));
            let read = 0, i = 0;
            for (const ch of String(s)) {
                const w = ch.codePointAt(0) < 0x80 ? 1 : ch.codePointAt(0) < 0x800 ? 2 : ch.codePointAt(0) < 0x10000 ? 3 : 4;
                if (i + w > n) break;
                i += w; read += ch.length;
            }
            return { read, written: n };
        }
    };
}
if (typeof globalThis.TextDecoder === 'undefined') {
    globalThis.TextDecoder = class TextDecoder {
        constructor(_label = 'utf-8', opts = {}) { this.fatal = !!opts.fatal; }
        get encoding() { return 'utf-8'; }
        decode(buf) {
            if (!buf) return '';
            const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength);
            let s = '';
            const bad = () => { if (this.fatal) throw new TypeError('invalid utf-8'); return 0xfffd; };
            for (let i = 0; i < b.length;) {
                const x = b[i];
                let c, n;
                if (x < 0x80) { c = x; n = 1; }
                else if (x >= 0xc2 && x < 0xe0) { c = x & 31; n = 2; }
                else if (x >= 0xe0 && x < 0xf0) { c = x & 15; n = 3; }
                else if (x >= 0xf0 && x < 0xf5) { c = x & 7; n = 4; }
                else { s += String.fromCodePoint(bad()); i++; continue; }
                if (i + n > b.length) { s += String.fromCodePoint(bad()); break; }
                let ok = true;
                for (let k = 1; k < n; k++) {
                    const y = b[i + k];
                    if ((y & 0xc0) !== 0x80) { ok = false; break; }
                    c = (c << 6) | (y & 63);
                }
                if (!ok || (n === 3 && c < 0x800) || (n === 4 && (c < 0x10000 || c > 0x10ffff)) || (c >= 0xd800 && c <= 0xdfff)) {
                    s += String.fromCodePoint(bad()); i++; continue;
                }
                s += String.fromCodePoint(c);
                i += n;
            }
            return s;
        }
    };
}
