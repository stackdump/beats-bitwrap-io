// Syntax highlighting: btw_highlight's spans -> HTML for the <pre> under the textarea.
// Pure. The class names the wasm gives are mapped to a fixed set of CSS classes (c-<name>).

import { esc } from './util.js';

/** The CSS classes the stylesheet knows; an unknown name from the wasm falls back to plain text. */
export const CLASSES = [
  'comment', 'keyword', 'role', 'action', 'deck', 'number', 'step', 'note', 'rest', 'generator',
  'param', 'op', 'punct', 'string', 'word', 'error', 'ident', 'def', 'section',
];

const ALIASES = { operator: 'op', operators: 'op', symbol: 'op', bracket: 'punct', call: 'generator', fn: 'generator', function: 'generator', hit: 'step', name: 'ident' };

export function normClass(c) {
  const k = String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const n = ALIASES[k] || k;
  return CLASSES.includes(n) ? n : 'word';
}

/**
 * HTML for `text` with `spans` ([[start16, end16, class], ...]) wrapped in <span class="c-...">.
 * Spans may arrive unsorted or overlapping; the earlier one wins an overlap. A final newline gets a
 * trailing space so the last empty line keeps its height in a <pre>.
 */
export function spansToHtml(text, spans) {
  const list = [];
  for (const s of spans || []) {
    if (!s || s.length < 3) continue;
    const a = Math.max(0, s[0] | 0);
    const b = Math.min(text.length, s[1] | 0);
    if (b > a) list.push([a, b, normClass(s[2])]);
  }
  list.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
  let out = '';
  let cur = 0;
  for (const [a0, b, cls] of list) {
    const a = Math.max(a0, cur);
    if (b <= a) continue;
    if (a > cur) out += esc(text.slice(cur, a));
    out += `<span class="c-${cls}">${esc(text.slice(a, b))}</span>`;
    cur = b;
  }
  out += esc(text.slice(cur));
  return text.endsWith('\n') || text === '' ? `${out} ` : out;
}

/** What the page uses before the wasm is loaded, or when it fails: only comments are coloured. */
export function plainSpans(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const nl = text.indexOf('\n', i);
    const end = nl < 0 ? text.length : nl;
    // a "#" starts a comment unless it sits inside a word (a sharp: f#, a#4)
    for (let j = i; j < end; j++) {
      if (text[j] === '#' && (j === i || /\s/.test(text[j - 1]))) {
        out.push([j, end, 'comment']);
        break;
      }
    }
    i = end + 1;
  }
  return out;
}
