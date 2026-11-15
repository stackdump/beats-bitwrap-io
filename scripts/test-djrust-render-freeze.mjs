#!/usr/bin/env node
//
// test-djrust-render-freeze.mjs — the render-farm freeze (studio plan step 3, R-16).
//
// Every feed-corpus envelope (scripts/fixtures/feed-corpus), rendered through the REAL offline
// render path, must give the djwasm 0.2.0 audio hashes in scripts/djrust-golden.json. "Real"
// means the page's own code, unmodified: public/lib/share/offline-render.js renderToBlobOffline
// (48 kHz, the farm's ?render=offline path) and renderProjectOffline (44.1 kHz), which call
// public/djrust/node.js createDjrustEngine, which loads public/djrust/worklet.js into an
// OfflineAudioContext with the compiled module in processorOptions. Node has no Web Audio, so
// this file supplies a minimal OfflineAudioContext / AudioWorkletNode / AudioWorkletGlobalScope
// (128-frame quanta, structured-cloned processorOptions, asynchronous ports, no TextEncoder /
// TextDecoder inside the worklet, fetch of file: URLs) and nothing else: every engine call is
// the one the page makes.
//
// The page state a farm render sees after a share boots is built from the envelope the way the
// golden lowers it (djrust-golden.mjs lowerEnvelope): el._lastProjectJSON is the lowered
// project, el._tempo the tempo override or the project's tempo, el._mutedNets the lowered
// mutes plus the project's initialMutes (what the worker reports), el._disabledMacros the
// envelope's macrosDisabled (lib/share/apply.js applyDisabledMacros). Then the page's own share
// boot runs on it: _currentGen and _pendingShareOverrides from lib/share/url.js shareFromPayload
// (as petri-note.js sets them), the genre table lib/ui/build.js installs, the module's feature
// mask, and lib/backend/wave.js waveLoadProject (which routes the share's swing / humanize).
// Every default render then makes exactly the farm's call, render-mode.js
// renderToBlobOffline(el, { maxMs }) (plus the module's location): no groove or controlMacros
// key, so whatever the boot left on `el` is what decides the bake.
//
// Gates (exit 1 on any failure):
//   default     offline renders with no opt-in (what the farm sends today): feed@48000 through
//               renderToBlobOffline and feed@44100 through renderProjectOffline = golden audio.
//   farm opts   for every feed envelope after the boot, offlineEngineOptions(el, { maxMs }) holds
//               no key but `mutes` (no flags / swing / humanize / controlMacros / macrosDisabled).
//   opt-in      the same with controlMacros:true and the envelope's macrosDisabled (the plan's
//               literal freeze: control macros on must not change any feed bake).
//   all-off     every golden case whose control nets fire macros (arrangement and example
//               cases), opted in with EVERY catalog macro disabled = golden audio.
//   insert      lib/share/insert-render.js renderNotesOffline (same path, no 0.3.0 options) =
//               the Node loader render of the same project (test-insert-render.mjs).
//   sensitivity so the gates above cannot pass vacuously (options that never reach the
//               engine): a techno loop with a control net firing drop and breakdown early.
//               Default = the ABI-1 Node direct render; opt-in != default (the macros run);
//               opt-in with those two ids disabled = default (macrosDisabled is honoured);
//               groove {30, 20} != default; groove {0, 0} = default. Needs a module with
//               FEATURE.NET_MACROS and GROOVE (djwasm 0.3.0+); on an older one it is skipped.
// Reported, not gated (decisions for Matt; the default path does not take them):
//   macros      golden cases (feed, example, arrangement) whose audio WOULD change if offline
//               renders opted in to control macros with the share's own macrosDisabled, and
//               the fire-macro ids that are not disabled.
//   groove      feed envelopes whose audio WOULD change if their swing/humanize fields were
//               treated as an explicit groove override (FLAG.GROOVE + those values).
//
//   node scripts/test-djrust-render-freeze.mjs [--wasm P] [--only RE] [--rate SR] [--skip-missing]
//                                             [--no-report]
//
// Exit 0 pass, 1 fail, 2 no module (0 with --skip-missing and no module named).

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname, basename } from 'node:path';

