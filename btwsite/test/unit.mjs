// Unit tests for the page's pure JavaScript (no npm: node:test and node:assert).
//   node --test btwsite/test/unit.mjs
// Where the real wasm is built (btwsite/web/wasm, which is never in git) the follow-scroll, the markers and the
// highlighter are tested against the real runtime; without it those tests run on the page's JS mock.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(here, '..', 'web');
const J = (f) => import(pathToFileURL(path.join(web, 'js', f)).href);

const { WavStream, wavHeader } = await J('wav.js');
const { spansToHtml, plainSpans, normClass } = await J('highlight.js');
const geo = await J('geometry.js');
const { Follow, SCROLL_SECS, PAUSE_SECS, blockEnd } = await J('follow.js');
const { deriveModel, fade, lampStyle, COLORS } = await J('markers-model.js');
const errs = await J('errors.js');
const { headerModel, sectionIndex, programName } = await J('header-model.js');
const { StreamPlayer } = await J('stream-player.js');
const { mapCaret } = await J('util.js');
const { makeFacade } = await J('wasm.js');
const mockMod = (await J('wasm-mock.js')).mockModule();

// the real wasm when it is built, else the mock
let realWasm = false;
let facade;
{
  const glue = path.join(web, 'wasm', 'btw.js');
  if (fs.existsSync(glue) && !process.env.BTW_MOCK_WASM) {
    const m = await import(pathToFileURL(glue).href);
    m.initSync({ module: fs.readFileSync(path.join(web, 'wasm', 'btw_bg.wasm')) });
    facade = makeFacade(m);
    realWasm = true;
  } else facade = makeFacade(mockMod);
}
console.log(`# markers/follow tests run on the ${realWasm ? 'REAL wasm' : 'JS mock'}`);

// ---------------------------------------------------------------------------------------------------------------
// the streaming WAV parser
// ---------------------------------------------------------------------------------------------------------------

function pcm16(frames, ch = 2, seed = 1) {
  const b = new Uint8Array(frames * ch * 2);
  const dv = new DataView(b.buffer);
  let x = seed;
  for (let i = 0; i < frames * ch; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    dv.setInt16(i * 2, (x % 65536) - 32768, true);
  }
  return b;
}
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

test('wav: a whole stream in one chunk', () => {
  const body = pcm16(1000);
  const w = new WavStream();
  const out = w.push(cat(wavHeader(), body));
  assert.equal(out.frames, 1000);
  assert.equal(w.header.sampleRate, 44100);
  assert.equal(w.header.channels, 2);
  assert.equal(w.header.dataSize, null, 'unknown size 0xFFFFFFFF is a stream');
  const dv = new DataView(body.buffer);
  assert.equal(out.channels[0][0], dv.getInt16(0, true) / 32768);
  assert.equal(out.channels[1][999], dv.getInt16(999 * 4 + 2, true) / 32768);
});

test('wav: any chunking gives the same samples (header split, half frames, one byte at a time)', () => {
  const body = pcm16(5000);
  const stream = cat(wavHeader(), body);
  const whole = new WavStream().push(stream);
  for (const sizes of [[1], [3], [7, 5, 11], [44], [45], [4410], [100000]]) {
    const w = new WavStream();
    const parts = [[], []];
    let pos = 0;
    let i = 0;
    while (pos < stream.length) {
      const n = Math.min(sizes[i++ % sizes.length], stream.length - pos);
      const o = w.push(stream.subarray(pos, pos + n));
      pos += n;
      if (o) o.channels.forEach((c, k) => parts[k].push(c));
    }
    for (let k = 0; k < 2; k++) {
      const all = new Float32Array(parts[k].reduce((n, x) => n + x.length, 0));
      let p = 0;
      for (const x of parts[k]) { all.set(x, p); p += x.length; }
      assert.deepEqual(all, whole.channels[k], `sizes ${sizes}`);
    }
    assert.equal(w.seconds, 5000 / 44100);
  }
});

test('wav: a finite data size stops at it; extra chunks before data are skipped; 32-bit float works', () => {
  const body = pcm16(100);
  const w = new WavStream();
  const o = w.push(cat(wavHeader({ dataSize: 100 * 4 }), body, new Uint8Array(40)));
  assert.equal(o.frames, 100, 'bytes after the data chunk are ignored');
  // a LIST chunk between fmt and data
  const h = wavHeader();
  const list = new Uint8Array(8 + 6);
  list.set([0x4c, 0x49, 0x53, 0x54], 0);
  new DataView(list.buffer).setUint32(4, 6, true);
  const w2 = new WavStream();
  const o2 = w2.push(cat(h.subarray(0, 36), list, h.subarray(36), pcm16(10)));
  assert.equal(o2.frames, 10);
  // float32
  const f = new Float32Array([0.5, -0.25, 1, -1]);
  const w3 = new WavStream();
  const o3 = w3.push(cat(wavHeader({ format: 3, bits: 32 }), new Uint8Array(f.buffer)));
  assert.deepEqual([...o3.channels[0]], [0.5, 1]);
  assert.deepEqual([...o3.channels[1]], [-0.25, -1]);
});

test('wav: not a WAV, or a format it cannot read, is refused in words', () => {
  assert.throws(() => new WavStream().push(new TextEncoder().encode('<html>not audio at all</html>')), /not a WAV/);
  assert.throws(() => new WavStream().push(wavHeader({ bits: 24 })), /not supported/);
});

// ---------------------------------------------------------------------------------------------------------------
// highlight overlay mapping + geometry
// ---------------------------------------------------------------------------------------------------------------

test('highlight: spans become classed html, text is escaped, gaps stay plain, overlaps do not duplicate text', () => {
  const t = 'a<b & "c"\n';
  const html = spansToHtml(t, [[0, 1, 'word'], [1, 2, 'operator'], [2, 3, 'bogus-class'], [6, 9, 'string']]);
  assert.match(html, /<span class="c-word">a<\/span>/);
  assert.match(html, /<span class="c-op">&lt;<\/span>/);
  assert.match(html, /<span class="c-word">b<\/span>/, 'an unknown class falls back to plain');
  assert.match(html, /&amp; /);
  assert.ok(html.endsWith(' '), 'a text ending in a newline gets a trailing space so the last line keeps its height');
  // text content survives every shape of spans
  const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'");
  for (const spans of [[], [[0, 3, 'word'], [2, 5, 'number']], [[5, 99, 'word'], [0, 0, 'word']], [[4, 2, 'word']]]) {
    assert.equal(strip(spansToHtml(t, spans)).replace(/ $/, ''), t.replace(/\n$/, '\n'), JSON.stringify(spans));
  }
  assert.equal(normClass('Operator'), 'op');
  assert.equal(normClass('generator'), 'generator');
});

test('highlight: the plain fallback colours only comments, and not a sharp inside a word', () => {
  const t = 'key f#m # a comment\nbass a#2 x\n# whole line\n';
  const spans = plainSpans(t);
  assert.deepEqual(spans.map(([a, b]) => t.slice(a, b)), ['# a comment', '# whole line']);
});

test('highlight: the real btw_highlight covers the text exactly and speaks only the 14 classes', { skip: !realWasm }, () => {
  const text = fs.readFileSync(path.join(here, '..', 'examples', 'markers-demo.btw'), 'utf8');
  const spans = facade.highlight(text);
  assert.ok(spans.length > 50);
  const known = new Set(['comment', 'keyword', 'role', 'action', 'deck', 'number', 'step', 'rest', 'generator', 'param', 'operator', 'word', 'string', 'error']);
  let prev = 0;
  for (const [a, b, c] of spans) {
    assert.ok(known.has(c), `class ${c}`);
    assert.ok(a >= prev && b > a && b <= text.length, `span ${a}..${b}`);
    prev = b;
  }
  const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  assert.equal(strip(spansToHtml(text, spans)), `${text} `);
  // the keyword span for "tempo" starts at the text's "tempo"
  const tempo = text.indexOf('tempo');
  assert.ok(spans.some(([a, b, c]) => a === tempo && b === tempo + 5 && c === 'keyword'));
});

test('geometry: lines, visual columns with tabs, and rectangles for one-line and many-line spans', () => {
  const t = 'ab\n\tcd ef\n  gh {\n    x\n  }\n';
  const st = geo.lineStarts(t);
  assert.deepEqual(st, [0, 3, 10, 17, 23, 27]);
  assert.equal(geo.lineOf(st, 0), 0);
  assert.equal(geo.lineOf(st, 3), 1);
  assert.equal(geo.lineOf(st, 9), 1);
  assert.equal(geo.lineOf(st, 10), 2);
  assert.equal(geo.visualCol(t, 3, 4), 2, 'a tab is two columns');
  assert.equal(geo.visualCol(t, 3, 5), 3);
  assert.equal(geo.maxCols(t), 7);
  assert.deepEqual(geo.rectsForSpan(t, st, 4, 6), [{ line: 1, c0: 2, c1: 4 }]);
  // a block from the `{` on line 2 to the `}` on line 4
  const open = t.indexOf('{');
  const close = t.lastIndexOf('}') + 1;
  assert.deepEqual(geo.rectsForSpan(t, st, open, close), [{ line: 2, c0: 5, c1: 6 }, { line: 3, c0: 4, c1: 5 }, { line: 4, c0: 2, c1: 3 }]);
  assert.deepEqual(geo.rectsForSpan(t, st, 1, 1), [{ line: 0, c0: 1, c1: 2 }], 'an empty span still shows one cell');
  assert.equal(geo.offsetOfLineCol(t, st, 2, 3), 5);
  assert.deepEqual(geo.lineColOf(t, st, 5), { line: 2, col: 3 });
});

