// Render mode (?render=1). Headless-friendly playback path:
// - Tap Tone's master output into a MediaStreamDestination + MediaRecorder
//   (webm/opus). The Go renderer (chromedp) reads the blob out as base64,
//   remuxes to ogg/opus on disk, and serves the cached file.
// - Auto-resume the AudioContext (Chromium is launched with
//   --autoplay-policy=no-user-gesture-required so this just works).
// - Wait until the share has applied and the structure has populated
//   `el._totalSteps`, then start playback and arm a wall-clock timer for
//   total_ticks × tick_interval_ms + tail. When the timer fires, stop
//   the recorder, base64-encode the blob, and flip window.__renderDone.
//
// Globals exposed for the renderer:
//   window.__renderInfo = { durationMs, totalSteps, tempo, ppq, started }
//   window.__renderDone = boolean
//   window.__renderBlob = base64 string (set right before __renderDone)
//   window.__renderError = string  (set if anything blew up)

const PPQ = 4;                // mirrors sequencer-worker.js
const TAIL_MS = 1500;         // capture reverb / release tail past last tick
const POLL_INTERVAL_MS = 100; // how often we check for project readiness
const READY_TIMEOUT_MS = 30_000;
// Loop-only payloads (no structure) never set _totalSteps. Render this
// many ticks of audio so listeners get something — still bounded by
// the renderer's maxMs ceiling.
const LOOP_FALLBACK_TICKS = 1024; // ~64 bars @ PPQ 4

export function isRenderMode() {
    try {
        return new URLSearchParams(location.search).get('render') === '1';
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

    // Visual work the page does every frame (ring canvas redraw,
    // particle viz, chase-light pulses, stage panels, mixer DOM)
    // saturates the CPU on a small render box and starves the worker's
    // setInterval, producing audible jitter in the captured webm. The
    // headless render doesn't need any of it. Stub rAF before runRender
    // awaits — every rAF chain in the page no-ops itself out at the
    // first tick, freeing the core for the worker. Audio scheduling
    // runs through Tone.js / AudioContext, never touches rAF.
    let rafId = 0;
    window.requestAnimationFrame = function () { return ++rafId; };
    window.cancelAnimationFrame  = function () {};

    runRender(el).catch((err) => {
        console.error('[render-mode] failed:', err && err.message || err);
        window.__renderError = String(err && err.message || err);
        window.__renderDone = true;
    });
}

async function runRender(el) {
    const Tone = await waitForTone();
    const maxMs = readMaxMs();
    await waitForReady(el);

    // Resume the AudioContext. Chromium without a user gesture would
    // normally refuse — the launch flag --autoplay-policy=no-user-gesture-required
    // makes start() succeed.
    await Tone.start();
    const rawCtx = Tone.getContext().rawContext;

    const recDest = rawCtx.createMediaStreamDestination();
    // Tone.getDestination() is a Gain wrapping rawCtx.destination. Connecting
    // it to recDest taps the master in parallel — audio still goes to the
    // (silent, in headless) speakers and is captured.
    Tone.getDestination().connect(recDest);

    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(recDest.stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

    // Prefer the arranged length (composer set _totalSteps from structure);
    // fall back to a fixed window for loop-only payloads. Either way, the
    // renderer-supplied maxMs is the hard ceiling.
    const totalSteps = el._totalSteps > 0 ? el._totalSteps : LOOP_FALLBACK_TICKS;
    const tempo = el._tempo || 120;
    const tickIntervalMs = 60_000 / (tempo * PPQ);
    let durationMs = totalSteps * tickIntervalMs;
    let cappedByMax = false;
    if (maxMs > 0 && durationMs > maxMs) {
        durationMs = maxMs;
        cappedByMax = true;
    }

    window.__renderInfo = {
        started: true,
        totalSteps,
        tempo,
        ppq: PPQ,
        tickIntervalMs,
        durationMs,
        cappedByMax,
        loopFallback: !(el._totalSteps > 0),
        mimeType: recorder.mimeType || mimeType || '',
    };

    recorder.start();
    console.log('[render-mode] recording, durationMs=', durationMs,
                'totalSteps=', totalSteps, 'tempo=', tempo,
                'loopFallback=', !(el._totalSteps > 0), 'cappedByMax=', cappedByMax);
    if (!el._playing) el._togglePlay();

    await sleep(durationMs + TAIL_MS);

    const stopped = new Promise((resolve) => { recorder.onstop = () => resolve(); });
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;

    if (el._playing) el._togglePlay();

    const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
    window.__renderBlob = await blobToBase64(blob);
    window.__renderInfo.byteLength = blob.size;
    window.__renderDone = true;
}

function pickMimeType() {
    if (typeof MediaRecorder === 'undefined') return '';
    const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
    ];
    for (const c of candidates) {
        if (MediaRecorder.isTypeSupported(c)) return c;
    }
    return '';
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
