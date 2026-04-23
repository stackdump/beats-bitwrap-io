/**
 * arrange.js — JS port of internal/generator/arrange.go and the
 * structure-related helpers in internal/generator/structure.go.
 *
 * Full Go/JS parity is the design contract: `arrangeWithOpts(proj,
 * genre, size, opts)` produces the same output shape as Go's
 * `ArrangeWithOpts` for the same inputs. This lets production hosts
 * (which run without the Go `-authoring` server) reconstitute the full
 * arrangement DSL client-side from a CID-addressed share envelope.
 *
 * The canonical surface is `arrangeWithOpts`. `fadeIn` / `fadeOut` /
 * `drumBreak` stay exported with their original signatures for any
 * legacy callers; `injectFeelCurve` / `injectMacroCurve` are also
 * exposed in case something wants to layer curves without a full
 * arrange pass.
 */

import { ringLayout } from './euclidean.js';
import { createRng } from './core.js';
import { NetBundle } from '../pflow.js';

// --- Blueprint + archetype tables (mirrors structure.go) ---------------

const FAMILIES = {
    edm: 'edm', techno: 'edm', house: 'edm', trance: 'edm', dnb: 'edm',
    dubstep: 'edm', speedcore: 'edm', garage: 'edm', trap: 'edm',
    country: 'song', blues: 'song', funk: 'song', reggae: 'song',
    synthwave: 'song', metal: 'song',
    jazz: 'jazz', bossa: 'jazz',
    ambient: 'chill', lofi: 'chill',
    // "wrapped" is the hand-authored share tag. Defaults to EDM-family
    // blueprints since authored tracks typically skew that way.
    wrapped: 'edm',
};

