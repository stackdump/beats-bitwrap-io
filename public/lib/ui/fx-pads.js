// The Pads panel: djrust's effects catalogue as pads, the way the Android app plays them. Each
// pad is one trick or macro in the one category djrust puts it in (Transition, Filter & tone,
// Space, Rhythm, Arrange, Pitch, Stereo & shape, Feel, Sweeps). Nothing fires at once: a pad
// lands on the track's next bar and runs for the length picked (1-4 bars, or latched until
// tapped again). A transition is held: on at the press, let go at the lift. A sweep has bars and
// no latch. The lights come from djrust (`fx_state`): lit once its bar has come, outlined while
// it waits, ringed while latched.
//
// Live performance only: nothing here goes into a share.

import { audioEngine } from '../../audio/engine.js';

const CATEGORY_LABELS = {
    'transition': 'Transition',
    'filter-tone': 'Filter & tone',
    'space': 'Space',
    'rhythm': 'Rhythm',
    'arrange': 'Arrange',
    'pitch': 'Pitch',
    'stereo-shape': 'Stereo & shape',
    'feel': 'Feel',
    'sweeps': 'Sweeps',
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Fill `panel` (the .pn-pads-panel) and keep its lights in step with djrust. */
export function buildPadsPanel(el, panel) {
    if (!panel) return;
    el._padsLength = el._padsLength || '1';     // '1'..'4' or 'latch'
    el._padsSweepBars = el._padsSweepBars || '2';
    const render = () => {
        const cat = audioEngine.catalogue || [];
        if (!cat.length) {
            panel.innerHTML = `<div class="pn-pads-hint">The pads appear once the audio engine is up (press Play).</div>`;
            if (el._djrustError) panel.firstChild.textContent = `The audio engine did not load: ${el._djrustError}`;
            return;
        }
        panel.innerHTML = padsHtml(el, cat);
        lightPads(panel, audioEngine.fxActive);
    };
    render();
    el._padsUnsub?.forEach((u) => u());
    el._padsUnsub = [
        audioEngine.on('ready', () => render()),
        audioEngine.on('failed', (why) => {
            if (!(audioEngine.catalogue || []).length) {
                panel.innerHTML = '<div class="pn-pads-hint pn-pads-failed"></div>';
                panel.firstChild.textContent = `The audio engine did not load: ${why}`;
            }
        }),
        audioEngine.on('fx', (active) => lightPads(panel, active)),
    ];

    panel.addEventListener('click', (ev) => {
        const chip = ev.target.closest('.pn-pads-len');
        if (chip) {
            if (chip.dataset.sweep) el._padsSweepBars = chip.dataset.len;
            else el._padsLength = chip.dataset.len;
            const row = chip.parentElement;
            row.querySelectorAll('.pn-pads-len').forEach((c) => c.classList.toggle('active', c === chip));
            return;
        }
        const pad = ev.target.closest('.pn-pad');
        if (!pad || pad.dataset.hold) return;
        tapPad(el, pad);
    });
    // a transition is held: pointer down engages it, the lift lets it go
    panel.addEventListener('pointerdown', (ev) => {
        const pad = ev.target.closest('.pn-pad[data-hold]');
        if (!pad) return;
        ev.preventDefault();
        try { pad.setPointerCapture(ev.pointerId); } catch { /* not an active pointer: the lift still lands on the pad */ }
        pad.classList.add('held');
        audioEngine.engage(pad.dataset.fx, 'momentary');
        const up = () => {
            pad.classList.remove('held');
            audioEngine.release(pad.dataset.fx);
            pad.removeEventListener('pointerup', up);
            pad.removeEventListener('pointercancel', up);
        };
        pad.addEventListener('pointerup', up);
        pad.addEventListener('pointercancel', up);
    });
    // keyboard: Enter / Space on a held pad fires it for a second
    panel.addEventListener('keydown', (ev) => {
        const pad = ev.target.closest('.pn-pad[data-hold]');
        if (!pad || (ev.key !== 'Enter' && ev.key !== ' ')) return;
        ev.preventDefault();
        audioEngine.engage(pad.dataset.fx, 'momentary');
        setTimeout(() => audioEngine.release(pad.dataset.fx), 1000);
    });
}

/** A tap: engage for the length picked, on the next bar; a tap on one that is on lets it go. */
function tapPad(el, pad) {
    const id = pad.dataset.fx;
    if (pad.dataset.state) {
        audioEngine.release(id);
        return;
    }
    const mode = pad.dataset.sweep ? el._padsSweepBars : el._padsLength;
    audioEngine.engage(id, mode);
    pad.dataset.state = 'pending';   // until djrust's next report
}

function lengthChips(selected, { latch, sweep }) {
    const opts = ['1', '2', '3', '4', ...(latch ? ['latch'] : [])];
    return `<div class="pn-pads-lens">${opts.map((v) =>
        `<button type="button" class="pn-pads-len${v === selected ? ' active' : ''}" data-len="${v}"${sweep ? ' data-sweep="1"' : ''}
            title="${v === 'latch' ? 'Latch: on until tapped again' : `${v} bar${v === '1' ? '' : 's'}`}">${v === 'latch' ? 'Latch' : v}</button>`).join('')}</div>`;
}

function padsHtml(el, cat) {
    const groups = new Map();
    for (const e of cat) {
        if (!groups.has(e.category)) groups.set(e.category, []);
        groups.get(e.category).push(e);
    }
    const head = `<div class="pn-pads-group pn-pads-head">
            <div class="pn-macro-group-label">Length <span class="pn-pads-note">lands on the next bar</span></div>
            ${lengthChips(el._padsLength, { latch: true })}
        </div>`;
    const body = [...groups].map(([id, items]) => {
        const transition = items.every((e) => e.transition);
        const sweep = !transition && items.every((e) => !e.latchable);
        const extra = transition ? '<span class="pn-pads-note">hold</span>'
            : sweep ? lengthChips(el._padsSweepBars, { latch: false, sweep: true }) : '';
        return `<div class="pn-pads-group" data-category="${esc(id)}">
            <div class="pn-macro-group-label">${esc(CATEGORY_LABELS[id] || id)} ${transition ? extra : ''}</div>
            ${sweep ? extra : ''}
            <div class="pn-pads-row">${items.map((e) => `<button type="button" class="pn-pad" data-fx="${esc(e.id)}"
                ${transition ? 'data-hold="1"' : ''}${sweep ? ' data-sweep="1"' : ''}
                title="${esc(e.label)}${transition ? ' — hold' : ' — tap: on at the next bar · tap again: off'}">${esc(e.label)}</button>`).join('')}</div>
        </div>`;
    }).join('');
    return head + body;
}

/** djrust's report of what is engaged → each pad's state (on / pending / latched). */
function lightPads(panel, active) {
    const by = new Map((active || []).map((a) => [a.id, a]));
    panel.querySelectorAll('.pn-pad').forEach((pad) => {
        const a = by.get(pad.dataset.fx);
        const state = !a ? '' : a.pending ? 'pending' : a.latched ? 'latched' : 'on';
        if (state) pad.dataset.state = state; else delete pad.dataset.state;
        pad.setAttribute('aria-pressed', state && state !== 'pending' ? 'true' : 'false');
    });
}
