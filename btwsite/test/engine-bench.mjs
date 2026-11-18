#!/usr/bin/env node
// engine-bench.mjs: what each thing the worklet does in a render quantum costs, measured in Node against the built module
// (same V8, same wasm; performance.now, which an AudioWorkletGlobalScope does not have). No browser, no npm.
//
//   node btwsite/test/engine-bench.mjs [--program hand-dubstep-140-v4] [--budget 12288] [--seconds 20]
//
// A real BtwRun evaluates the program on a fake clock; every load_net it asks for is prepared by a DjComposer and installed in a
// Dj with begin_install / install_step(budget) a quantum at a time, between render() calls, as engine-worklet.js does. Prints,
// in milliseconds: render() per 128-frame block, tick(), state() + JSON.parse (what the grid report and the bar-line plays do),
// and every install_step, the last (landing) step apart; and on the page's side, BtwRun.service() (apart when it hands out loads),
// marks(), status() and the size of each load_net envelope (KB). The budget of a quantum at 48 kHz is 2.67 ms.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, '..');
const wasmDir = path.join(site, 'web', 'wasm');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };
if (!fs.existsSync(path.join(wasmDir, 'btw_bg.wasm'))) { console.log('SKIP engine-bench: no built module in btwsite/web/wasm'); process.exit(0); }
const PROGRAM = arg('program', 'hand-dubstep-140-v4');
const BUDGET = Number(arg('budget', 12 * 1024));
const SECONDS = Number(arg('seconds', 20));
const SR = 48000, Q = 128;

const glue = await import(pathToFileURL(path.join(wasmDir, 'btw.js')).href);
glue.initSync({ module: fs.readFileSync(path.join(wasmDir, 'btw_bg.wasm')) });
const file = fs.existsSync(PROGRAM) ? PROGRAM : path.join(site, 'examples', `${PROGRAM.replace(/\.btw$/, '')}.btw`);
const text = fs.readFileSync(file, 'utf8');

const run = new glue.BtwRun();
const ev = JSON.parse(run.eval(text));
if (!ev.ok) { console.error('the program does not check', ev.diagnostics && ev.diagnostics[0]); process.exit(2); }
const dj = new glue.Dj(SR);
const comp = new glue.DjComposer(SR);
const now = () => performance.now();
const T = { render: [], tick: [], state: [], step: [], land: [], prepare: [], service: [], serviceLoad: [], marks: [], status: [], envelopeKB: [] };
const L = new Float32Array(Q), R = new Float32Array(Q);
const queue = []; // [deck, bytes]
let playing = { A: false, B: false };
let bpm = 120;
const blocks = Math.round((SECONDS * SR) / Q);
for (let q = 0; q < blocks; q++) {
  // the page's 25 ms service, on the engine's own beat
  if (q % Math.round((0.025 * SR) / Q) === 0) {
    const d = ['A', 'B'].find((k) => playing[k]);
    let grid = null;
    if (d) {
      let t = now(); const s = JSON.parse(dj.state(d)); T.state.push(now() - t);
      bpm = Number(s.tempo) || bpm;
      const tick = Number(s.tick) || 0;
      grid = { deck: d, beat: (tick === 0 ? 0 : Math.max(0, (Number(s.position) || tick) - 1)) / 4, bpm, playing: { ...playing } };
    }
    let t1 = now(); const cmds = JSON.parse(run.service(JSON.stringify(grid))); const ds = now() - t1;
    (cmds.some((c) => c.op === 'load_net') ? T.serviceLoad : T.service).push(ds);
    t1 = now(); run.marks(); T.marks.push(now() - t1);
    if (q % (Math.round((0.025 * SR) / Q) * 80) === 0) { t1 = now(); run.status(); T.status.push(now() - t1); }
    for (const c of cmds) {
      if (c.op === 'load_net') T.envelopeKB.push(JSON.stringify(c.envelope).length / 1024);
      if (c.op === 'load_net') {
        const t = now(); const bytes = comp.prepare_share(c.deck, JSON.stringify(c.envelope), '[]'); T.prepare.push(now() - t);
        queue.push([c.deck, bytes]);
      } else if (c.op === 'play') { if (!dj.installing() && !queue.length) dj.set_playing(c.deck, !!c.on); playing[c.deck] = !!c.on; }
    }
  }
  if (!dj.installing() && queue.length) { const [deck, bytes] = queue.shift(); dj.begin_install(deck, bytes); }
  if (dj.installing()) {
    const t = now(); const r = dj.install_step(BUDGET); const dt = now() - t;
    if (r) { T.land.push(dt); T.answerKB = T.answerKB || []; T.answerKB.push(r.length / 1024); const tp = now(); JSON.parse(r); (T.answerParse = T.answerParse || []).push(now() - tp); if (!queue.length) for (const k of ['A', 'B']) dj.set_playing(k, playing[k]); } else T.step.push(dt);
  }
  let t = now(); dj.render(L, R); T.render.push(now() - t);
  if (q % 4 === 0) { t = now(); dj.tick(); T.tick.push(now() - t); }
}
const st = (xs) => { const s = [...xs].sort((a, b) => a - b); const p = (x) => s[Math.min(s.length - 1, Math.floor(x * s.length))] || 0; return `n ${String(s.length).padStart(6)}  mean ${(s.reduce((a, b) => a + b, 0) / (s.length || 1)).toFixed(3)}  p95 ${p(0.95).toFixed(3)}  p99 ${p(0.99).toFixed(3)}  max ${(s[s.length - 1] || 0).toFixed(3)}`; };
console.log(`# engine-bench ${PROGRAM}: ${SECONDS} s at ${SR} Hz, install budget ${BUDGET} B a quantum (block budget ${(Q / SR * 1000).toFixed(2)} ms)`);
for (const k of Object.keys(T)) console.log(`  ${k.padEnd(8)} ${st(T[k])}`);
