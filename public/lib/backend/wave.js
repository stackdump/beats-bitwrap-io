// Engine glue: the djrust engine (public/djrust/, djwasm.wasm in an
// AudioWorklet) is the studio's only audio engine.
//
// The worklet is the clock and the sound source. The sequencer worker keeps
// composing (generate, shuffle, arrange, project-sync) but is never told to
// play; transport goes to the worklet instead, and the worklet's ticks are
// replayed into the normal handlers so the canvas, mixer and Stage
// visualizers read the marking the audio is being computed from.
//
// What the engine runs is feature-detected from the module itself
// (djw_features; public/djrust/loader.js FEATURE), never assumed from a
// version: el._engineFeatures is that mask, probed once per page
// (probeEngineFeatures) and drawn into lib/ui/engine-gaps.js. On djwasm 0.2.0
// it is 0 and nothing below reaches the engine (the 0.2.0 studio). With the
// bits djwasm 0.3.0 ("net clock") sets:
//
//   NET_MACROS      net macros (Mute, Tempo) run in the engine: the page
//                   posts {type:'fire-macro', id, duration} (engineFireMacro)
//                   and its macro UI follows the engine's events
//                   (macro-fired / macro-restored, lib/macros/runtime.js
//                   onEngineMacroEvent) and the wave-tick's macroMask. A
//                   panic posts {type:'panic'}; a stopped engine reports no
//                   tick after it, so a stop or Panic while it held a macro
//                   puts the page's mutes and tempo back itself
//                   (settleStoppedEngine).
//   CONTROL_MACROS  control nets' fire-macro run in the engine. The page
//                   turns that on at start with its disabled list
//                   ({type:'control-macros', on, disabled}), so 'control-fired'
//                   is UI only (backend/index.js) and nothing fires twice.
//   SEEK            a timeline seek while playing is {type:'seek', tick}
//                   (answered by 'seeked' and a state tick); a Play from a
//                   playhead past 0 (a seek while stopped, a loop start)
//                   seeks the engine there first.
//   GROOVE          swing / humanize reach the engine only as an explicit
//                   override (a share value off the genre's composed default,
//                   or setGroove from a session control): the engine is then
//                   made with FLAG.GROOVE. Genre defaults stay unapplied, so
//                   the default sound is djwasm 0.2.0's. A render page (the
//                   farm, isRenderPage) takes no share groove at all.
//
// The engine's tempo (a tempo macro moves it) comes back on the wave-tick and
// is shown, never posted back. Not routed to the engine yet (rebuild items,
// docs/MIGRATION-djrust-wasm.md §12): master / aux macros (djwasm 0.4.0),
// loop regions, live transpose, instrument change, per-channel mixer
// settings, master FX.
//
// Page-side clock consumers (R-2): Auto-DJ's cadence and the repeating
// one-shots are fed from every wave-tick (feedWaveTick), not from the
// every-sixth-tick state-sync the worker used to drive them with. The mute
// state the worklet reports is the playing one: the worker's own mute-state
// yields to it (backend/index.js 'mute-state'), so mutes the engine's
// control nets and macros hold are not overwritten by the worker's
// never-playing view.
//
// The JS wave engine (public/wave-engine/) is no longer a runtime fallback; it
// stays in the repo as the parity oracle `make test-djrust` compares against.

import { audioHost } from '../../audio/host.js';
import { createDjrustEngine, loadDjwasmModule } from '../../djrust/node.js';
import { instantiate, FEATURE, FLAG } from '../../djrust/loader.js';
import { perfWaveLag } from '../perf/monitor.js';
import { setEngineFeatures as drawEngineGaps } from '../ui/engine-gaps.js';
import { onEngineMacroEvent, engineMacroTick, loadDisabledMacros } from '../macros/runtime.js';

/** Always true: every studio page plays through the djrust worklet. */
export function waveEngineRequested() { return true; }

/**
 * A render page: the farm's ?render=1 (realtime capture of this live engine)
 * or ?render=offline. Feed bakes stay djwasm 0.2.0's audio until Matt decides
 * otherwise (studio plan decisions 1 and 5), so a render page takes no share
 * groove (activeGroove) and runs no Auto-DJ (lib/macros/runtime.js).
 */
export function isRenderPage() {
    try {
        const v = new URLSearchParams(globalThis.location?.search || '').get('render');
        return v === '1' || v === 'offline';
    } catch { return false; }
}

function djrustWasmUrl() {
    try { return new URLSearchParams(location.search).get('djrust-wasm') || undefined; }
    catch { return undefined; }
}

