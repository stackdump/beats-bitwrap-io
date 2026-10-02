/**
 * runner.js — WaveRunner: the net executor and the synthesis, sample by
 * sample. Shared verbatim by the AudioWorklet (worklet.js) and the offline
 * renderer (offline.js), so what the tests render is what the browser plays.
 *
 * Per sample: advance the tick clock; at a tick boundary fire the net
 * (net.js::tick) and add each audible fire's weight to its lane's gate; then
 * every active lane outputs gate × carrier, and the lanes are summed through
 * the master curve.
 *
 * The gate is realised as the IIR form of synth.js::envelope — one state per
 * exponential, multiplied down each sample and bumped by α·w at each onset.
 * That is exactly the closed form once a ring period has passed without a
 * control switch, and it keeps tails continuous across switches (a mute stops
 * new onsets; what is already sounding decays). process() never allocates.
 */

import { compileProject, resetGraph, tick as tickGraph } from './net.js';
import {
    PPQ, isDrumChannel, drumKind, drumVoice, tonalVoice,
    buildTable, TABLE_SIZE, noiseSeed, biquad,
} from './synth.js';

const L_GATE = 0, L_TONAL = 1;
const C_DC = 0, C_SWEEP = 1, C_NOISE = 2, C_NOISE_TONE = 3;
const SILENT = 1e-6;
const NO_LANES = Object.freeze([]);

// Every number that changes per sample lives in a typed array. V8 boxes a
// double written to an ordinary object field (and a double returned from a
// call it does not inline), which is an allocation per sample; typed-array
// slots are written in place. Lanes accumulate into ACC instead of returning.
const ENV = 0, PREV = 1, LEVEL = 2, PHASE = 3, SWEEP = 4, SWEEP_MUL = 5,
    F0 = 6, F1 = 7, TONE_INC = 8, TONE_MIX = 9, Z1 = 10, Z2 = 11,
    AM_DEPTH = 12, FM_DEPTH = 13, INV_SR = 14, ATT_MUL = 15, ST_SIZE = 16;
const ACC = new Float64Array(1);

const TABLES = {};
function table(wave) { return TABLES[wave] || (TABLES[wave] = buildTable(wave)); }

function laneState(voice, sr) {
    const st = new Float64Array(ST_SIZE);
    st[LEVEL] = voice.level;
    st[INV_SR] = 1 / sr;
    return st;
}

function gateLane(voice, sr, seed) {
    const E = voice.pulse.alpha.length;
    const st = laneState(voice, sr);
    const lane = {
        type: L_GATE, voice, active: false, st, E, sr,
        alpha: Float64Array.from(voice.pulse.alpha),
        mul: Float64Array.from(voice.pulse.tau, tau => Math.exp(-1 / (tau * sr))),
        s: new Float64Array(E),
        carrier: voice.carrier === 'dc' ? C_DC : voice.carrier === 'sweep' ? C_SWEEP
            : voice.carrier === 'noise+tone' ? C_NOISE_TONE : C_NOISE,
        rng: Int32Array.of(noiseSeed(seed)),
        bq: new Float64Array(5), am: null, fm: null,
        // Tonal-only fields, present so every lane has one hidden class.
        table: null, K: 0, inc: null, phase: null, sd: null, sa: null, md: null,
    };
    st[F0] = voice.f0 || 0; st[F1] = voice.f1 || 0;
    st[TONE_INC] = (voice.tone || 0) / sr; st[TONE_MIX] = voice.toneMix || 0;
    if (lane.carrier === C_SWEEP) st[SWEEP_MUL] = Math.exp(-1 / (voice.sweepTau * sr));
    if (lane.carrier === C_NOISE || lane.carrier === C_NOISE_TONE) {
        lane.bq = biquad(voice.filter, voice.fc, voice.q, sr);
    }
    return lane;
}

function tonalLane(voice, sr, poly) {
    const st = laneState(voice, sr);
    st[ATT_MUL] = Math.exp(-1 / (voice.attack * sr));
    return {
        type: L_TONAL, voice, active: false, st, E: 0, sr,
        alpha: null, mul: null, s: null, carrier: C_DC, rng: null, bq: null, am: null, fm: null,
        table: table(voice.wave), K: poly,
        inc: new Float64Array(poly), phase: new Float64Array(poly),
        sd: new Float64Array(poly), sa: new Float64Array(poly), md: new Float64Array(poly),
    };
}

