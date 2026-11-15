#!/usr/bin/env node
//
// test-djwasm-030.mjs — the beats-side gates for djwasm 0.3.0 "net clock" (plan step 2), run in
// Node against a candidate package before it is published or re-pinned.
//
//   DJRUST_WASM=../djrust-beats-studio/cabi/pkg node scripts/test-djwasm-030.mjs [--only RE] [--list]
//
// The package directory (or a .wasm inside one) gives both the module and its glue (loader.js,
// worklet.js). $DJRUST_GLUE overrides where the glue comes from. The served public/djrust/ files
// are never touched. The 0.2.0 reference is djwasm 0.2.0 itself from scripts/djrust-ref.mjs
// (.djrust-ref/djwasm@0.2.0/, git-ignored; `node scripts/djrust-ref.mjs fetch`), hash-checked: it
// was the pin until the 0.3.0 re-pin.
//
// Sections (each a set of ok/FAIL checks; exit 1 on any FAIL):
//   keys        djw_features / djw_keys equal the 0.3.0 export spec
//   compat      the new loader + worklet still drive djwasm 0.2.0 (the reference): golden bytes, every
//               new call a no-op / ERR_UNSUPPORTED, a stamped script lands on its quantum
//   hooks       worklet test hooks: script = q-stamped port messages = unstamped messages at the
//               quantum; at-stamps on the frame clock; tapHash = crypto sha256; assertQuantum
//   macros      every NetMacro fired from the page (default duration and 2 units) renders the
//               same bytes direct and through the worklet, moves the audio, and restores
//   control     the macroCurve arrangement with control macros on: worklet = direct; with every
//               id disabled = 0.2.0; = the page firing the reported ids at the reported quanta;
//               each control fire reported exactly once; master/aux ids come back -3
//   seek        seek while playing / while stopped: worklet = direct, deterministic, and the
//               marking equals the sequencer worker's fastForwardTo
//   groove      swing 30 / humanize 20 on a GROOVE instance: worklet = direct, moves notes,
//               deterministic; the values stick across a project swap
//   mechanism   sequencer-worker.js (postMessage shim) with the page's executeMacro transcribed
//               to ticks (restore nets) next to wasm fire_macro: per-tick mute sets and the tempo
//               stream for each NetMacro (see mechanismHarness below for what is compared)
//
// The macro / control / seek / groove scripts are exported (SCRIPTS_030, buildScript030) so
// test-djwasm-030-browser.mjs renders the same ones in Chrome for the tri-render.

