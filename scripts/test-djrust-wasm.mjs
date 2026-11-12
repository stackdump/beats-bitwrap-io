#!/usr/bin/env node
//
// The djrust engine compiled to WebAssembly (public/djrust/djwasm.wasm) against beats' own JS,
// live, in one process: no fixtures, so it also catches the JS drifting away from what djrust
// was last held to. Plain `node`, no npm.
//
//   make djrust-wasm && node scripts/test-djrust-wasm.mjs      # or: make test-djrust
//   DJRUST_WASM=/path/to/djwasm.wasm node scripts/test-djrust-wasm.mjs
//
// 1. Generator: compose(genre, params) in wasm returns the same project document, byte for byte,
//    and the same model CID as JS's compose → projectToJSON → canonicalProjectJSON, across all 19
//    genres, two seeds, loop / standard, with and without an explicit cohesion.
// 2. Engine: the wasm WaveRunner renders the same audio as wave-engine/runner.js (within the 1e-5
//    djrust's own suite holds it to), and reports the same fires, controls and markings tick by tick.
// 3. Live changes: tempo, mute, a project swap at the bar, pause / play / stop, played the same way
//    on both.
// 4. Determinism: two instances, same bits.
// 5. UTF-8: the hand-written codec (an AudioWorklet has no TextEncoder) equals the built-in one.
// 6. The worklet: public/djrust/worklet.js run in Node with TextEncoder / TextDecoder deleted (as in
//    an AudioWorkletGlobalScope): instantiates, queues early messages, renders the same audio,
//    posts the same ticks.

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { instantiate, utf8EncodeManual, utf8DecodeManual } from '../public/djrust/loader.js';
import { compose } from '../public/lib/generator/composer.js?v=6';
import { projectToJSON, parseProject, canonicalProjectJSON } from '../public/lib/pflow.js';
import { WaveRunner } from '../public/wave-engine/runner.js';
import { markingOf } from '../public/wave-engine/net.js';

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = process.env.DJRUST_WASM || join(here, '..', 'public', 'djrust', 'djwasm.wasm');
if (!existsSync(wasmPath)) {
    console.error(`no ${wasmPath}\nbuild it first: make djrust-wasm   (needs a djrust-vevr-se checkout and Rust with wasm32)`);
    process.exit(2);
}
const wasmBytes = readFileSync(wasmPath);

let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) failures++;
};
const sha = (s) => createHash('sha256').update(s).digest('hex');
const BLOCK = 128;

const GENRES = ['ambient', 'blues', 'bossa', 'country', 'dnb', 'dubstep', 'edm', 'funk', 'garage', 'house',
    'jazz', 'lofi', 'metal', 'reggae', 'speedcore', 'synthwave', 'techno', 'trance', 'trap'];

const newDj = async (sr, opts) => { const dj = await instantiate(wasmBytes, opts); if (sr) dj.init(sr); return dj; };

const jsProject = (genre, seed, structure, cohesion) => {
    const params = { seed };
    if (structure && structure !== 'loop') params.structure = structure;
    if (cohesion) params.cohesion = cohesion;
    return projectToJSON(compose(genre, params));
};
const specOf = (genre, seed, structure, cohesion) => {
    const s = { genre, seed };
    if (structure && structure !== 'loop') s.structure = structure;
    if (cohesion) s.cohesion = cohesion;
    return s;
};

console.log(`module: ${wasmPath} (${wasmBytes.length} bytes)`);
{
    const dj = await newDj();
    const info = dj.info();
    check('module speaks the loader\'s ABI', info.abi === 1, JSON.stringify(info));
}

