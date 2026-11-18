/**
 * engine-polyfill.js: TextEncoder / TextDecoder for an AudioWorkletGlobalScope.
 *
 * The worklet scope has neither (nor fetch), and the wasm-bindgen glue (../wasm/btw.js) makes both at the
 * top level of its module. engine-worklet.js imports this file first; ES module evaluation runs imports in
 * order, so these exist before the glue is evaluated. A scope that already has them (a Worker, the main
 * thread, Node) is left alone.
 *
 * UTF-8 only, which is all wasm-bindgen asks for: `encode`, `encodeInto`, and `decode` (also with no argument,
 * which the glue calls once to warm the decoder). With `fatal: true` a malformed sequence throws a TypeError, as the
 * real decoder does; otherwise it becomes U+FFFD.
 */

const scope = globalThis;

if (typeof scope.TextEncoder === 'undefined') {
    scope.TextEncoder = class TextEncoder {
        get encoding() { return 'utf-8'; }

        encode(str = '') {
            str = String(str);
            // worst case 3 bytes per UTF-16 unit (a surrogate pair is 4 bytes for 2 units)
            const out = new Uint8Array(str.length * 3);
            const { written } = this.encodeInto(str, out);
            return out.slice(0, written);
        }

        encodeInto(str, view) {
            str = String(str);
            let read = 0, written = 0;
            const n = str.length, cap = view.length;
            while (read < n) {
                let c = str.charCodeAt(read);
                let units = 1;
                if (c >= 0xd800 && c <= 0xdbff && read + 1 < n) {
                    const d = str.charCodeAt(read + 1);
                    if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); units = 2; }
                }
                if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd; // a lone surrogate
                const need = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
                if (written + need > cap) break;
                if (need === 1) {
                    view[written++] = c;
                } else if (need === 2) {
                    view[written++] = 0xc0 | (c >> 6);
                    view[written++] = 0x80 | (c & 63);
                } else if (need === 3) {
                    view[written++] = 0xe0 | (c >> 12);
                    view[written++] = 0x80 | ((c >> 6) & 63);
                    view[written++] = 0x80 | (c & 63);
                } else {
                    view[written++] = 0xf0 | (c >> 18);
                    view[written++] = 0x80 | ((c >> 12) & 63);
                    view[written++] = 0x80 | ((c >> 6) & 63);
                    view[written++] = 0x80 | (c & 63);
                }
                read += units;
            }
            return { read, written };
        }
    };
}

if (typeof scope.TextDecoder === 'undefined') {
    scope.TextDecoder = class TextDecoder {
        constructor(label = 'utf-8', options = {}) {
            const l = String(label).toLowerCase();
            if (l !== 'utf-8' && l !== 'utf8') throw new RangeError(`TextDecoder polyfill: only utf-8, not ${label}`);
            this.fatal = !!options.fatal;
            this.ignoreBOM = !!options.ignoreBOM;
        }

        get encoding() { return 'utf-8'; }

        decode(input) {
            if (input === undefined) return '';
            const b = input instanceof Uint8Array ? input
                : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
                : new Uint8Array(input);
            let i = 0;
            const n = b.length;
            if (!this.ignoreBOM && n >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
            const units = [];
            let out = '';
            const flush = () => { if (units.length) { out += String.fromCharCode.apply(null, units); units.length = 0; } };
            const bad = () => { if (this.fatal) throw new TypeError('The encoded data was not valid for encoding utf-8'); units.push(0xfffd); };
            while (i < n) {
                if (units.length > 8192) flush();
                const c = b[i];
                if (c < 0x80) { units.push(c); i += 1; continue; }
                // a lead byte: how many bytes the sequence has, and the bounds of its second byte (RFC 3629, no overlongs, no surrogates)
                let need = 0, lo = 0x80, hi = 0xbf, cp = 0;
                if (c >= 0xc2 && c <= 0xdf) { need = 1; cp = c & 0x1f; }
                else if (c >= 0xe0 && c <= 0xef) { need = 2; cp = c & 0x0f; if (c === 0xe0) lo = 0xa0; if (c === 0xed) hi = 0x9f; }
                else if (c >= 0xf0 && c <= 0xf4) { need = 3; cp = c & 0x07; if (c === 0xf0) lo = 0x90; if (c === 0xf4) hi = 0x8f; }
                else { bad(); i += 1; continue; }
                // take the continuation bytes that are valid; a sequence cut short is ONE replacement for what was valid of it
                let k = 1;
                while (k <= need && i + k < n && b[i + k] >= (k === 1 ? lo : 0x80) && b[i + k] <= (k === 1 ? hi : 0xbf)) { cp = (cp << 6) | (b[i + k] & 63); k++; }
                if (k <= need) { bad(); i += k; continue; }
                if (cp >= 0x10000) { const v = cp - 0x10000; units.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff)); } else units.push(cp);
                i += need + 1;
            }
            flush();
            return out;
        }
    };
}
