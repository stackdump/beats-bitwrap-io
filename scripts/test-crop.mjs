#!/usr/bin/env node
//
// test-crop.mjs — R-9 crop on the djrust engine (docs/MIGRATION-djrust-wasm.md §12).
//
//   node scripts/test-crop.mjs [--wasm P] [--skip-missing]
//
// Crop never needed an engine export: the sequencer worker builds the cropped project (music
// nets kept, structure trimmed, control nets rebuilt) and sends it back as an ordinary
// project-sync, and lib/backend/wave.js waveLoadProject hands that to the worklet as a `load`.
// The engine applies a load made while playing at the next bar line and restarts its tick at 0.
// This test drives exactly that path in Node, mid-play:
//
//   real public/sequencer-worker.js  --crop-->  project-sync + mute-state
//   real backend/index.js handleWsMessage(project-sync) -> real wave.js waveLoadProject
//   -> worklet-protocol {type:'load'} applied to a djwasm engine (scripts/djrust-golden.mjs)
//
// and checks: the cropped project's shape; the engine keeps playing the old project up to the
// bar line, then its tick goes back to 0; after the swap the engine holds exactly the cropped
// project's nets and its initial mutes; the cropped audio is not silent; and a fresh engine
// that loads the cropped project before play fires the same transitions, controls, markings
// and mutes tick for tick, so a crop plays the same as opening the cropped track. (Audio bytes
// differ across the bar line by design: the old project's voices ring on.)
//
// The module comes from --wasm, else $DJRUST_WASM, else public/djrust/djwasm.wasm (the pin).
// Exit: 0 pass, 1 fail, 2 no module (0 with --skip-missing).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolveModule, newEngine, applyMsg, composeProject, missingModule } from './djrust-golden.mjs';

const args = process.argv.slice(2);
const wasmArg = args.includes('--wasm') ? args[args.indexOf('--wasm') + 1] : undefined;
const skipMissing = args.includes('--skip-missing');

const SR = 48000;
const BLOCK = 128;
const TICKS_PER_BAR = 16;
const GENRE = 'techno', SEED = 42, STRUCTURE = 'standard';
const CROP = { startTick: 64, endTick: 64 + 8 * TICKS_PER_BAR }; // bars 5-12
const CROP_AT_TICK = 37; // mid-bar, so the swap has to wait for tick 48

const mod = await resolveModule(wasmArg);
if (!mod) process.exit(missingModule('test-crop', wasmArg, skipMissing));

// --- the real sequencer worker, in-process ---------------------------------------------------
const fromWorker = [];
globalThis.self = { postMessage: (m) => fromWorker.push(m) };
await import('../public/sequencer-worker.js');
const toWorker = (msg) => globalThis.self.onmessage({ data: msg });
const drainWorker = () => fromWorker.splice(0);

const { handleWsMessage } = await import('../public/lib/backend/index.js');

// --- a stub studio element whose engine is a djwasm instance ---------------------------------
const dj = newEngine(mod, SR);
const el = {
    _tick: 0, _playing: false, _playbackMode: 'single', _totalSteps: 0,
    _project: null, _activeNetId: null,
    _mutedNets: new Set(), _manualMutedNets: new Set(),
    _applyProjectSync(project) { el._project = project; },
    _autoDjTick() {}, _fireRepeatingOneShots() {},
    _updatePlayhead() {}, _renderMixer() {}, _renderMidiPanel() {}, _renderNet() {},
    querySelector() { return null; },
    // wave.js posts to the engine through this promise, as ensureWave leaves it.
    _wave: Promise.resolve({ post: (m) => applyMsg(dj, m) }),
};
el._sendWs = (m) => toWorker(m);
const settle = () => new Promise((r) => setTimeout(r, 0)); // let el._wave.then(...) run
const dispatch = async (msgs) => { for (const m of msgs) handleWsMessage(el, m); await settle(); };

const mutedSet = (o) => Object.entries(o || {}).filter(([, v]) => v).map(([k]) => k).sort();
const sha = () => createHash('sha256');

let failures = 0;
function check(name, fn) {
    try { fn(); console.log(`ok   ${name}`); }
    catch (err) { failures++; console.log(`FAIL ${name}\n     ${err.message}`); }
}

// One 128-frame quantum; returns the engine's tick report for it (or null when no tick began).
function quantum(engine, hash) {
    const t = engine.process(BLOCK);
    const [l, r] = engine.blocks(BLOCK);
    if (hash) {
        const inter = new Float32Array(2 * BLOCK);
        for (let i = 0; i < BLOCK; i++) { inter[2 * i] = l[i]; inter[2 * i + 1] = r[i]; }
        hash.update(new Uint8Array(inter.buffer));
    }
    let peak = 0;
    for (let i = 0; i < BLOCK; i++) peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
    return { rep: t > 0 ? engine.report() : null, peak };
}

// 1. Load the source track the way the studio does: worker project-load -> project-sync.
const source = composeProject(GENRE, SEED, STRUCTURE);
toWorker({ type: 'project-load', project: source });
await dispatch(drainWorker());
const srcNets = Object.keys(el._project.nets);
for (const id of el._mutedNets) dj.setMute(id, true); // ensureWave's one-time mute hand-over
dj.play();

// 2. Play to mid-bar.
let lastTick = -1;
while (lastTick < CROP_AT_TICK) { const { rep } = quantum(dj); if (rep) lastTick = rep.tick; }