test('geometry: UTF-8 byte offsets become UTF-16 offsets (the runtime counts bytes, JS counts code units)', () => {
  const t = 'é # ☃ x 😀 y\n';
  const m = geo.makeByteMapper(t);
  const enc = new TextEncoder();
  for (const ch of ['x', 'y', '#']) {
    const i = t.indexOf(ch);
    const byte = enc.encode(t.slice(0, i)).length;
    assert.equal(m(byte), i, ch);
  }
  assert.equal(geo.makeByteMapper('plain')(3), 3, 'ASCII text is the identity');
  assert.deepEqual(geo.spanRange({ start: 1, end: 2, start16: 7, end16: 9 }, (x) => x), [7, 9], 'start16/end16 win when present');
  assert.deepEqual(geo.spanRange({ start: 1, end: 2 }, m), [m(1), m(2)]);
  // a column in code points: the emoji is one column but two code units
  const st = geo.lineStarts(t);
  assert.equal(geo.visualCol(t, 0, t.indexOf('y')), 10);
});

// ---------------------------------------------------------------------------------------------------------------
// the follow-scroll rules, on a program and a fake clock (the desktop's tests, ported)
// ---------------------------------------------------------------------------------------------------------------

const LINE_H = 20;
const VIEW_H = 200;

function program(pad) {
  let t = 'tempo 124\nkey am\nsection one 4 bars {\n  deck A: kick x ~ ~ ~ x ~ ~ ~\n}\n';
  for (let i = 0; i < pad; i++) t += `# pad ${i}\n`;
  t += 'section two 4 bars {\n  deck A: kick x ~ x ~\n  master: filter lp 300 -> 2800 over 4 bars\n  at bar 2: master: reverb 0.3\n}\n';
  t += 'section three 4 bars {\n  deck A: kick x x x x\n}\narrange one two three\n';
  for (let i = 0; i < 40; i++) t += `# tail ${i}\n`;
  return t;
}
const layoutOf = (text, viewH) => {
  const n = text.split('\n').length - 1;
  return { lineTops: Array.from({ length: n }, (_, i) => i * LINE_H), lineH: LINE_H, viewH, contentH: n * LINE_H };
};
const lineIdx = (text, starts) => text.split('\n').findIndex((l) => l.trimStart().startsWith(starts));

class Run {
  constructor(text) {
    this.run = facade.newRun();
    this.text = text;
    const ev = this.run.eval(text);
    assert.ok(ev.ok, JSON.stringify(ev.diagnostics));
    this.beat = 8;
    this.playing = { A: false, B: false };
    this.step(0); // the start commands
  }
  step(db = 0.25) {
    this.beat += db;
    const cmds = this.run.service({ deck: 'A', beat: this.beat, bpm: 124, playing: { ...this.playing } });
    for (const c of cmds) if (c.op === 'play') this.playing[c.deck] = !!c.on;
    return (this.beat * 60) / 124;
  }
  marks() { return this.run.marks(); }
  headerStart() { const h = this.marks().header; return h ? (h.span.start16 ?? h.span.start) : null; }
  until(name) {
    const at = this.text.indexOf(`section ${name}`);
    for (let i = 0; i < 4000; i++) {
      const t = this.step();
      if (this.headerStart() === at) return t;
    }
    throw new Error(`never reached section ${name}`);
  }
}

/** One editor frame: the follow's answer applied to the offset, as the scroller would. */
function frame(f, run, layout, st, now) {
  const marks = run.marks();
  const fr = { marks, text: run.text, layout, offset: st.offset, fresh: true, now };
  const v = f.update(fr);
  if (v != null) { st.offset = v; f.observe(v, now); } else f.observe(st.offset, now);
  return v;
}

test('follow: a new section scrolls so its header sits near the top, in about 300 ms, and then leaves the scroll alone', () => {
  const text = program(20);
  const layout = layoutOf(text, VIEW_H);
  const run = new Run(text);
  const f = new Follow();
  const st = { offset: 0 };
  let now = run.until('one');
  frame(f, run, layout, st, now);
  assert.equal(st.offset, 0);
  now = run.until('two');
  const header = lineIdx(text, 'section two');
  const want = header * LINE_H - LINE_H;
  const first = frame(f, run, layout, st, now);
  assert.ok(first != null && first >= 0 && first < want, `it starts moving, not jumping: ${first} of ${want}`);
  const mid = frame(f, run, layout, st, now + SCROLL_SECS / 2);
  assert.ok(mid > first && mid < want, `halfway: ${mid}`);
  const end = frame(f, run, layout, st, now + SCROLL_SECS + 0.01);
  assert.ok(Math.abs(end - want) < 0.01, `${end} vs ${want}`);
  assert.equal(frame(f, run, layout, st, now + 0.5), null);
  assert.ok((header + 4) * LINE_H + LINE_H <= st.offset + VIEW_H, 'the whole block is in view');
  const t3 = run.until('three');
  frame(f, run, layout, st, t3);
  const there = frame(f, run, layout, st, t3 + SCROLL_SECS + 0.01);
  assert.ok(Math.abs(there - (lineIdx(text, 'section three') * LINE_H - LINE_H)) < 0.01);
});

test('follow: a manual scroll pauses for eight seconds or until the next section; within a section the pause holds', () => {
  const text = program(20);
  const layout = layoutOf(text, VIEW_H);
  const run = new Run(text);
  const f = new Follow();
  const st = { offset: 0 };
  const now = run.until('two');
  frame(f, run, layout, st, now);
  frame(f, run, layout, st, now + SCROLL_SECS + 0.01);
  const followed = st.offset;
  const t = now + 1;
  st.offset = followed + 150;
  assert.equal(f.observe(st.offset, t), true, 'a scroll the follow did not make is the user\'s');
  assert.ok(f.paused(t + PAUSE_SECS - 0.1) && !f.paused(t + PAUSE_SECS + 0.1));
  const t3 = run.until('three');
  assert.ok(t3 < t + PAUSE_SECS, 'the third section starts inside the pause');
  assert.notEqual(frame(f, run, layout, st, t3), null, 'the next section lifts the pause and scrolls');
  const again = t3 + 1;
  f.observe(st.offset + 90, again);
  const held = { offset: st.offset + 90 };
  assert.equal(frame(f, run, layout, held, again + 0.5), null);
  assert.equal(held.offset, st.offset + 90);
});

test('follow: nothing scrolls while the text differs from the evaluated text or follow is off; switching on goes to the playing section', () => {
  const text = program(20);
  const layout = layoutOf(text, VIEW_H);
  const run = new Run(text);
  const f = new Follow();
  const st = { offset: 0 };
  const now = run.until('two');
  const marks = run.marks();
  const edited = `${text}# a thought\n`;
  const fr = { marks, text: edited, layout, offset: 0, fresh: false, now };
  assert.equal(f.update(fr), null);
  assert.deepEqual(f.edges(fr), []);
  assert.deepEqual(f.defFlash(fr), []);
  f.setOn(false);
  assert.equal(frame(f, run, layout, st, now), null);
  f.setOn(true);
  assert.notEqual(frame(f, run, layout, st, now + 1), null);
});

test('follow: a section taller than the view follows the lines firing now', () => {
  const text = program(20);
  const layout = layoutOf(text, 3 * LINE_H);
  const run = new Run(text);
  const f = new Follow();
  const st = { offset: 0 };
  const now = run.until('two');
  frame(f, run, layout, st, now);
  frame(f, run, layout, st, now + SCROLL_SECS + 0.01);
  const first = lineIdx(text, 'section two');
  const top = first * LINE_H - LINE_H;
  const bottom = (first + 4) * LINE_H + LINE_H;
  assert.ok(st.offset >= top - 0.01 && st.offset + 3 * LINE_H <= bottom + 0.01, `${st.offset} within ${top}..${bottom}`);
  const kick = (first + 1) * LINE_H;
  assert.ok(run.marks().fires.length > 0, 'something fired');
  assert.ok(kick >= st.offset - 0.01 && kick < st.offset + 3 * LINE_H + 0.01, `the kick line at ${kick}, view ${st.offset}..${st.offset + 3 * LINE_H}`);
});

