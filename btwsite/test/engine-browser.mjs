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
    check('the AudioContext ran', T.ctxState === 'running', `state ${T.ctxState}`);
    check(`the composer is a ${COMPOSER === 'worker' ? 'Worker' : COMPOSER}`, T.composerKind === COMPOSER, T.composerKind);
    check('the grid advanced', T.grid && T.grid.length > 20, `${T.grid && T.grid.length} reads`);
    if (T.grid && T.grid.length > 20) {
      // beats against wall time: 140 bpm is 2.33 beats a second; the first read is after both decks have started
      const first = T.grid[0], last = T.grid[T.grid.length - 1];
      const rate = ((last[1] - first[1]) / ((last[0] - first[0]) / 1000));
      const beats = T.grid.map((g) => g[1]);
      check(`the beat moves at about the tempo (${rate.toFixed(2)} beats/s, 140 bpm is 2.33)`, rate > 2.0 && rate < 2.7, `${rate}`);
      let backs = 0; for (let i = 1; i < beats.length; i++) if (beats[i] < beats[i - 1] - 0.5) backs++;
      check('it does not jump back (inside a section)', backs <= 1, `${backs} jumps back`);
      check('the runtime counted bars', last[2] >= Math.floor(((last[0] - first[0]) / 1000) * 2.33 / 4) - 1, `bar ${last[2]} after ${(last[0] / 1000).toFixed(1)} s`);
    }
    check('the first section was reported', T.sections && T.sections[0] === 'intro', JSON.stringify(T.sections));
    check('both decks installed their nets', (T.events || []).filter((e) => e.deck).length >= 2, JSON.stringify(T.events));
    check('no engine error was raised', !(T.events || []).some((e) => e.error), JSON.stringify((T.events || []).filter((e) => e.error)));
    check(`the output is not silent (RMS max ${T.rmsMax && T.rmsMax.toFixed(4)})`, T.rmsMax > 0.005, `rms max ${T.rmsMax}`);
    const loud = (T.rmsSamples || []).filter((x) => x > 0.005).length;
    check('and keeps sounding (more than half the reads above the floor once playing)', loud > (T.rmsSamples || []).length / 2, `${loud} of ${(T.rmsSamples || []).length}`);
    if (T.stats) console.log(`  engine up ${Math.round(T.engineMs)} ms; loads ${T.stats.loads}, prepare ${T.stats.prepareMs.map((x) => Math.round(x)).join('/')} ms, install ${T.stats.installMs.map((x) => Math.round(x)).join('/')} ms (${T.stats.installQuanta.join('/')} quanta); sample rate ${T.sampleRate}, base latency ${T.baseLatency}, output latency ${T.outputLatency}`);
  }
  const bad = errors.filter((e) => !/favicon/i.test(e.text));
  check('no console error or exception', bad.length === 0, bad.map((e) => e.text).join(' | ').slice(0, 400));
  console.log(failed ? `engine-browser: ${failed} FAILED` : 'engine-browser: all ok');
  process.exit(failed ? 1 : 0);
}