import { readFileSync, existsSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { renderCase, composeProject, readGolden, ROOT, BLOCK } from './djrust-golden.mjs';
import { REF_DIR, REF_WASM, refStatus } from './djrust-ref.mjs';
import { buildScript as buildScript020 } from './djrust-script.mjs';
import { arrangeWithOpts } from '../public/lib/generator/arrange.js';
import { MACROS } from '../public/lib/macros/catalog.js';

const here = dirname(fileURLToPath(import.meta.url));
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const SR = 48000;

// The 0.3.0 export spec's key table, verbatim (plan step 2 Rust results, DJW_KEYS JSON).
export const SPEC_KEYS = {
    abi: 1,
    features: { SEEK: 1, NET_MACROS: 2, CONTROL_MACROS: 4, GROOVE: 8, FRAME_CLOCK: 16, EVENTS: 32, FX: 64, MASTER_MACROS: 128,
        AUX_MACROS: 256, VOICE: 512, STRIKE: 1024, INSTRUMENT: 2048, TRANSPOSE: 4096, LOOP: 8192, STINGER_VOICES: 16384, ROUTES: 32768 },
    build: 63,
    flags: { GROOVE: 1, STINGER_VOICES: 2 },
    errors: { ARG: -1, NOT_READY: -2, UNSUPPORTED: -3 },
    fx: ['hp-freq', 'lp-freq', 'phaser-freq', 'phaser-depth', 'phaser-wet', 'crush-bits', 'distortion', 'master-pitch',
        'reverb-size', 'reverb-damp', 'reverb-wet', 'delay-time', 'delay-feedback', 'delay-wet'],
    voice: ['gainDB', 'attack', 'decayScale', 'maxDecay', 'lowpass', 'distortion', 'vibratoRate', 'vibratoDepth', 'pitchFrom', 'pitchTo',
        'pitchTime', 'decayMul'],
    macros: {
        net: ['drop', 'breakdown', 'solo-drums', 'cut', 'double-drop', 'beat-repeat', 'half-time', 'tape-stop', 'tempo-anchor'],
        master: ['sweep-lp', 'sweep-hp', 'reverb-wash', 'riser', 'build-crush', 'phaser-drone', 'filter-res', 'octave-up', 'octave-down',
            'pitch-bend', 'vinyl-brake', 'feel-chill', 'feel-drive', 'feel-ambient', 'feel-euphoric', 'feel-build', 'feel-wind-down', 'feel-reset'],
        aux: ['ping-pong', 'hard-left', 'hard-right', 'auto-pan', 'mono', 'delay-throw', 'dub-delay', 'cathedral', 'tighten', 'loosen', 'pulse'],
        hit: ['hit1', 'hit2', 'hit3', 'hit4'],
    },
    maskBits: { net: 0, master: 16, aux: 40, hit: 60 },
    events: { kinds: ['fired', 'skipped', 'restored', 'tempo', 'overflow'], sources: ['page', 'control', 'engine'], capacity: 64 },
    controlCapacity: 16,
};
export const NET_MACROS = SPEC_KEYS.macros.net;

// --- the module and its glue -------------------------------------------------------------------

/** {wasmPath, glueDir, bytes, sha256, loader, module, workletPath} for a package dir or a .wasm. */
export async function loadPackage(arg = process.env.DJRUST_WASM, glue = process.env.DJRUST_GLUE) {
    if (!arg) return null;
    let p = resolve(arg), wasmPath = p, glueDir = null;
    if (existsSync(p) && statSync(p).isDirectory()) { wasmPath = join(p, 'djwasm.wasm'); glueDir = p; }
    else glueDir = dirname(p);
    if (glue) glueDir = resolve(glue);
    if (!existsSync(wasmPath) || !existsSync(join(glueDir, 'loader.js')) || !existsSync(join(glueDir, 'worklet.js'))) return null;
    return withGlue(wasmPath, glueDir);
}

export async function withGlue(wasmPath, glueDir) {
    const bytes = readFileSync(wasmPath);
    return {
        wasmPath, glueDir, bytes, sha256: sha256(bytes),
        loader: await import(pathToFileURL(join(glueDir, 'loader.js')).href),
        module: new WebAssembly.Module(bytes),
        workletPath: join(glueDir, 'worklet.js'),
    };
}

// --- renderers ---------------------------------------------------------------------------------

/**
 * Apply one studio message to a loader instance the way the new worklet.js apply() does (ABI-1
 * messages included). `state.disabled` mirrors the worklet's disabled-list bookkeeping.
 */
export function applyStudio(dj, msg, state = { disabled: new Set() }) {
    switch (msg.type) {
    case 'load': dj.load(msg.json !== undefined ? msg.json : msg.project); break;
    case 'transport':
        if (msg.action === 'play') dj.play(); else if (msg.action === 'pause') dj.pause(); else dj.stop();
        break;
    case 'tempo': dj.setTempo(msg.bpm); break;
    case 'mute': dj.setMute(msg.netId, msg.muted); break;
    case 'fire-macro': return dj.fireMacro(msg.id, msg.duration === undefined ? -1 : msg.duration);
    case 'release-macro': return dj.releaseMacro(msg.id);
    case 'panic': dj.panic(); break;
    case 'control-macros':
        if (Array.isArray(msg.disabled)) {
            const next = new Set(msg.disabled.map(String));
            for (const id of state.disabled) if (!next.has(id)) dj.setMacroDisabled(id, false);
            for (const id of next) if (!state.disabled.has(id)) dj.setMacroDisabled(id, true);
            state.disabled = next;
        }
        if (msg.on !== undefined) dj.setControlMacros(!!msg.on);
        break;
    case 'seek': return dj.seek(msg.tick);
    case 'groove': return dj.setGroove(Number(msg.swing) || 0, Number(msg.humanize) || 0);
    default: throw new Error(`no studio message ${msg.type}`);
    }
    return 0;
}

/**
 * A 0.3.0 script: {name, sr, blocks, text, options, steps:[{q, msg}]}. `options` are the
 * worklet processorOptions beyond module/json/play (flags, controlMacros, macrosDisabled, mutes,
 * swing, humanize). Node direct: djrust-golden renderCase with the options and steps applied in
 * the hooks, in the worklet's order. → renderCase's result + {events, frames}
 */
export function renderDirect(mod, s, { collectEvents = false } = {}) {
    const o = s.options || {};
    const st = { disabled: new Set() };
    const steps = s.steps.slice().sort((a, b) => a.q - b.q);
    let si = 0;
    const events = [];
    let lastQ = -1;
    const hooks = {
        afterInit(dj) { if (o.flags) dj.initWith(s.sr, o.flags); },
        afterLoad(dj) {
            for (const id of o.mutes || []) dj.setMute(id, true);
            if (o.controlMacros || Array.isArray(o.macrosDisabled)) {
                applyStudio(dj, { type: 'control-macros', on: !!o.controlMacros, disabled: o.macrosDisabled || [] }, st);
            }
            if (o.swing !== undefined || o.humanize !== undefined) dj.setGroove(o.swing || 0, o.humanize || 0);
        },
        atQuantum(dj, q) {
            if (collectEvents && lastQ >= 0 && dj.eventCount > 0) for (const e of dj.events()) events.push({ ...e, q: lastQ });
            while (si < steps.length && steps[si].q <= q) applyStudio(dj, steps[si++].msg, st);
            lastQ = q;
        },
    };
    const c = { id: `script:${s.name}`, blocks: s.blocks, seconds: {}, build: () => ({ text: s.text, steps: [] }) };
    const r = renderCase(mod, c, s.sr, { hooks, streams: true });
    return { ...r, events };
}

const workletCls = new Map();
async function workletClass(path) {
    if (workletCls.has(path)) return workletCls.get(path);
    let reg = null;
    globalThis.AudioWorkletProcessor = class {
        constructor() { this.port = { onmessage: null, _posted: [], postMessage(m) { this._posted.push(m); } }; }
    };
    globalThis.registerProcessor = (name, cls) => { reg = cls; };
    await import(pathToFileURL(path).href + `?djwasm030=${workletCls.size}`);
    delete globalThis.registerProcessor;
    workletCls.set(path, reg);
    return reg;
}

/**
 * Node worklet: the package's worklet.js with TextEncoder / TextDecoder deleted. `via`:
 *   'script'    steps in processorOptions.script (the test hook)
 *   'stamped'   steps posted up front through the port, each stamped {q}
 *   'live'      steps posted unstamped just before process() of their quantum
 * → {audio, posted, frames}
 */
export async function renderWorklet(mod, s, { via = 'script', quiet = true, extra = {} } = {}) {
    const cls = await workletClass(mod.workletPath);
    const saved = { TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder };
    globalThis.sampleRate = s.sr;
    globalThis.currentTime = 0;
    delete globalThis.TextEncoder; delete globalThis.TextDecoder;
    try {
        const po = { module: mod.module, json: s.text, play: true, quiet, ...(s.options || {}), ...extra };
        if (via === 'script') po.script = s.steps;
        const p = new cls({ processorOptions: po });
        const posted = p.port._posted;
        const ready = posted.find((m) => m.type === 'ready');
        if (!ready) throw new Error(`worklet not ready: ${JSON.stringify(posted.slice(0, 3))}`);
        if (via === 'stamped') for (const st of s.steps) p.port.onmessage({ data: { ...st.msg, q: st.q } });
        const steps = s.steps.slice().sort((a, b) => a.q - b.q);
        let si = 0;
        const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK), inter = new Float32Array(2 * BLOCK);
        const h = createHash('sha256');
        for (let q = 0; q < s.blocks; q++) {
            if (via === 'live') while (si < steps.length && steps[si].q <= q) p.port.onmessage({ data: steps[si++].msg });
            globalThis.currentTime = q * BLOCK / s.sr;
            p.process([], [[L, R]]);
            for (let i = 0; i < BLOCK; i++) { inter[2 * i] = L[i]; inter[2 * i + 1] = R[i]; }
            h.update(new Uint8Array(inter.buffer));
        }
        p.port.onmessage({ data: { type: 'tap-digest' } });
        return { audio: h.digest('hex'), posted, frames: s.blocks * BLOCK, ready, proc: p };
    } finally {
        Object.assign(globalThis, saved);
        delete globalThis.sampleRate; delete globalThis.currentTime;
    }
}

// --- the 0.3.0 scripts -------------------------------------------------------------------------

const textOf = (p) => JSON.stringify(p);
const cache = new Map();

