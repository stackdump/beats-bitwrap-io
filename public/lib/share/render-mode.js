// Render mode (?render=1). Headless-friendly playback path used by the
// Go renderer (chromedp). Thin wrapper around `client-render.js`:
// waits for the project to load, then runs `renderToBlob` and
// base64-stuffs the result into `window.__renderBlob` so chromedp can
// read it out via `Runtime.evaluate`. The capture pipeline itself
// (MediaStreamDestination → MediaRecorder → webm/opus) lives in
// client-render.js so it can also be triggered from a user button.
//
// Globals exposed for the renderer:
//   window.__renderInfo = { durationMs, totalSteps, tempo, ppq, started, ... }
//   window.__renderDone = boolean
//   window.__renderBlob = base64 string (set right before __renderDone)
//   window.__renderError = string  (set if anything blew up)

import { renderToBlob } from './client-render.js';
import { renderToBlobOffline, isOfflineRenderMode } from './offline-render.js';

const PPQ = 4;                // mirrors sequencer-worker.js
const POLL_INTERVAL_MS = 100; // how often we check for project readiness
const READY_TIMEOUT_MS = 30_000;

export function isRenderMode() {
    try {
        const v = new URLSearchParams(location.search).get('render');
        return v === '1' || v === 'offline';
    } catch {
        return false;
    }
}

export function initRenderMode(el) {
    if (!isRenderMode()) return;
    console.log('[render-mode] init');
    document.body.classList.add('pn-render-mode');
    window.__renderDone = false;
    window.__renderBlob = null;
    window.__renderError = null;
    window.__renderInfo = { started: false };

    runRender(el).catch((err) => {
        console.error('[render-mode] failed:', err && err.message || err);
        window.__renderError = String(err && err.message || err);
        window.__renderDone = true;
    });
}

async function runRender(el) {
    await waitForTone();
    await waitForReady(el);
    const maxMs = readMaxMs();

    const totalSteps = el._totalSteps > 0 ? el._totalSteps : 1024;
    const tempo = el._tempo || 120;
    const tickIntervalMs = 60_000 / (tempo * PPQ);

    window.__renderInfo = {
        started: true,
        totalSteps,
        tempo,
        ppq: PPQ,
        tickIntervalMs,
        durationMs: totalSteps * tickIntervalMs,
        cappedByMax: maxMs > 0 && totalSteps * tickIntervalMs > maxMs,
        loopFallback: !(el._totalSteps > 0),
    };

    const offline = isOfflineRenderMode();
    window.__renderInfo.mode = offline ? 'offline' : 'realtime';
    console.log('[render-mode] recording, mode=', window.__renderInfo.mode,
                'durationMs=', window.__renderInfo.durationMs,
                'totalSteps=', totalSteps, 'tempo=', tempo,
                'loopFallback=', window.__renderInfo.loopFallback,
                'cappedByMax=', window.__renderInfo.cappedByMax);

    let blob, mimeType, extras = {};
    if (offline) {
        const out = await renderToBlobOffline(el, { maxMs });
        blob = out.blob;
        mimeType = out.mimeType;
        extras = {
            offlineWallMs: out.offlineWallMs,
            speedupX: out.speedupX,
            eventCount: out.eventCount,
        };
        console.log('[render-mode] offline render done',
                    'wallMs=', out.offlineWallMs, 'speedup=', out.speedupX + 'x',
                    'events=', out.eventCount);
    } else {
        const out = await renderToBlob(el, { maxMs });
        blob = out.blob;
        mimeType = out.mimeType;
    }
    window.__renderInfo.mimeType = mimeType;
    window.__renderInfo.byteLength = blob.size;
    Object.assign(window.__renderInfo, extras);
    window.__renderBlob = await blobToBase64(blob);
    window.__renderDone = true;
}

async function waitForTone() {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (typeof window !== 'undefined' && window.Tone) return window.Tone;
        await sleep(POLL_INTERVAL_MS);
    }
    throw new Error('Tone.js never loaded');
}

async function waitForReady(el) {
    // We need the project loaded; the structure is optional (loop-only
    // payloads will fall back to LOOP_FALLBACK_TICKS). Wait for the
    // project; once it's there, give the structure a brief window to
    // populate so arranged tracks get their natural length.
    const projDeadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < projDeadline) {
        if (el._project) break;
        await sleep(POLL_INTERVAL_MS);
    }
    if (!el._project) throw new Error('project never loaded');
    // Up to 2s for the canvas to compute _totalSteps from the arranged
    // structure. Loop-only payloads will skip this entirely.
    const structDeadline = Date.now() + 2_000;
    while (Date.now() < structDeadline) {
        if (el._totalSteps > 0) return;
        await sleep(POLL_INTERVAL_MS);
    }
}

function readMaxMs() {
    try {
        const raw = new URLSearchParams(location.search).get('maxMs');
        const n = raw == null ? 0 : parseInt(raw, 10);
        return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
        return 0;
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => {
            const dataUrl = String(reader.result || '');
            const comma = dataUrl.indexOf(',');
            resolve(comma >= 0 ? dataUrl.slice(comma + 1) : '');
        };
        reader.readAsDataURL(blob);
    });
}