import { resolveModule, missingModule, corpus, caseFrames, readGolden, renderCase, composeProject, FEED_DIR, EXAMPLES_DIR, ROOT } from './djrust-golden.mjs';
import { shareFromPayload } from '../public/lib/share/url.js';

const here = dirname(fileURLToPath(import.meta.url));
const BLOCK = 128;
const TAIL_SECONDS = 1.5; // offline-render.js TAIL_SECONDS: renderToBlobOffline adds it to maxMs
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

// --- a minimal Web Audio for the real offline path --------------------------------------------

const workletRegistry = new Map(); // module URL → Map(name → processor class)
let pendingPort = null;            // handed to the AudioWorkletProcessor base constructor
let lastRender = null;             // the last AudioBuffer an OfflineAudioContext produced

class ShimPort {
    constructor() { this.onmessage = null; this.peer = null; }
    postMessage(msg, transfer) {
        const data = structuredClone(msg, transfer ? { transfer } : undefined);
        const peer = this.peer;
        setImmediate(() => { if (peer.onmessage) peer.onmessage({ data }); });
    }
    start() {}
    close() {}
}

function withScope(sr, t, fn) {
    // An AudioWorkletGlobalScope has sampleRate and currentTime, and no TextEncoder/TextDecoder.
    const saved = { TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder };
    globalThis.sampleRate = sr;
    globalThis.currentTime = t;
    delete globalThis.TextEncoder; delete globalThis.TextDecoder;
    try { return fn(); } finally {
        Object.assign(globalThis, saved);
        delete globalThis.sampleRate; delete globalThis.currentTime;
    }
}

class ShimAudioWorklet {
    constructor(ctx) { this.ctx = ctx; this.names = new Map(); }
    async addModule(url) {
        const href = String(url instanceof URL ? url.href : url);
        let reg = workletRegistry.get(href);
        if (!reg) {
            reg = new Map();
            globalThis.AudioWorkletProcessor = class {
                constructor() {
                    if (!pendingPort) throw new Error('AudioWorkletProcessor constructed outside an AudioWorkletNode');
                    this.port = pendingPort;
                    pendingPort = null;
                }
            };
            globalThis.registerProcessor = (name, cls) => { reg.set(name, cls); };
            await import(href);
            delete globalThis.registerProcessor;
            workletRegistry.set(href, reg);
        }
        for (const [name, cls] of reg) this.names.set(name, cls);
    }
}

class ShimOfflineAudioContext {
    constructor(channels, length, sampleRate) {
        if (typeof channels === 'object') ({ numberOfChannels: channels, length, sampleRate } = channels);
        this.numberOfChannels = channels;
        this.length = length;
        this.sampleRate = sampleRate;
        this.currentTime = 0;
        this.destination = { kind: 'destination' };
        this.audioWorklet = new ShimAudioWorklet(this);
        this.nodes = [];
        this.rendered = false;
    }
    async startRendering() {
        if (this.rendered) throw new Error('startRendering called twice');
        this.rendered = true;
        await new Promise((r) => setImmediate(r)); // deliver messages posted before rendering
        const n = this.length, sr = this.sampleRate;
        const chans = Array.from({ length: this.numberOfChannels }, () => new Float32Array(n));
        const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK);
        const live = this.nodes.filter((x) => x.connected);
        for (let off = 0; off < n; off += BLOCK) {
            const k = Math.min(BLOCK, n - off);
            const mixL = new Float32Array(BLOCK), mixR = new Float32Array(BLOCK);
            for (const node of live) {
                L.fill(0); R.fill(0);
                withScope(sr, off / sr, () => node.processor.process([], [[L, R]], {}));
                for (let i = 0; i < BLOCK; i++) { mixL[i] += L[i]; mixR[i] += R[i]; }
            }
            chans[0].set(mixL.subarray(0, k), off);
            if (chans[1]) chans[1].set(mixR.subarray(0, k), off);
            this.currentTime = (off + k) / sr;
        }
        const buffer = {
            numberOfChannels: this.numberOfChannels, sampleRate: sr, length: n, duration: n / sr,
            getChannelData: (c) => chans[c],
        };
        lastRender = buffer;
        return buffer;
    }
}

