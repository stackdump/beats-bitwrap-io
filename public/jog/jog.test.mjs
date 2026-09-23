// node --test public/jog/jog.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { INPULSE_200_MK3, parseJogMessage, decodeRelative, encodeRelative, secondsPerTick } from './inpulse-200-mk3.js';
import { requestMockMIDIAccess } from './mock-midi.js';
import { JogWheelSim } from './jog-sim.js';
import { createJogAdapter } from './jog-adapter.js';
import { PetriClock, demoNets, LOOP_TICKS } from './petri-clock.js';

const profile = () => structuredClone({ ...INPULSE_200_MK3, match: undefined });

async function rig(p = profile()) {
    const access = await requestMockMIDIAccess({ inputs: [p] });
    const input = [...access.inputs.values()][0];
    const got = [];
    input.addEventListener('midimessage', (e) => got.push({ data: [...e.data], t: e.timeStamp }));
    return { p, input, got, sim: new JogWheelSim(input, p) };
}

test('relative encoding round-trips', () => {
    for (const n of [1, -1, 5, -5, 63, -64]) assert.equal(decodeRelative(encodeRelative(n)), n);
    assert.equal(encodeRelative(-1), 0x7F);
});

test('mock input delivers Web MIDI-shaped events through both handler styles', async () => {
    const { input } = await rig();
    let viaProp = null;
    input.onmidimessage = (e) => { viaProp = e; };
    input.receive([0xB1, 0x0A, 0x01], 1234.5);
    assert.ok(viaProp.data instanceof Uint8Array);
    assert.deepEqual([...viaProp.data], [0xB1, 0x0A, 0x01]);
    assert.equal(viaProp.timeStamp, 1234.5);
    assert.equal(viaProp.target, input);
    assert.equal(viaProp.type, 'midimessage');
    input.onmidimessage = null;
    viaProp = null;
    input.receive([0xB1, 0x0A, 0x01]);
    assert.equal(viaProp, null);
});

test('one touched revolution = ticksPerRev scratch messages of +1, 1 ms-quantized, ordered', async () => {
    const { p, got, sim } = await rig();
    sim.touch(true, 0);
    // a 0.5 s revolution in 8 ms pointer steps
    const steps = 62;
    for (let i = 0; i < steps; i++) sim.rotate((Math.PI * 2) / steps, i * 8.06, (i + 1) * 8.06);
    sim.touch(false, 500);
    assert.deepEqual(got[0].data, [0x91, 0x08, 0x7F]);
    assert.deepEqual(got.at(-1).data, [0x91, 0x08, 0x00]);
    const cc = got.slice(1, -1);
    assert.ok(Math.abs(cc.length - p.ticksPerRev) <= 1, `got ${cc.length}`);
    for (const m of cc) assert.deepEqual(m.data, [0xB1, 0x0A, 0x01]);
    for (let i = 1; i < cc.length; i++) assert.ok(cc[i].t >= cc[i - 1].t);
    for (const m of cc) assert.equal(m.t, Math.round(m.t));
    // rate follows speed: ~2 rev/s * 248 = ~496 msg/s, NOT one per pointer event
    assert.ok(cc.length > steps * 3);
});

test('untouched rotation is bend CC; counter-clockwise is 0x7F; slow motion is sparse', async () => {
    const { got, sim } = await rig();
    sim.rotate(-0.01, 0, 8);           // under one tick: nothing
    assert.equal(got.length, 0);
    sim.rotate(-0.05, 8, 16);
    assert.deepEqual(got.map((m) => m.data), [[0xB1, 0x09, 0x7F], [0xB1, 0x09, 0x7F]]);
});

test('flick: release then coasting bend ticks that die out', async () => {
    const { got, sim } = await rig();
    sim.touch(true, 0);
    sim.touch(false, 1);
    sim.fling(12);
    let now = 0;
    sim.step(now);
    for (let i = 0; i < 400; i++) sim.step(now += 16);
    assert.equal(sim.omega, 0);
    const coast = got.slice(2);
    assert.ok(coast.length > 50);
    assert.ok(coast.every((m) => m.data[1] === 0x09));
});

test('coalescing firmware variant still sums to the same rotation', async () => {
    const p = profile();
    p.maxMagnitude = 8;
    const { got, sim } = await rig(p);
    sim.touch(true, 0);
    sim.rotate(Math.PI, 0, 4); // half a turn in 4 ms
    const total = got.slice(1).reduce((s, m) => s + decodeRelative(m.data[2]), 0);
    assert.equal(total, 124);
    assert.ok(got.length < 40);
});

