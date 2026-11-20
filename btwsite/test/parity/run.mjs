#!/usr/bin/env node
// run.mjs: does the page's ENGINE sound like the server's STREAM? (btwsite/test/parity/README.md)
//
//   node btwsite/test/parity/run.mjs [--corpus repros,examples,DIR...] [--only REGEX] [--out DIR] [--gate REGEX]
//                                    [--btwd PATH] [--keep-wav] [--jobs N]
//
// For each program:
//   stream  `btwd render --sr 48000 --format s16le` (what GET /api/render/<cid> serves: render.go pipes exactly this
//           through a WAV header, or ffmpeg for opus)
//   engine  web/parity.html in headless Chrome: js/engine.js + js/engine-calls.js + the djweb wasm, rendered into an
//           OfflineAudioContext, the runtime serviced every 1024 frames as the page's 25 ms loop does
// then analyze.mjs compares them bar by bar (loudness, spectrum, onsets, peaks), and the run writes
//   <out>/<name>.json        the bars, the engine's ignored calls, its runtime trace
//   <out>/report.json        every program's summary
//   <out>/RESULTS.md         the ranked table
// and, with --keep-wav, both renders as WAV.
//
// Exit 1 when a program matching --gate (default: ^00-base$, the repro with no control lines) has a flagged bar, or a
// program failed to render. Skips (exit 0) when the wasm is not built or Chrome / btwd are not there.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare, THRESHOLDS } from './analyze.mjs';
import { findBtwd, int16, missing, site, start, wasmDir, wav } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };
const flag = (k) => process.argv.includes(`--${k}`);
const SR = 48000;
const OUT = path.resolve(arg('out', path.join(here, 'out')));
const ONLY = arg('only') ? new RegExp(arg('only')) : null;
const GATE = new RegExp(arg('gate', '^00-base$'));
const JOBS = Number(arg('jobs', 2));
const KEEP = flag('keep-wav');
const BTWD = findBtwd(arg('btwd'));
{ const why = missing(BTWD); if (why) { console.log(`SKIP parity: ${why}`); process.exit(0); } }

// ---------------------------------------------------------------- the corpus
function corpus() {
    const sets = (arg('corpus', 'repros,examples')).split(',');
    const progs = [];
    for (const s of sets) {
        const dir = s === 'repros' ? path.join(here, 'repros') : s === 'examples' ? path.join(site, 'examples') : path.resolve(s);
        for (const f of fs.readdirSync(dir).sort()) {
            const p = path.join(dir, f);
            let text;
            if (f.endsWith('.btw')) text = fs.readFileSync(p, 'utf8');
            else if (f.endsWith('.json') && f !== 'index.json') { try { text = JSON.parse(fs.readFileSync(p, 'utf8')).text; } catch { continue; } }
            if (!text) continue;
            const name = `${s === 'repros' || s === 'examples' ? '' : `${path.basename(dir)}-`}${f.replace(/\.(btw|json)$/, '')}`.slice(0, 60);
            if (ONLY && !ONLY.test(name)) continue;
            progs.push({ name, text, set: s, file: p });
        }
    }
    return progs;
}

function btwd(args, input) {
    const r = spawnSync(BTWD, args, { input, maxBuffer: 1 << 30 });
    if (r.status !== 0 && !args.includes('render')) throw new Error(`btwd ${args[0]}: ${r.stderr}`);
    return r;
}