/** The macroCurve + feelCurve arrangement of the golden corpus (arr:techno:42:curves). */
export function curvesProject() {
    const p = composeProject('techno', 42, 'standard');
    arrangeWithOpts(p, 'techno', '', {
        overlayOnly: true,
        feelCurve: [{ section: 'intro', x: 0.2, y: 0.3 }, { section: 'buildup', x: 0.7, y: 0.6 }, { section: 'drop', x: 0.9, y: 0.9 }],
        macroCurve: [{ section: 'buildup', macro: 'riser', bars: 4 }, { section: 'drop', macro: 'beat-repeat', bars: 1 }],
    });
    return p;
}

/** Catalog ids beats knows (lib/macros/catalog.js), for "every id disabled". */
export const CATALOG_IDS = MACROS.map((m) => m.id);

/**
 * name → () => script. Macro scripts fire at q 600 (default duration) and q 2400 (2 units), on
 * techno/42 loop (every role playing), 4500 quanta (12 s at 48 kHz): each effect has ended
 * before the next fire and before the end. tempo-anchor first moves the tempo off the
 * project's (140 at q 300) so the anchor has somewhere to go. The others are named for what
 * they test; the macroCurve arrangement fires riser at tick 65 and beat-repeat at tick 257
 * (q 11250), so it runs 12500 quanta.
 */
const DEFS = {};
for (const id of NET_MACROS) {
    DEFS[`macro:${id}`] = () => ({
        base: textOf(composeProject('techno', 42, 'loop')), blocks: 4500,
        steps: [
            ...(id === 'tempo-anchor' ? [{ q: 300, msg: { type: 'tempo', bpm: 140 } }] : []),
            { q: 600, msg: { type: 'fire-macro', id } }, { q: 2400, msg: { type: 'fire-macro', id, duration: 2 } },
        ],
    });
}
DEFS['control:curves'] = () => ({
    base: textOf(curvesProject()), blocks: 12500, options: { controlMacros: true, macrosDisabled: [] }, steps: [],
});
DEFS['control:curves-disabled'] = () => ({
    base: textOf(curvesProject()), blocks: 12500, options: { controlMacros: true, macrosDisabled: CATALOG_IDS }, steps: [],
});
DEFS['seek:playing'] = () => ({
    base: textOf(composeProject('techno', 42, 'standard')), blocks: 3000,
    steps: [{ q: 1000, msg: { type: 'seek', tick: 400 } }, { q: 2000, msg: { type: 'seek', tick: 96 } }],
});
DEFS['seek:stopped'] = () => ({
    base: textOf(composeProject('techno', 42, 'standard')), blocks: 3000,
    steps: [{ q: 800, msg: { type: 'transport', action: 'stop' } }, { q: 801, msg: { type: 'seek', tick: 300 } },
        { q: 900, msg: { type: 'transport', action: 'play' } }],
});
DEFS['groove:30-20'] = () => ({
    base: textOf(composeProject('techno', 42, 'standard')), blocks: 3000, options: { flags: 1, swing: 30, humanize: 20 }, steps: [],
});
DEFS['groove:swap'] = () => ({
    base: textOf(composeProject('techno', 42, 'standard')), blocks: 3000, options: { flags: 1, swing: 30, humanize: 20 },
    steps: [{ q: 700, msg: { type: 'load', json: textOf(composeProject('house', 9, 'standard')) } }],
});
export const SCRIPTS_030 = Object.keys(DEFS);

export function buildScript030(name) {
    if (cache.has(name)) return cache.get(name);
    const d = DEFS[name]();
    const s = { name, sr: SR, blocks: d.blocks, text: d.base, options: d.options || {}, steps: d.steps };
    cache.set(name, s);
    return s;
}

// --- checks ------------------------------------------------------------------------------------

let failures = 0, passes = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if (ok) passes++; else failures++;
};
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function sectionKeys(mod) {
    const dj = mod.loader.instantiateSync(mod.module);
    check('keys: djw_features is 0x3F (SEEK NET_MACROS CONTROL_MACROS GROOVE FRAME_CLOCK EVENTS)', dj.features === 63, `features ${dj.features}`);
    const k = dj.keys();
    check('keys: djw_keys equals the 0.3.0 spec table', deepEq(k, SPEC_KEYS),
        deepEq(k, SPEC_KEYS) ? '' : JSON.stringify(Object.keys(SPEC_KEYS).filter((x) => !deepEq(k[x], SPEC_KEYS[x]))));
    check('keys: double-drop is mask bit 4 and beat-repeat bit 5 (enum order)', k.macros.net.indexOf('double-drop') === 4 && k.macros.net.indexOf('beat-repeat') === 5);
    check('keys: the loader exports the same FEATURE / FLAG / error codes',
        deepEq(mod.loader.FEATURE, SPEC_KEYS.features) && deepEq(mod.loader.FLAG, SPEC_KEYS.flags)
        && mod.loader.ERR_ARG === -1 && mod.loader.ERR_NOT_READY === -2 && mod.loader.ERR_UNSUPPORTED === -3);
    const ids = new Set([...k.macros.net, ...k.macros.master, ...k.macros.aux, ...k.macros.hit]);
    check('keys: the engine knows exactly beats\' catalog ids (42)', ids.size === 42 && CATALOG_IDS.length === 42 && CATALOG_IDS.every((id) => ids.has(id)),
        CATALOG_IDS.filter((id) => !ids.has(id)).join(' '));
    // init flags
    dj.init(SR);
    check('keys: initWith(sr, GROOVE) takes the flag; STINGER_VOICES is refused', dj.initWith(SR, 1) === 4096 && dj.flags === 1
        && (() => { try { dj.initWith(SR, 2); return false; } catch (e) { return /not supported/.test(e.message); } })());
}

