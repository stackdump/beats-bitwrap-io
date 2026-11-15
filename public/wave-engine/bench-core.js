// bench-core.js — on-device audio-thread cost of the studio's audio engines,
// shared by bench.html and the studio's Benchmark modal
// (lib/ui/bench-modal.js). Every case renders the same project for the same
// duration into an OfflineAudioContext — the graph a live session runs, as
// fast as the device can — and reports ×realtime (audio-thread headroom).
//
//   G  djrust worklet → destination           (the studio engine)
//   H  G at 24 kHz                            (low-power tier candidate)
//   I  djrust on the main thread, no audio graph (engine DSP alone)
//   C  JS wave worklet → destination
//   D  C at 24 kHz
//   E  WaveRunner on the main thread, no audio graph
//
// Cases A, B and F (Tone instruments / Tone master chain) left with Tone.js;
// the server still accepts them so old reports stay valid. Every id here
// must be in internal/bench Cases (a Go test checks), and the server must be
// deployed before a page that sends a new id.
//
// The djrust cases load the module the studio does (public/djrust/node.js:
// the pinned CDN build, else the local one; `?djrust-wasm=URL` overrides),
// compiled once and outside the timed span. Reports carry
// `engineVersion: "djrust@<crate>"` when a djrust case ran.

import { composeProject } from './offline.js';
import { WaveRunner } from './runner.js';

// The fixed track every device runs, so results compare across devices.
export const REFERENCE = { genre: 'techno', seed: 42, structure: 'standard', seconds: 20 };
export const CASE_ORDER = ['G', 'H', 'I', 'C', 'D', 'E'];
/** The one case a quick run measures: the studio engine at 48 kHz. */
export const QUICK_CASES = ['G'];
const WORKLET = new URL('./worklet.js', import.meta.url).href;
const DJ_WORKLET = new URL('../djrust/worklet.js', import.meta.url).href;

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

function djwasmOverride() {
    try { return new URLSearchParams(globalThis.location?.search || '').get('djrust-wasm') || undefined; }
    catch { return undefined; }
}

let djVersion = null; // "djrust@<crate>" once a djrust case has loaded the module

async function djModule() {
    const { loadDjwasmModule } = await import('../djrust/node.js');
    return (await loadDjwasmModule(djwasmOverride())).module;
}

async function djInstance(module) {
    const { instantiate } = await import('../djrust/loader.js');
    const dj = await instantiate(module);
    if (!djVersion) { const i = dj.info(); djVersion = `${i.engine || 'djrust'}@${i.crate}`; }
    return dj;
}

// The djrust worklet in an OfflineAudioContext, as the studio runs it for an offline render:
// a compiled Module in processorOptions so it is ready before the first quantum.
async function djrustCase(sr, project, seconds) {
    const module = await djModule();
    await djInstance(module); // version, and a module that will not start fails here, untimed
    const ctx = nativeOffline(sr, seconds);
    const t0 = performance.now();
    await ctx.audioWorklet.addModule(DJ_WORKLET);
    const node = new AudioWorkletNode(ctx, 'djrust-engine', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
        processorOptions: { module, project, play: true, quiet: true },
    });
    let failed = null;
    node.port.onmessage = (e) => { if (e.data?.type === 'error') failed = e.data.message; };
    node.connect(ctx.destination);
    const buf = await ctx.startRendering();
    const ms = performance.now() - t0;
    await new Promise(r => setTimeout(r, 0)); // let a pending error message land
    if (failed) throw new Error(failed);
    return { ms, buf };
}

export const CASES = {
    G: { label: 'djrust alone', engine: 'studio engine', run: (project, seconds) => djrustCase(48000, project, seconds) },
    H: { label: 'djrust alone @ 24 kHz', engine: 'eco tier candidate', run: (project, seconds) => djrustCase(24000, project, seconds) },
    I: { label: 'djrust DSP only (main thread)', engine: 'engine math alone', run: async (project, seconds) => {
        const dj = await djInstance(await djModule());
        dj.init(48000);
        dj.load(project); dj.play();
        const L = new Float32Array(128), R = new Float32Array(128);
        const blocks = Math.ceil(seconds * 48000 / 128);
        const t0 = performance.now();
        for (let i = 0; i < blocks; i++) { dj.process(128); dj.copyOut(L, R, 128); }
        return { ms: performance.now() - t0, buf: null };
    } },
    C: { label: 'wave alone', engine: 'JS wave engine', run: async (project, seconds) => {
        const ctx = nativeOffline(48000, seconds);
        const t0 = performance.now();
        (await waveNode(ctx, project)).connect(ctx.destination);
        const buf = await ctx.startRendering();
        return { ms: performance.now() - t0, buf };
    } },
    D: { label: 'wave alone @ 24 kHz', engine: 'JS wave, 24 kHz', run: async (project, seconds) => {
        const ctx = nativeOffline(24000, seconds);
        const t0 = performance.now();
        (await waveNode(ctx, project)).connect(ctx.destination);
        const buf = await ctx.startRendering();
        return { ms: performance.now() - t0, buf };
    } },
    E: { label: 'wave DSP only (main thread)', engine: 'JS wave math alone', run: async (project, seconds) => {
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
    let ranDjrust = false;
    for (const id of cases) {
        const c = CASES[id];
        if (!c) continue;
        if (onStart) onStart(id, c);
        await new Promise(r => setTimeout(r, 30)); // let the UI paint
        let row;
        if (id === 'G' || id === 'H' || id === 'I') ranDjrust = true;
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
    const report = {
        bench: 'beats-audio-engine/v1',
        ...(track || {}), seconds,
        at: new Date().toISOString(), device: await deviceInfo(), results,
    };
    if (ranDjrust && djVersion) report.engineVersion = djVersion;
    return report;
}

/** One-line recommendation from a report's 48 / 24 kHz cases: the studio engine (G, H), else the JS wave engine (C, D). */
export function recommend(report) {
    const x = (id) => report.results.find(r => r.case === id && !r.error)?.xRealtime;
    const pick = x('G') != null ? ['G', 'H', 'the studio engine'] : ['C', 'D', 'the wave engine'];
    const c = x(pick[0]), d = x(pick[1]), name = pick[2];
    if (c == null) return '';
    if (c >= 3) return `This device runs ${name} comfortably (${c}×).`;
    if (d != null && d >= 3) return `${name[0].toUpperCase() + name.slice(1)} is tight here (${c}×); the 24 kHz eco tier has room (${d}×).`;
    return `${name[0].toUpperCase() + name.slice(1)} is tight on this device (${c}×).`;
}
