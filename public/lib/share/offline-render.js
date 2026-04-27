// Offline render — faster-than-realtime audio rendering via Tone.Offline.
//
// Companion to client-render.js. Same input (a loaded petri-note element)
// and same output shape (a Blob in window.__renderBlob via render-mode.js),
// but the audio is synthesized into an OfflineAudioContext at maximum CPU
// speed instead of being recorded from a realtime AudioContext at 1×.
//
// On a fast machine this typically yields 5–15× realtime; on a slow one
// it's still bounded by single-core synthesis cost but with no realtime
// constraint, so you never get the "MediaRecorder dropped samples" failure
// mode that haunts the chromedp realtime path.
//
// MVP STATUS — proof-of-concept fidelity only:
//
// This module currently builds a SIMPLIFIED synth graph inside Tone.Offline:
// one Tone.PolySynth per channel (no per-instrument tone shaping, no master
// FX chain, no per-channel filters / decay / pan). It walks the project's
// nets via lib/pflow.js to collect note events, then schedules them via
// triggerAttackRelease at audio time. Result: the rhythmic + melodic
// content matches live, but the timbre and mix do NOT match the live
// chromedp render.
//
// Production-quality fidelity needs the full synth graph rebuilt against
// the offline context. Concretely, that means calling toneEngine's
// instrument-loading code inside the Tone.Offline callback so each
// channel's Sampler / FMSynth / MetalSynth / etc. lands on the offline
// context, then connecting the master FX chain (Reverb, Delay, Phaser,
// Compressor, master volume) the same way it's wired in real-time. This
// requires a refactor of tone-engine.js to make graph construction
// idempotent against an externally-supplied context. Tracked separately;
// the macro / sweep refactor (see lib/macros/sched.js) is the prerequisite
// that's already landed.
//
// Caveats / gaps to close before this replaces the realtime path:
//   - Per-instrument timbre (use loadInstrument inside the offline cb)
//   - Master FX chain (reverb / delay / phaser / compressor / master vol)
//   - Per-channel FX (filters, decay, pan)
//   - Macros + Auto-DJ (the audio scheduler is offline-safe now, but the
//     macro fire dispatcher still goes through el._fireMacro on the
//     element, which doesn't currently know to write into the offline
//     graph)
//   - Drift / swing / humanize — driven by the worker; PoC's tick
//     simulator skips these.
//   - Per-genre instrument override / shuffle state.
//
// Encoding: outputs uncompressed 16-bit stereo WAV (~10 MB per minute at
// 48 kHz). Production should transcode to Opus on the server, or wire an
// Opus encoder library client-side. WAV keeps the MVP dependency-free.

import { parseProject } from '../pflow.js';
import { ToneEngine } from '../../audio/tone-engine.js';
import { hpFreq, lpFreq } from '../ui/mixer-sliders.js';
import { MACROS, MACRO_TARGETS } from '../macros/catalog.js';

const PPQ = 4;
const SAMPLE_RATE = 48000;
const TAIL_SECONDS = 1.5;     // capture release tails past the last note
const LOOP_FALLBACK_TICKS = 1024;

export function isOfflineRenderMode() {
    try {
        return new URLSearchParams(location.search).get('render') === 'offline';
    } catch {
        return false;
    }
}

