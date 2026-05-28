/**
 * countermelody.js — Port of internal/generator/countermelody/*.go.
 *
 * Rule-based note-selection kernel shared between the composition-layer
 * insert renderer (Go-only) and the share-layer arrange directive
 * (Go ↔ JS parity). Same envelope must produce the same generated
 * music net from both paths.
 *
 * Manifesto: rule-based only — answer mode places notes in rest runs,
 * harmony mode emits parallel 3rds, shadow mode emits late echoes.
 * No ML, no model, no inference.
 *
 * Determinism: seedFromBytes is the same fnv32a hash Go uses; the
 * PRNG is the existing mulberry32 in core.js. All hashing inputs must
 * be ASCII for parity (JS charCodeAt = UTF-16 code units, which match
 * Go byte values only for ASCII — the call sites stick to that).
 */

import { createRng } from './core.js';

// PPQ matches sequencer-worker.js's constant and the Go counterpart.
export const PPQ = 4;

// --- fnv32a hash (matches Go's hash/fnv New32a) ---

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * seedFromBytes computes a fnv32a hash over the concatenated ASCII
 * byte representations of the given string parts. Output is a uint32.
 */
export function seedFromBytes(...parts) {
    let h = FNV_OFFSET >>> 0;
    for (const part of parts) {
        const s = String(part);
        for (let i = 0; i < s.length; i++) {
            h = (h ^ s.charCodeAt(i)) >>> 0;
            h = Math.imul(h, FNV_PRIME) >>> 0;
        }
    }
    return h >>> 0;
}

// --- Source simulation ---

/**
 * simulateMusicNotes walks music nets in proj for totalTicks ticks,
 * returning per-tick hits, sorted unique pitch set, and ordered source
 * notes. When scopeNetID is non-empty, only that net is simulated;
 * otherwise every music net is walked (control nets are skipped).
 *
 * Net state is reset at the end so the caller can boot the project
 * cleanly afterwards.
 */
export function simulateMusicNotes(proj, totalTicks, scopeNetID) {
    const hits = new Array(totalTicks).fill(false);
    const pitchSet = new Set();
    const notes = [];

    const netIDs = Object.keys(proj.nets).sort();
    for (const id of netIDs) {
        if (scopeNetID && id !== scopeNetID) continue;
        const nb = proj.nets[id];
        if (!nb) continue;
        if (nb.role === 'control') continue;

        nb.resetState();
        const transLabels = Object.keys(nb.bindings || {}).sort();
        for (let tick = 0; tick < totalTicks; tick++) {
            let fired = false;
            for (const label of transLabels) {
                if (!nb.isEnabled(label)) continue;
                const res = nb.fire(label);
                fired = true;
                if (res && res.midi && res.midi.note > 0) {
                    hits[tick] = true;
                    pitchSet.add(res.midi.note);
                    let vel = res.midi.velocity;
                    if (!vel || vel <= 0) vel = 90;
                    notes.push({ tick, note: res.midi.note, velocity: vel });
                }
                break;
            }
            if (!fired) nb.resetState();
        }
        nb.resetState();
    }
    const sortedPitches = Array.from(pitchSet).sort((a, b) => a - b);
    return { hits, pitchSet: sortedPitches, sourceNotes: notes };
}

// --- Mode functions ---

/**
 * answerMode finds rest runs in the source rhythm and places
 * complementary notes there. Density gates which runs get filled;
 * pitch is sampled from the source's pitch set, transposed ±12
 * semitones based on register.
 */
export function answerMode(hits, pitchSet, register, density, rng) {
    const transpose = register === 'below' ? -12 : 12;
    const notes = [];
    const totalTicks = hits.length;
    let t = 0;
    while (t < totalTicks) {
        if (hits[t]) { t++; continue; }
        const runStart = t;
        while (t < totalTicks && !hits[t]) t++;
        const runLen = t - runStart;
        if (runLen < 2) continue;
        if (rng.float64() > density) continue;

        let basePitch = pitchSet[rng.intn(pitchSet.length)] + transpose;
        while (basePitch < 24) basePitch += 12;
        while (basePitch > 108) basePitch -= 12;

        const startTick = runStart + Math.floor(runLen / 2);
        let dur = Math.floor(runLen / 2);
        if (dur > 8) dur = 8;
        if (dur < 1) dur = 1;
        notes.push({
            startTick,
            note: basePitch,
            velocity: 90,
            duration: dur,
        });
    }
    return notes;
}

/**
 * harmonyMode emits a parallel-motion line: every source note becomes
 * srcNote ± interval (major 3rd above or minor 3rd below). Density
 * thins source notes deterministically.
 */
