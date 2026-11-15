// Scheduling helpers for macros: setTimeout / clearTimeout with a token
// shape, plus a requestAnimationFrame animation loop.
//
// These used to ride Tone.Transport so macro restores fired on the audio
// clock (and under Tone.Offline). Tone is gone; the djrust engine runs
// macros natively in its runner (`WaveRunner::fire_macro`), which is where
// audio-clock timing comes back once macros are routed to it (rebuild
// item, docs/MIGRATION-djrust-wasm.md §12). Until then these are
// wall-clock timers, which is what the studio had before the Transport
// change; there is no offline macro render path any more.

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

// There is no offline (OfflineAudioContext) macro render any more.
export function isOfflineContext() { return false; }

// Drive an animation by stepping `applyAt(elapsedMs)` repeatedly until
// `durationMs` elapses. Picks the right clock for the current context:
//
//   - Live (real-time AudioContext): requestAnimationFrame at native
//     frame rate. Visual sliders look smooth, engine dispatches happen
//     whenever applyAt's own throttle says so.
//   - Offline (an OfflineAudioContext render; none exists since Tone left):
//     pre-schedules dispatches at `dispatchIntervalMs` via schedAudio,
//     because rAF doesn't fire during offline rendering. The animation
//     still happens — at audio-time intervals matching the live throttle.
//
// `applyAt` may be called many times per visual frame in live mode and
// must be safe to call with the same `elapsedMs` more than once.
// Returns a cancel function.
export function audioAnimLoop(durationMs, dispatchIntervalMs, applyAt, onCancel) {
    let cancelled = false;
    if (isOfflineContext()) {
        const tokens = [];
        // Schedule applyAt at every dispatch interval AND once at the
        // final durationMs so the "done" branch fires.
        for (let elapsed = 0; elapsed < durationMs; elapsed += dispatchIntervalMs) {
            const e = elapsed;
            tokens.push(schedAudio(() => { if (!cancelled) applyAt(e); }, e));
        }
        tokens.push(schedAudio(() => {
            if (!cancelled) applyAt(durationMs);
        }, durationMs));
        return () => {
            cancelled = true;
            for (const t of tokens) clearAudioSched(t);
            if (onCancel) onCancel();
        };
    } else {
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
}
