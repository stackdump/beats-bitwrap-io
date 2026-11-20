// The editor's assistant: completion, hover, quick-fixes and refactors (the lightbulb), the outline and go to definition,
// from the language service in the wasm module (BtwLs: djrust's crates/btwls, the server `btwd lsp` runs for VS Code and
// IntelliJ). The editor keeps its own keys; these are added:
//
//   Ctrl+Space          complete at the caret (also opens by itself after = : $ . | and ( )
//   ↑ ↓  Enter / Tab    pick in a list; Esc closes it (and only it: a second Esc stops the program, as before)
//   Alt+Enter           the fixes and refactors at the caret (the 💡 beside a line that has some)
//   Mod+Shift+O         the outline: type to filter, Enter to go
//   F12                 go to the definition of the name at the caret
//
// The squiggles stay the checker's (btw_check): the service adds to the editor, it does not replace what the page had.

import { lspPos, offsetOf, offsetOfVcol, expandSnippet, mergeEdits, mdToHtml, flattenSymbols, filterRows, kindLetter, TRIGGERS } from './assist-model.js';
import { lineStarts, lineOf, visualCol } from './geometry.js';
import { h } from './util.js';
import { cellXY } from './wrap-model.js';

const URI = 'main';
const VISIBLE = 10;

export class Assist {
  /** facade: the wasm facade (its `ls()` makes a BtwLs, or null in the mock). toast(msg, kind): the page's. */
  constructor(editor, facade, toast = () => {}) {
    this.ed = editor;
    this.ls = facade && facade.ls ? facade.ls() : null;
    this.toast = toast;
    this.synced = null;
    this.list = null; // {kind: 'complete'|'actions'|'outline', rows, sel, ...}
    this.pop = h('div', { class: 'as-pop', role: 'listbox', hidden: true });
    this.bulb = h('button', { type: 'button', class: 'as-bulb', title: 'Fixes and refactors (Alt+Enter)', 'aria-label': 'Fixes and refactors', hidden: true }, '💡');
    this.bulb.addEventListener('mousedown', (e) => { e.preventDefault(); this.openActions(); });
    editor.code.append(this.pop, this.bulb);
    this.pop.addEventListener('mousedown', (e) => {
      const row = e.target.closest('[data-i]');
      if (!row || !this.list) return;
      e.preventDefault();
      this.list.sel = +row.dataset.i;
      this.accept();
    });
  }

  get on() {
    return !!this.ls;
  }

  // ---- the service ---------------------------------------------------------------------------------------

  sync() {
    const t = this.ed.text;
    if (this.synced !== t) {
      this.ls.change(URI, t);
      this.synced = t;
    }
    return t;
  }

  req(method, params) {
    const t = this.sync();
    let r;
    try {
      r = JSON.parse(this.ls.request(method, JSON.stringify({ textDocument: { uri: URI }, ...params })));
    } catch (e) {
      console.warn('btw assist:', method, e);
      return null;
    }
    if (r && r.error && Object.keys(r).length === 1) return { error: r.error.message, text: t };
    return r;
  }

  caretPos() {
    return lspPos(this.ed.text, this.ed.ta.selectionStart);
  }

  // ---- editor hooks --------------------------------------------------------------------------------------

