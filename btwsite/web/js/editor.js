// The editor: a <textarea> with transparent text over a <pre> that holds the highlighted copy, both with
// identical metrics, inside ONE scroll container (the textarea is as tall as its text, so it never scrolls
// itself and nothing needs syncing). Native typing, IME, selection and undo all stay the browser's. The
// text soft-wraps: both layers wrap at the same width with the same hanging indent (`text-indent: <hang>
// hanging each-line`), so they break alike; the editor reads where each long line's rows start off the
// <pre> (`wrap`, a wrap-model.js layout), and the layers under and over the text (lamps, bars, squiggles)
// and the gutter are placed from (line, column) through it.

import { lineStarts, lineEnd, offsetOfLineCol, visualCol, lineOf, TAB } from './geometry.js';
import { buildLayout, cellXY, pieces, hit, lineTop, rowsOf } from './wrap-model.js';
import { spansToHtml, plainSpans } from './highlight.js';
import { h } from './util.js';

/** The hanging indent of a wrapped line's later rows, in columns (the CSS's --hang must say the same). */
export const HANG = 4;

/** The <pre>'s text nodes with the text offset each starts at (its text is the program's, plus maybe a trailing space). */
function textNodes(pre) {
  const out = [];
  const w = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
  let at = 0;
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    out.push({ n, at });
    at += n.data.length;
  }
  return out;
}

const range = typeof document !== 'undefined' ? document.createRange() : null;

/** The top of the character at text offset `i` (its first client rect), or null. */
function charTop(nodes, i) {
  let lo = 0;
  let hi = nodes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (nodes[mid].at <= i) lo = mid;
    else hi = mid - 1;
  }
  const { n, at } = nodes[lo] || {};
  if (!n || i - at >= n.data.length) return null;
  range.setStart(n, i - at);
  range.setEnd(n, i - at + 1);
  const rs = range.getClientRects();
  return rs.length ? rs[rs.length - 1].top : null;
}

/** The visual columns at which the line [a, b) starts a new row: [0, c1, ...], found by bisecting on the characters' tops. */
function measureRows(nodes, text, a, b) {
  const rows = [0];
  let from = a;
  let top = charTop(nodes, a);
  if (top == null) return rows;
  for (let guard = 0; guard < 400; guard++) {
    const lastTop = charTop(nodes, b - 1);
    if (lastTop == null || lastTop <= top + 1) break;
    // the first offset in (from, b) whose top is below `top`
    let lo = from + 1;
    let hi = b - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const t = charTop(nodes, mid);
      if (t != null && t > top + 1) hi = mid;
      else lo = mid + 1;
    }
    rows.push(visualCol(text, a, lo, TAB));
    from = lo;
    top = charTop(nodes, lo);
    if (top == null) break;
  }
  return rows;
}

export class Editor {
  /**
   * root: the .ed element. handlers: {onInput(text), onEval(), onStop(), onCursor(line, col), onToggleFollow()}
   */
  constructor(root, handlers = {}) {
    this.root = root;
    this.on = handlers;
    this.scroller = h('div', { class: 'ed-scroll' });
    this.body = h('div', { class: 'ed-body' });
    this.gutter = h('div', { class: 'ed-gutter', 'aria-hidden': 'true' });
    this.code = h('div', { class: 'ed-code' });
    this.under = h('div', { class: 'ly ly-under', 'aria-hidden': 'true' });
    this.pre = h('pre', { class: 'ly ly-hl', 'aria-hidden': 'true' });
    this.over = h('div', { class: 'ly ly-over', 'aria-hidden': 'true' });
    this.bars = h('div', { class: 'ly ly-bars', 'aria-hidden': 'true' });
    this.diagLayer = h('div', { class: 'ly ly-diag', 'aria-hidden': 'true' });
    this.ta = h('textarea', {
      class: 'ed-ta', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', wrap: 'soft',
      'aria-label': 'BeatScript program', 'aria-describedby': 'ed-help', rows: '1',
    });
    this.measure = h('span', { class: 'ed-measure', 'aria-hidden': 'true' }, 'MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM');
    this.tip = h('div', { class: 'ed-tip', role: 'tooltip', hidden: true });
    this.edges = h('div', { class: 'ed-edges' });
    this.code.append(this.under, this.pre, this.over, this.bars, this.diagLayer, this.ta);
    this.body.append(this.gutter, this.code);
    this.scroller.append(this.body);
    // the measuring span is 64 cells wide: outside the scroller (in .ed, which clips), so it never widens what scrolls
    root.append(this.scroller, this.edges, this.tip, this.measure);
    this.metrics = { charW: 8, lineH: 21, padTop: 10, padLeft: 12, hang: HANG };
    this.wrap = buildLayout([], this.metrics);
    this.lines = 0;
    this.rows = []; // gutter rows
    this.diags = [];
    this.spansFn = null; // (text) => spans, set once the wasm is up
    this._tabEscape = false;
    this._text = '';
    this._wire();
    this.measureNow();
    this.setText('');
  }

