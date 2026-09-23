// A minimal Petri-net sequencer in the shape the studio uses: each track is a
// token ring, a transition may carry a `midi` binding, and one clock tick
// fires every enabled transition. The addition here is that the clock can run
// BACKWARDS: a jog wheel drags the playhead both ways, and a ring net is
// reversible, so stepping back un-fires the transition whose output holds the
// token. The marking after scrubbing out and back is the marking you left.

import { bjorklund } from '../lib/generator/euclidean.js';

export function ringNet(id, steps, bindings) {
    const places = new Array(steps).fill(0);
    places[0] = 1;
    const transitions = [];
    for (let i = 0; i < steps; i++) {
        transitions.push({
            id: `t${i}`,
            inputs: [{ place: i, weight: 1 }],
            outputs: [{ place: (i + 1) % steps, weight: 1 }],
            midi: bindings[i] || null,
        });
    }
    return { id, places, transitions };
}

const enabled = (net, t) => t.inputs.every((a) => net.places[a.place] >= a.weight);
const reversible = (net, t) => t.outputs.every((a) => net.places[a.place] >= a.weight);

function fire(net, t) {
    for (const a of t.inputs) net.places[a.place] -= a.weight;
    for (const a of t.outputs) net.places[a.place] += a.weight;
}

function unfire(net, t) {
    for (const a of t.outputs) net.places[a.place] -= a.weight;
    for (const a of t.inputs) net.places[a.place] += a.weight;
}

export class PetriClock {
    constructor(nets) {
        this.nets = nets;
        this.tick = 0;
    }

    // One tick forward. Returns the midi bindings that fired.
    stepForward() {
        const events = [];
        for (const net of this.nets) {
            for (const t of net.transitions.filter((t) => enabled(net, t))) {
                fire(net, t);
                if (t.midi) events.push({ net: net.id, ...t.midi });
            }
        }
        this.tick++;
        return events;
    }

    stepBackward() {
        const events = [];
        for (const net of this.nets) {
            for (const t of net.transitions.filter((t) => reversible(net, t))) {
                unfire(net, t);
                if (t.midi) events.push({ net: net.id, ...t.midi });
            }
        }
        this.tick--;
        return events;
    }

    // Bring the marking to a (fractional) playhead position.
    syncTo(tickFloat) {
        const want = Math.floor(tickFloat);
        const events = [];
        while (this.tick < want) events.push(...this.stepForward());
        while (this.tick > want) events.push(...this.stepBackward());
        return events;
    }
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Four Euclidean rings; the bass ring is 32 steps so the loop is two bars.
export function demoNets(seed = 7) {
    const rot = (pattern, r) => pattern.map((_, i) => pattern[(i - r + pattern.length) % pattern.length]);
    const bind = (pattern, fn) => Object.fromEntries(
        pattern.map((hit, i) => [i, hit ? fn(i) : null]).filter(([, v]) => v));

    const rng = mulberry32(seed);
    const scale = [33, 36, 38, 40, 43, 45, 48]; // A minor pentatonic, bass register
    let degree = 0;
    const bass = bind(bjorklund(13, 32), (i) => {
        if (i % 16 === 0) degree = 0;
        else degree = Math.max(0, Math.min(scale.length - 1, degree + Math.floor(rng() * 5) - 2));
        return { note: scale[degree], velocity: i % 4 === 0 ? 110 : 85 };
    });

    return [
        ringNet('kick', 16, bind(bjorklund(4, 16), () => ({ note: 36, velocity: 120 }))),
        ringNet('snare', 16, bind(rot(bjorklund(2, 16), 4), () => ({ note: 38, velocity: 105 }))),
        ringNet('hat', 16, bind(bjorklund(11, 16), (i) => ({ note: 42, velocity: i % 2 ? 60 : 90 }))),
        ringNet('bass', 32, bass),
    ];
}

export const LOOP_TICKS = 32;
