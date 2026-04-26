// Mixer UI — row rendering, pattern/preset selects, per-row slider
// state save/restore, instrument preset manager, FX-state snapshot for
// bypass toggle, and tone-shape navigator (reset + forward/back random).
//
// Extracted from petri-note.js. Functions take the custom element as
// their first arg; petri-note.js keeps one-line class-method wrappers
// so `el._renderMixer()` etc. still works. Reads `el._project` /
// `el._mixerEl` / `el._channelInstruments` / `el._mutedNets` etc.

import { toneEngine, isDrumChannel } from '../../audio/tone-engine.js';
import { MIXER_SLIDERS, formatSliderReadout } from './mixer-sliders.js';
import { oneShotSpec, prettifyInstrumentName } from '../audio/oneshots.js';
import { showSliderTip, hideSliderTip, syncSliderTip } from './slider-tip.js';

// Resolve the section grouping for a net. Explicit `track.group` wins;
// otherwise we infer from the id (`hit*` → "stinger") so legacy shares
// that predate the group attribute still split out their beat-fire
// tracks into the Beats panel. Missing entirely → "main".
// Shared between the mixer (which uses it for divider placement and
// the _showOneShots hide filter) and build.js (which uses it to decide
// whether the Beats tab button is visible).
export function sectionGroupForNet(id, net) {
    const explicit = net?.track?.group;
    if (explicit) return explicit;
    if (/^hit\d+$/.test(id)) return 'stinger';
    return 'main';
}

export function isStingerTrack(id, net) {
    return sectionGroupForNet(id, net) === 'stinger';
}

// --- Render ---

