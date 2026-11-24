#!/usr/bin/env node
// The four djwasm-only genres (acid, deephouse, electro, italo) through the real page: pick the
// genre in .pn-genre-select, press the studio's own generate, let the worker ask djwasm for the
// project, play it, and read the master through an analyser. Fails when a genre is not offered,
// the page never gets its project, the project is not that genre's, or the master is silent.
//
//   make test-native-genres-browser            (boots its own server and headless Chrome)
//   node scripts/test-native-genres-browser.mjs http://localhost:18137    CDP_PORT=9344 by default
//
// Same driver shape as probe-djrust-gaps.mjs (raw CDP, no npm).
import { spawn } from 'node:child_process';
const HOST = process.argv[2] || 'http://localhost:18137';
const PORT = Number(process.env.CDP_PORT) || 9344;
const GENRES = { acid: 125, deephouse: 122, electro: 118, italo: 120 };
const FLOOR = 0.01;     // master rms; a playing track reads ~0.1-0.2
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME || 'google-chrome', ['--headless=new', `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--autoplay-policy=no-user-gesture-required', `--user-data-dir=/tmp/native-genres-profile-${PORT}`, 'about:blank'], { stdio: 'ignore' });
async function target() { for (let i = 0; i < 50; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = l.find(t => t.type === 'page'); if (p) return p.webSocketDebuggerUrl; } catch {} await sleep(200); } throw new Error('no chrome'); }
function connect(url) { const ws = new WebSocket(url); let id = 0; const pend = new Map(); const logs = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    else if (m.method === 'Runtime.consoleAPICalled' && /error/.test(m.params.type)) logs.push(m.params.args.map(a => a.value ?? a.description).join(' '));
    else if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval'); return r.result?.result?.value; };
  return new Promise(r => { ws.onopen = () => r({ send, ev, logs }); }); }

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

try {
  const cdp = await connect(await target());
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `${HOST}/` });
  for (let i = 0; i < 100; i++) { await sleep(200); if (await cdp.ev(`!!document.querySelector('petri-note')?._project?.nets`).catch(() => false)) break; }
  await sleep(2000);
  for (const [genre, bpm] of Object.entries(GENRES)) {
    cdp.logs.length = 0;
    const offered = await cdp.ev(`[...document.querySelector('.pn-genre-select').options].some(o => o.value === ${JSON.stringify(genre)})`);
    check(`${genre}: offered by the picker`, offered === true);
    // pick it and press the studio's own Generate
    const got = await cdp.ev(`(async () => { const el = document.querySelector('petri-note'); const sel = el.querySelector('.pn-genre-select');
      const before = el._project; sel.value = ${JSON.stringify(genre)}; sel.dispatchEvent(new Event('change'));
      el.querySelector('.pn-generate-btn').click();
      for (let i = 0; i < 150 && !(el._project !== before && String(el._project?.name || '').startsWith(${JSON.stringify(genre)})); i++) await new Promise(r => setTimeout(r, 100));
      return { name: String(el._project?.name || ''), tempo: el._project?.tempo, nets: Object.keys(el._project?.nets || {}).length }; })()`);
    check(`${genre}: the page gets the engine's project`, got.name.startsWith(genre) && got.nets >= 4 && got.tempo === bpm, JSON.stringify(got));
    await sleep(1500);
    const rms = await cdp.ev(`(async () => { const el = document.querySelector('petri-note'); await el._ensureToneStarted(); if (!el._playing) el._togglePlay();
      const { audioHost } = await import('/audio/host.js'); if (el._wave) await el._wave;
      const ctx = audioHost.getContext(); const an = ctx.createAnalyser(); an.fftSize = 4096; audioHost.output.connect(an);
      const buf = new Float32Array(an.fftSize); let ss = 0, n = 0; const t0 = performance.now();
      while (performance.now() - t0 < 2500) { await new Promise(r => setTimeout(r, 40)); an.getFloatTimeDomainData(buf); for (const x of buf) { ss += x*x; n++; } }
      audioHost.output.disconnect(an); if (el._playing) el._togglePlay();
      return Math.sqrt(ss / n); })()`);
    check(`${genre}: the master is heard`, rms > FLOOR, `rms ${rms.toFixed(4)}`);
    check(`${genre}: no console errors`, cdp.logs.length === 0, cdp.logs.slice(0, 2).join(' | '));
  }
} catch (e) { check('run', false, String(e.message || e)); }
chrome.kill();
console.log(failures ? `\n${failures} FAILED` : '\nall ok');
process.exit(failures ? 1 : 0);
