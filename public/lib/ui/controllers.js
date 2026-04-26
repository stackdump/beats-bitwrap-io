// Feel + FX + trait controllers. Pulls together everything that maps
// user gestures onto performance state:
//   - trait chip row render + trait editor modal
//   - Feel axis modal + per-axis apply + engage/disengage mechanics
//   - FX slider helpers (_fxSlider / _setFxValue) and surface helpers
//     (_setFxByKey, _setAutoDjValue) consumed by FEEL_MAP
//   - _macroPulse chase-light animation driver
//   - _channelParamMove for per-channel pan/decay animation

import { toneEngine } from '../../audio/tone-engine.js';
import {
    CORNERS,
    CORNER_COLORS,
    DEFAULT_PUCK,
    GENRE_FEEL_POSITIONS,
    sanitizePuck,
    applyFeelGrid,
} from '../feel/axes.js';

// --- Trait chip row ---

export function updateTraits(el) {
    if (!el._traitsEl) return;
    const genre = el.querySelector('.pn-genre-select')?.value || 'techno';
    const g = el._genreData[genre];
    if (!g) { el._traitsEl.innerHTML = ''; return; }

    if (!el._traitOverrides) el._traitOverrides = {};

    const ov = el._traitOverrides;
    const val = (key, def) => ov[key] !== undefined ? ov[key] : def;

    const fills = val('drum-fills', g.drumFills);
    const walking = val('walking-bass', g.walkingBass);
    const poly = val('polyrhythm', g.polyrhythm);
    const sync = val('syncopation', g.syncopation);
    const call = val('call-response', g.callResponse);
    const tension = val('tension-curve', g.tensionCurve);
    const modal = val('modal-interchange', g.modalInterchange);
    const ghosts = val('ghost-notes', g.ghostNotes);

    const traitTips = {
        'drum-fills': 'Add drum fills at section boundaries',
        'walking-bass': 'Chromatic passing tones between chord roots',
        'polyrhythm': 'Odd-length hihat loop (e.g. 6-over-4) for cross-rhythm feel',
        'syncopation': 'Shift notes to offbeats for rhythmic tension',
        'call-response': 'Alternate between melodic phrases and answering riffs',
        'tension-curve': 'Scale energy up/down across song sections',
        'modal-interchange': 'Borrow chords from parallel key for harmonic color',
        'ghost-notes': 'Add quiet ghost notes between hihat hits for groove',
    };
    const tag = (label, paramKey, v, active) => {
        const on = active !== undefined ? active : (v > 0);
        const display = typeof v === 'boolean' ? '' : (v > 0 ? (v <= 1 ? ' ' + Math.round(v * 100) + '%' : ' ' + v) : '');
        const tip = traitTips[paramKey] || '';
        return `<span class="pn-trait ${on ? 'on' : 'off'}" data-param="${paramKey}" title="${tip}">${label}${display}</span>`;
    };

    el._traitsEl.innerHTML =
        tag('Fills', 'drum-fills', fills, fills) +
        tag('Walking Bass', 'walking-bass', walking, walking) +
        tag('Polyrhythm', 'polyrhythm', poly, poly > 0) +
        tag('Syncopation', 'syncopation', sync) +
        tag('Call/Response', 'call-response', call, call) +
        tag('Tension', 'tension-curve', tension, tension) +
        tag('Modal', 'modal-interchange', modal) +
        tag('Ghosts', 'ghost-notes', ghosts) +
        `<span class="pn-trait-info">swing ${g.swing} · humanize ${g.humanize}</span>`;
}

export function initTraitClicks(el) {
    if (!el._traitsEl) return;
    el._traitsEl.addEventListener('click', (e) => {
        const trait = e.target.closest('.pn-trait[data-param]');
        if (!trait) return;
        openTraitEditor(el, trait.dataset.param);
    });
}

