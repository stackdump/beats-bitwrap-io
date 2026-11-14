#!/usr/bin/env node
// djrust-pin.mjs: the djwasm CDN pin (public/djrust/pin.js).
//
// The ?engine=djrust module is the `djwasm` npm package (stackdump/djrust, cabi/), served by
// jsDelivr at an exact version; the page fetches it with the SRI hash pinned here, so a changed
// file refuses to load. loader.js / worklet.js in public/djrust are the package's own glue,
// vendored byte for byte (a worklet cannot be loaded with SRI, so the glue is served from here).
//
//   node scripts/djrust-pin.mjs pin <pkg dir>   write pin.js from a built package (cabi/pkg) and
//                                               copy its loader.js / worklet.js
//   node scripts/djrust-pin.mjs check           offline: the vendored glue (and djwasm.wasm, when
//                                               present) are the bytes the pin names
//   node scripts/djrust-pin.mjs verify          online: jsDelivr serves the pinned bytes
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'djrust');
const pinPath = join(dir, 'pin.js');
const GLUE = ['loader.js', 'worklet.js'];
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const sri = (b) => 'sha384-' + createHash('sha384').update(b).digest('base64');

export function readPin() {
    const text = readFileSync(pinPath, 'utf8');
    const i = text.indexOf('export default ');
    return JSON.parse(text.slice(i + 'export default '.length).replace(/;\s*$/, ''));
}

function pin(pkgDir) {
    const h = JSON.parse(readFileSync(join(pkgDir, 'hashes.json'), 'utf8'));
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    if (h.package !== 'djwasm' || pkg.version !== h.version) throw new Error('not a djwasm package dir');
    for (const f of GLUE) copyFileSync(join(pkgDir, f), join(dir, f));
    const w = h.files['djwasm.wasm'];
    const p = {
        package: 'djwasm',
        version: h.version,
        url: `https://cdn.jsdelivr.net/npm/djwasm@${h.version}/djwasm.wasm`,
        integrity: w.integrity,
        sha256: w.sha256,
        bytes: w.bytes,
        glue: Object.fromEntries(GLUE.map((f) => [f, h.files[f].sha256])),
    };
    writeFileSync(pinPath,
        '// The djwasm module ?engine=djrust loads: an exact npm version on jsDelivr, fetched with this\n' +
        '// SRI hash (a changed file refuses to load). Written by `node scripts/djrust-pin.mjs pin`; held by\n' +
        '// `make check-djrust-pin` (offline) and `make djrust-verify-cdn` (online). Never a range or latest.\n' +
        'export default ' + JSON.stringify(p, null, 4) + ';\n');
    console.log(`pinned djwasm@${p.version} ${p.sha256}`);
}

function check() {
    const p = readPin();
    let bad = 0;
    for (const f of GLUE) {
        const have = sha256(readFileSync(join(dir, f)));
        if (have !== p.glue[f]) { console.error(`${f} is not djwasm@${p.version}'s (${have}); never edit it here, change cabi/js in djrust and re-pin`); bad++; }
    }
    const local = join(dir, 'djwasm.wasm');
    if (existsSync(local)) {
        const b = readFileSync(local);
        if (sha256(b) !== p.sha256) console.log(`note: local djwasm.wasm (${sha256(b).slice(0, 12)}) is not the pinned build; the page prefers the CDN`);
    }
    if (!/^sha384-[A-Za-z0-9+/]{64}$/.test(p.integrity) || !/^\d+\.\d+\.\d+$/.test(p.version)) { console.error('pin: integrity / version malformed'); bad++; }
    if (p.url !== `https://cdn.jsdelivr.net/npm/djwasm@${p.version}/djwasm.wasm`) { console.error('pin: url does not name the pinned version'); bad++; }
    if (bad) process.exit(1);
    console.log(`djrust pin ok: djwasm@${p.version}, glue matches`);
}

async function verify() {
    const p = readPin();
    const res = await fetch(p.url);
    if (!res.ok) { console.error(`${p.url}: HTTP ${res.status} (published yet?)`); process.exit(1); }
    const b = Buffer.from(await res.arrayBuffer());
    const okWasm = sha256(b) === p.sha256 && sri(b) === p.integrity;
    let okGlue = true;
    for (const f of GLUE) {
        const r = await fetch(p.url.replace('djwasm.wasm', f));
        const g = r.ok ? sha256(Buffer.from(await r.arrayBuffer())) : `HTTP ${r.status}`;
        if (g !== p.glue[f]) { console.error(`${f} on jsDelivr: ${g}, pinned ${p.glue[f]}`); okGlue = false; }
    }
    if (!okWasm) console.error(`jsDelivr serves ${sha256(b)}, pinned ${p.sha256}`);
    if (!okWasm || !okGlue) process.exit(1);
    console.log(`jsDelivr serves the pinned djwasm@${p.version} (${p.sha256})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const [cmd, arg] = process.argv.slice(2);
    if (cmd === 'pin' && arg) pin(arg);
    else if (cmd === 'check') check();
    else if (cmd === 'verify') await verify();
    else { console.error('usage: djrust-pin.mjs pin <pkg dir> | check | verify'); process.exit(2); }
}
