/**
 * petri-note.js - Custom HTMLElement for Petri net music sequencer
 *
 * A music sequencer where Petri net transitions trigger MIDI notes.
 */

import { toneEngine, INSTRUMENT_CONFIGS, isDrumChannel } from './audio/tone-engine.js';

// Mixer math: maps 0–100 slider values to audio-engine frequencies/Q
function hpFreq(val) { return 20 * Math.pow(250, val / 100); }
function lpFreq(val) { return 100 * Math.pow(200, val / 100); }
function qCurve(val) { return 0.5 + (Math.pow(val / 100, 2) * 49.5); }

// Slider config: [css class, state key, apply function factory(ch, drumRole) => fn(val)]
const MIXER_SLIDERS = [
    ['pn-mixer-vol',    'vol',   (ch) => v => toneEngine.controlChange(ch, 7, Math.round(v * 127 / 100))],
    ['pn-mixer-pan',    'pan',   (ch) => v => toneEngine.controlChange(ch, 10, v)],
    ['pn-mixer-locut',  'locut', (ch, role) => v => {
        if (role && toneEngine.hasDrumVoiceFilters(ch)) toneEngine.setDrumVoiceLoCut(ch, role, hpFreq(v));
        else toneEngine.setChannelLoCut(ch, hpFreq(v));
    }],
    ['pn-mixer-loreso', 'lores', (ch, role) => v => {
        if (role && toneEngine.hasDrumVoiceFilters(ch)) toneEngine.setDrumVoiceLoResonance(ch, role, qCurve(v));
        else toneEngine.setChannelLoResonance(ch, qCurve(v));
    }],
    ['pn-mixer-cutoff', 'cut',   (ch, role) => v => {
        if (role && toneEngine.hasDrumVoiceFilters(ch)) toneEngine.setDrumVoiceCutoff(ch, role, lpFreq(v));
        else toneEngine.setChannelCutoff(ch, lpFreq(v));
    }],
    ['pn-mixer-reso',   'res',   (ch, role) => v => {
        if (role && toneEngine.hasDrumVoiceFilters(ch)) toneEngine.setDrumVoiceResonance(ch, role, qCurve(v));
        else toneEngine.setChannelResonance(ch, qCurve(v));
    }],
    ['pn-mixer-decay',  'dec',   (ch) => v => toneEngine.setChannelDecay(ch, v / 100)],
];

// --- Live-performance macros ---
//
// Each macro computes a set of target netIds to affect, picks how long the
// affected state should last (in ticks), and sends a single `fire-macro`
// message to the worker. The worker applies the immediate side effect
// (e.g. mute) synchronously, then injects a small linear-chain control net
// that fires the restore action on its final transition — tick-locked.
//
// Target selection uses the current mutedNets snapshot to skip anything the
// user has already muted, so the restore never unmutes a user-intended mute.

function collectMacroTargets(host, predicate) {
    const out = [];
    for (const [id, net] of host._musicNets()) {
        if (host._mutedNets.has(id)) continue;
        if (!predicate(id, net)) continue;
        out.push(id);
    }
    return out;
}

const MACRO_TARGETS = {
    nonDrums:  (host) => collectMacroTargets(host, (_id, net) => !isDrumChannel(net.track?.channel)),
    drumsOnly: (host) => collectMacroTargets(host, (_id, net) => isDrumChannel(net.track?.channel)),
    everything:(host) => collectMacroTargets(host, () => true),
};

// Kind 'mute' uses worker-side control nets (tick-locked restore).
// Kind 'fx-sweep' linearly ramps a master FX slider to `toValue` over most of
// the duration, then ramps back over the tail — for filter breakdowns.
// Kind 'fx-hold' jumps an FX slider to `toValue`, holds, and snaps back — for
// washes / throws.
const MACROS = [
    // --- Mute ---
    { id: 'drop',         group: 'Mute', kind: 'mute', label: 'Drop',        defaultDuration: 1, durationOpts: [1, 2, 4, 8], durationLabel: 'bar',  durationUnit: 'bar',  targets: MACRO_TARGETS.nonDrums  },
    { id: 'breakdown',    group: 'Mute', kind: 'mute', label: 'Breakdown',   defaultDuration: 2, durationOpts: [1, 2, 4, 8], durationLabel: 'bar',  durationUnit: 'bar',  targets: MACRO_TARGETS.drumsOnly },
    { id: 'solo-drums',   group: 'Mute', kind: 'mute', label: 'Solo Drums',  defaultDuration: 2, durationOpts: [1, 2, 4, 8], durationLabel: 'bar',  durationUnit: 'bar',  targets: MACRO_TARGETS.nonDrums  },
    { id: 'cut',          group: 'Mute', kind: 'mute', label: 'Cut',         defaultDuration: 2, durationOpts: [1, 2, 4, 8], durationLabel: 'tick', durationUnit: 'tick', targets: MACRO_TARGETS.everything },
    { id: 'beat-repeat',  group: 'Mute', kind: 'beat-repeat', label: 'Beat Repeat', defaultDuration: 1, durationOpts: [1, 2, 4], durationLabel: 'bar', durationUnit: 'bar', stepTicks: 2, burstTicks: 1 },
    { id: 'double-drop',  group: 'Mute', kind: 'compound',    label: 'Double Drop', defaultDuration: 1, durationOpts: [1, 2, 4], durationLabel: 'bar', durationUnit: 'bar',
      steps: [{ macroId: 'cut', durationTicks: 2, offsetMs: 0 }, { macroId: 'drop', offsetMs: 260 }] },
    // --- FX ---
    { id: 'sweep-lp',     group: 'FX', kind: 'fx-sweep', label: 'Sweep LP',     defaultDuration: 4, durationOpts: [1, 2, 4, 8], durationLabel: 'bar', durationUnit: 'bar',
      ops: [{ fxKey: 'lp-freq', toValue: 5 }] },
    { id: 'sweep-hp',     group: 'FX', kind: 'fx-sweep', label: 'Sweep HP',     defaultDuration: 2, durationOpts: [1, 2, 4, 8], durationLabel: 'bar', durationUnit: 'bar',
      ops: [{ fxKey: 'hp-freq', toValue: 80 }] },
    // Reverb Wash: don't duck master-vol (that also ducks the wet signal —
    // "just gets quiet"). Instead, shape the reverb itself:
    //   - wet 95, size 90 — dramatic wet-to-dry ratio
    //   - damp → 15  (low damp = bright sparkly tail instead of muffled blanket)
    //   - HP → 30    (rolls off low mud so the wash doesn't clash with bass)
    // tailFrac 0.55 balances a sustained peak with a smooth fade.
    { id: 'reverb-wash',  group: 'FX', kind: 'fx-hold',  label: 'Reverb Wash',  defaultDuration: 2, durationOpts: [1, 2, 4, 8], durationLabel: 'bar', durationUnit: 'bar',
      tailFrac: 0.55,
      ops: [
          { fxKey: 'reverb-wet',  toValue: 95 },
          { fxKey: 'reverb-size', toValue: 90 },
          { fxKey: 'reverb-damp', toValue: 15 },
          { fxKey: 'hp-freq',     toValue: 30 },
      ] },
    { id: 'delay-throw',  group: 'FX', kind: 'fx-hold',  label: 'Delay Throw',  defaultDuration: 1, durationOpts: [1, 2, 4, 8], durationLabel: 'bar', durationUnit: 'bar',
      tailFrac: 0.35,
      ops: [{ fxKey: 'delay-wet', toValue: 100 }, { fxKey: 'delay-feedback', toValue: 72 }, { fxKey: 'delay-time', toValue: 38 }] },
    { id: 'riser',        group: 'FX', kind: 'fx-sweep', label: 'Riser',        defaultDuration: 4, durationOpts: [2, 4, 8],    durationLabel: 'bar', durationUnit: 'bar',
      ops: [{ fxKey: 'hp-freq', toValue: 70 }, { fxKey: 'reverb-wet', toValue: 80 }, { fxKey: 'phaser-wet', toValue: 60 }] },
    { id: 'build-crush',  group: 'FX', kind: 'fx-sweep', label: 'Bit Crush',    defaultDuration: 2, durationOpts: [1, 2, 4, 8], durationLabel: 'bar', durationUnit: 'bar',
      ops: [{ fxKey: 'crush-bits', toValue: 80 }, { fxKey: 'distortion', toValue: 20 }] },
    { id: 'phaser-drone', group: 'FX', kind: 'fx-hold',  label: 'Phaser Drone', defaultDuration: 2, durationOpts: [1, 2, 4, 8], durationLabel: 'bar', durationUnit: 'bar',
      ops: [{ fxKey: 'phaser-wet', toValue: 90 }, { fxKey: 'phaser-depth', toValue: 100 }, { fxKey: 'phaser-freq', toValue: 40 }] },
    { id: 'cathedral',    group: 'FX', kind: 'fx-hold',  label: 'Cathedral',    defaultDuration: 4, durationOpts: [2, 4, 8], durationLabel: 'bar', durationUnit: 'bar',
      tailFrac: 0.5, ops: [{ fxKey: 'reverb-size', toValue: 95 }, { fxKey: 'reverb-damp', toValue: 8 }, { fxKey: 'reverb-wet', toValue: 60 }] },
    { id: 'dub-delay',    group: 'FX', kind: 'fx-hold',  label: 'Dub Delay',    defaultDuration: 2, durationOpts: [1, 2, 4], durationLabel: 'bar', durationUnit: 'bar',
      tailFrac: 0.4, ops: [{ fxKey: 'delay-time', toValue: 50 }, { fxKey: 'delay-feedback', toValue: 80 }, { fxKey: 'delay-wet', toValue: 70 }] },
    { id: 'filter-res',   group: 'FX', kind: 'fx-sweep', label: 'Res Ping',     defaultDuration: 2, durationOpts: [1, 2], durationLabel: 'bar', durationUnit: 'bar',
      ops: [{ fxKey: 'lp-freq', toValue: 40 }, { fxKey: 'distortion', toValue: 30 }] },

    // --- Pan --- (per-channel, non-drum targets)
    { id: 'ping-pong',  group: 'Pan', kind: 'pan-move', label: 'Ping-Pong',  defaultDuration: 2, durationOpts: [1, 2, 4, 8], durationLabel: 'bar', durationUnit: 'bar', pattern: 'pingpong', stepBeats: 1,  targets: MACRO_TARGETS.nonDrums },
    { id: 'hard-left',  group: 'Pan', kind: 'pan-move', label: 'Hard Left',  defaultDuration: 1, durationOpts: [1, 2, 4, 8], durationLabel: 'bar', durationUnit: 'bar', pattern: 'hold',     toValue: -1,   targets: MACRO_TARGETS.nonDrums },
    { id: 'hard-right', group: 'Pan', kind: 'pan-move', label: 'Hard Right', defaultDuration: 1, durationOpts: [1, 2, 4, 8], durationLabel: 'bar', durationUnit: 'bar', pattern: 'hold',     toValue:  1,   targets: MACRO_TARGETS.nonDrums },
    { id: 'auto-pan',   group: 'Pan', kind: 'pan-move', label: 'Auto-Pan',   defaultDuration: 4, durationOpts: [2, 4, 8],    durationLabel: 'bar', durationUnit: 'bar', pattern: 'sweep',    rateBeats: 4,  targets: MACRO_TARGETS.nonDrums },
    { id: 'mono',       group: 'Pan', kind: 'pan-move', label: 'Mono',       defaultDuration: 2, durationOpts: [1, 2, 4, 8], durationLabel: 'bar', durationUnit: 'bar', pattern: 'hold',     toValue:  0,   targets: MACRO_TARGETS.nonDrums },

    // --- Shape ---
    { id: 'tighten',    group: 'Shape', kind: 'decay-move', label: 'Tighten', defaultDuration: 2, durationOpts: [1, 2, 4, 8], durationLabel: 'bar', durationUnit: 'bar', pattern: 'hold',  toValue: 0.3, targets: MACRO_TARGETS.everything },
    { id: 'loosen',     group: 'Shape', kind: 'decay-move', label: 'Loosen',  defaultDuration: 2, durationOpts: [1, 2, 4, 8], durationLabel: 'bar', durationUnit: 'bar', pattern: 'hold',  toValue: 2.5, targets: MACRO_TARGETS.everything },
    { id: 'pulse',      group: 'Shape', kind: 'decay-move', label: 'Pulse',   defaultDuration: 2, durationOpts: [1, 2, 4, 8], durationLabel: 'bar', durationUnit: 'bar', pattern: 'sweep', rateBeats: 2, targets: MACRO_TARGETS.everything },
    // --- Pitch ---
    { id: 'octave-up',    group: 'Pitch', kind: 'fx-hold',  label: 'Octave Up',   defaultDuration: 1, durationOpts: [1, 2, 4], durationLabel: 'bar', durationUnit: 'bar',
      tailFrac: 0.3, ops: [{ fxKey: 'master-pitch', toValue: 12 }] },
    { id: 'octave-down',  group: 'Pitch', kind: 'fx-hold',  label: 'Octave Down', defaultDuration: 1, durationOpts: [1, 2, 4], durationLabel: 'bar', durationUnit: 'bar',
      tailFrac: 0.3, ops: [{ fxKey: 'master-pitch', toValue: -12 }] },
    { id: 'pitch-bend',   group: 'Pitch', kind: 'fx-sweep', label: 'Pitch Bend',  defaultDuration: 2, durationOpts: [1, 2, 4], durationLabel: 'bar', durationUnit: 'bar',
      ops: [{ fxKey: 'master-pitch', toValue: 7 }] },
    { id: 'vinyl-brake',  group: 'Pitch', kind: 'compound', label: 'Vinyl Brake', defaultDuration: 1, durationOpts: [1, 2], durationLabel: 'bar', durationUnit: 'bar',
      steps: [
          { macroId: 'tape-stop', offsetMs: 0 },
          { macroId: 'octave-down', offsetMs: 60 },
      ] },

    // --- Tempo ---
    { id: 'half-time',    group: 'Tempo', kind: 'tempo-hold',  label: 'Half Time',  defaultDuration: 2, durationOpts: [1, 2, 4, 8], durationLabel: 'bar', durationUnit: 'bar', factor: 0.5 },
    { id: 'tape-stop',    group: 'Tempo', kind: 'tempo-sweep', label: 'Tape Stop',  defaultDuration: 1, durationOpts: [1, 2],       durationLabel: 'bar', durationUnit: 'bar', finalBpm: 22 },

    // --- One-shots ---
    // durationOpts = stutter repeat count. pitchOpts = per-hit transpose in
    // semitones; applied via oscillator detune so frequency sweeps stay
    // relative. Each tile also carries dropdowns for instrument swap, HP/LP
    // filter freq + Q, attack, decay — all dropdown-only (no sliders).
    // Stinger macros — ids match the reserved `hitN` track names in the
    // project schema. The `sound` field is a default instrument used only
    // when no matching track exists (fallback rendering); normally the Fire
    // pad routes through the track's current instrument.
    { id: 'hit1', group: 'One-Shot', kind: 'one-shot', label: 'Hit 1', defaultDuration: 1, durationOpts: [1, 2, 3, 4, 5], durationLabel: 'hit', durationUnit: 'bar', sound: 'airhorn', pitchOpts: [-12, -7, -5, -3, 0, 3, 5, 7, 12], defaultPitch: 0 },
    { id: 'hit2', group: 'One-Shot', kind: 'one-shot', label: 'Hit 2', defaultDuration: 1, durationOpts: [1, 2, 3, 4, 5], durationLabel: 'hit', durationUnit: 'bar', sound: 'laser',   pitchOpts: [-12, -7, -5, -3, 0, 3, 5, 7, 12], defaultPitch: 0 },
    { id: 'hit3', group: 'One-Shot', kind: 'one-shot', label: 'Hit 3', defaultDuration: 1, durationOpts: [1, 2, 3, 4, 5], durationLabel: 'hit', durationUnit: 'bar', sound: 'subdrop', pitchOpts: [-12, -7, -5, -3, 0, 3, 5, 7, 12], defaultPitch: 0 },
    { id: 'hit4', group: 'One-Shot', kind: 'one-shot', label: 'Hit 4', defaultDuration: 1, durationOpts: [1, 2, 3, 4, 5], durationLabel: 'hit', durationUnit: 'bar', sound: 'booj',    pitchOpts: [-12, -7, -5, -3, 0, 3, 5, 7, 12], defaultPitch: 0 },
];

