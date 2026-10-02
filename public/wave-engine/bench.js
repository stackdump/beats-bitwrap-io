// bench.js — on-device audio-thread cost of the Tone path vs the wave engine.
// See bench.html. Every case renders the same (genre, seed, structure) for
// the same duration into an OfflineAudioContext and reports ×realtime.
//
//   A  tone            Tone.js instruments + Tone master chain (today's default)
//   B  wave+tone-master  wave worklet → Tone master chain (today's ?engine=wave)
//   C  wave            wave worklet → destination
//   D  wave @24k       C at 24 kHz (a low-power tier candidate)
//   F  wave lean       C, with a Tone master chain built but unhooked — what
//                      ?engine=wave does now (checks the idle chain costs nothing)
//   E  wave JS only    WaveRunner on the main thread, no audio graph (engine DSP alone)
//
// Query params: ?genre=&structure=&seconds=&cases=A,B,C,D,E&auto=1

import { composeProject } from './offline.js';
import { compileProject, tick } from './net.js';
import { WaveRunner } from './runner.js';
import { ToneEngine } from '../audio/tone-engine.js';

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const GENRES = ['techno', 'house', 'edm', 'trance', 'dnb', 'dubstep', 'jazz', 'ambient', 'lofi', 'synthwave',
    'funk', 'bossa', 'blues', 'country', 'reggae', 'trap', 'garage', 'metal', 'speedcore'];
for (const g of GENRES) $('genre').add(new Option(g, g));
$('genre').value = q.get('genre') || 'techno';
if (q.has('structure')) $('structure').value = q.get('structure');
if (q.has('seconds')) $('seconds').value = q.get('seconds');

const SEED = 42;
const WORKLET = new URL('./worklet.js', import.meta.url).href;
const status = (s) => { $('status').textContent = s; };

// Note events exactly as the wave engine fires them (same executor), for the
// Tone case. Muted nets / notes are skipped, durations resolved at tempo.
function noteEvents(project, seconds) {
    const g = compileProject(project);
    const tickSec = 60 / (g.tempo * 4);
    const events = [];
    const n = Math.floor(seconds / tickSec);
    for (let k = 0; k < n && !g.stopRequested; k++) {
        tick(g, (net, t) => {
            const ch = net.bundle.bindings[net.transIds[t]].channel || net.bundle.track.channel;
            const steps = net.durSteps[t];
            const durMs = steps > 0 ? steps * tickSec * 1000 : net.durMs[t];
            events.push({ time: k * tickSec, channel: ch, note: net.note[t], velocity: net.vel[t], duration: durMs });
        });
    }
    const instruments = new Map();
    for (const net of g.nets) {
        if (net.bundle.role === 'control') continue;
        const tr = net.bundle.track;
        if (!instruments.has(tr.channel)) instruments.set(tr.channel, tr.instrument || 'piano');
    }
    return { events, instruments };
}

async function nativeOffline(sr, seconds) {
    return new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(seconds * sr), sampleRate: sr });
}

async function waveNode(ctx, project) {
    await ctx.audioWorklet.addModule(WORKLET);
    return new AudioWorkletNode(ctx, 'wave-engine', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
        processorOptions: { project, play: true, quiet: true },
    });
}

// Run `build(ctx)` on a fresh Tone-wrapped native OfflineAudioContext and
// time the whole thing (graph setup + render).
async function toneOffline(sr, seconds, build) {
    const raw = await nativeOffline(sr, seconds);
    const prev = Tone.getContext();
    const ctx = new Tone.OfflineContext(raw);
    Tone.setContext(ctx);
    try {
        const t0 = performance.now();
        await build(raw);
        const buf = await ctx.render();
        return { ms: performance.now() - t0, buf };
    } finally {
        Tone.setContext(prev);
    }
}