const BLUEPRINTS = {
    edm: {
        minimal: [
            ['intro', 'buildup', 'drop', 'outro'],
            ['intro', 'drop', 'breakdown', 'drop'],
        ],
        standard: [
            ['intro', 'buildup', 'drop', 'breakdown', 'buildup', 'drop', 'outro'],
            ['intro', 'verse', 'buildup', 'drop', 'breakdown', 'drop', 'outro'],
            ['intro', 'buildup', 'drop', 'verse', 'drop', 'outro'],
        ],
        extended: [
            ['intro', 'buildup', 'drop', 'breakdown', 'verse', 'buildup', 'drop', 'bridge', 'chorus', 'outro'],
            ['intro', 'verse', 'buildup', 'drop', 'breakdown', 'buildup', 'drop', 'chorus', 'outro'],
            ['intro', 'buildup', 'drop', 'verse', 'breakdown', 'buildup', 'drop', 'bridge', 'drop', 'outro'],
            ['intro', 'verse', 'pre-chorus', 'drop', 'breakdown', 'verse', 'buildup', 'drop', 'outro'],
        ],
        ab: [
            ['verse', 'drop', 'verse', 'drop'],
            ['buildup', 'drop', 'buildup', 'drop'],
            ['verse', 'chorus', 'verse', 'chorus'],
        ],
        drop: [
            ['drop', 'breakdown', 'drop', 'breakdown', 'drop'],
            ['buildup', 'drop', 'breakdown', 'drop'],
            ['drop', 'verse', 'drop', 'verse', 'drop'],
        ],
        build: [
            ['buildup', 'drop', 'buildup', 'drop', 'buildup', 'drop'],
            ['verse', 'buildup', 'drop', 'buildup', 'drop'],
        ],
        jam: [
            ['verse', 'solo', 'verse', 'solo', 'verse'],
            ['verse', 'bridge', 'verse', 'solo', 'verse'],
            ['drop', 'solo', 'drop', 'bridge', 'drop'],
        ],
    },
    song: {
        minimal: [
            ['intro', 'verse', 'chorus', 'outro'],
            ['intro', 'verse', 'verse', 'chorus'],
        ],
        standard: [
            ['intro', 'verse', 'chorus', 'verse', 'chorus', 'outro'],
            ['intro', 'verse', 'chorus', 'bridge', 'chorus', 'outro'],
            ['intro', 'verse', 'pre-chorus', 'chorus', 'verse', 'chorus', 'outro'],
        ],
        extended: [
            ['intro', 'verse', 'chorus', 'verse', 'chorus', 'bridge', 'chorus', 'outro'],
            ['intro', 'verse', 'pre-chorus', 'chorus', 'verse', 'pre-chorus', 'chorus', 'bridge', 'chorus', 'outro'],
            ['intro', 'verse', 'chorus', 'verse', 'chorus', 'breakdown', 'verse', 'chorus', 'outro'],
            ['intro', 'verse', 'verse', 'chorus', 'bridge', 'verse', 'chorus', 'chorus', 'outro'],
        ],
        ab: [
            ['verse', 'chorus', 'verse', 'chorus'],
            ['verse', 'chorus', 'bridge', 'chorus'],
            ['verse', 'pre-chorus', 'chorus', 'verse', 'chorus'],
        ],
        drop: [
            ['chorus', 'verse', 'chorus', 'verse', 'chorus'],
            ['chorus', 'bridge', 'chorus', 'bridge', 'chorus'],
        ],
        build: [
            ['verse', 'pre-chorus', 'chorus', 'verse', 'pre-chorus', 'chorus'],
            ['verse', 'buildup', 'chorus', 'verse', 'buildup', 'chorus'],
        ],
        jam: [
            ['verse', 'solo', 'verse', 'solo', 'verse'],
            ['verse', 'bridge', 'solo', 'verse', 'solo'],
            ['verse', 'verse', 'bridge', 'solo', 'verse'],
        ],
    },
    jazz: {
        minimal: [['intro', 'verse', 'solo', 'outro'], ['intro', 'verse', 'verse', 'outro']],
        standard: [
            ['intro', 'verse', 'solo', 'verse', 'outro'],
            ['intro', 'verse', 'verse', 'bridge', 'verse', 'outro'],
            ['intro', 'verse', 'chorus', 'solo', 'chorus', 'outro'],
        ],
        extended: [
            ['intro', 'verse', 'chorus', 'solo', 'verse', 'chorus', 'bridge', 'chorus', 'outro'],
            ['intro', 'verse', 'solo', 'verse', 'bridge', 'solo', 'verse', 'outro'],
            ['intro', 'verse', 'verse', 'solo', 'bridge', 'verse', 'chorus', 'outro'],
        ],
        ab: [['verse', 'solo', 'verse', 'solo'], ['verse', 'bridge', 'verse', 'solo']],
        drop: [['verse', 'solo', 'verse', 'solo', 'verse'], ['solo', 'verse', 'bridge', 'solo', 'verse']],
        build: [['verse', 'verse', 'solo', 'verse', 'solo', 'solo']],
        jam: [
            ['verse', 'solo', 'solo', 'bridge', 'solo', 'verse'],
            ['solo', 'bridge', 'solo', 'verse', 'solo'],
            ['verse', 'solo', 'verse', 'bridge', 'solo', 'solo'],
        ],
    },
    chill: {
        minimal: [['intro', 'verse', 'verse', 'outro'], ['intro', 'verse', 'bridge', 'outro']],
        standard: [
            ['intro', 'verse', 'bridge', 'verse', 'outro'],
            ['intro', 'verse', 'breakdown', 'verse', 'outro'],
            ['intro', 'verse', 'verse', 'bridge', 'verse', 'outro'],
        ],
        extended: [
            ['intro', 'verse', 'chorus', 'breakdown', 'verse', 'chorus', 'outro'],
            ['intro', 'verse', 'bridge', 'verse', 'breakdown', 'verse', 'bridge', 'outro'],
            ['intro', 'verse', 'verse', 'bridge', 'breakdown', 'verse', 'chorus', 'outro'],
        ],
        ab: [['verse', 'bridge', 'verse', 'bridge'], ['verse', 'breakdown', 'verse', 'bridge']],
        drop: [['verse', 'breakdown', 'verse', 'breakdown', 'verse'], ['verse', 'bridge', 'breakdown', 'verse', 'bridge']],
        build: [['verse', 'verse', 'bridge', 'verse', 'chorus'], ['breakdown', 'verse', 'bridge', 'verse', 'chorus']],
        jam: [['verse', 'bridge', 'verse', 'breakdown', 'verse'], ['verse', 'verse', 'bridge', 'breakdown', 'verse', 'bridge']],
    },
};

