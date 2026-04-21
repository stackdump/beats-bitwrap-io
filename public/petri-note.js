/**
 * petri-note.js - Custom HTMLElement for Petri net music sequencer
 *
 * A music sequencer where Petri net transitions trigger MIDI notes.
 */

import { toneEngine, INSTRUMENT_CONFIGS, isDrumChannel } from './audio/tone-engine.js';
import {
    b64urlEncode, b64urlDecode,
    canonicalizeJSON, sha256,
    encodeBase58, decodeBase58,
    createCIDv1Bytes, computeCidForJsonLd,
    gzipToB64Url, b64UrlToGunzip,
} from './lib/share/codec.js';
import { MIXER_SLIDERS, hpFreq, lpFreq, qCurve } from './lib/ui/mixer-sliders.js';
import { MACROS, MACRO_TARGETS, TRANSITION_MACRO_IDS, collectMacroTargets } from './lib/macros/catalog.js';
import {
    ONESHOT_INSTRUMENTS, ONESHOT_HP, ONESHOT_LP, ONESHOT_Q, ONESHOT_ATK, ONESHOT_DEC,
    oneShotSpec, prettifyInstrumentName,
} from './lib/audio/oneshots.js';
import { GENRE_INSTRUMENTS } from './lib/generator/genre-instruments.js';
import {
    collectFxState, collectFeelState, collectAutoDjState,
    collectDisabledMacros, collectTrackOverrides, collectInitialMutes,
    buildSharePayload,
} from './lib/share/collect.js';
import {
    applyFxState, applyFeelState, applyAutoDjState,
    applyDisabledMacros, applyTrackOverrides, applyShareOverrides,
} from './lib/share/apply.js';
import {
    parseShareFromUrl, shareFromPayload,
    buildShareUrlForms, buildShareUrl,
    uploadShare, fetchShare, onShareClick,
} from './lib/share/url.js';
import { loadUploadedProject, serializeProject, downloadProject } from './lib/project/serialize.js';
import {
    applyProjectInstruments, prewarmPreviewInstruments, applyDefaultPans,
    applyProjectSync, onInstrumentsChanged,
    getAvailableInstruments as getAvailableInstrumentsFn,
    getCurrentInstruments,
} from './lib/project/sync.js';
import { noteToName, nameToNote } from './lib/audio/note-name.js';
import {
    renderNet, centerNet, createPlaceElement, createTransitionElement,
    renderFrame, drawRing, draw, drawArrowhead, viewToModel,
    renderTimeline, updatePlayhead, updateLoopMarkers,
} from './lib/ui/canvas.js';
import {
    openMidiEditor, fireTransition,
    showQuickstartModal, showHelpModal, showWelcomeCard,
} from './lib/ui/dialogs.js';
import { buildUI } from './lib/ui/build.js';
import { toggleStage } from './lib/ui/stage.js';
import {
    fxSweep, runBeatRepeat, runCompound,
    setTempoTransient, tempoHold, tempoSweep,
    fxHold, cancelAllMacros,
} from './lib/macros/effects.js';
import {
    cyclePlaybackMode, togglePlay,
    showAudioLockBanner, hideAudioLockBanner,
    acquireWakeLock, releaseWakeLock,
    setupMediaSession, updateMediaSessionState, setTempo,
    connectBackend, connectWorker, connectWebSocket,
    scheduleReconnect, updateWsStatus, sendWs, handleWsMessage,
    onRemoteTransitionFired, humanizeNote, swingDelay, onStateSync,
} from './lib/backend/index.js';
import {
    initAudio, connectMidiInputs,
    sliderBindingKey, resolveBinding,
    handleMidiMessage, handleMidiCC, handleMidiNoteOn,
    ensureToneStarted, toggleAudioMode, refreshMidiOutputs,
    toggleMute, toggleMuteGroup, debouncedRenderMixer,
    playNote, reapplyChannelRoutings, setChannelRouting,
    playTone, playWebMidi, setChannelInstrument,
    vizColorForNet, vizSpawnParticle,
    vizStartLoop, vizStopLoop, vizDrawFrame, vizDrawTimeline,
} from './lib/backend/audio-io.js';
import {
    musicNets, panicMacros, fireMacro, executeMacro,
    snapshotOneShot, applyOneShotSnapshot, oneShotToneReset,
    oneShotToneStep, oneShotFavorite, bindLongPressToggle,
    toggleMacroDisabled, loadDisabledMacros, saveDisabledMacros,
    refreshMacroDisabledMarks, saveAutoDjSettings, restoreAutoDjSettings,
    autoDjTick, pickTransitionMacroId, fireTransitionMacro,
    transitionNetJson, injectTransitionNet, autoDjFireMacros,
    autoDjSpin, autoDjSpinAnimate, fireRepeatingOneShots,
    markMacroRunning, updateQueuedBadges, ONESHOT_SLIDER_KEYS,
} from './lib/macros/runtime.js';
import {
    renderMixer, patternSelectsHtml, presetSelectHtml,
    loadPresets, savePresets, saveCurrentPreset, applyPreset, deletePreset,
    openPresetManager, applyMixerStateToEngine, loadPadBindings,
    savePadBindings, hitsOptionsHtml, mixerSlidersHtml, createMixerRow,
    saveMixerSliderState, restoreMixerSliderState, saveFxState, restoreFxState,
    addDefaultNotches, toneReset, randomToneConfig, toneNav,
} from './lib/ui/mixer.js';
import {
    updateTraits, initTraitClicks, traitMeta, genreTraitDefault, openTraitEditor,
    setFxByKey, setAutoDjValue,
    applyFeel, saveFeelSettings, restoreFeelSettings,
    markGenreTilde, disengageFeel, updateFeelIconDisengaged, openFeelModal,
    fxSlider, setFxValue, macroPulse, channelParamMove,
} from './lib/ui/controllers.js';


// Diagram is read-only — all changes come from generator/shuffle

