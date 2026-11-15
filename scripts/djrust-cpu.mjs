#!/usr/bin/env node
//
// djrust-cpu.mjs — audio-thread cost of the djwasm engine per 128-frame quantum, in Node.
//
//   node scripts/djrust-cpu.mjs --record [--force]      # measure the 0.2.0 reference → scripts/djrust-cpu-baseline.json
//   node scripts/djrust-cpu.mjs --check [--wasm P]      # gate a module (default $DJRUST_WASM, else the pin) against 0.2.0
//   node scripts/djrust-cpu.mjs [--wasm P]              # measure and print only
//   make test-djrust-cpu                                # = --check, skips when no module is present
//
// What is measured (budget = 128 / 48000 s = 2.667 ms per quantum):
//   idle      process(128) while playing a project with no feature engaged: mean, p50, p99 and
//             max, after a 200-quantum warm-up, on 4 projects for 20 s each.
//   memory    wasm memory bytes over 60 s of churn: mute / tempo plus every feature export the
//             module has, at neutral values, every 2 s; once without and once with a project
//             swap every 2 s (see memoryChurn: 0.2.0 grows on every load).
//   seek      djw_seek(3000) cost, when the module exports it (0.3.0+). Absent on 0.2.0. Measured
//             on every project above AND every feed-corpus envelope (scripts/fixtures/feed-corpus),
//             SEEK_REPS seeks each after a warm-up, the first one included (a page seeks cold).
//             An arranged song stops at its stop-transport before tick 3000, so djw_seek returns
//             the tick it reached: that tick is reported per project, with how many projects
//             really reached 3000 (the loops). The arranged feed tracks are the costly ones.
//   feature   process(128) p99 with a feature engaged (djw_fire_macro 'sweep-lp', else djw_fx
//             lp-freq 40), when the module has one. Absent on 0.2.0.
//   setInstrument  djw_set_instrument cost, when present (0.5.0+). Reported, not gated.
//
// The reference is djwasm 0.2.0 itself (scripts/djrust-ref.mjs: .djrust-ref/djwasm@0.2.0/, git-ignored,
// never served; `node scripts/djrust-ref.mjs fetch` downloads it from jsDelivr and checks its hashes).
// Until the 0.3.0 re-pin it was the pin; the pin moved on, the reference did not.
//
// --check gates:
//   idle mean and p99 within +5% of djwasm 0.2.0. Both modules are measured in the same
//     process, in lockstep (one quantum each in turn) over 5 rounds, median round each. The recorded baseline is printed for
//     context only, because absolute times on a shared host drift between runs.
//   feature p99 < 25% of the budget (0.667 ms);
//   seek: the worst single djw_seek(3000) over every project and repetition < 2.0 ms, and at
//     least one project really reaches tick 3000 (so a seek that long was timed at all);
//   memory growth under control churn = 0 bytes, and bytes per load no more than 0.2.0's.
// Exit 0 pass, 1 fail, 2 no module.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { resolveModule, newEngine, composeProject, lowerEnvelope, feedFiles, FEED_DIR, missingModule } from './djrust-golden.mjs';
import { REF, REF_DIR, refStatus } from './djrust-ref.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const BASELINE_PATH = join(here, 'djrust-cpu-baseline.json');
const SR = 48000, BLOCK = 128;
const BUDGET_MS = BLOCK / SR * 1000;
const WARM = 200, MEASURE = Math.round(20 * SR / BLOCK);
const ROUNDS = 5;
const IDLE_TOL = 1.05, FEATURE_FRAC = 0.25, SEEK_MAX_MS = 2.0;

const FEED_CASE = 'z4EBG9j7D6VyFnQbKYRJiTQmnEvynfVxoxeys5Nh9hEyrSgUx6a'; // dnb raw-nets, structure extended

function projects() {
    const out = [
        ['techno:42:standard', JSON.stringify(composeProject('techno', 42, 'standard'))],
        ['ambient:1:extended', JSON.stringify(composeProject('ambient', 1, 'extended'))],
        ['dnb:3:drop', JSON.stringify(composeProject('dnb', 3, 'drop'))],
    ];
    const f = join(FEED_DIR, `${FEED_CASE}.json`);
    if (existsSync(f)) out.push([`feed:${FEED_CASE.slice(0, 12)}`, lowerEnvelope(JSON.parse(readFileSync(f, 'utf8')), FEED_CASE).text]);
    return out;
}

