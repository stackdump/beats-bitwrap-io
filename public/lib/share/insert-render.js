// Insert render — page-side entry point for PR-4.3.2 counterMelody synthesis. The Go side
// stashes a note payload via POST /api/insert-notes, then chromedp navigates to
// /?insert=counterMelody&notesId={id}&durationMs={ms}. This module fetches the payload, writes
// the notes as a beats project (one single-token ring per voice, a transition per tick, the
// notes bound on theirs), renders it with djrust's offline render (the same engine and voices as
// the rest of the mix, deterministic), encodes a 48 kHz / 16-bit / stereo PCM WAV blob, and
// exposes it on window.__renderBlob the same way render-mode.js does for share renders.

import { renderOffline, encodeWav } from './djrust-offline.js';

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

    const project = notesProject(notes, { tempo, channel, instrument, durationSec, tickIntervalMs });
    const { samples, version } = await renderOffline(JSON.stringify(project), durationSec, SAMPLE_RATE);
    window.__renderInfo.engineVersion = version;
    const blob = encodeWav(samples, SAMPLE_RATE);
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

/**
 * The notes as a beats project djrust plays: each voice (the n-th note of every tick) is a ring
 * of one place and one transition per tick, the token going round once over the render, with
 * the notes bound on the transitions of their ticks.
 */
export function notesProject(notes, { tempo, channel, instrument, durationSec, tickIntervalMs }) {
    const ticks = Math.max(1, Math.ceil(durationSec * 1000 / tickIntervalMs) + 1);
    const byTick = new Map();
    for (const ev of notes) {
        const t = Math.max(0, Math.min(ticks - 1, Math.round(ev.tick || 0)));
        if (!byTick.has(t)) byTick.set(t, []);
        byTick.get(t).push(ev);
    }
    const voices = Math.max(1, ...[...byTick.values()].map(l => l.length));
    const nets = {};
    for (let v = 0; v < voices; v++) {
        const places = {}, transitions = {}, arcs = [];
        for (let t = 0; t < ticks; t++) {
            places[`p${t}`] = { initial: [t === 0 ? 1 : 0], x: t * 10, y: v * 40 };
            const ev = byTick.get(t)?.[v];
            const tr = { x: t * 10 + 5, y: v * 40 };
            if (ev) {
                tr.midi = {
                    note: ev.note, channel, velocity: ev.velocity || 90,
                    durationSteps: Math.max(1, ev.durationTicks || 4),
                };
            }
            transitions[`t${t}`] = tr;
            arcs.push({ source: `p${t}`, target: `t${t}`, weight: [1] });
            arcs.push({ source: `t${t}`, target: `p${(t + 1) % ticks}`, weight: [1] });
        }
        nets[`insert-${v}`] = {
            role: 'music',
            track: { channel, instrument, group: 'melody', defaultVelocity: 90 },
            places, transitions, arcs,
        };
    }
    return { name: 'insert', tempo, nets };
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
