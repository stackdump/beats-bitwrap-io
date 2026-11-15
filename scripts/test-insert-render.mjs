#!/usr/bin/env node
// test-insert-render.mjs — R-12 Node check for the insert render
// (public/lib/share/insert-render.js, MIGRATION-djrust-wasm.md §12).
//
// The page builds a project from the /api/insert-notes payload with
// buildInsertProject (one countermelody buildMusicNet net per
// simultaneous-note layer) and renders it through the djrust worklet in an
// OfflineAudioContext (offline-render.js renderProjectOffline). Node has no
// OfflineAudioContext, so this check renders the SAME project two ways:
//
//   worklet  public/djrust/worklet.js in Node, with the processorOptions
//            renderProjectOffline sends ({module, project, play, tempo,
//            quiet}), truncated to ceil(durationSec × sr) frames as an
//            OfflineAudioContext of that length is;
//   direct   the loader (load → setTempo → play → process), the order the
//            worklet's up() applies them.
//
// and asserts: two worklet renders give one WAV sha256 (via the page's own
// audioBufferToWavBlob), the worklet's planar f32 equals the direct render's,
// the render is not silent, chords split into layers, every note is bound.
// The browser half (Chrome's renderNotesOffline f32 = renderInsertNode's
// f32) belongs in test-djrust-browser; renderInsertNode is exported for it.
//
//   node scripts/test-insert-render.mjs [--wasm P] [--skip-missing]
//   DJRUST_WASM=<path> node scripts/test-insert-render.mjs
//
// Exit 0 pass, 1 fail, 2 no module (0 with --skip-missing).

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveModule, composeProject, missingModule } from './djrust-golden.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const BLOCK = 128;

const { buildInsertProject } = await import(pathToFileURL(join(ROOT, 'public/lib/share/insert-render.js')).href);
const { audioBufferToWavBlob } = await import(pathToFileURL(join(ROOT, 'public/lib/share/offline-render.js')).href);
const { generateCounterMelody } = await import(pathToFileURL(join(ROOT, 'public/lib/generator/countermelody.js')).href);
const { parseProject } = await import(pathToFileURL(join(ROOT, 'public/lib/pflow.js')).href);

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

// --- fixtures ----------------------------------------------------------------------------------

/** A hand payload with chords (three notes on one tick), overlaps and an out-of-range note. */
export function chordPayload() {
    const notes = [];
    const chord = [60, 64, 67];
    for (let bar = 0; bar < 4; bar++) {
        for (const [i, n] of chord.entries()) {
            notes.push({ tick: bar * 16, note: n + bar, velocity: 80 + i * 5, durationTicks: 8 });
        }
        notes.push({ tick: bar * 16 + 6, note: 72 + bar, velocity: 100, durationTicks: 12 });
    }
    notes.push({ tick: 100000, note: 60, velocity: 90, durationTicks: 4 }); // past the ring: dropped
    return { notes, durationMs: 4000, tempo: 124, channel: 5, instrument: 'supersaw' };
}

/** A payload as Go's synthesizeNotesViaBrowser sends it, from the JS countermelody kernel. */
export function counterMelodyPayload(mode = 'harmony') {
    const tempo = 128;
    const durationMs = 6000;
    const totalTicks = Math.round((durationMs / 1000) / (60 / (tempo * 4)));
    const proj = parseProject(composeProject('techno', 42, 'loop'));
    const ns = generateCounterMelody(proj, { mode, density: 0.6, register: 'above', seed: 7, totalTicks }) || [];
    return {
        notes: ns.map((n) => ({ tick: n.startTick, note: n.note, velocity: n.velocity, durationTicks: n.duration })),
        durationMs, tempo, channel: 5, instrument: 'supersaw',
    };
}

// --- renders -----------------------------------------------------------------------------------

let workletCls = null;
async function workletClass(mod) {
    if (workletCls) return workletCls;
    let reg = null;
    globalThis.AudioWorkletProcessor = class {
        constructor() { this.port = { onmessage: null, postMessage: (m) => this.port._posted.push(m), _posted: [] }; }
    };
    globalThis.registerProcessor = (name, cls) => { reg = cls; };
    await import(pathToFileURL(mod.workletPath).href);
    delete globalThis.registerProcessor;
    workletCls = reg;
    return reg;
}

const framesOf = (spec) => Math.ceil(spec.durationSec * spec.sampleRate);

function planarBytes(L, R) {
    const all = new Uint8Array(L.byteLength + R.byteLength);
    all.set(new Uint8Array(L.buffer, L.byteOffset, L.byteLength), 0);
    all.set(new Uint8Array(R.buffer, R.byteOffset, R.byteLength), L.byteLength);
    return all;
}

async function wavSha(L, R, sr) {
    const fake = { numberOfChannels: 2, sampleRate: sr, length: L.length, getChannelData: (c) => (c ? R : L) };
    return sha256(new Uint8Array(await audioBufferToWavBlob(fake).arrayBuffer()));
}