function showEngineError(el, message) {
    if (el._engineErrorBanner || typeof document === 'undefined') return;
    const banner = document.createElement('div');
    banner.className = 'pn-audio-lock-banner pn-engine-error';
    banner.textContent = `Audio engine failed to load: ${message}`;
    el.appendChild?.(banner);
    el._engineErrorBanner = banner;
}

// --- What the engine runs ---

/** Does the loaded module run `bit` (a loader.js FEATURE value)? */
export function engineHas(el, bit) { return ((el._engineFeatures | 0) & bit) === bit; }

/** Record the module's feature mask and redraw the engine gaps for it. */
export function setEngineFeatures(el, features) {
    el._engineFeatures = Number(features) | 0;
    drawEngineGaps(el._engineFeatures, el.ownerDocument || (typeof document !== 'undefined' ? document : null));
}

/**
 * Ask the module what it runs: the same module the engine will load (pin, or
 * ?djrust-wasm=), compiled once per page (node.js loadDjwasmModule) and
 * instantiated off the audio graph just to read djw_features. Started when
 * the backend connects, so the macro panel can show before the first Play.
 * Resolves to the mask (0 when the module cannot be had: nothing is routed).
 */
export function probeEngineFeatures(el) {
    if (el._engineFeaturesProbe) return el._engineFeaturesProbe;
    const p = (async () => {
        const { module } = await loadDjwasmModule(djrustWasmUrl());
        return (await instantiate(module)).features;
    })().then((features) => { setEngineFeatures(el, features); return el._engineFeatures; },
        (err) => {
            if (el._engineFeaturesProbe === p) el._engineFeaturesProbe = null; // a later Play retries
            console.warn('djrust features unavailable:', err);
            return el._engineFeatures | 0;
        });
    el._engineFeaturesProbe = p;
    return p;
}

// --- Groove (R-8) ---

/**
 * The swing / humanize a share asks for explicitly, or null. Every share
 * carries both (lib/share/collect.js writes the project's), so a value is an
 * override only when it is off the genre's composed default `base`
 * ({swing, humanize}); a share at the default leaves the engine on its
 * 0.2.0 default path. Pure.
 */
export function grooveOverride(ov, base) {
    if (!ov) return null;
    const hasS = typeof ov.swing === 'number' && Number.isFinite(ov.swing);
    const hasH = typeof ov.humanize === 'number' && Number.isFinite(ov.humanize);
    if (!hasS && !hasH) return null;
    const bs = Number(base?.swing) || 0, bh = Number(base?.humanize) || 0;
    const swing = hasS ? ov.swing : bs, humanize = hasH ? ov.humanize : bh;
    if (swing === bs && humanize === bh) return null;
    return { swing, humanize };
}

/** The groove in force: a session setting, or the loaded share's override. */
function activeGroove(el) {
    const g = el._grooveOverride;
    if (!g) return null;
    if (g.source === 'share') {
        // A share's override belongs to that share's track: a new track drops it.
        if (g.gen !== el._currentGen) return null;
        // A farm bake (a render page) keeps the 0.2.0 sound: no share groove.
        if (isRenderPage()) return null;
    }
    return g;
}

/**
 * Route a share's swing / humanize (its overrides block; called from
 * waveLoadProject with the project it loads). The default they are measured
 * against is the genre's (lib/ui/build.js genre table, the composer's), or,
 * for a genre the table does not know (a hand-authored 'wrapped' share), the
 * loaded project's own values, which for such a share are the payload's.
 */
export function setShareGroove(el, ov, project) {
    const genre = el._currentGen?.genre;
    const base = el._genreData?.[genre] || (project ? { swing: project.swing, humanize: project.humanize } : null);
    const g = grooveOverride(ov, base);
    if (!g && el._grooveOverride?.source !== 'share') return;
    el._grooveOverride = g ? { ...g, source: 'share', gen: el._currentGen } : null;
    applyGroove(el);
}

/** A session swing / humanize (a slider): engages groove for this session. */
export function setGroove(el, swing, humanize) {
    el._grooveOverride = { swing: Number(swing) || 0, humanize: Number(humanize) || 0, source: 'session' };
    applyGroove(el);
}

function applyGroove(el) {
    if (!el._wave || !engineHas(el, FEATURE.GROOVE)) return; // ensureWave makes it right
    const g = activeGroove(el);
    if (el._waveFlags & FLAG.GROOVE) {
        // Sticky in the engine across loads; 0/0 is its neutral (identity).
        wavePost(el, { type: 'groove', swing: g ? g.swing : 0, humanize: g ? g.humanize : 0 });
    } else if (g) {
        rebuildEngine(el); // the flag is a construction flag
    }
}

