// Macros runtime — the main-thread half of the live-performance macro
// pipeline: musicNets iterator, firing + executing catalog entries,
// serial queue + badges, one-shot row controls, macro-disable toggle,
// Auto-DJ tick loop (cadence + regen prefetch + transition injection),
// and ring-spin animation.
//
// Extracted from petri-note.js. Each function takes the element (`el`)
// as first argument; petri-note.js keeps one-line class-method wrappers
// so call sites like `el._fireMacro(id)` are unchanged.

import { toneEngine } from '../../audio/tone-engine.js';
import { MACROS, TRANSITION_MACRO_IDS } from './catalog.js';
import { oneShotSpec } from '../audio/oneshots.js';
import { schedAudio, clearAudioSched, audioAnimLoop, isOfflineContext } from './sched.js';

// Slider keys tracked by the tone reset/nav/save machinery. Pitch/Hits/
// Instrument stay outside — they're semantic params, not tone.
export const ONESHOT_SLIDER_KEYS = [
    ['pn-os-vol', 80],
    ['pn-os-hp',  0],
    ['pn-os-hpr', 0],
    ['pn-os-lp',  100],
    ['pn-os-lpr', 0],
    ['pn-os-atk', 0],
    ['pn-os-dec', 0],
];

// --- Music nets iterator ---

export function musicNets(el) {
    const out = [];
    for (const [id, net] of Object.entries(el._project?.nets || {})) {
        if (net.role === 'control') continue;
        out.push([id, net]);
    }
    return out;
}

// --- Panic: cancel every pending / in-flight macro effect ---

export function panicMacros(el) {
    // 1. Drop queued macros; they never fire.
    el._macroQueue = [];
    el._runningMacro = null;
    if (el._runningTimer) { clearAudioSched(el._runningTimer); el._runningTimer = null; }

    // 2. Break any beat-repeat loop — the token guard exits on next tick.
    el._beatRepeatRuns = (el._beatRepeatRuns || 0) + 1;

    // 2b. Clear any compound-macro delayed sub-fires still pending.
    if (el._compoundTimers) {
        for (const t of el._compoundTimers) clearAudioSched(t);
        el._compoundTimers = [];
    }

    // 2c. Tempo: if a tempo-hold / tempo-sweep is running, cancel + snap
    //     back to its captured start BPM instead of waiting for the
    //     scheduled restore / sweep to finish.
    if (el._tempoAnim) {
        const tok = el._tempoAnim;
        tok.cancelled = true;
        if (tok.timeout) clearAudioSched(tok.timeout);
        if (typeof tok.startBpm === 'number') el._setTempo(tok.startBpm);
        el._tempoAnim = null;
    }
    // 2d. Feel: cancel any in-flight Feel snap/sweep/genre-reset so its
    //     rAF loop or restore timeout stops overriding the puck.
    cancelFeelAnim(el);

    // 3. Cancel + restore every in-flight channel param animation
    //    (pan-move / decay-move).
    if (el._chanAnim) {
        for (const id of Object.keys(el._chanAnim)) {
            const t = el._chanAnim[id];
            if (!t) continue;
            if (t.hardStop) { clearTimeout(t.hardStop); }
            // Run restore manually via the stored snapshot.
            if (t.before) {
                for (const ch of Object.keys(t.before)) {
                    const v = t.before[ch];
                    const chNum = parseInt(ch, 10);
                    // Snapshot format differs by kind — decay is a scalar
                    // multiplier in roughly [0.05, 3.0]; pan is the raw
                    // panner.pan.value in [-1, +1].
                    if (v >= -1 && v <= 1) {
                        const cc = Math.max(0, Math.min(127, Math.round((v + 1) * 63.5)));
                        toneEngine.controlChange(chNum, 10, cc);
                    } else {
                        toneEngine.setChannelDecay(chNum, v);
                    }
                }
            }
            t.cancelled = true;
        }
        el._chanAnim = {};
    }

    // 4. Cancel every pulse token and strip its CSS.
    if (el._pulseAnim) {
        for (const id of Object.keys(el._pulseAnim)) {
            const t = el._pulseAnim[id];
            if (t) t.cancelled = true;
        }
        el._pulseAnim = {};
    }
    el.querySelectorAll('.pn-pulsing, .pn-pulsing-hot').forEach(node => {
        node.classList.remove('pn-pulsing', 'pn-pulsing-hot');
    });

    // 5. Cancel master-FX sweep/hold animations AND restore their slider
    //    to the pre-macro start value. Without the restore, the slider
    //    stays wherever the ramp was when we cancelled — "stranded
    //    reverb" etc.
    if (el._fxAnim) {
        for (const key of Object.keys(el._fxAnim)) {
            const t = el._fxAnim[key];
            if (!t) continue;
            t.cancelled = true;
            if (t.slider && typeof t.start === 'number') {
                el._setFxValue(t.slider, t.start);
            }
        }
        el._fxAnim = {};
    }

    // 6. Tell the worker to prune in-flight macro control nets, then
    //    unmute anything not in the user's manual mute set — but keep
    //    the project's schema-reserved `initialMutes` (hit1-hit4 stinger
    //    slots) muted. Without this guard, Panic unmutes the stinger
    //    tracks and the first beat after panic dumps four stingers onto
    //    the mix.
    el._sendWs({ type: 'cancel-macros' });
    const manual = el._manualMutedNets || new Set();
    const initial = new Set(el._project?.initialMutes || []);
    const muted = [...el._mutedNets];
    for (const id of muted) {
        if (manual.has(id) || initial.has(id)) continue;
        el._mutedNets.delete(id);
        el._sendWs({ type: 'mute', netId: id, muted: false });
    }

    // 7. Visual book-keeping — drop queue badges, reset serial slot UI.
    updateQueuedBadges(el);
    el.querySelectorAll('.pn-macro-btn.running, .pn-macro-btn.queued, .pn-macro-btn.firing')
        .forEach(b => b.classList.remove('running', 'queued', 'firing'));
    el.querySelectorAll('.pn-macro-queue-badge').forEach(b => b.remove());

    const statusEl = el.querySelector('.pn-autodj-status');
    if (statusEl && el.querySelector('.pn-autodj-enable')?.checked) {
        statusEl.textContent = '(panicked — cycle will resume)';
    }
}

