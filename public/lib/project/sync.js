// Project-sync pipeline — applying a new/preview/uploaded project onto
// the live element: instrument loading (pooled-promote or cold), default
// per-role pan spread, the big _applyProjectSync orchestrator that
// cancels animations, updates state, rebuilds the UI, restores Feel,
// layers pending share overrides, and kicks playback.
//
// Extracted from petri-note.js. Functions take the custom element
// as first arg; petri-note.js keeps one-line class-method wrappers.

import { toneEngine, INSTRUMENT_CONFIGS } from '../../audio/tone-engine.js';
import { GENRE_INSTRUMENTS } from '../generator/genre-instruments.js';
import { injectTransitionNet } from '../macros/runtime.js';
import { stageOnProjectSync } from '../ui/stage.js';

export function applyProjectInstruments(el, project) {
    const nets = project.nets || {};
    let usedTrackInstruments = false;

    // Try pooled promote first (preview pre-warmed the synth → pointer
    // swap, no Tone allocation on the audio-scheduling thread). Fall
    // through to loadInstrument only for channels that weren't prewarmed.
    for (const [, net] of Object.entries(nets)) {
        if (net.track?.instrument && net.role !== 'control') {
            const ch = net.track.channel || 1;
            const inst = net.track.instrument;
            el._channelInstruments[ch] = inst;
            if (el._toneStarted) {
                if (!toneEngine.promotePooledInstrument(ch, inst)) {
                    toneEngine.loadInstrument(ch, inst);
                }
            }
            usedTrackInstruments = true;
        }
    }

    // Fallback: genre-based mapping.
    if (!usedTrackInstruments) {
        const genreName = (project.name || '').split(' ')[0].toLowerCase();
        const genreInst = GENRE_INSTRUMENTS[genreName] || {};
        for (const [ch, inst] of Object.entries(genreInst)) {
            const chNum = parseInt(ch);
            el._channelInstruments[chNum] = inst;
            if (el._toneStarted) {
                if (!toneEngine.promotePooledInstrument(chNum, inst)) {
                    toneEngine.loadInstrument(chNum, inst);
                }
            }
        }
    }
    // Drop anything still pooled (preview channels we didn't end up
    // using) so memory doesn't grow across regens.
    if (el._toneStarted) toneEngine.clearPool();

    // Subtle default pan spread per track role.
    applyDefaultPans(el, nets);
}

// Build the next track's synths into the tone-engine pool one-at-a-time
// while the current track still plays. Awaiting each keeps Tone.js
// allocations serialized so each individual hitch is tiny.
export async function prewarmPreviewInstruments(el, project) {
    if (!el._toneStarted || !project?.nets) return;
    const seen = new Set();
    for (const net of Object.values(project.nets)) {
        if (net.role === 'control') continue;
        const inst = net.track?.instrument;
        const ch = net.track?.channel;
        if (!inst || ch == null) continue;
        const key = `${ch}:${inst}`;
        if (seen.has(key)) continue;
        seen.add(key);
        try { await toneEngine.preloadInstrument(ch, inst); }
        catch (err) { console.warn('preloadInstrument failed:', err); }
    }
}

export function applyDefaultPans(el, nets) {
    // CC10 values: 64 = center. Offsets below are gentle (±24 max).
    const ROLE_PAN = {
        kick:   64, snare: 60, hihat: 84, clap: 44,
        bass:   64, melody: 54,
        harmony: 74, arp: 80,
        hit1: 40, hit2: 88, hit3: 56, hit4: 72,
    };
    for (const [id, net] of Object.entries(nets)) {
        if (net.role === 'control') continue;
        const ch = net.track?.channel;
        if (ch == null) continue;
        const key = net.riffGroup || id;
        const pan = ROLE_PAN[key] ?? 64;
        if (pan !== 64) toneEngine.controlChange(ch, 10, pan);
    }
}

