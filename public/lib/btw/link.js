// btw links: https://beats.bitwrap.io/p#<CID>.<base64url(deflate(canonical text))>[.<sig>][~<notes>]
//
// The bitwrap language's self-sealing share link (docs/BTW.md in djrust-vevr-se). The CID is the
// share CID of {"format":1,"text":<canonical text>,"type":"djrust.live"}: the page decodes the text,
// recomputes the CID the way the language does (canonical JSON, sha-256, CIDv1) and says whether the
// text is the program the CID names. Same helpers as the rest of the share path (lib/share/codec.js).

import { computeCidForJsonLd } from '../share/codec.js';

function unb64url(s) {
    const pad = '='.repeat((4 - s.length % 4) % 4);
    const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

// deflate-raw is what the language writes (DecompressionStream reads it natively).
async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const w = ds.writable.getWriter();
    w.write(bytes);
    w.close();
    const buf = await new Response(ds.readable).arrayBuffer();
    return new TextDecoder().decode(buf);
}

export async function unpack(s) {
    return inflateRaw(unb64url(s));
}

/** A link, its fragment, `CID.text`, or a bare CID. */
export async function parseLink(input) {
    const s = String(input || '').trim();
    const hash = s.includes('#') ? s.slice(s.indexOf('#') + 1) : s;
    const [sealed, notesPart] = hash.split('~');
    const parts = sealed.split('.');
    const cid = parts[0];
    if (!/^z[1-9A-HJ-NP-Za-km-z]{40,80}$/.test(cid)) throw new Error('that is not a btw link or CID');
    const link = { cid, text: null, sig: parts[2] || null, notes: [] };
    if (parts[1]) link.text = await unpack(parts[1]);
    if (notesPart) link.notes = (await unpack(notesPart)).split('\n').filter(Boolean);
    return link;
}

/** Decode and check: { link, computed, verified }. */
export async function openLink(input) {
    const link = await parseLink(input);
    if (link.text == null) return { link, computed: null, verified: false };
    const computed = await computeCidForJsonLd({ format: 1, text: link.text, type: 'djrust.live' });
    return { link, computed, verified: computed === link.cid };
}
