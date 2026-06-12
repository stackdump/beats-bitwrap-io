// Cohesion v2 — TrackTheme is the track-wide musical state that ties a
// generated track's sections together. JS port of
// internal/generator/theme.go. Both ports MUST produce byte-identical
// output for the same (seed, genre); the pinned-motif parity test
// (internal/generator/theme_parity_test.go + theme.parity.test.html) is
// the contract that catches drift.
//
// Algorithm contract:
//   1. State init: `((seed >>> 0) ^ hashStr("theme/"+genre)) | 0` → createRng.
//   2. All RNG draws via rng.nextInt(n) — Go uses mulberry32Intn with the
//      same algorithm, so the integer streams agree bit-for-bit.
//   3. SectionProfile tables (energy, role profiles, motif modes) are
//      hand-copied identical values, not derived.
//
// composer.js consumes these primitives when `params.cohesion === "v2"`.

import { createRng } from './core.js';
import { NetBundle } from '../pflow.js';
import { ringLayout, bjorklund } from './euclidean.js';
import { clampVelocity } from './core.js';
import { GenreTheories } from './theory.js';
import { archetypeFor } from './arrange.js';

// MotifMode — the grammar of motif recall. Small enumerated palette.
// Values mirror the Go iota order so cross-side serialization stays
// sortable.
export const MotifMode = Object.freeze({
    Ignore:     0,
    Play:       1,
    Transposed: 2,
    Fragment:   3,
    Augmented:  4,
    Inverted:   5,
    Layered:    6,
});

// chordAt returns the chord sounding at the given step of a ChordPlan.
export function chordAt(plan, step) {
    if (!plan.chords || plan.chords.length === 0) {
        return { root: 0, tones: [0, 2, 4] };
    }
    const idx = Math.floor(step / plan.stepsPerChord) % plan.chords.length;
    return plan.chords[idx];
}

// cycleSteps is the full harmonic cycle length in steps.
export function cycleSteps(plan) {
    return (plan.chords ? plan.chords.length : 0) * plan.stepsPerChord;
}

// BuildTrackTheme derives the track-wide theme from (genreName, seed).
// Pure function of its inputs — same inputs → same output, JS↔Go.
export function buildTrackTheme(genreName, seed) {
    const initialSeed = (((seed >>> 0) ^ hashStr('theme/' + genreName)) | 0);
    const rng = createRng(initialSeed);

    // Draw #1: pick the chord progression — MUST be the first draw to
    // stay aligned with Go's BuildTrackTheme stream.
    const theory = GenreTheories[genreName];
    const plan = { stepsPerChord: 16, chords: [] };
    if (theory && theory.chordProgs && theory.chordProgs.length > 0) {
        const prog = theory.chordProgs[rng.nextInt(theory.chordProgs.length)];
        plan.chords = prog.chords.map(c => ({ root: c.root, tones: c.tones.slice() }));
    } else {
        rng.nextInt(1); // burn the draw to keep the stream aligned
        plan.chords = [
            { root: 0, tones: [0, 2, 4] },
            { root: 5, tones: [5, 0, 2] },
            { root: 3, tones: [3, 5, 0] },
            { root: 6, tones: [6, 1, 3] },
        ];
    }

    const scaleLen = 7;
    const motif = generateMotif(rng, scaleLen, plan);

    const harmonic = {
        intro: 0, verse: 0, buildup: 0, drop: 0, breakdown: 0,
        bridge: 5, chorus: 0, outro: 0, solo: 4,
    };
    const groove = defaultGrooveFor(genreName);
    const energy = energyProfilesFor(familyFor(genreName), genreName);
    return { motif, plan, harmonic, groove, energy };
}

// cohesionGenreSupported gates v2 on the supported genre list. Adding a
// genre requires the corresponding family's role-profile table to exist
// below — without that, MotifMode defaults to Ignore everywhere and
// melody slots fall back to Markov, which defeats the recall mechanism.
export function cohesionGenreSupported(name) {
    // Supported when the genre has a chord progression to drive the
    // harmonic engine. Role coverage is guaranteed for every family
    // (explicit EDM/Song tables, synthesized jazz/chill), so any genre
    // with chords gets full v2. Mirrors theme.go::cohesionGenreSupported.
    const t = GenreTheories[name];
    return !!(t && t.chordProgs && t.chordProgs.length > 0);
}

