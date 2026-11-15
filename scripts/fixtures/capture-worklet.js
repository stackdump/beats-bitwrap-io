/**
 * capture-worklet.js — AudioWorkletProcessor 'djrust-capture', a test-only passthrough tap.
 *
 * It sits between the 'djrust-engine' node and the destination, and records exactly what the
 * engine rendered, from the engine's first quantum. The output is silence. Create both nodes
 * while the context is suspended, so the tap's first quantum is the engine's first. The tap
 * hashes from engine frame 0 because its frame counter starts at its own first process() call.
 *
 * An AudioWorkletGlobalScope has no crypto, so the tap does not hash. It posts the
 * interleaved little-endian f32 L,R frames to the page in chunks (transferred), and the page
 * hashes them with crypto.subtle. The bytes are exactly what djrust-golden.mjs hashes.
 *
 *   processorOptions {frames: N, chunkBlocks?: 64, collect?: true}
 *   page → tap   {type:'where'}           tap → page {type:'where', frames}  (frames seen so far)
 *   tap → page   {type:'hello', currentFrame}            (from the constructor)
 *                {type:'chunk', offset, data: Float32Array}   (interleaved; offset in frames)
 *                {type:'done', frames, startFrame, quanta: {<length>: count}}
 *
 * `quanta` counts the render-quantum lengths seen. The tri-render asserts it is {128: n}.
 * Test fixture only. It is not served by the app: test-djrust-browser.mjs loads it into the
 * page as a Blob URL.
 */
class DjrustCapture extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const o = (options && options.processorOptions) || {};
        this.limit = o.frames | 0;
        this.collect = o.collect !== false;
        this.chunkFrames = (o.chunkBlocks || 64) * 128;
        this.frames = 0;
        this.startFrame = -1;
        this.quanta = {};
        this.done = false;
        this.buf = this.collect ? new Float32Array(2 * this.chunkFrames) : null;
        this.fill = 0;
        this.bufOffset = 0;
        this.port.onmessage = (e) => {
            if (e.data && e.data.type === 'where') this.port.postMessage({ type: 'where', frames: this.frames });
        };
        this.port.postMessage({ type: 'hello', currentFrame });
    }

    flush() {
        if (!this.collect || this.fill === 0) return;
        const data = this.buf.slice(0, 2 * this.fill);
        this.port.postMessage({ type: 'chunk', offset: this.bufOffset, data }, [data.buffer]);
        this.bufOffset += this.fill;
        this.fill = 0;
    }

    process(inputs) {
        const inp = inputs[0] || [];
        const L = inp[0], R = inp[1] || inp[0];
        const n = L ? L.length : 128;
        if (this.startFrame < 0) this.startFrame = currentFrame;
        this.quanta[n] = (this.quanta[n] || 0) + 1;
        if (!this.done) {
            const take = Math.min(n, this.limit - this.frames);
            if (this.collect) {
                for (let i = 0; i < take; i++) {
                    const j = 2 * this.fill;
                    this.buf[j] = L ? L[i] : 0;
                    this.buf[j + 1] = R ? R[i] : 0;
                    if (++this.fill === this.chunkFrames) this.flush();
                }
            }
            this.frames += n;
            if (this.frames >= this.limit) {
                this.flush();
                this.done = true;
                this.port.postMessage({ type: 'done', frames: this.limit, startFrame: this.startFrame, quanta: this.quanta });
            }
        } else this.frames += n;
        return true;
    }
}

registerProcessor('djrust-capture', DjrustCapture);