  get text() {
    return this._text;
  }

  setHighlighter(fn) {
    this.spansFn = fn;
    this.render();
  }

  // ---- metrics --------------------------------------------------------------------------------

  measureNow() {
    const cs = getComputedStyle(this.pre);
    const w = this.measure.getBoundingClientRect().width / this.measure.textContent.length;
    const lh = parseFloat(cs.lineHeight) || 21;
    this.metrics = { charW: w || 8, lineH: lh, padTop: parseFloat(cs.paddingTop) || 0, padLeft: parseFloat(cs.paddingLeft) || 0, hang: HANG };
    this.code.style.setProperty('--cw', `${this.metrics.charW}px`);
    this.code.style.setProperty('--lh', `${this.metrics.lineH}px`);
    this._size();
  }

  /** {lineTops, lineH, viewH, contentH} for the follow-scroll, in scroller content coordinates. */
  layout() {
    const { lineH } = this.metrics;
    if (!this._tops || this._tops.length !== this.lines) this._tops = this.wrap.lines.map((l) => l.top);
    return { lineTops: this._tops, lineH, viewH: this.scroller.clientHeight, contentH: this.scroller.scrollHeight };
  }

  /** Where each line's rows start, read off the highlighted <pre> (the browser wrapped it), then the code layer's
   *  height and the gutter rows from that. A line that fits the width is one row and is not measured. */
  _size() {
    const { lineH, padTop, charW, padLeft } = this.metrics;
    const text = this._text;
    const starts = lineStarts(text);
    const avail = this.pre.clientWidth - padLeft * 2;
    const rowStarts = new Array(starts.length);
    let nodes = null;
    for (let l = 0; l < starts.length; l++) {
      const a = starts[l];
      const b = lineEnd(text, starts, l);
      if (avail <= 0 || visualCol(text, a, b) * charW <= avail + 0.5) continue;
      nodes = nodes || textNodes(this.pre);
      rowStarts[l] = measureRows(nodes, text, a, b);
    }
    this.wrap = buildLayout(rowStarts, this.metrics);
    this.code.style.height = `${padTop * 2 + this.wrap.height + lineH * 4}px`;
    this.code.style.removeProperty('min-width');
    this._tops = null;
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      const n = rowsOf(this.wrap, i);
      if (r.n !== n) {
        r.n = n;
        r.row.style.height = n > 1 ? `${n * lineH}px` : '';
      }
    }
  }

  // ---- text -----------------------------------------------------------------------------------

  /** Replace the whole text (loading a program). Resets undo; for edits the user can undo use replaceUndoable. */
  setText(text) {
    this._text = text;
    if (this.ta.value !== text) this.ta.value = text;
    this.render();
    this.ta.scrollTop = 0;
    this.ta.scrollLeft = 0;
  }

  /** Replace all text so the browser's undo stack keeps the old text (fmt, compose into the editor). */
  replaceUndoable(text) {
    this.ta.focus({ preventScroll: true });
    this.ta.select();
    const ok = typeof document.execCommand === 'function' && document.execCommand('insertText', false, text);
    if (!ok) {
      this.ta.value = text;
      this._text = text;
      this.render();
    } else {
      this._text = this.ta.value;
      this.render();
    }
    this.on.onInput && this.on.onInput(this._text, { programmatic: true });
  }

  /**
   * Show `text` without touching the textarea: a scrub in progress (scrub.js). The textarea keeps the text the scrub started
   * from, so the one edit the scrub makes when it ends is one undo step; until endPreview(), `text` is the preview (what a
   * check or an evaluation reads) and the highlighted layer draws it.
   */
  preview(text) {
    this.previewing = true;
    this._text = text;
    this.render();
  }

  /** Back to the textarea's own text (the scrub ended, or was abandoned). */
  endPreview() {
    if (!this.previewing) return;
    this.previewing = false;
    this._text = this.ta.value;
    this.render();
  }

  /** Replace [from, to) with `text` as ONE undoable edit (the browser's undo stack keeps the old text), caret just after it. */
  applyEdit(from, to, text) {
    const ta = this.ta;
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(from, to);
    const ok = typeof document.execCommand === 'function' && document.execCommand('insertText', false, text);
    if (!ok) {
      ta.setRangeText(text, from, to, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const at = from + text.length;
    ta.setSelectionRange(at, at);
    this.previewing = false;
    this._text = ta.value;
    this.render();
    this._revealCaret();
    this.on.onInput && this.on.onInput(this._text, { programmatic: true });
  }

  render() {
    const text = this._text;
    const starts = lineStarts(text);
    this.lines = starts.length;
    let spans;
    try {
      spans = this.spansFn ? this.spansFn(text) : plainSpans(text);
    } catch {
      spans = plainSpans(text);
    }
    this.pre.innerHTML = spansToHtml(text, spans);
    this._syncGutter();
    this._size();
    this._paintDiagnostics();
  }

  _syncGutter() {
    const n = this.lines;
    while (this.rows.length < n) {
      const i = this.rows.length;
      const row = h('div', { class: 'gl' }, h('i', { class: 'gi' }), h('b', {}, String(i + 1)), h('u', { class: 'gd' }));
      this.gutter.append(row);
      this.rows.push({ row, gi: row.firstChild, gd: row.lastChild, kind: '', k: -1, sev: '', hdr: false, n: 1 });
    }
    while (this.rows.length > n) this.rows.pop().row.remove();
  }

  // ---- gutter dots (called every frame; only changes touch the DOM) ------------------------------------

  setGutter(map, headerLine) {
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      const d = map && map.get(i);
      const kind = d ? d.kind : '';
      const k = d ? Math.round(d.k * 8) / 8 : 0;
      if (r.kind !== kind || r.k !== k) {
        r.kind = kind;
        r.k = k;
        if (kind) {
          r.gd.dataset.kind = kind;
          r.gd.style.setProperty('--k', String(k));
        } else {
          delete r.gd.dataset.kind;
          r.gd.style.removeProperty('--k');
        }
      }
      const hdr = headerLine === i;
      if (r.hdr !== hdr) {
        r.hdr = hdr;
        r.row.classList.toggle('sec-hdr', hdr);
      }
    }
  }

  // ---- diagnostics -------------------------------------------------------------------------------

  setDiagnostics(diags) {
    this.diags = diags || [];
    this._paintDiagnostics();
  }

  _paintDiagnostics() {
    const text = this._text;
    const starts = lineStarts(text);
    const { lineH } = this.metrics;
    this.diagLayer.textContent = '';
    for (const r of this.rows) r.sev = '';
    const sevRank = (s) => (s === 'error' ? 2 : 1);
    for (const d of this.diags) {
      const l = d.line - 1;
      if (l < 0 || l >= starts.length) continue;
      const a = offsetOfLineCol(text, starts, d.line, d.col);
      const endCol = d.end_col && d.end_col > d.col ? d.end_col : d.col + 1;
      let b = offsetOfLineCol(text, starts, d.line, endCol);
      if (b <= a) b = Math.min(a + 1, text.length);
      const c0 = visualCol(text, starts[l], a);
      let c1 = visualCol(text, starts[l], b);
      if (c1 <= c0) c1 = c0 + 1;
      for (const p of pieces(this.wrap, l, c0, c1)) {
        const sq = h('div', { class: `sq sq-${d.severity === 'warning' ? 'warn' : 'error'}` });
        sq.style.left = `${p.x}px`;
        sq.style.top = `${p.y + lineH - 3}px`;
        sq.style.width = `${p.w}px`;
        this.diagLayer.append(sq);
      }
      const row = this.rows[l];
      if (row && sevRank(d.severity) > sevRank(row.sev)) row.sev = d.severity;
    }
    for (const r of this.rows) {
      const want = r.sev === 'error' ? 'error' : r.sev ? 'warn' : '';
      if (r.gi.dataset.sev !== want) {
        if (want) r.gi.dataset.sev = want;
        else delete r.gi.dataset.sev;
      }
    }
  }

  /** The diagnostic under (line0, vcol), or null. */
  diagAt(line0, vcol) {
    const text = this._text;
    const starts = lineStarts(text);
    for (const d of this.diags) {
      if (d.line - 1 !== line0) continue;
      const a = offsetOfLineCol(text, starts, d.line, d.col);
      const endCol = d.end_col && d.end_col > d.col ? d.end_col : d.col + 1;
      const b = offsetOfLineCol(text, starts, d.line, endCol);
      const c0 = visualCol(text, starts[line0], a);
      const c1 = Math.max(visualCol(text, starts[line0], b), c0 + 1);
      if (vcol >= c0 && vcol < c1) return d;
    }
    return null;
  }

  // ---- movement ------------------------------------------------------------------------------------

  /** Put the caret at a 1-based line:col, select a span if given, and scroll it into view. */
  jumpTo(line, col, endCol) {
    const text = this._text;
    const starts = lineStarts(text);
    const a = offsetOfLineCol(text, starts, line, col);
    const b = endCol ? offsetOfLineCol(text, starts, line, endCol) : a;
    this.ta.focus({ preventScroll: true });
    this.ta.setSelectionRange(a, Math.max(a, b));
    this.revealLine(line - 1, true);
  }

  /** Scroll so line0 is inside the view (or near the top third when `center`). */
  revealLine(line0, center = false) {
    const { lineH } = this.metrics;
    const sc = this.scroller;
    const y = lineTop(this.wrap, line0);
    if (center || y < sc.scrollTop + lineH || y + lineH * 2 > sc.scrollTop + sc.clientHeight) {
      sc.scrollTop = Math.max(0, y - sc.clientHeight / 3);
    }
  }

  caretLineCol() {
    const text = this._text;
    const starts = lineStarts(text);
    const at = this.ta.selectionStart;
    const l = lineOf(starts, at);
    return { line: l, vcol: visualCol(text, starts[l], at) };
  }

  _revealCaret() {
    const { lineH } = this.metrics;
    const { line, vcol } = this.caretLineCol();
    const sc = this.scroller;
    const y = cellXY(this.wrap, line, vcol).y; // the caret's row (the text wraps: there is no sideways scroll)
    if (y < sc.scrollTop) sc.scrollTop = y - lineH;
    else if (y + lineH * 2 > sc.scrollTop + sc.clientHeight) sc.scrollTop = y + lineH * 2 - sc.clientHeight;
  }

  focus() {
    this.ta.focus({ preventScroll: true });
  }

  // ---- events --------------------------------------------------------------------------------------

  _wire() {
    const ta = this.ta;
    ta.addEventListener('input', () => {
      this._hoverKey = null;
      this._text = ta.value;
      this.render();
      ta.scrollTop = 0;
      ta.scrollLeft = 0;
      this._revealCaret();
      this.on.onInput && this.on.onInput(this._text, { programmatic: false });
    });
    ta.addEventListener('scroll', () => {
      ta.scrollTop = 0;
      ta.scrollLeft = 0;
    });
    ta.addEventListener('keydown', (e) => this._key(e));
    ta.addEventListener('keyup', (e) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) this._revealCaret();
    });
    const cursor = () => {
      const { line, vcol } = this.caretLineCol();
      this.on.onCursor && this.on.onCursor(line, vcol, this.diagAt(line, vcol));
    };
    document.addEventListener('selectionchange', () => {
      if (document.activeElement === ta) cursor();
    });
    // a diagnostic's message where the pointer rests
    this.code.addEventListener('pointermove', (e) => this._hover(e));
    this.code.addEventListener('pointerleave', () => (this.tip.hidden = true));
    if (typeof ResizeObserver !== 'undefined') {
      // a font change (the measure span) or a new width (the code layer: the text wraps again)
      let lastW = -1;
      const ro = new ResizeObserver(() => {
        const w = this.code.clientWidth;
        const fontChanged = this.measure.getBoundingClientRect().width / this.measure.textContent.length !== this.metrics.charW;
        if (w === lastW && !fontChanged) return;
        lastW = w;
        this.measureNow();
        this._paintDiagnostics();
        this.on.onLayout && this.on.onLayout();
      });
      ro.observe(this.measure);
      ro.observe(this.code);
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { this.measureNow(); this._paintDiagnostics(); });
  }

  _hover(e) {
    const r = this.code.getBoundingClientRect();
    const at = hit(this.wrap, e.clientX - r.left, e.clientY - r.top);
    const line = at ? at.line : -1;
    const vcol = at ? at.vcol : -1;
    const d = at && this.diags.length ? this.diagAt(line, vcol) : null;
    const er = this.root.getBoundingClientRect();
    if (!d) {
      // what the word under the pointer is (assist.js), asked once per cell
      const key = `${line}:${vcol}`;
      if (this._hoverKey !== key) {
        this._hoverKey = key;
        this._hoverInfo = line >= 0 && vcol >= 0 && this.on.onHoverInfo ? this.on.onHoverInfo(line, vcol) : null;
      }
      if (!this._hoverInfo) {
        this.tip.hidden = true;
        return;
      }
      this.tip.innerHTML = this._hoverInfo.html; // built from escaped text by assist-model.mdToHtml
      this.tip.classList.add('as-hover');
    } else {
      this.tip.classList.remove('as-hover');
      this.tip.replaceChildren(h('strong', {}, `${d.line}:${d.col} ${d.severity || 'error'}`), h('span', {}, ` ${d.message}`), ...(d.help ? [h('em', {}, /^did you mean/i.test(d.help) ? d.help : `did you mean: ${d.help}`)] : []));
    }
    this.tip.hidden = false;
    const x = Math.min(Math.max(8, e.clientX - er.left + 12), Math.max(8, er.width - this.tip.offsetWidth - 8));
    this.tip.style.left = `${x}px`;
    this.tip.style.top = `${Math.min(e.clientY - er.top + 18, er.height - this.tip.offsetHeight - 6)}px`;
  }

  _key(e) {
    // the assistant's keys first (assist.js: completion, Alt+Enter, Mod+Shift+O, F12, and Esc while one of its lists is open)
    if (this.on.onKey && this.on.onKey(e)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      this.on.onEval && this.on.onEval();
      return;
    }
    if (e.key === 'Escape' || (mod && e.key === '.')) {
      e.preventDefault();
      this._tabEscape = true;
      this.on.onStop && this.on.onStop();
      return;
    }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      if (this._tabEscape) {
        this._tabEscape = false;
        return; // Esc then Tab leaves the editor
      }
      e.preventDefault();
      this._indent(e.shiftKey);
      return;
    }
    this._tabEscape = false;
    if (e.key === 'Enter' && !mod && !e.shiftKey && !e.isComposing) {
      const ta = this.ta;
      if (ta.selectionStart === ta.selectionEnd) {
        e.preventDefault();
        const text = this._text;
        const at = ta.selectionStart;
        const ls = text.lastIndexOf('\n', at - 1) + 1;
        const lead = /^[ \t]*/.exec(text.slice(ls, at))[0];
        const before = text.slice(ls, at).trimEnd();
        const extra = before.endsWith('{') ? '  ' : '';
        this._insert(`\n${lead}${extra}`);
      }
    }
  }

  _insert(s) {
    const ta = this.ta;
    if (!(typeof document.execCommand === 'function' && document.execCommand('insertText', false, s))) {
      const a = ta.selectionStart;
      ta.setRangeText(s, a, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  _indent(back) {
    const ta = this.ta;
    const text = ta.value;
    const a = ta.selectionStart;
    const b = ta.selectionEnd;
    if (a === b && !back) return this._insert('  ');
    const ls = text.lastIndexOf('\n', a - 1) + 1;
    const block = text.slice(ls, b);
    const out = block.split('\n').map((l) => (back ? l.replace(/^( {1,2}|\t)/, '') : `  ${l}`)).join('\n');
    ta.setSelectionRange(ls, b);
    this._insert(out);
    ta.setSelectionRange(ls, ls + out.length);
  }
}
