// Scheduling helpers for the macros the studio animates itself (FX sweeps and holds, Feel,
// the Beats pads' re-mute), read like setTimeout / clearTimeout.
//
// These ran on Tone.Transport while Tone made the sound, so an offline Tone render kept its
// macro restores on the audio clock. djrust renders offline with no page in the loop and runs
// its own macros (song mutes, beat repeat, pan / decay / tempo moves) on its bar clock, so what
// is left here is the studio's live animation, for which the wall clock is the right one.

/** Run `fn` `delayMs` from now. Returns a token for clearAudioSched. */
export function schedAudio(fn, delayMs) {
    return { kind: 'wall', id: setTimeout(fn, Math.max(0, delayMs)) };
}

export function clearAudioSched(token) {
    if (token?.kind === 'wall') clearTimeout(token.id);
}

/** Nothing is queued but in each token; kept for its callers (stop, panic). */
export function clearAllAudioSched() {}

/** There is no offline Tone render any more: the animation is always the live one. */
export function isOfflineContext() {
    return false;
}

/**
 * Drive `applyAt(elapsedMs)` every animation frame for `durationMs` (and once at the end).
 * Returns a cancel function.
 */
export function audioAnimLoop(durationMs, dispatchIntervalMs, applyAt, onCancel) {
    let cancelled = false;
    const t0 = performance.now();
    const step = (now) => {
        if (cancelled) return;
        const elapsed = now - t0;
        if (elapsed >= durationMs) {
            applyAt(durationMs);
            return;
        }
        applyAt(elapsed);
        requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    return () => { cancelled = true; if (onCancel) onCancel(); };
}
