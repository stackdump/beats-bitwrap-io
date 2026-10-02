#!/usr/bin/env node
//
// CPU cost of the wave engine per 128-sample render quantum — the unit an
// AudioWorkletProcessor.process() call has to finish in (2.67 ms at 48 kHz).
//
//   node scripts/wave-bench.mjs [--seconds 60] [--slowdown 6]
//
// Times WaveRunner.process() block by block for several genres, loop and
// song mode. This measures desktop V8; --slowdown scales the numbers to a
// stand-in for a mid-range phone and is an assumption, not a measurement.

import { WaveRunner } from '../public/wave-engine/runner.js';
import { composeProject, BLOCK } from '../public/wave-engine/offline.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const seconds = arg('seconds', 60), slowdown = arg('slowdown', 6), sr = 48000;
const budgetUs = BLOCK / sr * 1e6;

const cases = [['techno', ''], ['techno', 'standard'], ['edm', 'standard'], ['jazz', 'standard'], ['ambient', 'extended'], ['dnb', 'standard']];
console.log(`budget per ${BLOCK}-sample block @ ${sr} Hz: ${budgetUs.toFixed(0)} µs; phone column = desktop × ${slowdown} (assumed)\n`);
console.log('case'.padEnd(20) + 'lanes'.padStart(6) + 'mean µs'.padStart(10) + 'p99 µs'.padStart(9) + 'max µs'.padStart(9) + '  %budget(mean)' + '  phone p99 %'.padStart(14));
const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK);
for (const [genre, structure] of cases) {
    const runner = new WaveRunner(sr);
    runner.load(composeProject(genre, 42, structure));
    runner.play();
    for (let i = 0; i < 2000; i++) runner.process(L, R, BLOCK); // JIT warm-up
    const blocks = Math.round(seconds * sr / BLOCK);
    const t = new Float64Array(blocks);
    // performance.now() returns a double; hrtime.bigint() would allocate per
    // block and charge its own GC pauses to the engine.
    for (let i = 0; i < blocks; i++) {
        const t0 = performance.now();
        runner.process(L, R, BLOCK);
        t[i] = (performance.now() - t0) * 1000;
    }
    const sorted = Float64Array.from(t).sort();
    const mean = t.reduce((a, b) => a + b, 0) / blocks;
    const p99 = sorted[Math.floor(blocks * 0.99)], max = sorted[blocks - 1];
    console.log(`${genre}/${structure || 'loop'}`.padEnd(20) + String(runner.lanes.length).padStart(6)
        + mean.toFixed(1).padStart(10) + p99.toFixed(1).padStart(9) + max.toFixed(0).padStart(9)
        + `${(100 * mean / budgetUs).toFixed(1)}%`.padStart(15) + `${(100 * p99 * slowdown / budgetUs).toFixed(0)}%`.padStart(14));
}
