// Physical model of one jog wheel: turns hand motion (touch, rotate, flick)
// into the byte stream the profile says the hardware emits, and pushes it
// into a MockMIDIInput. No DOM, no timers — the caller supplies time, so the
// same code runs under node --test.
//
// What is modelled, because each changes what the adapter has to cope with:
//
// - An incremental encoder. Rotation accumulates as a fraction of a tick and
//   a message is emitted for every whole tick crossed; slow motion yields
//   sparse messages, fast motion yields hundreds per second. There is no
//   fixed message rate.
// - USB framing. Arrival times are interpolated across the motion and then
//   quantized up to the next 1 ms frame; ticks landing in one frame share a
//   timestamp (or, if profile.maxMagnitude > 1, merge into one message).
// - Touch decides the CC. Top surface touched -> scratch CC; otherwise bend.
// - Inertia. Let go of a spinning platter and it keeps turning: touch
//   releases first, then the coasting wheel emits BEND ticks until friction
//   stops it. Touching it again stops it dead.

import { encodeRelative } from './inpulse-200-mk3.js';

const TWO_PI = Math.PI * 2;

export class JogWheelSim {
    constructor(input, profile, { deck = 'A' } = {}) {
        this.input = input;
        this.profile = profile;
        this.deck = deck;
        this.shift = false;
        this.touching = false;
        this.omega = 0;          // coasting speed, rad/s
        this._tickAcc = 0;       // fractional encoder ticks not yet emitted
        this._lastStep = null;
    }

    _status(type) {
        const ch = this.profile.decks[this.deck] + (this.shift ? this.profile.shiftChannelOffset : 0);
        return type | ch;
    }

    touch(down, t = performance.now()) {
        if (down === this.touching) return;
        this.touching = down;
        if (down) this.omega = 0;
        const { note, onVelocity, releaseAsNoteOff } = this.profile.touch;
        if (down) this.input.receive([this._status(0x90), note, onVelocity], t);
        else if (releaseAsNoteOff) this.input.receive([this._status(0x80), note, 0x00], t);
        else this.input.receive([this._status(0x90), note, 0x00], t);
    }

    // The wheel turned by deltaRad (clockwise positive) between t0 and t1 (ms).
    rotate(deltaRad, t0, t1) {
        const p = this.profile;
        const before = this._tickAcc;
        const after = before + (deltaRad / TWO_PI) * p.ticksPerRev;
        const n = Math.trunc(after);
        this._tickAcc = after - n;
        if (n === 0) return;

        const dir = Math.sign(n);
        const cc = this.touching ? p.scratchCC : p.bendCC;
        const status = this._status(0xB0);

        // The accumulator moved linearly from `before` to `after`; tick i is
        // emitted when it crosses dir*i. Quantize each crossing to a USB frame.
        const frames = new Map();
        for (let i = 1; i <= Math.abs(n); i++) {
            const frac = (dir * i - before) / (after - before);
            const t = t0 + (t1 - t0) * frac;
            const frame = Math.ceil(t / p.usbFrameMs) * p.usbFrameMs;
            frames.set(frame, (frames.get(frame) || 0) + 1);
        }
        for (const [frame, count] of frames) {
            let left = count;
            while (left > 0) {
                const mag = Math.min(left, p.maxMagnitude);
                this.input.receive([status, cc, encodeRelative(dir * mag, p.encoding)], frame);
                left -= mag;
            }
        }
    }

    // Hand leaves a moving platter.
    fling(omegaRadPerSec) {
        if (!this.touching) this.omega = omegaRadPerSec;
    }

    // Advance free-spin physics. Call once per animation frame.
    step(now = performance.now()) {
        const last = this._lastStep ?? now;
        this._lastStep = now;
        if (this.omega === 0) return;
        const dt = Math.min(0.05, (now - last) / 1000);
        if (dt <= 0) return;
        this.rotate(this.omega * dt, last, now);
        this.omega *= Math.exp(-dt / this.profile.coastTauSec);
        if (Math.abs(this.omega) < 0.4) this.omega = 0;
    }
}
