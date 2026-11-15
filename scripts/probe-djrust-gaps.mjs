#!/usr/bin/env node
// Gap probe: which studio controls take audible effect on the djrust engine (ratio after/before
// of RMS and spectral centroid). Tone is gone, so this is the rebuild scoreboard: a control whose
// ratio is ~1.00 is still a gap (docs/MIGRATION-djrust-wasm.md §12).
//
// Gates (exit 1 when one fails): the net macros djwasm 0.3.0 runs must be audible through the
// page's own el._fireMacro: `macro cut(8 ticks)` and `macro solo-drums` read an RMS ratio below
// 1.0. The other rows are the scoreboard (sweep-lp needs djwasm 0.4.0 and reads ~1.00 until then).
// Below 1.0 alone cannot tell a macro from no macro: the track's own loudness drifts down over
// these windows (an unfired run reads ~0.93-0.97). So each gated row must also
//   - have reached the engine: exactly one macro-fired for its id (source page, result 0) and a
//     non-zero macroMask while it was measured;
//   - read at least CONTROL_MARGIN below its control row, the same track opened the same way
//     with nothing fired and measured over the same window (`none (<ms> ms)`).
//
// The page boots a random techno seed and ignores ?genre= / ?seed=, so each row generates a fixed
// track in-page (the studio's own generate message): PROBE_TRACK (genre:seed, default trap:42) for
// the control rows. solo-drums mutes everything but the drums, and on a drum-heavy mix (techno/42)
// that barely moves RMS whether or not it ran; trap/42's non-drum parts carry ~20% of its RMS.
// The genre sweep generates <genre>:7.
//
//   make probe-djrust-gaps            (boots its own server)
//   node scripts/probe-djrust-gaps.mjs http://localhost:18136    CDP_PORT=9343 by default
import { spawn } from 'node:child_process';
const HOST = process.argv[2] || 'http://localhost:18136';
const PORT = Number(process.env.CDP_PORT) || 9343;
// Rows that must read an RMS ratio below this (the macro moved the audio).
const GATES = { 'macro cut(8 ticks)': 1.0, 'macro solo-drums': 1.0 };
// Each gated row's macro id and control row (nothing fired, same window length).
const GATED = { 'macro cut(8 ticks)': { id: 'cut', control: 'none (800 ms)' },
  'macro solo-drums': { id: 'solo-drums', control: 'none (2500 ms)' } };
