#!/usr/bin/env node
//
// djrust-script.mjs — the four quantum-keyed live scripts, replayed in Node.
//
//   node scripts/djrust-script.mjs [--wasm P] [--worklet] [--schedule JSON] [name ...]
//        print "<name> direct <sha>" (and "<name> worklet <sha>" with --worklet) per script;
//        no names = all four. --schedule replaces each step's q: {"<name>": [q0, q1, ...]}.
//   node scripts/djrust-script.mjs --export <name>      the script as JSON (text + steps)
//   node scripts/djrust-script.mjs --props [--wasm P]   the measured script properties
//
// A script is {name, sr, blocks, text, steps:[{q, msg}]}. `msg` is a worklet-protocol message
// (public/djrust/worklet.js): {type:'load', json}, {type:'tempo', bpm}, {type:'mute', netId,
// muted} or {type:'transport', action}. It is applied before quantum q, at a 128-frame
// boundary. Every step uses only ABI-1 messages, so djwasm 0.2.0 plays all of them.
//
// The sha is the golden's audio hash: interleaved little-endian f32 L,R over blocks × 128
// frames. Two Node renderers are here:
//   direct   loader.js on the calling thread (djrust-golden.mjs renderCase);
//   worklet  the module's worklet.js, run in Node with TextEncoder/TextDecoder deleted, as in an
//            AudioWorkletGlobalScope. It gets the compiled Module in processorOptions, and the
//            step messages through port.onmessage before process() of quantum q.
// The two browser renderers (OfflineAudioContext and a live AudioContext through
// scripts/fixtures/capture-worklet.js) are in test-djrust-browser.mjs.
//
// SENTINEL: `{type:'load', json:'{'}` makes the 0.2.0 worklet post {type:'error', op:'load'}
// and keep its project. Port messages are ordered, so that error confirms every earlier
// message was applied. The browser renderers post it after each step's messages while the
// context is suspended, then resume. A failed load is state-neutral; --props measures that.

import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import {
    BLOCK, resolveModule, renderCase, composeProject, applyMsg, newEngine,
} from './djrust-golden.mjs';

export const SENTINEL = Object.freeze({ type: 'load', json: '{' });

// name → {base: [genre, seed, structure], blocks, steps: [{q, msg}]}. 3000 blocks = 8 s at 48 kHz.
const DEFS = {
    tempo: {
        base: ['techno', 42, 'standard'], blocks: 3000,
        steps: [{ q: 600, msg: { type: 'tempo', bpm: 140 } }, { q: 1800, msg: { type: 'tempo', bpm: 96 } }],
    },
    mute: {
        base: ['techno', 42, 'standard'], blocks: 3000,
        steps: [
            { q: 400, msg: { type: 'mute', netId: 'kick-0', muted: true } },
            { q: 400, msg: { type: 'mute', netId: 'kick-1', muted: true } },
            { q: 900, msg: { type: 'mute', netId: 'snare', muted: true } },
            { q: 1500, msg: { type: 'mute', netId: 'kick-0', muted: false } },
            { q: 1500, msg: { type: 'mute', netId: 'kick-1', muted: false } },
            { q: 2200, msg: { type: 'mute', netId: 'snare', muted: false } },
        ],
    },
    swap: {
        // The load is queued by the engine and takes over at the next bar.
        base: ['techno', 42, 'standard'], blocks: 3000,
        steps: [{ q: 700, msg: { type: 'load', project: ['house', 9, 'standard'] } }],
    },
    transport: {
        base: ['techno', 42, 'loop'], blocks: 3000,
        steps: [
            { q: 800, msg: { type: 'transport', action: 'pause' } },
            { q: 900, msg: { type: 'transport', action: 'play' } },
            { q: 1700, msg: { type: 'transport', action: 'stop' } },
            { q: 1800, msg: { type: 'transport', action: 'play' } },
            { q: 2500, msg: { type: 'transport', action: 'pause' } },
            { q: 2550, msg: { type: 'transport', action: 'play' } },
        ],
    },
};
export const SCRIPT_NAMES = Object.keys(DEFS);
export const SCRIPT_SR = 48000;

const cache = new Map();
/** The script with its projects composed: {name, sr, blocks, text, steps:[{q, msg}]} (msgs JSON-safe). */
export function buildScript(name) {
    if (cache.has(name)) return cache.get(name);
    const d = DEFS[name];
    if (!d) throw new Error(`no script ${name} (have ${SCRIPT_NAMES.join(', ')})`);
    const text = JSON.stringify(composeProject(...d.base));
    const steps = d.steps.map(({ q, msg }) => {
        if (msg.type === 'load') return { q, msg: { type: 'load', json: JSON.stringify(composeProject(...msg.project)) } };
        return { q, msg: { ...msg } };
    });
    const s = { name, sr: SCRIPT_SR, blocks: d.blocks, text, steps };
    cache.set(name, s);
    return s;
}

/**
 * The same script on another schedule: `qs` gives the new q of each step in order (the live
 * renderer cannot land a message on a chosen quantum, so it reports where each one landed).
 */
export function withSchedule(s, qs) {
    if (!qs) return s;
    if (qs.length !== s.steps.length) throw new Error(`schedule for ${s.name}: ${qs.length} q for ${s.steps.length} steps`);
    return { ...s, steps: s.steps.map((st, i) => ({ q: qs[i], msg: st.msg })) };
}

