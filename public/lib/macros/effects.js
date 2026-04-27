// Macro effects pipeline — animation primitives used by every FX-style
// macro (sweep / hold / beat-repeat / compound / tempo). Each function
// takes the element (`el`) and drives the FX sliders + tempo through
// requestAnimationFrame loops, throttling engine dispatch so the worker
// isn't flooded.
//
// Extracted from petri-note.js (Phase A.7). Relies on class helpers for
// DOM queries (`el._fxSlider`, `el._setFxValue`), worker send
// (`el._sendWs`), and musical state (`el._musicNets`, `el._mutedNets`,
// `el._msPerBar`, `el._tempo`, `el._setTempo`).

import { MACROS } from './catalog.js';
import { schedAudio, clearAudioSched } from './sched.js';

export function fxSweep(el, fxKey, toValue, durationMs) {
    const slider = el._fxSlider(fxKey);
    if (!slider) return;
    // Reuse the PRIOR animation's start value so a macro re-firing its
    // own fxKey while already in flight doesn't capture the swept-up
    // value (e.g. reverb-wet at 80) as the new equilibrium, stranding it
    // there. Only the first fire of a given fxKey seeds start from the
    // current slider.
    const prev = el._fxAnim?.[fxKey];
    const start = (prev && !prev.cancelled && typeof prev.start === 'number')
        ? prev.start
        : parseFloat(slider.value);
    if (prev) prev.cancelled = true;
    el._fxAnim = el._fxAnim || {};
    const token = { cancelled: false, fxKey, slider, start };
    el._fxAnim[fxKey] = token;
    const t0 = performance.now();
    const rampDown = durationMs * 0.8;
    const DISPATCH_INTERVAL = 120;
    let lastDispatch = -DISPATCH_INTERVAL;

    const step = (now) => {
        if (token.cancelled) return;
        const elapsed = now - t0;
        let v;
        let done = false;
        if (elapsed < rampDown) {
            v = start + (toValue - start) * (elapsed / rampDown);
        } else if (elapsed < durationMs) {
            v = toValue + (start - toValue) * ((elapsed - rampDown) / (durationMs - rampDown));
        } else {
            v = start;
            done = true;
        }
        const dispatch = done || (now - lastDispatch >= DISPATCH_INTERVAL);
        if (dispatch) {
            el._setFxValue(slider, v);
            lastDispatch = now;
        } else {
            // Visual-only update — no input event, no engine dispatch
            slider.value = Math.round(v);
        }
        if (done) { el._fxAnim[fxKey] = null; return; }
        requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

// Beat Repeat: fire short Cut-like bursts every `stepTicks` for the full duration.
export function runBeatRepeat(el, macro, durationMs) {
    const msPerTick = el._msPerBar() / 16;
    const stepMs = (macro.stepTicks || 2) * msPerTick;
    const burstTicks = macro.burstTicks || 1;
    el._beatRepeatRuns = (el._beatRepeatRuns || 0) + 1;
    const myRun = el._beatRepeatRuns;
    let elapsed = 0;
    const fire = () => {
        if (myRun !== el._beatRepeatRuns) return;   // cancelled
        if (elapsed >= durationMs) return;
        const targets = [];
        for (const [id, net] of el._musicNets()) {
            // Keep kick alive so there's still a pulse under the stutter
            if (net.riffGroup === 'kick' || id === 'kick' || id.startsWith('kick:')) continue;
            if (el._mutedNets.has(id)) continue;
            targets.push(id);
        }
        if (targets.length > 0) {
            el._sendWs({
                type: 'fire-macro',
                macroId: `beat-repeat-${Date.now().toString(36)}-${elapsed}`,
                targets,
                durationTicks: burstTicks,
                muteAction: 'mute-track',
                restoreAction: 'unmute-track',
            });
        }
        elapsed += stepMs;
        if (elapsed < durationMs) schedAudio(fire, stepMs);
    };
    fire();
}

// Compound: fire a sequence of sub-macros by ID at timed offsets. Bypasses
// the queue because the parent macro already owns the single running slot.
export function runCompound(el, macro, duration, durationUnit, msPerTick) {
    // Track every pending sub-macro timer so Panic can clear them all.
    el._compoundTimers = el._compoundTimers || [];
    for (const step of macro.steps || []) {
        const delay = step.offsetMs || 0;
        const t = schedAudio(() => {
            const sub = MACROS.find(m => m.id === step.macroId);
            if (!sub) return;
            // Push the sub-macro directly (ignore queue, don't mark as running)
            if (sub.kind === 'mute') {
                const targets = sub.targets(el);
                if (targets.length === 0) return;
                const durationTicks = step.durationTicks
                    || (sub.durationUnit === 'tick' ? sub.defaultDuration : sub.defaultDuration * 16);
                el._sendWs({
                    type: 'fire-macro',
                    macroId: `${sub.id}-${Date.now().toString(36)}`,
                    targets,
                    durationTicks,
                    muteAction: 'mute-track',
                    restoreAction: 'unmute-track',
                });
            } else if (sub.kind === 'fx-sweep' || sub.kind === 'fx-hold') {
                const subMs = (step.durationTicks || sub.defaultDuration *
                               (sub.durationUnit === 'tick' ? 1 : 16)) * msPerTick;
                const ops = sub.ops || [{ fxKey: sub.fxKey, toValue: sub.toValue }];
                for (const op of ops) {
                    if (sub.kind === 'fx-sweep') fxSweep(el, op.fxKey, op.toValue, subMs);
                    else                         fxHold (el, op.fxKey, op.toValue, subMs);
                }
            }
        }, delay);
        el._compoundTimers.push(t);
    }
}

// Transient tempo set used during animations — skips localStorage/syncProject
// to keep a 60fps ramp cheap. Final resting value must use el._setTempo so
// the project JSON and storage stay consistent.
export function setTempoTransient(el, bpm) {
    const clamped = Math.max(20, Math.min(300, Math.round(bpm)));
    if (el._tempo === clamped) return;
    el._tempo = clamped;
    if (el._project) el._project.tempo = clamped;
    const input = el.querySelector('.pn-tempo input');
    if (input) input.value = clamped;
    el._sendWs({ type: 'tempo', bpm: clamped });
}

// Tempo Hold: multiply tempo by factor, hold for duration, restore.
export function tempoHold(el, factor, durationMs) {
    const startBpm = el._tempo || 120;
    const targetBpm = Math.max(20, Math.round(startBpm * factor));
    // Cancel any prior tempo-hold so Panic and stacked fires have a
    // single token to reset. _tempoAnim is also used by tempoSweep.
    if (el._tempoAnim) {
        el._tempoAnim.cancelled = true;
        if (el._tempoAnim.timeout) clearAudioSched(el._tempoAnim.timeout);
    }
    const token = { cancelled: false, startBpm };
    el._tempoAnim = token;
    el._setTempo(targetBpm);
    token.timeout = schedAudio(() => {
        if (token.cancelled) return;
        el._setTempo(startBpm);
        if (el._tempoAnim === token) el._tempoAnim = null;
    }, durationMs);
}

// Tempo Anchor: snap tempo back to the current genre's standard BPM
// for the duration, then restore the pre-fire tempo on release. Useful
// when the puck or a sweep has drifted you off-grid and you want to
// "land" briefly without committing to it.
export function tempoAnchor(el, durationMs) {
    const startBpm = el._tempo || 120;
    const genre = el.querySelector('.pn-genre-select')?.value;
    const targetBpm = el._genreData?.[genre]?.bpm || 120;
    if (el._tempoAnim) {
        el._tempoAnim.cancelled = true;
        if (el._tempoAnim.timeout) clearAudioSched(el._tempoAnim.timeout);
    }
    const token = { cancelled: false, startBpm };
    el._tempoAnim = token;
    el._setTempo(targetBpm);
    token.timeout = schedAudio(() => {
        if (token.cancelled) return;
        el._setTempo(startBpm);
        if (el._tempoAnim === token) el._tempoAnim = null;
    }, durationMs);
}

// Tape Stop: ease-out ramp down to finalBpm, then snap back.
//
// Each tempo message makes the worker restartTimer() (clears + resets
// setInterval), so dispatching every rAF frame (~60 Hz) thrashes the tick
// scheduler and can drop ticks. Throttle to ~12 Hz (80 ms) — still plenty
// smooth for a tape-stop gesture, and 5× kinder to the worker.
export function tempoSweep(el, finalBpm, durationMs) {
    const startBpm = el._tempo || 120;
    const target = Math.max(20, finalBpm);
    const t0 = performance.now();
    const DISPATCH_INTERVAL = 80;
    let lastDispatch = -DISPATCH_INTERVAL;
    if (el._tempoAnim) {
        el._tempoAnim.cancelled = true;
        if (el._tempoAnim.timeout) clearAudioSched(el._tempoAnim.timeout);
    }
    const token = { cancelled: false, startBpm };
    el._tempoAnim = token;
    const step = (now) => {
        if (token.cancelled) return;
        const elapsed = now - t0;
        if (elapsed >= durationMs) {
            el._setTempo(startBpm);   // authoritative final set (also writes localStorage)
            el._tempoAnim = null;
            return;
        }
        if (now - lastDispatch >= DISPATCH_INTERVAL) {
            const t = Math.min(1, elapsed / durationMs);
            const eased = 1 - Math.pow(1 - t, 2);
            const bpm = startBpm + (target - startBpm) * eased;
            setTempoTransient(el, bpm);
            lastDispatch = now;
        }
        requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

// fx-hold: jump to toValue, hold, then gradually fade back over the tail.
// `tailFrac` controls what portion of the duration is release (default 0.6
// gives a ringing tail after the initial peak).
//
// Visual slider updates every rAF but audio-engine dispatch is throttled to
// ~120 ms so rapid cancelScheduledValues + rampTo(0.1) collisions don't
// turn the release into a flat / oscillating no-op on the actual filter.
export function fxHold(el, fxKey, toValue, durationMs, tailFrac = 0.6) {
    const slider = el._fxSlider(fxKey);
    if (!slider) return;
    // Same re-entrancy guard as fxSweep — inherit the prior token's
    // `start` so stacked fires don't capture the peak value.
    const prev = el._fxAnim?.[fxKey];
    const start = (prev && !prev.cancelled && typeof prev.start === 'number')
        ? prev.start
        : parseFloat(slider.value);
    if (prev) prev.cancelled = true;
    el._fxAnim = el._fxAnim || {};
    const token = { cancelled: false, fxKey, slider, start };
    el._fxAnim[fxKey] = token;
    const tailMs = Math.max(50, durationMs * tailFrac);
    const sustainMs = Math.max(0, durationMs - tailMs);

    el._setFxValue(slider, toValue);

    const t0 = performance.now();
    const beginRelease = t0 + sustainMs;
    const endRelease   = t0 + durationMs;
    const DISPATCH_INTERVAL = 120;
    let lastDispatch = t0;   // the initial setFxValue counts as a dispatch

    const step = (now) => {
        if (token.cancelled) return;
        if (now < beginRelease) {
            requestAnimationFrame(step);
            return;
        }
        if (now >= endRelease) {
            el._setFxValue(slider, start);
            el._fxAnim[fxKey] = null;
            return;
        }
        const t = (now - beginRelease) / tailMs;
        const v = toValue + (start - toValue) * t;
        if (now - lastDispatch >= DISPATCH_INTERVAL) {
            el._setFxValue(slider, v);
            lastDispatch = now;
        } else {
            slider.value = Math.round(v);   // visual-only
        }
        requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

export function cancelAllMacros(el) {
    el._sendWs({ type: 'cancel-macros' });
    if (el._runningTimer) {
        clearAudioSched(el._runningTimer);
        el._runningTimer = null;
    }
    el._runningMacro = null;
    el._macroQueue = [];
    el.querySelectorAll?.('.pn-macro-btn.running, .pn-macro-btn.queued').forEach(b => {
        b.classList.remove('running');
        b.classList.remove('queued');
    });
    el.querySelectorAll?.('.pn-macro-queue-badge').forEach(b => b.remove());
    if (el._fxAnim) {
        for (const token of Object.values(el._fxAnim)) if (token) token.cancelled = true;
        el._fxAnim = {};
    }
}