async function sectionCompat(mod, pinned) {
    if (!pinned.mod) { check(`compat: the djwasm 0.2.0 reference is present (${REF_WASM})`, false, pinned.why); return; }
    pinned = pinned.mod;
    // new glue, old module
    const old = { ...pinned, loader: mod.loader, workletPath: mod.workletPath };
    const dj = old.loader.instantiateSync(old.module);
    dj.init(SR);
    dj.load(composeProject('techno', 42, 'loop'));
    const r = [dj.features, dj.keys(), dj.fireMacro('drop'), dj.releaseMacro('drop'), dj.seek(10), dj.setGroove(30, 20),
        dj.setMacroDisabled('cut', true), dj.setControlMacros(true), dj.macroMask, dj.frame, dj.eventCount, dj.events().length];
    dj.panic();
    check('compat: on 0.2.0 the new loader reads features 0, keys null, fires/seek/groove ERR_UNSUPPORTED, reads 0',
        deepEq(r, [0, null, -3, -3, -3, -3, -3, false, 0, 0, 0, 0]), JSON.stringify(r));
    const dj2 = old.loader.instantiateSync(old.module);
    dj2.initWith(SR, 1);
    check('compat: on 0.2.0 initWith(sr, GROOVE) initialises plainly and reports flags 0', dj2.flags === 0 && dj2.maxBlock === 4096);
    // golden bytes through the new loader
    const golden = readGolden();
    const cases = (await import('./djrust-golden.mjs')).corpus;
    const all = await cases();
    let bad = [];
    for (const id of ['gen:techno:42:loop', 'gen:techno:42:standard', 'gen:jazz:7:standard', 'arr:techno:42:curves', 'script:tempo', 'script:swap', 'script:transport', 'script:mute']) {
        const c = all.find((x) => x.id === id);
        for (const sr of c.rates) {
            const got = renderCase(old, c, sr);
            const want = golden.cases[`${id}@${sr}`];
            if (['audio', 'ticks', 'report', 'marking', 'muted'].some((k) => got[k] !== want[k])) bad.push(`${id}@${sr}`);
        }
    }
    check('compat: the new loader on 0.2.0 renders the golden (audio, ticks, report, marking, muted; 8 cases, both rates)', !bad.length, bad.join(' '));
    // the new worklet on 0.2.0, script hook: the four live scripts
    bad = [];
    for (const name of ['tempo', 'mute', 'swap', 'transport']) {
        const s = buildScript020(name);
        const w = await renderWorklet(old, { ...s, options: {} }, { via: 'script' });
        if (w.audio !== golden.cases[`script:${name}@48000`].audio) bad.push(name);
        if (w.posted.some((m) => m.type === 'error')) bad.push(`${name}: error`);
    }
    check('compat: the new worklet on 0.2.0 lands each live script on its quantum (script hook) = the golden', !bad.length, bad.join(' '));
    const s = buildScript020('tempo');
    const w = await renderWorklet(old, { ...s, options: {}, steps: [{ q: 10, msg: { type: 'fire-macro', id: 'drop' } }] }, { via: 'script', quiet: false });
    const mf = w.posted.filter((m) => m.type === 'macro-fired');
    const ticks = w.posted.filter((m) => m.type === 'wave-tick');
    check('compat: on 0.2.0 a fire-macro message answers macro-fired result -3 (the page runs it), once',
        mf.length === 1 && mf[0].result === -3 && mf[0].source === 'page', JSON.stringify(mf));
    check('compat: on 0.2.0 the wave-tick carries no new fields (macroMask / frame / tempo)',
        ticks.length > 10 && ticks.every((t) => !('macroMask' in t) && !('frame' in t) && !('tempo' in t)));
    check('compat: the ready message says features 0 / flags 0 on 0.2.0', w.ready.features === 0 && w.ready.flags === 0);
}

async function sectionHooks(mod) {
    const golden = readGolden();
    const s = { ...buildScript020('tempo'), options: {} };
    const want = golden.cases['script:tempo@48000'].audio;
    const vias = {};
    for (const via of ['script', 'stamped', 'live']) vias[via] = (await renderWorklet(mod, s, { via })).audio;
    check('hooks: script hook = q-stamped port messages = unstamped at the quantum = the golden (script:tempo)',
        Object.values(vias).every((x) => x === want), JSON.stringify(Object.fromEntries(Object.entries(vias).map(([k, v]) => [k, v.slice(0, 12)]))));
    // at-stamps: the engine frame clock (no pause before them, so frame = q·128)
    const atAudio = await (async () => {
        const saved = { TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder };
        globalThis.sampleRate = SR; globalThis.currentTime = 0;
        delete globalThis.TextEncoder; delete globalThis.TextDecoder;
        try {
            const cls = await workletClass(mod.workletPath);
            const p = new cls({ processorOptions: { module: mod.module, json: s.text, play: true, quiet: true } });
            for (const st of s.steps) p.port.onmessage({ data: { ...st.msg, at: st.q * BLOCK } });
            const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK), inter = new Float32Array(2 * BLOCK);
            const h = createHash('sha256');
            for (let q = 0; q < s.blocks; q++) {
                p.process([], [[L, R]]);
                for (let i = 0; i < BLOCK; i++) { inter[2 * i] = L[i]; inter[2 * i + 1] = R[i]; }
                h.update(new Uint8Array(inter.buffer));
            }
            return h.digest('hex');
        } finally { Object.assign(globalThis, saved); delete globalThis.sampleRate; delete globalThis.currentTime; }
    })();
    check('hooks: messages stamped at: frame land on the block that starts there (frame clock)', atAudio === want, atAudio.slice(0, 12));
    // tapHash = crypto sha256 of the same bytes
    const tapped = await renderWorklet(mod, s, { via: 'script', extra: { tapHash: true, tapFrames: s.blocks * BLOCK } });
    const done = tapped.posted.find((m) => m.type === 'tap-done');
    const dig = tapped.posted.find((m) => m.type === 'tap-digest');
    check('hooks: tapHash (pure-JS sha256 in the worklet) = node:crypto sha256 of the rendered bytes',
        !!done && done.sha === want && dig && dig.sha === want && done.frames === s.blocks * BLOCK && deepEq(done.quanta, { 128: s.blocks }),
        done ? `${done.sha.slice(0, 12)} frames ${done.frames}` : 'no tap-done');
    // tap (raw chunks) reassembles to the same bytes
    const raw = await renderWorklet(mod, s, { via: 'script', extra: { tap: true, tapBlocks: 50 } });
    const chunks = raw.posted.filter((m) => m.type === 'tap');
    const all = new Float32Array(2 * s.blocks * BLOCK);
    for (const c of chunks) all.set(c.data, 2 * c.offset);
    check('hooks: tap chunks reassemble to the rendered bytes', sha256(new Uint8Array(all.buffer)) === want, `${chunks.length} chunks`);
    // assertQuantum refuses a 64-frame quantum
    {
        const saved = { TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder };
        globalThis.sampleRate = SR; globalThis.currentTime = 0;
        try {
            const cls = await workletClass(mod.workletPath);
            const p = new cls({ processorOptions: { module: mod.module, json: s.text, play: true, quiet: true, assertQuantum: 128 } });
            const L = new Float32Array(64), R = new Float32Array(64);
            p.process([], [[L, R]]);
            const err = p.port._posted.find((m) => m.type === 'error');
            p.process([], [[L, R]]);
            check('hooks: assertQuantum 128 refuses a 64-frame quantum (error, then silence)', !!err && /128/.test(err.message) && L.every((x) => x === 0), err && err.message);
        } finally { Object.assign(globalThis, saved); delete globalThis.sampleRate; delete globalThis.currentTime; }
    }
}