// --- Fire + execute ---

export function fireMacro(el, id, opts) {
    // Serial execution: if anything is running, push onto the FIFO queue.
    el._macroQueue ||= [];
    if (el._runningMacro) {
        el._macroQueue.push(opts ? { id, opts } : id);
        updateQueuedBadges(el);
        return;
    }
    executeMacro(el, id, opts);
}

export function executeMacro(el, id, opts) {
    const macro = MACROS.find(m => m.id === id);
    if (!macro) return;
    // Prefer explicit override (e.g. from a control-net fire-macro), then
    // the panel UI select, then the macro's default. NOTE: 0 is the
    // sentinel for "permanent — fire and don't auto-restore", so use
    // explicit isFinite checks instead of an `||` falsy chain.
    const sel = el.querySelector(`.pn-macro-bars[data-macro="${id}"]`);
    const optsDur = opts && Number.isFinite(opts.duration) ? opts.duration : null;
    const selDur = sel ? parseInt(sel.value, 10) : NaN;
    const duration = optsDur != null ? optsDur
                   : Number.isFinite(selDur) ? selDur
                   : macro.defaultDuration;
    const permanent = duration === 0;
    // For permanent macros that still need a "ramp time" (FX sweep), use
    // the macro's default duration as the time to reach the target value.
    const effectiveDuration = permanent ? macro.defaultDuration : duration;
    const durationTicks = macro.durationUnit === 'tick' ? effectiveDuration : effectiveDuration * 16;
    const msPerTick = el._msPerBar() / 16;
    const durationMs = durationTicks * msPerTick;
    // Pulse for ~3 bars on permanent so the user gets feedback the fire
    // landed without the pulse class hanging around forever.
    const pulseMs = permanent ? Math.min(3 * el._msPerBar(), 4000) : durationMs;

    if (macro.kind === 'mute') {
        const targets = macro.targets(el);
        if (targets.length > 0) {
            el._sendWs({
                type: 'fire-macro',
                macroId: `${id}-${Date.now().toString(36)}`,
                targets,
                durationTicks,
                muteAction: 'mute-track',
                // null = no auto-restore. Worker mutes and stays muted.
                restoreAction: permanent ? null : 'unmute-track',
            });
            const muteEls = targets
                .map(tid => el._mixerEl?.querySelector(`.pn-mixer-row[data-net-id="${tid}"] .pn-mixer-mute`)
                         || el._mixerEl?.querySelector(`.pn-mixer-row[data-riff-group="${tid}"] .pn-mixer-mute`))
                .filter(Boolean);
            el._macroPulse(muteEls, pulseMs, `mute:${id}`);
        }
    } else if (macro.kind === 'fx-sweep' || macro.kind === 'fx-hold') {
        const ops = macro.ops || [{ fxKey: macro.fxKey, toValue: macro.toValue }];
        if (permanent) {
            // Snap to the target value and stay — no ramp-back.
            for (const op of ops) el._setFxByKey(op.fxKey, op.toValue);
        } else {
            for (const op of ops) {
                if (macro.kind === 'fx-sweep') el._fxSweep(op.fxKey, op.toValue, durationMs);
                else                           el._fxHold (op.fxKey, op.toValue, durationMs, macro.tailFrac);
            }
        }
        const fxEls = ops.map(op => el._fxSlider(op.fxKey)).filter(Boolean);
        el._macroPulse(fxEls, pulseMs, `fx:${id}`);
    } else if (macro.kind === 'pan-move' || macro.kind === 'decay-move') {
        // _channelParamMove always restores; for permanent we use a
        // very long duration so the move sticks for the foreseeable
        // session. (A first-class permanent path would need plumbing
        // into channelParamMove; this is the simplest non-invasive
        // approximation.)
        el._channelParamMove(macro, permanent ? 24 * 60 * 60 * 1000 : durationMs);
    } else if (macro.kind === 'beat-repeat') {
        el._runBeatRepeat(macro, durationMs);
    } else if (macro.kind === 'compound') {
        el._runCompound(macro, duration, macro.durationUnit, msPerTick);
    } else if (macro.kind === 'feel-snap') {
        if (permanent) {
            cancelFeelAnim(el);
            el._applyFeel(clampPuck(macro.target));
            pulseFeelButton(el, pulseMs, 'feel-snap');
        } else {
            feelSnap(el, macro.target, durationMs);
        }
    } else if (macro.kind === 'feel-sweep') {
        feelSweep(el, macro.target, durationMs);
    } else if (macro.kind === 'tempo-hold') {
        if (permanent) {
            const startBpm = el._tempo || 120;
            el._setTempo(Math.max(20, Math.round(startBpm * macro.factor)));
        } else {
            el._tempoHold(macro.factor, durationMs);
        }
    } else if (macro.kind === 'tempo-sweep') {
        el._tempoSweep(macro.finalBpm, durationMs);
    } else if (macro.kind === 'tempo-anchor') {
        if (permanent) {
            const genre = el.querySelector('.pn-genre-select')?.value;
            const targetBpm = el._genreData?.[genre]?.bpm || 120;
            el._setTempo(Math.round(targetBpm));
        } else {
            el._tempoAnchor(durationMs);
        }
    } else if (macro.kind === 'genre-reset') {
        feelGenreReset(el, durationMs);
    } else if (macro.kind === 'one-shot') {
        // Fire pad is an N-bar macro: unmute the stinger net for the
        // selected bar count so its Petri ring pulses every beat, then
        // re-mute on timer. The Pit dropdown is read live per-note in
        // onRemoteTransitionFired — not stashed here — so manual unmute
        // via hotkey 1–4 or the mixer mute button respects the same
        // pitch setting without a separate code path.
        const barsSel = el.querySelector(`.pn-os-bars[data-macro="${id}"]`);
        const bars = parseInt(barsSel?.value, 10) || 2;
        const windowMs = bars * el._msPerBar();

        // Unmute for the window (track re-mutes on timer expiry). Skip
        // when the track is 'unbound' (silent slot) — the paired FX is
        // then the only audible effect.
        const track = el._project?.nets?.[id];
        const currentInst = track?.track?.instrument;
        const wasMutedBefore = el._mutedNets?.has(id) || el._manualMutedNets?.has(id);
        if (currentInst !== 'unbound' && wasMutedBefore) {
            el._toggleMute(id);
        }
        el._stingerMuteTimers ||= {};
        clearAudioSched(el._stingerMuteTimers[id]);
        el._stingerMuteTimers[id] = schedAudio(() => {
            const stillUnmuted = !(el._mutedNets?.has(id) || el._manualMutedNets?.has(id));
            if (currentInst !== 'unbound' && wasMutedBefore && stillUnmuted) {
                el._toggleMute(id);
            }
        }, windowMs);

        // Paired FX: fire with the Fire pad's bar count, not the macro's
        // own default — so the effect lasts exactly as long as the beat
        // pulse it's stacked on.
        const pairSel = el.querySelector(`.pn-os-pair[data-macro="${id}"]`);
        const pairId = pairSel?.value;
        if (pairId && pairId !== id) {
            const pairBars = el.querySelector(`.pn-macro-bars[data-macro="${pairId}"]`);
            const savedBars = pairBars?.value;
            if (pairBars) pairBars.value = String(bars);
            const savedRunning = el._runningMacro;
            el._runningMacro = null;        // bypass serial queue for this side-effect
            try { executeMacro(el, pairId); } finally { el._runningMacro = savedRunning; }
            if (pairBars && savedBars != null) pairBars.value = savedBars;
        }
    }

    const btn = el.querySelector(`.pn-macro-btn[data-macro="${id}"]`);
    if (btn) {
        btn.classList.add('firing');
        setTimeout(() => btn.classList.remove('firing'), 120);
    }
    // One-shots finish fast — budget ~700 ms per hit so the serial queue
    // doesn't release while stutters are still firing. Permanent macros
    // budget the pulse duration so the queue releases promptly.
    const runTime = macro.kind === 'one-shot'
        ? 700 + Math.max(0, duration - 1) * (el._msPerBar() / 16)
        : (permanent ? pulseMs : durationMs);
    markMacroRunning(el, id, runTime);
}

