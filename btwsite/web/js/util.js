// Small helpers shared by the page's modules. No DOM at import time, so Node can import this.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---- what may come in from outside the editor ------------------------------------------------------------------------

/**
 * The most text a program loaded from outside the editor (a link, the server, an assistant's push) may have. The server
 * stores programs of at most 16 KiB; the page takes twice that. The checker costs real time (a 6 KB program of evolve
 * blocks takes about 2.7 s, in the page's one thread), so what a stranger's link or push can hand it has a bound.
 */
export const MAX_LOAD_TEXT = 32768;
/**
 * The most text the programs a link carries (`*` and their bundle: what its program imports, with what those import) may inflate to
 * together. They are only read when the program imports them, and each is hashed against its CID, so this is larger than one
 * program's bound: four of the biggest programs the server keeps.
 */
export const MAX_LINK_BUNDLE = 4 * 16384;
/** The longest link (characters) the page will look at. A 32 KiB program deflates to well under this. */
export const MAX_LINK_CHARS = 262144;
/** A CID: base58btc, `z...`. Anything that goes into a URL path as a CID is checked against this first. */
export const CID_RE = /^z[1-9A-HJ-NP-Za-km-z]{20,120}$/;
/** An example's name (examples/<name>.btw): no slash, no leading dot, so it cannot name another path. */
export const EXAMPLE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A session id as the server makes it. */
export const SESSION_RE = /^[A-Za-z0-9_-]{6,64}$/;

/** `s` cut to `n` characters, with an ellipsis. */
export function trunc(s, n = 300) {
  const t = String(s);
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

/**
 * A name from outside (a stored program's `#! name:`, an example's title) made safe to put in a title or a header:
 * control characters and the invisible/bidirectional marks that make text read as something else are dropped, runs of
 * white space become one space, and it is cut to `n`.
 */
export function cleanName(s, n = 80) {
  // eslint-disable-next-line no-control-regex
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g, ' ').replace(/\s+/g, ' ').trim();
  return trunc(t, n);
}

/**
 * Whether a program's own header says it is private (`#! visibility: private`). Such a program stays in this page: it is
 * not sent to the server to be streamed and stored, and it is not in the state the page reports to an assistant. (The
 * checker flags `use restricted` and sample/loop assets itself; this header is a comment to it.)
 */
export function marksPrivate(text) {
  return /^#!\s*visibility:\s*private\b/im.test(String(text ?? ''));
}

/** Whether a `location.hostname` is this machine (the only place the page's `?mock=1` stand-in may run). */
export function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost');
}

export function debounce(fn, ms) {
  let t = 0;
  const d = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.flush = (...a) => {
    clearTimeout(t);
    fn(...a);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** A DOM element in one call: h('button', {class:'x', onclick}, 'text', child). */
export function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return e;
}

/** How a user signed in, in words: "a wallet" or "a browser key". */
export const accountKind = (u) => (u && u.kind === 'eth' ? 'a wallet' : u && u.kind === 'ed25519' ? 'a browser key' : 'a key');

/** 83.2 -> "1:23" */
export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '–:––';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "z4EBG9jDzsE2U…7PCukZ" for a long CID. */
export function shortCid(cid, head = 6, tail = 6) {
  if (!cid) return '';
  return cid.length <= head + tail + 1 ? cid : `${cid.slice(0, head)}…${cid.slice(-tail)}`;
}

export function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function unhex(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Where the caret goes when the text is replaced by its formatted form: after the same number of non-space code characters
 * (comments do not count, in either text: the formatter keeps them, an older module's canonical form drops them).
 */
export function mapCaret(oldText, caret, newText) {
  // walks `s` from the start, calling `f(i)` at each code character (not a space, not in a comment) until it says stop
  const eachCode = (s, upto, f) => {
    let comment = false;
    for (let i = 0; i < upto; i++) {
      const c = s[i];
      if (c === '\n') comment = false;
      else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) comment = true;
      if (!comment && !/\s/.test(c) && f(i) === false) return;
    }
  };
  if (caret >= oldText.length) return newText.length;
  let want = 0;
  eachCode(oldText, caret, () => { want++; });
  if (want === 0) return 0;
  let at = newText.length;
  eachCode(newText, newText.length, (i) => { if (--want > 0) return true; at = i + 1; return false; });
  return at;
}