async function sectionMacros(mod) {
    const golden = readGolden();
    const base = renderDirect(mod, { ...buildScript030('macro:drop'), steps: [] }).audio;
    for (const id of NET_MACROS) {
        const s = buildScript030(`macro:${id}`);
        const noFire = renderDirect(mod, { ...s, steps: s.steps.filter((x) => x.msg.type !== 'fire-macro') }).audio;
        const d = renderDirect(mod, s, { collectEvents: true });
        const w = await renderWorklet(mod, s, { via: 'script', quiet: false });
        const st = await renderWorklet(mod, s, { via: 'stamped' });
        const d2 = renderDirect(mod, s);
        const fired = w.posted.filter((m) => m.type === 'macro-fired');
        const restored = w.posted.filter((m) => m.type === 'macro-restored');
        const masks = w.posted.filter((m) => m.type === 'wave-tick').map((m) => m.macroMask);
        const bit = 1 << NET_MACROS.indexOf(id);
        check(`macros ${id}: direct = worklet (script hook) = worklet (stamped messages), deterministic`,
            d.audio === w.audio && w.audio === st.audio && d.audio === d2.audio, `${d.audio.slice(0, 12)} ${w.audio.slice(0, 12)} ${st.audio.slice(0, 12)}`);
        check(`macros ${id}: the fire moves the audio (≠ the same 12 s without it)`, d.audio !== noFire);
        check(`macros ${id}: two page fires reported once each (fired/page/0), the effect restored, mask bit ${NET_MACROS.indexOf(id)} seen and cleared`,
            fired.length === 2 && fired.every((f) => f.id === id && f.source === 'page' && f.result === 0)
            && restored.filter((r) => r.id === id).length >= 1 && masks.some((m) => m & bit) && masks[masks.length - 1] === 0,
            `fired ${fired.length}, restored ${restored.length}, last mask ${masks[masks.length - 1]}`);
        void golden;
    }
    // unsupported / bad ids through the worklet
    const s = { ...buildScript030('macro:drop'), steps: [
        { q: 100, msg: { type: 'fire-macro', id: 'sweep-lp' } }, { q: 101, msg: { type: 'fire-macro', id: 'hit1' } },
        { q: 102, msg: { type: 'fire-macro', id: 'bogus' } }, { q: 103, msg: { type: 'fire-macro', id: 'drop', duration: 0 } }] };
    const w = await renderWorklet(mod, s, { via: 'script', quiet: false });
    const f = w.posted.filter((m) => m.type === 'macro-fired').map((m) => [m.id, m.result]);
    check('macros: master / hit / permanent fires answer -3 and an unknown id -1, each reported once',
        deepEq(f, [['sweep-lp', -3], ['hit1', -3], ['bogus', -1], ['drop', -3]]), JSON.stringify(f));
    check('macros: unsupported and unknown fires leave the audio alone', w.audio === base);
    // panic restores now
    const p = { ...buildScript030('macro:breakdown'), steps: [{ q: 600, msg: { type: 'fire-macro', id: 'breakdown' } }, { q: 700, msg: { type: 'panic' } }] };
    const pw = await renderWorklet(mod, p, { via: 'script', quiet: false });
    const pd = renderDirect(mod, p);
    const after = pw.posted.filter((m) => m.type === 'wave-tick' && m.frame !== undefined && m.frame > 700 * BLOCK);
    check('macros: panic restores at once (worklet = direct; mask 0 on every tick after it)', pw.audio === pd.audio && after.length > 0 && after.every((m) => m.macroMask === 0));
}

async function sectionControl(mod) {
    const golden = readGolden();
    const on = buildScript030('control:curves');
    const d = renderDirect(mod, on, { collectEvents: true });
    const w = await renderWorklet(mod, on, { via: 'script', quiet: false });
    check('control: macroCurve arrangement, control macros on: direct = worklet (33 s)', d.audio === w.audio, `${d.audio.slice(0, 12)} ${w.audio.slice(0, 12)}`);
    const ctl = w.posted.filter((m) => m.type === 'macro-fired' && m.source === 'control');
    const ids = [...new Set(ctl.map((m) => `${m.id}:${m.result}`))];
    check('control: the arrangement\'s control nets fire in the engine: beat-repeat ran (0), riser came back -3 (the page runs it)',
        ids.includes('beat-repeat:0') && ids.includes('riser:-3'), JSON.stringify(ids));
    // every control fire reported exactly once: one macro-fired per control fire-macro the reports carry
    const reported = w.posted.filter((m) => m.type === 'wave-tick')
        .flatMap((m) => m.controls.filter(([, , c]) => c.action === 'fire-macro').map(([, , c]) => `${m.tick}:${c.macro || c.macroId || c.targetNet}`));
    const firedKeys = ctl.map((m) => `${m.tick}:${m.id}`);
    check('control: each control fire-macro is reported exactly once (no double fire)', deepEq(reported.sort(), firedKeys.slice().sort()),
        `${reported.length} controls reported, ${firedKeys.length} fired events`);
    // = the page firing the same ids at the reported quanta
    const fires = d.events.filter((e) => e.k === 'fired' && e.src === 'control');
    const proj = JSON.parse(on.text);
    const bars = (id, tick) => {
        for (const net of Object.values(proj.nets)) for (const t of Object.values(net.transitions || {})) {
            const c = t.control; if (c && c.action === 'fire-macro' && (c.macro || c.macroId || c.targetNet) === id && c.macroBars > 0) return Math.round(c.macroBars);
        }
        return -1;
    };
    const page = { ...on, options: {}, steps: fires.filter((e) => e.res === 0).map((e) => ({ q: e.frame / BLOCK, msg: { type: 'fire-macro', id: e.id, duration: bars(e.id, e.tick) } })) };
    const pd = renderDirect(mod, page);
    check('control: control macros on = control off + the page firing the reported ids at the reported quanta',
        fires.length > 0 && fires.every((e) => e.frame % BLOCK === 0) && pd.audio === d.audio, `${page.steps.length} page fires ${JSON.stringify(page.steps.map((x) => [x.q, x.msg.id, x.msg.duration]))}`);
    // every id disabled = 0.2.0 on the same project
    const dis = buildScript030('control:curves-disabled');
    const dd = renderDirect(mod, dis, { collectEvents: true });
    const plain = renderDirect(mod, { ...dis, options: {} });
    const dw = await renderWorklet(mod, dis, { via: 'script', quiet: false });
    const skipped = dw.posted.filter((m) => m.type === 'macro-skipped');
    check('control: with every catalog id disabled = control macros off (33 s), worklet = direct, every control fire reported as skipped',
        dd.audio === plain.audio && dw.audio === dd.audio && skipped.length === ctl.length && skipped.every((m) => m.source === 'control'),
        `${skipped.length} skipped of ${ctl.length}`);
    const short = renderDirect(mod, { ...dis, blocks: 7500 });
    check('control: …and its first 20 s are the golden arr:techno:42:curves@48000 (djwasm 0.2.0)', short.audio === golden.cases['arr:techno:42:curves@48000'].audio);
}

