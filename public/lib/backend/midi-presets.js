// Pre-mapped MIDI controller presets. Detects the controller from the
// Web MIDI input.name string and offers a one-click "Apply" that
// populates el._padBindings + el._ccBindings with sensible defaults.
//
// To add a controller: append an entry to PRESETS with a `match` regex
// (case-insensitive) against the input name as Web MIDI reports it,
// `pads` mapping note number → macro id, and `ccs` mapping CC number
// → FX slider name (matches the data-fx attribute on .pn-fx-slider).
//
// The macro IDs and FX slider names referenced here MUST exist in
// public/lib/macros/catalog.js and public/lib/ui/build.js respectively.
// If you change either source of truth, update presets to match.

export const PRESETS = [
    {
        id: 'akai-mpk-mini',
        // Matches "MPK mini 3", "MPKmini2", "Akai MPK mini", etc.
        // The MK1/MK2/MK3 controllers all carry "MPK" + "mini" in the
        // device name; differences in default CCs are smoothed over by
        // the user's MPK Editor app — these are the factory defaults.
        match: /mpk\s*mini/i,
        label: 'Akai MPK Mini',
        notes: 'Factory pad bank A on channel 10; knobs K1–K8 on CC70–77. ' +
               'Pads mute / unmute riff groups (drums / bass / melody / ' +
               'harmony / arp / pad / lead / stinger). Knobs map to the ' +
               'master FX. If you remapped via Akai\'s MPK Editor your CC ' +
               'numbers may differ — bind manually instead.',
        // Pad bank A — 8 pads, MIDI notes 36..43 (default).
        // Each pad toggles mute on a riff group. Tap once to mute,
        // tap again to unmute. Maps to the standard composer-emitted
        // groups; tracks tagged with these riff groups in hand-authored
        // shares pick up the mapping automatically.
        pads: {
            36: { type: 'mute', target: 'drums'   },
            37: { type: 'mute', target: 'bass'    },
            38: { type: 'mute', target: 'melody'  },
            39: { type: 'mute', target: 'harmony' },
            40: { type: 'mute', target: 'arp'     },
            41: { type: 'mute', target: 'pad'     },
            42: { type: 'mute', target: 'lead'    },
            43: { type: 'mute', target: 'stinger' },
        },
        // K1..K8 → master mixer + the heavy-hitter FX wets. CC70 starts
        // here because that's the MPK's factory default for K1; if the
        // user has reprogrammed via Akai's editor, they'll need to
        // re-bind manually.
        ccs: {
            70: 'master-vol',
            71: 'reverb-wet',
            72: 'delay-wet',
            73: 'hp-freq',
            74: 'lp-freq',
            75: 'phaser-wet',
            76: 'crush-bits',
            77: 'master-pitch',
        },
    },
];

// Returns the first PRESETS entry that matches `name`, or null.
export function detectPreset(name) {
    if (!name) return null;
    for (const p of PRESETS) {
        if (p.match.test(name)) return p;
    }
    return null;
}

// Apply a preset to an element's binding maps. Overwrites any existing
// CC + pad bindings — the caller is expected to have warned the user.
// Returns { ccs, pads } counts for the status line.
export function applyPreset(el, preset) {
    if (!el || !preset) return { ccs: 0, pads: 0 };
    el._ccBindings = el._ccBindings || new Map();
    el._padBindings = el._padBindings || new Map();
    el._ccBindings.clear();
    el._padBindings.clear();
    for (const [cc, fxName] of Object.entries(preset.ccs || {})) {
        el._ccBindings.set(parseInt(cc, 10), {
            key: `fx:${fxName}`,
            selector: `.pn-fx-slider[data-fx="${fxName}"]`,
        });
    }
    for (const [note, macroId] of Object.entries(preset.pads || {})) {
        el._padBindings.set(parseInt(note, 10), macroId);
    }
    el._savePadBindings?.();
    return {
        ccs: Object.keys(preset.ccs || {}).length,
        pads: Object.keys(preset.pads || {}).length,
    };
}