// --- Feel macros: snap / sweep + visual pulse + auto-restore ---
//
// Both helpers capture the pre-fire puck position, drive a brief
// animation that touches `el._applyFeel`, and snap back at end-of-life.
// The Feel button (◈) pulses for the macro duration so the visual
// feedback matches every other macro family.
function clampPuck(p) {
    return [Math.max(0, Math.min(1, p[0])), Math.max(0, Math.min(1, p[1]))];
}

// Pulse every UI element a Feel macro touches: the Feel button, the BPM
// input, and the 8 master FX sliders that applyFeelGrid drives. Mirrors
// how fx-sweep/fx-hold pulse their target sliders, so the user sees
// exactly which controls are being modulated.
function pulseFeelButton(el, durationMs, key) {
    const targets = [];
    const feelBtn = el.querySelector('.pn-feel-open');
    if (feelBtn) targets.push(feelBtn);
    const bpmInput = el.querySelector('.pn-tempo input[type="number"]');
    if (bpmInput) targets.push(bpmInput);
    for (const k of FEEL_FX_KEYS) {
        const s = el._fxSlider?.(k);
        if (s) targets.push(s);
    }
    if (targets.length) el._macroPulse(targets, durationMs, key);
}

// Cancel any in-flight Feel animation (snap timeout, sweep rAF loop,
// genre-reset rAF loop). Without this, a stale animation from an
// earlier macro keeps overriding _applyFeel on every frame and the
// new macro's restore appears to "not work" — actually it does work,
// but the prior loop clobbers it on the next tick.
function cancelFeelAnim(el) {
    if (el._feelAnim) {
        el._feelAnim.cancelled = true;
        if (el._feelAnim.timeout) clearAudioSched(el._feelAnim.timeout);
        el._feelAnim = null;
    }
}

