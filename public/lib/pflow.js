/**
 * pflow.js — Discrete Petri net engine for beats-bitwrap-io.
 * Port of internal/pflow/adapter.go + go-pflow/petri types.
 */

// --- Arc weight helper ---
function weightSum(w) {
    if (!w || !w.length) return 1;
    let s = 0;
    for (let i = 0; i < w.length; i++) s += w[i];
    return s;
}

// --- NetBundle: wraps a parsed net with precomputed arc indices ---
export class NetBundle {
    constructor() {
        this.places = {};       // label -> { initial: [float], x, y, label? }
        this.transitions = {};  // label -> { x, y, label? }
        this.arcs = [];         // [{ source, target, weight: [float], inhibit: bool }]
        this.track = { channel: 1, defaultVelocity: 100, instrument: '', instrumentSet: [] };
        this.role = 'music';
        this.riffGroup = '';
        this.riffVariant = '';
        this.bindings = {};        // transLabel -> { note, channel, velocity, duration }
        this.controlBindings = {}; // transLabel -> { action, targetNet, targetNote }
        this.state = {};           // placeLabel -> float (mutable runtime state)

        // Precomputed arc indices (built after parsing)
        this.inputArcs = {};   // transLabel -> [{ source, target, weightSum, inhibit }]
        this.outputArcs = {};  // transLabel -> [{ source, target, weightSum, inhibit }]
    }

    buildArcIndex() {
        this.inputArcs = {};
        this.outputArcs = {};
        for (const arc of this.arcs) {
            const ca = {
                source: arc.source,
                target: arc.target,
                weightSum: weightSum(arc.weight),
                inhibit: !!arc.inhibit,
            };
            // Input arcs: arcs whose target is a transition
            if (!this.inputArcs[arc.target]) this.inputArcs[arc.target] = [];
            this.inputArcs[arc.target].push(ca);
            // Output arcs: arcs whose source is a transition
            if (!this.outputArcs[arc.source]) this.outputArcs[arc.source] = [];
            this.outputArcs[arc.source].push(ca);
        }
    }

    resetState() {
        this.state = {};
        for (const [label, place] of Object.entries(this.places)) {
            const init = place.initial || [0];
            let s = 0;
            for (let i = 0; i < init.length; i++) s += init[i];
            this.state[label] = s;
        }
    }

    isEnabled(transLabel) {
        const inputs = this.inputArcs[transLabel];
        if (!inputs) return false;
        for (const ca of inputs) {
            const tokens = this.state[ca.source] || 0;
            if (ca.inhibit) {
                if (tokens >= ca.weightSum) return false;
            } else {
                if (tokens < ca.weightSum) return false;
            }
        }
        return true;
    }

    fire(transLabel) {
        // Consume inputs
        const inputs = this.inputArcs[transLabel];
        if (inputs) {
            for (const ca of inputs) {
                if (!ca.inhibit) {
                    this.state[ca.source] = (this.state[ca.source] || 0) - ca.weightSum;
                    if (this.state[ca.source] < 0) this.state[ca.source] = 0;
                }
            }
        }
        // Produce outputs
        const outputs = this.outputArcs[transLabel];
        if (outputs) {
            for (const ca of outputs) {
                this.state[ca.target] = (this.state[ca.target] || 0) + ca.weightSum;
            }
        }
        return {
            midi: this.bindings[transLabel] || null,
            control: this.controlBindings[transLabel] || null,
        };
    }

    getInputArcs(transLabel) {
        return this.inputArcs[transLabel] || [];
    }

    transitionLabels() {
        return Object.keys(this.transitions);
    }
}

// --- Parse helpers ---
function getString(m, key, def) {
    return typeof m[key] === 'string' ? m[key] : def;
}
function getFloat(m, key, def) {
    const v = m[key];
    return typeof v === 'number' ? v : def;
}
function getInt(m, key, def) {
    const v = m[key];
    return typeof v === 'number' ? Math.round(v) : def;
}
function getBool(m, key, def) {
    return typeof m[key] === 'boolean' ? m[key] : def;
}
function getFloatArray(m, key, def) {
    const arr = m[key];
    if (Array.isArray(arr)) return arr.map(v => typeof v === 'number' ? v : 0);
    return def;
}

