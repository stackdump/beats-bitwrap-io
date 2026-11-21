// Number and range scrubbing, the pure side (scrub.js is the DOM). What a literal is, its limits, step and unit come from
// the language service's `btw/numberAt` (djrust crates/btwls/src/number.rs): an `info` here is that answer. Everything below
// is a function of numbers and strings, pinned in test/unit.mjs.
//
// The rules: a value never leaves [min, max]; an integer stays whole; the two ends of a range (a..b) or a ramp (a -> b) never
// cross; a note or a numeral moves through the service's `choices`; the text written is the canonical spelling (`btw fmt`'s:
// the shortest plain decimal, so a scrub keeps a canonical program canonical).

import { offsetOf } from './assist-model.js';

/** Pixels of drag per step. */
export const PX_PER_STEP = 6;
/** Pixels of drag per choice (a note, a numeral). */
export const PX_PER_CHOICE = 14;
/** The factor Shift gives (coarse). */
export const COARSE = 10;

/** The canonical text of `v` rounded to `decimals` places (djlive::print::num: no exponent, no trailing zeros, no -0). */
export function spell(v, decimals = 0) {
  const p = 10 ** Math.max(0, Math.min(6, decimals | 0));
  let r = Math.round(v * p) / p;
  if (Object.is(r, -0) || r === 0) r = 0;
  if (Number.isInteger(r)) return String(r);
  // toFixed then trim: never an exponent for the magnitudes a program has
  return r.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '');
}

/** `v` held to the literal's limits: [min, max], whole when it is an integer, rounded to its decimals. */
export function clampValue(info, v) {
  if (!Number.isFinite(v)) v = info.value;
  if (info.min != null) v = Math.max(info.min, v);
  if (info.max != null) v = Math.min(info.max, v);
  if (info.integer) v = Math.round(v);
  const p = 10 ** (info.decimals || 0);
  return Math.round(v * p) / p;
}

/** The value `steps` steps from `v` (a step is info.step; a log-scale number, a cutoff, moves by a ratio: 12 steps an octave). */
export function stepValue(info, v, steps) {
  if (info.scale === 'log' && v > 0) {
    const f = 2 ** (steps / 12);
    const nv = v * f;
    // at least one whole step when it moves at all, so a small cutoff does not stick
    const moved = Math.abs(nv - v) < info.step ? v + Math.sign(steps) * info.step : nv;
    return clampValue(info, roundNice(moved));
  }
  return clampValue(info, v + steps * info.step);
}

/** A cutoff as people write it: 2 significant figures under 1k, 3 above (440, 2150, 12300). */
function roundNice(v) {
  const digits = v >= 1000 ? 3 : 2;
  const m = 10 ** Math.max(0, Math.floor(Math.log10(Math.abs(v))) + 1 - digits);
  return Math.round(v / m) * m;
}

/** Steps for a pointer moved `dx` pixels (right is up), Shift coarse. */
export function dragSteps(dx, { coarse = false, perStep = PX_PER_STEP } = {}) {
  const s = Math.trunc(dx / perStep);
  return coarse ? s * COARSE : s;
}

/** Steps for a wheel event's deltaY (up is up), one notch one step. */
export function wheelSteps(deltaY, { coarse = false } = {}) {
  const s = deltaY < 0 ? 1 : deltaY > 0 ? -1 : 0;
  return coarse ? s * COARSE : s;
}

/** The choice `steps` from index `i`, held to the list. */
export function stepChoice(info, i, steps) {
  const n = (info.choices || []).length;
  return Math.max(0, Math.min(n - 1, i + steps));
}

/** UTF-16 [from, to) of an LSP range in `text`. */
export function rangeOffsets(text, r) {
  return [offsetOf(text, r.start), offsetOf(text, r.end)];
}

/** The text of the literal for value `v` (or choice index `v` for a note or a numeral). */
export function literalText(info, v) {
  if (info.choices) return info.choices[stepChoice(info, v, 0)];
  return spell(v, info.decimals || 0);
}

/**
 * A scrub in progress: one literal (or both ends of a range) moved from where it started. `text` is the program when the
 * scrub began; every value is applied to that text, so the result changes only the literal(s) and nothing else.
 */
export class Scrub {
  constructor(text, info) {
    this.text = text;
    this.info = info;
    [this.from, this.to] = rangeOffsets(text, info.range);
    this.start = info.choices ? info.index : info.value;
    this.value = this.start;
    const sp = info.span;
    if (sp) {
      this.span = { op: sp.op, ordered: sp.ordered, role: sp.role, a: rangeOffsets(text, sp.start), b: rangeOffsets(text, sp.end), lo: sp.startValue, hi: sp.endValue };
      this.lo = sp.startValue;
      this.hi = sp.endValue;
    }
  }

  /** The value `steps` from where the scrub started (drag) or from where it is now (`relative`: keys, wheel). */
  move(steps, { relative = false } = {}) {
    const base = relative ? this.value : this.start;
    const info = this.info;
    let v = info.choices ? stepChoice(info, base, steps) : stepValue(info, base, steps);
    if (this.span && !info.choices) v = this.keepOrder(v, this.span.role);
    this.value = v;
    if (this.span) {
      if (this.span.role === 'start') this.lo = v;
      else this.hi = v;
    }
    return v;
  }