/** The worklet path, as renderProjectOffline drives it. → {L, R, f32, wav, peak} */
export async function renderInsertWorklet(mod, spec) {
    const cls = await workletClass(mod);
    const sr = spec.sampleRate, frames = framesOf(spec);
    const saved = { TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder };
    globalThis.sampleRate = sr;
    globalThis.currentTime = 0;
    delete globalThis.TextEncoder; delete globalThis.TextDecoder;
    try {
        const p = new cls({ processorOptions: { module: mod.module, project: spec.project, play: true, tempo: spec.tempo, quiet: true } });
        const posted = p.port._posted;
        if (!posted.some((m) => m.type === 'ready')) throw new Error(`worklet not ready: ${JSON.stringify(posted)}`);
        const errs = posted.filter((m) => m.type === 'error');
        if (errs.length) throw new Error(`worklet error: ${JSON.stringify(errs)}`);
        const L = new Float32Array(frames), R = new Float32Array(frames);
        const bl = new Float32Array(BLOCK), br = new Float32Array(BLOCK);
        for (let q = 0, off = 0; off < frames; q++, off += BLOCK) {
            globalThis.currentTime = off / sr;
            p.process([], [[bl, br]]);
            const n = Math.min(BLOCK, frames - off);
            L.set(bl.subarray(0, n), off); R.set(br.subarray(0, n), off);
        }
        return finish(L, R, sr);
    } finally {
        Object.assign(globalThis, saved);
        delete globalThis.sampleRate; delete globalThis.currentTime;
    }
}

/** The Node loader, directly. → {L, R, f32, wav, peak} */
export async function renderInsertNode(mod, spec) {
    const sr = spec.sampleRate, frames = framesOf(spec);
    const dj = mod.loader.instantiateSync(mod.module);
    dj.init(sr);
    dj.load(spec.project);
    if (spec.tempo) dj.setTempo(spec.tempo);
    dj.play();
    const L = new Float32Array(frames), R = new Float32Array(frames);
    for (let off = 0; off < frames; off += BLOCK) {
        dj.process(BLOCK);
        const [l, r] = dj.blocks(BLOCK);
        const n = Math.min(BLOCK, frames - off);
        L.set(l.subarray(0, n), off); R.set(r.subarray(0, n), off);
    }
    return finish(L, R, sr);
}

async function finish(L, R, sr) {
    let peak = 0;
    for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    return { L, R, f32: sha256(planarBytes(L, R)), wav: await wavSha(L, R, sr), peak };
}

// --- main --------------------------------------------------------------------------------------

async function main(argv) {
    let wasm, skipMissing = false;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--wasm') wasm = argv[++i];
        else if (argv[i] === '--skip-missing') skipMissing = true;
        else { console.error(`unknown argument ${argv[i]}`); process.exit(2); }
    }
    const mod = await resolveModule(wasm);
    if (!mod) process.exit(missingModule('test-insert-render', wasm, skipMissing));
    console.log(`module ${mod.wasmPath} sha256 ${mod.sha256.slice(0, 16)}`);

    let fails = 0;
    const check = (name, ok, detail = '') => {
        console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
        if (!ok) fails++;
    };

    const cases = [['chords', chordPayload()], ['counterMelody harmony', counterMelodyPayload('harmony')],
        ['counterMelody shadow', counterMelodyPayload('shadow')]];
    for (const [name, payload] of cases) {
        const spec = buildInsertProject(payload, 'counterMelody');
        const again = buildInsertProject(JSON.parse(JSON.stringify(payload)), 'counterMelody');
        check(`${name}: buildInsertProject is deterministic`, JSON.stringify(spec.project) === JSON.stringify(again.project));
        const inRing = payload.notes.filter((n) => n.tick >= 0 && n.tick < spec.ringTicks).length;
        const bound = Object.values(spec.project.nets).reduce((a, n) => a + Object.keys(n.bindings).length, 0);
        check(`${name}: every in-range note is bound (one net per simultaneous layer)`, bound === inRing && inRing > 0,
            `${bound}/${inRing} notes, ${spec.layers} layer(s), ring ${spec.ringTicks} ticks`);
        const maxTick = Math.max(...payload.notes.map((n) => n.tick).filter((t) => t < spec.ringTicks));
        check(`${name}: the ring is longer than the render`,
            spec.ringTicks * spec.tickIntervalMs > spec.durationSec * 1000 && maxTick < spec.ringTicks);

        const a = await renderInsertWorklet(mod, spec);
        const b = await renderInsertWorklet(mod, spec);
        const d = await renderInsertNode(mod, spec);
        check(`${name}: two renders give one WAV sha256`, a.wav === b.wav, a.wav.slice(0, 16));
        check(`${name}: worklet f32 = Node loader f32`, a.f32 === d.f32 && a.wav === d.wav,
            `worklet ${a.f32.slice(0, 12)} direct ${d.f32.slice(0, 12)}`);
        check(`${name}: not silent`, a.peak > 0.01, `peak ${a.peak.toFixed(3)}`);
        console.log(`     ${name}: frames ${a.L.length} f32 ${a.f32} wav ${a.wav}`);
    }
    if (cases[0]) {
        const spec = buildInsertProject(chordPayload(), 'counterMelody');
        check('chords: three-note chords give three layers', spec.layers === 3, `${spec.layers}`);
    }

    console.log(fails ? `\n${fails} check(s) failed` : '\nall insert-render checks passed');
    process.exit(fails ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
