// The editor follows the song. When a section starts the editor scrolls so its block sits near the top
// with its header visible; a section taller than the view follows the lines firing now (a third of the
// way down); a def called from the section comes into view when it fits with it, else its header pulses
// and an edge arrow names it; a ramp or timed line that fires off-screen gets an arrow at the edge with
// its line number. A manual scroll pauses all this for PAUSE_SECS or until the next section; nothing
// scrolls while the text is not the text that was evaluated. (The rules of docs/BTW.md "Seeing it
// play", as the desktop's editor keeps them.)
//
// Pure: no DOM, no clock of its own. The page gives it the marks, the text, the layout and a `now`
// (seconds on any clock that does not go back: the wall clock, or the fake clock of record mode) and it
// answers the scrollTop to set this frame. The ease is a function of `now`, never a CSS behaviour.

import { lineStarts, lineOf, makeByteMapper, spanRange } from './geometry.js';

export const SCROLL_SECS = 0.3;
export const PAUSE_SECS = 8;

const ease = (t) => {
  t = Math.min(1, Math.max(0, t));
  return t * t * (3 - 2 * t);
};

/** layout = {lineTops: [px, ...], lineH, viewH, contentH} in content coordinates. */
const top = (l, line) => l.lineTops[line] ?? l.lineTops[l.lineTops.length - 1] ?? 0;
const bottom = (l, line) => top(l, line) + l.lineH;
const maxOffset = (l) => Math.max(0, l.contentH - l.viewH);

/** The last line of the `{ ... }` block that opens on headerLine (the header's own line when it has none). */
export function blockEnd(text, starts, headerLine) {
  let depth = 0;
  let opened = false;
  for (let i = starts[headerLine]; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 123) {
      depth++;
      opened = true;
    } else if (c === 125) {
      depth--;
      if (opened && depth <= 0) return lineOf(starts, i);
    } else if (c === 10 && !opened) return headerLine;
  }
  return starts.length - 1;
}

/** The first line of the nearest `def` above `line`, when there is one. */
export function defHeader(text, starts, line) {
  for (let l = line; l >= 0; l--) {
    if (/^\s*def\s/.test(text.slice(starts[l], starts[l] + 80))) return l;
  }
  return null;
}

/** Spans of a marks object as UTF-16 ranges, with the helper the callers need. */
function ranger(text) {
  const mapper = makeByteMapper(text);
  return (span) => spanRange(span, mapper);
}

/** The statement a fire sounded in (the span before its call sites), or null. */
export function fireLine(fire) {
  const sp = fire.spans || [];
  const calls = (fire.call_sites || []).length;
  return sp.length > calls ? sp[sp.length - calls - 1] : null;
}

export class Follow {
  constructor() {
    this.on = true;
    this.section = null; // the section header the editor last scrolled for (its start offset)
    this.anim = null;
    this.pause = null; // [until, section]
    this.lastSet = null; // {v, t}
    this.prev = null;
  }

  /** The user scrolled: pause for a while, or until the next section. */
  manual(now) {
    this.anim = null;
    this.pause = [now + PAUSE_SECS, this.section];
  }

  paused(now) {
    return this.pause != null && now < this.pause[0];
  }

  setOn(on) {
    this.on = on;
    this.anim = null;
    this.pause = null;
    if (on) this.section = null; // scroll to the section playing now, as if it had just begun
  }

  /** Forget everything (a new program, a restart). */
  reset() {
    this.section = null;
    this.anim = null;
    this.pause = null;
    this.lastSet = null;
    this.prev = null;
  }

  _geometry(f, starts, rg) {
    const hs = f.marks.header && f.marks.header.span;
    if (!hs) return null;
    const hl = lineOf(starts, rg(hs)[0]);
    const el = blockEnd(f.text, starts, hl);
    return { hl, el };
  }

  _firingLines(f, starts, rg, hl, el, within) {
    const out = [];
    for (const m of f.marks.fires || []) {
      if (!(m.age_beats < 1)) continue;
      const ln = fireLine(m);
      if (!ln) continue;
      const line = lineOf(starts, rg(ln)[0]);
      if (within ? line >= hl && line <= el : true) out.push(line);
    }
    return out;
  }