class PetriNote extends HTMLElement {
    constructor() {
        super();

        // Project state
        this._project = null;
        this._activeNetId = null;
        this._ldScript = null;

        // WebSocket
        this._ws = null;
        this._wsReconnectTimer = null;
        this._hasInitialProject = false;

        // Track history (for fwd/back navigation between generated tracks)
        this._trackHistory = [];   // array of project snapshots
        this._trackIndex = -1;     // current position in history

        // Transport
        this._playbackMode = 'single'; // 'single' | 'repeat' | 'shuffle'
        this._pendingNextTrack = null;  // pre-fetched project for shuffle
        this._prefetchSent = false;     // avoid duplicate prefetch requests
        // Monotonic id for preview-generate requests so late `preview-ready`
        // messages (the ones we gave up on and fell back from) can be dropped.
        // Without this, a stale preview slides into _pendingNextTrack and
        // triggers a second regen at the next boundary — the "regens twice"
        // symptom in Auto-DJ.
        this._previewReqId = 0;
        this._playing = false;
        this._tempo = 120;
        this._swing = 0;     // 0-100 swing percentage
        this._humanize = 0;  // 0-100 humanize amount
        this._structure = null; // [{name, steps}, ...]
        this._tick = 0; this._lastPlayheadPct = 0;
        this._loopStart = 0; this._loopEnd = 0; // loop marker tick positions (set to track bounds on load)
        this._draggingMarker = null; // 'start' | 'end' | null
        this._tickTimestamp = 0;  // when last tick was received (for interpolation)
        this._pendingInstruments = null;    // buffered instruments-changed for bar-quantized apply
        this._pendingBarTarget = 0;         // tick at which to apply pending changes (next bar)

        // Audio — Set of enabled global output modes: 'web-audio', 'web-midi'
        this._audioModes = new Set(['web-audio']);
        this._audioCtx = null;
        this._midiAccess = null;
        this._midiOutputId = null; // Selected MIDI output port ID
        this._channelRouting = new Map(); // channel -> { kind: 'audio'|'midi', id: string }

        // Rendering
        this._canvas = null;
        this._ctx = null;
        this._stage = null;
        this._nodes = {}; // id -> DOM element
        this._view = { scale: 1, tx: 0, ty: 0 };
        this._dpr = window.devicePixelRatio || 1;

        // Interaction state (read-only diagram — pan/zoom only)
        this._panning = null;
        this._spaceHeld = false;

        // History
        this._history = [];
        this._redo = [];
        this._lastSnap = null;

        // Visualization state
        this._vizParticles = []; // {x, y, color, life, maxLife, netId, size}
        this._vizTrackGlow = {}; // netId -> glow intensity (0-1)
        this._vizRafId = null;
        this._vizHistory = []; // rolling history: {time, netId, note}

        // Audio state (initialized here so methods can access before _initAudio)
        this._toneStarted = false;
        this._instruments = new Map();
        this._mutedChannels = new Set();
        this._mutedNets = new Set();      // automated mute (from server/structure)
        this._manualMutedNets = new Set(); // user permanent mute (checkbox)
        this._channelInstruments = {
            1: 'piano',
            2: 'electric-piano',
            3: 'pad',
            4: 'lead',
            5: 'pluck',
            6: 'bass',
            10: 'drums'
        };
        this._mixerSliderState = new Map(); // netId -> { vol, pan, cut, res, dec }
        this._mixerToneHistory = new Map(); // netId -> [configs...]
        this._mixerToneIndex = new Map();  // netId -> current index in history

        // MIDI CC → slider binding (keyed by logical ID, survives DOM rebuild)
        this._ccBindings = new Map();   // cc# -> { key, selector }
        this._hoveredSlider = null;     // slider currently under cursor
        this._midiInputConnected = false;

        // MIDI pad → macro bindings
        this._padBindings = new Map();   // note# -> macroId
        this._hoveredMacro = null;       // macro button currently under cursor
        this._loadPadBindings();
    }

    connectedCallback() {
        this._firstLoad = true;
        this._loadProject();
        this._buildUI();
        this._setupEventListeners();
        this._bindGlobalWheel();
        this._connectBackend();
        this._initAudio();
        this._renderNet();
        this._watchAudioContextState();
        // Welcome card fires from _applyProjectSync once the first
        // project lands — we need genre/seed/tempo to render it.
        // Convention: ?title=… in the URL forces the card to show
        // on every load (the title is the whole point of the link;
        // the recipient should see it even on return visits). Plain
        // visits gate on the first-visit flag as before.
        const hasUrlTitle = new URLSearchParams(location.search).has('title');
        this._showWelcomeOnSync = hasUrlTitle
            || (!localStorage.getItem('pn-welcome-seen')
                && !localStorage.getItem('pn-quickstart-seen'));
    }

    _bindGlobalWheel() {
        // Universal hover-and-scroll adjustment on inputs and selects.
        // Uses capture phase so it runs before any passive document listeners.
        this.addEventListener('wheel', (e) => {
            const t = e.target;
            if (!t || !t.tagName) return;
            if (t.disabled || t.readOnly) return;
            if (t.closest('.pn-modal') == null && t.closest('petri-note') == null) return;

            if (t.tagName === 'SELECT') {
                e.preventDefault();
                e.stopPropagation();
                // Wheel up → next option (higher value for ascending-value selects).
                const dir = e.deltaY < 0 ? 1 : -1;
                const idx = t.selectedIndex + dir;
                if (idx < 0 || idx >= t.options.length) return;
                t.selectedIndex = idx;
                t.dispatchEvent(new Event('input', { bubbles: true }));
                t.dispatchEvent(new Event('change', { bubbles: true }));
                return;
            }
            if (t.tagName === 'INPUT' && (t.type === 'number' || t.type === 'range')) {
                e.preventDefault();
                e.stopPropagation();
                const stepAttr = parseFloat(t.step) || 1;
                const dir = e.deltaY < 0 ? 1 : -1;
                const min = parseFloat(t.min);
                const max = parseFloat(t.max);
                let v = parseFloat(t.value);
                if (!Number.isFinite(v)) v = Number.isFinite(min) ? min : 0;
                v = v + dir * stepAttr;
                if (Number.isFinite(min) && v < min) v = min;
                if (Number.isFinite(max) && v > max) v = max;
                t.value = String(v);
                t.dispatchEvent(new Event('input', { bubbles: true }));
                t.dispatchEvent(new Event('change', { bubbles: true }));
                return;
            }
        }, { passive: false, capture: true });
    }

    _watchAudioContextState() {
        const ctx = window.Tone?.context?.rawContext;
        if (!ctx) return;
        const sync = () => {
            if (this._playing && ctx.state !== 'running') this._showAudioLockBanner();
            else this._hideAudioLockBanner();
        };
        ctx.addEventListener('statechange', sync);
        this._ctxListenerBound = true;
        // Re-sync whenever _playing toggles
        this._ctxStateSync = sync;
        // Initial check after a tick so _playing has a chance to be set by auto-play
        setTimeout(sync, 0);
    }

    disconnectedCallback() {
        if (this._worker) {
            this._worker.terminate();
        }
        if (this._ws) {
            this._ws.close();
        }
        if (this._wsReconnectTimer) {
            clearTimeout(this._wsReconnectTimer);
        }
    }

    // === Project Management ===

    _loadProject() {
        // Check for inline LD+JSON first
        const ldScript = this.querySelector('script[type="application/ld+json"]');
        if (ldScript) {
            try {
                this._project = JSON.parse(ldScript.textContent);
            } catch (e) {
                console.error('Failed to parse project JSON:', e);
            }
        }
        const hasInlineNets = Object.keys((this._project || {}).nets || {}).length > 0;
        this._normalizeProject();
        this._activeNetId = Object.keys(this._project.nets)[0] || null;

        // Default project is generated via WebSocket on first connect (see _connectWebSocket)
    }

    _normalizeProject() {
        const p = this._project || (this._project = {});
        p['@context'] ||= 'https://beats.bitwrap.io/schema';
        p['@type'] ||= 'PetriNoteProject';
        p.name ||= 'Untitled';
        p.tempo ||= 120;
        p.nets ||= {};
        p.connections ||= [];

        // Ensure at least one net
        if (Object.keys(p.nets).length === 0) {
            p.nets['track-1'] = this._createEmptyNet();
        }

        // Normalize each net
        for (const [id, net] of Object.entries(p.nets)) {
            this._normalizeNet(net);
        }

        this._tempo = p.tempo;
        this._swing = p.swing || 0;
        this._humanize = p.humanize || 0;
    }

    _normalizeNet(net) {
        net['@type'] ||= 'PetriNet';
        net.track ||= { channel: 1, defaultVelocity: 100 };
        net.places ||= {};
        net.transitions ||= {};
        net.arcs ||= [];

        // Normalize places
        for (const [id, place] of Object.entries(net.places)) {
            place.x = Number(place.x || 0);
            place.y = Number(place.y || 0);
            place.initial = Array.isArray(place.initial) ? place.initial : [place.initial || 0];
            place.tokens = place.tokens ?? [...place.initial];
        }

        // Normalize transitions
        for (const [id, trans] of Object.entries(net.transitions)) {
            trans.x = Number(trans.x || 0);
            trans.y = Number(trans.y || 0);
            // midi binding is optional
        }

        // Normalize arcs
        for (const arc of net.arcs) {
            arc.weight = Array.isArray(arc.weight) ? arc.weight : [arc.weight || 1];
            arc.inhibit = arc.inhibit || false;
        }

        // Regenerate ring layout when coords are absent (compact export format)
        const hasCoords = Object.values(net.places).some(p => p.x !== 0 || p.y !== 0) ||
                          Object.values(net.transitions).some(t => t.x !== 0 || t.y !== 0);
        if (!hasCoords) this._recomputeLayout(net);
    }