// Capture the actual current values of every parameter the Feel grid
// touches — not just the puck. applyFeel only restores the puck and
// re-blends FX/tempo/swing/humanize from the corner snapshots, which
// loses any *manual* slider adjustments the user made before firing
// the macro. Snapshot+restore solves that.
const FEEL_FX_KEYS = ['distortion', 'crush-bits', 'reverb-wet', 'reverb-size',
    'reverb-damp', 'delay-wet', 'delay-feedback', 'lp-freq'];

function snapshotFeelState(el) {
    const fx = {};
    for (const k of FEEL_FX_KEYS) {
        const v = el._fxSlider?.(k)?.value;
        if (v != null) fx[k] = parseInt(v, 10);
    }
    return {
        puck: el._feelState?.puck ? [...el._feelState.puck] : [0.5, 0.5],
        tempo: el._tempo || 120,
        swing: el._swing,
        humanize: el._humanize,
        fx,
    };
}

function restoreFeelState(el, snap) {
    if (!snap) return;
    el._applyFeel(snap.puck);          // sets puck + saves to localStorage
    if (Number.isFinite(snap.tempo))    el._setTempo(snap.tempo);
    if (Number.isFinite(snap.swing))    { el._swing = snap.swing;    if (el._project) el._project.swing = snap.swing; }
    if (Number.isFinite(snap.humanize)) { el._humanize = snap.humanize; if (el._project) el._project.humanize = snap.humanize; }
    // Re-apply the captured FX values *after* applyFeel so they win —
    // applyFeel writes blended defaults that would otherwise stomp the
    // user's manual adjustments.
    if (snap.fx) {
        // Reverb flush: drop wet to 0 briefly before restoring so the
        // lingering tail from the macro's larger room model doesn't
        // bleed back when wet snaps to the user's manual level.
        // Tone.Freeverb's wet rampTo is 50ms; 180ms covers the perceptual
        // worst of the tail on most settings without an audible click.
        const targetWet = snap.fx['reverb-wet'];
        if (Number.isFinite(targetWet)) {
            el._setFxByKey('reverb-wet', 0);
            schedAudio(() => el._setFxByKey('reverb-wet', targetWet), 180);
        }
        for (const [k, v] of Object.entries(snap.fx)) {
            if (k === 'reverb-wet') continue; // handled by the flush above
            el._setFxByKey(k, v);
        }
    }
}

function feelSnap(el, target, durationMs) {
    if (!Array.isArray(target) || target.length !== 2) return;
    cancelFeelAnim(el);
    const snap = snapshotFeelState(el);
    const token = { cancelled: false };
    el._feelAnim = token;
    el._applyFeel(clampPuck(target));
    pulseFeelButton(el, durationMs, 'feel-snap');
    token.timeout = schedAudio(() => {
        if (token.cancelled) return;
        restoreFeelState(el, snap);
        if (el._feelAnim === token) el._feelAnim = null;
    }, durationMs);
}

// Hard "factory defaults" for every FX slider. Mirrors the fxDefaults
// map in build.js's FX Reset button, so Feel: Reset lands at the exact
// same target values — just gradually instead of cutting over.
const FX_HARD_DEFAULTS = {
    'reverb-size': 50, 'reverb-damp': 30, 'reverb-wet': 20,
    'delay-time': 25, 'delay-feedback': 25, 'delay-wet': 15,
    'master-vol': 80, 'distortion': 0, 'hp-freq': 0, 'lp-freq': 100,
    'phaser-freq': 0, 'phaser-depth': 50, 'phaser-wet': 0,
    'crush-bits': 0, 'master-pitch': 0,
};

// Feel: Reset — gradual sibling of the tab-level FX Reset button, plus
// returning BPM to the current genre's default. Same FX destination as
// FX Reset (every master slider → factory default), but ramped over N
// bars and with tempo eased back home as a bonus. Puck is intentionally
// left alone (only FX + tempo). One-way; ends with _disengageFeel.
function feelGenreReset(el, durationMs) {
    cancelFeelAnim(el);
    const startFx = {};
    for (const k of Object.keys(FX_HARD_DEFAULTS)) {
        const v = el._fxSlider?.(k)?.value;
        if (v != null) startFx[k] = parseInt(v, 10);
    }
    const startBpm = el._tempo || 120;
    const genre = el.querySelector('.pn-genre-select')?.value;
    const targetBpm = el._genreData?.[genre]?.bpm || 120;
    // Tempo updates re-anchor the audio-grid scheduler in
    // onRemoteTransitionFired (changes to tickIntervalMs trigger a
    // re-anchor). At 10 Hz that's 40 re-anchors per 4-bar sweep —
    // enough to cause audible scheduler jitter and perceived
    // dropouts. Drop the BPM lerp entirely when there's no actual
    // change, and pace the FX/BPM lerp at 200ms otherwise.
    const bpmChanges = Math.abs(startBpm - targetBpm) > 1;
    const token = { cancelled: false };
    el._feelAnim = token;
    pulseFeelButton(el, durationMs, 'genre-reset');
    const STEP_MS = 200;
    let last = -Infinity;
    const lerpFx = (e) => {
        for (const [k, def] of Object.entries(FX_HARD_DEFAULTS)) {
            const start = startFx[k];
            if (!Number.isFinite(start)) continue;
            if (start === def) continue; // no-op
            el._setFxByKey(k, Math.round(start + (def - start) * e));
        }
    };
    const applyAt = (elapsed) => {
        if (!el.isConnected || token.cancelled) return;
        const t = elapsed / durationMs;
        if (t >= 1) {
            lerpFx(1);
            if (bpmChanges) el._setTempo(Math.round(targetBpm));
            el._disengageFeel?.();
            if (el._feelAnim === token) el._feelAnim = null;
            return;
        }
        if (elapsed - last >= STEP_MS || isOfflineContext()) {
            last = elapsed;
            const e = Math.sin(t * Math.PI / 2);
            lerpFx(e);
            if (bpmChanges) {
                el._setTempo(Math.round(startBpm + (targetBpm - startBpm) * e));
            }
        }
    };
    audioAnimLoop(durationMs, STEP_MS, applyAt);
}

