// Feel + FX + trait controllers. Pulls together everything that maps
// user gestures onto performance state:
//   - trait chip row render + trait editor modal
//   - Feel axis modal + per-axis apply + engage/disengage mechanics
//   - FX slider helpers (_fxSlider / _setFxValue) and surface helpers
//     (_setFxByKey, _setAutoDjValue) consumed by FEEL_MAP
//   - _macroPulse chase-light animation driver
//   - _channelParamMove for per-channel pan/decay animation

import { toneEngine } from '../../audio/tone-engine.js';
import { FEEL_AXES, FEEL_MAP } from '../feel/axes.js';

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

// --- Feel-bar surface helpers (used by FEEL_MAP) ---

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

export function applyFeel(el, id, v) {
    if (!el._traitOverrides) el._traitOverrides = {};
    // Stash locked traits before Feel runs, restore after.
    const locks = el._feelTraitLocks || new Set();
    const locked = {};
    for (const p of locks) locked[p] = el._traitOverrides[p];
    const fn = FEEL_MAP[id];
    if (fn) fn(v, el);
    for (const p of locks) {
        if (locked[p] === undefined) delete el._traitOverrides[p];
        else el._traitOverrides[p] = locked[p];
    }
    updateTraits(el);
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
    try {
        const raw = localStorage.getItem('pn-feel-settings');
        el._feelState = raw ? (JSON.parse(raw) || {}) : {};
    } catch { el._feelState = {}; }
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

export function openFeelModal(el) {
    el.querySelector('.pn-feel-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'pn-feel-overlay pn-modal-overlay';
    overlay.tabIndex = -1;
    const state = el._feelState || {};
    // Snapshot the state at open — Cancel restores from this.
    const snapshotFeel = { ...state };
    const snapshotDisengaged = !!el._feelDisengaged;
    const snapshotTraits = { ...(el._traitOverrides || {}) };
    el._feelPreviewMode = true;

    const row = (a) => {
        const v = typeof state[a.id] === 'number' ? state[a.id] : 50;
        const tags = [];
        if (a.live)    tags.push(`<span class="pn-feel-tag live">LIVE · ${a.live}</span>`);
        if (a.pending) tags.push(`<span class="pn-feel-tag pending">REGEN · ${a.pending}</span>`);
        return `<label class="pn-feel-field" title="${a.tip}">
            <span>${a.label}</span>
            <input type="range" class="pn-feel-slider" data-feel="${a.id}" min="0" max="100" value="${v}">
            <span class="pn-feel-val" data-feel-val="${a.id}">${v}</span>
            <span class="pn-feel-tags">${tags.join('')}</span>
        </label>`;
    };
    const disengagedNote = el._feelDisengaged
        ? `<p class="pn-feel-disengaged-note">Disengaged — genre defaults are in effect. Sliders re-engage as soon as you nudge one.</p>`
        : '';
    overlay.innerHTML = `
        <div class="pn-modal pn-feel-modal ${el._feelDisengaged ? 'disengaged' : ''}">
            <button class="pn-feel-close" title="Cancel (Esc)">&times;</button>
            <h2>Feel</h2>
            <p class="pn-modal-desc">Four abstract sliders that deterministically drive generator params, master FX, and Auto-DJ. Changes preview live; Apply commits, Cancel reverts to the state when you opened this panel.</p>
            ${disengagedNote}
            <div class="pn-feel-grid">${FEEL_AXES.map(row).join('')}</div>
            <p class="pn-feel-pending-note" style="display:none">Some changes are pending — the current track keeps its rhythmic feel until you hit <b>Save &amp; Regenerate</b>.</p>
            <div class="pn-modal-actions">
                <button class="pn-feel-cancel">Cancel</button>
                <button class="pn-feel-apply">Apply</button>
                <button class="pn-feel-regen" title="Apply then generate a new track with these trait overrides">Save &amp; Regenerate</button>
            </div>
        </div>`;

    const close = () => { el._feelPreviewMode = false; overlay.remove(); };
    const revert = () => {
        el._feelState = { ...snapshotFeel };
        el._traitOverrides = { ...snapshotTraits };
        for (const a of FEEL_AXES) {
            const v = typeof snapshotFeel[a.id] === 'number' ? snapshotFeel[a.id] : 50;
            applyFeel(el, a.id, v);
        }
        el._feelDisengaged = snapshotDisengaged;
        updateFeelIconDisengaged(el);
        markGenreTilde(el, !snapshotDisengaged);
        el._updateProjectNameDisplay();
        saveFeelSettings(el);
    };

    overlay.addEventListener('input', (e) => {
        const s = e.target.closest('.pn-feel-slider');
        if (!s) return;
        if (el._feelDisengaged) {
            el._feelDisengaged = false;
            overlay.querySelector('.pn-feel-modal')?.classList.remove('disengaged');
            overlay.querySelector('.pn-feel-disengaged-note')?.remove();
            updateFeelIconDisengaged(el);
            markGenreTilde(el, true);
            el._updateProjectNameDisplay();
        }
        const id = s.dataset.feel;
        const v = parseInt(s.value, 10);
        const valEl = overlay.querySelector(`.pn-feel-val[data-feel-val="${id}"]`);
        if (valEl) valEl.textContent = v;
        el._feelState = el._feelState || {};
        el._feelState[id] = v;
        applyFeel(el, id, v);

        const axis = FEEL_AXES.find(a => a.id === id);
        const movedFromOpen = (snapshotFeel[id] ?? 50) !== v;
        const anyPending = FEEL_AXES.some(a =>
            a.pending && (el._feelState[a.id] ?? 50) !== (snapshotFeel[a.id] ?? 50)
        );
        const banner = overlay.querySelector('.pn-feel-pending-note');
        if (banner) banner.style.display = anyPending ? 'block' : 'none';
        if (axis?.pending && movedFromOpen) {
            overlay.querySelector('.pn-feel-regen')?.classList.add('pn-feel-regen-dirty');
        }
    });
    const commit = () => {
        el._feelPreviewMode = false;
        if (el._feelDisengaged) {
            for (const a of FEEL_AXES) {
                const v = typeof el._feelState?.[a.id] === 'number'
                    ? el._feelState[a.id]
                    : 50;
                applyFeel(el, a.id, v);
            }
            el._feelDisengaged = false;
            updateFeelIconDisengaged(el);
            markGenreTilde(el, true);
            el._updateProjectNameDisplay();
        }
        el._feelTraitLocks = new Set();
        saveFeelSettings(el);
        close();
    };
    overlay.addEventListener('click', (e) => {
        if (e.target.closest('.pn-feel-regen')) {
            commit();
            el.querySelector('.pn-generate-btn')?.click();
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
    el.appendChild(overlay);
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
