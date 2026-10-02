#!/usr/bin/env node
//
// Wave engine tests — no bundler, no npm, plain `node`.
//
//   node scripts/test-wave-engine.mjs        # or: make test-wave
//
// 1. Determinism: same (genre, seed, structure) → byte-identical WAV.
// 2. P-invariants: for every net, every basis vector y of {yᵀC = 0} keeps
//    y·M constant at every tick of a full structured render.
// 3. Spectrum: the DFT of a single ring's rendered gate equals the c_k
//    predicted from the DFT of its place weights.
// 4. Closed form: the IIR gate equals synth.js::envelope(ring, marking,
//    phase) at every sample once the ring is stationary.
// 5. Executor parity: the compiled executor reproduces the sequencer
//    worker's tick semantics (markings, audible fires, controls, conflicts).
// 6. Nesting: an AM-nested ring is the product of the two gates.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderOffline, composeProject, encodeWav } from '../public/wave-engine/offline.js';
import { compileProject, tick, incidenceMatrix, pInvariants, deterministicRand, strHash } from '../public/wave-engine/net.js';
import { ringOf, envelope, ringSpectrum, pulse } from '../public/wave-engine/synth.js';
import { parseProject } from '../public/lib/pflow.js';
import { WaveRunner } from '../public/wave-engine/runner.js';

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) failures++;
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

// --- 1. Determinism --------------------------------------------------------
{
    const render = (seed) => {
        const r = renderOffline({ genre: 'techno', seed, structure: 'standard', seconds: 12 });
        return sha(encodeWav([r.left, r.right], 48000));
    };
    const a = render(42), b = render(42), c = render(43);
    check('determinism: two renders of techno/42/standard are byte-identical', a === b, a.slice(0, 16));
    check('determinism: a different seed renders different bytes', a !== c);

    // Two separate processes, through the CLI.
    const here = dirname(fileURLToPath(import.meta.url));
    const cli = () => spawnSync(process.execPath, [join(here, 'wave-render.mjs'), '--genre', 'techno', '--seed', '42',
        '--structure', 'standard', '--seconds', '12', '--sha'], { encoding: 'utf8' }).stdout.trim();
    const p1 = cli(), p2 = cli();
    check('determinism: two separate processes write byte-identical WAVs', p1 === p2 && p1 === a, p1.slice(0, 16));
}

