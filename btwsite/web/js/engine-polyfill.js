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
                const c = b[i];
                if (c < 0x80) { units.push(c); i += 1; }
                else if (c >= 0xc2 && c <= 0xdf) {
                    if (i + 1 < n && (b[i + 1] & 0xc0) === 0x80) { units.push(((c & 0x1f) << 6) | (b[i + 1] & 63)); i += 2; }
                    else { bad(); i += 1; }
                } else if (c >= 0xe0 && c <= 0xef) {
                    const lo = c === 0xe0 ? 0xa0 : 0x80, hi = c === 0xed ? 0x9f : 0xbf; // no overlongs, no surrogates
                    if (i + 2 < n && b[i + 1] >= lo && b[i + 1] <= hi && (b[i + 2] & 0xc0) === 0x80) {
                        units.push(((c & 0x0f) << 12) | ((b[i + 1] & 63) << 6) | (b[i + 2] & 63)); i += 3;
                    } else { bad(); i += 1; }
                } else if (c >= 0xf0 && c <= 0xf4) {
                    const lo = c === 0xf0 ? 0x90 : 0x80, hi = c === 0xf4 ? 0x8f : 0xbf;
                    if (i + 3 < n && b[i + 1] >= lo && b[i + 1] <= hi && (b[i + 2] & 0xc0) === 0x80 && (b[i + 3] & 0xc0) === 0x80) {
                        const cp = ((c & 0x07) << 18) | ((b[i + 1] & 63) << 12) | ((b[i + 2] & 63) << 6) | (b[i + 3] & 63);
                        const v = cp - 0x10000;
                        units.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff)); i += 4;
                    } else { bad(); i += 1; }
                } else { bad(); i += 1; }
                if (units.length > 8192) flush();
            }
            flush();
            return out;
        }
    };
}
