// Scheduling helpers for macros: setTimeout / clearTimeout with a token
// shape, plus a requestAnimationFrame animation loop.
//
// These used to ride Tone.Transport so macro restores fired on the audio
// clock (and under Tone.Offline). Tone is gone; the djrust engine runs
// timed macros on its own clock (djwasm 0.3.0+, lib/macros/runtime.js
// executeMacro), so what is left here is page bookkeeping on wall-clock
// timers: UI pulses, stinger windows, the page-side animations.

const pending = new Set();

// Schedule `fn` to fire `delayMs` from now. Returns a token for clearAudioSched.
export function schedAudio(fn, delayMs) {
    const token = { kind: 'wall', id: 0 };
    token.id = setTimeout(() => { pending.delete(token); fn(); }, Math.max(0, delayMs));
    pending.add(token);
    return token;
}

// Cancel a scheduled callback. No-op if token is null/undefined.
export function clearAudioSched(token) {
    if (!token) return;
    clearTimeout(token.id);
    pending.delete(token);
}

// Clear every scheduled event (panic / stop).
export function clearAllAudioSched() {
    for (const t of pending) clearTimeout(t.id);
    pending.clear();
}

// Kept for its importers (lib/ui/controllers.js): there is no page-side
// offline macro render. Offline renders run macros in the engine itself
// (control nets with controlMacros on; lib/share/offline-render.js).
export function isOfflineContext() { return false; }

// Drive an animation by stepping `applyAt(elapsedMs)` on
// requestAnimationFrame until `durationMs` elapses (then once more with
// durationMs, so the "done" branch runs). `applyAt` may be called many
// times per visual frame and must be safe to call with the same
// `elapsedMs` more than once; throttling engine dispatches is its job
// (`dispatchIntervalMs` documents its interval). Returns a cancel function.
export function audioAnimLoop(durationMs, dispatchIntervalMs, applyAt, onCancel) {
    let cancelled = false;
    const t0 = performance.now();
    const tick = (now) => {
        if (cancelled) return;
        const elapsed = now - t0;
        if (elapsed >= durationMs) {
            applyAt(durationMs);
            return;
        }
        applyAt(elapsed);
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => { cancelled = true; if (onCancel) onCancel(); };
}
