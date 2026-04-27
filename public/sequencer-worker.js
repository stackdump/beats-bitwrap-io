/**
 * sequencer-worker.js — Web Worker that runs the Petri net sequencer tick loop.
 * Replaces the Go backend's sequencer goroutine.
 * Communicates with main thread using the same JSON message protocol as WebSocket.
 */

import { parseProject, parseNetBundle, projectToJSON } from './lib/pflow.js';
import { compose, shuffleInstruments, Genres, GenreInstrumentSets, rebuildControlNets } from './lib/generator/index.js?v=6';
import { regenerateTrack } from './lib/generator/regenerate.js';
import { buildMacroRestoreNet, MACRO_NET_PREFIX, pruneMacroNets } from './lib/generator/macros.js';

const DefaultTempo = 120;
const DefaultPPQ = 4;
const MinBPM = 20;
const MaxBPM = 300;
// Audio-clock lookahead window. Each tick stamps `playAtOffsetMs` and
// `tickEpochMs` on every fire so the main thread can schedule notes
// into the AudioContext clock instead of playing them on receipt.
// LOOKAHEAD_MS is the buffer that absorbs main-thread stalls (Auto-DJ
// regen, macro fires, GC) without dropping beats. Kept small (80 ms)
// to stay under the AV-sync perception threshold (~40-80 ms for music)
// — visual side effects fire on receipt; audio fires LOOKAHEAD_MS
// later and the user shouldn't perceive the gap. Mirrored in
// lib/backend/index.js.
const LOOKAHEAD_MS = 80;

// --- Sequencer state ---
let project = null;
let playing = false;
let tempo = DefaultTempo;
const ppq = DefaultPPQ;
let tickCount = 0;
let stopRequested = false;
let loopStart = -1;
let loopEnd = -1;
let pendingProject = null;
let pendingNetUpdates = {}; // netId -> NetBundle (drained at bar boundary, preserves transport/mutes)
let timerId = null;

// Mute state
let mutedNets = {};
let mutedNotes = {};   // netId -> { note: bool }
let mutedGroups = {};   // riffGroup -> bool

// When true, conflict resolution is deterministic (loops repeat exactly).
// When false, Math.random() picks winners (original behavior — loops drift).
let deterministicLoop = false;

// Drift state: tracks loop iterations for evolving variation
let loopIteration = 0;
const GHOST_VEL_THRESHOLD = 55; // velocity at or below this = ghost note
const DRIFT_GHOST_SUPPRESS = 0.15; // probability a ghost note is suppressed per loop
const DRIFT_GHOST_ADD = 0.08; // probability a silent step becomes a ghost
const DRIFT_VEL_RANGE = 12; // max velocity jitter ±
const DRIFT_PHASE_CHANCE = 0.12; // probability of token phase shift on loop wrap

// --- Helpers ---

function tickInterval() {
    return 60000 / (tempo * ppq); // ms per tick
}

function post(msg) {
    self.postMessage(msg);
}

function broadcastState() {
    if (!project) return;
    const state = {};
    for (const [netId, bundle] of Object.entries(project.nets)) {
        state[netId] = { ...bundle.state };
    }
    post({ type: 'state-sync', state, tick: tickCount });
}

function broadcastMuteState() {
    post({ type: 'mute-state', mutedNets: { ...mutedNets }, mutedNotes: deepCopyMutedNotes() });
}

function deepCopyMutedNotes() {
    const copy = {};
    for (const [k, v] of Object.entries(mutedNotes)) {
        copy[k] = { ...v };
    }
    return copy;
}

// --- Deterministic hash for conflict resolution ---
// Mulberry32 one-shot: same (tick, salt) always gives the same result,
// so replay via fastForwardTo produces identical conflict outcomes.

function deterministicRand(tick, salt) {
    let s = (tick + salt) | 0;
    s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
}

// Simple string hash for place labels (used as salt)
function strHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = Math.imul(31, h) + str.charCodeAt(i) | 0;
    }
    return h;
}

// --- Drift: per-tick MIDI variation when not deterministic ---