    _recomputeLayout(net) {
        const n = Object.keys(net.places).length;
        if (n === 0) return;
        let radius = n * 70.0 / (2 * Math.PI * 0.7);
        if (radius < 150) radius = 150;
        const cx = radius + 80, cy = radius + 80;

        const placeLabels = Object.keys(net.places).sort((a, b) => {
            return (parseInt(a.replace(/\D/g, ''), 10) || 0) - (parseInt(b.replace(/\D/g, ''), 10) || 0);
        });
        for (let i = 0; i < placeLabels.length; i++) {
            const angle = (i / n) * 2 * Math.PI;
            net.places[placeLabels[i]].x = cx + radius * 0.7 * Math.cos(angle);
            net.places[placeLabels[i]].y = cy + radius * 0.7 * Math.sin(angle);
        }

        const transLabels = Object.keys(net.transitions).sort((a, b) => {
            return (parseInt(a.replace(/\D/g, ''), 10) || 0) - (parseInt(b.replace(/\D/g, ''), 10) || 0);
        });
        for (let i = 0; i < transLabels.length; i++) {
            const angle = ((i + 0.5) / transLabels.length) * 2 * Math.PI;
            net.transitions[transLabels[i]].x = cx + radius * Math.cos(angle);
            net.transitions[transLabels[i]].y = cy + radius * Math.sin(angle);
        }
    }

    _createEmptyNet() {
        return {
            '@type': 'PetriNet',
            track: { channel: 1, defaultVelocity: 100 },
            places: {},
            transitions: {},
            arcs: []
        };
    }

    _getActiveNet() {
        return this._project?.nets?.[this._activeNetId] || null;
    }

    // === UI Building ===

    _buildUI() { return buildUI(this); }


    _updateTraits() { return updateTraits(this); }
    _initTraitClicks() { return initTraitClicks(this); }
    _traitMeta() { return traitMeta(); }
    _genreTraitDefault(g, param) { return genreTraitDefault(g, param); }
    _openTraitEditor(param) { return openTraitEditor(this, param); }


    // --- Mixer UI — thin wrappers around ./lib/ui/mixer.js ---

    _renderMixer() { return renderMixer(this); }
    _patternSelectsHtml(net, targetId) { return patternSelectsHtml(net, targetId); }
    _loadPresets() { return loadPresets(this); }
    _savePresets() { return savePresets(this); }
    _saveCurrentPreset(netId) { return saveCurrentPreset(this, netId); }
    _applyPreset(netId, presetId) { return applyPreset(this, netId, presetId); }
    _deletePreset(presetId) { return deletePreset(this, presetId); }
    _openPresetManager(netId) { return openPresetManager(this, netId); }
    _presetSelectHtml(instrument, channel) { return presetSelectHtml(this, instrument, channel); }

    // --- Macros runtime — thin wrappers around ./lib/macros/runtime.js ---

    _musicNets() { return musicNets(this); }
    _panicMacros() { return panicMacros(this); }
    _fireMacro(id) { return fireMacro(this, id); }
    _executeMacro(id) { return executeMacro(this, id); }
    static get _ONESHOT_SLIDER_KEYS() { return ONESHOT_SLIDER_KEYS; }
    _snapshotOneShot(macroId) { return snapshotOneShot(this, macroId); }
    _applyOneShotSnapshot(macroId, snap) { return applyOneShotSnapshot(this, macroId, snap); }
    _oneShotToneReset(macroId) { return oneShotToneReset(this, macroId); }
    _oneShotToneStep(macroId, dir) { return oneShotToneStep(this, macroId, dir); }
    _oneShotFavorite(macroId, ev) { return oneShotFavorite(this, macroId, ev); }
    _bindLongPressToggle(panel) { return bindLongPressToggle(this, panel); }
    _toggleMacroDisabled(id) { return toggleMacroDisabled(this, id); }
    _loadDisabledMacros() { return loadDisabledMacros(this); }
    _saveDisabledMacros() { return saveDisabledMacros(this); }
    _refreshMacroDisabledMarks() { return refreshMacroDisabledMarks(this); }
    _saveAutoDjSettings() { return saveAutoDjSettings(this); }
    _restoreAutoDjSettings(autoDjBtn, panel) { return restoreAutoDjSettings(this, autoDjBtn, panel); }
    _autoDjTick(prevTick, curTick) { return autoDjTick(this, prevTick, curTick); }
    _pickTransitionMacroId() { return pickTransitionMacroId(this); }
    _fireTransitionMacro() { return fireTransitionMacro(this); }
    _transitionNetJson(macroId) { return transitionNetJson(macroId); }
    _injectTransitionNet(project) { return injectTransitionNet(this, project); }
    _autoDjFireMacros() { return autoDjFireMacros(this); }
    _autoDjSpin(steps) { return autoDjSpin(this, steps); }
    _autoDjSpinAnimate() { return autoDjSpinAnimate(this); }
    _fireRepeatingOneShots(prevTick, curTick) { return fireRepeatingOneShots(this, prevTick, curTick); }
    _markMacroRunning(id, durationMs) { return markMacroRunning(this, id, durationMs); }
    _updateQueuedBadges() { return updateQueuedBadges(this); }

    _msPerBar() {
        const ppq = 4;
        const ticksPerBar = 16;
        return (60000 / ((this._tempo || 120) * ppq)) * ticksPerBar;
    }

    // --- Feel/FX surface helpers — thin wrappers around ./lib/ui/controllers.js ---

    _setFxByKey(fxKey, value) { return setFxByKey(this, fxKey, value); }
    _setAutoDjValue(key, value) { return setAutoDjValue(this, key, value); }
    _applyFeel(puck) { return applyFeel(this, puck); }
    _saveFeelSettings() { return saveFeelSettings(this); }
    _restoreFeelSettings() { return restoreFeelSettings(this); }
    _markGenreTilde(on) { return markGenreTilde(this, on); }
    _disengageFeel() { return disengageFeel(this); }
    _updateFeelIconDisengaged() { return updateFeelIconDisengaged(this); }
    _openFeelModal() { return openFeelModal(this); }
    _fxSlider(fxKey) { return fxSlider(this, fxKey); }
    _setFxValue(slider, value) { return setFxValue(slider, value); }
    _macroPulse(elements, durationMs, tag) { return macroPulse(this, elements, durationMs, tag); }
    _channelParamMove(macro, durationMs) { return channelParamMove(this, macro, durationMs); }

    // --- Macro effects — thin wrappers around ./lib/macros/effects.js ---

    _fxSweep(fxKey, toValue, durationMs) { return fxSweep(this, fxKey, toValue, durationMs); }
    _runBeatRepeat(macro, durationMs) { return runBeatRepeat(this, macro, durationMs); }
    _runCompound(macro, duration, durationUnit, msPerTick) { return runCompound(this, macro, duration, durationUnit, msPerTick); }
    _setTempoTransient(bpm) { return setTempoTransient(this, bpm); }
    _tempoHold(factor, durationMs) { return tempoHold(this, factor, durationMs); }
    _tempoSweep(finalBpm, durationMs) { return tempoSweep(this, finalBpm, durationMs); }
    _fxHold(fxKey, toValue, durationMs, tailFrac) { return fxHold(this, fxKey, toValue, durationMs, tailFrac); }
    _cancelAllMacros() { return cancelAllMacros(this); }