// Render the currently-loaded project to an uncompressed WAV Blob via
// Tone.Offline. Returns the same shape as client-render.js::renderToBlob:
//   { blob, mimeType, durationMs, totalSteps }
//
// Throws on missing project, missing Tone, or missing OfflineAudioContext
// support (very old browsers).
export async function renderToBlobOffline(el, opts = {}) {
    const Tone = window.Tone;
    if (!Tone) throw new Error('Tone.js not loaded');
    if (!el._project) throw new Error('no project loaded');
    if (typeof OfflineAudioContext === 'undefined') {
        throw new Error('OfflineAudioContext unsupported');
    }

    const totalSteps = el._totalSteps > 0 ? el._totalSteps : LOOP_FALLBACK_TICKS;
    const tempo = el._tempo || 120;
    const tickIntervalMs = 60_000 / (tempo * PPQ);
    let durationMs = totalSteps * tickIntervalMs;
    if (opts.maxMs > 0 && durationMs > opts.maxMs) durationMs = opts.maxMs;
    const durationSec = durationMs / 1000 + TAIL_SECONDS;

    // Pre-compute every note event the project will fire over `totalSteps`
    // ticks. Walks pflow.NetBundle forward deterministically — same engine
    // the worker uses, just driven by a for-loop instead of setInterval.
    // Also collects fire-macro events from control nets and Auto-DJ ticks
    // so the offline render gets the same performance flavor as live.
    const { events, macroFires } = simulateProjectNotes(
        el._project, totalSteps, tickIntervalMs,
        { loopStart: el._loopStart || 0, loopEnd: el._loopEnd || 0 });

    // Build the per-channel instrument map from the project's nets so
    // we know which Sampler / FMSynth / MetalSynth / etc. to load for
    // each channel inside the Tone.Offline callback. Net.track.channel
    // → instrument name. Drum channels (10, 20, 21, 22, 23) get the
    // 'drums' kit. Channels with no track are skipped.
    const channelInstruments = collectChannelInstruments(el._project);
    // Per-track FX settings from the envelope feed straight into the
    // engine via the same setters the live UI uses.
    const fx = el._project?.fx || {};

    const wallStart = performance.now();
    const buffer = await Tone.Offline(async ({ transport }) => {
        // Spin up a fresh ToneEngine inside the Tone.Offline callback.
        // Tone.context is the OfflineAudioContext for the duration of
        // this callback, so any new Tone.X() (including the synths
        // ToneEngine creates internally) lands on the offline graph.
        // _offline=true skips the mobile audio-element path and
        // Tone.start() — both meaningless in an offline context.
        const engine = new ToneEngine();
        engine._offline = true;
        await engine.init();

        // Apply project-level FX values BEFORE any notes fire so the
        // recorded tail reflects them. Mirrors how the live UI applies
        // overrides on project-load.
        applyFxToEngine(engine, fx);

        // Load each channel's instrument. loadInstrument is async
        // (samplers fetch SoundFont files); await the whole batch
        // before scheduling notes so sample buffers are warm.
        await Promise.all(
            [...channelInstruments].map(([ch, inst]) => engine.loadInstrument(ch, inst))
        );

        // Schedule every note via engine.playNote(midi, playAt). The
        // second argument is an absolute audio-clock time; inside
        // Tone.Offline this corresponds to offline-context time, so
        // each note lands at the right beat in the rendered buffer.
        for (const ev of events) {
            const t = ev.tick * (tickIntervalMs / 1000);
            engine.playNote({
                channel: ev.channel,
                note: ev.midi,
                velocity: ev.velocity,
                duration: ev.durationMs,
            }, t);
        }
        // Schedule Auto-DJ + fire-macro effects via Tone.Transport. Each
        // macro fires its FX op(s), holds for durationMs, then restores
        // — same shape as the live fxSweep / fxHold runtime, but
        // scheduled against the offline transport instead of rAF +
        // setTimeout. Mute / tempo / pitch / pan / shape / feel macros
        // are noops here for now (live macrosDisabled covers the
        // audibly disruptive mute + tempo group; the rest are smaller
        // performance touches that can be ported in a follow-up).
        const fxState = collectInitialFxState(fx);
        // Channel list for per-channel macros (pan / shape) — built
        // from the music nets we loaded so the macro selectors don't
        // need a live `host` object.
        const channelTargets = collectChannelTargets(el._project);
        for (const fire of macroFires) {
            if (fire.macroId === '__set-feel__' && Array.isArray(fire.puck)) {
                // set-feel control action: lp-freq snap from puck X axis.
                const startLp = fxState['lp-freq'] ?? 100;
                const targetLp = feelPuckToLpFreq(fire.puck);
                Tone.Transport.scheduleOnce(() => setFxByKey(engine, 'lp-freq', targetLp), fire.audioTime);
                if (!fire.oneShot) {
                    Tone.Transport.scheduleOnce(
                        () => setFxByKey(engine, 'lp-freq', startLp),
                        fire.audioTime + fire.durationMs / 1000);
                }
                continue;
            }
            scheduleMacroEffect(
                engine, fire.macroId, fire.audioTime, fire.durationMs,
                fxState, channelTargets);
        }
        transport.start();
    }, durationSec, 2, SAMPLE_RATE);
    const wallElapsedMs = performance.now() - wallStart;
    const speedup = (durationSec * 1000) / Math.max(1, wallElapsedMs);

    const blob = audioBufferToWavBlob(buffer);
    return {
        blob,
        mimeType: 'audio/wav',
        durationMs,
        totalSteps,
        offlineWallMs: Math.round(wallElapsedMs),
        speedupX: Math.round(speedup * 10) / 10,
        eventCount: events.length,
    };
}

// --- Project simulation ---------------------------------------------------
//
// Walk every net forward `totalSteps` ticks, firing enabled transitions
// and recording any MIDI events plus the running mute / slot state.
// Control nets (`role: 'control'`) drive section structure, fade-ins,
// drum breaks, and riff-variant switches via control bindings on their
// transitions: mute-track / unmute-track / toggle-track / activate-slot.
// We process those as state changes during simulation so the resulting
// note list reflects the actual *arranged* track, not just every net
// firing in isolation.
//
// Still missing vs. the worker:
//   - drift / swing / humanize timing
//   - probabilistic conflict resolution beyond first-enabled
//   - fire-macro events (Auto-DJ + Beats panel — both run against the
//     live element, not the project envelope)
//   - mute-note / unmute-note (subset of mute-track scoped to one
//     transition; rare in composer output)
// The first two affect timing flavor; the rest affect macro-driven
// performance variation. Sufficient for fully-arranged offline renders
// that match the live track's *structure* without its live performance.