function feelSweep(el, target, durationMs) {
    if (!Array.isArray(target) || target.length !== 2) return;
    cancelFeelAnim(el);
    const snap = snapshotFeelState(el);
    const start = snap.puck;
    const end = clampPuck(target);
    const token = { cancelled: false };
    el._feelAnim = token;
    pulseFeelButton(el, durationMs, 'feel-sweep');
    // applyFeelGrid touches tempo + lp-freq every call. Tempo updates
    // re-anchor the audio-grid scheduler in onRemoteTransitionFired,
    // so a high update rate causes audible scheduler jitter ("audio
    // dropouts"). Throttle to 5 Hz — still smooth visually, far
    // gentler on playback timing.
    const STEP_MS = 200;
    let last = -Infinity;
    const applyAt = (elapsed) => {
        if (!el.isConnected || token.cancelled) return;
        const t = elapsed / durationMs;
        if (t >= 1) {
            el._applyFeel(end);
            token.timeout = schedAudio(() => {
                if (token.cancelled) return;
                restoreFeelState(el, snap);
                if (el._feelAnim === token) el._feelAnim = null;
            }, 60);
            return;
        }
        if (elapsed - last >= STEP_MS || isOfflineContext()) {
            last = elapsed;
            const e = 0.5 - 0.5 * Math.cos(t * Math.PI);
            const x = start[0] + (end[0] - start[0]) * e;
            const y = start[1] + (end[1] - start[1]) * e;
            el._applyFeel([x, y]);
        }
    };
    audioAnimLoop(durationMs, STEP_MS, applyAt);
}

// --- One-shot row: snapshot / apply / reset / nav / favorites ---

export function snapshotOneShot(el, macroId) {
    const snap = {};
    for (const [cls] of ONESHOT_SLIDER_KEYS) {
        const node = el.querySelector(`.${cls}[data-macro="${macroId}"]`);
        if (node) snap[cls] = parseFloat(node.value);
    }
    const inst = el.querySelector(`.pn-os-inst[data-macro="${macroId}"]`);
    if (inst) snap.inst = inst.value;
    const hits = el.querySelector(`.pn-os-hits[data-macro="${macroId}"]`);
    if (hits) snap.hits = hits.value;
    const pit  = el.querySelector(`.pn-os-pitch[data-macro="${macroId}"]`);
    if (pit)  snap.pitch = pit.value;
    return snap;
}

export function applyOneShotSnapshot(el, macroId, snap) {
    for (const [cls] of ONESHOT_SLIDER_KEYS) {
        const node = el.querySelector(`.${cls}[data-macro="${macroId}"]`);
        if (node && snap[cls] != null) node.value = snap[cls];
    }
    if (snap.inst != null) {
        const inst = el.querySelector(`.pn-os-inst[data-macro="${macroId}"]`);
        if (inst) {
            inst.value = snap.inst;
            const btn = el.querySelector(`.pn-os-fire[data-macro="${macroId}"]`);
            if (btn) btn.textContent = `Fire ${oneShotSpec(snap.inst)?.label || snap.inst}`;
        }
    }
    if (snap.hits != null) {
        const hits = el.querySelector(`.pn-os-hits[data-macro="${macroId}"]`);
        if (hits) hits.value = snap.hits;
    }
    if (snap.pitch != null) {
        const pit = el.querySelector(`.pn-os-pitch[data-macro="${macroId}"]`);
        if (pit) pit.value = snap.pitch;
    }
}

export function oneShotToneReset(el, macroId) {
    const snap = {};
    for (const [cls, def] of ONESHOT_SLIDER_KEYS) snap[cls] = def;
    applyOneShotSnapshot(el, macroId, snap);
    el._oneShotToneHistory ||= new Map();
    el._oneShotToneIndex   ||= new Map();
    el._oneShotToneHistory.set(macroId, [snap]);
    el._oneShotToneIndex.set(macroId, 0);
}

export function oneShotToneStep(el, macroId, dir) {
    el._oneShotToneHistory ||= new Map();
    el._oneShotToneIndex   ||= new Map();
    const hist = el._oneShotToneHistory.get(macroId) || [snapshotOneShot(el, macroId)];
    let idx = el._oneShotToneIndex.get(macroId) ?? (hist.length - 1);
    if (dir > 0) {
        // Generate a random mutation and append.
        const snap = {};
        for (const [cls] of ONESHOT_SLIDER_KEYS) {
            snap[cls] = Math.round(Math.random() * 100);
        }
        // Keep Vol sane (50–100) so randoms don't disappear.
        snap['pn-os-vol'] = 50 + Math.round(Math.random() * 50);
        hist.push(snap);
        idx = hist.length - 1;
    } else {
        idx = Math.max(0, idx - 1);
    }
    el._oneShotToneHistory.set(macroId, hist);
    el._oneShotToneIndex.set(macroId, idx);
    applyOneShotSnapshot(el, macroId, hist[idx]);
}

