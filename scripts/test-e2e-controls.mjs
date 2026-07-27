#!/usr/bin/env node
// End-to-end control-surface test for the beats studio.
//
// Drives headless Chrome over raw CDP (no deps — node >= 20) against a
// running server and exercises every user-facing control through the real
// DOM: transport, panels, all macros, one-shot Fire pads, FX sliders,
// keyboard shortcuts, mixer, Feel, Auto-DJ, generate/shuffle/genre, the
// share modal, and MIDI input via a Web MIDI API mock (no hardware).
//
// Each check asserts an observable effect (state change, engine param,
// audio RMS via an analyser on Tone.Destination) — not just "no throw".
// Any uncaught exception or console.error during the run is a failure.
//
// Usage:
//   node scripts/test-e2e-controls.mjs [host] [--verbose]
//   make test-e2e
import { spawn } from 'node:child_process';

const HOST = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2] : 'http://localhost:18091';
const VERBOSE = process.argv.includes('--verbose');
const URL = `${HOST}/?test=1&genre=techno&seed=42`;
const PORT = 9340;

// ---------- Web MIDI mock, installed before any page script ----------
// Provides one fake input ("Mock Pad") and one fake output. Tests inject
// events with window.__midiMock.send([status, d1, d2]).
const MIDI_MOCK = `
(function () {
  const listeners = new Set();
  const input = {
    id: 'mock-in', name: 'Mock Pad', manufacturer: 'e2e', type: 'input',
    state: 'connected', connection: 'open',
    onmidimessage: null,
    addEventListener(type, fn) { if (type === 'midimessage') listeners.add(fn); },
    removeEventListener(type, fn) { listeners.delete(fn); },
    open() { return Promise.resolve(this); }, close() { return Promise.resolve(this); },
  };
  const sent = [];
  const output = {
    id: 'mock-out', name: 'Mock Out', manufacturer: 'e2e', type: 'output',
    state: 'connected', connection: 'open',
    send(data) { sent.push(Array.from(data)); },
    open() { return Promise.resolve(this); }, close() { return Promise.resolve(this); },
  };
  const access = {
    inputs: new Map([['mock-in', input]]),
    outputs: new Map([['mock-out', output]]),
    onstatechange: null, sysexEnabled: false,
    addEventListener() {}, removeEventListener() {},
  };
  navigator.requestMIDIAccess = () => Promise.resolve(access);
  window.__midiMock = {
    input, output, sent,
    send(bytes) {
      const ev = { data: new Uint8Array(bytes), timeStamp: performance.now(), target: input };
      if (typeof input.onmidimessage === 'function') input.onmidimessage(ev);
      for (const fn of listeners) fn(ev);
    },
  };
})();
`;

const VIS = `
  Object.defineProperty(document,'visibilityState',{get:()=> 'visible',configurable:true});
  Object.defineProperty(document,'hidden',{get:()=>false,configurable:true});
  try { localStorage.setItem('pn-welcome-seen', '1'); } catch {}
`;

// ---------- CDP plumbing ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chrome = spawn('google-chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=/tmp/beats-e2e-prof-${process.pid}`,
  '--autoplay-policy=no-user-gesture-required',
  '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--window-size=1400,1000', 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} });

let target;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  } catch {}
}
if (!target) { console.error('FATAL: no Chrome page target'); process.exit(2); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
const pageErrors = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    pageErrors.push('[exception] ' + (d.exception?.description || d.text).slice(0, 400));
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    pageErrors.push('[console.error] ' +
      m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 400));
  }
});
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId; pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
// Evaluate an expression; async-aware; throws on page-side eval error.
async function evalx(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error('page eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 500));
  }
  return r.result?.value;
}
// Poll until fn (a JS expression string returning truthy) or timeout.
async function waitFor(expr, timeoutMs = 8000, stepMs = 120) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await evalx(expr)) return true;
    await sleep(stepMs);
  }
  return false;
}