function driftMidi(midi, netId, tLabel) {
    if (!midi) return midi;

    // Seed from loop iteration + transition identity for repeatable-within-loop but varying-across-loops
    const salt = strHash(netId + ':' + tLabel);
    const r = deterministicRand(loopIteration, salt);

    const isGhost = midi.velocity <= GHOST_VEL_THRESHOLD;

    // Ghost suppression: occasionally silence a ghost note
    if (isGhost && r < DRIFT_GHOST_SUPPRESS) {
        return null; // suppress this ghost
    }

    // Velocity drift: jitter based on loop iteration
    const r2 = deterministicRand(loopIteration * 7 + tickCount, salt);
    const velJitter = Math.round((r2 * 2 - 1) * DRIFT_VEL_RANGE);
    const newVel = Math.max(1, Math.min(127, midi.velocity + velJitter));

    return { ...midi, velocity: newVel };
}

// Apply token phase drift on loop wrap: shift one token in a random music net
function applyPhaseDrift() {
    const musicNets = [];
    for (const [netId, bundle] of Object.entries(project.nets)) {
        if (bundle.role === 'music' || bundle.role === '') musicNets.push({ netId, bundle });
    }
    if (musicNets.length === 0) return;

    // Pick a net to phase-shift, seeded from loop iteration
    const r = deterministicRand(loopIteration * 31, 0xDEAD);
    if (r >= DRIFT_PHASE_CHANCE) return; // usually skip

    const r2 = deterministicRand(loopIteration * 37, 0xBEEF);
    const entry = musicNets[Math.floor(r2 * musicNets.length)];
    const bundle = entry.bundle;

    // Find the place that currently has a token
    const places = Object.keys(bundle.places);
    if (places.length < 3) return; // too small to phase-shift meaningfully

    for (const p of places) {
        if ((bundle.state[p] || 0) >= 1) {
            // Move token forward by 1 step in the ring
            const idx = places.indexOf(p);
            const nextIdx = (idx + 1) % places.length;
            bundle.state[p] -= 1;
            bundle.state[places[nextIdx]] = (bundle.state[places[nextIdx]] || 0) + 1;
            break;
        }
    }
}

// --- Conflict resolution ---

function resolveConflicts(bundle, enabled) {
    const placeConsumers = {};
    const blocked = {};

    for (const tLabel of enabled) {
        for (const ca of bundle.getInputArcs(tLabel)) {
            if (!ca.inhibit) {
                if (!placeConsumers[ca.source]) placeConsumers[ca.source] = [];
                placeConsumers[ca.source].push(tLabel);
            }
        }
    }

    for (const [place, consumers] of Object.entries(placeConsumers)) {
        if (consumers.length <= 1) continue;
        const r = deterministicLoop ? deterministicRand(tickCount, strHash(place)) : Math.random();
        const winner = consumers[Math.floor(r * consumers.length)];
        for (const t of consumers) {
            if (t !== winner) blocked[t] = true;
        }
    }

    if (Object.keys(blocked).length === 0) return enabled;
    return enabled.filter(t => !blocked[t]);
}

// --- Control event handling ---

function applyControl(netId, transId, ctrl) {
    switch (ctrl.action) {
        case 'mute-track':
            mutedNets[ctrl.targetNet] = true;
            break;
        case 'unmute-track':
            mutedNets[ctrl.targetNet] = false;
            break;
        case 'toggle-track':
            mutedNets[ctrl.targetNet] = !mutedNets[ctrl.targetNet];
            break;
        case 'mute-note':
            if (!mutedNotes[ctrl.targetNet]) mutedNotes[ctrl.targetNet] = {};
            mutedNotes[ctrl.targetNet][ctrl.targetNote] = true;
            break;
        case 'unmute-note':
            if (mutedNotes[ctrl.targetNet]) {
                mutedNotes[ctrl.targetNet][ctrl.targetNote] = false;
            }
            break;
        case 'toggle-note':
            if (!mutedNotes[ctrl.targetNet]) mutedNotes[ctrl.targetNet] = {};
            mutedNotes[ctrl.targetNet][ctrl.targetNote] = !mutedNotes[ctrl.targetNet][ctrl.targetNote];
            break;
        case 'activate-slot': {
            const targetBundle = project?.nets[ctrl.targetNet];
            if (targetBundle && targetBundle.riffGroup) {
                for (const [nId, nb] of Object.entries(project.nets)) {
                    if (nb.riffGroup === targetBundle.riffGroup && nId !== ctrl.targetNet) {
                        mutedNets[nId] = true;
                    }
                }
                if (!mutedGroups[targetBundle.riffGroup]) {
                    mutedNets[ctrl.targetNet] = false;
                }
            }
            break;
        }
        case 'stop-transport':
            stopRequested = true;
            break;
    }

    post({ type: 'control-fired', netId, transitionId: transId, control: ctrl });
    broadcastMuteState();
}