export function traitMeta() {
    return {
        'drum-fills':        { label: 'Fills',          type: 'bool',    tip: 'Add drum fills at section boundaries' },
        'walking-bass':      { label: 'Walking Bass',   type: 'bool',    tip: 'Chromatic passing tones between chord roots' },
        'polyrhythm':        { label: 'Polyrhythm',     type: 'int',     min: 2, max: 16, defaultOn: 6, tip: 'Odd-length hihat loop for cross-rhythm feel' },
        'syncopation':       { label: 'Syncopation',    type: 'percent', defaultOn: 0.3, tip: 'Shift notes to offbeats for rhythmic tension' },
        'call-response':     { label: 'Call/Response',  type: 'bool',    tip: 'Alternate between melodic phrases and answering riffs' },
        'tension-curve':     { label: 'Tension',        type: 'bool',    tip: 'Scale energy up/down across song sections' },
        'modal-interchange': { label: 'Modal',          type: 'percent', defaultOn: 0.3, tip: 'Borrow chords from parallel key for harmonic color' },
        'ghost-notes':       { label: 'Ghosts',         type: 'percent', defaultOn: 0.3, tip: 'Add quiet ghost notes between hihat hits for groove' },
    };
}

export function genreTraitDefault(g, param) {
    return {
        'drum-fills': g.drumFills, 'walking-bass': g.walkingBass,
        'polyrhythm': g.polyrhythm, 'syncopation': g.syncopation,
        'call-response': g.callResponse, 'tension-curve': g.tensionCurve,
        'modal-interchange': g.modalInterchange, 'ghost-notes': g.ghostNotes,
    }[param];
}

export function openTraitEditor(el, param) {
    const meta = traitMeta()[param];
    if (!meta) return;
    const genre = el.querySelector('.pn-genre-select')?.value || 'techno';
    const g = el._genreData[genre];
    if (!g) return;

    if (!el._traitOverrides) el._traitOverrides = {};
    const current = el._traitOverrides[param] !== undefined
        ? el._traitOverrides[param]
        : genreTraitDefault(g, param);

    let enabled, numericValue;
    if (meta.type === 'bool') {
        enabled = !!current;
    } else if (meta.type === 'percent') {
        enabled = typeof current === 'number' && current > 0;
        numericValue = enabled ? current : meta.defaultOn;
    } else if (meta.type === 'int') {
        enabled = typeof current === 'number' && current > 0;
        numericValue = enabled ? current : meta.defaultOn;
    }

    const overlay = document.createElement('div');
    overlay.className = 'pn-modal-overlay';

    let valueRow = '';
    if (meta.type === 'percent') {
        const pct = Math.round(numericValue * 100);
        valueRow = `
            <div class="pn-modal-row">
                <label>Amount</label>
                <input type="range" name="pct" min="0" max="100" step="1" value="${pct}"/>
                <span class="pn-trait-val">${pct}%</span>
            </div>`;
    } else if (meta.type === 'int') {
        valueRow = `
            <div class="pn-modal-row">
                <label>Steps</label>
                <input type="number" name="intval" min="${meta.min}" max="${meta.max}" step="1" value="${numericValue}"/>
            </div>`;
    }

    overlay.innerHTML = `
        <div class="pn-modal">
            <h2>${meta.label}</h2>
            <p class="pn-modal-desc">${meta.tip}</p>
            <div class="pn-modal-row">
                <label>Enabled</label>
                <input type="checkbox" name="enabled" ${enabled ? 'checked' : ''}/>
            </div>
            ${valueRow}
            <div class="pn-modal-actions">
                <button class="cancel">Cancel</button>
                <button class="save">Apply</button>
            </div>
        </div>
    `;
    el.appendChild(overlay);

    const cb = overlay.querySelector('input[name="enabled"]');
    const slider = overlay.querySelector('input[name="pct"]');
    const valLabel = overlay.querySelector('.pn-trait-val');
    const intIn = overlay.querySelector('input[name="intval"]');

    const syncDisabled = () => {
        if (slider) slider.disabled = !cb.checked;
        if (intIn)  intIn.disabled  = !cb.checked;
    };
    syncDisabled();
    cb.addEventListener('change', syncDisabled);

    if (slider && valLabel) {
        slider.addEventListener('input', () => {
            valLabel.textContent = `${slider.value}%`;
            if (parseInt(slider.value, 10) > 0) cb.checked = true;
            else cb.checked = false;
            syncDisabled();
        });
    }

    overlay.addEventListener('wheel', (e) => {
        const t = e.target;
        if (t.tagName !== 'INPUT') return;
        if (t.type !== 'number' && t.type !== 'range') return;
        e.preventDefault();
        const step = e.deltaY < 0 ? 1 : -1;
        const min = parseInt(t.min, 10);
        const max = parseInt(t.max, 10);
        let v = parseInt(t.value, 10);
        if (!Number.isFinite(v)) v = Number.isFinite(min) ? min : 0;
        v += step;
        if (Number.isFinite(min) && v < min) v = min;
        if (Number.isFinite(max) && v > max) v = max;
        t.value = v;
        t.dispatchEvent(new Event('input', { bubbles: true }));
    }, { passive: false });

    const close = () => overlay.remove();
    overlay.querySelector('.cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        else if (e.key === 'Enter') { e.preventDefault(); overlay.querySelector('.save').click(); }
    });

    overlay.querySelector('.save').addEventListener('click', () => {
        const on = cb.checked;
        if (meta.type === 'bool') {
            el._traitOverrides[param] = on;
        } else if (meta.type === 'percent') {
            el._traitOverrides[param] = on ? (parseInt(slider.value, 10) / 100) : 0;
        } else if (meta.type === 'int') {
            el._traitOverrides[param] = on ? parseInt(intIn.value, 10) : 0;
        }
        // User just explicitly set this trait — lock it so Feel's mapping
        // won't clobber it on the next slider nudge.
        el._feelTraitLocks = el._feelTraitLocks || new Set();
        el._feelTraitLocks.add(param);
        close();
        updateTraits(el);
        toneEngine.resumeContext();
        el._ensureToneStarted();
        const params = { ...el._traitOverrides };
        const structure = el.querySelector('.pn-structure-select')?.value;
        if (structure) params.structure = structure;
        el._sendWs({ type: 'generate', genre, params });
    });

    (slider || intIn || cb).focus();
}

