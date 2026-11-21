#!/usr/bin/env node
// mobile.mjs: the narrow-screen layout (an Android phone: 412 x 915 css px, touch) and a check that the desktop layout is the same.
//
//   node btwsite/test/mobile.mjs [--shots DIR]
//
// Headless Chrome with touch emulation against mock-server.mjs (real wasm when built). Taps, not clicks. Checks, at 412 x 915:
//   - the bar is one row: stop/play, a short status (an icon and a word), the problems as a dot and a count, and the caret
//   - the engine/stream toggle, the level and the problems strip are not in the bar until the caret opens the sheet
//   - every control is at least 44 x 44 css px, and nothing in the bar or the sheet is cut off or wider than the screen
//   - the dot and count open the list of problems on a tap; the caret opens the sheet; a tap on `stream` switches the source
//   - the bar clears the bottom safe-area inset (env(safe-area-inset-bottom)), here emulated at 34 px
// and at 1280 x 800: the strip, the toggle, the level and the hint are in the bar as they were, with the long status text.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, launch, sleep } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };
const SHOTS = arg('shots', null);
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
if (!fs.existsSync(CHROME)) { console.log(`SKIP mobile: no Chrome at ${CHROME}`); process.exit(0); }

const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const server = spawn('node', [path.join(here, 'mock-server.mjs'), '--port', String(port)], { stdio: ['ignore', 'ignore', 'inherit'] });
const stop = () => { try { server.kill('SIGKILL'); } catch { /* gone */ } };
process.on('exit', stop);
for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch { await sleep(100); } }

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${!ok && detail ? `\n         ${detail}` : ''}`); if (!ok) failed++; };

const W = 412, H = 915;
const page = await launch({ width: W, height: H, args: ['--disable-audio-output'] });
await page.cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
const tap = async (sel) => {
  const r = await page.rect(sel);
  if (!r) throw new Error(`no element ${sel}`);
  const x = r.x + r.w / 2, y = r.y + r.h / 2;
  await page.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await page.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};
const shot = (n) => (SHOTS ? page.shot(path.join(SHOTS, `${n}.png`)) : null);
/** Size and visibility of the elements matching `sel` (only those that take up room). */
const boxes = (sel) => page.eval(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { id: e.id || e.className, w: r.width, h: r.height, x: r.x, right: r.right, y: r.y, bottom: r.bottom, shown: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden', cut: e.scrollWidth > e.clientWidth + 1, text: (e.textContent || '').trim() }; })`);
const one = async (sel) => (await boxes(sel))[0] || { shown: false, w: 0, h: 0 };