const ARCHETYPES = {
    intro:        { kick: true, hihat: true, bass: true },
    verse:        { kick: true, snare: true, hihat: true, bass: true },
    'pre-chorus': { kick: true, snare: true, hihat: true, bass: true, arp: true },
    chorus:       { kick: true, snare: true, hihat: true, bass: true, melody: true, harmony: true, arp: true, clap: true },
    drop:         { kick: true, snare: true, hihat: true, bass: true, melody: true, harmony: true, arp: true, clap: true },
    buildup:      { kick: true, snare: true, hihat: true, bass: true, arp: true },
    breakdown:    { hihat: true, bass: true, melody: true },
    bridge:       { bass: true, melody: true, harmony: true },
    solo:         { kick: true, hihat: true, bass: true, melody: true },
    outro:        { kick: true, hihat: true, melody: true },
};

const NO_VARIANT_ROLES = { snare: true };

function defaultPhrases(name) {
    switch (name) {
        case 'intro': case 'outro':        return ['A', 'A'];
        case 'verse':                      return ['A', 'A', 'B', 'A'];
        case 'chorus': case 'drop':        return ['A', 'B', 'A', 'B'];
        case 'bridge': case 'breakdown':   return ['C', 'C'];
        case 'buildup': case 'pre-chorus': return ['A', 'B'];
        case 'solo':                       return ['A', 'B', 'C', 'A'];
        default:                           return ['A', 'A'];
    }
}

function sectionSteps(name, size) {
    if (size === 'minimal') return (name === 'intro' || name === 'outro') ? 32 : 128;
    if (size === 'extended') {
        if (['intro', 'outro', 'breakdown', 'bridge', 'buildup', 'pre-chorus', 'solo'].includes(name)) return 128;
        return 192;
    }
    if (['intro', 'outro', 'breakdown', 'bridge', 'pre-chorus', 'solo'].includes(name)) return 64;
    return 192;
}

function sectionWithPhrases(name, steps, active) {
    const phrases = {};
    const pattern = defaultPhrases(name);
    for (const role of Object.keys(active)) {
        phrases[role] = NO_VARIANT_ROLES[role] ? Array(pattern.length).fill('A') : [...pattern];
    }
    return { name, steps, active: { ...active }, phrases };
}

// --- Predicates --------------------------------------------------------

function isStingerNet(id, nb) {
    if (nb?.track?.group === 'stinger') return true;
    return /^hit\d+$/.test(id);
}

function isDrumRoleName(id) {
    for (const prefix of ['kick', 'snare', 'hat', 'hihat', 'clap', 'cymbal', 'tom', 'drum', 'perc']) {
        if (id.startsWith(prefix)) return true;
    }
    return false;
}

function sortedMusicNetIDs(proj) {
    return Object.keys(proj.nets || {})
        .filter(id => proj.nets[id]?.role !== 'control')
        .sort();
}

// --- Control-net ring builder (NetBundle-based) ------------------------

// Returns a plain-JSON net bundle (wire format). The worker runs
// parseNetBundle on it on load, which is where the NetBundle class
// instantiation happens. Handing it a NetBundle instance directly would
// survive structured clone but lose methods/cache fields.
function buildControlBundle(steps, { ctrlAt = {}, sink = false, placePrefix = 'p', transPrefix = 't' } = {}) {
    const { cx, cy, radius } = ringLayout(steps);
    const placeCount = sink ? steps + 1 : steps;
    const angleDen = sink ? (steps + 1) : steps;
    const places = {};
    const transitions = {};
    const arcs = [];

    for (let i = 0; i < placeCount; i++) {
        const angle = (i / angleDen) * 2 * Math.PI;
        places[`${placePrefix}${i}`] = {
            initial: i === 0 ? [1] : [0],
            x: cx + radius * 0.7 * Math.cos(angle),
            y: cy + radius * 0.7 * Math.sin(angle),
        };
    }
    for (let i = 0; i < steps; i++) {
        const tAngle = ((i + 0.5) / angleDen) * 2 * Math.PI;
        const t = {
            x: cx + radius * Math.cos(tAngle),
            y: cy + radius * Math.sin(tAngle),
        };
        if (ctrlAt[i]) t.control = { ...ctrlAt[i] };
        transitions[`${transPrefix}${i}`] = t;
        const prev = `${placePrefix}${i}`;
        const next = sink ? `${placePrefix}${i + 1}` : `${placePrefix}${(i + 1) % steps}`;
        arcs.push(
            { source: prev, target: `${transPrefix}${i}`, weight: [1], inhibit: false },
            { source: `${transPrefix}${i}`, target: next, weight: [1], inhibit: false },
        );
    }

    return {
        role: 'control',
        track: { channel: 1, defaultVelocity: 100, instrument: '', instrumentSet: [] },
        places,
        transitions,
        arcs,
    };
}