class ShimAudioWorkletNode {
    constructor(ctx, name, options = {}) {
        const cls = ctx.audioWorklet.names.get(name);
        if (!cls) throw new Error(`AudioWorkletNode: no processor '${name}' registered`);
        this.context = ctx;
        this.port = new ShimPort();
        const inner = new ShimPort();
        this.port.peer = inner; inner.peer = this.port;
        const opts = structuredClone({ ...options, processorOptions: options.processorOptions || {} });
        pendingPort = inner;
        this.processor = withScope(ctx.sampleRate, 0, () => new cls(opts));
        this.connected = false;
        ctx.nodes.push(this);
    }
    connect(dest) { this.connected = true; return dest; }
    disconnect() { this.connected = false; }
}

const realFetch = globalThis.fetch;
function installWebAudio() {
    globalThis.OfflineAudioContext = ShimOfflineAudioContext;
    globalThis.AudioWorkletNode = ShimAudioWorkletNode;
    globalThis.fetch = async (url, init) => {
        const href = String(url instanceof URL ? url.href : url);
        if (href.startsWith('file:')) {
            const p = fileURLToPath(href);
            if (!existsSync(p)) return new Response(null, { status: 404 });
            return new Response(readFileSync(p), { status: 200 });
        }
        return realFetch(url, init);
    };
}

// --- page state from an envelope --------------------------------------------------------------

/** The genre table the studio installs (lib/ui/build.js `el._genreData = {…}`), read from the page source. */
function pageGenreTable() {
    const src = readFileSync(join(ROOT, 'public/lib/ui/build.js'), 'utf8');
    const m = src.match(/el\._genreData = (\{\n[\s\S]*?\n    \});/);
    if (!m) throw new Error('lib/ui/build.js: the genre table was not found');
    return Function(`"use strict"; return (${m[1]});`)();
}

/**
 * The petri-note element a farm render sees after the share boots (see the header). `boot` is
 * {waveLoadProject, setEngineFeatures, features, genres}; `cid` the envelope's (null for a
 * case with no envelope, which has no share boot).
 */
function pageFor(built, env, cid, boot) {
    const project = JSON.parse(built.text);
    const nets = project.nets || {};
    const reported = new Set([...(built.mutes || []), ...(project.initialMutes || [])].filter((id) => nets[id]));
    const el = {
        _project: project,
        _lastProjectJSON: project,
        _totalSteps: 0,
        _tempo: built.tempo || project.tempo || 120,
        _mutedNets: reported,
        _manualMutedNets: new Set(),
        _disabledMacros: new Set(Array.isArray(env?.macrosDisabled) ? env.macrosDisabled : []),
        _genreData: boot.genres,
        _currentGen: null,
        _wave: null,
    };
    boot.setEngineFeatures(el, boot.features);
    if (env) {
        // petri-note.js share branch: the generation, then the overrides block stashed for
        // _applyProjectSync, which waveLoadProject reads on the project-sync.
        const share = shareFromPayload(env, cid);
        el._currentGen = { genre: share.genre, params: { ...(share.params || {}) } };
        el._pendingShareOverrides = share.overrides || null;
        boot.waveLoadProject(el, project);
        el._pendingShareOverrides = null; // one-shot (lib/project/sync.js)
    }
    return el;
}

function interleavedSha(buffer, frames) {
    if (buffer.length < frames) return { sha: null, short: true };
    const L = buffer.getChannelData(0), R = buffer.getChannelData(1);
    const h = createHash('sha256');
    const inter = new Float32Array(2 * 4096);
    for (let off = 0; off < frames; off += 4096) {
        const k = Math.min(4096, frames - off);
        for (let i = 0; i < k; i++) { inter[2 * i] = L[off + i]; inter[2 * i + 1] = R[off + i]; }
        h.update(new Uint8Array(inter.buffer, 0, 8 * k));
    }
    return { sha: h.digest('hex'), short: false };
}

/** Control transitions' fire-macro ids in a project JSON text, with counts. */
function fireMacroIds(text) {
    const ids = new Map();
    for (const net of Object.values(JSON.parse(text).nets || {})) {
        for (const t of Object.values(net.transitions || {})) {
            const c = t && t.control;
            if (c && c.action === 'fire-macro') {
                const id = String(c.macro || '?');
                ids.set(id, (ids.get(id) || 0) + 1);
            }
        }
    }
    return ids;
}