const CASES = {
    A: { name: 'A · Tone instruments + Tone master (default today)', run: async (project, seconds) => {
        const { events, instruments } = noteEvents(project, seconds);
        return toneOffline(48000, seconds, async () => {
            const eng = new ToneEngine();
            eng._offline = true;
            await eng.init();
            await Promise.all([...instruments].map(([ch, inst]) => eng.loadInstrument(ch, inst)));
            for (const ev of events) eng.playNote(ev, ev.time + 0.05);
        });
    } },
    B: { name: 'B · wave engine → Tone master (?engine=wave today)', run: async (project, seconds) => {
        return toneOffline(48000, seconds, async (raw) => {
            const eng = new ToneEngine();
            eng._offline = true;
            await eng.init();
            const node = await waveNode(raw, project);
            Tone.connect(node, eng._masterVolume);
        });
    } },
    C: { name: 'C · wave engine alone', run: async (project, seconds) => {
        const ctx = await nativeOffline(48000, seconds);
        const t0 = performance.now();
        (await waveNode(ctx, project)).connect(ctx.destination);
        const buf = await ctx.startRendering();
        return { ms: performance.now() - t0, buf };
    } },
    D: { name: 'D · wave engine alone @ 24 kHz', run: async (project, seconds) => {
        const ctx = await nativeOffline(24000, seconds);
        const t0 = performance.now();
        (await waveNode(ctx, project)).connect(ctx.destination);
        const buf = await ctx.startRendering();
        return { ms: performance.now() - t0, buf };
    } },
    F: { name: 'F · wave alone, Tone master built but unhooked (lean ?engine=wave)', run: async (project, seconds) => {
        return toneOffline(48000, seconds, async (raw) => {
            const eng = new ToneEngine();
            eng._offline = true;
            await eng.init();
            try { eng._masterComp.disconnect(); } catch {}
            const gain = raw.createGain();
            (await waveNode(raw, project)).connect(gain);
            gain.connect(raw.destination);
        });
    } },
    E: { name: 'E · wave DSP only (main thread, no audio graph)', run: async (project, seconds) => {
        const r = new WaveRunner(48000);
        r.load(project); r.play();
        const L = new Float32Array(128), R = new Float32Array(128);
        const blocks = Math.ceil(seconds * 48000 / 128);
        const t0 = performance.now();
        for (let i = 0; i < blocks; i++) r.process(L, R, 128);
        return { ms: performance.now() - t0, buf: null };
    } },
};

function peakOf(buf) {
    if (!buf) return null;
    let p = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) for (const x of buf.getChannelData(c)) { const a = Math.abs(x); if (a > p) p = a; }
    return p;
}

function device() {
    return {
        ua: navigator.userAgent,
        cores: navigator.hardwareConcurrency || null,
        memoryGB: navigator.deviceMemory || null,
        defaultSampleRate: (() => { try { const c = new AudioContext(); const s = c.sampleRate; c.close(); return s; } catch { return null; } })(),
    };
}

const results = [];
async function run() {
    $('run').disabled = true; $('copy').disabled = true;
    const tbody = $('out').querySelector('tbody');
    tbody.innerHTML = ''; results.length = 0;
    const genre = $('genre').value, structure = $('structure').value, seconds = Number($('seconds').value) || 20;
    status(`composing ${genre}/${structure || 'loop'}…`);
    const project = composeProject(genre, SEED, structure);
    const cases = (q.get('cases') || 'A,B,F,C,D,E').split(',');
    for (const id of cases) {
        const c = CASES[id];
        if (!c) continue;
        status(`running ${c.name}…`);
        await new Promise(r => setTimeout(r, 50));
        let row;
        try {
            const { ms, buf } = await c.run(project, seconds);
            const x = seconds * 1000 / ms;
            const peak = peakOf(buf);
            row = { case: id, name: c.name, renderMs: Math.round(ms), xRealtime: +x.toFixed(2), peak: peak == null ? null : +peak.toFixed(3) };
        } catch (err) {
            row = { case: id, name: c.name, error: String(err && err.message || err) };
        }
        results.push(row);
        const tr = document.createElement('tr');
        const verdict = row.error ? `<span class="bad">error: ${row.error}</span>`
            : row.peak === 0 ? '<span class="bad">silent?</span>'
            : row.xRealtime >= 3 ? '<span class="ok">plenty of headroom</span>'
            : row.xRealtime >= 1.5 ? '<span class="meh">tight — may crackle under load</span>'
            : '<span class="bad">will crackle</span>';
        tr.innerHTML = `<td>${row.name}</td><td class="num">${row.error ? '' : (row.renderMs / 1000).toFixed(1) + ' s'}</td>`
            + `<td class="num">${row.error ? '' : row.xRealtime + '×'}</td><td>${verdict}</td>`;
        tbody.appendChild(tr);
    }
    const report = { bench: 'beats-audio-engine/v1', genre, seed: SEED, structure: structure || 'loop', seconds, at: new Date().toISOString(), device: device(), results };
    $('dev').textContent = JSON.stringify(report, null, 2);
    window.__benchReport = report;
    status('done');
    $('run').disabled = false; $('copy').disabled = false;
}

$('run').onclick = run;
$('copy').onclick = async () => {
    const text = $('dev').textContent;
    try { await navigator.clipboard.writeText(text); status('copied'); }
    catch { status('select the JSON below and copy it'); }
};
if (q.get('auto') === '1') run();
