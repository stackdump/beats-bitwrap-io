// A stand-in for the wasm module (?mock=1 and the Node tests): the same surface as DESIGN.md's JS API
// (btw_check, btw_fmt, btw_highlight, btw_open, btw_share, BtwRun ...) written as a few hundred lines of
// JavaScript. It knows enough of the language to light a page up (lines, sections, step tokens, ramps,
// timed lines, an evolve block) and nothing more: the CIDs are fake ("zMock..."), the grammar check is a
// line-shape check. It is only ever loaded on request; the real page runs on the real module.

const WORDS = ['tempo', 'swing', 'key', 'let', 'def', 'repeat', 'section', 'arrange', 'import', 'end', 'loop', 'evolve', 'deck', 'master', 'every', 'on', 'at', 'after', 'before', 'for', 'do', 'crossfader', 'swap', 'move', 'load', 'queue', 'play', 'stop', 'sync', 'mute', 'unmute', 'filter', 'delay', 'reverb', 'crush', 'level', 'low', 'mid', 'high', 'resonance'];
const ROLES = ['kick', 'snare', 'hihat', 'clap', 'bass', 'melody', 'harmony', 'arp'];
const KEYWORDS = ['deck', 'master', 'every', 'on', 'at', 'bar', 'bars', 'phrase', 'over', 'tempo', 'key', 'swing', 'with', 'pairs', 'pair', 'group', 'section', 'arrange', 'let', 'def', 'repeat', 'end', 'loop', 'evolve', 'before', 'after', 'for', 'from', 'when', 'gen', 'stop', 'import', 'next'];
const ACTIONS = ['swap', 'move', 'load', 'queue', 'play', 'sync', 'mute', 'unmute', 'filter', 'delay', 'reverb', 'crush', 'level', 'low', 'mid', 'high', 'resonance', 'crossfader'];
const PARAMS = ['vel', 'oct', 'len', 'inst', 'seed', 'kit', 'sound', 'route'];

// ---- fake CIDs --------------------------------------------------------------------------------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function mockCid(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0x1b873593;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 2246822519) >>> 0;
  }
  let out = '';
  let a = h1;
  let b = h2;
  for (let i = 0; i < 46; i++) {
    a = (Math.imul(a, 1103515245) + 12345 + b) >>> 0;
    b = (Math.imul(b ^ (a >>> 7), 22695477) + 1) >>> 0;
    out += B58[(a >>> 8) % 58];
  }
  return `zMock${out}`;
}

// ---- parsing ----------------------------------------------------------------------------------

/** Lines with their offsets: [{n, start, end, raw, code, indent}] (code: the text before a comment). */
function splitLines(text) {
  const out = [];
  let pos = 0;
  for (const raw of text.split('\n')) {
    let cut = raw.length;
    for (let j = 0; j < raw.length; j++) if (raw[j] === '#' && (j === 0 || /\s/.test(raw[j - 1]))) { cut = j; break; }
    const code = raw.slice(0, cut);
    out.push({ n: out.length, start: pos, end: pos + raw.length, raw, code, trimmed: code.trim(), indent: raw.length - raw.trimStart().length });
    pos += raw.length + 1;
  }
  return out;
}

/** The words of `s` with their [start,end) offsets, splitting on whitespace and punctuation that stands alone. */
function words(line, from = 0, to = line.code.length) {
  const re = /[^\s|]+/g;
  const out = [];
  const s = line.code.slice(from, to);
  let m;
  while ((m = re.exec(s))) out.push({ w: m[0], start: line.start + from + m.index, end: line.start + from + m.index + m[0].length });
  return out;
}