const stats = (xs) => {
    const s = Float64Array.from(xs).sort();
    const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const r = (v) => Math.round(v * 1e4) / 1e4;
    return { mean: r(mean), p50: r(at(0.5)), p99: r(at(0.99)), max: r(s[s.length - 1]), n: xs.length };
};

function timeProcess(dj, quanta, each) {
    const t = new Array(quanta);
    for (let i = 0; i < quanta; i++) {
        if (each) each(i);
        const a = process.hrtime.bigint();
        dj.process(BLOCK);
        t[i] = Number(process.hrtime.bigint() - a) / 1e6;
    }
    return t;
}


const withText = (dj, s, fn) => dj._withText(s, fn);
const has = (dj, n) => typeof dj.x[n] === 'function';

function neutralCalls(dj) {
    if (has(dj, 'djw_set_transpose')) dj.x.djw_set_transpose(0);
    if (has(dj, 'djw_fx_reset')) dj.x.djw_fx_reset();
    if (has(dj, 'djw_panic')) dj.x.djw_panic();
    if (has(dj, 'djw_set_loop')) dj.x.djw_set_loop(-1, -1);
    if (has(dj, 'djw_set_groove')) dj.x.djw_set_groove(0, 0);
    if (has(dj, 'djw_event_count') && dj.x.djw_event_count() > 0 && has(dj, 'djw_events')) dj.x.djw_events();
}

/**
 * Memory over 60 s of churn, two ways, because djwasm 0.2.0 grows its linear memory on every
 * djw_load and never reuses it (measured 2026-11-14: about 9 MB per load of the 591 kB
 * techno:42:standard document, about 1.4 MB per load of a 31 kB loop).
 *   controls  mute / tempo / every neutral feature export, every 2 s, with no loads. Must not
 *             grow at all after the first 2 s.
 *   loads     the same plus a project swap every 2 s. Bytes per load are reported, and --check
 *             holds the candidate to no more than 0.2.0.
 */
function memoryChurn(mod, texts) {
    const every = Math.round(2 * SR / BLOCK), total = Math.round(60 * SR / BLOCK);
    const nets = texts.map((t) => Object.keys(JSON.parse(t).nets).filter((id) => !/^struct-|feel-curve|macro-curve/.test(id)).slice(0, 4));
    const run = (withLoads) => {
        const dj = newEngine(mod, SR);
        dj.load(texts[0]); dj.play();
        let first = 0, k = 0, loads = 0;
        for (let q = 0; q < total; q++) {
            if (q % every === 0) {
                const i = withLoads ? k % texts.length : 0;
                k++;
                if (withLoads && q > 0) { dj.load(texts[i]); loads++; }
                for (const id of nets[i]) dj.setMute(id, (k & 1) === 1);
                dj.setTempo(100 + (k % 5) * 10);
                neutralCalls(dj);
            }
            dj.process(BLOCK);
            if (q === every - 1) first = dj.x.memory.buffer.byteLength;
        }
        const end = dj.x.memory.buffer.byteLength;
        return { after2s: first, end, growth: end - first, loads, bytesPerLoad: loads ? Math.round((end - first) / loads) : 0 };
    };
    return { seconds: 60, controls: run(false), loads: run(true) };
}

const SEEK_TARGET = 3000, SEEK_REPS = 7;

/** Every project the seek is timed on: `texts` (composed + one feed case) and the feed corpus. */
function seekProjects(texts) {
    const out = texts.map(([id, text]) => [id, text]);
    const seen = new Set(out.map(([id]) => id));
    for (const f of feedFiles()) {
        const cid = f.slice(0, -5);
        const id = `feed:${cid.slice(0, 12)}`;
        if (seen.has(id)) continue;
        out.push([id, lowerEnvelope(JSON.parse(readFileSync(join(FEED_DIR, f), 'utf8')), cid).text]);
    }
    return out;
}

/**
 * djw_seek(SEEK_TARGET) on every project: the tick it reached (an arranged song stops at its
 * stop-transport first), and per project the stats of SEEK_REPS seeks (the first, cold, too).
 * Returns the per-project rows plus the worst over all of them.
 */
