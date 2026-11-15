#!/usr/bin/env node
//
// test-wave-tick-feed.mjs — R-2 page part (docs/MIGRATION-djrust-wasm.md §12).
//
//   node scripts/test-wave-tick-feed.mjs
//
// The djrust worklet is the clock. lib/backend/wave.js onWaveMessage must run the page's
// per-tick consumers (el._autoDjTick, el._fireRepeatingOneShots) exactly once per wave-tick,
// detect a wrap (tick lower than the previous one) and pass it through as (prev, tick), and not
// run them a second time from the state-sync it forwards every sixth tick. And the worker's
// mute-state must yield to the mutes the engine reports (backend/index.js 'mute-state').
//
// Pure Node: real wave.js + index.js, a stub element, no server, no audio, no module.

import assert from 'node:assert/strict';
import { onWaveMessage, feedWaveTick, routeToWave, waveLoadProject } from '../public/lib/backend/wave.js';
import { handleWsMessage } from '../public/lib/backend/index.js';

let failures = 0;
function test(name, fn) {
    try { fn(); console.log(`ok   ${name}`); }
    catch (err) { failures++; console.log(`FAIL ${name}\n     ${err.message}`); }
}

function stubEl() {
    const el = {
        _tick: 0, _playing: false, _playbackMode: 'single', _totalSteps: 0,
        _project: { nets: {} }, _activeNetId: null,
        _mutedNets: new Set(), _manualMutedNets: new Set(),
        auto: [], shots: [], forwarded: [],
        _autoDjTick(p, c) { el.auto.push([p, c]); },
        _fireRepeatingOneShots(p, c) { el.shots.push([p, c]); },
        _updatePlayhead() {}, _renderMixer() {}, _renderMidiPanel() {}, _renderNet() {},
        querySelector() { return null; },
    };
    el._handleWsMessage = (m) => { el.forwarded.push(m.type); handleWsMessage(el, m); };
    // ensureWave returns an existing el._wave, so transport never starts real audio here.
    el._wave = Promise.resolve({ post() {} });
    return el;
}

// One wave-tick exactly as public/djrust/worklet.js report() posts it (STATE_EVERY = 6).
function tickMsg(tick, extra = {}) {
    const m = { type: 'wave-tick', tick, fired: [], controls: [], ...extra };
    if (tick % 6 === 0) m.state = {};
    return m;
}

const pairs = (a, b) => Array.from({ length: b - a }, (_, i) => [a + i, a + i + 1]);

test('autoDjTick and repeating one-shots run once per wave-tick', () => {
    const el = stubEl();
    for (let t = 0; t <= 40; t++) onWaveMessage(el, tickMsg(t));
    // tick 0 is the baseline; every later tick is one call, none doubled by state-sync.
    assert.deepEqual(el.auto, pairs(0, 40));
    assert.deepEqual(el.shots, pairs(0, 40));
    assert.equal(el.forwarded.filter(t => t === 'state-sync').length, 7); // 0, 6, … 36
    assert.equal(el._tick, 36); // state-sync still moves the playhead tick
});

test('a wrap is detected and passed through as (prev, tick)', () => {
    const el = stubEl();
    for (const t of [44, 45, 46, 47, 0, 1, 2]) onWaveMessage(el, tickMsg(t));
    assert.deepEqual(el.auto, [[44, 45], [45, 46], [46, 47], [47, 0], [0, 1], [1, 2]]);
    assert.deepEqual(el.shots, el.auto);
    assert.equal(el._waveTickWraps, 1);
});

test('a skipped tick (two ticks in one quantum) is one call spanning both', () => {
    const el = stubEl();
    for (const t of [10, 11, 13, 14]) onWaveMessage(el, tickMsg(t));
    assert.deepEqual(el.auto, [[10, 11], [11, 13], [13, 14]]);
});

test('a repeated tick is not a step', () => {
    const el = stubEl();
    for (const t of [5, 5, 6, 6]) feedWaveTick(el, t);
    assert.deepEqual(el.auto, [[5, 6]]);
});

test('a transport change resets the baseline (resume is not a jump)', () => {
    const el = stubEl();
    for (const t of [20, 21, 22]) onWaveMessage(el, tickMsg(t));
    assert.equal(routeToWave(el, { type: 'transport', action: 'pause' }), true);
    assert.equal(routeToWave(el, { type: 'transport', action: 'play' }), true);
    for (const t of [23, 24]) onWaveMessage(el, tickMsg(t));
    // 22 → 23 is not reported: the first tick after play is a baseline.
    assert.deepEqual(el.auto, [[20, 21], [21, 22], [23, 24]]);
    assert.equal(el._waveTickWraps, undefined);
});

test('a worker / WS state-sync still drives the consumers itself', () => {
    const el = stubEl();
    handleWsMessage(el, { type: 'state-sync', state: {}, tick: 6 });
    handleWsMessage(el, { type: 'state-sync', state: {}, tick: 12 });
    assert.deepEqual(el.auto, [[0, 6], [6, 12]]);
});

const muted = (o) => Object.fromEntries(Object.entries(o));
const set = (s) => [...s].sort();

test('worker mute-state yields to the mutes the engine holds', () => {
    const el = stubEl();
    // Project load: the worker reports the initial mutes (melody starts muted).
    waveLoadProject(el, { nets: {} });
    handleWsMessage(el, { type: 'mute-state', mutedNets: muted({ melody: true }), mutedNotes: {} });
    assert.deepEqual(set(el._mutedNets), ['melody']);
    // The engine's structure net unmutes melody and mutes pad.
    onWaveMessage(el, tickMsg(64, { controls: [['struct', 't1', { action: 'unmute-track' }]],
        mutedNets: { melody: false, pad: true } }));
    assert.deepEqual(set(el._mutedNets), ['pad']);
    // The page mutes bass; the worker echoes its never-playing view (melody still muted there).
    handleWsMessage(el, { type: 'mute-state', mutedNets: muted({ melody: true, bass: true }), mutedNotes: {} });
    assert.deepEqual(set(el._mutedNets), ['bass', 'pad'], 'engine-held mutes kept, page change applied');
    // The page unmutes bass.
    handleWsMessage(el, { type: 'mute-state', mutedNets: muted({ melody: true }), mutedNotes: {} });
    assert.deepEqual(set(el._mutedNets), ['pad']);
    // A new project: the worker is the authority again until the engine reports.
    waveLoadProject(el, { nets: {} });
    handleWsMessage(el, { type: 'mute-state', mutedNets: muted({ hat: true }), mutedNotes: {} });
    assert.deepEqual(set(el._mutedNets), ['hat']);
});

test('manual (lock) mutes the engine dropped are re-sent', () => {
    const el = stubEl();
    const sent = [];
    el._wave = null; // routeToWave forwards 'mute' to the worker: capture it there
    el._worker = { postMessage: (m) => sent.push(m) };
    el._manualMutedNets = new Set(['kick']);
    handleWsMessage(el, { type: 'mute-state', mutedNets: { kick: false }, mutedNotes: {}, source: 'engine' });
    assert.deepEqual(sent, [{ type: 'mute', netId: 'kick', muted: true }]);
});

test('without an engine report the worker mute-state is taken whole (WS / pre-play)', () => {
    const el = stubEl();
    handleWsMessage(el, { type: 'mute-state', mutedNets: { a: true }, mutedNotes: {} });
    handleWsMessage(el, { type: 'mute-state', mutedNets: { b: true }, mutedNotes: {} });
    assert.deepEqual(set(el._mutedNets), ['b']);
});

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nwave-tick feed: all pass');
