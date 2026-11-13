// Wiring for the jog lab page:
//
//   mouse -> JogWheelSim -> MockMIDIInput --midimessage--> jog adapter -> turntable
//                                  (or a real MIDIInput)                     |
//                         Petri-net marking  <-- playhead position <-- audio worklet
//
// djrust renders the nets' two-bar loop offline (the same rings, written as a
// beats project: the engine fires them for real), and the worklet plays that
// render like a record. The playhead is the single clock: the marking is
// derived from it, forwards and backwards.

import { INPULSE_200_MK3, parseJogMessage, withOverride } from './inpulse-200-mk3.js';
import { flattenCapture, replayCapture } from './replay.js';
import { requestMockMIDIAccess } from './mock-midi.js';
import { JogWheelSim } from './jog-sim.js';
import { createJogAdapter } from './jog-adapter.js';
import { mountJogWheel } from './jog-wheel-ui.js';
import { PetriClock, demoNets, LOOP_TICKS } from './petri-clock.js';
import { renderOffline } from '../lib/share/djrust-offline.js';

// Built-in guess, overlaid with whatever calibrate.html measured and saved.
const { profile, overridden } = withOverride(INPULSE_200_MK3);
const useReal = new URLSearchParams(location.search).get('midi') === 'real';
const BPM = 96;
const SEC_PER_NET_TICK = 60 / BPM / 4;
const $ = (id) => document.getElementById(id);

// --- turntable: the clock the adapter drives -------------------------------

let node = null;
let sampleRate = 48000;
const post = (msg) => node?.port.postMessage(msg);
const turntable = {
    freeze: () => post({ type: 'freeze' }),
    release: () => post({ type: 'release' }),
    scrubBy: (seconds) => post({ type: 'scrub', samples: seconds * sampleRate }),
    nudge: (value) => post({ type: 'nudge', value }),
};

const adapter = createJogAdapter({ profile, clock: turntable, deck: 'A' });

// --- MIDI input -------------------------------------------------------------

async function openMidi() {
    // The swap: everything below this line is identical for mock and real.
    const access = await (useReal
        ? navigator.requestMIDIAccess()
        : requestMockMIDIAccess({ inputs: [profile] }));

    const inputs = [...access.inputs.values()];
    const matched = inputs.filter((i) => profile.match.test(i.name || ''));
    // With real hardware, log EVERY input raw — that is how the profile's
    // UNVERIFIED numbers get checked — and drive the adapter from the match
    // (or from everything, if the port name guess was wrong).
    for (const input of inputs) input.addEventListener('midimessage', logMessage);
    for (const input of matched.length ? matched : inputs) {
        input.addEventListener('midimessage', adapter.onmidimessage);
        input.addEventListener('midimessage', showOnWheel);
    }
    $('source').textContent = useReal
        ? `real: ${inputs.map((i) => i.name).join(', ') || 'no inputs found'}` +
          (matched.length ? '' : ' — none matched the profile name, listening to all')
        : `mock: ${profile.name}`;
    if (overridden.length) $('source').textContent += ` · calibrated (${overridden.join(', ')})`;
    return { access, mockInput: useReal ? null : inputs[0] };
}

// --- message monitor --------------------------------------------------------

const hex = (b) => b.toString(16).toUpperCase().padStart(2, '0');
const lines = [];
const arrivals = [];
let peakRate = 0;
let logDirty = false;

function logMessage(e) {
    const msg = parseJogMessage(profile, e.data);
    const what = !msg ? '' :
        msg.kind === 'touch' ? `touch ${msg.deck} ${msg.down ? 'ON' : 'off'}` :
        `${msg.kind} ${msg.deck} ${msg.ticks > 0 ? '+' : ''}${msg.ticks}`;
    lines.push(`${e.timeStamp.toFixed(1).padStart(10)}  ${[...e.data].map(hex).join(' ')}   ${what}${msg?.shift ? ' [shift]' : ''}`);
    if (lines.length > 400) lines.splice(0, 200);
    arrivals.push(e.timeStamp);
    logDirty = true;
}

let wheel = null;
function showOnWheel(e) {
    const msg = parseJogMessage(profile, e.data);
    if (!msg || msg.deck !== 'A') return;
    if (msg.kind === 'touch') wheel.showTouch(msg.down);
    else wheel.showTicks(msg.ticks);
}

// --- Petri net view ---------------------------------------------------------

const petri = new PetriClock(demoNets());
const cells = new Map();

function buildNetView() {
    const host = $('nets');
    for (const net of petri.nets) {
        const row = document.createElement('div');
        row.className = 'net-row';
        const label = document.createElement('span');
        label.className = 'net-label';
        label.textContent = net.id;
        row.appendChild(label);
        const places = net.places.map((_, i) => {
            const c = document.createElement('i');
            // transition t_i leaves place i, so a hit on t_i sounds as the token leaves cell i
            if (net.transitions[i].midi) c.className = 'hit';
            row.appendChild(c);
            return c;
        });
        cells.set(net.id, places);
        host.appendChild(row);
    }
    drawMarking();
}

function drawMarking() {
    for (const net of petri.nets) {
        const row = cells.get(net.id);
        net.places.forEach((tokens, i) => row[i].classList.toggle('token', tokens > 0));
    }
}

// --- audio ------------------------------------------------------------------