  /** `v` for one end of the range, held so it does not cross the other end (a ramp keeps its direction). */
  keepOrder(v, role) {
    const s = this.span;
    const other = role === 'start' ? this.hi : this.lo;
    const up = s.ordered || s.hi >= s.lo; // a range is lo..hi; a ramp keeps the way it was written
    if (role === 'start') return up ? Math.min(v, other) : Math.max(v, other);
    return up ? Math.max(v, other) : Math.min(v, other);
  }

  /** Set both ends of a range (the slider): `which` is 'start', 'end' or 'span' (both by the same amount). */
  setEnds(lo, hi, which) {
    const info = this.info;
    if (which === 'span') {
      // the width is kept; the span stops at the limits
      const w = this.span.hi - this.span.lo;
      let a = clampValue(info, lo);
      let b = clampValue(info, a + w);
      if (b - a !== w) {
        b = clampValue(info, hi);
        a = clampValue(info, b - w);
      }
      [this.lo, this.hi] = [a, b];
    } else if (which === 'start') {
      this.lo = this.keepOrder(clampValue(info, lo), 'start');
    } else {
      this.hi = this.keepOrder(clampValue(info, hi), 'end');
    }
    this.value = this.span.role === 'start' ? this.lo : this.hi;
    return [this.lo, this.hi];
  }

  /** The program with the scrub applied: {text, edits: [{from, to, text}], caret: [from, to) of the moved literal}. */
  result() {
    if (this.span && (this.lo !== this.span.lo || this.hi !== this.span.hi)) {
      const ta = spell(this.lo, this.info.decimals || 0);
      const tb = spell(this.hi, this.info.decimals || 0);
      const [a0, a1] = this.span.a;
      const [b0, b1] = this.span.b;
      const text = this.text.slice(0, a0) + ta + this.text.slice(a1, b0) + tb + this.text.slice(b1);
      const shift = ta.length - (a1 - a0);
      const caret = this.span.role === 'start' ? [a0, a0 + ta.length] : [b0 + shift, b0 + shift + tb.length];
      return { text, edit: { from: a0, to: b1, text: ta + this.text.slice(a1, b0) + tb }, caret };
    }
    const lit = literalText(this.info, this.value);
    const text = this.text.slice(0, this.from) + lit + this.text.slice(this.to);
    return { text, edit: { from: this.from, to: this.to, text: lit }, caret: [this.from, this.from + lit.length] };
  }

  get changed() {
    return this.result().text !== this.text;
  }

  /** What a screen reader hears: "tempo 126 bpm", "velocity 90 to 110", "note d4". */
  say() {
    const i = this.info;
    if (this.span) return `${i.label} ${spell(this.lo, i.decimals)} to ${spell(this.hi, i.decimals)}${i.unit ? ` ${i.unit}` : ''}`;
    return `${i.label} ${literalText(i, this.value)}${!i.choices && i.unit ? ` ${i.unit}` : ''}`;
  }
}

/**
 * Is a candidate program acceptable to keep? A check that is ok always is; when the program did not check before the scrub
 * (an error elsewhere), one with no more errors than it had is, so a broken line elsewhere does not freeze every number.
 */
export function acceptable(report, baseline) {
  if (!report) return false;
  if (report.ok) return true;
  return !!baseline && !baseline.ok && (report.errors | 0) <= (baseline.errors | 0);
}

/** The first error of a report as one line (the hint a refused scrub flashes). */
export function firstHint(report) {
  const d = ((report && report.diagnostics) || []).find((x) => x.severity !== 'warning' && x.severity !== 'info');
  if (!d) return 'that value is refused';
  return d.help ? `${d.message} (${d.help})` : d.message;
}

/**
 * At most one call each `ms` (the first at once, the last always delivered), on an injected clock so the tests drive it.
 * `ms` may grow: `stretch(cost)` sets the interval to twice what the last call took, so a slow check is not stacked up.
 */
export class Throttle {
  constructor(fn, ms, { now = () => Date.now(), setTimer = (f, t) => setTimeout(f, t), clearTimer = (h) => clearTimeout(h) } = {}) {
    Object.assign(this, { fn, ms, base: ms, now, setTimer, clearTimer });
    this.last = -Infinity;
    this.timer = null;
    this.pending = null;
  }

  call(...args) {
    this.pending = args;
    const wait = this.last + this.ms - this.now();
    if (wait <= 0) return this.flush();
    if (!this.timer) this.timer = this.setTimer(() => { this.timer = null; this.flush(); }, wait);
    return undefined;
  }

  flush() {
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
    if (!this.pending) return undefined;
    const args = this.pending;
    this.pending = null;
    const t0 = this.now();
    this.last = t0;
    const r = this.fn(...args);
    this.stretch(this.now() - t0);
    return r;
  }

  stretch(cost) {
    this.ms = Math.max(this.base, 2 * cost);
  }

  cancel() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.pending = null;
  }
}