try {
  await page.goto(`http://127.0.0.1:${port}/?example=hand-dubstep-140-v2&keepalive=0`);
  await page.waitFor('window.__app && window.__app.wasmOk', 20000);
  await sleep(500);

  // ---- idle -----------------------------------------------------------------------------------------------------------
  const st0 = await one('#st-short');
  check(`idle: the status is one short word (${JSON.stringify(st0.text)})`, st0.shown && st0.text.length > 0 && st0.text.length <= 10 && !st0.cut, JSON.stringify(st0));
  check('no horizontal overflow of the page', !(await page.eval('document.documentElement.scrollWidth > document.documentElement.clientWidth')));

  // ---- play on the engine ----------------------------------------------------------------------------------------------------
  await tap('.ed'); // the first touch makes the AudioContext; the engine loads behind it
  await page.waitFor("window.__app.engineState === 'ready'", 30000);
  await tap('#btn-play');
  await page.waitFor('(()=>{ const l = __app.driver && __app.driver.last; return !!(l && l.grid && l.grid.playing && l.grid.playing.A); })()', 30000);
  await sleep(600);
  check('a tap on play plays on the engine', (await page.eval('__app.driver.kind')) === 'engine');
  const bar = await one('#transport');
  check(`the bar is one row (${Math.round(bar.h)} px high)`, bar.h > 0 && bar.h <= 66, `${bar.h}`);
  const st = await one('#st-short');
  check(`the status is an icon and a word: ${JSON.stringify(st.text)} (live, stream, offline ...)`, st.shown && /^(live|stream|preparing|loading|buffering|rendering|stopped|offline|error)$/.test(st.text) && !st.cut, JSON.stringify(st));
  check('the status icon is there', (await one('#t-status .st-ic')).shown);
  const inBar = { play: await one('#btn-play'), prob: await one('#t-prob'), caret: await one('#btn-decks') };
  check('the bar has stop/play, the problems dot and count, and the caret', inBar.play.shown && inBar.prob.shown && inBar.caret.shown, JSON.stringify(inBar));
  for (const [k, v] of Object.entries(inBar)) check(`${k}: a touch target of at least 44 x 44 (${Math.round(v.w)} x ${Math.round(v.h)})`, v.w >= 44 && v.h >= 44);
  for (const sel of ['#t-source', '.t-level', '#pr-sum', '.t-hint', '.t-bpm']) check(`${sel} is not in the bar`, !(await one(sel)).shown);
  check('the strip above the bar is gone', !(await one('#problems')).shown);
  // the top bar: the logo, the example picker and the menu button; the tools are in the menu, each with its label
  const top = (await boxes('.top .tb, .top select')).filter((b) => b.shown);
  check(`the top bar's controls are at least 44 px (${top.map((b) => `${Math.round(b.w)}x${Math.round(b.h)}`).join(' ')})`, top.length >= 2 && top.every((b) => b.w >= 44 && b.h >= 44), JSON.stringify(top.map((b) => [b.id, b.w, b.h])));
  check('and they fit the screen', top.every((b) => b.x >= 0 && b.right <= W + 0.5));
  check('the logo and the example picker are shown', (await one('.brand-mark')).shown && (await one('#examples')).shown && (await one('#btn-menu')).shown);
  await tap('#btn-menu');
  await sleep(150);
  const items = (await boxes('#tools .tb')).filter((b) => b.shown);
  check(`the menu lists the eight tools, each with its label, 44 px high, on screen (${items.map((b) => b.text.replace(/\s+/g, ' ')).join(', ')})`,
    items.length === 8 && items.every((b) => b.h >= 44 && b.x >= 0 && b.right <= W + 0.5 && /[a-z]{2,}/.test(b.text)), JSON.stringify(items.map((b) => [b.id, b.text, b.h])));
  await shot('menu');
  await tap('#btn-menu');
  await sleep(100);
  check('the menu closes again', !(await one('#btn-fmt')).shown);
  check('the code wraps: no sideways scroll in the editor', await page.eval('(() => { const s = document.querySelector(".ed-scroll"); return s.scrollWidth <= s.clientWidth; })()'));
  const follow = await one('#btn-follow');
  check(`the header's Follow button is on screen and 44 px (${Math.round(follow.w)} x ${Math.round(follow.h)})`, follow.shown && follow.right <= W + 0.5 && follow.w >= 44 && follow.h >= 44, JSON.stringify(follow));
  check('the problems dot says there are none', (await page.eval('document.getElementById("t-prob-dot").className')) === 'pr-dot ' && (await one('#t-prob-n')).text === '0');
  await shot('bar-playing');

  // ---- a problem: the dot and count open the list --------------------------------------------------------------------------------
  await page.eval('(()=>{const ta=document.querySelector(".ed-ta"); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);})()');
  await page.type('\nfoo bar\n');
  await sleep(600);
  check('the count is 1 and the dot is red', (await one('#t-prob-n')).text === '1' && /error/.test(await page.eval('document.getElementById("t-prob-dot").className')));
  check('the list is closed until asked for', !(await one('#pr-list')).shown);
  await tap('#t-prob');
  await sleep(250);
  const list = await one('#pr-list');
  const row = await one('.pr-row');
  check('a tap on the dot and count opens the list of problems', list.shown && (await page.eval('document.getElementById("t-prob").getAttribute("aria-expanded")')) === 'true', JSON.stringify(list));
  check(`a row is at least 44 px high (${Math.round(row.h)})`, row.h >= 44);
  check('the list is above the bar, on screen', list.bottom <= (await one('#transport')).y + 1 && list.y >= 0);
  await shot('problems-open');
  await tap('#t-prob');
  await sleep(200);
  check('a second tap closes it', !(await one('#pr-list')).shown);
  // a tap on a problem puts the caret there (the list is the same list as on a wide page)
  await tap('#t-prob');
  await sleep(150);
  await tap('.pr-row');
  await sleep(150);
  check('a tap on a problem jumps to it', (await page.eval('__app.editor.ta.selectionStart')) > 0 && (await page.eval('document.activeElement === __app.editor.ta')));
  await tap('#t-prob');

  // ---- the sheet: the caret ------------------------------------------------------------------------------------------------------
  await tap('#btn-decks');
  await sleep(300);
  const src = await one('#t-source');
  const lvl = await one('.t-level');
  const segs = await boxes('#t-source button');
  const rng = await one('#level');
  check('the caret opens the sheet: the engine / stream toggle and the level', src.shown && lvl.shown, JSON.stringify({ src, lvl }));
  check(`the toggle's buttons are 44 px and say engine and stream in full (${segs.map((b) => `${b.text} ${Math.round(b.w)}x${Math.round(b.h)}`).join(', ')})`, segs.length === 2 && segs.every((b) => b.h >= 44 && b.w >= 44 && !b.cut) && segs[0].text === 'engine' && segs[1].text === 'stream', JSON.stringify(segs));
  check(`the level slider is 44 px high (${Math.round(rng.h)})`, rng.shown && rng.h >= 44, JSON.stringify(rng));
  check('the sheet fits the screen and nothing in it is cut off', src.right <= W + 0.5 && lvl.right <= W + 0.5 && !(await page.eval('document.documentElement.scrollWidth > document.documentElement.clientWidth')) && !(await boxes('#transport *:not(.sr)')).some((b) => b.shown && b.cut), JSON.stringify((await boxes('#transport *:not(.sr)')).filter((b) => b.cut)));
  check('the caret turns over (aria-expanded)', (await page.eval('document.getElementById("btn-decks").getAttribute("aria-expanded")')) === 'true');
  await shot('sheet-open');
  await tap('#src-stream');
  await sleep(200);
  check('a tap on stream chooses it', (await page.eval('__app.sourcePref')) === 'stream');
  await tap('#src-stream'); // back to automatic
  await tap('#btn-decks');
  await sleep(200);
  check('the caret closes the sheet', !(await one('#t-source')).shown && !(await one('.t-level')).shown);

  // ---- safe area: the bar clears the home indicator ------------------------------------------------------------------------------
  let safe = null;
  try { await page.cdp('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom: 34, left: 0, right: 0 } }); safe = true; } catch { safe = false; }
  if (safe) {
    await sleep(200);
    const pb = await page.eval('parseFloat(getComputedStyle(document.getElementById("transport")).paddingBottom)');
    check(`the bar keeps clear of the bottom inset (padding-bottom ${pb}px with a 34 px inset)`, pb >= 34, `${pb}`);
    const pl = await page.eval('(()=>{ const c = getComputedStyle(document.getElementById("transport")); return [parseFloat(c.paddingLeft), parseFloat(c.paddingRight)]; })()');
    check(`and its sides have at least 10 px (${pl.join(', ')})`, pl.every((v) => v >= 10));
    await page.cdp('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom: 0, left: 0, right: 0 } }).catch(() => {});
  } else {
    console.log('  note: this Chrome has no Emulation.setSafeAreaInsetsOverride: the safe-area check reads the stylesheet instead');
    const css = fs.readFileSync(path.join(here, '..', 'web', 'css', 'btw.css'), 'utf8');
    check('the stylesheet pads the bar by env(safe-area-inset-bottom)', /\.transport \{[^}]*safe-area-inset-bottom/.test(css));
  }

  // ---- wide: nothing moved ----------------------------------------------------------------------------------------------------------
  await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: false });
  await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  const wide = {};
  for (const sel of ['#t-source', '.t-level', '#pr-sum', '.t-hint', '#t-status .st-long', '#btn-decks']) wide[sel] = (await one(sel)).shown;
  check('desktop: the strip, the toggle, the level and the hint are in place', Object.values(wide).every(Boolean), JSON.stringify(wide));
  check('desktop: the problems dot-and-count and the short status are not shown', !(await one('#t-prob')).shown && !(await one('#t-status .st-short')).shown && !(await one('#t-status .st-ic')).shown);
  const wbar = await one('#transport');
  check(`desktop: the bar is 54 px high as before (${wbar.h})`, Math.abs(wbar.h - 54) <= 1, `${wbar.h}`);
  check('desktop: the status reads the long way', /engine · live/.test((await one('#t-status')).text.replace(/\s+/g, ' ')) || /live: edits land/.test(await page.eval('document.getElementById("st-long").textContent')), (await one('#t-status')).text);
  check('desktop: the sheet class does nothing (toggle the caret: decks open, bar height unchanged)', await (async () => { await page.click('#btn-decks'); await sleep(200); const h = (await one('#transport')).h; await page.click('#btn-decks'); return Math.abs(h - wbar.h) <= 1; })());
  await shot('wide');
} catch (e) {
  console.log(`mobile: ${e.message}`);
  failed++;
} finally {
  const errors = page.errors().filter((e) => !/favicon/i.test(e.text));
  await page.close();
  stop();
  check('no console error or exception', errors.length === 0, errors.map((e) => e.text).join(' | ').slice(0, 400));
  console.log(failed ? `mobile: ${failed} FAILED` : 'mobile: all ok');
  process.exit(failed ? 1 : 0);
}