function renderStream(text) {
    return new Promise((resolve) => {
        const p = spawn(BTWD, ['render', '--sr', String(SR), '--format', 's16le', '--max-bars', '512', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
        const out = [], err = [];
        p.stdout.on('data', (d) => out.push(d));
        p.stderr.on('data', (d) => err.push(d));
        p.on('close', (code) => {
            const events = Buffer.concat(err).toString().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
            resolve({ code, pcm: Buffer.concat(out), events });
        });
        p.stdin.end(text);
    });
}

// ---------------------------------------------------------------- run
fs.mkdirSync(OUT, { recursive: true });
/**
 * The worklet's slow blocks (stats.slow, ?perf=1) against the comparison: each block's audio time on the engine, less the
 * alignment offset, is a time in the stream, so a bar of it. Which bars had one, how many of those are flagged, and each
 * section's first bar: did it have a slow block (in it or the bar before, where its nets are installed), and did it land
 * late (its onsets off by more than the threshold, or its hits unlike the stream's).
 */
function perfReport(perf, cmp, row) {
    if (!perf) return null;
    const barS = (4 * 60) / row.bpm, off = cmp.offsetMs / 1000;
    const byBar = new Map(), byDid = {};
    for (const b of perf.slow) {
        const bar = Math.floor((b.t - off) / barS) + 1;
        const e = byBar.get(bar) || { n: 0, ms: 0 };
        e.n++; e.ms += b.ms; byBar.set(bar, e);
        const d = (byDid[b.did || '-'] = byDid[b.did || '-'] || { n: 0, ms: 0 }); d.n++; d.ms += b.ms;
    }
    const rows = new Map(cmp.bars.map((r) => [r.bar, r]));
    const slowBars = [...byBar.keys()].filter((b) => rows.has(b)).sort((a, b) => a - b);
    const slowFlagged = slowBars.filter((b) => rows.get(b).flags.length).length;
    const sectionStarts = [];
    for (const s of row.sections || []) {
        const bar = s.start + 1, r = rows.get(bar);
        if (!r || bar === 1) continue; // the first bar has the start-up's installs in every program
        const late = Math.abs(r.onsetMs) > THRESHOLDS.onsetMs || r.onsetCorr < THRESHOLDS.onsetCorr;
        sectionStarts.push({ bar, section: s.name, slow: byBar.has(bar) || byBar.has(bar - 1), late, onsetMs: r.onsetMs, onsetCorr: r.onsetCorr });
    }
    const st = (xs) => (xs.length ? { n: xs.length, mean: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1), max: +Math.max(...xs).toFixed(1) } : { n: 0 });
    return { slow: perf.slow.length, maxMs: perf.slow.reduce((m, b) => Math.max(m, b.ms), 0), byDid, slowBars, slowFlagged, bars: cmp.bars.length, flagged: cmp.summary.flagged,
        sectionStarts, loads: perf.loads, prepareMs: st(perf.prepareMs), installMs: st(perf.installMs), installQuanta: st(perf.installQuanta) };
}

const progs = corpus();
console.log(`parity: ${progs.length} programs, btwd ${BTWD}, out ${OUT}`);

// the streams first, JOBS at a time
const streams = new Map();
{
    let i = 0;
    const worker = async () => {
        while (i < progs.length) {
            const p = progs[i++];
            const check = JSON.parse(btwd(['check', '-'], p.text).stdout.toString());
            const r = await renderStream(p.text);
            const start = r.events.find((e) => e.event === 'start');
            const error = r.events.find((e) => e.event === 'error');
            streams.set(p.name, { check, ...r, start, error });
            process.stdout.write(`  stream ${p.name}: ${error ? `error ${error.code}` : `${start.seconds} s`}\n`);
        }
    };
    await Promise.all(Array.from({ length: JOBS }, worker));
}

const h = await start();

const results = [];
let failed = 0;
for (const p of progs) {
    const s = streams.get(p.name);
    const row = { name: p.name, set: p.set, cid: s.check.cid, bpm: s.check.tempo || 120, sections: s.check.sections || [], loops: !!s.check.loops };
    if (!s.check.ok) { row.skipped = 'does not check'; results.push(row); continue; }
    if (s.error) { row.skipped = `stream: ${s.error.code}: ${s.error.message}`; results.push(row); continue; }
    const bars = s.start.bars;
    const seconds = s.start.seconds + 1.5; // the engine starts after a compile: room for it
    const eng = await h.render({ program: p.text, name: p.name, seconds, sampleRate: SR });
    row.console = eng.console;
    if (!eng.ok) { row.error = eng.error; failed++; results.push(row); console.log(`  engine ${p.name}: FAILED ${eng.error}`); continue; }
    const pcmE = eng.pcm;
    const cmp = compare(int16(s.pcm), int16(pcmE), { sr: SR, bpm: row.bpm, bars, sections: row.sections });
    Object.assign(row, { bars, seconds: s.start.seconds, streamNotes: s.start.notes, offsetMs: cmp.offsetMs, summary: cmp.summary, ignored: eng.ignored, warns: eng.warns, errors: eng.errors, renderMs: Math.round(eng.renderMs) });
    const calls = new Map();
    for (const c of eng.calls) if (c.noun) { const k = `${c.noun} ${JSON.stringify(Object.fromEntries(Object.entries(c.params || {}).filter(([k, v]) => k !== 'value' && typeof v !== 'number')))}`; calls.set(k, (calls.get(k) || 0) + 1); }
    row.calls = [...calls].map(([k, n]) => `${k} x${n}`);
    row.perf = perfReport(eng.perf, cmp, row);
    fs.writeFileSync(path.join(OUT, `${p.name}.json`), JSON.stringify({ ...row, slow: eng.perf && eng.perf.slow, barsDetail: cmp.bars, trace: eng.trace, decksTrace: eng.decksTrace }, null, 1));
    if (KEEP) {
        fs.writeFileSync(path.join(OUT, `${p.name}.stream.wav`), wav(s.pcm, SR));
        fs.writeFileSync(path.join(OUT, `${p.name}.engine.wav`), wav(pcmE.subarray(Math.round(cmp.offsetMs * SR / 1000) * 4), SR));
    }
    row.worst = cmp.bars.filter((b) => b.flags.length).sort((a, b) => b.score - a.score).slice(0, 4).map((b) => ({ bar: b.bar, section: b.section, flags: b.flags }));
    results.push(row);
    const pr = row.perf;
    console.log(`  engine ${p.name}: offset ${cmp.offsetMs} ms, ${cmp.summary.flagged}/${cmp.summary.bars} bars flagged, mean score ${cmp.summary.meanScore}, dLUFS ${(cmp.summary.lufsEngine - cmp.summary.lufsStream).toFixed(1)}${pr ? `, slow ${pr.slow} (max ${pr.maxMs} ms, ${pr.slowBars.length} bars, ${pr.slowFlagged} flagged)` : ''}${eng.ignored.length ? `, ignored: ${eng.ignored.join('; ')}` : ''}`);
}
await h.close();

results.sort((a, b) => (b.summary?.meanScore ?? -1) - (a.summary?.meanScore ?? -1));
// stats.slow across the corpus: are bars with a slow block flagged more often than bars without one, and do section starts
// with a slow block land late (their onsets off) more often?
const perfAll = (() => {
    const rs = results.filter((r) => r.perf);
    const sum = (f) => rs.reduce((a, r) => a + f(r.perf), 0);
    const slowBars = sum((p) => p.slowBars.length), slowFlagged = sum((p) => p.slowFlagged), bars = sum((p) => p.bars), flagged = sum((p) => p.flagged);
    const starts = rs.flatMap((r) => r.perf.sectionStarts);
    const withSlow = starts.filter((x) => x.slow), without = starts.filter((x) => !x.slow);
    const lateRate = (xs) => (xs.length ? +(xs.filter((x) => x.late).length / xs.length).toFixed(3) : null);
    const did = {};
    for (const r of rs) for (const [k, v] of Object.entries(r.perf.byDid)) { const e = (did[k] = did[k] || { n: 0, ms: 0 }); e.n += v.n; e.ms += v.ms; }
    return { programs: rs.length, slowBlocks: sum((p) => p.slow), maxMs: Math.max(0, ...rs.map((r) => r.perf.maxMs)), byDid: did,
        bars, flagged, slowBars, slowFlagged,
        flagRateSlowBars: slowBars ? +(slowFlagged / slowBars).toFixed(3) : null, flagRateOtherBars: bars - slowBars ? +((flagged - slowFlagged) / (bars - slowBars)).toFixed(3) : null,
        sectionStarts: starts.length, sectionStartsSlow: withSlow.length, lateRateSlow: lateRate(withSlow), lateRateOther: lateRate(without) };
})();
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ thresholds: THRESHOLDS, sampleRate: SR, perf: perfAll, btwd: BTWD, wasm: (() => { try { return JSON.parse(fs.readFileSync(path.join(wasmDir(), 'hashes.json'), 'utf8')); } catch { return null; } })(), results }, null, 1));
const md = ['# parity results', '', `${results.length} programs. Thresholds per bar: |dLUFS| > ${THRESHOLDS.lufs} LU, log-mel L1 > ${THRESHOLDS.mel} dB, onsets > ${THRESHOLDS.onsetMs} ms, onset corr < ${THRESHOLDS.onsetCorr}.`, '',
    `stats.slow (?perf=1): ${perfAll.slowBlocks} slow blocks (>= 3 ms, max ${perfAll.maxMs} ms) in ${perfAll.slowBars} of ${perfAll.bars} bars; flagged: ${perfAll.flagRateSlowBars} of bars with one, ${perfAll.flagRateOtherBars} of bars without; section starts landing late: ${perfAll.lateRateSlow} with a slow block (${perfAll.sectionStartsSlow}), ${perfAll.lateRateOther} without (${perfAll.sectionStarts - perfAll.sectionStartsSlow}).`, '',
    'Ranked by mean score: how far the engine strays from the render (btwd, the reference), per bar the largest measure over its threshold, averaged.', '',
    '| program | bars | flagged | mean score | LUFS stream / engine | TP stream / engine | mean mel dB | offset ms | slow blocks (bars, flagged) | engine ignored |', '|---|---|---|---|---|---|---|---|---|---|'];
for (const r of results) {
    if (!r.summary) { md.push(`| ${r.name} | | | | | | | | | ${r.skipped || r.error} |`); continue; }
    const s = r.summary;
    md.push(`| ${r.name} | ${s.bars} | ${s.flagged} | ${s.meanScore} | ${s.lufsStream} / ${s.lufsEngine} | ${s.tpStream} / ${s.tpEngine} | ${s.meanMel} | ${r.offsetMs} | ${r.perf ? `${r.perf.slow} (${r.perf.slowBars.length}, ${r.perf.slowFlagged})` : ''} | ${(r.ignored || []).join('; ')} |`);
}
fs.writeFileSync(path.join(OUT, 'RESULTS.md'), `${md.join('\n')}\n`);
console.log(`parity: wrote ${path.join(OUT, 'RESULTS.md')}`);

const gated = results.filter((r) => GATE.test(r.name));
for (const r of gated) if (!r.summary || r.summary.flagged) { console.log(`FAIL parity gate: ${r.name} ${r.summary ? `${r.summary.flagged} bars flagged` : r.error || r.skipped}`); failed++; }
process.exit(failed ? 1 : 0);
