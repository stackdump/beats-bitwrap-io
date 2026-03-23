/**
 * euclidean.js — Port of euclidean.go.
 * Bjorklund algorithm, ring layout, Euclidean rhythm and melodic arp generators.
 */

import { NetBundle } from '../pflow.js';
import { accentVelocity, clampVelocity } from './core.js';

/**
 * bjorklund distributes K pulses across N steps as evenly as possible.
 * Returns an array of 0s and 1s.
 */
export function bjorklund(k, n) {
    if (k >= n) {
        const result = new Array(n);
        for (let i = 0; i < n; i++) result[i] = 1;
        return result;
    }
    if (k === 0) {
        return new Array(n).fill(0);
    }

    // Build groups
    let groups = new Array(n);
    for (let i = 0; i < n; i++) {
        if (i < k) {
            groups[i] = [1];
        } else {
            groups[i] = [0];
        }
    }

    // Iteratively merge
    let kk = k;
    for (;;) {
        const remainder = groups.length - kk;
        if (remainder <= 1) break;

        let merges = kk;
        if (remainder < merges) merges = remainder;

        const newGroups = [];
        for (let i = 0; i < merges; i++) {
            newGroups.push(groups[i].concat(groups[groups.length - 1 - i]));
        }
        for (let i = merges; i < groups.length - merges; i++) {
            newGroups.push(groups[i]);
        }
        groups = newGroups;
        kk = merges;
        if (groups.length - kk <= 1) break;
    }

    // Flatten
    const result = [];
    for (const g of groups) {
        for (const v of g) result.push(v);
    }
    return result;
}

/**
 * ringLayout returns center and radius for a ring of n nodes.
 * Places sit at 0.7*radius, sized so each place gets ~70px spacing.
 */
export function ringLayout(n) {
    let radius = n * 70.0 / (2 * Math.PI * 0.7);
    if (radius < 150) radius = 150;
    const cx = radius + 80;
    const cy = radius + 80;
    return { cx, cy, radius };
}

/**
 * euclidean generates a Petri net ring from a Euclidean rhythm pattern.
 * K hits distributed across N steps using the Bjorklund algorithm.
 * The net is a cycle of N places with 1 circulating token.
 * Transitions at hit positions get MIDI bindings; others are silent.
 *
 * @param {number} k - Number of hits
 * @param {number} n - Number of steps
 * @param {number} rotation - Pattern rotation offset
 * @param {number} note - MIDI note number
 * @param {object} params - Generation params (channel, velocity, duration, accent)
 * @returns {{ bundle: NetBundle, netId: string }}
 */
export function euclidean(k, n, rotation, note, params) {
    let pattern = bjorklund(k, n);

    // Apply rotation
    if (rotation !== 0) {
        let rot = rotation % n;
        if (rot < 0) rot += n;
        const rotated = new Array(n);
        for (let i = 0; i < n; i++) {
            rotated[i] = pattern[(i + rot) % n];
        }
        pattern = rotated;
    }

    const nb = new NetBundle();
    const { cx, cy, radius } = ringLayout(n);

    // Create N places in a ring, token starts at p0
    for (let i = 0; i < n; i++) {
        const initial = i === 0 ? [1] : [0];
        const angle = (i / n) * 2 * Math.PI;
        const px = cx + radius * 0.7 * Math.cos(angle);
        const py = cy + radius * 0.7 * Math.sin(angle);
        nb.places[`p${i}`] = { initial, x: px, y: py };
    }

    // Create N transitions, connecting pi -> ti -> p(i+1 mod n)
    for (let i = 0; i < n; i++) {
        const tAngle = ((i + 0.5) / n) * 2 * Math.PI;
        const tx = cx + radius * Math.cos(tAngle);
        const ty = cy + radius * Math.sin(tAngle);
        nb.transitions[`t${i}`] = { x: tx, y: ty };

        // Arc: pi -> ti (consume)
        nb.arcs.push({ source: `p${i}`, target: `t${i}`, weight: [1], inhibit: false });
        // Arc: ti -> p(i+1 mod n) (produce)
        nb.arcs.push({ source: `t${i}`, target: `p${(i + 1) % n}`, weight: [1], inhibit: false });

        // MIDI binding only at hit positions
        if (pattern[i] === 1) {
            const vel = accentVelocity(i, n, params.velocity, params.accent);
            nb.bindings[`t${i}`] = {
                note:     note,
                channel:  params.channel,
                velocity: clampVelocity(vel),
                duration: params.duration,
            };
        }
    }

    nb.track = {
        channel: params.channel,
        defaultVelocity: params.velocity,
        instrument: '',
        instrumentSet: [],
    };
    nb.buildArcIndex();
    nb.resetState();

    return { bundle: nb, netId: `euclidean_${k}_${n}` };
}

/**
 * euclideanMelodic generates a ring where every step has a MIDI binding,
 * cycling through the provided notes. This creates an arpeggio pattern.
 *
 * @param {number[]} notes - MIDI note numbers to cycle through
 * @param {number} steps - Number of steps in the ring
 * @param {number} seed - Seed (unused in base implementation, reserved for future variation)
 * @param {object} params - Generation params (channel, velocity, duration)
 * @returns {{ bundle: NetBundle, netId: string }}
 */
export function euclideanMelodic(notes, steps, seed, params) {
    if (!notes || notes.length === 0) {
        notes = [60];
    }

    const nb = new NetBundle();
    const { cx, cy, radius } = ringLayout(steps);

    for (let i = 0; i < steps; i++) {
        const initial = i === 0 ? [1] : [0];
        const angle = (i / steps) * 2 * Math.PI;
        const px = cx + radius * 0.7 * Math.cos(angle);
        const py = cy + radius * 0.7 * Math.sin(angle);
        nb.places[`p${i}`] = { initial, x: px, y: py };

        const tAngle = ((i + 0.5) / steps) * 2 * Math.PI;
        const tx = cx + radius * Math.cos(tAngle);
        const ty = cy + radius * Math.sin(tAngle);
        nb.transitions[`t${i}`] = { x: tx, y: ty };

        // Arc: pi -> ti (consume)
        nb.arcs.push({ source: `p${i}`, target: `t${i}`, weight: [1], inhibit: false });
        // Arc: ti -> p(i+1 mod steps) (produce)
        nb.arcs.push({ source: `t${i}`, target: `p${(i + 1) % steps}`, weight: [1], inhibit: false });

        // Cycle through notes
        const note = notes[i % notes.length];
        nb.bindings[`t${i}`] = {
            note:     note,
            channel:  params.channel,
            velocity: params.velocity,
            duration: params.duration,
        };
    }

    nb.track = {
        channel: params.channel,
        defaultVelocity: params.velocity,
        instrument: '',
        instrumentSet: [],
    };
    nb.buildArcIndex();
    nb.resetState();

    return { bundle: nb, netId: 'arp' };
}