// --- Feel surface helpers ---

export function setFxByKey(el, fxKey, value) {
    const slider = fxSlider(el, fxKey);
    if (slider) setFxValue(slider, value);
}

export function setAutoDjValue(el, key, value) {
    const node = el.querySelector(`.pn-autodj-${key}`);
    if (node) {
        node.value = String(value);
        node.dispatchEvent(new Event('change', { bubbles: true }));
    }
}

// --- Feel state ---

function ensurePuck(el) {
    const s = el._feelState;
    if (s && Array.isArray(s.puck) && s.puck.length === 2) {
        s.puck = sanitizePuck(s.puck);
        return s.puck;
    }
    el._feelState = { puck: [...DEFAULT_PUCK] };
    return el._feelState.puck;
}

export function applyFeel(el, puck) {
    const p = sanitizePuck(puck || ensurePuck(el));
    el._feelState = el._feelState || {};
    el._feelState.puck = p;
    applyFeelGrid(el, p);
    saveFeelSettings(el);
}

export function saveFeelSettings(el) {
    if (el._feelPreviewMode) return;
    try {
        el._feelState = el._feelState || {};
        localStorage.setItem('pn-feel-settings', JSON.stringify(el._feelState));
    } catch {}
}

export function restoreFeelSettings(el) {
    let raw = null;
    try { raw = localStorage.getItem('pn-feel-settings'); } catch {}
    let state = {};
    try { state = raw ? (JSON.parse(raw) || {}) : {}; } catch { state = {}; }
    // One-shot migration: older stored blobs may carry {markers:[...]},
    // {energy, groove, chop, space}, or nothing. Collapse onto a single
    // puck position in [0,1]² so returning users keep roughly the same vibe.
    if (!Array.isArray(state.puck)) {
        let x = 0.5, y = 0.5;
        if (Array.isArray(state.markers) && state.markers.length === 3) {
            const sx = state.markers.reduce((s, m) => s + (+m?.[0] || 0), 0) / 3;
            const sy = state.markers.reduce((s, m) => s + (+m?.[1] || 0), 0) / 3;
            x = sx / 100; y = sy / 100;
        } else if (typeof state.energy === 'number' || typeof state.space === 'number') {
            x = (state.energy ?? 50) / 100;
            y = (state.space  ?? 50) / 100;
        }
        state = { puck: [x, y] };
    }
    state.puck = sanitizePuck(state.puck);
    el._feelState = state;
    el._feelDisengaged = true;
    updateFeelIconDisengaged(el);
}