// RenderMotif applies a MotifMode + harmonic offset to a MotifCell. Pure
// function. Mirrors theme.go::RenderMotif.
export function renderMotif(cell, mode, harmonicOffset = 0) {
    switch (mode) {
        case MotifMode.Ignore:
            return { degrees: [], mask: [], contour: 0 };
        case MotifMode.Play:
        case MotifMode.Layered:
        case MotifMode.Transposed: {
            const out = cloneCell(cell);
            if (mode === MotifMode.Transposed || harmonicOffset !== 0) {
                for (let i = 0; i < out.degrees.length; i++) {
                    if (out.degrees[i] >= 0) out.degrees[i] = clampDegree(out.degrees[i] + harmonicOffset);
                }
            }
            return out;
        }
        case MotifMode.Fragment: {
            const out = cloneCell(cell);
            const half = (out.degrees.length / 2) | 0;
            for (let i = half; i < out.degrees.length; i++) {
                out.degrees[i] = -1;
                out.mask[i] = false;
            }
            return out;
        }
        case MotifMode.Augmented: {
            const dl = cell.degrees.length * 2;
            const out = {
                degrees: new Array(dl),
                mask:    new Array(dl),
                contour: cell.contour,
            };
            for (let i = 0; i < cell.degrees.length; i++) {
                out.degrees[i*2]   = cell.degrees[i];
                out.mask[i*2]      = cell.mask[i];
                out.degrees[i*2+1] = -1;
                out.mask[i*2+1]    = false;
            }
            return out;
        }
        case MotifMode.Inverted: {
            const out = cloneCell(cell);
            const scaleLen = 7;
            for (let i = 0; i < out.degrees.length; i++) {
                if (out.degrees[i] >= 0) {
                    out.degrees[i] = clampDegree((scaleLen - 1) - out.degrees[i] + harmonicOffset);
                }
            }
            out.contour = -cell.contour;
            return out;
        }
        default:
            return cloneCell(cell);
    }
}

// degreeToMidi maps a scale-degree index to a MIDI note via the scale
// array, wrapping by octave for degrees beyond the diatonic-octave.
export function degreeToMidi(degree, scale) {
    if (!scale || scale.length === 0) return 60;
    if (degree < 0) return 0;
    if (degree < scale.length) return scale[degree];
    const octaves = (degree / scale.length) | 0;
    const idx = degree % scale.length;
    return scale[idx] + 12 * octaves;
}

// motifNet builds a Petri-net ring from a rendered MotifCell. Mirrors
// theme.go::MotifNet. Transitions at unmasked positions carry a MIDI
// binding at the scale-degree pitch.
export function motifNet(cell, scale, params) {
    let degrees = cell.degrees, mask = cell.mask;
    let n = degrees.length;
    if (n === 0) {
        n = 16;
        degrees = new Array(n).fill(-1);
        mask = new Array(n).fill(false);
    }
    const nb = new NetBundle();
    const { cx, cy, radius } = ringLayout(n);

    for (let i = 0; i < n; i++) {
        const initial = i === 0 ? [1] : [0];
        const angle = (i / n) * 2 * Math.PI;
        nb.places[`p${i}`] = {
            initial,
            x: cx + radius * 0.7 * Math.cos(angle),
            y: cy + radius * 0.7 * Math.sin(angle),
        };
    }
    for (let i = 0; i < n; i++) {
        const tAngle = ((i + 0.5) / n) * 2 * Math.PI;
        nb.transitions[`t${i}`] = {
            x: cx + radius * Math.cos(tAngle),
            y: cy + radius * Math.sin(tAngle),
        };
        nb.arcs.push({ source: `p${i}`, target: `t${i}`, weight: [1], inhibit: false });
        nb.arcs.push({ source: `t${i}`, target: `p${(i + 1) % n}`, weight: [1], inhibit: false });

        if (mask[i] && degrees[i] >= 0) {
            const note = degreeToMidi(degrees[i], scale);
            nb.bindings[`t${i}`] = {
                note,
                channel:  params.channel,
                velocity: clampVelocity(params.velocity),
                duration: params.duration,
            };
        }
    }
    nb.track = {
        channel: params.channel,
        defaultVelocity: params.velocity,
        instrument: '',
        instrumentSet: [],
        generator: 'motif',
        ringSize: n,
        beats: mask.filter(Boolean).length,
        generatorParams: {
            duration: params.duration,
            seed: params.seed || 0,
        },
    };
    nb.buildArcIndex();
    nb.resetState();
    return nb;
}

// maskedRing builds a Euclidean-style ring where every step plays note iff
// mask[i] is true. Mirrors theme.go::MaskedRing — used by the v2 bass path
// where the rhythm is grooveLock(kickMask) rather than a Bjorklund draw.
export function maskedRing(mask, note, params) {
    let m = mask;
    let n = m.length;
    if (n === 0) { n = 16; m = new Array(n).fill(false); }

    const nb = new NetBundle();
    const { cx, cy, radius } = ringLayout(n);
    for (let i = 0; i < n; i++) {
        const initial = i === 0 ? [1] : [0];
        const angle = (i / n) * 2 * Math.PI;
        nb.places[`p${i}`] = {
            initial,
            x: cx + radius * 0.7 * Math.cos(angle),
            y: cy + radius * 0.7 * Math.sin(angle),
        };
    }
    for (let i = 0; i < n; i++) {
        const tAngle = ((i + 0.5) / n) * 2 * Math.PI;
        nb.transitions[`t${i}`] = {
            x: cx + radius * Math.cos(tAngle),
            y: cy + radius * Math.sin(tAngle),
        };
        nb.arcs.push({ source: `p${i}`, target: `t${i}`, weight: [1], inhibit: false });
        nb.arcs.push({ source: `t${i}`, target: `p${(i + 1) % n}`, weight: [1], inhibit: false });
        if (m[i]) {
            nb.bindings[`t${i}`] = {
                note,
                channel:  params.channel,
                velocity: clampVelocity(params.velocity),
                duration: params.duration,
            };
        }
    }
    nb.track = {
        channel: params.channel,
        defaultVelocity: params.velocity,
        instrument: '',
        instrumentSet: [],
        generator: 'masked-ring',
        ringSize: n,
        beats: m.filter(Boolean).length,
        generatorParams: {
            duration: params.duration,
            seed: params.seed || 0,
        },
    };
    nb.buildArcIndex();
    nb.resetState();
    return nb;
}