// One-shot tone-shaping dropdown tables. Values are raw engine params so they
// can be forwarded to `playOneShot` without remapping.
// kind='custom': routed to toneEngine.playOneShot (hardcoded airhorn/laser/…)
// kind='note'  : routed to toneEngine.playOneShotInstrument which spins up a
//                throwaway synth instance, runs it through the one-shot chain,
//                and disposes after the tail. `note` is the default MIDI pitch
//                the Pitch dropdown transposes from.
const ONESHOT_INSTRUMENTS = [
    // --- Stingers / FX ---
    { id: 'airhorn', label: 'Airhorn',   kind: 'custom', group: 'Stingers' },
    { id: 'laser',   label: 'Laser',     kind: 'custom', group: 'Stingers' },
    { id: 'subdrop', label: 'Subdrop',   kind: 'custom', group: 'Stingers' },
    { id: 'booj',    label: 'Booj',      kind: 'custom', group: 'Stingers' },
    // --- Drum kits (note = kick voice; pitch shifts to 38=snare, 42=hat, etc.) ---
    { id: 'drums',           label: 'Kit Std',      kind: 'note', note: 36, group: 'Drums' },
    { id: 'drums-808',       label: 'Kit 808',      kind: 'note', note: 36, group: 'Drums' },
    { id: 'drums-cr78',      label: 'Kit CR-78',    kind: 'note', note: 36, group: 'Drums' },
    { id: 'drums-v8',        label: 'Kit V8',       kind: 'note', note: 36, group: 'Drums' },
    { id: 'drums-breakbeat', label: 'Kit Break',    kind: 'note', note: 36, group: 'Drums' },
    { id: 'drums-lofi',      label: 'Kit Lo-Fi',    kind: 'note', note: 36, group: 'Drums' },
    // --- Pitched percussion / bells ---
    { id: 'fm-bell',    label: 'FM Bell',     kind: 'note', note: 72, group: 'Percussion' },
    { id: 'am-bell',    label: 'AM Bell',     kind: 'note', note: 72, group: 'Percussion' },
    { id: 'marimba',    label: 'Marimba',     kind: 'note', note: 60, group: 'Percussion' },
    { id: 'vibes',      label: 'Vibes',       kind: 'note', note: 60, group: 'Percussion' },
    { id: 'kalimba',    label: 'Kalimba',     kind: 'note', note: 67, group: 'Percussion' },
    { id: 'steel-drum', label: 'Steel Drum',  kind: 'note', note: 60, group: 'Percussion' },
    { id: 'music-box',  label: 'Music Box',   kind: 'note', note: 72, group: 'Percussion' },
    { id: 'metallic',   label: 'Metallic',    kind: 'note', note: 60, group: 'Percussion' },
    { id: 'noise-hit',  label: 'Noise Hit',   kind: 'note', note: 60, group: 'Percussion' },
    // --- Stabs / Plucks ---
    { id: 'rave-stab',   label: 'Rave Stab',   kind: 'note', note: 60, group: 'Stabs' },
    { id: 'edm-stab',    label: 'EDM Stab',    kind: 'note', note: 60, group: 'Stabs' },
    { id: 'hoover',      label: 'Hoover',      kind: 'note', note: 48, group: 'Stabs' },
    { id: 'pluck',       label: 'Pluck',       kind: 'note', note: 60, group: 'Stabs' },
    { id: 'bright-pluck',label: 'Bright Pluck',kind: 'note', note: 60, group: 'Stabs' },
    { id: 'muted-pluck', label: 'Muted Pluck', kind: 'note', note: 60, group: 'Stabs' },
    { id: 'edm-pluck',   label: 'EDM Pluck',   kind: 'note', note: 60, group: 'Stabs' },
    { id: 'chiptune',    label: 'Chiptune',    kind: 'note', note: 60, group: 'Stabs' },
    // --- Bass hits ---
    { id: '808-bass',  label: '808 Hit',   kind: 'note', note: 36, group: 'Bass' },
    { id: 'sub-bass',  label: 'Sub Hit',   kind: 'note', note: 36, group: 'Bass' },
    { id: 'drop-bass', label: 'Drop Bass', kind: 'note', note: 36, group: 'Bass' },
    { id: 'fm-bass',   label: 'FM Bass',   kind: 'note', note: 36, group: 'Bass' },
];

function oneShotSpec(id) {
    return ONESHOT_INSTRUMENTS.find(o => o.id === id) || null;
}

// Prettify an instrument id for display when it isn't in ONESHOT_INSTRUMENTS.
// "drums-v8" → "Drums V8", "fm-bass" → "Fm Bass".
function prettifyInstrumentName(id) {
    if (!id) return '';
    return id.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}
