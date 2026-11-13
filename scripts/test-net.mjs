#!/usr/bin/env node
//
// lib/net.js tests — the Petri-net executor the Scope raster and the control-net planner
// (lib/backend/controls.js) tick offline. No bundler, no npm, plain `node`.
//
//   node scripts/test-net.mjs        # or: make test-net
//
// 1. P-invariants: for every net, every basis vector y of {yᵀC = 0} keeps y·M constant at
//    every tick of a full structured song.
// 2. Executor parity: the compiled executor reproduces the sequencer worker's tick semantics
//    (markings, audible fires, controls, conflicts).
// 3. Control plan: an arrangement's macroCurve / feelCurve controls are planned at their
//    section starts, in order, and runControls fires each once as the clock passes it.

import { compose } from '../public/lib/generator/composer.js?v=6';
import { projectToJSON, parseProject } from '../public/lib/pflow.js';
import { compileProject, tick, incidenceMatrix, pInvariants, deterministicRand, strHash } from '../public/lib/net.js';
import { planControls, runControls } from '../public/lib/backend/controls.js';
import { arrangeWithOpts } from '../public/lib/generator/arrange.js';

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) failures++;
}

function composeProject(genre, seed, structure) {
    const params = { seed };
    if (structure && structure !== 'loop') params.structure = structure;
    return projectToJSON(compose(genre, params));
}

// --- 1. P-invariants at every tick -----------------------------------------
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

// --- 2. Executor parity with the sequencer worker ---------------------------
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

// --- 3. Control plan -------------------------------------------------------------------------
{
    const project = composeProject('house', 7);
    arrangeWithOpts(project, 'house', 'standard', {
        seed: 7,
        macroCurve: [{ section: 'drop', macro: 'riser', bars: 2 }],
        feelCurve: [{ section: 'intro', x: 0.2, y: 0.3 }, { section: 'drop', x: 0.8, y: 0.9 }],
    });
    const plan = planControls(project);
    const kinds = plan.map(f => f.control.action);
    const ordered = plan.every((f, i) => i === 0 || plan[i - 1].tick <= f.tick);
    check('control plan: macroCurve and feelCurve fires are planned in order',
        kinds.includes('fire-macro') && kinds.includes('set-feel') && ordered,
        plan.map(f => `${f.tick}:${f.control.action}:${f.control.macro || JSON.stringify(f.control.macroParams || {})}`).join(' '));
    // a clock passing every tick in 40-tick steps fires each planned control once; a seek skips
    const seen = [];
    const el = { _controlPlan: { fires: plan, i: 0 }, _handleWsMessage: (m) => seen.push(m) };
    const last = plan.length ? plan[plan.length - 1].tick : 0;
    for (let t = 0; t <= last + 40; t += 40) runControls(el, Math.max(0, t - 40), t);
    check('control plan: runControls fires every planned control once',
        seen.length === plan.length && seen.every(m => m.type === 'control-fired'), `${seen.length}/${plan.length}`);
    const el2 = { _controlPlan: { fires: plan, i: 0 }, _handleWsMessage: (m) => seen2.push(m) };
    const seen2 = [];
    runControls(el2, 0, last + 1); // a seek past everything
    check('control plan: a seek does not replay what it skipped', seen2.length === 0, `${seen2.length}`);
    // every structured song carries its genre's feel-curve (set-feel at section starts)
    const std = planControls(composeProject('techno', 42, 'standard'));
    check("control plan: a structured song's own feel-curve is planned",
        std.length > 0 && std.every(f => f.control.action === 'set-feel'), `${std.length} set-feel`);
    check('control plan: a loop (no structure) plans nothing', planControls(composeProject('techno', 42)).length === 0);
}

if (failures) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
}
console.log('\nall net checks passed');