// Drift / humanize constants — mirrors sequencer-worker.js. Kept in
// sync by hand; the worker file documents the rationale for each value.
const GHOST_VEL_THRESHOLD = 55;
const DRIFT_GHOST_SUPPRESS = 0.15;
const DRIFT_VEL_RANGE = 12;

// Mulberry32 PRNG, byte-identical to sequencer-worker.js::deterministicRand
// so the offline render produces the same drift the live worker would
// for a given (loopIteration, tick, salt) tuple.
function detRand(tick, salt) {
    let s = (tick + salt) | 0;
    s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
}
function strHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = Math.imul(31, h) + str.charCodeAt(i) | 0;
    return h;
}

function simulateProjectNotes(projectMap, totalSteps, tickIntervalMs, opts = {}) {
    const loopStart = Math.max(0, opts.loopStart || 0);
    // loopEnd > loopStart enables wrap behavior. When unset (<=0), the
    // simulator walks totalSteps once and never wraps — same as live
    // playback with no loop region set.
    const loopEnd = (opts.loopEnd > loopStart) ? opts.loopEnd : 0;
    const proj = parseProject(projectMap);
    const events = [];
    const macroFires = [];
    const allNets = [];
    const musicNets = [];
    const controlNets = [];
    // Project-level swing / humanize amounts. Same scaling as the live
    // path: swing 0-100 → odd-8th delay = (swing/100) * tickMs * 0.5;
    // humanize 0-100 → velocity jitter ±(humanize/100 * 15).
    const swing = projectMap?.swing || 0;
    const humanize = projectMap?.humanize || 0;
    // Auto-DJ settings from the envelope. autoDj.run gates the whole
    // scheduler; rate is in bars (default 2); pools narrows the macro
    // pool. macrosDisabled blocks individual macros even when their
    // pool is enabled — this is how the seed batch keeps mute/tempo
    // macros baked off without disabling Auto-DJ entirely.
    const autoDj = projectMap?.autoDj || {};
    const autoDjRun = autoDj.run !== false; // default on; explicit false disables
    const autoDjRateBars = autoDj.rate || 2;
    const autoDjStack = autoDj.stack || 1;
    const autoDjPools = new Set(
        Array.isArray(autoDj.pools)
            ? autoDj.pools
            // Default pools when envelope doesn't specify: same as the live
            // panel's defaults (FX, Pitch, Pan, Shape are checked).
            : ['FX', 'Pitch', 'Pan', 'Shape']
    );
    const macrosDisabled = new Set(projectMap?.macrosDisabled || []);
    // Eligible macros for Auto-DJ to pick from this run.
    const autoDjPickable = MACROS.filter(m =>
        autoDjPools.has(m.group) && !macrosDisabled.has(m.id) && m.kind !== 'one-shot');
    // Mute state tracking. Initial mutes (project.initialMutes) win on
    // tick 0; control transitions firing mute-track / unmute-track /
    // toggle-track flip the bits during the walk.
    const muted = new Set();
    for (const id of (projectMap?.initialMutes || [])) muted.add(id);
    // Note-level mutes: `${netId}:${transitionLabel}` keys. When set,
    // that transition's MIDI binding is suppressed even if the
    // transition fires. Driven by mute-note / unmute-note / toggle-note
    // control actions.
    const mutedNotes = new Set();
    // riffGroup → currently-active variant id. activate-slot updates
    // this; emit notes only from the currently-active variant per group.
    const activeVariant = new Map();
    for (const [id, nb] of Object.entries(proj.nets)) {
        nb.resetState();
        allNets.push([id, nb]);
        if (nb.role === 'control') {
            controlNets.push([id, nb]);
        } else {
            musicNets.push([id, nb]);
            // First-seen net per riff group is the default active slot.
            // activate-slot can switch later.
            if (nb.riffGroup && !activeVariant.has(nb.riffGroup)) {
                activeVariant.set(nb.riffGroup, id);
            }
        }
    }
    // A net is muted if it's in the mute set OR (it has a riffGroup and
    // it's not the currently active variant for that group).
    const isAudible = (id, nb) => {
        if (muted.has(id)) return false;
        if (nb.riffGroup) {
            const active = activeVariant.get(nb.riffGroup);
            if (active && active !== id) return false;
        }
        return true;
    };
    // Tick walker. With loopEnd set, virtTick wraps from loopEnd back
    // to loopStart and we increment loopIteration + apply phase drift
    // before continuing — mirrors sequencer-worker.js _advanceOneTick.
    // Audio events still get scheduled at absolute audio time
    // (`physTick * tickIntervalMs`), so the wrap doesn't compress
    // playback timing — it just gives the engine a fresh slate to
    // re-fire the loop from.
    let loopIteration = 0;
    for (let physTick = 0; physTick < totalSteps; physTick++) {
        // Wrap detection BEFORE the music-net firing for this tick:
        // the live worker wraps when tickCount reaches loopEnd. We
        // align to the same cadence by applying the wrap right when
        // the virtual tick would have crossed loopEnd.
        const tick = physTick; // physical position within the recording
        if (loopEnd > 0 && physTick > 0 && (physTick - loopStart) > 0
            && ((physTick - loopStart) % (loopEnd - loopStart)) === 0) {
            loopIteration++;
            applyPhaseDriftSim(proj, musicNets, loopIteration);
        }
        // 1. Fire control nets first so any mute / activate-slot effects
        //    apply before this tick's music notes get emitted.
        for (const [, nb] of controlNets) {
            const enabled = [];
            for (const tLabel of Object.keys(nb.transitions || {})) {
                if (nb.isEnabled(tLabel)) enabled.push(tLabel);
            }
            if (enabled.length === 0) continue;
            const tLabel = enabled[0];
            const result = nb.fire(tLabel);
            const ctrl = result?.control;
            if (!ctrl || !ctrl.action) continue;
            const target = ctrl.targetNet;
            switch (ctrl.action) {
                case 'mute-track':
                    if (target) muted.add(target);
                    break;
                case 'unmute-track':
                    if (target) muted.delete(target);
                    break;
                case 'toggle-track':
                    if (target) {
                        if (muted.has(target)) muted.delete(target);
                        else muted.add(target);
                    }
                    break;
                case 'activate-slot': {
                    // Find the targeted net's riff group, then mark it
                    // active for that group.
                    if (!target) break;
                    const targetNb = proj.nets[target];
                    if (targetNb?.riffGroup) {
                        activeVariant.set(targetNb.riffGroup, target);
                    }
                    break;
                }
                case 'stop-transport':
                    // Truncate the simulation here. No more notes after
                    // a stop-transport — same as the live worker.
                    return { events, macroFires };
                case 'fire-macro': {
                    const macroId = ctrl.macro || target;
                    if (!macroId || macrosDisabled.has(macroId)) break;
                    const macro = MACROS.find(m => m.id === macroId);
                    if (!macro) break;
                    const bars = ctrl.macroBars || macro.defaultDuration;
                    const durationMs = macroDurationMs(macro, bars, tickIntervalMs);
                    macroFires.push({
                        audioTime: tick * (tickIntervalMs / 1000),
                        macroId,
                        durationMs,
                    });
                    break;
                }
                case 'mute-note':
                case 'unmute-note':
                case 'toggle-note': {
                    // Per-transition mute scoped to one note. Track
                    // (netId, transitionLabel) pairs in mutedNotes; the
                    // music-net loop checks this set before emitting
                    // the binding's MIDI.
                    if (!target || !ctrl.targetNote) break;
                    const key = `${target}:${ctrl.targetNote}`;
                    if (ctrl.action === 'mute-note') mutedNotes.add(key);
                    else if (ctrl.action === 'unmute-note') mutedNotes.delete(key);
                    else { // toggle-note
                        if (mutedNotes.has(key)) mutedNotes.delete(key);
                        else mutedNotes.add(key);
                    }
                    break;
                }
                case 'set-feel': {
                    // Schedule a feel snap as a pseudo-macro: applies
                    // the puck's lpFreq mapping at audio time. Tempo
                    // axis is no-op in offline (notes are pre-baked at
                    // fixed audio times).
                    if (!Array.isArray(ctrl.puck) || ctrl.puck.length !== 2) break;
                    macroFires.push({
                        audioTime: tick * (tickIntervalMs / 1000),
                        macroId: '__set-feel__',
                        durationMs: ctrl.holdMs || tickIntervalMs * 16, // 1 bar default; sticks
                        puck: ctrl.puck,
                        oneShot: true, // no restore
                    });
                    break;
                }
                // set-visualizer: pure UI, no audio effect — skip.
            }
        }
        // Auto-DJ tick: every autoDjRateBars * 16 ticks, pick a random
        // macro from the eligible pool and schedule its effect. Stack
        // controls how many concurrent macros fire per tick boundary.
        if (autoDjRun && autoDjPickable.length > 0) {
            const ticksPerBar = 16;
            const boundary = autoDjRateBars * ticksPerBar;
            if (tick > 0 && tick % boundary === 0) {
                for (let s = 0; s < autoDjStack; s++) {
                    const macro = autoDjPickable[Math.floor(Math.random() * autoDjPickable.length)];
                    const bars = macro.defaultDuration;
                    const durationMs = macroDurationMs(macro, bars, tickIntervalMs);
                    macroFires.push({
                        audioTime: tick * (tickIntervalMs / 1000),
                        macroId: macro.id,
                        durationMs,
                    });
                }
            }
        }
        // 2. Fire music nets, emit MIDI for audible (unmuted, active
        //    variant) ones only.
        for (const [id, nb] of musicNets) {
            const enabled = [];
            for (const tLabel of Object.keys(nb.transitions || {})) {
                if (nb.isEnabled(tLabel)) enabled.push(tLabel);
            }
            if (enabled.length === 0) continue;
            const tLabel = enabled[0];
            const result = nb.fire(tLabel);
            if (!isAudible(id, nb)) continue;
            if (mutedNotes.has(`${id}:${tLabel}`)) continue;
            const binding = result?.midi;
            if (!binding || typeof binding.note !== 'number') continue;
            let velocity = binding.velocity ?? nb.track?.defaultVelocity ?? 90;
            // --- Velocity drift (mirrors sequencer-worker.js::driftMidi)
            //     loopIteration is 0 for the first/only walk through the
            //     simulator. Suppression of ghost notes happens here too.
            const salt = strHash(id + ':' + tLabel);
            const r = detRand(0, salt);
            if (velocity <= GHOST_VEL_THRESHOLD && r < DRIFT_GHOST_SUPPRESS) {
                continue; // ghost suppressed for this loop iteration
            }
            const r2 = detRand(tick, salt);
            const velJitter = Math.round((r2 * 2 - 1) * DRIFT_VEL_RANGE);
            velocity = Math.max(1, Math.min(127, velocity + velJitter));
            // --- Humanize: extra velocity jitter ±humanize/100 * 15
            if (humanize > 0) {
                const hJitter = (Math.random() * 2 - 1) * (humanize / 100) * 15;
                velocity = Math.max(1, Math.min(127, Math.round(velocity + hJitter)));
            }
            // --- Swing: delay odd 8th-note ticks by swing/100 * tickMs * 0.5
            //     PPQ=4, so ticks 1 and 3 within a beat are odd 8ths.
            //     swingShiftTicks here is fractional — we add a fractional
            //     time offset rather than mutating the integer tick index.
            let tickFloat = tick;
            if (swing > 0) {
                const tickInBeat = tick % 4;
                if (tickInBeat === 1 || tickInBeat === 3) {
                    tickFloat = tick + (swing / 100) * 0.5;
                }
            }
            events.push({
                tick: tickFloat,
                channel: binding.channel ?? nb.track?.channel ?? 0,
                midi: binding.note,
                velocity,
                durationMs: binding.duration ?? 100,
            });
        }
    }
    return { events, macroFires };
}