test('follow: a ramp or timed line that fires off-screen gets an edge arrow with its line number, up or down', () => {
  const text = program(20);
  const layout = layoutOf(text, VIEW_H);
  const run = new Run(text);
  const f = new Follow();
  run.until('two');
  const marks = run.marks();
  const fr = { marks, text, layout, offset: 0, fresh: true, now: 0 };
  const filter = lineIdx(text, 'master: filter') + 1;
  assert.ok(f.edges(fr).some((e) => e.line === filter && e.above === false), JSON.stringify(f.edges(fr)));
  assert.deepEqual(f.edges({ ...fr, offset: (lineIdx(text, 'section two') - 1) * LINE_H }), []);
  assert.ok(f.edges({ ...fr, offset: lineIdx(text, 'section three') * LINE_H }).some((e) => e.line === filter && e.above === true));
});

test('follow: a def body playing out of reach flashes its header (and an arrow names it)', () => {
  const text = `tempo 124\nkey am\ndef groove(deck) {\n  deck $deck: kick x ~ x ~\n}\n${'# pad\n'.repeat(30)}section one 8 bars {\n  groove(A)\n}\narrange one\n`;
  const layout = layoutOf(text, VIEW_H);
  const run = new Run(text);
  const f = new Follow();
  run.until('one');
  let flashed = false;
  for (let i = 0; i < 16 && !flashed; i++) {
    run.step();
    const fr = { marks: run.marks(), text, layout, offset: 0, fresh: true, now: 0 };
    if (JSON.stringify(f.defFlash(fr)) === '[2]') {
      flashed = true;
      const low = { ...fr, offset: lineIdx(text, 'section one') * LINE_H };
      assert.ok(f.edges(low).some((e) => e.line === 3 && e.above), JSON.stringify(f.edges(low)));
    }
  }
  assert.ok(flashed, "the def's header (line 3) flashes while its body plays");
});

test('follow: blockEnd finds the closing brace of nested blocks', () => {
  const t = 'section a 4 bars {\n  repeat 2 {\n    x\n  }\n}\nnext\n';
  const st = geo.lineStarts(t);
  assert.equal(blockEnd(t, st, 0), 4);
  assert.equal(blockEnd(t, st, 5), 5, 'a line with no block is its own end');
});

// ---------------------------------------------------------------------------------------------------------------
// markers: a pure function of (marks, text, time)
// ---------------------------------------------------------------------------------------------------------------

test('markers: the gutter dots follow the desktop rules (later draws win: control > fire > playing; red for held)', () => {
  const text = 'a x\nb y\nc z\nd w\ne v\n';
  const sp = (start, end) => ({ start, end, start16: start, end16: end });
  const line = (n) => sp(n * 4, n * 4 + 3);
  const marks = {
    header: { span: line(0), progress: 0.25 },
    active_lines: [line(1), line(2), line(3)],
    fires: [{ deck: 'A', role: 'kick', age_beats: 0.25, spans: [sp(6, 7), line(1)], call_sites: [] }],
    controls: [{ line: 'ramp', span: line(2), via: [], age_beats: 0.5, progress: 0.4, held: false }, { line: 'held', span: line(3), via: [], age_beats: null, progress: null, held: true }],
    generation: null, generation_flash_beats: null, evolve_spans: [],
  };
  const m = deriveModel(marks, text, { now: 0 });
  assert.equal(m.gutter.get(1).kind, 'fire');
  assert.equal(m.gutter.get(1).k, 0.75);
  assert.equal(m.gutter.get(2).kind, 'ramp', 'a ramping control line is teal');
  assert.equal(m.gutter.get(3).kind, 'held', 'a line holding something changed is red');
  assert.equal(m.gutter.get(4), undefined);
  assert.equal(m.header.line, 0);
  const bars = Object.fromEntries(m.bars.map((b) => [b.kind, b]));
  assert.equal(bars.section.frac, 0.25);
  assert.equal(bars.ramp.frac, 0.4);
  assert.equal(bars.ramp.line, 2);
  // a token lamp at the token, brighter when younger
  const tok = m.lamps.find((l) => l.kind === 'tok');
  assert.deepEqual([tok.line, tok.c0, tok.c1, tok.k, tok.text], [1, 2, 3, 0.75, 'y']);
  // the control line's glow: fades over two beats
  const glow = m.lamps.find((l) => l.kind === 'ctl');
  assert.ok(Math.abs(glow.k - 0.75 * 0.42) < 1e-9);
});

test('markers: intensity is f(age): fade over one beat for a token, two for a control line, six for a generation', () => {
  assert.equal(fade(0, 1), 1);
  assert.equal(fade(0.5, 1), 0.5);
  assert.equal(fade(1, 1), 0);
  assert.equal(fade(3, 2), 0);
  assert.equal(fade(null, 2), 0);
  assert.equal(fade(3, 6), 0.5);
  const dim = lampStyle(0.1);
  const bright = lampStyle(1);
  assert.notEqual(dim.background, bright.background);
  assert.equal(bright.background, `rgb(${COLORS.amber.join(',')})`);
});

test('markers: the same marks and time give the identical model; reduced motion softens and never strobes', () => {
  const text = 'tempo 120\nkick x\n';
  const sp = (start, end) => ({ start, end, start16: start, end16: end });
  const marks = { header: null, active_lines: [], fires: [{ deck: 'A', role: 'kick', age_beats: 0.1, spans: [sp(15, 16), sp(10, 16)], call_sites: [] }], controls: [], generation: 2, generation_flash_beats: 1, evolve_spans: [sp(10, 16)] };
  assert.deepEqual(deriveModel(marks, text, { now: 3.5, defFlash: [1] }), deriveModel(marks, text, { now: 3.5, defFlash: [1] }));
  const full = deriveModel(marks, text, { reduced: false, now: 0 });
  const soft = deriveModel(marks, text, { reduced: true, now: 0 });
  assert.ok(full.lamps.find((l) => l.kind === 'tok').k > soft.lamps.find((l) => l.kind === 'tok').k, 'softer peak');
  assert.equal(full.gen.n, 2);
  // the pulse of a def flash is a function of time (so a fake clock can step it), and constant when reduced
  const a = deriveModel(marks, text, { reduced: false, now: 0.1, defFlash: [0] }).gutter.get(0).k;
  const b = deriveModel(marks, text, { reduced: false, now: 0.3, defFlash: [0] }).gutter.get(0).k;
  assert.notEqual(a, b);
  assert.equal(deriveModel(marks, text, { reduced: true, now: 0.1, defFlash: [0] }).gutter.get(0).k, deriveModel(marks, text, { reduced: true, now: 9, defFlash: [0] }).gutter.get(0).k);
});