function seekCost(mod, texts) {
    if (!has(newEngine(mod, SR), 'djw_seek')) return 'absent';
    const rows = [];
    for (const [id, text] of seekProjects(texts)) {
        const dj = newEngine(mod, SR);
        dj.load(text); dj.play();
        timeProcess(dj, WARM);
        const xs = [];
        let reached = -1;
        for (let i = 0; i < SEEK_REPS; i++) {
            const a = process.hrtime.bigint();
            reached = dj.x.djw_seek(SEEK_TARGET);
            xs.push(Number(process.hrtime.bigint() - a) / 1e6);
            timeProcess(dj, 50);
        }
        rows.push({ id, reached, ...stats(xs) });
    }
    const worst = rows.reduce((w, r) => (r.max > w.max ? r : w), rows[0]);
    const worstMedian = rows.reduce((w, r) => (r.p50 > w.p50 ? r : w), rows[0]);
    const full = rows.filter((r) => r.reached >= SEEK_TARGET);
    return {
        target: SEEK_TARGET, reps: SEEK_REPS, projects: rows.length,
        reachedTarget: full.length,
        max: worst.max, maxAt: { id: worst.id, reached: worst.reached },
        worstMedian: worstMedian.p50, worstMedianAt: { id: worstMedian.id, reached: worstMedian.reached },
        fullLengthMax: full.length ? Math.max(...full.map((r) => r.max)) : null,
        rows,
    };
}

function featureCost(mod, text) {
    const dj = newEngine(mod, SR);
    let how = null;
    dj.load(text); dj.play();
    timeProcess(dj, WARM);
    if (has(dj, 'djw_fire_macro')) {
        const rc = withText(dj, 'sweep-lp', (p, n) => dj.x.djw_fire_macro(p, n, 8));
        if (rc >= 0) how = `djw_fire_macro('sweep-lp', 8) → ${rc}`;
    }
    if (!how && has(dj, 'djw_fx')) { dj.x.djw_fx(1, 40); how = 'djw_fx(lp-freq, 40)'; }
    if (!how) return 'absent';
    return { how, ...stats(timeProcess(dj, MEASURE)) };
}

function setInstrumentCost(mod, text) {
    const dj = newEngine(mod, SR);
    if (!has(dj, 'djw_set_instrument')) return 'absent';
    dj.load(text); dj.play();
    timeProcess(dj, WARM);
    const a = process.hrtime.bigint();
    withText(dj, 'square-lead', (p, n) => dj.x.djw_set_instrument(4, p, n));
    const call = Number(process.hrtime.bigint() - a) / 1e6;
    return { callMs: Math.round(call * 1e4) / 1e4, nextBar: stats(timeProcess(dj, Math.round(4 * SR / BLOCK))) };
}

/**
 * Idle stats for each module. All modules play the same project in lockstep, one quantum each
 * in turn, so host drift (other processes, frequency scaling) lands on every module alike.
 * Repeated over ROUNDS; each statistic is the median of its rounds.
 */