// --- 1. Generator ----------------------------------------------------------------------------
{
    const dj = await newDj();
    let n = 0, bad = [];
    for (const genre of GENRES) for (const seed of [1, 42]) for (const structure of ['', 'standard']) {
        for (const cohesion of [undefined, 'v1']) {
            const js = jsProject(genre, seed, structure, cohesion);
            const jsText = JSON.stringify(js);
            const jsCid = sha(canonicalProjectJSON(parseProject(js)));
            const rs = dj.compose(specOf(genre, seed, structure, cohesion), { raw: true });
            n++;
            const tag = `${genre}/${seed}/${structure || 'loop'}/${cohesion || 'default'}`;
            if (rs.docText !== jsText) bad.push(`${tag}: document differs`);
            else if (rs.modelCid !== jsCid) bad.push(`${tag}: model CID ${rs.modelCid} != ${jsCid}`);
            else if (dj.modelCid(jsText) !== jsCid) bad.push(`${tag}: modelCid(doc) differs`);
            else if (rs.name !== js.name) bad.push(`${tag}: name`);
        }
    }
    check(`generator: ${n} compositions, document bytes and model CID equal beats' JS`, bad.length === 0,
        bad.length ? `${bad.length} differ, first: ${bad.slice(0, 3).join('; ')}` : `${GENRES.length} genres`);
    check('generator: a different seed composes a different CID',
        dj.compose({ genre: 'techno', seed: 42 }).modelCid !== dj.compose({ genre: 'techno', seed: 43 }).modelCid);
    check('generator: an unknown genre composes the fallback preset, as JS does',
        dj.compose({ genre: 'no-such-genre', seed: 5 }, { raw: true }).docText
            === JSON.stringify(jsProject('no-such-genre', 5)));
}

// --- engine drivers --------------------------------------------------------------------------

/** What the JS worklet posts for the last tick (wave-engine/worklet.js report()). */
function jsTickReport(r) {
    const g = r.graph, fired = [], controls = [];
    for (let i = 0; i < g.firedCount; i += 2) {
        const n = g.nets[g.fired[i]], t = g.fired[i + 1];
        fired.push([n.id, n.transIds[t], n.bundle.bindings[n.transIds[t]]]);
    }
    for (let i = 0; i < g.controlCount; i += 2) {
        const n = g.nets[g.controls[i]], t = g.controls[i + 1];
        controls.push([n.id, n.transIds[t], n.bundle.controlBindings[n.transIds[t]]]);
    }
    return { tick: g.tick, fired, controls };
}

/**
 * Play one script on both engines. `script` is a list of {block, op, ...}; `blocks` the length.
 * Returns {maxDiff, identical, total, tickMismatch, marks, ticks, jsMs, wasmMs}.
 */
async function playBoth({ sr, project, blocks, script = [], withTicks = true }) {
    const dj = await newDj(sr);
    const js = new WaveRunner(sr, {});
    js.load(project); dj.load(project);
    js.play(); dj.play();
    const jl = new Float32Array(BLOCK), jr = new Float32Array(BLOCK);
    let maxDiff = 0, identical = 0, total = 0, ticks = 0, marks = 0, jsMs = 0, wasmMs = 0;
    const tickMismatch = [];
    const ops = script.slice().sort((a, b) => a.block - b.block);
    let oi = 0;
    for (let b = 0; b < blocks; b++) {
        while (oi < ops.length && ops[oi].block <= b) {
            const o = ops[oi++];
            if (o.op === 'tempo') { js.setTempo(o.bpm); dj.setTempo(o.bpm); }
            else if (o.op === 'mute') { js.setMute(o.netId, o.muted); dj.setMute(o.netId, o.muted); }
            else if (o.op === 'load') { js.load(o.project); dj.load(o.project); }
            else if (o.op === 'pause') { js.pause(); dj.pause(); }
            else if (o.op === 'play') { js.play(); dj.play(); }
            else if (o.op === 'stop') { js.stop(); dj.stop(); }
        }
        let t0 = process.hrtime.bigint();
        js.process(jl, jr, BLOCK);
        jsMs += Number(process.hrtime.bigint() - t0) / 1e6;
        t0 = process.hrtime.bigint();
        const nt = dj.process(BLOCK);
        wasmMs += Number(process.hrtime.bigint() - t0) / 1e6;
        const [wl, wr] = dj.blocks(BLOCK);
        for (let i = 0; i < BLOCK; i++) {
            for (const [a, c] of [[jl[i], wl[i]], [jr[i], wr[i]]]) {
                const d = Math.abs(a - c);
                if (d > maxDiff) maxDiff = d;
                if (Object.is(a, c) || a === c) identical++;
                total++;
            }
        }
        const jsTicked = js.ticksInBlock > 0 && js.graph;
        if (!!jsTicked !== (nt > 0)) tickMismatch.push(`block ${b}: ticks js ${js.ticksInBlock} wasm ${nt}`);
        if (jsTicked && nt > 0 && withTicks) {
            ticks++;
            const a = jsTickReport(js), c = dj.report();
            const aj = JSON.stringify(a), cj = JSON.stringify(c);
            if (aj !== cj) tickMismatch.push(`tick ${a.tick}: report differs\n   js   ${aj.slice(0, 160)}\n   wasm ${cj && cj.slice(0, 160)}`);
            if (a.tick % 6 === 0) {
                marks++;
                if (JSON.stringify(markingOf(js.graph)) !== JSON.stringify(dj.marking())) tickMismatch.push(`tick ${a.tick}: marking differs`);
            }
        }
    }
    return { maxDiff, identical, total, tickMismatch, marks, ticks, jsMs, wasmMs, dj, js, blocks };
}

