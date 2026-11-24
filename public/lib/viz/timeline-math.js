// Geometry of the scrolling lane view (the rolling note dots), as pure
// functions so the direction of time and the side of the trail are tested
// (scripts/test-timeline-math.mjs) instead of read off a canvas.
//
// Time flows right → left: "now" (the playhead) is the right edge x = w, a
// note appears there when it sounds and scrolls toward x = 0 as it ages.
// A trail lives BEHIND its dot, i.e. on the side the dot came from: opposite
// to the motion, so toward the playhead (larger x), fading away from the dot.

export const FLOW = -1;      // dx per unit of age: dots move toward -x
export const TRAIL_PX = 20;  // max streak length
export const FADE_START = 0.85;

// Seconds of history across the lane: one bar at the current tempo, never
// under 2 s (tempo clamped ≥ 60). This is what the legacy adaptive window
// settles at; its comment says "4 bars = 8 s" but 240/bpm is one bar, so a
// dot crosses the lane in ~2 s at 120 bpm and above.
export function windowSec(tempo) {
    const t = Number.isFinite(tempo) ? Math.max(60, tempo) : 120;
    return Math.max(2, 240 / t);
}

// x of a dot `age` seconds after it sounded. age 0 → playhead (w).
export function dotX(age, win, w) {
    return w + FLOW * (age / win) * w;
}

// Streak rectangle behind a dot at x: it starts at the dot and extends
// against the motion. grad0 is the dot end (opaque), grad1 the far end.
export function trailSpan(x, len) {
    const far = x - FLOW * len; // FLOW is -1 → x + len
    return { x0: Math.min(x, far), x1: Math.max(x, far), dotEnd: x, farEnd: far };
}

export function alphaAt(age, win) {
    const pct = age / win;
    return pct < FADE_START ? 0.7 : 0.7 * (1 - (pct - FADE_START) / (1 - FADE_START));
}

// events: [{ t: seconds when it sounds, ... }]; nowSec on the same clock.
// Returns visible dots in event order. Events not yet sounding (t > now,
// lookahead) are held back instead of drawn past the playhead.
export function layoutDots(events, nowSec, win, w) {
    const out = [];
    if (!(win > 0) || !Number.isFinite(nowSec)) return out;
    const streak = Math.min(TRAIL_PX, (w / win) / 1000 * 120);
    for (const evt of events) {
        const age = nowSec - evt.t;
        if (!(age >= 0) || age > win) continue;
        const x = dotX(age, win, w);
        if (!Number.isFinite(x)) continue;
        out.push({ evt, age, x, alpha: alphaAt(age, win), trail: trailSpan(x, streak) });
    }
    return out;
}
