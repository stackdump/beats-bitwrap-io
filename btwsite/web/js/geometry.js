// Where things are in the text: line starts, visual columns (tabs expanded), the rectangles a span
// covers, and the conversion of the runtime's UTF-8 byte offsets to JS (UTF-16) offsets.
// Pure functions of strings; the editor, the markers, the follow-scroll and the tests all use them.

export const TAB = 2;

/** UTF-16 offset of the start of every line. */
export function lineStarts(text) {
  const v = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) v.push(i + 1);
  return v;
}

/** 0-based line holding UTF-16 offset `at` (the last line start <= at). */
export function lineOf(starts, at) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= at) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** End of line `line` (offset of its "\n", or the text's end). */
export function lineEnd(text, starts, line) {
  return line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
}

/** The visual column of UTF-16 offset `at` on the line starting at `from`: code points count one column, a tab goes to the next multiple of `tab`. */
export function visualCol(text, from, at, tab = TAB) {
  let col = 0;
  for (let i = from; i < at && i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) break;
    if (c >= 0xdc00 && c <= 0xdfff) continue; // second half of a surrogate pair
    col = c === 9 ? col + tab - (col % tab) : col + 1;
  }
  return col;
}

/** Width of the longest line, in visual columns. */
export function maxCols(text, tab = TAB) {
  let m = 0;
  const starts = lineStarts(text);
  for (let l = 0; l < starts.length; l++) {
    const e = lineEnd(text, starts, l);
    m = Math.max(m, visualCol(text, starts[l], e, tab));
  }
  return m;
}

function firstNonSpace(text, a, b) {
  let i = a;
  while (i < b && (text[i] === ' ' || text[i] === '\t')) i++;
  return i;
}

/**
 * The rectangles (line, c0, c1 in visual columns) a span [a, b) covers. A span inside one line is one
 * rectangle; a longer one (an evolve block) is the first line from `a`, the lines between from their
 * first word to their end, and the last line up to `b`. Blank lines are skipped.
 */
export function rectsForSpan(text, starts, a, b, tab = TAB) {
  if (b < a) [a, b] = [b, a];
  const l0 = lineOf(starts, a);
  const l1 = lineOf(starts, Math.max(a, b - 1));
  const out = [];
  for (let l = l0; l <= l1; l++) {
    const ls = starts[l];
    const le = lineEnd(text, starts, l);
    const from = l === l0 ? a : firstNonSpace(text, ls, le);
    const to = l === l1 ? Math.min(b, le) : le;
    const c0 = visualCol(text, ls, from, tab);
    let c1 = visualCol(text, ls, to, tab);
    if (c1 <= c0 && l === l0 && l === l1) c1 = c0 + 1; // an empty span still shows
    if (c1 > c0) out.push({ line: l, c0, c1 });
  }
  return out;
}

/** UTF-16 offset of a 1-based line and a 1-based column counted in code points; clamped to the line. */
export function offsetOfLineCol(text, starts, line1, col1) {
  const l = Math.min(Math.max(line1 - 1, 0), starts.length - 1);
  const ls = starts[l];
  const le = lineEnd(text, starts, l);
  let off = ls;
  let n = 1;
  while (off < le && n < col1) {
    const c = text.charCodeAt(off);
    off += c >= 0xd800 && c <= 0xdbff && off + 1 < le ? 2 : 1;
    n++;
  }
  return off;
}

/** 1-based {line, col} of a UTF-16 offset (col in code points). */
export function lineColOf(text, starts, at) {
  const l = lineOf(starts, at);
  let col = 1;
  for (let i = starts[l]; i < at && i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff) continue;
    col++;
  }
  return { line: l + 1, col };
}

/** Is every char of `text` ASCII? Then byte offsets are UTF-16 offsets. */
function isAscii(text) {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) return false;
  return true;
}

/** A function that maps a UTF-8 byte offset in `text` to a UTF-16 offset. */
export function makeByteMapper(text) {
  if (isAscii(text)) return (b) => b;
  const map = [];
  let byte = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i);
    const units = cp > 0xffff ? 2 : 1;
    const len = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    for (let k = 0; k < len; k++) map[byte + k] = i;
    byte += len;
    i += units;
  }
  map[byte] = text.length;
  return (b) => (b >= map.length ? text.length : map[b] ?? text.length);
}

/**
 * The [start, end) UTF-16 range of a span from the runtime ({start, end, start16?, end16?}). The wasm
 * layer gives start16/end16; without them the byte offsets are converted.
 */
export function spanRange(span, mapper) {
  if (span.start16 != null && span.end16 != null) return [span.start16, span.end16];
  return [mapper(span.start), mapper(span.end)];
}