// --- 2. Engine -------------------------------------------------------------------------------
const CASES = [
    ['techno', 42, 'standard', 48000, 10],
    ['jazz', 7, '', 48000, 8],
    ['dnb', 3, 'standard', 44100, 8],
    ['ambient', 1, 'extended', 48000, 8],
    ['bossa', 11, 'standard', 48000, 8],
    ['speedcore', 5, '', 48000, 6],
];
let perf = null;
for (const [genre, seed, structure, sr, secs] of CASES) {
    const project = jsProject(genre, seed, structure);
    const blocks = Math.ceil(secs * sr / BLOCK);
    const r = await playBoth({ sr, project, blocks });
    const tag = `${genre}/${seed}/${structure || 'loop'} @${sr}`;
    check(`engine: ${tag} audio within 1e-5 of the JS wave engine`, r.maxDiff < 1e-5 && r.tickMismatch.length === 0 && r.ticks > 10,
        `max |d| ${r.maxDiff.toExponential(2)}, ${(100 * r.identical / r.total).toFixed(2)}% of samples bit-identical, ${r.ticks} ticks, ${r.marks} markings` +
        (r.tickMismatch.length ? `\n   ${r.tickMismatch.slice(0, 3).join('\n   ')}` : ''));
    if (genre === 'techno') perf = r;
}
{
    // The gate has to be able to fail: a different seed on one side must not pass.
    const dj = await newDj(48000), js = new WaveRunner(48000, {});
    dj.load(jsProject('techno', 42, 'standard')); js.load(jsProject('techno', 43, 'standard'));
    dj.play(); js.play();
    const jl = new Float32Array(BLOCK), jr = new Float32Array(BLOCK);
    let worst = 0;
    for (let b = 0; b < 48000 * 4 / BLOCK; b++) {
        js.process(jl, jr, BLOCK); dj.process(BLOCK);
        const [wl] = dj.blocks(BLOCK);
        for (let i = 0; i < BLOCK; i++) worst = Math.max(worst, Math.abs(jl[i] - wl[i]));
    }
    check('engine: the comparison fails on a different seed (the gate can fail)', worst > 1e-2, `max |d| ${worst.toFixed(3)}`);
}
if (perf) {
    const budget = BLOCK / 48000 * 1000;
    console.log(`     time per ${BLOCK}-frame block (techno/standard, Node, shared host): wasm ${(perf.wasmMs / perf.blocks * 1000).toFixed(1)} µs, ` +
        `JS ${(perf.jsMs / perf.blocks * 1000).toFixed(1)} µs, budget ${(budget * 1000).toFixed(0)} µs`);
}