// --- Fast-forward (silent replay) ---

function fastForwardTo(targetTick) {
    for (const bundle of Object.values(project.nets)) {
        bundle.resetState();
    }
    tickCount = 0;
    mutedNets = {};
    mutedNotes = {};
    stopRequested = false;

    // Apply initial mutes
    if (project.initialMutes) {
        for (const netId of project.initialMutes) {
            mutedNets[netId] = true;
        }
    }

    // Replay ticks silently (control events only, no MIDI broadcast)
    while (tickCount < targetTick) {
        tickCount++;
        for (const [netId, bundle] of Object.entries(project.nets)) {
            const transLabels = bundle.transitionLabels();
            let enabled = [];
            for (const tLabel of transLabels) {
                if (bundle.isEnabled(tLabel)) enabled.push(tLabel);
            }
            if (enabled.length > 1) enabled = resolveConflicts(bundle, enabled);

            for (const tLabel of enabled) {
                const result = bundle.fire(tLabel);
                if (result.control) applyControl(netId, tLabel, result.control);
            }
        }
    }
}

// --- Tick ---

// Mobile lock-screen catch-up. setInterval gets throttled to ~1 Hz on
// backgrounded mobile tabs; without catch-up the song slows to a crawl.
// On every fire we measure real elapsed time and, if > 1.5× the expected
// interval, advance through the missed ticks in one batch so the song
// stays in time. Beats may clump on each fire (the broadcast still goes
// out as fast as we can post()) but the *song state* doesn't fall
// behind the audio clock.
let _lastTickAt = 0;
// Per-tick timing stamps applied to every `transition-fired` post so
// the main thread can schedule audio into the AudioContext clock.
// `_currentTickEpochMs` is set once per setInterval fire (same baseline
// for catch-up and the on-time tick); `_currentTickOffsetMs` advances
// per slot inside the catch-up loop. Negative offsets = "this tick was
// already in the past at fire time" (main thread clamps to 0).
let _currentTickEpochMs = 0;
let _currentTickOffsetMs = 0;
// When true, _advanceOneTick still evolves Petri net state + applies
// control events (so macros / mutes / loop wraps stay correct), but
// suppresses transition-fired broadcasts so the main thread doesn't
// play audio for ticks that already passed. Set during catch-up after
// a long suspension (mobile screen lock) so the user doesn't hear a
// blast of compressed catch-up beats on resume.
let _silentAdvance = false;
// Monotonic tick counter for audio-grid scheduling. Unlike `tickCount`,
// this never resets on loop wrap (fastForwardTo) — only on transport
// play/stop/swap. The main thread anchors `_audioGridStartTone` to the
// AudioContext clock at the first `playbackTicks` it sees and schedules
// every subsequent fire at `anchor + (playbackTicks - startTicks) *
// tickIntervalSec`. Result: audio onsets land on the grid regardless of
// when the worker's setInterval-driven fire actually arrives, so headless
// renders on a CPU-saturated host stay in time.
let playbackTicks = 0;
function tick() {
    if (!project) return;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const interval = tickInterval();
    const elapsed = _lastTickAt ? now - _lastTickAt : interval;
    _lastTickAt = now;
    _currentTickEpochMs = now;
    let catchUp = 0;
    // Cap catch-up at 1.5 seconds of missed ticks so a long suspension
    // doesn't trigger a multi-second blast of buffered events.
    const maxCatchUp = Math.min(64, Math.floor(1500 / interval));
    if (elapsed > interval * 1.5) {
        catchUp = Math.min(maxCatchUp, Math.floor(elapsed / interval) - 1);
    }
    // Catch-up: advance state silently for missed ticks so loops, macros,
    // and mutes stay correct, but DON'T post transition-fired — otherwise
    // resuming from a long screen-lock fires a 1-second burst of
    // compressed beats. The on-time tick below plays normally.
    _silentAdvance = true;
    for (let i = 0; i < catchUp; i++) {
        if (!project) { _silentAdvance = false; return; }
        _currentTickOffsetMs = (i - catchUp) * interval; // negative
        _advanceOneTick();
    }
    _silentAdvance = false;
    _currentTickOffsetMs = 0;
    _advanceOneTick();
}

