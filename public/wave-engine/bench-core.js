// bench-core.js — on-device audio-thread cost of the Tone path vs the wave
// engine, shared by bench.html and the studio's Benchmark modal
// (lib/ui/bench-modal.js). Every case renders the same project for the same
// duration into an OfflineAudioContext — the graph a live session runs, as
// fast as the device can — and reports ×realtime (audio-thread headroom).
//
//   A  Tone instruments + Tone master chain (the default engine)
//   B  wave worklet → Tone master chain     (?engine=wave&fx=tone)
//   F  wave, Tone master built but unhooked (?engine=wave, the lean path)
//   C  wave worklet → destination
//   D  C at 24 kHz                           (low-power tier candidate)
//   E  WaveRunner on the main thread, no audio graph (engine DSP alone)
//
// Cases A, B and F swap Tone's global context for the duration of the
// render; callers in the studio must stop playback first.

import { composeProject } from './offline.js';
import { compileProject, tick } from './net.js';
import { WaveRunner } from './runner.js';
import { ToneEngine } from '../audio/tone-engine.js';

// The fixed track every device runs, so results compare across devices.
export const REFERENCE = { genre: 'techno', seed: 42, structure: 'standard', seconds: 20 };
export const CASE_ORDER = ['A', 'B', 'F', 'C', 'D', 'E'];
const WORKLET = new URL('./worklet.js', import.meta.url).href;

/** Comfortable ≥ 3× (room for UI, GC, thermal), tight 1.5–3×, crackle < 1.5×. */
export function verdict(x) {
    if (!(x > 0)) return { level: 'bad', text: 'failed' };
    if (x >= 3) return { level: 'ok', text: 'plenty of headroom' };
    if (x >= 1.5) return { level: 'meh', text: 'tight — may crackle under load' };
    return { level: 'bad', text: 'will crackle' };
}

export function referenceProject() {
    return composeProject(REFERENCE.genre, REFERENCE.seed, REFERENCE.structure);
}

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

const nativeOffline = (sr, seconds) =>
    new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(seconds * sr), sampleRate: sr });

async function waveNode(ctx, project) {
    await ctx.audioWorklet.addModule(WORKLET);
    return new AudioWorkletNode(ctx, 'wave-engine', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
        processorOptions: { project, play: true, quiet: true },
    });
}

// Run `build(rawCtx)` on a fresh Tone-wrapped native OfflineAudioContext and
// time setup + render. Tone's previous context is always restored.
async function toneOffline(sr, seconds, build) {
    const T = window.Tone;
    const raw = nativeOffline(sr, seconds);
    const prev = T.getContext();
    const ctx = new T.OfflineContext(raw);
    T.setContext(ctx);
    try {
        const t0 = performance.now();
        await build(raw);
        const buf = await ctx.render();
        return { ms: performance.now() - t0, buf };
    } finally {
        T.setContext(prev);
    }
}

async function offlineToneEngine() {
    const eng = new ToneEngine();
    eng._offline = true;
    await eng.init();
    return eng;
}

export const CASES = {
    A: { label: 'Tone instruments + Tone master', engine: 'default engine', run: async (project, seconds) => {
        const { events, instruments } = noteEvents(project, seconds);
        return toneOffline(48000, seconds, async () => {
            const eng = await offlineToneEngine();
            await Promise.all([...instruments].map(([ch, inst]) => eng.loadInstrument(ch, inst)));
            for (const ev of events) eng.playNote(ev, ev.time + 0.05);
        });
    } },
    B: { label: 'wave → Tone master', engine: '?engine=wave&fx=tone', run: async (project, seconds) =>
        toneOffline(48000, seconds, async (raw) => {
            const eng = await offlineToneEngine();
            window.Tone.connect(await waveNode(raw, project), eng._masterVolume);
        }) },
    F: { label: 'wave, lean path', engine: '?engine=wave', run: async (project, seconds) =>
        toneOffline(48000, seconds, async (raw) => {
            const eng = await offlineToneEngine();
            try { eng._masterComp.disconnect(); } catch {}
            const gain = raw.createGain();
            (await waveNode(raw, project)).connect(gain);
            gain.connect(raw.destination);
        }) },
    C: { label: 'wave alone', engine: 'wave engine', run: async (project, seconds) => {
        const ctx = nativeOffline(48000, seconds);
        const t0 = performance.now();
        (await waveNode(ctx, project)).connect(ctx.destination);
        const buf = await ctx.startRendering();
        return { ms: performance.now() - t0, buf };
    } },
    D: { label: 'wave alone @ 24 kHz', engine: 'eco tier candidate', run: async (project, seconds) => {
        const ctx = nativeOffline(24000, seconds);
        const t0 = performance.now();
        (await waveNode(ctx, project)).connect(ctx.destination);
        const buf = await ctx.startRendering();
        return { ms: performance.now() - t0, buf };
    } },
    E: { label: 'wave DSP only (main thread)', engine: 'engine math alone', run: async (project, seconds) => {
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
    for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < d.length; i++) { const a = d[i] < 0 ? -d[i] : d[i]; if (a > p) p = a; }
    }
    return p;
}