// 3. Crop while playing.
toWorker({ type: 'crop', ...CROP });
const cropMsgs = drainWorker();
const sync = cropMsgs.find((m) => m.type === 'project-sync');
const workerMutes = cropMsgs.filter((m) => m.type === 'mute-state').pop();
await dispatch(cropMsgs);
const cropped = sync && sync.project;

check('the worker answers a crop with project-sync then mute-state', () => {
    assert.ok(cropped, 'no project-sync');
    assert.deepEqual(cropMsgs.map((m) => m.type), ['project-sync', 'mute-state']);
});

check('the cropped project: music nets kept, structure trimmed to the range, control nets rebuilt', () => {
    const music = Object.entries(cropped.nets).filter(([, n]) => n.role !== 'control').map(([id]) => id);
    const control = Object.entries(cropped.nets).filter(([, n]) => n.role === 'control').map(([id]) => id);
    const srcMusic = Object.entries(source.nets).filter(([, n]) => n.role !== 'control').map(([id]) => id);
    assert.deepEqual(music.sort(), srcMusic.sort());
    assert.ok(control.length > 0, 'no control nets rebuilt');
    assert.equal(cropped.structure.reduce((s, x) => s + x.steps, 0), CROP.endTick - CROP.startTick);
    assert.match(cropped.name, /\[crop\]$/);
    assert.equal(el._project, cropped, 'project-sync did not reach the page');
    assert.notEqual(Object.keys(cropped.nets).length, srcNets.length, 'crop left the net count unchanged');
});

// 4. Keep playing: record ticks through the bar line and well past it. From the swap on, each
//    tick's report (fired, controls), marking and mutes go into `liveNet`.
const RECORD_TICKS = 3 * TICKS_PER_BAR;
const MAX_QUANTA = 20000;
const netLine = (engine, rep) => JSON.stringify([rep, engine.marking(), engine.muted()]) + '\n';
const ticks = [];
const liveNet = sha();
let afterPeak = 0, swapped = false, mutedAtSwap = null, netsAtSwap = null, recorded = 0;
for (let q = 0; q < MAX_QUANTA && recorded < RECORD_TICKS; q++) {
    const { rep, peak } = quantum(dj);
    if (swapped) afterPeak = Math.max(afterPeak, peak);
    if (!rep) continue;
    ticks.push(rep.tick);
    if (!swapped && rep.tick === 0) {
        swapped = true;
        netsAtSwap = Object.keys(dj.marking()).sort();
        mutedAtSwap = mutedSet(dj.muted());
    }
    // The report that says tick 0 is the bar line itself: the load is applied there and no
    // transition fires in it. The cropped project's first tick reports as 1, as a fresh
    // engine's first tick does (report.tick counts ticks begun).
    if (swapped && rep.tick > 0) { liveNet.update(netLine(dj, rep)); recorded++; }
}

check('the engine plays the old project to the bar line, then its tick goes back to 0', () => {
    const bar = Math.ceil((CROP_AT_TICK + 1) / TICKS_PER_BAR) * TICKS_PER_BAR; // 48
    const expectPre = [];
    for (let t = CROP_AT_TICK + 1; t < bar; t++) expectPre.push(t);
    const zeroAt = ticks.indexOf(0);
    assert.ok(zeroAt >= 0, `tick never returned to 0: ${ticks.join(',')}`);
    assert.deepEqual(ticks.slice(0, zeroAt), expectPre, 'ticks before the swap');
    for (let i = zeroAt; i < ticks.length; i++) assert.equal(ticks[i], i - zeroAt, 'ticks after the swap');
});

check('after the swap the engine holds exactly the cropped nets (net count after project-sync)', () => {
    assert.deepEqual(netsAtSwap, Object.keys(cropped.nets).sort());
});

check('after the swap the engine mutes are the cropped initial mutes the worker reported', () => {
    assert.deepEqual(mutedAtSwap, mutedSet(workerMutes.mutedNets));
    assert.deepEqual([...el._mutedNets].sort(), mutedSet(workerMutes.mutedNets), 'page mute state');
});

check('the cropped track is audible', () => assert.ok(afterPeak > 1e-3, `peak ${afterPeak}`));

// 5. A crop must play like opening the cropped track: a fresh engine that loads it before play
//    fires the same transitions, controls, markings and mutes, tick for tick, from its first
//    tick.
//    (Audio bytes are not compared: the live engine carries the old project's ringing voices
//    across the bar line, which a fresh engine does not have.)
check('crop = opening the cropped track (net stream, tick for tick)', () => {
    const fresh = newEngine(mod, SR);
    applyMsg(fresh, { type: 'load', project: cropped });
    for (const id of mutedSet(workerMutes.mutedNets)) fresh.setMute(id, true);
    fresh.play();
    const ref = sha();
    let n = 0, freshTicks = [];
    for (let q = 0; q < MAX_QUANTA && n < recorded; q++) {
        const { rep } = quantum(fresh);
        if (!rep) continue;
        freshTicks.push(rep.tick);
        ref.update(netLine(fresh, rep)); n++;
    }
    assert.equal(n, recorded, 'fresh engine ticked too few times');
    assert.equal(freshTicks[0], 1, `fresh engine's first tick reports ${freshTicks[0]}`);
    assert.equal(ref.digest('hex'), liveNet.digest('hex'));
});

if (failures) { console.log(`\ntest-crop: ${failures} failed`); process.exit(1); }
console.log(`\ntest-crop: all pass (module sha256 ${mod.sha256.slice(0, 12)}…)`);
