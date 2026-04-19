/**
 * macros.js — Build transient control nets that drive live-performance macros.
 *
 * A macro mutes (or otherwise affects) a target track immediately, then relies on
 * a short control net to fire the restoring action N ticks later. The net is a
 * linear chain of N transitions; the final transition carries the restore action.
 * Each tick advances the token one step, so the final transition fires on the
 * Nth tick after injection — tick-locked, tempo-agnostic in tick terms.
 */

import { NetBundle } from '../pflow.js';

/**
 * Build a linear-chain control net that fires a single control binding after N ticks.
 *
 * @param {string} netId — ID this bundle will occupy in project.nets (should start with `macro:`).
 * @param {string} targetNetId — Net the restore action targets.
 * @param {number} durationTicks — Number of ticks to wait before firing restore (>= 1).
 * @param {string} [restoreAction='unmute-track'] — Action carried by the terminal transition.
 */
export function buildMacroRestoreNet(netId, targetNetId, durationTicks, restoreAction = 'unmute-track') {
    const N = Math.max(1, Math.round(durationTicks));
    const nb = new NetBundle();

    // Places p0..pN (token starts at p0)
    for (let i = 0; i <= N; i++) {
        nb.places[`p${i}`] = { initial: [i === 0 ? 1 : 0], x: 100 + i * 40, y: 100 };
    }
    // Transitions t0..t{N-1} forming a linear chain
    for (let i = 0; i < N; i++) {
        nb.transitions[`t${i}`] = { x: 120 + i * 40, y: 100 };
        nb.arcs.push({ source: `p${i}`, target: `t${i}`, weight: [1], inhibit: false });
        nb.arcs.push({ source: `t${i}`, target: `p${i + 1}`, weight: [1], inhibit: false });
    }
    // Terminal transition carries the restore action
    nb.controlBindings[`t${N - 1}`] = {
        action: restoreAction,
        targetNet: targetNetId,
        targetNote: 0,
    };

    nb.role = 'control';
    nb.track = { channel: 1, defaultVelocity: 100, instrument: '', instrumentSet: [] };
    nb.buildArcIndex();
    nb.resetState();
    return nb;
}

/**
 * Build a one-transition control net that fires a `fire-macro` binding on
 * its very first tick. Used to bake Auto-DJ transition macros into a freshly
 * generated project so the macro executes *as part of* normal net execution
 * (synchronized to the worker's tick clock) rather than racing against
 * project-load from the main thread. The MACRO_NET_PREFIX id ensures the
 * net is pruned automatically on stop / loop-wrap.
 */
export function buildTransitionFireNet(netId, macroId) {
    const nb = new NetBundle();
    nb.places['p0'] = { initial: [1], x: 100, y: 100 };
    nb.places['p1'] = { initial: [0], x: 140, y: 100 };
    nb.transitions['t0'] = { x: 120, y: 100 };
    nb.arcs.push({ source: 'p0', target: 't0', weight: [1], inhibit: false });
    nb.arcs.push({ source: 't0', target: 'p1', weight: [1], inhibit: false });
    nb.controlBindings['t0'] = {
        action: 'fire-macro',
        macroId,
        targetNet: '',
        targetNote: 0,
    };
    nb.role = 'control';
    nb.track = { channel: 1, defaultVelocity: 100, instrument: '', instrumentSet: [] };
    nb.buildArcIndex();
    nb.resetState();
    return nb;
}

/** Net IDs for macro-spawned control nets all share this prefix. */
export const MACRO_NET_PREFIX = 'macro:';

/** Delete all macro-spawned nets from a project (used on stop and loop wrap). */
export function pruneMacroNets(project) {
    if (!project || !project.nets) return;
    for (const id of Object.keys(project.nets)) {
        if (id.startsWith(MACRO_NET_PREFIX)) delete project.nets[id];
    }
}
