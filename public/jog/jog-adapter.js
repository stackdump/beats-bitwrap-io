// MIDI jog messages -> clock control. The adapter knows the device (through a
// profile) and knows time; it knows nothing about Petri nets or audio. The
// thing it drives is any object with:
//
//   clock.freeze()          touch-on:  hand is on the platter, stop the clock
//   clock.scrubBy(seconds)  rotation while touched: move the playhead by this
//                           much 1x time (negative = backwards)
//   clock.release()         touch-off: clock runs on its own again
//   clock.nudge(ratio)      outer ring: run at (1 + ratio) x; 0 = normal
//
// Scrub is expressed as POSITION deltas, not speed. A wheel returned to the
// angle it started at puts the playhead back where it started, exactly, no
// matter how jittery message delivery was — the same property real vinyl has.
// Turning position into an audible rate is the clock's job (see
// scrub-worklet.js), where it can be done per audio sample.
//
// Usage — identical for mock and real inputs:
//   input.addEventListener('midimessage', adapter.onmidimessage);

import { parseJogMessage, secondsPerTick } from './inpulse-200-mk3.js';

export function createJogAdapter({
    profile,
    clock,
    deck = 'A',
    shiftMultiplier = 4,     // SHIFT + scratch = coarse seek, as in Mixxx/Serato
    bendDepth = 0.10,        // nudge ratio when the ring turns at platter speed
    bendTauSec = 0.15,       // how quickly a nudge dies away once the ring stops
    bendMax = 0.5,
    timerMs = 10,
} = {}) {
    const secPerTick = secondsPerTick(profile);
    // One bend tick adds this much; with exponential decay of bendTauSec the
    // level settles at bendDepth when ticks arrive at platter speed.
    const bendPerTick = bendDepth / (bendTauSec * profile.ticksPerRev * (profile.platterRpm / 60));

    const state = { touching: false, nudge: 0 };
    let lastSent = 0;
    let lastDecay = null;

    function onmidimessage(e) {
        const msg = parseJogMessage(profile, e.data);
        if (!msg || msg.deck !== deck) return;
        switch (msg.kind) {
            case 'touch':
                if (msg.down === state.touching) return;
                state.touching = msg.down;
                if (msg.down) {
                    state.nudge = 0;
                    clock.freeze();
                } else {
                    clock.release();
                }
                break;
            case 'scratch':
                // A scratch CC with no touch means the note-on was missed or
                // the firmware orders them differently than assumed; bending
                // is the safe reading.
                if (!state.touching) { bend(msg.ticks); break; }
                clock.scrubBy(msg.ticks * secPerTick * (msg.shift ? shiftMultiplier : 1));
                break;
            case 'bend':
                bend(msg.ticks);
                break;
        }
    }

    function bend(ticks) {
        state.nudge = Math.max(-bendMax, Math.min(bendMax, state.nudge + ticks * bendPerTick));
    }

    // Bend is a rate, so it needs a time base the message stream does not
    // supply once the ring stops (no messages = no callbacks).
    function decay(now = performance.now()) {
        const dt = lastDecay === null ? 0 : (now - lastDecay) / 1000;
        lastDecay = now;
        state.nudge *= Math.exp(-dt / bendTauSec);
        if (Math.abs(state.nudge) < 1e-4) state.nudge = 0;
        if (state.nudge !== lastSent) {
            lastSent = state.nudge;
            clock.nudge(state.nudge);
        }
    }
    const timer = timerMs > 0 ? setInterval(decay, timerMs) : null;

    return {
        onmidimessage,
        state,
        decay,
        dispose() { if (timer) clearInterval(timer); },
    };
}
