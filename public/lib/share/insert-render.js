// Insert render — page-side entry point for PR-4.3.2 counterMelody
// synthesis via Tone.js OfflineAudioContext. The Go side stashes a
// note payload via POST /api/insert-notes, then chromedp navigates
// to /?insert=counterMelody&notesId={id}&durationMs={ms}. This
// module fetches the payload, builds a Tone.Offline graph using
// the same ToneEngine the studio uses (so timbre matches the rest
// of the mix), encodes the result as a 48 kHz / 16-bit / stereo
// PCM WAV blob, and exposes it on window.__renderBlob the same way
// render-mode.js does for share renders.
//
// Why a separate module rather than reusing renderToBlobOffline?
// renderToBlobOffline reads from el._project (a fully-loaded share);
// counterMelody isn't a share — it's a synthesised note sequence
// that needs Tone.Offline + an instrument but no project state.
// Sharing the WAV encoder keeps the bytes byte-identical.

import { ToneEngine } from '/audio/tone-engine.js';
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

    await waitForTone();
    const Tone = window.Tone;

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

    const buffer = await Tone.Offline(async () => {
        const engine = new ToneEngine();
        engine._offline = true;
        await engine.init();
        await engine.loadInstrument(channel, instrument);
        for (const ev of notes) {
            const t = (ev.tick || 0) * (tickIntervalMs / 1000);
            const dur = ((ev.durationTicks || 4) * tickIntervalMs);
            engine.playNote({
                channel,
                note: ev.note,
                velocity: ev.velocity || 90,
                duration: dur,
            }, t);
        }
    }, durationSec, 2, SAMPLE_RATE);

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

async function waitForTone() {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (typeof window !== 'undefined' && window.Tone) return window.Tone;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Tone.js never loaded');
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
