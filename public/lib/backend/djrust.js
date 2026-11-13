// The studio's audio engine: djrust (github.com/stackdump/djrust, MIT), the pinned npm package in
// public/djrust/version.js, in an AudioWorklet.
//
// The sequencer Worker keeps composing (generate, shuffle, arrange, ring resize, project-sync) and
// is never told to play: the project it composed is loaded into the djrust worklet as a raw-nets
// share (the engine plays exactly that project), transport / tempo / mutes / seeks go to the
// worklet, and the worklet's fires, ticks, mutes and marking are replayed into the normal
// handlers, so the tracks view, mixer, Stage and Scope draw from the audio being computed. The
// studio's controls go through audio/engine.js (FX panel, macros, mixer voices), which this
// module wires to the worklet and replays after every project load.
//
// A few controls have no djrust equivalent and are hidden rather than left doing nothing:
// the mixer's pan, lo-cut and resonance sliders and its test note, live transpose (the header
// pill and the Beats pads' Pit), the loop mode and crop, and the Scope's model views (their
// per-instrument kernels were Tone renders).
//
// Dev: ?djrust=<base URL of a djrust npm build, ending in />, e.g. a local
// `djrust/npm/build.sh` output served with CORS (scripts/serve-djrust-pkg.py).

import { audioEngine } from '../../audio/engine.js';
import { DJRUST_CDN, DJRUST_VERSION } from '../../djrust/version.js';
import { perfWaveLag } from '../perf/monitor.js';
import { planProjectControls } from './controls.js';

/** Where the djrust package is: the pinned CDN copy, or a dev override. */
export function djrustBase() {
    try {
        const o = new URLSearchParams(location.search).get('djrust');
        if (o) return new URL(o.endsWith('/') ? o : o + '/', location.href).href;
    } catch {}
    // absolute, since the worklet's blob module cannot resolve a path (a server run with
    // -djrust-pkg names its own /djrust-pkg/ here)
    try { return new URL(DJRUST_CDN, location.href).href; } catch { return DJRUST_CDN; }
}

// --- what is hidden (no djrust equivalent; not faked) ----------------------------------------

const HIDDEN = [
    // the mixer's pan, lo-cut and resonances: no live djrust strip pan / filter (label and slider)
    ...['pan', 'locut', 'loreso', 'reso'].map(k => `.pn-mixer-slider-group:has(> .pn-mixer-${k})`),
    '.pn-mixer-test',                                // test note: the engine plays nets, not notes
    '.pn-transpose', '.pn-mixer-slider-group:has(> .pn-os-pitch)', // live transpose: notes play as written
    '.pn-loop-mode-select', '.pn-crop-bar-btn',      // worker conflict modes / loop region
    '.pn-scope-model-only',                          // Scope model views (Tone kernels)
];

/** connectedCallback: hide what djrust has no equivalent for (a constructor may not add a class). */
export function showEngineGaps(el) {
    el.classList.add('pn-engine-djrust');
    if (document.getElementById('pn-engine-djrust-style')) return;
    const st = document.createElement('style');
    st.id = 'pn-engine-djrust-style';
    st.textContent = HIDDEN.map(s => `.pn-engine-djrust ${s}`).join(',\n') + ' { display: none !important; }';
    document.head.appendChild(st);
}

// --- the engine -----------------------------------------------------------------------------

async function compileWasm(url) {
    try { return await WebAssembly.compileStreaming(fetch(url)); }
    catch { // wrong content type from a dev server, or no compileStreaming
        const r = await fetch(url);
        if (!r.ok) throw new Error(`${url}: ${r.status}`);
        return WebAssembly.compile(await r.arrayBuffer());
    }
}

/** The worklet module: the polyfill, the pinned glue and worklet.js, named at run time. */
function bootstrapUrl(base) {
    const here = new URL('../../djrust/', import.meta.url).href;
    const src = `import ${JSON.stringify(here + 'polyfill.js')};\n` +
        `import * as djrust from ${JSON.stringify(base + 'djrust.js')};\n` +
        `import { define } from ${JSON.stringify(here + 'worklet.js')};\n` +
        `define(djrust);\n`;
    return URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
}