export async function deviceInfo() {
    let defaultSampleRate = null;
    try { const c = new AudioContext(); defaultSampleRate = c.sampleRate; c.close(); } catch {}
    const info = {
        ua: navigator.userAgent,
        cores: navigator.hardwareConcurrency || null,
        memoryGB: navigator.deviceMemory || null,
        defaultSampleRate,
    };
    // UA client hints (Chromium): the reduced UA string hides the model
    // ("Android 10; K"); the hints carry it when the browser allows.
    try {
        const h = await navigator.userAgentData?.getHighEntropyValues?.(['model', 'platformVersion']);
        if (h) {
            if (h.model) info.model = h.model;
            if (h.platform) info.platform = h.platform;
            if (h.platformVersion) info.platformVersion = h.platformVersion;
            if (typeof h.mobile === 'boolean') info.mobile = h.mobile;
        }
    } catch {}
    for (const k of Object.keys(info)) if (info[k] == null) delete info[k];
    return info;
}

// Where submissions go: same origin when served by the beats server; the
// CDN-hosted bench page posts to beats.bitwrap.io (CORS is open there).
export function benchApi() {
    return location.hostname === 'cdn.stackdump.com' ? 'https://beats.bitwrap.io/api/bench' : '/api/bench';
}

export function resultsUrl() {
    return location.hostname === 'cdn.stackdump.com'
        ? 'https://beats.bitwrap.io/wave-engine/results.html' : '/wave-engine/results.html';
}

/** POST a report (optionally with a user label). Resolves {ok, id} or throws. */
export async function submitReport(report, label) {
    const body = { ...report };
    if (label && label.trim()) body.label = label.trim().slice(0, 80);
    const res = await fetch(benchApi(), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.trim()}`);
    return JSON.parse(text);
}

/**
 * runBench({ project, track, seconds, cases, onCase }) → report.
 * `track` describes what was rendered ({genre, seed, structure} or
 * {current: name}). onCase(row) fires as each case finishes.
 */
export async function runBench({ project, track, seconds = REFERENCE.seconds, cases = CASE_ORDER, onCase, onStart } = {}) {
    const results = [];
    for (const id of cases) {
        const c = CASES[id];
        if (!c) continue;
        if (onStart) onStart(id, c);
        await new Promise(r => setTimeout(r, 30)); // let the UI paint
        let row;
        try {
            const { ms, buf } = await c.run(project, seconds);
            const peak = peakOf(buf);
            row = { case: id, name: `${id} · ${c.label}`, renderMs: Math.round(ms),
                xRealtime: +(seconds * 1000 / ms).toFixed(2), peak: peak == null ? null : +peak.toFixed(3) };
        } catch (err) {
            row = { case: id, name: `${id} · ${c.label}`, error: String((err && err.message) || err) };
        }
        results.push(row);
        if (onCase) onCase(row);
    }
    return {
        bench: 'beats-audio-engine/v1',
        ...(track || {}), seconds,
        at: new Date().toISOString(), device: await deviceInfo(), results,
    };
}

/** One-line recommendation from a report's A and F cases. */
export function recommend(report) {
    const x = (id) => report.results.find(r => r.case === id && !r.error)?.xRealtime;
    const a = x('A'), f = x('F');
    if (a == null || f == null) return '';
    if (a >= 3) return `This device runs the default engine comfortably (${a}×). The wave engine has ${(f / a).toFixed(0)}× more headroom.`;
    if (f >= 3) return `The default engine is ${a < 1.5 ? 'likely to crackle' : 'tight'} here (${a}×). Try the wave engine (${f}×): add ?engine=wave.`;
    return `Both engines are tight on this device (default ${a}×, wave ${f}×). The eco tier (24 kHz) is the next lever.`;
}