// --- Engine lifetime ---

async function createEngine(el, ctx, processorOptions) {
    try {
        const dj = await createDjrustEngine(ctx, (node) => node.connect(audioHost.output),
            { wasmUrl: djrustWasmUrl(), processorOptions });
        el._engineName = 'djrust';
        el._djrustInfo = dj.info;
        el._djrustSource = dj.wasmSource;
        return dj;
    } catch (err) {
        el._djrustError = String((err && err.message) || err);
        console.error('djrust engine unavailable:', err);
        showEngineError(el, el._djrustError);
        throw err;
    }
}

/**
 * processorOptions for a new engine: nothing (the 0.2.0 construction) unless
 * an explicit groove is in force on a module that runs it.
 */
export function engineCreateOptions(el) {
    const g = activeGroove(el);
    if (!g || !engineHas(el, FEATURE.GROOVE)) return undefined;
    return { flags: FLAG.GROOVE, swing: g.swing, humanize: g.humanize };
}

/** The page state a fresh engine needs before it plays. */
export function primeEngine(el, wave) {
    if (el._waveProject) wave.post({ type: 'load', project: el._waveProject });
    wave.post({ type: 'tempo', bpm: el._tempo || 120 });
    // The worker's mute state at this point is the loaded project's
    // (plus render-mode solo/mute and lock mutes); hand it over once.
    postMutes(wave, new Set([...(el._mutedNets || []), ...(el._manualMutedNets || [])]));
    if (engineHas(el, FEATURE.CONTROL_MACROS)) wave.post(controlMacrosMsg(el));
}

function controlMacrosMsg(el) {
    el._disabledMacros = el._disabledMacros || loadDisabledMacros(el);
    return { type: 'control-macros', on: true, disabled: [...el._disabledMacros] };
}

function ensureWave(el) {
    if (el._wave) return el._wave;
    const p = (async () => {
        await el._ensureToneStarted?.();
        const ctx = audioHost.getContext();
        await probeEngineFeatures(el);
        const processorOptions = engineCreateOptions(el);
        const wave = await createEngine(el, ctx, processorOptions);
        el._waveFlags = processorOptions?.flags || 0;
        // The running engine's own mask wins over the main-thread probe
        // (same module, so they agree unless the probe failed).
        if (Number.isInteger(wave.features) && wave.features !== (el._engineFeatures | 0)) setEngineFeatures(el, wave.features);
        wave.onmessage = (msg) => onWaveMessage(el, msg);
        primeEngine(el, wave);
        return wave;
    })();
    el._wave = p;
    // A failed start may be retried on the next Play.
    p.catch(() => { if (el._wave === p) el._wave = null; });
    return p;
}

/** Replace the engine (a construction flag changed); resumes where the page is. */
function rebuildEngine(el) {
    const old = el._wave;
    el._wave = null;
    old?.then(w => w.dispose()).catch(() => {});
    if (!el._playing) return;
    el._waveTickPrev = undefined;
    ensureWave(el).then(w => {
        if (engineHas(el, FEATURE.SEEK) && el._tick > 0) w.post({ type: 'seek', tick: el._tick });
        w.post({ type: 'transport', action: 'play' });
    }).catch(err => console.warn('djrust engine:', err));
}

/** Post to the running engine; false when there is none yet. */
export function wavePost(el, msg) {
    if (!el._wave) return false;
    el._wave.then(w => w.post(msg)).catch(() => {});
    return true;
}

/**
 * Fire catalog macro `id` in the engine for `duration` in its own unit (bars;
 * ticks for cut). False when the engine does not run it or is not up: the
 * caller must not fire it any other way then.
 */
export function engineFireMacro(el, id, duration) {
    if (!engineHas(el, FEATURE.NET_MACROS)) return false;
    const d = Number.isFinite(duration) ? Math.trunc(duration) : -1;
    return wavePost(el, { type: 'fire-macro', id, duration: d });
}

/**
 * Restore every engine-held macro effect now (no-op on a module without
 * macros). Every stop and Panic comes through here (lib/macros/effects.js
 * clearLocalMacroState).
 */
export function enginePanic(el) {
    if (!engineHas(el, FEATURE.NET_MACROS)) return false;
    const held = (el._engineMacroMask | 0) !== 0 || !!el._runningEngine || !!el._engineHeld?.size;
    el._engineMacroMask = 0;
    const sent = wavePost(el, { type: 'panic' });
    if (held && !el._playing) settleStoppedEngine(el);
    return sent;
}