// notedRing — like maskedRing but with per-step pitch. Mirrors
// theme.go::NotedRing. Used by the chord-walking bass.
export function notedRing(notes, mask, params) {
    return notedRingDur(notes, mask, null, params);
}

// notedRingDur — notedRing with an optional per-step duration override: when
// durs is non-null and durs[i] > 0, step i rings for durs[i] ms instead of
// params.duration. Passing null durs reproduces notedRing byte-for-byte.
// Mirrors theme.go::notedRingDur.
export function notedRingDur(notes, mask, durs, params) {
    let m = mask, nt = notes;
    let n = m.length;
    if (n === 0) { n = 16; m = new Array(n).fill(false); nt = new Array(n).fill(0); }

    const nb = new NetBundle();
    const { cx, cy, radius } = ringLayout(n);
    for (let i = 0; i < n; i++) {
        const initial = i === 0 ? [1] : [0];
        const angle = (i / n) * 2 * Math.PI;
        nb.places[`p${i}`] = {
            initial,
            x: cx + radius * 0.7 * Math.cos(angle),
            y: cy + radius * 0.7 * Math.sin(angle),
        };
    }
    for (let i = 0; i < n; i++) {
        const tAngle = ((i + 0.5) / n) * 2 * Math.PI;
        nb.transitions[`t${i}`] = {
            x: cx + radius * Math.cos(tAngle),
            y: cy + radius * Math.sin(tAngle),
        };
        nb.arcs.push({ source: `p${i}`, target: `t${i}`, weight: [1], inhibit: false });
        nb.arcs.push({ source: `t${i}`, target: `p${(i + 1) % n}`, weight: [1], inhibit: false });
        if (m[i] && i < nt.length) {
            let dur = params.duration;
            if (durs && i < durs.length && durs[i] > 0) dur = durs[i];
            nb.bindings[`t${i}`] = {
                note: nt[i],
                channel: params.channel,
                velocity: clampVelocity(params.velocity),
                duration: dur,
            };
        }
    }
    nb.track = {
        channel: params.channel,
        defaultVelocity: params.velocity,
        instrument: '',
        instrumentSet: [],
        generator: 'noted-ring',
        ringSize: n,
        beats: m.filter(Boolean).length,
        generatorParams: { duration: params.duration, seed: params.seed || 0 },
    };
    nb.buildArcIndex();
    nb.resetState();
    return nb;
}

// chordPadNet — voices the ChordPlan as a sustained, lightly-strummed pad.
// Mirrors theme.go::ChordPadNet: at each chord boundary the first three
// steps carry root/third/fifth with bar-length sustain so they overlap
// into a held chord.
export function chordPadNet(plan, scale, params) {
    let n = cycleSteps(plan);
    if (n === 0) n = 64;
    const nb = new NetBundle();
    const { cx, cy, radius } = ringLayout(n);

    for (let i = 0; i < n; i++) {
        const initial = i === 0 ? [1] : [0];
        const angle = (i / n) * 2 * Math.PI;
        nb.places[`p${i}`] = {
            initial,
            x: cx + radius * 0.7 * Math.cos(angle),
            y: cy + radius * 0.7 * Math.sin(angle),
        };
    }
    for (let i = 0; i < n; i++) {
        const tAngle = ((i + 0.5) / n) * 2 * Math.PI;
        nb.transitions[`t${i}`] = {
            x: cx + radius * Math.cos(tAngle),
            y: cy + radius * Math.sin(tAngle),
        };
        nb.arcs.push({ source: `p${i}`, target: `t${i}`, weight: [1], inhibit: false });
        nb.arcs.push({ source: `t${i}`, target: `p${(i + 1) % n}`, weight: [1], inhibit: false });
    }
    for (let c = 0; c < plan.chords.length; c++) {
        const chord = plan.chords[c];
        const base = c * plan.stepsPerChord;
        for (let v = 0; v < chord.tones.length && v < 3; v++) {
            const step = base + v;
            if (step >= n) break;
            nb.bindings[`t${step}`] = {
                note: degreeToMidi(clampDegree(chord.tones[v]), scale),
                channel: params.channel,
                velocity: clampVelocity(params.velocity),
                duration: params.duration,
            };
        }
    }
    nb.track = {
        channel: params.channel,
        defaultVelocity: params.velocity,
        instrument: '',
        instrumentSet: [],
        generator: 'chord-pad',
        ringSize: n,
        beats: plan.chords.length * 3,
        generatorParams: { duration: params.duration, seed: params.seed || 0 },
    };
    nb.buildArcIndex();
    nb.resetState();
    return nb;
}

