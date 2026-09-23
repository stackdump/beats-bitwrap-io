// Hardware-day wizard. Listens to EVERY MIDI input raw, walks the script in
// learn.js, and turns what it measured into a profile override that the demo
// picks up from localStorage. Defaults to real hardware; ?midi=mock swaps in
// the simulator + on-screen wheel so the wizard itself can be rehearsed.

import { INPULSE_200_MK3, OVERRIDE_KEY } from './inpulse-200-mk3.js';
import { requestMockMIDIAccess } from './mock-midi.js';
import { JogWheelSim } from './jog-sim.js';
import { mountJogWheel } from './jog-wheel-ui.js';
import { STEPS, buildOverride, diffProfile } from './learn.js';

const useMock = new URLSearchParams(location.search).get('midi') === 'mock';
const $ = (id) => document.getElementById(id);
const hex = (b) => b.toString(16).toUpperCase().padStart(2, '0');

const session = {
    startedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    ports: [],
    steps: {},      // id -> capture
};
const results = {};
let access = null;
let recording = null;   // capture array while a step is running
let current = 0;
let activePort = null;  // name of the input that has been talking
const logLines = [];
let logDirty = false;

function onMessage(e) {
    const d = [...e.data];
    // 0xF8 clock / 0xFE active sensing would drown everything else
    if (d[0] >= 0xF8) return;
    const port = e.target?.name || '?';
    if (!activePort) { activePort = port; renderPorts(); }
    if (recording) recording.push({ t: Number(e.timeStamp.toFixed(3)), d, port });
    logLines.push(`${e.timeStamp.toFixed(1).padStart(10)}  ${d.map(hex).join(' ').padEnd(10)} ${port}`);
    if (logLines.length > 600) logLines.splice(0, 300);
    logDirty = true;
}

function wire() {
    session.ports = [];
    for (const input of access.inputs.values()) {
        input.removeEventListener('midimessage', onMessage);
        input.addEventListener('midimessage', onMessage);
        session.ports.push({ dir: 'in', name: input.name, manufacturer: input.manufacturer, id: input.id, state: input.state });
    }
    for (const output of access.outputs?.values?.() || []) {
        session.ports.push({ dir: 'out', name: output.name, manufacturer: output.manufacturer, id: output.id, state: output.state });
    }
    renderPorts();
}

function renderPorts() {
    const ins = session.ports.filter((p) => p.dir === 'in');
    $('ports').innerHTML = ins.length
        ? ins.map((p) => `<li class="${p.name === activePort ? 'active' : ''}"><b>${p.name}</b> <span>${p.manufacturer || ''}</span>` +
            `${INPULSE_200_MK3.match.test(p.name || '') ? ' <em>matches profile</em>' : ''}${p.name === activePort ? ' <em>talking</em>' : ''}</li>`).join('')
        : '<li class="bad">No MIDI inputs. Plug the controller in; on Linux check <code>amidi -l</code>. This list updates on hot-plug.</li>';
}

function renderSteps() {
    $('steps').innerHTML = '';
    STEPS.forEach((step, i) => {
        const li = document.createElement('li');
        const done = results[step.id] !== undefined;
        li.className = i === current ? 'current' : done ? 'done' : '';
        const warns = done ? step.warn(results[step.id], results).filter(Boolean) : [];
        li.innerHTML = `<h3>${i + 1}. ${step.title}</h3><p>${step.ask}</p>`;
        if (i === current) {
            const b = document.createElement('button');
            b.textContent = recording ? 'Done — analyse' : done ? 'Redo' : 'Start capture';
            b.onclick = () => (recording ? finishStep() : beginStep());
            li.appendChild(b);
            if (recording) {
                const n = document.createElement('span');
                n.id = 'count';
                n.className = 'count';
                li.appendChild(n);
            } else if (done && i < STEPS.length - 1) {
                const nx = document.createElement('button');
                nx.textContent = 'Next →';
                nx.className = 'ghost';
                nx.onclick = () => { current++; renderSteps(); };
                li.appendChild(nx);
            }
            const sk = document.createElement('button');
            sk.textContent = 'Skip';
            sk.className = 'ghost';
            sk.onclick = () => { recording = null; current = Math.min(STEPS.length - 1, current + 1); renderSteps(); };
            if (!recording && !done && i < STEPS.length - 1) li.appendChild(sk);
        } else {
            li.onclick = () => { if (!recording) { current = i; renderSteps(); } };
        }
        if (done) {
            const pre = document.createElement('pre');
            pre.textContent = JSON.stringify(results[step.id], null, 1).replace(/\n\s+/g, ' ');
            li.appendChild(pre);
            for (const w of warns) {
                const p = document.createElement('p');
                p.className = 'warn';
                p.textContent = w;
                li.appendChild(p);
            }
        }
        $('steps').appendChild(li);
    });
    $('steps').querySelector('.current')?.scrollIntoView({ block: 'nearest' });
    renderVerdict();
}

