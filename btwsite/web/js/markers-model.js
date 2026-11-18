// What to light, as a pure function of (marks JSON, the evaluated text, a time). No DOM, no clock:
// the page paints the result with inline styles, so the same marks and the same time are the same pixels
// (the demo video is rendered frame by frame from this). Colours and rules are the desktop window's
// (docs/BTW.md "Seeing it play"): a quiet green dot on every playing line, bright amber on a line whose
// token just sounded, teal on a control line, red on one that holds something changed; a lamp behind a
// token for a beat, a control line glowing for two, a purple flash for a new generation.

import { lineStarts, lineOf, rectsForSpan, makeByteMapper, spanRange, visualCol, lineEnd } from './geometry.js';
import { fireLine } from './follow.js';

export const COLORS = {
  amber: [0xff, 0xc8, 0x50],
  callAmber: [0xe5, 0xc0, 0x7b],
  green: [0x4c, 0xd0, 0x6a],
  teal: [0x56, 0xb6, 0xc2],
  red: [0xe0, 0x50, 0x50],
  purple: [0xc6, 0x78, 0xdd],
  flash: [0xf0, 0xa8, 0x30],
  stage: [0x0b, 0x0d, 0x12],
  ink: [0xd8, 0xdc, 0xe6],
  inkDark: [0x10, 0x10, 0x14],
};

/** How bright a thing that happened `age` beats ago still is: full at once, gone after `len` beats. */
export const fade = (age, len) => (age == null ? 0 : Math.min(1, Math.max(0, 1 - age / len)));

export const lerp = (a, b, k) => a + (b - a) * k;
export const mix = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
export const rgb = (c) => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
export const rgba = (c, a) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${Math.max(0, Math.min(1, a)).toFixed(3)})`;

/** The look of a token lamp at intensity k: an opaque amber that cools to the stage, with the ink going dark as it warms. */
export function lampStyle(k) {
  return { background: rgb(mix(COLORS.stage, COLORS.amber, k)), color: rgb(mix(COLORS.ink, COLORS.inkDark, Math.min(1, k * 1.25))) };
}

/**
 * opts: {reduced: soften (no strobing: lower peak, longer fade), now: seconds for the one thing that pulses}
 * Returns {gutter: Map(line0 -> {kind,k}), lamps: [{key, layer:'under'|'over', kind, line, c0, c1, k, text}],
 * bars: [{key, kind:'ramp'|'section', line, cols, frac}], header: {line, frac}|null, gen: {n, line, k, flash}|null,
 * defFlash: [line0], ctlLines: [line0]}
 */
export function deriveModel(marks, text, opts = {}) {
  const model = { gutter: new Map(), lamps: [], bars: [], header: null, gen: null, defFlash: [], ctlLines: [] };
  if (!marks || !text) return model;
  const reduced = !!opts.reduced;
  const now = opts.now || 0;
  const starts = lineStarts(text);
  const mapper = makeByteMapper(text);
  const rg = (s) => spanRange(s, mapper);
  const lineAt = (s) => lineOf(starts, rg(s)[0]);
  const tokLen = reduced ? 2 : 1;
  const peak = reduced ? 0.6 : 1;
  const g = model.gutter;
  const dot = (line, kind, k) => g.set(line, { kind, k });

  // a def whose body is playing out of the section's reach: its header pulses
  for (const l of opts.defFlash || []) {
    const k = reduced ? 0.6 : 0.5 + 0.5 * Math.sin(now * 9);
    model.defFlash.push(l);
    model.lamps.push(...rectLamps('under', 'def', text, starts, starts[l], lineEnd(text, starts, l), k * 0.55, `def:${l}`, COLORS.flash));
    dot(l, 'flash', k);
  }
  // lines that are playing: a quiet mark
  for (const s of marks.active_lines || []) dot(lineAt(s), 'play', 0);
  // lines with a token that just sounded: bright, in step; the call sites dimmer
  for (const f of marks.fires || []) {
    const k = fade(f.age_beats, tokLen) * peak;
    if (k <= 0) continue;
    const tok = (f.spans || [])[0];
    const ln = fireLine(f);
    if (ln) dot(lineAt(ln), 'fire', k);
    if (tok) {
      const [a, b] = rg(tok);
      model.lamps.push({ key: `tok:${a}:${b}`, layer: 'over', kind: 'tok', line: lineOf(starts, a), c0: visualCol(text, starts[lineOf(starts, a)], a), c1: visualCol(text, starts[lineOf(starts, a)], b), k, text: text.slice(a, b) });
    }
    for (const c of f.call_sites || []) {
      const [a, b] = rg(c);
      dot(lineOf(starts, a), 'call', k * 0.6);
      model.lamps.push(...rectLamps('under', 'call', text, starts, a, b, k * 0.35, `call:${a}:${b}`, COLORS.amber));
    }
  }
  // the playhead: a bar under the section's header, as far across as the song is through it
  const hd = marks.header;
  if (hd && hd.span) {
    const l = lineAt(hd.span);
    model.header = { line: l, frac: clamp01(hd.progress) };
    model.bars.push({ key: `sec:${l}`, kind: 'section', line: l, cols: 0, frac: clamp01(hd.progress) });
  }
  // control lines: a glow when it fires, a bar under it while it ramps, a mark while it holds
  for (const c of marks.controls || []) {
    if (!c.span) continue;
    const [a, b] = rg(c.span);
    const l = lineOf(starts, a);
    model.ctlLines.push(l);
    const k = fade(c.age_beats, reduced ? 3 : 2) * peak;
    if (k > 0) {
      model.lamps.push(...rectLamps('under', 'ctl', text, starts, a, b, k * 0.42, `ctl:${a}:${b}`, COLORS.teal));
      dot(l, 'ctl', k);
    }
    if (c.progress != null) {
      const cols = Math.max(visualCol(text, starts[l], lineEnd(text, starts, l)), 24);
      model.bars.push({ key: `ramp:${a}`, kind: 'ramp', line: l, cols, frac: clamp01(c.progress) });
      dot(l, 'ramp', 0.5);
    }
    if (c.held) dot(l, 'held', 0.8);
    for (const v of c.via || []) {
      if (k > 0) dot(lineAt(v), 'via', k * 0.6);
    }
  }
  // a new generation: the evolve block and the rules that ran flash, and the number is said
  const ev = marks.evolve_spans || [];
  if (marks.generation != null && ev.length) {
    const first = rg(ev[0]);
    const line = lineOf(starts, first[0]);
    const flash = marks.generation_flash_beats;
    const k = flash == null ? 0 : fade(flash, reduced ? 12 : 6) * peak;
    if (k > 0) for (const s of ev) model.lamps.push(...rectLamps('under', 'evolve', text, starts, ...rg(s), k * 0.43, `ev:${rg(s)[0]}`, COLORS.purple));
    model.gen = { n: marks.generation, line, k, flash: flash != null };
  }
  return model;
}

function clamp01(v) {
  return Math.min(1, Math.max(0, Number(v) || 0));
}

function rectLamps(layer, kind, text, starts, a, b, k, keyBase, color) {
  if (k <= 0) return [];
  return rectsForSpan(text, starts, a, b).map((r, i) => ({ key: `${keyBase}:${i}`, layer, kind, line: r.line, c0: r.c0, c1: r.c1, k, color }));
}