const CONTROL_MARGIN = 0.05;
const TRACK = process.env.PROBE_TRACK || 'trap:42';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME || 'google-chrome', ['--headless=new', `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--autoplay-policy=no-user-gesture-required', `--user-data-dir=/tmp/djrust-probe-profile-${PORT}`, 'about:blank'], { stdio: 'ignore' });
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

/** Open the studio, generate `track` (genre:seed) in-page, play it, and put the analyser on the master. */
async function open(cdp, track) {
  const [genre, seed] = track.split(':');
  cdp.logs.length = 0;
  await cdp.send('Page.navigate', { url: `${HOST}/` });
  for (let i = 0; i < 100; i++) { await sleep(200); if (await cdp.ev(`!!document.querySelector('petri-note')?._project?.nets && Object.keys(document.querySelector('petri-note')._project.nets).length>0`).catch(() => false)) break; }
  await sleep(2000);
  const got = await cdp.ev(`(async () => { const el = document.querySelector('petri-note'); const before = el._project;
    const params = { seed: ${Number(seed)} }; el._currentGen = { genre: ${JSON.stringify(genre)}, params: { ...params } };
    el._sendWs({ type: 'generate', genre: ${JSON.stringify(genre)}, params });
    for (let i = 0; i < 100 && !(el._project !== before && el._waveProject && String(el._project.name || '').startsWith(${JSON.stringify(genre)})); i++) await new Promise(r => setTimeout(r, 100));
    return String(el._project.name || ''); })()`);
  if (!got.startsWith(genre)) throw new Error(`generate ${track}: the page has ${got}`);
  await sleep(1500);
  await cdp.ev(`(async () => { ${MEASURE} const el = document.querySelector('petri-note'); await el._ensureToneStarted(); if (!el._playing) el._togglePlay();
    await new Promise(r => setTimeout(r, 300));
    const { audioHost } = await import('/audio/host.js');
    const ctx = audioHost.getContext(); const an = ctx.createAnalyser(); an.fftSize = 4096; window.__an = an;
    if (el._wave) await el._wave;
    audioHost.output.connect(an); })()`);
  await sleep(1500);
}
const m = (cdp, ms = 2000) => cdp.ev(`window.__measure(${ms})`);
const fmt = (o) => `rms ${o.rms.toFixed(4)} centroid ${o.centroid.toFixed(0)}Hz`;
const rel = (a, b) => ({ rms: b.rms / (a.rms || 1e-9), cen: b.centroid / (a.centroid || 1e-9) });

const results = {};
try {
  const cdp = await connect(await target()); await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  for (const eng of ['djrust']) {
    const q = TRACK;
    const r = results[eng] = {};
    const probe = async (name, setup, teardown, ms = 2000) => {
      await open(cdp, q); const base = await m(cdp, 2000);
      // Record what the engine says from just before the setup to the end of the measurement.
      await cdp.ev(`(async () => { const el = document.querySelector('petri-note'); const w = await el._wave;
        const ev = window.__ev = { fired: [], maxMask: 0 }; const orig = w.onmessage;
        w.onmessage = (msg) => { if (msg && msg.type === 'macro-fired') ev.fired.push({ id: msg.id, source: msg.source, result: msg.result });
          if (msg && msg.type === 'wave-tick' && typeof msg.macroMask === 'number') ev.maxMask = Math.max(ev.maxMask, msg.macroMask);
          return orig && orig(msg); };
        ${setup} })()`); await sleep(300);
      const after = await m(cdp, ms);
      const ev = await cdp.ev('window.__ev');
      r[name] = { base: fmt(base), after: fmt(after), ...rel(base, after), fired: ev.fired, maxMask: ev.maxMask };
      console.log(eng.padEnd(7), name.padEnd(22), q, JSON.stringify(r[name]));
    };
    await probe('none (800 ms)', '', null, 800);
    await probe('none (2500 ms)', '', null, 2500);
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
    await open(cdp, `${g}:7`);
    const o = await m(cdp, 1200); const st = await cdp.ev(`(() => { const el = document.querySelector('petri-note'); return { engine: el._engineName, tick: el._tick, err: el._djrustError || null }; })()`);
    results.genres[g] = { ...st, rms: +o.rms.toFixed(4), errs: cdp.logs.filter(l => /EXC|engine:/.test(l)).slice(0, 2) };
    console.log('genre', g.padEnd(10), JSON.stringify(results.genres[g]));
  }
  // stage + scope open without exceptions
  await open(cdp, 'house:3');
  await cdp.ev(`(async () => { const el = document.querySelector('petri-note'); el._toggleStage(); })()`); await sleep(2500);
  results.stage = { errs: cdp.logs.filter(l => /EXC/.test(l)).slice(0, 3), canvas: await cdp.ev(`!!document.querySelector('.pn-stage, [class*=stage] canvas')`) };
  console.log('stage', JSON.stringify(results.stage));
  console.log('JSON', JSON.stringify(results));
  let bad = 0;
  for (const [row, max] of Object.entries(GATES)) {
    const r = results.djrust[row];
    const ok = !!r && Number.isFinite(r.rms) && r.rms < max;
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} gate: ${row} reads rms ratio ${r ? r.rms.toFixed(3) : 'n/a'} (must be < ${max})`);
    const { id, control } = GATED[row];
    const fired = (r?.fired || []).filter((f) => f.id === id);
    const ran = fired.length === 1 && fired[0].source === 'page' && fired[0].result === 0 && r.maxMask > 0;
    if (!ran) bad++;
    console.log(`${ran ? 'ok  ' : 'FAIL'} gate: ${row} reached the engine (one macro-fired ${id}, source page, result 0; macroMask set) — ${JSON.stringify({ fired: r?.fired, maxMask: r?.maxMask })}`);
    const c = results.djrust[control];
    const below = !!r && !!c && Number.isFinite(c.rms) && r.rms < c.rms - CONTROL_MARGIN;
    if (!below) bad++;
    console.log(`${below ? 'ok  ' : 'FAIL'} gate: ${row} rms ratio ${r ? r.rms.toFixed(3) : 'n/a'} is at least ${CONTROL_MARGIN} below its unfired control '${control}' (${c ? c.rms.toFixed(3) : 'n/a'})`);
  }
  if (bad) process.exitCode = 1;
  console.log(bad ? `\n${bad} gate(s) FAILED` : '\nall gates passed');
} catch (e) { console.error(e); process.exitCode = 1; } finally { chrome.kill(); }