// chordBassRing — expand a one-bar groove mask across the chord cycle with
// each bar's hits pitched at that bar's chord root. Mirrors
// theme.go::chordBassRingShifted.
export function chordBassRing(plan, barMask, scale, params, registerShift = 0) {
    let barSteps = barMask.length;
    let bm = barMask;
    if (barSteps === 0) { barSteps = 16; bm = new Array(barSteps).fill(false); }
    let bars = plan.chords.length;
    if (bars === 0) bars = 4;
    const n = bars * barSteps;
    const mask = new Array(n).fill(false);
    const notes = new Array(n).fill(0);
    for (let b = 0; b < bars; b++) {
        const chord = chordAt(plan, b * plan.stepsPerChord);
        const root = degreeToMidi(clampDegree(chord.root), scale) + registerShift;
        for (let i = 0; i < barSteps; i++) {
            const idx = b * barSteps + i;
            mask[idx] = bm[i];
            notes[idx] = root;
        }
    }
    return notedRing(notes, mask, params);
}

// chordWalkingBassRing — a real walking bass: steady quarter notes (4/bar,
// kick-independent) striding root→3rd→5th→chromatic-approach through the
// chords. Mirrors theme.go::chordWalkingBassRing. Draw-free, so it doesn't
// touch the shared RNG stream.
export function chordWalkingBassRing(plan, scale, params, registerShift = 0) {
    let barSteps = plan.stepsPerChord;
    if (!barSteps || barSteps <= 0) barSteps = 16;
    let bars = (plan.chords && plan.chords.length) || 0;
    if (bars === 0) bars = 4;
    const beats = 4;
    let stride = Math.floor(barSteps / beats);
    if (stride < 1) stride = 1;
    const n = bars * barSteps;
    const mask = new Array(n).fill(false);
    const notes = new Array(n).fill(0);
    for (let b = 0; b < bars; b++) {
        const chord = chordAt(plan, b * plan.stepsPerChord);
        const next = chordAt(plan, ((b + 1) % bars) * plan.stepsPerChord);
        for (let beat = 0; beat < beats; beat++) {
            const step = beat * stride;
            if (step >= barSteps) break;
            const idx = b * barSteps + step;
            mask[idx] = true;
            notes[idx] = walkingBassNote(beat, chord, next, scale, registerShift);
        }
    }
    return notedRing(notes, mask, params);
}

// walkingBassNote — root / third / fifth / chromatic approach to the next
// bar's root. Mirrors theme.go::walkingBassNote.
function walkingBassNote(beat, chord, next, scale, shift) {
    const root = degreeToMidi(clampDegree(chord.root), scale) + shift;
    switch (beat) {
        case 1:
            return (chord.tones && chord.tones.length > 1)
                ? degreeToMidi(clampDegree(chord.tones[1]), scale) + shift
                : root;
        case 2:
            return (chord.tones && chord.tones.length > 2)
                ? degreeToMidi(clampDegree(chord.tones[2]), scale) + shift
                : root;
        case 3: {
            const nextRoot = degreeToMidi(clampDegree(next.root), scale) + shift;
            return nextRoot < root ? nextRoot + 1 : nextRoot - 1;
        }
        default:
            return root;
    }
}

// chordBossaBassRing — bossa-nova ostinato: root on beat 1, chord fifth (voiced
// below the root) on the "& of 2", two onsets per bar. The root sustains a
// dotted quarter, the fifth a quarter (durations baked in ms from bpm, the
// pad's bar-length idiom). Mirrors theme.go::chordBossaBassRing. Draw-free.
export function chordBossaBassRing(plan, scale, params, registerShift = 0, bpm = 120) {
    let barSteps = plan.stepsPerChord;
    if (!barSteps || barSteps <= 0) barSteps = 16;
    let bars = (plan.chords && plan.chords.length) || 0;
    if (bars === 0) bars = 4;
    let fifthStep = Math.floor(barSteps * 3 / 8); // the "& of 2"
    if (fifthStep <= 0 || fifthStep >= barSteps) fifthStep = Math.floor(barSteps / 2);
    let barMs = 2000;
    if (bpm > 0) barMs = Math.floor(4.0 * 60000.0 / bpm * 0.95);
    const rootDur = Math.floor(barMs * 3 / 8); // dotted quarter
    const fifthDur = Math.floor(barMs / 4);    // quarter
    const n = bars * barSteps;
    const mask = new Array(n).fill(false);
    const notes = new Array(n).fill(0);
    const durs = new Array(n).fill(0);
    for (let b = 0; b < bars; b++) {
        const chord = chordAt(plan, b * plan.stepsPerChord);
        const root = degreeToMidi(clampDegree(chord.root), scale) + registerShift;
        let fifth = root;
        if (chord.tones && chord.tones.length > 2) {
            fifth = degreeToMidi(clampDegree(chord.tones[2]), scale) + registerShift;
        }
        while (fifth >= root) fifth -= 12; // voice the fifth below the root
        const base = b * barSteps;
        mask[base] = true;
        notes[base] = root;
        durs[base] = rootDur;
        mask[base + fifthStep] = true;
        notes[base + fifthStep] = fifth;
        durs[base + fifthStep] = fifthDur;
    }
    return notedRingDur(notes, mask, durs, params);
}