async function startComposer(base, module, sampleRate) {
    try {
        const w = new Worker(new URL('../../djrust/composer.js', import.meta.url), { type: 'module' });
        await new Promise((res, rej) => {
            w.onmessage = (ev) => (ev.data.t === 'ready' ? res() : rej(new Error(ev.data.error)));
            w.onerror = (e) => rej(new Error(e.message || 'composer worker failed'));
            w.postMessage({ t: 'init', glue: base + 'djrust.js', module, sampleRate });
        });
        return w;
    } catch (e) {
        console.warn('djrust engine: no composer Worker, loading inline:', e?.message || e);
        return null;
    }
}

/**
 * Why djrust cannot run on this page, or null. An AudioWorklet is only given to a secure context
 * (https, or http on localhost / 127.0.0.1): opened over plain http on a LAN address, Chrome has
 * no `AudioContext.audioWorklet` at all. `ctx`: the AudioContext, when there is one to look at.
 */
export function engineUnsupported(win = globalThis, ctx = null) {
    if (win.isSecureContext === false) {
        const origin = win.location?.origin || 'this page';
        return `${origin} is not a secure context, and browsers only run audio worklets on https ` +
            'pages or on localhost. Open the studio over https (see "LAN dev server over https" in ' +
            'CLAUDE.md) or at http://localhost.';
    }
    if (typeof win.AudioWorkletNode !== 'function' || (ctx && !ctx.audioWorklet)) {
        return 'This browser has no AudioWorklet, which the audio engine needs. Try a current Chrome, Firefox or Safari.';
    }
    return null;
}

/** Start the engine (once): the worklet on the studio's AudioContext, and the composer Worker. */
export function ensureDjrust(el) {
    if (el._dj) return el._dj;
    el._dj = (async () => {
        const early = engineUnsupported();
        if (early) throw new Error(early);
        const ctx = audioEngine.context();
        const late = engineUnsupported(globalThis, ctx);
        if (late) throw new Error(late);
        const base = djrustBase();
        const module = await compileWasm(base + 'djrust_bg.wasm');
        await ctx.audioWorklet.addModule(bootstrapUrl(base));
        const node = new AudioWorkletNode(ctx, 'djrust-engine', {
            numberOfInputs: 0, outputChannelCount: [2], processorOptions: { module },
        });
        const ready = await new Promise((res, rej) => {
            node.port.onmessage = (ev) => (ev.data.t === 'ready' ? res(ev.data) : ev.data.t === 'error' && rej(new Error(ev.data.error)));
        });
        const dj = {
            node, ctx, base, version: ready.version || DJRUST_VERSION, composer: null,
            serial: 0, lastNets: null,
            post: (m, transfer = []) => node.port.postMessage(m, transfer),
        };
        try { audioEngine.catalogue = JSON.parse(ready.catalogue || '[]'); } catch { audioEngine.catalogue = []; }
        audioEngine.emit('ready', dj);
        node.port.onmessage = (ev) => onEngineMessage(el, dj, ev.data);
        node.connect(audioEngine.output);
        audioEngine.attach(dj.post);
        dj.composer = await startComposer(base, module, ctx.sampleRate);
        if (dj.composer) dj.composer.onmessage = (ev) => onComposerMessage(el, dj, ev.data);
        console.log(`[djrust] engine ${dj.version} from ${base}${dj.composer ? ' (composer Worker)' : ''}`);
        if (el._lastProjectJSON) loadProject(el, dj, el._lastProjectJSON, true);
        return dj;
    })();
    el._dj.catch((err) => engineFailed(el, err));
    return el._dj;
}

