/**
 * sequencer-worker.js — Web Worker that runs the Petri net sequencer tick loop.
 * Replaces the Go backend's sequencer goroutine.
 * Communicates with main thread using the same JSON message protocol as WebSocket.
 */

import { parseProject, projectToJSON } from './lib/pflow.js';
import { compose, shuffleInstruments, Genres, GenreInstrumentSets } from './lib/generator/index.js';

const DefaultTempo = 120;
const DefaultPPQ = 4;
const MinBPM = 20;
const MaxBPM = 300;

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
let timerId = null;

// Mute state
let mutedNets = {};
let mutedNotes = {};   // netId -> { note: bool }
let mutedGroups = {};   // riffGroup -> bool

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

    for (const consumers of Object.values(placeConsumers)) {
        if (consumers.length <= 1) continue;
        const winner = consumers[Math.floor(Math.random() * consumers.length)];
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

function tick() {
    if (!project) return;

    tickCount++;

    // Loop wrap
    if (loopEnd > 0 && loopStart >= 0 && tickCount >= loopEnd) {
        fastForwardTo(loopStart);
        broadcastState();
        return;
    }

    // Bar-boundary project swap (16 ticks = 1 bar)
    if (pendingProject && tickCount % 16 === 0) {
        project = pendingProject;
        tempo = project.tempo;
        tickCount = 0;
        mutedNets = {};
        mutedNotes = {};
        mutedGroups = {};
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
                post({ type: 'transition-fired', netId, transitionId: tLabel, midi: result.midi });
            }
        }
    }

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
        timerId = setInterval(tick, tickInterval());
    }
}

// --- Transport ---

function doPlay() {
    if (playing) return;
    playing = true;
    restartTimer();
}

function doStop() {
    if (timerId !== null) {
        clearInterval(timerId);
        timerId = null;
    }
    playing = false;
    stopRequested = false;
    tickCount = 0;
    loopStart = -1;
    loopEnd = -1;
    mutedNets = {};
    mutedNotes = {};

    if (project) {
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
    // Apply initial mutes
    mutedNets = {};
    mutedNotes = {};
    if (project.initialMutes) {
        for (const netId of project.initialMutes) {
            mutedNets[netId] = true;
        }
    }
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

        case 'generate': {
            const proj = compose(msg.genre, msg.params || {});
            queueProject(proj);
            break;
        }

        case 'generate-preview': {
            const proj = compose(msg.genre, msg.params || {});
            post({ type: 'preview-ready', project: projectToJSON(proj) });
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
                const result = bundle.fire(msg.transitionId);
                if (result.control) applyControl(msg.netId, msg.transitionId, result.control);
                if (result.midi && !mutedNets[msg.netId]) {
                    post({ type: 'transition-fired', netId: msg.netId, transitionId: msg.transitionId, midi: result.midi });
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

        case 'crop':
            // Simplified crop: not porting full crop logic for initial version
            // Could be added later
            break;

        case 'loop':
            if (msg.startTick >= 0 && msg.endTick >= 0 && msg.startTick >= msg.endTick) {
                loopStart = -1;
                loopEnd = -1;
            } else {
                loopStart = msg.startTick;
                loopEnd = msg.endTick;
            }
            post({ type: 'loop-changed', startTick: loopStart, endTick: loopEnd });
            break;
    }
};

// Signal ready
post({ type: 'ready' });