// --- 3. Live changes -------------------------------------------------------------------------
{
    const a = jsProject('techno', 42, 'standard'), b = jsProject('house', 9, 'standard');
    const sr = 48000;
    const script = [
        { block: 100, op: 'tempo', bpm: 140 },
        { block: 200, op: 'mute', netId: 'kick', muted: true },
        { block: 400, op: 'mute', netId: 'kick', muted: false },
        { block: 500, op: 'load', project: b },       // queued, takes over at the next bar
        { block: 1300, op: 'pause' },
        { block: 1350, op: 'play' },
        { block: 1700, op: 'tempo', bpm: 96 },
        { block: 2000, op: 'stop' },
        { block: 2050, op: 'play' },
    ];
    const r = await playBoth({ sr, project: a, blocks: 2600, script });
    check('live: tempo, mute, queued project swap, pause/play, stop/play match the JS engine',
        r.maxDiff < 1e-5 && r.tickMismatch.length === 0,
        `max |d| ${r.maxDiff.toExponential(2)}, ${r.ticks} ticks` + (r.tickMismatch.length ? `\n   ${r.tickMismatch.slice(0, 3).join('\n   ')}` : ''));
    check('live: both engines end on the same tempo and tick', r.dj.tempo === r.js.tempo && r.dj.tick === r.js.graph.tick,
        `tempo ${r.dj.tempo}/${r.js.tempo}, tick ${r.dj.tick}/${r.js.graph.tick}`);
}

// --- 4. Determinism --------------------------------------------------------------------------
{
    const project = jsProject('trance', 8, 'standard');
    const run = async () => {
        const dj = await newDj(48000);
        dj.load(project); dj.play();
        const h = createHash('sha256');
        for (let i = 0; i < 48000 * 6 / BLOCK; i++) {
            dj.process(BLOCK);
            const [l, r] = dj.blocks(BLOCK);
            h.update(Buffer.from(l.buffer, l.byteOffset, l.byteLength)); h.update(Buffer.from(r.buffer, r.byteOffset, r.byteLength));
        }
        return h.digest('hex');
    };
    const x = await run(), y = await run();
    check('determinism: two wasm instances render byte-identical audio', x === y, x.slice(0, 16));
}

// --- 5. UTF-8 --------------------------------------------------------------------------------
{
    const samples = ['', 'techno', 'techno · Rusted Spine', 'añb ü', '日本語', '🎧 beats', 'a\u{1F600}b\u{10FFFF}', '\ud800', 'x\udc00y'];
    const enc = new TextEncoder(), dec = new TextDecoder();
    let ok = true, why = '';
    for (const s of samples) {
        const m = utf8EncodeManual(s), n = enc.encode(s);
        if (m.length !== n.length || !m.every((v, i) => v === n[i])) { ok = false; why = `encode ${JSON.stringify(s)}`; break; }
        if (utf8DecodeManual(n) !== dec.decode(n)) { ok = false; why = `decode ${JSON.stringify(s)}`; break; }
    }
    const big = 'ab·'.repeat(100000);
    if (ok && utf8DecodeManual(utf8EncodeManual(big)) !== big) { ok = false; why = 'large round trip'; }
    check('utf-8: the hand-written codec equals TextEncoder / TextDecoder (incl. surrogates, 300 kB)', ok, why);
    const a = await newDj(), b = await newDj(0, { manualUtf8: true });
    const spec = { genre: 'techno', seed: 42 };
    check('utf-8: compose through the hand-written codec returns the same bytes',
        a.compose(spec, { raw: true }).docText === b.compose(spec, { raw: true }).docText);
}

