/**
 * arrange.js — Port of Go arrange.go
 * Fade in/out, drum break, and chorus arrangement control nets.
 */

import { ringLayout } from './euclidean.js';
import { NetBundle } from '../pflow.js';

// --- fadeControlNet (internal helper) ---

/**
 * Creates a single-hit control net in a ring of `steps` places.
 * The control binding fires at position `hitPos`.
 * @param {string} targetNet
 * @param {string} action - 'mute-track' or 'unmute-track'
 * @param {number} steps
 * @param {number} hitPos
 * @returns {NetBundle}
 */
function fadeControlNet(targetNet, action, steps, hitPos) {
    if (hitPos >= steps) hitPos = steps - 1;

    const bundle = new NetBundle();
    const { cx, cy, radius } = ringLayout(steps);

    for (let i = 0; i < steps; i++) {
        const initial = i === 0 ? 1 : 0;
        const angle = (i / steps) * 2 * Math.PI;
        const x = cx + radius * 0.7 * Math.cos(angle);
        const y = cy + radius * 0.7 * Math.sin(angle);
        const pLabel = `p${i}`;
        bundle.places[pLabel] = { initial: [initial], x, y };

        const tLabel = `t${i}`;
        const tAngle = ((i + 0.5) / steps) * 2 * Math.PI;
        const tx = cx + radius * Math.cos(tAngle);
        const ty = cy + radius * Math.sin(tAngle);
        bundle.transitions[tLabel] = { x: tx, y: ty };

        // Ring: pi -> ti -> p(i+1)%steps
        bundle.arcs.push(
            { source: pLabel, target: tLabel, weight: [1], inhibit: false },
            { source: tLabel, target: `p${(i + 1) % steps}`, weight: [1], inhibit: false },
        );

        if (i === hitPos) {
            bundle.controlBindings[tLabel] = {
                action,
                targetNet,
                targetNote: 0,
            };
        }
    }

    bundle.track = { channel: 1, defaultVelocity: 100, instrument: '', instrumentSet: [] };
    bundle.role = 'control';

    bundle.buildArcIndex();
    bundle.resetState();

    return bundle;
}

// --- fadeIn ---

/**
 * Adds control nets that sequentially unmute targets over time.
 * Each target gets a long-cycle control net that fires unmute at staggered offset.
 * Targets should start muted.
 * @param {object} proj - project with .nets map
 * @param {string[]} targets - net IDs to fade in
 * @param {number} steps - cycle length
 * @param {number} seed
 * @returns {string[]} net IDs that should start muted
 */
export function fadeIn(proj, targets, steps, seed) {
    if (steps < 8) steps = 32;

    const mutedNets = [];
    for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        if (!proj.nets[target]) continue;

        mutedNets.push(target);

        // Stagger: each target unmutes at a different offset in the cycle
        const offset = (i + 1) * Math.floor(steps / (targets.length + 1));
        const netId = `fade-in-${target}`;
        proj.nets[netId] = fadeControlNet(target, 'unmute-track', steps, offset);
    }
    return mutedNets;
}

// --- fadeOut ---

/**
 * Adds control nets that sequentially mute targets toward end of cycle.
 * @param {object} proj - project with .nets map
 * @param {string[]} targets - net IDs to fade out
 * @param {number} steps - cycle length
 * @param {number} seed
 */
export function fadeOut(proj, targets, steps, seed) {
    if (steps < 8) steps = 32;

    for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        if (!proj.nets[target]) continue;

        // Stagger from end: first target mutes earliest
        const offset = steps - (targets.length - i) * Math.floor(steps / (targets.length + 1));
        const netId = `fade-out-${target}`;
        proj.nets[netId] = fadeControlNet(target, 'mute-track', steps, offset);
    }
}

// --- drumBreak ---

/**
 * Adds a control net that toggles targets off for a break, then back on.
 * Two control transitions: one mutes, one unmutes, in a long ring cycle.
 * @param {object} proj - project with .nets map
 * @param {string[]} targets - net IDs to break
 * @param {number} cycleLen
 * @param {number} breakLen
 * @param {number} seed
 */
export function drumBreak(proj, targets, cycleLen, breakLen, seed) {
    if (cycleLen < 16) cycleLen = 64;
    if (breakLen < 4) breakLen = 8;
    if (breakLen >= cycleLen) breakLen = Math.floor(cycleLen / 4);

    for (const target of targets) {
        if (!proj.nets[target]) continue;

        const bundle = new NetBundle();
        const { cx, cy, radius } = ringLayout(cycleLen);

        // Mute position and unmute position
        const mutePos = Math.floor(cycleLen / 2);
        const unmutePos = mutePos + breakLen;

        for (let i = 0; i < cycleLen; i++) {
            const initial = i === 0 ? 1 : 0;
            const angle = (i / cycleLen) * 2 * Math.PI;
            const x = cx + radius * 0.7 * Math.cos(angle);
            const y = cy + radius * 0.7 * Math.sin(angle);
            const pLabel = `p${i}`;
            bundle.places[pLabel] = { initial: [initial], x, y };

            const tLabel = `t${i}`;
            const tAngle = ((i + 0.5) / cycleLen) * 2 * Math.PI;
            const tx = cx + radius * Math.cos(tAngle);
            const ty = cy + radius * Math.sin(tAngle);
            bundle.transitions[tLabel] = { x: tx, y: ty };

            // Ring: pi -> ti -> p(i+1)%cycleLen
            bundle.arcs.push(
                { source: pLabel, target: tLabel, weight: [1], inhibit: false },
                { source: tLabel, target: `p${(i + 1) % cycleLen}`, weight: [1], inhibit: false },
            );

            if (i === mutePos) {
                bundle.controlBindings[tLabel] = {
                    action: 'mute-track',
                    targetNet: target,
                    targetNote: 0,
                };
            } else if (i === unmutePos % cycleLen) {
                bundle.controlBindings[tLabel] = {
                    action: 'unmute-track',
                    targetNet: target,
                    targetNote: 0,
                };
            }
        }

        bundle.track = { channel: 1, defaultVelocity: 100, instrument: '', instrumentSet: [] };
        bundle.role = 'control';

        bundle.buildArcIndex();
        bundle.resetState();

        const netId = `break-${target}`;
        proj.nets[netId] = bundle;
    }
}
