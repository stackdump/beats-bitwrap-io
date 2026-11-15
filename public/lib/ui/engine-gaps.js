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
//
// Macros are feature-detected, not version-pinned. The loaded module's
// djw_features() mask (lib/backend/wave.js setEngineFeatures) decides, per
// macro, whether it is shown (lib/macros/catalog.js engineRunsMacro): a
// module that runs net macros (djwasm 0.3.0) shows the Mute and Tempo
// macros and the Auto-DJ, and keeps hiding the FX / Pitch / Feel / Pan /
// Shape ones until a module that runs them is pinned. Rolling the pin back
// to 0.2.0 (mask 0) hides every macro again, exactly as before. Until the
// page knows the mask (the module is fetched and asked), it is 0. The Beats
// pads (hit1-hit4) are page work (stinger mutes) and run on every engine, so
// they are never a gap (catalog.js macroRunnable).

import { MACROS, engineRunsMacro, macroRunnable, autoDjPoolLive } from '../macros/catalog.js';

export const ENGINE_GAPS = [
    { id: 'macros',        selectors: ['.pn-macros-btn', '.pn-macros-panel', '.pn-macro-panic'], whenNoMacros: true,
      why: 'macros scheduled Tone params and worker restore nets; djrust runs them in the engine, each kind once djwasm reports it (djw_features: NET_MACROS, MASTER_MACROS, AUX_MACROS)' },
    { id: 'auto-dj',       selectors: ['.pn-autodj-btn', '.pn-autodj-panel'], whenNoMacros: true,
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
const AUTODJ_POOLS = ['Mute', 'FX', 'Pan', 'Shape', 'Pitch', 'Feel', 'Tempo', 'Beats', 'Transition'];

let currentFeatures = 0;

/** The feature mask the gaps are drawn for (0 until the page knows the module's). */
export function engineFeatures() { return currentFeatures; }

/** Panel macros (not the Beats pads) the engine with `features` runs. */
export function runnableMacros(features) {
    return MACROS.filter(m => m.kind !== 'one-shot' && engineRunsMacro(m.id, features)).map(m => m.id);
}

/**
 * What to hide and disable for an engine with feature mask `features`. Pure.
 * hiddenMacros lists the panel macros hidden one by one (empty when the whole
 * panel is hidden, as on a module that runs none).
 */
export function gapSelectors(features) {
    const runs = new Set(runnableMacros(features));
    const none = runs.size === 0;
    const hide = [];
    const disable = [];
    for (const g of ENGINE_GAPS) {
        if (g.whenNoMacros && !none) continue;
        hide.push(...g.selectors);
        disable.push(...(g.disable || []));
    }
    const hiddenMacros = [];
    if (!none) {
        const groups = new Map();
        for (const m of MACROS) {
            if (m.kind === 'one-shot') continue;
            if (!groups.has(m.group)) groups.set(m.group, []);
            groups.get(m.group).push(m.id);
        }
        for (const [, ids] of groups) {
            const off = ids.filter(id => !runs.has(id));
            hiddenMacros.push(...off);
            if (off.length === ids.length) {
                // The whole group, label included.
                hide.push(`.pn-macros-panel .pn-macro-group:has(.pn-macro-btn[data-macro="${ids[0]}"])`);
            } else {
                for (const id of off) hide.push(`.pn-macros-panel .pn-macro-item:has(> .pn-macro-btn[data-macro="${id}"])`);
            }
        }
        // Auto-DJ pools Auto-DJ will not draw from on this engine (the same
        // rule lib/macros/runtime.js draws by: catalog.js autoDjPoolLive).
        for (const pool of AUTODJ_POOLS) {
            if (!autoDjPoolLive(pool, features)) hide.push(`.pn-autodj-panel label:has(> .pn-autodj-pool[value="${pool}"])`);
        }
    }
    return { hide, disable, hiddenMacros };
}

function styleText(features) {
    const { hide, disable } = gapSelectors(features);
    return (hide.length ? `petri-note :is(${hide.join(', ')}) { display: none !important; }\n` : '') +
        (disable.length ? `petri-note :is(${disable.join(', ')}) { pointer-events: none; opacity: 0.6; }\n` : '');
}

/**
 * Install the stylesheet once per document, drawn for `features` (default:
 * the mask last set). A later call with another mask redraws it in place.
 */
export function applyEngineGaps(doc = (typeof document !== 'undefined' ? document : null), features = currentFeatures) {
    if (!doc) return;
    let style = doc.getElementById(STYLE_ID);
    if (!style) {
        style = doc.createElement('style');
        style.id = STYLE_ID;
        (doc.head || doc.documentElement).appendChild(style);
    }
    const text = styleText(features);
    if (style.textContent !== text) style.textContent = text;
}

/** The loaded module's mask: redraw the gaps for it (a no-op when unchanged). */
export function setEngineFeatures(features, doc = (typeof document !== 'undefined' ? document : null)) {
    currentFeatures = Number(features) | 0;
    if (doc && doc.getElementById(STYLE_ID)) applyEngineGaps(doc, currentFeatures);
}

const warned = new Set();
/**
 * True (and a one-time console note) when `id` is a gap on this engine.
 * `id` is an ENGINE_GAPS id, or `macro:<catalog id>` for one macro.
 */
export function engineGap(id, features = currentFeatures) {
    let gap;
    if (id.startsWith('macro:')) gap = !macroRunnable(id.slice(6), features);
    else {
        const g = ENGINE_GAPS.find(x => x.id === id);
        gap = !!g && (!g.whenNoMacros || runnableMacros(features).length === 0);
    }
    if (gap && !warned.has(id)) {
        warned.add(id);
        console.info(`[engine] ${id}: not available on the djrust engine yet (docs/MIGRATION-djrust-wasm.md §12)`);
    }
    return gap;
}