// --- Template construction --------------------------------------------

function generateArrangeStructure(genre, size, roles, rng) {
    const family = FAMILIES[genre] || 'song';
    const blueprintsBySize = BLUEPRINTS[family] || BLUEPRINTS.song;
    const candidates = blueprintsBySize[size] || BLUEPRINTS.song.standard;
    const blueprint = candidates[rng.nextInt(candidates.length)];
    const roleSet = new Set(roles);

    const sections = blueprint.map(name => {
        const active = {};
        const archetype = ARCHETYPES[name] || {};
        for (const k of Object.keys(archetype)) {
            if (roleSet.has(k)) active[k] = true;
        }
        // Custom roles (not in archetypes) active in named sections.
        for (const r of roles) {
            if (active[r] !== undefined) continue;
            if (archetype[r]) continue;
            if (!['intro', 'outro'].includes(name)) active[r] = true;
        }
        return sectionWithPhrases(name, sectionSteps(name, size), active);
    });
    return { name: size, sections, slotMap: {} };
}

function authorSectionsToTemplate(authored, roles) {
    const sections = authored.map(a => {
        const activeSet = new Set(a.active || []);
        const active = {};
        for (const r of roles) if (activeSet.has(r)) active[r] = true;
        return sectionWithPhrases(a.name, a.steps > 0 ? a.steps : 128, active);
    });
    return { name: 'authored', sections, slotMap: {} };
}

function projectStructureToTemplate(proj) {
    const raw = proj.structure;
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const sections = raw.map(s => ({
        name: s.name,
        steps: s.steps,
        active: {},
        phrases: s.phrases || {},
    }));
    return { name: 'overlay', sections, slotMap: {} };
}

function capVariantLetters(tmpl, max) {
    if (max <= 0) return;
    const allowed = new Set();
    for (let i = 0; i < max; i++) allowed.add(String.fromCharCode(65 + i));
    for (const sec of tmpl.sections) {
        for (const role of Object.keys(sec.phrases || {})) {
            sec.phrases[role] = sec.phrases[role].map(l => allowed.has(l) ? l : 'A');
        }
    }
}

// --- Variant cloning ---------------------------------------------------

// Deep-copy via JSON round-trip. Returned as a plain object — the worker's
// parseNetBundle will promote it to a NetBundle after structured clone.
function cloneBundle(nb) {
    return JSON.parse(JSON.stringify(nb));
}

function tweakVelocity(nb, delta) {
    if (!nb || !nb.bindings) return;
    for (const b of Object.values(nb.bindings)) {
        if (!b) continue;
        let v = b.velocity + delta;
        if (v < 1) v = 1;
        if (v > 127) v = 127;
        b.velocity = v;
    }
}

function expandArrangeVariants(proj, tmpl, roles, rng, deltas) {
    tmpl.slotMap = {};
    const rolesInPhrases = new Set();
    for (const sec of tmpl.sections) {
        for (const r of Object.keys(sec.phrases || {})) rolesInPhrases.add(r);
    }

    for (const role of roles) {
        if (!rolesInPhrases.has(role)) continue;
        const baseBundle = proj.nets[role];
        if (!baseBundle) continue;
        if (isStingerNet(role, baseBundle)) continue;

        const slotMap = tmpl.sections.map(() => []);
        let slotIdx = 0;
        const letterSlots = {};

        tmpl.sections.forEach((sec, si) => {
            const phrases = (sec.phrases && sec.phrases[role]) || ['A'];
            const sectionSlots = new Array(phrases.length);
            if (sec.active[role]) {
                phrases.forEach((letter, pi) => {
                    if (letterSlots[letter] !== undefined) {
                        sectionSlots[pi] = letterSlots[letter];
                    } else {
                        letterSlots[letter] = slotIdx;
                        sectionSlots[pi] = slotIdx;
                        slotIdx++;
                    }
                });
            } else {
                for (let pi = 0; pi < phrases.length; pi++) sectionSlots[pi] = -1;
            }
            slotMap[si] = sectionSlots;
        });
        tmpl.slotMap[role] = slotMap;

        if (slotIdx <= 1) {
            baseBundle.riffGroup = role;
            baseBundle.riffVariant = 'A';
            continue;
        }

        const lettersSorted = Object.keys(letterSlots).sort();
        for (const letter of lettersSorted) {
            const idx = letterSlots[letter];
            const slotNetId = `${role}-${idx}`;
            const clone = cloneBundle(baseBundle);
            clone.riffGroup = role;
            clone.riffVariant = letter;
            const d = deltas ? deltas[letter] : undefined;
            if (d) tweakVelocity(clone, d);
            proj.nets[slotNetId] = clone;
        }
        delete proj.nets[role];
    }
}

