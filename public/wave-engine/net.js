/**
 * net.js — the Petri-net executor, compiled to typed arrays so the audio
 * thread can tick it without allocating.
 *
 * Semantics are the sequencer worker's `_advanceOneTick` with
 * `deterministicLoop` on: nets in project order, enabled transitions in
 * label order, one winner per contested input place chosen by
 * deterministicRand(tick, strHash(place)), controls applied immediately so a
 * mute fired by an earlier net affects later nets in the same tick.
 * Not ported: macros (`fire-macro` restore nets are built in the worker),
 * loop/seek, drift. Those control actions are reported, not applied.
 */

import { parseProject } from '../lib/pflow.js';

export const A_NONE = 0, A_MUTE = 1, A_UNMUTE = 2, A_TOGGLE = 3,
    A_MUTE_NOTE = 4, A_UNMUTE_NOTE = 5, A_TOGGLE_NOTE = 6,
    A_SLOT = 7, A_STOP = 8, A_OTHER = 9;

const ACTIONS = {
    'mute-track': A_MUTE, 'unmute-track': A_UNMUTE, 'toggle-track': A_TOGGLE,
    'mute-note': A_MUTE_NOTE, 'unmute-note': A_UNMUTE_NOTE, 'toggle-note': A_TOGGLE_NOTE,
    'activate-slot': A_SLOT, 'stop-transport': A_STOP,
};

// Same as sequencer-worker.js — conflicts must resolve identically.
export function deterministicRand(tick, salt) {
    let s = (tick + salt) | 0;
    s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
}

export function strHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = Math.imul(31, h) + str.charCodeAt(i) | 0;
    return h;
}

function compileNet(id, nb, netIndex) {
    const placeIds = Object.keys(nb.places);
    const pIdx = new Map(placeIds.map((p, i) => [p, i]));
    const transIds = nb.transitionLabels();
    const P = placeIds.length, T = transIds.length;

    const inStart = new Int32Array(T + 1), outStart = new Int32Array(T + 1);
    const ins = [], outs = [];
    transIds.forEach((t, i) => {
        inStart[i] = ins.length;
        for (const ca of nb.getInputArcs(t)) ins.push([pIdx.get(ca.source) ?? -1, ca.weightSum, ca.inhibit ? 1 : 0]);
        outStart[i] = outs.length;
        for (const ca of (nb.outputArcs[t] || [])) outs.push([pIdx.get(ca.target) ?? -1, ca.weightSum]);
    });
    inStart[T] = ins.length; outStart[T] = outs.length;

    const state = new Float64Array(P);
    placeIds.forEach((p, i) => { state[i] = nb.state[p] || 0; });

    const midi = new Uint8Array(T), note = new Int16Array(T), vel = new Int16Array(T);
    const durMs = new Float64Array(T), durSteps = new Float64Array(T);
    const action = new Uint8Array(T), actionNote = new Int16Array(T);
    const actionTarget = []; // labels, resolved to indices after all nets compile
    transIds.forEach((t, i) => {
        const b = nb.bindings[t];
        if (b) {
            midi[i] = 1; note[i] = b.note; vel[i] = b.velocity;
            durMs[i] = b.duration; durSteps[i] = b.durationSteps || 0;
        }
        const c = nb.controlBindings[t];
        actionTarget.push(c ? c.targetNet : '');
        if (c) { action[i] = ACTIONS[c.action] || A_OTHER; actionNote[i] = c.targetNote || 0; }
    });

    return {
        id, index: netIndex, bundle: nb, placeIds, transIds, P, T,
        inStart, inPlace: Int32Array.from(ins, a => a[0]), inW: Float64Array.from(ins, a => a[1]),
        inInhib: Uint8Array.from(ins, a => a[2]),
        outStart, outPlace: Int32Array.from(outs, a => a[0]), outW: Float64Array.from(outs, a => a[1]),
        placeSalt: Int32Array.from(placeIds, strHash),
        initial: state.slice(), state,
        midi, note, vel, durMs, durSteps, action, actionNote, actionTarget,
        actionTargetIdx: new Int32Array(T).fill(-1),
        group: nb.riffGroup || '', groupIdx: -1,
        lane: new Int16Array(T).fill(-1), // filled by the runner
        // scratch, sized once
        enabled: new Int32Array(T), blocked: new Uint8Array(T),
        consumers: new Int32Array(Math.max(1, ins.length)), placeCount: new Int32Array(P),
    };
}

/**
 * compileProject(json) → graph: parsed + compiled nets, mute tables, and
 * per-tick event buffers. All allocation happens here, never in tick().
 */
