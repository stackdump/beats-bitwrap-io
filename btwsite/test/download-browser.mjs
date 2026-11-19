#!/usr/bin/env node
// download-browser.mjs: the download button, in headless Chrome against a running btwsite.
//
//   node btwsite/test/download-browser.mjs --server http://127.0.0.1:18397 [--shots DIR]
//
// Needs the real server (btwsite -btwd ...: the render status and the render itself) and the built wasm in the page.
// 1. trance-138 (64 bars): the popover says its length and offers Opus and WAV; the WAV link downloads a WAV whose
//    header has the real sizes, as an attachment named after the program.
// 2. a 300-bar program: the popover refuses before any request, saying the length, the 256-bar limit and the way out,
//    and there is no download link.
import fs from 'node:fs';
import path from 'node:path';
import { CHROME, launch, sleep } from './cdp.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };
const SERVER = arg('server', '');
const SHOTS = arg('shots', '');
if (!SERVER) { console.log('SKIP download-browser: needs --server http://host:port (a btwsite with -btwd)'); process.exit(0); }
if (!fs.existsSync(CHROME)) { console.log(`SKIP download-browser: no Chrome at ${CHROME}`); process.exit(0); }

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${!ok && detail ? `\n         ${detail}` : ''}`); if (!ok) failed++; };

const page = await launch({ width: 1280, height: 800 });
const wait = (expr, ms = 20000) => page.waitFor(expr, ms, 100);
const popText = () => page.eval('(()=>{const p=document.querySelector(".pop"); return p ? p.textContent : null})()');
try {
  await page.goto(`${SERVER}/`);
  await wait('window.__app && window.__app.wasmOk === true && window.__app.info');
  // 1. an example under the limit
  await page.eval('(()=>{const s=document.getElementById("examples"); s.value="trance-138"; s.dispatchEvent(new Event("change"));})()');
  await wait('__app.editor.text.includes("trance-138")');
  await page.click('#btn-download');
  await wait('!!document.querySelector("#dl-wav")', 30000);
  const t1 = await popText();
  check('the popover says how long the song is', /64 bars · 1:51/.test(t1), t1);
  check('it offers Opus and WAV', (await page.eval('!!document.querySelector("#dl-opus") && !!document.querySelector("#dl-wav")')) === true);
  if (SHOTS) await page.shot(path.join(SHOTS, 'download-ok.png'));
  const href = await page.eval('document.querySelector("#dl-wav").href');
  check('the WAV link is the render as an attachment', /\/api\/render\/z\w+\?format=wav&download=1$/.test(href), href);
  const r = await fetch(href);
  const b = Buffer.from(await r.arrayBuffer());
  check('the download is a WAV attachment named after the program', r.status === 200 && /^attachment; filename=trance-138-z\w+\.wav$/.test(r.headers.get('content-disposition') || ''), `${r.status} ${r.headers.get('content-disposition')}`);
  check('with the real sizes in its header', b.length > 44 && b.readUInt32LE(4) === b.length - 8 && b.readUInt32LE(40) === b.length - 44, `${b.length} bytes, riff ${b.length > 8 && b.readUInt32LE(4)}`);
  const secs = (b.length - 44) / (44100 * 2 * 2);
  check(`and the song's length (${secs.toFixed(1)} s; 64 bars at 138 bpm is 111.3 s)`, Math.abs(secs - 111.3) < 2.5, `${secs}`);
  await page.eval('__app.closePanel()');

  // 2. a program over the limit
  await page.eval('(()=>{const ta=document.querySelector(".ed-ta"); ta.focus(); ta.select(); })()');
  await page.type('tempo 120\ndeck A: kick x ~ ~ ~\nend at bar 300\n');
  await sleep(400);
  const bars = await page.eval('(__app.runCheckNow() || {}).song_bars');
  await page.click('#btn-download');
  await wait('!!document.querySelector(".pop")');
  await sleep(300);
  const t2 = await popText();
  check(`a ${bars}-bar song is refused with the length, the limit and the way out`, /this song is 300 bars \(10:00\)/i.test(t2) && /at most 256 bars/.test(t2) && /end at bar 256/.test(t2), t2);
  check('and there is no download link', (await page.eval('!document.querySelector("#dl-wav") && !document.querySelector("#dl-opus")')) === true);
  if (SHOTS) await page.shot(path.join(SHOTS, 'download-too-long.png'));
  await page.eval('__app.closePanel()');

  // 3. a phone: the header has no room for the button, so the share popover carries it
  await page.resize(412, 915);
  await page.eval('(()=>{const s=document.getElementById("examples"); s.value="trance-138"; s.dispatchEvent(new Event("change"));})()');
  await wait('__app.editor.text.includes("trance-138")');
  check('on a phone the header download button is hidden', (await page.eval('getComputedStyle(document.getElementById("btn-download")).display')) === 'none');
  await page.eval('document.getElementById("btn-share").click()');
  await wait('!!document.querySelector("#sh-download")');
  await page.eval('document.getElementById("sh-download").click()');
  await wait('!!document.querySelector("#dl-wav")', 30000);
  check('and share → Download audio… opens the download popover', /64 bars/.test(await popText()));
  if (SHOTS) await page.shot(path.join(SHOTS, 'download-phone.png'));
} catch (e) {
  console.log(`download-browser: ${e.message}`);
  failed++;
} finally {
  const bad = page.errors().filter((e) => !/favicon/i.test(e.text));
  check('no console error or exception', bad.length === 0, bad.map((e) => e.text).join(' | ').slice(0, 400));
  await page.close();
}
console.log(failed ? `download-browser: ${failed} FAILED` : 'download-browser: all ok');
process.exit(failed ? 1 : 0);