export function oneShotFavorite(el, macroId, ev) {
    const storeKey = 'pn-oneshot-favorites';
    const favs = JSON.parse(localStorage.getItem(storeKey) || '{}');
    const list = favs[macroId] || [];
    if (ev.shiftKey && list.length > 0) {
        // Shift-click → cycle through favorites.
        el._oneShotFavIdx ||= new Map();
        const idx = ((el._oneShotFavIdx.get(macroId) ?? -1) + 1) % list.length;
        el._oneShotFavIdx.set(macroId, idx);
        applyOneShotSnapshot(el, macroId, list[idx].snap);
        return;
    }
    if (list.length > 0 && !ev.altKey) {
        const names = list.map((f, i) => `${i+1}. ${f.name}`).join('\n');
        const choice = prompt(`Favorites for ${macroId}:\n${names}\n\nEnter number to load, 's' to save current, or blank to cancel:`, 's');
        if (!choice) return;
        if (choice === 's') {
            const name = prompt('Name this favorite:', list.length ? `${macroId}-${list.length + 1}` : macroId);
            if (!name) return;
            list.push({ name, snap: snapshotOneShot(el, macroId) });
            favs[macroId] = list;
            localStorage.setItem(storeKey, JSON.stringify(favs));
            return;
        }
        const n = parseInt(choice, 10);
        if (Number.isFinite(n) && n >= 1 && n <= list.length) {
            applyOneShotSnapshot(el, macroId, list[n - 1].snap);
        }
        return;
    }
    // First-time save.
    const name = prompt('Name this favorite:', macroId);
    if (!name) return;
    list.push({ name, snap: snapshotOneShot(el, macroId) });
    favs[macroId] = list;
    localStorage.setItem(storeKey, JSON.stringify(favs));
}

// --- Long-press toggle for touch (disable macro from the panel) ---

export function bindLongPressToggle(el, panel) {
    const LONG_PRESS_MS = 450;
    let timer = null;
    let activeBtn = null;
    const cancel = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        activeBtn = null;
    };
    panel.addEventListener('touchstart', (e) => {
        const btn = e.target.closest('.pn-macro-btn');
        if (!btn) return;
        // Fresh press → any prior suppression flag is stale; drop it.
        delete btn.dataset.suppressClick;
        cancel();
        activeBtn = btn;
        timer = setTimeout(() => {
            if (!activeBtn) return;
            activeBtn.dataset.suppressClick = '1';
            toggleMacroDisabled(el, activeBtn.dataset.macro);
            // Haptic nudge where supported.
            if (navigator.vibrate) navigator.vibrate(15);
            timer = null;
        }, LONG_PRESS_MS);
    }, { passive: true });
    panel.addEventListener('touchmove', cancel,   { passive: true });
    panel.addEventListener('touchend', cancel,    { passive: true });
    panel.addEventListener('touchcancel', cancel, { passive: true });
    // Capture-phase click filter: if the long-press timer flagged a
    // button, swallow the resulting click so the macro doesn't fire.
    panel.addEventListener('click', (e) => {
        const btn = e.target.closest('.pn-macro-btn');
        if (btn?.dataset.suppressClick) {
            delete btn.dataset.suppressClick;
            e.stopPropagation();
            e.preventDefault();
        }
    }, true);
}

// --- Disable toggle ---

export function toggleMacroDisabled(el, id) {
    el._disabledMacros = el._disabledMacros || loadDisabledMacros(el);
    if (el._disabledMacros.has(id)) el._disabledMacros.delete(id);
    else                            el._disabledMacros.add(id);
    saveDisabledMacros(el);
    refreshMacroDisabledMarks(el);
}

export function loadDisabledMacros(el) {
    try {
        const raw = localStorage.getItem('pn-macro-disabled');
        return new Set(raw ? JSON.parse(raw) : []);
    } catch { return new Set(); }
}

export function saveDisabledMacros(el) {
    try {
        localStorage.setItem('pn-macro-disabled', JSON.stringify([...el._disabledMacros]));
    } catch {}
}

export function refreshMacroDisabledMarks(el) {
    if (!el._disabledMacros) return;
    for (const btn of el.querySelectorAll('.pn-macro-btn[data-macro]')) {
        btn.classList.toggle('pn-macro-disabled', el._disabledMacros.has(btn.dataset.macro));
    }
}

// --- Auto-DJ settings persistence ---

export function saveAutoDjSettings(el) {
    try {
        const panel = el.querySelector('.pn-autodj-panel');
        if (!panel) return;
        const pools = {};
        for (const cb of panel.querySelectorAll('.pn-autodj-pool')) {
            pools[cb.value] = cb.checked;
        }
        const state = {
            showAutoDj: !!el._showAutoDj,
            run:         !!panel.querySelector('.pn-autodj-enable')?.checked,
            animateOnly: !!panel.querySelector('.pn-autodj-animate-only')?.checked,
            rate:        panel.querySelector('.pn-autodj-rate')?.value,
            regen:       panel.querySelector('.pn-autodj-regen')?.value,
            stack:       panel.querySelector('.pn-autodj-stack')?.value,
            pools,
        };
        localStorage.setItem('pn-autodj-settings', JSON.stringify(state));
    } catch {}
}