test('markers: against the real runtime on a fake clock, token lamps and dots appear on the lines that play', () => {
  const text = program(0).replace(/(# tail \d+\n)+/, '');
  const run = new Run(text);
  run.until('one');
  let lit = 0;
  let dots = 0;
  for (let i = 0; i < 24; i++) {
    run.step(0.25);
    const m = deriveModel(run.marks(), text, { now: i });
    lit += m.lamps.filter((l) => l.kind === 'tok').length;
    dots += m.gutter.size;
    for (const l of m.lamps) assert.ok(l.line >= 0 && l.line < text.split('\n').length && l.c1 > l.c0, JSON.stringify(l));
  }
  assert.ok(lit > 0, 'a kick sounded in 6 beats, so a token lamp lit');
  assert.ok(dots > 0);
});

// ---------------------------------------------------------------------------------------------------------------
// words for errors, the header row, small helpers
// ---------------------------------------------------------------------------------------------------------------

test('errors: the API error shape becomes the sentences the page shows', () => {
  const E = (status, code, extra = {}) => errs.apiErrorFrom(status, { error: { code, message: 'm', ...extra } }, null);
  assert.equal(errs.describeError(E(429, 'rate_limited', { retry_after: 37.2 })).title, 'rate limited, try again in 38 s');
  assert.equal(errs.describeError(errs.apiErrorFrom(429, { error: { code: 'rate_limited' } }, '12')).title, 'rate limited, try again in 12 s', 'Retry-After header counts');
  assert.match(errs.describeError(E(401, 'auth_required')).title, /^signed-in only/);
  assert.equal(errs.describeError(E(503, 'not_configured')).title, 'compose is not configured on this server');
  assert.match(errs.describeError(E(503, 'spend_cap')).title, /budget/);
  assert.match(errs.describeError(E(429, 'busy', { retry_after: 5 })).title, /render slots are busy, try again in 5 s/);
  assert.equal(errs.describeError(new Error('boom')).kind, 'error');
  const attempts = [
    { n: 1, ok: false, errors: 2, diagnostics: [{ severity: 'error', line: 3, col: 14, message: 'a thing' }, { severity: 'error', line: 5, col: 1, message: 'another' }] },
    { n: 2, ok: false, errors: 1, diagnostics: [{ severity: 'error', line: 3, col: 14, message: 'a thing' }] },
  ];
  const d = errs.describeError(E(422, 'unrepairable', { details: { attempts } }));
  assert.equal(d.title, 'unrepairable: see attempts');
  assert.deepEqual(d.lines, ['attempt 1: 2 errors', '  3:14 error: a thing', '  5:1 error: another', 'attempt 2: 1 error', '  3:14 error: a thing']);
});

test('errors: diagnostics read as line:col, the message, "expected: ..." and a did-you-mean', () => {
  const d = { severity: 'error', line: 1, col: 14, message: '`kick` has no pattern', expected: ['`x`', '`~`'], found: '`|`', help: 'kick x ~ x ~' };
  assert.equal(errs.diagLine(d), '1:14 error: `kick` has no pattern');
  assert.deepEqual(errs.diagDetails(d), ['expected: `x`, `~`', 'found: `|`', 'did you mean: kick x ~ x ~']);
  assert.equal(errs.summary({ errors: 2, warnings: 1 }), '2 errors, 1 warning');
  assert.equal(errs.summary({ errors: 0, warnings: 0 }), 'no problems');
  assert.equal(errs.summary({ errors: 1, warnings: 0 }), '1 error');
});

test('errors: the real checker gives line, column and a did-you-mean for a broken part', { skip: !realWasm }, () => {
  const r = facade.check('deck A: kick | snare ~ x\n');
  assert.equal(r.ok, false);
  const d = r.diagnostics[0];
  assert.deepEqual([d.line, d.col, d.end_col], [1, 14, 15]);
  assert.equal(d.help, 'kick x ~ x ~');
  assert.ok(d.expected.length > 3);
});

test('header: section n/m, bar, phrase and generation from status, marks and the section list', () => {
  const sections = [{ name: 'intro', start: 0, bars: 8 }, { name: 'build', start: 8, bars: 8 }, { name: 'drop', start: 16, bars: 16 }];
  assert.equal(sectionIndex(sections, 0), 0);
  assert.equal(sectionIndex(sections, 8), 1);
  assert.equal(sectionIndex(sections, 31), 2);
  assert.equal(sectionIndex(sections, 32), -1);
  const h = headerModel({ running: true, bar: 20, song_bar: 21, song_bars: 32, section: 'drop', section_bar: 5, section_bars: 16, bar_in_phrase: 5, phrase: 3, generation: 2 }, { header: { progress: 0.25 } }, sections);
  assert.deepEqual([h.secN, h.secM, h.section, h.songBar, h.songBars, h.barInPhrase, h.gen, h.progress], [3, 3, 'drop', 21, 32, 5, 2, 0.25]);
  assert.equal(headerModel({ running: true, ended: true }, null, null).ended, true);
  assert.equal(headerModel({}, null, null).running, false);
  assert.equal(programName('#! name: night bus\ntempo 1\n', 'zQ1234567'), 'night bus');
  assert.equal(programName('tempo 120\n', 'z4EBG9jFNsEJ8p6Gr'), 'btw J8p6Gr');
});

test('util: the caret keeps its place in the code when the text is replaced by its canonical form', () => {
  const old = 'tempo   140  # speed\ndeck A:  kick x ~ x ~\n';
  const neu = 'tempo 140\ndeck A: kick x ~ x ~\n';
  const caret = old.indexOf('kick') + 2; // between "ki" and "ck"
  const at = mapCaret(old, caret, neu);
  assert.equal(neu.slice(0, at), 'tempo 140\ndeck A: ki');
  assert.equal(mapCaret(old, 0, neu), 0);
  assert.equal(mapCaret(old, old.length, neu), neu.length);
});

// ---------------------------------------------------------------------------------------------------------------
// the stream player on a fake AudioContext and a fake fetch
// ---------------------------------------------------------------------------------------------------------------

class FakeCtx {
  constructor() { this.currentTime = 0; this.sampleRate = 44100; this.destination = {}; this.starts = []; this.outputLatency = 0; }
  createBuffer(ch, n, sr) { return { numberOfChannels: ch, length: n, sampleRate: sr, copyToChannel() {} }; }
  createBufferSource() {
    const ctx = this;
    return { buffer: null, onended: null, connect() {}, disconnect() {}, stop() { this.stopped = true; }, start(t) { ctx.starts.push({ t, n: this.buffer.length, sr: this.buffer.sampleRate }); } };
  }
}

function fakeFetch(chunks, headers = {}, { ok = true, status = 200, body = null } = {}) {
  return async () => ({
    ok, status,
    headers: { get: (k) => headers[k] ?? null },
    json: async () => body,
    body: { getReader() { let i = 0; return { read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }), cancel: async () => {} }; } },
  });
}

async function settle(p) { for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 2)); return p; }

test('stream: chunks are scheduled gaplessly, each starting where the one before ends; the grid follows the context clock', async () => {
  const ctx = new FakeCtx();
  const sr = 44100;
  const pieces = [wavHeader(), ...Array.from({ length: 12 }, (_, i) => pcm16(11025, 2, i + 1))]; // 12 x 250 ms
  const p = new StreamPlayer({ context: ctx, url: '/x', bpm: 120, fetchFn: fakeFetch(pieces, { 'X-Btw-Seconds': '3', 'X-Btw-Cid': 'zX' }) });
  await p.start();
  await settle();
  assert.ok(ctx.starts.length >= 2);
  for (let i = 1; i < ctx.starts.length; i++) {
    const a = ctx.starts[i - 1];
    assert.ok(Math.abs(ctx.starts[i].t - (a.t + a.n / sr)) < 1e-9, `buffer ${i} starts where ${i - 1} ends`);
  }
  assert.equal(p.info.seconds, 3);
  assert.equal(p.done, true);
  assert.ok(Math.abs(p.received - 3) < 1e-9);
  const t0 = ctx.starts[0].t;
  assert.equal(p.grid(), null, 'no clock until BtwRun has played a deck: a grid before its play would put bar 0 one bar late');
  p.echo([{ op: 'play', deck: 'A', on: true }, { op: 'play', deck: 'B', on: false }]);
  assert.equal(p.grid().beat, 0, 'before the clock reaches the first sound the beat is 0');
  ctx.currentTime = t0 + 1;
  assert.ok(Math.abs(p.grid().beat - 2) < 1e-9, '120 bpm: one second is two beats');
  assert.deepEqual(p.grid().playing, { A: true, B: false });
  assert.equal(p.state, 'playing');
  ctx.currentTime = t0 + 99;
  assert.equal(p.state, 'ended');
  assert.ok(Math.abs(p.mediaTime() - 3) < 1e-9, 'the media clock stops at the end of what arrived');
});

