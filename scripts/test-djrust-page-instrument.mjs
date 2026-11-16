#!/usr/bin/env node
//
// test-djrust-page-instrument.mjs — the live instrument change on the djrust engine (rebuild
// item R-5, docs/MIGRATION-djrust-wasm.md §12): the mixer's dropdown, its » rotate and Shuffle.
//
//   node scripts/test-djrust-page-instrument.mjs            # pinned public/djrust/djwasm.wasm
//   DJRUST_WASM=<pkg dir or .wasm> node scripts/test-djrust-page-instrument.mjs
//
// Real lib/ui/{mixer,engine-gaps}.js, lib/backend/{wave,index}.js, lib/project/sync.js and
// sequencer-worker.js, a stub element, no browser. Held here:
//
//   - engine-gaps: the dropdown is a disabled label and » is hidden on a module without
//     INSTRUMENT (djwasm 0.3.0, the pinned one today), both live on one that reports it;
//   - routing: mixer.js changeInstrument changes the page's project, sends one
//     'instrument-change' (the worker and a server backend get it), and wave.js posts
//     {type:'instrument'} to the engine for every net of a grouped row (never a control net),
//     only when the module reports INSTRUMENT; Shuffle's instruments-changed the same;
//   - the worker keeps its project in step, so a later message that sends the worker's nets
//     back (a pattern edit) does not undo the instrument;
//   - end to end, page → worklet.js → djwasm (a module with INSTRUMENT): the change sounds from
//     the block after it, the audio before it is untouched, and the song does not move (the
//     wave-tick stream, its ticks and fired transitions, is the unchanged run's). On a module
//     without it the page posts nothing and the engine plays on as before.
//
// A missing pinned module skips the wasm sections only (exit 0); one named by DJRUST_WASM that is
// not there fails (exit 2), as in the other djrust gates.

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolveModule, missingModule } from './djrust-golden.mjs';
import { routeToWave, setEngineFeatures, engineSetInstruments, instrumentTargets } from '../public/lib/backend/wave.js';
import { sendWs } from '../public/lib/backend/index.js';
import { changeInstrument } from '../public/lib/ui/mixer.js';
import { onInstrumentsChanged } from '../public/lib/project/sync.js';
import { gapSelectors, engineGap } from '../public/lib/ui/engine-gaps.js';

const V030 = 63; // SEEK|NET_MACROS|CONTROL_MACROS|GROOVE|FRAME_CLOCK|EVENTS: what 0.3.0 reports
const INSTRUMENT = 2048;

globalThis.requestAnimationFrame ||= () => 0;
console.info = () => {};