    // Push every mixer row's current slider/select values onto the tone engine.
    // Needed after instruments load (strips are just created with defaults).
    _applyMixerStateToEngine() { return applyMixerStateToEngine(this); }
    _loadPadBindings() { return loadPadBindings(this); }
    _savePadBindings() { return savePadBindings(this); }
    _hitsOptionsHtml(selected, sizeCap) { return hitsOptionsHtml(selected, sizeCap); }
    _mixerSlidersHtml(netId, isPercussion) { return mixerSlidersHtml(netId, isPercussion); }
    _createMixerRow(id, instruments) { return createMixerRow(this, id, instruments); }
    _saveMixerSliderState(netId) { return saveMixerSliderState(this, netId); }
    _restoreMixerSliderState() { return restoreMixerSliderState(this); }
    _saveFxState() { return saveFxState(this); }
    _restoreFxState() { return restoreFxState(this); }
    _addDefaultNotches(container) { return addDefaultNotches(container); }
    _toneReset(netId) { return toneReset(this, netId); }
    _randomToneConfig(isPerc) { return randomToneConfig(isPerc); }
    _toneNav(netId, dir) { return toneNav(this, netId, dir); }

    async _testNote(netId) {
        const net = this._project.nets[netId];
        if (!net) return;
        const channel = net.track?.channel || 1;
        let note = 60;
        if (isDrumChannel(channel)) {
            const roleNote = { kick: 36, snare: 38, hihat: 42, clap: 39 };
            note = roleNote[net.riffGroup] ?? roleNote[netId] ?? 36;
        }
        // Stinger rows: transpose by the Pitch dropdown in the Stingers panel
        // so the Test Note button auditions with whatever pitch the user has
        // dialed in on the Fire pad.
        const pitchSel = this.querySelector(`.pn-os-pitch[data-macro="${netId}"]`);
        if (pitchSel) {
            const semi = parseInt(pitchSel.value, 10);
            if (Number.isFinite(semi)) note += semi;
        }
        await this._playNote({ note, velocity: 100, duration: 200, channel });
    }

    _renderTimeline() { return renderTimeline(this); }
    _updatePlayhead() { return updatePlayhead(this); }
    _updateLoopMarkers() { return updateLoopMarkers(this); }


    // Track settings now handled by _renderMixer()

    _resizeCanvas() {
        const rect = this._canvas.parentElement.getBoundingClientRect();
        this._canvas.width = rect.width * this._dpr;
        this._canvas.height = rect.height * this._dpr;
        this._canvas.style.width = rect.width + 'px';
        this._canvas.style.height = rect.height + 'px';
        this._ctx = this._canvas.getContext('2d');
        this._ctx.scale(this._dpr, this._dpr);
        this._centerNet();
        this._draw();
    }

    // === Event Listeners ===

    async _populateAudioOutputs() {
        const audioEnabled = this._audioModes.has('web-audio');
        const midiEnabled = this._audioModes.has('web-midi');

        // Skip device enumeration (and its mic-permission prompt) unless the
        // user has opted into MIDI routing — the output dropdowns are hidden
        // until then.
        if (!midiEnabled) return;

        const devices = await toneEngine.listOutputDevices();

        // Lazy-load MIDI outputs (requires user permission) — only if browser supports it
        let midiOutputs = [];
        if (this._midiAccess) {
            midiOutputs = [...this._midiAccess.outputs.values()];
        }

        const audioOpts = audioEnabled
            ? devices.map((d, i) => `<option value="audio:${d.deviceId}">${d.label || `Output ${i + 1}`}</option>`).join('')
            : '';
        const midiOpts = midiEnabled
            ? midiOutputs.map((p) => `<option value="midi:${p.id}">${p.name || p.id}</option>`).join('')
            : '';

        const perChannelOpts =
            '<option value="">Master</option>' +
            (audioOpts ? `<optgroup label="Audio">${audioOpts}</optgroup>` : '') +
            (midiOpts ? `<optgroup label="MIDI">${midiOpts}</optgroup>` : '');

        for (const chanSel of this.querySelectorAll('.pn-mixer-output')) {
            const ch = chanSel.dataset.channel;
            const saved = sessionStorage.getItem(`pn-channel-routing-${ch}`) || '';
            chanSel.innerHTML = perChannelOpts;
            if (saved && chanSel.querySelector(`option[value="${CSS.escape(saved)}"]`)) {
                chanSel.value = saved;
            }
        }
    }

