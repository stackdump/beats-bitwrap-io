// A turntable: reads a looped buffer at a variable, signed rate with linear
// interpolation. Runs in the audio thread so the rate is updated per sample —
// main-thread jitter in MIDI delivery changes *when* a position target
// arrives, never the smoothness of the sound.
//
// Two modes:
//   play   rate eases toward (playing ? 1 + nudge : 0) — motor spin-up/brake
//   scrub  rate = (target - pos) / chaseTau — the platter follows the hand
//
// `pos` is unwrapped (it can go negative or past the loop) so the main thread
// can derive how many whole ticks were crossed in either direction.

class JogScrub extends AudioWorkletProcessor {
    constructor() {
        super();
        this.channels = null;
        this.length = 0;
        this.pos = 0;
        this.rate = 0;
        this.target = 0;
        this.mode = 'play';
        this.playing = false;
        this.nudge = 0;
        this.chaseTau = 0.035 * sampleRate;
        this.rateSmooth = 1 - Math.exp(-1 / (0.004 * sampleRate));
        this.motorSmooth = 1 - Math.exp(-1 / (0.045 * sampleRate));
        this.maxRate = 12;
        this.sinceReport = 0;
        this.port.onmessage = (e) => this.onMessage(e.data);
    }

    onMessage(m) {
        switch (m.type) {
            case 'load':
                this.channels = m.channels;
                this.length = m.channels[0].length;
                this.pos = 0;
                this.target = 0;
                break;
            case 'transport': this.playing = m.playing; break;
            case 'freeze': this.mode = 'scrub'; this.target = this.pos; break;
            case 'scrub': this.target += m.samples; break;
            case 'release': this.mode = 'play'; break;
            case 'nudge': this.nudge = m.value; break;
            case 'chase': this.chaseTau = Math.max(0.002, m.seconds) * sampleRate; break;
        }
    }

    process(_inputs, outputs) {
        const out = outputs[0];
        if (!this.channels) return true;
        const n = out[0].length;
        const len = this.length;
        for (let i = 0; i < n; i++) {
            if (this.mode === 'scrub') {
                let want = (this.target - this.pos) / this.chaseTau;
                if (want > this.maxRate) want = this.maxRate;
                else if (want < -this.maxRate) want = -this.maxRate;
                this.rate += (want - this.rate) * this.rateSmooth;
            } else {
                const want = this.playing ? 1 + this.nudge : 0;
                this.rate += (want - this.rate) * this.motorSmooth;
            }
            this.pos += this.rate;

            let p = this.pos % len;
            if (p < 0) p += len;
            const i0 = p | 0;
            const i1 = i0 + 1 === len ? 0 : i0 + 1;
            const f = p - i0;
            for (let c = 0; c < out.length; c++) {
                const ch = this.channels[c < this.channels.length ? c : 0];
                out[c][i] = ch[i0] + (ch[i1] - ch[i0]) * f;
            }
        }
        this.sinceReport += n;
        if (this.sinceReport >= 512) {
            this.sinceReport = 0;
            this.port.postMessage({ pos: this.pos, rate: this.rate });
        }
        return true;
    }
}

registerProcessor('jog-scrub', JogScrub);