// Phase drift on loop wrap — port of sequencer-worker.js applyPhaseDrift.
// Picks one music net (deterministically by loopIteration), with 12%
// probability advances one of its tokens by one step in the place ring.
// Same Mulberry32 seeding as the worker, so behavior is byte-identical
// for a given loopIteration.
function applyPhaseDriftSim(proj, musicNets, loopIteration) {
    if (musicNets.length === 0) return;
    const r = detRand(loopIteration * 31, 0xDEAD);
    if (r >= 0.12) return;
    const r2 = detRand(loopIteration * 37, 0xBEEF);
    const [, nb] = musicNets[Math.floor(r2 * musicNets.length)];
    const places = Object.keys(nb.places || {});
    if (places.length < 3) return;
    for (const p of places) {
        if ((nb.state[p] || 0) >= 1) {
            const idx = places.indexOf(p);
            const nextIdx = (idx + 1) % places.length;
            nb.state[p] -= 1;
            nb.state[places[nextIdx]] = (nb.state[places[nextIdx]] || 0) + 1;
            break;
        }
    }
}

// Convert a macro's bar/tick duration to ms at the project tempo.
function macroDurationMs(macro, durationOverride, tickIntervalMs) {
    const dur = durationOverride || macro.defaultDuration || 1;
    const ticksPerBar = 16;
    const ticks = (macro.durationUnit === 'tick' ? dur : dur * ticksPerBar);
    return ticks * tickIntervalMs;
}