test('adapter: freeze / scrubBy / release, position-exact out and back', async () => {
    const { p, input, sim } = await rig();
    const calls = [];
    let pos = 0;
    const clock = {
        freeze: () => calls.push('freeze'),
        release: () => calls.push('release'),
        scrubBy: (s) => { pos += s; },
        nudge: (v) => calls.push(['nudge', v]),
    };
    const adapter = createJogAdapter({ profile: p, clock, timerMs: 0 });
    input.addEventListener('midimessage', adapter.onmidimessage);

    sim.touch(true, 0);
    sim.rotate(Math.PI / 2, 0, 100);
    assert.ok(Math.abs(pos - 0.45) < secondsPerTick(p), `quarter turn = 0.45 s, got ${pos}`);
    sim.rotate(-Math.PI / 2, 100, 200);
    assert.ok(Math.abs(pos) < secondsPerTick(p) + 1e-9);
    sim.touch(false, 200);
    assert.deepEqual(calls, ['freeze', 'release']);

    // true note-off release is understood too
    adapter.onmidimessage({ data: Uint8Array.of(0x91, 0x08, 0x7F) });
    adapter.onmidimessage({ data: Uint8Array.of(0x81, 0x08, 0x00) });
    assert.equal(adapter.state.touching, false);

    // other deck and other controls are ignored
    adapter.onmidimessage({ data: Uint8Array.of(0x92, 0x08, 0x7F) });
    adapter.onmidimessage({ data: Uint8Array.of(0xB1, 0x01, 0x40) });
    assert.equal(adapter.state.touching, false);

    // bend raises nudge, decay returns it to zero
    sim.rotate(1, 300, 400);
    adapter.decay(0);
    assert.ok(adapter.state.nudge > 0);
    adapter.decay(5000);
    assert.equal(adapter.state.nudge, 0);
    assert.deepEqual(calls.at(-1), ['nudge', 0]);

    // shift layer scrubs coarser
    pos = 0;
    sim.shift = true;
    sim.touch(true, 500);
    sim.rotate(0.1, 500, 510);
    assert.ok(pos > 3 * 3 * secondsPerTick(p));
    assert.deepEqual(parseJogMessage(p, [0x94, 0x08, 0x7F]), { kind: 'touch', deck: 'A', shift: true, down: true });
});

test('petri clock is reversible: out and back restores the marking', () => {
    const clock = new PetriClock(demoNets());
    const initial = JSON.stringify(clock.nets.map((n) => n.places));
    const fwd = clock.syncTo(LOOP_TICKS + 5.7);
    assert.equal(clock.tick, LOOP_TICKS + 5);
    assert.ok(fwd.length > 0);
    const mid = JSON.stringify(clock.nets.map((n) => n.places));
    clock.syncTo(-3.2);
    clock.syncTo(LOOP_TICKS + 5.1);
    assert.equal(JSON.stringify(clock.nets.map((n) => n.places)), mid);
    clock.syncTo(0);
    assert.equal(JSON.stringify(clock.nets.map((n) => n.places)), initial);
    for (const net of clock.nets) assert.equal(net.places.reduce((a, b) => a + b), 1);
});

// --- calibration learner ------------------------------------------------------
import { STEPS, buildOverride, diffProfile, detectEncoding } from './learn.js';
import { withOverride } from './inpulse-200-mk3.js';

