// Insert render — page-side entry point for PR-4.3.2 counterMelody
// synthesis. The Go side stashes a note payload via POST
// /api/insert-notes, then chromedp navigates to
// /?insert=counterMelody&notesId={id}&durationMs={ms}. This module fetches
// the payload, renders it offline and exposes a 48 kHz / 16-bit / stereo
// WAV on window.__renderBlob the way render-mode.js does for shares.
//
// The note list becomes a small project (buildInsertProject): one music
// net per simultaneous-note layer, each built by countermelody's
// buildMusicNet (the same net the arrange counterMelody directive
// injects) as a ring longer than the render, so nothing wraps and plays
// twice. That project is rendered by the djrust worklet in an
// OfflineAudioContext through offline-render.js's renderProjectOffline,
// the path shares take. The engine is a pure function of the project, so
// the WAV is deterministic: scripts/test-insert-render.mjs renders the
// same project with the Node loader and checks both the bytes and their
// repeatability. (MIGRATION-djrust-wasm.md §12 R-12; the old Tone.Offline
// graph with one ToneEngine instrument is gone.)

import { audioBufferToWavBlob, renderProjectOffline, wasmUrlFromPage } from './offline-render.js';
import { buildMusicNet } from '../generator/countermelody.js';

const PPQ = 4;
const SAMPLE_RATE = 48000;
const TAIL_SECONDS = 0.25;
const DEFAULT_TEMPO = 124;
const DEFAULT_DURATION_MS = 4000;
const DEFAULT_CHANNEL = 5;

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

    const spec = buildInsertProject(payload, insertType);
    const { instrument, notes, durationSec } = spec;

    window.__renderInfo = {
        started: true,
        mode: 'insert',
        insertType,
        durationMs: durationSec * 1000,
        noteCount: notes.length,
        instrument,
        layers: spec.layers,
    };
    console.log('[insert-render]',
        'type=', insertType, 'notes=', notes.length, 'layers=', spec.layers,
        'instrument=', instrument, 'durationSec=', durationSec.toFixed(3));

    const buffer = await renderNotesOffline(spec);

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

// buildInsertProject turns the /api/insert-notes payload
//   { notes: [{tick, note, velocity, durationTicks}], durationMs, tempo,
//     channel, instrument }
// into a project JSON object plus the render parameters. Pure and
// deterministic (no DOM), so Node builds the identical project.
//
// buildMusicNet binds one note per transition, so notes sharing a start
// tick go to separate nets: layer k holds the k-th note (payload order) at
// each tick. Every layer is a ring of `ringTicks` steps, more than the
// render covers, so no note repeats inside it. Note sustains are legacy
// ms (`duration`) against the payload's fixed tempo.
export function buildInsertProject(payload, insertType) {
    const p = payload || {};
    const tempo = +p.tempo || DEFAULT_TEMPO;
    const tickIntervalMs = 60_000 / (tempo * PPQ);
    const durationSec = (+p.durationMs || DEFAULT_DURATION_MS) / 1000 + TAIL_SECONDS;
    const channel = +p.channel || DEFAULT_CHANNEL;
    const instrument = p.instrument || pickDefaultInstrument(insertType);
    const notes = Array.isArray(p.notes) ? p.notes : [];
    const ringTicks = Math.ceil((durationSec * 1000) / tickIntervalMs) + 1;

    const layers = [];
    const depth = new Map(); // tick -> notes already placed at it
    for (const n of notes) {
        const tick = Math.floor(+n.tick);
        if (!(tick >= 0 && tick < ringTicks)) continue;
        const k = depth.get(tick) || 0;
        depth.set(tick, k + 1);
        if (!layers[k]) layers[k] = [];
        layers[k].push({
            startTick: tick,
            note: n.note | 0,
            velocity: (+n.velocity > 0) ? (n.velocity | 0) : 90,
            duration: +n.durationTicks > 0 ? +n.durationTicks : 1,
        });
    }

    const nets = {};
    layers.forEach((layer, k) => {
        nets[`insert-${k}`] = buildMusicNet(layer, {
            totalTicks: ringTicks,
            channel,
            instrument,
            group: 'melody',
            msPerTick: tickIntervalMs,
        });
    });

    return {
        project: { name: `insert-${insertType || 'notes'}`, tempo, nets },
        tempo,
        tickIntervalMs,
        durationSec,
        sampleRate: SAMPLE_RATE,
        channel,
        instrument,
        notes,
        ringTicks,
        layers: layers.length,
    };
}

// renderNotesOffline renders a buildInsertProject result through the
// djrust worklet in an OfflineAudioContext (renderProjectOffline) and
// returns the AudioBuffer. An empty note list renders silence.
export async function renderNotesOffline(spec, opts = {}) {
    const { buffer } = await renderProjectOffline(spec.project, {
        durationSec: spec.durationSec,
        sampleRate: spec.sampleRate || SAMPLE_RATE,
        tempo: spec.tempo,
        wasmUrl: opts.wasmUrl !== undefined ? opts.wasmUrl : wasmUrlFromPage(),
    });
    return buffer;
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
