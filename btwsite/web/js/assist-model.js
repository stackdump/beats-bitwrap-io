// The language service's pure side for the editor (assist.js is the DOM): LSP positions over the editor's UTF-16 text,
// snippets, edits, the hover's markdown, the outline. No DOM, so test/unit.mjs pins it.
//
// The service is djrust's btwls (crates/btwls), reached through the wasm module's BtwLs class: the same server `btwd lsp`
// runs for VS Code and IntelliJ, with positions in UTF-16 code units, which is what JS string offsets are.

/** The LSP position {line, character} of UTF-16 offset `at`. A line ends at "\n", "\r\n" or a lone "\r" (as btwls counts). */
export function lspPos(text, at) {
  at = Math.max(0, Math.min(at, text.length));
  let line = 0;
  let ls = 0;
  for (let i = 0; i < at; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) {
      line++;
      ls = i + 1;
    }
  }
  return { line, character: at - ls };
}

/** The UTF-16 offset of an LSP position (a character past its line's end is the line's end; a line past the text, its end). */
export function offsetOf(text, pos) {
  let line = 0;
  let i = 0;
  while (line < pos.line && i < text.length) {
    const c = text.charCodeAt(i);
    i++;
    if (c === 10 || (c === 13 && text.charCodeAt(i) !== 10)) line++;
  }
  if (line < pos.line) return text.length;
  let end = i;
  while (end < text.length && text.charCodeAt(end) !== 10 && text.charCodeAt(end) !== 13) end++;
  return Math.min(i + pos.character, end);
}

/** The UTF-16 offset of visual column `vcol` on the line starting at `from` (tabs to the next multiple of `tab`). */
export function offsetOfVcol(text, from, vcol, tab = 2) {
  let col = 0;
  let i = from;
  while (i < text.length && text.charCodeAt(i) !== 10 && col < vcol) {
    const c = text.charCodeAt(i);
    col = c === 9 ? col + tab - (col % tab) : col + 1;
    i += c >= 0xd800 && c <= 0xdbff ? 2 : 1;
  }
  return i;
}

/**
 * An LSP snippet as plain text and the range to select after it is inserted: `${1:x}` is `x` (the first one selected),
 * `${1|a,b|}` is `a`, `$1` / `$0` mark the caret. Nested placeholders keep their text.
 */
export function expandSnippet(snippet) {
  let out = '';
  let sel = null; // [start, end] of the lowest-numbered stop (0 last)
  let selN = Infinity;
  const mark = (n, a, b) => {
    const rank = n === 0 ? 1e9 : n;
    if (rank < selN) { selN = rank; sel = [a, b]; }
  };
  let i = 0;
  while (i < snippet.length) {
    const c = snippet[i];
    if (c === '\\' && i + 1 < snippet.length) { out += snippet[i + 1]; i += 2; continue; }
    if (c === '$') {
      let m = /^\$\{(\d+)\|([^|]*)\|\}/.exec(snippet.slice(i));
      if (m) {
        const v = m[2].split(',')[0];
        mark(+m[1], out.length, out.length + v.length);
        out += v; i += m[0].length; continue;
      }
      m = /^\$\{(\d+):/.exec(snippet.slice(i));
      if (m) {
        // the placeholder's text, to its closing brace (nested braces counted)
        let depth = 1;
        let j = i + m[0].length;
        let inner = '';
        while (j < snippet.length && depth > 0) {
          if (snippet[j] === '{') depth++;
          else if (snippet[j] === '}' && --depth === 0) break;
          inner += snippet[j]; j++;
        }
        const v = expandSnippet(inner).text;
        mark(+m[1], out.length, out.length + v.length);
        out += v; i = j + 1; continue;
      }
      m = /^\$(\d+)|^\$\{(\d+)\}/.exec(snippet.slice(i));
      if (m) { mark(+(m[1] ?? m[2]), out.length, out.length); i += m[0].length; continue; }
    }
    out += c; i++;
  }
  return { text: out, sel: sel || [out.length, out.length] };
}

/**
 * LSP TextEdits on `text` as ONE replacement (so the browser's undo takes them back together): {from, to, insert, text}.
 * Edits must not overlap (an LSP rule).
 */
export function mergeEdits(text, edits) {
  const spans = edits.map((e) => ({ a: offsetOf(text, e.range.start), b: offsetOf(text, e.range.end), t: e.newText })).sort((x, y) => x.a - y.a || x.b - y.b);
  if (!spans.length) return { from: 0, to: 0, insert: '', text };
  const from = spans[0].a;
  const to = Math.max(...spans.map((s) => s.b));
  let insert = '';
  let at = from;
  for (const s of spans) {
    insert += text.slice(at, s.a) + s.t;
    at = s.b;
  }
  insert += text.slice(at, to);
  return { from, to, insert, text: text.slice(0, from) + insert + text.slice(to) };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The hover's markdown as safe HTML: ``` fences are code blocks, `x` inline code, blank lines paragraphs. Nothing else is read. */
export function mdToHtml(md) {
  const parts = String(md || '').split(/```[a-z]*\n?/);
  let html = '';
  parts.forEach((p, k) => {
    if (k % 2 === 1) {
      html += `<pre class="as-code">${esc(p.replace(/\n$/, ''))}</pre>`;
      return;
    }
    for (const para of p.split(/\n{2,}/)) {
      const t = para.trim();
      if (!t) continue;
      html += `<p>${esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>')}</p>`;
    }
  });
  return html;
}

/** The outline tree (DocumentSymbol[]) as rows {name, detail, kind, depth, line, character}, in text order. */
export function flattenSymbols(tree, depth = 0, out = []) {
  for (const s of tree || []) {
    const r = s.selectionRange || s.range;
    out.push({ name: s.name, detail: s.detail || '', kind: s.kind, depth, line: r.start.line, character: r.start.character });
    if (s.children) flattenSymbols(s.children, depth + 1, out);
  }
  return out;
}

/** Rows whose name holds `q` in order (a subsequence), names starting with it first. */
export function filterRows(rows, q) {
  const lq = String(q || '').toLowerCase();
  if (!lq) return rows;
  const sub = (s) => { let i = 0; for (const c of s) if (c === lq[i]) i++; return i === lq.length; };
  const hits = rows.filter((r) => sub(r.name.toLowerCase()));
  return [...hits.filter((r) => r.name.toLowerCase().startsWith(lq)), ...hits.filter((r) => !r.name.toLowerCase().startsWith(lq))];
}

/** One letter for an LSP CompletionItemKind / SymbolKind, for the list's icon column. */
export function kindLetter(kind, symbol = false) {
  if (symbol) return ({ 2: 'S', 3: 'B', 13: 'L', 23: 'L', 12: 'D', 26: 'P', 11: 'P', 1: 'F', 4: 'I', 8: 'p', 20: 'K', 18: 'A', 24: 'E', 25: 'W' })[kind] || '·';
  return ({ 3: 'ƒ', 5: 'r', 6: 'L', 9: 'S', 10: '=', 12: 'v', 14: 'k', 15: '⋯', 17: 'F', 20: 'o', 21: 'c', 22: 'L', 25: '$' })[kind] || '·';
}

/** Characters that open completion as they are typed. */
export const TRIGGERS = new Set(['=', ':', '$', '.', '|', '(']);