/** djrust could not start (no network, a blocked CDN, an engine without the beats facade). */
function engineFailed(el, err) {
    const why = String(err?.message || err);
    console.error('[djrust] the audio engine did not start:', why);
    el._djrustError = why;
    el._dj = null;
    audioEngine.emit('failed', why);
    if (el._engineErrorBanner) {
        el._engineErrorBanner.querySelector('.pn-engine-error-why').textContent = why;
        if (!el._engineErrorBanner.isConnected) document.body.appendChild(el._engineErrorBanner);
        return;
    }
    const banner = document.createElement('div');
    banner.className = 'pn-audio-lock-banner pn-engine-error';
    banner.setAttribute('role', 'alert');
    banner.innerHTML = '<span>The audio engine did not load: <span class="pn-engine-error-why"></span></span><button>Retry</button>';
    banner.querySelector('.pn-engine-error-why').textContent = why;
    banner.title = why;
    banner.querySelector('button').addEventListener('click', () => {
        banner.remove();
        el._engineErrorBanner = null;
        ensureDjrust(el);
    });
    // on the body, not in the studio element, which a project load rebuilds
    document.body.appendChild(banner);
    el._engineErrorBanner = banner;
}

/**
 * The text a deck plays for the studio's project: the project plus its genre and seed, played
 * as written; or, for a `play: "dj"` share whose project is still the one composed for it, the
 * share's envelope, which djrust composes itself with the DJ pass (the same nets: the pass
 * rewrites notes, never places, transitions or arcs). Any edit plays as written from then on.
 */
function projectText(el, project) {
    const dj = el._djShare;
    if (dj && !dj.dropped) {
        const nets = JSON.stringify(project.nets || {});
        if (dj.nets == null) dj.nets = nets; // the first project composed for the share
        dj.active = dj.nets === nets;
        if (dj.active) return JSON.stringify(dj.envelope);
        dj.dropped = true; // edited: as written from here on
    }
    return asWrittenText(el, project);
}

function asWrittenText(el, project) {
    const genre = el.querySelector?.('.pn-genre-select')?.value || el._currentGen?.genre;
    const seed = el._currentGen?.params?.seed;
    return JSON.stringify({ ...project, genre, ...(Number.isFinite(seed) ? { seed } : {}) });
}

function loadProject(el, dj, project, force = false) {
    const nets = JSON.stringify(project.nets || {});
    if (!force && nets === dj.lastNets) {
        // same nets (a state-only sync): only the tempo may have moved
        if (project.tempo) dj.post({ t: 'tempo', bpm: project.tempo });
        return;
    }
    dj.lastNets = nets;
    planProjectControls(el, project);
    const serial = ++dj.serial;
    const m = {
        t: 'load', serial, text: projectText(el, project),
        muted: [...(el._mutedNets || [])], bpm: el._tempo || project.tempo || 0,
        playing: !!el._playing,
        // the studio's FX and mixer voices, put back on the project as it lands
        after: [...audioEngine.fxCommands(), ...audioEngine.voiceCommands(), ...audioEngine.vocoderCommands()],
    };
    if (!dj.composer) { dj.post(m); return; }
    dj.pending ||= new Map();
    dj.pending.set(serial, m);
    dj.composer.postMessage({ t: 'prepare', id: serial, text: m.text });
}

function onComposerMessage(el, dj, r) {
    const m = dj.pending?.get(r.id);
    if (!m) return;
    dj.pending.delete(r.id);
    if (r.id !== dj.serial) return; // a newer project is on its way
    if (r.t === 'prepared') dj.post({ ...m, prepared: r.bytes, prepareMs: r.ms }, [r.bytes.buffer]);
    else dj.post(m); // prepare failed: load inline
}

/**
 * routeToDjrust(el, msg) — called by sendWs. True when the message was consumed (must not
 * reach the worker), false to forward it as usual.
 */