export function renderMixer(el) {
    if (!el._mixerEl) return;

    // Save all current slider states before rebuilding DOM.
    el._mixerEl.querySelectorAll('.pn-mixer-row').forEach(row => {
        const netId = row.dataset.netId;
        if (netId) saveMixerSliderState(el, netId);
    });

    el._mixerEl.innerHTML = '';

    const instruments = el.getAvailableInstruments();

    // Group nets by riffGroup for collapsed display.
    const groups = new Map();
    const ungrouped = [];

    const sectionGroupFor = sectionGroupForNet;

    // Hide `stinger`-group tracks unless the Beats tab is toggled on.
    const hitsHidden = !el._showOneShots;
    for (const [id, net] of Object.entries(el._project.nets)) {
        if (net.role === 'control') continue;
        if (hitsHidden && sectionGroupFor(id, net) === 'stinger') continue;
        if (net.riffGroup) {
            if (!groups.has(net.riffGroup)) groups.set(net.riffGroup, []);
            groups.get(net.riffGroup).push(id);
        } else {
            ungrouped.push(id);
        }
    }

    // Sort: percussion → bass → melody → harmony → arp → rest.
    const roleOrder = ['kick', 'snare', 'hihat', 'clap', 'bass', 'melody', 'harmony', 'arp'];
    const percOrder = ['kick', 'snare', 'hihat', 'clap'];
    const roleIdx = (name) => {
        const i = roleOrder.indexOf(name);
        return i >= 0 ? i : roleOrder.length;
    };
    // Section ordering for dividers. Explicit groups slot in after the
    // built-in role order; unknown group names fall to the end alphabetically.
    const sectionOrder = ['drums', 'percussion', 'bass', 'chords', 'harmony', 'lead', 'melody', 'arp', 'pad', 'texture', 'stinger'];
    const sectionIdx = (section) => {
        if (section === 'main') return -1; // main goes first, no divider
        const i = sectionOrder.indexOf(section);
        return i >= 0 ? i : sectionOrder.length;
    };
    const sortedGroups = [...groups.entries()].sort(([a], [b]) => roleIdx(a) - roleIdx(b));

    // Grouped nets: single row per group showing group name.
    for (const [group, netIds] of sortedGroups) {
        const firstNet = el._project.nets[netIds[0]];
        const allMuted = netIds.every(nid => el._mutedNets.has(nid));
        const isActive = netIds.includes(el._activeNetId);
        const channel = firstNet.track?.channel || 1;
        const currentInstrument = firstNet.track?.instrument || el._channelInstruments[channel] || 'piano';

        const row = document.createElement('div');
        row.className = `pn-mixer-row ${isActive ? 'active' : ''}`;
        row.dataset.netId = netIds[0];
        row.dataset.riffGroup = group;

        const seenLetters = new Set();
        const variantLabels = [];
        const activeSlotId = netIds.find(id => !el._mutedNets.has(id));
        const activeLetter = activeSlotId
            ? (el._project.nets[activeSlotId]?.riffVariant || activeSlotId.slice(group.length + 1))
            : null;
        for (const nid of netIds) {
            const net = el._project.nets[nid];
            const letter = net?.riffVariant || nid.slice(group.length + 1);
            if (!seenLetters.has(letter)) {
                seenLetters.add(letter);
                variantLabels.push(`<span class="pn-riff-label ${letter === activeLetter ? 'active' : 'muted'}">${letter}</span>`);
            }
        }
        if (variantLabels.length === 0) {
            variantLabels.push(`<span class="pn-riff-label active">A</span>`);
        }
        const variantLabelsHtml = variantLabels.join('');

        const allManualMuted = netIds.every(nid => el._manualMutedNets.has(nid));
        row.innerHTML = `
            <input type="checkbox" class="pn-mixer-solo" data-riff-group="${group}" title="Lock mute — persists across regenerates" aria-label="Lock mute" ${allManualMuted ? 'checked' : ''}>
            <button class="pn-mixer-mute ${allMuted ? 'muted' : ''}" data-net-id="${netIds[0]}" data-riff-group="${group}" title="${allMuted ? 'Unmute all' : 'Mute all'}">
                ${allMuted ? '\u{1F507}' : '\u{1F50A}'}
            </button>
            <span class="pn-mixer-name">${group}</span>
            <span class="pn-riff-variants" title="Active riff variant — the letter shows which A/B/C subnet is playing">${variantLabelsHtml}</span>
            <select class="pn-mixer-instrument" data-net-id="${netIds[0]}" data-riff-group="${group}">
                ${instruments.map(inst => `
                    <option value="${inst}" ${currentInstrument === inst ? 'selected' : ''}>
                        ${inst.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
                    </option>
                `).join('')}
            </select>
            ${(firstNet.track?.instrumentSet?.length > 1) ? `<button class="pn-mixer-rotate" data-net-id="${netIds[0]}" data-riff-group="${group}" title="Next genre instrument">&raquo;</button>` : ''}
            <select class="pn-mixer-output" data-channel="${channel}" title="Audio output device">
                <option value="">Master</option>
            </select>
            ${patternSelectsHtml(el._project.nets[activeSlotId || netIds[0]], activeSlotId || netIds[0])}
            ${mixerSlidersHtml(netIds[0], percOrder.includes(group))}
            <button class="pn-mixer-save" data-net-id="${netIds[0]}" title="Save / load tone presets for this track">&#9733;</button>
            <button class="pn-mixer-test" data-net-id="${netIds[0]}" title="Test note">&#9835;</button>
            <button class="pn-mixer-tone-reset" data-net-id="${netIds[0]}" title="Reset tone">&#8634;</button>
            <button class="pn-mixer-tone-prev" data-net-id="${netIds[0]}" title="Previous tone">&lsaquo;</button>
            <button class="pn-mixer-tone-next" data-net-id="${netIds[0]}" title="Random tone">&rsaquo;</button>
        `;

        el._mixerEl.appendChild(row);
    }

    // Ungrouped nets in sorted order, interleaved with groups.
    const sortedUngrouped = [...ungrouped].sort((a, b) => roleIdx(a) - roleIdx(b));
    for (const id of sortedUngrouped) {
        const idx = roleIdx(id);
        const row = createMixerRow(el, id, instruments);
        const existing = [...el._mixerEl.children];
        const insertBefore = existing.find(node => {
            const nodeRole = node.dataset.riffGroup || node.dataset.netId;
            return roleIdx(nodeRole) > idx;
        });
        if (insertBefore) {
            el._mixerEl.insertBefore(row, insertBefore);
        } else {
            el._mixerEl.appendChild(row);
        }
    }

    // Sort rows into sections by resolved track.group, then insert a
    // divider between each section. "main" is the default bucket and
    // gets no header. Section order is explicit per `sectionOrder`;
    // unknown group names fall to the end alphabetically.
    const rowOf = (node) => {
        // For both grouped and ungrouped rows the data-net-id on the row
        // points at a representative net; use its track.group (or the
        // hit-name fallback) to decide which mixer section it belongs to.
        const nid = node.dataset.netId;
        const net = el._project.nets[nid];
        return { node, section: net ? sectionGroupFor(nid, net) : 'main' };
    };
    const children = [...el._mixerEl.children];
    const sorted = children
        .map(rowOf)
        .sort((a, b) => {
            const da = sectionIdx(a.section);
            const db = sectionIdx(b.section);
            if (da !== db) return da - db;
            // Within a section, keep the existing role-based order.
            const roleA = a.node.dataset.riffGroup || a.node.dataset.netId;
            const roleB = b.node.dataset.riffGroup || b.node.dataset.netId;
            return roleIdx(roleA) - roleIdx(roleB);
        });
    // Detach + reinsert in order, injecting dividers on section changes.
    for (const row of children) el._mixerEl.removeChild(row);
    let lastSection = null;
    for (const { node, section } of sorted) {
        if (section !== 'main' && section !== lastSection) {
            const label = section.charAt(0).toUpperCase() + section.slice(1);
            const membersInSection = sorted
                .filter(r => r.section === section)
                .map(r => r.node.dataset.riffGroup || r.node.dataset.netId)
                .filter(Boolean);
            const divider = document.createElement('div');
            divider.className = 'pn-mixer-divider';
            divider.dataset.section = section;
            divider.title = `Hover + tap a pad to bind it to mute / unmute the whole ${label} section`;
            divider.innerHTML = `<span class="pn-mixer-divider-label">${label}</span>` +
                `<span class="pn-mixer-divider-list">${membersInSection.join(' · ')}</span>`;
            el._mixerEl.appendChild(divider);
        }
        lastSection = section;
        el._mixerEl.appendChild(node);
    }

    el._populateAudioOutputs();

    // Event delegation: bind once.
    if (el._mixerEventsBound) {
        restoreMixerSliderState(el);
        return;
    }
    el._mixerEventsBound = true;

    bindMixerEvents(el);

    // Apply initial decay and volume per row.
    for (const row of el._mixerEl.querySelectorAll('.pn-mixer-row')) {
        const nid = row.dataset.netId;
        const net = el._project.nets[nid];
        if (!net) continue;
        const ch = net.track?.channel || 1;
        const decSlider = row.querySelector('.pn-mixer-decay');
        if (decSlider) toneEngine.setChannelDecay(ch, parseInt(decSlider.value) / 100);
        const volSel = row.querySelector('.pn-mixer-vol');
        if (volSel) toneEngine.controlChange(ch, 7, Math.round(parseInt(volSel.value, 10) * 127 / 100));
    }

    restoreMixerSliderState(el);
    el._populateAudioOutputs();
    const mixerEl = el._mixerEl;
    requestAnimationFrame(() => requestAnimationFrame(() => {
        if (mixerEl.isConnected) addDefaultNotches(mixerEl);
    }));
}

function bindMixerEvents(el) {
    el._mixerEl.addEventListener('pointerdown', async (e) => {
        if (e.target.closest('.pn-mixer-output') && !el._midiEnumerated) {
            el._midiEnumerated = true;
            try {
                await el._refreshMidiOutputs();
                await el._populateAudioOutputs();
            } catch {}
        }
    }, true);

    el._mixerEl.addEventListener('click', async (e) => {
        const muteBtn = e.target.closest('.pn-mixer-mute');
        if (muteBtn) {
            e.stopPropagation();
            const riffGroup = muteBtn.dataset.riffGroup;
            if (riffGroup) el._toggleMuteGroup(riffGroup);
            else           el._toggleMute(muteBtn.dataset.netId);
            return;
        }
        const testBtn = e.target.closest('.pn-mixer-test');
        if (testBtn) { e.stopPropagation(); el._testNote(testBtn.dataset.netId); return; }
        const toneResetBtn = e.target.closest('.pn-mixer-tone-reset');
        if (toneResetBtn) { e.stopPropagation(); toneReset(el, toneResetBtn.dataset.netId); return; }
        const tonePrev = e.target.closest('.pn-mixer-tone-prev');
        if (tonePrev) { e.stopPropagation(); toneNav(el, tonePrev.dataset.netId, -1); return; }
        const toneNext = e.target.closest('.pn-mixer-tone-next');
        if (toneNext) { e.stopPropagation(); toneNav(el, toneNext.dataset.netId, 1); return; }
        const saveBtn = e.target.closest('.pn-mixer-save');
        if (saveBtn) { e.stopPropagation(); openPresetManager(el, saveBtn.dataset.netId); return; }
        const rotateBtn = e.target.closest('.pn-mixer-rotate');
        if (rotateBtn) {
            e.stopPropagation();
            const netId = rotateBtn.dataset.netId;
            const riffGroup = rotateBtn.dataset.riffGroup;
            const net = el._project.nets[netId];
            const instSet = net?.track?.instrumentSet;
            if (!instSet || instSet.length < 2) return;

            const current = net.track?.instrument || instSet[0];
            const idx = instSet.indexOf(current);
            const next = instSet[(idx + 1) % instSet.length];

            const row = rotateBtn.closest('.pn-mixer-row');
            const select = row?.querySelector('.pn-mixer-instrument');
            if (select) select.value = next;

            const targetIds = riffGroup
                ? Object.keys(el._project.nets).filter(id => el._project.nets[id].riffGroup === riffGroup)
                : [netId];

            for (const tid of targetIds) {
                const n = el._project.nets[tid];
                if (n) {
                    const ch = n.track?.channel || 1;
                    n.track.instrument = next;
                    el._channelInstruments[ch] = next;
                    if (el._toneStarted) await toneEngine.loadInstrument(ch, next);
                }
            }
            const fireBtn = el.querySelector(`.pn-os-fire[data-macro="${netId}"]`);
            if (fireBtn) {
                const label = next === 'unbound'
                    ? prettifyInstrumentName(netId)
                    : (oneShotSpec(next)?.label || prettifyInstrumentName(next));
                fireBtn.textContent = `Fire ${label}`;
            }
            return;
        }
        const row = e.target.closest('.pn-mixer-row');
        if (row && !e.target.closest('select') && !e.target.closest('input')) {
            el._switchNet(row.dataset.netId);
        }
    });

    el._mixerEl.addEventListener('change', async (e) => {
        const soloCheckbox = e.target.closest('.pn-mixer-solo');
        if (soloCheckbox) {
            const checked = soloCheckbox.checked;
            const riffGroup = soloCheckbox.dataset.riffGroup;
            const netId = soloCheckbox.dataset.netId;

            const targetIds = riffGroup
                ? Object.keys(el._project.nets).filter(id => el._project.nets[id].riffGroup === riffGroup)
                : [netId];

            const batch = [];
            for (const nid of targetIds) {
                if (checked) {
                    el._manualMutedNets.add(nid);
                    el._mutedNets.add(nid);
                } else {
                    el._manualMutedNets.delete(nid);
                    el._mutedNets.delete(nid);
                }
                batch.push({ type: 'mute', netId: nid, muted: checked });
            }
            for (const msg of batch) el._sendWs(msg);
            el._debouncedRenderMixer();
            return;
        }
        const outputSelect = e.target.closest('.pn-mixer-output');
        if (outputSelect) {
            const channel = parseInt(outputSelect.dataset.channel, 10);
            const val = outputSelect.value;
            await el._setChannelRouting(channel, val);
            sessionStorage.setItem(`pn-channel-routing-${channel}`, val);
            return;
        }
        const sizeSel = e.target.closest('.pn-mixer-size');
        const hitsSel = e.target.closest('.pn-mixer-hits');
        if (sizeSel || hitsSel) {
            const row = e.target.closest('.pn-mixer-row');
            if (!row) return;
            const sizeEl = row.querySelector('.pn-mixer-size');
            const hitsEl = row.querySelector('.pn-mixer-hits');
            if (!sizeEl || !hitsEl) return;
            const netId = (sizeSel || hitsSel).dataset.netId;
            let size = parseInt(sizeEl.value, 10);
            let hits = parseInt(hitsEl.value, 10);
            if (!Number.isFinite(size) || size < 2) size = 2;
            if (size > 32) size = 32;
            if (!Number.isFinite(hits) || hits < 2) hits = 2;
            if (hits > size) {
                hits = size;
                hitsEl.innerHTML = hitsOptionsHtml(hits, size);
            } else if (sizeSel) {
                hitsEl.innerHTML = hitsOptionsHtml(hits, size);
            }
            el._sendWs({ type: 'update-track-pattern', netId, ringSize: size, beats: hits });
            return;
        }
        const instSelect = e.target.closest('.pn-mixer-instrument');
        if (instSelect) {
            const netId = instSelect.dataset.netId;
            const riffGroup = instSelect.dataset.riffGroup;
            const instrument = instSelect.value;

            const targetIds = riffGroup
                ? Object.keys(el._project.nets).filter(id => el._project.nets[id].riffGroup === riffGroup)
                : [netId];

            for (const tid of targetIds) {
                const net = el._project.nets[tid];
                if (net) {
                    const ch = net.track?.channel || 1;
                    net.track.instrument = instrument;
                    el._channelInstruments[ch] = instrument;
                    if (el._toneStarted) await toneEngine.loadInstrument(ch, instrument);
                }
            }
            // Mirror the swap to the backend so server-authoritative state
            // tracks the dropdown and the change fans out to other clients.
            // Worker-mode backends don't have an instrument-change handler,
            // so the post is a no-op there. Sent after the local load so
            // playback never stalls on the round-trip.
            el._sendWs({ type: 'instrument-change', netId, riffGroup: riffGroup || '', instrument });
            const fireBtn = el.querySelector(`.pn-os-fire[data-macro="${netId}"]`);
            if (fireBtn) {
                const label = instrument === 'unbound'
                    ? prettifyInstrumentName(netId)
                    : (oneShotSpec(instrument)?.label || prettifyInstrumentName(instrument));
                fireBtn.textContent = `Fire ${label}`;
            }
            return;
        }
    });

    el._mixerEl.addEventListener('input', (e) => {
        const slider = e.target.closest('.pn-mixer-slider');
        if (!slider) return;
        const netId = slider.dataset.netId;
        const net = el._project.nets[netId];
        if (!net) return;
        const ch = net.track?.channel || 1;
        const row = slider.closest('.pn-mixer-row');
        const drumRole = isDrumChannel(ch) ? (net.riffGroup || row?.dataset.riffGroup || netId) : null;

        saveMixerSliderState(el, netId);

        // Keep the floating slider tip in sync with drags / wheel /
        // keyboard nudges — only if the user is currently hovering
        // the same slider.
        syncSliderTip(slider, formatSliderReadout(slider.className, slider.value));

        const v = parseInt(slider.value);
        for (const [cls, , applyFactory] of MIXER_SLIDERS) {
            if (slider.classList.contains(cls)) {
                applyFactory(ch, drumRole)(v);
                return;
            }
        }
    });

    el._mixerEl.addEventListener('wheel', (e) => {
        const group = e.target.closest('.pn-mixer-slider-group');
        if (!group) return;
        e.preventDefault();
        const slider = group.querySelector('input[type="range"], select');
        if (!slider) return;
        const dir = e.deltaY < 0 ? 1 : -1;
        if (slider.tagName === 'SELECT') {
            const idx = slider.selectedIndex + dir;
            if (idx < 0 || idx >= slider.options.length) return;
            slider.selectedIndex = idx;
        } else {
            const min = parseInt(slider.min) || 0;
            const max = parseInt(slider.max) || 127;
            slider.value = Math.max(min, Math.min(max, parseInt(slider.value) + dir));
        }
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        slider.dispatchEvent(new Event('change', { bubbles: true }));
    }, { passive: false });

    el._mixerEl.addEventListener('mouseover', (e) => {
        const slider = e.target.closest('.pn-mixer-slider');
        if (slider) el._hoveredSlider = slider;
        // Mute-button hover tracking — handleMidiNoteOn picks this up
        // so a pad press while hovering a mute button creates a
        // {type:'mute'} pad binding for that riff group / net id.
        const mute = e.target.closest('.pn-mixer-mute');
        if (mute) el._hoveredMute = mute;
        // Section-divider hover — same flow but binds the pad to a
        // section-wide mute (drums / bass / melody / …), not a single
        // track. Useful for "kill the entire bass section" pads.
        const divider = e.target.closest('.pn-mixer-divider[data-section]');
        if (divider) el._hoveredSection = divider;
    });
    el._mixerEl.addEventListener('mouseout', (e) => {
        const slider = e.target.closest('.pn-mixer-slider');
        if (slider && slider === el._hoveredSlider) el._hoveredSlider = null;
        const mute = e.target.closest('.pn-mixer-mute');
        if (mute && mute === el._hoveredMute) el._hoveredMute = null;
        const divider = e.target.closest('.pn-mixer-divider[data-section]');
        if (divider && divider === el._hoveredSection) el._hoveredSection = null;
    });

    // Cursor-anchored value tip — follows the mouse over any slider
    // group and shows that slider's live formatted value. Positioned
    // via fixed offset, not inside the row, so the mixer's row layout
    // is unaffected by hover state.
    el._mixerEl.addEventListener('mousemove', (e) => {
        const group = e.target.closest('.pn-mixer-slider-group');
        if (!group) { hideSliderTip(); return; }
        const slider = group.querySelector('.pn-mixer-slider');
        if (!slider) return;
        showSliderTip(slider, formatSliderReadout(slider.className, slider.value), e.clientX, e.clientY);
    });
    el._mixerEl.addEventListener('mouseleave', () => hideSliderTip());
}

export function patternSelectsHtml(net, targetId) {
    if (!net || !net.track || !net.track.generator) return '';
    const placeCount = Object.keys(net.places || {}).length;
    let bindCount = 0;
    if (net.bindings) {
        bindCount = Object.keys(net.bindings).length;
    } else if (net.transitions) {
        for (const t of Object.values(net.transitions)) if (t && t.midi) bindCount++;
    }
    let size = Number.isFinite(net.track.ringSize) ? net.track.ringSize : placeCount;
    let hits = Number.isFinite(net.track.beats) ? net.track.beats : bindCount;
    if (size < 2) size = 2;
    if (size > 32) size = 32;
    if (hits < 2) hits = 2;
    if (hits > size) hits = size;

    let sizeOpts = '';
    for (let v = 2; v <= 32; v++) {
        sizeOpts += `<option value="${v}"${v === size ? ' selected' : ''}>${v}</option>`;
    }
    let hitsOpts = '';
    const hitsMax = Math.min(32, size);
    for (let v = 2; v <= hitsMax; v++) {
        hitsOpts += `<option value="${v}"${v === hits ? ' selected' : ''}>${v}</option>`;
    }
    return `
        <select class="pn-mixer-size" data-net-id="${targetId}" title="Ring size (steps)">${sizeOpts}</select>
        <select class="pn-mixer-hits" data-net-id="${targetId}" title="Beats (hits)">${hitsOpts}</select>
    `;
}

// --- Presets ---

export function loadPresets(el) {
    if (el._presets) return el._presets;
    try {
        const raw = localStorage.getItem('pn-instrument-presets');
        el._presets = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(el._presets)) el._presets = [];
    } catch {
        el._presets = [];
    }
    return el._presets;
}

