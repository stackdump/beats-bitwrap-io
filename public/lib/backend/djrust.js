// djrust engine glue (`?engine=djrust`). The default (Tone) engine is untouched: every function
// here is a no-op unless el._djrustEngine is set.
//
// djrust (github.com/stackdump/djrust, MIT, the pinned npm package in public/djrust/version.js)
// replaces the sound under the studio's own UI. As with ?engine=wave, the sequencer Worker keeps
// composing (generate, shuffle, arrange, ring resize, project-sync) and is never told to play:
// the project it composed is loaded into a djrust AudioWorklet as a raw-nets share (the engine
// plays exactly that project), transport / tempo / mutes / seeks go to the worklet, and the
// worklet's fires, ticks, mutes and marking are replayed into the normal handlers, so the tracks
// view, mixer, Stage and Scope draw from the audio being computed.
//
// The adapter half (installDjrustAdapter) keeps the `toneEngine` singleton the views import:
// what makes sound becomes a no-op, the master analyser and volume read djrust's output, and
// every control with no djrust equivalent yet is hidden rather than left doing nothing:
// FX / Macros / Beats / Auto-DJ / MIDI / Device panels, Feel, FX bypass / reset / panic, loop
// mode and crop, the mixer's per-channel tone controls, tone presets, test note and output
// device, and the Scope's model views (per-instrument kernels are a Tone render).
//
// Dev: ?djrust=<base URL of a djrust npm build, ending in />, e.g. a local
// `djrust/npm/build.sh` output served with CORS (scripts/serve-djrust-pkg.py).

import { toneEngine } from '../../audio/tone-engine.js';
import { DJRUST_CDN, DJRUST_VERSION } from '../../djrust/version.js';
import { perfWaveLag } from '../perf/monitor.js';

const PARAM = 'engine';

export function djrustEngineRequested() {
    try { return new URLSearchParams(location.search).get(PARAM) === 'djrust'; }
    catch { return false; }
}

/** Where the djrust package is: the pinned CDN copy, or a dev override. */
export function djrustBase() {
    try {
        const o = new URLSearchParams(location.search).get('djrust');
        if (o) return new URL(o.endsWith('/') ? o : o + '/', location.href).href;
    } catch {}
    return DJRUST_CDN;
}

const isMobile = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || '');

/**
 * Give Tone a native AudioContext before any Tone node exists, so the worklet module (ES
 * imports) can be added to the same context the studio graph uses. As ?engine=wave does.
 */
export function prepareDjrustContext() {
    const T = window.Tone;
    if (!T || typeof AudioContext === 'undefined') return;
    const latencyHint = isMobile() ? 'playback' : 'interactive';
    try { T.setContext(new T.Context(new AudioContext({ latencyHint }))); }
    catch (err) { console.warn('djrust engine: could not install a native AudioContext', err); }
}

// --- what is hidden while djrust plays (no equivalent yet; ported later, not faked) ---------

const HIDDEN = [
    '.pn-effects-btn', '.pn-effects-panel',          // master FX chain
    '.pn-macros-btn', '.pn-macros-panel',            // macro catalogue → djrust live ops: not mapped
    '.pn-oneshots-btn', '.pn-oneshots-panel',        // stinger pads fire macros
    '.pn-autodj-btn', '.pn-autodj-panel',            // Auto-DJ fires macros
    '.pn-midi-btn', '.pn-midi-panel',                // Web MIDI in / out
    '.pn-device-btn', '.pn-device-panel',            // APC mini (MIDI)
    '.pn-fx-bypass', '.pn-fx-reset', '.pn-macro-panic',
    '.pn-feel-open',                                 // Feel morphs FX + swing/humanize live
    '.pn-loop-mode-select', '.pn-crop-bar-btn',      // worker conflict modes / loop region
    // mixer: per-channel tone (Tone synth params), presets, test note, output device
    '.pn-mixer-slider-group', '.pn-mixer-output', '.pn-mixer-save', '.pn-mixer-test',
    '.pn-mixer-tone-reset', '.pn-mixer-tone-prev', '.pn-mixer-tone-next', '.pn-mixer-preset',
    // scope: the model views and the model/measured toggle (per-instrument Tone.Offline kernels)
    '.pn-scope-model-only',
];
const BLOCKED_KEYS = new Set(['f', 'j', 'p', 'b', 'r']);

/** Keyboard shortcuts of hidden controls do nothing while djrust plays. */
export function djrustBlocksKey(el, k) {
    return !!el._djrustEngine && BLOCKED_KEYS.has(k);
}

function installHiddenStyle(el) {
    el.classList.add('pn-engine-djrust');
    if (document.getElementById('pn-engine-djrust-style')) return;
    const st = document.createElement('style');
    st.id = 'pn-engine-djrust-style';
    st.textContent = HIDDEN.map(s => `.pn-engine-djrust ${s}`).join(',\n') + ' { display: none !important; }';
    document.head.appendChild(st);
}

/** connectedCallback: hide what djrust has no equivalent for (a constructor may not add a class). */
export function showDjrustEngine(el) {
    if (el._djrustEngine) installHiddenStyle(el);
}

// --- the toneEngine adapter -----------------------------------------------------------------

const patched = new Map();

function patch(name, fn) {
    if (!patched.has(name)) patched.set(name, toneEngine[name]);
    toneEngine[name] = fn;
}