export function compileProject(json) {
    const proj = parseProject(json);
    const ids = Object.keys(proj.nets);
    const nets = ids.map((id, i) => compileNet(id, proj.nets[id], i));
    const byId = new Map(ids.map((id, i) => [id, i]));
    const groups = [...new Set(nets.map(n => n.group).filter(Boolean))];
    for (const n of nets) {
        n.groupIdx = n.group ? groups.indexOf(n.group) : -1;
        for (let t = 0; t < n.T; t++) {
            const tgt = n.actionTarget[t];
            if (tgt && byId.has(tgt)) n.actionTargetIdx[t] = byId.get(tgt);
        }
    }
    const g = {
        project: proj, nets, byId, groups,
        tempo: proj.tempo > 0 ? proj.tempo : 120,
        tick: 0,
        muted: new Uint8Array(nets.length),
        mutedNotes: new Uint8Array(nets.length * 128),
        mutedGroups: new Uint8Array(Math.max(1, groups.length)),
        stopRequested: false,
        // Events of the last tick, for the UI: fired (net, transition) pairs
        // and control pairs. Fixed capacity; overflow is counted, not grown.
        fired: new Int32Array(8192), firedCount: 0,
        controls: new Int32Array(1024), controlCount: 0, overflow: 0,
    };
    resetGraph(g);
    return g;
}

export function resetGraph(g) {
    g.tick = 0;
    g.stopRequested = false;
    g.muted.fill(0); g.mutedNotes.fill(0); g.mutedGroups.fill(0);
    for (const n of g.nets) n.state.set(n.initial);
    for (const id of g.project.initialMutes || []) {
        const i = g.byId.get(id);
        if (i !== undefined) g.muted[i] = 1;
    }
}

function isEnabled(n, t) {
    const s = n.state;
    const end = n.inStart[t + 1];
    if (n.inStart[t] === end) return false;
    for (let a = n.inStart[t]; a < end; a++) {
        const tok = n.inPlace[a] >= 0 ? s[n.inPlace[a]] : 0;
        if (n.inInhib[a]) { if (tok >= n.inW[a]) return false; }
        else if (tok < n.inW[a]) return false;
    }
    return true;
}

function fire(n, t) {
    const s = n.state;
    for (let a = n.inStart[t]; a < n.inStart[t + 1]; a++) {
        const p = n.inPlace[a];
        if (!n.inInhib[a] && p >= 0) { s[p] -= n.inW[a]; if (s[p] < 0) s[p] = 0; }
    }
    for (let a = n.outStart[t]; a < n.outStart[t + 1]; a++) {
        const p = n.outPlace[a];
        if (p >= 0) s[p] += n.outW[a];
    }
}

// Returns the number of survivors written back into n.enabled.
function resolveConflicts(n, count, tick) {
    n.placeCount.fill(0);
    let contested = false;
    for (let i = 0; i < count; i++) {
        const t = n.enabled[i];
        for (let a = n.inStart[t]; a < n.inStart[t + 1]; a++) {
            if (!n.inInhib[a] && n.inPlace[a] >= 0 && ++n.placeCount[n.inPlace[a]] > 1) contested = true;
        }
    }
    if (!contested) return count;
    n.blocked.fill(0);
    for (let p = 0; p < n.P; p++) {
        if (n.placeCount[p] < 2) continue;
        let c = 0;
        for (let i = 0; i < count; i++) {
            const t = n.enabled[i];
            for (let a = n.inStart[t]; a < n.inStart[t + 1]; a++) {
                if (!n.inInhib[a] && n.inPlace[a] === p) n.consumers[c++] = t;
            }
        }
        const winner = n.consumers[Math.floor(deterministicRand(tick, n.placeSalt[p]) * c)];
        for (let i = 0; i < c; i++) if (n.consumers[i] !== winner) n.blocked[n.consumers[i]] = 1;
    }
    let w = 0;
    for (let i = 0; i < count; i++) if (!n.blocked[n.enabled[i]]) n.enabled[w++] = n.enabled[i];
    return w;
}

