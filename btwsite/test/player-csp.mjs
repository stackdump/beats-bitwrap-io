// The self-contained player (btwsite/player, project-datum 6669) under a Claude-artifact-like CSP, in headless Chrome.
//
//   node btwsite/test/player-csp.mjs        (needs btwsite/web/wasm, or BTW_WASM=<dir>; skips without it)
//
// Builds the package, then plays player/test/csp.html's program (drums on an 808 kit, a melody, a sung line) three ways:
//   files   the package beside the page (one origin)
//   cdn     the package from a second origin with CORS, as from cdn.jsdelivr.net (the page allows it in script-src)
//   strict  the CSP exactly as an artifact states it, without 'wasm-unsafe-eval': WebAssembly cannot compile, and the
//           element must say so rather than fail silently
// and checks, for the first two: it plays (the section and bar advance), no request was blocked (no
// securitypolicyviolation), nothing was fetched from anywhere but the page's origin and the CDN, and no console error.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const wasm = process.env.BTW_WASM || path.join(here, '..', 'web', 'wasm');
if (!fs.existsSync(path.join(wasm, 'btw_bg.wasm'))) {
  console.log(`# skip: no ${wasm}/btw_bg.wasm (djrust-vevr-se scripts/build-web-wasm.sh ${wasm})`);
  process.exit(0);
}
const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'btw-player-'));
execFileSync(process.execPath, [path.join(here, '..', 'player', 'build.mjs'), '--wasm', wasm, '--out', dist], { stdio: 'inherit' });

const ARTIFACT = "default-src 'self'; script-src 'self' 'unsafe-inline' cdn.jsdelivr.net unpkg.com; connect-src 'self'";
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json' };

function serve(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve({ s, origin: `http://127.0.0.1:${s.address().port}` }));
  });
}
function file(res, p, headers) {
  if (!p.startsWith(dist) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store', ...headers });
  res.end(fs.readFileSync(p));
}

const page = fs.readFileSync(path.join(dist, 'test', 'csp.html'), 'utf8');
const cdn = await serve((req, res) => file(res, path.join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname)), { 'Access-Control-Allow-Origin': '*' }));
let csp = '';
const site = await serve((req, res) => {
  const u = new URL(req.url, 'http://x');
  // the browser's own request, not the page's
  if (u.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (u.pathname === '/cdn.html') {
    // the same page, the package from the other origin, which the CSP allows as it allows cdn.jsdelivr.net
    const html = page.replace('src="../beatscript-track.js"', `src="${cdn.origin}/beatscript-track.js"`).replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
    res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Content-Security-Policy': csp });
    res.end(html);
    return;
  }
  file(res, path.join(dist, decodeURIComponent(u.pathname)), { 'Content-Security-Policy': csp });
});

const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok' : 'FAIL'} - ${what}`); if (!ok) failures.push(what); };

async function play(b, url, label) {
  await b.goto(url);
  await b.waitFor(`customElements.get('beatscript-track') && document.getElementById('track').shadowRoot`, 20000);
  // the play button is the card's first thing, at its left
  await b.click('#track', { dx: 48, dy: 60 });
  const t0 = Date.now();
  let r;
  for (;;) {
    r = await b.eval(`document.getElementById('track').report`);
    if (r.playing || (r.state && !/loading/.test(r.state)) || Date.now() - t0 > 60000) break;
    await sleep(200);
  }
  const seen = new Set();
  if (r.playing) for (let i = 0; i < 20; i++) { await sleep(200); const q = await b.eval(`document.getElementById('track').report`); seen.add(`${q.sec} ${q.bar}`); }
  // what the engine installed by the end (a deck's net lands on a bar line, after the first report)
  const installed = r.playing ? (await b.eval(`document.getElementById('track').report`)).installed : [];
  if (process.env.BTW_SHOT) await b.shot(process.env.BTW_SHOT.replace(/\.png$/, `-${label}.png`));
  const v = await b.eval('window.__violations');
  const fetched = await b.eval(`performance.getEntriesByType('resource').map((e) => e.name)`);
  const errors = b.errors().map((e) => e.text);
  await b.eval(`document.getElementById('track').stop()`);
  console.log(`# ${label}: ${JSON.stringify({ report: r, seen: [...seen], installed, violations: v, errors })}`);
  return { r, seen, installed, v, fetched, errors };
}

const b = await launch({ width: 640, height: 480 });
try {
  csp = ARTIFACT.replace("'unsafe-inline'", "'unsafe-inline' 'wasm-unsafe-eval'");
  const f = await play(b, `${site.origin}/test/csp.html`, 'files');
  check(f.r.playing, 'files: it plays from a click');
  check([...f.seen].some((s) => /^verse 1\/1 bar [2-4]\/4$/.test(s)), `files: the section and bar advance (${[...f.seen].join(' | ')})`);
  check(f.v.length === 0, `files: no blocked request (${JSON.stringify(f.v)})`);
  check(f.fetched.every((u) => u.startsWith(site.origin)), 'files: nothing fetched but the page\'s own files');
  check(f.errors.length === 0, `files: no console error (${f.errors.join('; ')})`);
  // deck B is the melody and the line sung on it: both decks' nets reached the engine
  check(JSON.stringify(f.installed) === '["A","B"]', `files: the drums (deck A) and the melody with its sung line (deck B) are installed (${JSON.stringify(f.installed)})`);

  csp = ARTIFACT.replace("'unsafe-inline'", `'unsafe-inline' 'wasm-unsafe-eval' ${cdn.origin}`);
  const c = await play(b, `${site.origin}/cdn.html`, 'cdn');
  check(c.r.playing, 'cdn: it plays from a click');
  check([...c.seen].some((s) => /^verse 1\/1 bar [2-4]\/4$/.test(s)), `cdn: the section and bar advance (${[...c.seen].join(' | ')})`);
  check(c.v.length === 0, `cdn: no blocked request (${JSON.stringify(c.v)})`);
  check(c.fetched.every((u) => u.startsWith(site.origin) || u.startsWith(cdn.origin)), `cdn: nothing fetched but the page and the CDN (${c.fetched.filter((u) => !u.startsWith(cdn.origin)).join(', ')})`);
  check(JSON.stringify(c.installed) === '["A","B"]', `cdn: both decks are installed (${JSON.stringify(c.installed)})`);
  check(c.r.composer === 'main', `cdn: the composer runs on the page thread (a cross-origin Worker is not allowed): ${c.r.composer}`);

  csp = ARTIFACT;
  const s = await play(b, `${site.origin}/test/csp.html`, 'strict');
  check(!s.r.playing && /wasm-unsafe-eval/.test(s.r.state), `strict: without 'wasm-unsafe-eval' it does not play and says why (${s.r.state})`);
} finally {
  await b.close();
  site.s.close();
  cdn.s.close();
  fs.rmSync(dist, { recursive: true, force: true });
}
console.log(failures.length ? `# ${failures.length} failed` : '# all passed');
process.exit(failures.length ? 1 : 0);