/** techno:42 loop plus a 64-step control ring firing drop (tick 8) and breakdown (tick 40). */
function sensitivityCase() {
    return {
        id: 'sens:techno:42:drop', kind: 'sens', rates: [48000], seconds: { 48000: 12 },
        build() {
            const p = composeProject('techno', 42, 'loop');
            const steps = 64, places = {}, transitions = {}, arcs = [];
            const ctrlAt = { 8: { action: 'fire-macro', macro: 'drop', macroBars: 1 },
                40: { action: 'fire-macro', macro: 'breakdown', macroBars: 1 } };
            for (let i = 0; i < steps; i++) {
                places[`sp${i}`] = { initial: i === 0 ? [1] : [0], x: 0, y: 0 };
                transitions[`st${i}`] = ctrlAt[i] ? { x: 0, y: 0, control: ctrlAt[i] } : { x: 0, y: 0 };
                arcs.push({ source: `sp${i}`, target: `st${i}`, weight: [1] },
                    { source: `st${i}`, target: `sp${(i + 1) % steps}`, weight: [1] });
            }
            p.nets['sens-curve'] = { role: 'control', places, transitions, arcs };
            return { text: JSON.stringify(p), mutes: [] };
        },
    };
}

// --- main -------------------------------------------------------------------------------------

function parseArgs(argv) {
    const a = {};
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--wasm') a.wasm = argv[++i];
        else if (k === '--only') a.only = new RegExp(argv[++i]);
        else if (k === '--rate') a.rate = Number(argv[++i]);
        else if (k === '--skip-missing') a.skipMissing = true;
        else if (k === '--no-report') a.noReport = true;
        else { console.error(`unknown argument ${k}`); process.exit(2); }
    }
    return a;
}

