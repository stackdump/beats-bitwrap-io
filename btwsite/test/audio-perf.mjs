#!/usr/bin/env node
// audio-perf.mjs: how the in-page engine (real wasm, AudioWorklet) holds up while the real page plays a program.
//
//   node btwsite/test/audio-perf.mjs [--program hand-dubstep-140-v4] [--seconds 30] [--server URL] [--json out.json]
//                                    [--sink null|device] [--query latency=interactive] [--max-overruns-per-min N] [--max-underruns N]
//
// --query adds to the page's query string (latency=interactive is the page as it was before the 0.1 s buffer).
//
// Opens the page (the mock server with the real wasm, or --server), puts the program in the editor, plays it on the engine
// (not the stream) and, for --seconds, records:
//   - every AudioWorkletProcessor.process() call on the realtime audio thread, from a Chrome trace (category
//     disabled-by-default-audio-worklet, "author script execution": the time inside our process(), to the microsecond).
//     The budget of one 128-frame render quantum is 128 / sampleRate (2.67 ms at 48 kHz); a call over it is an overrun.
//     The trace's thread time against its wall time tells a slow call from a thread that was waiting for a CPU (a busy machine).
//   - the worklet's own slow blocks (?perf=1, which the test always sets: Date.now() around each part of process(), 1 ms steps),
//     grouped by what the block did (install step, landing, bar-line plays, tick, grid report).
//   - AudioContext.playbackStats (Chrome): underrunEvents / underrunDuration, the glitches the listener hears.
//   - the audio clock against the wall clock, baseLatency / outputLatency.
//   - main-thread long tasks (PerformanceObserver 'longtask', > 50 ms) and the frame rate.
//   - the engine's own stats (loads, prepare and install times).
// Prints a table and exits 1 when a --max-* threshold is given and broken. Skips (exit 0) without the wasm or Chrome.
//
// --sink null (the default) is Chrome's --disable-audio-output: a fake sink with the same callback cadence, no sound card.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, launch, sleep } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true; };
const PROGRAM = String(arg('program', 'hand-dubstep-140-v4'));
const SECONDS = Number(arg('seconds', 30));
const SERVER = arg('server', null);
const SINK = arg('sink', 'null');
const JSON_OUT = arg('json', null);
const MAX_OVERRUNS = arg('max-overruns-per-min', null);
const MAX_UNDERRUNS = arg('max-underruns', null);
const QUERY = String(arg('query', ''));

if (!SERVER && !fs.existsSync(path.join(site, 'web', 'wasm', 'btw_bg.wasm'))) { console.log('SKIP audio-perf: no built module in btwsite/web/wasm'); process.exit(0); }
if (!fs.existsSync(CHROME)) { console.log(`SKIP audio-perf: no Chrome at ${CHROME}`); process.exit(0); }

let base = SERVER;
let server = null;
if (!base) {
  const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  server = spawn('node', [path.join(here, 'mock-server.mjs'), '--port', String(port)], { stdio: ['ignore', 'ignore', 'inherit'] });
  process.on('exit', () => { try { server.kill('SIGKILL'); } catch { /* gone */ } });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* starting */ } await sleep(100); }
}

// the program: an example name, a path to a .btw file, or a URL path on the server
let text;
if (fs.existsSync(PROGRAM)) text = fs.readFileSync(PROGRAM, 'utf8');
else {
  const p = PROGRAM.startsWith('/') ? PROGRAM : `/examples/${PROGRAM.replace(/\.btw$/, '')}.btw`;
  const r = await fetch(`${base}${p}`);
  if (!r.ok) { console.error(`audio-perf: ${p}: HTTP ${r.status}`); process.exit(2); }
  text = await r.text();
}

const stats = (xs) => {
  if (!xs.length) return { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / s.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s[s.length - 1] };
};