function beginStep() {
    recording = [];
    renderSteps();
}

function finishStep() {
    const step = STEPS[current];
    // If several ports talked, analyse the busiest one.
    const byPort = new Map();
    for (const m of recording) byPort.set(m.port, (byPort.get(m.port) || 0) + 1);
    const busiest = [...byPort.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (busiest) activePort = busiest;
    session.steps[step.id] = recording;
    results[step.id] = step.analyze(recording.filter((m) => m.port === busiest), results);
    recording = null;
    renderPorts();
    renderSteps();
}

function renderVerdict() {
    const override = buildOverride(results, useMock ? null : activePort);
    const rows = diffProfile(INPULSE_200_MK3, override);
    const fmt = (v) => (typeof v === 'number' && Number.isInteger(v) && v < 256 ? `${v} (0x${hex(v)})` : String(v));
    $('verdict').innerHTML = rows.length
        ? `<table><tr><th>field</th><th>assumed</th><th>measured</th><th></th></tr>${rows.map((r) =>
            `<tr class="${r.same ? 'same' : 'diff'}"><td>${r.field}</td><td>${fmt(r.assumed)}</td><td>${fmt(r.measured)}</td><td>${r.same ? '✓' : '≠'}</td></tr>`).join('')}</table>`
        : '<p class="dim">Nothing measured yet.</p>';
    $('override').textContent = JSON.stringify(override, null, 2);
    $('save').disabled = !rows.length;
    return override;
}

function download(name, obj) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(obj)], { type: 'application/json' }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
}

async function main() {
    $('mode').textContent = useMock ? 'mock (rehearsal) — drag the wheel' : 'real hardware';
    try {
        access = await (useMock
            ? requestMockMIDIAccess({ inputs: [INPULSE_200_MK3] })
            : navigator.requestMIDIAccess({ sysex: false }));
    } catch (err) {
        $('ports').innerHTML = `<li class="bad">Web MIDI unavailable: ${err.message || err}. Needs Chrome/Edge/Firefox on https or localhost, and the MIDI permission allowed.</li>`;
        renderSteps();
        return;
    }
    access.onstatechange = wire;
    wire();

    if (useMock) {
        const input = [...access.inputs.values()][0];
        const sim = new JogWheelSim(input, INPULSE_200_MK3);
        $('wheel-card').hidden = false;
        const wheel = mountJogWheel($('wheel'), { sim, ticksPerRev: INPULSE_200_MK3.ticksPerRev });
        input.addEventListener('midimessage', (e) => {
            if ((e.data[0] & 0xF0) === 0xB0) wheel.showTicks(e.data[2] < 0x40 ? e.data[2] : e.data[2] - 0x80);
            else wheel.showTouch((e.data[0] & 0xF0) === 0x90 && e.data[2] > 0);
        });
        $('deck-b').onchange = (e) => { sim.deck = e.target.checked ? 'B' : 'A'; };
    }

    // Mixxx sends B0 7F 7F at init to make Hercules controllers report state.
    $('wake').onclick = () => {
        let n = 0;
        for (const out of access.outputs?.values?.() || []) { out.send([0xB0, 0x7F, 0x7F]); n++; }
        $('wake').textContent = n ? `Sent B0 7F 7F to ${n} output${n > 1 ? 's' : ''}` : 'No MIDI outputs found';
    };
    $('save').onclick = () => {
        localStorage.setItem(OVERRIDE_KEY, JSON.stringify(renderVerdict()));
        $('saved').textContent = 'Saved. demo.html?midi=real now uses the measured profile.';
    };
    $('clear').onclick = () => { localStorage.removeItem(OVERRIDE_KEY); $('saved').textContent = 'Override cleared.'; };
    $('dl').onclick = () => download(`jog-capture-${session.startedAt.replace(/[:.]/g, '-')}.json`,
        { ...session, results, override: renderVerdict() });

    renderSteps();
    const tick = () => {
        if (logDirty) { logDirty = false; $('log').textContent = logLines.slice(-22).join('\n'); }
        if (recording && $('count')) $('count').textContent = `${recording.length} messages`;
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
}

main();