// kickHitMask returns the kick's hit mask as a boolean array — mirrors
// theme.go::KickHitMask. The genre arg uses the JS composer.js Genres
// shape (lowercase kick: [hits, steps, rotation, midiNote]).
export function kickHitMask(genre) {
    const [k, n, rot] = genre.kick || [4, 16, 0];
    const pattern = bjorklund(k, n);
    const r = ((rot % n) + n) % n;
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = pattern[(i + r) % n] === 1;
    return out;
}

// --- Helpers ---

// generateMotif — slice-2 phrase-grammar rewrite, byte-equivalent to
// theme.go::generateMotif. 4 bars (64 steps): bars 0-1 = question (ends on
// the third of bar 1's chord), bars 2-3 = answer (resolves to tonic).
// Strong beats snap to the active bar's chord tones. Draw order is part of
// the parity contract: per-bar hit counts first (4 draws), per-bar mask
// fills (variable), then one walk draw per active weak step.
function generateMotif(rng, scaleLen, plan) {
    const bars = 4;
    const barSteps = 16;
    const motifLen = bars * barSteps;
    const degrees = new Array(motifLen).fill(0);
    const mask = new Array(motifLen).fill(false);

    for (let b = 0; b < bars; b++) {
        const hits = 6 + rng.nextInt(3);
        const base = b * barSteps;
        let have = 0;
        for (let i = 0; i < barSteps; i += 4) {
            mask[base + i] = true;
            have++;
        }
        while (have < hits) {
            const i = rng.nextInt(barSteps);
            if (!mask[base + i]) {
                mask[base + i] = true;
                have++;
            }
        }
    }

    let cur = 0;
    for (let i = 0; i < motifLen; i++) {
        if (!mask[i]) {
            degrees[i] = -1;
            continue;
        }
        const bar = (i / barSteps) | 0;
        const chord = chordAt(plan, bar * plan.stepsPerChord);
        if (i % 4 === 0) {
            cur = nearestToneOf(cur, scaleLen, chord.tones);
        } else {
            const delta = rng.nextInt(5) - 2;
            cur += delta;
            if (cur < 0) cur = 0;
            if (cur > scaleLen - 1) cur = scaleLen - 1;
        }
        degrees[i] = cur;
    }

    // Question end → third of bar 1's chord; answer end → tonic.
    let li = lastActiveIn(degrees, 1 * barSteps, 2 * barSteps);
    if (li >= 0) {
        const c = chordAt(plan, 1 * plan.stepsPerChord);
        if (c.tones.length > 1) degrees[li] = clampDegree(c.tones[1]);
    }
    li = lastActiveIn(degrees, 3 * barSteps, 4 * barSteps);
    if (li >= 0) degrees[li] = 0;

    let first = -1, last = -1;
    for (const d of degrees) {
        if (d >= 0) {
            if (first < 0) first = d;
            last = d;
        }
    }
    let contour = 0;
    if (first >= 0 && last >= 0) {
        if (last > first) contour = 1;
        else if (last < first) contour = -1;
    }
    return { degrees, mask, contour };
}

// nearestToneOf — deterministic chord-tone snap (ties resolve upward),
// mirrors theme.go::nearestToneOf.
function nearestToneOf(cur, scaleLen, tones) {
    for (const t of tones) if (t === cur) return cur;
    for (let dist = 1; dist < scaleLen; dist++) {
        for (const t of tones) if (t === cur + dist && t < scaleLen) return t;
        for (const t of tones) if (t === cur - dist && t >= 0) return t;
    }
    if (tones.length > 0) return clampDegree(tones[0]);
    return 0;
}

function lastActiveIn(degrees, from, to) {
    for (let i = to - 1; i >= from; i--) {
        if (degrees[i] >= 0) return i;
    }
    return -1;
}

function cloneCell(c) {
    return {
        degrees: c.degrees.slice(),
        mask: c.mask.slice(),
        contour: c.contour,
    };
}

function clampDegree(d) {
    const scaleLen = 7;
    while (d < 0) d += scaleLen;
    while (d >= scaleLen) d -= scaleLen;
    return d;
}