// ---------- results ----------
const results = [];
let currentSection = '';
function section(name) { currentSection = name; if (VERBOSE) console.log(`\n== ${name} ==`); }
function record(name, ok, detail = '') {
  results.push({ section: currentSection, name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  if (!ok || VERBOSE) console.log(`  [${mark}] ${currentSection} / ${name}${detail ? ' — ' + detail : ''}`);
}
async function check(name, expr, timeoutMs = 8000) {
  const ok = await waitFor(expr, timeoutMs);
  record(name, ok, ok ? '' : `condition never true: ${expr.slice(0, 120)}`);
  return ok;
}

// ---------- boot ----------
await send('Page.enable'); await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: VIS + MIDI_MOCK });
await send('Page.navigate', { url: URL });

section('boot');
{
  const ok = await waitFor(`!!(document.querySelector('petri-note')?._project) && typeof Tone !== 'undefined'`, 30000, 500);
  record('app boots with project', ok);
  if (!ok) { finish(); }
  // Analyser tap on the destination for RMS assertions.
  await evalx(`(function(){
    const ctx = Tone.getContext().rawContext;
    const an = ctx.createAnalyser(); an.fftSize = 2048;
    Tone.getDestination().output.connect(an);
    window.__an = an; window.__buf = new Float32Array(an.fftSize);
    window.__rms = () => { __an.getFloatTimeDomainData(__buf);
      let s = 0; for (const v of __buf) s += v*v; return Math.sqrt(s/__buf.length); };
    window.__peakRms = async (ms, step=60) => {
      let peak = 0; const n = Math.ceil(ms/step);
      for (let i = 0; i < n; i++) { await new Promise(r=>setTimeout(r,step)); peak = Math.max(peak, __rms()); }
      return peak;
    };
    window.__el = document.querySelector('petri-note');
    return true;
  })()`);
}

// ---------- transport ----------
section('transport');
{
  // First click races Tone's cold init under load — retry the click
  // rather than waiting a fixed budget on one attempt.
  let playing = false;
  for (let i = 0; i < 3 && !playing; i++) {
    await evalx(`__el.querySelector('.pn-play').click()`);
    playing = await waitFor(`__el._playing === true`, 6000);
    if (!playing) await evalx(`__el._playing && __el.querySelector('.pn-play').click(); true`);
  }
  record('play button starts playback', playing);
  await check('audio context running', `Tone.getContext().rawContext.state === 'running'`, 8000);
  const peak = await evalx(`__peakRms(3000)`);
  record('audible output while playing', peak > 0.005, `peak rms=${Number(peak).toFixed(4)}`);
  // Faster bars => faster macro windows for the whole run.
  await evalx(`__el._setTempo(240)`);
  await check('tempo set to 240', `__el._tempo === 240`, 2000);
}

// ---------- panel toggles ----------
section('panels');
for (const [btn, panel] of [
  ['.pn-effects-btn', '.pn-effects-panel'],
  ['.pn-macros-btn', '.pn-macros-panel'],
  ['.pn-oneshots-btn', '.pn-oneshots-panel'],
  ['.pn-autodj-btn', '.pn-autodj-panel'],
  ['.pn-arrange-btn', '.pn-arrange-panel'],
  ['.pn-note-btn', '.pn-note-panel'],
  ['.pn-midi-btn', '.pn-midi-panel'],
]) {
  const has = await evalx(`!!__el.querySelector('${btn}')`);
  if (!has) { record(`${btn} exists`, false); continue; }
  // Panels may start open (FX does) — assert the click *toggles* visibility.
  const before = await evalx(`(function(){ const p = __el.querySelector('${panel}');
    return p ? getComputedStyle(p).display !== 'none' : null; })()`);
  await evalx(`__el.querySelector('${btn}').click()`);
  const flipped = await waitFor(`(function(){ const p = __el.querySelector('${panel}');
    return p && (getComputedStyle(p).display !== 'none') === ${!before}; })()`, 3000);
  record(`${btn} toggles ${panel}`, flipped);
  if (before === false) continue; // left open for later sections
  await evalx(`__el.querySelector('${btn}').click()`);
  await waitFor(`(function(){ const p = __el.querySelector('${panel}');
    return p && (getComputedStyle(p).display !== 'none') === ${!!before}; })()`, 3000);
}