const ONESHOT_HP  = [[0, 'HP Off'], [80, 'HP 80'], [200, 'HP 200'], [500, 'HP 500'], [1500, 'HP 1.5k']];
const ONESHOT_LP  = [[20000, 'LP Open'], [8000, 'LP 8k'], [3000, 'LP 3k'], [1000, 'LP 1k'], [400, 'LP 400']];
const ONESHOT_Q   = [[0.5, 'Q1'], [2, 'Q2'], [5, 'Q3'], [12, 'Q4'], [25, 'Q5']];
const ONESHOT_ATK = [[0, 'A 0'], [30, 'A 30'], [80, 'A 80'], [200, 'A 200'], [500, 'A 500']];
const ONESHOT_DEC = [[0, 'D Off'], [200, 'D 200'], [500, 'D 500'], [1200, 'D 1.2s'], [3000, 'D 3s']];

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
        if (!localStorage.getItem('pn-quickstart-seen')) {
            this._showQuickstartModal();
        }
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

    _buildUI() {
        this.innerHTML = '';
        this.classList.toggle('pn-midi-enabled', this._audioModes.has('web-midi'));

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
                <button class="${this._audioModes.has('web-midi') ? 'active' : ''}" data-mode="web-midi">MIDI</button>
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
        if (this._showFx === undefined) this._showFx = true;
        if (this._showOneShots === undefined) this._showOneShots = false;
        const fx = document.createElement('div');
        fx.className = 'pn-effects';
        fx.innerHTML = `
            <div class="pn-effects-toggle">
                <button class="pn-effects-btn ${this._showFx ? 'active' : ''}">FX</button>
                <button class="pn-macros-btn ${this._showMacros ? 'active' : ''}" title="Live performance macros">Macros</button>
                <button class="pn-oneshots-btn ${this._showOneShots ? 'active' : ''}" title="Beat fire pads">Beats</button>
                <button class="pn-autodj-btn ${this._showAutoDj ? 'active' : ''}" title="Auto-DJ: fires random macros on a cadence">Auto-DJ</button>
                <button class="pn-fx-bypass" title="Bypass all effects">Bypass</button>
                <button class="pn-fx-reset" title="Reset all effects to defaults">Reset</button>
                <button class="pn-cc-reset" title="Clear all MIDI CC bindings">CC Reset</button>
                <button class="pn-crop-bar-btn" title="Crop track to loop region" style="display:none">✂ Crop</button>
                <select class="pn-loop-mode-select" title="Loop conflict resolution mode">
                    <option value="drift">Drift</option>
                    <option value="deterministic">Deterministic</option>
                </select>
            </div>
            <div class="pn-oneshots-panel" style="display:${this._showOneShots ? 'flex' : 'none'}">
                ${(() => {
                    const opt = (v, label, def) => `<option value="${v}"${v===def?' selected':''}>${label}</option>`;
                    const oneShots = MACROS.filter(m => m.kind === 'one-shot');
                    const osCat = new Map();
                    for (const inst of ONESHOT_INSTRUMENTS) {
                        const g = inst.group || 'Other';
                        if (!osCat.has(g)) osCat.set(g, []);
                        osCat.get(g).push(inst);
                    }
                    const osInstOpts = [...osCat.entries()].map(([g, items]) =>
                        `<optgroup label="${g}">${items.map(s => opt(s.id, s.label, '')).join('')}</optgroup>`
                    ).join('');
                    // Stingers are real tracks now (see composer.addStingerTracks);
                    // the tab's rows are just manual Fire pads. Filter, vol, pan, and
                    // preset controls live on the track's mixer row above.
                    // Paired-macro dropdown: clicking Fire plays the sound AND
                    // triggers the chosen macro simultaneously (duration comes
                    // from the macro's defaultDuration). Auto-fires from the
                    // stinger Petri track are sound-only — macros would be too
                    // noisy if they ran every beat.
                    const pairableMacros = MACROS.filter(m => m.kind !== 'one-shot');
                    const pairByGroup = new Map();
                    for (const m of pairableMacros) {
                        const g = m.group || 'Other';
                        if (!pairByGroup.has(g)) pairByGroup.set(g, []);
                        pairByGroup.get(g).push(m);
                    }
                    const pairOpts = `<option value="">No FX</option>` +
                        [...pairByGroup.entries()].map(([g, items]) =>
                            `<optgroup label="${g}">${items.map(x => `<option value="${x.id}">${x.label}</option>`).join('')}</optgroup>`
                        ).join('');
                    const oneShotRows = oneShots.map(m => {
                        const pitchHtml = `<select class="pn-mixer-slider pn-os-pitch" data-macro="${m.id}" title="Pitch (semitones)">
                            ${m.pitchOpts.map(v => opt(v, v > 0 ? '+'+v : ''+v, m.defaultPitch ?? 0)).join('')}
                        </select>`;
                        const fxHtml = `<select class="pn-os-pair" data-macro="${m.id}" title="Fire this macro together with the stinger">${pairOpts}</select>`;
                        // Label reflects the current track.instrument (may differ from
                        // the macro's default sound after the user rotates / picks a
                        // new instrument on the mixer row). 'unbound' falls back to
                        // the slot's own id ("Hit1" / "Hit2" / …) so the button stays
                        // meaningful when no sound is loaded.
                        const currentInst = this._project?.nets?.[m.id]?.track?.instrument || m.sound;
                        const defaultLabel = currentInst === 'unbound'
                            ? prettifyInstrumentName(m.id)
                            : (oneShotSpec(currentInst)?.label || prettifyInstrumentName(currentInst));
                        return `<div class="pn-os-pad">
                            <button class="pn-macro-btn pn-os-fire" data-macro="${m.id}" title="Fire">Fire ${defaultLabel}</button>
                            <div class="pn-mixer-slider-group"><span>Pit</span>${pitchHtml}</div>
                            <div class="pn-mixer-slider-group"><span>FX</span>${fxHtml}</div>
                        </div>`;
                    }).join('');

                    return `<div class="pn-os-rows">${oneShotRows}</div>`;
                })()}
            </div>
            <div class="pn-autodj-panel" style="display:${this._showAutoDj ? 'flex' : 'none'}">
                <label class="pn-autodj-toggle">
                    <input type="checkbox" class="pn-autodj-enable">
                    <span>Run</span>
                </label>
                <label class="pn-autodj-toggle" title="Spin the ring on cadence without firing any macros">
                    <input type="checkbox" class="pn-autodj-animate-only">
                    <span>Animate only</span>
                </label>
                <label class="pn-autodj-field">
                    <span>Every</span>
                    <select class="pn-autodj-rate">
                        ${[1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024].map(v =>
                            `<option value="${v}"${v === 2 ? ' selected' : ''}>${v} bars · ${v * 4} beats</option>`
                        ).join('')}
                    </select>
                </label>
                <fieldset class="pn-autodj-pools">
                    <legend>Pools</legend>
                    <label><input type="checkbox" class="pn-autodj-pool" value="Mute"  checked>Mute</label>
                    <label><input type="checkbox" class="pn-autodj-pool" value="FX"    checked>FX</label>
                    <label><input type="checkbox" class="pn-autodj-pool" value="Pan"   checked>Pan</label>
                    <label><input type="checkbox" class="pn-autodj-pool" value="Shape" checked>Shape</label>
                    <label><input type="checkbox" class="pn-autodj-pool" value="Pitch">Pitch</label>
                    <label><input type="checkbox" class="pn-autodj-pool" value="Tempo">Tempo</label>
                    <label><input type="checkbox" class="pn-autodj-pool" value="Beats">Beats</label>
                </fieldset>
                <label class="pn-autodj-field">
                    <span>Stack</span>
                    <select class="pn-autodj-stack">
                        <option value="1" selected>1</option>
                        <option value="2">2</option>
                        <option value="3">3</option>
                    </select>
                </label>
                <label class="pn-autodj-field">
                    <span>Regen</span>
                    <select class="pn-autodj-regen" title="Regenerate the whole track every N bars (off = never)">
                        <option value="0" selected>Off</option>
                        ${[8, 16, 32, 64, 128, 256, 512, 1024].map(v =>
                            `<option value="${v}">${v} bars · ${v * 4} beats</option>`
                        ).join('')}
                    </select>
                </label>
                <span class="pn-autodj-status">idle</span>
            </div>
            <div class="pn-macros-panel" style="display:${this._showMacros ? 'flex' : 'none'}">
                ${(() => {
                    const others = MACROS.filter(m => m.kind !== 'one-shot');
                    const byGroup = new Map();
                    for (const m of others) {
                        const g = m.group || 'Other';
                        if (!byGroup.has(g)) byGroup.set(g, []);
                        byGroup.get(g).push(m);
                    }
                    return [...byGroup.entries()].map(([label, items]) => `
                        <div class="pn-macro-group">
                            <div class="pn-macro-group-label">${label}</div>
                            ${items.map(m => {
                                const needsDuration = m.durationOpts.length > 1 || (m.durationLabel && m.durationLabel.length > 0);
                                const selectHtml = needsDuration
                                    ? `<select class="pn-macro-bars" data-macro="${m.id}" title="Duration">
                                           ${m.durationOpts.map(v => `<option value="${v}"${v===m.defaultDuration?' selected':''}>${v} ${m.durationLabel}${v===1?'':'s'}</option>`).join('')}
                                       </select>`
                                    : '';
                                const pitchHtml = m.pitchOpts
                                    ? `<select class="pn-macro-pitch" data-macro="${m.id}" title="Pitch (semitones)">
                                           ${m.pitchOpts.map(v => `<option value="${v}"${v===(m.defaultPitch ?? 0)?' selected':''}>${v > 0 ? '+'+v : v} st</option>`).join('')}
                                       </select>`
                                    : '';
                                return `<div class="pn-macro-item">
                                            <button class="pn-macro-btn" data-macro="${m.id}" title="${m.label}">${m.label}</button>
                                            ${selectHtml}
                                            ${pitchHtml}
                                        </div>`;
                            }).join('')}
                        </div>
                    `).join('');
                })()}
            </div>
            <div class="pn-effects-panel" style="display:${this._showFx ? 'flex' : 'none'}">
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
                    <span class="pn-fx-label">Pitch</span>
                    <div class="pn-fx-control">
                        <span>Semi</span>
                        <input type="range" class="pn-fx-slider" data-fx="master-pitch" data-default="0" min="-12" max="12" step="1" value="0">
                        <span class="pn-fx-value" data-fx-val="master-pitch">0</span>
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

        // FX, One-Shots and Macros each toggle independently. Stacking order
        // is controlled via CSS `order` on the .pn-effects flex container.
        const macrosBtn   = fx.querySelector('.pn-macros-btn');
        const fxBtn       = fx.querySelector('.pn-effects-btn');
        const oneShotsBtn = fx.querySelector('.pn-oneshots-btn');
        const fxPanel     = fx.querySelector('.pn-effects-panel');
        const mxPanel     = fx.querySelector('.pn-macros-panel');
        const osPanel     = fx.querySelector('.pn-oneshots-panel');
        macrosBtn.addEventListener('click', () => {
            this._showMacros = !this._showMacros;
            mxPanel.style.display = this._showMacros ? 'flex' : 'none';
            macrosBtn.classList.toggle('active', this._showMacros);
        });
        fxBtn.addEventListener('click', () => {
            this._showFx = !this._showFx;
            fxPanel.style.display = this._showFx ? 'flex' : 'none';
            fxBtn.classList.toggle('active', this._showFx);
        });
        oneShotsBtn.addEventListener('click', () => {
            this._showOneShots = !this._showOneShots;
            osPanel.style.display = this._showOneShots ? 'flex' : 'none';
            oneShotsBtn.classList.toggle('active', this._showOneShots);
            // hit* rows in the main mixer are gated on this flag; re-render
            // so they appear/disappear alongside the Beats panel.
            this._renderMixer();
        });
        // Auto-DJ toggle — panel visibility only; the enable checkbox inside
        // drives whether the engine actually fires macros, so users can leave
        // the panel open while the DJ is paused.
        const autoDjBtn   = fx.querySelector('.pn-autodj-btn');
        const autoDjPanel = fx.querySelector('.pn-autodj-panel');
        autoDjBtn.addEventListener('click', () => {
            this._showAutoDj = !this._showAutoDj;
            autoDjPanel.style.display = this._showAutoDj ? 'flex' : 'none';
            autoDjBtn.classList.toggle('active', this._showAutoDj);
            this._saveAutoDjSettings();
        });
        // Persist every panel change so settings survive reload, auto-advance
        // to shuffled / extended next tracks, Auto-DJ regens, etc.
        autoDjPanel.addEventListener('change', () => this._saveAutoDjSettings());
        // Hydrate the panel from the last-saved settings (if any)
        this._restoreAutoDjSettings(autoDjBtn, autoDjPanel);
        // Restore persisted "macro disabled" marks after the panels are built
        this._disabledMacros = this._loadDisabledMacros();
        this._refreshMacroDisabledMarks();
        // One-shot panel forwards clicks and keeps Fire button labels synced
        osPanel.addEventListener('click', (e) => {
            const save = e.target.closest('.pn-os-save');
            if (save)  { this._oneShotFavorite(save.dataset.macro, e); return; }
            const reset = e.target.closest('.pn-os-tone-reset');
            if (reset) { this._oneShotToneReset(reset.dataset.macro); return; }
            const prev = e.target.closest('.pn-os-tone-prev');
            if (prev)  { this._oneShotToneStep(prev.dataset.macro, -1); return; }
            const next = e.target.closest('.pn-os-tone-next');
            if (next)  { this._oneShotToneStep(next.dataset.macro, +1); return; }
            const btn = e.target.closest('.pn-macro-btn');
            if (!btn) return;
            this._fireMacro(btn.dataset.macro);
        });
        osPanel.addEventListener('contextmenu', (e) => {
            const btn = e.target.closest('.pn-macro-btn');
            if (!btn) return;
            e.preventDefault();
            this._toggleMacroDisabled(btn.dataset.macro);
        });
        osPanel.addEventListener('change', (e) => {
            const sel = e.target.closest('.pn-os-inst');
            if (!sel) return;
            const macroId = sel.dataset.macro;
            const btn = osPanel.querySelector(`.pn-os-fire[data-macro="${macroId}"]`);
            if (!btn) return;
            const label = oneShotSpec(sel.value)?.label || sel.value;
            btn.textContent = `Fire ${label}`;
        });

        // Macro button clicks → fire the macro
        mxPanel.addEventListener('click', (e) => {
            const btn = e.target.closest('.pn-macro-btn');
            if (!btn) return;
            this._fireMacro(btn.dataset.macro);
        });
        // Right-click toggles a macro's "disabled" flag — Auto-DJ skips
        // disabled macros when picking random candidates. Persists to
        // localStorage so the choice survives reload.
        mxPanel.addEventListener('contextmenu', (e) => {
            const btn = e.target.closest('.pn-macro-btn');
            if (!btn) return;
            e.preventDefault();
            this._toggleMacroDisabled(btn.dataset.macro);
        });
        // Track hovered macro button for MIDI pad binding
        mxPanel.addEventListener('mouseover', (e) => {
            const btn = e.target.closest('.pn-macro-btn');
            if (btn) this._hoveredMacro = btn;
        });
        mxPanel.addEventListener('mouseout', (e) => {
            const btn = e.target.closest('.pn-macro-btn');
            if (btn && btn === this._hoveredMacro) this._hoveredMacro = null;
        });

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
            'crush-bits': 0, 'master-pitch': 0,
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
        });

        fx.querySelector('.pn-crop-bar-btn').addEventListener('click', () => {
            if (this._loopStart >= 0 && this._loopEnd > this._loopStart) {
                this._sendWs({ type: 'crop', startTick: this._loopStart, endTick: this._loopEnd });
            }
        });

        fx.querySelector('.pn-loop-mode-select').addEventListener('change', (e) => {
            this._sendWs({ type: 'deterministic-loop', enabled: e.target.value === 'deterministic' });
        });

        // FX slider events - throttled to avoid audio thread overload
        let _fxThrottleId = null;
        const _fxPending = new Map();   // fxKey -> latest value awaiting engine dispatch
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
                case 'master-pitch':
                    toneEngine.setMasterPitch(val);
                    valEl.textContent = (val > 0 ? '+' : '') + val + ' st';
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
            const key = slider.dataset.fx;
            const val = parseInt(slider.value);
            // Queue this key's latest value; other keys stay pending independently
            // so a multi-slider dispatch (e.g. a macro touching wet + size in the
            // same rAF tick) can't silently drop one value by overwriting another.
            _fxPending.set(key, val);
            // Update label immediately for responsiveness
            const valEl = this.querySelector(`[data-fx-val="${key}"]`);
            if (valEl && key === 'delay-time') {
                valEl.textContent = (val / 100).toFixed(2) + 's';
            } else if (valEl && (key === 'hp-freq' || key === 'lp-freq')) {
                const freq = key === 'hp-freq' ? hpFreq(val) : lpFreq(val);
                valEl.textContent = freq < 1000 ? Math.round(freq) + 'Hz' : (freq / 1000).toFixed(1) + 'kHz';
            } else if (valEl && key === 'master-pitch') {
                valEl.textContent = (val > 0 ? '+' : '') + val + ' st';
            } else if (valEl) {
                valEl.textContent = val + '%';
            }
            // Throttle engine calls to ~30fps — but flush every pending key
            if (!_fxThrottleId) {
                _fxThrottleId = setTimeout(() => {
                    for (const [k, v] of _fxPending) applyFx(k, v);
                    _fxPending.clear();
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

        // FX scroll wheel support (1% per tick)
        fx.addEventListener('wheel', (e) => {
            const control = e.target.closest('.pn-fx-control');
            if (!control) return;
            e.preventDefault();
            const slider = control.querySelector('.pn-fx-slider');
            if (!slider) return;
            const min = parseInt(slider.min);
            const max = parseInt(slider.max);
            const step = e.deltaY < 0 ? 1 : -1;
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

        // Status bar (WebSocket mode only)
        if (this.dataset.backend === 'ws') {
            const status = document.createElement('div');
            status.className = 'pn-status';
            status.innerHTML = '<span class="pn-ws-status disconnected">&#9679; Disconnected</span>';
            this.appendChild(status);
        }

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
            this._openTraitEditor(trait.dataset.param);
        });
    }

    _traitMeta() {
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

    _genreTraitDefault(g, param) {
        return {
            'drum-fills': g.drumFills, 'walking-bass': g.walkingBass,
            'polyrhythm': g.polyrhythm, 'syncopation': g.syncopation,
            'call-response': g.callResponse, 'tension-curve': g.tensionCurve,
            'modal-interchange': g.modalInterchange, 'ghost-notes': g.ghostNotes,
        }[param];
    }

    _openTraitEditor(param) {
        const meta = this._traitMeta()[param];
        if (!meta) return;
        const genre = this.querySelector('.pn-genre-select')?.value || 'techno';
        const g = this._genreData[genre];
        if (!g) return;

        if (!this._traitOverrides) this._traitOverrides = {};
        const current = this._traitOverrides[param] !== undefined
            ? this._traitOverrides[param]
            : this._genreTraitDefault(g, param);

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
        this.appendChild(overlay);

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

        // Wheel-to-adjust on any number/range input
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
                this._traitOverrides[param] = on;
            } else if (meta.type === 'percent') {
                this._traitOverrides[param] = on ? (parseInt(slider.value, 10) / 100) : 0;
            } else if (meta.type === 'int') {
                this._traitOverrides[param] = on ? parseInt(intIn.value, 10) : 0;
            }
            close();
            this._updateTraits();
            toneEngine.resumeContext();
            this._ensureToneStarted();
            const params = { ...this._traitOverrides };
            const structure = this.querySelector('.pn-structure-select')?.value;
            if (structure) params.structure = structure;
            this._sendWs({ type: 'generate', genre, params });
        });

        (slider || intIn || cb).focus();
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

        // Hide `hit*` (Beats) tracks unless the Beats tab is toggled on — they
        // clutter the mixer when the user isn't actively tweaking them.
        const hitsHidden = !this._showOneShots;
        for (const [id, net] of Object.entries(this._project.nets)) {
            if (net.role === 'control') continue;
            if (hitsHidden && id.startsWith('hit')) continue;
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
                <select class="pn-mixer-output" data-channel="${channel}" title="Audio output device">
                    <option value="">Master</option>
                </select>
                ${this._patternSelectsHtml(this._project.nets[activeSlotId || netIds[0]], activeSlotId || netIds[0])}
                ${this._mixerSlidersHtml(netIds[0], percOrder.includes(group))}
                <button class="pn-mixer-save" data-net-id="${netIds[0]}" title="Save / load tone presets for this track">&#9733;</button>
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

        // Insert a divider between standard tracks (anything in roleOrder) and
        // extra tracks (stingers + anything else with a non-standard name).
        // Extras all report roleIdx === roleOrder.length since they aren't in
        // the roleOrder list. The divider label lists their ids so users see
        // at a glance what's been added beyond the core tracks.
        const rows = [...this._mixerEl.children];
        const firstExtraIdx = rows.findIndex(el => {
            const elRole = el.dataset.riffGroup || el.dataset.netId;
            return roleIdx(elRole) >= roleOrder.length;
        });
        if (firstExtraIdx >= 0 && firstExtraIdx < rows.length) {
            const extraIds = rows.slice(firstExtraIdx)
                .map(el => el.dataset.riffGroup || el.dataset.netId)
                .filter(Boolean);
            const divider = document.createElement('div');
            divider.className = 'pn-mixer-divider';
            divider.innerHTML = `<span class="pn-mixer-divider-label">Beats</span>` +
                `<span class="pn-mixer-divider-list">${extraIds.join(' · ')}</span>`;
            this._mixerEl.insertBefore(divider, rows[firstExtraIdx]);
        }

        this._populateAudioOutputs();

        // Bind mixer events (only once — event delegation handles dynamic content)
        if (this._mixerEventsBound) {
            this._restoreMixerSliderState();
            return;
        }
        this._mixerEventsBound = true;

        this._mixerEl.addEventListener('pointerdown', async (e) => {
            if (e.target.closest('.pn-mixer-output') && !this._midiEnumerated) {
                this._midiEnumerated = true;
                try {
                    await this._refreshMidiOutputs();
                    await this._populateAudioOutputs();
                } catch {}
            }
        }, true);

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
            const saveBtn = e.target.closest('.pn-mixer-save');
            if (saveBtn) {
                e.stopPropagation();
                this._openPresetManager(saveBtn.dataset.netId);
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
                // Keep hit Fire-pad label synced when rotating; unbound shows slot id
                const fireBtn = this.querySelector(`.pn-os-fire[data-macro="${netId}"]`);
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
            const outputSelect = e.target.closest('.pn-mixer-output');
            if (outputSelect) {
                const channel = parseInt(outputSelect.dataset.channel, 10);
                const val = outputSelect.value; // '' | 'audio:<id>' | 'midi:<id>'
                await this._setChannelRouting(channel, val);
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
                    hitsEl.innerHTML = this._hitsOptionsHtml(hits, size);
                } else if (sizeSel) {
                    // Re-populate hits options to reflect new cap; preserve selection
                    hitsEl.innerHTML = this._hitsOptionsHtml(hits, size);
                }
                this._sendWs({ type: 'update-track-pattern', netId, ringSize: size, beats: hits });
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
                // If this is a stinger/hit track, keep the Fire pad label in
                // sync with the track's current instrument. "unbound" falls
                // back to the slot id so the button still reads e.g. Fire Hit1.
                const fireBtn = this.querySelector(`.pn-os-fire[data-macro="${netId}"]`);
                if (fireBtn) {
                    const label = instrument === 'unbound'
                        ? prettifyInstrumentName(netId)
                        : (oneShotSpec(instrument)?.label || prettifyInstrumentName(instrument));
                    fireBtn.textContent = `Fire ${label}`;
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
            const row = slider.closest('.pn-mixer-row');
            const drumRole = isDrumChannel(ch) ? (net.riffGroup || row?.dataset.riffGroup || netId) : null;

            // Save slider state for this net
            this._saveMixerSliderState(netId);

            const v = parseInt(slider.value);
            for (const [cls, , applyFactory] of MIXER_SLIDERS) {
                if (slider.classList.contains(cls)) {
                    applyFactory(ch, drumRole)(v);
                    return;
                }
            }
        });

        this._mixerEl.addEventListener('wheel', (e) => {
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

        // Track hovered slider for MIDI CC binding
        this._mixerEl.addEventListener('mouseover', (e) => {
            const slider = e.target.closest('.pn-mixer-slider');
            if (slider) this._hoveredSlider = slider;
        });
        this._mixerEl.addEventListener('mouseout', (e) => {
            const slider = e.target.closest('.pn-mixer-slider');
            if (slider && slider === this._hoveredSlider) this._hoveredSlider = null;
        });

        // Apply initial decay and volume per row
        for (const row of this._mixerEl.querySelectorAll('.pn-mixer-row')) {
            const nid = row.dataset.netId;
            const net = this._project.nets[nid];
            if (!net) continue;
            const ch = net.track?.channel || 1;
            const decSlider = row.querySelector('.pn-mixer-decay');
            if (decSlider) toneEngine.setChannelDecay(ch, parseInt(decSlider.value) / 100);
            const volSel = row.querySelector('.pn-mixer-vol');
            if (volSel) toneEngine.controlChange(ch, 7, Math.round(parseInt(volSel.value, 10) * 127 / 100));
        }

        // Restore saved slider positions after DOM rebuild
        this._restoreMixerSliderState();
        // Populate per-channel output selectors (async, non-blocking)
        this._populateAudioOutputs();
        // Defer notches to after layout is complete (double rAF ensures paint)
        const mixerEl = this._mixerEl;
        requestAnimationFrame(() => requestAnimationFrame(() => {
            if (mixerEl.isConnected) this._addDefaultNotches(mixerEl);
        }));
    }

    _patternSelectsHtml(net, targetId) {
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

    _loadPresets() {
        if (this._presets) return this._presets;
        try {
            const raw = localStorage.getItem('pn-instrument-presets');
            this._presets = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(this._presets)) this._presets = [];
        } catch {
            this._presets = [];
        }
        return this._presets;
    }

    _savePresets() {
        localStorage.setItem('pn-instrument-presets', JSON.stringify(this._presets || []));
    }

    _generatePresetName(instrument) {
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

    _captureRowSettings(row) {
        const settings = {};
        for (const [cls, key] of MIXER_SLIDERS) {
            const el = row.querySelector(`.${cls}`);
            if (el) settings[key] = el.value;
        }
        return settings;
    }

    _saveCurrentPreset(netId) {
        const row = this._mixerEl?.querySelector(`.pn-mixer-row[data-net-id="${netId}"]`);
        if (!row) return;
        const net = this._project.nets[netId];
        if (!net) return;
        const ch = net.track?.channel || 1;
        const instrument = net.track?.instrument || this._channelInstruments[ch] || 'piano';
        this._loadPresets();
        const preset = {
            id: `${instrument}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            name: this._generatePresetName(instrument),
            instrument,
            channel: ch,
            settings: this._captureRowSettings(row),
            created: Date.now(),
        };
        this._presets.push(preset);
        this._savePresets();
        this._renderMixer();
    }

    _applyPreset(netId, presetId) {
        this._loadPresets();
        const preset = this._presets.find(p => p.id === presetId);
        if (!preset) return;
        const row = this._mixerEl?.querySelector(`.pn-mixer-row[data-net-id="${netId}"]`);
        if (!row) return;
        const net = this._project.nets[netId];
        if (!net) return;
        const ch = net.track?.channel || 1;
        const drumRole = isDrumChannel(ch) ? (net.riffGroup || row.dataset.riffGroup || netId) : null;

        for (const [cls, key, applyFactory] of MIXER_SLIDERS) {
            const el = row.querySelector(`.${cls}`);
            const v = preset.settings[key];
            if (el && v != null) {
                el.value = v;
                applyFactory(ch, drumRole)(parseInt(v, 10));
            }
        }
        this._saveMixerSliderState(netId);
    }

    _deletePreset(presetId) {
        this._loadPresets();
        this._presets = this._presets.filter(p => p.id !== presetId);
        this._savePresets();
        this._renderMixer();
    }

    _openPresetManager(netId) {
        const net = this._project.nets[netId];
        if (!net) return;
        const ch = net.track?.channel || 1;
        const instrument = net.track?.instrument || this._channelInstruments[ch] || 'piano';

        const overlay = document.createElement('div');
        overlay.className = 'pn-modal-overlay';

        const render = () => {
            const all = this._loadPresets();
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
        this.appendChild(overlay);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay || e.target.classList.contains('close')) {
                overlay.remove();
                return;
            }
            if (e.target.classList.contains('save')) {
                this._saveCurrentPreset(netId);
                render();
                return;
            }
            const applyBtn = e.target.closest('.pn-preset-apply');
            if (applyBtn) {
                this._applyPreset(netId, applyBtn.dataset.presetId);
                overlay.remove();
                return;
            }
            const delBtn = e.target.closest('.pn-preset-delete');
            if (delBtn) {
                const presetId = delBtn.dataset.presetId;
                const preset = this._loadPresets().find(p => p.id === presetId);
                const name = preset?.name || 'this preset';
                if (confirm(`Delete preset "${name}"?`)) {
                    this._deletePreset(presetId);
                    render();
                }
                return;
            }
        });
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.preventDefault(); overlay.remove(); }
        });
    }

    _presetSelectHtml(instrument, channel) {
        const all = this._loadPresets();
        // Match by channel when available (covers legacy presets that only stored instrument)
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

    // --- Macros ---
    //
    // Fire-and-forget: main thread computes target set and duration, worker
    // does the rest (immediate mute + transient control net for restore).

    _musicNets() {
        const out = [];
        for (const [id, net] of Object.entries(this._project?.nets || {})) {
            if (net.role === 'control') continue;
            out.push([id, net]);
        }
        return out;
    }

    _fireMacro(id) {
        // Serial execution: if anything is running, push onto the FIFO queue.
        this._macroQueue ||= [];
        if (this._runningMacro) {
            this._macroQueue.push(id);
            this._updateQueuedBadges();
            return;
        }
        this._executeMacro(id);
    }

    _executeMacro(id) {
        const macro = MACROS.find(m => m.id === id);
        if (!macro) return;
        const sel = this.querySelector(`.pn-macro-bars[data-macro="${id}"]`);
        const duration = parseInt(sel?.value, 10) || macro.defaultDuration;
        const durationTicks = macro.durationUnit === 'tick' ? duration : duration * 16;
        const msPerTick = this._msPerBar() / 16;
        const durationMs = durationTicks * msPerTick;

        if (macro.kind === 'mute') {
            const targets = macro.targets(this);
            if (targets.length > 0) {
                this._sendWs({
                    type: 'fire-macro',
                    macroId: `${id}-${Date.now().toString(36)}`,
                    targets,
                    durationTicks,
                    muteAction: 'mute-track',
                    restoreAction: 'unmute-track',
                });
                // Pulse the mute buttons of affected rows for the duration so
                // the mixer signals what the macro is touching.
                const muteEls = targets
                    .map(tid => this._mixerEl?.querySelector(`.pn-mixer-row[data-net-id="${tid}"] .pn-mixer-mute`)
                             || this._mixerEl?.querySelector(`.pn-mixer-row[data-riff-group="${tid}"] .pn-mixer-mute`))
                    .filter(Boolean);
                this._macroPulse(muteEls, durationMs, `mute:${id}`);
            }
        } else if (macro.kind === 'fx-sweep' || macro.kind === 'fx-hold') {
            const ops = macro.ops || [{ fxKey: macro.fxKey, toValue: macro.toValue }];
            for (const op of ops) {
                if (macro.kind === 'fx-sweep') this._fxSweep(op.fxKey, op.toValue, durationMs);
                else                          this._fxHold (op.fxKey, op.toValue, durationMs, macro.tailFrac);
            }
            // Pulse the affected FX sliders for the duration of the macro.
            const fxEls = ops.map(op => this._fxSlider(op.fxKey)).filter(Boolean);
            this._macroPulse(fxEls, durationMs, `fx:${id}`);
        } else if (macro.kind === 'pan-move' || macro.kind === 'decay-move') {
            this._channelParamMove(macro, durationMs);
        } else if (macro.kind === 'beat-repeat') {
            this._runBeatRepeat(macro, durationMs);
        } else if (macro.kind === 'compound') {
            this._runCompound(macro, duration, macro.durationUnit, msPerTick);
        } else if (macro.kind === 'tempo-hold') {
            this._tempoHold(macro.factor, durationMs);
        } else if (macro.kind === 'tempo-sweep') {
            this._tempoSweep(macro.finalBpm, durationMs);
        } else if (macro.kind === 'one-shot') {
            // Fire pad: route through the track's channel strip (so track vol
            // /pan/filters apply) and bypass the mute filter — so Fire still
            // works even when the stinger track starts muted. Track id matches
            // macro.id (hit1/hit2/…); macro.sound is just the default-instrument
            // fallback used when no matching track exists.
            const pitchSel = this.querySelector(`.pn-os-pitch[data-macro="${id}"]`);
            const pitch = parseInt(pitchSel?.value, 10) || 0;
            const track = this._project?.nets?.[id];
            const channel = track?.track?.channel;
            const currentInst = track?.track?.instrument;
            this._ensureToneStarted().then(() => {
                if (currentInst === 'unbound') {
                    // Silent slot — Fire still fires paired FX macros, but no sound
                } else if (channel != null) {
                    toneEngine.playNote({ channel, note: 60 + pitch, velocity: 110, duration: 200 });
                } else {
                    toneEngine.playOneShot(macro.sound, pitch);
                }
            });
            // Paired macro: fire the chosen FX macro alongside the sound.
            // Runs through the normal macro pipeline (not the serial queue)
            // so stutters/sweeps trigger instantly next to the stinger.
            const pairSel = this.querySelector(`.pn-os-pair[data-macro="${id}"]`);
            const pairId = pairSel?.value;
            if (pairId && pairId !== id) {
                const savedRunning = this._runningMacro;
                this._runningMacro = null;        // bypass serial queue for this side-effect
                try { this._executeMacro(pairId); } finally { this._runningMacro = savedRunning; }
            }
        }

        const btn = this.querySelector(`.pn-macro-btn[data-macro="${id}"]`);
        if (btn) {
            btn.classList.add('firing');
            setTimeout(() => btn.classList.remove('firing'), 120);
        }
        // One-shots finish fast — budget ~700 ms per hit so the serial queue
        // doesn't release while stutters are still firing.
        const runTime = macro.kind === 'one-shot'
            ? 700 + Math.max(0, duration - 1) * (this._msPerBar() / 16)
            : durationMs;
        this._markMacroRunning(id, runTime);
    }

    // ---- One-shot row controls: repeat-on-beat, tone reset/nav, favorites ----
    // Slider keys (class suffix) tracked by the tone reset/nav/save machinery.
    // Pitch/Hits/Instrument stay outside — they're semantic parameters, not tone.
    static get _ONESHOT_SLIDER_KEYS() {
        return [
            ['pn-os-vol', 80],
            ['pn-os-hp',  0],
            ['pn-os-hpr', 0],
            ['pn-os-lp',  100],
            ['pn-os-lpr', 0],
            ['pn-os-atk', 0],
            ['pn-os-dec', 0],
        ];
    }

    _snapshotOneShot(macroId) {
        const snap = {};
        for (const [cls] of PetriNote._ONESHOT_SLIDER_KEYS) {
            const el = this.querySelector(`.${cls}[data-macro="${macroId}"]`);
            if (el) snap[cls] = parseFloat(el.value);
        }
        const inst = this.querySelector(`.pn-os-inst[data-macro="${macroId}"]`);
        if (inst) snap.inst = inst.value;
        const hits = this.querySelector(`.pn-os-hits[data-macro="${macroId}"]`);
        if (hits) snap.hits = hits.value;
        const pit  = this.querySelector(`.pn-os-pitch[data-macro="${macroId}"]`);
        if (pit)  snap.pitch = pit.value;
        return snap;
    }

    _applyOneShotSnapshot(macroId, snap) {
        for (const [cls] of PetriNote._ONESHOT_SLIDER_KEYS) {
            const el = this.querySelector(`.${cls}[data-macro="${macroId}"]`);
            if (el && snap[cls] != null) el.value = snap[cls];
        }
        if (snap.inst != null) {
            const inst = this.querySelector(`.pn-os-inst[data-macro="${macroId}"]`);
            if (inst) {
                inst.value = snap.inst;
                const btn = this.querySelector(`.pn-os-fire[data-macro="${macroId}"]`);
                if (btn) btn.textContent = `Fire ${oneShotSpec(snap.inst)?.label || snap.inst}`;
            }
        }
        if (snap.hits != null) {
            const hits = this.querySelector(`.pn-os-hits[data-macro="${macroId}"]`);
            if (hits) hits.value = snap.hits;
        }
        if (snap.pitch != null) {
            const pit = this.querySelector(`.pn-os-pitch[data-macro="${macroId}"]`);
            if (pit) pit.value = snap.pitch;
        }
    }

    _oneShotToneReset(macroId) {
        const snap = {};
        for (const [cls, def] of PetriNote._ONESHOT_SLIDER_KEYS) snap[cls] = def;
        this._applyOneShotSnapshot(macroId, snap);
        this._oneShotToneHistory ||= new Map();
        this._oneShotToneIndex   ||= new Map();
        this._oneShotToneHistory.set(macroId, [snap]);
        this._oneShotToneIndex.set(macroId, 0);
    }

    _oneShotToneStep(macroId, dir) {
        this._oneShotToneHistory ||= new Map();
        this._oneShotToneIndex   ||= new Map();
        const hist = this._oneShotToneHistory.get(macroId) || [this._snapshotOneShot(macroId)];
        let idx = this._oneShotToneIndex.get(macroId) ?? (hist.length - 1);
        if (dir > 0) {
            // Generate a random mutation and append
            const snap = {};
            for (const [cls] of PetriNote._ONESHOT_SLIDER_KEYS) {
                snap[cls] = Math.round(Math.random() * 100);
            }
            // Keep Vol sane (50–100) so randoms don't disappear
            snap['pn-os-vol'] = 50 + Math.round(Math.random() * 50);
            hist.push(snap);
            idx = hist.length - 1;
        } else {
            idx = Math.max(0, idx - 1);
        }
        this._oneShotToneHistory.set(macroId, hist);
        this._oneShotToneIndex.set(macroId, idx);
        this._applyOneShotSnapshot(macroId, hist[idx]);
    }

    _oneShotFavorite(macroId, ev) {
        const storeKey = 'pn-oneshot-favorites';
        const favs = JSON.parse(localStorage.getItem(storeKey) || '{}');
        const list = favs[macroId] || [];
        if (ev.shiftKey && list.length > 0) {
            // Shift-click → cycle through favorites
            this._oneShotFavIdx ||= new Map();
            const idx = ((this._oneShotFavIdx.get(macroId) ?? -1) + 1) % list.length;
            this._oneShotFavIdx.set(macroId, idx);
            this._applyOneShotSnapshot(macroId, list[idx].snap);
            return;
        }
        if (list.length > 0 && !ev.altKey) {
            const names = list.map((f, i) => `${i+1}. ${f.name}`).join('\n');
            const choice = prompt(`Favorites for ${macroId}:\n${names}\n\nEnter number to load, 's' to save current, or blank to cancel:`, 's');
            if (!choice) return;
            if (choice === 's') {
                const name = prompt('Name this favorite:', list.length ? `${macroId}-${list.length + 1}` : macroId);
                if (!name) return;
                list.push({ name, snap: this._snapshotOneShot(macroId) });
                favs[macroId] = list;
                localStorage.setItem(storeKey, JSON.stringify(favs));
                return;
            }
            const n = parseInt(choice, 10);
            if (Number.isFinite(n) && n >= 1 && n <= list.length) {
                this._applyOneShotSnapshot(macroId, list[n - 1].snap);
            }
            return;
        }
        // First-time save
        const name = prompt('Name this favorite:', macroId);
        if (!name) return;
        list.push({ name, snap: this._snapshotOneShot(macroId) });
        favs[macroId] = list;
        localStorage.setItem(storeKey, JSON.stringify(favs));
    }

    // Right-click toggle: mark a macro as Auto-DJ-disabled. Visual marker is
    // a `pn-macro-disabled` class on every button bearing that data-macro id.
    // Persists to `localStorage['pn-macro-disabled']` so reload preserves it.
    _toggleMacroDisabled(id) {
        this._disabledMacros = this._disabledMacros || this._loadDisabledMacros();
        if (this._disabledMacros.has(id)) this._disabledMacros.delete(id);
        else                              this._disabledMacros.add(id);
        this._saveDisabledMacros();
        this._refreshMacroDisabledMarks();
    }

    // Persist every Auto-DJ knob to localStorage so state survives browser
    // reload AND any in-app transition that might otherwise clear it (shuffle
    // auto-advance, regen, project upload, structure change). Read on panel
    // build and apply to the existing DOM elements.
    _saveAutoDjSettings() {
        try {
            const panel = this.querySelector('.pn-autodj-panel');
            if (!panel) return;
            const pools = {};
            for (const cb of panel.querySelectorAll('.pn-autodj-pool')) {
                pools[cb.value] = cb.checked;
            }
            const state = {
                showAutoDj: !!this._showAutoDj,
                run:         !!panel.querySelector('.pn-autodj-enable')?.checked,
                animateOnly: !!panel.querySelector('.pn-autodj-animate-only')?.checked,
                rate:        panel.querySelector('.pn-autodj-rate')?.value,
                regen:       panel.querySelector('.pn-autodj-regen')?.value,
                stack:       panel.querySelector('.pn-autodj-stack')?.value,
                pools,
            };
            localStorage.setItem('pn-autodj-settings', JSON.stringify(state));
        } catch {}
    }

    _restoreAutoDjSettings(autoDjBtn, panel) {
        let state;
        try {
            const raw = localStorage.getItem('pn-autodj-settings');
            if (!raw) return;
            state = JSON.parse(raw);
        } catch { return; }
        if (!state) return;
        if (state.showAutoDj) {
            this._showAutoDj = true;
            panel.style.display = 'flex';
            autoDjBtn.classList.add('active');
        }
        const set = (cls, val) => {
            const el = panel.querySelector(`.${cls}`);
            if (!el) return;
            if (el.type === 'checkbox') el.checked = !!val;
            else if (val != null) el.value = val;
        };
        set('pn-autodj-enable',        state.run);
        set('pn-autodj-animate-only',  state.animateOnly);
        set('pn-autodj-rate',          state.rate);
        set('pn-autodj-regen',         state.regen);
        set('pn-autodj-stack',         state.stack);
        if (state.pools) {
            for (const cb of panel.querySelectorAll('.pn-autodj-pool')) {
                if (cb.value in state.pools) cb.checked = !!state.pools[cb.value];
            }
        }
    }

    _loadDisabledMacros() {
        try {
            const raw = localStorage.getItem('pn-macro-disabled');
            return new Set(raw ? JSON.parse(raw) : []);
        } catch { return new Set(); }
    }

    _saveDisabledMacros() {
        try {
            localStorage.setItem('pn-macro-disabled', JSON.stringify([...this._disabledMacros]));
        } catch {}
    }

    _refreshMacroDisabledMarks() {
        if (!this._disabledMacros) return;
        for (const btn of this.querySelectorAll('.pn-macro-btn[data-macro]')) {
            btn.classList.toggle('pn-macro-disabled', this._disabledMacros.has(btn.dataset.macro));
        }
    }

    // Auto-DJ: every N bars (configurable), pick a random macro from the
    // selected pool and fire it. If Stack > 1, fires that many macros at once.
    // Each fire kicks the petri-net canvas into rotation, alternating direction
    // so stacked effects accumulate into a visible spin-up.
    _autoDjTick(prevTick, curTick) {
        // Arm state is the Run checkbox, not tab visibility — Auto-DJ keeps
        // running in the background while the user is in FX / Macros / Beats.
        // The form controls stay in the DOM when the panel is display:none.
        const enableEl = this.querySelector('.pn-autodj-enable');
        if (!enableEl?.checked) return;
        if (curTick === prevTick) return;
        // Tick wrap (loop wrap or freshly-regenerated project resets to 0) —
        // skip this cycle to avoid re-triggering regen/macros on the reset.
        if (curTick < prevTick) { this._autoDjPreviewPending = false; return; }
        const ticksPerBar = 16;

        // Regen check runs independently of macro cadence. At 1 bar before
        // the boundary we kick a preview-generate to the worker; at the
        // boundary we apply that pre-rendered project (falling back to a
        // sync Generate click if the preview didn't arrive in time). Keeps
        // the swap as seamless as shuffle mode.
        const regenBars = parseInt(this.querySelector('.pn-autodj-regen')?.value, 10) || 0;
        if (regenBars > 0) {
            const regenBoundary = regenBars * ticksPerBar;
            const prefetchTick = regenBoundary - ticksPerBar; // 1 bar early
            const prPf = ((prevTick) % regenBoundary) < prefetchTick;
            const crPf = ((curTick)  % regenBoundary) >= prefetchTick;
            if (prPf && crPf && !this._autoDjPreviewPending && curTick > 0) {
                this._autoDjPreviewPending = true;
                const genre = this.querySelector('.pn-genre-select')?.value || 'techno';
                const params = { ...(this._traitOverrides || {}) };
                const structure = this.querySelector('.pn-structure-select')?.value || '';
                if (structure) params.structure = structure;
                this._sendWs({ type: 'generate-preview', genre, params });
                const statusEl = this.querySelector('.pn-autodj-status');
                if (statusEl) statusEl.textContent = `pre-loading next…`;
            }

            const pr = Math.floor(prevTick / regenBoundary);
            const cr = Math.floor(curTick  / regenBoundary);
            if (cr !== pr && curTick > 0) {
                const preview = this._pendingNextTrack;
                if (preview) {
                    // Use pre-rendered project for a seamless swap
                    this._pendingNextTrack = null;
                    this._applyProjectSync(preview, true);
                    this._sendWs({ type: 'project-load', project: preview });
                } else {
                    // Pre-load didn't land in time — fall back to a sync gen
                    this.querySelector('.pn-generate-btn')?.click();
                }
                this._autoDjPreviewPending = false;
                const statusEl = this.querySelector('.pn-autodj-status');
                if (statusEl) statusEl.textContent = `regenerating…`;
            }
        }

        const rateBars = parseInt(this.querySelector('.pn-autodj-rate')?.value, 10) || 2;
        const boundary = rateBars * ticksPerBar;
        const prev = Math.floor(prevTick / boundary);
        const cur  = Math.floor(curTick / boundary);
        if (cur === prev) return;

        const stack = parseInt(this.querySelector('.pn-autodj-stack')?.value, 10) || 1;
        const animateOnly = !!this.querySelector('.pn-autodj-animate-only')?.checked;
        const statusEl = this.querySelector('.pn-autodj-status');

        // Animate-only: skip macro selection entirely, just spin the ring
        // `stack` times so users can use Auto-DJ as a pure visualizer.
        // Runs even when a user-fired macro is active since there's no
        // firing conflict.
        if (animateOnly) {
            for (let i = 0; i < stack; i++) this._autoDjSpin();
            if (statusEl) statusEl.textContent = `(animate only)`;
            return;
        }

        // Don't pile up — if any macro (user-fired or previous Auto-DJ pick)
        // is still running or has queued followers, skip this cycle entirely
        // rather than stacking into the serial queue.
        if (this._runningMacro || (this._macroQueue && this._macroQueue.length > 0)) {
            if (statusEl) statusEl.textContent = `(skipped — busy)`;
            return;
        }

        const poolBoxes = this.querySelectorAll('.pn-autodj-pool:checked');
        const enabled = new Set([...poolBoxes].map(cb => cb.value));

        // "Beats" maps to the one-shot kind (Hit1..4 Fire pads); any other
        // entry matches `macro.group` directly. Compound macros are skipped
        // since they internally fire several others and the cadence is too
        // dense for auto-cycling.
        this._disabledMacros = this._disabledMacros || this._loadDisabledMacros();
        const candidates = enabled.size === 0 ? [] : MACROS.filter(m => {
            if (m.kind === 'compound') return false;
            if (this._disabledMacros.has(m.id)) return false;
            if (m.kind === 'one-shot') return enabled.has('Beats');
            return enabled.has(m.group);
        });

        // No candidates (all pools unchecked / all macros disabled) — still
        // spin the ring on cadence so the visual feedback persists even when
        // there's nothing to fire. Avoids "is Auto-DJ broken?" moments.
        if (candidates.length === 0) {
            for (let i = 0; i < stack; i++) this._autoDjSpin();
            if (statusEl) statusEl.textContent = `(no candidates)`;
            return;
        }

        const fired = [];
        // First stack item goes through the normal fire path so it claims the
        // serial slot. Remaining stack items run directly via _executeMacro so
        // they overlap with the first rather than queuing behind it.
        for (let i = 0; i < stack; i++) {
            const pick = candidates[Math.floor(Math.random() * candidates.length)];
            fired.push(pick.label);
            if (i === 0) this._fireMacro(pick.id);
            else         this._executeMacro(pick.id);
            this._autoDjSpin();
        }
        if (statusEl) statusEl.textContent = `→ ${fired.join(', ')}`;
    }

    // Nudge the ring-visualization rotation by ±90° each time Auto-DJ fires,
    // alternating direction so consecutive fires visibly stack/swing. The
    // rotation is applied inside _draw (around the ring center) rather than
    // via CSS transform on the canvas element — that way the beat-timeline
    // dots and particle bursts above the ring stay put while only the
    // euclidean ring spins underneath.
    _autoDjSpin() {
        const dir = this._autoDjDir || 1;
        this._autoDjTargetAngle = (this._autoDjTargetAngle || 0) + dir * 90;
        this._autoDjDir = -dir;
        this._autoDjSpinStart = performance.now();
        this._autoDjSpinFrom = this._autoDjAngleDeg || 0;
        // Arrow direction follows rotation direction: CCW spin (negative
        // delta) flips arrowheads so tokens visually move with the net.
        this._autoDjReverse = dir < 0;
        this._autoDjSpinAnimate();
    }

    _autoDjSpinAnimate() {
        const DURATION = 800;
        const t0 = this._autoDjSpinStart;
        const from = this._autoDjSpinFrom || 0;
        const to   = this._autoDjTargetAngle || 0;
        const step = (now) => {
            const elapsed = now - t0;
            const t = Math.min(1, elapsed / DURATION);
            // cubic-bezier-ish ease out
            const eased = 1 - Math.pow(1 - t, 3);
            this._autoDjAngleDeg = from + (to - from) * eased;
            this._draw();
            if (t < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }

    // Fire any one-shot whose repeat checkbox is on when we cross a beat
    // boundary (4 ticks / quarter note at 16 ticks per bar).
    _fireRepeatingOneShots(prevTick, curTick) {
        if (!this._showOneShots || curTick === prevTick) return;
        const prevBeat = Math.floor(prevTick / 4);
        const curBeat  = Math.floor(curTick / 4);
        if (curBeat === prevBeat) return;
        const boxes = this.querySelectorAll('.pn-os-repeat:checked');
        for (const cb of boxes) this._fireMacro(cb.dataset.macro);
    }

    _markMacroRunning(id, durationMs) {
        this._runningMacro = id;
        const btn = this.querySelector(`.pn-macro-btn[data-macro="${id}"]`);
        if (btn) btn.classList.add('running');
        this._updateQueuedBadges();
        this._runningTimer = setTimeout(() => {
            const b = this.querySelector(`.pn-macro-btn[data-macro="${id}"]`);
            if (b) b.classList.remove('running');
            this._runningMacro = null;
            this._runningTimer = null;
            const next = (this._macroQueue || []).shift();
            if (next !== undefined) {
                this._updateQueuedBadges();
                this._executeMacro(next);
            } else {
                // Clear any stale 'queued' classes
                this.querySelectorAll('.pn-macro-btn.queued').forEach(b => b.classList.remove('queued'));
                this.querySelectorAll('.pn-macro-queue-badge').forEach(b => b.remove());
            }
        }, Math.max(100, durationMs + 40));
    }

    // Mark buttons for macros currently in the queue, with a "+N" badge for depth > 1.
    _updateQueuedBadges() {
        const counts = new Map();
        for (const qid of (this._macroQueue || [])) counts.set(qid, (counts.get(qid) || 0) + 1);
        for (const btn of this.querySelectorAll('.pn-macro-btn')) {
            const qid = btn.dataset.macro;
            const count = counts.get(qid) || 0;
            btn.classList.toggle('queued', count > 0);
            let badge = btn.querySelector('.pn-macro-queue-badge');
            if (count > 0) {
                if (!badge) {
                    badge = document.createElement('span');
                    badge.className = 'pn-macro-queue-badge';
                    btn.appendChild(badge);
                }
                badge.textContent = count > 1 ? `+${count}` : '•';
            } else if (badge) {
                badge.remove();
            }
        }
    }

    _msPerBar() {
        const ppq = 4;
        const ticksPerBar = 16;
        return (60000 / ((this._tempo || 120) * ppq)) * ticksPerBar;
    }

    _fxSlider(fxKey) {
        return this.querySelector(`.pn-fx-slider[data-fx="${fxKey}"]`);
    }

    _setFxValue(slider, value) {
        slider.value = Math.round(value);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // fx-sweep: 80% of duration ramps from start → toValue, final 20% ramps back.
    // Slider UI animates at rAF rate, but audio-engine dispatch is throttled to
    // ~120 ms so the engine's built-in 100 ms `rampTo` smoothing doesn't get
    // cancelled mid-ramp (which produces an oscillating, audibly flat filter).
    // Chase-pulse across an array of DOM elements for `durationMs`. Every
    // element gets `pn-pulsing` while one at a time rotates through
    // `pn-pulsing-hot` (120ms per step). Used so every macro side-effect has
    // the same "under control" visual as the pan/decay sliders. Returns a
    // cancel fn so callers can stop early.
    _macroPulse(elements, durationMs, tag) {
        if (!elements || elements.length === 0) return () => {};
        this._pulseAnim = this._pulseAnim || {};
        if (tag && this._pulseAnim[tag]) this._pulseAnim[tag].cancelled = true;
        const token = { cancelled: false };
        if (tag) this._pulseAnim[tag] = token;
        const BLINK = 120;
        const t0 = performance.now();
        let lastBlink = -BLINK;
        let idx = 0;
        const clear = () => {
            for (const el of elements) el?.classList.remove('pn-pulsing', 'pn-pulsing-hot');
            if (tag && this._pulseAnim[tag] === token) this._pulseAnim[tag] = null;
        };
        // Safety net: even if rAF stalls (tab backgrounded, page reflow, etc.)
        // or the token gets orphaned, guarantee a cleanup slightly past the
        // macro's duration so pulses never get stuck on forever.
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

    // Drive per-channel pan or decay over `durationMs` for every channel in
    // the macro's target group. Patterns: `hold` (snap & hold), `pingpong`
    // (flip every stepBeats), `sweep` (sinusoidal LFO at rateBeats). Restores
    // every affected channel to its pre-macro value on release (pan back to
    // the user's previous pan, decay back to the user's previous decay).
    _channelParamMove(macro, durationMs) {
        const targets = macro.targets ? macro.targets(this) : [];
        const chans = [];
        const seen = new Set();
        const netIds = [];
        for (const id of targets) {
            const ch = this._project?.nets?.[id]?.track?.channel;
            if (ch != null && !seen.has(ch)) { chans.push(ch); seen.add(ch); netIds.push(id); }
        }
        if (chans.length === 0) return;

        const kind = macro.kind; // 'pan-move' | 'decay-move'

        this._chanAnim = this._chanAnim || {};
        const prev = this._chanAnim[macro.id];
        // If the same macro is already running, reuse its pre-macro snapshot
        // so we don't capture mid-animation state (0.3 or -1) as the new
        // equilibrium — that's what caused "shape doesn't return" on rapid
        // re-fires. Then cancel the old token so only one step loop runs.
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
                // v in [-1, 1] → CC10 0..127. controlChange smooths via
                // setTargetAtTime in the engine.
                const cc = Math.max(0, Math.min(127, Math.round((v + 1) * 63.5)));
                toneEngine.controlChange(ch, 10, cc);
            } else {
                toneEngine.setChannelDecay(ch, v);
            }
        };
        const restore = () => {
            for (const ch of chans) apply(ch, before[ch] ?? (kind === 'pan-move' ? 0 : 1.0));
        };

        // Visual feedback: chase-blink the row sliders while the macro runs.
        // Leaves the displayed slider value alone — the audio animation is
        // independent of the user's UI setting.
        const sliderCls = kind === 'pan-move' ? 'pn-mixer-pan' : 'pn-mixer-decay';
        const sliders = netIds.map(id =>
            this._mixerEl?.querySelector(`.pn-mixer-row[data-net-id="${id}"] .${sliderCls}`)
            || this._mixerEl?.querySelector(`.pn-mixer-row[data-riff-group="${id}"] .${sliderCls}`)
        ).filter(Boolean);
        const cleanupBlink = () => {
            for (const el of sliders) el.classList.remove('pn-pulsing', 'pn-pulsing-hot');
        };

        const token = { cancelled: false, before };
        this._chanAnim[macro.id] = token;

        // Safety net: guaranteed restore + blink cleanup shortly after the
        // expected end even if the rAF loop never completes (orphaned token,
        // tab hidden). Without this the audio param stays stuck at the macro
        // value ("tighten doesn't return").
        token.hardStop = setTimeout(() => {
            if (token.cancelled) return;
            token.cancelled = true;
            restore();
            cleanupBlink();
            if (this._chanAnim[macro.id] === token) this._chanAnim[macro.id] = null;
        }, durationMs + 400);

        const t0 = performance.now();
        const msPerBeat = this._msPerBar() / 4;
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
                if (this._chanAnim[macro.id] === token) this._chanAnim[macro.id] = null;
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
                    // Map sine -1..+1 to a musically useful decay range so the
                    // sweep pulses between snappy and bloomy without ever
                    // hitting the 0.05 clamp or the 3.0 ceiling.
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

    _fxSweep(fxKey, toValue, durationMs) {
        const slider = this._fxSlider(fxKey);
        if (!slider) return;
        if (this._fxAnim && this._fxAnim[fxKey]) this._fxAnim[fxKey].cancelled = true;
        this._fxAnim = this._fxAnim || {};
        const token = { cancelled: false };
        this._fxAnim[fxKey] = token;

        const start = parseFloat(slider.value);
        const t0 = performance.now();
        const rampDown = durationMs * 0.8;
        const DISPATCH_INTERVAL = 120;
        let lastDispatch = -DISPATCH_INTERVAL;

        const step = (now) => {
            if (token.cancelled) return;
            const elapsed = now - t0;
            let v;
            let done = false;
            if (elapsed < rampDown) {
                v = start + (toValue - start) * (elapsed / rampDown);
            } else if (elapsed < durationMs) {
                v = toValue + (start - toValue) * ((elapsed - rampDown) / (durationMs - rampDown));
            } else {
                v = start;
                done = true;
            }
            const dispatch = done || (now - lastDispatch >= DISPATCH_INTERVAL);
            if (dispatch) {
                this._setFxValue(slider, v);
                lastDispatch = now;
            } else {
                // Visual-only update — no input event, no engine dispatch
                slider.value = Math.round(v);
            }
            if (done) { this._fxAnim[fxKey] = null; return; }
            requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }

    // Beat Repeat: fire short Cut-like bursts every `stepTicks` for the full duration.
    _runBeatRepeat(macro, durationMs) {
        const msPerTick = this._msPerBar() / 16;
        const stepMs = (macro.stepTicks || 2) * msPerTick;
        const burstTicks = macro.burstTicks || 1;
        this._beatRepeatRuns = (this._beatRepeatRuns || 0) + 1;
        const myRun = this._beatRepeatRuns;
        let elapsed = 0;
        const fire = () => {
            if (myRun !== this._beatRepeatRuns) return;   // cancelled
            if (elapsed >= durationMs) return;
            const targets = [];
            for (const [id, net] of this._musicNets()) {
                // Keep kick alive so there's still a pulse under the stutter
                if (net.riffGroup === 'kick' || id === 'kick' || id.startsWith('kick:')) continue;
                if (this._mutedNets.has(id)) continue;
                targets.push(id);
            }
            if (targets.length > 0) {
                this._sendWs({
                    type: 'fire-macro',
                    macroId: `beat-repeat-${Date.now().toString(36)}-${elapsed}`,
                    targets,
                    durationTicks: burstTicks,
                    muteAction: 'mute-track',
                    restoreAction: 'unmute-track',
                });
            }
            elapsed += stepMs;
            if (elapsed < durationMs) setTimeout(fire, stepMs);
        };
        fire();
    }

    // Compound: fire a sequence of sub-macros by ID at timed offsets. Bypasses
    // the queue because the parent macro already owns the single running slot.
    _runCompound(macro, duration, durationUnit, msPerTick) {
        for (const step of macro.steps || []) {
            const delay = step.offsetMs || 0;
            setTimeout(() => {
                const sub = MACROS.find(m => m.id === step.macroId);
                if (!sub) return;
                // Push the sub-macro directly (ignore queue, don't mark as running)
                if (sub.kind === 'mute') {
                    const targets = sub.targets(this);
                    if (targets.length === 0) return;
                    const durationTicks = step.durationTicks
                        || (sub.durationUnit === 'tick' ? sub.defaultDuration : sub.defaultDuration * 16);
                    this._sendWs({
                        type: 'fire-macro',
                        macroId: `${sub.id}-${Date.now().toString(36)}`,
                        targets,
                        durationTicks,
                        muteAction: 'mute-track',
                        restoreAction: 'unmute-track',
                    });
                } else if (sub.kind === 'fx-sweep' || sub.kind === 'fx-hold') {
                    const subMs = (step.durationTicks || sub.defaultDuration *
                                   (sub.durationUnit === 'tick' ? 1 : 16)) * msPerTick;
                    const ops = sub.ops || [{ fxKey: sub.fxKey, toValue: sub.toValue }];
                    for (const op of ops) {
                        if (sub.kind === 'fx-sweep') this._fxSweep(op.fxKey, op.toValue, subMs);
                        else                         this._fxHold (op.fxKey, op.toValue, subMs);
                    }
                }
            }, delay);
        }
    }

    // Transient tempo set used during animations — skips localStorage/syncProject
    // to keep a 60fps ramp cheap. Final resting value must use _setTempo so
    // the project JSON and storage stay consistent.
    _setTempoTransient(bpm) {
        const clamped = Math.max(20, Math.min(300, Math.round(bpm)));
        if (this._tempo === clamped) return;
        this._tempo = clamped;
        if (this._project) this._project.tempo = clamped;
        const input = this.querySelector('.pn-tempo input');
        if (input) input.value = clamped;
        this._sendWs({ type: 'tempo', bpm: clamped });
    }

    // Tempo Hold: multiply tempo by factor, hold for duration, restore.
    _tempoHold(factor, durationMs) {
        const startBpm = this._tempo || 120;
        const targetBpm = Math.max(20, Math.round(startBpm * factor));
        this._setTempo(targetBpm);
        setTimeout(() => this._setTempo(startBpm), durationMs);
    }

    // Tape Stop: ease-out ramp down to finalBpm, then snap back.
    //
    // Each tempo message makes the worker restartTimer() (clears + resets
    // setInterval), so dispatching every rAF frame (~60 Hz) thrashes the tick
    // scheduler and can drop ticks. Throttle to ~12 Hz (80 ms) — still plenty
    // smooth for a tape-stop gesture, and 5× kinder to the worker.
    _tempoSweep(finalBpm, durationMs) {
        const startBpm = this._tempo || 120;
        const target = Math.max(20, finalBpm);
        const t0 = performance.now();
        const DISPATCH_INTERVAL = 80;
        let lastDispatch = -DISPATCH_INTERVAL;
        if (this._tempoAnim) this._tempoAnim.cancelled = true;
        const token = { cancelled: false };
        this._tempoAnim = token;
        const step = (now) => {
            if (token.cancelled) return;
            const elapsed = now - t0;
            if (elapsed >= durationMs) {
                this._setTempo(startBpm);   // authoritative final set (also writes localStorage)
                this._tempoAnim = null;
                return;
            }
            if (now - lastDispatch >= DISPATCH_INTERVAL) {
                const t = Math.min(1, elapsed / durationMs);
                const eased = 1 - Math.pow(1 - t, 2);
                const bpm = startBpm + (target - startBpm) * eased;
                this._setTempoTransient(bpm);
                lastDispatch = now;
            }
            requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }

    // fx-hold: jump to toValue, hold, then gradually fade back over the tail.
    // `tailFrac` controls what portion of the duration is release (default 0.6
    // gives a ringing tail after the initial peak).
    //
    // Visual slider updates every rAF but audio-engine dispatch is throttled to
    // ~120 ms so rapid cancelScheduledValues + rampTo(0.1) collisions don't
    // turn the release into a flat / oscillating no-op on the actual filter.
    _fxHold(fxKey, toValue, durationMs, tailFrac = 0.6) {
        const slider = this._fxSlider(fxKey);
        if (!slider) return;
        if (this._fxAnim && this._fxAnim[fxKey]) this._fxAnim[fxKey].cancelled = true;
        this._fxAnim = this._fxAnim || {};
        const token = { cancelled: false };
        this._fxAnim[fxKey] = token;

        const start = parseFloat(slider.value);
        const tailMs = Math.max(50, durationMs * tailFrac);
        const sustainMs = Math.max(0, durationMs - tailMs);

        this._setFxValue(slider, toValue);

        const t0 = performance.now();
        const beginRelease = t0 + sustainMs;
        const endRelease   = t0 + durationMs;
        const DISPATCH_INTERVAL = 120;
        let lastDispatch = t0;   // the initial setFxValue counts as a dispatch

        const step = (now) => {
            if (token.cancelled) return;
            if (now < beginRelease) {
                requestAnimationFrame(step);
                return;
            }
            if (now >= endRelease) {
                this._setFxValue(slider, start);
                this._fxAnim[fxKey] = null;
                return;
            }
            const t = (now - beginRelease) / tailMs;
            const v = toValue + (start - toValue) * t;
            if (now - lastDispatch >= DISPATCH_INTERVAL) {
                this._setFxValue(slider, v);
                lastDispatch = now;
            } else {
                slider.value = Math.round(v);   // visual-only
            }
            requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }

    _cancelAllMacros() {
        this._sendWs({ type: 'cancel-macros' });
        if (this._runningTimer) {
            clearTimeout(this._runningTimer);
            this._runningTimer = null;
        }
        this._runningMacro = null;
        this._macroQueue = [];
        this.querySelectorAll?.('.pn-macro-btn.running, .pn-macro-btn.queued').forEach(b => {
            b.classList.remove('running');
            b.classList.remove('queued');
        });
        this.querySelectorAll?.('.pn-macro-queue-badge').forEach(b => b.remove());
        if (this._fxAnim) {
            for (const token of Object.values(this._fxAnim)) if (token) token.cancelled = true;
            this._fxAnim = {};
        }
    }

    // Push every mixer row's current slider/select values onto the tone engine.
    // Needed after instruments load (strips are just created with defaults).
    _applyMixerStateToEngine() {
        if (!this._mixerEl) return;
        for (const row of this._mixerEl.querySelectorAll('.pn-mixer-row')) {
            const netId = row.dataset.netId;
            const net = this._project?.nets?.[netId];
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

    _loadPadBindings() {
        try {
            const raw = sessionStorage.getItem('pn-pad-bindings');
            if (raw) this._padBindings = new Map(JSON.parse(raw));
        } catch {}
    }

    _savePadBindings() {
        try {
            sessionStorage.setItem('pn-pad-bindings', JSON.stringify([...this._padBindings]));
        } catch {}
    }

    _hitsOptionsHtml(selected, sizeCap) {
        const cap = Math.min(32, Math.max(2, sizeCap));
        let opts = '';
        for (let v = 2; v <= cap; v++) {
            opts += `<option value="${v}"${v === selected ? ' selected' : ''}>${v}</option>`;
        }
        return opts;
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
                    <select class="pn-mixer-slider pn-mixer-vol" data-net-id="${netId}" data-default="80">${
                        Array.from({ length: 101 }, (_, v) =>
                            `<option value="${v}"${v === 80 ? ' selected' : ''}>${v}</option>`
                        ).join('')
                    }</select>
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
            <select class="pn-mixer-output" data-channel="${channel}" title="Audio output device">
                <option value="">Master</option>
            </select>
            ${this._patternSelectsHtml(net, id)}
            ${this._mixerSlidersHtml(id, isDrumChannel(channel))}
            <button class="pn-mixer-save" data-net-id="${id}" title="Save / load tone presets for this track">&#9733;</button>
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
            const drumRole = isDrumChannel(ch) ? (net.riffGroup || row.dataset.riffGroup || netId) : null;

            for (const [cls, key, applyFactory] of MIXER_SLIDERS) {
                const el = row.querySelector(`.${cls}`);
                const val = state[key];
                if (el && val != null) {
                    el.value = val;
                    applyFactory(ch, drumRole)(parseInt(val));
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

    // Mark each range slider's default value with a CSS custom property so the
    // stylesheet can paint a tick on the track via a linear-gradient background.
    // No absolute pixel math, no DOM children — percentage scales naturally if
    // the slider resizes and can't drift out of place on re-render.
    _addDefaultNotches(container) {
        container.querySelectorAll('input[type="range"][data-default]').forEach(slider => {
            const def = parseFloat(slider.dataset.default);
            const min = parseFloat(slider.min);
            const max = parseFloat(slider.max);
            if (!Number.isFinite(def) || max === min) return;
            const pct = Math.max(0, Math.min(100, ((def - min) / (max - min)) * 100));
            slider.style.setProperty('--default-pct', pct + '%');
        });
        // Clean up any legacy DOM notches from earlier versions
        container.querySelectorAll('.pn-slider-notch').forEach(n => n.remove());
    }

    _toneReset(netId) {
        const row = this._mixerEl?.querySelector(`.pn-mixer-row[data-net-id="${netId}"]`);
        if (!row) return;
        const net = this._project.nets[netId];
        if (!net) return;
        const ch = net.track?.channel || 1;
        const isPerc = isDrumChannel(ch);
        const drumRole = isPerc ? (net.riffGroup || row.dataset.riffGroup || netId) : null;
        const defaults = { locut: '0', lores: '5', cut: '100', res: '5', dec: isPerc ? '100' : '5' };
        for (const [cls, key, applyFactory] of MIXER_SLIDERS) {
            if (key === 'vol' || key === 'pan') continue;
            const el = row.querySelector(`.${cls}`);
            if (el && defaults[key] != null) {
                el.value = defaults[key];
                applyFactory(ch, drumRole)(parseInt(defaults[key]));
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
                // Don't overwrite vol/pan from random configs
                if (key === 'vol' || key === 'pan') continue;
                const el = row.querySelector(`.${cls}`);
                if (el && s[key] != null) {
                    el.value = s[key];
                    applyFactory(ch, drumRole)(parseInt(s[key]));
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
        // Window resize
        window.addEventListener('resize', () => this._resizeCanvas());

        // Transport controls
        this.querySelector('.pn-play').addEventListener('click', () => this._togglePlay());
        this._populateAudioOutputs();
        if (navigator.mediaDevices?.addEventListener) {
            navigator.mediaDevices.addEventListener('devicechange', () => this._populateAudioOutputs());
        }
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
        const isControl = !!trans.control && !trans.midi;
        let badge = '';
        if (trans.midi) {
            badge = `<div class="pn-midi-badge" title="Click to edit note (${trans.midi.note})">${this._noteToName(trans.midi.note)}</div>`;
        } else if (!isControl) {
            badge = `<div class="pn-midi-badge pn-midi-badge--empty" title="Click to add MIDI note">+</div>`;
        }
        el.innerHTML = `
            <div class="pn-transition-rect"></div>
            ${badge}
            ${tLabel ? `<div class="pn-label">${tLabel}</div>` : ''}
        `;

        const badgeEl = el.querySelector('.pn-midi-badge');
        if (badgeEl) {
            badgeEl.addEventListener('click', (e) => {
                e.stopPropagation();
                this._openMidiEditor(id);
            });
        }

        this._stage.appendChild(el);
        this._nodes[id] = el;
    }

    _noteToName(note) {
        const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const octave = Math.floor(note / 12) - 1;
        return names[note % 12] + octave;
    }

    _nameToNote(name) {
        if (typeof name !== 'string') return null;
        const m = name.trim().match(/^([A-Ga-g])([#b]?)(-?\d+)$/);
        if (!m) return null;
        const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()];
        const accidental = m[2] === '#' ? 1 : (m[2] === 'b' ? -1 : 0);
        const octave = parseInt(m[3], 10);
        const note = base + accidental + (octave + 1) * 12;
        if (note < 0 || note > 127) return null;
        return note;
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

        // Auto-DJ spin: rotate only the ring layer (arcs + places + transitions)
        // around the average centroid of the active net's places. Anything
        // drawn after ctx.restore() (particles, beat indicators, timeline)
        // stays in world-space so the timeline / dots don't rotate with it.
        const spin = this._autoDjAngleDeg || 0;
        if (spin !== 0) {
            const places = net.places || {};
            let sx = 0, sy = 0, n = 0;
            for (const p of Object.values(places)) { sx += p.x; sy += p.y; n++; }
            if (n > 0) {
                const cx = sx / n, cy = sy / n;
                ctx.translate(cx, cy);
                ctx.rotate(spin * Math.PI / 180);
                ctx.translate(-cx, -cy);
            }
        }

        // Draw arcs
        ctx.strokeStyle = '#4a90d9';
        ctx.lineWidth = 2 / this._view.scale;

        const reverseArrows = !!this._autoDjReverse;
        for (const arc of net.arcs) {
            const srcNode = net.places[arc.source] || net.transitions[arc.source];
            const trgNode = net.places[arc.target] || net.transitions[arc.target];
            if (!srcNode || !trgNode) continue;

            ctx.beginPath();
            ctx.moveTo(srcNode.x, srcNode.y);
            ctx.lineTo(trgNode.x, trgNode.y);
            ctx.stroke();

            // Draw arrowhead — flipped when Auto-DJ has spun the ring CCW, so
            // arrow direction matches the visual rotation direction.
            if (reverseArrows) {
                this._drawArrowhead(ctx, trgNode.x, trgNode.y, srcNode.x, srcNode.y);
            } else {
                this._drawArrowhead(ctx, srcNode.x, srcNode.y, trgNode.x, trgNode.y);
            }

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

    // Diagram is read-only — no panning, dragging, or zooming
    _onPointerDown(e) {}
    _onPointerMove(e) {}
    _onPointerUp(e) {}
    _onWheel(e) {}

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
            setFx('master-pitch', proj.fx.masterPitch);
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
        this._reapplyChannelRoutings();
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

        // Compact: strip x/y, tokens, and default values from nets
        for (const [netId, net] of Object.entries(proj.nets)) {
            const ch = net.track?.channel || 1;
            const defVel = net.track?.defaultVelocity || 100;

            // Strip defaultVelocity if 100
            if (net.track?.defaultVelocity === 100) delete net.track.defaultVelocity;

            // Compact places
            for (const [id, place] of Object.entries(net.places || {})) {
                delete place.x; delete place.y; delete place.tokens;
                delete place['@type'];
                const initSum = (place.initial || [0]).reduce((a, b) => a + b, 0);
                if (initSum === 0) delete place.initial;
            }

            // Compact transitions
            for (const [id, trans] of Object.entries(net.transitions || {})) {
                delete trans.x; delete trans.y;
                if (trans.midi) {
                    if (trans.midi.channel === ch) delete trans.midi.channel;
                    if (trans.midi.velocity === defVel) delete trans.midi.velocity;
                    if (trans.midi.duration === 100) delete trans.midi.duration;
                }
            }

            // Compact arcs
            for (const arc of (net.arcs || [])) {
                if (arc.weight && arc.weight.length === 1 && arc.weight[0] === 1) delete arc.weight;
                if (!arc.inhibit) delete arc.inhibit;
            }

            // Strip internal fields
            delete net['@type'];
            delete net.connections;

            // Capture mix from sliders
            if (net.track) {
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
        }

        // Strip top-level internal fields
        delete proj['@context']; delete proj['@type']; delete proj.connections;

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
            masterPitch: fxVal('master-pitch'),
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
        const trackCh = net.track?.channel || 1;
        const trackVel = net.track?.defaultVelocity || 100;
        const src = trans.midi || {};
        const midi = {
            note: Number.isFinite(src.note) ? src.note : 60,
            channel: Number.isFinite(src.channel) ? src.channel : trackCh,
            velocity: Number.isFinite(src.velocity) ? src.velocity : trackVel,
            duration: Number.isFinite(src.duration) ? src.duration : 100,
        };

        const overlay = document.createElement('div');
        overlay.className = 'pn-modal-overlay';
        overlay.innerHTML = `
            <div class="pn-modal">
                <h2>MIDI Binding: ${trans.label || transitionId}</h2>
                <div class="pn-modal-row">
                    <label>Note</label>
                    <input type="number" name="note" value="${midi.note}" min="0" max="127"/>
                    <input type="text" name="noteName" value="${this._noteToName(midi.note)}" size="4" title="Note name (e.g. C4, F#3, Bb5)"/>
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

        // Bidirectional sync between note number and name
        const noteInput = overlay.querySelector('input[name="note"]');
        const noteName = overlay.querySelector('input[name="noteName"]');
        noteInput.addEventListener('input', () => {
            const n = parseInt(noteInput.value, 10);
            if (Number.isFinite(n)) noteName.value = this._noteToName(n);
        });
        noteName.addEventListener('input', () => {
            const n = this._nameToNote(noteName.value);
            if (n !== null) {
                noteInput.value = n;
                noteName.classList.remove('pn-invalid');
            } else {
                noteName.classList.add('pn-invalid');
            }
        });
        noteName.addEventListener('blur', () => {
            const n = parseInt(noteInput.value, 10);
            if (Number.isFinite(n)) {
                noteName.value = this._noteToName(n);
                noteName.classList.remove('pn-invalid');
            }
        });

        // Wheel on any value field bumps the value up/down (prevents page scroll)
        overlay.addEventListener('wheel', (e) => {
            const target = e.target;
            let numInput = null;
            if (target === noteName) numInput = noteInput;
            else if (target.tagName === 'INPUT' && target.type === 'number') numInput = target;
            if (!numInput) return;
            e.preventDefault();
            const step = e.deltaY < 0 ? 1 : -1;
            const min = parseInt(numInput.min, 10);
            const max = parseInt(numInput.max, 10);
            let v = parseInt(numInput.value, 10);
            if (!Number.isFinite(v)) v = Number.isFinite(min) ? min : 0;
            v += step;
            if (Number.isFinite(min) && v < min) v = min;
            if (Number.isFinite(max) && v > max) v = max;
            numInput.value = v;
            numInput.dispatchEvent(new Event('input', { bubbles: true }));
        }, { passive: false });

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
        const save = () => {
            this._pushHistory();
            trans.midi = {
                note: parseInt(overlay.querySelector('input[name="note"]').value, 10),
                channel: parseInt(overlay.querySelector('input[name="channel"]').value, 10),
                velocity: parseInt(overlay.querySelector('input[name="velocity"]').value, 10),
                duration: parseInt(overlay.querySelector('input[name="duration"]').value, 10)
            };
            overlay.remove();
            this._renderNet();
            this._syncProject();
            this._sendWs({ type: 'project-load', project: this._project });
        };
        overlay.querySelector('.save').addEventListener('click', save);

        // Keyboard: Enter saves, Escape cancels
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); save(); }
            else if (e.key === 'Escape') { e.preventDefault(); overlay.remove(); }
        });
        noteInput.focus();
        noteInput.select();

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
                input.onmidimessage = (e) => this._handleMidiMessage(e);
            }
            // Listen for new devices plugged in
            midi.onstatechange = () => {
                for (const input of midi.inputs.values()) {
                    if (!input.onmidimessage) {
                        input.onmidimessage = (e) => this._handleMidiMessage(e);
                    }
                }
            };
            this._midiInputConnected = true;
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

    _handleMidiMessage(event) {
        const [status, data1, data2] = event.data;
        const type = status & 0xF0;
        if (type === 0xB0) return this._handleMidiCC(data1, data2);
        if (type === 0x90 && data2 > 0) return this._handleMidiNoteOn(data1);
        // Ignore Note Off (0x80) and velocity-0 Note On (release) — macros are one-shot
    }

    _handleMidiCC(cc, value) {
        // If hovering over a slider, bind this CC to it
        if (this._hoveredSlider && !this._ccBindings.has(cc)) {
            const binding = this._sliderBindingKey(this._hoveredSlider);
            if (binding) {
                this._ccBindings.set(cc, binding);
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

    _handleMidiNoteOn(note) {
        // Bind on hover
        if (this._hoveredMacro && !this._padBindings.has(note)) {
            const macroId = this._hoveredMacro.dataset.macro;
            this._padBindings.set(note, macroId);
            this._savePadBindings();
            const btn = this._hoveredMacro;
            btn.style.outline = '2px solid #64ffda';
            setTimeout(() => { btn.style.outline = ''; }, 300);
            return;
        }
        const macroId = this._padBindings.get(note);
        if (macroId) this._fireMacro(macroId);
    }

    async _ensureToneStarted() {
        if (this._toneStarted) return;
        if (this._toneInitPromise) return this._toneInitPromise;
        this._toneInitPromise = (async () => {
            try {
                await toneEngine.init();
                // Apply initial master volume from slider (default 80% = -12 dB)
                const initVol = parseInt(this.querySelector('[data-fx="master-vol"]')?.value || '80');
                const initDb = initVol === 0 ? -60 : -60 + (initVol / 100) * 60;
                toneEngine.setMasterVolume(initDb);
                this._toneStarted = true;
                // Keep banner in sync with context state
                const ctx = window.Tone?.context?.rawContext;
                if (ctx && !this._ctxListenerBound) {
                    this._ctxListenerBound = true;
                    ctx.addEventListener('statechange', () => {
                        if (this._playing && ctx.state !== 'running') this._showAudioLockBanner();
                        else this._hideAudioLockBanner();
                    });
                }
                // If auto-play triggered init without a user gesture, context stays suspended.
                if (ctx && ctx.state !== 'running' && this._playing) {
                    this._showAudioLockBanner();
                }
                const loads = Object.entries(this._channelInstruments).map(
                    ([ch, inst]) => toneEngine.loadInstrument(parseInt(ch), inst)
                );
                await Promise.all(loads);
                // Channel strips now exist — push the current mixer state onto them
                // (initial vol/pan was silently dropped before strips were created).
                this._applyMixerStateToEngine();
                await this._reapplyChannelRoutings();
                this._populateAudioOutputs();
            } catch (e) {
                console.error('Failed to start Tone.js:', e);
            }
        })();
        return this._toneInitPromise;
    }

    _showQuickstartModal() {
        this.querySelector('.pn-help-overlay')?.remove();
        const overlay = document.createElement('div');
        overlay.className = 'pn-help-overlay pn-quickstart-overlay';
        overlay.innerHTML = `
            <div class="pn-help-modal">
                <button class="pn-help-close">&times;</button>
                <h2>Welcome to Petri Note</h2>
                <p style="color:#ccc;margin:0 0 14px">
                    A deterministic beat generator. Every note is a Petri net transition firing — tokens circulate, rhythms emerge.
                </p>
                <ol style="line-height:1.7">
                    <li>Pick a <b>Genre</b> and hit <b>Generate</b></li>
                    <li>Press <b>Play</b> (Space) to listen</li>
                    <li>Open the <b>Macros</b> panel next to FX for live tricks: Drop, Sweep LP, Reverb Wash, Tape Stop &hellip;</li>
                    <li>Every slider and dropdown: hover + scroll to fine-tune</li>
                    <li>Click <b>?</b> any time for the full guide</li>
                </ol>
                <div style="display:flex;gap:10px;margin-top:18px">
                    <button class="pn-quickstart-start" style="flex:1;padding:10px;background:#e94560;border:none;color:#fff;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600">Get Started</button>
                    <button class="pn-quickstart-guide" style="flex:1;padding:10px;background:#1a1a2e;border:1px solid #0f3460;color:#eee;border-radius:6px;cursor:pointer;font-size:14px">Open Full Guide</button>
                </div>
            </div>
        `;
        const dismiss = () => {
            localStorage.setItem('pn-quickstart-seen', '1');
            overlay.remove();
        };
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay || e.target.closest('.pn-help-close') || e.target.closest('.pn-quickstart-start')) {
                dismiss();
            } else if (e.target.closest('.pn-quickstart-guide')) {
                dismiss();
                this._showHelpModal();
            }
        });
        // Attach to body so _buildUI's innerHTML reset doesn't wipe it
        document.body.appendChild(overlay);
    }

    _showHelpModal() {
        this.querySelector('.pn-help-overlay')?.remove();
        const overlay = document.createElement('div');
        overlay.className = 'pn-help-overlay';
        overlay.tabIndex = -1;
        overlay.innerHTML = `
            <div class="pn-help-modal">
                <button class="pn-help-close" title="Close (Esc)">&times;</button>
                <h2>Performance Guide</h2>

                <h3>Getting Started</h3>
                <ul>
                    <li><b>Generate</b> a track, then hit <b>Play</b></li>
                    <li>Click the arrow next to Play to cycle playback modes: once &rarr; repeat &rarr; shuffle</li>
                    <li>Pick a <b>Structure</b> (Standard, Drop, etc.) for tracks with sections and a timeline</li>
                    <li><b>&star;</b> on any mixer row opens its Preset Manager to save / apply / delete tone presets (pan, vol, filters, decay) &mdash; saved to browser storage, scoped by channel</li>
                </ul>

                <h3>Tabs</h3>
                <p style="margin:0 0 8px;color:#aaa;font-size:0.92em">The four toggle buttons above the mixer &mdash; <b>FX</b>, <b>Macros</b>, <b>Beats</b>, <b>Auto-DJ</b> &mdash; each open independently. Stacked top-to-bottom in that order.</p>

                <h3>Macros (live tricks)</h3>
                <p style="margin:0 0 8px;color:#aaa;font-size:0.92em">Macros queue serially &mdash; tapping while another runs adds it to the queue (orange badge shows depth). Click the same one to extend. Every macro pulses the UI element it touches in a chase pattern and returns that element to its pre-macro value on release.</p>
                <ul>
                    <li><b>Mute</b>: Drop, Breakdown, Solo Drums, Cut, Beat Repeat, Double Drop</li>
                    <li><b>FX</b>: Sweep LP / HP, Reverb Wash, Delay Throw, Riser, Bit Crush, Phaser Drone, <b>Cathedral</b> (long bright reverb), <b>Dub Delay</b> (longer/heavier feedback), <b>Res Ping</b> (LP+drive slam)</li>
                    <li><b>Pitch</b>: Octave Up / Down, Pitch Bend, Vinyl Brake</li>
                    <li><b>Tempo</b>: Half Time, Tape Stop</li>
                    <li><b>Pan</b> (non-drum tracks only): <b>Ping-Pong</b> (hard L/R every beat), <b>Hard Left / Right</b> (hold to one side), <b>Auto-Pan</b> (slow sinusoidal LFO), <b>Mono</b> (force center). Each track restores to the pan you had set before firing.</li>
                    <li><b>Shape</b> (per-channel decay): <b>Tighten</b> snaps tails shut, <b>Loosen</b> blooms them out, <b>Pulse</b> breathes decay in/out on a 2-beat sine. All restore per-channel to the user's pre-macro decay on release.</li>
                </ul>

                <h3>Beats (stinger fire pads)</h3>
                <p style="margin:0 0 8px;color:#aaa;font-size:0.92em">The <b>Beats</b> tab exposes four reserved stinger slots (<code>hit1</code>&ndash;<code>hit4</code>) that also exist as real muted tracks below a <b>Stingers</b> divider in the main mixer when the tab is open. Each fires on every beat via its own Petri net, so unmuting the track produces a steady stinger pulse.</p>
                <ul>
                    <li>Pick any instrument on the hit row &mdash; curated set of airhorn / laser / subdrop / booj stingers, plus percussion, stabs, bells, bass hits, short leads</li>
                    <li>Pick <b>Unbound</b> to silence the slot while keeping the net running (useful for pairing macros without sound)</li>
                    <li>The <b>Fire</b> pad manually triggers the slot via the track's channel (vol / pan / filter apply, bypasses mute)</li>
                    <li><b>Pit</b> dropdown transposes in semitones &mdash; also applied by the row's test-note (&#9835;) button</li>
                    <li><b>FX</b> dropdown pairs any macro with the Fire click &mdash; sound + effect in one tap</li>
                    <li><b>&raquo;</b> on a hit's mixer row cycles through non-percussion instruments</li>
                </ul>

                <h3>Auto-DJ</h3>
                <p style="margin:0 0 8px;color:#aaa;font-size:0.92em">Hands-free performer. Arm with <b>Run</b>; every N bars it picks a random macro from the checked pools and fires it. The petri-net ring swings ±90&deg; on every fire (arrowheads flip on CCW passes so tokens visually follow the spin).</p>
                <ul>
                    <li><b>Every</b> — cadence of fires (1 / 2 / 4 / 8 / 16 / 32 / 64 / 128 / 256 / 512 / 1024 bars, each label shows its beat count)</li>
                    <li><b>Animate only</b> — spin the ring on cadence without firing any macros (works even while another macro is running)</li>
                    <li><b>Pools</b> checkboxes — Mute / FX / Pan / Shape / Pitch / Tempo / Beats. If every pool is unchecked the ring still spins with <code>(no candidates)</code> in the status line</li>
                    <li><b>Stack</b> 1 / 2 / 3 — fires that many simultaneously each cycle (stack members bypass the serial queue; cycles are skipped entirely if a user-fired macro is already running)</li>
                    <li><b>Regen</b> — every N bars (off / 8 / 16 / 32 / 64 / 128 / 256 / 512 / 1024) Auto-DJ kicks off a new Generate. The next project is pre-rendered one bar early for a seamless swap</li>
                    <li>Status line shows the last picks, pre-load activity, or why a cycle was skipped</li>
                    <li><b>Right-click any macro tile</b> to mark it disabled — Auto-DJ skips disabled macros (line-through mark, persisted)</li>
                </ul>

                <h3>MIDI Pad &amp; CC Learn</h3>
                <ul>
                    <li>Toggle <b>MIDI</b> (top right) to enable Web MIDI and per-track audio-output routing</li>
                    <li><b>CC</b>: hover a slider, move a MIDI CC knob &rarr; binds it. Use <b>CC Reset</b> to clear</li>
                    <li><b>Pads</b>: hover a Macro button, press a pad (Note On) &rarr; binds it. Subsequent presses fire the macro</li>
                </ul>

                <h3>Per-Track Controls</h3>
                <ul>
                    <li><b>Size / Hits</b> dropdowns (2&ndash;32) live-regenerate the Petri subnet for that track. Change on the active variant only.</li>
                    <li><b>Instrument</b> dropdown swaps the synth mid-loop</li>
                    <li><b>&raquo;</b> rotates through the current genre's instrument set</li>
                    <li>Slider group: Pan / Vol / HP / HPR / LP / LPR / Dec &mdash; hover and scroll to fine-tune (1% per tick)</li>
                    <li><b>&#9835;</b> test note, <b>&#8634;</b> reset, <b>&lsaquo; &rsaquo;</b> prev/next tone variation</li>
                </ul>

                <h3>Filter &amp; FX</h3>
                <ul>
                    <li><b>LP sweep down</b> / <b>HP sweep up</b> &mdash; darken or thin the mix; release for impact</li>
                    <li><b>Reverb wash</b> / <b>Delay throw</b> &mdash; crank wet Mix, then cut for freeze/echo tail</li>
                    <li><b>Distortion rise</b> &mdash; slowly bring up Drive, kill for release</li>
                    <li><b>Bypass</b> &mdash; instant wet/dry comparison</li>
                    <li><b>Phaser / Bit crush</b> &mdash; motion and lo-fi degradation</li>
                </ul>

                <h3>Loop &amp; Timeline</h3>
                <ul>
                    <li><b>Click</b> the timeline to seek</li>
                    <li><b>Right-click</b> to snap the nearest loop marker</li>
                    <li><b>Drag</b> the orange markers (snaps to bars)</li>
                    <li><b>Crop</b> (scissors) &mdash; trim the track to just the loop</li>
                </ul>

                <h3>Traits &amp; Genre</h3>
                <ul>
                    <li>Click any genre trait chip (Fills, Syncopation, Ghosts, etc.) to open its editor &mdash; toggle on/off or tune percentages</li>
                    <li>Traits reshape the next Generate</li>
                </ul>

                <h3>MIDI Note Editor</h3>
                <ul>
                    <li>Click any note badge on a transition (the small <b>C4</b>-style chip) to open the binding editor</li>
                    <li>Edit note as integer <i>or</i> name (C4, F#3, Bb5) &mdash; they stay in sync</li>
                    <li>Scroll over any field to nudge by 1</li>
                </ul>

                <h3>Keyboard</h3>
                <ul>
                    <li><b>Space</b> &mdash; Play / Stop</li>
                    <li><b>Esc</b> &mdash; close any open modal</li>
                    <li><b>Arrow keys</b> &mdash; nudge sliders when focused</li>
                    <li><b>Scroll</b> &mdash; fine-tune any slider, number, or dropdown under the cursor</li>
                </ul>

                <h3>Built With</h3>
                <p style="margin:0 0 8px;color:#aaa;font-size:0.92em">The sequencer is a <b>Petri net</b> executor &mdash; every note is a transition firing, every rhythm is tokens circulating. Macros inject transient control nets that fire their restore action on a tick-locked terminal transition.</p>
                <ul>
                    <li><b><a href="https://tonejs.github.io/" target="_blank" rel="noopener" style="color:#0af">Tone.js</a></b> &mdash; turns transition firings into sound</li>
                    <li><b>Bjorklund's algorithm</b> &mdash; generates Euclidean rhythms as token rings</li>
                </ul>
            </div>
        `;
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay || e.target.closest('.pn-help-close')) {
                overlay.remove();
            }
        });
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.preventDefault(); overlay.remove(); }
        });
        this.appendChild(overlay);
        overlay.focus();
    }

    async _toggleAudioMode(mode) {
        if (this._audioModes.has(mode)) {
            this._audioModes.delete(mode);
            // Clear per-channel pins of the now-disabled kind
            const kind = mode === 'web-audio' ? 'audio' : 'midi';
            for (const [ch, routing] of [...this._channelRouting.entries()]) {
                if (routing.kind === kind) {
                    await this._setChannelRouting(ch, '');
                    sessionStorage.removeItem(`pn-channel-routing-${ch}`);
                }
            }
        } else {
            this._audioModes.add(mode);
        }
        this.querySelectorAll('.pn-audio-mode button').forEach(btn => {
            btn.classList.toggle('active', this._audioModes.has(btn.dataset.mode));
        });
        this.classList.toggle('pn-midi-enabled', this._audioModes.has('web-midi'));

        if (this._audioModes.has('web-midi')) {
            this._refreshMidiOutputs().then(() => this._populateAudioOutputs());
        } else {
            this._populateAudioOutputs();
        }
    }

    async _refreshMidiOutputs() {
        if (!navigator.requestMIDIAccess) {
            console.warn('Web MIDI not supported');
            return;
        }

        try {
            this._midiAccess = await navigator.requestMIDIAccess();
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
        // Drop notes while AudioContext is suspended — otherwise they queue up
        // and fire in a burst when the context resumes, blowing polyphony.
        if (this._toneStarted && !toneEngine.isContextRunning()) {
            return;
        }

        const routing = this._channelRouting.get(channel);
        if (routing?.kind === 'midi') {
            await this._playWebMidi(midi, routing.id);
            return;
        }
        if (routing?.kind === 'audio') {
            await this._playTone(midi);
            return;
        }

        // Global fallback: honor whichever modes are enabled
        if (this._audioModes.has('web-audio')) {
            await this._playTone(midi);
        } else if (this._audioModes.has('web-midi')) {
            await this._playWebMidi(midi);
        }
    }

    async _reapplyChannelRoutings() {
        if (!this._toneStarted) return;
        for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            const m = key && key.match(/^pn-channel-routing-(\d+)$/);
            if (!m) continue;
            const ch = parseInt(m[1], 10);
            const val = sessionStorage.getItem(key);
            if (val) await this._setChannelRouting(ch, val);
        }
    }

    async _setChannelRouting(channel, value) {
        // value: '' | 'audio:<deviceId>' | 'midi:<portId>'
        if (!value) {
            this._channelRouting.delete(channel);
            try { await toneEngine.setChannelOutputDevice(channel, ''); } catch (err) { console.warn(err); }
            return;
        }
        const sep = value.indexOf(':');
        const kind = value.slice(0, sep);
        const id = value.slice(sep + 1);

        if (kind === 'audio') {
            this._channelRouting.set(channel, { kind, id });
            try { await toneEngine.setChannelOutputDevice(channel, id); }
            catch (err) { console.warn('setChannelOutputDevice failed:', err); }
        } else if (kind === 'midi') {
            if (!this._midiAccess) await this._refreshMidiOutputs();
            this._channelRouting.set(channel, { kind, id });
            // Release any audio-sink routing for this channel (no local synth output)
            try { await toneEngine.setChannelOutputDevice(channel, ''); } catch {}
        }
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

    async _playWebMidi(midi, portIdOverride) {
        if (!this._midiAccess) {
            await this._refreshMidiOutputs();
        }

        const portId = portIdOverride || this._midiOutputId;
        if (!this._midiAccess || !portId) {
            console.warn('No MIDI output selected');
            return;
        }

        const output = this._midiAccess.outputs.get(portId);
        if (!output) {
            console.warn('MIDI output not found:', portId);
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

        // Subtle default pan spread per track role so the Mono / Pan macros
        // have something to collapse/flip. Users can still override via the
        // mixer pan slider — these only paint the starting point.
        this._applyDefaultPans(nets);
    }

    _applyDefaultPans(nets) {
        // CC10 values: 64 = center. Offsets below are gentle (±24 max) so a
        // default project still sounds natural, but Mono / Ping-Pong produce
        // an audible change.
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

    /**
     * Apply a buffered project-sync (called immediately or at bar boundary)
     */
    _applyProjectSync(project, seamless = false) {
        // Cancel any in-flight macro animations — their tokens reference DOM
        // nodes about to be replaced and channels whose snapshots no longer
        // apply. Without this, chase-pulse classes can stick on detached
        // elements and pan/decay restores can fire against a fresh project's
        // state with stale "before" values.
        if (this._chanAnim) {
            for (const id of Object.keys(this._chanAnim)) {
                const t = this._chanAnim[id];
                if (t) { t.cancelled = true; if (t.hardStop) clearTimeout(t.hardStop); }
            }
            this._chanAnim = {};
        }
        if (this._pulseAnim) {
            for (const id of Object.keys(this._pulseAnim)) {
                const t = this._pulseAnim[id];
                if (t) t.cancelled = true;
            }
            this._pulseAnim = {};
        }
        // Clear any leftover pulse classes so the new mixer rows render clean.
        this.querySelectorAll('.pn-pulsing, .pn-pulsing-hot').forEach(el => {
            el.classList.remove('pn-pulsing', 'pn-pulsing-hot');
        });
        // Auto-DJ preview bookkeeping resets with the project
        this._autoDjPreviewPending = false;

        this._project = project;
        this._normalizeProject();
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
        this._reapplyChannelRoutings();
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
        // Re-render traits now that genre dropdown is restored
        this._updateTraits();
        if (this._firstLoad) {
            // Initial page load — don't auto-play (browser blocks audio without a gesture)
            this._firstLoad = false;
            this._sendWs({ type: 'project-load', project: this._project });
            this._playing = false;
            const playBtn = this.querySelector('.pn-play');
            if (playBtn) playBtn.innerHTML = '&#9654;';
            return;
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
        this._reapplyChannelRoutings();
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

        // After resume() settles, check if the context actually unlocked.
        if (this._playing) {
            setTimeout(() => {
                if (this._playing && !toneEngine.isContextRunning()) {
                    this._showAudioLockBanner();
                } else {
                    this._hideAudioLockBanner();
                }
            }, 150);
        } else {
            this._hideAudioLockBanner();
        }
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
            // Cancel any pending macro restores — worker will reset mute state anyway
            this._cancelAllMacros();
            // Reset playhead to loop start (or beginning if no loop)
            this._tick = this._loopStart > 0 ? this._loopStart : 0;
            this._lastPlayheadPct = null;
            this._updatePlayhead();
            this._draw(); // restore static view
            this._releaseWakeLock();
        }

        this._sendWs({ type: 'transport', action: this._playing ? 'play' : 'stop' });
        this._updateMediaSessionState();
    }

    _showAudioLockBanner() {
        if (this._audioLockBanner) return;
        const banner = document.createElement('div');
        banner.className = 'pn-audio-lock-banner';
        banner.innerHTML = '<span>Audio is blocked by the browser.</span><button>Click to enable</button>';
        banner.querySelector('button').addEventListener('click', async () => {
            toneEngine.resumeContext();
            await this._ensureToneStarted();
            // Clear any notes that may have been scheduled pre-resume
            try { toneEngine.panic?.(); } catch {}
            if (toneEngine.isContextRunning()) this._hideAudioLockBanner();
        });
        this.appendChild(banner);
        this._audioLockBanner = banner;
    }

    _hideAudioLockBanner() {
        if (!this._audioLockBanner) return;
        this._audioLockBanner.remove();
        this._audioLockBanner = null;
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

    // === Backend: Worker (default) or WebSocket (data-backend="ws") ===
    //
    // The WS path is a client-side stub for a planned feature: a remote
    // conductor (separate service / repo) driving the front-end by streaming
    // sequencer messages over `/ws`. All worker message types
    // (`generate`, `project-load`, `transport`, `tempo`, `mute`, `mute-group`,
    // `fire-macro`, `update-track-pattern`, `cancel-macros`, `transition-fire`,
    // `loop`, `seek`, `crop`, `deterministic-loop`, `shuffle-instruments`) must
    // be proxied verbatim by any WS implementation so the client needs no
    // backend-specific branches beyond connection management.
    // Responses the client expects: `ready`, `project-sync`, `state-sync`,
    // `mute-state`, `tempo-changed`, `transition-fired`, `control-fired`,
    // `instruments-changed`, `track-pattern-updated`, `track-pattern-error`,
    // `preview-ready`, `playback-complete`.
    // The Go server in this repo does NOT implement /ws today — it's a pure
    // static file server. The remote-conductor service lives (or will live)
    // in a separate repo and is exercised via end-to-end tests there.

    _connectBackend() {
        if (this.dataset.backend === 'ws') {
            this._connectWebSocket();
        } else {
            this._connectWorker();
        }
    }

    _connectWorker() {
        this._worker = new Worker('./sequencer-worker.js?v=11', { type: 'module' });

        this._worker.onmessage = (e) => {
            const msg = e.data;
            if (msg.type === 'ready') {
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

    _connectWebSocket() {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${location.host}/ws`;

        try {
            this._ws = new WebSocket(wsUrl);

            this._ws.onopen = () => {
                this._updateWsStatus(true);
                if (!this._hasInitialProject) {
                    this._hasInitialProject = true;
                    this._sendWs({ type: 'generate', genre: 'techno', params: {} });
                } else {
                    this._sendWs({ type: 'project-load', project: this._project });
                }
            };

            this._ws.onmessage = (event) => {
                this._handleWsMessage(JSON.parse(event.data));
            };

            this._ws.onclose = () => {
                this._updateWsStatus(false);
                this._scheduleReconnect();
            };

            this._ws.onerror = (err) => {
                console.error('WebSocket error:', err);
            };
        } catch (e) {
            console.warn('WebSocket connection failed:', e);
            this._updateWsStatus(false);
        }
    }

    _scheduleReconnect() {
        if (this._wsReconnectTimer) return;
        this._wsReconnectTimer = setTimeout(() => {
            this._wsReconnectTimer = null;
            this._connectWebSocket();
        }, 3000);
    }

    _updateWsStatus(connected) {
        // Infer from actual state when called with no args (e.g. after UI rebuild)
        if (connected === undefined) {
            connected = this._ws?.readyState === WebSocket.OPEN;
        }
        const el = this.querySelector('.pn-ws-status');
        if (!el) return;
        el.className = `pn-ws-status ${connected ? 'connected' : 'disconnected'}`;
        el.innerHTML = connected ? '&#9679; Connected' : '&#9679; Disconnected';
    }

    _sendWs(msg) {
        if (this._ws?.readyState === WebSocket.OPEN) {
            this._ws.send(JSON.stringify(msg));
        } else if (this._worker) {
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
                this._fireRepeatingOneShots(prevTick, this._tick);
                this._autoDjTick(prevTick, this._tick);
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
            case 'track-pattern-updated':
                if (this._project && this._project.nets && msg.netId && msg.net) {
                    this._project.nets[msg.netId] = msg.net;
                    this._normalizeNet(msg.net);
                    this._renderMixer();
                    if (msg.netId === this._activeNetId) this._renderNet();
                }
                break;
            case 'track-pattern-error':
                console.warn('[petri-note] track-pattern-error', msg.netId, msg.error);
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

        // Play sound locally
        if (midi) {
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
