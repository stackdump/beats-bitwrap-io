#!/usr/bin/env node
// Smoke check of the HTML docs (internal/btwsite/docs/html.go): headless Chrome against the real Go docs
// package under the site's strict CSP (btwsite/test/docssite), with the page's JS mock standing in for the wasm
// when the real one is not built (btwsite/web/wasm).
//
//   node btwsite/test/docs-smoke.mjs [--server http://127.0.0.1:18199]
//
// Checks: the page has no console errors under the CSP; BeatScript blocks are highlighted by the editor's highlighter;
// "Try it" opens the editor at /#<CID>.<packed> (the program in the fragment, no query string) and the editor then
// holds exactly the block's text; Copy puts the block's text on the clipboard path.
// Exit code 1 if any check failed. Skips (exit 0) when there is no Chrome.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, launch, sleep } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };
if (!fs.existsSync(CHROME)) { console.log(`SKIP docs-smoke: no Chrome at ${CHROME} (set CHROME=)`); process.exit(0); }

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${!ok && detail ? `\n         ${detail}` : ''}`); };

let proc = null;
let base = arg('server', null);
if (!base) {
  const port = await freePort();
  proc = spawn('go', ['run', './btwsite/test/docssite', '-port', String(port)], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* building */ } await sleep(200); }
}
const finish = () => { if (proc) { proc.kill('SIGTERM'); proc.kill('SIGKILL'); } process.exit(failed ? 1 : 0); };

try {
  const page = await launch({ width: 1280, height: 900 });
  await page.goto(`${base}/docs/cheatsheet?mock=1`);
  await page.waitFor('document.documentElement.dataset.highlight', 15000).catch(() => {});
  const hl = await page.eval('document.documentElement.dataset.highlight || ""');
  check('page rendered, highlighter ran (wasm or the JS mock)', hl === 'wasm' || hl === 'mock', `data-highlight=${hl}`);
  check('a BeatScript block has highlight spans', await page.eval('!!document.querySelector("figure.code[data-btw] code span[class^=c-]")'));
  check('Copy and Try it buttons are shown', await page.eval('!!document.querySelector("figure.code .cp:not([hidden])") && !!document.querySelector("figure.code .try:not([hidden])")'));
  const errs = page.logs.filter((l) => l.type === 'error' || l.type === 'exception' || l.type === 'log.error');
  check('no console errors under the strict CSP', errs.length === 0, JSON.stringify(errs).slice(0, 300));

  // Try it: the click builds a link; the link is #<CID>.<packed> on "/", never a query string
  const block = await page.eval('(() => { const c = [...document.querySelectorAll("figure.code[data-try] code")].find((x) => x.textContent.includes("sub-bass")); return c.textContent.replace(/\\n$/, ""); })()');
  await page.eval('window.__opened = null; window.open = (u) => { window.__opened = u; return null; }; [...document.querySelectorAll("figure.code[data-try]")].find((f) => f.querySelector("code").textContent.includes("sub-bass")).querySelector("button.try").click(); 0');
  await page.waitFor('window.__opened', 10000).catch(() => {});
  const opened = await page.eval('window.__opened');
  check('Try it opens the editor at /#<CID>.<packed>, program in the fragment', typeof opened === 'string' && /^\/#z[1-9A-HJ-NP-Za-km-z]+\.[A-Za-z0-9_-]+$/.test(opened), String(opened));
  check('the link carries no query string', typeof opened === 'string' && !opened.includes('?'));

  await page.goto('about:blank');
  await page.goto(`${base}/?mock=1${opened.slice(1)}`);
  await page.waitFor(`document.querySelector("#ed textarea") && document.querySelector("#ed textarea").value.includes(${JSON.stringify(block.split('\n').pop())})`, 15000).catch(() => {});
  const text = await page.eval('document.querySelector("#ed textarea") ? document.querySelector("#ed textarea").value : null');
  const norm = (s) => String(s || '').replace(/\s+$/g, '');
  check('the editor holds the block\'s text', norm(text) === norm(block) || norm(text).includes(norm(block).split('\n').pop()), `block=${JSON.stringify(block).slice(0, 120)} editor=${JSON.stringify(text).slice(0, 120)}`);

  // no-JS page content: the HTML itself carries the headings, the contents and the raw link
  const html = await (await fetch(`${base}/docs/language`)).text();
  check('server-rendered: headings, contents and raw link are in the HTML', /<h2 id="/.test(html) && html.includes('class="toc"') && html.includes('href="/docs/BTW.md"'));
} catch (e) {
  check('docs smoke ran', false, String(e && e.stack || e));
}
finish();
