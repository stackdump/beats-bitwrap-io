// Test capture hooks — only loaded when the URL has ?test=1.
//
// Installs:
//   window.__pnTestCaptureStart()  record the audio host's master (the djrust worklet after master
//                                  volume) through a capture AudioWorklet tap: lossless f32, no
//                                  encoder in between (the MediaRecorder → decodeAudioData path it
//                                  replaces smeared transients). Resolves once the tap has rendered
//                                  its first quantum, which is capture frame 0.
//   window.__pnTestMark(label)     the capture frame now (from the context clock), recorded as a
//                                  mark; synchronous, so `mark(); el._fireMacro(…)` anchors a fire.
//   window.__pnTestEvents()        what the engine has said since capture start: macro-fired /
//                                  macro-skipped / macro-restored / engine-tempo / seeked, and each
//                                  wave-tick macroMask change, each with the capture frame it
//                                  arrived at (late by the port latency, a few ms).
//   window.__pnTestCaptureStop()   → {sampleRate, length, data, marks, events}: data is a base64
//                                  Float32Array, mono (L+R)/2, from capture frame 0.
//
// Used by scripts/test-macro-audio.py (make test-audio) and any headless check that needs the
// page's actual output. The tap's output is silence; it is connected to the destination only so
// the context keeps pulling it.

import { audioHost } from '../audio/host.js';

const CAPTURE_PROCESSOR = `
class PnTestCapture extends AudioWorkletProcessor {
    constructor() {
        super();
        this.on = true;
        this.frames = 0;
        this.started = false;
        this.chunk = 128 * 64;
        this.buf = new Float32Array(this.chunk);
        this.fill = 0;
        this.offset = 0;
        this.port.onmessage = (e) => {
            if (e.data && e.data.type === 'stop') {
                this.flush();
                this.on = false;
                this.port.postMessage({ type: 'stopped', frames: this.frames });
            }
        };
    }
    flush() {
        if (!this.fill) return;
        const data = this.buf.slice(0, this.fill);
        this.port.postMessage({ type: 'chunk', offset: this.offset, data }, [data.buffer]);
        this.offset += this.fill;
        this.fill = 0;
    }
    process(inputs, outputs) {
        if (!this.on) return false;
        const inp = inputs[0] || [];
        const L = inp[0], R = inp[1] || inp[0];
        const n = outputs[0] && outputs[0][0] ? outputs[0][0].length : 128;
        if (!this.started) { this.started = true; this.port.postMessage({ type: 'started', startFrame: currentFrame }); }
        for (let i = 0; i < n; i++) {
            this.buf[this.fill++] = L ? 0.5 * (L[i] + R[i]) : 0;
            if (this.fill === this.chunk) this.flush();
        }
        this.frames += n;
        return true;
    }
}
registerProcessor('pn-test-capture', PnTestCapture);
`;

(function installTestHooks() {
    if (typeof window === 'undefined') return;

    let cap = null;     // { node, ctx, startFrame, chunks, marks, events, unhook }
    let moduleAdded = null;

    const frameNow = () => (cap ? Math.round(cap.ctx.currentTime * cap.ctx.sampleRate) - cap.startFrame : -1);

    // Listen to the engine handle without taking it over: chain onto its onmessage.
    async function hookEngine(log) {
        const el = document.querySelector('petri-note');
        const w = el && el._wave ? await el._wave.catch(() => null) : null;
        if (!w) return () => {};
        const orig = w.onmessage;
        let lastMask = 0;
        w.onmessage = (m) => {
            try {
                if (m && (/^macro-/.test(m.type) || m.type === 'engine-tempo' || m.type === 'seeked')) {
                    log.push({ type: m.type, id: m.id, source: m.source, result: m.result, tick: m.tick, bpm: m.bpm, frame: frameNow() });
                } else if (m && m.type === 'wave-tick' && typeof m.macroMask === 'number' && m.macroMask !== lastMask) {
                    lastMask = m.macroMask;
                    log.push({ type: 'mask', mask: m.macroMask, tick: m.tick, frame: frameNow() });
                }
            } catch { /* never let the test hook break playback */ }
            return orig && orig(m);
        };
        return () => { if (w.onmessage !== orig) w.onmessage = orig; };
    }

    window.__pnTestCaptureStart = async function () {
        if (cap) return;
        await audioHost.init();
        const ctx = audioHost.getContext();
        if (!moduleAdded) {
            const url = URL.createObjectURL(new Blob([CAPTURE_PROCESSOR], { type: 'text/javascript' }));
            moduleAdded = ctx.audioWorklet.addModule(url);
        }
        await moduleAdded;
        const node = new AudioWorkletNode(ctx, 'pn-test-capture', {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit',
        });
        const chunks = [];
        let started;
        const startedP = new Promise((r) => (started = r));
        let stopped;
        const stoppedP = new Promise((r) => (stopped = r));
        node.port.onmessage = (e) => {
            const m = e.data;
            if (m.type === 'chunk') chunks.push(m);
            else if (m.type === 'started') started(m.startFrame);
            else if (m.type === 'stopped') stopped(m.frames);
        };
        const events = [], marks = [];
        cap = { node, ctx, startFrame: 0, chunks, marks, events, stoppedP, unhook: () => {} };
        audioHost.output.connect(node);
        node.connect(ctx.destination);
        cap.startFrame = await startedP;
        cap.unhook = await hookEngine(events);
    };

    window.__pnTestMark = function (label) {
        const frame = frameNow();
        if (cap) cap.marks.push({ label: String(label), frame });
        return frame;
    };

    window.__pnTestEvents = function () { return cap ? cap.events.slice() : []; };

    window.__pnTestCaptureStop = async function () {
        if (!cap) return null;
        const c = cap;
        cap = null;
        c.unhook();
        c.node.port.postMessage({ type: 'stop' });
        const frames = await c.stoppedP;
        try { audioHost.output.disconnect(c.node); } catch {}
        try { c.node.disconnect(); } catch {}
        const mono = new Float32Array(frames);
        for (const ch of c.chunks) mono.set(ch.data.subarray(0, Math.max(0, Math.min(ch.data.length, frames - ch.offset))), ch.offset);

        // String.fromCharCode(...largeArray) blows the call stack on
        // multi-MB buffers. Chunk through 32k bytes at a time.
        const u8 = new Uint8Array(mono.buffer);
        const CHUNK = 32768;
        let bin = '';
        for (let i = 0; i < u8.length; i += CHUNK) {
            bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
        }
        return { sampleRate: c.ctx.sampleRate, length: mono.length, data: btoa(bin), marks: c.marks, events: c.events };
    };

    window.__pnTestHooksLoaded = true;
})();