// Onset of transition t of compiled net n on `lane`, at the runner's tempo.
function hit(runner, lane, n, t) {
    lane.active = true;
    const w = n.vel[t] / 127;
    if (lane.type === L_GATE) {
        for (let e = 0; e < lane.E; e++) lane.s[e] += lane.alpha[e] * w;
        if (lane.carrier === C_SWEEP) lane.st[SWEEP] = 1;
        return;
    }
    const steps = n.durSteps[t];
    const durMs = steps > 0 ? steps * 60000 / (runner.clock[TEMPO] * PPQ) : n.durMs[t];
    // Tonal: steal the quietest voice (deterministic), continue from its
    // current level so a stolen voice does not click.
    let v = 0, best = Infinity;
    for (let k = 0; k < lane.K; k++) {
        const a = Math.abs(lane.sd[k] + lane.sa[k]);
        if (a < best) { best = a; v = k; }
    }
    const cur = lane.sd[v] + lane.sa[v];
    // midiToHz and noteDecay (synth.js), inlined: a double passed to or
    // returned from a call V8 does not inline is boxed — an allocation.
    lane.inc[v] = 440 * Math.pow(2, (n.note[t] - 69) / 12) * lane.st[INV_SR];
    let tau = (durMs > 0 ? durMs : 100) / 1000 * lane.voice.decayScale;
    tau = tau < 0.03 ? 0.03 : tau > lane.voice.maxDecay ? lane.voice.maxDecay : tau;
    lane.md[v] = Math.exp(-lane.st[INV_SR] / tau);
    lane.sd[v] = w;
    lane.sa[v] = cur - w;
}

// One sample of `lane`, added into ACC[0].
function laneSample(lane) {
    const st = lane.st;
    if (lane.type === L_GATE) {
        let env = 0;
        for (let e = 0; e < lane.E; e++) { env += lane.s[e]; lane.s[e] *= lane.mul[e]; }
        st[ENV] = env;
        let c = 1;
        if (lane.carrier === C_SWEEP) {
            let f = st[F1] + (st[F0] - st[F1]) * st[SWEEP];
            st[SWEEP] *= st[SWEEP_MUL];
            if (lane.fm !== null) f *= 1 + st[FM_DEPTH] * lane.fm.st[PREV];
            let ph = st[PHASE] + f * st[INV_SR];
            ph -= Math.floor(ph);
            st[PHASE] = ph;
            c = Math.sin(2 * Math.PI * ph);
        } else if (lane.carrier !== C_DC) {
            let x = lane.rng[0];
            x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
            lane.rng[0] = x;
            const nz = (x | 0) / 2147483648;
            const b = lane.bq;
            const y = b[0] * nz + st[Z1];
            st[Z1] = b[1] * nz - b[3] * y + st[Z2];
            st[Z2] = b[2] * nz - b[4] * y;
            c = y;
            if (lane.carrier === C_NOISE_TONE) {
                let ph = st[PHASE] + st[TONE_INC];
                ph -= Math.floor(ph);
                st[PHASE] = ph;
                c = (1 - st[TONE_MIX]) * y + st[TONE_MIX] * Math.sin(2 * Math.PI * ph);
            }
        }
        let out = env * c * st[LEVEL];
        if (lane.am !== null) out *= 1 - st[AM_DEPTH] + st[AM_DEPTH] * lane.am.st[PREV];
        ACC[0] += out;
        if (Math.abs(lane.s[0]) < SILENT && (lane.E < 2 || Math.abs(lane.s[1]) < SILENT)) {
            lane.active = false;
            st[ENV] = 0;
        }
        return;
    }
    // Tonal pool
    let out = 0, envSum = 0, live = false;
    const tb = lane.table;
    const fmk = lane.fm !== null ? 1 + st[FM_DEPTH] * lane.fm.st[PREV] : 1;
    const am = st[ATT_MUL];
    for (let k = 0; k < lane.K; k++) {
        const sd = lane.sd[k], sa = lane.sa[k];
        if (Math.abs(sd) < SILENT && Math.abs(sa) < SILENT) continue;
        live = true;
        const env = sd + sa;
        envSum += env;
        lane.sd[k] = sd * lane.md[k];
        lane.sa[k] = sa * am;
        let ph = lane.phase[k] + lane.inc[k] * fmk;
        ph -= Math.floor(ph);
        lane.phase[k] = ph;
        const x = ph * TABLE_SIZE, i = x | 0, fr = x - i;
        out += env * (tb[i] + (tb[i + 1] - tb[i]) * fr);
    }
    st[ENV] = envSum;
    if (!live) lane.active = false;
    out *= st[LEVEL];
    if (lane.am !== null) out *= 1 - st[AM_DEPTH] + st[AM_DEPTH] * lane.am.st[PREV];
    ACC[0] += out;
}

