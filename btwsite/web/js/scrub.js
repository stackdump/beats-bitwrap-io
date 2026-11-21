// Number and range scrubbing in the editor. A number literal (a tempo, a velocity, a cutoff, a level, the bars of a section,
// the steps of e(k, n), an octave, an effect amount ...), a note (c4, f#3) or a Roman numeral (VI) can be moved without
// typing it:
//
//   Alt/Option + drag on it        right is up; Shift is ten steps a pixel group (coarse)
//   the ⇔ handle beside it         shows on hover: drag it, or turn the wheel over it (Shift: coarse);
//                                  on a range (70..100) or a ramp (2000 -> 8000) a click opens a two-handle slider
//   Alt + ↑ / ↓                    one step at the caret (Shift: ten); also plain ↑ ↓ while exactly that literal is selected
//   Alt + PageUp / PageDown        a range or a ramp: both ends together
//
// What a literal is, its limits, step and unit come from the language service (`btw/numberAt`, djrust's btwls). A value never
// leaves its range and the ends of a range never cross; a candidate the checker refuses is not kept (the last good value
// stays and the reason flashes beside it). While a drag goes on the editor shows a preview and the textarea is untouched, so
// the edit made when it ends is one undo step. When something is playing, the program is evaluated as it changes, the way
// Cmd+Enter does (it lands on the next bar), at most once per throttle interval (stretched when a check is slow).
//
// Off in record mode (app.js does not make it) and with a module that has no language service.

import { Scrub, dragSteps, wheelSteps, rangeOffsets, acceptable, firstHint, Throttle, spell, PX_PER_CHOICE, COARSE } from './scrub-model.js';
import { lineStarts, lineOf, visualCol } from './geometry.js';
import { lspPos, offsetOfVcol } from './assist-model.js';
import { cellXY, hit } from './wrap-model.js';
import { h } from './util.js';

const EVAL_MS = 250;

export class Scrubber {
  /**
   * editor: the Editor. assist: the Assist (its req() reaches the language service). host: {check(text) -> report,
   * baseline() -> {text, report} of the last check, evaluate(text, report) (live: only while playing)}.
   */
  constructor(editor, assist, host) {
    this.ed = editor;
    this.assist = assist;
    this.host = host;
    this.cache = new Map(); // `${text.length}:${offset}` -> info (cleared when the text changes)
    this.cacheText = null;
    this.drag = null;
    this.hover = null; // {info, from, to}
    this.handle = h('button', { type: 'button', class: 'sc-handle', tabindex: '-1', 'aria-hidden': 'true', title: 'Drag, or turn the wheel, to change this value (Shift: coarse). Alt+↑/↓ at the caret.', hidden: true }, '⇔');
    this.flashEl = h('div', { class: 'sc-flash', role: 'alert', hidden: true });
    this.live = h('div', { class: 'sc-live', 'aria-live': 'polite', 'aria-atomic': 'true' });
    this.pop = null;
    editor.code.append(this.handle, this.flashEl);
    editor.root.append(this.live);
    this.evalT = new Throttle((text) => this.tryText(text), EVAL_MS);
    this._wire();
  }

  // ---- the service ---------------------------------------------------------------------------------------

  /** numberAt for UTF-16 offset `at` of the current text, or null. */
  infoAt(at) {
    const t = this.ed.text;
    if (this.cacheText !== t) {
      this.cache.clear();
      this.cacheText = t;
    }
    const k = at;
    if (this.cache.has(k)) return this.cache.get(k);
    const r = this.assist.req('btw/numberAt', { position: lspPos(t, at) });
    const info = r && !r.error && r.range ? r : null;
    this.cache.set(k, info);
    return info;
  }

  /** The info of the literal at the caret, or the one the selection is exactly. */
  infoAtCaret() {
    return this.infoAt(this.ed.ta.selectionStart);
  }

  // ---- wiring ---------------------------------------------------------------------------------------------