// Mark the currently-selected genre option with a trailing `· feels`
// whenever Feel is engaged.
export function markGenreTilde(el, on) {
    const sel = el.querySelector('.pn-genre-select');
    if (!sel) return;
    const opt = sel.options[sel.selectedIndex];
    if (!opt) return;
    if (on) {
        if (!opt.dataset.labelOrig) opt.dataset.labelOrig = opt.textContent;
        opt.textContent = `${opt.dataset.labelOrig} · feels`;
    } else if (opt.dataset.labelOrig) {
        opt.textContent = opt.dataset.labelOrig;
        delete opt.dataset.labelOrig;
    }
}

export function disengageFeel(el) {
    el._feelDisengaged = true;
    updateFeelIconDisengaged(el);
    markGenreTilde(el, false);
    el._updateProjectNameDisplay();
}

export function updateFeelIconDisengaged(el) {
    const btn = el.querySelector('.pn-feel-open');
    if (!btn) return;
    btn.classList.toggle('disengaged', !!el._feelDisengaged);
    btn.title = el._feelDisengaged
        ? 'Feel — disengaged (genre defaults in effect). Open to apply.'
        : 'Feel — abstract performance sliders';
}

// --- Feel modal — XY morph pad with four corner snapshots ---

const SVG_NS = 'http://www.w3.org/2000/svg';
const PAD_VIEW = 340;           // SVG viewBox
const PAD_INSET = 28;           // inner square inset for corner labels
const PAD_SPAN = PAD_VIEW - PAD_INSET * 2;

function puckToSvg([x, y]) {
    return [
        PAD_INSET + x * PAD_SPAN,
        PAD_INSET + (1 - y) * PAD_SPAN,
    ];
}

function svgToPuck(svg, clientX, clientY) {
    const pt = svg.createSVGPoint();
    pt.x = clientX; pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return [0.5, 0.5];
    const local = pt.matrixTransform(ctm.inverse());
    const x = (local.x - PAD_INSET) / PAD_SPAN;
    const y = 1 - (local.y - PAD_INSET) / PAD_SPAN;
    return sanitizePuck([x, y]);
}

function constellationMarkup(el) {
    const current = el.querySelector('.pn-genre-select')?.value || '';
    return Object.entries(GENRE_FEEL_POSITIONS).map(([genre, [x, y]]) => {
        const [sx, sy] = puckToSvg([x, y]);
        const active = genre === current;
        const labelX = sx + 6;
        const labelY = sy - 5;
        return `
            <g class="pn-feel-star ${active ? 'active' : ''}" data-genre="${genre}" data-x="${x}" data-y="${y}">
                <title>${genre}</title>
                <circle cx="${sx}" cy="${sy}" r="${active ? 4.5 : 2.8}"/>
                <text x="${labelX}" y="${labelY}">${genre}</text>
            </g>`;
    }).join('');
}

function cornerLabelEl(c) {
    const [sx, sy] = puckToSvg([c.x, c.y]);
    // Pull the label away from the square's edge so it reads as an
    // external anchor rather than overlapping the corner swatch.
    const off = 10;
    const lx = sx + (c.x < 0.5 ? -off : off);
    const ly = sy + (c.y < 0.5 ?  off + 14 : -off - 6);
    const anchor = c.x < 0.5 ? 'start' : 'end';
    return `<text class="pn-feel-corner-label" x="${lx}" y="${ly}" text-anchor="${anchor}">${c.name}</text>`;
}