export function restoreAutoDjSettings(el, autoDjBtn, panel) {
    let state;
    try {
        const raw = localStorage.getItem('pn-autodj-settings');
        if (!raw) return;
        state = JSON.parse(raw);
    } catch { return; }
    if (!state) return;
    if (state.showAutoDj) {
        el._showAutoDj = true;
        panel.style.display = 'flex';
        autoDjBtn.classList.add('active');
    }
    const set = (cls, val) => {
        const node = panel.querySelector(`.${cls}`);
        if (!node) return;
        if (node.type === 'checkbox') node.checked = !!val;
        else if (val != null) node.value = val;
    };
    set('pn-autodj-enable',        state.run);
    set('pn-autodj-animate-only',  state.animateOnly);
    set('pn-autodj-rate',          state.rate);
    set('pn-autodj-regen',         state.regen);
    set('pn-autodj-stack',         state.stack);
    if (state.pools) {
        for (const cb of panel.querySelectorAll('.pn-autodj-pool')) {
            if (cb.value in state.pools) cb.checked = !!state.pools[cb.value];
        }
    }
}

// --- Auto-DJ tick: cadence + regen prefetch + transition injection ---

export function autoDjTick(el, prevTick, curTick) {
    // Arm state is the Run checkbox, not tab visibility.
    const enableEl = el.querySelector('.pn-autodj-enable');
    if (!enableEl?.checked) return;
    if (curTick === prevTick) return;
    // Tick wrap (loop wrap or freshly-regenerated project resets to 0).
    if (curTick < prevTick) { el._autoDjPreviewPending = false; return; }
    const ticksPerBar = 16;

    // Regen check runs independently of macro cadence.
    const regenBars = parseInt(el.querySelector('.pn-autodj-regen')?.value, 10) || 0;
    if (regenBars > 0) {
        const regenBoundary = regenBars * ticksPerBar;
        const prefetchTick = regenBoundary - ticksPerBar; // 1 bar early
        const prPf = ((prevTick) % regenBoundary) < prefetchTick;
        const crPf = ((curTick)  % regenBoundary) >= prefetchTick;
        if (prPf && crPf && !el._autoDjPreviewPending && curTick > 0) {
            el._autoDjPreviewPending = true;
            const genre = el.querySelector('.pn-genre-select')?.value || 'techno';
            const params = { ...(el._traitOverrides || {}) };
            const structure = el.querySelector('.pn-structure-select')?.value || '';
            if (structure) params.structure = structure;
            const reqId = ++el._previewReqId;
            el._sendWs({ type: 'generate-preview', genre, params, reqId });
            const statusEl = el.querySelector('.pn-autodj-status');
            if (statusEl) statusEl.textContent = `pre-loading next…`;
        }

        const pr = Math.floor(prevTick / regenBoundary);
        const cr = Math.floor(curTick  / regenBoundary);
        if (cr !== pr && curTick > 0) {
            const preview = el._pendingNextTrack;
            if (preview) {
                // Seamless regen: hand the pre-rendered project to the
                // worker via project-queue so the swap lands on a bar
                // boundary (resets tickCount).
                el._pendingNextTrack = null;
                const label = injectTransitionNet(el, preview);
                el._sendWs({ type: 'project-queue', project: preview });
                const statusEl = el.querySelector('.pn-autodj-status');
                if (statusEl && label) statusEl.textContent = `⟳ ${label}`;
            } else {
                // Pre-load didn't land in time — fall back to a sync gen.
                // The generate click routes through the same path that
                // ships `injectTransitionNet` in the generate message,
                // so the transition still lands on the fresh project.
                el._previewReqId++;
                el.querySelector('.pn-generate-btn')?.click();
            }
            el._autoDjPreviewPending = false;
            const statusEl = el.querySelector('.pn-autodj-status');
            if (statusEl) statusEl.textContent = `regenerating…`;
        }
    }

    const rateBars = parseInt(el.querySelector('.pn-autodj-rate')?.value, 10) || 2;
    const boundary = rateBars * ticksPerBar;
    const prev = Math.floor(prevTick / boundary);
    const cur  = Math.floor(curTick / boundary);
    if (cur === prev) return;

    autoDjFireMacros(el);
}

export function pickTransitionMacroId(el) {
    if (!el.querySelector('.pn-autodj-enable')?.checked) return null;
    const pools = el.querySelectorAll('.pn-autodj-pool:checked');
    const enabled = new Set([...pools].map(cb => cb.value));
    if (!enabled.has('Transition')) return null;
    el._disabledMacros = el._disabledMacros || loadDisabledMacros(el);
    const ids = [...TRANSITION_MACRO_IDS].filter(id => !el._disabledMacros.has(id));
    if (ids.length === 0) return null;
    return ids[Math.floor(Math.random() * ids.length)];
}

export function fireTransitionMacro(el) {
    const id = pickTransitionMacroId(el);
    if (!id) return;
    const macro = MACROS.find(m => m.id === id);
    fireMacro(el, id);
    const statusEl = el.querySelector('.pn-autodj-status');
    if (statusEl) statusEl.textContent = `⟳ ${macro?.label || id}`;
}

// Plain-JSON one-transition control net that fires a `fire-macro`
// control binding on its first tick.
export function transitionNetJson(macroId) {
    return {
        role: 'control',
        track: { channel: 1 },
        places: { p0: { initial: [1] }, p1: {} },
        transitions: {
            t0: {
                control: { action: 'fire-macro', targetNet: macroId },
            },
        },
        arcs: [
            { source: 'p0', target: 't0' },
            { source: 't0', target: 'p1' },
        ],
    };
}

export function injectTransitionNet(el, project) {
    const id = pickTransitionMacroId(el);
    if (!id || !project?.nets) return null;
    const netId = `macro:transition:${id}:${Date.now().toString(36)}`;
    project.nets[netId] = transitionNetJson(id);
    return MACROS.find(m => m.id === id)?.label || id;
}