// --- Section control nets ---------------------------------------------

function extractSlotIndex(netId, riffGroup) {
    const suffix = netId.slice(riffGroup.length + 1);
    let n = 0;
    for (const c of suffix) if (c >= '0' && c <= '9') n = n * 10 + (c.charCodeAt(0) - 48);
    return n;
}

function roleControlNet(role, slotMap, tmpl, totalSteps) {
    const ctrlAt = {};
    let prevSlot = (slotMap.length > 0 && slotMap[0].length > 0) ? slotMap[0][0] : -1;
    let pos = 0;
    tmpl.sections.forEach((sec, si) => {
        const phrases = (sec.phrases && sec.phrases[role]) || ['A'];
        const phraseLen = Math.floor(sec.steps / phrases.length);
        phrases.forEach((_, pi) => {
            const phraseStart = pos + pi * phraseLen;
            if (phraseStart === 0) return;
            let curSlot = -1;
            if (si < slotMap.length && pi < slotMap[si].length) curSlot = slotMap[si][pi];
            if (curSlot !== prevSlot) {
                if (curSlot >= 0) {
                    ctrlAt[phraseStart] = { action: 'activate-slot', targetNet: `${role}-${curSlot}`, targetNote: 0 };
                } else {
                    ctrlAt[phraseStart] = { action: 'mute-track', targetNet: `${role}-${prevSlot}`, targetNote: 0 };
                }
                prevSlot = curSlot;
            }
        });
        pos += sec.steps;
    });
    return buildControlBundle(totalSteps, { ctrlAt, sink: true });
}

function linearControlNet(targetNet, tmpl, totalSteps) {
    const ctrlAt = {};
    let wasActive = tmpl.sections[0].active[targetNet];
    let pos = 0;
    for (let si = 1; si < tmpl.sections.length; si++) {
        pos += tmpl.sections[si - 1].steps;
        const isActive = tmpl.sections[si].active[targetNet];
        if (isActive !== wasActive) {
            ctrlAt[pos] = { action: isActive ? 'unmute-track' : 'mute-track', targetNet, targetNote: 0 };
            wasActive = isActive;
        }
    }
    return buildControlBundle(totalSteps, { ctrlAt, sink: true });
}

function linearStopNet(totalSteps) {
    const ctrlAt = { [totalSteps - 1]: { action: 'stop-transport', targetNet: '', targetNote: 0 } };
    return buildControlBundle(totalSteps, { ctrlAt, sink: true });
}