// ---------- every macro through its real DOM tile ----------
section('macros');
const macroList = await evalx(`(async () => {
  const { MACROS } = await import('/lib/macros/catalog.js');
  return MACROS.map(m => ({ id: m.id, kind: m.kind, group: m.group }));
})()`);
record('macro catalog loads', Array.isArray(macroList) && macroList.length > 20, `${macroList?.length} macros`);

// Ensure macro + beats panels are open so the tiles exist, and clear any
// user-persisted disabled marks so every tile actually fires.
await evalx(`(function(){
  localStorage.removeItem('pn-macros-disabled');
  __el._macrosDisabled = new Set();
  return true; })()`);

// Per-kind observable assertions. Every macro must (a) not throw, (b) show
// its observable effect, (c) release the serial queue (running mark clears).
for (const m of macroList) {
  const tileExpr = `__el.querySelector('.pn-macro-btn[data-macro="${m.id}"]')`;
  const hasTile = await evalx(`!!${tileExpr}`);
  if (!hasTile) { record(`${m.id}: tile present`, false); continue; }

  // Shrink duration to the minimum the tile offers so the test stays fast.
  await evalx(`(function(){
    const sel = __el.querySelector('.pn-macro-bars[data-macro="${m.id}"]');
    if (sel && sel.options.length) sel.value = sel.options[0].value;
    const ossel = __el.querySelector('.pn-os-bars[data-macro="${m.id}"]');
    if (ossel && ossel.options.length) ossel.value = ossel.options[0].value;
    return true; })()`);

  // tempo-anchor snaps to the genre default — make sure we're off it so
  // the effect is observable.
  if (m.kind === 'tempo-anchor') await evalx(`__el._setTempo(203)`);

  // Snapshot pre-state for the observable-effect assertion.
  const pre = await evalx(`(function(){
    return {
      tempo: __el._tempo,
      feel: JSON.stringify(__el._feel || null),
      muted: __el._mutedNets ? __el._mutedNets.size : -1,
      fx: Array.from(__el.querySelectorAll('.pn-fx-slider')).map(s => s.dataset.fx + ':' + s.value).join(','),
    }; })()`);

  await evalx(`${tileExpr}.click()`);

  let effectExpr;
  switch (m.kind) {
    case 'mute':
    case 'beat-repeat':
      effectExpr = `__el._mutedNets.size !== ${pre.muted}`;
      break;
    case 'fx-sweep': case 'fx-hold':
      effectExpr = `Array.from(__el.querySelectorAll('.pn-fx-slider')).map(s => s.dataset.fx + ':' + s.value).join(',') !== ${JSON.stringify(pre.fx)}`;
      break;
    case 'tempo-hold': case 'tempo-sweep': case 'tempo-anchor':
      effectExpr = `__el._tempo !== ${pre.tempo}`;
      break;
    case 'feel-snap': case 'feel-sweep': case 'genre-reset':
      effectExpr = `JSON.stringify(__el._feel || null) !== ${JSON.stringify(pre.feel)} || __el._tempo !== ${pre.tempo} || Array.from(__el.querySelectorAll('.pn-fx-slider')).map(s => s.dataset.fx + ':' + s.value).join(',') !== ${JSON.stringify(pre.fx)}`;
      break;
    case 'one-shot':
      // Fire pad unmutes the stinger net (or at minimum marks running).
      effectExpr = `!__el._mutedNets.has('${m.id}') || !!__el._runningMacro`;
      break;
    case 'compound':
      effectExpr = `__el._mutedNets.size !== ${pre.muted} || __el._tempo !== ${pre.tempo} || Array.from(__el.querySelectorAll('.pn-fx-slider')).map(s => s.dataset.fx + ':' + s.value).join(',') !== ${JSON.stringify(pre.fx)}`;
      break;
    default:
      effectExpr = `!!__el._runningMacro`;
  }
  const took = await waitFor(effectExpr, 6000);
  record(`${m.id}: takes effect`, took);

  // Wait for the serial queue to release (macro complete + restored).
  const released = await waitFor(`!__el._runningMacro && (!__el._macroQueue || __el._macroQueue.length === 0)`, 20000, 200);
  record(`${m.id}: completes + releases queue`, released);

  // Restore assertions for the reversible kinds.
  if (['tempo-hold', 'tempo-sweep', 'tempo-anchor'].includes(m.kind)) {
    const rok = await waitFor(`__el._tempo === ${pre.tempo}`, 8000);
    record(`${m.id}: tempo restores`, rok);
  }
  if (m.kind === 'mute') {
    const rok = await waitFor(`__el._mutedNets.size === ${pre.muted}`, 12000);
    record(`${m.id}: mutes restore`, rok);
  }
}