export function parseProgram(text) {
  const lines = splitLines(text);
  const diags = [];
  const lets = {};
  const defs = {};
  const sections = [];
  let arrange = null;
  let tempo = null;
  let key = '';
  let swing = null;
  const stack = [];
  const problem = (line, col0, col1, message, expected, found, help) => diags.push({ severity: 'error', line: line.n + 1, col: col0 + 1, end_col: Math.max(col1, col0 + 1) + 1, start: line.start + col0, end: line.start + Math.max(col1, col0 + 1), message, expected, found, help });
  const top = () => stack[stack.length - 1];
  const stmts = []; // part and control statements: {kind:'part'|'ctl'|'evolve'|'call', line, sectionIdx, defName?}
  for (const line of lines) {
    const t = line.trimmed;
    if (!t) continue;
    if (t.startsWith('|')) continue;
    if (t === '}' || t.startsWith('}')) {
      const b = stack.pop();
      if (!b) problem(line, line.indent, line.indent + 1, 'unmatched `}`', [], '}', null);
      else if (b.kind === 'section') b.sec.endLine = line.n;
      else if (b.kind === 'evolve') b.ev.endLine = line.n;
      else if (b.kind === 'def') b.def.endLine = line.n;
      continue;
    }
    const ws = words(line);
    const first = ws[0];
    const w0 = first.w;
    const col0 = first.start - line.start;
    const opens = /\{\s*$/.test(t);
    const ctx = top();
    const secIdx = ctx && ctx.sec ? sections.indexOf(ctx.sec) : ctx && ctx.kind === 'evolve' ? ctx.sectionIdx : -1;
    if (w0 === 'tempo' || w0 === 'swing') {
      const v = Number(ws[1] && ws[1].w);
      if (!ws[1] || Number.isNaN(v)) problem(line, col0 + w0.length + 1, col0 + w0.length + 2, `\`${w0}\` wants a number`, ['a number'], ws[1] ? ws[1].w : 'the end of the line', null);
      else if (w0 === 'tempo') tempo = v;
      else swing = v;
    } else if (w0 === 'key') key = ws[1] ? ws[1].w : '';
    else if (w0 === 'let') {
      const eq = line.code.indexOf('=');
      if (eq < 0) problem(line, col0, col0 + 3, '`let` needs `=`', ['let name = pattern'], 'let', null);
      else lets[ws[1].w] = { name: ws[1].w, line: line.n, from: line.start + eq + 1, to: line.start + line.code.length };
    } else if (w0 === 'def') {
      const name = (ws[1] ? ws[1].w : '').replace(/\(.*$/, '');
      const def = { name, line: line.n, endLine: line.n };
      defs[name] = def;
      if (opens) stack.push({ kind: 'def', def });
    } else if (w0 === 'repeat') {
      if (opens) stack.push({ kind: 'repeat', sec: ctx && ctx.sec, sectionIdx: secIdx });
    } else if (w0 === 'section') {
      const name = ws[1] ? ws[1].w : '';
      const bars = Number(ws[2] && ws[2].w);
      if (!name || Number.isNaN(bars) || !opens) problem(line, col0, line.code.trimEnd().length, 'a section is `section name N bars {`', ['section name 8 bars {'], t, 'section drop 16 bars {');
      const sec = { name, bars: Number.isNaN(bars) ? 0 : bars, line: line.n, start: 0, endLine: line.n, headerStart: line.start + col0, headerEnd: line.start + line.code.trimEnd().length };
      sections.push(sec);
      if (opens) stack.push({ kind: 'section', sec });
    } else if (w0 === 'arrange') arrange = ws.slice(1).map((x) => x.w);
    else if (w0 === 'end' || w0 === 'loop' || w0 === 'import') { /* nothing to light */ }
    else if (w0 === 'evolve') {
      const ev = { line: line.n, endLine: line.n, every: Number((t.match(/every\s+(\d+)/) || [])[1]) || 8, sectionIdx: secIdx, startOff: line.start + col0 };
      stmts.push({ kind: 'evolve', ev });
      if (opens) stack.push({ kind: 'evolve', ev, sectionIdx: secIdx });
    } else if (ctx && ctx.kind === 'evolve') {
      /* a rule line inside an evolve block */
    } else if (/^\w+\s*\(/.test(t)) {
      stmts.push({ kind: 'call', line, name: w0.replace(/\(.*$/, ''), sectionIdx: secIdx, call: { start: line.start + col0, end: line.start + line.code.trimEnd().length } });
    } else if (/^(every|on|at|after|before|for|deck|master)\b/.test(t) || ACTIONS.includes(w0) || ['do', 'vocoder', 'vocal', 'freeze', 'trick'].includes(w0)) {
      const m = t.match(/^deck\s+([AB])\s*:\s*(.*)$/);
      if (m && /^(kick|snare|hihat|clap|bass|melody|harmony|arp)\b/.test(m[2])) {
        // a part line: each `|` part must be `role pattern`
        const base = line.code.indexOf(m[2], line.code.indexOf(':'));
        let cursor = base;
        let bad = false;
        const parts = [];
        // continuation lines
        let endLine = line.n;
        let code = line.code;
        for (let j = line.n + 1; j < lines.length && lines[j].trimmed.startsWith('|'); j++) endLine = j;
        for (const seg of m[2].split('|')) {
          const segStart = line.code.indexOf(seg, cursor);
          cursor = segStart + seg.length;
          const sw = seg.trim().split(/\s+/).filter(Boolean);
          if (!ROLES.includes(sw[0] || '')) {
            problem(line, Math.max(segStart, 0), Math.max(segStart, 0) + Math.max(seg.trim().length, 1), `expected a part like \`kick x ~ x ~\`, found \`${seg.trim() || '|'}\``, ['a role: kick, snare, hihat, clap, bass, melody, harmony or arp'], seg.trim() || '|', 'kick x ~ x ~');
            bad = true;
          } else if (sw.length < 2) {
            const at = segStart + seg.indexOf(sw[0]) + sw[0].length;
            problem(line, at, at + 1, `a part is \`role pattern\`, and \`${sw[0]}\` has no pattern`, ['`x`, `~`, a note like c3, a degree like 3, `[`, `<` or a generator like e(5,8)'], seg.includes('|') ? '|' : 'the end of the line', `${sw[0]} x ~ x ~`);
            bad = true;
          } else parts.push({ role: sw[0], from: line.start + segStart, to: line.start + cursor });
        }
        if (!bad) stmts.push({ kind: 'part', line, deck: m[1], parts, endLine, sectionIdx: secIdx, defName: ctx && ctx.kind === 'def' ? ctx.def.name : null, seg: m[2], base: line.start + base });
        void code;
      } else {
        const ramp = /->/.test(t) && /over\s+(\d+)\s+bars/.exec(t);
        stmts.push({ kind: 'ctl', line, sectionIdx: secIdx, text: t, ramp: ramp ? Number(ramp[1]) : null, span: { start: line.start + col0, end: line.start + line.code.trimEnd().length } });
      }
    } else {
      const near = nearest(w0, [...WORDS, ...ROLES]);
      problem(line, col0, col0 + w0.length, `expected a statement, found \`${w0}\``, ['tempo', 'key', 'deck A: ...', 'master: ...', 'section name N bars {', 'every N bars: ...'], w0, near ? `${near}` : null);
    }
  }
  for (const b of stack) {
    const line = lines[(b.sec || b.ev || b.def || { line: 0 }).line];
    problem(line, line.indent, line.code.trimEnd().length, 'this block is never closed: add a `}`', ['}'], 'the end of the text', '}');
  }
  // the timeline
  let order = sections.slice();
  if (arrange) {
    order = arrange.map((n) => sections.find((s) => s.name === n)).filter(Boolean);
    for (const n of arrange) if (!sections.find((s) => s.name === n)) diags.push({ severity: 'error', line: 1, col: 1, end_col: 2, start: 0, end: 1, message: `\`arrange\` names the section \`${n}\`, which is not defined`, expected: sections.map((s) => s.name), found: n, help: nearest(n, sections.map((s) => s.name)) });
  }
  let at = 0;
  const timeline = order.map((s) => ({ sec: s, name: s.name, start: (at += 0) , bars: s.bars, _a: (s.start = at), _b: (at += s.bars) }));
  const songBars = sections.length ? at : null;
  return { lines, diags, lets, defs, sections, timeline, songBars, tempo, key, swing, stmts, arranged: sections.length > 0 };
}

function nearest(w, list) {
  let best = null;
  let bd = 99;
  for (const c of list) {
    const d = lev(w, c);
    if (d < bd) { bd = d; best = c; }
  }
  return bd <= Math.max(2, Math.floor(w.length / 2)) ? best : null;
}

function lev(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

// ---- check, fmt, highlight, share, open ---------------------------------------------------------

export function mockCheck(text) {
  const p = parseProgram(text);
  const errors = p.diags.filter((d) => d.severity === 'error').length;
  const ok = errors === 0;
  const canonical = ok ? canonicalOf(text) : null;
  const sections = p.timeline.map((t) => ({ name: t.name, start: t.start, bars: t.bars }));
  const seconds = p.songBars && p.tempo ? (p.songBars * 4 * 60) / p.tempo : null;
  return {
    ok, errors, warnings: 0,
    diagnostics: p.diags.map((d) => ({ ...d, render: `error: ${d.message}\n  --> ${d.line}:${d.col}` })),
    cid: ok ? mockCid(canonical) : null, canonical, nets: {}, song_nets: null,
    tempo: p.tempo, key: p.key, swing: p.swing, arranged: p.arranged, song_bars: p.songBars || 0, ends: p.arranged, loops: false,
    sections, decks: ['A', 'B'], evolve: [], lineage: [], uses_assets: /^\s*(sample|loop)\b/m.test(text), restricted: /^\s*use\s+restricted/m.test(text), seconds,
  };
}

function canonicalOf(text) {
  const out = [];
  let depth = 0;
  for (const l of splitLines(text)) {
    const t = l.trimmed.replace(/\s+/g, ' ');
    if (!t) continue;
    if (t.startsWith('}')) depth = Math.max(0, depth - 1);
    out.push(`${'  '.repeat(depth)}${t}`);
    if (/\{\s*$/.test(t)) depth++;
  }
  return `${out.join('\n')}\n`;
}

export function mockFmt(text) {
  const c = mockCheck(text);
  const comments = [];
  for (const l of splitLines(text)) if (l.code.length < l.raw.length) comments.push(l.raw.slice(l.code.length).trim());
  return c.ok ? { ok: true, canonical: c.canonical, cid: c.cid, comments, diagnostics: [] } : { ok: false, canonical: null, cid: null, comments, diagnostics: c.diagnostics };
}

export function mockHighlight(text) {
  const out = [];
  const re = /(#[^\n]*)|("[^"\n]*")|([A-Za-z_][A-Za-z0-9_#-]*)(\()?|(-?\d+(?:\.\d+)?[k%]?)|(->|[~|<>\[\]{}():,=*!^])/g;
  let m;
  while ((m = re.exec(text))) {
    const a = m.index;
    const b = a + m[0].length;
    if (m[1]) {
      if (a === 0 || /\s/.test(text[a - 1])) out.push([a, b, 'comment']);
      else out.push([a, a + 1, 'op']);
    } else if (m[2]) out.push([a, b, 'string']);
    else if (m[3]) {
      const w = m[3];
      const after = text.slice(b - (m[4] ? 1 : 0)).startsWith('=') ? '=' : '';
      let cls = 'word';
      if (m[4]) cls = 'generator';
      else if (after && PARAMS.includes(w)) cls = 'param';
      else if (w === 'A' || w === 'B') cls = 'deck';
      else if (ROLES.includes(w)) cls = 'role';
      else if (KEYWORDS.includes(w)) cls = 'keyword';
      else if (ACTIONS.includes(w)) cls = 'action';
      else if (w === 'x' || /^[a-g][#b]?-?\d?$/.test(w)) cls = 'step';
      out.push([a, a + w.length, cls]);
      if (m[4]) out.push([b - 1, b, 'op']);
    } else if (m[5]) out.push([a, b, 'number']);
    else if (m[6]) out.push([a, b, m[6] === '~' ? 'rest' : 'op']);
  }
  return out;
}

function b64url(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function mockShare(text, _sig, _notes, origin = 'https://btw.bitwrap.io') {
  const c = mockCheck(text);
  if (!c.ok) return { ok: false, error: 'the program has errors' };
  const packed = b64url(c.canonical);
  return { ok: true, url: `${origin}/#${c.cid}.${packed}`, social_url: `${origin}/c/${c.cid}.${packed}`, beats_url: `https://beats.bitwrap.io/p#${c.cid}.${packed}`, cid: c.cid, chars: `${origin}/#${c.cid}.${packed}`.length, canonical: c.canonical, warnings: [] };
}

export function mockOpen(s) {
  const m = /([zZ][1-9A-HJ-NP-Za-km-z]{20,})(?:\.([A-Za-z0-9_-]+))?/.exec(s || '');
  if (!m) return { ok: false, error: 'not a btw link or CID', cid: null };
  if (!m[2]) return { ok: false, cid: m[1], error: 'a bare CID has no text: fetch it from the server' };
  let text;
  try { text = unb64url(m[2]); } catch { return { ok: false, cid: m[1], error: 'the link text is not valid' }; }
  const c = mockCheck(text);
  if (!c.ok) return { ok: false, cid: m[1], error: 'the linked program has errors' };
  if (c.cid !== m[1]) return { ok: false, cid: m[1], canonical: c.canonical, verified: false, error: `refused: the link says ${m[1]} but its text is ${c.cid}` };
  return { ok: true, cid: c.cid, canonical: c.canonical, verified: true, warnings: [], notes_unverified: [], error: null };
}

export const mockInstruments = () => ({ voices: ['wobble-lead', 'pwm-lead', 'warm-pad', 'sub-bass', 'detuned-saw'], families: ['bass', 'pad', 'acid', 'reese'], kits: ['drums-808', 'drums-909'], palettes: [] });

// ---- the runtime --------------------------------------------------------------------------------

const round3 = (x) => Math.round(x * 1000) / 1000;

/** Where in a pattern's bar each term sounds, in beats; `*N` gives N hits in its slot. */
function termFires(termWords) {
  const terms = termWords.filter((w) => !/^[a-z]+=/.test(w.w) && !w.w.startsWith('|'));
  const n = terms.length || 1;
  const out = [];
  terms.forEach((t, i) => {
    if (t.w === '~') return;
    const mul = /\*(\d+)$/.exec(t.w);
    const k = mul ? Number(mul[1]) : 1;
    for (let j = 0; j < k; j++) out.push({ beat: ((i + j / k) / n) * 4, span: t });
  });
  return out;
}

export class MockRun {
  constructor() {
    this.compiled = null;
    this.text = '';
    this.running = false;
    this.started = false;
    this.pending = null;
    this.originBeat = 0;
    this.pos = 0; // beats since origin
    this.line = 0;
    this._cid = '';
  }

  eval(text) {
    const c = mockCheck(text);
    if (!c.ok) return { ok: false, diagnostics: c.diagnostics, cid: null, canonical: null, nets: {}, lands: null, unchanged: false, lineage: [], evolve: [] };
    if (this.running && this.text === text) return { ok: true, diagnostics: [], cid: c.cid, canonical: c.canonical, nets: {}, lands: null, unchanged: true, lineage: [], evolve: [] };
    this.text = text;
    this.compiled = parseProgram(text);
    this._cid = c.cid;
    this.running = true;
    if (!this.started) this.pending = true;
    return { ok: true, diagnostics: c.diagnostics, cid: c.cid, canonical: c.canonical, nets: { A: mockCid(`A${text}`), B: mockCid(`B${text}`) }, changes: ['deck A: loaded', 'deck B: loaded'], lands: this.started ? this.line + 1 : null, unchanged: false, lineage: [], evolve: [] };
  }

  stop() {
    this.running = false;
    this.started = false;
    return [];
  }

  service(gridJson) {
    const g = typeof gridJson === 'string' ? JSON.parse(gridJson || 'null') : gridJson;
    const cmds = [];
    if (!this.running) return cmds;
    if (this.pending) {
      this.pending = false;
      const bpm = (this.compiled && this.compiled.tempo) || (g && g.bpm) || 120;
      for (const d of ['A', 'B']) {
        cmds.push({ op: 'load_net', deck: d, envelope: { bpm, mock: true } });
        cmds.push({ op: 'play', deck: d, on: true });
      }
      return cmds;
    }
    if (!g || !g.playing || !(g.playing.A || g.playing.B)) return cmds;
    if (!this.started) {
      this.started = true;
      this.originBeat = Math.floor(g.beat / 4 + 1e-9) * 4;
    }
    this.pos = Math.max(0, g.beat - this.originBeat);
    this.line = Math.floor(this.pos / 4 + 1e-9);
    return cmds;
  }

  running_cid() {
    return this._cid;
  }

  _sectionAt(bar) {
    const p = this.compiled;
    if (!p || !p.timeline.length) return null;
    for (let i = 0; i < p.timeline.length; i++) {
      const t = p.timeline[i];
      if (bar >= t.start && bar < t.start + t.bars) return { i, ...t, barIn: bar - t.start };
    }
    return null;
  }

  _ended() {
    const p = this.compiled;
    return !!(p && p.songBars && this.line >= p.songBars && this.started);
  }

  status() {
    const p = this.compiled;
    const o = { running: this.running, bar: this.line, bar_in_phrase: (this.line % 8) + 1, phrase: Math.floor(this.line / 8) + 1, beat_in_bar: round3((this.pos % 4) + 1), clock: this.started, ended: this._ended(), errors: 0, words: [] };
    if (!this.running || !p) return o;
    o.arranged = p.arranged;
    o.loops = false;
    const s = this._sectionAt(this.line);
    if (s) {
      o.section = s.name;
      o.section_bar = s.barIn + 1;
      o.section_bars = s.bars;
      const ev = p.stmts.find((x) => x.kind === 'evolve' && x.ev.sectionIdx === p.sections.indexOf(s.sec));
      if (ev) o.generation = Math.floor(s.barIn / ev.ev.every);
    }
    if (p.songBars) {
      o.song_bars = p.songBars;
      o.song_bar = this.line + 1;
    }
    o.cid = this._cid;
    o.text = this.text;
    return o;
  }

  marks() {
    const p = this.compiled;
    const m = { running: this.running, ended: this._ended(), cid: this._cid, bar: round3(this.pos / 4), header: null, active_lines: [], fires: [], controls: [], generation: null, generation_flash_beats: null, evolve_spans: [] };
    if (!this.running || !p || !this.started) return m;
    const text = this.text;
    const mk = (start, end) => {
      const before = text.slice(0, start);
      const line = before.split('\n').length;
      const col = start - before.lastIndexOf('\n');
      return { start, end, start16: start, end16: end, line, col, len: end - start };
    };
    const sec = this._sectionAt(this.line);
    if (p.arranged && !sec) return m;
    const secIdx = sec ? p.sections.indexOf(sec.sec) : -1;
    const barIn = sec ? sec.barIn : this.line;
    const startBeat = sec ? sec.start * 4 : 0;
    const posBeat = this.pos;
    if (sec) m.header = { span: mk(sec.sec.headerStart, sec.sec.headerEnd), progress: round3((posBeat - sec.start * 4) / (sec.bars * 4)) };
    const inScope = (st) => st.sectionIdx === -1 || st.sectionIdx === secIdx;
    const callSpansOf = (defName) => p.stmts.filter((s) => s.kind === 'call' && s.name === defName && s.sectionIdx === secIdx).map((s) => s.call);
    for (const st of p.stmts) {
      if (st.kind === 'part') {
        let calls = [];
        if (st.defName) {
          calls = callSpansOf(st.defName);
          if (!calls.length) continue;
        } else if (!inScope(st)) continue;
        m.active_lines.push(mk(st.line.start + (st.line.indent || 0), st.line.start + st.line.code.trimEnd().length));
        for (const part of st.parts) {
          const sub = text.slice(part.from, part.to);
          const ws = words({ code: text.slice(part.from, part.to), start: part.from }, 0).slice(1);
          const flat = [];
          for (const w of ws) {
            const name = w.w.replace(/\*\d+$/, '');
            if (p.lets[name]) {
              const lt = p.lets[name];
              const lws = words({ code: text.slice(lt.from, lt.to), start: lt.from }, 0);
              const per = termFires(lws);
              for (const f of per) flat.push({ beat: f.beat, span: f.span, via: w });
            } else flat.push(...termFires([w]).map((f) => ({ ...f, via: null })));
          }
          // terms that are lets spread over the bar on their own; direct terms share it
          const direct = ws.filter((w) => !p.lets[w.w.replace(/\*\d+$/, '')]);
          if (direct.length === ws.length) {
            flat.length = 0;
            for (const f of termFires(ws)) flat.push({ ...f, via: null });
          }
          void sub;
          for (const f of flat) {
            for (const bar of [this.line, this.line - 1]) {
              if (bar < (sec ? sec.start : 0)) continue;
              const when = bar * 4 + f.beat;
              const age = posBeat - when;
              if (age >= 0 && age < 2) {
                const spans = [mk(f.span.start, f.span.end)];
                if (f.via) spans.push(mk(st.line.start, st.line.start + st.line.code.trimEnd().length));
                else spans.push(mk(st.line.start + st.line.indent, st.line.start + st.line.code.trimEnd().length));
                const cs = f.via ? [mk(f.via.start, f.via.end)] : calls.map((c) => mk(c.start, c.end));
                if (f.via) spans.splice(1, 1, mk(st.line.start + st.line.indent, st.line.start + st.line.code.trimEnd().length));
                spans.push(...cs);
                m.fires.push({ deck: st.deck, role: part.role, age_beats: round3(age), spans, call_sites: cs });
                break;
              }
            }
          }
        }
      } else if (st.kind === 'ctl' && inScope(st)) {
        const base = sec ? sec.start : 0;
        const startBar = base;
        const t = st.text;
        let age = null;
        let progress = null;
        const every = /^every\s+(\d+)\s+bars/.exec(t);
        const atBar = /^at\s+bar\s+(\d+)/.exec(t);
        const before = /^before\s+(\w+)\s+(\d+)\s+bars/.exec(t);
        if (every) {
          const n = Number(every[1]);
          const k = Math.floor(this.line / n) * n;
          if (k > 0) age = posBeat - k * 4;
        } else if (atBar) age = posBeat - (startBar + Number(atBar[1])) * 4;
        else if (before) {
          const target = p.timeline.find((x) => x.name === before[1]);
          if (target) age = posBeat - (target.start - Number(before[2])) * 4;
        } else age = posBeat - startBar * 4;
        if (age != null && age < 0) age = null;
        if (st.ramp) {
          progress = Math.min(1, Math.max(0, (posBeat - startBar * 4) / (st.ramp * 4)));
          if (progress >= 1) progress = null;
        }
        m.controls.push({ line: t, span: mk(st.span.start, st.span.end), via: [], age_beats: age == null ? null : round3(age), progress: progress == null ? null : round3(progress), held: /\bfor\s+\d+\s+bars/.test(t) && age != null && age < 16 });
        m.active_lines.push(mk(st.span.start, st.span.end));
      }
    }
    const ev = p.stmts.find((x) => x.kind === 'evolve' && x.ev.sectionIdx === secIdx);
    if (ev && sec) {
      const gen = Math.floor(barIn / ev.ev.every);
      m.generation = gen;
      const genStart = (sec.start + gen * ev.ev.every) * 4;
      const sinceBeats = posBeat - genStart;
      if (gen > 0 && sinceBeats < 8) m.generation_flash_beats = round3(sinceBeats);
      const endLine = p.lines[ev.ev.endLine];
      m.evolve_spans = [mk(ev.ev.startOff, endLine.start + endLine.code.trimEnd().length)];
    }
    void barIn;
    return m;
  }
}

// ---- the engine stand-in ---------------------------------------------------------------------------

/** Plays nothing, but keeps a clock the way the real engine's grid() does: a beat count from the first `play on`. */
export async function createMockEngine({ context, destination }) {
  const state = { bpm: 120, playing: { A: false, B: false }, t0: null, level: 1 };
  const out = context.createGain();
  out.connect(destination || context.destination);
  return {
    ready: Promise.resolve(),
    mock: true,
    apply(cmds) {
      for (const c of cmds || []) {
        if (c.op === 'load_net' && c.envelope && c.envelope.bpm) state.bpm = c.envelope.bpm;
        if (c.op === 'play') {
          state.playing[c.deck] = !!c.on;
          if (c.on && state.t0 == null) state.t0 = context.currentTime + 0.05;
          if (!state.playing.A && !state.playing.B) state.t0 = null;
        }
      }
    },
    grid() {
      if (state.t0 == null) return null;
      return { deck: 'A', beat: Math.max(0, ((context.currentTime - state.t0) * state.bpm) / 60), bpm: state.bpm, playing: { ...state.playing } };
    },
    setLevel(v) { out.gain.value = v; },
    dispose() { out.disconnect(); },
  };
}

// ---- the module's surface ----------------------------------------------------------------------------

export function mockModule() {
  const j = (f) => (...a) => JSON.stringify(f(...a));
  return {
    mock: true,
    btw_check: j(mockCheck),
    btw_fmt: j(mockFmt),
    btw_highlight: j(mockHighlight),
    btw_open: j(mockOpen),
    btw_share: (t, s, n) => JSON.stringify(mockShare(t, s, n)),
    btw_instruments: j(mockInstruments),
    btw_generation: () => JSON.stringify({ ok: true, cid: 'zMockGen', scope: 'drop', n: 1 }),
    btw_cheatsheet: () => '# btw cheat sheet (mock)\n',
    BtwRun: class {
      constructor() { this.r = new MockRun(); }
      eval(t) { return JSON.stringify(this.r.eval(t)); }
      stop() { return JSON.stringify(this.r.stop()); }
      service(g) { return JSON.stringify(this.r.service(g)); }
      marks() { return JSON.stringify(this.r.marks()); }
      status() { return JSON.stringify(this.r.status()); }
      running_cid() { return this.r.running_cid(); }
      free() {}
    },
  };
}
