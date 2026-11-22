// build.mjs: assemble the self-contained player package (project-datum 6669) into one directory, publish-ready.
//
//   node btwsite/player/build.mjs [--wasm <dir>] [--out <dir>]
//
// --wasm: the browser module (btw.js + btw_bg.wasm, from djrust-vevr-se scripts/build-web-wasm.sh); default
//         btwsite/web/wasm. --out: default btwsite/player/dist (git-ignored: the wasm is built from a private repo, as
//         btwsite/web/wasm is, so the package is assembled, never committed).
//
// The output is the npm package and also the files to put beside a page:
//   beatscript-track.js        the element (ESM)        beatscript-track.umd.js   a classic-script loader of it
//   js/                        the editor's engine, unchanged (engine.js, its worklet and composer, the facade)
//   wasm/btw.js                the wasm-bindgen glue    wasm/btw_bg.wasm.b64.js   the module, base64, as an ES module
//   test/csp.html              a page under an artifact-like CSP that plays a program
//   package.json, README.md, hashes.json (sha256 of every file, and the module's own hashes.json)
// The module is inlined so that nothing is fetched (a page whose connect-src is 'self' cannot fetch a .wasm from a CDN,
// but it can import a script from one). No npm, no bundler: files are copied as they are.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(here, '..', 'web');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const wasmDir = path.resolve(arg('--wasm', path.join(web, 'wasm')));
const out = path.resolve(arg('--out', path.join(here, 'dist')));

// the engine's own files, and nothing of the editor: what engine.js, its worklet and composer import, and the facade
const ENGINE = ['engine.js', 'engine-worklet.js', 'engine-composer.js', 'engine-polyfill.js', 'engine-calls.js', 'mixer-model.js', 'wasm.js', 'wasm-mock.js', 'embed-model.js'];

for (const f of ['btw.js', 'btw_bg.wasm']) {
  if (!fs.existsSync(path.join(wasmDir, f))) {
    console.error(`build.mjs: ${path.join(wasmDir, f)} is missing: build it with djrust-vevr-se scripts/build-web-wasm.sh ${wasmDir}`);
    process.exit(2);
  }
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'js'), { recursive: true });
fs.mkdirSync(path.join(out, 'wasm'), { recursive: true });
fs.mkdirSync(path.join(out, 'test'), { recursive: true });
const cp = (from, to) => fs.copyFileSync(from, path.join(out, to));
cp(path.join(here, 'src', 'beatscript-track.js'), 'beatscript-track.js');
cp(path.join(here, 'src', 'beatscript-track.umd.js'), 'beatscript-track.umd.js');
cp(path.join(here, 'src', 'package.json'), 'package.json');
cp(path.join(here, 'README.md'), 'README.md');
cp(path.join(here, 'test', 'csp.html'), 'test/csp.html');
for (const f of ENGINE) cp(path.join(web, 'js', f), `js/${f}`);
cp(path.join(wasmDir, 'btw.js'), 'wasm/btw.js');
const wasm = fs.readFileSync(path.join(wasmDir, 'btw_bg.wasm'));
fs.writeFileSync(path.join(out, 'wasm', 'btw_bg.wasm.b64.js'), `// btw_bg.wasm (${wasm.length} bytes, sha256 ${crypto.createHash('sha256').update(wasm).digest('hex')}), base64: imported, never fetched\nexport const WASM_BASE64 = '${wasm.toString('base64')}';\n`);

// every import the copied files make must be a copied file: a missing one would be fetched from nowhere
for (const dir of ['', 'js', 'wasm']) {
  for (const f of fs.readdirSync(path.join(out, dir)).filter((f) => f.endsWith('.js'))) {
    // the code, without its comments (a doc comment's example import is not an import)
    const src = fs.readFileSync(path.join(out, dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)'(\.[^']+)'/g)) {
      const target = path.join(out, dir, m[1]);
      if (!fs.existsSync(target)) throw new Error(`${path.join(dir, f)} imports ${m[1]}, which the package does not have`);
    }
    if (/https?:\/\/beatscript\.app\/(?!p\/|docs|#)/.test(src)) throw new Error(`${path.join(dir, f)} names a beatscript.app URL that is not a plain link`);
  }
}

const files = {};
const walk = (d) => {
  for (const f of fs.readdirSync(path.join(out, d))) {
    const rel = path.join(d, f);
    if (fs.statSync(path.join(out, rel)).isDirectory()) walk(rel);
    else files[rel] = { sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(out, rel))).digest('hex'), size: fs.statSync(path.join(out, rel)).size };
  }
};
walk('');
let module = null;
try { module = JSON.parse(fs.readFileSync(path.join(wasmDir, 'hashes.json'), 'utf8')); } catch { /* an older build */ }
fs.writeFileSync(path.join(out, 'hashes.json'), JSON.stringify({ files, module }, null, 2) + '\n');
const total = Object.values(files).reduce((a, f) => a + f.size, 0);
console.log(`build.mjs: wrote ${out}: ${Object.keys(files).length} files, ${(total / 1048576).toFixed(1)} MB`);