// Snapshot the project's initial FX values (envelope-applied) so macro
// effects know what to ramp BACK to on restore. Each fxKey defaults
// match tone-engine.js init() defaults; envelope keys override.
function collectInitialFxState(fx) {
    const defaults = {
        'reverb-size': 50, 'reverb-damp': 30, 'reverb-wet': 20,
        'delay-time': 25, 'delay-feedback': 25, 'delay-wet': 15,
        'master-vol': 80, 'distortion': 0, 'hp-freq': 0, 'lp-freq': 100,
        'phaser-freq': 0, 'phaser-depth': 50, 'phaser-wet': 0,
        'crush-bits': 0, 'master-pitch': 0,
    };
    const state = { ...defaults };
    for (const k of Object.keys(state)) {
        const v = Number(fx?.[k]);
        if (Number.isFinite(v)) state[k] = v;
    }
    return state;
}

// Apply a single fxKey value through the engine. Mirrors the switch in
// lib/ui/build.js applyFx() so live and offline behavior match.
function setFxByKey(engine, key, val) {
    switch (key) {
        case 'reverb-size':    engine.setReverbSize(val / 100); break;
        case 'reverb-damp':    engine.setReverbDampening(10000 - (val / 100) * 9800); break;
        case 'reverb-wet':     engine.setReverbWet(val / 100); break;
        case 'delay-time':     engine.setDelayTime(val / 100); break;
        case 'delay-feedback': engine.setDelayFeedback(val / 100); break;
        case 'delay-wet':      engine.setDelayWet(val / 100); break;
        case 'master-vol':     engine.setMasterVolume(val === 0 ? -60 : -60 + (val / 100) * 60); break;
        case 'distortion':     engine.setDistortion(val / 100); break;
        case 'master-pitch':   engine.setMasterPitch(val); break;
        case 'hp-freq':        engine.setHighpassFreq(hpFreq(val)); break;
        case 'lp-freq':        engine.setLowpassFreq(lpFreq(val)); break;
        case 'phaser-freq':    engine.setPhaserFreq(val === 0 ? 0 : 0.1 + (val / 100) * 9.9); break;
        case 'phaser-depth':   engine.setPhaserDepth(val / 100); break;
        case 'phaser-wet':     engine.setPhaserWet(val / 100); break;
        case 'crush-bits':     engine.setCrush(val / 100); break;
    }
}

