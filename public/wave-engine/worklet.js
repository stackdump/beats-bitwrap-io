/**
 * worklet.js — AudioWorkletProcessor 'wave-engine'.
 *
 * The Petri-net executor runs here, on the audio thread, so a tick lands on
 * an exact sample. Each 128-frame process() call renders through
 * WaveRunner.process(), which never allocates. Messages back to the page
 * (fired transitions for the canvas, the marking for the Stage visualizers,
 * mute state, control events) are posted only on blocks that contained a
 * tick — a few per second — and those posts are the one place this thread
 * allocates.
 *
 * Port protocol (page → worklet):
 *   {type:'load', project}            project JSON (projectToJSON shape)
 *   {type:'transport', action}        'play' | 'stop' | 'pause'
 *   {type:'tempo', bpm}
 *   {type:'mute', netId, muted}
 * (worklet → page):
 *   {type:'wave-tick', tick, fired:[[netId, transId, midi]], controls:[[netId, transId, control]],
 *    state?: {netId:{place:tokens}}, mutedNets?: {netId: bool}}
 *   {type:'playback-complete'}
 */

import { WaveRunner } from './runner.js';
import { markingOf } from './net.js';

const STATE_EVERY = 6; // ticks between marking posts, as in the sequencer worker

class WaveEngineProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.runner = new WaveRunner(sampleRate);
        this.port.onmessage = (e) => this.onMessage(e.data);
    }

    onMessage(msg) {
        const r = this.runner;
        switch (msg.type) {
        case 'load': r.load(msg.project); break;
        case 'transport':
            if (msg.action === 'play') r.play();
            else if (msg.action === 'pause') r.pause();
            else r.stop();
            break;
        case 'tempo': r.setTempo(msg.bpm); break;
        case 'mute': r.setMute(msg.netId, msg.muted); break;
        }
    }

    process(inputs, outputs) {
        const out = outputs[0];
        if (!out || !out[0]) return true;
        const r = this.runner;
        r.process(out[0], out[1] || null, out[0].length);
        if (r.ticksInBlock && r.graph) this.report();
        return true;
    }

    report() {
        const g = this.runner.graph;
        const fired = [];
        for (let i = 0; i < g.firedCount; i += 2) {
            const n = g.nets[g.fired[i]], t = g.fired[i + 1];
            const midi = n.bundle.bindings[n.transIds[t]];
            fired.push([n.id, n.transIds[t], midi]);
        }
        const controls = [];
        for (let i = 0; i < g.controlCount; i += 2) {
            const n = g.nets[g.controls[i]], t = g.controls[i + 1];
            controls.push([n.id, n.transIds[t], n.bundle.controlBindings[n.transIds[t]]]);
        }
        const msg = { type: 'wave-tick', tick: g.tick, fired, controls };
        if (g.tick % STATE_EVERY === 0) msg.state = markingOf(g);
        if (controls.length) {
            const muted = {};
            for (const n of g.nets) muted[n.id] = !!g.muted[n.index];
            msg.mutedNets = muted;
        }
        this.port.postMessage(msg);
        if (this.runner.stopped) {
            this.runner.stopped = false;
            this.port.postMessage({ type: 'playback-complete' });
        }
    }
}

registerProcessor('wave-engine', WaveEngineProcessor);