export function autoDjFireMacros(el) {
    const stack = parseInt(el.querySelector('.pn-autodj-stack')?.value, 10) || 1;
    const animateOnly = !!el.querySelector('.pn-autodj-animate-only')?.checked;
    const statusEl = el.querySelector('.pn-autodj-status');

    // Animate-only: skip macro selection entirely, just spin the ring.
    if (animateOnly) {
        autoDjSpin(el, stack);
        if (statusEl) statusEl.textContent = `(animate only)`;
        return;
    }

    // Don't pile up — if any macro is still running or queued, skip.
    if (el._runningMacro || (el._macroQueue && el._macroQueue.length > 0)) {
        if (statusEl) statusEl.textContent = `(skipped — busy)`;
        return;
    }

    const poolBoxes = el.querySelectorAll('.pn-autodj-pool:checked');
    const enabled = new Set([...poolBoxes].map(cb => cb.value));

    el._disabledMacros = el._disabledMacros || loadDisabledMacros(el);
    const candidates = enabled.size === 0 ? [] : MACROS.filter(m => {
        if (m.kind === 'compound') return false;
        if (el._disabledMacros.has(m.id)) return false;
        if (m.kind === 'one-shot') return enabled.has('Beats');
        return enabled.has(m.group);
    });

    if (candidates.length === 0) {
        autoDjSpin(el, stack);
        if (statusEl) statusEl.textContent = `(no candidates)`;
        return;
    }

    const fired = [];
    for (let i = 0; i < stack; i++) {
        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        fired.push(pick.label);
        if (i === 0) fireMacro(el, pick.id);
        else         executeMacro(el, pick.id);
    }
    autoDjSpin(el, stack);
    if (statusEl) statusEl.textContent = `→ ${fired.join(', ')}`;
}

// --- Ring rotation ---

// Nudge the ring-visualization rotation by ±90° per step, alternating
// direction between cadences so consecutive fires visibly swing.
export function autoDjSpin(el, steps = 1) {
    if (steps <= 0) return;
    const dir = el._autoDjDir || 1;
    el._autoDjTargetAngle = (el._autoDjTargetAngle || 0) + dir * 90 * steps;
    el._autoDjDir = -dir;
    el._autoDjSpinStart = performance.now();
    el._autoDjSpinFrom = el._autoDjAngleDeg || 0;
    // Arrow direction follows rotation direction.
    el._autoDjReverse = dir < 0;
    autoDjSpinAnimate(el);
}

export function autoDjSpinAnimate(el) {
    const DURATION = 800;
    const t0 = el._autoDjSpinStart;
    const from = el._autoDjSpinFrom || 0;
    const to   = el._autoDjTargetAngle || 0;
    const step = (now) => {
        const elapsed = now - t0;
        const t = Math.min(1, elapsed / DURATION);
        // cubic-bezier-ish ease out.
        const eased = 1 - Math.pow(1 - t, 3);
        el._autoDjAngleDeg = from + (to - from) * eased;
        // When the viz loop is running, it redraws every rAF with rotation
        // applied — calling _draw() here would clear its timeline.
        if (!el._vizRafId) el._draw();
        if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

// --- Repeating one-shots + running marks + queue badges ---

export function fireRepeatingOneShots(el, prevTick, curTick) {
    if (!el._showOneShots || curTick === prevTick) return;
    const prevBeat = Math.floor(prevTick / 4);
    const curBeat  = Math.floor(curTick / 4);
    if (curBeat === prevBeat) return;
    const boxes = el.querySelectorAll('.pn-os-repeat:checked');
    for (const cb of boxes) fireMacro(el, cb.dataset.macro);
}

export function markMacroRunning(el, id, durationMs) {
    el._runningMacro = id;
    const btn = el.querySelector(`.pn-macro-btn[data-macro="${id}"]`);
    if (btn) btn.classList.add('running');
    updateQueuedBadges(el);
    el._runningTimer = schedAudio(() => {
        const b = el.querySelector(`.pn-macro-btn[data-macro="${id}"]`);
        if (b) b.classList.remove('running');
        el._runningMacro = null;
        el._runningTimer = null;
        const next = (el._macroQueue || []).shift();
        if (next !== undefined) {
            updateQueuedBadges(el);
            if (typeof next === 'string') executeMacro(el, next);
            else executeMacro(el, next.id, next.opts);
        } else {
            el.querySelectorAll('.pn-macro-btn.queued').forEach(b => b.classList.remove('queued'));
            el.querySelectorAll('.pn-macro-queue-badge').forEach(b => b.remove());
        }
    }, Math.max(100, durationMs + 40));
}

export function updateQueuedBadges(el) {
    const counts = new Map();
    for (const entry of (el._macroQueue || [])) {
        const qid = typeof entry === 'string' ? entry : entry.id;
        counts.set(qid, (counts.get(qid) || 0) + 1);
    }
    for (const btn of el.querySelectorAll('.pn-macro-btn')) {
        const qid = btn.dataset.macro;
        const count = counts.get(qid) || 0;
        btn.classList.toggle('queued', count > 0);
        let badge = btn.querySelector('.pn-macro-queue-badge');
        if (count > 0) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'pn-macro-queue-badge';
                btn.appendChild(badge);
            }
            badge.textContent = count > 1 ? `+${count}` : '•';
        } else if (badge) {
            badge.remove();
        }
    }
}
