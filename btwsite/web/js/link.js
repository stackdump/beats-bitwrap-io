// Opening a link: what to do with the bytes of a stranger's link before the module sees them. Pure (no DOM), so Node tests it.
//
// A btw link is `#<CID>.<base64url(deflate(canonical text))>[.<sig>][~<base64url(deflate(notes))>]`. The module inflates
// it (to at most 1 MiB) and then parses, compiles and checks what came out, all in the page's one thread. A link of a few
// KB can inflate to 1 MiB, and checking that much text takes minutes (a 6 KB program of evolve blocks takes ~2.7 s), so
// the page looks at what a link would inflate to first, and refuses the link when it is more than a program is allowed.

import { MAX_LOAD_TEXT, MAX_LINK_CHARS } from './util.js';

/**
 * The fragment of a `location.hash`, percent-decoded when it can be. A malformed escape (`#%`, `#%E0%A4%A`) is a link
 * somebody mangled, not a reason to stop: it is left as written and the module says it is not a btw link.
 */
export function fragmentOf(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** The base64url runs in `input` long enough to inflate to more than a program may be (the CID, 46 characters, never is). */
export function packedCandidates(input) {
  return String(input || '').split(/[^A-Za-z0-9_-]+/).filter((t) => t.length >= 60);
}

/** Bytes of base64url `s`, or null when it is not base64url. */
export function b64uBytes(s) {
  if (!/^[A-Za-z0-9_-]+$/.test(s) || s.length % 4 === 1) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * How many bytes a raw-deflate stream inflates to, counted only as far as `cap` + one chunk: the answer is "more than
 * cap" for a bomb, without having made it. null when `bytes` is not deflate at all; undefined when this browser cannot
 * inflate in a stream (then the module's own 1 MiB limit is all there is).
 */
export async function inflatedLength(bytes, cap) {
  if (typeof DecompressionStream !== 'function') return undefined;
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  const fed = writer.write(bytes).then(() => writer.close()).catch(() => {});
  let n = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > cap) {
        await reader.cancel().catch(() => {});
        writer.abort().catch(() => {});
        return n;
      }
    }
  } catch {
    return null;
  } finally {
    await fed;
  }
  return n;
}

/**
 * Whether a link may go to the module: {ok: true}, or {ok: false, error} in words for the banner. `cap` is the most
 * text a link's program (or its notes) may inflate to.
 */
export async function guardLink(input, cap = MAX_LOAD_TEXT) {
  const s = String(input || '');
  if (s.length > MAX_LINK_CHARS) return { ok: false, error: `this link is ${s.length.toLocaleString('en-US')} characters long, and the page opens links of at most ${MAX_LINK_CHARS.toLocaleString('en-US')}` };
  for (const tok of packedCandidates(s)) {
    const bytes = b64uBytes(tok);
    if (!bytes) continue;
    const n = await inflatedLength(bytes, cap);
    if (n != null && n > cap) return { ok: false, error: `the text in this link is larger than ${cap.toLocaleString('en-US')} bytes, and the page opens programs of at most that (the server keeps 16,384). It was not opened` };
  }
  return { ok: true };
}