async function main() {
    const a = parseArgs(process.argv.slice(2));
    const mod = await resolveModule(a.wasm || process.env.DJRUST_WASM);
    if (!mod) process.exit(missingModule('test-djrust-render-freeze', a.wasm, a.skipMissing));
    installWebAudio();

    const offline = await import(pathToFileURL(join(ROOT, 'public/lib/share/offline-render.js')).href);
    globalThis.requestAnimationFrame ||= () => 0;
    const wave = await import(pathToFileURL(join(ROOT, 'public/lib/backend/wave.js')).href);
    const { MACROS } = await import(pathToFileURL(join(ROOT, 'public/lib/macros/catalog.js')).href);
    const ALL_IDS = MACROS.map((m) => m.id);
    const golden = readGolden();
    const wasmUrl = pathToFileURL(mod.wasmPath).href;
    const pubWorklet = join(ROOT, 'public', 'djrust', 'worklet.js');
    console.log(`render-freeze: ${mod.wasmPath} (sha256 ${mod.sha256.slice(0, 16)}…) against djwasm@${golden.module.version} golden`);
    if (readFileSync(mod.workletPath, 'utf8') !== readFileSync(pubWorklet, 'utf8')) {
        console.log(`note: ${mod.workletPath} differs from public/djrust/worklet.js; the page path loads the public one`);
    }

    const t0 = Date.now();
    let fails = 0, n = 0;
    const check = (name, ok, detail = '') => {
        if (!ok) { fails++; console.log(`FAIL ${name}${detail ? `  (${detail})` : ''}`); }
        n++;
    };

    /**
     * One render through the real path. mode: {controlMacros, groove, disabledAll}; a key the
     * mode does not name is not passed, so the default render is the farm's own call. → sha | null
     */
    async function render(c, built, env, sr, mode) {
        const el = pageFor(built, env, c.cid || null, boot);
        if (mode.disabledAll) el._disabledMacros = new Set(ALL_IDS);
        const frames = caseFrames(c, sr);
        const sel = {};
        if (mode.controlMacros) sel.controlMacros = true;
        if (mode.groove !== undefined) sel.groove = mode.groove;
        if (sr === 48000 && Math.abs(c.seconds[sr] * sr - frames) < 1e-9) {
            // The farm path itself: renderToBlobOffline, capped so the render is the golden length.
            lastRender = null;
            const out = await offline.renderToBlobOffline(el, {
                maxMs: (c.seconds[sr] - TAIL_SECONDS) * 1000, wasmUrl, ...sel,
            });
            if (!lastRender || !out.blob || out.blob.type !== 'audio/wav') throw new Error('renderToBlobOffline produced no WAV');
            const got = interleavedSha(lastRender, frames);
            if (got.short) throw new Error(`rendered ${lastRender.length} frames < ${frames}`);
            return got.sha;
        }
        // Other rates: the same engine path one level down (renderToBlobOffline is 48 kHz only).
        const { buffer } = await offline.renderProjectOffline(el._lastProjectJSON, {
            durationSec: (frames + 1) / sr, sampleRate: sr, tempo: el._tempo,
            ...offline.offlineEngineOptions(el, sel), wasmUrl,
        });
        const got = interleavedSha(buffer, frames);
        if (got.short) throw new Error(`rendered ${buffer.length} frames < ${frames}`);
        return got.sha;
    }

    const cases = (await corpus()).filter((c) => c.kind !== 'script' && c.kind !== 'generated');
    const envOf = (c) => {
        if (c.kind === 'feed') return JSON.parse(readFileSync(join(FEED_DIR, `${c.cid}.json`), 'utf8'));
        if (c.kind === 'example') return JSON.parse(readFileSync(join(EXAMPLES_DIR, `${c.id.slice(3)}.json`), 'utf8'));
        return null;
    };

    // Sensitivity: the options really reach the engine.
    const probe = mod.loader.instantiateSync(mod.module);
    const F = mod.loader.FEATURE || {};
    const hasMacros = !!(F.NET_MACROS && probe.features & F.NET_MACROS && probe.features & F.CONTROL_MACROS);
    const hasGroove = !!(F.GROOVE && probe.features & F.GROOVE);
    const boot = { waveLoadProject: wave.waveLoadProject, setEngineFeatures: wave.setEngineFeatures,
        features: probe.features | 0, genres: pageGenreTable() };
    if ((!a.only || a.only.test('sens:')) && (!a.rate || a.rate === 48000)) {
        const sc = sensitivityCase();
        const built = sc.build();
        const direct = renderCase(mod, sc, 48000, { built, streams: false }).audio;
        const d = await render(sc, built, null, 48000, {});
        check('sensitivity: default offline = ABI-1 Node direct', d === direct, `${d.slice(0, 12)} != ${direct.slice(0, 12)}`);
        if (hasMacros) {
            const on = await render(sc, built, null, 48000, { controlMacros: true });
            check('sensitivity: opt-in runs the control macros (audio differs)', on !== d);
            const dis = await render(sc, built, { macrosDisabled: ['drop', 'breakdown'] }, 48000, { controlMacros: true });
            check('sensitivity: opt-in with drop+breakdown disabled = default', dis === d, `${dis.slice(0, 12)} != ${d.slice(0, 12)}`);
        } else console.log('skip sensitivity (macros): the module has no NET_MACROS/CONTROL_MACROS feature');
        if (hasGroove) {
            const g = await render(sc, built, null, 48000, { groove: { swing: 30, humanize: 20 } });
            check('sensitivity: groove {30, 20} moves notes (audio differs)', g !== d);
            const g0 = await render(sc, built, null, 48000, { groove: { swing: 0, humanize: 0 } });
            check('sensitivity: groove {0, 0} = default', g0 === d, `${g0.slice(0, 12)} != ${d.slice(0, 12)}`);
        } else console.log('skip sensitivity (groove): the module has no GROOVE feature');
    }

    // The insert render (lib/share/insert-render.js renderNotesOffline) rides the same path with
    // no 0.3.0 options: its buffer must equal the Node loader render of the same project.
    if (!a.only || a.only.test('insert:')) {
        const ins = await import('./test-insert-render.mjs');
        const { buildInsertProject, renderNotesOffline } = await import(pathToFileURL(join(ROOT, 'public/lib/share/insert-render.js')).href);
        for (const [name, payload] of [['chords', ins.chordPayload()], ['counterMelody', ins.counterMelodyPayload('harmony')]]) {
            const spec = buildInsertProject(payload, 'counterMelody');
            const buf = await renderNotesOffline(spec, { wasmUrl });
            const L = buf.getChannelData(0), R = buf.getChannelData(1);
            const planar = new Uint8Array(L.byteLength + R.byteLength);
            planar.set(new Uint8Array(L.buffer, L.byteOffset, L.byteLength), 0);
            planar.set(new Uint8Array(R.buffer, R.byteOffset, R.byteLength), L.byteLength);
            const want = (await ins.renderInsertNode(mod, spec)).f32;
            const got = sha256(planar);
            check(`insert:${name}: renderNotesOffline = Node loader`, got === want, `${got.slice(0, 12)} != ${want.slice(0, 12)}`);
        }
    }

    const wouldChange = [];   // opt-in with the share's own macrosDisabled, not the golden
    const grooveChange = [];  // envelope swing/humanize as an override, not the golden
    for (const c of cases) {
        if (a.only && !a.only.test(c.id)) continue;
        const env = envOf(c);
        const built = c.build();
        const fires = fireMacroIds(built.text);
        for (const sr of c.rates.filter((r) => !a.rate || r === a.rate)) {
            const key = `${c.id}@${sr}`;
            const want = golden.cases[key];
            if (!want) { check(`${key}: in the golden`, false, 'missing'); continue; }
            if (c.kind === 'feed') {
                if (sr === 48000) {
                    // What the farm's call sends the engine beside project / tempo / play / quiet.
                    const keys = Object.keys(offline.offlineEngineOptions(pageFor(built, env, c.cid, boot), { maxMs: 60000 }));
                    check(`farm opts ${c.id}`, keys.every((k) => k === 'mutes'), `keys ${keys.join(',')}`);
                }
                const d = await render(c, built, env, sr, {});
                check(`default ${key}`, d === want.audio, `${String(d).slice(0, 12)} != ${want.audio.slice(0, 12)}`);
                const o = await render(c, built, env, sr, { controlMacros: true });
                check(`opt-in ${key}`, o === want.audio, `${String(o).slice(0, 12)} != ${want.audio.slice(0, 12)}`);
                if (o !== want.audio) wouldChange.push({ key, fires, disabled: env?.macrosDisabled || [] });
                if (!a.noReport && sr === 48000 && env && (typeof env.swing === 'number' || typeof env.humanize === 'number')) {
                    const g = await render(c, built, env, sr, { groove: { swing: env.swing ?? 0, humanize: env.humanize ?? 0 } });
                    if (g !== want.audio) grooveChange.push({ key, genre: env.genre, swing: env.swing, humanize: env.humanize });
                }
            } else if (fires.size) {
                const off = await render(c, built, env, sr, { controlMacros: true, disabledAll: true });
                check(`all-off ${key}`, off === want.audio, `${String(off).slice(0, 12)} != ${want.audio.slice(0, 12)}`);
                if (!a.noReport) {
                    const o = await render(c, built, env, sr, { controlMacros: true });
                    if (o !== want.audio) wouldChange.push({ key, fires, disabled: env?.macrosDisabled || [] });
                }
            }
        }
    }

    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (!a.noReport) {
        console.log(`\nreport (not gated): audio that WOULD change if offline renders opted in to control macros`);
        if (!wouldChange.length) console.log('  none');
        for (const w of wouldChange) {
            const live = [...w.fires].filter(([id]) => !w.disabled.includes(id)).map(([id, k]) => `${id}×${k}`);
            console.log(`  ${w.key}: control nets fire ${live.join(', ') || '(no enabled fire-macro: an engine difference)'}`);
        }
        console.log(`\nreport (not gated): feed audio that WOULD change if a share's swing/humanize fields were an explicit groove override`);
        if (!grooveChange.length) console.log('  none');
        for (const g of grooveChange) console.log(`  ${g.key} (${g.genre}, swing ${g.swing ?? '-'}, humanize ${g.humanize ?? '-'})`);
    }
    console.log(fails
        ? `\n${fails} of ${n} render-freeze checks failed — ${secs} s`
        : `\nok   ${n} render-freeze checks: the real offline path renders the djwasm@${golden.module.version} golden — ${secs} s`);
    process.exit(fails ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
