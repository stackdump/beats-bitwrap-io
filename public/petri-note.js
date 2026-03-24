/**
 * petri-note.js - Custom HTMLElement for Petri net music sequencer
 *
 * A music sequencer where Petri net transitions trigger MIDI notes.
 */

import { toneEngine, INSTRUMENT_CONFIGS } from './audio/tone-engine.js';

// Mixer math: maps 0–100 slider values to audio-engine frequencies/Q
function hpFreq(val) { return 20 * Math.pow(250, val / 100); }
function lpFreq(val) { return 100 * Math.pow(200, val / 100); }
function qCurve(val) { return 0.5 + (Math.pow(val / 100, 2) * 49.5); }

// Slider config: [css class, state key, apply function factory(ch) => fn(val)]
const MIXER_SLIDERS = [
    ['pn-mixer-vol',    'vol',   ch => v => toneEngine.controlChange(ch, 7, v)],
    ['pn-mixer-pan',    'pan',   ch => v => toneEngine.controlChange(ch, 10, v)],
    ['pn-mixer-locut',  'locut', ch => v => toneEngine.setChannelLoCut(ch, hpFreq(v))],
    ['pn-mixer-loreso', 'lores', ch => v => toneEngine.setChannelLoResonance(ch, qCurve(v))],
    ['pn-mixer-cutoff', 'cut',   ch => v => toneEngine.setChannelCutoff(ch, lpFreq(v))],
    ['pn-mixer-reso',   'res',   ch => v => toneEngine.setChannelResonance(ch, qCurve(v))],
    ['pn-mixer-decay',  'dec',   ch => v => toneEngine.setChannelDecay(ch, v / 100)],
];