// Apply a buffered project-sync (called immediately or at bar boundary).
export function applyProjectSync(el, project, seamless = false) {
    // Cancel any in-flight macro animations — their tokens reference DOM
    // nodes about to be replaced and channels whose snapshots no longer
    // apply.
    if (el._chanAnim) {
        for (const id of Object.keys(el._chanAnim)) {
            const t = el._chanAnim[id];
            if (t) { t.cancelled = true; if (t.hardStop) clearTimeout(t.hardStop); }
        }
        el._chanAnim = {};
    }
    if (el._pulseAnim) {
        for (const id of Object.keys(el._pulseAnim)) {
            const t = el._pulseAnim[id];
            if (t) t.cancelled = true;
        }
        el._pulseAnim = {};
    }
    el.querySelectorAll('.pn-pulsing, .pn-pulsing-hot').forEach(node => {
        node.classList.remove('pn-pulsing', 'pn-pulsing-hot');
    });
    // Master-FX sweep/hold in progress? Snap their sliders back to the
    // pre-macro start BEFORE cancelling so the new project doesn't
    // inherit a half-swept reverb / delay / filter.
    if (el._fxAnim) {
        for (const key of Object.keys(el._fxAnim)) {
            const t = el._fxAnim[key];
            if (!t) continue;
            t.cancelled = true;
            if (t.slider && typeof t.start === 'number') {
                el._setFxValue(t.slider, t.start);
            }
        }
        el._fxAnim = {};
    }
    el._autoDjPreviewPending = false;

    // Tag the incoming project with the Feel-engaged snapshot.
    if (typeof project._feelsApplied !== 'boolean') {
        project._feelsApplied = !!el._nextGenerateWithFeels;
    }
    el._nextGenerateWithFeels = false;

    // Auto-DJ transition (when armed) is now injected server-side in
    // the worker's `generate` handler, so the transition net is
    // already present on project.nets when we land here. Just label
    // the status pill for UX.
    el._injectTransitionOnNextSync = false;
    if (project?.nets) {
        const transitionNetId = Object.keys(project.nets)
            .find(k => k.startsWith('macro:transition:'));
        if (transitionNetId) {
            const macroId = transitionNetId.split(':')[2] || '';
            const statusEl = el.querySelector('.pn-autodj-status');
            if (statusEl && macroId) statusEl.textContent = `⟳ ${macroId}`;
        }
    }

    el._project = project;
    el._normalizeProject();
    el._vizHistory = [];
    // Save to track history (unless navigating back). Capped at 99.
    if (!el._navingHistory) {
        if (el._trackIndex < el._trackHistory.length - 1) {
            el._trackHistory.length = el._trackIndex + 1;
        }
        el._trackHistory.push(JSON.parse(JSON.stringify(project)));
        const MAX_TRACK_HISTORY = 99;
        while (el._trackHistory.length > MAX_TRACK_HISTORY) {
            el._trackHistory.shift();
        }
        el._trackIndex = el._trackHistory.length - 1;
    }
    el._navingHistory = false;
    el._tempo = project.tempo || 120;
    el._swing = project.swing || 0;
    el._humanize = project.humanize || 0;
    el._structure = project.structure || null;
    el._tick = 0; el._lastPlayheadPct = 0;
    el._loopStart = 0;
    el._loopEnd = 0;
    el._sendWs({ type: 'loop', startTick: -1, endTick: -1 });
    const netIds = Object.keys(project.nets || {});
    el._activeNetId = netIds.find(id => project.nets[id].role !== 'control') || netIds[0] || null;
    applyProjectInstruments(el, project);
    el._reapplyChannelRoutings();
    const prevGenre = el.querySelector('.pn-genre-select')?.value;
    const prevStructure = el.querySelector('.pn-structure-select')?.value;
    el._saveFxState();
    el._buildUI();
    el._setupEventListeners();
    el._restoreFxState();
    el._renderNet();
    el._updateWsStatus();
    const genreSelect = el.querySelector('.pn-genre-select');
    if (genreSelect) {
        if (prevGenre && genreSelect.querySelector(`option[value="${prevGenre}"]`)) {
            genreSelect.value = prevGenre;
        } else {
            const genreMatch = (project.name || '').split(' ')[0].toLowerCase();
            if (genreSelect.querySelector(`option[value="${genreMatch}"]`)) {
                genreSelect.value = genreMatch;
            }
        }
    }
    const structSelect = el.querySelector('.pn-structure-select');
    if (structSelect && prevStructure) {
        structSelect.value = prevStructure;
    }
    el._updateTraits();
    el._updateFeelIconDisengaged();
    el._markGenreTilde(!el._feelDisengaged);
    el._updateProjectNameDisplay();
    stageOnProjectSync(el);
    // Apply pending share overrides one-shot.
    if (el._pendingShareOverrides) {
        const ov = el._pendingShareOverrides;
        el._pendingShareOverrides = null;
        el._applyShareOverrides(ov);
    }
    if (el._firstLoad) {
        el._firstLoad = false;
        el._sendWs({ type: 'project-load', project: el._project });
        el._playing = false;
        const playBtn = el.querySelector('.pn-play');
        if (playBtn) playBtn.innerHTML = '&#9654;';
        if (el._showWelcomeOnSync) {
            el._showWelcomeOnSync = false;
            el._showWelcomeCard?.();
        }
        return;
    }
    if (seamless) {
        el._playing = true;
        el._vizStartLoop();
    } else {
        el._sendWs({ type: 'project-load', project: el._project });
        el._playing = true;
        el._vizStartLoop();
        el._sendWs({ type: 'transport', action: 'play' });
    }
    const playBtn = el.querySelector('.pn-play');
    if (playBtn) playBtn.textContent = '⏹';
    el._setupMediaSession();
    el._updateMediaSessionState();

}

// Handle instruments-changed message from server (after shuffle).
export function onInstrumentsChanged(el, instruments) {
    if (!instruments || !el._project) return;

    for (const [netId, instrumentName] of Object.entries(instruments)) {
        const net = el._project.nets[netId];
        if (!net) continue;
        if (!net.track) net.track = {};
        net.track.instrument = instrumentName;
        const ch = net.track.channel || 1;
        el._channelInstruments[ch] = instrumentName;
        if (el._toneStarted) {
            if (!toneEngine.promotePooledInstrument(ch, instrumentName)) {
                toneEngine.loadInstrument(ch, instrumentName);
            }
        }
    }

    el._renderMixer();
    el._reapplyChannelRoutings();
}

export function getAvailableInstruments() {
    return Object.keys(INSTRUMENT_CONFIGS).sort();
}

export function getCurrentInstruments(el) {
    const instruments = {};
    if (!el._project?.nets) return instruments;
    for (const [netId, net] of Object.entries(el._project.nets)) {
        if (net.track?.instrument) instruments[netId] = net.track.instrument;
    }
    return instruments;
}
