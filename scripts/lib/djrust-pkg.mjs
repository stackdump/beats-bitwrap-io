// The djrust npm package for node scripts: DJRUST_PKG=<dir with djrust.js + djrust_bg.wasm>
// (a local `djrust/npm/build.sh` build), else the version beats pins
// (public/djrust/version.js), fetched from the npm registry. Initialised and checked for the
// functions the caller needs.

import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DJRUST_VERSION } from '../../public/djrust/version.js';

export async function loadDjrust(needs = []) {
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
    for (const fn of needs) {
        if (typeof m[fn] !== 'function') {
            throw new Error(`djrust ${m.engine_version?.() || '?'} in ${dir} has no ${fn}(): ` +
                'it predates the beats facade (djrust 0.2.0)');
        }
    }
    return { m, dir };
}