test('driver: a program on a virtual clock counts its bars from 0 (the first grid the runtime sees comes after its play)', async () => {
  const { Driver, VirtualSource, ManualClock } = await J('driver.js');
  const text = program(0).replace(/(# tail \d+\n)+/, '');
  const d = new Driver(facade);
  const clock = new ManualClock(124);
  assert.ok(d.evaluate(text, new VirtualSource(clock, 'manual')).ok);
  assert.equal(clock.grid(), null, 'nothing plays yet: no clock');
  d.tick(); // service(null): the runtime queues load + play, the source echoes them
  assert.notEqual(clock.grid(), null);
  d.tick(); // the first grid, at beat 0
  const bars = [];
  for (let i = 0; i < 40; i++) {
    clock.setTime(i * 0.25 * 60 / 124 * 1);
    const f = d.tick();
    bars.push(f.status.bar);
  }
  // 10 beats at a quarter beat a step: bar 0 until beat 4 ... the runtime's bar is the clock's bar, not one behind
  assert.equal(bars[0], 0);
  const beat = (i) => (i * 0.25);
  const wantBar = (i) => Math.floor(beat(i) / 4);
  for (let i = 0; i < 40; i++) assert.equal(bars[i], wantBar(i), `step ${i} at beat ${beat(i)}`);
  assert.equal(d.last.status.section, 'one');
  assert.equal(d.last.status.song_bar, wantBar(39) + 1);
});

test('driver: the carried-forward status equals the real status() at every step (and asks the runtime for it rarely)', async () => {
  const { Driver, VirtualSource, ManualClock } = await J('driver.js');
  const text = program(0).replace(/(# tail \d+\n)+/, '');
  const d = new Driver(facade);
  const clock = new ManualClock(124);
  assert.ok(d.evaluate(text, new VirtualSource(clock, 'manual')).ok);
  let asked = 0;
  const run = d.run;
  const real = run.status.bind(run);
  run.status = () => { asked++; return real(); };
  d.tick();
  let ticks = 0;
  for (let i = 0; i < 230; i++) { // 57 beats: twelve bars, then the ending
    clock.setTime(i * 0.25 * 60 / 124);
    const f = d.tick();
    ticks++;
    const want = real();
    for (const k of ['running', 'ended', 'bar', 'bar_in_phrase', 'phrase', 'section', 'section_bar', 'section_bars', 'song_bar', 'song_bars', 'generation']) {
      assert.deepEqual(f.status[k], want[k], `step ${i} ${k}: ${f.status[k]} vs ${want[k]}`);
    }
  }
  assert.ok(asked < ticks / 8, `status() was asked ${asked} times in ${ticks} frames`);
});

test('stream: an underrun re-anchors the next chunk and takes the gap off the media clock', async () => {
  const ctx = new FakeCtx();
  const first = [wavHeader(), pcm16(44100)];
  let release;
  const gate = new Promise((r) => { release = r; });
  const chunks = [...first];
  const fetchFn = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    body: { getReader() { let i = 0; return { read: async () => { if (i < chunks.length) return { done: false, value: chunks[i++] }; if (i === chunks.length) { i++; await gate; return { done: false, value: pcm16(44100, 2, 9) }; } return { done: true }; }, cancel: async () => {} }; } },
  });
  const p = new StreamPlayer({ context: ctx, url: '/x', bpm: 60, fetchFn });
  await p.start();
  await settle();
  const t0 = ctx.starts[0].t;
  assert.equal(p.state, 'playing');
  ctx.currentTime = t0 + 3; // the one second of audio ran out two seconds ago
  assert.equal(p.state, 'buffering');
  release();
  await settle();
  assert.equal(p.underruns, 1);
  const last = ctx.starts[ctx.starts.length - 1];
  assert.ok(last.t >= ctx.currentTime, 'the late chunk starts now, not in the past');
  assert.ok(p.stall > 1.9 && p.stall < 2.1, `stall ${p.stall}`);
  ctx.currentTime = last.t + 0.5;
  assert.ok(Math.abs(p.mediaTime() - 1.5) < 0.1, `media time ${p.mediaTime()} is 1 s of first chunk + 0.5 s of the second`);
});

test('stream: a refused render is an ApiError with its code and retry_after', async () => {
  const ctx = new FakeCtx();
  const p = new StreamPlayer({ context: ctx, url: '/x', fetchFn: fakeFetch([], { 'Retry-After': '7' }, { ok: false, status: 429, body: { error: { code: 'busy', message: 'all slots taken', retry_after: 7 } } }) });
  await assert.rejects(() => p.start(), (e) => e.code === 'busy' && e.retryAfter === 7 && e.status === 429);
});

// ---------------------------------------------------------------------------------------------------------------
// sign-in with a browser key
// ---------------------------------------------------------------------------------------------------------------

// a key store like the page's IndexedDB one: it keeps the very objects it is given (structured clone does the same for a CryptoKey)
function fakeKeyStore() {
  let rec = null;
  return { get: async () => rec, put: async (v) => { rec = v; }, del: async () => { rec = null; }, peek: () => rec };
}
const memLocalStorage = () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  return mem;
};
const CHAL = 'btw.bitwrap.io sign-in\nnonce: abc\nissued: now\nexpires: later';

test('auth: an Ed25519 browser key signs the challenge, is not extractable, and leaves no private key in localStorage', async () => {
  const mem = memLocalStorage();
  const auth = await J('auth.js');
  const { unhex } = await J('util.js');
  const ks = fakeKeyStore();
  auth.useKeyStore(ks);
  assert.equal(auth.localKeyInfo(), null);
  const s1 = await auth.signEd25519(CHAL);
  assert.equal(s1.type, 'ed25519');
  assert.equal(s1.address.length, 64);
  assert.equal(s1.signature.length, 128);
  // what is kept: the public half in localStorage, the CryptoKey in the key store, and nowhere a JWK
  assert.deepEqual(JSON.parse(mem.get('btw-ed25519-v1')), { publicKeyHex: s1.address });
  assert.equal(auth.localKeyInfo(), s1.address);
  const rec = ks.peek();
  assert.equal(rec.publicKeyHex, s1.address);
  assert.equal(rec.privateKey.extractable, false, 'the private key cannot be exported');
  await assert.rejects(() => crypto.subtle.exportKey('jwk', rec.privateKey));
  await assert.rejects(() => crypto.subtle.exportKey('pkcs8', rec.privateKey));
  assert.doesNotMatch(JSON.stringify([...mem.values()]), /"d"|privateKey/, 'no secret in localStorage');
  const pub = await crypto.subtle.importKey('raw', unhex(s1.address), { name: 'Ed25519' }, false, ['verify']);
  assert.equal(await crypto.subtle.verify({ name: 'Ed25519' }, pub, unhex(s1.signature), new TextEncoder().encode(CHAL)), true);
  // the same key again, also after the page forgets what it holds (a reload)
  auth.useKeyStore(ks);
  assert.equal((await auth.signEd25519(CHAL)).address, s1.address, 'the same key is used again');
  // two sign-ins at once make one key
  const ks2 = fakeKeyStore();
  auth.useKeyStore(ks2);
  const [a, b] = await Promise.all([auth.signEd25519(CHAL), auth.signEd25519(CHAL)]);
  assert.equal(a.address, b.address);
  // the whole flow against a fake API
  const calls = [];
  const api = { challenge: async () => ({ nonce: 'abc', message: CHAL }), login: async (b2) => { calls.push(b2); return { user: { id: `ed25519:${b2.address}` } }; } };
  const user = await auth.signIn(api, 'ed25519', { hosts: ['btw.bitwrap.io'] });
  assert.equal(calls[0].nonce, 'abc');
  assert.equal(calls[0].type, 'ed25519');
  assert.equal(user.id, `ed25519:${a.address}`);
  // forgetting wipes every copy
  await auth.resetLocalKey();
  assert.equal(auth.localKeyInfo(), null);
  assert.equal(ks2.peek(), null);
  assert.equal(mem.size, 0);
});

test('auth: a key an earlier version kept as a JWK in localStorage becomes a non-extractable key and the JWK goes', async () => {
  const mem = memLocalStorage();
  const auth = await J('auth.js');
  const { hex, unhex } = await J('util.js');
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKeyHex = hex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  mem.set('btw-ed25519-v1', JSON.stringify({ publicKeyHex, privateKeyJwk: await crypto.subtle.exportKey('jwk', pair.privateKey) }));
  const ks = fakeKeyStore();
  auth.useKeyStore(ks);
  const s = await auth.signEd25519(CHAL);
  assert.equal(s.address, publicKeyHex, 'the same account');
  assert.equal(ks.peek().privateKey.extractable, false);
  assert.deepEqual(JSON.parse(mem.get('btw-ed25519-v1')), { publicKeyHex }, 'the JWK left localStorage');
  const pub = await crypto.subtle.importKey('raw', unhex(publicKeyHex), { name: 'Ed25519' }, false, ['verify']);
  assert.equal(await crypto.subtle.verify({ name: 'Ed25519' }, pub, unhex(s.signature), new TextEncoder().encode(CHAL)), true);
  // where nothing can keep the key, the JWK stays (the account is not lost) and is still imported non-extractable for signing
  const mem2 = memLocalStorage();
  mem2.set('btw-ed25519-v1', JSON.stringify({ publicKeyHex, privateKeyJwk: await crypto.subtle.exportKey('jwk', pair.privateKey) }));
  auth.useKeyStore({ get: async () => null, put: async () => { throw new Error('no space'); }, del: async () => {} });
  assert.equal((await auth.signEd25519(CHAL)).address, publicKeyHex);
  assert.ok(JSON.parse(mem2.get('btw-ed25519-v1')).privateKeyJwk, 'still there, since the key store could not take it');
  await auth.resetLocalKey();
});

test('auth: with no key store the key lasts this page only and no secret is written anywhere', async () => {
  const mem = memLocalStorage();
  const auth = await J('auth.js');
  auth.useKeyStore(null);
  const s1 = await auth.signEd25519(CHAL);
  assert.equal(mem.size, 0, 'nothing in localStorage');
  assert.equal((await auth.signEd25519(CHAL)).address, s1.address, 'the page keeps it for itself');
  auth.useKeyStore(null);
  assert.notEqual((await auth.signEd25519(CHAL)).address, s1.address, 'and a new page has a new key');
});

test('auth: what localStorage says the key is cannot be anything but 64 hex characters', async () => {
  const mem = memLocalStorage();
  const auth = await J('auth.js');
  for (const bad of [{ publicKeyHex: 5 }, { publicKeyHex: 'zz' }, { publicKeyHex: { slice: 1 } }, 'x', 7, null, { publicKeyHex: 'A'.repeat(64) }]) {
    mem.set('btw-ed25519-v1', JSON.stringify(bad));
    assert.equal(auth.localKeyInfo(), null, JSON.stringify(bad));
  }
  mem.set('btw-ed25519-v1', '{not json');
  assert.equal(auth.localKeyInfo(), null);
  mem.set('btw-ed25519-v1', JSON.stringify({ publicKeyHex: 'ab'.repeat(32) }));
  assert.equal(auth.localKeyInfo(), 'ab'.repeat(32));
});

test('auth: only the site\'s own sign-in message is signed (no blind signing)', async () => {
  const auth = await J('auth.js');
  const ok = (m, nonce = 'abc', hosts = ['btw.bitwrap.io']) => auth.checkChallenge({ nonce, message: m }, { hosts });
  assert.equal(ok(CHAL), CHAL);
  assert.equal(ok('127.0.0.1:18097 sign-in\nnonce: n1\nissued: 1\nexpires: 2', 'n1', ['127.0.0.1:18097']), '127.0.0.1:18097 sign-in\nnonce: n1\nissued: 1\nexpires: 2');
  const bad = [
    ['another site', 'evil.example sign-in\nnonce: abc'],
    ['not a sign-in', 'transfer 10 ETH to 0xabc\nnonce: abc'],
    ['no nonce line', 'btw.bitwrap.io sign-in\nissued: now'],
    ['someone else\'s nonce', 'btw.bitwrap.io sign-in\nnonce: other'],
    ['control characters', 'btw.bitwrap.io sign-in\nnonce: abc\u0000'],
    ['a right-to-left mark', 'btw.bitwrap.io sign-in\nnonce: abc‮'],
    ['non-ASCII text', 'btw.bitwrap.io sign-in\nnonce: abc\nnote: café'],
    ['too long', `btw.bitwrap.io sign-in\nnonce: abc\n${'x'.repeat(600)}`],
    ['a first line that is more', 'btw.bitwrap.io sign-in please\nnonce: abc'],
  ];
  for (const [why, m] of bad) assert.throws(() => ok(m), (e) => e.code === 'bad_request' && /not signed/.test(e.message), why);
  for (const ch of [null, {}, { nonce: 'abc' }, { message: CHAL }, { nonce: '', message: CHAL }, { nonce: 5, message: CHAL }, { nonce: 'abc', message: { x: 1 } }]) assert.throws(() => auth.checkChallenge(ch, { hosts: ['btw.bitwrap.io'] }), (e) => e.code === 'bad_request');
  // a refused challenge reaches neither a wallet nor the key, and nothing is posted
  let signed = 0;
  const mem = memLocalStorage();
  globalThis.ethereum = { request: async () => { signed++; return []; } };
  auth.useKeyStore(fakeKeyStore());
  const posts = [];
  const api = { challenge: async () => ({ nonce: 'abc', message: 'evil.example sign-in\nnonce: abc' }), login: async (b) => { posts.push(b); return { user: {} }; } };
  for (const kind of ['eth', 'ed25519']) await assert.rejects(() => auth.signIn(api, kind, { hosts: ['btw.bitwrap.io'] }), /not for this site|not signed/);
  assert.equal(signed, 0);
  assert.equal(posts.length, 0);
  assert.equal(mem.size, 0, 'no key was made for a refused challenge');
  delete globalThis.ethereum;
});

test('auth: a wallet signs with personal_sign over the message and the lower-cased account', async () => {
  const seen = [];
  globalThis.ethereum = { request: async ({ method, params }) => { seen.push([method, params]); return method === 'eth_requestAccounts' ? ['0xABCDEF0000000000000000000000000000000001'] : '0xdeadbeef'; } };
  const auth = await J('auth.js');
  const r = await auth.signEth('hello');
  assert.deepEqual(r, { type: 'eth', address: '0xabcdef0000000000000000000000000000000001', signature: '0xdeadbeef' });
  assert.deepEqual(seen[1], ['personal_sign', ['hello', '0xabcdef0000000000000000000000000000000001']]);
  delete globalThis.ethereum;
  assert.equal(auth.hasWallet(), false);
});

// ---------------------------------------------------------------------------------------------------------------
// security: what a link, the server or an assistant can hand the page (DESIGN.md "The page"; the SEC-3 review)
// ---------------------------------------------------------------------------------------------------------------

test('security: hostile text is text, never markup, in the highlighted overlay (the page\'s one innerHTML)', () => {
  const evil = ['<img src=x onerror="window.__pwn=1">', '</pre><script>window.__pwn=1</script>', '"><svg/onload=alert(1)>', "' onmouseover='alert(1)", '&lt;b&gt; &#x3c;i&#x3e;', '<!--', ']]>', '  ', '<a href="javascript:alert(1)">x</a>'];
  for (const t of evil) {
    for (const spans of [[], [[0, t.length, 'word']], [[0, 3, 'string'], [1, t.length, 'comment']], [[0, t.length, '"><img src=x onerror=alert(1)>']], [[0, t.length, '__proto__']]]) {
      const html = spansToHtml(t, spans);
      // the only tags in the output are the page's own spans, with a class from the fixed list
      for (const tag of html.match(/<[^>]*>/g) || []) assert.match(tag, /^(<span class="c-[a-z]+">|<\/span>)$/, `${JSON.stringify(t)} ${JSON.stringify(spans)} -> ${tag}`);
      assert.doesNotMatch(html.replace(/<span class="c-[a-z]+">|<\/span>/g, ''), /[<>"']/, 'no raw markup characters outside the page\'s own spans');
    }
  }
});

test('security: a malformed percent escape in the address bar is a mangled link, not an exception', async () => {
  const { fragmentOf } = await J('link.js');
  assert.equal(fragmentOf('#%'), '%');
  assert.equal(fragmentOf('#%E0%A4%A'), '%E0%A4%A');
  assert.equal(fragmentOf('#%zz'), '%zz');
  assert.equal(fragmentOf(''), '');
  assert.equal(fragmentOf('#'), '');
  assert.equal(fragmentOf('#abc%20def'), 'abc def', 'a good escape is still decoded');
  assert.equal(fragmentOf('#z4EBG9j.K0nNLchXMDQy~abc'), 'z4EBG9j.K0nNLchXMDQy~abc');
});

test('security: a link that would inflate to a bomb is refused before the module sees it', async () => {
  const zlib = await import('node:zlib');
  const { guardLink, packedCandidates, b64uBytes, inflatedLength } = await J('link.js');
  const { MAX_LOAD_TEXT, MAX_LINK_CHARS } = await J('util.js');
  const cid = 'z4EBG9jB3vwMeCJNSp8WJLWDRM7ADEWxi23HyNSij5cHBL94r7v';
  const link = (bytes, extra = '') => `https://btw.bitwrap.io/#${cid}.${Buffer.from(bytes).toString('base64url')}${extra}`;
  // 1 MiB (the module's own limit), 64 and 128 MiB of 'a'
  for (const n of [1 << 20, 64 << 20, 128 << 20]) {
    const z = zlib.deflateRawSync(Buffer.alloc(n, 'a'), { level: 9 });
    const t0 = performance.now();
    const r = await guardLink(link(z));
    assert.equal(r.ok, false, `${n}`);
    assert.match(r.error, /larger than 32,768 bytes/);
    assert.ok(performance.now() - t0 < 1500, `refused in ${performance.now() - t0} ms without inflating it all`);
  }
  // in the notes part, and in the social /c/ form, and behind a signature
  const bomb = zlib.deflateRawSync(Buffer.alloc(8 << 20, 'a'), { level: 9 });
  const fine = zlib.deflateRawSync(Buffer.from('tempo 120\ndeck A: kick x ~ x ~\n'));
  assert.equal((await guardLink(`${link(fine)}~${Buffer.from(bomb).toString('base64url')}`)).ok, false, 'notes');
  assert.equal((await guardLink(`https://btw.bitwrap.io/c/${cid}.${Buffer.from(bomb).toString('base64url')}`)).ok, false, 'social form');
  assert.equal((await guardLink(`${cid}.${Buffer.from(bomb).toString('base64url')}.${'ab'.repeat(32)}`)).ok, false, 'with a signature');
  // what is fine stays fine: a real link, a bare CID, text just under the cap, a short or garbled run
  assert.deepEqual(await guardLink(link(fine)), { ok: true });
  assert.deepEqual(await guardLink(`#${cid}`), { ok: true });
  assert.deepEqual(await guardLink(link(zlib.deflateRawSync(Buffer.alloc(MAX_LOAD_TEXT, 'a')))), { ok: true });
  assert.equal((await guardLink(link(zlib.deflateRawSync(Buffer.alloc(MAX_LOAD_TEXT + 1, 'a'))))).ok, false, 'one byte over');
  assert.deepEqual(await guardLink(`#${cid}.${'A'.repeat(200)}`), { ok: true }, 'not deflate: the module will say so');
  assert.deepEqual(await guardLink(`#${cid}.${'!'.repeat(200)}`), { ok: true });
  // a link of absurd length is refused without being read
  assert.equal((await guardLink('x'.repeat(MAX_LINK_CHARS + 1))).ok, false);
  // helpers
  assert.deepEqual(packedCandidates(`#${cid}.${'a'.repeat(80)}~${'b'.repeat(70)}`), ['a'.repeat(80), 'b'.repeat(70)], 'the CID is not a candidate');
  assert.equal(b64uBytes('a'), null);
  assert.equal(b64uBytes('a b'), null);
  assert.deepEqual([...b64uBytes('AQID')], [1, 2, 3]);
  assert.equal(await inflatedLength(Buffer.from([0xff, 0xff, 0xff]), 100), null, 'not deflate');
});

test('security: what becomes part of a URL path is checked first (CID, example name, session id)', async () => {
  const { makeApi } = await J('api.js');
  const seen = [];
  const api = makeApi({ fetchFn: async (u, init) => { seen.push(`${init.method} ${u}`); return { ok: true, headers: new Headers({ 'Content-Type': 'application/json' }), json: async () => ({}) }; } });
  const cid = 'z4EBG9jB3vwMeCJNSp8WJLWDRM7ADEWxi23HyNSij5cHBL94r7v';
  await api.getProgram(cid);
  await api.putProgram(cid, 'tempo 120\n');
  await api.renderStatus(cid);
  await api.exampleText('hand-dubstep-140-v4');
  await api.report('PqjBDf8367OflXp4zG-TKQ', {});
  assert.deepEqual(seen, [`GET /api/programs/${cid}`, `PUT /api/programs/${cid}`, `GET /api/render/${cid}/status`, 'GET /examples/hand-dubstep-140-v4.btw', 'POST /api/session/PqjBDf8367OflXp4zG-TKQ/report']);
  assert.equal(api.renderUrl(cid), `/api/render/${cid}?format=wav&sr=44100`);
  assert.equal(api.renderUrl(cid, 'opus'), `/api/render/${cid}?format=opus`);
  assert.equal(api.renderUrl(cid, 'x&y=1', 7), `/api/render/${cid}?format=wav&sr=44100`, 'format and rate are from a short list');
  assert.equal(api.eventsUrl('PqjBDf8367OflXp4zG-TKQ'), '/api/session/PqjBDf8367OflXp4zG-TKQ/events');
  seen.length = 0;
  const badCids = ['', '../../api/info', `${cid}/../..`, `${cid}?x=1`, `${cid}#`, `${cid}%2f..`, 'zshort', `z${'1'.repeat(200)}`, 'a'.repeat(50), `${cid}\n`, '/etc/passwd', null, undefined, 5, { toString: () => cid }];
  for (const c of badCids) {
    for (const f of [() => api.getProgram(c), () => api.putProgram(c, 'x'), () => api.renderStatus(c), () => api.renderUrl(c)]) {
      await assert.rejects(async () => f(), (e) => e.code === 'bad_request', String(c));
    }
  }
  for (const n of ['', '..', '../../api/info', '..%2f..%2fapi%2finfo', '.hidden', 'a/b', 'a?b', 'a#b', 'x'.repeat(65), 'a b', null, 3]) await assert.rejects(() => api.exampleText(n), (e) => e.code === 'bad_request', String(n));
  for (const id of ['', 'a/b', '../x', 'short', 'x?y=1x', 'a'.repeat(65), null]) {
    await assert.rejects(() => api.report(id, {}), (e) => e.code === 'bad_request', String(id));
    assert.throws(() => api.eventsUrl(id), (e) => e.code === 'bad_request', String(id));
  }
  assert.deepEqual(seen, [], 'not one request was made for any of them');
});

test('security: names and messages from outside are cleaned and cut before they reach a title or a toast', async () => {
  const { cleanName, trunc, marksPrivate, isLoopbackHost, CID_RE, EXAMPLE_RE } = await J('util.js');
  assert.equal(cleanName('a‮b\u0000c​d\n  e'), 'a b c d e');
  assert.equal(cleanName('x'.repeat(500)).length, 80);
  assert.equal(cleanName('  '), '');
  assert.equal(cleanName(null), '');
  assert.equal(trunc('x'.repeat(1000)).length, 300);
  assert.equal(trunc('short'), 'short');
  assert.equal(programName('#! name: ' + 'long '.repeat(100) + '\ntempo 120\n', null).length <= 80, true);
  assert.equal(programName('#! name: ‮​\n', 'zabcdef123456'), 'btw 123456', 'a name that is nothing but marks falls back');
  assert.equal(programName('#! name: <img src=x onerror=alert(1)>\n', null), '<img src=x onerror=alert(1)>', 'markup stays text (it is put in with textContent)');
  // private programs
  assert.equal(marksPrivate('#! btw 1\n#! visibility: private\ntempo 120\n'), true);
  assert.equal(marksPrivate('  #! Visibility:   PRIVATE\n'), false, 'the header starts the line');
  assert.equal(marksPrivate('#!visibility:private\n'), true);
  assert.equal(marksPrivate('#! visibility: public\n'), false);
  assert.equal(marksPrivate('# visibility: private (just a comment)\n'), false);
  assert.equal(marksPrivate(''), false);
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('btw.bitwrap.io'), false);
  assert.equal(isLoopbackHost('127.0.0.1.evil.example'), false);
  assert.equal(isLoopbackHost('evil-localhost'), false);
  assert.equal(CID_RE.test('z4EBG9jB3vwMeCJNSp8WJLWDRM7ADEWxi23HyNSij5cHBL94r7v'), true);
  assert.equal(EXAMPLE_RE.test('hand-dubstep-140-v4'), true);
});

test('security: events an assistant pushes can set text, load a CID or an example, play and stop, and nothing else', async () => {
  const { SessionLink } = await J('session.js');
  const calls = [];
  const rec = (name) => async (...a) => { calls.push([name, ...a]); };
  const app = {
    api: { reply: async (...a) => calls.push(['reply', ...a]), report: async () => {}, eventsUrl: () => 'x', createSession: async () => ({ id: 'abcdefghij' }) },
    on() {}, emit() {}, user: null,
    setProgram: (...a) => { calls.push(['setProgram', ...a]); }, toast: (...a) => calls.push(['toast', ...a]), showError: (e) => calls.push(['error', e.message]),
    loadByCid: rec('loadByCid'), loadExample: rec('loadExample'), openAny: rec('openAny'), play: rec('play'), stop: () => calls.push(['stop']),
    isPlaying: () => false, reportState: () => ({ text: 'state' }),
  };
  const s = new SessionLink(app);
  s.id = 'abcdefghij';
  s.send = () => {};
  const ev = (type, o) => s.onEvent(type, JSON.stringify(o));
  const names = () => calls.map((c) => c[0]);
  await ev('eval', { text: 'tempo 120\n', play: true });
  assert.deepEqual(names(), ['setProgram', 'toast', 'play']);
  calls.length = 0;
  await ev('load', { cid: 'z4EBG9jB3vwMeCJNSp8WJLWDRM7ADEWxi23HyNSij5cHBL94r7v', play: true });
  assert.deepEqual(calls[0], ['loadByCid', 'z4EBG9jB3vwMeCJNSp8WJLWDRM7ADEWxi23HyNSij5cHBL94r7v']);
  calls.length = 0;
  await ev('load', { extra: { example: 'matrix-130' } });
  assert.deepEqual(calls[0], ['loadExample', 'matrix-130']);
  calls.length = 0;
  await ev('stop', {});
  assert.deepEqual(names(), ['stop']);
  calls.length = 0;
  await ev('get', { request_id: 'r1' });
  assert.deepEqual(calls[0], ['reply', 'abcdefghij', 'r1', { text: 'state' }]);
  // hostile shapes: nothing throws out of onEvent, nothing runs that was not asked for, nothing plays unless it is `true`
  calls.length = 0;
  const hostile = [
    ['eval', { text: { toString: 'x' }, play: 'yes' }], ['eval', { text: 5 }], ['eval', 'a string'], ['eval', [1, 2]], ['eval', null],
    ['load', { cid: ['z'], extra: 'oops' }], ['load', { extra: { example: { a: 1 }, url: 5 } }], ['load', { cid: 7 }], ['load', { extra: null }],
    ['get', { request_id: 'x'.repeat(5000) }], ['get', { request_id: { a: 1 } }], ['get', {}],
    ['stop', { cid: 'z' }],
  ];
  for (const [t, o] of hostile) await ev(t, o);
  assert.equal(await s.onEvent('eval', '{not json'), undefined);
  assert.ok(!names().includes('play'), 'play only for play === true');
  assert.ok(!names().includes('reply'), 'no reply to a missing or absurd request id');
  assert.ok(!names().includes('loadByCid') && !names().includes('loadExample') && !names().includes('openAny'), 'only strings are looked up');
  // and the editor takes only what setProgram lets in: too big a text is an error, not a freeze
});

// ---- the page in the background (js/background-model.js, js/background.js) ----------------------------------------------------------------
const bgm = await J('background-model.js');
const { Background } = await J('background.js');

test('background: who services the runtime (hidden, or the frame loop has stalled) and how often', () => {
  assert.equal(bgm.needsPump({ hidden: false, now: 1000, lastFrameAt: 990 }), false, 'a visible page with frames needs nothing');
  assert.equal(bgm.needsPump({ hidden: false, now: 1000, lastFrameAt: null }), false, 'before the first frame, nothing is stalled');
  assert.equal(bgm.needsPump({ hidden: false, now: 1000, lastFrameAt: 1000 - bgm.FRAME_STALE_MS - 1 }), true, 'frames that stopped (an occluded window) are replaced');
  assert.equal(bgm.needsPump({ hidden: true, now: 1000, lastFrameAt: 999 }), true, 'hidden: always');
  assert.equal(bgm.pumpDue({ now: 100, lastPumpAt: null }), true);
  assert.equal(bgm.pumpDue({ now: 100, lastPumpAt: 100 - bgm.PUMP_EVERY_MS + 1 }), false, 'the audio thread reports every ~25 ms: not every one is a pass');
  assert.equal(bgm.pumpDue({ now: 100, lastPumpAt: 100 - bgm.PUMP_EVERY_MS }), true);
});

test('background: the audio clock is "in step" within a quarter second and 5%', () => {
  assert.equal(bgm.clockKeptUp({ audioS: 30, wallS: 30 }), true);
  assert.equal(bgm.clockKeptUp({ audioS: 29.9, wallS: 30.2 }), true);
  assert.equal(bgm.clockKeptUp({ audioS: 0, wallS: 30 }), false, 'a suspended context');
  assert.equal(bgm.clockKeptUp({ audioS: 20, wallS: 30 }), false, 'a starved one');
});

test('background: the stream is offered after a long enough background, once, for a source that can fall behind', () => {
  const base = { hiddenMs: 30000, wasPlaying: true, source: 'engine', canStream: true, android: false, ctxState: 'running', degraded: false, offered: false };
  assert.equal(bgm.offerStream(base), null, 'a desktop engine that kept up: no offer');
  assert.match(bgm.offerStream({ ...base, ctxState: 'suspended' }), /paused the sound/);
  assert.match(bgm.offerStream({ ...base, degraded: true }), /fell behind/);
  assert.match(bgm.offerStream({ ...base, android: true }), /Phones/, 'on Android it is suggested whenever the engine played through a background');
  assert.equal(bgm.offerStream({ ...base, android: true, hiddenMs: 1500 }), null, 'a notification-shade blip is not a background');
  assert.equal(bgm.offerStream({ ...base, android: true, offered: true }), null, 'said once');
  assert.equal(bgm.offerStream({ ...base, android: true, source: 'stream' }), null, 'already on the stream');
  assert.equal(bgm.offerStream({ ...base, android: true, canStream: false }), null, 'a private program never goes to the server');
  assert.equal(bgm.offerStream({ ...base, android: true, wasPlaying: false }), null);
  assert.equal(bgm.isAndroid('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36'), true);
  assert.equal(bgm.isAndroid('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'), false);
});

test('background: what the lock screen shows', () => {
  assert.deepEqual(bgm.mediaInfo({ name: ' hand-dubstep ', source: 'engine', tempo: 139.6 }), { title: 'hand-dubstep', artist: 'BeatScript', album: 'live engine · 140 bpm' });
  assert.equal(bgm.mediaInfo({ name: '', source: 'stream' }).title, 'btw');
  assert.equal(bgm.mediaInfo({ name: 'x', source: 'stream' }).album, 'streamed render');
  assert.equal(bgm.mediaState({ playing: true, loaded: true }), 'playing');
  assert.equal(bgm.mediaState({ playing: false, loaded: true }), 'paused', 'the lock screen keeps a Play');
  assert.equal(bgm.mediaState({ playing: false, loaded: false }), 'none');
});

/** A page, an app and an engine that are just enough for Background. */
function bgRig({ hidden = false, ua = 'Linux; Android 14' } = {}) {
  let now = 0;
  const handlers = {};
  const doc = { hidden, addEventListener: (t, f) => { (handlers[t] ||= []).push(f); } };
  const fire = (t) => (handlers[t] || []).forEach((f) => f());
  const services = [];
  const banners = [];
  const actions = [];
  const app = {
    ctx: { currentTime: 0, state: 'running' }, driver: { kind: 'engine' }, report: { ok: true }, evalReport: { ok: true }, q: new URLSearchParams(), manual: false, record: false, sourcePref: 'auto',
    isPlaying: () => true, canStream: () => true, ensureAudio: () => actions.push('ensureAudio'), resync: () => actions.push('resync'),
    serviceOnly: () => services.push(now), banner: (b) => banners.push(b), setSourcePref: (s) => { app.sourcePref = s; },
  };
  const listeners = {};
  const engine = { on: (t, f) => { listeners[t] = f; } };
  const g = globalThis;
  const prevWin = g.window;
  g.window = { addEventListener() {} };
  const bg = new Background(app, { doc, nav: { userAgent: ua }, now: () => now });
  bg.start();
  clearInterval(bg.timer);
  g.window = prevWin;
  bg.attachEngine(engine);
  return { bg, app, doc, fire, engine, listeners, services, banners, actions, at: (t) => { now = t; } };
}

test('background: a hidden page is serviced from the engine\'s audio-thread reports, a visible one is left to the frame loop', () => {
  const r = bgRig({ hidden: true });
  r.at(100); r.listeners.grid();
  r.at(110); r.listeners.grid(); // too soon after the last pass
  r.at(140); r.listeners.grid();
  assert.deepEqual(r.services, [100, 140], 'a pass at most every PUMP_EVERY_MS');
  r.doc.hidden = false;
  r.bg.frame(); // a frame just ran
  r.at(200); r.listeners.grid();
  assert.deepEqual(r.services, [100, 140], 'visible and painting: the frame loop services the runtime');
  r.at(200 + bgm.FRAME_STALE_MS + 50); r.listeners.grid();
  assert.equal(r.services.length, 3, 'frames stopped (occluded window, screen off): the reports take over');
});

test('background: the fallback timer path services a hidden page whose source has no reports (the stream)', () => {
  const r = bgRig({ hidden: true });
  r.at(1000); assert.equal(r.bg.pump(), true);
  r.at(1010); assert.equal(r.bg.pump(), false);
  assert.equal(r.bg.stats.hiddenPumps, 1);
  const off = bgRig({ hidden: true });
  off.app.q = new URLSearchParams('pump=0');
  off.at(1000); assert.equal(off.bg.pump(), false, '?pump=0 is the test switch that turns it off');
});

test('background: coming back resyncs the page and, on Android after a long background, offers the stream once', () => {
  const r = bgRig({ hidden: false });
  r.at(1000); r.doc.hidden = true; r.fire('visibilitychange');
  r.at(1000 + 30000); r.app.ctx.currentTime = 30; r.doc.hidden = false; r.fire('visibilitychange');
  assert.ok(r.actions.includes('resync'));
  assert.equal(r.banners.length, 1);
  assert.match(r.banners[0].text, /streamed render keeps time/);
  assert.deepEqual(r.banners[0].actions.map((a) => a.label), ['Use stream', 'Dismiss']);
  r.banners[0].actions[0].run();
  assert.equal(r.app.sourcePref, 'stream');
  assert.equal(r.banners.at(-1), null, 'the banner is cleared');
  // a second background: not offered again
  r.at(40000); r.doc.hidden = true; r.fire('visibilitychange');
  r.at(80000); r.doc.hidden = false; r.fire('visibilitychange');
  assert.equal(r.banners.length, 2, 'only the clearing banner(null) was added');
  // a desktop that kept up is left alone; one whose context the browser suspended is offered it and its context is resumed
  const d = bgRig({ ua: 'Macintosh' });
  d.at(0); d.doc.hidden = true; d.fire('visibilitychange');
  d.at(20000); d.app.ctx.currentTime = 20; d.doc.hidden = false; d.fire('visibilitychange');
  assert.equal(d.banners.length, 0);
  const s = bgRig({ ua: 'Macintosh' });
  s.at(0); s.doc.hidden = true; s.fire('visibilitychange');
  s.at(20000); s.app.ctx.currentTime = 0.4; s.app.ctx.state = 'suspended'; s.doc.hidden = false; s.fire('visibilitychange');
  assert.ok(s.actions.includes('ensureAudio'), 'a suspended context is resumed');
  assert.match(s.banners[0].text, /paused the sound/);
});

// engine-worklet.js, without the wasm: the engine's crossfader starts at 0 (all deck A), so the worklet must centre it
// when it builds the Dj, or every part a program puts on deck B (melody, harmony, bass) is silent while deck A plays.
test('engine worklet centres the crossfader when it builds the Dj (deck B is audible)', async () => {
  let src = fs.readFileSync(path.join(web, 'js', 'engine-worklet.js'), 'utf8');
  src = src.replace(/^import .*$/gm, '').replace(/^export /gm, '');
  const calls = [];
  class Dj { constructor(sr) { calls.push(['new', sr]); this.crossfader = 0; } set_crossfader(v) { calls.push(['crossfader', v]); this.crossfader = v; } }
  let Proc;
  const glue = { initSync() {}, Dj, engine_version: () => 'test' };
  const posted = [];
  class AudioWorkletProcessor { constructor() { this.port = { postMessage: (m) => posted.push(m), onmessage: null }; } }
  const registerProcessor = (_n, c) => { Proc = c; };
  new Function('glue', 'AudioWorkletProcessor', 'registerProcessor', 'sampleRate', src)(glue, AudioWorkletProcessor, registerProcessor, 48000);
  assert.ok(Proc, 'the worklet registers its processor');
  const p = new Proc();
  p.up(new Uint8Array(0));
  const xf = calls.filter((c) => c[0] === 'crossfader');
  assert.ok(xf.length >= 1, 'set_crossfader is called when the engine comes up');
  assert.equal(p.dj.crossfader, 0.5, 'the crossfader is at the centre: both decks at full level');
  assert.ok(calls.findIndex((c) => c[0] === 'new') < calls.findIndex((c) => c[0] === 'crossfader'), 'centred after the Dj exists');
});