let failures = 0, skipped = 0;
async function test(name, fn) {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failures++; console.log(`FAIL ${name}\n     ${err.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const ofType = (list, type) => list.filter((m) => m.type === type);

function stubEl({ features = V030, project } = {}) {
    const wave = [], worker = [];
    const el = {
        _tick: 0, _playing: true, _engineFeatures: 0, _toneStarted: true,
        _project: project || { nets: {
            kick: { riffGroup: 'kick', track: { channel: 10, instrument: 'drums' } },
            'lead-a': { riffGroup: 'melody', track: { channel: 3, instrument: 'sync-lead' } },
            'lead-b': { riffGroup: 'melody', track: { channel: 3, instrument: 'sync-lead' } },
            bass: { riffGroup: 'bass', track: { channel: 2, instrument: 'reese' } },
            'macro-curve': { role: 'control', riffGroup: 'melody', track: { channel: 1 } },
        } },
        _channelInstruments: {},
        _worker: { postMessage: (m) => worker.push(m) },
        querySelector() { return null },
        querySelectorAll() { return []; },
        _renderMixer() {}, _reapplyChannelRoutings() {},
        wave, worker,
    };
    el._sendWs = (m) => sendWs(el, m);
    el._wave = Promise.resolve({ post: (m) => wave.push(m) });
    setEngineFeatures(el, features);
    return el;
}

// --- engine-gaps ------------------------------------------------------------------------------

await test('engine-gaps: 0.3.0 keeps the dropdown a label and hides », INSTRUMENT makes both live', () => {
    for (const mask of [0, V030]) {
        const { hide, disable } = gapSelectors(mask);
        assert.ok(disable.includes('.pn-mixer-instrument'), `mask ${mask}: dropdown disabled`);
        assert.ok(hide.includes('.pn-mixer-rotate'), `mask ${mask}: » hidden`);
        assert.equal(engineGap('instrument-change', mask), true);
    }
    for (const mask of [INSTRUMENT, V030 | INSTRUMENT]) {
        const { hide, disable } = gapSelectors(mask);
        assert.ok(!disable.includes('.pn-mixer-instrument'), `mask ${mask}: dropdown live`);
        assert.ok(!hide.includes('.pn-mixer-rotate'), `mask ${mask}: » shown`);
        assert.equal(engineGap('instrument-change', mask), false);
        // only that gap opened: the Tone tone tools stay hidden
        assert.ok(hide.includes('.pn-mixer-test') && hide.includes('.pn-mixer-tone-next'));
    }
});

// --- routing ----------------------------------------------------------------------------------

await test('mixer: a grouped row changes every net of the group, the engine gets one message per voiced net', async () => {
    const el = stubEl({ features: V030 | INSTRUMENT });
    const changed = await changeInstrument(el, 'lead-a', 'melody', 'vibes');
    await flush();
    assert.deepEqual(changed.sort(), ['lead-a', 'lead-b', 'macro-curve']);
    assert.equal(el._project.nets['lead-a'].track.instrument, 'vibes');
    assert.equal(el._project.nets['lead-b'].track.instrument, 'vibes');
    assert.equal(el._project.nets.bass.track.instrument, 'reese', 'another group is untouched');
    assert.deepEqual(ofType(el.wave, 'instrument').map((m) => [m.netId, m.instrument]).sort(),
        [['lead-a', 'vibes'], ['lead-b', 'vibes']], 'no message for the control net');
    assert.deepEqual(ofType(el.worker, 'instrument-change'),
        [{ type: 'instrument-change', netId: 'lead-a', riffGroup: 'melody', instrument: 'vibes' }]);
});

await test('mixer: an ungrouped net is the one net', async () => {
    const el = stubEl({ features: V030 | INSTRUMENT });
    await changeInstrument(el, 'bass', undefined, 'sub-bass');
    await flush();
    assert.deepEqual(ofType(el.wave, 'instrument'), [{ type: 'instrument', netId: 'bass', instrument: 'sub-bass' }]);
    assert.deepEqual(ofType(el.worker, 'instrument-change').map((m) => m.riffGroup), ['']);
});

await test('mixer: djwasm 0.3.0 (no INSTRUMENT) posts nothing to the engine; the project and worker still change', async () => {
    const el = stubEl({ features: V030 });
    await changeInstrument(el, 'lead-a', 'melody', 'vibes');
    await flush();
    assert.equal(ofType(el.wave, 'instrument').length, 0);
    assert.equal(el._project.nets['lead-a'].track.instrument, 'vibes');
    assert.equal(ofType(el.worker, 'instrument-change').length, 1);
});

await test('routing: no engine yet posts nothing (the engine is made from the changed project)', async () => {
    const el = stubEl({ features: V030 | INSTRUMENT });
    el._wave = null;
    assert.equal(routeToWave(el, { type: 'instrument-change', netId: 'bass', riffGroup: '', instrument: 'x' }), false);
    assert.equal(engineSetInstruments(el, { bass: 'x' }), 0);
    assert.deepEqual(instrumentTargets(el._project, 'lead-b', 'melody').sort(), ['lead-a', 'lead-b']);
    assert.deepEqual(instrumentTargets(el._project, 'nope', ''), []);
});

await test('shuffle: instruments-changed reaches the engine too (INSTRUMENT only)', async () => {
    const el = stubEl({ features: V030 | INSTRUMENT });
    onInstrumentsChanged(el, { kick: 'drums-808', bass: 'acid-bass', 'macro-curve': 'x' });
    await flush();
    assert.deepEqual(ofType(el.wave, 'instrument').map((m) => [m.netId, m.instrument]).sort(),
        [['bass', 'acid-bass'], ['kick', 'drums-808']]);
    const old = stubEl({ features: V030 });
    onInstrumentsChanged(old, { kick: 'drums-808' });
    await flush();
    assert.equal(ofType(old.wave, 'instrument').length, 0);
});

// --- the worker keeps its project in step -----------------------------------------------------

await test('worker: instrument-change updates its project, so a pattern edit sends the new instrument back', async () => {
    const posted = [];
    globalThis.self = { postMessage: (m) => posted.push(m) };
    await import(pathToFileURL(new URL('../public/sequencer-worker.js', import.meta.url).pathname).href + '?instrument');
    const send = (data) => globalThis.self.onmessage({ data });
    send({ type: 'generate', genre: 'techno', params: { seed: 42 } });
    const sync = ofType(posted, 'project-sync').at(-1);
    assert.ok(sync, 'a project-sync after generate');
    const [id] = Object.entries(sync.project.nets).find(([, n]) => n.track?.generator && n.role !== 'control') || [];
    assert.ok(id, 'a net with a generator recipe');
    const group = sync.project.nets[id].riffGroup;
    send({ type: 'instrument-change', netId: id, riffGroup: '', instrument: 'drums-808' });
    send({ type: 'update-track-pattern', netId: id, ringSize: 16, beats: 5 });
    const upd = ofType(posted, 'track-pattern-updated').at(-1);
    assert.ok(upd, `track-pattern-updated for ${id} (${group})`);
    assert.equal(upd.net.track.instrument, 'drums-808');
    delete globalThis.self;
});

// --- end to end: page → worklet.js → djwasm ---------------------------------------------------

const mod = await resolveModule();
if (!mod) {
    const code = missingModule('test-djrust-page-instrument', undefined, true);
    if (code) process.exit(code);
}

let workletCls = null;
async function workletClass(path) {
    if (workletCls) return workletCls;
    let reg = null;
    globalThis.AudioWorkletProcessor = class {
        constructor() { this.port = { onmessage: null, _posted: [], postMessage(m) { this._posted.push(m); } }; }
    };
    globalThis.registerProcessor = (name, cls) => { reg = cls; };
    await import(pathToFileURL(path).href + '?page-instrument');
    delete globalThis.registerProcessor;
    workletCls = reg;
    return reg;
}

/** Play `project` for `quanta` render quanta; at quantum `at` the page changes `change`. */
async function runE2E(project, { quanta, at = -1, change = null } = {}) {
    const Proc = await workletClass(mod.workletPath);
    globalThis.sampleRate = 48000; globalThis.currentTime = 0;
    try {
        const proc = new Proc({ processorOptions: { module: mod.module } });
        const ready = proc.port._posted.find((m) => m.type === 'ready');
        const doc = JSON.parse(JSON.stringify(project)); // the page's own copy, changed in place
        const el = stubEl({ features: ready.features, project: doc });
        const wave = { post: (m) => { el.wave.push(m); proc.port.onmessage({ data: m }); } };
        el._wave = Promise.resolve(wave);
        wave.post({ type: 'load', project: doc });
        wave.post({ type: 'transport', action: 'play' });
        const L = new Float32Array(128), R = new Float32Array(128);
        const audio = new Float32Array(quanta * 256), ticks = [];
        let seen = 0;
        for (let q = 0; q < quanta; q++) {
            if (q === at) { await changeInstrument(el, change.netId, change.riffGroup, change.instrument); await flush(); }
            globalThis.currentTime = q * 128 / 48000;
            proc.process([], [[L, R]]);
            audio.set(L, q * 256); audio.set(R, q * 256 + 128);
            const posted = proc.port._posted;
            for (; seen < posted.length; seen++) {
                const m = posted[seen];
                if (m.type === 'wave-tick') ticks.push(JSON.stringify([m.tick, m.fired]));
                if (m.type === 'instrument-refused' || m.type === 'error') throw new Error(`engine: ${JSON.stringify(m)}`);
            }
        }
        return { el, ready, audio, ticks };
    } finally { delete globalThis.sampleRate; delete globalThis.currentTime; }
}

const same = (a, b) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

await test('e2e: a live change sounds from the next block, the song does not move', async () => {
    if (!mod) { skipped++; return; }
    const dj = await mod.loader.instantiate(mod.module);
    const project = dj.compose({ genre: 'techno', seed: 42 }).doc;
    // (a loop has no riff groups: the melody is the one net; beats' voice families make a pad
    // the soft voice and a bass the saw whatever their name, so the melody is the net to change)
    const [melody, net] = Object.entries(project.nets).find(([id, n]) => (n.track?.group || id) === 'melody') || [];
    assert.ok(melody, 'a melody net');
    const change = { netId: melody, riffGroup: net.riffGroup || '', instrument: 'vibes' };
    const QUANTA = 3000, AT = 1500;
    const base = await runE2E(project, { quanta: QUANTA });
    const live = await runE2E(project, { quanta: QUANTA, at: AT, change });
    if (!(live.ready.features & INSTRUMENT)) {
        // djwasm 0.3.0: the page sends nothing, the engine plays on exactly as before
        assert.equal(ofType(live.el.wave, 'instrument').length, 0);
        assert.ok(same(live.audio, base.audio), 'nothing reached the engine');
        console.log('     (the module has no INSTRUMENT: only the no-op half ran; DJRUST_WASM=<a pkg with it> for the rest)');
        skipped++;
        return;
    }
    assert.ok(ofType(live.el.wave, 'instrument').length >= 1, 'the page posted the change');
    const cut = AT * 256;
    assert.ok(same(live.audio.subarray(0, cut), base.audio.subarray(0, cut)), 'the change touched the past');
    assert.ok(!same(live.audio.subarray(cut), base.audio.subarray(cut)), 'no change heard');
    assert.deepEqual(live.ticks, base.ticks, 'the song moved: the tick stream differs');
    // and the voice is the changed document's: made before the first block (nothing ringing to
    // cut), the change renders bit for bit what the document with the instrument in it renders
    const changedDoc = JSON.parse(JSON.stringify(project));
    for (const id of instrumentTargets(changedDoc, change.netId, change.riffGroup)) changedDoc.nets[id].track.instrument = 'vibes';
    const fromStart = await runE2E(changedDoc, { quanta: 1200 });
    const atZero = await runE2E(project, { quanta: 1200, at: 0, change });
    assert.ok(same(atZero.audio, fromStart.audio), 'not the changed document\'s voice');
    assert.deepEqual(atZero.ticks, fromStart.ticks);
});

await test('e2e: changing a net to the instrument it plays is silent (bit for bit)', async () => {
    if (!mod) { skipped++; return; }
    const dj = await mod.loader.instantiate(mod.module);
    const project = dj.compose({ genre: 'house', seed: 7 }).doc;
    const [id, net] = Object.entries(project.nets).find(([, n]) => n.role !== 'control' && n.track?.instrument);
    const base = await runE2E(project, { quanta: 1200 });
    const live = await runE2E(project, { quanta: 1200, at: 600, change: { netId: id, riffGroup: '', instrument: net.track.instrument } });
    assert.ok(same(live.audio, base.audio));
    assert.deepEqual(live.ticks, base.ticks);
});

console.log(`\ntest-djrust-page-instrument: ${failures ? `FAIL (${failures})` : 'ok'}${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failures ? 1 : 0);