async function sectionSeek(mod, worker) {
    for (const name of ['seek:playing', 'seek:stopped']) {
        const s = buildScript030(name);
        const d = renderDirect(mod, s);
        const d2 = renderDirect(mod, s);
        const w = await renderWorklet(mod, s, { via: 'script', quiet: false });
        const seeked = w.posted.filter((m) => m.type === 'seeked');
        const stateTicks = w.posted.filter((m) => m.type === 'wave-tick' && m.seek);
        check(`seek ${name}: direct = worklet, deterministic`, d.audio === w.audio && d.audio === d2.audio);
        check(`seek ${name}: each seek answered (seeked + an immediate state tick with the marking, frame 0)`,
            seeked.length === s.steps.filter((x) => x.msg.type === 'seek').length && stateTicks.length === seeked.length
            && stateTicks.every((m) => m.state && m.mutedNets && m.frame === 0), JSON.stringify(seeked));
        // the marking right after each seek = the sequencer worker's fastForwardTo
        for (const st of s.steps.filter((x) => x.msg.type === 'seek')) {
            const t = seeked.find((m) => m.requested === st.msg.tick);
            const ref = worker ? await worker.markingAfterSeek(s.text, st.msg.tick) : null;
            const mine = stateTicks[seeked.indexOf(t)];
            check(`seek ${name} → ${st.msg.tick}: marking and mutes = sequencer-worker.js fastForwardTo`,
                !!ref && Object.keys(normMarking(ref.marking)).length > 3
                && deepEq(normMarking(mine.state), normMarking(ref.marking)) && deepEq(mutedSet(mine.mutedNets), mutedSet(ref.mutedNets)),
                ref ? `${Object.keys(normMarking(ref.marking)).length} nets, muted [${mutedSet(ref.mutedNets)}]` : 'no worker');
        }
    }
    // seek to the current tick while stopped is the neutral value (marking, page mutes kept)
    const dj = mod.loader.instantiateSync(mod.module);
    dj.init(SR);
    const proj = composeProject('techno', 42, 'standard');
    dj.load(proj);
    const music = Object.entries(proj.nets).filter(([, n]) => n.role !== 'control').map(([id]) => id);
    dj.setMute(music[0], true);
    const before = dj.muted();
    const r = dj.seek(0);
    check('seek: seek(0) on a loaded, stopped project keeps the page\'s mutes (the neutral value)', r === 0 && deepEq(dj.muted(), before) && before[music[0]] === true);
    check('seek: bad seeks are codes (-1 negative / NaN)', dj.seek(-1) === -1 && dj.seek(NaN) === -1);
}

async function sectionGroove(mod) {
    const golden = readGolden();
    const s = buildScript030('groove:30-20');
    const d = renderDirect(mod, s), d2 = renderDirect(mod, s);
    const w = await renderWorklet(mod, s, { via: 'script' });
    const plain = renderDirect(mod, { ...s, options: {} });
    check('groove 30/20: direct = worklet, deterministic', d.audio === w.audio && d.audio === d2.audio);
    check('groove 30/20: moves notes (≠ no groove)', d.audio !== plain.audio);
    const noflag = renderDirect(mod, { ...s, options: { swing: 30, humanize: 20 } });
    check('groove 30/20 without the GROOVE flag changes nothing (= no groove)', noflag.audio === plain.audio);
    const sw = buildScript030('groove:swap');
    const ds = renderDirect(mod, sw), ws = await renderWorklet(mod, sw, { via: 'script' });
    check('groove + swap: direct = worklet', ds.audio === ws.audio);
    // the latch: GROOVE + 0/0 across the golden swap script = 0.2.0
    const sc = buildScript020('swap');
    const z = renderDirect(mod, { name: 'swap0', sr: sc.sr, blocks: sc.blocks, text: sc.text, options: { flags: 1, swing: 0, humanize: 0 }, steps: sc.steps });
    check('groove: 0/0 on a GROOVE instance sticks across a project swap (script:swap = the golden)', z.audio === golden.cases['script:swap@48000'].audio);
    const zw = await renderWorklet(mod, { name: 'swap0', sr: sc.sr, blocks: sc.blocks, text: sc.text, options: { flags: 1, swing: 0, humanize: 0 }, steps: sc.steps }, { via: 'script' });
    check('groove: …and through the worklet', zw.audio === golden.cases['script:swap@48000'].audio);
}

const normMarking = (m) => {
    const out = {};
    for (const [net, places] of Object.entries(m || {}).sort()) {
        if (net.startsWith('macro:')) continue;
        out[net] = {};
        for (const [p, v] of Object.entries(places).sort()) out[net][p] = typeof v === 'object' ? (v.tokens ?? v.initial ?? 0) : v;
    }
    return out;
};
const mutedSet = (m) => Object.entries(m || {}).filter(([k, v]) => v && !k.startsWith('macro:')).map(([k]) => k).sort();

// --- the mechanism-parity harness --------------------------------------------------------------
//
// beats' own net-macro semantics live in two places: the worker's tick-locked `fire-macro`
// (mute now, a restore control net N ticks later: sequencer-worker.js + buildMacroRestoreNet)
// and the page code that decides what to send (runtime.js executeMacro, effects.js runBeatRepeat /
// runCompound / tempoHold / tempoAnchor / tempoSweep). The page code runs on wall-clock timers,
// so it is transcribed here to the net clock:
//   mute kinds   one fire-macro {targets, durationTicks} after tick T, targets as catalog.js
//                MACRO_TARGETS picks them (music nets not muted; drum channel 10..15 or not)
//   beat-repeat  a 1-tick fire on the non-kick nets after ticks T, T+2, … while < duration
//   double-drop  cut (2 ticks, everything) after T; drop (its catalog default, 16 ticks, non-drums)
//                after tick T + round(260 ms / tick ms)
//   tempo kinds  the page's tempo now, restored durationMs (at the fire tempo) after the fire,
//                on the first quantum at or after that point
// and run against the real sequencer-worker.js (loaded with a postMessage shim; its timer is
// never started, ticks are stepped by hand). The wasm engine fires the same id with
// djw_fire_macro after the block in which tick T began. Compared per tick: the set of muted
// nets a tick leaves for the next one, and the tempo in effect during the block where the tick
// began. The page's tape-stop sends an integer bpm (setTempoTransient rounds, and throttles to
// 80 ms of wall clock); the engine ramps without rounding, per block. That check reports both
// the difference and the distance to the page's curve before its rounding.
// The ms → tick conversion of the 260 ms offset has no tick-exact original; it is the engine's.

