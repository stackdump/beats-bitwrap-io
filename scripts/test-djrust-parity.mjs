#!/usr/bin/env node
//
// Share-CID parity gate for the djrust engine (BEATS-BACKPORT-PLAN.md, contract 1).
//
// `?engine=djrust` swaps only what plays the project. It must not change what the project IS,
// because share links and model CIDs are hashes of it. This diffs the two composers that can
// produce a beats project from (genre, seed, structure):
//
//   JS:     public/lib/generator/composer.js compose() → parseProject → canonicalProjectJSON → sha256
//   djrust: compose_model_cid(genre, overrides) from the pinned npm package (the same path
//           TrackSpec::project() takes)
//
// for every genre × structure × seed, and checks that djrust names every example share envelope
// by the same CID as codec.js. Any mismatch fails the gate and blocks the switch.
//
// The package: DJRUST_PKG=<dir with djrust.js + djrust_bg.wasm> (a local `djrust/npm/build.sh`
// build), else the pinned version (public/djrust/version.js) from the npm registry.
//
// Usage:
//   node scripts/test-djrust-parity.mjs [--seeds N]
//   DJRUST_PKG=../djrust/npm/pkg make test-djrust-parity

import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compose } from '../public/lib/generator/composer.js';
import { parseProject, canonicalProjectJSON } from '../public/lib/pflow.js';
import { computeCidForJsonLd } from '../public/lib/share/codec.js';
import { DJRUST_VERSION } from '../public/djrust/version.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : dflt;
};
const SEEDS = Number(arg('--seeds', process.env.DJRUST_PARITY_SEEDS || 6));

// The genres the studio offers (.pn-genre-select in public/lib/ui/build.js).
const GENRES = ['ambient', 'blues', 'bossa', 'country', 'dnb', 'dubstep', 'edm', 'funk', 'garage',
    'house', 'jazz', 'lofi', 'metal', 'reggae', 'speedcore', 'synthwave', 'techno', 'trance', 'trap'];
// '' is a loop (no structure); the rest are the share envelope's `structure` values.
const STRUCTURES = ['', 'ab', 'drop', 'build', 'jam', 'minimal', 'standard', 'extended'];

async function loadDjrust() {
    let dir = process.env.DJRUST_PKG;
    if (!dir) {
        dir = mkdtempSync(path.join(tmpdir(), 'djrust-pkg-'));
        const url = `https://registry.npmjs.org/djrust/-/djrust-${DJRUST_VERSION}.tgz`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${url}: ${res.status} (unpublished? set DJRUST_PKG to a local build)`);
        const tgz = path.join(dir, 'pkg.tgz');
        writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
        const t = spawnSync('tar', ['xzf', tgz, '-C', dir], { encoding: 'utf8' });
        if (t.status !== 0) throw new Error('tar: ' + t.stderr);
        dir = path.join(dir, 'package');
    }
    const glue = path.join(dir, 'djrust.js');
    if (!existsSync(glue)) throw new Error(`no djrust.js in ${dir}`);
    const m = await import(pathToFileURL(glue).href);
    m.initSync({ module: readFileSync(path.join(dir, 'djrust_bg.wasm')) });
    for (const fn of ['compose_model_cid', 'compose_project', 'share_cid']) {
        if (typeof m[fn] !== 'function') {
            throw new Error(`djrust in ${dir} has no ${fn}(): it predates the beats facade ` +
                '(djrust feat/beats-facade); the gate needs a release that includes it');
        }
    }
    return { m, dir };
}

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

function firstDiff(a, b) {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return `at byte ${i}:\n    js:     …${a.slice(Math.max(0, i - 60), i + 80)}\n    djrust: …${b.slice(Math.max(0, i - 60), i + 80)}`;
}

const { m: dj, dir } = await loadDjrust();
const version = typeof dj.engine_version === 'function' ? dj.engine_version() : '?';
console.log(`djrust ${version} from ${dir}; ${GENRES.length} genres × ${STRUCTURES.length} structures × ${SEEDS} seeds`);

const failures = [];
let n = 0;
const t0 = Date.now();
for (const genre of GENRES) {
    for (const structure of STRUCTURES) {
        for (let k = 0; k < SEEDS; k++) {
            // Spread the seeds: small ones, and large ones near the int32 edge.
            const seed = k < SEEDS / 2 ? k * 7 + 1 : 2147483000 - k * 104729;
            const ov = { seed };
            if (structure) ov.structure = structure;
            const js = canonicalProjectJSON(parseProject(compose(genre, { ...ov })));
            const jsCid = sha(js);
            let djCid;
            try { djCid = dj.compose_model_cid(genre, JSON.stringify(ov)); }
            catch (e) { djCid = 'error: ' + (e?.message || e); }
            n++;
            if (jsCid !== djCid) {
                let detail = '';
                try {
                    const djCanon = canonicalProjectJSON(parseProject(JSON.parse(dj.compose_project(genre, JSON.stringify(ov)))));
                    detail = firstDiff(js, djCanon);
                } catch (e) { detail = String(e?.message || e); }
                failures.push(`${genre}:${seed}:${structure || 'loop'}  js ${jsCid.slice(0, 12)} djrust ${String(djCid).slice(0, 12)}\n  ${detail}`);
            }
        }
    }
}
console.log(`  composed ${n} projects on each side in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

// Share envelopes: djrust and codec.js name each by the same CID.
let shares = 0;
for (const f of readdirSync(path.join(root, 'examples')).filter(f => f.endsWith('.json')).sort()) {
    const doc = JSON.parse(readFileSync(path.join(root, 'examples', f), 'utf8'));
    if (doc['@type'] !== 'BeatsShare') continue;
    const js = await computeCidForJsonLd(doc);
    const d = dj.share_cid(JSON.stringify(doc));
    shares++;
    if (js !== d) failures.push(`examples/${f}: share CID js ${js} djrust ${d}`);
}
console.log(`  checked ${shares} example share envelopes`);

if (failures.length) {
    console.error(`\ndjrust parity FAILED: ${failures.length} of ${n + shares} differ`);
    for (const f of failures.slice(0, 20)) console.error('  ' + f);
    if (failures.length > 20) console.error(`  … and ${failures.length - 20} more`);
    process.exit(1);
}
console.log(`ok  djrust parity: ${n} model CIDs and ${shares} share CIDs agree (djrust ${version})`);
