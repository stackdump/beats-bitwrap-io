// Client-side audio render. Taps Tone's master output into a
// MediaStreamDestination + MediaRecorder, plays the loaded project for
// (totalSteps × tickIntervalMs + tail) wall-clock ms, and resolves with
// the captured webm Blob. Same machinery as the headless server render
// (lib/share/render-mode.js wraps this for chromedp), so output quality
// matches: the audio-grid scheduler in lib/backend/index.js locks every
// onset to the AudioContext clock regardless of CPU pressure.
//
// Caller responsibilities:
//   - The petri-note element must already have a project loaded
//     (`el._project` populated, `el._totalSteps` ≥ 0).
//   - Tone.js must be loaded on the page.
//   - The user must have already interacted with the page (autoplay
//     unlock) — call from a click handler, not on page load.

const PPQ = 4;            // mirrors sequencer-worker.js
const TAIL_MS = 1500;     // capture reverb / release tail past last tick
const LOOP_FALLBACK_TICKS = 1024; // ~64 bars @ PPQ 4 — same as render-mode.js

export function pickMimeType() {
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

// Returns true if the running browser can do a client render.
// MediaRecorder is broadly supported on desktop but partial on iOS Safari.
export function isClientRenderSupported() {
    return typeof MediaRecorder !== 'undefined' && pickMimeType() !== '';
}

// Render the currently-loaded project to a Blob.
// opts:
//   onProgress(ms, totalMs)  — called periodically while recording
//   maxMs                    — cap render duration; 0 = use track length
//
// Returns: { blob, mimeType, durationMs, totalSteps }
export async function renderToBlob(el, opts = {}) {
    const Tone = window.Tone;
    if (!Tone) throw new Error('Tone.js not loaded');
    if (!el._project) throw new Error('no project loaded');
    if (!isClientRenderSupported()) throw new Error('MediaRecorder unavailable in this browser');

    // Stop current playback so we don't capture the user's mid-song state.
    if (el._playing) el._togglePlay();

    // Make sure the AudioContext is unlocked. Safe to call when already
    // running. Throws on browsers that refuse without a fresh gesture —
    // caller should be inside a click handler.
    await Tone.start();
    const rawCtx = Tone.getContext().rawContext;

    const recDest = rawCtx.createMediaStreamDestination();
    Tone.getDestination().connect(recDest);

    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(recDest.stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

    const totalSteps = el._totalSteps > 0 ? el._totalSteps : LOOP_FALLBACK_TICKS;
    const tempo = el._tempo || 120;
    const tickIntervalMs = 60_000 / (tempo * PPQ);
    let durationMs = totalSteps * tickIntervalMs;
    if (opts.maxMs > 0 && durationMs > opts.maxMs) durationMs = opts.maxMs;

    recorder.start();
    // Start playback after the recorder is armed so the first onset is
    // captured (otherwise MediaRecorder discards the first ~50 ms).
    el._togglePlay();

    // Progress ticker on a 200 ms interval. Cheap, doesn't touch audio.
    let ticker = null;
    if (typeof opts.onProgress === 'function') {
        const startedAt = performance.now();
        ticker = setInterval(() => {
            const elapsed = performance.now() - startedAt;
            opts.onProgress(Math.min(elapsed, durationMs + TAIL_MS), durationMs + TAIL_MS);
        }, 200);
    }

    await new Promise((resolve) => setTimeout(resolve, durationMs + TAIL_MS));
    if (ticker) clearInterval(ticker);

    const stopped = new Promise((resolve) => { recorder.onstop = () => resolve(); });
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;

    if (el._playing) el._togglePlay();

    const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
    return { blob, mimeType: recorder.mimeType || mimeType || '', durationMs, totalSteps };
}

// Background-upload a freshly-rendered .webm to /audio/{cid}.webm so the
// server's audio cache picks it up (and the next listener / RSS feed gets
// it instantly instead of waiting for a server-side re-render). Trust
// model: first-write-wins on the server; this is fire-and-forget. Errors
// are logged to the console but never surfaced — failure to upload only
// means the next listener triggers a server render. Skips when the blob
// is empty or the CID is missing.
export async function uploadBlob(cid, blob) {
    if (!cid || !blob || !blob.size) return { uploaded: false, reason: 'no-blob' };
    try {
        const r = await fetch(`/audio/${encodeURIComponent(cid)}.webm`, {
            method: 'PUT',
            headers: { 'Content-Type': blob.type || 'audio/webm' },
            body: blob,
        });
        if (!r.ok) {
            console.warn(`[uploadBlob] ${cid}: ${r.status} ${r.statusText}`);
            return { uploaded: false, status: r.status };
        }
        // 201 = wrote; 200 = first-write-wins, server already had one.
        return { uploaded: r.status === 201, status: r.status };
    } catch (err) {
        console.warn('[uploadBlob] network error:', err);
        return { uploaded: false, error: err };
    }
}

// Trigger a browser download of a Blob. Cleans up the object URL on
// the next tick (revoke happens after the click event has dispatched
// and the browser has started the download stream).
export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
    }, 0);
}