// Per-tick advance — extracted so catch-up can run it in a loop.
function _advanceOneTick() {
    if (!project) return;

    tickCount++;
    playbackTicks++;

    // Loop wrap
    if (loopEnd > 0 && loopStart >= 0 && tickCount >= loopEnd) {
        loopIteration++;
        pruneMacroNets(project);   // macros are one-shot; don't replay on loop wrap
        fastForwardTo(loopStart);
        if (!deterministicLoop) applyPhaseDrift();
        broadcastState();
        return;
    }

    // Bar-boundary per-track swap — preserves tickCount and mute state
    if (tickCount % 16 === 0 && Object.keys(pendingNetUpdates).length > 0) {
        for (const [nid, nb] of Object.entries(pendingNetUpdates)) {
            if (project.nets[nid]) {
                project.nets[nid] = nb;
                post({ type: 'track-pattern-updated', netId: nid, net: projectToJSON(project).nets[nid] });
            }
        }
        pendingNetUpdates = {};
    }

    // Bar-boundary project swap (16 ticks = 1 bar)
    if (pendingProject && tickCount % 16 === 0) {
        project = pendingProject;
        tempo = project.tempo;
        tickCount = 0;
        loopIteration = 0;
        playbackTicks = 0; // re-anchor audio grid for the new project
        mutedNets = {};
        mutedNotes = {};
        mutedGroups = {};
        pendingNetUpdates = {}; // stale — belonged to the previous project
        if (project.initialMutes) {
            for (const netId of project.initialMutes) {
                mutedNets[netId] = true;
            }
        }
        post({ type: 'project-sync', project: projectToJSON(project) });
        broadcastMuteState();
        pendingProject = null;
        broadcastState();
        restartTimer(); // tempo may have changed
        return;
    }

    // Collect macro nets whose token reached the terminal place this tick so
    // we can prune them after iteration (can't mutate project.nets mid-loop).
    const exhaustedMacroNets = [];

    for (const [netId, bundle] of Object.entries(project.nets)) {
        const transLabels = bundle.transitionLabels();
        let enabled = [];
        for (const tLabel of transLabels) {
            if (bundle.isEnabled(tLabel)) enabled.push(tLabel);
        }
        if (enabled.length > 1) enabled = resolveConflicts(bundle, enabled);

        for (const tLabel of enabled) {
            const result = bundle.fire(tLabel);

            if (result.control) {
                applyControl(netId, tLabel, result.control);
            }

            if (result.midi && !mutedNets[netId]) {
                const noteMap = mutedNotes[netId];
                if (noteMap && noteMap[result.midi.note]) continue;
                const midi = !deterministicLoop ? driftMidi(result.midi, netId, tLabel) : result.midi;
                if (midi && !_silentAdvance) {
                    post({
                        type: 'transition-fired',
                        netId, transitionId: tLabel, midi,
                        // Per-burst anchor fields — kept for backward
                        // compat with the WS path (Go server doesn't emit
                        // `playbackTicks` yet) and for browsers that load
                        // an older worker against a newer main thread.
                        playAtOffsetMs: _currentTickOffsetMs,
                        tickEpochMs: _currentTickEpochMs,
                        // Audio-grid scheduling: main thread anchors
                        // `playbackTicks` to a `Tone.now()` baseline once
                        // and schedules every subsequent fire at exact
                        // grid positions. Drops setInterval jitter.
                        playbackTicks,
                        tickIntervalMs: tickInterval(),
                    });
                }
            }
        }

        // A macro control net is a linear chain whose last transition carries
        // the restore action. Once the token reaches the terminal place no
        // further transitions are enabled — the net's work is done.
        if (netId.startsWith(MACRO_NET_PREFIX)) {
            let stillLive = false;
            for (const tLabel of transLabels) {
                if (bundle.isEnabled(tLabel)) { stillLive = true; break; }
            }
            if (!stillLive) exhaustedMacroNets.push(netId);
        }
    }
    for (const id of exhaustedMacroNets) delete project.nets[id];

    // Throttle state broadcasts to every 6 ticks
    if (tickCount % 6 === 0) {
        broadcastState();
    }

    // Check stop request
    if (stopRequested) {
        doStop();
        post({ type: 'playback-complete' });
    }
}

