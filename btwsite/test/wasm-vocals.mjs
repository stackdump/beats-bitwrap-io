#!/usr/bin/env node
// wasm-vocals.mjs: BeatScript vocals and the vocoder in the browser engine, headless (Node, the built module, no browser).
//
//   node btwsite/test/wasm-vocals.mjs [wasm dir]          (default btwsite/web/wasm; SKIP when it is not built)
//
// 1. engine-calls.js: the vocoder's set / swap / add / remove and the vocoder_handoff move become live ops; a timed
//    `vocal` call is ignored (and named)
// 2. a `sing` line on deck A: BtwRun puts a sung part in deck A's net (no `vocal` call), and the engine renders it: the deck
//    is not silent with the voice alone, and the voice changes what deck A plays
// 3. the vocoder: carrier deck A (bass and an arp), modulator deck B (a sung line, its fader down): the output with the vocoder on
//    (as an insert on A, mix 1) differs from the dry carrier, and a mix ramp's midpoint lies between the two
// 4. determinism: the same text gives the same CID and the same nets, and the same samples twice
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmDir = path.resolve(process.argv[2] || path.join(here, '..', 'web', 'wasm'));
if (!fs.existsSync(path.join(wasmDir, 'btw_bg.wasm'))) {
    console.log(`SKIP wasm-vocals: no built module in ${wasmDir} (scripts/build-web-wasm.sh <dir> in djrust-vevr-se)`);
    process.exit(0);
}
const glue = await import(pathToFileURL(path.join(wasmDir, 'btw.js')).href);
glue.initSync({ module: fs.readFileSync(path.join(wasmDir, 'btw_bg.wasm')) });
const { mapCall } = await import(pathToFileURL(path.join(here, '..', 'web', 'js', 'engine-calls.js')).href);

let passed = 0;
const failures = [];
function ok(name, cond, detail) {
    if (cond) { passed++; console.log(`ok   ${name}`); return; }
    failures.push(name);
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
}
const SR = 48000;

// ---- 1. the calls
{
    const v = mapCall('vocoder', { action: 'set', carrier: 'A', modulator: 'B', mix: 1, insert: true, on: true });
    ok('vocoder set is a live op with its params', v.ops.length === 1 && v.ops[0].type === 'live' && v.ops[0].method === 'vocoder' && JSON.parse(v.ops[0].params).carrier === 'A' && !v.ignored, JSON.stringify(v));
    const ramp = mapCall('vocoder', { action: 'set', mix: 0.5 });
    ok('a ramp pass is a set of mix', JSON.parse(ramp.ops[0].params).mix === 0.5);
    ok('swap', JSON.parse(mapCall('vocoder', { action: 'swap' }).ops[0].params).swap === true);
    const h = mapCall('moves', { action: 'arm', kind: 'vocoder_handoff', deck: 'B' });
    ok('vocoder_handoff swaps on the next phrase line of its deck', h.ops[0].phrase.deck === 'B' && h.ops[0].phrase.bars === 8 && JSON.parse(h.ops[0].params).swap === true, JSON.stringify(h));
    ok('another move is still ignored, by name', mapCall('moves', { action: 'arm', kind: 'echo_out' }).ignored === 'moves');
    ok('a vocal call is ignored, by name', mapCall('vocal', { action: 'create' }).ignored === 'vocal');
    ok('vocoder status is ignored', mapCall('vocoder', { action: 'status' }).ignored === 'vocoder status');
}

// ---- helpers: a program's first loads, and a render of envelopes on a fresh engine
function firstPass(text) {
    const run = new glue.BtwRun();
    const ev = JSON.parse(run.eval(text));
    if (!ev.ok) throw new Error(JSON.stringify(ev.diagnostics.map((d) => d.render)));
    const cmds = JSON.parse(run.service('null'));
    run.free();
    return { ev, cmds, loads: cmds.filter((c) => c.op === 'load_net'), calls: cmds.filter((c) => c.op === 'call') };
}
function render(loads, seconds, setup) {
    const dj = new glue.Dj(SR);
    for (const l of loads) dj.load_share(l.deck, JSON.stringify(l.envelope));
    if (setup) setup(dj, 0);
    for (const l of loads) dj.set_playing(l.deck, true);
    const out = new Float32Array(Math.floor(seconds * SR));
    const L = new Float32Array(128), R = new Float32Array(128);
    for (let i = 0, q = 0; i < out.length; i += 128, q++) {
        if (setup && setup.each) setup.each(dj, i / SR);
        dj.render(L, R);
        if (q % 4 === 3) dj.tick();
        for (let k = 0; k < 128 && i + k < out.length; k++) out[i + k] = 0.5 * (L[k] + R[k]);
    }
    dj.free();
    return out;
}
const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / Math.max(1, x.length));
const diffRms = (a, b) => rms(a.map((v, i) => v - (b[i] || 0)));
const sha = (x) => crypto.createHash('sha256').update(Buffer.from(x.buffer)).digest('hex');