export async function workerHarness() {
    const src = readFileSync(join(ROOT, 'public', 'sequencer-worker.js'), 'utf8');
    const lib = pathToFileURL(join(ROOT, 'public', 'lib')).href + '/';
    let body = src.replace(/from '\.\/lib\//g, `from '${lib}`)
        .replace(/\bsetInterval\(/g, '__setInterval(').replace(/\bclearInterval\(/g, '__clearInterval(');
    body += `
function __setInterval() { return 1; }
function __clearInterval() {}
export const __h = {
    get mutedNets() { return mutedNets; }, get tick() { return tickCount; }, get tempo() { return tempo; },
    get project() { return project; }, advance() { _advanceOneTick(); }, send(m) { self.onmessage({ data: m }); },
};
`;
    const dir = mkdtempSync(join(tmpdir(), 'djwasm030-worker-'));
    let n = 0;
    const fresh = async () => {
        const f = join(dir, `worker-${n++}.mjs`);
        writeFileSync(f, body);
        const sink = [];
        globalThis.self = { postMessage: (m) => sink.push(m) };
        const mod = await import(pathToFileURL(f).href);
        return { h: mod.__h, sink };
    };
    return {
        fresh,
        cleanup() { rmSync(dir, { recursive: true, force: true }); },
        async markingAfterSeek(text, tick) {
            const { h, sink } = await fresh();
            h.send({ type: 'project-load', project: JSON.parse(text) });
            h.send({ type: 'seek', tick });
            const st = sink.filter((m) => m.type === 'state-sync').pop();
            return { marking: st.state, mutedNets: { ...h.mutedNets } };
        },
    };
}

const isDrum = (net) => { const ch = net.track && net.track.channel; return ch >= 10 && ch <= 15; };
const isKick = (id, net) => net.riffGroup === 'kick' || id === 'kick' || id.startsWith('kick:');

/** The page side, transcribed to ticks: [{after: tick, msgs: () => [worker messages]}] plus tempo plan. */
function pagePlan(id, dur, T, proj, tempoAtFire, getMuted) {
    const macro = MACROS.find((m) => m.id === id);
    const d = dur === undefined || dur < 0 ? macro.defaultDuration : dur;
    const durationTicks = macro.durationUnit === 'tick' ? d : d * 16;
    const music = Object.entries(proj.nets).filter(([, n]) => n.role !== 'control');
    const pick = (pred) => () => music.filter(([nid, net]) => !getMuted()[nid] && pred(nid, net)).map(([nid]) => nid);
    const fire = (targets, ticks, tag) => () => {
        const t = targets();
        return t.length ? [{ type: 'fire-macro', macroId: `${tag}`, targets: t, durationTicks: ticks, muteAction: 'mute-track', restoreAction: 'unmute-track' }] : [];
    };
    const plan = { sends: [], tempo: null };
    const tickMs = 60000 / (tempoAtFire * 4);
    if (macro.kind === 'mute') {
        const sel = { drop: (i, n) => !isDrum(n), 'solo-drums': (i, n) => !isDrum(n), breakdown: (i, n) => isDrum(n), cut: () => true }[id];
        plan.sends.push({ after: T, msgs: fire(pick(sel), durationTicks, `${id}-0`) });
    } else if (id === 'beat-repeat') {
        for (let k = 0; 2 * k < durationTicks; k++) plan.sends.push({ after: T + 2 * k, msgs: fire(pick((i, n) => !isKick(i, n)), 1, `br-${k}`) });
    } else if (id === 'double-drop') {
        plan.sends.push({ after: T, msgs: fire(pick(() => true), 2, 'dd-cut') });
        const delay = Math.max(1, Math.floor(0.26 / (60 / (tempoAtFire * 4)) + 0.5));
        plan.sends.push({ after: T + delay, msgs: fire(pick((i, n) => !isDrum(n)), 16, 'dd-drop') });
    } else {
        const durationMs = durationTicks * tickMs;
        const target = id === 'half-time' ? Math.max(20, Math.round(tempoAtFire * 0.5))
            : id === 'tempo-anchor' ? 'genre' : 22;
        plan.tempo = { kind: macro.kind, target, durationMs, start: tempoAtFire };
    }
    return plan;
}

async function mechanismRun(mod, worker, { genre, seed, structure, id, dur, T, ticks }) {
    const proj = composeProject(genre, seed, structure);
    const text = JSON.stringify(proj);
    // wasm
    const dj = mod.loader.instantiateSync(mod.module);
    dj.init(SR);
    dj.load(text);
    dj.play();
    const W = [];
    let fired = false, fireFrame = -1, immediateW = null;
    const tempoAt = [];
    for (let q = 0; W.length < ticks && q < 200000; q++) {
        if (!fired && W.length && W[W.length - 1].tick === T) {
            const r = dj.fireMacro(id, dur === undefined ? -1 : dur);
            if (r !== 0) throw new Error(`fireMacro ${id} → ${r}`);
            fired = true; fireFrame = dj.frame;
            immediateW = mutedSet(dj.muted());
        }
        const frameStart = dj.frame;
        const t = dj.process(BLOCK);
        // the tempo in effect during the block: a tempo effect is serviced at the block's start
        const blockTempo = dj.tempo;
        if (t > 0) {
            if (t > 1) throw new Error('two ticks in one block');
            W.push({ tick: dj.tick, muted: mutedSet(dj.muted()), blockTempo, frameStart });
        }
        tempoAt.push(blockTempo);
    }
    // the state a tick leaves for the next one: at tick T that is after the page's fire
    const iT = W.findIndex((w) => w.tick === T);
    if (iT >= 0) W[iT] = { ...W[iT], muted: immediateW };
    // worker + page transcription
    const { h } = await worker.fresh();
    h.send({ type: 'project-load', project: JSON.parse(text) });
    h.send({ type: 'transport', action: 'play' });
    const J = [];
    let plan = null, immediateJ = null;
    for (let k = 1; k <= ticks; k++) {
        h.advance();
        const tick = h.tick;
        if (tick === T && !plan) plan = pagePlan(id, dur, T, proj, h.tempo, () => h.mutedNets);
        if (plan) for (const s of plan.sends.filter((x) => x.after === tick)) for (const m of s.msgs()) h.send(m);
        if (tick === T) immediateJ = mutedSet(h.mutedNets);
        // the state the tick leaves for the next one: the worker's end of tick plus what the page
        // sent before the next tick (the engine applies a burst or a delayed drop inside the
        // tick's macro service; both are in effect from the next tick's MIDI on)
        J.push({ tick, muted: mutedSet(h.mutedNets) });
    }
    return { W, J, plan, immediateW, immediateJ, fireFrame, proj };
}

async function sectionMechanism(mod, worker) {
    const { Genres } = await import('../public/lib/generator/index.js?v=6');
    const runs = [];
    for (const id of NET_MACROS) for (const dur of [undefined, 2]) {
        runs.push({ genre: 'techno', seed: 42, structure: 'loop', id, dur, T: 40, ticks: 160 });
        runs.push({ genre: 'dnb', seed: 3, structure: 'standard', id, dur, T: 70, ticks: 200 });
    }
    const tempoNotes = [];
    for (const r of runs) {
        const label = `mechanism ${r.id}${r.dur === undefined ? '' : ' ×' + r.dur} on ${r.genre}:${r.seed}:${r.structure} at tick ${r.T}`;
        let res;
        try { res = await mechanismRun(mod, worker, r); } catch (err) { check(label, false, err.message); continue; }
        const { W, J, plan } = res;
        // per-tick mute sets (every kind: a tempo macro must leave the mutes alone)
        let firstBad = -1;
        for (let i = 0; i < Math.min(W.length, J.length); i++) {
            if (W[i].tick !== J[i].tick || !deepEq(W[i].muted, J[i].muted)) { firstBad = i; break; }
        }
        const muteOk = firstBad < 0 && W.length === J.length && deepEq(res.immediateW, res.immediateJ);
        check(`${label}: per-tick mute set = sequencer-worker + page transcription (${W.length} ticks)`, muteOk,
            firstBad < 0 ? (deepEq(res.immediateW, res.immediateJ) ? '' : `at the fire: wasm ${res.immediateW} worker ${res.immediateJ}`)
                : `first differs at tick ${W[firstBad].tick}/${J[firstBad].tick}: wasm [${W[firstBad].muted}] worker [${J[firstBad].muted}]`);
        // tempo stream
        if (plan && plan.tempo) {
            const p = plan.tempo;
            const fx = res.fireFrame;
            const target = p.target === 'genre' ? Math.round((Genres[r.genre] && Genres[r.genre].bpm) || 120) : p.target;
            const restoreFrame = fx + Math.ceil(p.durationMs * SR / 1000 / BLOCK) * BLOCK;
            let worst = 0, worstAt = null, n = 0, worstCurve = 0;
            for (const w of W) {
                if (w.frameStart < fx) continue;
                n++;
                let want, curve;
                if (w.frameStart >= restoreFrame) want = curve = p.start;
                else if (p.kind === 'tempo-sweep') {
                    // effects.js tempoSweep: ease-out to finalBpm, sent through setTempoTransient,
                    // which rounds to an integer bpm (and, live, throttles to 80 ms).
                    const el = (w.frameStart - fx) / SR * 1000;
                    const t = Math.min(1, el / p.durationMs);
                    curve = p.start + (Math.max(20, target) - p.start) * (1 - Math.pow(1 - t, 2));
                    want = Math.max(20, Math.min(300, Math.round(curve)));
                } else want = curve = target;
                const dlt = Math.abs(w.blockTempo - want);
                worstCurve = Math.max(worstCurve, Math.abs(w.blockTempo - curve));
                if (dlt > worst) { worst = dlt; worstAt = { tick: w.tick, wasm: w.blockTempo, page: want }; }
            }
            const exact = worst === 0;
            check(`${label}: tempo stream = the page's (${p.kind}, ${n} ticks from the fire)`, exact,
                exact ? `target ${target}, restore at frame ${restoreFrame}`
                    : `max |Δbpm| ${worst.toFixed(4)} at ${JSON.stringify(worstAt)}; vs the page's curve before its integer rounding: max |Δ| ${worstCurve.toExponential(2)}`);
            if (!exact) tempoNotes.push({ id: r.id, dur: r.dur, genre: r.genre, worst, worstCurve, worstAt });
        }
    }
    if (tempoNotes.length) console.log(`mechanism tempo differences: ${JSON.stringify(tempoNotes)}`);
}

