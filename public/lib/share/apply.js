// State appliers (share payload → DOM / in-memory). Each exported
// function takes the custom element (`el`) and applies a slice of a
// share-v1 envelope onto live UI + project state. The high-level
// `applyShareOverrides` is what `_applyProjectSync` calls when a
// pending share is waiting.
//
// Extracted from petri-note.js (Phase A.3). The class keeps one-line
// wrappers so any `el._applyFxState(fx)` call site still works.

import { toneEngine } from '../../audio/tone-engine.js';
import { sanitizePuck, applyFeelGrid } from '../feel/axes.js';

export function applyFxState(el, fx) {
    if (!fx) return;
    for (const [name, val] of Object.entries(fx)) {
        if (name === '_bypassed') continue;
        const slider = el.querySelector(`.pn-fx-slider[data-fx="${name}"]`);
        if (slider && val != null) {
            slider.value = val;
            slider.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }
    if (fx._bypassed) {
        const btn = el.querySelector('.pn-fx-bypass');
        if (btn && !btn.classList.contains('active')) btn.click();
    }
}

export function applyFeelState(el, feel) {
    if (!feel) return;
    const sliders = feel.sliders || {};
    let puck = sliders.puck;
    if (!Array.isArray(puck)) {
        if (Array.isArray(sliders.markers) && sliders.markers.length === 3) {
            // Triangle era: centroid of three markers → puck in [0,1]².
            const sx = sliders.markers.reduce((s, m) => s + (+m?.[0] || 0), 0) / 3;
            const sy = sliders.markers.reduce((s, m) => s + (+m?.[1] || 0), 0) / 3;
            puck = [sx / 100, sy / 100];
        } else {
            // Four-axis era: energy→x, space→y.
            const oldX = typeof sliders.energy === 'number' ? sliders.energy : 50;
            const oldY = typeof sliders.space  === 'number' ? sliders.space  : 50;
            puck = [oldX / 100, oldY / 100];
        }
    }
    puck = sanitizePuck(puck);
    el._feelState = { puck };
    try { localStorage.setItem('pn-feel-settings', JSON.stringify(el._feelState)); } catch {}
    el._feelDisengaged = !feel.engaged;
    el._updateFeelIconDisengaged();
    if (feel.engaged) {
        el._markGenreTilde(true);
        applyFeelGrid(el, puck);
    }
}

export function applyAutoDjState(el, state) {
    const panel = el.querySelector('.pn-autodj-panel');
    const btn = el.querySelector('.pn-autodj-btn');
    if (!panel || !state) return;
    if (state.showAutoDj) {
        el._showAutoDj = true;
        panel.style.display = 'flex';
        btn?.classList.add('active');
    }
    const set = (cls, val) => {
        const node = panel.querySelector(`.${cls}`);
        if (!node) return;
        if (node.type === 'checkbox') node.checked = !!val;
        else if (val != null) node.value = val;
    };
    set('pn-autodj-enable',       state.run);
    set('pn-autodj-animate-only', state.animateOnly);
    set('pn-autodj-rate',         state.rate);
    set('pn-autodj-regen',        state.regen);
    set('pn-autodj-stack',        state.stack);
    if (state.pools) {
        for (const cb of panel.querySelectorAll('.pn-autodj-pool')) {
            if (cb.value in state.pools) cb.checked = !!state.pools[cb.value];
        }
    }
    try { localStorage.setItem('pn-autodj-settings', JSON.stringify(state)); } catch {}
}

export function applyDisabledMacros(el, ids) {
    if (!Array.isArray(ids)) return;
    el._disabledMacros = new Set(ids);
    el._saveDisabledMacros();
    el._refreshMacroDisabledMarks();
}

export function applyTrackOverrides(el, tracksByChannel) {
    if (!tracksByChannel || !el._project?.nets) return;
    const nets = el._project.nets;
    for (const [ch, ov] of Object.entries(tracksByChannel)) {
        const chNum = parseInt(ch);
        for (const [, net] of Object.entries(nets)) {
            if (net.role === 'control' || net.track?.channel !== chNum) continue;
            if (ov.mix) net.track.mix = { ...(net.track.mix || {}), ...ov.mix };
            if (ov.instrument) {
                net.track.instrument = ov.instrument;
                el._channelInstruments[chNum] = ov.instrument;
                if (el._toneStarted) toneEngine.loadInstrument(chNum, ov.instrument);
            }
            if (ov.instrumentSet) net.track.instrumentSet = ov.instrumentSet;
        }
    }
}

export function applyHitState(el, hits) {
    if (!hits) return;
    for (const [id, cfg] of Object.entries(hits)) {
        const bars  = el.querySelector(`.pn-os-bars[data-macro="${id}"]`);
        const pitch = el.querySelector(`.pn-os-pitch[data-macro="${id}"]`);
        const pair  = el.querySelector(`.pn-os-pair[data-macro="${id}"]`);
        if (bars  && cfg.bars  != null) bars.value  = String(cfg.bars);
        if (pitch && cfg.pitch != null) pitch.value = String(cfg.pitch);
        if (pair  && cfg.pair  != null) pair.value  = cfg.pair;
    }
}

export function applyUiState(el, ui) {
    if (!ui) return;
    if (ui.playbackMode && ui.playbackMode !== el._playbackMode) {
        // _cyclePlaybackMode walks single → repeat → shuffle; cycle until
        // we land on the requested mode. Bounded by the 3-mode cycle.
        for (let i = 0; i < 3 && el._playbackMode !== ui.playbackMode; i++) {
            el._cyclePlaybackMode?.();
        }
    }
    const togglePanel = (want, current, btnSelector) => {
        if (want === current) return;
        el.querySelector(btnSelector)?.click();
    };
    if (typeof ui.showFx === 'boolean')       togglePanel(ui.showFx,       el._showFx,       '.pn-effects-btn');
    if (typeof ui.showMacros === 'boolean')   togglePanel(ui.showMacros,   el._showMacros,   '.pn-macros-btn');
    if (typeof ui.showOneShots === 'boolean') togglePanel(ui.showOneShots, el._showOneShots, '.pn-oneshots-btn');
}

// Apply every override block onto the just-synced project + DOM.
// Called at the tail of _applyProjectSync when a pending share payload
// is waiting — one-shot: cleared after application.
export function applyShareOverrides(el, ov) {
    if (!ov) return;
    if (ov.tracks) applyTrackOverrides(el, ov.tracks);
    // Re-render mixer so mix values land on the sliders. The mixer reads
    // from track.mix; applying after applyTrackOverrides is important.
    if (ov.tracks) el._renderMixer?.();
    if (ov.fx) applyFxState(el, ov.fx);
    if (ov.feel) applyFeelState(el, ov.feel);
    if (ov.autoDj) applyAutoDjState(el, ov.autoDj);
    if (ov.macrosDisabled) applyDisabledMacros(el, ov.macrosDisabled);
    if (ov.initialMutes && el._project) {
        el._project.initialMutes = [...ov.initialMutes];
        el._sendWs({ type: 'mute-state', mutes: ov.initialMutes });
    }
    // UI panel toggles must run before hits — hits live inside the Beats
    // panel DOM, which only exists when showOneShots is true.
    if (ov.ui) applyUiState(el, ov.ui);
    if (ov.hits) applyHitState(el, ov.hits);
}