// --- Timer management ---

function restartTimer() {
    if (timerId !== null) {
        clearInterval(timerId);
        timerId = null;
    }
    if (playing) {
        // Reset the catch-up baseline so a tempo change or play-start
        // doesn't trigger spurious catch-up against the prior interval.
        _lastTickAt = 0;
        _currentTickEpochMs = 0;
        _currentTickOffsetMs = 0;
        timerId = setInterval(tick, tickInterval());
    }
}

// --- Transport ---

function doPlay() {
    if (playing) return;
    // Seek to loop start to restore correct Petri net state
    if (loopStart > 0 && project) {
        fastForwardTo(loopStart);
        broadcastState();
    }
    playing = true;
    playbackTicks = 0; // re-anchor audio grid on next fire
    restartTimer();
}

function doStop() {
    if (timerId !== null) {
        clearInterval(timerId);
        timerId = null;
    }
    playing = false;
    stopRequested = false;
    tickCount = loopStart >= 0 ? loopStart : 0;
    loopIteration = 0;
    playbackTicks = 0;
    mutedNets = {};
    mutedNotes = {};

    if (project) {
        pruneMacroNets(project);   // drop any in-flight macro control nets
        for (const bundle of Object.values(project.nets)) {
            bundle.resetState();
        }
        // Re-apply initial mutes
        if (project.initialMutes) {
            for (const netId of project.initialMutes) {
                mutedNets[netId] = true;
            }
        }
    }
    broadcastMuteState();
}

function doPause() {
    if (timerId !== null) {
        clearInterval(timerId);
        timerId = null;
    }
    playing = false;
}

// --- Load project ---

function loadProject(data) {
    project = parseProject(data);
    tempo = project.tempo;
    mutedGroups = {};
    loopIteration = 0;
    // Apply initial mutes
    mutedNets = {};
    mutedNotes = {};
    if (project.initialMutes) {
        for (const netId of project.initialMutes) {
            mutedNets[netId] = true;
        }
    }
    // Echo the loaded project back so the main thread mirrors worker
    // state. Without this, `project-load` messages apply in the worker
    // but the UI keeps showing the previous project — which is how the
    // share-v2 raw-nets boot path got swallowed silently.
    post({ type: 'project-sync', project: projectToJSON(project) });
    broadcastMuteState();
}

function queueProject(proj) {
    if (!playing) {
        project = proj;
        tempo = proj.tempo;
        mutedGroups = {};
        mutedNets = {};
        mutedNotes = {};
        if (proj.initialMutes) {
            for (const netId of proj.initialMutes) {
                mutedNets[netId] = true;
            }
        }
        post({ type: 'project-sync', project: projectToJSON(proj) });
        broadcastMuteState();
        return;
    }
    pendingProject = proj;
}

// --- Message handler ---

