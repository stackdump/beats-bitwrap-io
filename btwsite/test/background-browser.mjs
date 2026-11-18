#!/usr/bin/env node
// background-browser.mjs: does the page keep time when it is hidden?
//
//   node btwsite/test/background-browser.mjs [--seconds 30] [--mode hidden|frozen] [--without-pump]
//
// Headless Chrome plays a looping program on the in-page engine (real wasm, mock server), then the page is hidden for
// --seconds: a second tab is opened and activated, so document.hidden is true and Chrome throttles the page the way it does a
// background tab (no animation frames, timers at 1 Hz). While it is hidden the test reads, over CDP, the program runtime's bar
// counter (what BtwRun was last serviced with: sections, loads and ramps depend on it) and the worklet's own bar counter (the
// audio thread), and compares both with wall time at the program's tempo: within one bar. Then the tab is shown again and the first
// seconds are watched for a catch-up burst: the runtime's bar counter must not jump by more than a bar between reads, and the
// engine must not be handed a flood of commands.
//
//   --mode frozen   Page.setWebLifecycleState frozen instead (nothing runs on the page at all, not even message events); only the
//                   return can be read (CDP leaves the thawed page hidden, so "painting again" is not asserted). Held to the no-burst checks; the in-step checks are for the hidden mode:
//                   a frozen page cannot service anything, which is why the offer to stream exists.
//   --without-pump  load the page with ?pump=0 (the runtime is serviced by the frame loop alone, as before the fix): the bar
//                   checks are then expected to FAIL; the test passes if they do (it proves the test can see the stall).
//
// Skips (exit 0) when the wasm is not built or Chrome is not installed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, launch, sleep } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true; };
const SECONDS = Number(arg('seconds', 30));
const MODE = arg('mode', 'hidden');
const NEGATIVE = arg('without-pump', false) === true;
const BPM = 120; // 2 s a bar
// a null audio sink that still runs the AudioContext's clock: no sound card is opened (the machine may be playing something else)
const AUDIO_ARGS = ['--disable-audio-output'];

if (!fs.existsSync(path.join(site, 'web', 'wasm', 'btw_bg.wasm'))) { console.log('SKIP background-browser: no built module in btwsite/web/wasm'); process.exit(0); }
if (!fs.existsSync(CHROME)) { console.log(`SKIP background-browser: no Chrome at ${CHROME}`); process.exit(0); }

// 2-bar sections of 4 s each, alternating, enough of them to outlast the test: every section change is the runtime loading the next net into the engine
const SECTIONS = Math.ceil((SECONDS + 30) / 4) + 2;
const PROGRAM = `tempo ${BPM}
key am
section verse 2 bars {
  deck A: kick e(5,8) | hihat x*8
  deck B: harmony chord(am7)
}
section chorus 2 bars {
  deck A: kick x ~ x ~ | snare ~ x ~ x
  deck B: arp arp(am7, up, 8)
}
arrange ${Array.from({ length: SECTIONS }, (_, k) => (k % 2 ? 'chorus' : 'verse')).join(' ')}
`;