// --- 1b. Allocation in the audio callback ----------------------------------
{
    // Needs --expose-gc, so it runs in a child. Two properties:
    //  - the per-sample path (lanes, gates, carriers, mix) allocates nothing:
    //    with ticks frozen, 40k blocks must not grow the heap (a single boxed
    //    double per sample would be ≥ 2 kB/block);
    //  - tick-boundary work (net firing + note onsets, ~8×/s) is cold code
    //    that V8 leaves in its baseline tiers, where double temporaries are
    //    boxed. It is bounded per tick, not per sample: assert < 1 kB/tick.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = `
        import { WaveRunner } from ${JSON.stringify(join(here, '../public/wave-engine/runner.js'))};
        import { composeProject } from ${JSON.stringify(join(here, '../public/wave-engine/offline.js'))};
        const L = new Float32Array(128), R = new Float32Array(128);
        // Loop mode: a song-mode project stops itself (struct-stop) mid-run.
        let ticks = 0;
        const r = new WaveRunner(48000, { onTick: () => { ticks++; } });
        r.load(composeProject('edm', 42)); r.play();
        for (let i = 0; i < 30000; i++) r.process(L, R, 128);
        const measure = (N) => { gc(); gc(); const t0 = ticks, h0 = process.memoryUsage().heapUsed;
            for (let i = 0; i < N; i++) r.process(L, R, 128);
            return [(process.memoryUsage().heapUsed - h0), ticks - t0]; };
        const [playBytes, played] = measure(40000);
        r.playing = false;
        const [idleBytes] = measure(40000);
        console.log(JSON.stringify({ perBlockNoTicks: idleBytes / 40000, perTick: playBytes / played, ticks: played }));`;
    const res = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', src], { encoding: 'utf8' });
    let m = null;
    try { m = JSON.parse(res.stdout.trim().split('\n').pop()); } catch {}
    check('allocation: per-sample path allocates nothing', m && m.perBlockNoTicks < 1,
        m ? `${m.perBlockNoTicks.toFixed(2)} bytes/block with ticks frozen` : res.stderr.slice(0, 200));
    check('allocation: tick-boundary work is bounded per tick', m && m.perTick < 1024,
        m ? `${m.perTick.toFixed(0)} bytes/tick over ${m.ticks} ticks (${process.version})` : '');
}

// --- 2. P-invariants at every tick -----------------------------------------
{
    const project = composeProject('techno', 42, 'standard');
    const g = compileProject(project);
    const inv = g.nets.map(n => {
        const ys = pInvariants(incidenceMatrix(n));
        return ys.map(y => {
            let v = 0;
            for (let p = 0; p < n.P; p++) v += y[p] * n.state[p];
            return { y, v };
        });
    });
    // Music rings conserve their one token: the all-ones vector must be in
    // the basis. The struct-* control nets are not conservative — delay
    // tokens are drained and the last gate is a sink — so they may have no
    // invariant at all; they are reported, not failed.
    const ones = (n, ys) => ys.some(({ y }) => {
        const nz = y.find(v => Math.abs(v) > 1e-12);
        return nz !== undefined && y.every(v => Math.abs(v - nz) < 1e-9);
    });
    const music = g.nets.filter(n => n.bundle.role !== 'control');
    const badRings = music.filter(n => !ones(n, inv[n.index]));
    check('P-invariants: every music ring has the all-ones invariant (one token, conserved)',
        badRings.length === 0, `${music.length - badRings.length}/${music.length} rings`);
    const none = g.nets.filter((n, i) => inv[i].length === 0).map(n => n.id);
    console.log(`     (non-conservative control nets, no P-invariant: ${none.join(', ') || 'none'})`);
    let ticks = 0, worst = 0, breaches = 0;
    const totalSteps = project.structure.reduce((s, x) => s + x.steps, 0);
    while (ticks < totalSteps + 32) {
        tick(g, null);
        ticks++;
        for (let i = 0; i < g.nets.length; i++) {
            const n = g.nets[i];
            for (const { y, v } of inv[i]) {
                let w = 0;
                for (let p = 0; p < n.P; p++) w += y[p] * n.state[p];
                const d = Math.abs(w - v);
                if (d > worst) worst = d;
                if (d > 1e-9) breaches++;
            }
        }
    }
    check('P-invariants: y·M constant at every tick of a full techno/standard song',
        breaches === 0, `${ticks} ticks × ${g.nets.length} nets, max drift ${worst.toExponential(1)}`);
}

// --- shared: an isolated ring with a DC carrier ------------------------------
// The techno hi-hat ring (8 steps, accented hits + seeded ghost notes) has
// non-trivial weights, so its spectrum is a real test of the DFT relation.
const SR = 48000, BPM = 120, M = 6000; // one tick = 0.125 s = 6000 samples exactly
const PULSE = pulse(0.001, 0.05);
function isolatedRing(netId = 'hihat') {
    const proj = composeProject('techno', 42);
    const net = proj.nets[netId];
    return {
        name: 'ring', tempo: BPM,
        nets: { [netId]: { ...net, track: { ...net.track } } },
        initialMutes: [],
    };
}
const ringProject = isolatedRing();
const ring = ringOf(parseProject(ringProject).nets.hihat);
const n = ring.n, N = n * M, WARM = 8;

function renderGate(project, opts = {}) {
    const r = renderOffline({
        project, sampleRate: SR, seconds: (WARM + 1) * N / SR,
        runner: { master: 'linear', voices: { hihat: { kind: 'dc', carrier: 'dc', pulse: PULSE, level: 1 } }, ...opts },
    });
    return r;
}

// --- 3. Spectrum: DFT of the rendered gate vs predicted c_k -------------------
{
    // Probe the gate (not the output) by rendering with a DC carrier and a
    // linear master: output ≡ gate.
    const { left } = renderGate(ringProject);
    const win = left.subarray(WARM * N, (WARM + 1) * N);
    const K = 48;
    const pred = ringSpectrum(ring.weights, PULSE, M, SR, K);
    let maxErr = 0, maxMag = 0;
    for (let k = 0; k < K; k++) {
        let re = 0, im = 0;
        for (let s = 0; s < N; s++) {
            const ang = -2 * Math.PI * k * s / N;
            re += win[s] * Math.cos(ang);
            im += win[s] * Math.sin(ang);
        }
        re /= N; im /= N;
        maxErr = Math.max(maxErr, Math.hypot(re - pred.re[k], im - pred.im[k]));
        maxMag = Math.max(maxMag, Math.hypot(pred.re[k], pred.im[k]));
    }
    // Rendered output is float32, so ~1e-7 relative is the floor.
    check('spectrum: DFT of a rendered ring gate matches c_k = P̂(k)·DFT(w)', maxErr / maxMag < 1e-5,
        `n=${n}, weights=[${[...ring.weights].map(w => w.toFixed(2)).join(' ')}], max rel err ${(maxErr / maxMag).toExponential(2)}`);

    // The weights' DFT is what shapes it: harmonics at multiples of n
    // (the tick rate) and the ring's own sub-audio partials between.
    const zeroW = ring.weights.every(w => w === 0);
    check('spectrum: ring has non-zero weights', !zeroW);
}

// --- 4. Closed form vs IIR, sample by sample ------------------------------
{
    const { left } = renderGate(ringProject);
    const tickSec = M / SR;
    let worst = 0;
    for (let u = 0; u < N; u++) {
        const j = (Math.floor(u / M) + 1) % n;         // token place after this tick's fire
        const phase = (u % M) / M;
        const g = envelope(ring, j, phase, PULSE, tickSec);
        worst = Math.max(worst, Math.abs(g - left[WARM * N + u]));
    }
    check('closed form: envelope(ring, marking, phase) equals the rendered gate', worst < 1e-6,
        `max abs err ${worst.toExponential(2)} over ${N} samples`);
}

// --- 5. Executor parity with the sequencer worker ---------------------------
// Reference: the worker's _advanceOneTick + resolveConflicts + applyControl
// (deterministicLoop on), written against plain NetBundles.
function referenceRun(projectJSON, ticks) {
    const proj = parseProject(projectJSON);
    const muted = {}, mutedNotes = {}, mutedGroups = {};
    for (const id of proj.initialMutes || []) muted[id] = true;
    const log = [];
    for (let tc = 1; tc <= ticks; tc++) {
        const fired = [];
        for (const [netId, b] of Object.entries(proj.nets)) {
            let enabled = b.transitionLabels().filter(t => b.isEnabled(t));
            if (enabled.length > 1) {
                const pc = {}, blocked = {};
                for (const t of enabled) for (const ca of b.getInputArcs(t)) if (!ca.inhibit) (pc[ca.source] ||= []).push(t);
                for (const [place, cs] of Object.entries(pc)) {
                    if (cs.length <= 1) continue;
                    const w = cs[Math.floor(deterministicRand(tc, strHash(place)) * cs.length)];
                    for (const t of cs) if (t !== w) blocked[t] = true;
                }
                enabled = enabled.filter(t => !blocked[t]);
            }
            for (const t of enabled) {
                const r = b.fire(t);
                const c = r.control;
                if (c) {
                    if (c.action === 'mute-track') muted[c.targetNet] = true;
                    else if (c.action === 'unmute-track') muted[c.targetNet] = false;
                    else if (c.action === 'toggle-track') muted[c.targetNet] = !muted[c.targetNet];
                    else if (c.action === 'activate-slot') {
                        const tb = proj.nets[c.targetNet];
                        if (tb && tb.riffGroup) {
                            for (const [nid, nb] of Object.entries(proj.nets)) if (nb.riffGroup === tb.riffGroup && nid !== c.targetNet) muted[nid] = true;
                            if (!mutedGroups[tb.riffGroup]) muted[c.targetNet] = false;
                        }
                    }
                }
                if (r.midi && !muted[netId] && !(mutedNotes[netId] || {})[r.midi.note]) fired.push(netId + ':' + t);
            }
        }
        const marking = Object.values(proj.nets).map(b => Object.values(b.state).join(',')).join('|');
        log.push(fired.join(' ') + '#' + marking);
    }
    return log;
}
function compiledRun(projectJSON, ticks) {
    const g = compileProject(projectJSON);
    const log = [];
    for (let i = 0; i < ticks; i++) {
        tick(g, null);
        const fired = [];
        for (let k = 0; k < g.firedCount; k += 2) {
            const n = g.nets[g.fired[k]];
            fired.push(n.id + ':' + n.transIds[g.fired[k + 1]]);
        }
        const marking = g.nets.map(n => Array.from(n.state).join(',')).join('|');
        log.push(fired.join(' ') + '#' + marking);
    }
    return log;
}
{
    const project = composeProject('techno', 42, 'standard');
    const ticks = project.structure.reduce((s, x) => s + x.steps, 0);
    const a = referenceRun(project, ticks), b = compiledRun(project, ticks);
    const firstDiff = a.findIndex((x, i) => x !== b[i]);
    check('executor parity: techno/42/standard, every tick (markings + audible fires)',
        firstDiff === -1, firstDiff === -1 ? `${ticks} ticks` : `first divergence at tick ${firstDiff + 1}`);

    // A net with a real conflict: two transitions compete for one place.
    const conflict = {
        name: 'conflict', tempo: 120,
        nets: { fork: {
            track: { channel: 1 },
            places: { a: { initial: [1] }, b: {}, c: {} },
            transitions: { left: { midi: { note: 60 } }, right: { midi: { note: 64 } }, back1: {}, back2: {} },
            arcs: [
                { source: 'a', target: 'left' }, { source: 'a', target: 'right' },
                { source: 'left', target: 'b' }, { source: 'right', target: 'c' },
                { source: 'b', target: 'back1' }, { source: 'back1', target: 'a' },
                { source: 'c', target: 'back2' }, { source: 'back2', target: 'a' },
            ],
        } },
    };
    const ra = referenceRun(conflict, 400), rb = compiledRun(conflict, 400);
    const lefts = rb.filter(x => x.includes('fork:left')).length, rights = rb.filter(x => x.includes('fork:right')).length;
    check('executor parity: seeded conflict resolution matches the worker',
        ra.every((x, i) => x === rb[i]) && lefts > 0 && rights > 0, `left ${lefts} / right ${rights}`);
}

// --- 6. Nested modulation (ring of rings) -----------------------------------
{
    // Kick ring as a silent outer ring amplitude-modulating the hat ring.
    const base = composeProject('techno', 42);
    const project = { name: 'nest', tempo: BPM, initialMutes: [], nets: { hihat: base.nets.hihat, kick: base.nets.kick } };
    const dc = { kind: 'dc', carrier: 'dc', pulse: PULSE, level: 1 };
    const kickGate = { kind: 'dc', carrier: 'dc', pulse: pulse(0.001, 0.3), level: 1 };
    const seconds = 4;
    // Gate of each ring alone (mute the other via a level-0 override).
    const hat = renderOffline({ project, sampleRate: SR, seconds,
        runner: { master: 'linear', voices: { hihat: dc, kick: { ...kickGate, level: 0 } } } }).left;
    const kick = renderOffline({ project, sampleRate: SR, seconds,
        runner: { master: 'linear', voices: { hihat: { ...dc, level: 0 }, kick: kickGate } } }).left;
    const nested = renderOffline({ project, sampleRate: SR, seconds,
        runner: { master: 'linear', voices: { hihat: dc, kick: kickGate },
            mods: [{ target: 'hihat', source: 'kick', kind: 'am', depth: 1, silentSource: true }] } }).left;
    let worst = 0;
    for (let i = 1; i < nested.length; i++) worst = Math.max(worst, Math.abs(nested[i] - hat[i] * kick[i - 1]));
    check('nesting: AM-nested ring = inner gate × outer gate (one-sample lag)', worst < 1e-6,
        `max abs err ${worst.toExponential(2)}`);
}

// --- 7. Mid-play project swap lands on a bar boundary ----------------------
{
    const r = new WaveRunner(SR);
    r.load(composeProject('techno', 42));
    r.play();
    const L = new Float32Array(128);
    let swapTick = -1, prevGraph = r.graph, sawPendingTicks = 0;
    r.opts.onTick = (run) => { if (run.graph !== prevGraph && swapTick < 0) swapTick = run.graph.tick; };
    for (let i = 0; i < 40; i++) r.process(L, null, 128); // a few ticks in
    const tickAtLoad = r.graph.tick;
    r.load(composeProject('house', 7));
    check('swap: a load while playing is deferred', r.pending !== null && r.graph === prevGraph);
    for (let i = 0; i < 1500 && r.pending; i++) { r.process(L, null, 128); sawPendingTicks = prevGraph.tick; }
    check('swap: applied at the next bar boundary with the tick reset',
        r.pending === null && r.graph !== prevGraph && (sawPendingTicks + 1) % 16 === 0 && r.tempo === 124,
        `loaded at tick ${tickAtLoad}, swapped after tick ${sawPendingTicks}, new tempo ${r.tempo}`);
}

if (failures) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
}
console.log('\nall wave-engine checks passed');
