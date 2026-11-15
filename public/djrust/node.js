/**
 * node.js — page-side handle on the 'djrust-engine' AudioWorklet.
 *
 *   const dj = await createDjrustEngine(audioContext, connectTo);
 *   dj.post({type:'load', project}); dj.post({type:'transport', action:'play'});
 *   dj.onmessage = (msg) => { ... };
 *
 * Same handle shape as wave-engine/node.js (`node`, `onmessage`, `post`, `dispose`), plus
 * `info` (what the module said about itself). The returned promise rejects, with the node
 * already disconnected, when the module cannot be fetched, compiled or started; the caller
 * (lib/backend/wave.js) falls back to the JS wave engine.
 *
 * `opts.processorOptions` is passed to the processor ({project, play, tempo, quiet}: load and
 * start at construction, for offline renders).
 *
 * Where djwasm.wasm comes from: the pinned `djwasm` npm version on jsDelivr, fetched with its SRI
 * hash (pin.js), so pflow.dev never builds Rust. When that fails (offline, CDN down, a hash
 * mismatch) a local build beside this file is tried (`make djrust-wasm`, git-ignored; same
 * origin). `opts.wasmUrl` replaces both (`?djrust-wasm=URL` on the page sets it, which the
 * browser test uses to prove the fallback). `handle.wasmSource` says which one loaded.
 */

import PIN from './pin.js';

const READY_TIMEOUT_MS = 10000;

async function fetchWasm(override) {
    const tries = override
        ? [{ url: override, init: { cache: 'no-cache' }, source: 'override' }]
        : [
            { url: PIN.url, init: { integrity: PIN.integrity, mode: 'cors', credentials: 'omit' }, source: `cdn djwasm@${PIN.version}` },
            { url: new URL('./djwasm.wasm', import.meta.url), init: { cache: 'no-cache' }, source: 'local' },
        ];
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

const compiled = new Map(); // override URL ('' = the pin) → Promise<{module, source}>

/**
 * The djwasm module, fetched (same sources and order as createDjrustEngine) and compiled once
 * per page: later calls with the same `override` share the promise. A failure is not cached, so
 * a retry fetches again. For callers that want the engine off the audio graph or in several
 * contexts (the benchmark: worklet cases and a main-thread DSP case on one compile).
 * createDjrustEngine keeps its own fetch: its fallback transfers the bytes to the worklet.
 */
export function loadDjwasmModule(override) {
    const key = override ? String(override) : '';
    let p = compiled.get(key);
    if (!p) {
        p = fetchWasm(override || undefined)
            .then(async ({ bytes, source }) => ({ module: await WebAssembly.compile(bytes), source }));
        p.catch(() => { if (compiled.get(key) === p) compiled.delete(key); });
        compiled.set(key, p);
    }
    return p;
}

export async function createDjrustEngine(ctx, connectTo, opts = {}) {
    // Fetch before touching the audio graph: a missing module costs nothing then.
    const { bytes, source } = await fetchWasm(opts.wasmUrl);

    await ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
    const make = (processorOptions) => new AudioWorkletNode(ctx, 'djrust-engine', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions,
    });
    // Preferred: compile here and hand the worklet a Module, ready before its first quantum
    // (an OfflineAudioContext needs that). A browser that will not clone a Module into a worklet
    // gets the bytes in a message and compiles there.
    let node, viaModule = false;
    try {
        node = make({ module: await WebAssembly.compile(bytes), ...(opts.processorOptions || {}) });
        viaModule = true;
    } catch (err) {
        node = make(opts.processorOptions || {});
    }
    const handle = {
        node,
        info: null,
        features: null,
        flags: null,
        viaModule,
        wasmSource: source,
        onmessage: null,
        post(msg) { node.port.postMessage(msg); },
        dispose() { try { node.disconnect(); } catch {} node.port.onmessage = null; },
    };

    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('djrust engine did not start')), READY_TIMEOUT_MS);
        node.port.onmessage = (e) => {
            const m = e.data;
            if (m.type === 'ready') {
                clearTimeout(timer);
                handle.info = m.info;
                // The running module's djw_features / init flags (absent on djwasm 0.2.0's worklet).
                handle.features = Number.isInteger(m.features) ? m.features : null;
                handle.flags = Number.isInteger(m.flags) ? m.flags : null;
                resolve();
            }
            else if (m.type === 'error' && !handle.info) { clearTimeout(timer); reject(new Error(m.message)); }
            else if (handle.onmessage) handle.onmessage(m);
        };
        if (!viaModule) node.port.postMessage({ type: 'wasm', bytes }, [bytes]);
    }).catch((err) => { handle.dispose(); throw err; });

    // From here on every message goes to the page's handler.
    node.port.onmessage = (e) => { if (handle.onmessage) handle.onmessage(e.data); };
    if (connectTo) connectTo(node);
    else node.connect(ctx.destination);
    return handle;
}