// Perform the calibration script's hand motions on a simulated device.
async function performCalibration(p) {
    const access = await requestMockMIDIAccess({ inputs: [p] });
    const input = [...access.inputs.values()][0];
    let cap = [];
    input.addEventListener('midimessage', (e) => cap.push({ t: e.timeStamp, d: [...e.data] }));
    const sim = new JogWheelSim(input, p);
    let now = 0;
    const turn = (rad, ms) => { for (let i = 0; i < ms / 8; i++) { sim.rotate(rad / (ms / 8), now, now + 8); now += 8; } };
    const moves = {
        'touch': () => { for (let i = 0; i < 3; i++) { sim.touch(true, now += 200); sim.touch(false, now += 200); } },
        'scratch-cw': () => { sim.touch(true, now); turn(Math.PI * 2, 2000); sim.touch(false, now); },
        'scratch-ccw': () => { sim.touch(true, now); turn(-Math.PI * 2, 2000); sim.touch(false, now); },
        'bend': () => turn(Math.PI * 2, 1500),
        'spin': () => { sim.touch(true, now); turn(Math.PI * 3, 250); sim.touch(false, now); sim.fling(30); sim.step(now); for (let i = 0; i < 300; i++) sim.step(now += 16); },
        'shift': () => { sim.shift = true; sim.touch(true, now); turn(1, 300); sim.touch(false, now); sim.shift = false; },
        'vinyl': () => { sim.touch(true, now); turn(1, 300); sim.touch(false, now); },
        'deck-b': () => { sim.deck = 'B'; sim.touch(true, now); turn(1, 300); sim.touch(false, now); sim.deck = 'A'; },
    };
    const results = {};
    for (const step of STEPS) {
        cap = [];
        sim._tickAcc = 0;
        moves[step.id]();
        results[step.id] = step.analyze(cap, results);
    }
    return results;
}

test('learner recovers a device that differs from the guess in every field', async () => {
    const odd = {
        ...profile(),
        decks: { A: 0, B: 5 }, shiftChannelOffset: 2,
        touch: { note: 0x21, onVelocity: 0x64, releaseAsNoteOff: true },
        scratchCC: 0x30, bendCC: 0x31, encoding: 'offset64', maxMagnitude: 6, ticksPerRev: 720, coastTauSec: 0.8,
    };
    const results = await performCalibration(odd);
    const o = buildOverride(results, 'Weird Deck (v2)');
    assert.deepEqual(o.decks, { A: 0, B: 5 });
    assert.deepEqual(o.touch, odd.touch);
    assert.equal(o.scratchCC, 0x30);
    assert.equal(o.bendCC, 0x31);
    assert.equal(o.encoding, 'offset64');
    assert.equal(o.shiftChannelOffset, 2);
    assert.ok(Math.abs(o.ticksPerRev - 720) <= 1, `ticksPerRev ${o.ticksPerRev}`);
    assert.ok(o.maxMagnitude > 1);
    assert.ok(Math.abs(o.coastTauSec - 0.8) < 0.25, `tau ${o.coastTauSec}`);
    assert.ok(new RegExp(o.match, 'i').test('Weird Deck (v2)'));
    assert.ok(diffProfile(INPULSE_200_MK3, o).some((r) => !r.same));

    // and the saved override makes the adapter's parser understand that device
    const store = { getItem: () => JSON.stringify(o) };
    const { profile: merged } = withOverride(INPULSE_200_MK3, store);
    assert.deepEqual(parseJogMessage(merged, [0xB0, 0x30, 0x3F]), { kind: 'scratch', deck: 'A', shift: false, ticks: -1 });
    assert.deepEqual(parseJogMessage(merged, [0x85, 0x21, 0x00]), { kind: 'touch', deck: 'B', shift: false, down: false });
});

test('learner confirms the guess when the device matches it', async () => {
    const results = await performCalibration(profile());
    const rows = diffProfile(INPULSE_200_MK3, buildOverride(results));
    const wrong = rows.filter((r) => !r.same && r.field !== 'coastTauSec' && r.field !== 'ticksPerRev');
    assert.deepEqual(wrong, []);
    assert.ok(Math.abs(rows.find((r) => r.field === 'ticksPerRev').measured - 248) <= 1);
});

test('an absolute-position wheel is named, not mis-decoded', () => {
    assert.equal(detectEncoding(Array.from({ length: 60 }, (_, i) => (10 + i) % 128)), 'absolute');
});

test('a capture replays through the mock input in order with live timestamps', async () => {
    const { flattenCapture, replayCapture } = await import('./replay.js');
    const { input, got } = await rig();
    const session = { steps: { b: [{ t: 5000, d: [0xB1, 0x0A, 0x01] }], a: [{ t: 10, d: [0x91, 0x08, 0x7F] }, { t: 14, d: [0xB1, 0x0A, 0x7F] }] } };
    const msgs = flattenCapture(session);
    const before = performance.now();
    assert.equal(await replayCapture(input, msgs, { maxGapMs: 20 }), 3);
    assert.deepEqual(got.map((m) => m.data[0]), [0x91, 0xB1, 0xB1]);
    assert.ok(got[0].t >= before && got[2].t - got[0].t < 100);
});
