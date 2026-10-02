/**
 * node.js — page-side handle on the 'wave-engine' AudioWorklet.
 *
 *   const wave = await createWaveEngine(audioContext, connectTo);
 *   wave.post({type:'load', project}); wave.post({type:'transport', action:'play'});
 *   wave.onmessage = (msg) => { ... };
 *
 * `connectTo(node)` wires the worklet's output wherever the caller wants
 * (the studio routes it into Tone's master chain).
 */

export async function createWaveEngine(ctx, connectTo) {
    await ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
    const node = new AudioWorkletNode(ctx, 'wave-engine', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    });
    if (connectTo) connectTo(node);
    else node.connect(ctx.destination);
    const handle = {
        node,
        onmessage: null,
        post(msg) { node.port.postMessage(msg); },
        dispose() { try { node.disconnect(); } catch {} node.port.onmessage = null; },
    };
    node.port.onmessage = (e) => { if (handle.onmessage) handle.onmessage(e.data); };
    return handle;
}