/**
 * Keep the `toneEngine` surface the views use, with djrust underneath: nothing Tone would
 * play sounds (djrust renders every fire itself), panic is the engine's own business, and the
 * analyser the Stage reads taps djrust's output gain (`_waveGain`, which setMasterVolume and the
 * Scope already follow for the worklet engines).
 */
export function installDjrustAdapter(el) {
    if (!el._djrustEngine) return;
    const none = () => {};
    patch('playNote', none);
    patch('playOneShot', none);
    patch('playOneShotInstrument', none);
    patch('panic', none);
    patch('getMasterAnalyser', (type = 'waveform', size = 1024) => {
        const src = toneEngine._waveGain;
        if (!src || typeof Tone === 'undefined') return null;
        const key = `${type === 'fft' ? 'fft' : 'waveform'}:${size}`;
        el._djrustAnalysers ||= new Map();
        if (el._djrustAnalysers.has(key)) return el._djrustAnalysers.get(key);
        try {
            const a = new Tone.Analyser(type === 'fft' ? 'fft' : 'waveform', size);
            a.smoothing = type === 'fft' ? 0.6 : 0;
            Tone.connect(src, a);
            el._djrustAnalysers.set(key, a);
            return a;
        } catch { return null; }
    });
}

/** Put Tone back (djrust failed to start): the studio plays as if the flag were off. */
function uninstallDjrustAdapter(el) {
    for (const [name, fn] of patched) toneEngine[name] = fn;
    patched.clear();
    el.classList.remove('pn-engine-djrust');
}

// --- the engine -----------------------------------------------------------------------------

function connectOutput(node, ctx) {
    const gain = ctx.createGain();
    const db = toneEngine._masterVolume ? toneEngine._masterVolume.volume.value : -12;
    gain.gain.value = Math.pow(10, db / 20);
    node.connect(gain);
    // Phones: keep Tone's MediaStream → <audio> sink (keeps iOS playing through screen lock).
    gain.connect(toneEngine._masterSink?.streamDest || ctx.destination);
    toneEngine._waveGain = gain;
    // Tone's master chain is silent now; stop the audio thread pulling it.
    try { toneEngine._masterComp?.disconnect(); } catch {}
}

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

function ensureDjrust(el) {
    if (el._dj) return el._dj;
    el._dj = (async () => {
        await el._ensureToneStarted?.();
        const ctx = window.Tone.getContext().rawContext;
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
            serial: 0, lastNets: null, playing: false,
            post: (m, transfer = []) => node.port.postMessage(m, transfer),
        };
        node.port.onmessage = (ev) => onEngineMessage(el, dj, ev.data);
        connectOutput(node, ctx);
        dj.composer = await startComposer(base, module, ctx.sampleRate);
        if (dj.composer) dj.composer.onmessage = (ev) => onComposerMessage(el, dj, ev.data);
        console.log(`[djrust] engine ${dj.version} from ${base}${dj.composer ? ' (composer Worker)' : ''}`);
        if (el._lastProjectJSON) loadProject(el, dj, el._lastProjectJSON, true);
        return dj;
    })();
    el._dj.catch((err) => fallBackToTone(el, err));
    return el._dj;
}

/** djrust could not start (no network, an engine without the beats facade): play with Tone. */
function fallBackToTone(el, err) {
    console.warn('[djrust] engine unavailable, falling back to Tone:', err?.message || err);
    el._djrustEngine = false;
    el._djrustError = String(err?.message || err);
    el._dj = null;
    uninstallDjrustAdapter(el);
    if (el._lastProjectJSON) el._worker?.postMessage({ type: 'project-load', project: el._lastProjectJSON });
    if (el._playing) el._worker?.postMessage({ type: 'transport', action: 'play' });
}

/** The text a deck plays for the studio's project: the project plus its genre and seed. */
function projectText(el, project) {
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
    const serial = ++dj.serial;
    const m = {
        t: 'load', serial, text: projectText(el, project),
        muted: [...(el._mutedNets || [])], bpm: el._tempo || project.tempo || 0,
        playing: !!el._playing,
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
    if (!el._djrustEngine) return false;
    const send = (m) => ensureDjrust(el).then(dj => dj.post(m)).catch(() => {});
    switch (msg.type) {
    case 'transport':
        if (msg.action === 'play') send({ t: 'play', on: true });
        else if (msg.action === 'pause') send({ t: 'play', on: false });
        else if (msg.action === 'stop') send({ t: 'stop' });
        return true; // the worker never plays while djrust does
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
    case 'loop':
        return true; // hidden controls; nothing to send
    }
    return false;
}

/**
 * Reload the studio's current project (el._project) into djrust: after a change the studio
 * makes to it in place (an instrument pick, a shuffle) rather than through a project-sync.
 */
export function djrustReloadProject(el) {
    if (!el._djrustEngine || !el._dj || !el._project) return;
    el._dj.then(dj => loadProject(el, dj, el._project, true)).catch(() => {});
}

/** Called on every project-sync from the worker. */
export function djrustLoadProject(el, project) {
    if (!el._djrustEngine || !el._dj) return;
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
    case 'ended':
        el._handleWsMessage?.({ type: 'playback-complete' });
        return;
    case 'error':
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