// Build channel-target buckets so pan-move / decay-move can pick the
// same channel sets MACRO_TARGETS picks live. Returns
// { nonDrums: [ch, …], everything: [ch, …] } from the project's nets.
function collectChannelTargets(projectMap) {
    const nonDrums = new Set();
    const everything = new Set();
    for (const net of Object.values(projectMap?.nets || {})) {
        if (net.role === 'control') continue;
        const ch = net.track?.channel;
        if (ch == null) continue;
        everything.add(ch);
        if (!isDrumCh(ch)) nonDrums.add(ch);
    }
    return { nonDrums: [...nonDrums], everything: [...everything] };
}

// Bilinear lpFreq from a puck position. Same blend as
// lib/feel/axes.js::blendCorners. CORNERS' lpFreq values are 50 / 100
// for left / right columns (Y axis is BPM-only), so the blend reduces
// to lpFreq = 50 + 50 * x. Returned in 0–100 range matching the
// fxSlider's lp-freq scale.
function feelPuckToLpFreq(puck) {
    const x = Math.max(0, Math.min(1, puck[0] || 0));
    return 50 + 50 * x;
}

// Schedule a macro's audio effect at audioTime via Tone.Transport. For
// fx-sweep / fx-hold (with op list), schedules a peak-then-restore
// curve. For pan-move / decay-move, schedules per-channel CC10 (pan)
// or setChannelDecay calls following the macro's pattern. For
// feel-snap / feel-sweep, applies the puck's lpFreq blend. Other
// macro kinds (mute / tempo / one-shot) are noops here — covered
// elsewhere or intentionally suppressed via macrosDisabled.
function scheduleMacroEffect(engine, macroId, audioTime, durationMs, fxState, channelTargets) {
    const Tone = window.Tone;
    if (!Tone?.Transport) return;
    // Special pseudo-macro emitted by set-feel control action.
    if (macroId === '__set-feel__') {
        // The caller pushed a `puck` field on the fire entry; we don't
        // see it in this signature, so this branch is intentionally a
        // no-op here. set-feel events are dispatched in the caller
        // loop right before scheduleMacroEffect via a side path.
        return;
    }
    const macro = MACROS.find(m => m.id === macroId);
    if (!macro) return;
    const durSec = durationMs / 1000;

    if (macro.kind === 'pan-move' || macro.kind === 'decay-move') {
        return scheduleChannelMacro(macro, audioTime, durationMs, engine, channelTargets);
    }
    if (macro.kind === 'feel-snap' || macro.kind === 'feel-sweep') {
        return scheduleFeelMacro(macro, audioTime, durationMs, engine, fxState);
    }

    const ops = macro.ops || (macro.fxKey ? [{ fxKey: macro.fxKey, toValue: macro.toValue }] : null);
    if (!ops || (macro.kind !== 'fx-sweep' && macro.kind !== 'fx-hold')) return;
    const tailFrac = macro.tailFrac ?? 0.6;
    for (const op of ops) {
        const startVal = fxState[op.fxKey];
        if (!Number.isFinite(startVal)) continue;
        const peakVal = op.toValue;
        // Jump to peak at audioTime. For fx-sweep, this is the apex of
        // a there-and-back curve (rampDown 80% then back to start). For
        // fx-hold, this is sustain-then-release with tailFrac.
        Tone.Transport.scheduleOnce(() => setFxByKey(engine, op.fxKey, peakVal), audioTime);
        if (macro.kind === 'fx-hold') {
            const releaseStart = audioTime + (1 - tailFrac) * durSec;
            Tone.Transport.scheduleOnce(() => setFxByKey(engine, op.fxKey, startVal), audioTime + durSec);
            // Mid-point so the listener hears the curve, not just two steps.
            Tone.Transport.scheduleOnce(
                () => setFxByKey(engine, op.fxKey, peakVal + (startVal - peakVal) * 0.5),
                releaseStart + (durSec * tailFrac) / 2);
        } else { // fx-sweep
            const rampDownEnd = audioTime + 0.8 * durSec;
            // Sweep up to peak halfway, then back to start. Three points
            // approximate the live linear-then-linear curve adequately.
            Tone.Transport.scheduleOnce(
                () => setFxByKey(engine, op.fxKey, peakVal),
                audioTime + 0.4 * durSec);
            Tone.Transport.scheduleOnce(() => setFxByKey(engine, op.fxKey, startVal), audioTime + durSec);
            // Half-way restore so the second leg actually moves.
            Tone.Transport.scheduleOnce(
                () => setFxByKey(engine, op.fxKey, peakVal + (startVal - peakVal) * 0.5),
                rampDownEnd);
        }
    }
}