/**
 * buildLanes(graph, sr, opts) — one lane per (music net, drum kind) for drum
 * channels, one pooled tonal lane per other music net. Writes the lane index
 * of every MIDI-bound transition into net.lane.
 */
function buildLanes(g, sr, opts) {
    const lanes = [];
    const byNet = new Map();
    for (const n of g.nets) {
        if (n.bundle.role === 'control') continue;
        const tr = n.bundle.track || {};
        const override = opts.voices && opts.voices[n.id];
        const kindLane = new Map();
        for (let t = 0; t < n.T; t++) {
            if (!n.midi[t]) continue;
            const ch = n.bundle.bindings[n.transIds[t]].channel || tr.channel;
            const key = override ? 'v' : isDrumChannel(ch) ? drumKind(n.note[t]) : 'tonal';
            if (!kindLane.has(key)) {
                let lane;
                if (override) lane = override.kind === 'tonal' ? tonalLane(override, sr, 4) : gateLane(override, sr, lanes.length);
                else if (key === 'tonal') lane = tonalLane(tonalVoice(tr.instrument, tr.group), sr, tr.group === 'harmony' ? 6 : 4);
                else lane = gateLane(drumVoice(key, tr.instrument), sr, lanes.length);
                lane.netId = n.id;
                kindLane.set(key, lanes.length);
                lanes.push(lane);
            }
            n.lane[t] = kindLane.get(key);
        }
        if (kindLane.size) byNet.set(n.id, [...kindLane.values()]);
    }
    // Nested modulation: an outer ring's gate scales (am) or bends (fm) an
    // inner ring. The source's previous-sample gate (`prev`) is used, so
    // the order lanes are evaluated in never matters.
    const sources = [];
    for (const m of opts.mods || []) {
        const src = byNet.get(m.source), dst = byNet.get(m.target);
        if (!src || !dst) continue;
        for (const li of dst) {
            if (m.kind === 'fm') { lanes[li].fm = lanes[src[0]]; lanes[li].st[FM_DEPTH] = m.depth; }
            else { lanes[li].am = lanes[src[0]]; lanes[li].st[AM_DEPTH] = m.depth; }
        }
        if (m.silentSource) for (const li of src) lanes[li].st[LEVEL] = 0;
        if (!sources.includes(lanes[src[0]])) sources.push(lanes[src[0]]);
    }
    return { lanes, byNet, sources };
}

// Runner clock slots (typed for the same reason as lane state).
const TICK_POS = 0, SPT = 1, TEMPO = 2, SAMPLES = 3;

export class WaveRunner {
    /**
     * opts.master     'soft' (tanh, default) | 'linear' (tests)
     * opts.masterGain default 0.8
     * opts.voices     {netId: voice spec} — override a net's voice
     * opts.mods       [{target, source, kind: 'am'|'fm', depth, silentSource}]
     * opts.onTick     (runner) => void, after every tick (offline only)
     */
    constructor(sampleRate, opts = {}) {
        this.sr = sampleRate;
        this.opts = opts;
        this.masterGain = opts.masterGain ?? 0.8;
        this.linear = opts.master === 'linear';
        this.graph = null; this.lanes = NO_LANES; this.byNet = new Map(); this.sources = NO_LANES;
        this.pending = null;      // {graph, lanes, byNet, sources} swapped at a bar boundary
        this.fading = NO_LANES;   // lanes of a swapped-out project, ringing out
        this.playing = false;
        this.clock = new Float64Array(4);
        this.clock[TEMPO] = 120;
        this.clock[SPT] = this._spt(120);
        this.ticksInBlock = 0;
        this.stopped = false;     // set when a stop-transport control fires
        this.probe = null;        // {lane, buf: Float64Array, pos} — records a lane's gate
        this._onNote = (n, t) => {
            const li = n.lane[t];
            if (li >= 0) hit(this, this.lanes[li], n, t);
        };
    }