// --- 6. The worklet --------------------------------------------------------------------------
{
    // An AudioWorkletGlobalScope has no TextEncoder / TextDecoder, fetch, performance, URL ...:
    // take the first two away (the ones the Rust glue would need) and load the real worklet.
    const saved = { TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder };
    let registered = null;
    const posted = [];
    globalThis.AudioWorkletProcessor = class { constructor() { this.port = { onmessage: null, postMessage: (m) => posted.push(m) }; } };
    globalThis.registerProcessor = (name, cls) => { registered = { name, cls }; };
    globalThis.sampleRate = 48000;
    globalThis.currentTime = 0;
    delete globalThis.TextEncoder; delete globalThis.TextDecoder;
    try {
        await import('../public/djrust/worklet.js');
        check('worklet: registers the processor "djrust-engine"', registered && registered.name === 'djrust-engine');
        const p = new registered.cls({ processorOptions: {} });

        const project = jsProject('techno', 42, 'standard');
        // Messages that arrive before the module is up are queued: load + play + tempo, in order.
        p.port.onmessage({ data: { type: 'load', project } });
        p.port.onmessage({ data: { type: 'transport', action: 'play' } });
        p.port.onmessage({ data: { type: 'tempo', bpm: 128 } });
        const silent = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
        p.process([], [silent]);
        check('worklet: silent until the module is instantiated', silent[0].every(v => v === 0));
        p.port.onmessage({ data: { type: 'wasm', bytes: wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength) } });
        for (let i = 0; i < 200 && !posted.some(m => m.type === 'ready'); i++) await new Promise(r => setTimeout(r, 10));
        const ready = posted.find(m => m.type === 'ready');
        check('worklet: instantiates without TextEncoder / TextDecoder and says ready', !!ready, ready ? JSON.stringify(ready.info) : JSON.stringify(posted));

        // Reference: the same project played directly through the loader.
        const ref = await instantiate(wasmBytes);
        ref.init(48000); ref.load(project); ref.setTempo(128); ref.play();
        let diff = 0, ticksPosted = 0, tickErr = '';
        const out = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
        const before = posted.length;
        for (let b = 0; b < 48000 * 6 / BLOCK; b++) {
            globalThis.currentTime = b * BLOCK / 48000;
            p.process([], [out]);
            ref.process(BLOCK);
            const [rl, rr] = ref.blocks(BLOCK);
            for (let i = 0; i < BLOCK; i++) diff = Math.max(diff, Math.abs(out[0][i] - rl[i]), Math.abs(out[1][i] - rr[i]));
            const rep = ref.report();
            if (rep) {
                ticksPosted++;
                const m = posted.slice(before).filter(x => x.type === 'wave-tick').pop();
                if (!m || m.tick !== rep.tick || JSON.stringify(m.fired) !== JSON.stringify(rep.fired)) tickErr = `tick ${rep.tick}`;
                if (m && rep.tick % 6 === 0 && JSON.stringify(m.state) !== JSON.stringify(ref.marking())) tickErr = `marking at tick ${rep.tick}`;
            }
        }
        const ticks = posted.filter(x => x.type === 'wave-tick');
        check('worklet: the queued load / play / tempo took effect and the audio equals the loader\'s', diff === 0 && ticksPosted > 10, `max |d| ${diff}`);
        check('worklet: posts one wave-tick per tick, with fires, markings and the audio-thread time',
            ticks.length === ticksPosted && !tickErr && ticks.every(t => typeof t.t === 'number' && Array.isArray(t.fired)),
            `${ticks.length} ticks${tickErr ? ', ' + tickErr : ''}`);
        check('worklet: no error was posted', !posted.some(x => x.type === 'error'), JSON.stringify(posted.filter(x => x.type === 'error')));

        // The synchronous path: a compiled Module in processorOptions, project + play at construction
        // (what an OfflineAudioContext needs: ready before the first quantum, no message round trip).
        {
            const before = posted.length;
            const q = new registered.cls({ processorOptions: { module: new WebAssembly.Module(wasmBytes), project, play: true, tempo: 128 } });
            const readyNow = posted.slice(before).some(m => m.type === 'ready');
            const o2 = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
            const r2 = await instantiate(wasmBytes);
            r2.init(48000); r2.load(project); r2.setTempo(128); r2.play();
            let d2 = 0, any = false;
            for (let b = 0; b < 400; b++) {
                q.process([], [o2]); r2.process(BLOCK);
                const [l, r] = r2.blocks(BLOCK);
                for (let i = 0; i < BLOCK; i++) { d2 = Math.max(d2, Math.abs(o2[0][i] - l[i]), Math.abs(o2[1][i] - r[i])); if (o2[0][i] !== 0) any = true; }
            }
            check('worklet: a compiled Module in processorOptions is ready at construction and plays from the first quantum',
                readyNow && any && d2 === 0, `ready in constructor: ${readyNow}, max |d| ${d2}`);
        }

        // A bad project is reported and does not stop the audio.
        p.port.onmessage({ data: { type: 'load', json: '{ not json' } });
        const err = posted.filter(x => x.type === 'error').pop();
        p.process([], [out]);
        check('worklet: a bad project posts an error and the engine keeps playing', !!err && err.op === 'load' && out[0].some(v => v !== 0), err && err.message);
    } finally {
        Object.assign(globalThis, saved);
        delete globalThis.AudioWorkletProcessor; delete globalThis.registerProcessor;
        delete globalThis.sampleRate; delete globalThis.currentTime;
    }
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
