#!/usr/bin/env node
//
// Scope kernels through djrust: proves that the kernel worker
// (public/lib/ui/scope-kernel-worker.js) renders, for every kernel spec,
// exactly the f32 PCM a plain Node render of the same one-net project
// through the djwasm loader gives.
//
//   node scripts/test-scope-kernels.mjs [--wasm P] [--skip-missing] [--genres a,b] [--seed N]
//
// The worker file runs unmodified in a worker_threads thread (a 10-line
// shim stands in for the Worker global scope) and is handed the module's
// bytes. The reference side instantiates a FRESH engine per kernel from the
// module package's own loader.js and renders with copyOut, so neither the
// worker's engine reuse nor its glue is trusted. Specs come from the Scope
// tab's own lane → kernel mapping (scope-model.js laneKernelSpecs) over
// composed projects, so every instrument / group / kit note the studio
// would ask for is covered.
//
// Also checks: every kernel is non-silent, its key carries the group and
// the djwasm version, and the same instrument + note in another group is a
// different key. Exit 0 pass, 1 fail, 2 no module (0 with --skip-missing).
//
// Exports nodeKernelRender / nodeKernelSha for test-scope-browser.mjs, which
// compares the browser Worker's shas against them.

import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_URL = pathToFileURL(join(ROOT, 'public/lib/ui/scope-kernel-worker.js')).href;

const kw = await import(WORKER_URL);
export const { kernelProject, KERNEL_SR, KERNEL_FRAMES, KERNEL_BLOCK } = kw;

/** Reference render: a fresh instance of `mod` (djrust-golden resolveModule shape), copyOut per quantum. */
export function nodeKernelRender(mod, spec) {
    const dj = mod.loader.instantiateSync(mod.module);
    dj.init(KERNEL_SR);
    dj.load(JSON.stringify(kernelProject(spec)));
    dj.play();
    const left = new Float32Array(KERNEL_FRAMES), right = new Float32Array(KERNEL_FRAMES);
    const l = new Float32Array(KERNEL_BLOCK), r = new Float32Array(KERNEL_BLOCK);
    for (let o = 0; o < KERNEL_FRAMES; o += KERNEL_BLOCK) {
        const n = Math.min(KERNEL_BLOCK, KERNEL_FRAMES - o);
        dj.process(n);
        dj.copyOut(l, r, n);
        left.set(l.subarray(0, n), o);
        right.set(r.subarray(0, n), o);
    }
    return { left, right };
}

export function pcmSha(left, right) {
    const h = createHash('sha256');
    h.update(Buffer.from(left.buffer, left.byteOffset, left.byteLength));
    h.update(Buffer.from(right.buffer, right.byteOffset, right.byteLength));
    return h.digest('hex');
}

export function nodeKernelSha(mod, spec) {
    const { left, right } = nodeKernelRender(mod, spec);
    return pcmSha(left, right);
}

// --- lanes → specs, as scope.js buildLanes + laneInstrument do ----------------

function durMsOf(m, tempo) {
    const bpm = Number.isFinite(tempo) && tempo > 0 ? tempo : 120;
    if (m.durationSteps > 0) return m.durationSteps * 60000 / bpm / 4;
    return Number.isFinite(m.duration) && m.duration > 0 ? m.duration : 100;
}

export function specsForProject(project, model) {
    const byKey = new Map();
    for (const [id, net] of Object.entries(project.nets || {})) {
        if (!net || net.role === 'control' || !net.track || id.startsWith('macro:')) continue;
        const key = net.riffGroup || id.replace(/-\d+$/, '');
        let lane = byKey.get(key);
        if (!lane) {
            const ch = net.track.channel ?? 1;
            lane = { key, channel: ch, drum: model.isDrumChannel(ch), inst: net.track.instrument || '',
                trackGroup: net.track.group || '', riffGroup: net.riffGroup || '', notes: new Set(), durs: [] };
            byKey.set(key, lane);
        }
        for (const t of Object.values(net.transitions || {})) {
            const m = t?.midi;
            if (!m || !Number.isFinite(m.note)) continue;
            lane.notes.add(m.note);
            if (lane.durs.length < 256) lane.durs.push(durMsOf(m, project.tempo));
        }
    }
    return [...byKey.values()].flatMap(l => model.laneKernelSpecs(l, l.inst || (l.drum ? 'drums' : 'piano')));
}

// --- the worker, in a worker_threads thread ----------------------------------------

const SHIM = `
import { parentPort, workerData } from 'node:worker_threads';
const scope = { onmessage: null, postMessage: (m, t) => parentPort.postMessage(m, t) };
parentPort.on('message', (data) => scope.onmessage && scope.onmessage({ data }));
const m = await import(workerData.url);
m.installKernelWorker(scope);
parentPort.postMessage({ type: 'shim-ready' });
`;

