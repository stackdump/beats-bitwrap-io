#!/usr/bin/env node
//
// A share's audio, offline, with no browser: djrust's render_offline (deterministic for one
// engine version, the worklet's blocks and housekeeping cadence) written as a 16-bit WAV.
//
//   node scripts/djrust-render.mjs --genre techno --seed 42 [--structure standard] [--seconds 30]
//          [--out file.wav] [--share envelope.json]
//   DJRUST_PKG=../djrust/npm/pkg make djrust-render GENRE=techno SEED=42

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadDjrust } from './lib/djrust-pkg.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const genre = arg('genre', 'techno');
const seed = +arg('seed', 42);
const structure = arg('structure', '');
const seconds = +arg('seconds', 30);
const sampleRate = +arg('rate', 48000);
const share = arg('share', '');
const text = share ? readFileSync(share, 'utf8') : JSON.stringify({
    '@context': 'https://beats.bitwrap.io/schema/beats-share', '@type': 'BeatsShare', v: 1,
    genre, seed, ...(structure && structure !== 'loop' ? { structure } : {}),
});

const { m } = await loadDjrust(['render_offline', 'share_cid']);
const t0 = performance.now();
const pcm = m.render_offline(text, seconds, sampleRate);
const ms = performance.now() - t0;

const frames = pcm.length / 2;
const buf = Buffer.alloc(44 + frames * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + frames * 4, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(frames * 4, 40);
for (let i = 0; i < pcm.length; i++) {
    const x = Math.max(-1, Math.min(1, pcm[i]));
    buf.writeInt16LE(Math.round(x < 0 ? x * 0x8000 : x * 0x7fff), 44 + i * 2);
}
const cid = m.share_cid(text);
const out = arg('out', `djrust-${m.engine_version()}-${cid}.wav`);
writeFileSync(out, buf);
const hash = createHash('sha256').update(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)).digest('hex');
console.log(`${out}: ${seconds}s of ${cid} by djrust ${m.engine_version()} in ${ms.toFixed(0)} ms ` +
    `(${(seconds * 1000 / ms).toFixed(1)}× realtime); f32 sha256 ${hash}`);
