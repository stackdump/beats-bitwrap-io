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

// No factory bindings ship right now — too many MPK / LaunchKey /
// other-controller variants send different default note + CC numbers
// for what looks like the same hardware (firmware revs, MPK Editor
// presets, bank A vs B). The hover-bind flow + MIDI Monitor modal
// produce a more reliable layout than guessing from the device name.
// Add device-specific entries here only when a layout is verified
// against real hardware AND the user wants a one-click setup.
export const PRESETS = [];

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
