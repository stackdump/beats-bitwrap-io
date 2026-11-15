// What the studio hides or switches off because it depended on Tone.js and
// is not on the djrust engine yet. One list, one stylesheet, one guard, so
// re-enabling a feature is deleting its entry here once djwasm can do it.
// The same list, with what each needs from the engine, is the rebuild table
// in docs/MIGRATION-djrust-wasm.md §12.
//
// Hidden by CSS (survives every _buildUI / _renderMixer re-render) rather
// than removed from the DOM: the panels' code, share collectors/appliers and
// keyboard wiring stay intact, so a share that carries fx / autoDj / macro
// settings still round-trips byte for byte.

export const ENGINE_GAPS = [
    { id: 'macros',        selectors: ['.pn-macros-btn', '.pn-macros-panel', '.pn-macro-panic'],
      why: 'macros scheduled Tone params and worker restore nets; djrust runs macros in the runner (WaveRunner::fire_macro), not yet exported by djwasm' },
    { id: 'auto-dj',       selectors: ['.pn-autodj-btn', '.pn-autodj-panel'],
      why: 'Auto-DJ fires macros' },
    { id: 'master-fx',     selectors: ['.pn-effects-panel .pn-fx-group:not(:first-child)', '.pn-fx-bypass', '.pn-fx-reset'],
      why: 'reverb, delay, drive, pitch, filters, phaser, crush were Tone nodes; djrust fx::master_chain is not exported by djwasm (master volume stays: it is the host gain)' },
    { id: 'channel-strip', selectors: ['.pn-mixer-slider-group'],
      why: 'per-channel pan / volume / HP / LP / decay were Tone channel strips; needs per-lane voice settings in djwasm' },
    { id: 'instrument-tone', selectors: ['.pn-mixer-test', '.pn-mixer-save', '.pn-mixer-tone-reset', '.pn-mixer-tone-prev', '.pn-mixer-tone-next', '.pn-mixer-rotate'],
      why: 'test note, tone presets and tone randomise edited Tone patches' },
    { id: 'instrument-change', selectors: [], disable: ['.pn-mixer-instrument'],
      why: 'djrust plays the instrument named in the loaded project; a live change is not sent to the worklet yet (the dropdown stays as a label)' },
];

const STYLE_ID = 'pn-engine-gaps-style';

/** Install the stylesheet once per document. */
export function applyEngineGaps(doc = (typeof document !== 'undefined' ? document : null)) {
    if (!doc || doc.getElementById(STYLE_ID)) return;
    const hide = ENGINE_GAPS.flatMap(g => g.selectors);
    const disable = ENGINE_GAPS.flatMap(g => g.disable || []);
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
        (hide.length ? `petri-note :is(${hide.join(', ')}) { display: none !important; }\n` : '') +
        (disable.length ? `petri-note :is(${disable.join(', ')}) { pointer-events: none; opacity: 0.6; }\n` : '');
    (doc.head || doc.documentElement).appendChild(style);
}

const warned = new Set();
/** True (and a one-time console note) when `id` is a gap on this engine. */
export function engineGap(id) {
    if (!ENGINE_GAPS.some(g => g.id === id)) return false;
    if (!warned.has(id)) {
        warned.add(id);
        console.info(`[engine] ${id}: not available on the djrust engine yet (docs/MIGRATION-djrust-wasm.md §12)`);
    }
    return true;
}