// --- Parse a net bundle from JSON ---
function parseNetBundle(data) {
    const nb = new NetBundle();
    nb.role = getString(data, 'role', 'music');
    nb.riffGroup = getString(data, 'riffGroup', '');
    nb.riffVariant = getString(data, 'riffVariant', '');

    // Track
    const t = data.track || {};
    nb.track = {
        channel: getInt(t, 'channel', 1),
        defaultVelocity: getInt(t, 'defaultVelocity', 100),
        instrument: getString(t, 'instrument', ''),
        instrumentSet: Array.isArray(t.instrumentSet) ? t.instrumentSet : [],
    };
    // Mix settings passthrough
    if (t.mix) nb.track.mix = t.mix;

    // Places
    if (data.places && typeof data.places === 'object') {
        for (const [id, pData] of Object.entries(data.places)) {
            nb.places[id] = {
                initial: getFloatArray(pData, 'initial', [0]),
                x: getFloat(pData, 'x', 0),
                y: getFloat(pData, 'y', 0),
            };
            if (pData.label) nb.places[id].label = pData.label;
        }
    }

    // Transitions
    if (data.transitions && typeof data.transitions === 'object') {
        for (const [id, tData] of Object.entries(data.transitions)) {
            nb.transitions[id] = {
                x: getFloat(tData, 'x', 0),
                y: getFloat(tData, 'y', 0),
            };
            if (tData.label) nb.transitions[id].label = tData.label;

            // MIDI binding
            if (tData.midi && typeof tData.midi === 'object') {
                nb.bindings[id] = {
                    note: getInt(tData.midi, 'note', 60),
                    channel: getInt(tData.midi, 'channel', nb.track.channel),
                    velocity: getInt(tData.midi, 'velocity', nb.track.defaultVelocity),
                    duration: getInt(tData.midi, 'duration', 100),
                };
            }

            // Control binding
            if (tData.control && typeof tData.control === 'object') {
                nb.controlBindings[id] = {
                    action: getString(tData.control, 'action', 'toggle-track'),
                    targetNet: getString(tData.control, 'targetNet', ''),
                    targetNote: getInt(tData.control, 'targetNote', 0),
                };
            }
        }
    }

    // Arcs
    if (Array.isArray(data.arcs)) {
        for (const aData of data.arcs) {
            nb.arcs.push({
                source: getString(aData, 'source', ''),
                target: getString(aData, 'target', ''),
                weight: getFloatArray(aData, 'weight', [1]),
                inhibit: getBool(aData, 'inhibit', false),
            });
        }
    }

    nb.buildArcIndex();
    nb.resetState();
    return nb;
}

// --- Parse a full project from JSON ---
export function parseProject(data) {
    const proj = {
        name: getString(data, 'name', 'Untitled'),
        tempo: getFloat(data, 'tempo', 120),
        swing: getFloat(data, 'swing', 0),
        humanize: getFloat(data, 'humanize', 0),
        nets: {},
        connections: [],
        initialMutes: [],
        structure: [],
    };

    if (data.nets && typeof data.nets === 'object') {
        for (const [netId, netData] of Object.entries(data.nets)) {
            if (netData && typeof netData === 'object') {
                proj.nets[netId] = parseNetBundle(netData);
            }
        }
    }

    // Structure sections
    if (Array.isArray(data.structure)) {
        for (const s of data.structure) {
            if (!s || typeof s !== 'object') continue;
            const ss = {
                name: getString(s, 'name', ''),
                steps: Math.round(getFloat(s, 'steps', 0)),
                phrases: {},
            };
            if (s.phrases && typeof s.phrases === 'object') {
                for (const [role, arr] of Object.entries(s.phrases)) {
                    if (Array.isArray(arr)) {
                        ss.phrases[role] = arr.filter(v => typeof v === 'string');
                    }
                }
            }
            proj.structure.push(ss);
        }
    }

    // Initial mutes
    if (Array.isArray(data.initialMutes)) {
        proj.initialMutes = data.initialMutes.filter(v => typeof v === 'string');
    }

    return proj;
}

// --- Serialize project back to JSON ---
export function projectToJSON(proj) {
    const result = {
        name: proj.name,
        tempo: proj.tempo,
        nets: {},
    };
    if (proj.swing > 0) result.swing = proj.swing;
    if (proj.humanize > 0) result.humanize = proj.humanize;

    for (const [netId, nb] of Object.entries(proj.nets)) {
        result.nets[netId] = bundleToJSON(nb);
    }

    if (proj.initialMutes && proj.initialMutes.length > 0) {
        result.initialMutes = proj.initialMutes;
    }

    if (proj.structure && proj.structure.length > 0) {
        result.structure = proj.structure.map(sec => {
            const s = { name: sec.name, steps: sec.steps };
            if (sec.phrases && Object.keys(sec.phrases).length > 0) {
                s.phrases = sec.phrases;
            }
            return s;
        });
    }

    return result;
}

function bundleToJSON(nb) {
    const trackMap = {
        channel: nb.track.channel,
        defaultVelocity: nb.track.defaultVelocity,
    };
    if (nb.track.instrument) trackMap.instrument = nb.track.instrument;
    if (nb.track.instrumentSet && nb.track.instrumentSet.length > 0) {
        trackMap.instrumentSet = nb.track.instrumentSet;
    }
    if (nb.track.mix) trackMap.mix = nb.track.mix;

    const result = { track: trackMap };
    if (nb.role && nb.role !== 'music') result.role = nb.role;
    if (nb.riffGroup) result.riffGroup = nb.riffGroup;
    if (nb.riffVariant) result.riffVariant = nb.riffVariant;

    // Places
    const places = {};
    for (const [label, place] of Object.entries(nb.places)) {
        const p = { x: place.x, y: place.y, initial: place.initial };
        if (place.label) p.label = place.label;
        places[label] = p;
    }
    result.places = places;

    // Transitions
    const transitions = {};
    for (const [label, trans] of Object.entries(nb.transitions)) {
        const t = { x: trans.x, y: trans.y };
        if (trans.label) t.label = trans.label;
        if (nb.bindings[label]) {
            const m = nb.bindings[label];
            t.midi = { note: m.note, channel: m.channel, velocity: m.velocity, duration: m.duration };
        }
        if (nb.controlBindings[label]) {
            const c = nb.controlBindings[label];
            const cm = { action: c.action, targetNet: c.targetNet };
            if (c.targetNote > 0) cm.targetNote = c.targetNote;
            t.control = cm;
        }
        transitions[label] = t;
    }
    result.transitions = transitions;

    // Arcs
    result.arcs = nb.arcs.map(arc => {
        const a = { source: arc.source, target: arc.target, weight: arc.weight };
        if (arc.inhibit) a.inhibit = true;
        return a;
    });

    return result;
}