// --- WAV encoding ---------------------------------------------------------
//
// 16-bit linear PCM WAV. Trivially decodeable by any audio tool, no
// dependencies. Stereo interleaved. Supports any sample rate the
// AudioBuffer carries.

function audioBufferToWavBlob(audioBuffer) {
    const numChannels = Math.min(2, audioBuffer.numberOfChannels);
    const sampleRate = audioBuffer.sampleRate;
    const numFrames = audioBuffer.length;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = numFrames * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    // RIFF header
    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeAscii(view, 8, 'WAVE');
    // fmt chunk
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);              // chunk size
    view.setUint16(20, 1, true);               // PCM format
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bytesPerSample * 8, true);
    // data chunk
    writeAscii(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    // Interleave channel data, clamp + convert float → int16
    const channels = [];
    for (let c = 0; c < numChannels; c++) channels.push(audioBuffer.getChannelData(c));
    let off = 44;
    for (let i = 0; i < numFrames; i++) {
        for (let c = 0; c < numChannels; c++) {
            const s = Math.max(-1, Math.min(1, channels[c][i] || 0));
            view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
            off += 2;
        }
    }
    return new Blob([buffer], { type: 'audio/wav' });
}

function writeAscii(view, offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

// MIDI note number → scientific pitch notation. Tone.PolySynth accepts
// note names like "C4", "F#5". Falls back to "A4" (440Hz) on weird input.
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function midiToNoteName(midi) {
    if (!Number.isFinite(midi) || midi < 0 || midi > 127) return 'A4';
    const octave = Math.floor(midi / 12) - 1;
    const name = NOTE_NAMES[midi % 12];
    return `${name}${octave}`;
}

// Walk every music net and build channel → instrument-name map.
// Falls back to 'piano' / 'drums' for missing instruments so a half-
// authored project still renders something audible.
function collectChannelInstruments(projectMap) {
    const out = new Map();
    const nets = projectMap?.nets || {};
    for (const net of Object.values(nets)) {
        if (net.role === 'control') continue;
        const ch = net.track?.channel;
        if (ch == null) continue;
        if (out.has(ch)) continue; // first net wins per channel
        const inst = net.track?.instrument;
        if (inst) {
            out.set(ch, inst);
        } else {
            // Drum channels (10, 20-23 in this codebase) get 'drums'.
            out.set(ch, isDrumCh(ch) ? 'drums' : 'piano');
        }
    }
    return out;
}

function isDrumCh(ch) { return ch === 10 || (ch >= 20 && ch <= 23); }

// Apply project envelope's `fx` overrides to the engine. Mirrors the
// switch in lib/ui/build.js applyFx() — same scaling, same setters,
// same default values when a key is missing. Only applied keys touch
// the engine, so unspecified values keep tone-engine.js init() defaults.
function applyFxToEngine(engine, fx) {
    if (!fx) return;
    const v = (key) => {
        const n = Number(fx[key]);
        return Number.isFinite(n) ? n : null;
    };
    let n;
    if ((n = v('reverb-size'))    !== null) engine.setReverbSize(n / 100);
    if ((n = v('reverb-damp'))    !== null) engine.setReverbDampening(10000 - (n / 100) * 9800);
    if ((n = v('reverb-wet'))     !== null) engine.setReverbWet(n / 100);
    if ((n = v('delay-time'))     !== null) engine.setDelayTime(n / 100);
    if ((n = v('delay-feedback')) !== null) engine.setDelayFeedback(n / 100);
    if ((n = v('delay-wet'))      !== null) engine.setDelayWet(n / 100);
    if ((n = v('master-vol'))     !== null) engine.setMasterVolume(n === 0 ? -60 : -60 + (n / 100) * 60);
    if ((n = v('distortion'))     !== null) engine.setDistortion(n / 100);
    if ((n = v('master-pitch'))   !== null) engine.setMasterPitch(n);
    if ((n = v('hp-freq'))        !== null) engine.setHighpassFreq(hpFreq(n));
    if ((n = v('lp-freq'))        !== null) engine.setLowpassFreq(lpFreq(n));
    if ((n = v('phaser-freq'))    !== null) engine.setPhaserFreq(n === 0 ? 0 : 0.1 + (n / 100) * 9.9);
    if ((n = v('phaser-depth'))   !== null) engine.setPhaserDepth(n / 100);
    if ((n = v('phaser-wet'))     !== null) engine.setPhaserWet(n / 100);
    if ((n = v('crush-bits'))     !== null) engine.setCrush(n / 100);
}

// pan-move / decay-move: walk the macro's pattern over the duration,
// scheduling per-channel param changes via Tone.Transport. 'hold' is
// constant, 'pingpong' alternates per stepBeats, 'sweep' is a sine
// wave at rateBeats period. Mirrors lib/ui/controllers.js
// channelParamMove with the rAF clock replaced by audio-time.
function scheduleChannelMacro(macro, audioTime, durationMs, engine, channelTargets) {
    const Tone = window.Tone;
    if (!Tone?.Transport) return;
    const targetSet = (macro.targets === MACRO_TARGETS.nonDrums)
        ? channelTargets.nonDrums
        : channelTargets.everything;
    if (!targetSet || targetSet.length === 0) return;
    const isPan = macro.kind === 'pan-move';
    const apply = (ch, v) => {
        if (isPan) {
            const cc = Math.max(0, Math.min(127, Math.round((v + 1) * 63.5)));
            engine.controlChange(ch, 10, cc);
        } else {
            engine.setChannelDecay(ch, v);
        }
    };
    const restore = isPan ? 0 : 1.0;
    const durSec = durationMs / 1000;
    // Step rate: 12 dispatches per second = ~80 ms throttle, same as
    // the live channelParamMove. For "hold" pattern that's overkill
    // but harmless; sweep / pingpong need it.
    const STEP_SEC = 0.08;
    const steps = Math.max(1, Math.floor(durSec / STEP_SEC));
    // Use the project's tick interval to estimate beats — close enough
    // for the macro patterns. (Approximate: ~16 ticks/bar × 4 bars/sec
    // at 240 BPM; we don't have that here, so fall back on stepBeats
    // expressed in seconds at 120 BPM = 0.5 s/beat baseline.)
    const secPerBeat = 0.5;
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const elapsedSec = t * durSec;
        let v = restore;
        if (macro.pattern === 'pingpong') {
            const beat = Math.floor(elapsedSec / (secPerBeat * (macro.stepBeats || 1)));
            v = (beat % 2 === 0) ? -1 : 1;
        } else if (macro.pattern === 'sweep') {
            const rateSec = (macro.rateBeats || 4) * secPerBeat;
            const sine = Math.sin((elapsedSec / rateSec) * 2 * Math.PI);
            if (!isPan) {
                const lo = macro.sweepMin ?? 0.3;
                const hi = macro.sweepMax ?? 1.8;
                v = lo + (sine + 1) * 0.5 * (hi - lo);
            } else {
                v = sine;
            }
        } else {
            v = macro.toValue ?? restore;
        }
        const at = audioTime + elapsedSec;
        for (const ch of targetSet) {
            Tone.Transport.scheduleOnce(((c, vv) => () => apply(c, vv))(ch, v), at);
        }
    }
    // Final restore at end of duration.
    Tone.Transport.scheduleOnce(() => {
        for (const ch of targetSet) apply(ch, restore);
    }, audioTime + durSec);
}