export function openFeelModal(el) {
    el.querySelector('.pn-feel-overlay')?.remove();

    let puck = [...sanitizePuck(el._feelState?.puck ?? DEFAULT_PUCK)];
    const snapshotPuck = [...puck];
    const snapshotDisengaged = !!el._feelDisengaged;
    const snapshotSwing = el._swing;
    const snapshotHumanize = el._humanize;
    el._feelPreviewMode = true;

    const cornerSwatches = CORNERS.map((c, i) => {
        const [sx, sy] = puckToSvg([c.x, c.y]);
        return `<circle class="pn-feel-corner" cx="${sx}" cy="${sy}" r="10" style="fill:${CORNER_COLORS[i]};stroke:${CORNER_COLORS[i]}"/>`;
    }).join('');

    const overlay = document.createElement('div');
    overlay.className = 'pn-feel-overlay pn-modal-overlay';
    overlay.tabIndex = -1;
    overlay.innerHTML = `
        <div class="pn-modal pn-feel-modal ${el._feelDisengaged ? 'disengaged' : ''}">
            <button class="pn-feel-close" title="Cancel (Esc)">&times;</button>
            <h2>Feel</h2>
            <p class="pn-modal-desc">Drag the puck. Each corner is a full vibe; the middle is the mix.</p>
            <div class="pn-feel-gridwrap">
                <svg class="pn-feel-grid-svg" viewBox="0 0 ${PAD_VIEW} ${PAD_VIEW}" preserveAspectRatio="xMidYMid meet">
                    <defs>
                        <radialGradient id="pn-feel-bg" cx="50%" cy="50%" r="75%">
                            <stop offset="0%"  stop-color="rgba(110, 74, 223, 0.20)"/>
                            <stop offset="100%" stop-color="rgba(110, 74, 223, 0.04)"/>
                        </radialGradient>
                    </defs>
                    <rect class="pn-feel-grid-bg" x="${PAD_INSET}" y="${PAD_INSET}" width="${PAD_SPAN}" height="${PAD_SPAN}" fill="url(#pn-feel-bg)"/>
                    <g class="pn-feel-grid-lines"></g>
                    ${cornerSwatches}
                    ${CORNERS.map(cornerLabelEl).join('')}
                    <g class="pn-feel-constellation">${constellationMarkup(el)}</g>
                    <circle class="pn-feel-ghost-puck" r="11" style="display:none"/>
                    <circle class="pn-feel-puck" r="11"/>
                </svg>
            </div>
            <div class="pn-modal-actions">
                <button class="pn-feel-cancel">Cancel</button>
                <button class="pn-feel-reset" title="Center the puck">Center</button>
                <button class="pn-feel-apply">Apply</button>
            </div>
        </div>`;

    el.appendChild(overlay);

    const svg   = overlay.querySelector('.pn-feel-grid-svg');
    const puckEl = overlay.querySelector('.pn-feel-puck');

    // Faint quarter-grid behind the pad.
    const lineGroup = overlay.querySelector('.pn-feel-grid-lines');
    for (let i = 1; i < 4; i++) {
        const t = PAD_INSET + (PAD_SPAN * i) / 4;
        const v = document.createElementNS(SVG_NS, 'line');
        v.setAttribute('x1', t); v.setAttribute('x2', t);
        v.setAttribute('y1', PAD_INSET); v.setAttribute('y2', PAD_VIEW - PAD_INSET);
        const h = document.createElementNS(SVG_NS, 'line');
        h.setAttribute('x1', PAD_INSET); h.setAttribute('x2', PAD_VIEW - PAD_INSET);
        h.setAttribute('y1', t); h.setAttribute('y2', t);
        lineGroup.appendChild(v);
        lineGroup.appendChild(h);
    }

    const redraw = () => {
        const [sx, sy] = puckToSvg(puck);
        puckEl.setAttribute('cx', sx);
        puckEl.setAttribute('cy', sy);
    };

    const engageIfNeeded = () => {
        if (!el._feelDisengaged) return;
        el._feelDisengaged = false;
        overlay.querySelector('.pn-feel-modal')?.classList.remove('disengaged');
        updateFeelIconDisengaged(el);
        markGenreTilde(el, true);
        el._updateProjectNameDisplay();
    };

    const pushLive = () => {
        el._feelState = el._feelState || {};
        el._feelState.puck = [...puck];
        applyFeelGrid(el, puck);
    };

    redraw();

    let dragging = false;
    let puckBeforeGrab = null;
    const onDown = (e) => {
        // Clicking anywhere inside the pad jumps the puck there and
        // starts a drag — matches Alchemy / Massive X feel. Snapshot
        // the pre-grab position so release can restore it (spring
        // return — Feel becomes a temporary modulation, not a
        // destructive setter, mirroring the joystick BPM model).
        puckBeforeGrab = [...puck];
        dragging = true;
        puck = svgToPuck(svg, e.clientX, e.clientY);
        puckEl.classList.add('dragging');
        engageIfNeeded();
        redraw();
        pushLive();
        svg.setPointerCapture?.(e.pointerId);
        e.preventDefault();
    };
    const onMove = (e) => {
        if (!dragging) return;
        puck = svgToPuck(svg, e.clientX, e.clientY);
        redraw();
        pushLive();
    };
    const onUp = (e) => {
        if (!dragging) return;
        dragging = false;
        puckEl.classList.remove('dragging');
        svg.releasePointerCapture?.(e.pointerId);
        // Spring-return: snap back to where the puck was before the
        // grab, re-applying the corresponding BPM + tone.
        if (puckBeforeGrab) {
            puck = puckBeforeGrab;
            puckBeforeGrab = null;
            redraw();
            pushLive();
        }
    };
    svg.addEventListener('pointerdown', onDown);
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerup',   onUp);

    // Constellation hover preview — hovering a genre star shows a
    // dimmer "ghost" puck at that coordinate without moving the real
    // puck or engaging Feel. Click still snaps + commits via the
    // existing pointerdown path.
    const constellation = overlay.querySelector('.pn-feel-constellation');
    const ghostPuckEl = overlay.querySelector('.pn-feel-ghost-puck');
    if (constellation && ghostPuckEl) {
        constellation.addEventListener('pointerover', (e) => {
            if (dragging) return;
            const star = e.target.closest('.pn-feel-star');
            if (!star) return;
            const x = +star.dataset.x, y = +star.dataset.y;
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
            const [sx, sy] = puckToSvg([x, y]);
            ghostPuckEl.setAttribute('cx', sx);
            ghostPuckEl.setAttribute('cy', sy);
            ghostPuckEl.style.display = '';
        });
        constellation.addEventListener('pointerout', (e) => {
            if (dragging) return;
            const star = e.target.closest('.pn-feel-star');
            const into = e.relatedTarget?.closest?.('.pn-feel-star');
            if (!star || into === star) return;
            ghostPuckEl.style.display = 'none';
        });
    }
    svg.addEventListener('pointercancel', onUp);

    const close = () => { el._feelPreviewMode = false; overlay.remove(); };
    const revert = () => {
        puck = [...snapshotPuck];
        el._feelState = el._feelState || {};
        el._feelState.puck = [...puck];
        if (snapshotDisengaged) {
            el._feelDisengaged = true;
            updateFeelIconDisengaged(el);
            markGenreTilde(el, false);
            el._updateProjectNameDisplay();
            el._swing    = snapshotSwing;
            el._humanize = snapshotHumanize;
            if (el._project) {
                el._project.swing    = el._swing;
                el._project.humanize = el._humanize;
            }
        } else {
            applyFeelGrid(el, puck);
        }
        saveFeelSettings(el);
    };

    const commit = () => {
        el._feelPreviewMode = false;
        engageIfNeeded();
        el._feelState = el._feelState || {};
        el._feelState.puck = [...puck];
        applyFeelGrid(el, puck);
        saveFeelSettings(el);
        close();
    };

    overlay.addEventListener('click', (e) => {
        if (e.target.closest('.pn-feel-reset')) {
            puck = [...DEFAULT_PUCK];
            engageIfNeeded();
            redraw();
            pushLive();
            return;
        }
        if (e.target.closest('.pn-feel-apply')) { commit(); return; }
        if (e.target.closest('.pn-feel-cancel') || e.target.closest('.pn-feel-close')) {
            revert(); close(); return;
        }
        if (e.target === overlay) { revert(); close(); }
    });
    overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); revert(); close(); }
        else if (e.key === 'Enter') { e.preventDefault(); commit(); }
    });
    overlay.focus();
}

