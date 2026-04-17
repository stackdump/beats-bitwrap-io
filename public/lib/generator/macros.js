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

/** Net IDs for macro-spawned control nets all share this prefix. */
export const MACRO_NET_PREFIX = 'macro:';

/** Delete all macro-spawned nets from a project (used on stop and loop wrap). */
export function pruneMacroNets(project) {
    if (!project || !project.nets) return;
    for (const id of Object.keys(project.nets)) {
        if (id.startsWith(MACRO_NET_PREFIX)) delete project.nets[id];
    }
}