    _setupEventListeners() {
        // Global (document / window / navigator) listeners attach exactly
        // once per instance — _setupEventListeners gets called on every
        // _buildUI rebuild, and re-adding these without removing the old
        // ones piled up duplicates that GC couldn't reap because document
        // and window outlive every DOM rebuild.
        this._attachGlobalListeners();

        // Transport controls
        this.querySelector('.pn-play').addEventListener('click', () => this._togglePlay());
        this._populateAudioOutputs();
        this.querySelector('.pn-playback-mode').addEventListener('click', () => this._cyclePlaybackMode());
        this.querySelector('.pn-tempo input').addEventListener('change', (e) => {
            this._setTempo(parseInt(e.target.value, 10));
        });
        this.querySelector('.pn-tempo').addEventListener('wheel', (e) => {
            e.preventDefault();
            const input = this.querySelector('.pn-tempo input');
            const step = e.deltaY < 0 ? 1 : -1;
            this._setTempo(parseInt(input.value, 10) + step);
        }, { passive: false });
        this.querySelector('.pn-tap-tempo')?.addEventListener('click', () => this._tapTempo());

        // Track navigation
        this.querySelector('.pn-track-prev').addEventListener('click', () => this._navTrack(-1));
        this.querySelector('.pn-track-next').addEventListener('click', () => this._navTrack(1));
        this._updateTrackLabel();

        // Generate: triggered by button, genre change, or structure change.
        // Debounce so rapid clicks don't queue duplicate worker generations.
        let _lastGenerateAt = 0;
        const doGenerate = () => {
            const now = performance.now();
            if (now - _lastGenerateAt < 350) return;
            _lastGenerateAt = now;
            toneEngine.resumeContext();
            this._ensureToneStarted();
            const genre = this.querySelector('.pn-genre-select').value;
            const params = { ...(this._traitOverrides || {}) };
            const structure = this.querySelector('.pn-structure-select').value;
            if (structure) params.structure = structure;
            // Always tag the generation with a concrete seed so the current
            // track is reproducible via Share. Without this, compose() falls
            // back to Date.now() and the seed is effectively unknown.
            if (typeof params.seed !== 'number') {
                params.seed = Math.floor(Math.random() * 0x7fffffff);
            }
            this._currentGen = { genre, params: { ...params } };
            // Snapshot whether Feel was engaged at generate time so the
            // project name can carry "· feels" only when this specific
            // track was produced with Feel overrides active. Cleared
            // automatically when a fresh (non-feels) generate lands.
            this._nextGenerateWithFeels = !this._feelDisengaged;
            // When Auto-DJ is armed, a manual Generate should cross-fade
            // through a transition macro the same way the Regen timer
            // does. Ship the transition net with the generate message
            // so the worker adds it to the composed project before
            // queueing — landing it server-side survives both the
            // cold-start (project-load) and seamless-swap (project-
            // queue / bar-boundary) paths without a client-side
            // injection that the worker's already-swapped project
            // would never see.
            let injectTransitionNet = null;
            if (this.querySelector('.pn-autodj-enable')?.checked) {
                const macroId = pickTransitionMacroId(this);
                if (macroId) {
                    injectTransitionNet = {
                        netId: `macro:transition:${macroId}:${Date.now().toString(36)}`,
                        net: transitionNetJson(macroId),
                    };
                }
            }
            this._sendWs({ type: 'generate', genre, params, injectTransitionNet });
        };
        this.querySelector('.pn-generate-btn').addEventListener('click', doGenerate);
        // Genre change: drop any Feel-written trait overrides so the NEW
        // genre's defaults (BPM, swing, humanize, drum-fills, walking-bass,
        // tension-curve, etc.) take effect cleanly. Users can re-open the
        // Feel modal to layer their sliders back on top.
        this.querySelector('.pn-genre-select').addEventListener('change', () => {
            this._traitOverrides = {};
            // Drop any per-trait user locks — the new genre provides a fresh
            // baseline so Feel gets full authority again until the user
            // manually pins something.
            this._feelTraitLocks = new Set();
            const genreKey = this.querySelector('.pn-genre-select').value;
            const baseBpm = this._genreData?.[genreKey]?.bpm;
            if (baseBpm) this._setTempo(baseBpm);
            this._feelDisengaged = true;
            this._updateFeelIconDisengaged();
            this._markGenreTilde(false);
            doGenerate();
        });
        this.querySelector('.pn-structure-select').addEventListener('change', doGenerate);


        // Shuffle instruments button
        this.querySelector('.pn-shuffle-btn').addEventListener('click', () => {
            this._sendWs({ type: 'shuffle-instruments' });
        });

        // Save to server button
        this.querySelector('.pn-save-btn').addEventListener('click', () => {
            this._saveToServer();
        });

        // Leaderboard button
        this.querySelector('.pn-leaderboard-btn').addEventListener('click', () => {
            this._showLeaderboard();
        });

        // Download track button
        this.querySelector('.pn-download-btn').addEventListener('click', () => {
            this._downloadProject();
        });

        this.querySelector('.pn-share-btn')?.addEventListener('click', () => {
            this._onShareClick();
        });

        this.querySelector('.pn-wakelock-btn')?.addEventListener('click', () => {
            this._toggleWakeLock();
        });

        // Upload track button
        const uploadInput = this.querySelector('.pn-upload-input');
        this.querySelector('.pn-upload-btn').addEventListener('click', () => {
            uploadInput.click();
        });
        uploadInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            file.text().then(text => {
                const proj = JSON.parse(text);
                this._loadUploadedProject(proj);
            }).catch(err => console.error('Failed to load project:', err));
            uploadInput.value = '';
        });

        // Audio mode (multi-select: either, both, or neither)
        this.querySelector('.pn-audio-mode').addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-mode]');
            if (btn) {
                this._toggleAudioMode(btn.dataset.mode);
            }
        });

        // Help modal
        this.querySelector('.pn-help-btn')?.addEventListener('click', () => {
            this._showHelpModal();
        });

        // Full-page Stage
        this.querySelector('.pn-stage-btn')?.addEventListener('click', () => {
            this._toggleStage();
        });

        // Canvas interactions (pan/zoom only)
        this._canvas.parentElement.addEventListener('pointerdown', (e) => this._onPointerDown(e));
        this._canvas.parentElement.addEventListener('pointermove', (e) => this._onPointerMove(e));
        this._canvas.parentElement.addEventListener('pointerup', (e) => this._onPointerUp(e));
        // Wheel zoom disabled — let the page scroll naturally

    }

    _attachGlobalListeners() {
        if (this._globalListenersAttached) return;
        this._globalListenersAttached = true;

        window.addEventListener('resize', () => this._resizeCanvas());

        if (navigator.mediaDevices?.addEventListener) {
            navigator.mediaDevices.addEventListener('devicechange', () => this._populateAudioOutputs());
        }

        document.addEventListener('keydown', (e) => {
            if (e.key === ' ') this._spaceHeld = true;
            this._onKeyDown(e);
        });
        document.addEventListener('keyup', (e) => {
            if (e.key === ' ') this._spaceHeld = false;
        });
    }

    // === Rendering ===

    // --- Canvas rendering — thin wrappers around ./lib/ui/canvas.js ---

    _renderNet() { return renderNet(this); }
    _centerNet() { return centerNet(this); }
    _createPlaceElement(id, place) { return createPlaceElement(this, id, place); }
    _createTransitionElement(id, trans) { return createTransitionElement(this, id, trans); }
    _renderFrame() { return renderFrame(this); }
    _drawRing(ctx, playing) { return drawRing(this, ctx, playing); }
    _draw() { return draw(this); }
    _drawArrowhead(ctx, x1, y1, x2, y2) { return drawArrowhead(ctx, x1, y1, x2, y2); }
    _viewToModel(vx, vy) { return viewToModel(this, vx, vy); }
    _noteToName(note) { return noteToName(note); }
    _nameToNote(name) { return nameToNote(name); }

    // === Pointer Events ===

    // Diagram is read-only — no panning, dragging, or zooming
    _onPointerDown(e) {}
    _onPointerMove(e) {}
    _onPointerUp(e) {}
    _onWheel(e) {}

    _onKeyDown(e) {
        const tag = e.target.tagName;
        const inInput = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.target.isContentEditable;
        const modalOpen = !!document.querySelector('.pn-modal-overlay, .pn-welcome-modal, .pn-stage-overlay');

        // Space to play/stop (works anywhere except text fields)
        if (e.key === ' ' && !inInput) {
            e.preventDefault();
            this._togglePlay();
            return;
        }

        // Arrow keys adjust hovered slider — always active
        if (this._hoveredSlider && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            e.preventDefault();
            const slider = this._hoveredSlider;
            const step = (e.key === 'ArrowUp' || e.key === 'ArrowRight') ? 1 : -1;
            const min = parseInt(slider.min) || 0;
            const max = parseInt(slider.max) || 127;
            slider.value = Math.max(min, Math.min(max, parseInt(slider.value) + step));
            slider.dispatchEvent(new Event('input', { bubbles: true }));
            return;
        }

        // Single-letter shortcuts — skip when typing or when a modal owns keys
        if (inInput || modalOpen || e.metaKey || e.ctrlKey || e.altKey) return;
        const k = e.key.toLowerCase();
        switch (k) {
            case 'g': e.preventDefault(); this.querySelector('.pn-generate-btn')?.click(); return;
            case 's': e.preventDefault(); this.querySelector('.pn-shuffle-btn')?.click(); return;
            case 'f': e.preventDefault(); this._openFeelModal(); return;
            case 'm': e.preventDefault(); this._toggleStage(); return;
            case 't': e.preventDefault(); this._tapTempo(); return;
            case '?': e.preventDefault(); this.querySelector('.pn-help-btn')?.click(); return;
            case '1': case '2': case '3': case '4': {
                const pad = this.querySelector(`.pn-os-fire[data-macro="hit${k}"]`);
                if (pad) { e.preventDefault(); pad.click(); }
                return;
            }
            case '[': e.preventDefault(); this.querySelector('.pn-track-prev')?.click(); return;
            case ']': e.preventDefault(); this.querySelector('.pn-track-next')?.click(); return;
        }
    }

    _tapTempo() {
        const now = performance.now();
        if (!this._tapHistory) this._tapHistory = [];
        // drop taps older than 2s — that's a new count-in
        this._tapHistory = this._tapHistory.filter(t => now - t < 2000);
        this._tapHistory.push(now);
        if (this._tapHistory.length < 2) return;
        const intervals = [];
        for (let i = 1; i < this._tapHistory.length; i++) {
            intervals.push(this._tapHistory[i] - this._tapHistory[i - 1]);
        }
        const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        const bpm = Math.round(60000 / avgMs);
        if (bpm >= 40 && bpm <= 240) this._setTempo(bpm);
    }

    _loadUploadedProject(proj) { return loadUploadedProject(this, proj); }
    _serializeProject() { return serializeProject(this); }
    _downloadProject() { return downloadProject(this); }

    async _saveToServer() {
        // Show tag input modal
        this.querySelector('.pn-save-overlay')?.remove();
        const overlay = document.createElement('div');
        overlay.className = 'pn-save-overlay pn-help-overlay';
        overlay.innerHTML = `
            <div class="pn-help-modal" style="max-width:320px">
                <h2>Save Track</h2>
                <p style="margin:0 0 12px;color:#999">Enter your 4-character tag (arcade initials)</p>
                <input class="pn-tag-input" type="text" maxlength="4" placeholder="ABCD"
                    style="font-size:24px;text-align:center;width:120px;background:#0f3460;border:1px solid #4a90d9;
                    color:#fff;padding:8px;border-radius:4px;text-transform:uppercase;letter-spacing:4px;font-family:monospace">
                <div style="margin-top:12px;display:flex;gap:8px;justify-content:center">
                    <button class="pn-save-confirm" style="padding:6px 16px;background:#f5a623;border:none;border-radius:4px;
                        color:#000;font-weight:600;cursor:pointer">Save</button>
                    <button class="pn-save-sign" style="padding:6px 16px;background:#4a90d9;border:none;border-radius:4px;
                        color:#fff;font-weight:600;cursor:pointer" title="Sign with MetaMask to prove ownership">Sign & Save</button>
                    <button class="pn-save-cancel" style="padding:6px 16px;background:transparent;border:1px solid #0f3460;
                        border-radius:4px;color:#666;cursor:pointer">Cancel</button>
                </div>
                <p class="pn-save-status" style="margin:8px 0 0;font-size:11px;color:#666;text-align:center"></p>
            </div>
        `;
        this.appendChild(overlay);
        const input = overlay.querySelector('.pn-tag-input');
        const status = overlay.querySelector('.pn-save-status');
        input.focus();

        const doSave = async (sign) => {
            const tag = input.value.toUpperCase();
            if (!/^[A-Za-z0-9]{4}$/.test(tag)) {
                status.textContent = 'Tag must be exactly 4 alphanumeric characters';
                status.style.color = '#e94560';
                return;
            }
            const proj = this._serializeProject();
            const body = { project: proj, tag };

            if (sign && window.ethereum) {
                try {
                    status.textContent = 'Requesting wallet signature...';
                    status.style.color = '#4a90d9';
                    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
                    const address = accounts[0];
                    // We need the CID first — compute client-side or get from server
                    // Send without sig first to get CID, then sign
                    const preResp = await fetch('/api/save', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body),
                    });
                    const preResult = await preResp.json();
                    const cid = preResult.cid;

                    const message = `own:petri-note:${cid}`;
                    const signature = await window.ethereum.request({
                        method: 'personal_sign',
                        params: [message, address]
                    });
                    // Re-save with ownership proof
                    body.address = address;
                    body.signature = signature;
                } catch (err) {
                    status.textContent = 'Wallet signing cancelled';
                    status.style.color = '#e94560';
                    return;
                }
            }

            try {
                status.textContent = 'Saving...';
                status.style.color = '#4a90d9';
                const resp = await fetch('/api/save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                const result = await resp.json();
                status.textContent = `Saved! CID: ${result.cid?.slice(0, 12)}...`;
                status.style.color = '#2ecc71';
                setTimeout(() => overlay.remove(), 1500);
            } catch (err) {
                status.textContent = 'Save failed';
                status.style.color = '#e94560';
            }
        };

        overlay.querySelector('.pn-save-confirm').addEventListener('click', () => doSave(false));
        overlay.querySelector('.pn-save-sign').addEventListener('click', () => doSave(true));
        overlay.querySelector('.pn-save-cancel').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(false); });
    }

    async _showLeaderboard() {
        this.querySelector('.pn-leaderboard-overlay')?.remove();
        const overlay = document.createElement('div');
        overlay.className = 'pn-leaderboard-overlay pn-help-overlay';
        overlay.innerHTML = `
            <div class="pn-help-modal" style="max-width:650px">
                <button class="pn-help-close">&times;</button>
                <h2>Leaderboard</h2>
                <div class="pn-lb-list" style="color:#999;font-size:12px">Loading...</div>
            </div>
        `;
        this.appendChild(overlay);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay || e.target.closest('.pn-help-close')) overlay.remove();
        });

        try {
            const resp = await fetch('/api/tracks');
            const tracks = await resp.json();
            const list = overlay.querySelector('.pn-lb-list');
            if (!tracks || tracks.length === 0) {
                list.textContent = 'No saved tracks yet. Save a track to appear here!';
                return;
            }
            list.innerHTML = `
                <table style="width:100%;border-collapse:collapse;font-size:13px">
                    <thead>
                        <tr style="border-bottom:1px solid #0f3460;color:#666;text-align:left">
                            <th style="padding:4px 8px">#</th>
                            <th style="padding:4px 8px">Tag</th>
                            <th style="padding:4px 8px">Track</th>
                            <th style="padding:4px 8px">Genre</th>
                            <th style="padding:4px 8px;text-align:right">Votes</th>
                            <th style="padding:4px 8px"></th>
                        </tr>
                    </thead>
                    <tbody>
                        ${tracks.map((t, i) => `
                            <tr style="border-bottom:1px solid #0a1628" data-cid="${t.cid}">
                                <td style="padding:6px 8px;color:#666">${i + 1}</td>
                                <td style="padding:6px 8px;color:#f5a623;font-family:monospace;font-weight:bold">${t.tag || '????'}</td>
                                <td style="padding:6px 8px">
                                    <a href="#" class="pn-lb-load" style="color:#4a90d9;text-decoration:none">${t.name}</a>
                                </td>
                                <td style="padding:6px 8px;color:#666">${t.genre}</td>
                                <td style="padding:6px 8px;text-align:right;color:#ccc">${t.votes}</td>
                                <td style="padding:6px 8px">
                                    <button class="pn-lb-vote" style="background:transparent;border:1px solid #0f3460;
                                        color:#2ecc71;cursor:pointer;padding:2px 8px;border-radius:3px;font-size:12px"
                                        title="Upvote with MetaMask">&#9650;</button>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            `;

            // Load track on click
            list.addEventListener('click', async (e) => {
                const link = e.target.closest('.pn-lb-load');
                if (link) {
                    e.preventDefault();
                    const row = link.closest('tr');
                    const cid = row?.dataset.cid;
                    if (!cid) return;
                    try {
                        const resp = await fetch(`/api/tracks/${cid}`);
                        const proj = await resp.json();
                        this._loadUploadedProject(proj);
                        overlay.remove();
                    } catch (err) {
                        console.error('Load failed:', err);
                    }
                }
            });

            // Vote on click
            list.addEventListener('click', async (e) => {
                const btn = e.target.closest('.pn-lb-vote');
                if (!btn) return;
                const row = btn.closest('tr');
                const cid = row?.dataset.cid;
                if (!cid) return;
                await this._upvoteTrack(cid, btn, row);
            });
        } catch (err) {
            overlay.querySelector('.pn-lb-list').textContent = 'Failed to load leaderboard';
        }
    }

    async _upvoteTrack(cid, btn, row) {
        if (!window.ethereum) {
            alert('Install MetaMask to vote');
            return;
        }
        try {
            const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
            const address = accounts[0];
            const message = `upvote:petri-note:${cid}`;
            const signature = await window.ethereum.request({
                method: 'personal_sign',
                params: [message, address]
            });
            const resp = await fetch('/api/vote', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cid, address, signature }),
            });
            const result = await resp.json();
            if (result.ok) {
                // Update vote count in the row
                const voteCell = row?.querySelector('td:nth-child(5)');
                if (voteCell) voteCell.textContent = result.votes;
                if (btn) {
                    btn.style.color = '#f5a623';
                    btn.disabled = true;
                }
            }
        } catch (err) {
            console.error('Vote failed:', err);
        }
    }

    _switchNet(netId) {
        this._activeNetId = netId;
        // Update active highlight in mixer
        if (this._mixerEl) {
            this._mixerEl.querySelectorAll('.pn-mixer-row').forEach(row => {
                row.classList.toggle('active', row.dataset.netId === netId);
            });
        }
        this._updateTrackLabel();
        this._renderNet();
    }

    _getMusicNetIds() {
        if (!this._project?.nets) return [];
        return Object.keys(this._project.nets).filter(id => this._project.nets[id].role !== 'control');
    }

    // === Share URL (genre + seed + traits + structure) ===
    //
    // The pure codec helpers (canonical JSON, base58, CID, base64url, gzip)
    // live in ./lib/share/codec.js. Methods below are thin wrappers kept on
    // the class so call sites like `el._canonicalizeJSON(x)` still work from
    // tests and the browser console.

    _b64urlEncode(obj) { return b64urlEncode(obj); }
    _b64urlDecode(str) { return b64urlDecode(str); }
    _canonicalizeJSON(doc) { return canonicalizeJSON(doc); }
    _sha256(data) { return sha256(data); }
    _encodeBase58(bytes) { return encodeBase58(bytes); }
    _decodeBase58(str) { return decodeBase58(str); }
    _createCIDv1Bytes(hash) { return createCIDv1Bytes(hash); }
    _computeCidForJsonLd(doc) { return computeCidForJsonLd(doc); }
    _gzipToB64Url(str) { return gzipToB64Url(str); }
    _b64UrlToGunzip(str) { return b64UrlToGunzip(str); }

    // --- State collectors — thin wrappers around ./lib/share/collect.js ---

    _collectFxState() { return collectFxState(this); }
    _collectFeelState() { return collectFeelState(this); }
    _collectAutoDjState() { return collectAutoDjState(this); }
    _collectDisabledMacros() { return collectDisabledMacros(this); }
    _collectTrackOverrides() { return collectTrackOverrides(this); }
    _collectInitialMutes() { return collectInitialMutes(this); }
    _buildSharePayload() { return buildSharePayload(this); }

    // --- State appliers — thin wrappers around ./lib/share/apply.js ---

    _applyFxState(fx) { return applyFxState(this, fx); }
    _applyFeelState(feel) { return applyFeelState(this, feel); }
    _applyAutoDjState(state) { return applyAutoDjState(this, state); }
    _applyDisabledMacros(ids) { return applyDisabledMacros(this, ids); }
    _applyTrackOverrides(tracksByChannel) { return applyTrackOverrides(this, tracksByChannel); }
    _applyShareOverrides(ov) { return applyShareOverrides(this, ov); }

    // --- Share URL — thin wrappers around ./lib/share/url.js ---

    _parseShareFromUrl() { return parseShareFromUrl(this); }
    _shareFromPayload(payload) { return shareFromPayload(payload); }
    _buildShareUrlForms() { return buildShareUrlForms(this); }
    _buildShareUrl() { return buildShareUrl(this); }
    _uploadShare(cid, canonical) { return uploadShare(cid, canonical); }
    _fetchShare(cid) { return fetchShare(cid); }
    _onShareClick() { return onShareClick(this); }

    // Screen Wake Lock: prevent the OS screensaver / display sleep so a
    // live set keeps running on laptops and tablets. Request is gated
    // by a user gesture per spec; re-acquired automatically when the tab
    // returns to visible if it was auto-released on tab-hide.
    async _toggleWakeLock() {
        if (!('wakeLock' in navigator)) {
            const btn = this.querySelector('.pn-wakelock-btn');
            if (btn) btn.title = 'Wake Lock not supported in this browser';
            return;
        }
        if (this._wakeLock) {
            this._wakeLockDesired = false;
            try { await this._wakeLock.release(); } catch {}
            this._wakeLock = null;
            this._updateWakeLockUI();
            return;
        }
        try {
            const lock = await navigator.wakeLock.request('screen');
            this._wakeLock = lock;
            lock.addEventListener('release', () => {
                if (this._wakeLock === lock) this._wakeLock = null;
                this._updateWakeLockUI();
            });
            if (!this._wakeLockVisHandler) {
                this._wakeLockVisHandler = async () => {
                    if (document.visibilityState === 'visible' && this._wakeLockDesired && !this._wakeLock) {
                        try {
                            this._wakeLock = await navigator.wakeLock.request('screen');
                        } catch {}
                        this._updateWakeLockUI();
                    }
                };
                document.addEventListener('visibilitychange', this._wakeLockVisHandler);
            }
            this._wakeLockDesired = true;
            this._updateWakeLockUI();
        } catch (err) {
            console.warn('Wake lock request failed:', err);
        }
    }

    _updateWakeLockUI() {
        const btn = this.querySelector('.pn-wakelock-btn');
        if (!btn) return;
        const on = !!this._wakeLock;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.title = on
            ? 'Screen wake lock ON — click to release'
            : 'Keep screen awake during playback (screen wake lock)';
    }

    // First generate after worker/WS ready. Honours a `?g=...&s=...` share
    // URL if present so the linked track is reproduced on load, otherwise
    // kicks the default techno generate with a fresh explicit seed.
    async _bootGenerate() {
        const share = await this._parseShareFromUrl();
        if (share) {
            const genreSelect = this.querySelector('.pn-genre-select');
            if (genreSelect && [...genreSelect.options].some(o => o.value === share.genre)) {
                genreSelect.value = share.genre;
            }
            const structSelect = this.querySelector('.pn-structure-select');
            if (structSelect && share.params.structure) structSelect.value = share.params.structure;
            // Hydrate trait overrides so the Feel/traits UI reflects the
            // linked track; compose() consumes them via params either way.
            this._traitOverrides = this._traitOverrides || {};
            for (const [k, v] of Object.entries(share.params)) {
                if (k === 'seed' || k === 'structure') continue;
                this._traitOverrides[k] = v;
            }
            this._currentGen = { genre: share.genre, params: { ...share.params } };
            // Stash the overrides block so _applyProjectSync can layer it
            // onto the regenerated project once the worker replies. One-shot.
            if (share.overrides) this._pendingShareOverrides = share.overrides;
            this._sendWs({ type: 'generate', genre: share.genre, params: share.params });
            return;
        }
        const params = { seed: Math.floor(Math.random() * 0x7fffffff) };
        this._currentGen = { genre: 'techno', params: { ...params } };
        this._sendWs({ type: 'generate', genre: 'techno', params });
    }

    _navTrack(dir) {
        if (dir === -1 && this._trackIndex > 0) {
            // Go back to previous track
            this._trackIndex--;
            this._loadHistoryTrack(this._trackIndex);
        } else if (dir === 1) {
            if (this._trackIndex < this._trackHistory.length - 1) {
                // Go forward to already-generated track
                this._trackIndex++;
                this._loadHistoryTrack(this._trackIndex);
            } else {
                // Generate a new track (forward past end of history)
                const genre = this.querySelector('.pn-genre-select')?.value || 'ambient';
                const structure = this.querySelector('.pn-structure-select')?.value || '';
                const params = {};
                if (structure) params.structure = structure;
                this._sendWs({ type: 'generate', genre, params });
            }
        }
    }

    _loadHistoryTrack(index) {
        const proj = JSON.parse(JSON.stringify(this._trackHistory[index]));
        this._navingHistory = true;
        // Load project and play
        this._sendWs({ type: 'project-load', project: proj });
        // Trigger a project-sync from server
        this._project = proj;
        this._tempo = proj.tempo || 120;
        this._structure = proj.structure || null;
        this._tick = 0; this._lastPlayheadPct = 0;
        const netIds = Object.keys(proj.nets || {});
        this._activeNetId = netIds.find(id => proj.nets[id].role !== 'control') || netIds[0] || null;
        this._applyProjectInstruments(proj);
        const prevGenre = this.querySelector('.pn-genre-select')?.value;
        const prevStructure = this.querySelector('.pn-structure-select')?.value;
        this._saveFxState();
        this._buildUI();
        this._setupEventListeners();
        this._restoreFxState();
        this._renderNet();
        this._updateWsStatus();
        // Restore dropdowns
        const genreSelect = this.querySelector('.pn-genre-select');
        if (genreSelect && prevGenre) genreSelect.value = prevGenre;
        const structSelect = this.querySelector('.pn-structure-select');
        if (structSelect && prevStructure) structSelect.value = prevStructure;
        // Auto-play
        if (!this._playing) {
            this._playing = true;
            this._ensureToneStarted();
            this._vizStartLoop();
        }
        this._sendWs({ type: 'transport', action: 'play' });
        const playBtn = this.querySelector('.pn-play');
        if (playBtn) { playBtn.classList.add('playing'); playBtn.textContent = '\u23F9'; }
        this._updateTrackLabel();
    }

    _updateTrackLabel() {
        const label = this.querySelector('.pn-track-label');
        if (!label) return;
        const name = this._project?.name || 'Untitled';
        const total = this._trackHistory.length;
        const pos = this._trackIndex + 1;
        label.textContent = total > 0 ? `${pos}/${total}` : '—';
        label.title = name;
        this._updateProjectNameDisplay();
    }

    // Shows "<genre · title>" normally, "<genre · title · feels>" only
    // when the CURRENT project was generated with Feel overrides active
    // (recorded on project._feelsApplied at generate time). Engaging Feel
    // after the fact doesn't retroactively stamp the track — it only
    // marks the dropdown tilde + icon glow until the user regenerates.
    _updateProjectNameDisplay() {
        const el = this.querySelector('.pn-project-name');
        const name = this._project?.name || 'Untitled';
        const display = this._project?._feelsApplied ? `${name} · feels` : name;
        if (el) el.textContent = display;
        document.title = this._project ? `${display} — beats-btw` : 'beats-btw';
    }

    // === MIDI ===

    _openMidiEditor(transitionId) { return openMidiEditor(this, transitionId); }
    _fireTransition(transitionId) { return fireTransition(this, transitionId); }

    // === Audio (Tone.js) ===

    // --- Audio/MIDI I/O + viz — thin wrappers around ./lib/backend/audio-io.js ---

    _initAudio() { return initAudio(this); }
    _connectMidiInputs() { return connectMidiInputs(this); }
    _sliderBindingKey(slider) { return sliderBindingKey(slider); }
    _resolveBinding(binding) { return resolveBinding(this, binding); }
    _handleMidiMessage(event) { return handleMidiMessage(this, event); }
    _handleMidiCC(cc, value) { return handleMidiCC(this, cc, value); }
    _handleMidiNoteOn(note) { return handleMidiNoteOn(this, note); }
    _ensureToneStarted() { return ensureToneStarted(this); }

    _showQuickstartModal() { return showQuickstartModal(this); }
    _showWelcomeCard() { return showWelcomeCard(this); }
    _showHelpModal() { return showHelpModal(this); }
    _toggleStage() { return toggleStage(this); }

    _toggleAudioMode(mode) { return toggleAudioMode(this, mode); }
    _refreshMidiOutputs() { return refreshMidiOutputs(this); }
    _toggleMute(netId) { return toggleMute(this, netId); }
    _toggleMuteGroup(riffGroup) { return toggleMuteGroup(this, riffGroup); }
    _debouncedRenderMixer() { return debouncedRenderMixer(this); }
    _playNote(midi, netId) { return playNote(this, midi, netId); }
    _reapplyChannelRoutings() { return reapplyChannelRoutings(this); }
    _setChannelRouting(channel, value) { return setChannelRouting(this, channel, value); }
    _playTone(midi) { return playTone(this, midi); }
    _vizColorForNet(netId) { return vizColorForNet(netId); }
    _vizSpawnParticle(netId, midi) { return vizSpawnParticle(this, netId, midi); }
    _vizStartLoop() { return vizStartLoop(this); }
    _vizStopLoop() { return vizStopLoop(this); }
    _vizDrawFrame() { return vizDrawFrame(this); }
    _vizDrawTimeline(ctx, w, h) { return vizDrawTimeline(this, ctx, w, h); }
    _playWebMidi(midi, portIdOverride) { return playWebMidi(this, midi, portIdOverride); }
    setChannelInstrument(channel, instrumentType) { return setChannelInstrument(this, channel, instrumentType); }

    // --- Project sync — thin wrappers around ./lib/project/sync.js ---
    _applyProjectInstruments(project) { return applyProjectInstruments(this, project); }
    _prewarmPreviewInstruments(project) { return prewarmPreviewInstruments(this, project); }
    _applyDefaultPans(nets) { return applyDefaultPans(this, nets); }
    _applyProjectSync(project, seamless) { return applyProjectSync(this, project, seamless); }
    _onInstrumentsChanged(instruments) { return onInstrumentsChanged(this, instruments); }
    getAvailableInstruments() { return getAvailableInstrumentsFn(); }
    _getCurrentInstruments() { return getCurrentInstruments(this); }

    // === Transport ===

    // --- Transport — thin wrappers around ./lib/backend/index.js ---
    _cyclePlaybackMode() { return cyclePlaybackMode(this); }
    _togglePlay() { return togglePlay(this); }
    _showAudioLockBanner() { return showAudioLockBanner(this); }
    _hideAudioLockBanner() { return hideAudioLockBanner(this); }
    _acquireWakeLock() { return acquireWakeLock(this); }
    _releaseWakeLock() { return releaseWakeLock(this); }
    _setupMediaSession() { return setupMediaSession(this); }
    _updateMediaSessionState() { return updateMediaSessionState(this); }
    _setTempo(bpm) { return setTempo(this, bpm); }

    // --- Backend / WS — thin wrappers around ./lib/backend/index.js ---
    _connectBackend() { return connectBackend(this); }
    _connectWorker() { return connectWorker(this); }
    _connectWebSocket() { return connectWebSocket(this); }
    _scheduleReconnect() { return scheduleReconnect(this); }
    _updateWsStatus(connected) { return updateWsStatus(this, connected); }
    _sendWs(msg) { return sendWs(this, msg); }
    _handleWsMessage(msg) { return handleWsMessage(this, msg); }
    _onRemoteTransitionFired(netId, transitionId, midi) { return onRemoteTransitionFired(this, netId, transitionId, midi); }
    _humanizeNote(midi) { return humanizeNote(this, midi); }
    _swingDelay() { return swingDelay(this); }
    _onStateSync(state) { return onStateSync(this, state); }

    // === History ===

    _pushHistory() {
        const snap = JSON.stringify(this._project);
        if (snap === this._lastSnap) return;
        this._lastSnap = snap;
        if (this._history.length > 50) this._history.shift();
        this._history.push(snap);
        this._redo.length = 0;
    }

    _undoAction() {
        if (this._history.length === 0) return;
        const current = JSON.stringify(this._project);
        this._redo.push(current);
        const prev = this._history.pop();
        this._project = JSON.parse(prev);
        this._lastSnap = prev;
        this._normalizeProject();
        this._renderMixer();
        this._renderNet();
        this._syncProject();
    }

    _redoAction() {
        if (this._redo.length === 0) return;
        const current = JSON.stringify(this._project);
        this._history.push(current);
        const next = this._redo.pop();
        this._project = JSON.parse(next);
        this._lastSnap = next;
        this._normalizeProject();
        this._renderMixer();
        this._renderNet();
        this._syncProject();
    }

    // === Persistence ===

    _syncProject() {
        // Update embedded script
        if (this._ldScript) {
            this._ldScript.textContent = JSON.stringify(this._project, null, 2);
        }
        // Save to localStorage
        localStorage.setItem('petri-note-project', JSON.stringify(this._project));
        // Dispatch event
        this.dispatchEvent(new CustomEvent('project-updated', { detail: { project: this._project } }));
    }

    // === Public API ===

    getProject() {
        return JSON.parse(JSON.stringify(this._project));
    }

    setProject(project) {
        this._project = project;
        this._normalizeProject();
        this._activeNetId = Object.keys(this._project.nets)[0];
        this._renderMixer();
        this._renderNet();
        this._syncProject();
    }

    exportJSON() {
        return JSON.stringify(this._project, null, 2);
    }
}

customElements.define('petri-note', PetriNote);