// --- FX slider helpers ---

export function fxSlider(el, fxKey) {
    return el.querySelector(`.pn-fx-slider[data-fx="${fxKey}"]`);
}

export function setFxValue(slider, value) {
    slider.value = Math.round(value);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
}

// --- Chase-pulse for macro UI ---

// Every element gets `pn-pulsing` while one at a time rotates through
// `pn-pulsing-hot` (120ms per step). Returns a cancel fn.
export function macroPulse(el, elements, durationMs, tag) {
    if (!elements || elements.length === 0) return () => {};
    el._pulseAnim = el._pulseAnim || {};
    if (tag && el._pulseAnim[tag]) el._pulseAnim[tag].cancelled = true;
    const token = { cancelled: false };
    if (tag) el._pulseAnim[tag] = token;
    const BLINK = 120;
    const t0 = performance.now();
    let lastBlink = -BLINK;
    let idx = 0;
    const clear = () => {
        for (const node of elements) node?.classList.remove('pn-pulsing', 'pn-pulsing-hot');
        if (tag && el._pulseAnim[tag] === token) el._pulseAnim[tag] = null;
    };
    // Safety net: guarantee cleanup slightly past the macro's duration.
    const hardStop = setTimeout(() => {
        token.cancelled = true;
        clear();
    }, durationMs + 400);
    const step = (now) => {
        if (token.cancelled) { clearTimeout(hardStop); clear(); return; }
        if (now - t0 >= durationMs) { clearTimeout(hardStop); clear(); return; }
        if (now - lastBlink >= BLINK) {
            for (let i = 0; i < elements.length; i++) {
                elements[i]?.classList.add('pn-pulsing');
                elements[i]?.classList.toggle('pn-pulsing-hot', i === idx % elements.length);
            }
            idx++;
            lastBlink = now;
        }
        requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    return () => { clearTimeout(hardStop); token.cancelled = true; clear(); };
}

// --- Per-channel pan / decay animation ---

export function channelParamMove(el, macro, durationMs) {
    const targets = macro.targets ? macro.targets(el) : [];
    const chans = [];
    const seen = new Set();
    const allTargetIds = [];
    for (const id of targets) {
        const ch = el._project?.nets?.[id]?.track?.channel;
        if (ch == null) continue;
        allTargetIds.push(id);
        if (!seen.has(ch)) { chans.push(ch); seen.add(ch); }
    }
    if (chans.length === 0) return;

    const kind = macro.kind; // 'pan-move' | 'decay-move'

    el._chanAnim = el._chanAnim || {};
    const prev = el._chanAnim[macro.id];
    const before = (prev && !prev.cancelled && prev.before)
        ? prev.before
        : (() => {
            const snap = {};
            for (const ch of chans) {
                if (kind === 'pan-move') {
                    snap[ch] = toneEngine._channelStrips?.get?.(ch)?.panner?.pan?.value ?? 0;
                } else {
                    snap[ch] = toneEngine._channelStrips?.get?.(ch)?.decay ?? 1.0;
                }
            }
            return snap;
        })();
    if (prev) {
        prev.cancelled = true;
        if (prev.hardStop) clearTimeout(prev.hardStop);
    }

    const apply = (ch, v) => {
        if (kind === 'pan-move') {
            const cc = Math.max(0, Math.min(127, Math.round((v + 1) * 63.5)));
            toneEngine.controlChange(ch, 10, cc);
        } else {
            toneEngine.setChannelDecay(ch, v);
        }
    };
    const restore = () => {
        for (const ch of chans) apply(ch, before[ch] ?? (kind === 'pan-move' ? 0 : 1.0));
    };

    // Pulse every targeted net's mixer row, not just the first per channel.
    // Drum voices (kick/snare/hihat/clap) share a single channel — without
    // this, dedup-by-channel meant only one drum row's slider animated
    // and the others looked like the macro skipped them.
    const sliderCls = kind === 'pan-move' ? 'pn-mixer-pan' : 'pn-mixer-decay';
    const sliderSet = new Set();
    for (const id of allTargetIds) {
        const byNet = el._mixerEl?.querySelector(`.pn-mixer-row[data-net-id="${id}"] .${sliderCls}`);
        if (byNet) { sliderSet.add(byNet); continue; }
        const net = el._project?.nets?.[id];
        if (net?.riffGroup) {
            const byGroup = el._mixerEl?.querySelector(`.pn-mixer-row[data-riff-group="${net.riffGroup}"] .${sliderCls}`);
            if (byGroup) sliderSet.add(byGroup);
        }
    }
    const sliders = [...sliderSet];
    const cleanupBlink = () => {
        for (const node of sliders) node.classList.remove('pn-pulsing', 'pn-pulsing-hot');
    };

    const token = { cancelled: false, before };
    el._chanAnim[macro.id] = token;

    // Safety net: guaranteed restore + blink cleanup.
    token.hardStop = setTimeout(() => {
        if (token.cancelled) return;
        token.cancelled = true;
        restore();
        cleanupBlink();
        if (el._chanAnim[macro.id] === token) el._chanAnim[macro.id] = null;
    }, durationMs + 400);

    const t0 = performance.now();
    const msPerBeat = el._msPerBar() / 4;
    const DISPATCH = 80;
    const BLINK_STEP = 120;
    let last = -DISPATCH;
    let lastBlink = -BLINK_STEP;
    let blinkIdx = 0;

    const step = (now) => {
        if (token.cancelled) { cleanupBlink(); return; }
        const elapsed = now - t0;
        if (elapsed >= durationMs) {
            restore();
            cleanupBlink();
            if (token.hardStop) clearTimeout(token.hardStop);
            if (el._chanAnim[macro.id] === token) el._chanAnim[macro.id] = null;
            return;
        }
        let v;
        if (macro.pattern === 'pingpong') {
            const beat = Math.floor(elapsed / (msPerBeat * (macro.stepBeats || 1)));
            v = (beat % 2 === 0) ? -1 : 1;
        } else if (macro.pattern === 'sweep') {
            const rateMs = (macro.rateBeats || 4) * msPerBeat;
            const sine = Math.sin((elapsed / rateMs) * 2 * Math.PI);
            if (kind === 'decay-move') {
                const lo = macro.sweepMin ?? 0.3;
                const hi = macro.sweepMax ?? 1.8;
                v = lo + (sine + 1) * 0.5 * (hi - lo);
            } else {
                v = sine;
            }
        } else {
            v = macro.toValue ?? (kind === 'pan-move' ? 0 : 1.0);
        }
        if (now - last >= DISPATCH) {
            for (const ch of chans) apply(ch, v);
            last = now;
        }
        if (sliders.length > 0 && (now - lastBlink >= BLINK_STEP)) {
            for (let i = 0; i < sliders.length; i++) {
                sliders[i].classList.add('pn-pulsing');
                sliders[i].classList.toggle('pn-pulsing-hot', i === blinkIdx % sliders.length);
            }
            blinkIdx++;
            lastBlink = now;
        }
        requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}