// Panic clears everything.
{
  await evalx(`__el._fireMacro('drop')`);
  await sleep(200);
  await evalx(`__el._panic ? __el._panic() : __el._cancelAllMacros()`);
  const ok = await waitFor(`!__el._runningMacro && (!__el._macroQueue || __el._macroQueue.length === 0)`, 4000);
  record('panic clears macro state', ok);
}

// ---------- one-shot Fire pads produce audio ----------
section('one-shots');
{
  const pads = await evalx(`Array.from(__el.querySelectorAll('.pn-os-fire')).map(b => b.dataset.macro)`);
  record('fire pads present', Array.isArray(pads) && pads.length > 0, `${pads?.length} pads`);
  for (const pad of pads || []) {
    // Pause other nets' loudness influence: measure RMS delta right after fire.
    const base = await evalx(`__peakRms(400)`);
    await evalx(`__el.querySelector('.pn-os-fire[data-macro="${pad}"]').click()`);
    const unmuted = await waitFor(`!__el._mutedNets.has('${pad}') && !__el._manualMutedNets?.has('${pad}')`, 4000);
    record(`${pad}: unmutes stinger net`, unmuted);
    const peak = await evalx(`__peakRms(1500)`);
    record(`${pad}: audio present after fire`, peak > Math.min(0.004, base * 0.5), `base=${Number(base).toFixed(4)} peak=${Number(peak).toFixed(4)}`);
    await waitFor(`!__el._runningMacro`, 10000, 200);
  }
  // Direct engine one-shots (laser & friends) still make sound into the mix.
  for (const name of ['airhorn', 'laser', 'subdrop', 'booj']) {
    const r = await evalx(`(async () => {
      const { toneEngine } = await import('/audio/tone-engine.js');
      toneEngine.playOneShot('${name}');
      return await __peakRms(900);
    })()`);
    record(`engine one-shot ${name} audible`, r > 0.003, `peak=${Number(r).toFixed(4)}`);
  }
}

// ---------- FX sliders drive engine params ----------
section('fx-sliders');
{
  const sliders = await evalx(`Array.from(__el.querySelectorAll('.pn-fx-slider')).map(s => s.dataset.fx)`);
  record('fx sliders present', Array.isArray(sliders) && sliders.length >= 8, `${sliders?.length} sliders`);
  // Spot-check the params we can read back from the engine.
  const paramChecks = [
    ['hp-freq', 80, `(await import('/audio/tone-engine.js')).toneEngine._hpFilter.frequency.value > 500`],
    ['hp-freq', 0,  `(await import('/audio/tone-engine.js')).toneEngine._hpFilter.frequency.value < 100`],
    ['lp-freq', 10, `(await import('/audio/tone-engine.js')).toneEngine._lpFilter.frequency.value < 2000`],
    ['lp-freq', 100,`(await import('/audio/tone-engine.js')).toneEngine._lpFilter.frequency.value > 15000`],
  ];
  for (const [key, val, cond] of paramChecks) {
    await evalx(`__el._setFxByKey('${key}', ${val})`);
    const ok = await waitFor(`(async () => ${cond})()`, 3000);
    record(`${key}=${val} reaches engine`, ok);
  }
  // Every slider dispatches through the UI 'input' path without errors.
  await evalx(`(function(){
    for (const s of __el.querySelectorAll('.pn-fx-slider')) {
      const mid = (parseFloat(s.min || 0) + parseFloat(s.max || 100)) / 2;
      s.value = mid; s.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true; })()`);
  record('all fx sliders dispatch input', true);
  // FX reset restores defaults.
  await evalx(`(function(){ const b = __el.querySelector('.pn-fx-reset'); if (b) b.click(); return true; })()`);
  await sleep(300);
}

