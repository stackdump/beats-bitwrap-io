#!/usr/bin/env node
//
// test-djrust-page-macros.mjs — the page side of djwasm 0.3.0 "net clock" (studio plan step 3:
// R-1a page side, R-2 pools + busy check, R-9 seek routing, R-8 groove routing).
//
//   node scripts/test-djrust-page-macros.mjs            # pinned public/djrust/djwasm.wasm
//   DJRUST_WASM=<pkg dir or .wasm> node scripts/test-djrust-page-macros.mjs
//
// Real lib/backend/{wave,index}.js, lib/macros/{runtime,catalog}.js and lib/ui/engine-gaps.js,
// a stub element, no browser. The wasm sections drive the real worklet.js + djwasm.wasm in Node
// (the AudioWorklet globals shimmed), page → worklet → engine → page:
//
//   - the catalog's engine table is the module's own (djw_keys), and a 0.2.0 module runs none;
//   - engine-gaps hides exactly the macros a feature mask cannot run (0 → every macro hidden as
//     before, the 0.3.0 mask → only the non-net macros, every kind → only the hit pads);
//   - no double fire: a macro the engine runs is posted once and never also sent to the worker;
//     a control net's fire-macro is run by the engine and the page sends nothing for it;
//   - macrosDisabled is honoured: the disabled list reaches the engine (start and every change),
//     a disabled control-net macro is skipped in the engine, Auto-DJ never picks one;
//   - Auto-DJ: only what the engine runs, and busy while the engine's macroMask is set;
//   - seek: playing → the engine seeks (the worker does not); stopped → the worker, and the next
//     Play seeks the engine to the playhead first;
//   - groove is not sent without an explicit override (a share at its genre default, or no share,
//     sends nothing and makes the engine without FLAG.GROOVE); an offline bake never takes a
//     share's groove, only a session move or an explicit render option;
//   - the Beats pads (hit1-hit4) are page work on every engine and are never sent to the engine;
//   - Auto-DJ draws only from pools engine-gaps shows (the Transition pool needs at least half of
//     its spread runnable, so 0.3.0 does not turn it into "tape-stop at every change"), and never
//     runs on a render page (the farm), where a share's groove is not taken either;
//   - a stop or Panic while the engine holds a macro puts the page's mutes and tempo back (the
//     stopped engine posts no tick to say so), and a running macro's mutes never reach
//     el._project.initialMutes (the share collector reads it).
//
// A missing pinned module skips the wasm sections only (exit 0); one named by DJRUST_WASM that is
// not there fails (exit 2), as in the other djrust gates.

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolveModule, missingModule } from './djrust-golden.mjs';
import {
    onWaveMessage, routeToWave, waveLoadProject, primeEngine, engineCreateOptions, setEngineFeatures,
    setShareGroove, grooveOverride,
} from '../public/lib/backend/wave.js';
import { handleWsMessage, sendWs } from '../public/lib/backend/index.js';
import {
    fireMacro, executeMacro, autoDjFireMacros, autoDjTick, pickTransitionMacroId, toggleMacroDisabled, macroBusy,
    fireRepeatingOneShots, panicMacros,
} from '../public/lib/macros/runtime.js';
import { cancelAllMacros } from '../public/lib/macros/effects.js';
import { MACROS, ENGINE_MACRO_KIND, engineRunsMacro, autoDjPoolLive } from '../public/lib/macros/catalog.js';
import { offlineEngineOptions } from '../public/lib/share/offline-render.js';
import { gapSelectors, applyEngineGaps, engineGap, setEngineFeatures as drawGaps } from '../public/lib/ui/engine-gaps.js';

const NET = 2, CONTROL = 4, GROOVE = 8, SEEK = 1;
const V030 = 63; // SEEK|NET_MACROS|CONTROL_MACROS|GROOVE|FRAME_CLOCK|EVENTS: what 0.3.0 reports
const NET_IDS = Object.entries(ENGINE_MACRO_KIND).filter(([, k]) => k === 'net').map(([id]) => id);

// Page globals the macro runtime touches (Auto-DJ's ring spin); the one-time
// "[engine] … not available" notes are expected here and silenced.
globalThis.requestAnimationFrame ||= () => 0;
console.info = () => {};