  _wire() {
    const code = this.ed.code;
    code.addEventListener('pointermove', (e) => this._hoverMove(e));
    code.addEventListener('pointerleave', (e) => {
      if (!this.drag && e.relatedTarget !== this.handle) this.hideHandle();
    });
    // Alt + drag on the literal itself: before the textarea starts a selection
    code.addEventListener('pointerdown', (e) => {
      if (!e.altKey || e.button !== 0 || this.drag) return;
      const info = this.infoUnder(e);
      if (!info) return;
      e.preventDefault();
      e.stopPropagation();
      this.begin(info, e);
    }, true);
    this.handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.hover) return;
      e.preventDefault();
      e.stopPropagation();
      this.begin(this.hover.info, e, { fromHandle: true });
    });
    this.handle.addEventListener('wheel', (e) => {
      if (!this.hover) return;
      e.preventDefault();
      const steps = wheelSteps(e.deltaY, { coarse: e.shiftKey });
      if (steps) this.nudge(this.hover.info, steps);
    }, { passive: false });
    window.addEventListener('pointermove', (e) => this.drag && this._dragMove(e));
    window.addEventListener('pointerup', (e) => this.drag && this.end(e));
    window.addEventListener('pointercancel', () => this.drag && this.end(null, { cancel: true }));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.drag) { e.preventDefault(); this.end(null, { cancel: true }); }
    });
    document.addEventListener('pointerdown', (e) => {
      if (this.pop && !this.pop.contains(e.target) && e.target !== this.handle) this.closePop();
    });
  }

  /** The literal under a pointer event (code-layer coordinates), or null. */
  infoUnder(e) {
    const r = this.ed.code.getBoundingClientRect();
    const at = hit(this.ed.wrap, e.clientX - r.left, e.clientY - r.top);
    if (!at) return null;
    const t = this.ed.text;
    const starts = lineStarts(t);
    if (at.line >= starts.length) return null;
    const off = offsetOfVcol(t, starts[at.line], at.vcol);
    // the cell must be inside the literal (not just past its end)
    const info = this.infoAt(off);
    if (!info) return null;
    const [from, to] = rangeOffsets(t, info.range);
    return off >= from && off < to ? info : null;
  }

  _hoverMove(e) {
    if (this.drag || this.ed.previewing) return;
    const info = this.infoUnder(e);
    this.ed.ta.style.cursor = info && e.altKey ? 'ew-resize' : '';
    if (!info) {
      if (e.target !== this.handle) this.hideHandle();
      return;
    }
    const t = this.ed.text;
    const [from, to] = rangeOffsets(t, info.range);
    if (this.hover && this.hover.from === from && this.hover.to === to && !this.handle.hidden) return;
    this.hover = { info, from, to };
    this.placeHandle(from, to);
  }

  /** The code-layer position of UTF-16 offset `at`. */
  xy(at) {
    const t = this.ed.text;
    const starts = lineStarts(t);
    const l = lineOf(starts, at);
    return cellXY(this.ed.wrap, l, visualCol(t, starts[l], at));
  }

  /** The handle sits just above the literal's last character, a badge in the gap over the line (it covers no text). */
  placeHandle(from, to) {
    const p = this.xy(Math.max(from, to - 1));
    this.handle.style.left = `${p.x}px`;
    this.handle.style.top = `${p.y - 9}px`;
    this.handle.hidden = false;
  }

  hideHandle() {
    this.handle.hidden = true;
    this.hover = null;
  }

  // ---- a drag ---------------------------------------------------------------------------------------------

  begin(info, e, { fromHandle = false } = {}) {
    this.closePop();
    const text = this.ed.text;
    const b = this.host.baseline();
    const baseline = b && b.text === text ? b.report : this.host.check(text);
    this.drag = { s: new Scrub(text, info), x0: e.clientX, moved: false, fromHandle, baseline, good: text, applied: text };
    this.ed.root.classList.add('scrubbing');
    this.ed.tip.hidden = true;
    try { (e.target.setPointerCapture && e.pointerId != null) && e.target.setPointerCapture(e.pointerId); } catch (_) { /* not capturable */ }
  }

  _dragMove(e) {
    const d = this.drag;
    const dx = e.clientX - d.x0;
    if (Math.abs(dx) >= 3) d.moved = true;
    if (!d.moved) return;
    const per = d.s.info.choices ? PX_PER_CHOICE : undefined;
    d.s.move(dragSteps(dx, { coarse: e.shiftKey, perStep: per }));
    this.show(d);
  }

  /** Preview the scrub's text and hand it to the throttled check-and-evaluate. */
  show(d) {
    const r = d.s.result();
    this.ed.preview(r.text);
    this.placeHandle(r.caret[0], r.caret[1]);
    this.say(d.s.say());
    this.evalT.call(r.text);
  }

  /** Check a candidate; keep it (and evaluate it, while playing) or put the last good one back and say why. */
  tryText(text) {
    const d = this.drag || this.keyDrag;
    if (!d) return;
    if (text === d.good) return;
    const rep = this.host.check(text);
    if (acceptable(rep, d.baseline)) {
      d.good = text;
      if (d.applied !== text) {
        d.applied = text;
        this.host.evaluate(text, rep);
      }
    } else {
      this.flash(firstHint(rep), d);
      if (this.drag) this.ed.preview(d.good);
    }
  }

  end(e, { cancel = false } = {}) {
    const d = this.drag;
    // the newest value is checked (and kept, if it may be) while the drag is still the scrub's
    if (!cancel) this.evalT.flush();
    this.evalT.cancel();
    this.drag = null;
    this.ed.root.classList.remove('scrubbing');
    this.ed.endPreview();
    if (!cancel && d.fromHandle && !d.moved && d.s.span) {
      this.openPop(d.s.info);
      return;
    }
    const keep = cancel ? d.s.text : d.good;
    this.commit(d.s.text, keep, d);
  }

  /** Make the one undoable edit from `before` to `after` (they differ only in the literals the scrub moved). */
  commit(before, after, d) {
    if (after === before) {
      // a cancelled drag that had evaluated a preview plays the text it started from again
      if (d && d.applied !== before) this.host.evaluate(before, d.baseline);
      return;
    }
    let a = 0;
    while (a < before.length && a < after.length && before[a] === after[a]) a++;
    let b = 0;
    while (b < before.length - a && b < after.length - a && before[before.length - 1 - b] === after[after.length - 1 - b]) b++;
    this.ed.applyEdit(a, before.length - b, after.slice(a, after.length - b));
    // the moved literal stays selected, so ↑ ↓ go on moving it
    const info = this.infoAt(a);
    if (info) {
      const [f, t] = rangeOffsets(this.ed.text, info.range);
      this.ed.ta.setSelectionRange(f, t);
    }
    if (d && d.applied !== after) this.host.evaluate(after, this.host.check(after));
  }

  /** One step (or `steps`) of a literal at once: a key or a wheel notch. Each is one undo step. */
  nudge(info, steps, { both = false } = {}) {
    const text = this.ed.text;
    const s = new Scrub(text, info);
    if (both && s.span) {
      const st = info.choices ? 1 : info.step;
      s.setEnds(s.lo + steps * st, s.hi + steps * st, 'span');
    } else {
      s.move(steps, { relative: true });
    }
    const r = s.result();
    if (r.text === text) {
      this.say(`${s.say()} (at its limit)`);
      return;
    }
    const b = this.host.baseline();
    const baseline = b && b.text === text ? b.report : this.host.check(text);
    const rep = this.host.check(r.text);
    if (!acceptable(rep, baseline)) {
      this.flash(firstHint(rep), { s });
      return;
    }
    this.say(s.say());
    this.ed.applyEdit(r.edit.from, r.edit.to, r.edit.text);
    const f = r.caret[0];
    this.ed.ta.setSelectionRange(f, r.caret[1]);
    if (this.hover) this.placeHandle(r.caret[0], r.caret[1]);
    this.host.evaluate(r.text, rep);
  }

  // ---- keys -------------------------------------------------------------------------------------------------

  /** The editor's keydown, first. True: the key was the scrubber's. */
  onKey(e) {
    if (this.drag) return true;
    const ta = this.ed.ta;
    const vertical = e.key === 'ArrowUp' || e.key === 'ArrowDown';
    const page = e.key === 'PageUp' || e.key === 'PageDown';
    if (!vertical && !page) return false;
    if (e.metaKey || e.ctrlKey) return false;
    const info = this.infoAtCaret();
    if (!info) return false;
    const [from, to] = rangeOffsets(this.ed.text, info.range);
    const selected = ta.selectionStart === from && ta.selectionEnd === to && from !== to;
    if (!e.altKey && !(selected && vertical)) return false;
    if (page && !info.span) return false;
    e.preventDefault();
    const up = e.key === 'ArrowUp' || e.key === 'PageUp';
    this.nudge(info, (up ? 1 : -1) * (e.shiftKey ? COARSE : 1), { both: page });
    return true;
  }

  // ---- the range slider -------------------------------------------------------------------------------------

  openPop(info) {
    this.closePop();
    const text = this.ed.text;
    const s = new Scrub(text, info);
    const lo = info.min != null ? info.min : Math.min(s.lo, s.hi) - 10 * info.step;
    const hi = info.max != null ? info.max : Math.max(s.lo, s.hi) + 10 * info.step;
    const log = info.scale === 'log' && lo > 0;
    const toT = (v) => (log ? Math.log(v / lo) / Math.log(hi / lo) : (v - lo) / (hi - lo));
    const fromT = (t) => (log ? lo * (hi / lo) ** t : lo + t * (hi - lo));
    const track = h('div', { class: 'sc-track' });
    const bar = h('div', { class: 'sc-span', title: 'Drag to move both ends' });
    const thumb = (role) => h('div', { class: `sc-thumb sc-${role}`, role: 'slider', tabindex: '0', 'aria-label': `${info.label}: ${role === 'start' ? (info.span.op === '->' ? 'from' : 'low') : (info.span.op === '->' ? 'to' : 'high')}`, 'aria-valuemin': String(lo), 'aria-valuemax': String(hi) });
    const tA = thumb('start');
    const tB = thumb('end');
    const read = h('div', { class: 'sc-read' });
    track.append(bar, tA, tB);
    const pop = h('div', { class: 'sc-pop', role: 'group', 'aria-label': `${info.label} range` }, h('div', { class: 'sc-title' }, info.label), track, read);
    this.ed.code.append(pop);
    this.pop = pop;
    const [f] = rangeOffsets(text, info.span.start);
    const p = this.xy(f);
    pop.style.left = `${Math.max(0, p.x - 8)}px`;
    pop.style.top = `${p.y + this.ed.metrics.lineH + 4}px`;
    const b = this.host.baseline();
    const d = { s, baseline: b && b.text === text ? b.report : this.host.check(text), good: text, applied: text };
    this.keyDrag = d;
    const paint = () => {
      const a = Math.max(0, Math.min(1, toT(s.lo)));
      const z = Math.max(0, Math.min(1, toT(s.hi)));
      tA.style.left = `${a * 100}%`;
      tB.style.left = `${z * 100}%`;
      bar.style.left = `${Math.min(a, z) * 100}%`;
      bar.style.width = `${Math.abs(z - a) * 100}%`;
      const u = info.unit ? ` ${info.unit}` : '';
      read.textContent = `${spell(s.lo, info.decimals)} ${info.span.op} ${spell(s.hi, info.decimals)}${u}`;
      tA.setAttribute('aria-valuenow', String(s.lo));
      tB.setAttribute('aria-valuenow', String(s.hi));
      tA.setAttribute('aria-valuetext', `${spell(s.lo, info.decimals)}${u}`);
      tB.setAttribute('aria-valuetext', `${spell(s.hi, info.decimals)}${u}`);
    };
    const update = () => {
      paint();
      const r = s.result();
      this.ed.preview(r.text);
      this.say(s.say());
      this.evalT.call(r.text);
    };
    const done = () => {
      this.evalT.flush();
      this.evalT.cancel();
      this.ed.endPreview();
      const before = d.s.text;
      const after = d.good;
      d.s = new Scrub(after, info); // later moves start from what was kept
      this.commit(before, after, d);
      // the next drag in the same popover starts from the text now in the editor
      const ni = this.infoAt(rangeOffsets(this.ed.text, info.span.start)[0]);
      if (ni && ni.span) {
        Object.assign(s, new Scrub(this.ed.text, ni));
        d.good = d.applied = this.ed.text;
      }
    };
    const dragOn = (el, which) => {
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.setPointerCapture(e.pointerId);
        const rect = track.getBoundingClientRect();
        const t0 = (e.clientX - rect.left) / rect.width;
        const lo0 = s.lo;
        const hi0 = s.hi;
        const move = (ev) => {
          const t = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
          if (which === 'span') {
            const dt = t - t0;
            const nlo = fromT(toT(lo0) + dt);
            s.setEnds(nlo, nlo + (hi0 - lo0), 'span');
          } else if (which === 'start') s.setEnds(fromT(t), s.hi, 'start');
          else s.setEnds(s.lo, fromT(t), 'end');
          update();
        };
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          done();
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
      });
    };
    dragOn(tA, 'start');
    dragOn(tB, 'end');
    dragOn(bar, 'span');
    const keys = (el, which) => el.addEventListener('keydown', (e) => {
      const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (e.key === 'Escape') { e.preventDefault(); this.closePop(); this.ed.ta.focus(); return; }
      if (!dir) return;
      e.preventDefault();
      const st = (e.shiftKey ? COARSE : 1) * info.step;
      if (which === 'start') s.setEnds(s.lo + dir * st, s.hi, 'start');
      else s.setEnds(s.lo, s.hi + dir * st, 'end');
      update();
      done();
    });
    keys(tA, 'start');
    keys(tB, 'end');
    paint();
    (info.span.role === 'start' ? tA : tB).focus();
  }

  closePop() {
    if (!this.pop) return;
    this.pop.remove();
    this.pop = null;
    this.keyDrag = null;
    this.ed.endPreview();
  }

  // ---- saying -----------------------------------------------------------------------------------------------

  say(text) {
    this.live.textContent = text;
  }

  /** The reason a value was refused, for a moment, beside the literal. */
  flash(msg, d) {
    const el = this.flashEl;
    el.textContent = msg;
    const s = d && d.s;
    if (s) {
      const p = this.xy(s.from);
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y - this.ed.metrics.lineH - 4}px`;
    }
    el.hidden = false;
    this.say(msg);
    clearTimeout(this._flashT);
    this._flashT = setTimeout(() => (el.hidden = true), 2200);
  }
}