const asCase = (s) => ({ id: `script:${s.name}`, blocks: s.blocks, seconds: {}, build: () => ({ text: s.text, steps: s.steps }) });

/** Node direct: the golden's renderer. → {audio, ticks, report, marking, muted, ...} */
export function renderScriptDirect(mod, s, opts = {}) {
    return renderCase(mod, asCase(s), s.sr, opts);
}

/**
 * Node direct with SENTINEL applied after each step group, as the browser renderers post it.
 * renderCase applies a quantum's steps before calling atQuantum, so the hook runs after them.
 */
function renderScriptDirectWithSentinel(mod, s) {
    const qs = new Set(s.steps.map((st) => st.q));
    return renderScriptDirect(mod, s, {
        hooks: {
            atQuantum(dj, q) {
                if (!qs.has(q)) return;
                let threw = false;
                try { dj.load(SENTINEL.json); } catch { threw = true; }
                if (!threw) throw new Error('the sentinel load was accepted: it is no longer an ack');
            },
        },
    });
}

let workletCls = null;
const workletFor = new Map();
/** Load a worklet.js into Node once, with the AudioWorkletGlobalScope stand-ins. */
async function workletClass(mod) {
    if (workletFor.has(mod.workletPath)) return workletFor.get(mod.workletPath);
    globalThis.AudioWorkletProcessor = class { constructor() { this.port = { onmessage: null, postMessage: (m) => this.port._posted.push(m), _posted: [] }; } };
    globalThis.registerProcessor = (name, cls) => { workletCls = { name, cls }; };
    await import(pathToFileURL(mod.workletPath).href);
    delete globalThis.registerProcessor;
    workletFor.set(mod.workletPath, workletCls);
    return workletCls;
}

/** Node worklet: worklet.js with TextEncoder/TextDecoder deleted. → {audio, frames, errors} */
export async function renderScriptWorklet(mod, s) {
    const { cls } = await workletClass(mod);
    const saved = { TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder };
    globalThis.sampleRate = s.sr;
    globalThis.currentTime = 0;
    delete globalThis.TextEncoder; delete globalThis.TextDecoder;
    try {
        const p = new cls({ processorOptions: { module: mod.module, json: s.text, play: true, quiet: true } });
        const posted = p.port._posted;
        if (!posted.some((m) => m.type === 'ready')) throw new Error(`worklet not ready: ${JSON.stringify(posted)}`);
        const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK), inter = new Float32Array(2 * BLOCK);
        const h = createHash('sha256');
        const steps = s.steps.slice().sort((a, b) => a.q - b.q);
        let si = 0;
        for (let q = 0; q < s.blocks; q++) {
            while (si < steps.length && steps[si].q <= q) p.port.onmessage({ data: steps[si++].msg });
            globalThis.currentTime = q * BLOCK / s.sr;
            p.process([], [[L, R]]);
            for (let i = 0; i < BLOCK; i++) { inter[2 * i] = L[i]; inter[2 * i + 1] = R[i]; }
            h.update(new Uint8Array(inter.buffer));
        }
        return { audio: h.digest('hex'), frames: s.blocks * BLOCK, errors: posted.filter((m) => m.type === 'error') };
    } finally {
        Object.assign(globalThis, saved);
        delete globalThis.sampleRate; delete globalThis.currentTime;
    }
}

/** What djrust-golden.mjs make records about the scripts. */
export async function measureScriptProperties(mod) {
    const out = { scripts: {}, summary: { workletEqualsDirect: true, sentinelNeutral: true } };
    for (const name of SCRIPT_NAMES) {
        const s = buildScript(name);
        const direct = renderScriptDirect(mod, s).audio;
        const worklet = (await renderScriptWorklet(mod, s)).audio;
        const sentinel = renderScriptDirectWithSentinel(mod, s).audio;
        out.scripts[name] = { direct, worklet, sentinel, steps: s.steps.map((st) => st.q) };
        if (worklet !== direct) out.summary.workletEqualsDirect = false;
        if (sentinel !== direct) out.summary.sentinelNeutral = false;
    }
    return out;
}

// --- CLI -------------------------------------------------------------------------------------

async function main(argv) {
    const a = { names: [] };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--wasm') a.wasm = argv[++i];
        else if (k === '--worklet') a.worklet = true;
        else if (k === '--schedule') a.schedule = JSON.parse(argv[++i]);
        else if (k === '--export') a.export = argv[++i];
        else if (k === '--props') a.props = true;
        else a.names.push(k);
    }
    if (a.export) { process.stdout.write(JSON.stringify(buildScript(a.export)) + '\n'); return 0; }
    const mod = await resolveModule(a.wasm || process.env.DJRUST_WASM);
    if (!mod) { console.error('djrust-script: no module (make djrust-wasm, or --wasm / DJRUST_WASM)'); return 2; }
    if (a.props) { console.log(JSON.stringify(await measureScriptProperties(mod), null, 1)); return 0; }
    for (const name of a.names.length ? a.names : SCRIPT_NAMES) {
        const s = withSchedule(buildScript(name), a.schedule && a.schedule[name]);
        console.log(`${name} direct ${renderScriptDirect(mod, s).audio}`);
        if (a.worklet) console.log(`${name} worklet ${(await renderScriptWorklet(mod, s)).audio}`);
    }
    return 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2)).then((rc) => process.exit(rc), (err) => { console.error(err); process.exit(1); });

export { applyMsg, newEngine };