// ---- 2. a sing line sounds on its deck
const SING = 'tempo 120\nkey am\ndeck A: kick x ~ x ~ | melody <[a3 c4 e4 c4] [a3 c4 e4 g4]>\ndeck A: sing "we are the rave to-night" on melody voice=robot-choir\n';
{
    const p = firstPass(SING);
    const a = p.loads.find((l) => l.deck === 'A');
    const nets = Object.keys(a.envelope.nets);
    ok('the sing line is a part of deck A\'s net (vox, voice-robot-choir)', nets.includes('vox') && a.envelope.nets.vox.track.instrument === 'voice-robot-choir', nets.join(','));
    ok('and not a vocal call the browser would drop', !p.calls.some((c) => c.noun === 'vocal'), JSON.stringify(p.calls));
    const solo = { deck: 'A', envelope: { ...a.envelope, nets: Object.fromEntries(Object.entries(a.envelope.nets).filter(([k]) => k.startsWith('vox'))) } };
    const voice = render([solo], 4);
    ok('the voice alone is not silent on deck A', rms(voice) > 1e-3, `rms ${rms(voice)}`);
    const withVoice = render([a], 4);
    const without = render(firstPass(SING.replace(/deck A: sing.*\n/, '')).loads.filter((l) => l.deck === 'A'), 4);
    ok('the voice changes what deck A plays', diffRms(withVoice, without) > 0.2 * rms(without), `${diffRms(withVoice, without)} vs ${rms(without)}`);
    // through the deck's strip: deck A's fader down silences the voice too
    const faded = render([a], 2, Object.assign((dj) => dj.set_param('A', 'volume', 0), {}));
    ok('deck A\'s fader takes the voice with it', rms(faded) < 0.05 * rms(withVoice.subarray(0, 2 * SR)), `rms ${rms(faded)}`);
}

// ---- 3. the vocoder: carrier deck A, modulator deck B (a sung line, its fader down: the vocoder taps before the fader)
{
    const VOC = 'tempo 120\nkey am\ndeck A: bass a2 a2 e2 e2 | arp [a3 c4 e4 a4]*2\ndeck B: melody [a3 c4 e4 g4]\ndeck B: sing "/w ee - aa r - dh uh - r ay v/" on melody\n';
    const p = firstPass(VOC);
    const fader = (dj) => { dj.set_param('B', 'volume', 0); };
    const dry = render(p.loads, 4, fader);
    const vocoded = (mix) => render(p.loads, 4, (dj) => { fader(dj); dj.live_op('vocoder', JSON.stringify({ carrier: 'A', modulator: 'B', on: true, insert: true, mix })); });
    const wet = vocoded(1);
    ok('the carrier alone plays (deck B\'s fader is down)', rms(dry) > 1e-3, `rms ${rms(dry)}`);
    ok('the vocoder\'s output differs from the dry carrier', diffRms(wet, dry) > 0.1 * rms(dry), `${diffRms(wet, dry)} vs ${rms(dry)}`);
    ok('it is not silent', rms(wet) > 1e-4, `rms ${rms(wet)}`);
    const half = vocoded(0.5);
    ok('a mix of 0.5 lies between dry and wet', diffRms(half, dry) < diffRms(wet, dry) && diffRms(half, dry) > 0, `${diffRms(half, dry)} / ${diffRms(wet, dry)}`);
    ok('the language says it with no new grammar', firstPass('deck A: harmony chord(am)\ndeck B: melody [a3 c4]\ndo vocoder set carrier=A insert=true modulator=B on=true mix=0 -> 1 over 8 bars\n').ev.ok);
}

// ---- 4. determinism
{
    const t = 'tempo 120\ndeck A: melody [a3 c4 e4 g4]\ndeck A: sing "/w ee - aa: r - dh uh - r ay! v/" on melody\n';
    const a = firstPass(t), b = firstPass(t);
    ok('the same text, the same CID and nets', a.ev.cid === b.ev.cid && JSON.stringify(a.loads) === JSON.stringify(b.loads));
    ok('and the same samples', sha(render(a.loads, 2)) === sha(render(b.loads, 2)));
    const ph = firstPass('tempo 124\ndeck A: melody [a3 c4 e4 g4 a4 g4 e4 c4]\ndeck A: sing @hands_up on melody\n');
    ok('a phrasebook phrase sings', rms(render(ph.loads, 2)) > 1e-3);
}

console.log(`\nwasm-vocals: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
