#!/usr/bin/env node
// loop.mjs: what `loop` does in the engine, against what it should do.
//
//   node btwsite/test/parity/loop.mjs [--passes 3] [--out DIR]
//
// For each case the engine plays the looping program for `passes` passes of its arrangement, and btwd renders the
// same program with the arrangement written out that many times and no `loop` (`arrange a b` + loop -> `arrange a b a b
// a b`): what a loop means. A pattern whose alternation does not divide the section (`<p1 p2 p3>` in a 2-bar section) tells
// a restart (the section's nets load again: bars 3 and 4 are p1, p2) from a net that just runs on (p3, p1): each p has
// its own number of kicks, so a bar's count says which it is. The runtime's
// status (section, bar) is traced for each bar. Exit 1 when a case's engine does not match its unrolled render.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare } from './analyze.mjs';
import { findBtwd, int16, missing, start, wav } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };
const PASSES = Number(arg('passes', 3));
const OUT = path.resolve(arg('out', path.join(here, 'out')));
const SR = 48000;
const BTWD = findBtwd(arg('btwd'));
{ const why = missing(BTWD); if (why) { console.log(`SKIP loop: ${why}`); process.exit(0); } }

// bar k of a pattern is told by how many kicks it has: p1 one, p2 two, p3 three; section two has four
const pats = 'let p1 = x ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~\nlet p2 = x ~ ~ ~ x ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~\nlet p3 = x ~ ~ ~ x ~ ~ ~ x ~ ~ ~ ~ ~ ~ ~\n';
const CASES = [
    { name: 'loop-single', what: 'a single-section arrange with loop (2-bar section, a 3-bar alternation)', text: `tempo 128\n${pats}section groove 2 bars {\n  deck A: kick <p1 p2 p3>\n}\narrange groove\nloop\n`, sections: ['groove'] },
    { name: 'loop-single-even', what: 'a single-section arrange with loop (3-bar section, the alternation fits)', text: `tempo 128\n${pats}section groove 3 bars {\n  deck A: kick <p1 p2 p3>\n}\narrange groove\nloop\n`, sections: ['groove'] },
    { name: 'loop-two', what: 'two sections with loop', text: `tempo 128\n${pats}section one 2 bars {\n  deck A: kick <p1 p2 p3>\n}\nsection two 2 bars {\n  deck A: kick x ~ ~ ~ x ~ ~ ~ x ~ ~ ~ x ~ ~ ~\n}\narrange one two\nloop\n`, sections: ['one', 'two'] },
    // the live paths: the loop evaluated while another program plays (it lands on the next bar line), and evaluated again mid-pass
    { name: 'loop-single-after-other', what: 'the single-section loop evaluated while another program plays', pre: `tempo 128\ndeck A: kick x ~ ~ ~ x ~ ~ ~ x ~ ~ ~ x ~ ~ ~\n`, preBars: 1.5, text: `tempo 128\n${pats}section groove 2 bars {\n  deck A: kick <p1 p2 p3>\n}\narrange groove\nloop\n`, sections: ['groove'] },
    { name: 'loop-single-reeval', what: 'the single-section loop evaluated again in its second bar (Cmd+Enter on the same text)', reeval: 1.5, text: `tempo 128\n${pats}section groove 2 bars {\n  deck A: kick <p1 p2 p3>\n}\narrange groove\nloop\n`, sections: ['groove'] },
    { name: 'no-loop', what: 'no sections, `end at bar 4` (the reference: no loop at all)', text: `tempo 128\n${pats}deck A: kick <p1 p2 p3>\nend at bar 4\n`, sections: null },
];

/** Energy in each 16th of each bar (from the first sound), normalised: a bar's fingerprint. */
function fingerprints(pcm, bpm, bars) {
    const x = int16(pcm), n = x.length >> 1, sr = SR, bar = (4 * 60 * sr) / bpm, step = bar / 16;
    let t0 = 0;
    for (let i = 0; i < n; i++) if (Math.abs(x[2 * i]) > 300) { t0 = i; break; }
    const out = [];
    for (let b = 0; b < bars; b++) {
        const f = [];
        for (let k = 0; k < 16; k++) {
            const o = Math.round(t0 + b * bar + k * step);
            let e = 0;
            for (let i = o; i < Math.min(n, o + Math.round(step / 2)); i++) { const v = x[2 * i]; e += v * v; }
            f.push(Math.sqrt(e));
        }
        const norm = Math.hypot(...f) || 1;
        out.push(f.map((v) => v / norm));
    }
    return out;
}
const cos = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
/** The name of the reference bar each bar is most like (and how alike, 0..1). */
function classify(fps, refs) {
    return fps.map((f) => { let best = '?', v = -1; for (const [k, r] of Object.entries(refs)) { const c = cos(f, r); if (c > v) { v = c; best = k; } } return v > 0.9 ? best : `?${best}`; });
}