// FNV-32 — byte-equivalent to theme.go::hashStr. Used by buildTrackTheme to
// salt the seed so motif draws are independent of the existing composer
// RNG stream.
export function hashStr(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
        h = (h ^ s.charCodeAt(i)) >>> 0;
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
}

// --- Family + groove + energy tables (mirrors energy.go / groove.go) ---

const FAMILIES = {
    techno: 'edm', edm: 'edm', house: 'edm', trance: 'edm',
    dnb: 'edm', dubstep: 'edm', speedcore: 'edm', garage: 'edm', trap: 'edm',
    country: 'song', blues: 'song', funk: 'song', reggae: 'song',
    synthwave: 'song', metal: 'song',
    jazz: 'jazz', bossa: 'jazz',
    ambient: 'chill', lofi: 'chill',
    wrapped: 'edm',
};

export function familyFor(genreName) {
    return FAMILIES[genreName] || 'edm';
}

export const Groove = Object.freeze({
    FourOnFloor: 0,
    Offbeat:     1,
    Sidechained: 2,
    SyncoPocket: 3,
    Breakbeat:   4,
    Walking:     5,
    Bossa:       6,
});

export function defaultGrooveFor(genreName) {
    switch (genreName) {
        case 'techno': case 'edm': case 'trance': return Groove.FourOnFloor;
        case 'house':                              return Groove.SyncoPocket;
        case 'dubstep': case 'trap':              return Groove.Sidechained;
        case 'reggae':                             return Groove.Offbeat;
        case 'dnb':                                return Groove.Breakbeat;
        // Walking-bass genres: steady quarter-note line through the chord
        // tones, kick-independent. (Ambient stays a drone on the default.)
        case 'jazz': case 'blues': case 'lofi':   return Groove.Walking;
        // Bossa has its own signature: the syncopated root / low-fifth
        // ostinato, not a walking line.
        case 'bossa':                              return Groove.Bossa;
        default:                                   return Groove.FourOnFloor;
    }
}

const energyEDM = {
    intro:       { energy: 0.30, filterOpen: 0.35 },
    buildup:     { energy: 0.65, filterOpen: 0.40 },
    'pre-chorus':{ energy: 0.60, filterOpen: 0.45 },
    drop:        { energy: 0.95, filterOpen: 0.90 },
    verse:       { energy: 0.55, filterOpen: 0.50 },
    chorus:      { energy: 0.85, filterOpen: 0.80 },
    breakdown:   { energy: 0.30, filterOpen: 0.25 },
    bridge:      { energy: 0.55, filterOpen: 0.55 },
    solo:        { energy: 0.70, filterOpen: 0.70 },
    outro:       { energy: 0.30, filterOpen: 0.30 },
};

const energySong = {
    intro:       { energy: 0.35, filterOpen: 0.40 },
    verse:       { energy: 0.55, filterOpen: 0.55 },
    'pre-chorus':{ energy: 0.70, filterOpen: 0.55 },
    chorus:      { energy: 0.85, filterOpen: 0.80 },
    breakdown:   { energy: 0.40, filterOpen: 0.40 },
    bridge:      { energy: 0.55, filterOpen: 0.55 },
    drop:        { energy: 0.85, filterOpen: 0.80 },
    solo:        { energy: 0.75, filterOpen: 0.75 },
    outro:       { energy: 0.30, filterOpen: 0.35 },
};

const energyChill = {
    intro:       { energy: 0.25, filterOpen: 0.35 },
    verse:       { energy: 0.45, filterOpen: 0.50 },
    chorus:      { energy: 0.60, filterOpen: 0.60 },
    bridge:      { energy: 0.55, filterOpen: 0.55 },
    breakdown:   { energy: 0.30, filterOpen: 0.40 },
    buildup:     { energy: 0.40, filterOpen: 0.45 },
    drop:        { energy: 0.55, filterOpen: 0.55 },
    'pre-chorus':{ energy: 0.50, filterOpen: 0.50 },
    solo:        { energy: 0.55, filterOpen: 0.55 },
    outro:       { energy: 0.25, filterOpen: 0.30 },
};

function energyTableFor(family) {
    if (family === 'song' || family === 'jazz') return energySong;
    if (family === 'chill') return energyChill;
    return energyEDM;
}

