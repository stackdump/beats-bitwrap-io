#!/usr/bin/env node
//
// Offline render through the wave engine — writes a 16-bit stereo WAV.
//
//   node scripts/wave-render.mjs --genre techno --seed 42 [--structure standard] \
//        [--seconds 30] [--rate 48000] [--out techno-42.wav] [--sha] [--nets kick,snare,hihat]
//
// --nets keeps only the listed nets (e.g. the drum rings alone).
// --sha prints the sha256 of the WAV bytes instead of (or as well as)
// writing it; the determinism test compares two separate processes on it.

import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { renderOffline, encodeWav, composeProject } from '../public/wave-engine/offline.js';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a.startsWith('--')) continue;
    const next = process.argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[a.slice(2)] = true;
    else { args[a.slice(2)] = next; i++; }
}
const genre = args.genre || 'techno';
const seed = Number(args.seed ?? 42);
const structure = typeof args.structure === 'string' ? args.structure : '';
const seconds = Number(args.seconds ?? 30);
const rate = Number(args.rate ?? 48000);

let project;
if (typeof args.nets === 'string') {
    project = composeProject(genre, seed, structure);
    const keep = new Set(args.nets.split(','));
    for (const id of Object.keys(project.nets)) if (!keep.has(id)) delete project.nets[id];
}
const r = renderOffline({ genre, seed, structure, seconds, sampleRate: rate, project });
const wav = encodeWav([r.left, r.right], rate);
if (args.sha) console.log(createHash('sha256').update(wav).digest('hex'));
if (args.out || !args.sha) {
    const out = typeof args.out === 'string' ? args.out : `${genre}-${seed}${structure ? '-' + structure : ''}.wav`;
    writeFileSync(out, wav);
    if (!args.sha) console.log(`${out}: ${seconds}s @ ${rate} Hz, ${r.runner.lanes.length} lanes, ${r.runner.graph.tick} ticks, ${wav.length} bytes`);
}