export function savePresets(el) {
    localStorage.setItem('pn-instrument-presets', JSON.stringify(el._presets || []));
}

function generatePresetName(instrument) {
    const adjectives = [
        'Neon', 'Velvet', 'Crystal', 'Midnight', 'Golden', 'Electric', 'Cosmic',
        'Faded', 'Phantom', 'Solar', 'Liquid', 'Frozen', 'Burning', 'Silent',
        'Digital', 'Hollow', 'Iron', 'Violet', 'Crimson', 'Silver', 'Amber',
        'Azure', 'Jade', 'Obsidian', 'Ivory', 'Rusted', 'Wired', 'Broken',
        'Floating', 'Endless',
    ];
    const nouns = [
        'Drift', 'Pulse', 'Echo', 'Haze', 'Bloom', 'Wave', 'Storm', 'Glow',
        'Shade', 'Vibe', 'Circuit', 'Signal', 'Mirage', 'Orbit', 'Tide',
        'Vapor', 'Ember', 'Fracture', 'Horizon', 'Spine', 'Flicker', 'Reverb',
        'Cipher', 'Arc', 'Lattice', 'Prism', 'Rust', 'Grain', 'Thread', 'Void',
    ];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    const label = instrument.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    return `${label} \u00b7 ${adj} ${noun}`;
}

