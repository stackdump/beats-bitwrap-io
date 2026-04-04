/**
 * structure.js — Port of Go structure.go
 * Song templates, section archetypes, genre families, structure blueprints,
 * and linear control nets for song arrangement.
 */

import { ringLayout } from './euclidean.js';
import { NetBundle } from '../pflow.js';

// --- Section archetypes: active roles per section type ---

const sectionArchetypes = {
    'intro':      { kick: true, hihat: true, bass: true },
    'verse':      { kick: true, snare: true, hihat: true, bass: true },
    'pre-chorus': { kick: true, snare: true, hihat: true, bass: true, arp: true },
    'chorus':     { kick: true, snare: true, hihat: true, bass: true, melody: true, harmony: true, arp: true, clap: true },
    'drop':       { kick: true, snare: true, hihat: true, bass: true, melody: true, harmony: true, arp: true, clap: true },
    'buildup':    { kick: true, snare: true, hihat: true, bass: true, arp: true },
    'breakdown':  { hihat: true, bass: true, melody: true },
    'bridge':     { bass: true, melody: true, harmony: true },
    'solo':       { kick: true, hihat: true, bass: true, melody: true },
    'outro':      { kick: true, hihat: true, melody: true },
};

// --- Drum roles and no-variant roles ---

const drumRoles = { kick: true, snare: true, hihat: true, clap: true };

const noVariantRoles = { snare: true };

// --- Genre families ---

const familyEDM = 0;
const familySong = 1;
const familyJazz = 2;
const familyChill = 3;

const genreFamilies = {
    techno:    familyEDM,
    house:     familyEDM,
    edm:       familyEDM,
    trance:    familyEDM,
    dnb:       familyEDM,
    dubstep:   familyEDM,
    speedcore: familyEDM,
    garage:    familyEDM,
    trap:      familyEDM,
    country:   familySong,
    blues:     familySong,
    funk:      familySong,
    reggae:    familySong,
    synthwave: familySong,
    metal:     familySong,
    jazz:      familyJazz,
    bossa:     familyJazz,
    ambient:   familyChill,
    lofi:      familyChill,
};

// --- Structure blueprints ---

