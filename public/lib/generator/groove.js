// Cohesion v2 — GrooveLock derives the bass hit-mask from the kick hit-mask.
// Mirror of internal/generator/groove.go. See theme.js for the JS port
// status — composer.js doesn't yet consume these primitives; the authoring
// server's Go composer is the path that honors `params.cohesion === "v2"`.

import { Groove } from './theme.js';

// grooveLock returns a bass hit-mask the same length as kickMask, with hits
// placed according to the template. Pure function except for Breakbeat,
// which intentionally uses the supplied rng so the bass can be independent
// of the kick.
//
// kickMask is an array of booleans (true = hit).
export function grooveLock(kickMask, template, rng) {
    const n = kickMask.length;
    const out = new Array(n).fill(false);

    switch (template) {
        case Groove.FourOnFloor:
            for (let i = 0; i < n; i++) out[i] = kickMask[i];
            break;

        case Groove.Offbeat:
            for (let i = 0; i < n; i++) {
                if (kickMask[i]) {
                    const prev = ((i - 1) % n + n) % n;
                    out[prev] = true;
                }
            }
            break;

        case Groove.Sidechained:
            for (let i = 0; i < n; i++) out[i] = !kickMask[i];
            break;

        case Groove.SyncoPocket: {
            for (let i = 0; i < n; i++) out[i] = kickMask[i];
            let off1 = 6, off2 = 14;
            if (n === 8) { off1 = 3; off2 = 7; }
            if (off1 < n) out[off1] = true;
            if (off2 < n) out[off2] = true;
            break;
        }

        case Groove.Breakbeat: {
            let hits = Math.floor(n * 3 / 8);
            if (hits < 1) hits = 1;
            const rot = (typeof rng === 'function') ? Math.floor(rng() * n) : 0;
            for (let i = 0; i < hits; i++) {
                const pos = (Math.floor(i * n / hits) + rot) % n;
                out[pos] = true;
            }
            break;
        }

        default:
            for (let i = 0; i < n; i++) out[i] = kickMask[i];
            break;
    }
    return out;
}

// kickHitMaskFromGenre is retained for the groove module's call surface
// but delegates to the shared kickHitMask in theme.js (which uses the
// canonical bjorklund from euclidean.js) — keeps the rhythm-derivation
// algorithm in one place.
export { kickHitMask as kickHitMaskFromGenre } from './theme.js';
