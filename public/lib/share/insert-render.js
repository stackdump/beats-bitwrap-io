// Insert render — page-side entry point for PR-4.3.2 counterMelody
// synthesis. The Go side stashes a note payload via POST
// /api/insert-notes, then chromedp navigates to
// /?insert=counterMelody&notesId={id}&durationMs={ms}. This module fetches
// the payload, renders it offline and exposes a 48 kHz / 16-bit / stereo
// WAV on window.__renderBlob the way render-mode.js does for shares.
//
// NOT AVAILABLE on the djrust engine yet (rebuild item,
// docs/MIGRATION-djrust-wasm.md §12). The old path built a Tone.Offline
// graph with one ToneEngine instrument. The djrust equivalent is to wrap
// the note list in a one-net project (a ring of `durationTicks` steps with
// the notes bound to their ticks) and render it through the worklet in an
// OfflineAudioContext, as offline-render.js does for shares. Until then
// the page reports an error, which the Go side (internal/audiorender)
// surfaces as a failed insert render.

import { audioBufferToWavBlob } from './offline-render.js';

const PPQ = 4;
const SAMPLE_RATE = 48000;

export function isInsertRenderMode() {
    try {
        const v = new URLSearchParams(location.search).get('insert');
        return !!v && v.length > 0;
    } catch {
        return false;
    }
}

export function initInsertRenderMode() {
    if (!isInsertRenderMode()) return;
    document.body.classList.add('pn-render-mode');
    window.__renderDone = false;
    window.__renderBlob = null;
    window.__renderError = null;
    window.__renderInfo = { started: false, mode: 'insert' };
    runInsertRender().catch((err) => {
        console.error('[insert-render] failed:', err && err.message || err);
        window.__renderError = String(err && err.message || err);
        window.__renderDone = true;
    });
}

async function runInsertRender() {
    const params = new URLSearchParams(location.search);
    const insertType = params.get('insert');
    const notesId = params.get('notesId');
    if (!notesId) throw new Error('missing notesId');


    // Pull the note payload from the in-memory ephemeral store the
    // Go side posted to. This is the contract the worker depends on.
    const resp = await fetch('/api/insert-notes/' + encodeURIComponent(notesId));
    if (!resp.ok) {
        throw new Error('notes fetch HTTP ' + resp.status + ' (TTL is 5 min — did chromedp take too long to boot?)');
    }
    const payload = await resp.json();

    const tempo = +payload.tempo || 124;
    const tickIntervalMs = 60_000 / (tempo * PPQ);
    const durationSec = (+payload.durationMs || 4000) / 1000 + 0.25; // 250 ms tail
    const channel = +payload.channel || 5;
    const instrument = payload.instrument || pickDefaultInstrument(insertType);
    const notes = Array.isArray(payload.notes) ? payload.notes : [];

    window.__renderInfo = {
        started: true,
        mode: 'insert',
        insertType,
        durationMs: durationSec * 1000,
        noteCount: notes.length,
        instrument,
    };
    console.log('[insert-render]',
        'type=', insertType, 'notes=', notes.length,
        'instrument=', instrument, 'durationSec=', durationSec.toFixed(3));

    const buffer = await renderNotesOffline({ channel, instrument, notes, tickIntervalMs, durationSec });

    const blob = audioBufferToWavBlob(buffer);
    window.__renderInfo.mimeType = blob.type;
    window.__renderInfo.byteLength = blob.size;
    window.__renderBlob = await blobToBase64(blob);
    window.__renderDone = true;
}

// pickDefaultInstrument matches the genre-instruments map style. For
// counterMelody we want a complementary lead voice that sits well
// against typical source tracks. supersaw is the most common
// channel-5 instrument across techno/house/edm presets.
function pickDefaultInstrument(insertType) {
    if (insertType === 'counterMelody') return 'supersaw';
    return 'supersaw';
}

// The rebuild goes here (see the header). Kept as one function so the
// payload handling above stays as it is.
async function renderNotesOffline(_spec) {
    throw new Error('insert render is not available on the djrust engine yet');
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