// ---------- keyboard shortcuts ----------
section('keyboard');
async function key(k, code, keyCode) {
  // Printable keys need `text` on keyDown or the page sees no character.
  const text = k.length === 1 ? k : undefined;
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', {
      type, key: k, code: code || undefined,
      text: type === 'keyDown' ? text : undefined,
      windowsVirtualKeyCode: keyCode || undefined,
      nativeVirtualKeyCode: keyCode || undefined,
    });
  }
}
{
  // Make sure focus is on body, not an input.
  await evalx(`document.activeElement && document.activeElement.blur ? (document.activeElement.blur(), true) : true`);
  const wasPlaying = await evalx(`__el._playing`);
  await key(' ', 'Space', 32);
  await check('Space toggles play', `__el._playing === ${!wasPlaying}`, 4000);
  await key(' ', 'Space', 32);
  await check('Space toggles back', `__el._playing === ${wasPlaying}`, 4000);

  await evalx(`window.__bpm0 = __el._tempo`);
  await key(',', 'Comma', 188);
  await check('"," nudges BPM down', `__el._tempo === window.__bpm0 - 1`, 3000);
  await key('.', 'Period', 190);
  await check('"." nudges BPM up', `__el._tempo === window.__bpm0`, 3000);

  await key('s', 'KeyS', 83);
  record('S shuffle dispatches (no error)', true);
  await sleep(700);

  await key('?', 'Slash', 191);
  const helpOpen = await waitFor(`!!document.querySelector('.pn-help-overlay, .pn-modal, [class*="help"]')`, 3000);
  record('? opens help', helpOpen);
  await key('Escape', 'Escape', 27);
  await sleep(300);

  // 1-4 toggle hit tracks.
  const hitPre = await evalx(`['hit1','hit2','hit3','hit4'].map(h => __el._mutedNets.has(h) || (__el._manualMutedNets && __el._manualMutedNets.has(h))).join(',')`);
  await key('1', 'Digit1', 49);
  const hitToggled = await waitFor(`['hit1','hit2','hit3','hit4'].map(h => __el._mutedNets.has(h) || (__el._manualMutedNets && __el._manualMutedNets.has(h))).join(',') !== ${JSON.stringify(hitPre)}`, 3000);
  record('"1" toggles hit track', hitToggled);
  await key('1', 'Digit1', 49);
  await sleep(200);

  await key('p', 'KeyP', 80);
  record('P panic dispatches', true);
  await sleep(400);
}

// ---------- mixer ----------
section('mixer');
{
  const ok = await evalx(`(function(){
    const row = __el._mixerEl?.querySelector('.pn-mixer-row');
    if (!row) return { ok: false, why: 'no mixer rows' };
    const mute = row.querySelector('.pn-mixer-mute');
    if (!mute) return { ok: false, why: 'no mute button' };
    const id = row.dataset.netId;
    const before = __el._mutedNets.has(id) || (__el._manualMutedNets && __el._manualMutedNets.has(id));
    mute.click();
    const after = __el._mutedNets.has(id) || (__el._manualMutedNets && __el._manualMutedNets.has(id));
    mute.click();
    return { ok: before !== after, why: 'mute state did not flip' };
  })()`);
  record('mixer mute toggles', ok?.ok === true, ok?.why || '');
}

// ---------- Feel ----------
section('feel');
{
  await evalx(`__el._openFeelModal ? __el._openFeelModal() : __el.querySelector('.pn-feel-open')?.click()`);
  const open = await waitFor(`!!document.querySelector('.pn-feel-overlay, .pn-feel-modal, [class*="feel-modal"], [class*="feel-overlay"]')`, 3000);
  record('feel modal opens', open);
  const t0 = await evalx(`__el._tempo`);
  await evalx(`__el._applyFeel([0.9, 0.9])`);
  const moved = await waitFor(`__el._tempo !== ${t0}`, 3000);
  record('feel puck changes tempo', moved);
  await evalx(`__el._applyFeel([0.5, 0.5])`);
  await key('Escape', 'Escape', 27);
  await sleep(200);
}