const page = await launch({ width: 1280, height: 800, args: SINK === 'null' ? ['--disable-audio-output'] : [] });
let out = null;
let failed = 0;
try {
  await page.goto(`${base}/?perf=1${QUERY ? `&${QUERY}` : ''}`);
  await page.waitFor('window.__app && window.__app.wasmOk', 30000);
  await page.eval(`(()=>{
    window.__perf = { longtasks: [], frames: 0 };
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.longtasks.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: false }); } catch (e) { window.__perf.noLongtask = String(e); }
    const f = () => { window.__perf.frames++; requestAnimationFrame(f); }; requestAnimationFrame(f);
    __app.setProgram(${JSON.stringify(text)}, { name: 'audio perf', quiet: true });
  })()`);
  await page.click('.ed'); // the gesture that makes the AudioContext; the engine loads behind it
  await page.waitFor("window.__app.engineState === 'ready' || window.__app.engineState === 'failed'", 60000);
  if ((await page.eval('__app.engineState')) !== 'ready') throw new Error(`the engine did not load: ${await page.eval('__app.engineError')}`);
  await page.eval("(()=>{ __app.sourcePref = 'engine'; })()");

  // the trace: the audio thread's process() calls, and the device callbacks
  const events = [];
  let traced;
  const done = new Promise((r) => { traced = r; });
  page.listen((d) => {
    if (d.method === 'Tracing.dataCollected') for (const e of d.params.value) if (e.ph === 'X' || e.name === 'thread_name') events.push(e);
    if (d.method === 'Tracing.tracingComplete') traced();
  });
  await page.cdp('Tracing.start', { traceConfig: { includedCategories: ['disabled-by-default-audio-worklet', 'audio', '__metadata'], excludedCategories: ['*'] }, transferMode: 'ReportEvents' });

  await page.click('#btn-play');
  await page.waitFor('(()=>{ const l = __app.driver && __app.driver.last; return !!(l && l.grid && l.grid.playing && (l.grid.playing.A || l.grid.playing.B)); })()', 60000);
  const snap = () => page.eval(`(()=>{
    const c = __app.ctx, ps = c.playbackStats ? (c.playbackStats.toJSON ? c.playbackStats.toJSON() : { ...c.playbackStats }) : null;
    const l = __app.driver && __app.driver.last;
    return { wall: performance.now(), ctx: c.currentTime, ps, sr: c.sampleRate, base: c.baseLatency, out: c.outputLatency, kind: __app.driver && __app.driver.kind,
             bar: l && l.marks ? l.marks.bar : null, section: l && l.status ? l.status.section : null, frames: window.__perf.frames, longtasks: window.__perf.longtasks.length };
  })()`);
  const a = await snap();
  const sections = [];
  const t0 = Date.now();
  while (Date.now() - t0 < SECONDS * 1000) {
    await sleep(500);
    const s = await snap();
    if (s.section && sections[sections.length - 1] !== s.section) sections.push(s.section);
  }
  const b = await snap();
  await page.cdp('Tracing.end');
  await Promise.race([done, sleep(30000)]);
  const lt = (await page.eval('window.__perf.longtasks')).filter(([st]) => st >= a.wall && st <= b.wall).map(([, d]) => d);
  const eng = await page.eval('JSON.parse(JSON.stringify(__app.engine.stats))');

  // the audio thread: the thread whose name says AudioWorklet
  const names = {};
  for (const e of events) if (e.name === 'thread_name') names[`${e.pid}:${e.tid}`] = e.args.name;
  const awTid = Object.keys(names).find((k) => /AudioWorklet/i.test(names[k]));
  const proc = events.filter((e) => e.name === 'AudioWorkletProcessor::Process (author script execution)' && (!awTid || `${e.pid}:${e.tid}` === awTid));
  const spanUs = proc.length ? proc[proc.length - 1].ts - proc[0].ts : 0;
  const ms = proc.map((e) => e.dur / 1000);
  const budget = (128 / a.sr) * 1000;
  const over = ms.filter((x) => x > budget);
  // the trace's thread time (tdur) against the wall time (dur): an overrun whose thread ran for less than half of it was the
  // audio thread waiting for a CPU (the machine is busy, or the thread has no realtime priority), not our code being slow
  const overEv = proc.filter((e) => e.dur / 1000 > budget);
  const preempted = overEv.filter((e) => typeof e.tdur === 'number' && e.tdur < e.dur / 2).length;
  const cpuMs = proc.filter((e) => typeof e.tdur === 'number').map((e) => e.tdur / 1000);
  const cpuOver = cpuMs.filter((x) => x > budget).length;
  const cb = events.filter((e) => e.name === 'AudioOutputDevice::FireRenderCallback');
  // the worst stretch: the most audio-thread time spent in any 10.67 ms (512-frame) window, as a fraction of it
  const win = (512 / a.sr) * 1e6;
  let worst = 0;
  for (let i = 0, j = 0, sum = 0; i < proc.length; i++) {
    sum += proc[i].dur;
    while (proc[i].ts - proc[j].ts > win) { sum -= proc[j].dur; j++; }
    worst = Math.max(worst, sum / win);
  }
  const wallS = (b.wall - a.wall) / 1000;
  const min = wallS / 60;
  out = {
    program: PROGRAM, seconds: wallS, sink: SINK, source: b.kind, sampleRate: a.sr, baseLatency: a.base, outputLatency: b.out, sections,
    audioClock: { audioS: b.ctx - a.ctx, wallS },
    process: { ...stats(ms), budgetMs: budget, overruns: over.length, overrunsPerMin: over.length / min, over2x: ms.filter((x) => x > 2 * budget).length, perSecond: spanUs ? proc.length / (spanUs / 1e6) : 0, worstWindow: worst, preempted, cpu: stats(cpuMs), cpuOverruns: cpuOver },
    deviceCallbacks: { n: cb.length, mean: stats(cb.map((e) => e.dur / 1000)).mean, max: stats(cb.map((e) => e.dur / 1000)).max },
    playback: a.ps && b.ps ? { underrunEvents: b.ps.underrunEvents - a.ps.underrunEvents, underrunMs: (b.ps.underrunDuration - a.ps.underrunDuration) * 1000, averageLatencyMs: b.ps.averageLatency * 1000, maximumLatencyMs: b.ps.maximumLatency * 1000 } : null,
    main: { longtasks: lt.length, longtasksPerMin: lt.length / min, longtaskMaxMs: lt.length ? Math.max(...lt) : 0, longtaskTotalMs: lt.reduce((x, y) => x + y, 0), fps: (b.frames - a.frames) / wallS },
    slow: eng.slow || [],
    engine: { loads: eng.loads, prepareMs: stats(eng.prepareMs || []), installMs: stats(eng.installMs || []), installQuanta: stats(eng.installQuanta || []) },
  };
  const f = (x, d = 3) => (typeof x === 'number' ? x.toFixed(d) : String(x));
  const p = out.process;
  console.log(`# audio-perf ${PROGRAM}: ${f(wallS, 1)} s on the ${b.kind} (${SINK} sink, ${a.sr} Hz, base latency ${f(a.base * 1000, 1)} ms, output latency ${f((b.out || 0) * 1000, 1)} ms)`);
  console.log(`  sections heard       ${sections.join(' ')}`);
  console.log(`  process() per block  n ${p.n} (${f(p.perSecond, 0)}/s)  mean ${f(p.mean)}  p50 ${f(p.p50)}  p95 ${f(p.p95)}  p99 ${f(p.p99)}  max ${f(p.max)} ms  (budget ${f(budget)} ms)`);
  console.log(`  overruns             ${p.overruns} (${f(p.overrunsPerMin, 1)}/min), over 2x budget ${p.over2x}; busiest 10.7 ms window ${f(p.worstWindow * 100, 0)}% of real time`);
  console.log(`  of which preempted   ${p.preempted} (the thread ran < half the wall time); by thread CPU time: mean ${f(p.cpu.mean)} p99 ${f(p.cpu.p99)} max ${f(p.cpu.max)} ms, ${p.cpuOverruns} over budget`);
  if (out.playback) console.log(`  underruns (heard)    ${out.playback.underrunEvents} events, ${f(out.playback.underrunMs, 1)} ms of silence; latency avg ${f(out.playback.averageLatencyMs, 1)} max ${f(out.playback.maximumLatencyMs, 1)} ms`);
  console.log(`  audio clock          ${f(out.audioClock.audioS, 2)} s in ${f(wallS, 2)} s of wall time`);
  console.log(`  main thread          ${out.main.longtasks} long tasks (${f(out.main.longtasksPerMin, 1)}/min, max ${f(out.main.longtaskMaxMs, 0)} ms, total ${f(out.main.longtaskTotalMs, 0)} ms), ${f(out.main.fps, 1)} frames/s`);
  console.log(`  engine               ${eng.loads} loads; prepare mean ${f(out.engine.prepareMs.mean, 0)} ms max ${f(out.engine.prepareMs.max, 0)}; install mean ${f(out.engine.installMs.mean, 0)} ms over mean ${f(out.engine.installQuanta.mean, 1)} quanta`);
  if (out.slow.length) {
    // where the slow blocks' time went (the worklet's ?perf=1 report, Date.now() steps of 1 ms): I install_step, L landed, B bar-line plays, T tick, G grid
    const by = {};
    for (const x of out.slow) { const k = x.did || '-'; const e = (by[k] = by[k] || { n: 0, ms: 0, install: 0, bars: 0, render: 0, tick: 0, grid: 0 }); e.n++; for (const f2 of ['ms', 'install', 'bars', 'render', 'tick', 'grid']) e[f2] += x[f2]; }
    console.log('  slow blocks (>= 3 ms by the worklet clock), by what the block did: I install, L landed, B bar plays, T tick, G grid');
    for (const [k, e] of Object.entries(by).sort((x, y) => y[1].ms - x[1].ms)) console.log(`    ${k.padEnd(6)} ${String(e.n).padStart(4)} blocks, ${e.ms} ms: install ${e.install} bars ${e.bars} render ${e.render} tick ${e.tick} grid ${e.grid}`);
  }
  if (MAX_OVERRUNS !== null && p.overrunsPerMin > Number(MAX_OVERRUNS)) { console.log(` FAIL overruns ${f(p.overrunsPerMin, 1)}/min > ${MAX_OVERRUNS}`); failed++; }
  if (MAX_UNDERRUNS !== null && out.playback && out.playback.underrunEvents > Number(MAX_UNDERRUNS)) { console.log(` FAIL underruns ${out.playback.underrunEvents} > ${MAX_UNDERRUNS}`); failed++; }
  const errs = page.errors();
  if (errs.length) { console.log(` FAIL console errors: ${errs.map((e) => e.text).join(' | ').slice(0, 400)}`); failed++; }
} catch (e) {
  console.log(`audio-perf: ${e.message}`);
  failed++;
} finally {
  await page.close();
  if (server) try { server.kill('SIGKILL'); } catch { /* gone */ }
}
if (JSON_OUT && out) fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
process.exit(failed ? 1 : 0);
