// djrust's offline render on the page's main thread: no AudioContext, deterministic for one
// engine version (the same blocks and housekeeping cadence as the worklet), about 8× faster than
// realtime. Used by ?render=offline and the counter-melody insert render; the live studio and
// ?render=1 capture the worklet instead.

import { djrustBase } from '../backend/djrust.js';

let mod = null;

/** The djrust glue, initialised (once). */
export function djrustModule() {
    if (mod) return mod;
    mod = (async () => {
        const base = djrustBase();
        const glue = await import(/* @vite-ignore */ base + 'djrust.js');
        let module;
        try { module = await WebAssembly.compileStreaming(fetch(base + 'djrust_bg.wasm')); }
        catch {
            const r = await fetch(base + 'djrust_bg.wasm');
            if (!r.ok) throw new Error(`djrust_bg.wasm: ${r.status}`);
            module = await WebAssembly.compile(await r.arrayBuffer());
        }
        glue.initSync({ module });
        if (typeof glue.render_offline !== 'function') {
            throw new Error(`djrust ${glue.engine_version?.() || '?'} has no render_offline`);
        }
        return glue;
    })();
    mod.catch(() => { mod = null; });
    return mod;
}

/** Interleaved stereo f32 of `seconds` of a share envelope or beats project (JSON text). */
export async function renderOffline(text, seconds, sampleRate = 48000) {
    const dj = await djrustModule();
    return { samples: dj.render_offline(text, seconds, sampleRate), version: dj.engine_version() };
}

/** 16-bit PCM stereo WAV of interleaved f32 samples. */
export function encodeWav(interleaved, sampleRate) {
    const frames = interleaved.length / 2;
    const buf = new ArrayBuffer(44 + frames * 4);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + frames * 4, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 4, true);
    v.setUint16(32, 4, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, frames * 4, true);
    let o = 44;
    for (let i = 0; i < interleaved.length; i++, o += 2) {
        const x = Math.max(-1, Math.min(1, interleaved[i]));
        v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
}