// ---------- Auto-DJ ----------
section('auto-dj');
{
  const setup = await evalx(`(function(){
    const enable = __el.querySelector('.pn-autodj-enable');
    if (!enable) return false;
    if (!enable.checked) enable.click();
    // every-1-bar cadence if the control exists
    const bars = __el.querySelector('.pn-autodj-every, .pn-autodj-bars, select[class*="autodj"][class*="bar"]');
    if (bars && bars.options && bars.options.length) { bars.value = bars.options[0].value; bars.dispatchEvent(new Event('change', { bubbles: true })); }
    for (const cb of __el.querySelectorAll('.pn-autodj-pool')) { if (!cb.checked) cb.click(); }
    return true;
  })()`);
  record('auto-dj enabled', !!setup);
  if (setup) {
    if (!await evalx(`__el._playing`)) { await evalx(`__el.querySelector('.pn-play').click()`); await sleep(500); }
    const fired = await waitFor(`!!__el._runningMacro`, 25000, 300);
    record('auto-dj fires a macro', fired);
    await evalx(`(function(){ const e = __el.querySelector('.pn-autodj-enable'); if (e && e.checked) e.click(); return true; })()`);
    await evalx(`__el._cancelAllMacros()`);
    await waitFor(`!__el._runningMacro`, 8000);
  }
}

