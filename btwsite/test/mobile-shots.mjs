#!/usr/bin/env node
// mobile-shots.mjs: screenshots of the page the way an Android phone shows it (412 x 915 css px, touch, a
// 2x pixel ratio), for before/after comparisons of the narrow-screen layout.
//
//   node btwsite/test/mobile-shots.mjs --prefix before     writes btwsite/test/shots/mobile/before-*.png
//   node btwsite/test/mobile-shots.mjs --prefix after [--width 412 --height 915] [--out DIR]
//
// Runs against mock-server.mjs (real wasm when built). Plays the first section on the engine, so the bar shows
// what it shows while music plays. Exit code 1 if the page logged a console error.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };
const PREFIX = arg('prefix', 'shot');
const W = Number(arg('width', 412));
const H = Number(arg('height', 915));
const OUT = arg('out', path.join(here, 'shots', 'mobile'));
fs.mkdirSync(OUT, { recursive: true });

const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const server = spawn('node', [path.join(here, 'mock-server.mjs'), '--port', String(port)], { stdio: ['ignore', 'ignore', 'inherit'] });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch { /* gone */ } });
for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch { /* starting */ } await sleep(100); }

const page = await launch({ width: W, height: H, args: ['--disable-audio-output'] });
await page.cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
const tap = async (sel) => {
  const r = await page.rect(sel);
  if (!r) throw new Error(`no element ${sel}`);
  const x = r.x + r.w / 2, y = r.y + r.h / 2;
  await page.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await page.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};
const shot = (name) => page.shot(path.join(OUT, `${PREFIX}-${name}.png`));
let code = 0;
try {
  await page.goto(`http://127.0.0.1:${port}/?example=hand-dubstep-140-v2&keepalive=0`);
  await page.waitFor('window.__btw && window.__app && window.__app.wasmOk', 20000);
  await sleep(600);
  await shot('1-idle');
  // a first touch makes the AudioContext and the engine loads behind it; the next tap on play then plays on the engine
  await tap('.ed');
  await page.waitFor("window.__app.engineState === 'ready'", 30000);
  await tap('#btn-play');
  await page.waitFor('document.getElementById("btn-play").classList.contains("on")', 15000);
  await page.waitFor('window.__app.driver.last && window.__app.driver.last.grid', 20000).catch(() => {});
  await sleep(1500);
  await shot('2-playing');
  // break the program so the diagnostics strip has something to say
  await page.eval('(()=>{const ta=document.querySelector(".ed-ta"); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);})()');
  await page.type('\nfoo bar\n');
  await sleep(600);
  await shot('3-problems');
  // the problems list: the strip's button on a wide page, the bar's dot and count on a phone
  const prob = (await page.eval('(()=>{const e=document.getElementById("t-prob");return !!e && getComputedStyle(e).display!=="none"})()')) ? '#t-prob' : '#pr-sum';
  await tap(prob); await sleep(300); await shot('4-problems-open'); await tap(prob); await sleep(200);
  await tap('#btn-decks'); await sleep(400); await shot('5-expanded');
  const m = await page.eval('(()=>{const r=e=>{const b=document.querySelector(e);if(!b)return null;const x=b.getBoundingClientRect();return [Math.round(x.width),Math.round(x.height)]};return {transport:r("#transport"),play:r("#btn-play"),status:r("#t-status"),src:r("#t-source"),level:r("#level"),decks:r("#btn-decks"),problems:r("#pr-sum"),prob:r("#t-prob"),overflowX:document.documentElement.scrollWidth>document.documentElement.clientWidth}})()');
  console.log(JSON.stringify(m));
  const bad = page.errors().filter((e) => !/favicon/i.test(e.text));
  if (bad.length) { console.log('console errors:', bad.map((e) => e.text).join(' | ').slice(0, 400)); code = 1; }
} catch (e) {
  console.log('mobile-shots:', e.message);
  code = 1;
} finally {
  await page.close();
  try { server.kill('SIGKILL'); } catch { /* gone */ }
  console.log(`shots in ${OUT}`);
  process.exit(code);
}