  /** The editor's keydown, first. True: the key was the assistant's. */
  onKey(e) {
    if (!this.on) return false;
    const mod = e.metaKey || e.ctrlKey;
    if (this.list) {
      const n = this.list.rows.length;
      const move = (d) => { this.list.sel = (this.list.sel + d + n) % Math.max(n, 1); this.paint(); };
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return true; }
      if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return true; }
      if (e.key === 'PageDown') { e.preventDefault(); move(VISIBLE); return true; }
      if (e.key === 'PageUp') { e.preventDefault(); move(-VISIBLE); return true; }
      if ((e.key === 'Enter' || e.key === 'Tab') && !mod && n) { e.preventDefault(); this.accept(); return true; }
      if (e.key === 'Escape') { e.preventDefault(); this.close(); return true; }
      if (this.list.kind === 'outline') {
        if (e.key === 'Backspace') { e.preventDefault(); this.list.q = this.list.q.slice(0, -1); this.refilter(); return true; }
        if (e.key.length === 1 && !mod && !e.altKey) { e.preventDefault(); this.list.q += e.key; this.refilter(); return true; }
      }
      if (this.list.kind !== 'complete') { this.close(); }
    }
    if (mod && e.key === ' ') { e.preventDefault(); this.complete(); return true; }
    if (e.altKey && e.key === 'Enter') { e.preventDefault(); this.openActions(); return true; }
    if (mod && e.shiftKey && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); this.outline(); return true; }
    if (e.key === 'F12') { e.preventDefault(); this.definition(); return true; }
    return false;
  }

  /** After the text changed by typing: keep an open completion list current, or open one after a trigger character. */
  onInput(programmatic) {
    if (!this.on || programmatic) { this.close(); return; }
    const t = this.ed.text;
    const at = this.ed.ta.selectionStart;
    const ch = t[at - 1];
    if (this.list && this.list.kind === 'complete') {
      if (!ch || /\s/.test(ch) && !this.list.space) this.close();
      else this.complete(true);
    } else if (ch && TRIGGERS.has(ch)) this.complete(true);
  }

  /** The caret moved: the lightbulb where the caret's line has fixes or refactors. */
  onCursor() {
    if (!this.on) return;
    clearTimeout(this._bulbT);
    this._bulbT = setTimeout(() => this.updateBulb(), 120);
  }

  /** Hover text for (line0, vcol) when no diagnostic is there: {title, html} or null. */
  hoverAt(line0, vcol) {
    if (!this.on) return null;
    const t = this.ed.text;
    const starts = lineStarts(t);
    if (line0 >= starts.length) return null;
    const at = offsetOfVcol(t, starts[line0], vcol);
    const r = this.req('textDocument/hover', { position: lspPos(t, at) });
    if (!r || r.error || !r.contents) return null;
    return { html: mdToHtml(r.contents.value) };
  }

  // ---- lists -----------------------------------------------------------------------------------------------

  /** Where the popup goes: under the caret, in the code layer's coordinates. */
  place() {
    const t = this.ed.text;
    const starts = lineStarts(t);
    const at = this.list && this.list.anchor != null ? this.list.anchor : this.ed.ta.selectionStart;
    const l = lineOf(starts, at);
    const p = cellXY(this.ed.wrap, l, visualCol(t, starts[l], at)); // the text soft-wraps: ask the layout
    this.pop.style.left = `${p.x}px`;
    this.pop.style.top = `${p.y + this.ed.metrics.lineH + 2}px`;
  }

  paint() {
    const L = this.list;
    if (!L || !L.rows.length) {
      this.pop.hidden = true;
      return;
    }
    const first = Math.max(0, Math.min(L.sel - Math.floor(VISIBLE / 2), L.rows.length - VISIBLE));
    const shown = L.rows.slice(first, first + VISIBLE);
    const head = L.kind === 'outline' ? [h('div', { class: 'as-q' }, `outline ${L.q ? `· ${L.q}` : '· type to filter'}`)] : [];
    this.pop.replaceChildren(...head, ...shown.map((r, k) => {
      const i = first + k;
      return h('div', { class: `as-row${i === L.sel ? ' sel' : ''}`, role: 'option', 'aria-selected': String(i === L.sel), 'data-i': String(i) },
        h('i', { class: 'as-k' }, r.icon || ''),
        h('span', { class: 'as-l', style: r.depth ? `padding-left:${r.depth * 12}px` : null }, r.label),
        r.detail ? h('span', { class: 'as-d' }, r.detail) : null);
    }), ...(L.rows[L.sel] && L.rows[L.sel].doc ? [h('div', { class: 'as-doc' })] : []));
    const doc = this.pop.querySelector('.as-doc');
    if (doc) doc.innerHTML = mdToHtml(L.rows[L.sel].doc);
    this.pop.hidden = false;
    this.place();
  }

  close() {
    this.list = null;
    this.pop.hidden = true;
  }

  accept() {
    const L = this.list;
    if (!L) return;
    const r = L.rows[L.sel];
    this.close();
    if (r && r.go) r.go();
  }

  // ---- completion ------------------------------------------------------------------------------------------

  complete(auto = false) {
    const res = this.req('textDocument/completion', { position: this.caretPos() });
    const items = (res && res.items) || [];
    if (!items.length) {
      this.close();
      return;
    }
    const t = this.ed.text;
    const rows = items.map((it) => ({
      label: it.label,
      detail: it.detail || '',
      doc: it.documentation ? it.documentation.value : '',
      icon: kindLetter(it.kind),
      go: () => this.insert(it),
    }));
    const range = items[0].textEdit && items[0].textEdit.range;
    const anchor = range ? offsetOf(t, range.start) : this.ed.ta.selectionStart;
    const keep = this.list && this.list.kind === 'complete' ? rows.findIndex((r) => r.label === this.list.rows[this.list.sel]?.label) : -1;
    this.list = { kind: 'complete', rows, sel: Math.max(0, keep), anchor, auto };
    this.paint();
  }

  insert(item) {
    const t = this.ed.text;
    const te = item.textEdit;
    const from = te ? offsetOf(t, te.range.start) : this.ed.ta.selectionStart;
    const to = te ? Math.max(offsetOf(t, te.range.end), this.ed.ta.selectionStart) : this.ed.ta.selectionStart;
    const raw = te ? te.newText : item.insertText || item.label;
    const { text, sel } = item.insertTextFormat === 2 ? expandSnippet(raw) : { text: raw, sel: [raw.length, raw.length] };
    // keep the line's indentation on the lines a snippet adds
    const ls = t.lastIndexOf('\n', from - 1) + 1;
    const lead = /^[ \t]*/.exec(t.slice(ls, from))[0];
    const body = text.replace(/\n/g, `\n${lead}`);
    const shift = (k) => k + (text.slice(0, k).split('\n').length - 1) * lead.length;
    this.ed.applyEdit(from, to, body);
    this.ed.ta.setSelectionRange(from + shift(sel[0]), from + shift(sel[1]));
  }

  // ---- code actions ------------------------------------------------------------------------------------------

  actionsAt() {
    const ta = this.ed.ta;
    const t = this.ed.text;
    const res = this.req('textDocument/codeAction', { range: { start: lspPos(t, ta.selectionStart), end: lspPos(t, ta.selectionEnd) }, context: { diagnostics: [] } });
    return Array.isArray(res) ? res : [];
  }

  updateBulb() {
    const acts = this.actionsAt();
    if (!acts.length) {
      this.bulb.hidden = true;
      return;
    }
    const t = this.ed.text;
    const starts = lineStarts(t);
    const l = lineOf(starts, this.ed.ta.selectionStart);
    const end = l + 1 < starts.length ? starts[l + 1] - 1 : t.length;
    const p = cellXY(this.ed.wrap, l, visualCol(t, starts[l], end) + 1);
    this.bulb.style.left = `${p.x}px`;
    this.bulb.style.top = `${p.y}px`;
    this.bulb.hidden = false;
  }

  openActions() {
    const acts = this.actionsAt();
    if (!acts.length) {
      this.toast('No fixes or refactors here.', 'ok');
      return;
    }
    const rows = acts.map((a) => ({ label: a.title, detail: a.kind === 'quickfix' ? (a.isPreferred ? 'fix' : 'maybe') : a.kind.replace(/^refactor\./, ''), icon: a.kind === 'quickfix' ? '✓' : '↻', go: () => this.run(a) }));
    this.list = { kind: 'actions', rows, sel: 0, anchor: this.ed.ta.selectionStart };
    this.paint();
  }

  run(action) {
    let a = action;
    if (!a.edit) {
      // a refactor: made and proved by the service (the nets must not change)
      let r;
      try { r = JSON.parse(this.ls.request('codeAction/resolve', JSON.stringify(a))); } catch { r = null; }
      if (!r || r.error) {
        this.toast(r && r.error ? r.error.message : 'The refactor could not be made.', 'warn');
        return;
      }
      a = r;
    }
    const edits = a.edit && a.edit.changes && a.edit.changes[URI];
    if (!edits || !edits.length) return;
    const m = mergeEdits(this.ed.text, edits);
    this.ed.applyEdit(m.from, m.to, m.insert);
    this.bulb.hidden = true;
  }

  // ---- outline and definition ------------------------------------------------------------------------------

  outline() {
    const res = this.req('textDocument/documentSymbol', {});
    const all = flattenSymbols(Array.isArray(res) ? res : []);
    if (!all.length) {
      this.toast('Nothing to outline yet.', 'ok');
      return;
    }
    this.list = { kind: 'outline', all, q: '', rows: [], sel: 0, anchor: this.ed.ta.selectionStart };
    this.refilter();
  }

  refilter() {
    const L = this.list;
    const t = this.ed.text;
    L.rows = filterRows(L.all, L.q).map((r) => ({ label: r.name, detail: r.detail, icon: kindLetter(r.kind, true), depth: L.q ? 0 : r.depth, go: () => this.goTo(offsetOf(t, r)) }));
    L.sel = 0;
    this.paint();
  }

  goTo(at) {
    const t = this.ed.text;
    const starts = lineStarts(t);
    const l = lineOf(starts, at);
    this.ed.ta.focus({ preventScroll: true });
    this.ed.ta.setSelectionRange(at, at);
    this.ed.revealLine(l, true);
  }

  definition() {
    const r = this.req('textDocument/definition', { position: this.caretPos() });
    if (!r || r.error || !r.range) {
      this.toast('No definition here.', 'ok');
      return;
    }
    this.goTo(offsetOf(this.ed.text, r.range.start));
  }
}