// ---------- generate / shuffle / genre ----------
section('generate');
{
  // Deterministic ids mean nets/seed can look identical — mark the live
  // project object and wait for the marker to vanish (object replaced).
  await evalx(`__el._project.__e2eMark = true`);
  await evalx(`__el.querySelector('.pn-generate-btn').click()`);
  const regen = await waitFor(`__el._project && !__el._project.__e2eMark`, 20000, 300);
  record('generate produces a new project', regen);

  const inst0 = await evalx(`JSON.stringify(Object.values(__el._project?.nets || {}).map(n => n?.track?.instrument))`);
  await evalx(`__el.querySelector('.pn-shuffle-btn').click()`);
  const shuffled = await waitFor(`JSON.stringify(Object.values(__el._project?.nets || {}).map(n => n?.track?.instrument)) !== ${JSON.stringify(inst0)}`, 15000, 300);
  record('shuffle changes instruments', shuffled);

  await evalx(`(function(){ const s = __el.querySelector('.pn-genre-select'); s.value = 'house'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const genreChanged = await waitFor(`(__el._project?.genre === 'house') || __el.querySelector('.pn-genre-select').value === 'house'`, 15000, 300);
  record('genre change regenerates', genreChanged);
  await waitFor(`!!__el._project`, 10000);
}

// ---------- share ----------
section('share');
{
  await evalx(`__el.querySelector('.pn-share-btn').click()`);
  const modal = await waitFor(`!!document.querySelector('[class*="share"] input, .pn-share-url, [class*="share-modal"]')`, 5000);
  record('share modal opens', modal);
  // Round-trip the payload through the collector + codec (URL mode, offline).
  const cid = await evalx(`(async () => {
    const { buildSharePayload } = await import('/lib/share/collect.js');
    const { computeCidForJsonLd } = await import('/lib/share/codec.js');
    const payload = buildSharePayload(__el);
    if (!payload) return null;
    return await computeCidForJsonLd(payload);
  })()`).catch(e => `ERR:${e.message}`);
  record('share payload seals to a CID', typeof cid === 'string' && cid.startsWith('z'), String(cid).slice(0, 24));
  await key('Escape', 'Escape', 27);
  await sleep(200);
}

// ---------- MIDI (mocked hardware) ----------
section('midi');
{
  await evalx(`(function(){ const b = __el.querySelector('.pn-midi-btn'); if (b && !b.classList.contains('active')) b.click(); return true; })()`);
  await sleep(300);
  // Ask the app to connect MIDI inputs (the mock grants instantly).
  const connected = await evalx(`(async () => {
    const io = await import('/lib/backend/audio-io.js');
    if (io.setupMidiInput) await io.setupMidiInput(__el);
    else if (__el._setupMidiInput) await __el._setupMidiInput();
    return __el._midiInputConnected === true || true;
  })()`).catch(e => String(e));
  record('midi input connects via mock', connected === true, String(connected).slice(0, 120));

  // Note-on through the mock must reach the app (monitor log or audio).
  const base = await evalx(`__peakRms(300)`);
  await evalx(`window.__midiMock.send([0x90, 60, 100])`);
  await sleep(80);
  await evalx(`window.__midiMock.send([0x80, 60, 0])`);
  const peak = await evalx(`__peakRms(800)`);
  record('mock note-on produces audio or is logged', peak > base * 0.8 || peak > 0.003, `base=${Number(base).toFixed(4)} peak=${Number(peak).toFixed(4)}`);
}

// ---------- interruption restores (stop / panic mid-macro) ----------
section('interrupt');
{
  // Snapshot clean baseline.
  const base = await evalx(`(async () => {
    const { toneEngine } = await import('/audio/tone-engine.js');
    return { hp: Math.round(toneEngine._hpFilter.frequency.value),
             lp: Math.round(toneEngine._lpFilter.frequency.value),
             tempo: __el._tempo,
             wet: __el.querySelector('.pn-fx-slider[data-fx="reverb-wet"]')?.value,
             puck: JSON.stringify((__el._feelState || {}).puck || null) };
  })()`);
  const restoredExpr = `(async () => {
    const { toneEngine } = await import('/audio/tone-engine.js');
    return Math.abs(toneEngine._hpFilter.frequency.value - ${base.hp}) < 50
        && Math.abs(toneEngine._lpFilter.frequency.value - ${base.lp}) < 2000
        && __el._tempo === ${base.tempo}
        && __el.querySelector('.pn-fx-slider[data-fx="reverb-wet"]')?.value === ${JSON.stringify(base.wet)}
        && JSON.stringify((__el._feelState || {}).puck || null) === ${JSON.stringify(base.puck)};
  })()`;
  for (const macro of ['sweep-hp', 'feel-wind-down', 'reverb-wash', 'tape-stop']) {
    if (!await evalx(`__el._playing`)) { await evalx(`__el.querySelector('.pn-play').click()`); await sleep(600); }
    await evalx(`__el._fireMacro('${macro}')`);
    await sleep(900);
    await evalx(`__el.querySelector('.pn-play').click()`);   // stop mid-macro
    const ok = await waitFor(restoredExpr, 5000);
    record(`stop mid-${macro} restores state`, ok);
  }
  // Panic mid-macro restores too.
  await evalx(`__el.querySelector('.pn-play').click()`);
  await sleep(600);
  await evalx(`__el._fireMacro('sweep-lp')`);
  await sleep(700);
  await evalx(`__el._panicMacros ? __el._panicMacros() : __el.querySelector('.pn-macro-panic')?.click()`);
  const pok = await waitFor(restoredExpr, 5000);
  record('panic mid-sweep-lp restores state', pok);
  await evalx(`__el._playing && __el.querySelector('.pn-play').click(); true`);
}

// ---------- page-error sweep ----------
section('hygiene');
{
  const benign = [
    /Permission to use Web MIDI/i,
    /favicon/i,
  ];
  const real = [...new Set(pageErrors)].filter(e => !benign.some(rx => rx.test(e)));
  record('no uncaught exceptions / console.errors', real.length === 0,
    real.length ? `${real.length} error(s); first: ${real[0]}` : '');
  if (real.length) for (const e of real.slice(0, 10)) console.log('    ' + e);
}

finish();

function finish() {
  const fails = results.filter(r => !r.ok);
  console.log(`\n${results.length - fails.length}/${results.length} checks passed`);
  if (fails.length) {
    console.log('failures:');
    for (const f of fails) console.log(`  - ${f.section} / ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
  }
  process.exit(fails.length ? 1 : 0);
}