// roleProfilesEDM — section -> role -> RoleProfile. Byte-equivalent to
// energy.go::roleProfilesEDM.
const roleProfilesEDM = {
    intro: {
        kick:  { active: true, densityMul: 1.0, velocityAdd: -10, hitsOverride: 4 },
        hihat: { active: true, densityMul: 0.5, velocityAdd: -10, hitsOverride: 2 },
    },
    buildup: {
        kick:    { active: true, densityMul: 1.0, hitsOverride: 4 },
        snare:   { active: true, densityMul: 0.7 },
        hihat:   { active: true, densityMul: 1.0, hitsOverride: 8 },
        bass:    { active: true, densityMul: 0.8, motifMode: MotifMode.Fragment },
        melody:  { active: true, densityMul: 0.7, motifMode: MotifMode.Fragment },
        harmony: { active: true, densityMul: 0.8, velocityAdd: -6 },
    },
    drop: {
        kick:    { active: true, densityMul: 1.0, velocityAdd: 8, hitsOverride: 4 },
        snare:   { active: true, densityMul: 1.0, velocityAdd: 6 },
        hihat:   { active: true, densityMul: 1.0, velocityAdd: 4, hitsOverride: 8 },
        clap:    { active: true, densityMul: 1.0, velocityAdd: 6 },
        bass:    { active: true, densityMul: 1.0, velocityAdd: 6, motifMode: MotifMode.Ignore },
        melody:  { active: true, densityMul: 1.0, velocityAdd: 6, motifMode: MotifMode.Play },
        arp:     { active: true, densityMul: 1.0, velocityAdd: 4, motifMode: MotifMode.Transposed },
        harmony: { active: true, densityMul: 1.0, velocityAdd: 4 },
    },
    verse: {
        kick:    { active: true, hitsOverride: 4 },
        snare:   { active: true },
        hihat:   { active: true, hitsOverride: 5 },
        bass:    { active: true, densityMul: 0.9, motifMode: MotifMode.Ignore },
        melody:  { active: true, densityMul: 0.6, motifMode: MotifMode.Fragment },
        harmony: { active: true, densityMul: 0.8, velocityAdd: -4 },
    },
    breakdown: {
        hihat:   { active: true, densityMul: 0.6, velocityAdd: -8, hitsOverride: 2 },
        bass:    { active: true, densityMul: 0.5, registerShift: 12, motifMode: MotifMode.Ignore },
        melody:  { active: true, densityMul: 0.7, motifMode: MotifMode.Augmented },
        harmony: { active: true, densityMul: 1.0 },
    },
    chorus: {
        kick:    { active: true, hitsOverride: 4 },
        snare:   { active: true },
        hihat:   { active: true, hitsOverride: 8 },
        bass:    { active: true, densityMul: 1.0, motifMode: MotifMode.Ignore },
        melody:  { active: true, densityMul: 1.0, motifMode: MotifMode.Play },
        arp:     { active: true, densityMul: 1.0, motifMode: MotifMode.Transposed },
        harmony: { active: true, densityMul: 1.0, velocityAdd: 4 },
    },
    bridge: {
        hihat:   { active: true, densityMul: 0.7 },
        bass:    { active: true, densityMul: 0.8, motifMode: MotifMode.Ignore },
        melody:  { active: true, densityMul: 0.8, motifMode: MotifMode.Inverted },
        harmony: { active: true, densityMul: 0.9 },
    },
    solo: {
        kick:    { active: true, hitsOverride: 4 },
        hihat:   { active: true, hitsOverride: 6 },
        bass:    { active: true, motifMode: MotifMode.Ignore },
        melody:  { active: true, densityMul: 1.1, motifMode: MotifMode.Play },
        harmony: { active: true, densityMul: 0.9 },
    },
    'pre-chorus': {
        kick:    { active: true, hitsOverride: 4 },
        snare:   { active: true },
        hihat:   { active: true, hitsOverride: 6 },
        bass:    { active: true, motifMode: MotifMode.Ignore },
        arp:     { active: true, densityMul: 1.0, motifMode: MotifMode.Fragment },
        harmony: { active: true, densityMul: 0.9 },
    },
    outro: {
        kick:    { active: true, hitsOverride: 2, velocityAdd: -10 },
        hihat:   { active: true, hitsOverride: 2, velocityAdd: -10 },
        melody:  { active: true, densityMul: 0.5, motifMode: MotifMode.Fragment },
        harmony: { active: true, densityMul: 0.7, velocityAdd: -8 },
    },
};