fs.mkdirSync(OUT, { recursive: true });
// the reference bars: p1, p2, p3 and four kicks, each as btwd renders it
const REFS = {};
{
    const one = spawnSync(BTWD, ['render', '--sr', String(SR), '--format', 's16le', '-'], { input: `tempo 128\n${pats}deck A: kick <p1 p2 p3>\nend at bar 3\n`, maxBuffer: 1 << 30 });
    const fp = fingerprints(one.stdout, 128, 3);
    REFS.p1 = fp[0]; REFS.p2 = fp[1]; REFS.p3 = fp[2];
    const four = spawnSync(BTWD, ['render', '--sr', String(SR), '--format', 's16le', '-'], { input: 'tempo 128\ndeck A: kick x ~ ~ ~ x ~ ~ ~ x ~ ~ ~ x ~ ~ ~\nend at bar 1\n', maxBuffer: 1 << 30 });
    REFS.four = fingerprints(four.stdout, 128, 1)[0];
}
const h = await start();
const results = [];
let failed = 0;
for (const c of CASES) {
    const unrolled = c.sections ? c.text.replace(/arrange [^\n]*\nloop\n/, `arrange ${Array(PASSES).fill(c.sections.join(' ')).join(' ')}\n`) : c.text;
    const check = JSON.parse(spawnSync(BTWD, ['check', '-'], { input: c.text }).stdout.toString());
    const passBars = check.song_bars || check.end_bar || 16;
    const bars = c.sections ? passBars * PASSES : passBars;
    // what the stream serves for the looping program itself: one pass
    const own = spawnSync(BTWD, ['render', '--sr', String(SR), '--format', 's16le', '-'], { input: c.text, maxBuffer: 1 << 30 });
    const ownStart = own.stderr.toString().split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.event === 'start');
    const ref = spawnSync(BTWD, ['render', '--sr', String(SR), '--format', 's16le', '--max-bars', '512', '-'], { input: unrolled, maxBuffer: 1 << 30 });
    const bpm = check.tempo || 120;
    const seconds = (bars * 4 * 60) / bpm + 2;
    const barS = (4 * 60) / bpm;
    let eng;
    if (c.pre) eng = await h.render({ program: c.pre, name: c.name, seconds: seconds + c.preBars * barS + barS, sampleRate: SR, evals: [{ at: c.preBars * barS, program: c.text }] });
    else if (c.reeval) eng = await h.render({ program: c.text, name: c.name, seconds, sampleRate: SR, evals: [{ at: c.reeval * barS, program: c.text }] });
    else eng = await h.render({ program: c.text, name: c.name, seconds, sampleRate: SR });
    // with a program before it, the loop's audio starts on the bar line after it was evaluated: cut what came before
    if (c.pre && eng.ok) { const cut = Math.round(Math.ceil(c.preBars + 1e-9) * barS * SR) * 4 + Math.round(0.064 * SR) * 4; eng.pcm = eng.pcm.subarray(Math.min(cut, eng.pcm.length)); }
    if (!eng.ok) { failed++; results.push({ ...c, error: eng.error }); continue; }
    const cmp = compare(int16(ref.stdout), int16(eng.pcm), { sr: SR, bpm, bars, sections: [] });
    const hitsRef = classify(fingerprints(ref.stdout, bpm, bars), REFS), hitsEng = classify(fingerprints(eng.pcm, bpm, bars), REFS);
    // the runtime's status at each bar line it reported
    const perBar = [];
    for (const t of eng.trace) if (t.bar !== null && !perBar.some((p) => p.bar === t.bar)) perBar.push({ bar: t.bar, section: t.section, sectionBar: t.sectionBar, sectionBars: t.sectionBars, songBar: t.songBar, header: t.marksHeader });
    const row = {
        name: c.name, what: c.what, passBars, renderedBars: cmp.bars.length,
        streamSeconds: ownStart ? ownStart.seconds : null, streamNotes: ownStart ? ownStart.notes : null,
        engineVsUnrolled: cmp.bars.map((b) => ({ bar: b.bar, mel: b.mel, onsetCorr: b.onsetCorr, dLufs: b.dLufs, flags: b.flags })),
        status: perBar.slice(0, bars + 2),
        bars: { unrolled: hitsRef.join(','), engine: hitsEng.join(',') },
        flagged: cmp.summary.flagged,
    };
    if (hitsRef.join(',') !== hitsEng.join(',')) failed++;
    results.push(row);
    fs.writeFileSync(path.join(OUT, `${c.name}.engine.wav`), wav(eng.pcm, SR));
    fs.writeFileSync(path.join(OUT, `${c.name}.unrolled.wav`), wav(ref.stdout, SR));
    console.log(`${c.name}: bars as heard, unrolled ${row.bars.unrolled} / engine ${row.bars.engine} ${row.bars.unrolled === row.bars.engine ? 'same' : 'DIFFER'}; ${row.flagged}/${row.renderedBars} bars flagged; the stream of the looping program is ${row.streamSeconds} s (one pass)`);
    console.log(`   status by bar (bar: section section_bar/section_bars, song_bar): ${row.status.map((s) => `${s.bar}:${s.section ?? '-'} ${s.sectionBar ?? '-'}/${s.sectionBars ?? '-'} ${s.songBar ?? '-'}`).join(' | ')}`);
}
await h.close();
fs.writeFileSync(path.join(OUT, 'loop.json'), JSON.stringify(results, null, 1));
process.exit(failed ? 1 : 0);