let failures = 0, skipped = 0;
async function test(name, fn) {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failures++; console.log(`FAIL ${name}\n     ${err.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}
const flush = () => new Promise((r) => setTimeout(r, 0));

// --- a stub element --------------------------------------------------------------------------

function stubEl({ features = V030, playing = true, pools = ['Mute', 'Tempo', 'FX', 'Transition'] } = {}) {
    const wave = [], worker = [], handled = [];
    const fakeNode = (props) => ({ classList: { add() {}, remove() {}, toggle() {} }, ...props });
    const el = {
        _tick: 0, _playing: playing, _tempo: 128, _engineFeatures: 0,
        _project: { nets: {
            kick: { track: { channel: 10 } }, bass: { track: { channel: 2 } }, lead: { track: { channel: 3 } },
            'macro-curve': { role: 'control' },
        } },
        _mutedNets: new Set(), _manualMutedNets: new Set(), _disabledMacros: new Set(),
        _activeNetId: 'bass', _nodes: {}, _structure: null,
        _currentGen: { genre: 'techno', params: { seed: 42 } },
        _genreData: { techno: { bpm: 128, swing: 0, humanize: 10 }, house: { bpm: 124, swing: 20, humanize: 15 } },
        _msPerBar: () => 4 * 60000 / 128,
        _macroPulse() {}, _musicNets() { return Object.entries(el._project.nets).filter(([, n]) => n.role !== 'control'); },
        _autoDjTick() {}, _fireRepeatingOneShots() {}, _renderMixer() {}, _renderMidiPanel() {},
        _updatePlayhead() {}, _draw() {},
        _fireMacro(id, opts) { return fireMacro(el, id, opts); },
        _worker: { postMessage: (m) => worker.push(m) },
        querySelector(sel) {
            if (sel === '.pn-autodj-stack') return { value: '1' };
            if (sel === '.pn-autodj-enable') return { checked: true };
            if (sel === '.pn-tempo input') return el._bpmInput;
            return null;
        },
        querySelectorAll(sel) {
            if (sel === '.pn-autodj-pool:checked') return pools.map((value) => ({ value }));
            return [];
        },
        _bpmInput: fakeNode({ value: '128' }),
        wave, worker, handled,
    };
    el._sendWs = (m) => sendWs(el, m);
    el._handleWsMessage = (m) => { handled.push(m); if (m.type === 'control-fired' || m.type === 'mute-state') handleWsMessage(el, m); };
    el._wave = Promise.resolve({ post: (m) => wave.push(m) });
    setEngineFeatures(el, features);
    return el;
}
const ofType = (list, type) => list.filter((m) => m.type === type);

// --- the module (optional) -------------------------------------------------------------------

const mod = await resolveModule();
if (!mod) {
    const code = missingModule('test-djrust-page-macros', undefined, true);
    if (code) process.exit(code);
}

// --- catalog + engine-gaps -------------------------------------------------------------------

await test('catalog: the engine table is the module\'s own (djw_keys), and features are read from it', async () => {
    if (!mod) { skipped++; return; }
    const dj = await mod.loader.instantiate(mod.module);
    const keys = dj.keys();
    assert.ok(keys, 'the pinned module has djw_keys (djwasm 0.3.0+)');
    const ours = {};
    for (const [id, k] of Object.entries(ENGINE_MACRO_KIND)) (ours[k] ||= []).push(id);
    for (const kind of ['net', 'master', 'aux', 'hit']) {
        assert.deepEqual([...ours[kind]].sort(), [...keys.macros[kind]].sort(), `kind ${kind}`);
    }
    // Every catalog macro is classified; nothing the engine names is missing.
    assert.deepEqual(MACROS.map((m) => m.id).filter((id) => !ENGINE_MACRO_KIND[id]), []);
    assert.equal(dj.features & NET, NET, 'pinned module runs net macros');
    for (const id of NET_IDS) assert.ok(engineRunsMacro(id, dj.features), id);
});

await test('catalog: a 0.2.0 module (no djw_features) runs no macro', async () => {
    const ref = process.env.DJRUST_REF || 'djrust-ref';
    const { existsSync, readFileSync } = await import('node:fs');
    const path = new URL(`../.djrust-ref/djwasm@0.2.0/djwasm.wasm`, import.meta.url);
    if (!mod || !existsSync(path)) { skipped++; console.log(`     (skipped: no 0.2.0 reference; make ${ref})`); return; }
    const dj = await mod.loader.instantiate(readFileSync(path));
    assert.equal(dj.features, 0);
    assert.equal(MACROS.filter((m) => engineRunsMacro(m.id, dj.features)).length, 0);
});

// The stylesheet engine-gaps.js wrote before it was feature-driven (the 0.2.0 studio).
const OLD_HIDE = ['.pn-macros-btn', '.pn-macros-panel', '.pn-macro-panic', '.pn-autodj-btn', '.pn-autodj-panel',
    '.pn-effects-panel .pn-fx-group:not(:first-child)', '.pn-fx-bypass', '.pn-fx-reset', '.pn-mixer-slider-group',
    '.pn-mixer-test', '.pn-mixer-save', '.pn-mixer-tone-reset', '.pn-mixer-tone-prev', '.pn-mixer-tone-next', '.pn-mixer-rotate'];
const OLD_CSS = `petri-note :is(${OLD_HIDE.join(', ')}) { display: none !important; }\n` +
    'petri-note :is(.pn-mixer-instrument) { pointer-events: none; opacity: 0.6; }\n';

function fakeDoc() {
    const nodes = new Map();
    const head = { appendChild(n) { nodes.set(n.id, n); } };
    return { head, getElementById: (id) => nodes.get(id) || null, createElement: () => ({ id: '', textContent: '' }) };
}

await test('engine-gaps: mask 0 (djwasm 0.2.0) hides every macro and Auto-DJ, the same stylesheet as before', () => {
    const g = gapSelectors(0);
    assert.deepEqual(g.hide, OLD_HIDE);
    assert.deepEqual(g.hiddenMacros, []);
    const doc = fakeDoc();
    applyEngineGaps(doc, 0);
    assert.equal(doc.getElementById('pn-engine-gaps-style').textContent, OLD_CSS);
    for (const m of MACROS) {
        // The hit pads are page work (stinger mutes): never a gap.
        if (m.kind === 'one-shot') assert.ok(!engineGap(`macro:${m.id}`, 0), m.id);
        else assert.ok(engineGap(`macro:${m.id}`, 0), m.id);
    }
    assert.ok(engineGap('macros', 0) && engineGap('auto-dj', 0));
});

await test('engine-gaps: the 0.3.0 mask shows the net macros and Auto-DJ, hides exactly the rest', () => {
    const g = gapSelectors(V030);
    for (const sel of ['.pn-macros-btn', '.pn-macros-panel', '.pn-macro-panic', '.pn-autodj-btn', '.pn-autodj-panel']) {
        assert.ok(!g.hide.includes(sel), `${sel} shown`);
    }
    const panel = MACROS.filter((m) => m.kind !== 'one-shot').map((m) => m.id);
    assert.deepEqual([...g.hiddenMacros].sort(), panel.filter((id) => !NET_IDS.includes(id)).sort());
    // Each hidden macro (or its whole group) has a selector; no net macro does.
    for (const id of NET_IDS) assert.ok(!g.hide.some((s) => s.includes(`"${id}"`)), `${id} not hidden`);
    // Transition: 0.3.0 runs 1 of its 9 (tape-stop), so it is not offered.
    for (const pool of ['FX', 'Pan', 'Shape', 'Pitch', 'Feel', 'Transition']) {
        assert.ok(g.hide.some((s) => s.includes(`value="${pool}"`)), `pool ${pool} hidden`);
        assert.ok(!autoDjPoolLive(pool, V030), `pool ${pool} not drawn from`);
    }
    for (const pool of ['Mute', 'Tempo', 'Beats']) {
        assert.ok(!g.hide.some((s) => s.includes(`value="${pool}"`)), `pool ${pool} shown`);
        assert.ok(autoDjPoolLive(pool, V030), `pool ${pool} drawn from`);
    }
    // The non-macro gaps stay until their own wiring lands.
    for (const sel of OLD_HIDE.slice(5)) assert.ok(g.hide.includes(sel), sel);
    assert.ok(!engineGap('macros', V030) && !engineGap('auto-dj', V030));
    assert.ok(!engineGap('macro:cut', V030) && engineGap('macro:sweep-lp', V030) && !engineGap('macro:hit1', V030));
});

await test('engine-gaps: feature-detected, not version-pinned (every macro kind → no macro or pool hidden)', () => {
    const all = NET | 128 | 256;
    assert.deepEqual(gapSelectors(all).hiddenMacros, []);
    assert.ok(!gapSelectors(all).hide.some((s) => s.includes('pn-autodj-pool')), 'every Auto-DJ pool shown');
    assert.ok(autoDjPoolLive('Transition', all) && autoDjPoolLive('Beats', all));
    // Master / aux without net: the Mute and Tempo groups go, the rest show.
    const g = gapSelectors(128 | 256);
    assert.deepEqual([...g.hiddenMacros].sort(), [...NET_IDS].sort());
    // A redraw replaces the stylesheet in place.
    const doc = fakeDoc();
    applyEngineGaps(doc, 0);
    drawGaps(V030, doc);
    const css = doc.getElementById('pn-engine-gaps-style').textContent;
    assert.ok(!css.includes('.pn-macros-btn') && css.includes('data-macro="sweep-lp"'));
    drawGaps(0, doc);
    assert.equal(doc.getElementById('pn-engine-gaps-style').textContent, OLD_CSS);
});

// --- no double fire --------------------------------------------------------------------------

await test('page fire: an engine macro is one fire-macro to the engine, nothing to the worker', async () => {
    const el = stubEl();
    fireMacro(el, 'drop');
    await flush();
    assert.deepEqual(ofType(el.wave, 'fire-macro'), [{ type: 'fire-macro', id: 'drop', duration: 1 }]);
    assert.equal(ofType(el.worker, 'fire-macro').length, 0);
    assert.equal(el._runningMacro, 'drop');
    // The engine lets go (restore event): the slot frees, the queued one fires, once.
    fireMacro(el, 'cut', { duration: 4 });
    assert.deepEqual(el._macroQueue, [{ id: 'cut', opts: { duration: 4 } }]);
    onWaveMessage(el, { type: 'macro-restored', id: 'drop', source: 'engine', result: 0 });
    await flush();
    assert.deepEqual(ofType(el.wave, 'fire-macro').map((m) => [m.id, m.duration]), [['drop', 1], ['cut', 4]]);
    assert.equal(el._runningMacro, 'cut');
    // A fire that changes nothing never restores: three ticks with an empty mask free it.
    for (let t = 1; t <= 3; t++) onWaveMessage(el, { type: 'wave-tick', tick: t, fired: [], controls: [], macroMask: 0 });
    assert.equal(el._runningMacro, null);
});

await test('page fire: djwasm 0.2.0 (mask 0) sends nothing anywhere, as before', async () => {
    const el = stubEl({ features: 0 });
    fireMacro(el, 'drop'); executeMacro(el, 'half-time'); autoDjFireMacros(el);
    await flush();
    assert.equal(el.wave.length + el.worker.length, 0);
    assert.equal(el._runningMacro ?? null, null);
});

await test('page fire: a macro the engine does not run (sweep-lp) is inert', async () => {
    const el = stubEl();
    fireMacro(el, 'sweep-lp');
    await flush();
    assert.equal(el.wave.length + el.worker.length, 0);
});

/** A stub with a muted stinger net hit1 (the Beats pads' target) and a Repeat box on it. */
function stingerEl(opts) {
    const el = stubEl(opts);
    el._project.nets.hit1 = { track: { channel: 11, instrument: 'stab', group: 'stinger' } };
    el._mutedNets = new Set(['hit1']);
    const toggled = [];
    el._toggleMute = (id) => {
        toggled.push(id);
        const muted = !el._mutedNets.has(id);
        if (muted) el._mutedNets.add(id); else el._mutedNets.delete(id);
        el._sendWs({ type: 'mute', netId: id, muted });
    };
    el._showOneShots = true;
    const qsa = el.querySelectorAll.bind(el);
    el.querySelectorAll = (sel) => sel === '.pn-os-repeat:checked' ? [{ dataset: { macro: 'hit1' } }] : qsa(sel);
    el.toggled = toggled;
    return el;
}

await test('Beats pads: a Fire pad is page work on every engine (stinger unmute), never an engine fire', async () => {
    for (const features of [V030, 0]) {
        const el = stingerEl({ features });
        fireMacro(el, 'hit1');
        await flush();
        assert.deepEqual(el.toggled, ['hit1'], `features ${features}: the pad unmuted its stinger`);
        assert.deepEqual(ofType(el.wave, 'mute'), [{ type: 'mute', netId: 'hit1', muted: false }]);
        assert.equal(ofType(el.wave, 'fire-macro').length, 0, 'the engine is never asked to fire a pad');
        // The repeating pads (R-2, fed by wave-ticks) fire on each beat.
        const rep = stingerEl({ features });
        fireRepeatingOneShots(rep, 3, 4);
        assert.deepEqual(rep.toggled, ['hit1'], `features ${features}: a repeat fired the pad`);
    }
});

await test('page fire: permanent (∞) stays page-side as plain mutes, no engine fire', async () => {
    const el = stubEl();
    executeMacro(el, 'drop', { duration: 0, bypassQueue: true });
    await flush();
    assert.equal(ofType(el.wave, 'fire-macro').length, 0);
    assert.deepEqual(ofType(el.wave, 'mute').map((m) => m.netId).sort(), ['bass', 'lead']);
    assert.deepEqual(ofType(el.worker, 'mute').map((m) => m.netId).sort(), ['bass', 'lead']);
});

await test('control net: the engine runs the fire-macro, the page sends nothing and only shows it', async () => {
    const el = stubEl();
    const ctl = (macro) => ({ type: 'wave-tick', tick: 16, fired: [], controls: [['macro-curve', 't0', { action: 'fire-macro', macro }]] });
    onWaveMessage(el, ctl('breakdown'));
    await flush();
    assert.equal(ofType(el.wave, 'fire-macro').length, 0, 'no page fire');
    assert.equal(ofType(el.worker, 'fire-macro').length, 0);
    onWaveMessage(el, { type: 'macro-fired', id: 'breakdown', source: 'control', result: 0 });
    assert.ok(el._engineHeld.has('breakdown'));
    assert.equal(el._runningMacro ?? null, null, 'a control fire bypasses the serial slot');
    // Busy for Auto-DJ while the engine holds it.
    onWaveMessage(el, { type: 'wave-tick', tick: 17, fired: [], controls: [], macroMask: 2 });
    assert.ok(macroBusy(el));
    onWaveMessage(el, { type: 'wave-tick', tick: 18, fired: [], controls: [], macroMask: 0 });
    assert.ok(!macroBusy(el) && el._engineHeld.size === 0);
    // On 0.2.0 the page still owns control fires (and they are inert there).
    const old = stubEl({ features: 0 });
    onWaveMessage(old, ctl('breakdown'));
    await flush();
    assert.equal(old.wave.length + old.worker.length, 0);
    // A module with net macros but not control dispatch: the page fires it, exactly once.
    const mid = stubEl({ features: NET });
    onWaveMessage(mid, ctl('breakdown'));
    await flush();
    assert.deepEqual(ofType(mid.wave, 'fire-macro').map((m) => m.id), ['breakdown']);
});

// --- macrosDisabled --------------------------------------------------------------------------

await test('macrosDisabled: the list reaches the engine at start and on every change', async () => {
    const el = stubEl();
    el._disabledMacros = new Set(['drop', 'cut']);
    el._waveProject = { nets: {} };
    const posts = [];
    primeEngine(el, { post: (m) => posts.push(m) });
    assert.deepEqual(ofType(posts, 'control-macros'), [{ type: 'control-macros', on: true, disabled: ['drop', 'cut'] }]);
    assert.equal(ofType(posts, 'groove').length, 0);
    toggleMacroDisabled(el, 'breakdown');
    await flush();
    assert.deepEqual(ofType(el.wave, 'control-macros').at(-1).disabled.sort(), ['breakdown', 'cut', 'drop']);
    // 0.2.0: nothing to tell.
    const old = stubEl({ features: 0 });
    const oldPosts = [];
    primeEngine(old, { post: (m) => oldPosts.push(m) });
    assert.equal(ofType(oldPosts, 'control-macros').length, 0);
});

await test('Auto-DJ: picks only engine-run, enabled macros; skips while the engine holds one', async () => {
    const el = stubEl({ pools: ['Mute', 'FX', 'Pan', 'Tempo', 'Transition'] });
    el._disabledMacros = new Set(['drop', 'half-time']);
    const picked = new Set();
    for (let i = 0; i < 400; i++) {
        el.wave.length = 0;
        el._runningMacro = null; el._runningEngine = null; el._macroQueue = []; el._engineMacroMask = 0;
        autoDjFireMacros(el);
        await flush();
        for (const m of ofType(el.wave, 'fire-macro')) picked.add(m.id);
    }
    for (const id of picked) {
        assert.ok(NET_IDS.includes(id), `${id} is a net macro`);
        assert.ok(!el._disabledMacros.has(id), `${id} not disabled`);
    }
    assert.ok(picked.has('breakdown') && picked.has('tape-stop'), [...picked].join(','));
    el.wave.length = 0; el._engineMacroMask = 8;
    autoDjFireMacros(el);
    await flush();
    assert.equal(el.wave.length, 0, 'busy: macroMask set');
    // The Transition pool is not drawn from on 0.3.0 (1 of 9 runnable): no transition net at a
    // regen, and a Transition-only Auto-DJ has no candidates, rather than tape-stop every time.
    for (let i = 0; i < 50; i++) assert.equal(pickTransitionMacroId(el), null);
    const tOnly = stubEl({ pools: ['Transition'] });
    for (let i = 0; i < 50; i++) { tOnly._runningMacro = null; tOnly._runningEngine = null; autoDjFireMacros(tOnly); }
    await flush();
    assert.equal(ofType(tOnly.wave, 'fire-macro').length, 0, 'Transition alone fires nothing on 0.3.0');
    // An engine that runs the spread draws from all of it.
    const full = stubEl({ features: V030 | 128 | 256, pools: ['Transition'] });
    const ids = new Set();
    for (let i = 0; i < 400; i++) ids.add(pickTransitionMacroId(full));
    assert.ok(ids.size > 3 && ids.has('tape-stop') && ids.has('riser'), [...ids].join(','));
});

await test('Auto-DJ: never runs on a render page (the farm), not even a regen; runs on a studio page', async () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'location');
    const run = (search) => {
        Object.defineProperty(globalThis, 'location', { value: { search }, configurable: true, writable: true });
        const el = stubEl({ pools: ['Mute', 'Tempo'] });
        const q = el.querySelector.bind(el);
        el.querySelector = (sel) => sel === '.pn-autodj-regen' ? { value: '32' } : sel === '.pn-autodj-rate' ? { value: '2' } : q(sel);
        el._previewReqId = 0;
        // Cross the 2-bar cadence and the 32-bar regen boundary (and its prefetch).
        autoDjTick(el, 32 * 16 - 20, 32 * 16 + 2);
        return el;
    };
    try {
        for (const search of ['?render=1&cid=x', '?render=offline&maxMs=2000']) {
            const el = run(search);
            await flush();
            assert.deepEqual([...el.wave, ...el.worker].map((m) => m.type).filter((t) => t !== 'mute'), [], search);
        }
        const live = run('?cid=x');
        await flush();
        const types = [...live.wave, ...live.worker].map((m) => m.type);
        assert.ok(types.includes('generate-preview') || types.includes('fire-macro'), `studio page: ${types}`);
    } finally {
        if (saved) Object.defineProperty(globalThis, 'location', saved); else delete globalThis.location;
    }
});

// --- seek, tempo -----------------------------------------------------------------------------

await test('seek: playing → the engine (not the worker); stopped → the worker, then Play seeks first', async () => {
    const el = stubEl({ playing: true });
    sendWs(el, { type: 'seek', tick: 300 });
    await flush();
    assert.deepEqual(ofType(el.wave, 'seek'), [{ type: 'seek', tick: 300 }]);
    assert.equal(ofType(el.worker, 'seek').length, 0);
    const st = stubEl({ playing: false });
    sendWs(st, { type: 'seek', tick: 200 });
    st._tick = 200;
    sendWs(st, { type: 'transport', action: 'play' });
    await flush();
    assert.deepEqual(ofType(st.worker, 'seek'), [{ type: 'seek', tick: 200 }]);
    assert.deepEqual(st.wave.map((m) => m.type), ['seek', 'transport']);
    // From 0 nothing extra is sent: the default Play is untouched.
    const z = stubEl({ playing: false });
    sendWs(z, { type: 'transport', action: 'play' });
    await flush();
    assert.deepEqual(z.wave.map((m) => m.type), ['transport']);
    // 0.2.0: the worker seeks, the engine is never asked.
    const old = stubEl({ features: 0, playing: true });
    sendWs(old, { type: 'seek', tick: 300 });
    old._tick = 300;
    await flush();
    assert.equal(ofType(old.wave, 'seek').length, 0);
    assert.equal(ofType(old.worker, 'seek').length, 1);
    // The seek's state tick is a new baseline, not a step for Auto-DJ.
    let steps = 0;
    el._autoDjTick = () => { steps++; };
    onWaveMessage(el, { type: 'wave-tick', tick: 10, fired: [], controls: [] });
    onWaveMessage(el, { type: 'wave-tick', tick: 300, fired: [], controls: [], seek: true, state: {} });
    onWaveMessage(el, { type: 'wave-tick', tick: 301, fired: [], controls: [] });
    assert.equal(steps, 1);
});

await test('tempo: the engine\'s tempo (a tempo macro) is shown, never posted back', async () => {
    const el = stubEl();
    onWaveMessage(el, { type: 'wave-tick', tick: 3, fired: [], controls: [], macroMask: 64, tempo: 64 });
    await flush();
    assert.equal(el._tempo, 64);
    assert.equal(el._bpmInput.value, 64);
    assert.equal(ofType(el.wave, 'tempo').length + ofType(el.worker, 'tempo').length, 0);
});

// --- stop / Panic while the engine holds a macro ----------------------------------------------

/** A playing stub whose worker reports {kick: muted? no} + hit1, then the engine runs `id`. */
function heldEl(id, tickMsg) {
    const el = stubEl();
    el._project.nets.hit1 = { track: { channel: 11 } };
    el._project.tempo = 128;
    el._togglePlayStub = true;
    // The worker's view (it never plays): the project's initial mutes.
    handleWsMessage(el, { type: 'mute-state', mutedNets: { hit1: true }, mutedNotes: {} });
    el._manualMutedNets = new Set(['lead']);
    fireMacro(el, id);
    onWaveMessage(el, { type: 'wave-tick', tick: 5, fired: [], controls: [], ...tickMsg });
    return el;
}

await test('stop mid engine mute macro: the page takes back the worker\'s + manual mutes; Panic keeps nothing of the macro', async () => {
    const el = heldEl('breakdown', { macroMask: 2, mutedNets: { kick: true, hit1: true, lead: true } });
    assert.deepEqual([...el._mutedNets].sort(), ['hit1', 'kick', 'lead'], 'while it runs the engine\'s set is shown');
    assert.ok(!el._project.initialMutes || !el._project.initialMutes.includes('kick'),
        'a running macro\'s mute is not mirrored into initialMutes (the share collector reads it)');
    // Stop: the transport-stop path (backend/index.js togglePlay → _cancelAllMacros, then transport stop).
    el._playing = false;
    cancelAllMacros(el);
    sendWs(el, { type: 'transport', action: 'stop' });
    await flush();
    assert.deepEqual(ofType(el.wave, 'panic').length, 1);
    assert.deepEqual([...el._mutedNets].sort(), ['hit1', 'lead'], 'the macro\'s mute is gone once stopped');
    assert.deepEqual([...el._project.initialMutes].sort(), ['hit1', 'lead']);
    // Panic while stopped changes nothing further and keeps the project / manual mutes.
    panicMacros(el);
    await flush();
    assert.deepEqual([...el._mutedNets].sort(), ['hit1', 'lead']);
    // No engine macro held: a stop leaves the engine-reported mutes alone (no settle).
    const plain = stubEl();
    onWaveMessage(plain, { type: 'wave-tick', tick: 5, fired: [], controls: [], macroMask: 0, mutedNets: { kick: true } });
    plain._playing = false;
    cancelAllMacros(plain);
    assert.deepEqual([...plain._mutedNets], ['kick']);
});

await test('stop mid engine tempo macro: tempo and BPM box go back to the project tempo; a nudge commits from there', async () => {
    const el = heldEl('half-time', { macroMask: 64, tempo: 64 });
    assert.equal(el._tempo, 64);
    el._playing = false;
    cancelAllMacros(el);
    sendWs(el, { type: 'transport', action: 'stop' });
    await flush();
    assert.equal(el._tempo, 128);
    assert.equal(el._bpmInput.value, 128);
    // The `.` key: el._setTempo(el._tempo + 1) (backend/index.js setTempo).
    const { setTempo } = await import('../public/lib/backend/index.js');
    el._syncProject = () => {};
    el.querySelector = ((q) => (sel) => sel === '.pn-tempo input' ? el._bpmInput : q(sel))(el.querySelector);
    setTempo(el, el._tempo + 1);
    assert.equal(el._project.tempo, 129);
    // The engine's own report of its restore (engine-tempo, no wave-tick while stopped) is followed.
    const ev = heldEl('half-time', { macroMask: 64, tempo: 64 });
    ev._playing = false;
    onWaveMessage(ev, { type: 'engine-tempo', bpm: 128, frame: 0, tick: 5 });
    assert.equal(ev._tempo, 128);
    assert.equal(ofType(ev.wave, 'tempo').length + ofType(ev.worker, 'tempo').length, 0, 'never posted back');
});

// --- groove ----------------------------------------------------------------------------------

await test('groove (offline): a bake never takes a share\'s groove; a session move or an explicit option does', () => {
    const el = stubEl();
    el._wave = null;
    el._currentGen = { genre: 'house', params: { seed: 3 } };
    el._pendingShareOverrides = { tempo: 124, swing: 0, humanize: 10 }; // house is 20/15: off it
    waveLoadProject(el, { nets: {} });
    assert.equal(el._grooveOverride?.source, 'share', 'the live engine takes it');
    // The farm's call (render-mode.js): renderToBlobOffline(el, { maxMs }).
    assert.deepEqual(offlineEngineOptions(el, { maxMs: 60000 }), {}, 'the farm bake is the 0.2.0 call');
    assert.deepEqual(offlineEngineOptions(el, { groove: { swing: 30, humanize: 20 } }), { flags: 1, swing: 30, humanize: 20 });
    el._grooveOverride = { swing: 40, humanize: 5, source: 'session' };
    assert.deepEqual(offlineEngineOptions(el, {}), { flags: 1, swing: 40, humanize: 5 });
});

await test('groove (render page): the farm\'s realtime capture makes the engine without a share\'s groove', () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'location');
    try {
        Object.defineProperty(globalThis, 'location', { value: { search: '?cid=x&render=1' }, configurable: true, writable: true });
        const el = stubEl();
        el._wave = null;
        el._currentGen = { genre: 'house', params: { seed: 3 } };
        el._pendingShareOverrides = { swing: 0, humanize: 10 };
        waveLoadProject(el, { nets: {} });
        assert.equal(engineCreateOptions(el), undefined);
    } finally {
        if (saved) Object.defineProperty(globalThis, 'location', saved); else delete globalThis.location;
    }
});


await test('groove: not sent without an explicit override', async () => {
    assert.equal(grooveOverride(null, { swing: 0, humanize: 10 }), null);
    assert.equal(grooveOverride({ swing: 0, humanize: 10 }, { swing: 0, humanize: 10 }), null, 'at the genre default');
    assert.equal(grooveOverride({ humanize: 10 }, { swing: 0, humanize: 10 }), null);
    assert.equal(grooveOverride({ tempo: 140 }, { swing: 0, humanize: 10 }), null);
    assert.deepEqual(grooveOverride({ swing: 30, humanize: 10 }, { swing: 0, humanize: 10 }), { swing: 30, humanize: 10 });

    const el = stubEl();
    el._wave = null; // before the first Play
    assert.equal(engineCreateOptions(el), undefined, 'no share: the 0.2.0 construction');
    setShareGroove(el, { swing: 0, humanize: 10, tempo: 128 }); // a techno share at its defaults
    assert.equal(engineCreateOptions(el), undefined, 'a share at the genre default: nothing');
    const posts = [];
    primeEngine(el, { post: (m) => posts.push(m) });
    assert.equal(ofType(posts, 'groove').length, 0);

    setShareGroove(el, { swing: 30, humanize: 20 });
    assert.deepEqual(engineCreateOptions(el), { flags: 1, swing: 30, humanize: 20 });
    // Another track drops a share's override.
    el._currentGen = { genre: 'techno', params: { seed: 7 } };
    assert.equal(engineCreateOptions(el), undefined);
    // A module without GROOVE never gets the flag.
    const old = stubEl({ features: 0 });
    old._wave = null;
    setShareGroove(old, { swing: 30, humanize: 20 });
    assert.equal(engineCreateOptions(old), undefined);
});

await test('groove: a running GROOVE engine gets the override, and neutral 0/0 when a new track drops it', async () => {
    const el = stubEl();
    el._waveFlags = 1; // made with FLAG.GROOVE
    setShareGroove(el, { swing: 30, humanize: 20 });
    await flush();
    assert.deepEqual(ofType(el.wave, 'groove'), [{ type: 'groove', swing: 30, humanize: 20 }]);
    el._currentGen = { genre: 'house', params: { seed: 1 } };
    waveLoadProject(el, { nets: {} });
    await flush();
    assert.deepEqual(ofType(el.wave, 'groove').at(-1), { type: 'groove', swing: 0, humanize: 0 });
    // A plain engine (no flag) and no override: a project load sends no groove.
    const plain = stubEl();
    waveLoadProject(plain, { nets: {} });
    setShareGroove(plain, { swing: 0, humanize: 10 });
    await flush();
    assert.equal(ofType(plain.wave, 'groove').length, 0);
});

await test('groove: a loading share is routed from its pending overrides (lib/share/ untouched)', async () => {
    // At its genre default (every share carries swing / humanize): nothing.
    const el = stubEl();
    el._wave = null;
    el._pendingShareOverrides = { tempo: 128, swing: 0, humanize: 10, macrosDisabled: ['cut'] };
    waveLoadProject(el, { nets: {} });
    assert.equal(el._grooveOverride ?? null, null);
    assert.equal(engineCreateOptions(el), undefined);
    // Off it: the engine is made with FLAG.GROOVE and the share's values.
    const sw = stubEl();
    sw._wave = null;
    sw._currentGen = { genre: 'house', params: { seed: 3 } };
    sw._pendingShareOverrides = { swing: 0, humanize: 10 };
    waveLoadProject(sw, { nets: {} });
    assert.deepEqual(engineCreateOptions(sw), { flags: 1, swing: 0, humanize: 10 });
    // The same track re-loaded (an arrange overlay) keeps it; a regenerate drops it.
    sw._pendingShareOverrides = null;
    waveLoadProject(sw, { nets: {} });
    assert.deepEqual(engineCreateOptions(sw), { flags: 1, swing: 0, humanize: 10 });
    sw._currentGen = { genre: 'house', params: { seed: 4 } };
    waveLoadProject(sw, { nets: {} });
    assert.equal(engineCreateOptions(sw), undefined);
    // A genre the table does not know (a hand-authored share): measured against the project's
    // own values, which are the payload's, so a hand-authored swing is not an override.
    const ha = stubEl();
    ha._wave = null;
    ha._currentGen = { genre: 'wrapped', params: {} };
    ha._pendingShareOverrides = { swing: 40, humanize: 30 };
    waveLoadProject(ha, { swing: 40, humanize: 30, nets: {} });
    assert.equal(engineCreateOptions(ha), undefined);
});

// --- end to end: page → worklet.js → djwasm → page --------------------------------------------

let workletCls = null;
async function workletClass(path) {
    if (workletCls) return workletCls;
    let reg = null;
    globalThis.AudioWorkletProcessor = class {
        constructor() { this.port = { onmessage: null, _posted: [], postMessage(m) { this._posted.push(m); } }; }
    };
    globalThis.registerProcessor = (name, cls) => { reg = cls; };
    await import(pathToFileURL(path).href + '?page-macros');
    delete globalThis.registerProcessor;
    workletCls = reg;
    return reg;
}

// A composed track plus a control net that fires `cut` at tick 0 and `drop` at tick 40.
function controlProject(dj) {
    const doc = dj.compose({ genre: 'techno', seed: 42 }).doc;
    const places = { p0: { initial: [1] } }, transitions = {}, arcs = [];
    for (let i = 0; i <= 40; i++) {
        places[`p${i + 1}`] = {};
        transitions[`t${i}`] = i === 0 ? { control: { action: 'fire-macro', macro: 'cut', macroBars: 2 } }
            : i === 40 ? { control: { action: 'fire-macro', macro: 'drop', macroBars: 1 } } : {};
        arcs.push({ source: `p${i}`, target: `t${i}` }, { source: `t${i}`, target: `p${i + 1}` });
    }
    doc.nets['macro-curve'] = { role: 'control', track: { channel: 1 }, places, transitions, arcs };
    return doc;
}

async function runE2E({ disabled = [], pageFires = [] } = {}) {
    const Proc = await workletClass(mod.workletPath);
    const dj = await mod.loader.instantiate(mod.module);
    const project = controlProject(dj);
    globalThis.sampleRate = 48000; globalThis.currentTime = 0;
    try {
        const proc = new Proc({ processorOptions: { module: mod.module } });
        const ready = proc.port._posted.find((m) => m.type === 'ready');
        const el = stubEl({ features: ready.features });
        el._disabledMacros = new Set(disabled);
        el._waveProject = project;
        el._tempo = project.tempo || 128;
        const wave = { post: (m) => { el.wave.push(m); proc.port.onmessage({ data: m }); } };
        el._wave = Promise.resolve(wave);
        primeEngine(el, wave);
        wave.post({ type: 'transport', action: 'play' });
        const L = new Float32Array(128), R = new Float32Array(128);
        const engineMsgs = [], tempos = new Set();
        let seen = 0, q = 0, tick = 0;
        while (tick < 60 && q < 20000) {
            const due = pageFires.find((f) => f.tick === tick && !f.done);
            if (due) { due.done = true; fireMacro(el, due.id); await flush(); }
            globalThis.currentTime = q++ * 128 / 48000;
            proc.process([], [[L, R]]);
            const posted = proc.port._posted;
            for (; seen < posted.length; seen++) {
                engineMsgs.push(posted[seen]);
                onWaveMessage(el, posted[seen]);
                tempos.add(el._tempo);
                if (posted[seen].type === 'wave-tick') tick = posted[seen].tick;
            }
        }
        await flush();
        return { el, engineMsgs, ready, tempos };
    } finally { delete globalThis.sampleRate; delete globalThis.currentTime; }
}

await test('e2e: a control-net macro is fired once, by the engine; the page sends no fire for it', async () => {
    if (!mod) { skipped++; return; }
    const { el, engineMsgs, ready } = await runE2E();
    assert.equal(ready.features & CONTROL, CONTROL);
    const fired = ofType(engineMsgs, 'macro-fired');
    assert.deepEqual(fired.map((m) => [m.id, m.source, m.result]), [['cut', 'control', 0], ['drop', 'control', 0]]);
    assert.equal(ofType(el.wave, 'fire-macro').length, 0, 'the page fired nothing');
    assert.equal(ofType(el.worker, 'fire-macro').length, 0);
    assert.ok(ofType(el.handled, 'control-fired').length >= 2, 'the controls still reached the page (UI)');
});

await test('e2e: macrosDisabled — a disabled control-net macro is skipped in the engine', async () => {
    if (!mod) { skipped++; return; }
    const { engineMsgs } = await runE2E({ disabled: ['drop'] });
    assert.deepEqual(ofType(engineMsgs, 'macro-fired').map((m) => m.id), ['cut']);
    assert.deepEqual(ofType(engineMsgs, 'macro-skipped').map((m) => [m.id, m.source]), [['drop', 'control']]);
});

await test('e2e: a page fire is one engine fire with one macro-fired event, source page', async () => {
    if (!mod) { skipped++; return; }
    const { el, engineMsgs, tempos } = await runE2E({ disabled: ['cut', 'drop'], pageFires: [{ tick: 20, id: 'half-time' }] });
    assert.equal(ofType(el.wave, 'fire-macro').length, 1);
    assert.deepEqual(ofType(engineMsgs, 'macro-fired').map((m) => [m.id, m.source, m.result]), [['half-time', 'page', 0]]);
    // The engine halved the tempo for 2 bars and restored it; the page followed both ways
    // without posting either back.
    const base = el._waveProject.tempo || 128;
    assert.deepEqual([...tempos].sort((a, b) => a - b), [base / 2, base]);
    assert.deepEqual(ofType(engineMsgs, 'macro-restored').map((m) => m.id), ['half-time']);
    assert.equal(el._runningMacro, null, 'the restore freed the serial slot');
    assert.equal(el._tempo, base);
    assert.equal(ofType(el.wave, 'tempo').length, 1, 'only primeEngine\'s tempo');
});

console.log(failures ? `\npage macros: ${failures} FAILED` : `\npage macros: all pass${skipped ? ` (${skipped} skipped: no module)` : ''}`);
process.exit(failures ? 1 : 0);
