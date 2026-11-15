// Scope kernel worker — renders the Scope tab's instrument kernels h_k
// through the djrust engine, off the main thread.
//
// A kernel is one hit of one part: a one-net project whose single
// transition fires once at tick 0 (p0 → t0 → p1, no way back), rendered
// from a fresh djw_init so no earlier kernel's voices, tails or state can
// leak into it. The net carries the lane's channel, instrument, group and
// riff group, because the engine picks the voice from all of them (a
// tonal voice by instrument + group, the drum voice by kit note, part
// shaping and the bass sub-octave by group).
//
// Protocol (module Worker, `new Worker(url, {type: 'module'})`):
//
//   → {type: 'render', id, specs: [{key, inst, channel, note, durMs, group, riffGroup}],
//      wasm?: WebAssembly.Module | ArrayBuffer, wasmUrl?: string}
//   ← {type: 'module', id, source, sha256, info}                       once per module
//   ← {type: 'kernel', id, key, left, right, sha256}  per spec; left/right transferred
//   ← {type: 'done', id, n}
//   ← {type: 'error', id, message}
//
// sha256 of a kernel is over its f32 PCM, left then right, little-endian —
// the same bytes a Node render of kernelProject(spec) through loader.js
// gives (scripts/test-scope-kernels.mjs proves it; test-scope-browser.mjs
// checks the browser's against Node's).
//
// The exports below are the pure parts, importable from Node.

import { instantiate } from '../../djrust/loader.js';
import PIN from '../../djrust/pin.js';
import { wasmTries } from '../../djrust/sources.js';

export const KERNEL_SR = 44100;
export const KERNEL_FRAMES = 32768;     // = scope-model FFT_N: 0.743 s per hit
export const KERNEL_BLOCK = 128;        // a render quantum, as the worklet runs it
export const KERNEL_VELOCITY = 100;

/** The one-net, one-hit project of a kernel spec. */
export function kernelProject(spec) {
    const ch = spec.channel | 0 || 1;
    const track = { channel: ch, defaultVelocity: KERNEL_VELOCITY, instrument: String(spec.inst || '') };
    if (spec.group) track.group = String(spec.group);
    const net = {
        role: 'music',
        track,
        places: { p0: { initial: [1], x: 0, y: 0 }, p1: { initial: [0], x: 60, y: 0 } },
        transitions: {
            t0: { x: 30, y: 0, midi: { note: spec.note | 0, channel: ch, velocity: KERNEL_VELOCITY, duration: Math.round(spec.durMs) || 100 } },
        },
        arcs: [{ source: 'p0', target: 't0', weight: [1] }, { source: 't0', target: 'p1', weight: [1] }],
    };
    if (spec.riffGroup) net.riffGroup = String(spec.riffGroup);
    return { name: 'scope-kernel', tempo: 120, nets: { kernel: net } };
}

/**
 * Render one kernel on `dj` (a loader.js DjWasm): fresh init, load, play,
 * KERNEL_FRAMES frames in KERNEL_BLOCK quanta. Returns planar {left, right}.
 */
export function renderKernel(dj, spec, { sr = KERNEL_SR, frames = KERNEL_FRAMES, block = KERNEL_BLOCK } = {}) {
    dj.init(sr);
    dj.load(kernelProject(spec));
    dj.play();
    const left = new Float32Array(frames), right = new Float32Array(frames);
    for (let o = 0; o < frames; o += block) {
        const n = Math.min(block, frames - o);
        dj.process(n);
        const [l, r] = dj.blocks(n);
        left.set(l, o);
        right.set(r, o);
    }
    dj.stop();
    return { left, right };
}

const hex = (buf) => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');

/** sha256 hex of a kernel's PCM: left f32 bytes then right f32 bytes. */
export async function kernelSha256(left, right) {
    const bytes = new Uint8Array(left.byteLength + right.byteLength);
    bytes.set(new Uint8Array(left.buffer, left.byteOffset, left.byteLength), 0);
    bytes.set(new Uint8Array(right.buffer, right.byteOffset, right.byteLength), left.byteLength);
    return hex(await crypto.subtle.digest('SHA-256', bytes));
}

// --- worker side ---------------------------------------------------------------

// The module, as public/djrust/node.js fetches it: the pinned CDN copy with its
// SRI hash, else the local build beside loader.js; `wasmUrl` replaces both.
async function fetchWasm(override) {
    const tries = wasmTries(PIN, new URL('../../djrust/djwasm.wasm', import.meta.url), override);
    const errs = [];
    for (const t of tries) {
        try {
            const res = await fetch(t.url, t.init);
            if (!res.ok) { errs.push(`${t.source}: HTTP ${res.status}`); continue; }
            return { bytes: await res.arrayBuffer(), source: t.source };
        } catch (err) {
            errs.push(`${t.source}: ${err && err.message || err}`);
        }
    }
    throw new Error(`djwasm.wasm: ${errs.join('; ')}`);
}

let loaded = null;      // { key, dj, source, sha256, info }

async function engineFor(msg) {
    const key = msg.wasm ? 'given' : (msg.wasmUrl || 'pin');
    if (loaded && loaded.key === key && !msg.wasm) return loaded;
    let source, sha256 = null, mod;
    if (msg.wasm instanceof WebAssembly.Module) {
        mod = msg.wasm; source = 'given module';
    } else {
        const got = msg.wasm ? { bytes: msg.wasm, source: 'given bytes' } : await fetchWasm(msg.wasmUrl);
        source = got.source;
        sha256 = hex(await crypto.subtle.digest('SHA-256', got.bytes));
        mod = await WebAssembly.compile(got.bytes);
    }
    const dj = await instantiate(mod);
    loaded = { key, dj, source, sha256, info: dj.info() };
    return loaded;
}

let queue = Promise.resolve();

async function onRender(msg, post) {
    const { id } = msg;
    try {
        const eng = await engineFor(msg);
        post({ type: 'module', id, source: eng.source, sha256: eng.sha256, info: eng.info });
        let n = 0;
        for (const spec of msg.specs || []) {
            const { left, right } = renderKernel(eng.dj, spec);
            const sha256 = await kernelSha256(left, right);
            post({ type: 'kernel', id, key: spec.key, left, right, sha256 }, [left.buffer, right.buffer]);
            n++;
        }
        post({ type: 'done', id, n });
    } catch (err) {
        let message = String(err && err.message || err);
        try { const p = loaded?.dj?.panicMessage(); if (p) message += ` (panic: ${p})`; } catch {}
        post({ type: 'error', id, message });
    }
}

/** Wire the protocol onto a worker scope (exported for the Node test's worker_threads shim). */
export function installKernelWorker(scope) {
    scope.onmessage = (e) => {
        const msg = e.data;
        if (!msg || msg.type !== 'render') return;
        const post = (m, transfer) => scope.postMessage(m, transfer || []);
        queue = queue.then(() => onRender(msg, post));
    };
}

if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope) {
    installKernelWorker(self);
}
