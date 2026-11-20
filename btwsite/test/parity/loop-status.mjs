#!/usr/bin/env node
// loop-status.mjs: the runtime's status (the page header's numbers) through a looping program, on a synthetic clock, in
// Node (no browser, no sound): BtwRun.service() with a grid that runs at the tempo, `play` echoed as the stream's virtual
// clock does. Prints, per bar, what header-model.js would show: "section N/M · name" and "bar song_bar/song_bars".
//
//   node btwsite/test/parity/loop-status.mjs [file.btw ...]    (default: the cases below)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { headerModel } from '../../web/js/header-model.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmDir = process.env.PARITY_WASM_DIR ? path.resolve(process.env.PARITY_WASM_DIR) : path.resolve(here, '..', '..', 'web', 'wasm');
if (!fs.existsSync(path.join(wasmDir, 'btw_bg.wasm'))) { console.log('SKIP loop-status: no built module in btwsite/web/wasm'); process.exit(0); }
const glue = await import(pathToFileURL(path.join(wasmDir, 'btw.js')).href);
glue.initSync({ module: fs.readFileSync(path.join(wasmDir, 'btw_bg.wasm')) });

const pats = 'let p1 = x ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~\nlet p2 = x ~ ~ ~ x ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~\nlet p3 = x ~ ~ ~ x ~ ~ ~ x ~ ~ ~ ~ ~ ~ ~\n';
const CASES = process.argv.length > 2 ? process.argv.slice(2).map((f) => ({ name: path.basename(f), text: fs.readFileSync(f, 'utf8') })) : [
    { name: 'single 2 bars', text: `tempo 128\n${pats}section groove 2 bars {\n  deck A: kick <p1 p2 p3>\n}\narrange groove\nloop\n` },
    { name: 'single 8 bars', text: `tempo 128\n${pats}section groove 8 bars {\n  deck A: kick <p1 p2 p3>\n}\narrange groove\nloop\n` },
    { name: 'single 4 bars + evolve', text: `tempo 128\nsection groove 4 bars {\n  deck A: kick x ~ ~ ~ x ~ ~ ~ x ~ ~ ~ x ~ ~ ~ | hihat ~ ~ x ~ ~ ~ x ~ ~ ~ x ~ ~ ~ x ~\n  evolve every 2 bars {\n    hihat: rotate 1\n  }\n}\narrange groove\nloop\n` },
    { name: 'single 2 bars, two decks', text: `tempo 128\n${pats}section groove 2 bars {\n  deck A: kick <p1 p2 p3>\n  deck B: bass a1*4 inst=sub-bass\n}\narrange groove\nloop\n` },
    // a long section with an evolve is a chain of nets (compiled.flat_clock): the runtime's other lap branch
    { name: 'single 16 bars + evolve (a chain)', text: `tempo 128\nsection groove 16 bars {\n  deck A: kick x ~ ~ ~ x ~ ~ ~ x ~ ~ ~ x ~ ~ ~ | hihat ~ ~ x ~ ~ ~ x ~ ~ ~ x ~ ~ ~ x ~\n  deck B: bass <a1*4 c2*4 e2*4 g1*4> inst=sub-bass\n  evolve every 4 bars {\n    hihat: rotate 1\n    stop when gen == 3\n  }\n}\narrange groove\nloop\n` },
    { name: 'single 32 bars + evolve every bar (a chain)', text: `tempo 128\nsection groove 32 bars {\n  deck A: kick x ~ ~ ~ x ~ ~ ~ x ~ ~ ~ x ~ ~ ~ | hihat ~ ~ x ~ ~ ~ x ~ ~ ~ x ~ ~ ~ x ~\n  evolve every 1 bars {\n    hihat: rotate 1\n  }\n}\narrange groove\nloop\n` },
    { name: 'two sections', text: `tempo 128\n${pats}section one 2 bars {\n  deck A: kick <p1 p2 p3>\n}\nsection two 2 bars {\n  deck A: kick x ~ ~ ~ x ~ ~ ~ x ~ ~ ~ x ~ ~ ~\n}\narrange one two\nloop\n` },
];

let bad = 0;
for (const c of CASES) {
    const run = new glue.BtwRun();
    const check = JSON.parse(run.check(c.text));
    const ev = JSON.parse(run.eval(c.text));
    if (!ev.ok) { console.log(`${c.name}: does not check: ${JSON.stringify(ev.diagnostics[0])}`); bad++; continue; }
    const rep = JSON.parse(glue.btw_check(c.text));
    const sections = rep.sections || [];
    const bpm = rep.tempo || 120;
    const passes = 3, bars = (rep.song_bars || 8) * passes;
    const playing = { A: false, B: false };
    let lastBar = null;
    const seen = [];
    for (let beat = 0; beat < bars * 4 + 0.5; beat += 0.05) {
        const grid = playing.A || playing.B ? { deck: 'A', beat, bpm, playing: { ...playing } } : null;
        const cmds = JSON.parse(run.service(JSON.stringify(grid)));
        for (const x of cmds) if (x.op === 'play') playing[x.deck] = !!x.on;
        const st = JSON.parse(run.status());
        const hm = headerModel(st, JSON.parse(run.marks()), sections);
        const shown = `${hm.section ? `section${hm.secN != null ? ` ${hm.secN}/${hm.secM}` : ''} · ${hm.section}` : 'playing'} bar ${hm.songBars ? `${hm.songBar}/${hm.songBars}` : hm.bar}`;
        if (st.bar !== lastBar) { lastBar = st.bar; seen.push(shown); }
        if (hm.songBars && hm.songBar > hm.songBars) { bad++; console.log(`${c.name}: at beat ${beat.toFixed(2)} the header would say "${shown}"`); break; }
    }
    console.log(`${c.name}${rep.song_bars ? ` (${rep.song_bars} bars${check.flat_clock ? ', chain' : ''})` : ''}: ${seen.length > 12 ? [...seen.slice(0, 3), '...', ...seen.slice(rep.song_bars - 2, rep.song_bars + 3)].join(' | ') : seen.join(' | ')}`);
    run.free();
}
process.exit(bad ? 1 : 0);