// roleProfilesSong — byte-equivalent to energy.go::roleProfilesSong.
// Verse/chorus-oriented sections; chorus is the anchor (motif verbatim),
// verse/outro fragment, bridge inverts. Synthwave drum density stays
// active — the cohesion here is the recurring motif + locked bass,
// not the EDM "kick drops in the breakdown" signature.
const roleProfilesSong = {
    intro: {
        kick:    { active: true, densityMul: 1.0, velocityAdd: -10, hitsOverride: 4 },
        hihat:   { active: true, densityMul: 0.7, velocityAdd: -8 },
        melody:  { active: true, densityMul: 0.4, motifMode: MotifMode.Fragment },
        harmony: { active: true, densityMul: 0.8, velocityAdd: -6 },
    },
    verse: {
        kick:    { active: true, hitsOverride: 4 },
        snare:   { active: true },
        hihat:   { active: true },
        bass:    { active: true, motifMode: MotifMode.Ignore },
        melody:  { active: true, densityMul: 0.7, motifMode: MotifMode.Fragment },
        harmony: { active: true, densityMul: 0.9 },
    },
    'pre-chorus': {
        kick:    { active: true, hitsOverride: 4 },
        snare:   { active: true },
        hihat:   { active: true },
        bass:    { active: true, motifMode: MotifMode.Ignore },
        arp:     { active: true, densityMul: 0.9, motifMode: MotifMode.Fragment },
        harmony: { active: true, densityMul: 0.9 },
    },
    chorus: {
        kick:    { active: true, hitsOverride: 4, velocityAdd: 6 },
        snare:   { active: true, velocityAdd: 4 },
        hihat:   { active: true, velocityAdd: 4 },
        bass:    { active: true, velocityAdd: 6, motifMode: MotifMode.Ignore },
        melody:  { active: true, velocityAdd: 6, motifMode: MotifMode.Play },
        arp:     { active: true, motifMode: MotifMode.Transposed },
        harmony: { active: true, densityMul: 1.0, velocityAdd: 4 },
    },
    bridge: {
        kick:    { active: true, hitsOverride: 4 },
        hihat:   { active: true, densityMul: 0.7 },
        bass:    { active: true, densityMul: 0.8, motifMode: MotifMode.Ignore },
        melody:  { active: true, densityMul: 0.8, motifMode: MotifMode.Inverted },
        harmony: { active: true, densityMul: 0.9 },
    },
    breakdown: {
        kick:    { active: true, densityMul: 0.7, velocityAdd: -10, hitsOverride: 2 },
        hihat:   { active: true, densityMul: 0.5, velocityAdd: -8 },
        bass:    { active: true, densityMul: 0.5, registerShift: 12, motifMode: MotifMode.Ignore },
        melody:  { active: true, densityMul: 0.7, motifMode: MotifMode.Augmented },
        harmony: { active: true, densityMul: 1.0 },
    },
    drop: {
        kick:    { active: true, hitsOverride: 4, velocityAdd: 8 },
        snare:   { active: true, velocityAdd: 6 },
        hihat:   { active: true, velocityAdd: 4 },
        bass:    { active: true, velocityAdd: 6, motifMode: MotifMode.Ignore },
        melody:  { active: true, velocityAdd: 6, motifMode: MotifMode.Play },
        harmony: { active: true, densityMul: 1.0, velocityAdd: 4 },
    },
    solo: {
        kick:    { active: true, hitsOverride: 4 },
        hihat:   { active: true },
        bass:    { active: true, motifMode: MotifMode.Ignore },
        melody:  { active: true, densityMul: 1.1, motifMode: MotifMode.Play },
        harmony: { active: true, densityMul: 0.9 },
    },
    outro: {
        kick:    { active: true, hitsOverride: 2, velocityAdd: -10 },
        hihat:   { active: true, densityMul: 0.6, velocityAdd: -10 },
        melody:  { active: true, densityMul: 0.5, motifMode: MotifMode.Fragment },
        harmony: { active: true, densityMul: 0.7, velocityAdd: -8 },
    },
};

function rolesTableFor(family) {
    if (family === 'edm') return roleProfilesEDM;
    if (family === 'song') return roleProfilesSong;
    return null;
}

// motifModeForSection — section→recall-grammar policy. Mirrors
// energy.go::motifModeForSection.
function motifModeForSection(sectionName) {
    switch (sectionName) {
        case 'drop': case 'chorus': case 'solo': return MotifMode.Play;
        case 'breakdown':                        return MotifMode.Augmented;
        case 'bridge':                           return MotifMode.Inverted;
        default:                                 return MotifMode.Fragment;
    }
}

// synthesizeRoles — derive a section's RoleProfile map from the family
// archetype for families without an explicit table (jazz/chill). Mirrors
// energy.go::synthesizeRoles.
function synthesizeRoles(family, sectionName) {
    const out = {};
    for (const role of Object.keys(archetypeFor(family, sectionName))) {
        const rp = { active: true };
        if (role === 'melody' || role === 'arp') {
            rp.motifMode = motifModeForSection(sectionName);
        }
        out[role] = rp;
    }
    if (!out.harmony) out.harmony = { active: true };
    return out;
}

export function energyProfilesFor(family, genreName) {
    const base = energyTableFor(family);
    const roles = rolesTableFor(family);
    const out = {};
    for (const name of Object.keys(base)) {
        let filledRoles = null;
        if (roles && roles[name]) {
            filledRoles = {};
            for (const [role, p] of Object.entries(roles[name])) {
                filledRoles[role] = p;
            }
        }
        if (filledRoles === null) {
            filledRoles = synthesizeRoles(family, name);
        }
        out[name] = {
            roles: filledRoles,
            filterOpen: base[name].filterOpen,
            energy: base[name].energy,
        };
    }
    return out;
}

// activeRolesFromProfile returns the legacy `{role: true}` shape so
// non-v2-aware code can interop with sectionProfile-aware code.
export function activeRolesFromProfile(p) {
    const out = {};
    for (const [role, rp] of Object.entries(p.roles || {})) {
        if (rp.active) out[role] = true;
    }
    return out;
}
