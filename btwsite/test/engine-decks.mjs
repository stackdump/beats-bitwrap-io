#!/usr/bin/env node
// engine-decks.mjs: each deck is heard on its own through js/engine.js.
//
//   node btwsite/test/engine-decks.mjs [--seconds 4]
//
// Plays btwsite/testdata/engine/deck-a-kick.btw (a kick on deck A only) and deck-b-kick.btw (the same kick on deck B
// only) in headless Chrome through web/engine-test.html, and checks that both are loud and about as loud as each other.
// The regression it guards: the wasm `Dj` starts with its crossfader at 0 (all A), and the desktop centres it when its
// audio starts (djapp audio_io.rs) but the worklet did not, so everything on deck B was faded out (trance-138's arp,
// pad and melody were silent while its drums played). Skips (exit 0) when the wasm is not built or Chrome is not
// installed (CHROME=/usr/bin/google-chrome on Linux; BTW_CHROME_ARGS=--disable-audio-output where there is no sound card).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, launch, sleep } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };
const SECONDS = Number(arg('seconds', 4));

if (!fs.existsSync(path.join(site, 'web', 'wasm', 'btw_bg.wasm'))) { console.log('SKIP engine-decks: no built module in btwsite/web/wasm'); process.exit(0); }
if (!fs.existsSync(CHROME)) { console.log(`SKIP engine-decks: no Chrome at ${CHROME}`); process.exit(0); }

const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', site], { stdio: 'ignore' });
const stop = () => { try { server.kill('SIGKILL'); } catch { /* gone */ } };
process.on('exit', stop);
for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/web/engine-test.html`); break; } catch { await sleep(100); } }

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${!ok && detail ? `\n         ${detail}` : ''}`); if (!ok) failed++; };

async function play(program) {
  const page = await launch({ width: 600, height: 400, args: ['--disable-audio-output'] });
  try {
    await page.goto(`http://127.0.0.1:${port}/web/engine-test.html?program=${encodeURIComponent(program)}&seconds=${SECONDS}`);
    await page.click('#go');
    await page.waitFor("window.__btwTest && (window.__btwTest.phase === 'done' || window.__btwTest.phase === 'error')", (SECONDS + 40) * 1000, 250);
    return await page.eval('JSON.parse(JSON.stringify(window.__btwTest))');
  } finally {
    await page.close();
  }
}

const level = {};
try {
  for (const deck of ['A', 'B']) {
    const T = await play(`/testdata/engine/deck-${deck.toLowerCase()}-kick.btw`);
    check(`deck ${deck} alone: the page finished`, T.phase === 'done', T.error || `phase ${T.phase}`);
    const installed = (T.events || []).filter((e) => e.deck === deck).length;
    check(`deck ${deck} alone: its net was installed`, installed >= 1, JSON.stringify(T.events));
    level[deck] = T.rmsMax || 0;
    check(`deck ${deck} alone is heard (RMS max ${level[deck].toFixed(4)})`, level[deck] > 0.05, `rms max ${level[deck]}`);
  }
  if (level.A > 0.05 && level.B > 0.05) {
    const ratio = level.B / level.A;
    check(`and the two decks are about as loud (B/A ${ratio.toFixed(2)})`, ratio > 0.5 && ratio < 2, `A ${level.A}, B ${level.B}`);
  }
} catch (e) {
  console.log(`engine-decks: ${e.message}`);
  failed++;
} finally {
  stop();
}
console.log(failed ? `engine-decks: ${failed} FAILED` : 'engine-decks: all ok');
process.exit(failed ? 1 : 0);