  _target(f, starts, rg) {
    const g = this._geometry(f, starts, rg);
    if (!g) return null;
    const { hl, el } = g;
    const l = f.layout;
    const t = Math.max(top(l, hl) - l.lineH, 0);
    const b = bottom(l, el) + l.lineH * 0.5;
    let want = t;
    if (b - t > l.viewH) {
      // too tall: the lines firing now, a third of the way down
      const firing = this._firingLines(f, starts, rg, hl, el, true);
      if (firing.length) {
        const y = top(l, Math.max(...firing));
        const inBand = y >= f.offset + l.viewH * 0.15 && y < f.offset + l.viewH * 0.75;
        want = inBand && f.offset >= t ? f.offset : clampRange(y - l.viewH / 3, t, Math.max(b - l.viewH, t));
      } else {
        want = clampRange(f.offset, t, Math.max(b - l.viewH, t));
      }
    } else {
      const d = this._peekDef(f, starts, rg, hl, el, t, b);
      if (d != null) want = d; // the def body fits with the section: start at the def
    }
    return clampRange(want, 0, maxOffset(l));
  }

  _peekDef(f, starts, rg, hl, el, t, b) {
    const l = f.layout;
    let dTop = null;
    for (const line of this._firingLines(f, starts, rg, hl, el, false)) {
      if (line >= hl && line <= el) continue;
      const dh = defHeader(f.text, starts, line);
      if (dh != null) dTop = dTop == null ? top(l, dh) : Math.min(dTop, top(l, dh));
    }
    if (dTop == null) return null;
    const d = Math.max(dTop - l.lineH, 0);
    return d < t && b - d <= l.viewH ? d : null;
  }

  /** The def headers (0-based lines) whose bodies are playing out of the section's reach. */
  defFlash(f) {
    if (!f.fresh) return [];
    const starts = lineStarts(f.text);
    const rg = ranger(f.text);
    const g = this._geometry(f, starts, rg);
    if (!g) return [];
    const out = [];
    for (const line of this._firingLines(f, starts, rg, g.hl, g.el, false)) {
      if (line >= g.hl && line <= g.el) continue;
      const dh = defHeader(f.text, starts, line);
      if (dh != null && !out.includes(dh)) out.push(dh);
    }
    return out;
  }

  /** One frame: the scrollTop to set (null: leave the scroll alone). */
  update(f) {
    if (!this.on || !f.fresh || !f.marks.header || !f.layout.lineTops.length) {
      this.anim = null;
      return null;
    }
    const starts = lineStarts(f.text);
    const rg = ranger(f.text);
    const hs = f.marks.header.span;
    const key = rg(hs)[0];
    const newSection = key !== this.section;
    if (newSection) {
      this.section = key;
      if (this.pause && this.pause[1] !== key) this.pause = null; // the next section lifts a pause
    }
    if (this.paused(f.now)) {
      this.anim = null;
      return null;
    }
    this.pause = null;
    const to = this._target(f, starts, rg);
    if (to != null) {
      const l = f.layout;
      const g = this._geometry(f, starts, rg);
      const tall = bottom(l, g.el) - Math.max(top(l, g.hl) - l.lineH, 0) > l.viewH;
      const moving = this.anim ? this.anim.to : null;
      const retarget = newSection || (tall && (moving == null || Math.abs(moving - to) > l.lineH) && Math.abs(to - f.offset) > l.lineH);
      if (retarget && Math.abs(to - f.offset) > 0.5) this.anim = { from: f.offset, to, t0: f.now };
    }
    const a = this.anim;
    if (!a) return null;
    const t = (f.now - a.t0) / SCROLL_SECS;
    const v = a.from + (a.to - a.from) * ease(t);
    if (t >= 1) this.anim = null;
    this.lastSet = { v, t: f.now };
    return v;
  }

  /** After a scroll event: is it the user's? (A change this follow did not just make.) Returns true when it paused the follow. */
  observe(offset, now) {
    const ours = this.lastSet != null && now - this.lastSet.t < 0.25 && Math.abs(offset - this.lastSet.v) <= 2.5;
    const moved = this.prev != null && Math.abs(this.prev - offset) > 1;
    this.prev = offset;
    if (!ours && moved && this.on) {
      this.manual(now);
      return true;
    }
    return false;
  }

  /** Lines that fired out of view: [{line (1-based), above}]. Ramps and timed lines (control lines fired within two beats) and the defs playing out of view. */
  edges(f) {
    if (!f.fresh) return [];
    const starts = lineStarts(f.text);
    const rg = ranger(f.text);
    const l = f.layout;
    const lines = [];
    for (const c of f.marks.controls || []) {
      if (c.age_beats != null && c.age_beats < 2 && c.span) lines.push(lineOf(starts, rg(c.span)[0]));
    }
    lines.push(...this.defFlash(f));
    const uniq = [...new Set(lines)].sort((a, b) => a - b);
    const out = [];
    for (const line of uniq) {
      const t = top(l, line);
      const b = bottom(l, line);
      if (b <= f.offset) out.push({ line: line + 1, above: true });
      else if (t >= f.offset + l.viewH) out.push({ line: line + 1, above: false });
    }
    return out;
  }
}

function clampRange(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