    get tempo() { return this.clock[TEMPO]; }
    get samples() { return this.clock[SAMPLES]; }

    _spt(bpm) { return this.sr * 60 / (bpm * PPQ); }

    /** Compile a project JSON. Applied now when stopped, at the next bar when playing. */
    load(json) {
        const graph = compileProject(json);
        const built = buildLanes(graph, this.sr, this.opts);
        const next = { graph, lanes: built.lanes, byNet: built.byNet, sources: built.sources };
        if (this.playing && this.graph) { this.pending = next; return; }
        this._install(next);
    }

    _install(next) {
        // Pointer swap, no allocation: the old project's lanes ring out.
        if (this.graph) this.fading = this.lanes;
        this.graph = next.graph; this.lanes = next.lanes; this.byNet = next.byNet;
        this.sources = next.sources;
        this.setTempo(next.graph.tempo);
    }

    play() {
        if (!this.graph || this.playing) return;
        this.playing = true;
        this.stopped = false;
        this.clock[TICK_POS] = this.clock[SPT] - 1; // first tick lands on the next sample
    }

    pause() { this.playing = false; }

    stop() {
        this.playing = false;
        if (this.graph) resetGraph(this.graph);
    }

    setTempo(bpm) {
        if (!(bpm > 0)) return;
        const c = this.clock;
        const frac = c[TICK_POS] / c[SPT];
        c[TEMPO] = bpm;
        if (this.graph) this.graph.tempo = bpm;
        c[SPT] = this._spt(bpm);
        c[TICK_POS] = frac * c[SPT];
    }

    setMute(netId, muted) {
        const i = this.graph?.byId.get(netId);
        if (i !== undefined) this.graph.muted[i] = muted ? 1 : 0;
    }

    /** The lane(s) a net renders through — tests use this to probe a gate. */
    lanesOf(netId) { return (this.byNet.get(netId) || []).map(i => this.lanes[i]); }

    _tick() {
        const g = this.graph;
        if (this.pending && (g.tick + 1) % 16 === 0) {
            const next = this.pending;
            this.pending = null;
            this._install(next);
            this.ticksInBlock++;
            return;
        }
        tickGraph(g, this._onNote);
        this.ticksInBlock++;
        if (this.opts.onTick) this.opts.onTick(this);
        if (g.stopRequested) { this.stopped = true; this.stop(); }
    }

    /** Render `frames` samples into L (and R, if given). Allocation-free. */
    process(L, R, frames) {
        this.ticksInBlock = 0;
        const probe = this.probe;
        const c = this.clock;
        const gain = this.masterGain, linear = this.linear;
        for (let i = 0; i < frames; i++) {
            if (this.playing) {
                c[TICK_POS] += 1;
                if (c[TICK_POS] >= c[SPT]) {
                    c[TICK_POS] -= c[SPT];
                    this._tick();
                }
            }
            ACC[0] = 0;
            const lanes = this.lanes, fading = this.fading;
            for (let l = 0; l < lanes.length; l++) {
                const lane = lanes[l];
                if (lane.active) laneSample(lane);
                else lane.st[ENV] = 0;
            }
            for (let l = 0; l < fading.length; l++) {
                if (fading[l].active) laneSample(fading[l]);
            }
            const src = this.sources;
            for (let l = 0; l < src.length; l++) src[l].st[PREV] = src[l].st[ENV];
            if (probe !== null && probe.pos < probe.buf.length) probe.buf[probe.pos++] = probe.lane.st[ENV];
            const y = linear ? ACC[0] : Math.tanh(ACC[0] * gain);
            L[i] = y;
            if (R) R[i] = y;
            c[SAMPLES] += 1;
        }
        const fading = this.fading;
        if (fading.length) {
            let any = false;
            for (let l = 0; l < fading.length; l++) if (fading[l].active) { any = true; break; }
            if (!any) this.fading = NO_LANES;
        }
    }
}