const structureBlueprints = {
    [familyEDM]: {
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
    [familySong]: {
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
    [familyJazz]: {
        minimal: [
            ['intro', 'verse', 'solo', 'outro'],
            ['intro', 'verse', 'verse', 'outro'],
        ],
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
        ab: [
            ['verse', 'solo', 'verse', 'solo'],
            ['verse', 'bridge', 'verse', 'solo'],
        ],
        drop: [
            ['verse', 'solo', 'verse', 'solo', 'verse'],
            ['solo', 'verse', 'bridge', 'solo', 'verse'],
        ],
        build: [
            ['verse', 'verse', 'solo', 'verse', 'solo', 'solo'],
        ],
        jam: [
            ['verse', 'solo', 'solo', 'bridge', 'solo', 'verse'],
            ['solo', 'bridge', 'solo', 'verse', 'solo'],
            ['verse', 'solo', 'verse', 'bridge', 'solo', 'solo'],
        ],
    },
    [familyChill]: {
        minimal: [
            ['intro', 'verse', 'verse', 'outro'],
            ['intro', 'verse', 'bridge', 'outro'],
        ],
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
        ab: [
            ['verse', 'bridge', 'verse', 'bridge'],
            ['verse', 'breakdown', 'verse', 'bridge'],
        ],
        drop: [
            ['verse', 'breakdown', 'verse', 'breakdown', 'verse'],
            ['verse', 'bridge', 'breakdown', 'verse', 'bridge'],
        ],
        build: [
            ['verse', 'verse', 'bridge', 'verse', 'chorus'],
            ['breakdown', 'verse', 'bridge', 'verse', 'chorus'],
        ],
        jam: [
            ['verse', 'bridge', 'verse', 'breakdown', 'verse'],
            ['verse', 'verse', 'bridge', 'breakdown', 'verse', 'bridge'],
        ],
    },
};

// --- sectionSteps ---

/**
 * Returns step count for a section at a given template size.
 * @param {string} name - section name
 * @param {string} size - 'minimal', 'standard', or 'extended'
 * @returns {number}
 */
function sectionSteps(name, size) {
    switch (size) {
    case 'minimal':
        switch (name) {
        case 'intro': case 'outro':
            return 32;
        default:
            return 128;
        }
    case 'extended':
        switch (name) {
        case 'intro': case 'outro': case 'breakdown': case 'bridge':
        case 'buildup': case 'pre-chorus': case 'solo':
            return 128;
        default:
            return 192;
        }
    default: // standard
        switch (name) {
        case 'intro': case 'outro': case 'breakdown': case 'bridge':
        case 'pre-chorus': case 'solo':
            return 64;
        default:
            return 192;
        }
    }
}

// --- defaultPhrases ---

/**
 * Returns default phrase variant patterns for a given section type.
 * @param {string} sectionName
 * @returns {string[]}
 */
export function defaultPhrases(sectionName) {
    switch (sectionName) {
    case 'intro': case 'outro':
        return ['A', 'A'];
    case 'verse':
        return ['A', 'A', 'B', 'A'];
    case 'chorus': case 'drop':
        return ['A', 'B', 'A', 'B'];
    case 'bridge': case 'breakdown':
        return ['C', 'C'];
    case 'buildup': case 'pre-chorus':
        return ['A', 'B'];
    case 'solo':
        return ['A', 'B', 'C', 'A'];
    default:
        return ['A', 'A'];
    }
}

// --- sectionWithPhrases (internal) ---

function sectionWithPhrases(name, steps, active) {
    const phrases = {};
    const pattern = defaultPhrases(name);
    for (const role of Object.keys(active)) {
        if (noVariantRoles[role]) continue;
        phrases[role] = pattern.slice();
    }
    return { name, steps, active: { ...active }, phrases };
}

// --- generateStructure ---

/**
 * Creates a randomized SongTemplate appropriate for the genre.
 * @param {string} genreName
 * @param {string} size - 'minimal', 'standard', 'extended', 'ab', 'drop', 'build', 'jam'
 * @param {{ float64: Function }} rng
 * @returns {{ name: string, sections: Array, slotMap: object }}
 */
export function generateStructure(genreName, size, rng) {
    const family = genreFamilies[genreName] !== undefined ? genreFamilies[genreName] : familySong;
    const familyBlueprints = structureBlueprints[family] || {};
    let blueprints = familyBlueprints[size];
    if (!blueprints) {
        blueprints = (structureBlueprints[familySong] || {}).standard || [['verse', 'chorus']];
    }

    const blueprint = blueprints[Math.floor(rng.float64() * blueprints.length)];

    const sections = blueprint.map(name => {
        const active = {};
        const archetype = sectionArchetypes[name];
        if (archetype) {
            for (const k of Object.keys(archetype)) {
                active[k] = archetype[k];
            }
        }
        const steps = sectionSteps(name, size);
        return sectionWithPhrases(name, steps, active);
    });

    return {
        name: size,
        sections,
        slotMap: {},
    };
}

// --- SongTemplates (preset fallbacks) ---

export const SongTemplates = {
    standard: {
        name: 'standard',
        sections: [
            sectionWithPhrases('intro', 64, sectionArchetypes['intro']),
            sectionWithPhrases('verse', 192, sectionArchetypes['verse']),
            sectionWithPhrases('chorus', 192, sectionArchetypes['chorus']),
            sectionWithPhrases('breakdown', 64, sectionArchetypes['breakdown']),
            sectionWithPhrases('verse', 192, sectionArchetypes['verse']),
            sectionWithPhrases('chorus', 192, sectionArchetypes['chorus']),
            sectionWithPhrases('outro', 64, sectionArchetypes['outro']),
        ],
        slotMap: {},
    },
    minimal: {
        name: 'minimal',
        sections: [
            sectionWithPhrases('intro', 32, sectionArchetypes['intro']),
            sectionWithPhrases('verse', 128, sectionArchetypes['verse']),
            sectionWithPhrases('chorus', 128, sectionArchetypes['chorus']),
            sectionWithPhrases('outro', 32, sectionArchetypes['outro']),
        ],
        slotMap: {},
    },
    extended: {
        name: 'extended',
        sections: [
            sectionWithPhrases('intro', 128, sectionArchetypes['intro']),
            sectionWithPhrases('buildup', 128, sectionArchetypes['buildup']),
            sectionWithPhrases('drop', 192, sectionArchetypes['drop']),
            sectionWithPhrases('breakdown', 128, sectionArchetypes['breakdown']),
            sectionWithPhrases('verse', 192, sectionArchetypes['verse']),
            sectionWithPhrases('buildup', 128, sectionArchetypes['buildup']),
            sectionWithPhrases('drop', 192, sectionArchetypes['drop']),
            sectionWithPhrases('bridge', 128, sectionArchetypes['bridge']),
            sectionWithPhrases('chorus', 192, sectionArchetypes['chorus']),
            sectionWithPhrases('outro', 128, sectionArchetypes['outro']),
        ],
        slotMap: {},
    },
};

// --- extractSlotIndex ---

/**
 * Parses a slot index from a net ID like "kick-3" -> 3.
 * @param {string} netId
 * @param {string} riffGroup
 * @returns {number}
 */
export function extractSlotIndex(netId, riffGroup) {
    const suffix = netId.substring(riffGroup.length + 1);
    let idx = 0;
    for (let i = 0; i < suffix.length; i++) {
        const c = suffix.charCodeAt(i);
        if (c >= 48 && c <= 57) { // '0'-'9'
            idx = idx * 10 + (c - 48);
        }
    }
    return idx;
}

// --- Accumulator control net ---
//
// Compact alternative to linear chains. A self-loop clock adds 1 token per tick
// to a counter place. Each control transition consumes N tokens from the counter,
// where N is the tick gap since the previous event. This reduces a 1536-step chain
// to ~10 nodes for a typical song.
//
// Layout:
//   p_clock(1) → t_clock → p_clock  (self-loop)
//                    ↓ (weight 1)
//                p_counter
//                    ↓ (weight = gap)
//              t_ctrl_0, t_ctrl_1, ...

function buildAccumulatorNet(events) {
    const bundle = new NetBundle();
    const controlBindings = {};

    if (events.length === 0) {
        bundle.places['p0'] = { initial: [1], x: 0, y: 0 };
        bundle.transitions['t0'] = { x: 0, y: 0 };
        bundle.arcs.push(
            { source: 'p0', target: 't0', weight: [1], inhibit: false },
            { source: 't0', target: 'p0', weight: [1], inhibit: false },
        );
        bundle.track = { channel: 1, defaultVelocity: 100, instrument: '', instrumentSet: [] };
        bundle.role = 'control';
        bundle.buildArcIndex();
        bundle.resetState();
        return bundle;
    }

    events.sort((a, b) => a.tick - b.tick);

    // Design: countdown timers chained by gate tokens.
    //
    // Each event i has:
    //   p_delay_i — starts with gap tokens, drained 1/tick by t_drain_i
    //   p_gate_i  — 1 token when this stage is active (enables drain + control)
    //   t_drain_i — consumes 1 from delay + borrows gate (returns it)
    //   t_ctrl_i  — fires when delay=0 (inhibitor), consumes gate, passes gate to next
    //
    // t_drain_i: enabled when p_delay_i >= 1 AND p_gate_i >= 1
    //   consumes: 1 from p_delay_i, 1 from p_gate_i
    //   produces: 1 to p_gate_i (return gate)
    //
    // t_ctrl_i: enabled when p_delay_i < 1 (inhibitor) AND p_gate_i >= 1
    //   consumes: 1 from p_gate_i
    //   produces: 1 to p_gate_{i+1} (advance to next stage)

    const n = events.length;
    let prevTick = 0;

    for (let i = 0; i < n; i++) {
        const ev = events[i];
        const gap = ev.tick - prevTick;
        const pDelay = `p_delay_${i}`;
        const pGate = `p_gate_${i}`;
        const tDrain = `t_drain_${i}`;
        const tCtrl = `t_ctrl_${i}`;

        bundle.places[pDelay] = { initial: [gap], x: 0, y: 0 };
        bundle.places[pGate] = { initial: [i === 0 ? 1 : 0], x: 0, y: 0 };

        // Drain: eats 1 from delay each tick while gate is held
        bundle.transitions[tDrain] = { x: 0, y: 0 };
        bundle.arcs.push(
            { source: pDelay, target: tDrain, weight: [1], inhibit: false },
            { source: pGate, target: tDrain, weight: [1], inhibit: false },
            { source: tDrain, target: pGate, weight: [1], inhibit: false },
        );

        // Control: fires when delay is empty (inhibitor) and gate is held
        bundle.transitions[tCtrl] = { x: 0, y: 0 };
        bundle.arcs.push(
            { source: pDelay, target: tCtrl, weight: [1], inhibit: true },
            { source: pGate, target: tCtrl, weight: [1], inhibit: false },
        );

        // Pass gate to next stage
        if (i < n - 1) {
            bundle.arcs.push(
                { source: tCtrl, target: `p_gate_${i + 1}`, weight: [1], inhibit: false },
            );
        }

        controlBindings[tCtrl] = ev.binding;
        prevTick = ev.tick;
    }

    bundle.track = { channel: 1, defaultVelocity: 100, instrument: '', instrumentSet: [] };
    bundle.role = 'control';
    bundle.controlBindings = controlBindings;

    bundle.buildArcIndex();
    bundle.resetState();
    return bundle;
}

// --- roleControlNet (internal) ---

/**
 * Creates a compact control net for a role with activate-slot at phrase boundaries.
 * @param {string} role
 * @param {number[][]} slotMap - [sectionIdx][phraseIdx] -> global slot index (-1 = inactive)
 * @param {object} template
 * @param {number} totalSteps
 * @returns {NetBundle}
 */
function roleControlNet(role, slotMap, template, totalSteps) {
    // Collect control events with their tick positions
    const events = []; // { tick, binding }
    let prevSlot = -1;
    if (slotMap && slotMap.length > 0 && slotMap[0] && slotMap[0].length > 0) {
        prevSlot = slotMap[0][0];
    }

    let pos = 0;
    for (let si = 0; si < template.sections.length; si++) {
        const sec = template.sections[si];
        let phrases = sec.phrases[role];
        if (!phrases || phrases.length === 0) {
            phrases = ['A'];
        }
        const phraseLen = Math.floor(sec.steps / phrases.length);

        for (let pi = 0; pi < phrases.length; pi++) {
            const phraseStart = pos + pi * phraseLen;
            if (phraseStart === 0) continue;

            let curSlot = -1;
            if (slotMap && si < slotMap.length && slotMap[si] && pi < slotMap[si].length) {
                curSlot = slotMap[si][pi];
            }

            if (curSlot !== prevSlot) {
                if (curSlot >= 0) {
                    events.push({ tick: phraseStart, binding: {
                        action: 'activate-slot',
                        targetNet: `${role}-${curSlot}`,
                        targetNote: 0,
                    }});
                } else {
                    events.push({ tick: phraseStart, binding: {
                        action: 'mute-track',
                        targetNet: `${role}-${prevSlot}`,
                        targetNote: 0,
                    }});
                }
                prevSlot = curSlot;
            }
        }
        pos += sec.steps;
    }

    return buildAccumulatorNet(events);
}

// --- linearControlNet (internal) ---

/**
 * Creates a linear chain with mute/unmute at section boundaries.
 * @param {string} targetNet
 * @param {object} template
 * @param {number} totalSteps
 * @returns {NetBundle}
 */
function linearControlNet(targetNet, template, totalSteps) {
    const events = [];
    let wasActive = template.sections[0].active[targetNet] || false;
    let pos = 0;
    for (let si = 1; si < template.sections.length; si++) {
        pos += template.sections[si - 1].steps;
        const isActive = template.sections[si].active[targetNet] || false;
        if (isActive !== wasActive) {
            events.push({ tick: pos, binding: {
                action: isActive ? 'unmute-track' : 'mute-track',
                targetNet,
                targetNote: 0,
            }});
            wasActive = isActive;
        }
    }

    return buildAccumulatorNet(events);
}

// --- linearStopNet (internal) ---

/**
 * Creates a linear chain where the final transition fires stop-transport.
 * @param {number} totalSteps
 * @returns {NetBundle}
 */
function linearStopNet(totalSteps) {
    return buildAccumulatorNet([{
        tick: totalSteps,
        binding: { action: 'stop-transport', targetNet: '', targetNote: 0 },
    }]);
}

// --- songStructure ---

/**
 * Builds linear control nets that implement a song structure.
 * For roles with slot variants, creates one control net per role using activate-slot.
 * A stop net fires stop-transport at the end.
 * @param {object} proj - project with .nets map
 * @param {object} template - SongTemplate { name, sections, slotMap }
 * @param {string[]} musicNets - net IDs to manage
 * @returns {string[]} net IDs that should start muted
 */
export function songStructure(proj, template, musicNets) {
    let totalSteps = 0;
    for (const sec of template.sections) {
        totalSteps += sec.steps;
    }

    const initialMutes = [];

    // Build set of base roles that have slot variants
    const slotRoles = new Set();
    for (const netId of musicNets) {
        const nb = proj.nets[netId];
        if (nb && nb.riffGroup) {
            slotRoles.add(nb.riffGroup);
        }
    }

    // Build one control net per role (using SlotMap)
    const processedRoles = new Set();
    for (const netId of musicNets) {
        const nb = proj.nets[netId];
        if (!nb) continue;

        if (nb.riffGroup) {
            const role = nb.riffGroup;
            if (processedRoles.has(role)) continue;
            processedRoles.add(role);

            const slotMap = (template.slotMap && template.slotMap[role]) || [];
            const ctrl = roleControlNet(role, slotMap, template, totalSteps);
            proj.nets[`struct-${role}`] = ctrl;

            // Determine initial mutes: all slot nets start muted except the first active one
            let firstSlot = -1;
            if (slotMap.length > 0 && slotMap[0] && slotMap[0].length > 0) {
                firstSlot = slotMap[0][0];
            }
            for (const nId of musicNets) {
                const nb2 = proj.nets[nId];
                if (nb2 && nb2.riffGroup === role) {
                    const slotIdx = extractSlotIndex(nId, role);
                    if (slotIdx !== firstSlot || firstSlot < 0) {
                        initialMutes.push(nId);
                    }
                }
            }
        } else if (!slotRoles.has(netId)) {
            // Non-variant net — use section-boundary control
            const ctrl = linearControlNet(netId, template, totalSteps);
            proj.nets[`struct-${netId}`] = ctrl;

            if (!template.sections[0].active[netId]) {
                initialMutes.push(netId);
            }
        }
    }

    // Stop net
    proj.nets['struct-stop'] = linearStopNet(totalSteps);

    // Store structure metadata for timeline display
    proj.structure = template.sections.map(sec => {
        const ss = { name: sec.name, steps: sec.steps };
        if (sec.phrases && Object.keys(sec.phrases).length > 0) {
            ss.phrases = {};
            for (const [role, phrases] of Object.entries(sec.phrases)) {
                ss.phrases[role] = phrases.slice();
            }
        }
        return ss;
    });

    return initialMutes;
}

/**
 * Rebuild control nets from a project's serialized structure.
 * Used after crop to recreate mute/unmute, activate-slot, and stop-transport
 * control nets so the cropped track behaves like a freshly generated one.
 *
 * @param {object} proj - parsed project with .nets and .structure
 * @returns {string[]} net IDs that should start muted
 */
export function rebuildControlNets(proj) {
    const structure = proj.structure;
    if (!structure || structure.length === 0) return [];

    const totalSteps = structure.reduce((s, sec) => s + sec.steps, 0);

    // Identify music nets and group by role
    const netRoles = {};      // netId → base role
    const riffGroups = {};    // role → [netId, ...]
    const simpleNets = [];    // netIds without riff groups

    for (const [id, net] of Object.entries(proj.nets)) {
        if (net.role === 'control') continue;
        const role = net.riffGroup || id;
        netRoles[id] = role;
        if (net.riffGroup) {
            if (!riffGroups[role]) riffGroups[role] = [];
            riffGroups[role].push(id);
        } else {
            simpleNets.push(id);
        }
    }

    // Determine which roles are active in each section
    // A role is active if it appears in section.phrases or in the section archetype
    function isRoleActive(sec, role) {
        if (sec.phrases && sec.phrases[role]) return true;
        const arch = sectionArchetypes[sec.name];
        if (arch && arch[role]) return true;
        return false;
    }

    const initialMutes = [];

    // Simple nets (no riff group): mute/unmute at section boundaries
    for (const netId of simpleNets) {
        const role = netRoles[netId];
        const events = [];
        let wasActive = isRoleActive(structure[0], role);
        let pos = 0;

        for (let si = 1; si < structure.length; si++) {
            pos += structure[si - 1].steps;
            const active = isRoleActive(structure[si], role);
            if (active !== wasActive) {
                events.push({ tick: pos, binding: {
                    action: active ? 'unmute-track' : 'mute-track',
                    targetNet: netId,
                    targetNote: 0,
                }});
                wasActive = active;
            }
        }

        if (events.length > 0) {
            proj.nets[`struct-${netId}`] = buildAccumulatorNet(events);
        }

        if (!isRoleActive(structure[0], role)) {
            initialMutes.push(netId);
        }
    }

    // Riff groups: activate-slot at phrase boundaries
    for (const [role, netIds] of Object.entries(riffGroups)) {
        const events = [];
        // Map phrase letters to slot indices: A→0, B→1, C→2
        let prevSlot = -1;
        let pos = 0;

        for (let si = 0; si < structure.length; si++) {
            const sec = structure[si];
            const phrases = (sec.phrases && sec.phrases[role]) || [];

            if (phrases.length === 0) {
                // Role not active in this section — mute it
                if (prevSlot >= 0 && pos > 0) {
                    events.push({ tick: pos, binding: {
                        action: 'mute-track',
                        targetNet: `${role}-${prevSlot}`,
                        targetNote: 0,
                    }});
                    prevSlot = -1;
                }
                pos += sec.steps;
                continue;
            }

            const phraseLen = Math.floor(sec.steps / phrases.length);

            for (let pi = 0; pi < phrases.length; pi++) {
                const phraseStart = pos + pi * phraseLen;
                // Convert letter to slot: 'A'→0, 'B'→1, 'C'→2
                const letter = phrases[pi];
                const slot = letter ? letter.charCodeAt(0) - 65 : 0;

                if (slot !== prevSlot) {
                    if (phraseStart > 0) {
                        if (slot >= 0) {
                            events.push({ tick: phraseStart, binding: {
                                action: 'activate-slot',
                                targetNet: `${role}-${slot}`,
                                targetNote: 0,
                            }});
                        } else if (prevSlot >= 0) {
                            events.push({ tick: phraseStart, binding: {
                                action: 'mute-track',
                                targetNet: `${role}-${prevSlot}`,
                                targetNote: 0,
                            }});
                        }
                    }
                    prevSlot = slot;
                }
            }
            pos += sec.steps;
        }

        if (events.length > 0) {
            proj.nets[`struct-${role}`] = buildAccumulatorNet(events);
        }

        // Initial mutes: all slots muted except the first active one
        const firstSec = structure[0];
        const firstPhrases = (firstSec.phrases && firstSec.phrases[role]) || [];
        const firstSlot = firstPhrases.length > 0 ? (firstPhrases[0].charCodeAt(0) - 65) : -1;

        for (const nId of netIds) {
            const slotIdx = extractSlotIndex(nId, role);
            if (slotIdx !== firstSlot || firstSlot < 0) {
                initialMutes.push(nId);
            }
        }
    }

    // Stop net
    proj.nets['struct-stop'] = linearStopNet(totalSteps);

    return initialMutes;
}