/**
 * The engine has just restored the macros it held, and the transport is
 * stopped (a stop, or Panic while stopped). It posts no wave-tick while
 * stopped, so nothing would report the restored mutes and tempo, and the page
 * would keep showing (and sharing, and committing on the next tempo nudge)
 * the macro's. Put back what the page knows instead:
 *   mutes  the worker's set (the project's initial mutes plus page requests;
 *          it never plays, so it holds no macro mute) with the manual mutes,
 *          through the normal mute-state path (mixer, Stage, MIDI panel,
 *          initialMutes mirror). A stop also resets the engine's own mutes
 *          to the project's (djrust graph reset), and the next Play's ticks
 *          report from there.
 *   tempo  the page's committed tempo, el._project.tempo (followEngineTempo
 *          never writes it; _setTempo does). The engine's own engine-tempo
 *          event for the restore follows and agrees.
 */
function settleStoppedEngine(el) {
    if (el._workerMutedNets) {
        const mutes = new Set([...el._workerMutedNets, ...(el._manualMutedNets || [])]);
        el._handleWsMessage?.({ type: 'mute-state', mutedNets: Object.fromEntries([...mutes].map(id => [id, true])),
            mutedNotes: {}, source: 'engine' });
    }
    const bpm = Number(el._project?.tempo);
    if (Number.isFinite(bpm) && bpm > 0) showTempo(el, bpm);
}

/** Re-send the control-net macro switch and disabled list (it changed). */
export function syncControlMacros(el) {
    if (!engineHas(el, FEATURE.CONTROL_MACROS)) return false;
    return wavePost(el, controlMacrosMsg(el));
}

/** Do control nets' fire-macro run in the engine (so the page must not)? */
export function engineRunsControlMacros(el) {
    return !!el._wave && engineHas(el, FEATURE.CONTROL_MACROS);
}

/**
 * routeToWave(el, msg) — called by sendWs. Returns true when the message
 * was consumed (must not reach the worker), false to forward it as usual.
 */
function postMutes(wave, ids) {
    for (const netId of ids) wave.post({ type: 'mute', netId, muted: true });
}

export function routeToWave(el, msg) {
    switch (msg.type) {
    case 'mute-group': {
        // The worker expands a riff group itself; the engine only takes
        // per-net mutes, so expand it the same way (sequencer-worker.js).
        if (!el._wave || !el._project?.nets) return false;
        const ids = Object.entries(el._project.nets)
            .filter(([, nb]) => nb.riffGroup === msg.riffGroup).map(([id]) => id);
        el._wave.then(w => {
            if (msg.muted) { for (const netId of ids) w.post({ type: 'mute', netId, muted: true }); }
            else if (ids.length) w.post({ type: 'mute', netId: ids[0], muted: false });
        }).catch(() => {});
        return false;
    }
    case 'transport':
        // The next wave-tick after any transport change is a new baseline
        // for feedWaveTick, not a step from wherever the last run stopped.
        el._waveTickPrev = undefined;
        if (msg.action !== 'play') el._engineMacroMask = 0;
        ensureWave(el).then(w => {
            // The engine starts a Play at tick 0 (a stop rewinds it). A
            // playhead past 0 (a seek while stopped, a loop start) is where
            // the page says it plays from: go there first.
            if (msg.action === 'play' && engineHas(el, FEATURE.SEEK) && el._tick > 0) {
                w.post({ type: 'seek', tick: el._tick });
            }
            w.post(msg);
        }).catch(err => console.warn('djrust engine:', err));
        return true; // the worker never plays
    case 'seek':
        // While playing, the engine seeks (and answers with a state tick).
        // Stopped, the worker moves the canvas as before and the next Play
        // seeks the engine to the playhead (see 'transport').
        if (!el._playing || !el._wave || !engineHas(el, FEATURE.SEEK)) return false;
        el._waveTickPrev = undefined;
        wavePost(el, { type: 'seek', tick: msg.tick });
        return true;
    case 'tempo':
    case 'mute':
        if (el._wave) el._wave.then(w => w.post(msg)).catch(() => {});
        return false;
    }
    return false;
}

/** Called on every project-sync from the worker. */
export function waveLoadProject(el, project) {
    el._waveProject = project;
    // Until the engine reports mutes for this project, the worker's
    // mute-state (sent right after this project-sync) is the authority.
    el._engineMutesFresh = false;
    // A share being loaded: its overrides are still pending here (this runs
    // just before _applyProjectSync applies the rest of them, lib/share/
    // apply.js), so its swing / humanize are routed now, from the same
    // object. lib/share/ stays untouched (scripts/cid-freeze.sh).
    if (el._pendingShareOverrides) setShareGroove(el, el._pendingShareOverrides, project);
    // A share's groove does not follow it onto another track.
    const stale = el._grooveOverride && !activeGroove(el);
    if (stale) el._grooveOverride = null;
    if (!el._wave) return;
    el._wave.then(w => {
        w.post({ type: 'load', project });
        // Lock mutes persist across regenerates (mixer "lock" checkbox).
        postMutes(w, el._manualMutedNets || []);
        if (stale && (el._waveFlags & FLAG.GROOVE)) w.post({ type: 'groove', swing: 0, humanize: 0 });
    }).catch(() => {});
}