export async function workerRender(bytes, specs) {
    const w = new Worker(new URL('data:text/javascript,' + encodeURIComponent(SHIM)), { workerData: { url: WORKER_URL } });
    try {
        await new Promise((res, rej) => {
            w.once('error', rej);
            w.once('message', (m) => m?.type === 'shim-ready' ? res() : rej(new Error('shim: ' + JSON.stringify(m))));
        });
        return await new Promise((res, rej) => {
            const out = { module: null, kernels: [] };
            w.on('error', rej);
            w.on('message', (m) => {
                if (m.type === 'module') out.module = m;
                else if (m.type === 'kernel') out.kernels.push(m);
                else if (m.type === 'done') res(out);
                else if (m.type === 'error') rej(new Error(m.message));
            });
            const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            w.postMessage({ type: 'render', id: 1, specs, wasm: copy });
        });
    } finally {
        await w.terminate();
    }
}

// --- main ----------------------------------------------------------------------------

function parseArgs(argv) {
    const a = { wasm: process.env.DJRUST_WASM || '', skipMissing: false, genres: 'techno,jazz,dnb,ambient,metal,bossa', seed: 42 };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--wasm') a.wasm = argv[++i];
        else if (k === '--skip-missing') a.skipMissing = true;
        else if (k === '--genres') a.genres = argv[++i];
        else if (k === '--seed') a.seed = +argv[++i];
        else { console.error(`unknown argument ${k}`); process.exit(2); }
    }
    return a;
}

async function main() {
    const a = parseArgs(process.argv.slice(2));
    const golden = await import('./djrust-golden.mjs');
    const mod = await golden.resolveModule(a.wasm || undefined);
    if (!mod) process.exit(golden.missingModule('test-scope-kernels', a.wasm, a.skipMissing));
    const PIN = (await import(pathToFileURL(join(ROOT, 'public/djrust/pin.js')).href)).default;
    const model = await import(pathToFileURL(join(ROOT, 'public/lib/ui/scope-model.js')).href);
    console.log(`module ${mod.wasmPath} sha256 ${mod.sha256.slice(0, 16)}…${mod.sha256 === PIN.sha256 ? ' (pin)' : ' (not the pin)'}`);

    let failures = 0;
    const check = (name, ok, detail = '') => {
        console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
        if (!ok) failures++;
    };

    const seen = new Map();
    for (const g of a.genres.split(',').filter(Boolean)) {
        for (const sp of specsForProject(golden.composeProject(g, a.seed), model)) if (!seen.has(sp.key)) seen.set(sp.key, sp);
    }
    const specs = [...seen.values()];
    check('kernel specs from composed projects', specs.length >= 10, `${specs.length} distinct kernels over ${a.genres}`);
    check('every key carries the group and the djwasm version',
        specs.every(s => s.key.includes(`|djwasm@${PIN.version}`) && s.key.split('|')[1] === (s.group || (s.riffGroup ? '~' + s.riffGroup : ''))));
    const k1 = model.kernelKey('electric-piano', 60, 200, 'melody'), k2 = model.kernelKey('electric-piano', 60, 200, 'bass');
    check('same instrument + note in another group is another kernel', k1 !== k2, `${k1} vs ${k2}`);

    const t0 = performance.now();
    const got = await workerRender(mod.bytes, specs);
    const workerMs = performance.now() - t0;
    check('worker reports the module it was given', got.module?.sha256 === mod.sha256, got.module?.sha256);
    check('worker rendered every kernel', got.kernels.length === specs.length, `${got.kernels.length}/${specs.length} in ${workerMs.toFixed(0)} ms`);

    let same = 0, silent = 0;
    const diffs = [];
    for (const k of got.kernels) {
        const spec = seen.get(k.key);
        const ownSha = pcmSha(k.left, k.right);
        const ref = nodeKernelRender(mod, spec);
        const refSha = pcmSha(ref.left, ref.right);
        let e = 0;
        for (let i = 0; i < ref.left.length; i++) e += ref.left[i] * ref.left[i] + ref.right[i] * ref.right[i];
        if (!(e > 1e-6)) silent++;
        if (k.sha256 === refSha && ownSha === refSha) same++;
        else diffs.push(`${k.key}: worker ${k.sha256.slice(0, 12)} (bytes ${ownSha.slice(0, 12)}) node ${refSha.slice(0, 12)}`);
    }
    check('each kernel f32 sha from the worker equals a fresh Node loader render', same === got.kernels.length && got.kernels.length > 0,
        diffs.length ? diffs.slice(0, 5).join(' | ') : `${same} kernels bit-identical`);
    check('no kernel is silent', silent === 0, `${silent} silent`);

    console.log(failures ? `\n${failures} failure(s)` : '\nall scope kernel checks passed');
    process.exit(failures ? 1 : 0);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((err) => { console.error(err); process.exit(1); });