function applyControl(g, n, t) {
    const tgt = n.actionTargetIdx[t];
    switch (n.action[t]) {
    case A_MUTE: if (tgt >= 0) g.muted[tgt] = 1; break;
    case A_UNMUTE: if (tgt >= 0) g.muted[tgt] = 0; break;
    case A_TOGGLE: if (tgt >= 0) g.muted[tgt] ^= 1; break;
    case A_MUTE_NOTE: if (tgt >= 0) g.mutedNotes[tgt * 128 + (n.actionNote[t] & 127)] = 1; break;
    case A_UNMUTE_NOTE: if (tgt >= 0) g.mutedNotes[tgt * 128 + (n.actionNote[t] & 127)] = 0; break;
    case A_TOGGLE_NOTE: if (tgt >= 0) g.mutedNotes[tgt * 128 + (n.actionNote[t] & 127)] ^= 1; break;
    case A_SLOT: {
        if (tgt < 0) break;
        const gi = g.nets[tgt].groupIdx;
        if (gi < 0) break;
        for (const o of g.nets) if (o.groupIdx === gi && o.index !== tgt) g.muted[o.index] = 1;
        if (!g.mutedGroups[gi]) g.muted[tgt] = 0;
        break;
    }
    case A_STOP: g.stopRequested = true; break;
    }
    if (g.controlCount < g.controls.length) {
        g.controls[g.controlCount++] = n.index; g.controls[g.controlCount++] = t;
    } else g.overflow++;
}

/**
 * tick(g, onNote) — advance every net one tick. onNote(net, t) is called for
 * each fired transition whose MIDI binding is audible (net un-muted, note
 * un-muted), in firing order. No allocation.
 */
export function tick(g, onNote) {
    g.tick++;
    g.firedCount = 0; g.controlCount = 0;
    for (let ni = 0; ni < g.nets.length; ni++) {
        const n = g.nets[ni];
        let count = 0;
        for (let t = 0; t < n.T; t++) if (isEnabled(n, t)) n.enabled[count++] = t;
        if (count > 1) count = resolveConflicts(n, count, g.tick);
        for (let i = 0; i < count; i++) {
            const t = n.enabled[i];
            fire(n, t);
            if (n.action[t]) applyControl(g, n, t);
            if (n.midi[t] && !g.muted[ni] && !g.mutedNotes[ni * 128 + (n.note[t] & 127)]) {
                if (g.firedCount < g.fired.length) {
                    g.fired[g.firedCount++] = ni; g.fired[g.firedCount++] = t;
                } else g.overflow++;
                if (onNote) onNote(n, t);
            }
        }
    }
}

/** Plain-object marking {netId: {place: tokens}} — for the UI, allocates. */
export function markingOf(g) {
    const out = {};
    for (const n of g.nets) {
        const m = {};
        for (let p = 0; p < n.P; p++) m[n.placeIds[p]] = n.state[p];
        out[n.id] = m;
    }
    return out;
}

// --- Incidence matrix and P-invariants ------------------------------------

/** C[p][t] = Σ weight(t→p) − Σ weight(p→t), inhibitor arcs excluded. */
export function incidenceMatrix(n) {
    const C = Array.from({ length: n.P }, () => new Float64Array(n.T));
    for (let t = 0; t < n.T; t++) {
        for (let a = n.inStart[t]; a < n.inStart[t + 1]; a++) {
            if (!n.inInhib[a] && n.inPlace[a] >= 0) C[n.inPlace[a]][t] -= n.inW[a];
        }
        for (let a = n.outStart[t]; a < n.outStart[t + 1]; a++) {
            if (n.outPlace[a] >= 0) C[n.outPlace[a]][t] += n.outW[a];
        }
    }
    return C;
}

/**
 * pInvariants(C) → basis of { y : yᵀC = 0 } (left null space), by Gaussian
 * elimination on Cᵀ. For any such y, y·M is constant under every firing.
 */
export function pInvariants(C) {
    const P = C.length, T = P ? C[0].length : 0;
    // Rows of A = Cᵀ (T × P); find null space of A.
    const A = Array.from({ length: T }, (_, t) => Float64Array.from({ length: P }, (_, p) => C[p][t]));
    const pivots = [];
    let r = 0;
    for (let c = 0; c < P && r < T; c++) {
        let best = r;
        for (let i = r + 1; i < T; i++) if (Math.abs(A[i][c]) > Math.abs(A[best][c])) best = i;
        if (Math.abs(A[best][c]) < 1e-12) continue;
        [A[r], A[best]] = [A[best], A[r]];
        const piv = A[r][c];
        for (let j = 0; j < P; j++) A[r][j] /= piv;
        for (let i = 0; i < T; i++) {
            if (i === r || A[i][c] === 0) continue;
            const f = A[i][c];
            for (let j = 0; j < P; j++) A[i][j] -= f * A[r][j];
        }
        pivots.push(c);
        r++;
    }
    const free = [];
    for (let c = 0; c < P; c++) if (!pivots.includes(c)) free.push(c);
    return free.map(fc => {
        const y = new Float64Array(P);
        y[fc] = 1;
        pivots.forEach((pc, row) => { y[pc] = -A[row][fc]; });
        return y;
    });
}
