#!/usr/bin/env node
// Gap probe: which studio features take audible effect under each engine.
// node scripts/probe-djrust-gaps.mjs http://localhost:18096
import { spawn } from 'node:child_process';
const HOST = process.argv[2] || 'http://localhost:18096';
const PORT = 9343;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME || 'google-chrome', ['--headless=new', `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--autoplay-policy=no-user-gesture-required', '--user-data-dir=/tmp/djrust-probe-profile', 'about:blank'], { stdio: 'ignore' });
async function target() { for (let i = 0; i < 50; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = l.find(t => t.type === 'page'); if (p) return p.webSocketDebuggerUrl; } catch {} await sleep(200); } throw new Error('no chrome'); }
function connect(url) { const ws = new WebSocket(url); let id = 0; const pend = new Map(); const logs = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    else if (m.method === 'Runtime.consoleAPICalled' && /warn|error/.test(m.params.type)) logs.push(m.params.args.map(a => a.value ?? a.description).join(' '));
    else if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval'); return r.result?.result?.value; };
  return new Promise(r => { ws.onopen = () => r({ send, ev, logs }); }); }

const MEASURE = `window.__measure = async (ms) => {
  const an = window.__an; const buf = new Float32Array(an.fftSize); const fb = new Float32Array(an.frequencyBinCount);
  let ss = 0, n = 0, cnum = 0, cden = 0; const t0 = performance.now(); const sr = an.context.sampleRate;
  while (performance.now() - t0 < ms) { await new Promise(r => setTimeout(r, 40)); an.getFloatTimeDomainData(buf); for (const x of buf) { ss += x*x; n++; }
    an.getFloatFrequencyData(fb); for (let k = 1; k < fb.length; k++) { const p = Math.pow(10, fb[k]/10); cnum += p * k * sr / an.fftSize; cden += p; } }
  return { rms: Math.sqrt(ss / n), centroid: cden ? cnum / cden : 0 };
};`;

async function open(cdp, query) {
  cdp.logs.length = 0;
  await cdp.send('Page.navigate', { url: `${HOST}/?${query}` });
  for (let i = 0; i < 100; i++) { await sleep(200); if (await cdp.ev(`!!document.querySelector('petri-note')?._project?.nets && Object.keys(document.querySelector('petri-note')._project.nets).length>0`).catch(() => false)) break; }
  await sleep(2000);
  await cdp.ev(`(async () => { ${MEASURE} const el = document.querySelector('petri-note'); await el._ensureToneStarted(); if (!el._playing) el._togglePlay();
    await new Promise(r => setTimeout(r, 300));
    const ctx = window.Tone.getContext().rawContext; const an = ctx.createAnalyser(); an.fftSize = 4096; window.__an = an;
    if (el._wave) { await el._wave; const { toneEngine } = await import('/audio/tone-engine.js'); (toneEngine._waveGain).connect(an); }
    else { window.Tone.getDestination().connect(an); } })()`);
  await sleep(1500);
}
const m = (cdp, ms = 2000) => cdp.ev(`window.__measure(${ms})`);
const fmt = (o) => `rms ${o.rms.toFixed(4)} centroid ${o.centroid.toFixed(0)}Hz`;
const rel = (a, b) => ({ rms: b.rms / (a.rms || 1e-9), cen: b.centroid / (a.centroid || 1e-9) });

const results = {};
try {
  const cdp = await connect(await target()); await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  for (const eng of ['tone', 'djrust']) {
    const q = (eng === 'djrust' ? 'engine=djrust&' : '') + 'genre=techno&seed=42';
    const r = results[eng] = {};
    const probe = async (name, setup, teardown, ms = 2000) => {
      await open(cdp, q); const base = await m(cdp, 2000);
      await cdp.ev(`(async () => { const el = document.querySelector('petri-note'); ${setup} })()`); await sleep(300);
      const after = await m(cdp, ms); r[name] = { base: fmt(base), after: fmt(after), ...rel(base, after) };
      console.log(eng.padEnd(7), name.padEnd(22), JSON.stringify(r[name]));
    };
    await probe('fx lp-freq=5', `el._setFxByKey('lp-freq', 5)`);
    await probe('fx master-vol=5', `el._setFxByKey('master-vol', 5)`);
    await probe('fx distortion=100', `el._setFxByKey('distortion', 100)`);
    await probe('macro cut(8 ticks)', `el._fireMacro('cut', {duration: 8})`, null, 800);
    await probe('macro sweep-lp', `el._fireMacro('sweep-lp')`, null, 3000);
    await probe('macro solo-drums', `el._fireMacro('solo-drums')`, null, 2500);
    await probe('mute all music nets', `for (const id of Object.keys(el._project.nets)) if (el._project.nets[id].role !== 'control') el._sendWs({type:'mute', netId:id, muted:true})`);
    await probe('tempo 60', `el._sendWs({type:'tempo', bpm:60}); el._tempo = 60`);
  }
  // all genres under djrust
  const genres = ['ambient','blues','bossa','country','dnb','dubstep','edm','funk','garage','house','jazz','lofi','metal','reggae','speedcore','synthwave','techno','trance','trap'];
  results.genres = {};
  for (const g of genres) {
    await open(cdp, `engine=djrust&genre=${g}&seed=7`);
    const o = await m(cdp, 1200); const st = await cdp.ev(`(() => { const el = document.querySelector('petri-note'); return { engine: el._engineName, tick: el._tick, err: el._djrustError || null }; })()`);
    results.genres[g] = { ...st, rms: +o.rms.toFixed(4), errs: cdp.logs.filter(l => /EXC|engine:/.test(l)).slice(0, 2) };
    console.log('genre', g.padEnd(10), JSON.stringify(results.genres[g]));
  }
  // stage + scope open without exceptions
  await open(cdp, 'engine=djrust&genre=house&seed=3');
  await cdp.ev(`(async () => { const el = document.querySelector('petri-note'); el._toggleStage(); })()`); await sleep(2500);
  results.stage = { errs: cdp.logs.filter(l => /EXC/.test(l)).slice(0, 3), canvas: await cdp.ev(`!!document.querySelector('.pn-stage, [class*=stage] canvas')`) };
  console.log('stage', JSON.stringify(results.stage));
  console.log('JSON', JSON.stringify(results));
} catch (e) { console.error(e); process.exitCode = 1; } finally { chrome.kill(); }