export function routeToDjrust(el, msg) {
    const send = (m) => ensureDjrust(el).then(dj => dj.post(m)).catch(() => {});
    switch (msg.type) {
    case 'transport':
        if (msg.action === 'play') send({ t: 'play', on: true });
        else if (msg.action === 'pause') send({ t: 'play', on: false });
        else if (msg.action === 'stop') send({ t: 'stop' });
        return true; // the worker never plays
    case 'seek':
        send({ t: 'seek', tick: msg.tick });
        return true;
    case 'tempo':
        if (el._dj) send({ t: 'tempo', bpm: msg.bpm });
        return false; // the worker keeps its tempo and echoes tempo-changed to the UI
    case 'mute':
        if (el._dj) send({ t: 'mute', netId: msg.netId, muted: !!msg.muted });
        return false; // the worker keeps the mute table the mixer reads
    case 'mute-group':
        if (el._dj && el._project?.nets) {
            for (const [id, nb] of Object.entries(el._project.nets)) {
                if (nb.riffGroup === msg.riffGroup) send({ t: 'mute', netId: id, muted: !!msg.muted });
            }
        }
        return false;
    case 'instrument-change':
        // the mixer changed track.instrument in el._project; the worker has no handler for it
        djrustReloadProject(el);
        return false;
    case 'fire-macro':
        return true; // macros run in djrust (audio/engine.js fireMacro), not as worker control nets
    case 'cancel-macros':
        send({ t: 'perform', action: { op: 'panic' } });
        return false;
    case 'loop':
        return true; // hidden: djrust plays the whole project
    }
    return false;
}

/**
 * Reload the studio's current project (el._project) into djrust: after a change the studio
 * makes to it in place (an instrument pick, a shuffle) rather than through a project-sync.
 */
export function djrustReloadProject(el) {
    if (!el._dj || !el._project) return;
    el._dj.then(dj => loadProject(el, dj, el._project, true)).catch(() => {});
}

/** Called on every project-sync from the worker. */
export function djrustLoadProject(el, project) {
    if (!el._dj) return;
    el._dj.then(dj => loadProject(el, dj, project)).catch(() => {});
}

function onEngineMessage(el, dj, msg) {
    // per-type message counts, for devtools and the browser test
    (el._djrustStats ||= {})[msg.t] = (el._djrustStats[msg.t] || 0) + 1;
    switch (msg.t) {
    case 'events': return onEvents(el, dj, msg);
    case 'loaded':
        if (msg.serial === dj.serial) {
            el._djrustLoad = { ms: msg.ms, inline: msg.inline, steps: msg.steps, kb: msg.kb };
            // a reload while playing picks up where the old project was
            if (el._playing && el._tick > 0) dj.post({ t: 'seek', tick: el._tick });
        }
        return;
    case 'fx':
        audioEngine.setFxActive(msg.state);
        return;
    case 'voc':
        audioEngine.vocLevels = msg.levels;
        audioEngine.emit('voc', msg);
        return;
    case 'ended':
        el._handleWsMessage?.({ type: 'playback-complete' });
        return;
    case 'error':
        (el._djrustErrors ||= []).push(msg.error);
        if (el._djrustErrors.length > 50) el._djrustErrors.shift();
        console.warn('[djrust]', msg.error);
        return;
    }
}

function onEvents(el, dj, msg) {
    let ev;
    try { ev = JSON.parse(msg.ev); } catch { return; }
    const ctxNow = dj.ctx.currentTime;
    if (ev.tempo) el._djrustTempo = ev.tempo;
    perfWaveLag(el, (ctxNow - msg.at) * 1000);
    if (ev.muted) {
        const mutedNets = {};
        for (const id of ev.muted) mutedNets[id] = true;
        el._handleWsMessage?.({ type: 'mute-state', mutedNets, mutedNotes: {} });
    }
    // fire.frame is in the renderer's frame base, as is msg.frames (after this block)
    for (const [netId, transitionId, note, velocity, channel, tick, frame] of ev.fires) {
        const audioT = msg.at + (frame - msg.frames + 128) / msg.sr;
        el._handleWsMessage?.({
            type: 'transition-fired', netId, transitionId,
            midi: { note, velocity, channel }, tick: tick - 1, audioT,
        });
    }
    el._handleWsMessage?.({ type: 'state-sync', state: ev.marking || {}, tick: ev.tick });
}
