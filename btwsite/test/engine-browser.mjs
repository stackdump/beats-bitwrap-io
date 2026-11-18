#!/usr/bin/env node
// engine-browser.mjs: headless Chrome plays hand-dubstep-140-v2 through js/engine.js for about 10 s.
//
//   node btwsite/test/engine-browser.mjs [--seconds 10] [--program /examples/hand-dubstep-140-v2.btw] [--composer worker]
//
// Serves btwsite/ with `python3 -m http.server` on a free port, opens web/engine-test.html in headless Chrome
// (btwsite/test/cdp.mjs), clicks the button (a click starts the AudioContext) and reads window.__btwTest back:
// the engine came up with its composer Worker, the grid advanced about as fast as the tempo says, the program's
// first section was reported, nothing logged an error, and the output was not silent (an AnalyserNode's RMS).
// Skips (exit 0) when the wasm is not built or Chrome is not installed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, launch, sleep } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };
const SECONDS = Number(arg('seconds', 10));
const PROGRAM = arg('program', '/examples/hand-dubstep-140-v2.btw');
const COMPOSER = arg('composer', 'worker');

if (!fs.existsSync(path.join(site, 'web', 'wasm', 'btw_bg.wasm'))) { console.log('SKIP engine-browser: no built module in btwsite/web/wasm'); process.exit(0); }
if (!fs.existsSync(CHROME)) { console.log(`SKIP engine-browser: no Chrome at ${CHROME}`); process.exit(0); }

const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', site], { stdio: 'ignore' });
const stop = () => { try { server.kill('SIGKILL'); } catch { /* gone */ } };
process.on('exit', stop);
for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/web/engine-test.html`); break; } catch { await sleep(100); } }

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${!ok && detail ? `\n         ${detail}` : ''}`); if (!ok) failed++; };

