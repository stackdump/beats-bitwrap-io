// Audio-time scheduling helpers for macros. Wraps Tone.Transport so
// callsites read like setTimeout/clearTimeout but fire on the audio
// clock instead of the wall clock.
//
// Why this matters: setTimeout fires in wall-clock ms, decoupled from
// what the audio engine is actually doing. That's fine in the studio
// where audio IS realtime, but it breaks under Tone.Offline (the
// OfflineAudioContext renders faster than realtime; a 60-second track
// finishes in ~5 wall-clock seconds, so any setTimeout-scheduled macro
// restore fires *long after* the render has already finished). Audio-
// time scheduling fixes that by riding the same clock that drives the
// synthesizers — restores fire at the right beat regardless of how
// fast or slow the host context is rendering.
//
// Bonus, even in the studio: Tone.Transport callbacks are scheduled
// against the audio context's lookahead, so they're ±0 samples instead
// of ±10ms-ish jittered by the JS event loop.
//
// Behavior change worth knowing about: if a macro is fired while the
// transport is *stopped* (user clicked a macro tile but hasn't pressed
// play), the restore callback waits until the transport resumes. With
// the old setTimeout it would have fired in wall-clock time regardless.
// We accept this — musically, "this macro lasts 4 bars" should mean
// 4 bars of music, not 4 seconds of clock. If you panic, panicMacros()
// clears all scheduled events anyway.

// Schedule `fn` to fire `delayMs` from now in audio time. Returns a
// transport id; pass to clearAudioSched to cancel.
export function schedAudio(fn, delayMs) {
    if (typeof Tone === 'undefined' || !Tone.Transport) {
        // Fall back to setTimeout if Tone hasn't loaded — keeps the
        // studio responsive in the rare boot-time race. Returns the
        // setTimeout id under a sentinel so clearAudioSched can route
        // back to clearTimeout.
        return { kind: 'wall', id: setTimeout(fn, delayMs) };
    }
    const seconds = Math.max(0, delayMs) / 1000;
    // "+N" syntax = N seconds from transport.now(). Tone parses this
    // string as a relative offset.
    const id = Tone.Transport.scheduleOnce(() => fn(), `+${seconds}`);
    return { kind: 'audio', id };
}

// Cancel a scheduled callback. No-op if token is null/undefined.
export function clearAudioSched(token) {
    if (!token) return;
    if (token.kind === 'wall') {
        clearTimeout(token.id);
    } else if (token.kind === 'audio') {
        if (typeof Tone !== 'undefined' && Tone.Transport) {
            Tone.Transport.clear(token.id);
        }
    }
}

// Clear every scheduled audio-time event. Used by panic to nuke any
// in-flight macro restores in one call (cheaper + safer than tracking
// every individual token if you've already lost references).
export function clearAllAudioSched() {
    if (typeof Tone !== 'undefined' && Tone.Transport) {
        // cancel(0) clears events scheduled for transport.seconds >= 0,
        // which is everything. Doesn't stop the transport itself.
        Tone.Transport.cancel(0);
    }
}
