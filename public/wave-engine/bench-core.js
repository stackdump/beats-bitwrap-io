// bench-core.js — on-device audio-thread cost of the wave engine, shared by
// bench.html and the studio's Benchmark modal
// (lib/ui/bench-modal.js). Every case renders the same project for the same
// duration into an OfflineAudioContext — the graph a live session runs, as
// fast as the device can — and reports ×realtime (audio-thread headroom).
//
//   C  wave worklet → destination
//   D  C at 24 kHz                           (low-power tier candidate)
//   E  WaveRunner on the main thread, no audio graph (engine DSP alone)
//
// Cases A, B and F (Tone instruments / Tone master chain) left with Tone.js;
// the server still accepts them so old reports stay valid. A djrust case
// (the studio's engine now) is a rebuild item: it needs a new case id in
// internal/bench (schema column) and here (docs/MIGRATION-djrust-wasm.md §12).

import { composeProject } from './offline.js';
import { WaveRunner } from './runner.js';

// The fixed track every device runs, so results compare across devices.
export const REFERENCE = { genre: 'techno', seed: 42, structure: 'standard', seconds: 20 };
export const CASE_ORDER = ['C', 'D', 'E'];
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

const nativeOffline = (sr, seconds) =>
    new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(seconds * sr), sampleRate: sr });

async function waveNode(ctx, project) {
    await ctx.audioWorklet.addModule(WORKLET);
    return new AudioWorkletNode(ctx, 'wave-engine', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
        processorOptions: { project, play: true, quiet: true },
    });
}

export const CASES = {
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

/** One-line recommendation from a report's C and D cases. */
export function recommend(report) {
    const x = (id) => report.results.find(r => r.case === id && !r.error)?.xRealtime;
    const c = x('C'), d = x('D');
    if (c == null) return '';
    if (c >= 3) return `This device runs the wave engine comfortably (${c}×).`;
    if (d != null && d >= 3) return `The wave engine is tight here (${c}×); the 24 kHz eco tier has room (${d}×).`;
    return `The wave engine is tight on this device (${c}×).`;
}
