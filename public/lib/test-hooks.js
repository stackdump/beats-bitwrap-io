// Test capture hooks — only loaded when the URL has ?test=1.
//
// Installs window.__pnTestCaptureStart() / __pnTestCaptureStop() which
// tap Tone's master destination via Tone.Recorder (a MediaRecorder
// pipeline behind the scenes), then decode the encoded blob back to
// PCM in-browser via decodeAudioData. PCM is shipped to Python as
// base64-encoded Float32Array.
//
// We use Tone.Recorder rather than constructing an AudioWorkletNode
// directly because Tone v15 wraps the AudioContext in a Proxy that
// (a) doesn't pass `instanceof BaseAudioContext` and (b) tracks node
// origin contexts strictly, so a hand-constructed AudioWorkletNode
// can't be `connect()`ed to Tone.getDestination() without
// InvalidAccessError. Tone.Recorder is the supported path.
//
// Used by scripts/test-macro-audio.py to render deterministic clips
// while firing macros at known timestamps, then ship the PCM back to
// Python for spectral / RMS analysis.

(function installTestHooks() {
    if (typeof window === 'undefined') return;

    let recorder = null;
    let mounted = false;

    window.__pnTestCaptureStart = async function () {
        if (recorder) return;
        if (typeof Tone === 'undefined' || !Tone.Recorder) {
            throw new Error('Tone.Recorder unavailable');
        }
        recorder = new Tone.Recorder();
        Tone.getDestination().connect(recorder);
        mounted = true;
        await recorder.start();
    };

    window.__pnTestCaptureStop = async function () {
        if (!recorder) return null;
        const blob = await recorder.stop();
        try {
            if (mounted) Tone.getDestination().disconnect(recorder);
        } catch {}
        try { recorder.dispose(); } catch {}
        recorder = null;
        mounted = false;

        // Decode the encoded blob to raw PCM via the page's
        // AudioContext (which has decodeAudioData on the Proxy).
        const buf = await blob.arrayBuffer();
        const audio = await Tone.getContext().decodeAudioData(buf.slice(0));
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