// feel-snap / feel-sweep: project the puck X coordinate to lp-freq
// (0–100 slider value), apply at audioTime, restore at end. Tempo /
// swing / humanize axes are no-op in offline (notes are pre-baked at
// fixed audio times). Sweep variant interpolates from the current
// puck (assumed centered at [0.5, 0.5] in offline since we have no
// live puck state) to the target over the duration.
function scheduleFeelMacro(macro, audioTime, durationMs, engine, fxState) {
    const Tone = window.Tone;
    if (!Tone?.Transport) return;
    if (!Array.isArray(macro.target) || macro.target.length !== 2) return;
    const startLp = fxState['lp-freq'] ?? 100;
    const targetLp = feelPuckToLpFreq(macro.target);
    const durSec = durationMs / 1000;
    if (macro.kind === 'feel-snap') {
        Tone.Transport.scheduleOnce(() => setFxByKey(engine, 'lp-freq', targetLp), audioTime);
        Tone.Transport.scheduleOnce(() => setFxByKey(engine, 'lp-freq', startLp), audioTime + durSec);
        return;
    }
    // feel-sweep: 8 interpolation steps over durationMs, then snap back.
    const STEPS = 8;
    for (let i = 1; i <= STEPS; i++) {
        const t = i / STEPS;
        const eased = 0.5 - 0.5 * Math.cos(t * Math.PI); // cosine ease, matches live feelSweep
        const v = startLp + (targetLp - startLp) * eased;
        Tone.Transport.scheduleOnce(((vv) => () => setFxByKey(engine, 'lp-freq', vv))(v), audioTime + t * durSec);
    }
    Tone.Transport.scheduleOnce(() => setFxByKey(engine, 'lp-freq', startLp), audioTime + durSec + 0.06);
}
