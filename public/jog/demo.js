// Wiring for the jog lab page:
//
//   mouse -> JogWheelSim -> MockMIDIInput --midimessage--> jog adapter -> turntable
//                                  (or a real MIDIInput)                     |
//                         Petri-net marking  <-- playhead position <-- audio worklet
//
// A small native Web Audio kit renders the net's two-bar loop offline (the
// net is fired for real; its midi bindings are what get scheduled), and the
// worklet plays that
// render like a record. The playhead is the single clock: the marking is
// derived from it, forwards and backwards.

import { INPULSE_200_MK3, parseJogMessage, withOverride } from './inpulse-200-mk3.js';
import { flattenCapture, replayCapture } from './replay.js';
import { requestMockMIDIAccess } from './mock-midi.js';
import { JogWheelSim } from './jog-sim.js';
import { createJogAdapter } from './jog-adapter.js';
import { mountJogWheel } from './jog-wheel-ui.js';
import { PetriClock, demoNets, LOOP_TICKS } from './petri-clock.js';

// Built-in guess, overlaid with whatever calibrate.html measured and saved.
const { profile, overridden } = withOverride(INPULSE_200_MK3);
const useReal = new URLSearchParams(location.search).get('midi') === 'real';
const BPM = 96;
const SEC_PER_NET_TICK = 60 / BPM / 4;
const $ = (id) => document.getElementById(id);

// --- turntable: the clock the adapter drives -------------------------------

let node = null;
let ctx = null;
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

async function renderLoop() {
    // Fire a fresh copy of the net through one loop and schedule what it emits.
    const clock = new PetriClock(demoNets());
    const events = [];
    for (let k = 0; k < LOOP_TICKS; k++) {
        for (const ev of clock.stepForward()) events.push({ tick: k, ...ev });
    }
    const loopSec = LOOP_TICKS * SEC_PER_NET_TICK;
    // Render two loop lengths, then fold the second onto the first so decay
    // tails wrap around the seam instead of being cut.
    const rendered = await renderKit(events, loopSec * 2, sampleRate);

    const n = Math.round(loopSec * rendered.sampleRate);
    const channels = [];
    for (let c = 0; c < rendered.numberOfChannels; c++) {
        const src = rendered.getChannelData(c);
        const dst = new Float32Array(n);
        for (let i = 0; i < n; i++) dst[i] = src[i] + (src[i + n] || 0);
        channels.push(dst);
    }
    return { channels, samplesPerNetTick: n / LOOP_TICKS };
}

// Kick (sine pitch drop), snare / hat (filtered noise bursts) and a
// sawtooth bass through a lowpass with its own envelope: the same four
// voices the lab always had, in plain Web Audio nodes.
async function renderKit(events, seconds, sr) {
    const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sr), sr);
    const out = ctx.createDynamicsCompressor();          // a soft limiter
    out.threshold.value = -3; out.ratio.value = 20; out.attack.value = 0.001; out.release.value = 0.05;
    out.connect(ctx.destination);
    const noise = ctx.createBuffer(1, sr, sr);
    const nd = noise.getChannelData(0);
    let seed = 1;
    for (let i = 0; i < nd.length; i++) { seed = (seed * 16807) % 2147483647; nd[i] = seed / 1073741823.5 - 1; }
    const env = (g, t, peak, attack, decay) => {
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(peak, t + attack);
        g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    };
    const burst = (t, vel, type, freq, decay, level) => {
        const src = ctx.createBufferSource(); src.buffer = noise;
        const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
        const g = ctx.createGain();
        src.connect(f).connect(g).connect(out);
        env(g, t, vel * level, 0.001, decay);
        src.start(t); src.stop(t + decay + 0.05);
    };
    for (const ev of events) {
        const t = ev.tick * SEC_PER_NET_TICK;
        const vel = ev.velocity / 127;
        if (ev.net === 'kick') {
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.frequency.setValueAtTime(32.7 * 64, t);                      // C1 · 6 octaves
            o.frequency.exponentialRampToValueAtTime(32.7, t + 0.04);
            o.connect(g).connect(out);
            env(g, t, vel, 0.001, 0.3);
            o.start(t); o.stop(t + 0.4);
        } else if (ev.net === 'snare') {
            burst(t, vel, 'bandpass', 1800, 0.16, 0.8);
        } else if (ev.net === 'hat') {
            burst(t, vel, 'highpass', 7000, 0.035, 0.2);
        } else if (ev.net === 'bass') {
            const dur = SEC_PER_NET_TICK * 0.9;
            const o = ctx.createOscillator(); o.type = 'sawtooth';
            o.frequency.value = 440 * Math.pow(2, (ev.note - 69) / 12);
            const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 3;
            f.frequency.setValueAtTime(120, t);
            f.frequency.linearRampToValueAtTime(960, t + 0.005);
            f.frequency.exponentialRampToValueAtTime(120 + 840 * 0.3, t + 0.125);
            const g = ctx.createGain();
            o.connect(f).connect(g).connect(out);
            g.gain.setValueAtTime(0, t);
            g.gain.linearRampToValueAtTime(vel * 0.5, t + 0.005);
            g.gain.linearRampToValueAtTime(vel * 0.25, t + 0.2);
            g.gain.setValueAtTime(vel * 0.25, t + dur);
            g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.15);
            o.start(t); o.stop(t + dur + 0.2);
        }
    }
    return ctx.startRendering();
}

let playing = false;
let started = false;

async function startAudio() {
    $('play').disabled = true;
    $('status').textContent = 'rendering the net…';
    ctx ||= new AudioContext();
    await ctx.resume();
    window.__jogCtx = ctx; // e2e taps the output here
    sampleRate = ctx.sampleRate;
    const { channels, samplesPerNetTick } = await renderLoop();
    await ctx.audioWorklet.addModule(new URL('./scrub-worklet.js', import.meta.url).href);
    node = new AudioWorkletNode(ctx, 'jog-scrub', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    node.connect(ctx.destination);
    window.__jogNode = node;
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