// Genre-specific instrument mappings (channel -> instrument name)
const GENRE_INSTRUMENTS = {
    'techno': { 4: 'supersaw', 5: 'pluck', 6: 'acid', 10: 'drums' },
    'house':  { 4: 'electric-piano', 5: 'bright-pluck', 6: 'bass', 10: 'drums' },
    'jazz':   { 4: 'vibes', 5: 'pluck', 6: 'sub-bass', 10: 'drums-cr78' },
    'ambient':{ 4: 'warm-pad', 5: 'fm-bell', 6: 'sub-bass', 10: 'drums' },
    'dnb':    { 4: 'square-lead', 5: 'bright-pluck', 6: 'reese', 10: 'drums-breakbeat' },
    'edm':    { 4: 'supersaw', 5: 'bright-pluck', 6: 'acid', 10: 'drums' },
    'speedcore': { 4: 'scream-lead', 5: 'pluck', 6: 'acid', 10: 'drums-v8' },
    'dubstep': { 4: 'detuned-saw', 5: 'rave-stab', 6: 'wobble-bass', 10: 'drums-v8' },
};

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

        // Audio
        this._audioMode = 'web-audio'; // 'web-audio' | 'web-midi' | 'backend'
        this._audioCtx = null;
        this._midiAccess = null;
        this._midiOutputId = null; // Selected MIDI output port ID

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
    }

    connectedCallback() {
        this._loadProject();
        this._buildUI();
        this._setupEventListeners();
        this._connectWorker();
        this._initAudio();
        this._renderNet();
    }

    disconnectedCallback() {
        if (this._worker) {
            this._worker.terminate();
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

    _buildUI() {
        this.innerHTML = '';

        // Header
        const header = document.createElement('div');
        header.className = 'pn-header';
        header.innerHTML = `
            <h1>beats-btw</h1>
            <span class="pn-project-name">${this._project.name}</span>
            <div class="pn-track-nav">
                <button class="pn-track-prev" title="Previous track">&#9664;</button>
                <span class="pn-track-label"></span>
                <button class="pn-track-next" title="Next track">&#9654;</button>
            </div>
            <div class="pn-transport">
                <button class="pn-play" title="Play/Stop">&#9654;</button>
                <button class="pn-playback-mode${this._playbackMode !== 'single' ? ' active' : ''}" title="${{single:'Single play',repeat:'Repeat track',shuffle:'Shuffle — new track on end'}[this._playbackMode]}">${{single:'1x',repeat:'🔁',shuffle:'🔀'}[this._playbackMode]}</button>
                <div class="pn-tempo">
                    <input type="number" value="${this._tempo}" min="20" max="300" step="1"/>
                    <span>BPM</span>
                </div>
            </div>
            <div class="pn-generate">
                <select class="pn-genre-select">
                    <option value="ambient">Ambient</option>
                    <option value="blues">Blues</option>
                    <option value="bossa">Bossa Nova</option>
                    <option value="country">Country</option>
                    <option value="dnb">DnB</option>
                    <option value="dubstep">Dubstep</option>
                    <option value="edm">EDM</option>
                    <option value="funk">Funk</option>
                    <option value="garage">Garage</option>
                    <option value="house">House</option>
                    <option value="jazz">Jazz</option>
                    <option value="lofi">Lo-fi</option>
                    <option value="metal">Metal</option>
                    <option value="reggae">Reggae</option>
                    <option value="speedcore">Speedcore</option>
                    <option value="synthwave">Synthwave</option>
                    <option value="techno" selected>Techno</option>
                    <option value="trance">Trance</option>
                    <option value="trap">Trap</option>
                </select>
                <button class="pn-generate-btn" title="Generate new track">Generate</button>
                <button class="pn-shuffle-btn" title="Shuffle instruments">Shuffle</button>
                <button class="pn-save-btn" title="Save to server" style="display:none">&#x1F4BE;</button>
                <button class="pn-leaderboard-btn" title="Leaderboard" style="display:none">&#x1F3C6;</button>
                <button class="pn-download-btn" title="Download track as JSON-LD">&#x2B07;</button>
                <button class="pn-upload-btn" title="Upload JSON-LD track">&#x2B06;</button>
                <input type="file" class="pn-upload-input" accept=".jsonld,.json" style="display:none">
                <select class="pn-structure-select" title="Song structure">
                    <option value="">Loop</option>
                    <option value="ab">A/B</option>
                    <option value="drop">Drop</option>
                    <option value="build">Build</option>
                    <option value="jam">Jam</option>
                    <option value="minimal">Minimal</option>
                    <option value="standard">Standard</option>
                    <option value="extended">Extended</option>
                </select>
            </div>
            <div class="pn-audio-mode">
                <button class="${this._audioMode === 'web-audio' ? 'active' : ''}" data-mode="web-audio">Synth</button>
                <button class="${this._audioMode === 'web-midi' ? 'active' : ''}" data-mode="web-midi">MIDI</button>
                <select class="pn-midi-output" style="display: ${this._audioMode === 'web-midi' ? 'block' : 'none'}">
                    <option value="">Select MIDI output...</option>
                </select>
                <button class="pn-help-btn" title="Performance tips">?</button>
                <a class="pn-gh-link" href="https://github.com/stackdump/beats-bitwrap-io" target="_blank" rel="noopener" title="View source on GitHub">
                    <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
                </a>
            </div>
        `;
        this.appendChild(header);

        this._genOptsEl = null;

        // Genre traits display
        const traits = document.createElement('div');
        traits.className = 'pn-genre-traits';
        this.appendChild(traits);
        this._traitsEl = traits;
        this._genreData = {};
        // Genre traits loaded locally (no server) — camelCase keys to match original /api/genres format
        this._genreData = {
            techno:    { name: 'techno',    bpm: 128, swing: 0,  humanize: 10, syncopation: 0.1,  ghostNotes: 0.3 },
            house:     { name: 'house',     bpm: 124, swing: 20, humanize: 15, syncopation: 0.2,  ghostNotes: 0.4 },
            jazz:      { name: 'jazz',      bpm: 110, swing: 60, humanize: 40, drumFills: true, walkingBass: true, syncopation: 0.5, callResponse: true, tensionCurve: true, modalInterchange: 0.3, ghostNotes: 0.6 },
            ambient:   { name: 'ambient',   bpm: 72,  swing: 0,  humanize: 25, tensionCurve: true, modalInterchange: 0.2 },
            dnb:       { name: 'dnb',       bpm: 174, swing: 10, humanize: 15, drumFills: true, polyrhythm: 6, syncopation: 0.3, tensionCurve: true, ghostNotes: 0.5 },
            edm:       { name: 'edm',       bpm: 138, swing: 0,  humanize: 8,  drumFills: true, syncopation: 0.15, tensionCurve: true, modalInterchange: 0.1, ghostNotes: 0.3 },
            speedcore: { name: 'speedcore', bpm: 220, swing: 0,  humanize: 5,  syncopation: 0.05, ghostNotes: 0.2 },
            dubstep:   { name: 'dubstep',   bpm: 140, swing: 15, humanize: 12, drumFills: true, syncopation: 0.3, tensionCurve: true, modalInterchange: 0.15, ghostNotes: 0.4 },
            country:   { name: 'country',   bpm: 110, swing: 15, humanize: 20, walkingBass: true, syncopation: 0.2, callResponse: true, modalInterchange: 0.1, ghostNotes: 0.3 },
            blues:     { name: 'blues',     bpm: 95,  swing: 50, humanize: 35, drumFills: true, walkingBass: true, syncopation: 0.4, callResponse: true, tensionCurve: true, modalInterchange: 0.2, ghostNotes: 0.5 },
            synthwave: { name: 'synthwave', bpm: 108, swing: 0,  humanize: 5,  syncopation: 0.05, ghostNotes: 0.15, tensionCurve: true, modalInterchange: 0.1 },
            trance:    { name: 'trance',    bpm: 140, swing: 0,  humanize: 5,  tensionCurve: true, syncopation: 0.1, ghostNotes: 0.2, modalInterchange: 0.15 },
            lofi:      { name: 'lofi',      bpm: 82,  swing: 35, humanize: 40, syncopation: 0.2, ghostNotes: 0.6, modalInterchange: 0.15 },
            reggae:    { name: 'reggae',    bpm: 75,  swing: 25, humanize: 25, syncopation: 0.4, ghostNotes: 0.3, walkingBass: true },
            funk:      { name: 'funk',      bpm: 108, swing: 30, humanize: 25, syncopation: 0.5, ghostNotes: 0.6, walkingBass: true, callResponse: true, drumFills: true },
            bossa:     { name: 'bossa',     bpm: 88,  swing: 40, humanize: 30, syncopation: 0.35, ghostNotes: 0.5, walkingBass: true, callResponse: true, modalInterchange: 0.25 },
            trap:      { name: 'trap',      bpm: 140, swing: 10, humanize: 8,  syncopation: 0.3, ghostNotes: 0.4, drumFills: true, tensionCurve: true },
            garage:    { name: 'garage',    bpm: 130, swing: 30, humanize: 18, syncopation: 0.35, ghostNotes: 0.45, drumFills: true },
            metal:     { name: 'metal',     bpm: 180, swing: 0,  humanize: 8,  syncopation: 0.15, ghostNotes: 0.2, drumFills: true, tensionCurve: true },
        };
        this._updateTraits();
        this.querySelector('.pn-genre-select').addEventListener('change', () => {
            this._traitOverrides = {}; // Reset overrides when genre changes
            this._updateTraits();
        });
        this._initTraitClicks();

        // Mixer panel (replaces tabs + track settings)
        const mixer = document.createElement('div');
        mixer.className = 'pn-mixer';
        this.appendChild(mixer);
        this._mixerEl = mixer;
        this._mixerEventsBound = false; // Reset so events bind to new element
        this._renderMixer();

        // Effects panel
        const fx = document.createElement('div');
        fx.className = 'pn-effects';
        fx.innerHTML = `
            <div class="pn-effects-toggle">
                <button class="pn-effects-btn active">FX</button>
                <button class="pn-fx-bypass" title="Bypass all effects">Bypass</button>
                <button class="pn-fx-reset" title="Reset all effects to defaults">Reset</button>
                <button class="pn-cc-reset" title="Clear all MIDI CC bindings">CC Reset</button>
                <button class="pn-crop-bar-btn" title="Crop track to loop region" style="display:none">✂ Crop</button>
            </div>
            <div class="pn-effects-panel" style="display:flex">
                <div class="pn-fx-group">
                    <span class="pn-fx-label">Master</span>
                    <div class="pn-fx-control">
                        <span>Vol</span>
                        <input type="range" class="pn-fx-slider" data-fx="master-vol" data-default="80" min="0" max="100" value="80">
                        <span class="pn-fx-value" data-fx-val="master-vol">80%</span>
                    </div>
                </div>
                <div class="pn-fx-group">
                    <span class="pn-fx-label">Reverb</span>
                    <div class="pn-fx-control">
                        <span>Size</span>
                        <input type="range" class="pn-fx-slider" data-fx="reverb-size" data-default="50" min="0" max="100" value="50">
                        <span class="pn-fx-value" data-fx-val="reverb-size">50%</span>
                    </div>
                    <div class="pn-fx-control">
                        <span>Damp</span>
                        <input type="range" class="pn-fx-slider" data-fx="reverb-damp" data-default="30" min="0" max="100" value="30">
                        <span class="pn-fx-value" data-fx-val="reverb-damp">30%</span>
                    </div>
                    <div class="pn-fx-control">
                        <span>Mix</span>
                        <input type="range" class="pn-fx-slider" data-fx="reverb-wet" data-default="20" min="0" max="100" value="20">
                        <span class="pn-fx-value" data-fx-val="reverb-wet">20%</span>
                    </div>
                </div>
                <div class="pn-fx-group">
                    <span class="pn-fx-label">Delay</span>
                    <div class="pn-fx-control">
                        <span>Time</span>
                        <input type="range" class="pn-fx-slider" data-fx="delay-time" data-default="25" min="1" max="100" value="25">
                        <span class="pn-fx-value" data-fx-val="delay-time">0.25s</span>
                    </div>
                    <div class="pn-fx-control">
                        <span>Feedback</span>
                        <input type="range" class="pn-fx-slider" data-fx="delay-feedback" data-default="25" min="0" max="90" value="25">
                        <span class="pn-fx-value" data-fx-val="delay-feedback">25%</span>
                    </div>
                    <div class="pn-fx-control">
                        <span>Mix</span>
                        <input type="range" class="pn-fx-slider" data-fx="delay-wet" data-default="15" min="0" max="100" value="15">
                        <span class="pn-fx-value" data-fx-val="delay-wet">15%</span>
                    </div>
                </div>
                <div class="pn-fx-group">
                    <span class="pn-fx-label">Distort</span>
                    <div class="pn-fx-control">
                        <span>Drive</span>
                        <input type="range" class="pn-fx-slider" data-fx="distortion" data-default="0" min="0" max="100" value="0">
                        <span class="pn-fx-value" data-fx-val="distortion">0%</span>
                    </div>
                </div>
                <div class="pn-fx-group">
                    <span class="pn-fx-label">Filter</span>
                    <div class="pn-fx-control">
                        <span>Lo Cut</span>
                        <input type="range" class="pn-fx-slider" data-fx="hp-freq" data-default="0" min="0" max="100" value="0">
                        <span class="pn-fx-value" data-fx-val="hp-freq">20Hz</span>
                    </div>
                    <div class="pn-fx-control">
                        <span>Hi Cut</span>
                        <input type="range" class="pn-fx-slider" data-fx="lp-freq" data-default="100" min="0" max="100" value="100">
                        <span class="pn-fx-value" data-fx-val="lp-freq">20kHz</span>
                    </div>
                </div>
                <div class="pn-fx-group">
                    <span class="pn-fx-label">Phaser</span>
                    <div class="pn-fx-control">
                        <span>Rate</span>
                        <input type="range" class="pn-fx-slider" data-fx="phaser-freq" data-default="0" min="0" max="100" value="0">
                        <span class="pn-fx-value" data-fx-val="phaser-freq">Off</span>
                    </div>
                    <div class="pn-fx-control">
                        <span>Depth</span>
                        <input type="range" class="pn-fx-slider" data-fx="phaser-depth" data-default="50" min="0" max="100" value="50">
                        <span class="pn-fx-value" data-fx-val="phaser-depth">50%</span>
                    </div>
                    <div class="pn-fx-control">
                        <span>Mix</span>
                        <input type="range" class="pn-fx-slider" data-fx="phaser-wet" data-default="0" min="0" max="100" value="0">
                        <span class="pn-fx-value" data-fx-val="phaser-wet">0%</span>
                    </div>
                </div>
                <div class="pn-fx-group">
                    <span class="pn-fx-label">Crush</span>
                    <div class="pn-fx-control">
                        <span>Bits</span>
                        <input type="range" class="pn-fx-slider" data-fx="crush-bits" data-default="0" min="0" max="100" value="0">
                        <span class="pn-fx-value" data-fx-val="crush-bits">Off</span>
                    </div>
                </div>
            </div>
        `;
        this.appendChild(fx);
        this._fxEl = fx;
        this._fxNotchesAdded = true;
        requestAnimationFrame(() => this._addDefaultNotches(fx));

        // FX panel always open (toggle removed)

        // FX bypass toggle
        this._fxBypassed = false;
        this._fxSavedValues = null;
        fx.querySelector('.pn-fx-bypass').addEventListener('click', () => {
            const btn = fx.querySelector('.pn-fx-bypass');
            this._fxBypassed = !this._fxBypassed;
            btn.classList.toggle('active', this._fxBypassed);
            btn.textContent = this._fxBypassed ? 'Bypassed' : 'Bypass';
            if (this._fxBypassed) {
                // Save current values (except master-vol) and zero out wet/mix sends
                this._fxSavedValues = {};
                fx.querySelectorAll('.pn-fx-slider').forEach(s => {
                    if (s.dataset.fx !== 'master-vol') {
                        this._fxSavedValues[s.dataset.fx] = s.value;
                    }
                });
                toneEngine.setReverbWet(0);
                toneEngine.setDelayWet(0);
                toneEngine.setDistortion(0);
                toneEngine.setHighpassFreq(20);
                toneEngine.setLowpassFreq(20000);
                toneEngine.setPhaserWet(0);
                toneEngine.setCrush(0);
            } else {
                // Restore saved values — skip reverb size/damp (they weren't changed,
                // and setting dampening triggers unstable IIR filter rebuilds)
                if (this._fxSavedValues) {
                    const skipOnRestore = new Set(['reverb-size', 'reverb-damp']);
                    for (const [fxName, val] of Object.entries(this._fxSavedValues)) {
                        const slider = fx.querySelector(`.pn-fx-slider[data-fx="${fxName}"]`);
                        if (slider) slider.value = val;
                        if (!skipOnRestore.has(fxName)) {
                            applyFx(fxName, parseInt(val));
                        }
                    }
                    this._fxSavedValues = null;
                }
            }
        });

        // FX reset
        const fxDefaults = {
            'reverb-size': 50, 'reverb-damp': 30, 'reverb-wet': 20,
            'delay-time': 25, 'delay-feedback': 25, 'delay-wet': 15,
            'master-vol': 80, 'distortion': 0, 'hp-freq': 0, 'lp-freq': 100,
            'phaser-freq': 0, 'phaser-depth': 50, 'phaser-wet': 0,
            'crush-bits': 0,
        };
        fx.querySelector('.pn-fx-reset').addEventListener('click', () => {
            this._fxBypassed = false;
            this._fxSavedValues = null;
            const bypassBtn = fx.querySelector('.pn-fx-bypass');
            bypassBtn.classList.remove('active');
            bypassBtn.textContent = 'Bypass';
            for (const [fxName, def] of Object.entries(fxDefaults)) {
                const slider = fx.querySelector(`.pn-fx-slider[data-fx="${fxName}"]`);
                if (slider) slider.value = def;
                applyFx(fxName, def);
            }
        });

        fx.querySelector('.pn-cc-reset').addEventListener('click', () => {
            this._ccBindings.clear();
            console.log('MIDI CC bindings cleared');
        });

        fx.querySelector('.pn-crop-bar-btn').addEventListener('click', () => {
            if (this._loopStart >= 0 && this._loopEnd > this._loopStart) {
                this._sendWs({ type: 'crop', startTick: this._loopStart, endTick: this._loopEnd });
            }
        });

        // FX slider events - throttled to avoid audio thread overload
        let _fxThrottleId = null;
        let _fxPending = null;
        const applyFx = (fxName, val) => {
            const valEl = this.querySelector(`[data-fx-val="${fxName}"]`);
            switch (fxName) {
                case 'reverb-size':
                    toneEngine.setReverbSize(val / 100);
                    valEl.textContent = val + '%';
                    break;
                case 'reverb-damp':
                    toneEngine.setReverbDampening(10000 - (val / 100) * 9800);
                    valEl.textContent = val + '%';
                    break;
                case 'reverb-wet':
                    toneEngine.setReverbWet(val / 100);
                    valEl.textContent = val + '%';
                    break;
                case 'delay-time':
                    toneEngine.setDelayTime(val / 100);
                    valEl.textContent = (val / 100).toFixed(2) + 's';
                    break;
                case 'delay-feedback':
                    toneEngine.setDelayFeedback(val / 100);
                    valEl.textContent = val + '%';
                    break;
                case 'delay-wet':
                    toneEngine.setDelayWet(val / 100);
                    valEl.textContent = val + '%';
                    break;
                case 'master-vol': {
                    const db = val === 0 ? -60 : -60 + (val / 100) * 60;
                    toneEngine.setMasterVolume(db);
                    valEl.textContent = val + '%';
                    break;
                }
                case 'distortion':
                    toneEngine.setDistortion(val / 100);
                    valEl.textContent = val + '%';
                    break;
                case 'hp-freq': {
                    const freq = hpFreq(val);
                    toneEngine.setHighpassFreq(freq);
                    valEl.textContent = freq < 1000 ? Math.round(freq) + 'Hz' : (freq / 1000).toFixed(1) + 'kHz';
                    break;
                }
                case 'lp-freq': {
                    const freq = lpFreq(val);
                    toneEngine.setLowpassFreq(freq);
                    valEl.textContent = freq < 1000 ? Math.round(freq) + 'Hz' : (freq / 1000).toFixed(1) + 'kHz';
                    break;
                }
                case 'phaser-freq': {
                    const rate = val === 0 ? 0 : 0.1 + (val / 100) * 9.9;
                    toneEngine.setPhaserFreq(rate);
                    valEl.textContent = val === 0 ? 'Off' : rate.toFixed(1) + 'Hz';
                    break;
                }
                case 'phaser-depth':
                    toneEngine.setPhaserDepth(val / 100);
                    valEl.textContent = val + '%';
                    break;
                case 'phaser-wet':
                    toneEngine.setPhaserWet(val / 100);
                    valEl.textContent = val + '%';
                    break;
                case 'crush-bits': {
                    toneEngine.setCrush(val / 100);
                    valEl.textContent = val === 0 ? 'Off' : Math.max(1, Math.round(16 - (val / 100) * 15)) + '-bit';
                    break;
                }
            }
        };
        fx.addEventListener('input', (e) => {
            const slider = e.target.closest('.pn-fx-slider');
            if (!slider) return;
            _fxPending = { fx: slider.dataset.fx, val: parseInt(slider.value) };
            // Update label immediately for responsiveness
            const valEl = this.querySelector(`[data-fx-val="${_fxPending.fx}"]`);
            if (valEl && _fxPending.fx === 'delay-time') {
                valEl.textContent = (_fxPending.val / 100).toFixed(2) + 's';
            } else if (valEl && (_fxPending.fx === 'hp-freq' || _fxPending.fx === 'lp-freq')) {
                const freq = _fxPending.fx === 'hp-freq'
                    ? hpFreq(_fxPending.val)
                    : lpFreq(_fxPending.val);
                valEl.textContent = freq < 1000 ? Math.round(freq) + 'Hz' : (freq / 1000).toFixed(1) + 'kHz';
            } else if (valEl) {
                valEl.textContent = _fxPending.val + '%';
            }
            // Throttle engine calls to ~30fps
            if (!_fxThrottleId) {
                _fxThrottleId = setTimeout(() => {
                    if (_fxPending) applyFx(_fxPending.fx, _fxPending.val);
                    _fxPending = null;
                    _fxThrottleId = null;
                }, 33);
            }
        });

        // Track hovered FX slider for MIDI CC binding
        fx.addEventListener('mouseover', (e) => {
            const slider = e.target.closest('.pn-fx-slider');
            if (slider) this._hoveredSlider = slider;
        });
        fx.addEventListener('mouseout', (e) => {
            const slider = e.target.closest('.pn-fx-slider');
            if (slider && slider === this._hoveredSlider) this._hoveredSlider = null;
        });

        // FX scroll wheel support
        fx.addEventListener('wheel', (e) => {
            const control = e.target.closest('.pn-fx-control');
            if (!control) return;
            e.preventDefault();
            const slider = control.querySelector('.pn-fx-slider');
            if (!slider) return;
            const min = parseInt(slider.min);
            const max = parseInt(slider.max);
            const step = e.deltaY < 0 ? 2 : -2;
            slider.value = Math.max(min, Math.min(max, parseInt(slider.value) + step));
            slider.dispatchEvent(new Event('input', { bubbles: true }));
        }, { passive: false });

        // Timeline (structure mode only)
        const timeline = document.createElement('div');
        timeline.className = 'pn-timeline';
        timeline.style.display = this._structure ? 'flex' : 'none';
        this.appendChild(timeline);
        this._timelineEl = timeline;
        this._renderTimeline();

        // Timeline: click to seek, drag markers to set loop region
        timeline.addEventListener('mousedown', (e) => {
            if (e.button === 2) return; // right-click handled by contextmenu
            if (!this._totalSteps || !this._structure) return;
            const rect = timeline.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;

            // Check if clicking on a loop marker (within 10px)
            const startX = (this._loopStart / this._totalSteps) * rect.width;
            const endX = (this._loopEnd / this._totalSteps) * rect.width;
            const clickX = e.clientX - rect.left;

            if (this._loopStart >= 0 && Math.abs(clickX - startX) < 10) {
                this._draggingMarker = 'start';
                e.preventDefault();
                return;
            }
            if (this._loopEnd >= 0 && Math.abs(clickX - endX) < 10) {
                this._draggingMarker = 'end';
                e.preventDefault();
                return;
            }

            // Plain click: seek
            const targetTick = Math.floor(pct * this._totalSteps);
            this._sendWs({ type: 'seek', tick: targetTick });
            this._tick = targetTick;
            this._lastPlayheadPct = null;
            this._updatePlayhead();
        });

        timeline.addEventListener('mousemove', (e) => {
            if (!this._draggingMarker || !this._totalSteps) return;
            e.preventDefault();
            const rect = timeline.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const tick = Math.round(pct * this._totalSteps / 16) * 16; // snap to bar
            if (this._draggingMarker === 'start') this._loopStart = tick;
            else this._loopEnd = tick;
            this._updateLoopMarkers();
        });

        const endDrag = () => {
            if (!this._draggingMarker) return;
            // Swap if start > end
            if (this._loopStart > this._loopEnd) {
                [this._loopStart, this._loopEnd] = [this._loopEnd, this._loopStart];
            }
            // Send loop to server (only active when markers are moved from default positions)
            const isFullRange = this._loopStart === 0 && this._loopEnd === this._totalSteps;
            if (isFullRange) {
                this._sendWs({ type: 'loop', startTick: -1, endTick: -1 });
            } else {
                this._sendWs({ type: 'loop', startTick: this._loopStart, endTick: this._loopEnd });
            }
            this._updateLoopMarkers();
            this._draggingMarker = null;
        };
        timeline.addEventListener('mouseup', endDrag);
        timeline.addEventListener('mouseleave', endDrag);

        // Right-click: move nearest marker (start or end) to clicked position
        timeline.addEventListener('contextmenu', (e) => {
            if (!this._totalSteps || !this._structure) return;
            e.preventDefault();
            const rect = timeline.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            const tick = Math.round(pct * this._totalSteps / 16) * 16;
            // Move whichever marker is closer
            const distStart = Math.abs(tick - this._loopStart);
            const distEnd = Math.abs(tick - this._loopEnd);
            if (distStart <= distEnd) {
                this._loopStart = tick;
            } else {
                this._loopEnd = tick;
            }
            // Swap if needed
            if (this._loopStart > this._loopEnd) {
                [this._loopStart, this._loopEnd] = [this._loopEnd, this._loopStart];
            }
            const isFullRange = this._loopStart === 0 && this._loopEnd === this._totalSteps;
            this._sendWs({ type: 'loop', startTick: isFullRange ? -1 : this._loopStart, endTick: isFullRange ? -1 : this._loopEnd });
            this._updateLoopMarkers();
        });

        // Workspace (read-only visualization)
        const workspace = document.createElement('div');
        workspace.className = 'pn-workspace';

        // Canvas for arcs
        const canvasContainer = document.createElement('div');
        canvasContainer.className = 'pn-canvas-container';

        this._canvas = document.createElement('canvas');
        this._canvas.className = 'pn-canvas';
        canvasContainer.appendChild(this._canvas);

        // Stage for nodes
        this._stage = document.createElement('div');
        this._stage.className = 'pn-stage';
        canvasContainer.appendChild(this._stage);

        workspace.appendChild(canvasContainer);
        this.appendChild(workspace);

        // Status bar
        // Setup canvas size
        this._resizeCanvas();
    }

    _updateTraits() {
        if (!this._traitsEl) return;
        const genre = this.querySelector('.pn-genre-select')?.value || 'techno';
        const g = this._genreData[genre];
        if (!g) { this._traitsEl.innerHTML = ''; return; }

        // Initialize overrides from genre defaults if not set
        if (!this._traitOverrides) this._traitOverrides = {};

        const ov = this._traitOverrides;
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

        this._traitsEl.innerHTML =
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

    _initTraitClicks() {
        if (!this._traitsEl) return;
        this._traitsEl.addEventListener('click', (e) => {
            const trait = e.target.closest('.pn-trait[data-param]');
            if (!trait) return;

            const param = trait.dataset.param;
            const genre = this.querySelector('.pn-genre-select')?.value || 'techno';
            const g = this._genreData[genre];
            if (!g) return;

            if (!this._traitOverrides) this._traitOverrides = {};

            // Determine current value and toggle
            const genreDefaults = {
                'drum-fills': g.drumFills, 'walking-bass': g.walkingBass,
                'polyrhythm': g.polyrhythm, 'syncopation': g.syncopation,
                'call-response': g.callResponse, 'tension-curve': g.tensionCurve,
                'modal-interchange': g.modalInterchange, 'ghost-notes': g.ghostNotes,
            };
            const current = this._traitOverrides[param] !== undefined ? this._traitOverrides[param] : genreDefaults[param];

            if (typeof current === 'boolean') {
                this._traitOverrides[param] = !current;
            } else if (typeof current === 'number') {
                // Toggle: if > 0 set to 0, if 0 set to genre default (or 0.3 if default is 0)
                if (current > 0) {
                    this._traitOverrides[param] = param === 'polyrhythm' ? 0 : 0;
                } else {
                    const def = genreDefaults[param];
                    this._traitOverrides[param] = def > 0 ? def : (param === 'polyrhythm' ? 6 : 0.3);
                }
            }

            this._updateTraits();

            // Auto-regenerate with the new params
            toneEngine.resumeContext();
            this._ensureToneStarted();
            const params = { ...this._traitOverrides };
            const structure = this.querySelector('.pn-structure-select')?.value;
            if (structure) params.structure = structure;
            this._sendWs({ type: 'generate', genre, params });
        });
    }

    _renderMixer() {
        if (!this._mixerEl) return;

        // Save all current slider states before rebuilding DOM
        this._mixerEl.querySelectorAll('.pn-mixer-row').forEach(row => {
            const netId = row.dataset.netId;
            if (netId) this._saveMixerSliderState(netId);
        });

        this._mixerEl.innerHTML = '';

        const instruments = this.getAvailableInstruments();

        // Group nets by riffGroup for collapsed display
        const groups = new Map(); // riffGroup -> [netIds]
        const ungrouped = [];

        for (const [id, net] of Object.entries(this._project.nets)) {
            if (net.role === 'control') continue;
            if (net.riffGroup) {
                if (!groups.has(net.riffGroup)) groups.set(net.riffGroup, []);
                groups.get(net.riffGroup).push(id);
            } else {
                ungrouped.push(id);
            }
        }

        // Sort everything by role: percussion → bass → melody → harmony → arp → rest
        const roleOrder = ['kick', 'snare', 'hihat', 'clap', 'bass', 'melody', 'harmony', 'arp'];
        const percOrder = ['kick', 'snare', 'hihat', 'clap'];
        const roleIdx = (name) => {
            const i = roleOrder.indexOf(name);
            return i >= 0 ? i : roleOrder.length;
        };
        const sortedGroups = [...groups.entries()].sort(([a], [b]) => roleIdx(a) - roleIdx(b));

        // Render grouped nets: single row per group showing group name
        for (const [group, netIds] of sortedGroups) {
            const firstNet = this._project.nets[netIds[0]];
            // Any variant muted = show group as partially muted
            const allMuted = netIds.every(nid => this._mutedNets.has(nid));
            const isActive = netIds.includes(this._activeNetId);
            const channel = firstNet.track?.channel || 1;
            const currentInstrument = firstNet.track?.instrument || this._channelInstruments[channel] || 'piano';

            const row = document.createElement('div');
            row.className = `pn-mixer-row ${isActive ? 'active' : ''}`;
            row.dataset.netId = netIds[0]; // click selects first variant
            row.dataset.riffGroup = group;

            // Show unique variant letters — only the currently playing slot is "active"
            const seenLetters = new Set();
            const variantLabels = [];
            // Find which net is currently unmuted (the active slot)
            const activeSlotId = netIds.find(id => !this._mutedNets.has(id));
            const activeLetter = activeSlotId
                ? (this._project.nets[activeSlotId]?.riffVariant || activeSlotId.slice(group.length + 1))
                : null;
            for (const nid of netIds) {
                const net = this._project.nets[nid];
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

            const allManualMuted = netIds.every(nid => this._manualMutedNets.has(nid));
            row.innerHTML = `
                <input type="checkbox" class="pn-mixer-solo" data-riff-group="${group}" title="Permanent mute" ${allManualMuted ? 'checked' : ''}>
                <button class="pn-mixer-mute ${allMuted ? 'muted' : ''}" data-net-id="${netIds[0]}" data-riff-group="${group}" title="${allMuted ? 'Unmute all' : 'Mute all'}">
                    ${allMuted ? '\u{1F507}' : '\u{1F50A}'}
                </button>
                <span class="pn-mixer-name">${group}</span>
                <span class="pn-riff-variants">${variantLabelsHtml}</span>
                <select class="pn-mixer-instrument" data-net-id="${netIds[0]}" data-riff-group="${group}">
                    ${instruments.map(inst => `
                        <option value="${inst}" ${currentInstrument === inst ? 'selected' : ''}>
                            ${inst.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
                        </option>
                    `).join('')}
                </select>
                ${(firstNet.track?.instrumentSet?.length > 1) ? `<button class="pn-mixer-rotate" data-net-id="${netIds[0]}" data-riff-group="${group}" title="Next genre instrument">&raquo;</button>` : ''}
                ${this._mixerSlidersHtml(netIds[0], percOrder.includes(group))}
                <button class="pn-mixer-test" data-net-id="${netIds[0]}" title="Test note">&#9835;</button>
                <button class="pn-mixer-tone-reset" data-net-id="${netIds[0]}" title="Reset tone">&#8634;</button>
                <button class="pn-mixer-tone-prev" data-net-id="${netIds[0]}" title="Previous tone">&lsaquo;</button>
                <button class="pn-mixer-tone-next" data-net-id="${netIds[0]}" title="Random tone">&rsaquo;</button>
            `;

            this._mixerEl.appendChild(row);
        }

        // Render ungrouped nets in sorted order, interleaved with groups
        const sortedUngrouped = [...ungrouped].sort((a, b) => roleIdx(a) - roleIdx(b));
        for (const id of sortedUngrouped) {
            // Insert in correct position among existing rows
            const idx = roleIdx(id);
            const row = this._createMixerRow(id, instruments);
            const existing = [...this._mixerEl.children];
            const insertBefore = existing.find(el => {
                const elRole = el.dataset.riffGroup || el.dataset.netId;
                return roleIdx(elRole) > idx;
            });
            if (insertBefore) {
                this._mixerEl.insertBefore(row, insertBefore);
            } else {
                this._mixerEl.appendChild(row);
            }
        }

        // Bind mixer events (only once — event delegation handles dynamic content)
        if (this._mixerEventsBound) {
            this._restoreMixerSliderState();
            return;
        }
        this._mixerEventsBound = true;

        this._mixerEl.addEventListener('click', async (e) => {
            const muteBtn = e.target.closest('.pn-mixer-mute');
            if (muteBtn) {
                e.stopPropagation();
                const riffGroup = muteBtn.dataset.riffGroup;
                if (riffGroup) {
                    this._toggleMuteGroup(riffGroup);
                } else {
                    this._toggleMute(muteBtn.dataset.netId);
                }
                return;
            }
            const testBtn = e.target.closest('.pn-mixer-test');
            if (testBtn) {
                e.stopPropagation();
                this._testNote(testBtn.dataset.netId);
                return;
            }
            const toneReset = e.target.closest('.pn-mixer-tone-reset');
            if (toneReset) {
                e.stopPropagation();
                this._toneReset(toneReset.dataset.netId);
                return;
            }
            const tonePrev = e.target.closest('.pn-mixer-tone-prev');
            if (tonePrev) {
                e.stopPropagation();
                this._toneNav(tonePrev.dataset.netId, -1);
                return;
            }
            const toneNext = e.target.closest('.pn-mixer-tone-next');
            if (toneNext) {
                e.stopPropagation();
                this._toneNav(toneNext.dataset.netId, 1);
                return;
            }
            const rotateBtn = e.target.closest('.pn-mixer-rotate');
            if (rotateBtn) {
                e.stopPropagation();
                const netId = rotateBtn.dataset.netId;
                const riffGroup = rotateBtn.dataset.riffGroup;
                const net = this._project.nets[netId];
                const instSet = net?.track?.instrumentSet;
                if (!instSet || instSet.length < 2) return;

                const current = net.track?.instrument || instSet[0];
                const idx = instSet.indexOf(current);
                const next = instSet[(idx + 1) % instSet.length];

                // Update the dropdown to match
                const row = rotateBtn.closest('.pn-mixer-row');
                const select = row?.querySelector('.pn-mixer-instrument');
                if (select) select.value = next;

                // Apply to all nets in riff group or single net
                const targetIds = riffGroup
                    ? Object.keys(this._project.nets).filter(id => this._project.nets[id].riffGroup === riffGroup)
                    : [netId];

                for (const tid of targetIds) {
                    const n = this._project.nets[tid];
                    if (n) {
                        const ch = n.track?.channel || 1;
                        n.track.instrument = next;
                        this._channelInstruments[ch] = next;
                        if (this._toneStarted) await toneEngine.loadInstrument(ch, next);
                    }
                }
                return;
            }
            const row = e.target.closest('.pn-mixer-row');
            if (row && !e.target.closest('select') && !e.target.closest('input')) {
                this._switchNet(row.dataset.netId);
            }
        });

        this._mixerEl.addEventListener('change', async (e) => {
            const soloCheckbox = e.target.closest('.pn-mixer-solo');
            if (soloCheckbox) {
                const checked = soloCheckbox.checked;
                const riffGroup = soloCheckbox.dataset.riffGroup;
                const netId = soloCheckbox.dataset.netId;

                const targetIds = riffGroup
                    ? Object.keys(this._project.nets).filter(id => this._project.nets[id].riffGroup === riffGroup)
                    : [netId];

                // Batch: collect all mute changes, send with small delay between
                const batch = [];
                for (const nid of targetIds) {
                    if (checked) {
                        this._manualMutedNets.add(nid);
                        this._mutedNets.add(nid);
                    } else {
                        this._manualMutedNets.delete(nid);
                        this._mutedNets.delete(nid);
                    }
                    batch.push({ type: 'mute', netId: nid, muted: checked });
                }
                for (const msg of batch) {
                    this._sendWs(msg);
                }
                this._debouncedRenderMixer();
                return;
            }
            const instSelect = e.target.closest('.pn-mixer-instrument');
            if (instSelect) {
                const netId = instSelect.dataset.netId;
                const riffGroup = instSelect.dataset.riffGroup;
                const instrument = instSelect.value;

                // Apply to all nets in riff group, or just the single net
                const targetIds = riffGroup
                    ? Object.keys(this._project.nets).filter(id => this._project.nets[id].riffGroup === riffGroup)
                    : [netId];

                for (const tid of targetIds) {
                    const net = this._project.nets[tid];
                    if (net) {
                        const ch = net.track?.channel || 1;
                        net.track.instrument = instrument;
                        this._channelInstruments[ch] = instrument;
                        if (this._toneStarted) await toneEngine.loadInstrument(ch, instrument);
                    }
                }
                return;
            }
        });

        this._mixerEl.addEventListener('input', (e) => {
            const slider = e.target.closest('.pn-mixer-slider');
            if (!slider) return;
            const netId = slider.dataset.netId;
            const net = this._project.nets[netId];
            if (!net) return;
            const ch = net.track?.channel || 1;

            // Save slider state for this net
            this._saveMixerSliderState(netId);

            if (slider.classList.contains('pn-mixer-vol')) {
                toneEngine.controlChange(ch, 7, parseInt(slider.value));
            } else if (slider.classList.contains('pn-mixer-pan')) {
                toneEngine.controlChange(ch, 10, parseInt(slider.value));
            } else if (slider.classList.contains('pn-mixer-locut')) {
                toneEngine.setChannelLoCut(ch, hpFreq(parseInt(slider.value)));
            } else if (slider.classList.contains('pn-mixer-loreso')) {
                toneEngine.setChannelLoResonance(ch, qCurve(parseInt(slider.value)));
            } else if (slider.classList.contains('pn-mixer-cutoff')) {
                toneEngine.setChannelCutoff(ch, lpFreq(parseInt(slider.value)));
            } else if (slider.classList.contains('pn-mixer-reso')) {
                toneEngine.setChannelResonance(ch, qCurve(parseInt(slider.value)));
            } else if (slider.classList.contains('pn-mixer-decay')) {
                toneEngine.setChannelDecay(ch, parseInt(slider.value) / 100);
            }
        });

        this._mixerEl.addEventListener('wheel', (e) => {
            const group = e.target.closest('.pn-mixer-slider-group');
            if (!group) return;
            e.preventDefault();
            const slider = group.querySelector('input[type="range"]');
            if (!slider) return;
            const step = e.deltaY < 0 ? 3 : -3;
            const min = parseInt(slider.min) || 0;
            const max = parseInt(slider.max) || 127;
            slider.value = Math.max(min, Math.min(max, parseInt(slider.value) + step));
            slider.dispatchEvent(new Event('input', { bubbles: true }));
        }, { passive: false });

        // Drag-to-reorder mixer rows
        let dragRow = null;
        this._mixerEl.addEventListener('mousedown', (e) => {
            const name = e.target.closest('.pn-mixer-name');
            if (!name) return;
            const row = name.closest('.pn-mixer-row');
            if (!row) return;
            dragRow = row;
            row.classList.add('dragging');
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragRow) return;
            const rows = [...this._mixerEl.querySelectorAll('.pn-mixer-row')];
            for (const row of rows) {
                if (row === dragRow) continue;
                const rect = row.getBoundingClientRect();
                if (e.clientY < rect.top + rect.height / 2 && dragRow.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING) {
                    this._mixerEl.insertBefore(dragRow, row);
                    return;
                }
                if (e.clientY > rect.top + rect.height / 2 && dragRow.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_PRECEDING) {
                    this._mixerEl.insertBefore(dragRow, row.nextSibling);
                    return;
                }
            }
        });
        document.addEventListener('mouseup', () => {
            if (dragRow) {
                dragRow.classList.remove('dragging');
                dragRow = null;
            }
        });

        // Track hovered slider for MIDI CC binding
        this._mixerEl.addEventListener('mouseover', (e) => {
            const slider = e.target.closest('.pn-mixer-slider');
            if (slider) this._hoveredSlider = slider;
        });
        this._mixerEl.addEventListener('mouseout', (e) => {
            const slider = e.target.closest('.pn-mixer-slider');
            if (slider && slider === this._hoveredSlider) this._hoveredSlider = null;
        });

        // Apply initial decay for non-percussion tracks
        for (const row of this._mixerEl.querySelectorAll('.pn-mixer-row')) {
            const decSlider = row.querySelector('.pn-mixer-decay');
            if (!decSlider) continue;
            const nid = row.dataset.netId;
            const net = this._project.nets[nid];
            if (!net) continue;
            const ch = net.track?.channel || 1;
            toneEngine.setChannelDecay(ch, parseInt(decSlider.value) / 100);
        }

        // Restore saved slider positions after DOM rebuild
        this._restoreMixerSliderState();
        // Defer notches to after layout is complete (double rAF ensures paint)
        const mixerEl = this._mixerEl;
        requestAnimationFrame(() => requestAnimationFrame(() => {
            if (mixerEl.isConnected) this._addDefaultNotches(mixerEl);
        }));
    }

    _mixerSlidersHtml(netId, isPercussion) {
        const decDefault = isPercussion ? 100 : 5;
        return `
                <div class="pn-mixer-slider-group">
                    <span>Pan</span>
                    <input type="range" class="pn-mixer-slider pn-mixer-pan" data-net-id="${netId}" data-default="64" min="0" max="127" value="64">
                </div>
                <div class="pn-mixer-slider-group">
                    <span>Vol</span>
                    <input type="range" class="pn-mixer-slider pn-mixer-vol" data-net-id="${netId}" data-default="127" min="0" max="127" value="127">
                </div>
                <div class="pn-mixer-slider-group">
                    <span>HP</span>
                    <input type="range" class="pn-mixer-slider pn-mixer-locut" data-net-id="${netId}" data-default="0" min="0" max="100" value="0" title="Low cut (high-pass)">
                </div>
                <div class="pn-mixer-slider-group">
                    <span>HPR</span>
                    <input type="range" class="pn-mixer-slider pn-mixer-loreso" data-net-id="${netId}" data-default="5" min="0" max="100" value="5" title="Low cut resonance">
                </div>
                <div class="pn-mixer-slider-group">
                    <span>LP</span>
                    <input type="range" class="pn-mixer-slider pn-mixer-cutoff" data-net-id="${netId}" data-default="100" min="0" max="100" value="100" title="High cut (low-pass)">
                </div>
                <div class="pn-mixer-slider-group">
                    <span>LPR</span>
                    <input type="range" class="pn-mixer-slider pn-mixer-reso" data-net-id="${netId}" data-default="5" min="0" max="100" value="5" title="High cut resonance">
                </div>
                <div class="pn-mixer-slider-group">
                    <span>Dec</span>
                    <input type="range" class="pn-mixer-slider pn-mixer-decay" data-net-id="${netId}" data-default="${decDefault}" min="5" max="300" value="${decDefault}" title="Envelope decay">
                </div>
                `;
    }

    _createMixerRow(id, instruments) {
        const net = this._project.nets[id];
        const isMuted = this._mutedNets.has(id);
        const isActive = id === this._activeNetId;
        const channel = net.track?.channel || 1;
        const currentInstrument = net.track?.instrument || this._channelInstruments[channel] || 'piano';

        const row = document.createElement('div');
        row.className = `pn-mixer-row ${isActive ? 'active' : ''}`;
        row.dataset.netId = id;

        const isManualMuted = this._manualMutedNets.has(id);
        row.innerHTML = `
            <input type="checkbox" class="pn-mixer-solo" data-net-id="${id}" title="Permanent mute" ${isManualMuted ? 'checked' : ''}>
            <button class="pn-mixer-mute ${isMuted ? 'muted' : ''}" data-net-id="${id}" title="${isMuted ? 'Unmute' : 'Mute'}">
                ${isMuted ? '\u{1F507}' : '\u{1F50A}'}
            </button>
            <span class="pn-mixer-name">${id}</span>
            <span class="pn-riff-variants"><span class="pn-riff-label active">A</span></span>
            <select class="pn-mixer-instrument" data-net-id="${id}">
                ${instruments.map(inst => `
                    <option value="${inst}" ${currentInstrument === inst ? 'selected' : ''}>
                        ${inst.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
                    </option>
                `).join('')}
            </select>
            ${(net.track?.instrumentSet?.length > 1) ? `<button class="pn-mixer-rotate" data-net-id="${id}" title="Next genre instrument">&raquo;</button>` : ''}
            ${this._mixerSlidersHtml(id, channel === 10)}
            <button class="pn-mixer-test" data-net-id="${id}" title="Test note">&#9835;</button>
            <button class="pn-mixer-tone-reset" data-net-id="${id}" title="Reset tone">&#8634;</button>
            <button class="pn-mixer-tone-prev" data-net-id="${id}" title="Previous tone">&lsaquo;</button>
            <button class="pn-mixer-tone-next" data-net-id="${id}" title="Random tone">&rsaquo;</button>
        `;

        return row;
    }

    _saveMixerSliderState(netId) {
        const row = this._mixerEl?.querySelector(`.pn-mixer-row[data-net-id="${netId}"]`);
        if (!row) return;
        const state = {};
        for (const [cls, key] of MIXER_SLIDERS) {
            state[key] = row.querySelector(`.${cls}`)?.value;
        }
        this._mixerSliderState.set(netId, state);
    }

    _restoreMixerSliderState() {
        for (const [netId, state] of this._mixerSliderState) {
            const row = this._mixerEl?.querySelector(`.pn-mixer-row[data-net-id="${netId}"]`);
            if (!row) continue;
            const net = this._project.nets[netId];
            if (!net) continue;
            const ch = net.track?.channel || 1;

            for (const [cls, key, applyFactory] of MIXER_SLIDERS) {
                const el = row.querySelector(`.${cls}`);
                const val = state[key];
                if (el && val != null) {
                    el.value = val;
                    applyFactory(ch)(parseInt(val));
                }
            }
        }
    }

    _saveFxState() {
        const fxEl = this.querySelector('.pn-effects-panel');
        if (!fxEl) return;
        this._savedFxValues = {};
        fxEl.querySelectorAll('.pn-fx-slider').forEach(s => {
            this._savedFxValues[s.dataset.fx] = s.value;
        });
        this._savedFxBypassed = this._fxBypassed;
    }

    _restoreFxState() {
        if (!this._savedFxValues) return;
        const fxEl = this.querySelector('.pn-effects-panel');
        if (!fxEl) return;
        for (const [fxName, val] of Object.entries(this._savedFxValues)) {
            const slider = fxEl.querySelector(`.pn-fx-slider[data-fx="${fxName}"]`);
            if (slider) {
                slider.value = val;
                // Apply to audio engine (dispatch input event to trigger applyFx)
                slider.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
        // Restore bypass state — apply to both UI and audio engine
        if (this._savedFxBypassed) {
            this._fxBypassed = true;
            const btn = this.querySelector('.pn-fx-bypass');
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
        this._savedFxValues = null;
    }

    _addDefaultNotches(container) {
        container.querySelectorAll('input[type="range"][data-default]').forEach(slider => {
            const group = slider.closest('.pn-mixer-slider-group, .pn-fx-control');
            if (!group || group.querySelector('.pn-slider-notch')) return;
            const def = parseFloat(slider.dataset.default);
            const min = parseFloat(slider.min);
            const max = parseFloat(slider.max);
            const pct = (def - min) / (max - min);
            group.style.position = 'relative';
            const notch = document.createElement('div');
            notch.className = 'pn-slider-notch';
            group.appendChild(notch);
            // Position using slider's actual rect relative to group
            requestAnimationFrame(() => {
                const thumbHalf = 6;
                const sliderRect = slider.getBoundingClientRect();
                const groupRect = group.getBoundingClientRect();
                if (sliderRect.width > 0) {
                    const px = (sliderRect.left - groupRect.left) + thumbHalf + pct * (sliderRect.width - thumbHalf * 2);
                    notch.style.left = `${px}px`;
                }
            });
        });
    }

    _toneReset(netId) {
        const row = this._mixerEl?.querySelector(`.pn-mixer-row[data-net-id="${netId}"]`);
        if (!row) return;
        const net = this._project.nets[netId];
        if (!net) return;
        const ch = net.track?.channel || 1;
        const isPerc = ch === 10;
        const defaults = { locut: '0', lores: '5', cut: '100', res: '5', dec: isPerc ? '100' : '5' };
        for (const [cls, key, applyFactory] of MIXER_SLIDERS) {
            if (key === 'vol' || key === 'pan') continue;
            const el = row.querySelector(`.${cls}`);
            if (el && defaults[key] != null) {
                el.value = defaults[key];
                applyFactory(ch)(parseInt(defaults[key]));
            }
        }
        this._saveMixerSliderState(netId);
        // Reset tone history
        this._mixerToneHistory.delete(netId);
        this._mixerToneIndex.delete(netId);
    }

    _randomToneConfig(isPerc) {
        // Generate a random but musically useful tone configuration
        const r = (lo, hi) => String(Math.floor(Math.random() * (hi - lo + 1)) + lo);
        return {
            vol: '127', pan: '64', // keep vol/pan unchanged
            locut: r(0, 40),                          // HP: 0-40 (subtle to moderate)
            lores: r(2, 25),                          // HPR: gentle to resonant
            cut: r(30, 100),                          // LP: mid to fully open
            res: r(2, 30),                            // LPR: gentle to resonant
            dec: isPerc ? r(30, 200) : r(5, 150),     // Dec: short to long
        };
    }

    _toneNav(netId, dir) {
        const row = this._mixerEl?.querySelector(`.pn-mixer-row[data-net-id="${netId}"]`);
        if (!row) return;
        const net = this._project.nets[netId];
        if (!net) return;
        const ch = net.track?.channel || 1;
        const isPerc = ch === 10;

        const readCurrent = () => {
            const state = {};
            for (const [cls, key] of MIXER_SLIDERS) {
                state[key] = row.querySelector(`.${cls}`)?.value;
            }
            return state;
        };

        const apply = (s) => {
            for (const [cls, key, applyFactory] of MIXER_SLIDERS) {
                // Don't overwrite vol/pan from random configs
                if (key === 'vol' || key === 'pan') continue;
                const el = row.querySelector(`.${cls}`);
                if (el && s[key] != null) {
                    el.value = s[key];
                    applyFactory(ch)(parseInt(s[key]));
                }
            }
            this._saveMixerSliderState(netId);
        };

        // Initialize history with current state if needed
        if (!this._mixerToneHistory.has(netId)) {
            this._mixerToneHistory.set(netId, [readCurrent()]);
            this._mixerToneIndex.set(netId, 0);
        }

        const history = this._mixerToneHistory.get(netId);
        let idx = this._mixerToneIndex.get(netId);

        if (dir > 0) {
            // Forward: if we're at the end, generate a new random config
            if (idx >= history.length - 1) {
                history.push(this._randomToneConfig(isPerc));
            }
            idx++;
        } else {
            // Back: go to previous config
            if (idx <= 0) return;
            idx--;
        }

        this._mixerToneIndex.set(netId, idx);
        apply(history[idx]);
    }

    async _testNote(netId) {
        const net = this._project.nets[netId];
        if (!net) return;
        const channel = net.track?.channel || 1;
        await this._playNote({
            note: channel === 10 ? 36 : 60,
            velocity: 100,
            duration: 200,
            channel
        });
    }

    _renderTimeline() {
        if (!this._timelineEl || !this._structure) return;
        const sections = this._structure;
        const totalSteps = sections.reduce((s, sec) => s + sec.steps, 0);

        this._timelineEl.innerHTML = '';

        // Section colors
        const sectionColors = {
            intro: '#4a90d9', verse: '#2ecc71', chorus: '#e94560',
            bridge: '#9b59b6', outro: '#f5a623',
        };

        let stepOffset = 0;
        for (const sec of sections) {
            const pct = (sec.steps / totalSteps) * 100;
            const color = sectionColors[sec.name] || '#888';
            const block = document.createElement('div');
            block.className = 'pn-timeline-section';
            block.style.width = `${pct}%`;
            block.style.background = color;
            block.dataset.start = stepOffset;
            block.dataset.end = stepOffset + sec.steps;

            // Check if section has phrase patterns
            const phrases = sec.phrases;
            if (phrases) {
                // Find the longest phrase array to determine phrase count
                const phraseLists = Object.values(phrases);
                const phraseCount = phraseLists.length > 0 ? Math.max(...phraseLists.map(p => p.length)) : 1;

                if (phraseCount > 1) {
                    // Get representative phrase pattern (first role's pattern)
                    const firstRole = Object.keys(phrases)[0];
                    const pattern = phrases[firstRole] || ['A'];

                    block.innerHTML = `<span>${sec.name}</span><span class="pn-timeline-phrases">${pattern.join('')}</span>`;

                    // Add thin dividers at phrase boundaries
                    for (let pi = 1; pi < phraseCount; pi++) {
                        const divider = document.createElement('div');
                        divider.className = 'pn-timeline-phrase-divider';
                        divider.style.left = `${(pi / phraseCount) * 100}%`;
                        block.appendChild(divider);
                    }
                } else {
                    block.innerHTML = `<span>${sec.name}</span>`;
                }
            } else {
                block.innerHTML = `<span>${sec.name}</span>`;
            }

            this._timelineEl.appendChild(block);
            stepOffset += sec.steps;
        }

        // Loop region highlight
        const loopRegion = document.createElement('div');
        loopRegion.className = 'pn-loop-region';
        this._timelineEl.appendChild(loopRegion);
        this._loopRegionEl = loopRegion;

        // Loop markers
        const loopStartEl = document.createElement('div');
        loopStartEl.className = 'pn-loop-marker pn-loop-start';
        this._timelineEl.appendChild(loopStartEl);
        this._loopStartEl = loopStartEl;

        const loopEndEl = document.createElement('div');
        loopEndEl.className = 'pn-loop-marker pn-loop-end';
        this._timelineEl.appendChild(loopEndEl);
        this._loopEndEl = loopEndEl;

        // Crop button reference (lives in FX bar, visibility toggled by _updateLoopMarkers)
        this._cropBtnEl = this.querySelector('.pn-crop-bar-btn');

        // Playhead
        const playhead = document.createElement('div');
        playhead.className = 'pn-timeline-playhead';
        this._timelineEl.appendChild(playhead);
        this._playheadEl = playhead;

        this._totalSteps = totalSteps;
        // Place markers at track start/end by default
        this._loopStart = 0;
        this._loopEnd = totalSteps;
        this._updateLoopMarkers();
    }

    _updatePlayhead() {
        if (!this._playheadEl || !this._structure || !this._totalSteps) return;

        // Interpolate between server ticks for smooth movement
        let tickEstimate = this._tick;
        if (this._playing && this._tickTimestamp > 0) {
            const elapsed = performance.now() - this._tickTimestamp;
            const tickMs = 60000 / (this._tempo * 4); // ms per tick (4 ticks/beat)
            // Cap interpolation to 6 ticks (one server update interval) to avoid overshoot
            const interpolated = Math.min(elapsed / tickMs, 6);
            tickEstimate = this._tick + interpolated;
        }

        const pct = Math.min(100, (tickEstimate / this._totalSteps) * 100);
        // Only move forward (prevent jitter when server tick arrives), unless looping
        if (!this._lastPlayheadPct || pct >= this._lastPlayheadPct || pct < 1 || this._loopStart >= 0) {
            this._lastPlayheadPct = pct;
            this._playheadEl.style.left = `${pct}%`;
        }
    }

    _updateLoopMarkers() {
        if (!this._loopStartEl || !this._totalSteps) return;
        this._loopStartEl.style.left = `${(this._loopStart / this._totalSteps) * 100}%`;
        this._loopEndEl.style.left = `${(this._loopEnd / this._totalSteps) * 100}%`;
        // Show region highlight only when markers differ from full range
        const isFullRange = this._loopStart === 0 && this._loopEnd === this._totalSteps;
        if (!isFullRange && this._loopRegionEl) {
            const left = (this._loopStart / this._totalSteps) * 100;
            const width = ((this._loopEnd - this._loopStart) / this._totalSteps) * 100;
            this._loopRegionEl.style.left = `${left}%`;
            this._loopRegionEl.style.width = `${width}%`;
            this._loopRegionEl.style.display = '';
        } else if (this._loopRegionEl) {
            this._loopRegionEl.style.display = 'none';
        }
        // Show crop button in FX bar when loop region is narrower than full track
        if (this._cropBtnEl) {
            this._cropBtnEl.style.display = isFullRange ? 'none' : '';
        }
    }

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

    _setupEventListeners() {
        // Window resize
        window.addEventListener('resize', () => this._resizeCanvas());

        // Transport controls
        this.querySelector('.pn-play').addEventListener('click', () => this._togglePlay());
        this.querySelector('.pn-playback-mode').addEventListener('click', () => this._cyclePlaybackMode());
        this.querySelector('.pn-tempo input').addEventListener('change', (e) => {
            this._setTempo(parseInt(e.target.value, 10));
        });
        this.querySelector('.pn-tempo').addEventListener('wheel', (e) => {
            e.preventDefault();
            const input = this.querySelector('.pn-tempo input');
            const step = e.deltaY < 0 ? 2 : -2;
            this._setTempo(parseInt(input.value, 10) + step);
        }, { passive: false });

        // Track navigation
        this.querySelector('.pn-track-prev').addEventListener('click', () => this._navTrack(-1));
        this.querySelector('.pn-track-next').addEventListener('click', () => this._navTrack(1));
        this._updateTrackLabel();

        // Generate: triggered by button, genre change, or structure change
        const doGenerate = () => {
            toneEngine.resumeContext();
            this._ensureToneStarted();
            const genre = this.querySelector('.pn-genre-select').value;
            const params = { ...(this._traitOverrides || {}) };
            const structure = this.querySelector('.pn-structure-select').value;
            if (structure) params.structure = structure;
            this._sendWs({ type: 'generate', genre, params });
        };
        this.querySelector('.pn-generate-btn').addEventListener('click', doGenerate);
        this.querySelector('.pn-genre-select').addEventListener('change', doGenerate);
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

        // Audio mode
        this.querySelector('.pn-audio-mode').addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-mode]');
            if (btn) {
                this._setAudioMode(btn.dataset.mode);
            }
        });

        // Help modal
        this.querySelector('.pn-help-btn')?.addEventListener('click', () => {
            this._showHelpModal();
        });

        // MIDI output selector
        this.querySelector('.pn-midi-output').addEventListener('change', (e) => {
            this._midiOutputId = e.target.value || null;
        });

        // Canvas interactions (pan/zoom only)
        this._canvas.parentElement.addEventListener('pointerdown', (e) => this._onPointerDown(e));
        this._canvas.parentElement.addEventListener('pointermove', (e) => this._onPointerMove(e));
        this._canvas.parentElement.addEventListener('pointerup', (e) => this._onPointerUp(e));
        // Wheel zoom disabled — let the page scroll naturally

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === ' ') this._spaceHeld = true;
            this._onKeyDown(e);
        });
        document.addEventListener('keyup', (e) => {
            if (e.key === ' ') this._spaceHeld = false;
        });
    }

    // === Rendering ===

    _renderNet() {
        const net = this._getActiveNet();
        if (!net) return;

        // Clear stage
        this._stage.innerHTML = '';
        this._nodes = {};

        // Render places
        for (const [id, place] of Object.entries(net.places)) {
            this._createPlaceElement(id, place);
        }

        // Render transitions
        for (const [id, trans] of Object.entries(net.transitions)) {
            this._createTransitionElement(id, trans);
        }

        this._centerNet();
        this._draw();
    }

    _centerNet() {
        const net = this._getActiveNet();
        if (!net || !this._canvas) return;

        // Compute bounding box of all nodes
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const place of Object.values(net.places)) {
            minX = Math.min(minX, place.x);
            minY = Math.min(minY, place.y);
            maxX = Math.max(maxX, place.x);
            maxY = Math.max(maxY, place.y);
        }
        for (const trans of Object.values(net.transitions)) {
            minX = Math.min(minX, trans.x);
            minY = Math.min(minY, trans.y);
            maxX = Math.max(maxX, trans.x);
            maxY = Math.max(maxY, trans.y);
        }
        if (!isFinite(minX)) return;

        const pad = 60;
        const netW = maxX - minX + pad * 2;
        const netH = maxY - minY + pad * 2;
        const vpW = this._canvas.width / this._dpr;
        const vpH = this._canvas.height / this._dpr;

        // Scale to fit, capped at 1x (don't upscale small nets)
        const scale = Math.min(1, vpW / netW, vpH / netH);
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const tx = vpW / 2 - cx * scale;
        const ty = vpH / 2 - cy * scale;

        this._view = { scale, tx, ty };

        // Apply transform to stage (DOM nodes)
        this._stage.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
        this._stage.style.transformOrigin = '0 0';
    }

    _createPlaceElement(id, place) {
        const el = document.createElement('div');
        el.className = 'pn-node pn-place';
        el.dataset.id = id;
        el.dataset.type = 'place';
        el.style.left = `${place.x - 30}px`;
        el.style.top = `${place.y - 30}px`;

        const label = place.label && !/^(p|deg)\d+/.test(place.label) ? place.label : '';
        el.innerHTML = `
            <div class="pn-place-circle"></div>
            ${label ? `<div class="pn-label">${label}</div>` : ''}
        `;

        this._stage.appendChild(el);
        this._nodes[id] = el;
    }

    _createTransitionElement(id, trans) {
        const el = document.createElement('div');
        el.className = 'pn-node pn-transition';
        if (trans.midi) el.classList.add('has-midi');
        el.dataset.id = id;
        el.dataset.type = 'transition';
        el.style.left = `${trans.x - 25}px`;
        el.style.top = `${trans.y - 25}px`;

        const tLabel = trans.label && !/^t\d+/.test(trans.label) ? trans.label : '';
        el.innerHTML = `
            <div class="pn-transition-rect"></div>
            ${trans.midi ? `<div class="pn-midi-badge" title="Note: ${trans.midi.note}">${this._noteToName(trans.midi.note)}</div>` : ''}
            ${tLabel ? `<div class="pn-label">${tLabel}</div>` : ''}
        `;

        this._stage.appendChild(el);
        this._nodes[id] = el;
    }

    _noteToName(note) {
        const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const octave = Math.floor(note / 12) - 1;
        return names[note % 12] + octave;
    }

    _draw() {
        const ctx = this._ctx;
        if (!ctx) return;

        const width = this._canvas.width / this._dpr;
        const height = this._canvas.height / this._dpr;

        ctx.clearRect(0, 0, width, height);

        const net = this._getActiveNet();
        if (!net) return;

        // Apply view transform to match stage
        ctx.save();
        ctx.translate(this._view.tx, this._view.ty);
        ctx.scale(this._view.scale, this._view.scale);

        // Draw arcs
        ctx.strokeStyle = '#4a90d9';
        ctx.lineWidth = 2 / this._view.scale;

        for (const arc of net.arcs) {
            const srcNode = net.places[arc.source] || net.transitions[arc.source];
            const trgNode = net.places[arc.target] || net.transitions[arc.target];
            if (!srcNode || !trgNode) continue;

            ctx.beginPath();
            ctx.moveTo(srcNode.x, srcNode.y);
            ctx.lineTo(trgNode.x, trgNode.y);
            ctx.stroke();

            // Draw arrowhead
            this._drawArrowhead(ctx, srcNode.x, srcNode.y, trgNode.x, trgNode.y);

            // Draw weight if > 1
            const weight = arc.weight[0];
            if (weight > 1) {
                const mx = (srcNode.x + trgNode.x) / 2;
                const my = (srcNode.y + trgNode.y) / 2;
                ctx.fillStyle = '#1a1a2e';
                ctx.beginPath();
                ctx.arc(mx, my, 12, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#4a90d9';
                ctx.font = '12px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(weight.toString(), mx, my);
            }
        }

        // Restore before drawing viewport-space elements
        ctx.restore();
    }

    _drawArrowhead(ctx, x1, y1, x2, y2) {
        const headLen = 12;
        const angle = Math.atan2(y2 - y1, x2 - x1);

        // Offset to edge of target node
        const offset = 25;
        const tx = x2 - Math.cos(angle) * offset;
        const ty = y2 - Math.sin(angle) * offset;

        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx - headLen * Math.cos(angle - Math.PI / 6), ty - headLen * Math.sin(angle - Math.PI / 6));
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx - headLen * Math.cos(angle + Math.PI / 6), ty - headLen * Math.sin(angle + Math.PI / 6));
        ctx.stroke();
    }

    // === Pointer Events ===

    // Convert viewport coordinates to model coordinates
    _viewToModel(vx, vy) {
        return {
            x: (vx - this._view.tx) / this._view.scale,
            y: (vy - this._view.ty) / this._view.scale,
        };
    }

    _onPointerDown(e) {
        const rect = this._canvas.parentElement.getBoundingClientRect();
        const vx = e.clientX - rect.left;
        const vy = e.clientY - rect.top;

        // Pan: any click or space held
        if (e.button === 1 || this._spaceHeld || e.button === 0) {
            this._panning = { lastX: vx, lastY: vy };
            e.preventDefault();
            return;
        }
    }

    _onPointerMove(e) {
        if (!this._panning) return;

        const rect = this._canvas.parentElement.getBoundingClientRect();
        const vx = e.clientX - rect.left;
        const vy = e.clientY - rect.top;

        this._view.tx += vx - this._panning.lastX;
        this._view.ty += vy - this._panning.lastY;
        this._panning.lastX = vx;
        this._panning.lastY = vy;
        this._stage.style.transform = `translate(${this._view.tx}px, ${this._view.ty}px) scale(${this._view.scale})`;
        this._draw();
    }

    _onPointerUp(e) {
        this._panning = null;
    }

    _onWheel(e) {
        e.preventDefault();
        const rect = this._canvas.parentElement.getBoundingClientRect();
        const vx = e.clientX - rect.left;
        const vy = e.clientY - rect.top;

        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        const newScale = Math.max(0.1, Math.min(3, this._view.scale * delta));

        // Zoom toward cursor
        this._view.tx = vx - (vx - this._view.tx) * (newScale / this._view.scale);
        this._view.ty = vy - (vy - this._view.ty) * (newScale / this._view.scale);
        this._view.scale = newScale;

        this._stage.style.transform = `translate(${this._view.tx}px, ${this._view.ty}px) scale(${this._view.scale})`;
        this._draw();
    }

    _onKeyDown(e) {
        // Space to play/stop
        if (e.key === ' ' && e.target.tagName !== 'INPUT') {
            e.preventDefault();
            this._togglePlay();
        }
        // Arrow keys adjust hovered slider
        if (this._hoveredSlider && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            e.preventDefault();
            const slider = this._hoveredSlider;
            const step = (e.key === 'ArrowUp' || e.key === 'ArrowRight') ? 1 : -1;
            const min = parseInt(slider.min) || 0;
            const max = parseInt(slider.max) || 127;
            slider.value = Math.max(min, Math.min(max, parseInt(slider.value) + step));
            slider.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    _loadUploadedProject(proj) {
        // Restore FX settings before loading project
        if (proj.fx) {
            const setFx = (name, val) => {
                const slider = this.querySelector(`.pn-fx-slider[data-fx="${name}"]`);
                if (slider && val != null) {
                    slider.value = val;
                    slider.dispatchEvent(new Event('input', { bubbles: true }));
                }
            };
            setFx('master-vol', proj.fx.masterVol);
            setFx('reverb-size', proj.fx.reverbSize);
            setFx('reverb-damp', proj.fx.reverbDamp);
            setFx('reverb-wet', proj.fx.reverbWet);
            setFx('delay-time', proj.fx.delayTime);
            setFx('delay-feedback', proj.fx.delayFeedback);
            setFx('delay-wet', proj.fx.delayWet);
            setFx('distortion', proj.fx.distortion);
            setFx('hp-freq', proj.fx.hpFreq);
            setFx('lp-freq', proj.fx.lpFreq);
            setFx('phaser-freq', proj.fx.phaserFreq);
            setFx('phaser-depth', proj.fx.phaserDepth);
            setFx('phaser-wet', proj.fx.phaserWet);
            setFx('crush-bits', proj.fx.crushBits);
        }

        // Extract mix settings before they get lost in project load
        const mixSettings = new Map();
        for (const [netId, net] of Object.entries(proj.nets || {})) {
            if (net.track?.mix) {
                mixSettings.set(netId, net.track.mix);
            }
        }

        this._project = proj;
        this._normalizeProject();
        this._activeNetId = Object.keys(this._project.nets)[0] || null;
        this._renderNet();
        this._renderMixer();
        this._sendWs({ type: 'project-load', project: proj });

        // Restore mix slider state after mixer is rendered
        for (const [netId, mix] of mixSettings) {
            this._mixerSliderState.set(netId, {
                vol: mix.volume ?? 100,
                pan: mix.pan ?? 64,
                locut: mix.loCut ?? 0,
                lores: mix.loResonance ?? 5,
                cut: mix.cutoff ?? 100,
                res: mix.resonance ?? 5,
                dec: mix.decay ?? 100,
            });
        }
        this._restoreMixerSliderState();
    }

    _serializeProject() {
        const proj = JSON.parse(JSON.stringify(this._project));
        for (const [netId, net] of Object.entries(proj.nets)) {
            if (!net.track) continue;
            const row = this._mixerEl?.querySelector(`.pn-mixer-row[data-net-id="${netId}"]`);
            if (row) {
                const vol = row.querySelector('.pn-mixer-vol')?.value;
                const pan = row.querySelector('.pn-mixer-pan')?.value;
                const locut = row.querySelector('.pn-mixer-locut')?.value;
                const lores = row.querySelector('.pn-mixer-loreso')?.value;
                const cut = row.querySelector('.pn-mixer-cutoff')?.value;
                const res = row.querySelector('.pn-mixer-reso')?.value;
                const dec = row.querySelector('.pn-mixer-decay')?.value;
                net.track.mix = {
                    volume: parseInt(vol ?? 100),
                    pan: parseInt(pan ?? 64),
                    loCut: parseInt(locut ?? 0),
                    loResonance: parseInt(lores ?? 5),
                    cutoff: parseInt(cut ?? 100),
                    resonance: parseInt(res ?? 5),
                    decay: parseInt(dec ?? 100),
                };
            }
        }
        const fxVal = (name) => parseInt(this.querySelector(`.pn-fx-slider[data-fx="${name}"]`)?.value ?? 0);
        proj.fx = {
            masterVol: fxVal('master-vol'),
            reverbSize: fxVal('reverb-size'),
            reverbDamp: fxVal('reverb-damp'),
            reverbWet: fxVal('reverb-wet'),
            delayTime: fxVal('delay-time'),
            delayFeedback: fxVal('delay-feedback'),
            delayWet: fxVal('delay-wet'),
            distortion: fxVal('distortion'),
            hpFreq: fxVal('hp-freq'),
            lpFreq: fxVal('lp-freq'),
            phaserFreq: fxVal('phaser-freq'),
            phaserDepth: fxVal('phaser-depth'),
            phaserWet: fxVal('phaser-wet'),
            crushBits: fxVal('crush-bits'),
        };
        return proj;
    }

    _downloadProject() {
        const proj = this._serializeProject();
        const blob = new Blob([JSON.stringify(proj, null, 2)], { type: 'application/ld+json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${proj.name || 'petri-note'}.jsonld`;
        a.click();
        URL.revokeObjectURL(url);
    }

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
    }

    // === MIDI ===

    _openMidiEditor(transitionId) {
        const net = this._getActiveNet();
        const trans = net.transitions[transitionId];
        const midi = trans.midi || { note: 60, channel: net.track.channel, velocity: 100, duration: 100 };

        const overlay = document.createElement('div');
        overlay.className = 'pn-modal-overlay';
        overlay.innerHTML = `
            <div class="pn-modal">
                <h2>MIDI Binding: ${trans.label || transitionId}</h2>
                <div class="pn-modal-row">
                    <label>Note</label>
                    <input type="number" name="note" value="${midi.note}" min="0" max="127"/>
                    <span>${this._noteToName(midi.note)}</span>
                </div>
                <div class="pn-modal-row">
                    <label>Channel</label>
                    <input type="number" name="channel" value="${midi.channel}" min="1" max="16"/>
                </div>
                <div class="pn-modal-row">
                    <label>Velocity</label>
                    <input type="number" name="velocity" value="${midi.velocity}" min="0" max="127"/>
                </div>
                <div class="pn-modal-row">
                    <label>Duration</label>
                    <input type="number" name="duration" value="${midi.duration}" min="10" max="10000"/>
                    <span>ms</span>
                </div>
                <div class="pn-modal-actions">
                    <button class="cancel">Cancel</button>
                    <button class="test">Test</button>
                    <button class="save">Save</button>
                </div>
            </div>
        `;

        this.appendChild(overlay);

        // Update note name on change
        const noteInput = overlay.querySelector('input[name="note"]');
        const noteName = overlay.querySelector('.pn-modal-row span');
        noteInput.addEventListener('input', () => {
            noteName.textContent = this._noteToName(parseInt(noteInput.value, 10));
        });

        // Button handlers
        overlay.querySelector('.cancel').addEventListener('click', () => overlay.remove());
        overlay.querySelector('.test').addEventListener('click', () => {
            const testMidi = {
                note: parseInt(overlay.querySelector('input[name="note"]').value, 10),
                channel: parseInt(overlay.querySelector('input[name="channel"]').value, 10),
                velocity: parseInt(overlay.querySelector('input[name="velocity"]').value, 10),
                duration: parseInt(overlay.querySelector('input[name="duration"]').value, 10)
            };
            this._playNote(testMidi);
        });
        overlay.querySelector('.save').addEventListener('click', () => {
            trans.midi = {
                note: parseInt(overlay.querySelector('input[name="note"]').value, 10),
                channel: parseInt(overlay.querySelector('input[name="channel"]').value, 10),
                velocity: parseInt(overlay.querySelector('input[name="velocity"]').value, 10),
                duration: parseInt(overlay.querySelector('input[name="duration"]').value, 10)
            };
            this._pushHistory();
            overlay.remove();
            this._renderNet();
            this._syncProject();
        });

        // Click outside to close
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });
    }

    _fireTransition(transitionId) {
        const net = this._getActiveNet();
        const trans = net.transitions[transitionId];

        // Check if enabled (all input places have enough tokens)
        const inputArcs = net.arcs.filter(a => a.target === transitionId);
        const outputArcs = net.arcs.filter(a => a.source === transitionId);

        for (const arc of inputArcs) {
            const place = net.places[arc.source];
            if (!place || (place.tokens[0] || 0) < arc.weight[0]) {
                return false;
            }
        }

        // Fire: consume input tokens
        for (const arc of inputArcs) {
            const place = net.places[arc.source];
            place.tokens[0] = (place.tokens[0] || 0) - arc.weight[0];
        }

        // Produce output tokens
        for (const arc of outputArcs) {
            const place = net.places[arc.target];
            if (place) {
                place.tokens[0] = (place.tokens[0] || 0) + arc.weight[0];
            }
        }

        // Visual feedback
        const el = this._nodes[transitionId];
        if (el) {
            el.classList.add('firing');
            setTimeout(() => el.classList.remove('firing'), 100);
        }

        // Play MIDI note
        if (trans.midi) {
            this._playNote(trans.midi);
        }

        // Update display
        this._renderNet();

        // Send to server
        this._sendWs({ type: 'transition-fire', netId: this._activeNetId, transitionId });

        return true;
    }

    // === Audio (Tone.js) ===

    async _initAudio() {
        // Audio state already initialized in constructor
        // Tone.js requires user gesture to start - handled in _ensureToneStarted
        this._connectMidiInputs();
    }

    async _connectMidiInputs() {
        if (this._midiInputConnected || !navigator.requestMIDIAccess) return;
        try {
            const midi = await navigator.requestMIDIAccess({ sysex: false });
            for (const input of midi.inputs.values()) {
                input.onmidimessage = (e) => this._handleMidiCC(e);
            }
            // Listen for new devices plugged in
            midi.onstatechange = () => {
                for (const input of midi.inputs.values()) {
                    if (!input.onmidimessage) {
                        input.onmidimessage = (e) => this._handleMidiCC(e);
                    }
                }
            };
            this._midiInputConnected = true;
            console.log('MIDI inputs connected:', [...midi.inputs.values()].map(i => i.name).join(', '));
        } catch (e) {
            console.warn('MIDI input access denied:', e);
        }
    }

    // Build a logical key and CSS selector for a slider so bindings survive DOM rebuilds.
    _sliderBindingKey(slider) {
        // FX slider: keyed by data-fx attribute
        if (slider.dataset.fx) {
            return { key: `fx:${slider.dataset.fx}`, selector: `.pn-fx-slider[data-fx="${slider.dataset.fx}"]` };
        }
        // Mixer slider: keyed by riffGroup (or netId) + slider class
        const row = slider.closest('.pn-mixer-row');
        if (!row) return null;
        const group = row.dataset.riffGroup || row.dataset.netId;
        const cls = [...slider.classList].find(c => c.startsWith('pn-mixer-') && c !== 'pn-mixer-slider');
        if (!group || !cls) return null;
        return { key: `mix:${group}:${cls}`, selector: `.pn-mixer-row[data-riff-group="${group}"] .${cls}, .pn-mixer-row[data-net-id="${group}"] .${cls}` };
    }

    // Resolve a binding's selector to a current DOM element.
    _resolveBinding(binding) {
        return this.querySelector(binding.selector);
    }

    _handleMidiCC(event) {
        const [status, cc, value] = event.data;
        const type = status & 0xF0;
        if (type !== 0xB0) return; // Only handle Control Change

        // If hovering over a slider, bind this CC to it
        if (this._hoveredSlider && !this._ccBindings.has(cc)) {
            const binding = this._sliderBindingKey(this._hoveredSlider);
            if (binding) {
                this._ccBindings.set(cc, binding);
                const sliderGroup = this._hoveredSlider.closest('.pn-mixer-slider-group') || this._hoveredSlider.closest('.pn-fx-group');
                const label = sliderGroup?.querySelector('span')?.textContent || this._hoveredSlider.dataset.fx || '?';
                const row = this._hoveredSlider.closest('.pn-mixer-row');
                const name = row?.querySelector('.pn-mixer-name')?.textContent || 'FX';
                console.log(`CC ${cc} → ${name} ${label}`);
                // Visual flash to confirm binding
                this._hoveredSlider.style.outline = '2px solid #64ffda';
                setTimeout(() => { if (this._hoveredSlider) this._hoveredSlider.style.outline = ''; }, 300);
            }
        }

        // Apply CC value to bound slider (resolve from DOM each time)
        const binding = this._ccBindings.get(cc);
        if (!binding) return;

        const slider = this._resolveBinding(binding);
        if (!slider) return;

        const min = parseFloat(slider.min);
        const max = parseFloat(slider.max);
        slider.value = Math.round(min + (value / 127) * (max - min));
        slider.dispatchEvent(new Event('input', { bubbles: true }));
    }

    async _ensureToneStarted() {
        if (this._toneStarted) return;
        if (this._toneInitPromise) return this._toneInitPromise;
        this._toneInitPromise = (async () => {
            try {
                await toneEngine.init();
                this._toneStarted = true;
                const loads = Object.entries(this._channelInstruments).map(
                    ([ch, inst]) => toneEngine.loadInstrument(parseInt(ch), inst)
                );
                await Promise.all(loads);
            } catch (e) {
                console.error('Failed to start Tone.js:', e);
            }
        })();
        return this._toneInitPromise;
    }

    _showHelpModal() {
        // Remove existing modal if any
        this.querySelector('.pn-help-overlay')?.remove();
        const overlay = document.createElement('div');
        overlay.className = 'pn-help-overlay';
        overlay.innerHTML = `
            <div class="pn-help-modal">
                <button class="pn-help-close">&times;</button>
                <h2>Performance Guide</h2>

                <h3>Getting Started</h3>
                <ul>
                    <li><b>Generate</b> a track, then hit <b>Play</b></li>
                    <li>Use <b>Shuffle</b> mode (click 1x until you see the shuffle icon) for continuous new tracks</li>
                    <li>Choose a <b>Structure</b> (Standard, Drop, etc.) for tracks with sections and a timeline</li>
                </ul>

                <h3>Filter Moves</h3>
                <ul>
                    <li><b>LP sweep down</b> &mdash; close the low-pass to darken the mix, then open for the drop</li>
                    <li><b>HP sweep up</b> &mdash; thin out the low end for a breakdown, release for impact</li>
                    <li><b>Both at once</b> &mdash; sweep HP up and LP down to isolate mids, then release both</li>
                    <li><b>Resonance spike</b> &mdash; boost LPR or HPR while sweeping for acid squelch</li>
                    <li><b>Safety filter</b> &mdash; pull LP or HP to hide a track while you change its instrument</li>
                </ul>

                <h3>Mixer Moves</h3>
                <ul>
                    <li><b>Volume kills</b> &mdash; drop kick or snare volume to zero for instant breakdowns</li>
                    <li><b>Decay sweep</b> &mdash; crank Dec up on melody to pad-like, bring back for staccato</li>
                    <li><b>Mute groups</b> &mdash; click track names to mute/unmute for live arrangement</li>
                    <li><b>Instrument swap</b> &mdash; change an instrument mid-loop (use LP to mask the switch)</li>
                </ul>

                <h3>FX Moves</h3>
                <ul>
                    <li><b>Reverb wash</b> &mdash; crank reverb Mix to 100% then cut it (freeze effect)</li>
                    <li><b>Delay throw</b> &mdash; bump delay Mix up briefly on a hit, then cut back</li>
                    <li><b>Distortion rise</b> &mdash; slowly bring up Drive for tension, kill for release</li>
                    <li><b>Bypass toggle</b> &mdash; instant wet/dry comparison or dramatic cuts</li>
                    <li><b>Phaser sweep</b> &mdash; bring up Mix and adjust Rate for swirling motion</li>
                    <li><b>Bit crush</b> &mdash; push Bits slider up for lo-fi degradation, great on drums</li>
                </ul>

                <h3>Loop & Timeline</h3>
                <ul>
                    <li><b>Right-click</b> timeline to snap the nearest loop marker to that position</li>
                    <li><b>Drag</b> the orange markers to set a loop region (snaps to bars)</li>
                    <li><b>Crop</b> (scissors icon) &mdash; trim the track to just the looped section</li>
                    <li><b>Click</b> the timeline to seek to any position</li>
                </ul>

                <h3>Keyboard Shortcuts</h3>
                <ul>
                    <li><b>Space</b> &mdash; Play / Stop</li>
                    <li><b>Scroll</b> over any slider to adjust it</li>
                </ul>

                <h3>MIDI CC</h3>
                <ul>
                    <li>Hover a slider and move a MIDI CC knob to bind it</li>
                    <li>Use <b>CC Reset</b> in the FX panel to clear all bindings</li>
                </ul>

                <h3>Built With</h3>
                <p style="margin:0 0 8px;color:#aaa;font-size:0.95em">The sequencer is a <b>Petri net</b> executor &mdash; every note is a transition firing, every rhythm is tokens circulating. Carl Adam Petri's 1962 formalism is the runtime.</p>
                <ul>
                    <li><b><a href="https://tonejs.github.io/" target="_blank" style="color:#0af">Tone.js</a></b> &mdash; turns transition firings into sound</li>
                    <li><b>Bjorklund's algorithm</b> &mdash; generates Euclidean rhythms that become token rings in the net</li>
                </ul>
            </div>
        `;
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay || e.target.closest('.pn-help-close')) {
                overlay.remove();
            }
        });
        this.appendChild(overlay);
    }

    _setAudioMode(mode) {
        this._audioMode = mode;
        this.querySelectorAll('.pn-audio-mode button').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });

        const midiSelect = this.querySelector('.pn-midi-output');
        if (midiSelect) {
            midiSelect.style.display = mode === 'web-midi' ? 'block' : 'none';
            if (mode === 'web-midi') {
                this._refreshMidiOutputs();
            }
        }
    }

    async _refreshMidiOutputs() {
        if (!navigator.requestMIDIAccess) {
            console.warn('Web MIDI not supported');
            return;
        }

        try {
            this._midiAccess = await navigator.requestMIDIAccess();
            const select = this.querySelector('.pn-midi-output');
            if (!select) return;

            // Clear existing options except first
            select.innerHTML = '<option value="">Select MIDI output...</option>';

            // Add available outputs
            for (const [id, output] of this._midiAccess.outputs) {
                const option = document.createElement('option');
                option.value = id;
                option.textContent = output.name || id;
                if (this._midiOutputId === id) {
                    option.selected = true;
                }
                select.appendChild(option);
            }

            // Auto-select first if none selected and outputs available
            if (!this._midiOutputId && this._midiAccess.outputs.size > 0) {
                const firstId = this._midiAccess.outputs.keys().next().value;
                this._midiOutputId = firstId;
                select.value = firstId;
            }
        } catch (e) {
            console.error('MIDI access error:', e);
        }
    }

    _toggleMute(netId) {
        const muted = !this._mutedNets.has(netId);
        if (muted) {
            this._mutedNets.add(netId);
        } else {
            this._mutedNets.delete(netId);
        }
        this._sendWs({ type: 'mute', netId, muted });
        this._debouncedRenderMixer();
    }

    _toggleMuteGroup(riffGroup) {
        // Find all nets in this riff group
        const netIds = [];
        for (const [id, net] of Object.entries(this._project.nets)) {
            if (net.riffGroup === riffGroup) netIds.push(id);
        }
        if (netIds.length === 0) return;

        // If all are muted, unmute; otherwise mute
        const allMuted = netIds.every(nid => this._mutedNets.has(nid));
        const muted = !allMuted;

        // Let the server handle riff group logic (only unmutes the active slot)
        this._sendWs({ type: 'mute-group', riffGroup, muted });
    }

    _debouncedRenderMixer() {
        if (this._renderMixerTimeout) return;
        this._renderMixerTimeout = setTimeout(() => {
            this._renderMixerTimeout = null;
            this._renderMixer();
        }, 100);
    }

    async _playNote(midi, netId) {
        const channel = midi.channel || 1;
        if (netId && (this._mutedNets.has(netId) || this._manualMutedNets.has(netId))) {
            return; // Skip muted nets
        }
        if (this._mutedChannels.has(channel)) {
            return; // Skip muted channels (legacy)
        }

        if (this._audioMode === 'tone' || this._audioMode === 'web-audio') {
            await this._playTone(midi);
        } else if (this._audioMode === 'web-midi') {
            await this._playWebMidi(midi);
        }
        // 'backend' mode: server handles MIDI
    }

    async _playTone(midi) {
        if (!this._toneStarted) {
            await this._ensureToneStarted();
        }
        toneEngine.playNote(midi);
    }

    // === Visualization ===

    _vizColors = {
        kick:    '#e94560',
        snare:   '#f5a623',
        hihat:   '#f8e71c',
        clap:    '#ff6b6b',
        bass:    '#4a90d9',
        melody:  '#2ecc71',
        harmony: '#9b59b6',
        arp:     '#00d2ff',
    };

    _vizDefaultColor = '#888';

    _vizColorForNet(netId) {
        if (this._vizColors[netId]) return this._vizColors[netId];
        // Match riff group prefix: "kick-0" -> "kick"
        const base = netId.replace(/-\d+$/, '');
        return this._vizColors[base] || this._vizDefaultColor;
    }

    _vizSpawnParticle(netId, midi) {
        // Rolling history for timeline
        this._vizHistory.push({ time: Date.now(), netId, note: midi?.note });
        if (this._vizHistory.length > 200) this._vizHistory.shift();
    }

    _vizStartLoop() {
        if (this._vizRafId) return;
        const loop = () => {
            this._vizRafId = requestAnimationFrame(loop);
            this._vizDrawFrame();
        };
        this._vizRafId = requestAnimationFrame(loop);
    }

    _vizStopLoop() {
        if (this._vizRafId) {
            cancelAnimationFrame(this._vizRafId);
            this._vizRafId = null;
        }
    }

    _vizDrawFrame() {
        const ctx = this._ctx;
        if (!ctx) return;
        const w = this._canvas.width / this._dpr;
        const h = this._canvas.height / this._dpr;

        ctx.clearRect(0, 0, w, h);

        // Draw rolling timeline
        this._vizDrawTimeline(ctx, w, h);

        // Draw the petri net overlay
        this._vizDrawPetriOverlay(ctx, w, h);

        // Smooth playhead interpolation
        this._updatePlayhead();
    }

    _vizDrawTimeline(ctx, w, h) {
        const now = Date.now();
        // Adaptive window: shrinks to fit available dots, grows to max 4 bars
        // At 120bpm, 4 bars = 8s. Use elapsed since first dot as the window.
        const maxWindowMs = (240 / Math.max(60, this._tempo)) * 1000; // ~4 bars
        const elapsed = this._vizHistory.length > 0 ? now - this._vizHistory[0].time : 0;
        const windowMs = Math.max(2000, Math.min(maxWindowMs, elapsed + 500));

        for (const evt of this._vizHistory) {
            const age = now - evt.time;
            if (age > windowMs) continue;
            const x = w - (age / windowMs) * w;
            const color = this._vizColorForNet(evt.netId);
            // Stay visible across the full screen: fade only in the last 15%
            const pct = age / windowMs;
            const alpha = pct < 0.85 ? 0.7 : 0.7 * (1 - (pct - 0.85) / 0.15);

            ctx.globalAlpha = alpha;
            ctx.fillStyle = color;
            // Short streak trailing behind the dot
            const streakLen = Math.min(20, (w / windowMs) * 120); // ~120ms trail
            const grad = ctx.createLinearGradient(x - streakLen, 0, x, 0);
            grad.addColorStop(0, 'transparent');
            grad.addColorStop(1, color);
            ctx.fillStyle = grad;
            ctx.fillRect(x - streakLen, 27, streakLen, 6);
            // Dot head
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(x, 30, 4, 0, Math.PI * 2);
            ctx.fill();
        }

        // Prune old events
        while (this._vizHistory.length > 0 && now - this._vizHistory[0].time > windowMs) {
            this._vizHistory.shift();
        }
        ctx.globalAlpha = 1;
    }

    _vizDrawPetriOverlay(ctx, w, h) {
        // Draw arcs of the active net (dimmed, as context)
        const net = this._getActiveNet();
        if (!net) return;

        ctx.save();
        ctx.translate(this._view.tx, this._view.ty);
        ctx.scale(this._view.scale, this._view.scale);

        ctx.globalAlpha = 0.3;
        ctx.strokeStyle = '#4a90d9';
        ctx.lineWidth = 1 / this._view.scale;

        for (const arc of net.arcs) {
            const srcNode = net.places[arc.source] || net.transitions[arc.source];
            const trgNode = net.places[arc.target] || net.transitions[arc.target];
            if (!srcNode || !trgNode) continue;

            ctx.beginPath();
            ctx.moveTo(srcNode.x, srcNode.y);
            ctx.lineTo(trgNode.x, trgNode.y);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.restore();
    }

    async _playWebMidi(midi) {
        if (!this._midiAccess) {
            await this._refreshMidiOutputs();
        }

        if (!this._midiAccess || !this._midiOutputId) {
            console.warn('No MIDI output selected');
            return;
        }

        const output = this._midiAccess.outputs.get(this._midiOutputId);
        if (!output) {
            console.warn('MIDI output not found:', this._midiOutputId);
            return;
        }

        const noteOn = [0x90 | ((midi.channel || 1) - 1), midi.note, midi.velocity || 100];
        const noteOff = [0x80 | ((midi.channel || 1) - 1), midi.note, 0];

        output.send(noteOn);
        setTimeout(() => output.send(noteOff), midi.duration || 100);
    }

    /**
     * Set instrument for a channel
     */
    async setChannelInstrument(channel, instrumentType) {
        this._channelInstruments[channel] = instrumentType;
        if (this._toneStarted) {
            await toneEngine.loadInstrument(channel, instrumentType);
        }
    }

    /**
     * Apply instruments from project track data, falling back to genre mapping
     */
    _applyProjectInstruments(project) {
        const nets = project.nets || {};
        let usedTrackInstruments = false;

        // First try: use track.instrument from each net
        for (const [, net] of Object.entries(nets)) {
            if (net.track?.instrument && net.role !== 'control') {
                const ch = net.track.channel || 1;
                this._channelInstruments[ch] = net.track.instrument;
                if (this._toneStarted) toneEngine.loadInstrument(ch, net.track.instrument);
                usedTrackInstruments = true;
            }
        }

        // Fallback: genre-based mapping
        if (!usedTrackInstruments) {
            const genreName = (project.name || '').split(' ')[0].toLowerCase();
            const genreInst = GENRE_INSTRUMENTS[genreName] || {};
            for (const [ch, inst] of Object.entries(genreInst)) {
                this._channelInstruments[parseInt(ch)] = inst;
                if (this._toneStarted) toneEngine.loadInstrument(parseInt(ch), inst);
            }
        }
    }

    /**
     * Apply a buffered project-sync (called immediately or at bar boundary)
     */
    _applyProjectSync(project, seamless = false) {
        this._project = project;
        this._vizHistory = [];
        // Save to track history (unless navigating back)
        if (!this._navingHistory) {
            if (this._trackIndex < this._trackHistory.length - 1) {
                this._trackHistory.length = this._trackIndex + 1;
            }
            this._trackHistory.push(JSON.parse(JSON.stringify(project)));
            this._trackIndex = this._trackHistory.length - 1;
        }
        this._navingHistory = false;
        this._tempo = project.tempo || 120;
        this._swing = project.swing || 0;
        this._humanize = project.humanize || 0;
        this._structure = project.structure || null;
        this._tick = 0; this._lastPlayheadPct = 0;
        // Reset loop markers to full range and clear server loop
        this._loopStart = 0;
        this._loopEnd = 0; // will be set to totalSteps in _renderTimeline
        this._sendWs({ type: 'loop', startTick: -1, endTick: -1 });
        const netIds = Object.keys(project.nets || {});
        this._activeNetId = netIds.find(id => project.nets[id].role !== 'control') || netIds[0] || null;
        this._applyProjectInstruments(project);
        const prevGenre = this.querySelector('.pn-genre-select')?.value;
        const prevStructure = this.querySelector('.pn-structure-select')?.value;
        this._saveFxState();
        this._buildUI();
        this._setupEventListeners();
        this._restoreFxState();
        this._renderNet();
        this._updateWsStatus();
        const genreSelect = this.querySelector('.pn-genre-select');
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
        const structSelect = this.querySelector('.pn-structure-select');
        if (structSelect && prevStructure) {
            structSelect.value = prevStructure;
        }
        if (seamless) {
            // Server already has the project loaded and is playing —
            // just ensure frontend state is correct
            this._playing = true;
            this._vizStartLoop();
        } else {
            // Cold load — send project to server and start playback
            this._sendWs({ type: 'project-load', project: this._project });
            this._playing = true;
            this._vizStartLoop();
            this._sendWs({ type: 'transport', action: 'play' });
        }
        const playBtn = this.querySelector('.pn-play');
        if (playBtn) playBtn.textContent = '⏹';
        this._setupMediaSession();
        this._updateMediaSessionState();
    }

    /**
     * Handle instruments-changed message from server (after shuffle)
     */
    _onInstrumentsChanged(instruments) {
        if (!instruments || !this._project) return;

        for (const [netId, instrumentName] of Object.entries(instruments)) {
            const net = this._project.nets[netId];
            if (!net) continue;
            // Update project data
            if (!net.track) net.track = {};
            net.track.instrument = instrumentName;
            // Update audio engine
            const ch = net.track.channel || 1;
            this._channelInstruments[ch] = instrumentName;
            if (this._toneStarted) toneEngine.loadInstrument(ch, instrumentName);
        }

        // Refresh mixer display
        this._renderMixer();
    }

    /**
     * Get available instrument types
     */
    getAvailableInstruments() {
        return Object.keys(INSTRUMENT_CONFIGS).sort();
    }

    _getCurrentInstruments() {
        const instruments = {};
        if (!this._project?.nets) return instruments;
        for (const [netId, net] of Object.entries(this._project.nets)) {
            if (net.track?.instrument) instruments[netId] = net.track.instrument;
        }
        return instruments;
    }

    // === Transport ===

    _cyclePlaybackMode() {
        const modes = ['single', 'repeat', 'shuffle'];
        const labels = { single: '1x', repeat: '🔁', shuffle: '🔀' };
        const titles = { single: 'Single play', repeat: 'Repeat track', shuffle: 'Shuffle — new track on end' };
        const idx = modes.indexOf(this._playbackMode);
        this._playbackMode = modes[(idx + 1) % modes.length];
        this._pendingNextTrack = null;
        this._prefetchSent = false;
        const btn = this.querySelector('.pn-playback-mode');
        btn.textContent = labels[this._playbackMode];
        btn.title = titles[this._playbackMode];
        btn.className = 'pn-playback-mode' + (this._playbackMode !== 'single' ? ' active' : '');
    }

    _togglePlay() {
        // Resume AudioContext immediately in user gesture (Chrome autoplay policy)
        toneEngine.resumeContext();

        this._playing = !this._playing;
        const btn = this.querySelector('.pn-play');
        btn.classList.toggle('playing', this._playing);
        btn.innerHTML = this._playing ? '&#9632;' : '&#9654;';

        if (this._playing) {
            this._ensureToneStarted();
            this._vizStartLoop();
            this._acquireWakeLock();
            this._setupMediaSession();
        } else {
            this._vizStopLoop();
            this._draw(); // restore static view
            this._releaseWakeLock();
        }

        this._sendWs({ type: 'transport', action: this._playing ? 'play' : 'stop' });
        this._updateMediaSessionState();
    }

    async _acquireWakeLock() {
        if (!('wakeLock' in navigator)) return;
        try {
            this._wakeLock = await navigator.wakeLock.request('screen');
            this._wakeLock.addEventListener('release', () => { this._wakeLock = null; });
        } catch (e) { /* user denied or not supported */ }
        // Re-acquire when tab becomes visible again (browser auto-releases on hide)
        if (!this._wakeLockVisHandler) {
            this._wakeLockVisHandler = () => {
                if (document.visibilityState === 'visible' && this._playing) {
                    this._acquireWakeLock();
                }
            };
            document.addEventListener('visibilitychange', this._wakeLockVisHandler);
        }
    }

    _releaseWakeLock() {
        if (this._wakeLock) { this._wakeLock.release(); this._wakeLock = null; }
    }

    _setupMediaSession() {
        if (!('mediaSession' in navigator)) return;
        // Claim media session from macOS (steals media keys from Apple Music)
        if (!this._silentAudio) {
            // Generate 2 seconds of near-silent WAV (not zero — browsers skip truly silent audio)
            const sampleRate = 8000, seconds = 2, numSamples = sampleRate * seconds;
            const buf = new ArrayBuffer(44 + numSamples * 2);
            const view = new DataView(buf);
            const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
            writeStr(0, 'RIFF'); view.setUint32(4, 36 + numSamples * 2, true);
            writeStr(8, 'WAVE'); writeStr(12, 'fmt ');
            view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
            view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
            view.setUint16(32, 2, true); view.setUint16(34, 16, true);
            writeStr(36, 'data'); view.setUint32(40, numSamples * 2, true);
            for (let i = 0; i < numSamples; i++) view.setInt16(44 + i * 2, (i % 2) ? 1 : -1, true); // ±1 out of 32767
            const blob = new Blob([buf], { type: 'audio/wav' });
            const audio = document.createElement('audio');
            audio.src = URL.createObjectURL(blob);
            audio.loop = true;
            document.body.appendChild(audio); // must be in DOM for macOS Now Playing
            this._silentAudio = audio;
        }
        // Set handlers BEFORE play so Chrome registers them with macOS
        navigator.mediaSession.metadata = new MediaMetadata({
            title: this._project?.name || 'beats-btw',
            artist: 'beats-btw',
        });
        navigator.mediaSession.setActionHandler('play', () => {
            if (!this._playing) this._togglePlay();
        });
        navigator.mediaSession.setActionHandler('pause', () => {
            if (this._playing) this._togglePlay();
        });
        navigator.mediaSession.setActionHandler('nexttrack', () => {
            const genre = this.querySelector('.pn-genre-select')?.value || 'techno';
            const structure = this.querySelector('.pn-structure-select')?.value || '';
            const params = {};
            if (structure) params.structure = structure;
            this._sendWs({ type: 'generate', genre, params });
        });
        navigator.mediaSession.setActionHandler('previoustrack', () => {
            this._navTrack(-1);
        });
        // Start silent audio AFTER handlers are registered
        if (this._playing) {
            this._silentAudio.play().catch(() => {});
        }
    }

    _updateMediaSessionState() {
        if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = this._playing ? 'playing' : 'paused';
        }
        if (this._silentAudio) {
            if (this._playing) {
                this._silentAudio.play().catch(() => {});
            } else {
                this._silentAudio.pause();
            }
        }
    }

    _setTempo(bpm) {
        this._tempo = Math.max(20, Math.min(300, bpm));
        this._project.tempo = this._tempo;
        this.querySelector('.pn-tempo input').value = this._tempo;
        this._sendWs({ type: 'tempo', bpm: this._tempo });
        this._syncProject();
    }

    // === Worker (replaces WebSocket) ===

    _connectWorker() {
        this._worker = new Worker('./sequencer-worker.js', { type: 'module' });

        this._worker.onmessage = (e) => {
            const msg = e.data;
            if (msg.type === 'ready') {
                console.log('Sequencer worker ready');
                this._updateWsStatus(true);
                // Generate a techno track on first connect, otherwise reload current project
                if (!this._hasInitialProject) {
                    this._hasInitialProject = true;
                    this._sendWs({ type: 'generate', genre: 'techno', params: {} });
                } else {
                    this._sendWs({ type: 'project-load', project: this._project });
                }
                return;
            }
            if (msg.type === 'preview-ready') {
                // Handle prefetch for shuffle mode
                this._pendingNextTrack = msg.project;
                return;
            }
            this._handleWsMessage(msg);
        };

        this._worker.onerror = (err) => {
            console.error('Worker error:', err);
        };
    }

    _updateWsStatus() {
        // No-op: status indicator removed for client-only mode
    }

    _sendWs(msg) {
        if (this._worker) {
            this._worker.postMessage(msg);
        }
    }

    _handleWsMessage(msg) {
        switch (msg.type) {
            case 'transition-fired':
                this._onRemoteTransitionFired(msg.netId, msg.transitionId, msg.midi);
                break;
            case 'state-sync': {
                const prevTick = this._tick;
                this._tick = msg.tick || 0;
                this._tickTimestamp = performance.now();
                // Detect loop wrap (tick jumped backward) — cut lingering notes
                if (this._tick < prevTick && this._playing) {
                    toneEngine.panic();
                }
                this._onStateSync(msg.state);
                // Apply pending instrument changes at bar boundary
                if (this._pendingInstruments && this._tick >= this._pendingBarTarget) {
                    toneEngine.panic();
                    this._onInstrumentsChanged(this._pendingInstruments);
                    this._pendingInstruments = null;
                }
                // Prefetch next track for shuffle mode at ~80% progress
                if (this._playbackMode === 'shuffle' && !this._prefetchSent && this._totalSteps > 0) {
                    const pct = this._tick / this._totalSteps;
                    if (pct >= 0.8) {
                        this._prefetchSent = true;
                        const genre = this.querySelector('.pn-genre-select')?.value || 'techno';
                        const structure = this.querySelector('.pn-structure-select')?.value || '';
                        const body = { genre, params: {}, instruments: this._getCurrentInstruments() };
                        if (structure) body.params.structure = structure;
                        this._sendWs({ type: 'generate-preview', genre: body.genre, params: body.params });
                    }
                }
                break;
            }
            case 'tempo-changed':
                this._tempo = msg.tempo;
                this.querySelector('.pn-tempo input').value = msg.tempo;
                break;
            case 'project-sync':
                if (this._playing) {
                    // Server swapped at bar boundary — apply seamlessly
                    toneEngine.panic();
                    this._applyProjectSync(msg.project, true);
                } else {
                    this._applyProjectSync(msg.project, false);
                }
                break;
            case 'instruments-changed':
                if (this._playing) {
                    this._pendingInstruments = msg.instruments;
                    this._pendingBarTarget = (Math.floor(this._tick / 16) + 1) * 16;
                } else {
                    this._onInstrumentsChanged(msg.instruments);
                }
                break;
            case 'control-fired':
                // Visual feedback for control events
                if (msg.netId === this._activeNetId) {
                    const el = this._nodes[msg.transitionId];
                    if (el) {
                        el.classList.add('firing');
                        setTimeout(() => el.classList.remove('firing'), 100);
                    }
                }
                // Auto-rotate view at phrase boundaries (structured tracks only)
                // Cycle through melodic nets as they activate
                if (this._structure && msg.control) {
                    const action = msg.control.action;
                    if (action === 'activate-slot' || action === 'unmute-track') {
                        const targetNet = msg.control.targetNet;
                        const target = this._project?.nets?.[targetNet];
                        const targetRole = target?.riffGroup || targetNet;
                        const melodicRoles = ['bass', 'melody', 'harmony', 'arp'];
                        if (melodicRoles.includes(targetRole) && targetNet !== this._activeNetId) {
                            this._switchNet(targetNet);
                        }
                    }
                }
                break;
            case 'mute-state':
                this._mutedNets = new Set(Object.entries(msg.mutedNets || {}).filter(([,v]) => v).map(([k]) => k));
                // Re-apply manual mutes to server (manual overrides auto)
                for (const nid of this._manualMutedNets) {
                    if (!this._mutedNets.has(nid)) {
                        this._sendWs({ type: 'mute', netId: nid, muted: true });
                    }
                }
                this._renderMixer();
                break;
            case 'playback-complete':
                // Sequencer has stopped — mark as not playing so project-sync
                // goes through the cold-load path (sends project-load + play)
                this._playing = false;
                if (this._playbackMode === 'repeat') {
                    // Replay the same track from the beginning
                    this._tick = 0; this._lastPlayheadPct = 0;
                    this._vizHistory = [];
                    this._updatePlayhead();
                    this._sendWs({ type: 'transport', action: 'play' });
                    this._playing = true;
                    this._vizStartLoop();
                } else if (this._playbackMode === 'shuffle') {
                    this._prefetchSent = false;
                    if (this._pendingNextTrack) {
                        // Use pre-fetched track — load and play
                        const proj = this._pendingNextTrack;
                        this._pendingNextTrack = null;
                        toneEngine.panic();
                        this._applyProjectSync(proj, false);
                    } else {
                        // Fallback: generate on demand with current instruments
                        this._tick = 0; this._lastPlayheadPct = 0;
                        this._updatePlayhead();
                        const genre = this.querySelector('.pn-genre-select').value;
                        const structure = this.querySelector('.pn-structure-select').value;
                        const params = { ...(this._traitOverrides || {}), instruments: this._getCurrentInstruments() };
                        if (structure) params.structure = structure;
                        this._sendWs({ type: 'generate', genre, params });
                    }
                } else {
                    // Single: stop
                    this._playing = false;
                    this._tick = 0; this._lastPlayheadPct = 0;
                    this._vizStopLoop();
                    this._draw();
                    this._updatePlayhead();
                    const playBtn2 = this.querySelector('.pn-play');
                    if (playBtn2) {
                        playBtn2.classList.remove('playing');
                        playBtn2.innerHTML = '&#9654;';
                    }
                }
                break;
            case 'loop-changed':
                this._loopStart = msg.startTick < 0 ? 0 : msg.startTick;
                this._loopEnd = msg.endTick < 0 ? (this._totalSteps || 0) : msg.endTick;
                this._updateLoopMarkers();
                break;
        }
    }

    _onRemoteTransitionFired(netId, transitionId, midi) {
        // Visual feedback — match by exact ID or riff group
        const activeNet = this._project?.nets?.[this._activeNetId];
        const firedNet = this._project?.nets?.[netId];
        const sameGroup = activeNet?.riffGroup && activeNet.riffGroup === firedNet?.riffGroup;
        if (netId === this._activeNetId || sameGroup) {
            const el = this._nodes[transitionId];
            if (el) {
                el.classList.add('firing');
                setTimeout(() => el.classList.remove('firing'), 100);
            }
        }


        // Visualization particles
        if (midi) {
            this._vizSpawnParticle(netId, midi);
        }

        // Play sound locally if not in backend mode
        if (this._audioMode !== 'backend' && midi) {
            // Apply client-side humanization
            const humanizedMidi = this._humanizeNote(midi);
            const delay = this._swingDelay();

            if (delay > 0) {
                setTimeout(() => this._playNote(humanizedMidi, netId), delay);
            } else {
                this._playNote(humanizedMidi, netId);
            }
        }
    }

    /**
     * Apply humanize: timing jitter (via caller) and velocity jitter.
     * Returns a new midi object with jittered velocity.
     */
    _humanizeNote(midi) {
        if (this._humanize <= 0) return midi;

        const amount = this._humanize / 100; // 0-1
        // Velocity jitter: ±(amount * 15) from original
        const velJitter = (Math.random() * 2 - 1) * amount * 15;
        const newVel = Math.max(1, Math.min(127, Math.round((midi.velocity || 100) + velJitter)));

        return { ...midi, velocity: newVel };
    }

    /**
     * Calculate swing delay for current tick.
     * Swing offsets even 8th-note positions by swing/100 * tickDuration * 0.5.
     * Returns delay in ms (0 for on-beat ticks).
     */
    _swingDelay() {
        if (this._swing <= 0) return 0;

        // PPQ=4: ticks 0,1,2,3 per beat. Even 8th notes = every 2 ticks.
        // Odd 8th-note positions (tick % 2 === 1) get swing offset.
        const tickInBeat = this._tick % 4;
        if (tickInBeat === 1 || tickInBeat === 3) {
            // Duration of one tick in ms
            const tickMs = (60000 / this._tempo) / 4;
            // Swing: push the off-beat tick later
            const swingAmount = (this._swing / 100) * tickMs * 0.5;
            // Add humanize timing jitter on top
            const humanizeJitter = this._humanize > 0
                ? (Math.random() * 2 - 1) * (this._humanize / 100) * 30
                : 0;
            return Math.max(0, swingAmount + humanizeJitter);
        }

        // On-beat ticks: only humanize jitter
        if (this._humanize > 0) {
            return Math.max(0, (Math.random() * 2 - 1) * (this._humanize / 100) * 15);
        }
        return 0;
    }

    _onStateSync(state) {
        // Update token counts from server
        for (const [netId, netState] of Object.entries(state)) {
            const net = this._project.nets[netId];
            if (!net) continue;
            for (const [placeId, tokens] of Object.entries(netState)) {
                if (net.places[placeId]) {
                    net.places[placeId].tokens = [tokens];
                }
            }
        }
        if (this._activeNetId in state) {
            this._renderNet();
        }
        this._updatePlayhead();
    }

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
