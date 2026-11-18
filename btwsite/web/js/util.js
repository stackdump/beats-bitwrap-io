// Small helpers shared by the page's modules. No DOM at import time, so Node can import this.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

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
 * Where the caret goes when the text is replaced by its canonical form: after the same number of
 * non-space code characters (comments, which the canonical form drops, do not count).
 */
export function mapCaret(oldText, caret, newText) {
  const code = (s, upto) => {
    let n = 0;
    let comment = false;
    for (let i = 0; i < upto; i++) {
      const c = s[i];
      if (c === '\n') comment = false;
      else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) comment = true;
      if (!comment && !/\s/.test(c)) n++;
    }
    return n;
  };
  if (caret >= oldText.length) return newText.length;
  let want = code(oldText, caret);
  if (want === 0) return 0;
  let i = 0;
  for (; i < newText.length && want > 0; i++) if (!/\s/.test(newText[i])) want--;
  return i;
}
