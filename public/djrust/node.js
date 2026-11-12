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
 * start at construction, for offline renders). `opts.wasmUrl` overrides where djwasm.wasm comes
 * from (default: beside this file; `?djrust-wasm=URL` on the page sets it, which the browser
 * test uses to prove the fallback).
 */

const READY_TIMEOUT_MS = 10000;

export async function createDjrustEngine(ctx, connectTo, opts = {}) {
    const url = opts.wasmUrl || new URL('./djwasm.wasm', import.meta.url);
    // Fetch before touching the audio graph: a missing module costs nothing then.
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`djwasm.wasm: HTTP ${res.status} (build it: make djrust-wasm)`);
    const bytes = await res.arrayBuffer();

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
        viaModule,
        onmessage: null,
        post(msg) { node.port.postMessage(msg); },
        dispose() { try { node.disconnect(); } catch {} node.port.onmessage = null; },
    };

    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('djrust engine did not start')), READY_TIMEOUT_MS);
        node.port.onmessage = (e) => {
            const m = e.data;
            if (m.type === 'ready') { clearTimeout(timer); handle.info = m.info; resolve(); }
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
