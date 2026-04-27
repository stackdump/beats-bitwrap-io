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

// True when Tone is rendering into an OfflineAudioContext (i.e. inside
// a Tone.Offline() call). In offline mode requestAnimationFrame doesn't
// fire, so any rAF-driven macro animation must instead pre-schedule its
// dispatches against the audio clock via schedAudio.
//
// We sniff by name rather than instanceof so we don't need to import
// the OfflineAudioContext constructor (it's a browser global — and the
// goal is for this same code to also run under node-web-audio-api,
// where the class name is the same but the constructor lives elsewhere).
export function isOfflineContext() {
    if (typeof Tone === 'undefined' || !Tone.context) return false;
    const raw = Tone.context.rawContext || Tone.context;
    const name = raw?.constructor?.name || '';
    return name === 'OfflineAudioContext';
}

// Drive an animation by stepping `applyAt(elapsedMs)` repeatedly until
// `durationMs` elapses. Picks the right clock for the current context:
//
//   - Live (real-time AudioContext): requestAnimationFrame at native
//     frame rate. Visual sliders look smooth, engine dispatches happen
//     whenever applyAt's own throttle says so.
//   - Offline (OfflineAudioContext during Tone.Offline render):
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