function songStructure(proj, tmpl, musicNets) {
    let totalSteps = 0;
    for (const sec of tmpl.sections) totalSteps += sec.steps;
    const initialMutes = [];
    const slotRoles = new Set();
    for (const id of musicNets) {
        const nb = proj.nets[id];
        if (nb?.riffGroup) slotRoles.add(nb.riffGroup);
    }
    const processed = new Set();
    for (const id of musicNets) {
        const nb = proj.nets[id];
        if (!nb) continue;
        if (nb.riffGroup) {
            const role = nb.riffGroup;
            if (processed.has(role)) continue;
            processed.add(role);
            const slotMap = tmpl.slotMap[role] || [];
            proj.nets[`struct-${role}`] = roleControlNet(role, slotMap, tmpl, totalSteps);
            let firstSlot = -1;
            if (slotMap.length > 0 && slotMap[0].length > 0) firstSlot = slotMap[0][0];
            for (const nId of musicNets) {
                const nb2 = proj.nets[nId];
                if (nb2?.riffGroup === role) {
                    const slotIdx = extractSlotIndex(nId, role);
                    if (slotIdx !== firstSlot || firstSlot < 0) initialMutes.push(nId);
                }
            }
        } else if (!slotRoles.has(id)) {
            proj.nets[`struct-${id}`] = linearControlNet(id, tmpl, totalSteps);
            if (!tmpl.sections[0].active[id]) initialMutes.push(id);
        }
    }
    proj.nets['struct-stop'] = linearStopNet(totalSteps);

    proj.structure = tmpl.sections.map(s => {
        const out = { name: s.name, steps: s.steps };
        if (s.phrases && Object.keys(s.phrases).length > 0) out.phrases = s.phrases;
        return out;
    });
    return initialMutes;
}

// --- Feel curve / macro curve ------------------------------------------

function resolveCurvePoints(tmpl, curve, valueFn) {
    const starts = {};
    let cum = 0;
    for (const sec of tmpl.sections) {
        if (starts[sec.name] === undefined) starts[sec.name] = cum;
        cum += sec.steps;
    }
    const totalSteps = cum;
    const points = [];
    if (totalSteps === 0) return { totalSteps, points };
    for (const entry of curve) {
        const tick = starts[entry.section];
        if (tick === undefined) continue;
        const value = valueFn(entry);
        if (value) points.push({ tick, ...value });
    }
    points.sort((a, b) => a.tick - b.tick);
    return { totalSteps, points };
}

export function injectFeelCurve(proj, tmpl, curve) {
    const { totalSteps, points } = resolveCurvePoints(tmpl, curve, e =>
        ({ control: { action: 'set-feel', macroParams: { x: e.x, y: e.y } } })
    );
    if (!totalSteps || points.length === 0) return;
    const ctrlAt = {};
    for (const p of points) ctrlAt[p.tick] = p.control;
    proj.nets['feel-curve'] = buildControlBundle(totalSteps, { ctrlAt, placePrefix: 'fp', transPrefix: 'ft' });
}

export function injectMacroCurve(proj, tmpl, curve) {
    const { totalSteps, points } = resolveCurvePoints(tmpl, curve, e => {
        if (!e.macro) return null;
        const c = { action: 'fire-macro', macro: e.macro };
        if (e.bars > 0) c.macroBars = e.bars;
        return { control: c };
    });
    if (!totalSteps || points.length === 0) return;
    const ctrlAt = {};
    for (const p of points) ctrlAt[p.tick] = p.control;
    proj.nets['macro-curve'] = buildControlBundle(totalSteps, { ctrlAt, placePrefix: 'mp', transPrefix: 'mt' });
}

// --- Fade in / fade out / drum break (original exports kept) ----------

function fadeControlNet(targetNet, action, steps, hitPos) {
    if (hitPos >= steps) hitPos = steps - 1;
    const ctrlAt = { [hitPos]: { action, targetNet, targetNote: 0 } };
    return buildControlBundle(steps, { ctrlAt });
}

export function fadeIn(proj, targets, steps, _seed) {
    if (steps < 8) steps = 32;
    const mutedNets = [];
    targets.forEach((target, i) => {
        if (!proj.nets[target]) return;
        mutedNets.push(target);
        const offset = (i + 1) * Math.floor(steps / (targets.length + 1));
        proj.nets[`fade-in-${target}`] = fadeControlNet(target, 'unmute-track', steps, offset);
    });
    return mutedNets;
}

export function fadeOut(proj, targets, steps, _seed) {
    if (steps < 8) steps = 32;
    targets.forEach((target, i) => {
        if (!proj.nets[target]) return;
        const offset = steps - (targets.length - i) * Math.floor(steps / (targets.length + 1));
        proj.nets[`fade-out-${target}`] = fadeControlNet(target, 'mute-track', steps, offset);
    });
}