export function harmonyMode(src, register, density, rng) {
    const interval = register === 'below' ? -3 : 4;
    const out = [];
    for (const n of src) {
        if (rng.float64() > density) continue;
        let pitch = n.note + interval;
        while (pitch < 24) pitch += 12;
        while (pitch > 108) pitch -= 12;
        out.push({
            startTick: n.tick,
            note: pitch,
            velocity: n.velocity,
            duration: 4,
        });
    }
    return out;
}

/**
 * shadowMode emits sparse 16th-late echoes of the source line at half
 * velocity, transposed by register. Echoes past totalTicks are dropped.
 */
export function shadowMode(src, totalTicks, register, density, rng) {
    const transpose = register === 'below' ? -12 : 12;
    const out = [];
    for (const n of src) {
        if (rng.float64() > density) continue;
        const echoTick = n.tick + 1;
        if (echoTick >= totalTicks) continue;
        let pitch = n.note + transpose;
        while (pitch < 24) pitch += 12;
        while (pitch > 108) pitch -= 12;
        let velocity = Math.floor(n.velocity / 2);
        if (velocity < 30) velocity = 30;
        out.push({
            startTick: echoTick,
            note: pitch,
            velocity,
            duration: 3,
        });
    }
    return out;
}

// --- Main entry ---

/**
 * generateCounterMelody simulates the source project, dispatches to
 * the requested mode, returns the generated note list.
 *
 * Return contract (matches Go countermelody.GenerateCounterMelody):
 *   - null  → no source material (project has no music transitions)
 *   - []    → source material exists but the mode produced no notes
 *   - non-empty → notes to render or materialize as a music net
 */
export function generateCounterMelody(proj, opts) {
    const mode = opts.mode || 'answer';
    const register = opts.register || 'above';
    let density = opts.density;
    if (!density || density <= 0) density = 0.5;
    if (density > 1) density = 1;
    let totalTicks = opts.totalTicks | 0;
    if (totalTicks < 4) totalTicks = 4;

    const { hits, pitchSet, sourceNotes } = simulateMusicNotes(proj, totalTicks, opts.sourceNetID || '');
    if (pitchSet.length === 0) return null;

    const rng = createRng(opts.seed >>> 0);
    switch (mode) {
        case 'harmony':
            return harmonyMode(sourceNotes, register, density, rng);
        case 'shadow':
            return shadowMode(sourceNotes, totalTicks, register, density, rng);
        default:
            return answerMode(hits, pitchSet, register, density, rng);
    }
}

// --- Net construction ---

/**
 * buildMusicNet materializes a music net from a note list. Topology
 * mirrors composer melody nets: a ring of totalTicks places +
 * transitions, initial token at p0, arcs p_i → t_i and t_i → p_{(i+1) mod N}.
 * Note-onset transitions carry a MIDI binding; the rest are silent
 * advancers. Returns null when totalTicks <= 0.
 *
 * Returns a plain-JSON net bundle (wire format) — the worker calls
 * parseNetBundle on it on load. Matches the buildControlBundle
 * convention in arrange.js: handing a NetBundle instance directly
 * would lose methods/cache fields after structured clone.
 */
export function buildMusicNet(notes, opts) {
    const totalTicks = opts.totalTicks | 0;
    if (totalTicks <= 0) return null;
    const group = opts.group || 'harmony';
    const defaultVel = (opts.defaultVelocity && opts.defaultVelocity > 0) ? opts.defaultVelocity : 90;
    const channel = opts.channel | 0;
    const instrument = opts.instrument || '';
    const msPerTick = opts.msPerTick || 0;

    const places = {};
    const transitions = {};
    const arcs = [];
    const bindings = {};

    for (let i = 0; i < totalTicks; i++) {
        places[`p${i}`] = { initial: i === 0 ? [1] : [0], x: 0, y: 0 };
        transitions[`t${i}`] = { x: 0, y: 0 };
        arcs.push({ source: `p${i}`, target: `t${i}`, weight: [1], inhibit: false });
        const next = (i + 1) % totalTicks;
        arcs.push({ source: `t${i}`, target: `p${next}`, weight: [1], inhibit: false });
    }

    for (const n of notes) {
        if (n.startTick < 0 || n.startTick >= totalTicks) continue;
        let durMs = Math.floor(n.duration * msPerTick);
        if (durMs < 1) durMs = 1;
        bindings[`t${n.startTick}`] = {
            note: n.note,
            channel,
            velocity: n.velocity,
            duration: durMs,
        };
    }

    return {
        role: 'music',
        track: {
            channel,
            defaultVelocity: defaultVel,
            instrument,
            instrumentSet: [],
            group,
        },
        places,
        transitions,
        arcs,
        bindings,
    };
}