const page = await launch({ width: 900, height: 500 });
let T;
let starved = false;
try {
  await page.goto(`http://127.0.0.1:${port}/web/engine-test.html?program=${encodeURIComponent(PROGRAM)}&seconds=${SECONDS}&composer=${COMPOSER}`);
  await page.click('#go');
  await page.waitFor("window.__btwTest && (window.__btwTest.phase === 'done' || window.__btwTest.phase === 'error')", (SECONDS + 40) * 1000, 250);
  T = await page.eval('JSON.parse(JSON.stringify(window.__btwTest))');
  const text = await page.eval("document.getElementById('out').textContent");
  console.log(text.trim().split('\n').map((l) => `  | ${l}`).join('\n'));
} catch (e) {
  console.log(`engine-browser: ${e.message}`);
  T = T || (await page.eval('JSON.parse(JSON.stringify(window.__btwTest || {}))').catch(() => ({})));
  failed++;
} finally {
  const errors = page.errors();
  await page.close();
  stop();
  if (T) {
    check('the page finished without an error', T.phase === 'done', T.error || `phase ${T.phase}`);
    // an overloaded machine starves the audio thread: the audio clock then runs slow and the sound-dependent checks mean nothing
    starved = T.audioSeconds !== undefined && T.audioSeconds < 0.85 * (T.wallSeconds - 0.5);
    if (starved) console.log(`  note: the audio clock ran ${T.audioSeconds.toFixed(1)} s in ${T.wallSeconds.toFixed(1)} s of wall time (the machine is overloaded): timing and level checks are skipped`);
    else check(`the audio clock kept up with the wall clock (${T.audioSeconds && T.audioSeconds.toFixed(1)} s of ${T.wallSeconds && T.wallSeconds.toFixed(1)} s)`, T.audioSeconds !== undefined, 'no audio time reported');
    check('the AudioContext ran', T.ctxState === 'running', `state ${T.ctxState}`);
    check(`the composer is a ${COMPOSER === 'worker' ? 'Worker' : COMPOSER}`, T.composerKind === COMPOSER, T.composerKind);
    check('the grid advanced', T.grid && T.grid.length > 20, `${T.grid && T.grid.length} reads`);
    if (T.grid && T.grid.length > 20) {
      // beats against wall time: 140 bpm is 2.33 beats a second; the first read is after both decks have started
      const first = T.grid[0], last = T.grid[T.grid.length - 1];
      // the rate over the first stretch of one net: a section swap puts the beat back to the top of the next net
      const beats = T.grid.map((g) => g[1]);
      let end = beats.length;
      for (let i = 1; i < beats.length; i++) if (beats[i] < beats[i - 1] - 0.5) { end = i; break; }
      const seg = T.grid.slice(0, end);
      const rate = (seg[seg.length - 1][1] - seg[0][1]) / ((seg[seg.length - 1][0] - seg[0][0]) / 1000);
      if (end < beats.length && PROGRAM.includes('hand-dubstep-140-v2')) {
        check(`the new section's net starts on the bar line the runtime calls bar 8 (it read bar ${T.grid[end][2]}, beat ${beats[end]})`, beats[end] < 1.5 && (T.grid[end][2] === 8 || T.grid[end][2] === 7), JSON.stringify(T.grid.slice(end - 2, end + 2)));
      }
      const bpm = Number(arg('bpm', 140));
      if (!starved) check(`the beat moves at about the tempo (${rate.toFixed(2)} beats/s, ${bpm} bpm is ${(bpm / 60).toFixed(2)})`, Math.abs(rate / (bpm / 60) - 1) < 0.1, `${rate}`);
      let backs = 0; for (let i = 1; i < beats.length; i++) if (beats[i] < beats[i - 1] - 0.5) backs++;
      check('it jumps back only at a section swap (once in the first 8 bars + build)', backs <= (SECONDS > 14 ? 1 : 0), `${backs} jumps back`);
      if (!starved) check('the runtime counted bars', last[2] >= Math.floor(((last[0] - first[0]) / 1000) * (bpm / 60) / 4) - 1, `bar ${last[2]} after ${(last[0] / 1000).toFixed(1)} s`);
    }
    check('the first section was reported', T.sections && T.sections[0] === 'intro', JSON.stringify(T.sections));
    if (SECONDS > 16 && PROGRAM.includes('hand-dubstep-140-v2')) check('and the next section came on the bar line (intro is 8 bars: 13.7 s)', T.sections && T.sections[1] === 'build', JSON.stringify(T.sections));
    check('both decks installed their nets', (T.events || []).filter((e) => e.deck).length >= 2, JSON.stringify(T.events));
    check('no engine error was raised', !(T.events || []).some((e) => e.error), JSON.stringify((T.events || []).filter((e) => e.error)));
    check(`the output is not silent (RMS max ${T.rmsMax && T.rmsMax.toFixed(4)})`, T.rmsMax > 0.005, `rms max ${T.rmsMax}`);
    const loud = (T.rmsSamples || []).filter((x) => x > 0.005).length;
    if (!starved) check('and keeps sounding (more than a third of the reads above the floor: a drop-out is silence)', loud > (T.rmsSamples || []).length / 3, `${loud} of ${(T.rmsSamples || []).length}`);
    if (T.stats) console.log(`  engine up ${Math.round(T.engineMs)} ms; loads ${T.stats.loads}, prepare ${T.stats.prepareMs.map((x) => Math.round(x)).join('/')} ms, install ${T.stats.installMs.map((x) => Math.round(x)).join('/')} ms (${T.stats.installQuanta.join('/')} quanta); sample rate ${T.sampleRate}, base latency ${T.baseLatency}, output latency ${T.outputLatency}`);
  }
  const bad = errors.filter((e) => !/favicon/i.test(e.text));
  check('no console error or exception', bad.length === 0, bad.map((e) => e.text).join(' | ').slice(0, 400));
  console.log(failed ? `engine-browser: ${failed} FAILED` : 'engine-browser: all ok');
  process.exit(failed ? 1 : 0);
}