self.onmessage = function(e) {
    const msg = e.data;

    switch (msg.type) {
        case 'transport':
            switch (msg.action) {
                case 'play': doPlay(); break;
                case 'stop': doStop(); break;
                case 'pause': doPause(); break;
            }
            break;

        case 'tempo': {
            let bpm = msg.bpm;
            if (bpm < MinBPM) bpm = MinBPM;
            if (bpm > MaxBPM) bpm = MaxBPM;
            tempo = bpm;
            if (project) project.tempo = bpm;
            post({ type: 'tempo-changed', tempo });
            if (playing) restartTimer();
            break;
        }

        case 'project-load':
            loadProject(msg.project);
            break;

        // Mid-playback swap of a pre-composed project. Routes through
        // queueProject so it lands on a bar boundary with tickCount reset,
        // avoiding the mid-tick replacement that project-load causes.
        case 'project-queue': {
            const proj = parseProject(msg.project);
            queueProject(proj);
            break;
        }

        case 'generate': {
            const proj = compose(msg.genre, msg.params || {});
            // Auto-DJ-requested transition: add a transient control net
            // to the composed project before it's queued. The client
            // picks the macro ID so user preferences (disabled macros,
            // transition pool) stay authoritative there; the worker
            // just links the JSON shape into its bundle graph.
            if (msg.injectTransitionNet?.netId && msg.injectTransitionNet?.net) {
                proj.nets[msg.injectTransitionNet.netId] = parseNetBundle(msg.injectTransitionNet.net);
            }
            queueProject(proj);
            break;
        }

        case 'generate-preview': {
            const proj = compose(msg.genre, msg.params || {});
            post({ type: 'preview-ready', project: projectToJSON(proj), reqId: msg.reqId });
            break;
        }

        case 'shuffle-instruments': {
            if (!project) break;
            const instruments = shuffleInstruments(project, msg.seed || 0);
            post({ type: 'instruments-changed', instruments });
            break;
        }

        case 'transition-fire':
            if (project && project.nets[msg.netId]) {
                const bundle = project.nets[msg.netId];
                if (bundle.isEnabled(msg.transitionId)) {
                    const result = bundle.fire(msg.transitionId);
                    if (result.control) applyControl(msg.netId, msg.transitionId, result.control);
                    if (result.midi && !mutedNets[msg.netId]) {
                        post({ type: 'transition-fired', netId: msg.netId, transitionId: msg.transitionId, midi: result.midi });
                    }
                }
            }
            break;

        case 'mute':
            mutedNets[msg.netId] = msg.muted;
            broadcastMuteState();
            break;

        case 'mute-group':
            if (project) {
                mutedGroups[msg.riffGroup] = msg.muted;
                if (msg.muted) {
                    for (const [netId, nb] of Object.entries(project.nets)) {
                        if (nb.riffGroup === msg.riffGroup) mutedNets[netId] = true;
                    }
                } else {
                    let activeSlot = '';
                    for (const [netId, nb] of Object.entries(project.nets)) {
                        if (nb.riffGroup === msg.riffGroup && !activeSlot) activeSlot = netId;
                    }
                    if (activeSlot) mutedNets[activeSlot] = false;
                }
                broadcastMuteState();
            }
            break;

        case 'seek':
            if (project) {
                fastForwardTo(msg.tick);
                broadcastState();
                broadcastMuteState();
            }
            break;

        case 'crop': {
            const cropStart = msg.startTick;
            const cropEnd = msg.endTick;
            if (!(cropStart >= 0 && cropEnd > cropStart && project)) break;

            const srcJSON = projectToJSON(project);

            // Keep only music nets (strip old control nets)
            const musicNets = {};
            for (const [id, net] of Object.entries(srcJSON.nets)) {
                if (net.role !== 'control') musicNets[id] = net;
            }

            const cropped = {
                name: (() => {
                    const m = srcJSON.name.match(/^(.*?)\s*(\[+)crop(\]+)$/);
                    if (m) return m[1] + ' ' + '[' + m[2] + 'crop' + m[3] + ']';
                    return srcJSON.name + ' [crop]';
                })(),
                tempo: srcJSON.tempo,
                nets: musicNets,
            };
            if (srcJSON.swing) cropped.swing = srcJSON.swing;
            if (srcJSON.humanize) cropped.humanize = srcJSON.humanize;

            // Trim structure to crop range
            if (srcJSON.structure && srcJSON.structure.length > 0) {
                const newStructure = [];
                let offset = 0;
                for (const sec of srcJSON.structure) {
                    const secStart = offset;
                    const secEnd = offset + sec.steps;
                    offset = secEnd;
                    if (secEnd <= cropStart || secStart >= cropEnd) continue;
                    const trimStart = Math.max(0, cropStart - secStart);
                    const trimEnd = Math.min(sec.steps, cropEnd - secStart);
                    const trimmedSteps = trimEnd - trimStart;
                    if (trimmedSteps <= 0) continue;
                    const s = { name: sec.name, steps: trimmedSteps };
                    if (sec.phrases) s.phrases = sec.phrases;
                    newStructure.push(s);
                }
                cropped.structure = newStructure;
            }

            // Parse, rebuild control nets, and load as a normal project
            const newProj = parseProject(cropped);
            const cropMutes = rebuildControlNets(newProj);
            newProj.initialMutes = cropMutes;
            queueProject(newProj);
            break;
        }

        case 'loop':
            if (msg.startTick < 0 || msg.endTick < 0 || msg.startTick >= msg.endTick) {
                loopStart = -1;
                loopEnd = -1;
            } else {
                loopStart = msg.startTick;
                loopEnd = msg.endTick;
            }
            post({ type: 'loop-changed', startTick: loopStart, endTick: loopEnd });
            break;

        case 'deterministic-loop':
            deterministicLoop = !!msg.enabled;
            post({ type: 'deterministic-loop-changed', enabled: deterministicLoop });
            break;

        case 'fire-macro': {
            if (!project) break;
            const targets = Array.isArray(msg.targets) ? msg.targets : [];
            const durationTicks = Math.max(1, Math.round(msg.durationTicks || 16));
            const macroId = msg.macroId || `m${Date.now()}`;
            const muteAction = msg.muteAction || 'mute-track';
            // null / 'none' = permanent — apply the side effect and skip the
            // restore control net entirely. User must un-mute manually.
            const restoreAction = msg.restoreAction === null || msg.restoreAction === 'none'
                ? null
                : (msg.restoreAction || 'unmute-track');
            for (const target of targets) {
                if (!project.nets[target]) continue;
                if (muteAction === 'mute-track') mutedNets[target] = true;
                else if (muteAction === 'unmute-track') mutedNets[target] = false;
                if (restoreAction) {
                    const netId = `${MACRO_NET_PREFIX}${macroId}:${target}`;
                    project.nets[netId] = buildMacroRestoreNet(netId, target, durationTicks, restoreAction);
                }
            }
            broadcastMuteState();
            break;
        }

        case 'cancel-macros': {
            pruneMacroNets(project);
            break;
        }

        case 'update-track-pattern': {
            if (!project || !project.nets[msg.netId]) break;
            const prev = project.nets[msg.netId];
            if (!prev.track || !prev.track.generator) {
                post({ type: 'track-pattern-error', netId: msg.netId,
                    error: 'track has no generator recipe' });
                break;
            }
            let newNb;
            try {
                newNb = regenerateTrack(prev, {
                    ringSize: msg.ringSize,
                    beats: msg.beats,
                    rotation: msg.rotation,
                    note: msg.note,
                });
            } catch (err) {
                post({ type: 'track-pattern-error', netId: msg.netId, error: String(err) });
                break;
            }
            if (!playing) {
                project.nets[msg.netId] = newNb;
                post({ type: 'track-pattern-updated', netId: msg.netId,
                    net: projectToJSON(project).nets[msg.netId] });
            } else {
                pendingNetUpdates[msg.netId] = newNb;
            }
            break;
        }
    }
};

// Signal ready
post({ type: 'ready' });