/**
 * feedWaveTick(el, tick) — run the page's per-tick clock consumers on one
 * wave-tick: el._fireRepeatingOneShots(prev, tick) and el._autoDjTick(prev,
 * tick), each exactly once per tick the engine reports.
 *
 * The first tick after a transport change or a seek only sets the baseline
 * (nothing has been crossed yet; a resume or a jump must not look like a
 * step). A tick lower than the previous one is a wrap (loop end, or a project
 * load the engine applied at the bar, which restarts its tick at 0): it is
 * passed through as (prev, tick) so autoDjTick's own wrap branch runs, the
 * same shape the worker's state-sync gave it. el._waveTickWraps counts them.
 */
export function feedWaveTick(el, tick) {
    if (typeof tick !== 'number') return;
    const prev = el._waveTickPrev;
    el._waveTickPrev = tick;
    if (prev === undefined || prev === tick) return;
    if (tick < prev) el._waveTickWraps = (el._waveTickWraps || 0) + 1;
    el._fireRepeatingOneShots?.(prev, tick);
    el._autoDjTick?.(prev, tick);
}

/** The engine moved the tempo (a tempo macro): show it, never post it back. */
function followEngineTempo(el, bpm) {
    if (!Number.isFinite(bpm) || bpm <= 0) return;
    showTempo(el, bpm);
}

function showTempo(el, bpm) {
    if (bpm === el._tempo) return;
    el._tempo = bpm;
    const input = el.querySelector?.('.pn-tempo input');
    if (input) input.value = Math.round(bpm);
}

const MACRO_EVENTS = new Set(['macro-fired', 'macro-skipped', 'macro-restored', 'macro-released', 'macro-overflow']);

export function onWaveMessage(el, msg) {
    if (msg.type === 'error') {
        console.warn('djrust engine:', msg.message, msg.op ? `(${msg.op})` : '');
        return;
    }
    if (msg.type === 'playback-complete') {
        el._handleWsMessage?.({ type: 'playback-complete' });
        return;
    }
    if (MACRO_EVENTS.has(msg.type)) { onEngineMacroEvent(el, msg); return; }
    // The engine moved its tempo (a tempo macro, or its restore, which a
    // stopped engine reports only this way: no wave-tick follows a stop).
    if (msg.type === 'engine-tempo') { followEngineTempo(el, msg.bpm); return; }
    if (msg.type === 'seeked') {
        if (!(msg.tick >= 0)) console.warn('djrust engine: seek refused', msg);
        return;
    }
    if (msg.type !== 'wave-tick') return;
    if (typeof msg.t === 'number') {
        const ctx = audioHost.getContext();
        if (ctx) perfWaveLag(el, (ctx.currentTime - msg.t) * 1000);
    }
    if (msg.seek) el._waveTickPrev = undefined; // a jump, not a step
    if (typeof msg.tempo === 'number') followEngineTempo(el, msg.tempo);
    for (const [netId, transitionId, control] of msg.controls) {
        el._handleWsMessage?.({ type: 'control-fired', netId, transitionId, control });
    }
    // macroHeld: the engine holds a macro on this tick, so some of these mutes
    // are the macro's, not the track's (backend/index.js keeps them out of
    // el._project.initialMutes, which a share carries).
    if (msg.mutedNets) el._handleWsMessage?.({ type: 'mute-state', mutedNets: msg.mutedNets, mutedNotes: {}, source: 'engine',
        macroHeld: (msg.macroMask | 0) !== 0 });
    for (const [netId, transitionId, midi] of msg.fired) {
        el._handleWsMessage?.({ type: 'transition-fired', netId, transitionId, midi, tick: msg.tick, audioT: msg.t });
    }
    if (typeof msg.macroMask === 'number') engineMacroTick(el, msg.tick, msg.macroMask);
    feedWaveTick(el, msg.tick);
    // fromWave: feedWaveTick already ran the per-tick consumers for this tick.
    if (msg.state) el._handleWsMessage?.({ type: 'state-sync', state: msg.state, tick: msg.tick, fromWave: true });
}