// The demo's rings as a beats project djrust plays: drums on the drum channels, bass on 2.
const VOICES = { kick: [10, 'drums'], snare: [11, 'drums'], hat: [12, 'drums'], bass: [2, 'bass'] };

function demoProject() {
    const nets = {};
    for (const ring of demoNets()) {
        const [channel, instrument] = VOICES[ring.id];
        const places = {}, transitions = {}, arcs = [];
        ring.places.forEach((tokens, i) => { places[`p${i}`] = { initial: [tokens], x: i * 10, y: 0 }; });
        for (const t of ring.transitions) {
            const tr = { x: 0, y: 0 };
            if (t.midi) tr.midi = { note: t.midi.note, velocity: t.midi.velocity, channel, durationSteps: 1 };
            transitions[t.id] = tr;
            for (const a of t.inputs) arcs.push({ source: `p${a.place}`, target: t.id, weight: [a.weight] });
            for (const a of t.outputs) arcs.push({ source: t.id, target: `p${a.place}`, weight: [a.weight] });
        }
        nets[ring.id] = { role: 'music', track: { channel, instrument, group: ring.id }, places, transitions, arcs };
    }
    return { name: 'jog demo', tempo: BPM, nets };
}

async function renderLoop() {
    const loopSec = LOOP_TICKS * SEC_PER_NET_TICK;
    // Render two loop lengths, then fold the second onto the first so decay
    // tails wrap around the seam instead of being cut.
    const { samples } = await renderOffline(JSON.stringify(demoProject()), loopSec * 2, sampleRate);
    const n = Math.round(loopSec * sampleRate);
    const channels = [new Float32Array(n), new Float32Array(n)];
    for (let c = 0; c < 2; c++) {
        for (let i = 0; i < n; i++) {
            channels[c][i] = samples[2 * i + c] + (samples[2 * (i + n) + c] || 0);
        }
    }
    return { channels, samplesPerNetTick: n / LOOP_TICKS };
}

let playing = false;
let started = false;

async function startAudio() {
    $('play').disabled = true;
    $('status').textContent = 'rendering the net…';
    const ctx = new AudioContext();
    await ctx.resume();
    sampleRate = ctx.sampleRate;
    const { channels, samplesPerNetTick } = await renderLoop();
    await ctx.audioWorklet.addModule(new URL('./scrub-worklet.js', import.meta.url).href);
    node = new AudioWorkletNode(ctx, 'jog-scrub', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    node.connect(ctx.destination);
    node.port.onmessage = (e) => {
        const tickFloat = e.data.pos / samplesPerNetTick;
        // +1: the transition for step k fires as the playhead enters step k.
        const before = petri.tick;
        petri.syncTo(tickFloat + 1);
        if (petri.tick !== before) drawMarking();
        $('tick').textContent = tickFloat.toFixed(2);
        $('rate').textContent = e.data.rate.toFixed(2) + '×';
    };
    post({ type: 'load', channels });
    post({ type: 'chase', seconds: Number($('chase').value) / 1000 });
    started = true;
    $('play').disabled = false;
}

async function togglePlay() {
    if (!started) await startAudio();
    playing = !playing;
    post({ type: 'transport', playing });
    $('play').textContent = playing ? 'Stop' : 'Play';
    $('status').textContent = playing ? 'playing — drag the platter' : 'stopped — the platter still scrubs';
}

// --- page -------------------------------------------------------------------

function frame(now) {
    while (arrivals.length && arrivals[0] < now - 1000) arrivals.shift();
    peakRate = Math.max(peakRate, arrivals.length);
    $('msgrate').textContent = `${arrivals.length}/s (peak ${peakRate})`;
    $('touching').textContent = adapter.state.touching ? 'yes' : 'no';
    $('nudge').textContent = (adapter.state.nudge * 100).toFixed(1) + '%';
    if (logDirty) {
        logDirty = false;
        $('log').textContent = lines.slice(-18).join('\n');
    }
    requestAnimationFrame(frame);
}

async function main() {
    buildNetView();
    const { mockInput } = await openMidi();
    const sim = mockInput ? new JogWheelSim(mockInput, profile, { deck: 'A' }) : null;
    wheel = mountJogWheel($('wheel'), { sim, ticksPerRev: profile.ticksPerRev });

    $('play').addEventListener('click', togglePlay);
    $('chase').addEventListener('input', (e) => {
        $('chase-val').textContent = e.target.value + ' ms';
        post({ type: 'chase', seconds: Number(e.target.value) / 1000 });
    });
    // Exercise the two encodings the real firmware might turn out to use.
    $('opt-noteoff').addEventListener('change', (e) => { profile.touch.releaseAsNoteOff = e.target.checked; });
    $('opt-coalesce').addEventListener('change', (e) => { profile.maxMagnitude = e.target.checked ? 8 : 1; });
    // Feed a capture saved by calibrate.html back through the mock input with
    // its original timing: real-hardware behaviour, reproducible, no hardware.
    $('replay').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file || !mockInput) return;
        const msgs = flattenCapture(JSON.parse(await file.text()));
        $('status').textContent = `replaying ${msgs.length} captured messages…`;
        await replayCapture(mockInput, msgs);
        $('status').textContent = 'replay finished';
    });
    if (useReal) document.body.classList.add('real');
    requestAnimationFrame(frame);
}

main().catch((err) => {
    console.error(err);
    $('status').textContent = String(err);
});
