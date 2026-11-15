// Macro catalog — data-only definitions for every live-performance macro
// (mute/FX/pan/shape/pitch/tempo/one-shot) the element can fire.
//
// Each entry computes a set of target netIds to affect, picks how long the
// affected state should last (in ticks), and sends a single `fire-macro`
// message to the worker. The worker applies the immediate side effect
// (e.g. mute) synchronously, then injects a small linear-chain control net
// that fires the restore action on its final transition — tick-locked.
//
// Target selection uses the current mutedNets snapshot to skip anything the
// user has already muted, so the restore never unmutes a user-intended mute.

import { isDrumChannel } from '../../audio/instruments.js';

export function collectMacroTargets(host, predicate) {
    const out = [];
    for (const [id, net] of host._musicNets()) {
        if (host._mutedNets.has(id)) continue;
        if (!predicate(id, net)) continue;
        out.push(id);
    }
    return out;
}

export const MACRO_TARGETS = {
    nonDrums:  (host) => collectMacroTargets(host, (_id, net) => !isDrumChannel(net.track?.channel)),
    drumsOnly: (host) => collectMacroTargets(host, (_id, net) => isDrumChannel(net.track?.channel)),
    everything:(host) => collectMacroTargets(host, () => true),
};

// Kind 'mute' uses worker-side control nets (tick-locked restore).
// Kind 'fx-sweep' linearly ramps a master FX slider to `toValue` over most of
// the duration, then ramps back over the tail — for filter breakdowns.
// Kind 'fx-hold' jumps an FX slider to `toValue`, holds, and snaps back — for
// washes / throws.
export const MACROS = [
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
    { id: 'auto-pan',   group: 'Pan', kind: 'pan-move', label: 'Auto-Pan',   defaultDuration: 4, durationOpts: [2, 4, 8],    durationLabel: 'bar', durationUnit: 'bar', pattern: 'sweep',    rateBeats: 4,  targets: MACRO_TARGETS.everything },
    { id: 'mono',       group: 'Pan', kind: 'pan-move', label: 'Mono',       defaultDuration: 2, durationOpts: [1, 2, 4, 8], durationLabel: 'bar', durationUnit: 'bar', pattern: 'hold',     toValue:  0,   targets: MACRO_TARGETS.everything },

    // --- Shape ---
    { id: 'tighten',    group: 'Shape', kind: 'decay-move', label: 'Tighten', defaultDuration: 2, durationOpts: [1, 2, 4, 8], durationLabel: 'bar', durationUnit: 'bar', pattern: 'hold',  toValue: 0.3, targets: MACRO_TARGETS.everything },
    { id: 'loosen',     group: 'Shape', kind: 'decay-move', label: 'Loosen',  defaultDuration: 2, durationOpts: [1, 2, 4, 8], durationLabel: 'bar', durationUnit: 'bar', pattern: 'hold',  toValue: 2.5, targets: MACRO_TARGETS.everything },
    { id: 'pulse',      group: 'Shape', kind: 'decay-move', label: 'Pulse',   defaultDuration: 2, durationOpts: [1, 2, 4, 8], durationLabel: 'bar', durationUnit: 'bar', pattern: 'sweep', rateBeats: 2, sweepMin: 0.2, sweepMax: 2.5, targets: MACRO_TARGETS.everything },
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

    // --- Feel ---
    // Snap the Feel XY puck to a corner for the duration, restore on release.
    // The corner names mirror the Feel modal's four labeled snapshots.
    { id: 'feel-chill',     group: 'Feel', kind: 'feel-snap', label: 'Chill',     defaultDuration: 2, durationOpts: [1, 2, 4, 8], durationLabel: 'bar', durationUnit: 'bar', target: [0, 0] },
    { id: 'feel-drive',     group: 'Feel', kind: 'feel-snap', label: 'Drive',     defaultDuration: 2, durationOpts: [1, 2, 4, 8], durationLabel: 'bar', durationUnit: 'bar', target: [1, 0] },
    { id: 'feel-ambient',   group: 'Feel', kind: 'feel-snap', label: 'Ambient',   defaultDuration: 2, durationOpts: [1, 2, 4, 8], durationLabel: 'bar', durationUnit: 'bar', target: [0, 1] },
    { id: 'feel-euphoric',  group: 'Feel', kind: 'feel-snap', label: 'Euphoric',  defaultDuration: 2, durationOpts: [1, 2, 4, 8], durationLabel: 'bar', durationUnit: 'bar', target: [1, 1] },
    // Sweep-and-return: smoothly animate from current puck position to
    // target over the duration, then snap back to the pre-fire position.
    // Build Up = ramp to Euphoric (energy lift); Wind Down = ramp to Chill
    // (energy fall). Classic build / breakdown gestures.
    // Targets sit a notch in from the corners — the Feel pad's
    // X = LP filter (left = LP 50, right = LP 100) and
    // Y = BPM × 0.6..1.4 mean (1, 1) is bright + 40% faster (loud
    // + frantic) and (0, 0) is muffled + 40% slower (perceptually
    // dead). The 0.15 inset keeps both gestures musical without
    // bottoming out either axis.
    { id: 'feel-build',     group: 'Feel', kind: 'feel-sweep', label: 'Build Up', defaultDuration: 4, durationOpts: [2, 4, 8],    durationLabel: 'bar', durationUnit: 'bar', target: [0.85, 0.85] },
    { id: 'feel-wind-down', group: 'Feel', kind: 'feel-sweep', label: 'Wind Down',defaultDuration: 4, durationOpts: [2, 4, 8],    durationLabel: 'bar', durationUnit: 'bar', target: [0.25, 0.30] },
    // Gradual reset — same effect as a tab-level "reset to defaults" but
    // ramps over N bars instead of cutting over. Eases puck + tempo back
    // to the current genre's defaults.
    { id: 'feel-reset',     group: 'Feel', kind: 'genre-reset', label: 'Reset',    defaultDuration: 4, durationOpts: [2, 4, 8, 16], durationLabel: 'bar', durationUnit: 'bar' },

    // --- Tempo ---
    { id: 'half-time',    group: 'Tempo', kind: 'tempo-hold',   label: 'Half Time',  defaultDuration: 2, durationOpts: [1, 2, 4, 8], durationLabel: 'bar', durationUnit: 'bar', factor: 0.5 },
    { id: 'tape-stop',    group: 'Tempo', kind: 'tempo-sweep',  label: 'Tape Stop',  defaultDuration: 1, durationOpts: [1, 2],       durationLabel: 'bar', durationUnit: 'bar', finalBpm: 22 },
    { id: 'tempo-anchor', group: 'Tempo', kind: 'tempo-anchor', label: 'Anchor',     defaultDuration: 2, durationOpts: [1, 2, 4, 8], durationLabel: 'bar', durationUnit: 'bar' },

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

// --- Which macros the djrust engine runs ---
//
// djwasm sorts the catalog into four kinds (djw_keys().macros): `net` macros
// run in the runner (mutes and tempo, djwasm 0.3.0 "net clock"), `master`
// and `aux` macros in the master chain and aux bus (djwasm 0.4.0), and the
// `hit` pads stay page-side. The module says what it runs in its feature
// mask (djw_features), so the page never assumes a version: a macro is live
// exactly when its kind's feature bit is set. A module without the mask
// (djwasm 0.2.0) runs none, which is the studio before macros came back.
//
// The table is the engine's own (djw_keys of the pinned module);
// scripts/test-djrust-page-macros.mjs fails if the two drift apart.
export const ENGINE_MACRO_KIND = Object.freeze({
    'drop': 'net', 'breakdown': 'net', 'solo-drums': 'net', 'cut': 'net', 'double-drop': 'net',
    'beat-repeat': 'net', 'half-time': 'net', 'tape-stop': 'net', 'tempo-anchor': 'net',
    'sweep-lp': 'master', 'sweep-hp': 'master', 'reverb-wash': 'master', 'riser': 'master',
    'build-crush': 'master', 'phaser-drone': 'master', 'filter-res': 'master', 'octave-up': 'master',
    'octave-down': 'master', 'pitch-bend': 'master', 'vinyl-brake': 'master', 'feel-chill': 'master',
    'feel-drive': 'master', 'feel-ambient': 'master', 'feel-euphoric': 'master', 'feel-build': 'master',
    'feel-wind-down': 'master', 'feel-reset': 'master',
    'ping-pong': 'aux', 'hard-left': 'aux', 'hard-right': 'aux', 'auto-pan': 'aux', 'mono': 'aux',
    'delay-throw': 'aux', 'dub-delay': 'aux', 'cathedral': 'aux', 'tighten': 'aux', 'loosen': 'aux',
    'pulse': 'aux',
    'hit1': 'hit', 'hit2': 'hit', 'hit3': 'hit', 'hit4': 'hit',
});

// The djw_features() bit each kind needs (public/djrust/loader.js FEATURE:
// NET_MACROS, MASTER_MACROS, AUX_MACROS). `hit` has none: the pads are page
// work the engine does not take.
export const ENGINE_KIND_FEATURE = Object.freeze({ net: 2, master: 128, aux: 256 });

/** Does an engine with feature mask `features` run catalog macro `id`? */
export function engineRunsMacro(id, features) {
    const bit = ENGINE_KIND_FEATURE[ENGINE_MACRO_KIND[id]];
    return !!bit && ((features | 0) & bit) === bit;
}

// Curated picks for "Transition" pool — fires only on Auto-DJ regen
// boundaries. Chosen to resolve naturally on a downbeat (sweeps that
// end open, washes that decay, risers that land) rather than random
// Mute/Pan/Shape gestures which tend to feel disorienting across a
// track change.
export const TRANSITION_MACRO_IDS = new Set([
    'riser', 'sweep-hp', 'sweep-lp', 'reverb-wash', 'cathedral',
    'delay-throw', 'dub-delay', 'tape-stop', 'phaser-drone',
]);

/**
 * Can the studio run catalog macro `id` on an engine with feature mask
 * `features`? The engine's own kinds as engineRunsMacro says; the `hit` pads
 * (the Beats panel's Fire / Repeat) are page work on any engine: they unmute
 * a stinger net for N bars and mute it again, plain mutes every djwasm takes.
 */
export function macroRunnable(id, features) {
    if (ENGINE_MACRO_KIND[id] === 'hit') return true;
    return engineRunsMacro(id, features);
}

/**
 * Is Auto-DJ pool `pool` (the .pn-autodj-pool values) live on an engine with
 * `features`? One rule for lib/ui/engine-gaps.js (which pools are shown) and
 * lib/macros/runtime.js (which pools Auto-DJ draws from), so a hidden pool is
 * never drawn from.
 *   Beats       the hit pads (page work: always).
 *   Transition  a curated spread of sweeps, washes, throws and one tape stop,
 *               picked for variety at a track change. It is offered only when
 *               the engine runs at least half of it: filtered down to what a
 *               net-macro engine runs (djwasm 0.3.0: tape-stop alone) it
 *               would be "tape stop at every change", not a transition pool.
 *   the rest    a catalog group: live when any of its macros runs.
 */
export function autoDjPoolLive(pool, features) {
    if (pool === 'Beats') return MACROS.some(m => m.kind === 'one-shot' && macroRunnable(m.id, features));
    if (pool === 'Transition') {
        const ids = [...TRANSITION_MACRO_IDS];
        return 2 * ids.filter(id => macroRunnable(id, features)).length >= ids.length;
    }
    return MACROS.some(m => m.group === pool && m.kind !== 'one-shot' && macroRunnable(m.id, features));
}