// --- main --------------------------------------------------------------------------------------

async function main(argv) {
    const a = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--only') a.only = new RegExp(argv[++i]);
        else if (argv[i] === '--wasm') a.wasm = argv[++i];
        else if (argv[i] === '--list') a.list = true;
    }
    const sections = ['keys', 'compat', 'hooks', 'macros', 'control', 'seek', 'groove', 'mechanism'];
    if (a.list) { console.log(sections.join('\n')); return 0; }
    const mod = await loadPackage(a.wasm || process.env.DJRUST_WASM);
    if (!mod) { console.error('test-djwasm-030: DJRUST_WASM must name a djwasm package dir (or a .wasm beside its loader.js / worklet.js)'); return 2; }
    const ref = refStatus();
    const pinned = ref.ok ? { mod: await withGlue(REF_WASM, REF_DIR) } : { why: ref.why };
    console.log(`test-djwasm-030: ${mod.wasmPath} (sha256 ${mod.sha256.slice(0, 16)}…, ${mod.bytes.length} B), glue ${mod.glueDir}`);
    const worker = await workerHarness();
    const t0 = Date.now();
    try {
        const run = { keys: () => sectionKeys(mod), compat: () => sectionCompat(mod, pinned), hooks: () => sectionHooks(mod),
            macros: () => sectionMacros(mod), control: () => sectionControl(mod), seek: () => sectionSeek(mod, worker),
            groove: () => sectionGroove(mod), mechanism: () => sectionMechanism(mod, worker) };
        for (const s of sections) {
            if (a.only && !a.only.test(s)) continue;
            const t = Date.now();
            try { await run[s](); } catch (err) { check(`${s}: ran`, false, err.stack || String(err)); }
            console.log(`     (${s}: ${((Date.now() - t) / 1000).toFixed(1)} s)`);
        }
    } finally { worker.cleanup(); }
    console.log(failures ? `\n${failures} check(s) FAILED, ${passes} passed — ${((Date.now() - t0) / 1000).toFixed(0)} s`
        : `\nall ${passes} checks passed — ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    return failures ? 1 : 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2)).then((rc) => process.exit(rc), (err) => { console.error(err); process.exit(1); });
void here;