export function drumBreak(proj, targets, cycleLen, breakLen, _seed) {
    if (cycleLen < 16) cycleLen = 64;
    if (breakLen < 4) breakLen = 8;
    if (breakLen >= cycleLen) breakLen = Math.floor(cycleLen / 4);
    const mutePos = Math.floor(cycleLen / 2);
    const unmutePos = (mutePos + breakLen) % cycleLen;
    for (const target of targets) {
        if (!proj.nets[target]) continue;
        const ctrlAt = {
            [mutePos]:   { action: 'mute-track',   targetNet: target, targetNote: 0 },
            [unmutePos]: { action: 'unmute-track', targetNet: target, targetNote: 0 },
        };
        proj.nets[`break-${target}`] = buildControlBundle(cycleLen, { ctrlAt });
    }
}

// --- Overlays (shared between full + overlay-only modes) --------------

function applyArrangeOverlays(proj, tmpl, allNets, opts) {
    if (opts.fadeIn && opts.fadeIn.length > 0) {
        let introSteps = 128;
        if (tmpl.sections.length > 0) introSteps = tmpl.sections[0].steps;
        const variantTargets = [];
        for (const role of opts.fadeIn) {
            for (const id of allNets) {
                if (id === role || (id.length > role.length && id.slice(0, role.length + 1) === role + '-')) {
                    variantTargets.push(id);
                }
            }
        }
        if (variantTargets.length > 0) {
            const added = fadeIn(proj, variantTargets, introSteps, opts.seed || 0);
            proj.initialMutes = [...(proj.initialMutes || []), ...added];
        }
    }

    if (opts.drumBreak > 0) {
        const drumTargets = [];
        for (const id of allNets) {
            const nb = proj.nets[id];
            if (!nb || isDrumRoleName(id) || isStingerNet(id, nb)) continue;
            drumTargets.push(id);
        }
        let totalSteps = 0;
        for (const sec of tmpl.sections) totalSteps += sec.steps;
        if (totalSteps > 0) drumBreak(proj, drumTargets, totalSteps, opts.drumBreak * 16, opts.seed || 0);
    }

    if (opts.feelCurve  && opts.feelCurve.length  > 0) injectFeelCurve(proj, tmpl, opts.feelCurve);
    if (opts.macroCurve && opts.macroCurve.length > 0) injectMacroCurve(proj, tmpl, opts.macroCurve);
}

// --- Canonical entry point --------------------------------------------

/**
 * arrangeWithOpts — full-parity port of Go's ArrangeWithOpts.
 * Mutates `proj` in place.
 *
 * opts: {
 *   seed: int,
 *   velocityDeltas: { A:0, B:15, C:-15, ... },
 *   maxVariants: int,
 *   fadeIn: [role, ...],
 *   drumBreak: bars,
 *   sections: [{name, steps, active}, ...],
 *   feelCurve: [{section, x, y}, ...],
 *   macroCurve: [{section, macro, bars}, ...],
 *   overlayOnly: bool,
 * }
 */
export function arrangeWithOpts(proj, genre, size, opts = {}) {
    proj.nets = proj.nets || {};

    if (opts.overlayOnly) {
        const tmpl = projectStructureToTemplate(proj);
        if (!tmpl) return;
        applyArrangeOverlays(proj, tmpl, sortedMusicNetIDs(proj), opts);
        return;
    }

    const rng = createRng(opts.seed || 0);
    const musicRoles = sortedMusicNetIDs(proj);

    let tmpl;
    if (opts.sections && opts.sections.length > 0) {
        tmpl = authorSectionsToTemplate(opts.sections, musicRoles);
    } else {
        tmpl = generateArrangeStructure(genre || 'wrapped', size || 'standard', musicRoles, rng);
    }
    if (opts.maxVariants > 0) capVariantLetters(tmpl, opts.maxVariants);

    const deltas = opts.velocityDeltas || { A: 0, B: 15, C: -15 };
    expandArrangeVariants(proj, tmpl, musicRoles, rng, deltas);

    const allNets = sortedMusicNetIDs(proj);
    const initialMutes = songStructure(proj, tmpl, allNets);
    proj.initialMutes = initialMutes;

    applyArrangeOverlays(proj, tmpl, allNets, opts);
}

export function arrange(proj, genre, size) {
    arrangeWithOpts(proj, genre, size, { seed: (Date.now() & 0x7fffffff) });
}

export function arrangeSeeded(proj, genre, size, seed) {
    arrangeWithOpts(proj, genre, size, { seed });
}