function idleCompare(mods, texts) {
    const rounds = mods.map(() => ({}));
    for (let r = 0; r < ROUNDS; r++) {
        for (const [id, text] of texts) {
            const djs = mods.map((m) => { const dj = newEngine(m, SR); dj.load(text); dj.play(); return dj; });
            for (let i = 0; i < WARM; i++) for (const dj of djs) dj.process(BLOCK);
            const ts = mods.map(() => new Array(MEASURE));
            for (let i = 0; i < MEASURE; i++) {
                // Alternate who goes first, so neither always runs on a warmer cache.
                for (let j = 0; j < djs.length; j++) {
                    const mi = (i + j) % djs.length;
                    const a = process.hrtime.bigint();
                    djs[mi].process(BLOCK);
                    ts[mi][i] = Number(process.hrtime.bigint() - a) / 1e6;
                }
            }
            ts.forEach((t, mi) => (rounds[mi][id] = rounds[mi][id] || []).push(stats(t)));
        }
    }
    const med = (xs) => { const s = xs.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    return rounds.map((byId) => Object.fromEntries(Object.entries(byId).map(([id, rs]) => [id, {
        mean: med(rs.map((x) => x.mean)), p50: med(rs.map((x) => x.p50)), p99: med(rs.map((x) => x.p99)),
        max: med(rs.map((x) => x.max)), n: rs[0].n, rounds: rs.length,
    }])));
}

function measureAll(mod, texts, idle) {
    return {
        budgetMs: Math.round(BUDGET_MS * 1e4) / 1e4,
        idle,
        memory: memoryChurn(mod, texts.map(([, t]) => t)),
        seek: seekCost(mod, texts),
        feature: featureCost(mod, texts[0][1]),
        setInstrument: setInstrumentCost(mod, texts[0][1]),
    };
}

function printMeasure(label, m) {
    console.log(`${label}`);
    for (const [id, s] of Object.entries(m.idle)) {
        console.log(`  idle ${id.padEnd(22)} mean ${s.mean.toFixed(4)} ms  p50 ${s.p50.toFixed(4)}  p99 ${s.p99.toFixed(4)}  max ${s.max.toFixed(3)}  (${(100 * s.p99 / BUDGET_MS).toFixed(1)}% of budget at p99)`);
    }
    console.log(`  memory  controls-only churn: ${m.memory.controls.after2s} B → ${m.memory.controls.end} B (growth ${m.memory.controls.growth} B); ` +
        `with ${m.memory.loads.loads} loads: growth ${m.memory.loads.growth} B, ${m.memory.loads.bytesPerLoad} B per load`);
    if (typeof m.seek === 'string') console.log(`  seek    ${m.seek}`);
    else {
        const s = m.seek;
        console.log(`  seek    djw_seek(${s.target}) × ${s.reps} on ${s.projects} projects (${s.reachedTarget} reach tick ${s.target}; ` +
            `the rest stop at their song's end): worst ${s.max} ms (${s.maxAt.id}, reached ${s.maxAt.reached}), ` +
            `worst median ${s.worstMedian} ms (${s.worstMedianAt.id}), worst of those reaching ${s.target}: ${s.fullLengthMax} ms`);
        for (const r of [...s.rows].sort((a, b) => b.max - a.max).slice(0, 5)) {
            console.log(`          ${r.id.padEnd(22)} reached ${String(r.reached).padStart(5)}  median ${r.p50} ms  max ${r.max} ms`);
        }
    }
    console.log(`  feature ${typeof m.feature === 'string' ? m.feature : `${m.feature.how}: p99 ${m.feature.p99} ms`}`);
    console.log(`  setInstrument ${typeof m.setInstrument === 'string' ? m.setInstrument : JSON.stringify(m.setInstrument)}`);
}

async function main(argv) {
    const a = {};
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--record') a.record = true;
        else if (k === '--check') a.check = true;
        else if (k === '--force') a.force = true;
        else if (k === '--skip-missing') a.skipMissing = true;
        else if (k === '--wasm') a.wasm = argv[++i];
        else { console.error(`unknown argument ${k}`); return 2; }
    }
    const texts = projects();
    if (a.record) {
        const mod = await resolveModule(a.wasm || REF_DIR);
        if (!mod) { console.error(`djrust-cpu: no module at ${a.wasm || REF_DIR} (node scripts/djrust-ref.mjs fetch)`); return 2; }
        const pin = { version: REF.version };
        if (mod.sha256 !== REF.files['djwasm.wasm'] && !a.force) {
            console.error(`djrust-cpu --record: ${mod.wasmPath} is not djwasm@${REF.version}; the baseline is that reference (--force to override)`);
            return 1;
        }
        const [idle] = idleCompare([mod], texts);
        const m = measureAll(mod, texts, idle);
        const out = {
            about: 'djwasm cost per 128-frame quantum in Node on the recording host (scripts/djrust-cpu.mjs). Context for --check, which ' +
                're-measures this 0.2.0 reference beside the candidate rather than trusting these absolute numbers.',
            module: { version: pin.version, sha256: mod.sha256 },
            recorded: new Date().toISOString().slice(0, 10),
            host: { cpu: cpus()[0] && cpus()[0].model, cores: cpus().length, node: process.version },
            method: { sampleRate: SR, block: BLOCK, warmupQuanta: WARM, measureQuanta: MEASURE, rounds: ROUNDS, stat: 'median over rounds of each statistic; lockstep with any compared module' },
            gates: { idleTolerance: IDLE_TOL, featureP99FractionOfBudget: FEATURE_FRAC, seekMaxMs: SEEK_MAX_MS, memoryControlChurnGrowthBytes: 0, memoryPerLoad: 'no more than 0.2.0' },
            ...m,
        };
        writeFileSync(BASELINE_PATH, JSON.stringify(out, null, 1) + '\n');
        printMeasure(`recorded ${BASELINE_PATH}`, m);
        return 0;
    }
    const mod = await resolveModule(a.wasm || process.env.DJRUST_WASM);
    if (!mod) return missingModule('djrust-cpu', a.wasm, a.skipMissing);
    if (!a.check) {
        const [idle] = idleCompare([mod], texts);
        printMeasure(`${mod.wasmPath} (sha256 ${mod.sha256.slice(0, 16)}…)`, measureAll(mod, texts, idle));
        return 0;
    }
    const ref = refStatus();
    if (!ref.ok) {
        // (skippable only when the reference is absent and nothing was named: a named candidate must
        // be measured, and a reference with the wrong bytes is never a skip)
        if (!ref.present && a.skipMissing && !(a.wasm || process.env.DJRUST_WASM)) {
            console.log(`djrust-cpu --check: SKIP, needs djwasm@${REF.version} to measure beside the candidate: ${ref.why}`);
            return 0;
        }
        console.error(`djrust-cpu --check: FAIL, needs djwasm@${REF.version} to measure beside the candidate: ${ref.why}`);
        return 2;
    }
    const base = await resolveModule(REF_DIR);
    const [bIdle, cIdle] = idleCompare([base, mod], texts);
    const m = measureAll(mod, texts, cIdle);
    printMeasure(`candidate ${mod.wasmPath} (sha256 ${mod.sha256.slice(0, 16)}…) against djwasm@${REF.version} (${base.wasmPath})`, m);
    let fails = 0;
    const gate = (name, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} — ${detail}`); if (!ok) fails++; };
    for (const [id, c] of Object.entries(cIdle)) {
        const b = bIdle[id];
        gate(`idle ${id} mean within +${Math.round((IDLE_TOL - 1) * 100)}% of ${REF.version}`, c.mean <= b.mean * IDLE_TOL,
            `${c.mean} vs ${b.mean} ms (×${(c.mean / b.mean).toFixed(3)})`);
        gate(`idle ${id} p99 within +${Math.round((IDLE_TOL - 1) * 100)}% of ${REF.version}`, c.p99 <= b.p99 * IDLE_TOL,
            `${c.p99} vs ${b.p99} ms (×${(c.p99 / b.p99).toFixed(3)})`);
    }
    gate('memory does not grow over 60 s of control churn (no loads)', m.memory.controls.growth === 0, `${m.memory.controls.growth} B`);
    const bm = memoryChurn(base, texts.map(([, t]) => t)).loads;
    gate(`memory per djw_load is no worse than ${REF.version}`, m.memory.loads.bytesPerLoad <= bm.bytesPerLoad,
        `${m.memory.loads.bytesPerLoad} vs ${bm.bytesPerLoad} B per load (0.2.0 never reuses load memory)`);
    if (typeof m.feature !== 'string') gate('feature-active p99 under 25% of the budget', m.feature.p99 < BUDGET_MS * FEATURE_FRAC, `${m.feature.p99} ms`);
    else console.log(`skip feature-active p99 — ${m.feature}`);
    if (typeof m.seek !== 'string') {
        const s = m.seek;
        gate(`seek: every djw_seek(${s.target}) under ${SEEK_MAX_MS} ms (${s.reps} each, cold one included, on ${s.projects} projects)`,
            s.max < SEEK_MAX_MS, `worst ${s.max} ms on ${s.maxAt.id} (reached tick ${s.maxAt.reached}); worst median ${s.worstMedian} ms`);
        gate(`seek: some project really reaches tick ${s.target}`, s.reachedTarget > 0,
            `${s.reachedTarget} of ${s.projects} (worst of them ${s.fullLengthMax} ms)`);
    } else console.log(`skip seek — ${m.seek}`);
    if (existsSync(BASELINE_PATH)) {
        const rec = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
        console.log(`     recorded baseline (${rec.recorded}, ${rec.host && rec.host.cpu}): ` +
            Object.entries(rec.idle).map(([id, s]) => `${id} mean ${s.mean}`).join(', '));
    }
    console.log(fails ? `\n${fails} cpu gate(s) FAILED` : '\nall cpu gates passed');
    return fails ? 1 : 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2)).then((rc) => process.exit(rc), (err) => { console.error(err); process.exit(1); });