function captureRowSettings(row) {
    const settings = {};
    for (const [cls, key] of MIXER_SLIDERS) {
        const node = row.querySelector(`.${cls}`);
        if (node) settings[key] = node.value;
    }
    return settings;
}

export function saveCurrentPreset(el, netId) {
    const row = el._mixerEl?.querySelector(`.pn-mixer-row[data-net-id="${netId}"]`);
    if (!row) return;
    const net = el._project.nets[netId];
    if (!net) return;
    const ch = net.track?.channel || 1;
    const instrument = net.track?.instrument || el._channelInstruments[ch] || 'piano';
    loadPresets(el);
    const preset = {
        id: `${instrument}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: generatePresetName(instrument),
        instrument,
        channel: ch,
        settings: captureRowSettings(row),
        created: Date.now(),
    };
    el._presets.push(preset);
    savePresets(el);
    renderMixer(el);
}

export function applyPreset(el, netId, presetId) {
    loadPresets(el);
    const preset = el._presets.find(p => p.id === presetId);
    if (!preset) return;
    const row = el._mixerEl?.querySelector(`.pn-mixer-row[data-net-id="${netId}"]`);
    if (!row) return;
    const net = el._project.nets[netId];
    if (!net) return;
    const ch = net.track?.channel || 1;
    const drumRole = isDrumChannel(ch) ? (net.riffGroup || row.dataset.riffGroup || netId) : null;

    for (const [cls, key, applyFactory] of MIXER_SLIDERS) {
        const node = row.querySelector(`.${cls}`);
        const v = preset.settings[key];
        if (node && v != null) {
            node.value = v;
            applyFactory(ch, drumRole)(parseInt(v, 10));
        }
    }
    saveMixerSliderState(el, netId);
}

export function deletePreset(el, presetId) {
    loadPresets(el);
    el._presets = el._presets.filter(p => p.id !== presetId);
    savePresets(el);
    renderMixer(el);
}

export function openPresetManager(el, netId) {
    const net = el._project.nets[netId];
    if (!net) return;
    const ch = net.track?.channel || 1;
    const instrument = net.track?.instrument || el._channelInstruments[ch] || 'piano';

    const overlay = document.createElement('div');
    overlay.className = 'pn-modal-overlay';

    const render = () => {
        const all = loadPresets(el);
        const presets = all.filter(p => {
            if (typeof p.channel === 'number') return p.channel === ch;
            return p.instrument === instrument;
        });
        const list = presets.length === 0
            ? `<p class="pn-modal-desc">No presets yet. Save the current mixer settings to create one.</p>`
            : `<ul class="pn-preset-list">${presets.map(p => `
                <li class="pn-preset-item" data-preset-id="${p.id}">
                    <span class="pn-preset-name">${p.name.replace(/[<&]/g, c => ({ '<': '&lt;', '&': '&amp;' }[c]))}</span>
                    <button class="pn-preset-apply" data-preset-id="${p.id}">Apply</button>
                    <button class="pn-preset-delete" data-preset-id="${p.id}" title="Delete">&times;</button>
                </li>`).join('')}</ul>`;

        overlay.innerHTML = `
            <div class="pn-modal">
                <h2>Presets &mdash; ${instrument}</h2>
                <p class="pn-modal-desc">Save the current mixer panel (volume, pan, filters, decay) and restore it later on any track sharing this channel.</p>
                ${list}
                <div class="pn-modal-actions">
                    <button class="close">Close</button>
                    <button class="save">Save current as preset</button>
                </div>
            </div>
        `;
    };
    render();
    overlay.tabIndex = -1;
    el.appendChild(overlay);
    overlay.focus();

    const close = () => {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
    };
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.classList.contains('close')) {
            close();
            return;
        }
        if (e.target.classList.contains('save')) {
            saveCurrentPreset(el, netId);
            render();
            return;
        }
        const applyBtn = e.target.closest('.pn-preset-apply');
        if (applyBtn) {
            applyPreset(el, netId, applyBtn.dataset.presetId);
            close();
            return;
        }
        const delBtn = e.target.closest('.pn-preset-delete');
        if (delBtn) {
            const presetId = delBtn.dataset.presetId;
            const preset = loadPresets(el).find(p => p.id === presetId);
            const name = preset?.name || 'this preset';
            if (confirm(`Delete preset "${name}"?`)) {
                deletePreset(el, presetId);
                render();
            }
            return;
        }
    });
    const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); close(); }
    };
    document.addEventListener('keydown', onKey);
}

export function presetSelectHtml(el, instrument, channel) {
    const all = loadPresets(el);
    const presets = all.filter(p => {
        if (typeof p.channel === 'number' && typeof channel === 'number') return p.channel === channel;
        return p.instrument === instrument;
    });
    const opts = [`<option value="">&mdash; preset &mdash;</option>`];
    for (const p of presets) {
        opts.push(`<option value="${p.id}">${p.name.replace(/"/g, '&quot;')}</option>`);
    }
    return `<select class="pn-mixer-preset" title="Load saved preset">${opts.join('')}</select>`;
}

// --- Mixer state + row html + FX state + tone navigation ---

export function applyMixerStateToEngine(el) {
    if (!el._mixerEl) return;
    for (const row of el._mixerEl.querySelectorAll('.pn-mixer-row')) {
        const netId = row.dataset.netId;
        const net = el._project?.nets?.[netId];
        if (!net) continue;
        const ch = net.track?.channel || 1;
        const drumRole = isDrumChannel(ch) ? (net.riffGroup || row.dataset.riffGroup || netId) : null;
        for (const [cls, , applyFactory] of MIXER_SLIDERS) {
            const ctrl = row.querySelector(`.${cls}`);
            if (!ctrl) continue;
            const v = parseInt(ctrl.value, 10);
            if (!Number.isFinite(v)) continue;
            try { applyFactory(ch, drumRole)(v); } catch {}
        }
    }
}

export function loadPadBindings(el) {
    try {
        const raw = sessionStorage.getItem('pn-pad-bindings');
        if (raw) el._padBindings = new Map(JSON.parse(raw));
    } catch {}
}

export function savePadBindings(el) {
    try {
        sessionStorage.setItem('pn-pad-bindings', JSON.stringify([...el._padBindings]));
    } catch {}
}

export function hitsOptionsHtml(selected, sizeCap) {
    const cap = Math.min(32, Math.max(2, sizeCap));
    let opts = '';
    for (let v = 2; v <= cap; v++) {
        opts += `<option value="${v}"${v === selected ? ' selected' : ''}>${v}</option>`;
    }
    return opts;
}

export function mixerSlidersHtml(netId, isPercussion) {
    const decDefault = isPercussion ? 100 : 5;
    // No inline readout span: the value floats near the cursor via
    // the single .pn-slider-tip element below so tail icons stay
    // perfectly aligned across rows regardless of hover state.
    return `
            <div class="pn-mixer-slider-group">
                <span>Pan</span>
                <input type="range" class="pn-mixer-slider pn-mixer-pan" data-net-id="${netId}" data-default="64" min="0" max="127" value="64" aria-label="${netId} pan" title="Pan">
            </div>
            <div class="pn-mixer-slider-group">
                <span>Vol</span>
                <select class="pn-mixer-slider pn-mixer-vol" data-net-id="${netId}" data-default="80" aria-label="${netId} volume" title="Volume">${
                    Array.from({ length: 101 }, (_, v) =>
                        `<option value="${v}"${v === 80 ? ' selected' : ''}>${v}</option>`
                    ).join('')
                }</select>
            </div>
            <div class="pn-mixer-slider-group">
                <span>HP</span>
                <input type="range" class="pn-mixer-slider pn-mixer-locut" data-net-id="${netId}" data-default="0" min="0" max="100" value="0" aria-label="${netId} high-pass cutoff" title="Low cut (high-pass)">
            </div>
            <div class="pn-mixer-slider-group">
                <span>HPR</span>
                <input type="range" class="pn-mixer-slider pn-mixer-loreso" data-net-id="${netId}" data-default="5" min="0" max="100" value="5" aria-label="${netId} high-pass resonance" title="Low cut resonance">
            </div>
            <div class="pn-mixer-slider-group">
                <span>LP</span>
                <input type="range" class="pn-mixer-slider pn-mixer-cutoff" data-net-id="${netId}" data-default="100" min="0" max="100" value="100" aria-label="${netId} low-pass cutoff" title="High cut (low-pass)">
            </div>
            <div class="pn-mixer-slider-group">
                <span>LPR</span>
                <input type="range" class="pn-mixer-slider pn-mixer-reso" data-net-id="${netId}" data-default="5" min="0" max="100" value="5" aria-label="${netId} low-pass resonance" title="High cut resonance">
            </div>
            <div class="pn-mixer-slider-group">
                <span>Dec</span>
                <input type="range" class="pn-mixer-slider pn-mixer-decay" data-net-id="${netId}" data-default="${decDefault}" min="5" max="300" value="${decDefault}" aria-label="${netId} envelope decay" title="Envelope decay">
            </div>
            `;
}

export function createMixerRow(el, id, instruments) {
    const net = el._project.nets[id];
    const isMuted = el._mutedNets.has(id);
    const isActive = id === el._activeNetId;
    const channel = net.track?.channel || 1;
    const currentInstrument = net.track?.instrument || el._channelInstruments[channel] || 'piano';

    const row = document.createElement('div');
    row.className = `pn-mixer-row ${isActive ? 'active' : ''}`;
    row.dataset.netId = id;

    const isManualMuted = el._manualMutedNets.has(id);
    row.innerHTML = `
        <input type="checkbox" class="pn-mixer-solo" data-net-id="${id}" title="Lock mute — persists across regenerates" aria-label="Lock mute" ${isManualMuted ? 'checked' : ''}>
        <button class="pn-mixer-mute ${isMuted ? 'muted' : ''}" data-net-id="${id}" title="${isMuted ? 'Unmute' : 'Mute'}">
            ${isMuted ? '\u{1F507}' : '\u{1F50A}'}
        </button>
        <span class="pn-mixer-name">${id}</span>
        <span class="pn-riff-variants" title="Active riff variant — the letter shows which A/B/C subnet is playing"><span class="pn-riff-label active">A</span></span>
        <select class="pn-mixer-instrument" data-net-id="${id}">
            ${instruments.map(inst => `
                <option value="${inst}" ${currentInstrument === inst ? 'selected' : ''}>
                    ${inst.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
                </option>
            `).join('')}
        </select>
        ${(net.track?.instrumentSet?.length > 1) ? `<button class="pn-mixer-rotate" data-net-id="${id}" title="Next genre instrument">&raquo;</button>` : ''}
        <select class="pn-mixer-output" data-channel="${channel}" title="Audio output device">
            <option value="">Master</option>
        </select>
        ${patternSelectsHtml(net, id)}
        ${mixerSlidersHtml(id, isDrumChannel(channel))}
        <button class="pn-mixer-save" data-net-id="${id}" title="Save / load tone presets for this track">&#9733;</button>
        <button class="pn-mixer-test" data-net-id="${id}" title="Test note">&#9835;</button>
        <button class="pn-mixer-tone-reset" data-net-id="${id}" title="Reset tone">&#8634;</button>
        <button class="pn-mixer-tone-prev" data-net-id="${id}" title="Previous tone">&lsaquo;</button>
        <button class="pn-mixer-tone-next" data-net-id="${id}" title="Random tone">&rsaquo;</button>
    `;

    return row;
}

export function saveMixerSliderState(el, netId) {
    const row = el._mixerEl?.querySelector(`.pn-mixer-row[data-net-id="${netId}"]`);
    if (!row) return;
    const state = {};
    for (const [cls, key] of MIXER_SLIDERS) {
        state[key] = row.querySelector(`.${cls}`)?.value;
    }
    el._mixerSliderState.set(netId, state);
}

export function restoreMixerSliderState(el) {
    for (const [netId, state] of el._mixerSliderState) {
        const row = el._mixerEl?.querySelector(`.pn-mixer-row[data-net-id="${netId}"]`);
        if (!row) continue;
        const net = el._project.nets[netId];
        if (!net) continue;
        const ch = net.track?.channel || 1;
        const drumRole = isDrumChannel(ch) ? (net.riffGroup || row.dataset.riffGroup || netId) : null;

        for (const [cls, key, applyFactory] of MIXER_SLIDERS) {
            const node = row.querySelector(`.${cls}`);
            const val = state[key];
            if (node && val != null) {
                node.value = val;
                applyFactory(ch, drumRole)(parseInt(val));
            }
        }
    }
}

export function saveFxState(el) {
    const fxEl = el.querySelector('.pn-effects-panel');
    if (!fxEl) return;
    el._savedFxValues = {};
    fxEl.querySelectorAll('.pn-fx-slider').forEach(s => {
        el._savedFxValues[s.dataset.fx] = s.value;
    });
    el._savedFxBypassed = el._fxBypassed;
}

export function restoreFxState(el) {
    if (!el._savedFxValues) return;
    const fxEl = el.querySelector('.pn-effects-panel');
    if (!fxEl) return;
    for (const [fxName, val] of Object.entries(el._savedFxValues)) {
        const slider = fxEl.querySelector(`.pn-fx-slider[data-fx="${fxName}"]`);
        if (slider) {
            slider.value = val;
            slider.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }
    if (el._savedFxBypassed) {
        el._fxBypassed = true;
        const btn = el.querySelector('.pn-fx-bypass');
        if (btn) {
            btn.classList.add('active');
            btn.textContent = 'Bypassed';
        }
        toneEngine.setReverbWet(0);
        toneEngine.setDelayWet(0);
        toneEngine.setDistortion(0);
        toneEngine.setHighpassFreq(20);
        toneEngine.setLowpassFreq(20000);
        toneEngine.setPhaserWet(0);
        toneEngine.setCrush(0);
    }
    el._savedFxValues = null;
}

// Mark each range slider's default value with a CSS custom property so
// the stylesheet paints a tick via a linear-gradient.
export function addDefaultNotches(container) {
    container.querySelectorAll('input[type="range"][data-default]').forEach(slider => {
        const def = parseFloat(slider.dataset.default);
        const min = parseFloat(slider.min);
        const max = parseFloat(slider.max);
        if (!Number.isFinite(def) || max === min) return;
        const pct = Math.max(0, Math.min(100, ((def - min) / (max - min)) * 100));
        slider.style.setProperty('--default-pct', pct + '%');
    });
    container.querySelectorAll('.pn-slider-notch').forEach(n => n.remove());
}

// --- Tone reset / random / navigate ---

export function toneReset(el, netId) {
    const row = el._mixerEl?.querySelector(`.pn-mixer-row[data-net-id="${netId}"]`);
    if (!row) return;
    const net = el._project.nets[netId];
    if (!net) return;
    const ch = net.track?.channel || 1;
    const isPerc = isDrumChannel(ch);
    const drumRole = isPerc ? (net.riffGroup || row.dataset.riffGroup || netId) : null;
    const defaults = { locut: '0', lores: '5', cut: '100', res: '5', dec: isPerc ? '100' : '5' };
    for (const [cls, key, applyFactory] of MIXER_SLIDERS) {
        if (key === 'vol' || key === 'pan') continue;
        const node = row.querySelector(`.${cls}`);
        if (node && defaults[key] != null) {
            node.value = defaults[key];
            applyFactory(ch, drumRole)(parseInt(defaults[key]));
        }
    }
    saveMixerSliderState(el, netId);
    el._mixerToneHistory.delete(netId);
    el._mixerToneIndex.delete(netId);
}

export function randomToneConfig(isPerc) {
    const r = (lo, hi) => String(Math.floor(Math.random() * (hi - lo + 1)) + lo);
    return {
        vol: '127', pan: '64',
        locut: r(0, 40),
        lores: r(2, 25),
        cut: r(30, 100),
        res: r(2, 30),
        dec: isPerc ? r(30, 200) : r(5, 150),
    };
}

export function toneNav(el, netId, dir) {
    const row = el._mixerEl?.querySelector(`.pn-mixer-row[data-net-id="${netId}"]`);
    if (!row) return;
    const net = el._project.nets[netId];
    if (!net) return;
    const ch = net.track?.channel || 1;
    const isPerc = isDrumChannel(ch);
    const drumRole = isPerc ? (net.riffGroup || row.dataset.riffGroup || netId) : null;

    const readCurrent = () => {
        const state = {};
        for (const [cls, key] of MIXER_SLIDERS) {
            state[key] = row.querySelector(`.${cls}`)?.value;
        }
        return state;
    };

    const apply = (s) => {
        for (const [cls, key, applyFactory] of MIXER_SLIDERS) {
            if (key === 'vol' || key === 'pan') continue;
            const node = row.querySelector(`.${cls}`);
            if (node && s[key] != null) {
                node.value = s[key];
                applyFactory(ch, drumRole)(parseInt(s[key]));
            }
        }
        saveMixerSliderState(el, netId);
    };

    if (!el._mixerToneHistory.has(netId)) {
        el._mixerToneHistory.set(netId, [readCurrent()]);
        el._mixerToneIndex.set(netId, 0);
    }

    const history = el._mixerToneHistory.get(netId);
    let idx = el._mixerToneIndex.get(netId);

    if (dir > 0) {
        if (idx >= history.length - 1) {
            history.push(randomToneConfig(isPerc));
        }
        idx++;
    } else {
        if (idx <= 0) return;
        idx--;
    }

    el._mixerToneIndex.set(netId, idx);
    apply(history[idx]);
}