const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const server = spawn('node', [path.join(here, 'mock-server.mjs'), '--port', String(port)], { stdio: ['ignore', 'ignore', 'inherit'] });
const stop = () => { try { server.kill('SIGKILL'); } catch { /* gone */ } };
process.on('exit', stop);
for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch { await sleep(100); } }

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${!ok && detail ? `\n         ${detail}` : ''}`); if (!ok) failed++; };
const notes = [];

const page = await launch({ width: 900, height: 600, args: AUDIO_ARGS });
let other = null;
try {
  await page.goto(`http://127.0.0.1:${port}/?${NEGATIVE ? 'pump=0&' : ''}keepalive=0`);
  await page.waitFor('window.__app && window.__app.wasmOk', 20000);
  await page.eval(`(()=>{ __app.setProgram(${JSON.stringify(PROGRAM)}, { name: 'background test', quiet: true }); })()`);
  // a click is the gesture that makes the AudioContext; the engine loads behind it
  await page.click('.ed');
  await page.waitFor("window.__app.engineState === 'ready'", 30000);
  await page.eval("(()=>{ __app.sourcePref = 'engine'; })()");
  await page.click('#btn-play');
  await page.waitFor('(()=>{ const l = __app.driver && __app.driver.last; return !!(l && l.grid && l.grid.playing && l.grid.playing.A); })()', 30000);
  const ctxRunning = await page.eval("__app.ctx.state");
  check('the engine plays and the AudioContext runs', ctxRunning === 'running' && (await page.eval("__app.driver.kind")) === 'engine', `ctx ${ctxRunning}`);

  // count what the engine is handed, from here on
  await page.eval(`(()=>{
    const log = window.__bgLog = { applies: [], marks: [] };
    const e = __app.engine, orig = e.apply.bind(e);
    // structural commands (load a net, play/stop a deck, change a sound) are what a catch-up would flood; a ramp's call commands go out every pass by design
    e.apply = (cmds) => { if (cmds && cmds.length) log.applies.push([Date.now(), cmds.filter((c) => c.op !== 'call').length]); return orig(cmds); };
  })()`);
  const probe = () => page.eval(`(()=>{
    const l = __app.driver && __app.driver.last;
    return { t: Date.now(), hidden: document.hidden, frames: __app.bg ? __app.bg.stats.frames : 0, pumps: __app.bg ? __app.bg.stats.hiddenPumps : 0,
             runBar: l && l.marks ? l.marks.bar : null, sec: l && l.status ? l.status.section : null, loads: __app.engine.stats.loads, ctx: __app.ctx.currentTime, state: __app.ctx.state,
             fires: l && l.marks && l.marks.fires ? l.marks.fires.length : 0, apply: window.__bgLog.applies.reduce((n, a) => n + a[1], 0) };
  })()`);
  // a steady stretch, as a yardstick for what "normal" looks like: eight seconds, so both sections are in it
  const steady = [];
  for (let i = 0; i < 40; i++) { steady.push(await probe()); await sleep(200); }
  const steadyFires = Math.max(...steady.map((s) => s.fires));
  const steadyApplies = Math.ceil(((steady[steady.length - 1].apply - steady[0].apply) * 3) / ((steady[steady.length - 1].t - steady[0].t) / 1000)); // per 3 s

  // ---- hide ---------------------------------------------------------------------------------------------------------
  const before = await probe();
  const targets = async () => (await fetch(`http://127.0.0.1:${page.port}/json/list`)).json();
  const mine = (await targets()).find((t) => t.type === 'page' && t.url.includes(`127.0.0.1:${port}`));
  let hiddenSamples = [];
  let after;
  if (MODE === 'frozen') {
    await page.cdp('Page.setWebLifecycleState', { state: 'frozen' });
    await sleep(SECONDS * 1000);
    await page.cdp('Page.setWebLifecycleState', { state: 'active' });
    after = await probe(); // CDP leaves a thawed page hidden; the activation below shows it again, as the user would
  } else {
    other = await (await fetch(`http://127.0.0.1:${page.port}/json/new?about:blank`, { method: 'PUT' })).json();
    await fetch(`http://127.0.0.1:${page.port}/json/activate/${other.id}`);
    await page.waitFor('document.hidden === true', 10000, 100);
    const t0 = Date.now();
    while (Date.now() - t0 < SECONDS * 1000) {
      await sleep(Math.min(5000, SECONDS * 1000 - (Date.now() - t0)));
      hiddenSamples.push(await probe());
    }
    after = hiddenSamples[hiddenSamples.length - 1];
  }
  const wallS = (after.t - before.t) / 1000;
  const expectBars = (wallS * BPM) / 240;
  if (MODE !== 'frozen') {
    const f = after.frames - before.frames;
    check(`the page really was hidden (document.hidden, ${f} frames in ${wallS.toFixed(0)} s; a visible page makes ~${Math.round(wallS * 55)})`, after.hidden === true && f < 10, JSON.stringify({ hidden: after.hidden, frames: f }));
    const runBars = after.runBar - before.runBar;
    const secs = [before, ...hiddenSamples].map((x) => x.sec);
    const changes = secs.slice(1).filter((x, k) => x !== secs[k]).length;
    const expectLoads = 2 * Math.floor(wallS / 4); // a net per deck per section
    const loads = after.loads - before.loads;
    notes.push(`section at each read while hidden: ${secs.join(' ')}`);
    const ctxS = after.ctx - before.ctx;
    check(`the AudioContext clock advanced ${ctxS.toFixed(1)} s in ${wallS.toFixed(1)} s of wall time`, ctxS >= wallS * 0.95 - 0.25 && after.state === 'running', `state ${after.state}`);
    const stalled = Math.abs(runBars - expectBars) > 1;
    const m = `the runtime was serviced while hidden: its bar counter advanced ${runBars.toFixed(2)} bars (expect ${expectBars.toFixed(2)} ± 1; ${after.pumps - before.pumps} background services)`;
    if (NEGATIVE) check(`[negative control, ?pump=0] the stall is visible: ${m.replace('was serviced', 'was NOT serviced')}`, stalled, 'the runtime kept time without the background service: the test cannot see the stall');
    else check(m, !stalled, `runBar ${before.runBar} -> ${after.runBar}`);
    if (NEGATIVE) {
      check(`[negative control, ?pump=0] no section changed and the engine was handed nothing while hidden (${loads} nets loaded, ${changes} section changes in ${wallS.toFixed(0)} s)`, loads <= 1 && changes === 0, `${loads} loads, ${changes} changes`);
    } else {
      check(`sections advanced while hidden: ${changes} section changes seen in ${wallS.toFixed(0)} s at ${hiddenSamples.length} reads (a section is 4 s)`, changes >= Math.min(2, hiddenSamples.length - 1), secs.join(' '));
      check(`and the engine was handed their nets: ${loads} loads (expect about ${expectLoads}: two decks a section, ±4)`, Math.abs(loads - expectLoads) <= 4, `${loads} vs ${expectLoads}`);
    }
    // every sample along the way, not only the end: the counter must advance steadily, not catch up in one go at the end
    const bars = [before, ...hiddenSamples].map((s) => s.runBar);
    const gaps = bars.slice(1).map((b, i) => b - bars[i]);
    notes.push(`runtime bar counter at each read while hidden: ${bars.map((b) => b.toFixed(1)).join(' ')}`);
    if (!NEGATIVE) check('and it advanced at every read, not in one jump at the end', gaps.every((g) => g > 0 && g < 4 * 5 * (BPM / 240) + 1), JSON.stringify(gaps));
  }

  // ---- back -----------------------------------------------------------------------------------------------------------
  await fetch(`http://127.0.0.1:${page.port}/json/activate/${mine.id}`);
  const back = [];
  const tBack = Date.now();
  while (Date.now() - tBack < 3000) { back.push(await probe()); await sleep(100); }
  if (MODE !== 'frozen') check('the page is visible again and painting again', back[back.length - 1].hidden === false && back[back.length - 1].frames - back[0].frames > 20, JSON.stringify({ frames: back[back.length - 1].frames - back[0].frames }));
  const jumps = back.slice(1).map((s, i) => s.runBar - back[i].runBar);
  const biggest = Math.max(...jumps);
  check(`no catch-up on return: the runtime's bar counter never jumped more than a bar between reads (biggest ${biggest.toFixed(2)})`, biggest <= 1 + 1e-6 && Math.min(...jumps) > -1e-6, JSON.stringify(jumps.map((j) => +j.toFixed(2))));
  const applies = back[back.length - 1].apply - (MODE === 'frozen' ? before.apply : after.apply);
  check(`no flood of load/play commands to the engine on return (${applies} handed over in 3 s; steady state: ${steadyApplies} per 3 s)`, applies <= steadyApplies + 3, `${applies}`);
  const fires = Math.max(...back.map((s) => s.fires));
  check(`no burst of note flashes on return (most at once ${fires}; steady ${steadyFires})`, fires <= steadyFires + 4, `${fires}`);
  const s = await page.eval('__app.bg && __app.bg.stats.lastHidden');
  notes.push(`background stats: ${JSON.stringify(s)}`);
  if (MODE !== 'frozen') check('the page measured its own background stretch', !!s && s.hiddenMs > SECONDS * 900 && s.degraded === false, JSON.stringify(s));
} catch (e) {
  console.log(`background-browser: ${e.message}`);
  failed++;
} finally {
  const errors = page.errors().filter((e) => !/favicon/i.test(e.text));
  if (other) { try { await fetch(`http://127.0.0.1:${page.port}/json/close/${other.id}`); } catch { /* gone */ } }
  await page.close();
  stop();
  for (const n of notes) console.log(`  note: ${n}`);
  check('no console error or exception', errors.length === 0, errors.map((e) => e.text).join(' | ').slice(0, 400));
  console.log(failed ? `background-browser (${MODE}${NEGATIVE ? ', without pump' : ''}): ${failed} FAILED` : `background-browser (${MODE}${NEGATIVE ? ', without pump' : ''}): all ok`);
  process.exit(failed ? 1 : 0);
}
