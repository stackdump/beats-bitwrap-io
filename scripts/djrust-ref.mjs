#!/usr/bin/env node
// djrust-ref.mjs — the frozen djwasm 0.2.0 package, kept beside the repo for the gates that run it
// next to the current pin.
//
// public/djrust/djwasm.wasm is whatever the pin names (0.3.0 since the net-clock re-pin). Two gates
// still need the 0.2.0 module itself, not just its golden hashes:
//   scripts/djrust-cpu.mjs --check   idle cost and memory of the candidate against 0.2.0, measured
//                                    side by side in one process (absolute numbers drift)
//   scripts/test-djwasm-030.mjs      'compat': the new loader / worklet still drive 0.2.0
// They read it from .djrust-ref/djwasm@0.2.0/ (djwasm.wasm + its own loader.js / worklet.js),
// git-ignored and outside public/, so it is never served. $DJRUST_REF names another directory.
// The bytes are checked against the hashes below on every use: a wrong file is a failure, never a
// silent stand-in. They are the bytes of scripts/djrust-golden.json's module and of
// scripts/djrust-cpu-baseline.json's.
//
//   node scripts/djrust-ref.mjs fetch    download djwasm@0.2.0 from jsDelivr into the ref dir, checked
//   node scripts/djrust-ref.mjs check    offline: the ref dir holds exactly those bytes
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

export const REF = {
    package: 'djwasm',
    version: '0.2.0',
    files: {
        'djwasm.wasm': 'cfcd9cf4a1b51f186bb93e893406adfdd7ca712b09a10303da8a73ce29b30bca',
        'loader.js': '3eb8661614570170895c3d92028c4bd62b188e731f789c385a2d8813801698da',
        'worklet.js': '602abe9dd67134e4735b7f9670605c57c335addfc591719695e1480d1822ff3a',
    },
};
export const REF_DIR = resolve(process.env.DJRUST_REF || join(ROOT, '.djrust-ref', `djwasm@${REF.version}`));
export const REF_WASM = join(REF_DIR, 'djwasm.wasm');

/** → {present, ok, why}: present = the ref dir has a djwasm.wasm; ok = every file has its hash. */
export function refStatus() {
    if (!existsSync(REF_WASM)) return { present: false, ok: false, why: `no ${REF_WASM} (node scripts/djrust-ref.mjs fetch)` };
    const bad = [];
    for (const [f, want] of Object.entries(REF.files)) {
        const p = join(REF_DIR, f);
        const have = existsSync(p) ? sha256(readFileSync(p)) : 'missing';
        if (have !== want) bad.push(`${f} ${have.slice(0, 12)} != ${want.slice(0, 12)}`);
    }
    return bad.length
        ? { present: true, ok: false, why: `${REF_DIR} is not djwasm@${REF.version}: ${bad.join('; ')}` }
        : { present: true, ok: true, why: '' };
}

async function fetchRef() {
    mkdirSync(REF_DIR, { recursive: true });
    for (const [f, want] of Object.entries(REF.files)) {
        const url = `https://cdn.jsdelivr.net/npm/${REF.package}@${REF.version}/${f}`;
        const res = await fetch(url);
        if (!res.ok) { console.error(`${url}: HTTP ${res.status}`); return 1; }
        const b = Buffer.from(await res.arrayBuffer());
        if (sha256(b) !== want) { console.error(`${url}: ${sha256(b)}, want ${want}`); return 1; }
        writeFileSync(join(REF_DIR, f), b);
    }
    console.log(`wrote ${REF_DIR} (djwasm@${REF.version}, hashes checked)`);
    return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const cmd = process.argv[2];
    if (cmd === 'fetch') process.exit(await fetchRef());
    else if (cmd === 'check') {
        const s = refStatus();
        if (s.ok) console.log(`djrust ref ok: ${REF_DIR} is djwasm@${REF.version}`);
        else console.error(s.why);
        process.exit(s.ok ? 0 : 1);
    } else { console.error('usage: djrust-ref.mjs fetch | check'); process.exit(2); }
}
