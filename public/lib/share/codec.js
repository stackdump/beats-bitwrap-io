// Pure, stateless helpers for the share-URL pipeline:
//   canonical JSON → sha256 → CIDv1 (dag-json / sha2-256 / base58btc)
//   gzip ↔ base64url
//   JSON ↔ base64url
// Extracted from petri-note.js; still imported from there so existing
// `el._canonicalizeJSON(...)` call sites keep working for tests and any
// external caller peeking at the element. No `this` dependency — every
// function here is fully independent and can be unit-tested in isolation
// or reused from a non-element context (e.g. a future headless renderer).

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// --- base64url (JSON values) ---

export function b64urlEncode(obj) {
    const s = JSON.stringify(obj);
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
    try {
        const pad = '='.repeat((4 - str.length % 4) % 4);
        const b64 = (str + pad).replace(/-/g, '+').replace(/_/g, '/');
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
        return null;
    }
}

// --- canonical JSON ---

// Sorted-key recursive stringify. Mirrors seal.go `canonicalJSON` byte-for-byte.
// Deliberately not URDNA2015 — keeps the whole ecosystem dep-free.
export function canonicalizeJSON(doc) {
    const canon = (obj) => {
        if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
        if (Array.isArray(obj)) return '[' + obj.map(canon).join(',') + ']';
        const keys = Object.keys(obj).sort();
        return '{' + keys.map(k => JSON.stringify(k) + ':' + canon(obj[k])).join(',') + '}';
    };
    return canon(doc);
}

// --- sha256 ---

export async function sha256(data) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const h = await crypto.subtle.digest('SHA-256', bytes);
    return new Uint8Array(h);
}

// --- base58btc (bytes) ---

export function encodeBase58(bytes) {
    let num = 0n;
    for (let i = 0; i < bytes.length; i++) num = num * 256n + BigInt(bytes[i]);
    let out = '';
    while (num > 0n) { out = BASE58_ALPHABET[Number(num % 58n)] + out; num = num / 58n; }
    for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out = '1' + out;
    return out;
}

export function decodeBase58(str) {
    let num = 0n;
    for (const ch of str) {
        const v = BASE58_ALPHABET.indexOf(ch);
        if (v < 0) return null;
        num = num * 58n + BigInt(v);
    }
    const bytes = [];
    while (num > 0n) { bytes.unshift(Number(num & 0xffn)); num >>= 8n; }
    for (let i = 0; i < str.length && str[i] === '1'; i++) bytes.unshift(0);
    return new Uint8Array(bytes);
}

// --- CIDv1 (dag-json / sha2-256) ---

// CIDv1 = <version=0x01><codec-varint><multihash>.
// dag-json codec 0x0129 = varint [0xa9, 0x02]; sha2-256 = 0x12 len 0x20.
export function createCIDv1Bytes(hash) {
    const codec = [0xa9, 0x02];
    const out = new Uint8Array(1 + codec.length + 2 + hash.length);
    let o = 0;
    out[o++] = 0x01;
    for (const b of codec) out[o++] = b;
    out[o++] = 0x12;
    out[o++] = hash.length;
    for (let i = 0; i < hash.length; i++) out[o++] = hash[i];
    return out;
}

export async function computeCidForJsonLd(doc) {
    const canonical = canonicalizeJSON(doc);
    const hash = await sha256(canonical);
    const cidBytes = createCIDv1Bytes(hash);
    return 'z' + encodeBase58(cidBytes);
}

// --- gzip ↔ base64url (strings) ---

// CompressionStream / DecompressionStream are native in all evergreen browsers.
export async function gzipToB64Url(str) {
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    writer.write(new TextEncoder().encode(str));
    writer.close();
    const buf = await new Response(cs.readable).arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function b64UrlToGunzip(str) {
    const pad = '='.repeat((4 - str.length % 4) % 4);
    const b64 = (str + pad).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const buf = await new Response(ds.readable).arrayBuffer();
    return new TextDecoder().decode(buf);
}
