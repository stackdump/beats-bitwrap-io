// Test capture hooks — only loaded when the URL has ?test=1.
//
// Installs window.__pnTestCaptureStart() / __pnTestCaptureStop() which tap the engine's master
// output (djrust's worklet → master gain) with a MediaRecorder, then decode the encoded blob back
// to PCM in-browser via decodeAudioData. PCM is shipped to Python as base64-encoded
// Float32Array.
//
// Used by scripts/test-macro-audio.py to render clips while firing macros at known timestamps,
// then ship the PCM back to Python for spectral / RMS analysis.

import { audioEngine } from '../audio/engine.js';

(function installTestHooks() {
    if (typeof window === 'undefined') return;

    let rec = null; // { recorder, dest, chunks }

    window.__pnTestCaptureStart = async function () {
        if (rec) return;
        await audioEngine.init();
        const dest = audioEngine.ctx.createMediaStreamDestination();
        audioEngine.output.connect(dest);
        const recorder = new MediaRecorder(dest.stream);
        const chunks = [];
        recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        recorder.start();
        rec = { recorder, dest, chunks };
    };

    window.__pnTestCaptureStop = async function () {
        if (!rec) return null;
        const { recorder, dest, chunks } = rec;
        rec = null;
        const stopped = new Promise((resolve) => { recorder.onstop = () => resolve(); });
        if (recorder.state !== 'inactive') recorder.stop();
        await stopped;
        try { audioEngine.output.disconnect(dest); } catch {}
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });

        // Decode the encoded blob to raw PCM via the page's AudioContext.
        const buf = await blob.arrayBuffer();
        const audio = await audioEngine.ctx.decodeAudioData(buf.slice(0));
        const ch0 = audio.getChannelData(0);
        const ch1 = audio.numberOfChannels > 1 ? audio.getChannelData(1) : ch0;
        const n = ch0.length;
        const mono = new Float32Array(n);
        for (let i = 0; i < n; i++) mono[i] = 0.5 * (ch0[i] + ch1[i]);

        // String.fromCharCode(...largeArray) blows the call stack on
        // multi-MB buffers. Chunk through 32k bytes at a time.
        const u8 = new Uint8Array(mono.buffer);
        const CHUNK = 32768;
        let bin = '';
        for (let i = 0; i < u8.length; i += CHUNK) {
            bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
        }
        return {
            sampleRate: audio.sampleRate,
            length: mono.length,
            data: btoa(bin),
        };
    };

    window.__pnTestHooksLoaded = true;
})();
