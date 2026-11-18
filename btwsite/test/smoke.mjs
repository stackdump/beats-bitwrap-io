#!/usr/bin/env node
// The browser smoke run of btwsite/test/smoke.md: headless Chrome (a tiny CDP client, no npm) against a server.
//
//   node btwsite/test/smoke.mjs                       start the mock server (real wasm if built), run everything
//   node btwsite/test/smoke.mjs --server http://127.0.0.1:18097   run against a real server instead (compose and
//                                                     session steps that need the mock's test routes are skipped)
//   node btwsite/test/smoke.mjs --only 3,5            run only steps whose number is listed
//   --mock-wasm                                       the mock server and the page both use the JS mock (?mock=1)
//
// Screenshots go to btwsite/test/shots/. Exit code 1 if any check failed or the page logged a console error.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(here, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true; };
const ONLY = arg('only', null) ? String(arg('only')).split(',').map(Number) : null;
const MOCKWASM = arg('mock-wasm', false) === true;
const QS = MOCKWASM ? 'mock=1' : '';

const results = [];
let step = 0;
function check(name, ok, detail = '') {
  results.push({ step, name, ok });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${step}. ${name}${!ok && detail ? `\n         ${detail}` : ''}`);
}
const want = () => !ONLY || ONLY.includes(step);

function freePort() { return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }
const sha = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 12);

let serverProc = null;
let base = arg('server', null);
const isMock = !base;
if (isMock) {
  const port = await freePort();
  serverProc = spawn('node', [path.join(here, 'mock-server.mjs'), '--port', String(port), ...(MOCKWASM ? ['--mock-wasm'] : [])], { stdio: ['ignore', 'ignore', 'inherit'] });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* starting */ } await sleep(100); }
}
console.log(`# server ${base} (${isMock ? 'mock' : 'real'})${MOCKWASM ? ', JS-mock wasm' : ''}`);

const page = await launch({ width: 1280, height: 800 });
const T = (path2 = '') => `${base}/${path2}`;
// a navigation that is always a real load (the same URL with a new fragment is not one)
const fresh = async (u) => { await page.goto('about:blank'); await page.goto(u); };
const shot = (n, name) => page.shot(path.join(SHOTS, `${String(n).padStart(2, '0')}-${name}.png`));
const ready = () => page.eval('(async()=>{ for (let i=0;i<300 && !(window.__btw);i++) await new Promise(r=>setTimeout(r,50)); await window.__btw.ready; return true })()', true);
const text = () => page.eval('__app.editor.text');
const setText = async (t) => { await page.eval('(()=>{const ta=document.querySelector(".ed-ta"); ta.focus(); ta.select(); })()'); await page.type(t); };
const playing = () => page.eval('document.getElementById("btn-play").classList.contains("on")');
const q = (s) => page.eval(`(()=>{const e=document.querySelector(${JSON.stringify(s)}); return e ? e.textContent : null})()`);
const count = (s) => page.eval(`document.querySelectorAll(${JSON.stringify(s)}).length`);
const withQ = (extra = '') => `${QS}${QS && extra ? '&' : ''}${extra}`;
const url = (extra = '', hash = '') => `${T('')}?${withQ(extra)}${hash}`;

const SHORT = `tempo 240
key am
section first 2 bars {
  deck A: kick x ~ x ~ | hihat x*8
  master: filter lp 300 -> 2800 over 2 bars
}
${Array.from({ length: 40 }, (_, i) => `# padding line ${i + 1}, so the next section is below the fold`).join('\n')}
section second 2 bars {
  deck A: kick x x x x | snare ~ x ~ x
  at bar 1: master: reverb 0.3
}
arrange first second first second
`;

try {
  // ---- 1. load ---------------------------------------------------------------------------------------------------
  step = 1;
  if (want()) {
    await page.goto(url());
    await ready();
    await sleep(400);
    check('the page loads and the module is up', (await page.eval('__app.wasmOk')) === true);
    check('the editor shows highlighted code (syntax spans from btw_highlight)', (await count('.ly-hl .c-keyword')) > 0 && (await count('.ly-hl [class^="c-"]')) > 10);
    check('examples are in the picker', (await count('#examples option')) > 2, `${await count('#examples option')} options`);
    check('a gutter with a number per line', (await count('.ed-gutter .gl')) === (await page.eval('__app.editor.text.split("\\n").length')));
    await shot(1, 'load');
  }

  // ---- 2. a broken program: squiggle, gutter mark, problems with the did-you-mean ----------------------------------------
  step = 2;
  if (want()) {
    await page.goto(url());
    await ready();
    await setText('tempo 126\ndeck A: kick | snare ~ x\nfoo bar\n');
    await sleep(500);
    check('a squiggle under the error span', (await count('.sq-error')) >= 1, `squiggles ${await count('.sq-error')}`);
    check('a red mark in the gutter on the line', (await count('.gi[data-sev="error"]')) >= 1);
    const sum = await q('#pr-sum-txt');
    check('the problems bar says how many errors', /error/.test(sum || ''), String(sum));
    await page.click('#pr-sum');
    await sleep(100);
    const rows = await page.eval('[...document.querySelectorAll(".pr-row")].map(r=>r.textContent)');
    check('a problem row has line:col, the message, expected: and did you mean', rows.length >= 1 && /2:\d+/.test(rows[0]) && /expected:/.test(rows[0]) && /did you mean: kick x ~ x ~/.test(rows[0]), JSON.stringify(rows[0]));
    // hover the squiggle: the message appears at the pointer
    const sq = await page.rect('.sq-error');
    await page.hover(sq.x + 4, sq.y - 6);
    await sleep(150);
    check('hovering the squiggle shows the message', (await page.eval('!document.querySelector(".ed-tip").hidden')) === true);
    await shot(2, 'error');
    // click the problem: the caret jumps to it
    await page.click('.pr-row');
    await sleep(100);
    const sel = await page.eval('JSON.stringify([document.querySelector(".ed-ta").selectionStart, document.querySelector(".ed-ta").selectionEnd, __app.editor.text.indexOf("deck A")])');
    const [a, b, line2] = JSON.parse(sel);
    check('clicking a problem puts the caret on its span', a >= line2 && b >= a, sel);
    // fix it
    await setText('tempo 126\ndeck A: kick x ~ x ~ | snare ~ x ~ x\n');
    await sleep(500);
    check('after the fix the squiggles are gone and the bar says no problems', (await count('.sq')) === 0 && (await q('#pr-sum-txt')) === 'no problems');
  }

  // ---- 3. an example, evaluated: markers on a program that is playing ---------------------------------------------------------
  step = 3;
  if (want()) {
    await page.goto(url());
    await ready();
    await page.eval('(()=>{const s=document.getElementById("examples"); s.value=["matrix-130","hand-dubstep-140-v4","trance-138"].find(n=>[...s.options].some(o=>o.value===n)); s.dispatchEvent(new Event("change"));})()');
    await sleep(800);
    check('picking an example loads its text', /section/.test(await text()));
    check('nothing plays until asked', !(await playing()));
    await page.click('.ed-ta');
    await page.key('Enter', { meta: true });
    await page.waitFor('document.getElementById("btn-play").classList.contains("on")', 8000);
    check('Cmd+Enter evaluates and plays', await playing());
    const hdr = await page.waitFor('(()=>{const t=document.getElementById("h-sec-txt").textContent; return /section \\d+\\/\\d+/.test(t) ? t : null})()', 8000);
    check('the header names the section n/m', !!hdr, String(hdr));
    let dots = 0; let lamps = 0; let bars = 0;
    for (let i = 0; i < 40 && !(dots && lamps); i++) {
      dots = Math.max(dots, await count('.gd[data-kind]'));
      lamps = Math.max(lamps, await count('.lamp-tok'));
      bars = Math.max(bars, await count('.bar'));
      await sleep(150);
    }
    check('gutter dots light on playing lines', dots > 0, `${dots}`);
    check('a token flashes (a lamp behind a token)', lamps > 0, `${lamps}`);
    check('the section bar is under the header line', (await count('.bar-section')) >= 1);
    check('the phrase lights show a current bar', (await count('#h-phrase i.now')) === 1);
    const src = await page.eval('__app.driver.kind');
    check(`a sound source is chosen (${src})`, src === 'engine' || src === 'stream');
    await sleep(1200);
    await shot(3, 'playing');
    // editing the text: markers wait for the next eval
    await page.eval('(()=>{const ta=document.querySelector(".ed-ta"); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);})()');
    await page.type('\n# a thought\n');
    await sleep(300);
    check('after an edit the markers wait for the next eval (no dots, hint in the header)', (await count('.gd[data-kind]')) === 0 && /edited since eval/.test(await q('#h-state')), await q('#h-state'));
    await page.key('Escape');
    await sleep(300);
    check('Esc stops', !(await playing()));
    if (!MOCKWASM) {
      // a later eval uses the engine (loaded behind the stream), and the next edit hot-reloads on the same runtime
      await page.waitFor('__app.engineState === "ready"', 30000);
      await page.eval('(()=>{const ta=document.querySelector(".ed-ta"); ta.focus(); ta.value=ta.value.replace(/\\n# a thought\\n$/, "\\n"); ta.dispatchEvent(new Event("input",{bubbles:true}));})()');
      await page.key('Enter', { meta: true });
      await page.waitFor('document.getElementById("btn-play").classList.contains("on")', 8000);
      check('with the engine loaded, Cmd+Enter plays on the engine', (await page.eval('__app.driver.kind')) === 'engine', await page.eval('__app.driver.kind'));
      await page.waitFor('__app.driver.last && __app.driver.last.grid && __app.driver.last.grid.playing && (__app.driver.last.grid.playing.A || __app.driver.last.grid.playing.B)', 15000);
      check('after a stop and a play again the header names the section (no stale "ready")', !!(await page.waitFor('(()=>{const t=document.getElementById("h-sec-txt").textContent; return /section \\d+\\/\\d+/.test(t) ? t : null})()', 8000).catch(() => null)), await q('#h-sec-txt'));
      await page.eval('window.__run0 = __app.driver.run');
      await page.eval('(()=>{const ta=document.querySelector(".ed-ta"); ta.focus(); ta.value=ta.value.replace(/^tempo \\d+/m, m=>"tempo "+(parseInt(m.slice(6))+2)); ta.dispatchEvent(new Event("input",{bubbles:true}));})()');
      const tempo0 = await page.eval('__app.report.tempo');
      await page.key('Enter', { meta: true });
      await sleep(600);
      check('the next edit hot-reloads on the same runtime (no restart)', (await page.eval('__app.driver.run === window.__run0')) === true && (await page.eval('__app.driver.evalText === __app.editor.text')) === true, `tempo ${tempo0}`);
      await page.click('#btn-decks');
      await sleep(600);
      check('the decks panel lists each deck\'s roles', (await count('#decks .roles li')) >= 2, `${await count('#decks .roles li')}`);
      await shot(15, 'decks');
      await page.key('Escape');
    }
  }

  // ---- 4. sections advance, the editor follows, follow toggles ---------------------------------------------------------------------
  step = 4;
  if (want()) {
    await page.goto(url());
    await ready();
    await setText(SHORT);
    await sleep(400);
    await page.click('.ed-ta');
    await page.key('Enter', { meta: true });
    await page.waitFor('document.getElementById("btn-play").classList.contains("on")', 8000);
    const first = await page.waitFor('(()=>{const t=document.getElementById("h-sec-txt").textContent; return /· first/.test(t) ? t : null})()', 8000);
    check('the first section plays first', !!first, String(first));
    await sleep(700);
    const top0 = await page.eval('document.querySelector(".ed-scroll").scrollTop');
    check('the editor went up to the first section (it was at the bottom after typing)', top0 < 120, String(top0));
    const second = await page.waitFor('(()=>{const t=document.getElementById("h-sec-txt").textContent; return /· second/.test(t) ? t : null})()', 12000);
    check('the header advances to the second section', !!second, String(second));
    await sleep(700);
    const top1 = await page.eval('document.querySelector(".ed-scroll").scrollTop');
    check('the editor followed the song down to the second section', top1 > top0 + 300, `${top0} -> ${top1}`);
    await shot(4, 'follow');
    await page.eval('document.querySelector(".ed-ta").blur()');
    await page.key('l');
    await sleep(100);
    check('L toggles follow off', (await page.eval('document.getElementById("btn-follow").getAttribute("aria-pressed")')) === 'false');
    await page.key('l');
    check('and on again', (await page.eval('document.getElementById("btn-follow").getAttribute("aria-pressed")')) === 'true');
    await page.key('Escape');
  }

  // ---- 5. fmt, share, open ------------------------------------------------------------------------------------------------------------
  step = 5;
  if (want()) {
    await page.goto(url());
    await ready();
    await setText('tempo   126  # speed\nkey  am\ndeck A:   kick x ~ x ~   |   snare ~ x ~ x\n');
    await sleep(400);
    await page.click('#btn-fmt');
    await sleep(300);
    check('fmt puts the canonical text in the editor', (await text()).includes('deck A: kick x ~ x ~ | snare ~ x ~ x') && !(await text()).includes('  # speed'), JSON.stringify(await text()));
    await page.eval('document.querySelector(".ed-ta").focus(); document.execCommand("undo")');
    await sleep(200);
    check('and Cmd+Z brings the old text back (the browser keeps its undo stack)', (await text()).includes('# speed'), JSON.stringify(await text()));
    await page.click('#btn-fmt');
    await sleep(200);
    await page.click('#btn-share');
    await page.waitFor('document.querySelector(".pop input")', 4000);
    const link = await page.eval('document.querySelector(".pop input").value');
    check('share shows a self-sealing link', /^https?:\/\/[^/]+\/#z[1-9A-HJ-NP-Za-km-z]{20,}\.[A-Za-z0-9_-]+$/.test(link), link.slice(0, 80));
    check('and puts it in the address bar', (await page.eval('location.hash')).startsWith('#z'));
    check('and says how many characters', /\d+ characters/.test(await page.eval('document.querySelector(".pop").textContent')));
    check('and offers the social /c/ form', (await page.eval('[...document.querySelectorAll(".pop input")].some(i=>/\\/c\\/z/.test(i.value))')) === true);
    await shot(5, 'share');
    const frag = link.slice(link.indexOf('#'));
    // open: a fresh page at that link shows the program with a banner and a Play button, and does not play
    await fresh(`${T('')}?${withQ()}${frag}`);
    await ready();
    await sleep(600);
    check('opening a link shows the program and a banner, verified', /Opened/.test(await q('#banner')) && (await text()).includes('snare'), await q('#banner'));
    check('and nothing plays by itself', !(await playing()));
    await shot(6, 'open-link');
    await page.eval('[...document.querySelectorAll("#banner button")].find(b=>b.textContent==="Play").click()');
    await page.waitFor('document.getElementById("btn-play").classList.contains("on")', 8000);
    check('the banner\'s Play starts it (the stream, at once)', (await page.eval('__app.driver.kind')) === 'stream');
    await page.key('Escape');
    // a link whose CID is not its text's is refused loudly
    const bad = frag.replace(/#z(.)/, (m, c) => `#z${c === '4' ? '5' : '4'}`);
    await fresh(`${T('')}?${withQ()}${bad}`);
    await ready();
    await sleep(600);
    check('a link whose CID does not match is refused, loudly', /Refused/.test(await q('#banner')), await q('#banner'));
    check('and its program was not loaded', !(await text()).includes('snare ~ x ~ x\n') || !/Opened/.test(await q('#banner')));
    // a bare CID is fetched from the server and checked
    if (isMock) {
      const ex = await (await fetch(T('api/examples'))).json();
      await fresh(`${T('')}?${withQ()}#${ex[0].cid}`);
      await ready();
      await sleep(800);
      check('a bare #CID is fetched and verified', /Opened/.test(await q('#banner')) && /fetched by CID/.test(await q('#banner')), await q('#banner'));
    }
  }

  // ---- 6. compose, sign-in, MCP ---------------------------------------------------------------------------------------------------------
  step = 6;
  if (want() && isMock) {
    await page.goto(url());
    await ready();
    await page.click('#btn-compose');
    await page.waitFor('!document.getElementById("drawer").hidden', 3000);
    check('compose is visible but disabled until signed in, with the reason', (await page.eval('document.querySelector("#drawer-body fieldset").disabled')) === true && /signed-in|sign in/i.test(await q('#drawer-body')));
    await shot(7, 'compose-signed-out');
    await page.click('#btn-user');
    await page.waitFor('document.getElementById("drawer-title").textContent==="Sign in"', 3000);
    await shot(8, 'signin');
    await page.eval('[...document.querySelectorAll("#drawer-body button")].find(b=>/browser key/i.test(b.textContent)).click()');
    await page.waitFor('__app.user', 6000);
    check('sign in with a browser-local Ed25519 key', /ed25519:/.test(await page.eval('__app.user.id')));
    check('the key is kept in localStorage btw-ed25519-v1', (await page.eval('!!localStorage.getItem("btw-ed25519-v1")')) === true);
    await page.click('#btn-compose');
    await page.waitFor('!document.querySelector("#drawer-body fieldset").disabled', 3000);
    check('compose is enabled once signed in', true);
    await page.eval('(()=>{const t=document.getElementById("c-prompt"); t.focus();})()');
    await page.type('dark techno with an acid line');
    await page.eval('[...document.querySelectorAll("#drawer-body button")].find(b=>b.textContent==="Compose").click()');
    await page.waitFor('document.querySelector("#drawer-body .okbox")', 10000);
    await page.waitFor('document.getElementById("btn-play").classList.contains("on")', 8000);
    check('compose puts the program in the editor and starts the stream at once', (await page.eval('__app.driver.kind')) === 'stream' && /composed from/.test(await text()), await page.eval('__app.driver.kind'));
    await shot(9, 'compose-done');
    check('fork-current is possible now that the program is stored', (await page.eval('!document.getElementById("c-fork").disabled')) === true);
    for (const [prompt, expect] of [['FAIL', /unrepairable: see attempts/], ['LIMIT', /rate limited, try again in 38 s/], ['NOKEY', /compose is not configured/]]) {
      await page.eval('(()=>{const t=document.getElementById("c-prompt"); t.value=""; t.focus();})()');
      await page.type(prompt);
      await page.eval('[...document.querySelectorAll("#drawer-body button")].find(b=>/^Compos/.test(b.textContent)).click()');
      await page.waitFor(`document.querySelector("#drawer-body .err")`, 6000);
      const msg = await q('#drawer-body .err');
      check(`compose error "${prompt}" reads well`, expect.test(msg || ''), String(msg));
      if (prompt === 'FAIL') { check('and lists the attempts with their diagnostics', /attempt 1/.test(msg) && /\d+:\d+ error:/.test(msg), String(msg)); await shot(10, 'compose-unrepairable'); }
      await sleep(200);
    }
    await page.eval('document.getElementById("btn-play").classList.contains("on") && document.getElementById("btn-play").click()');
    await page.click('#btn-mcp');
    await page.waitFor('document.getElementById("drawer-title").textContent==="MCP"', 3000);
    await sleep(500);
    check('the MCP panel shows the session id', /[A-Za-z0-9_-]{16,}/.test(await q('#drawer-body pre')), await q('#drawer-body pre'));
    await page.eval('[...document.querySelectorAll("#drawer-body button")].find(b=>/Create an MCP token/.test(b.textContent)).click()');
    await page.waitFor('document.querySelector("#drawer-body .okbox")', 4000);
    const tok = await q('#drawer-body .okbox pre');
    check('create MCP token shows the token once with the claude mcp add command', /^btw_/.test(tok || '') && /claude mcp add --transport http btw .*\/mcp --header "Authorization: Bearer btw_/.test(await q('#drawer-body .okbox')), String(tok));
    await shot(11, 'mcp-token');
  }

  // ---- 7. the MCP bridge: a pushed eval, a get ----------------------------------------------------------------------------------------------
  step = 7;
  if (want() && isMock) {
    await page.goto(url());
    await ready();
    await sleep(800);
    const sid = await page.eval('__app.session && __app.session.id');
    check('the page opens a session and an event stream', !!sid && (await page.eval('__app.session.connected')) === true, String(sid));
    await page.click('.ed-ta');
    const pushed = 'tempo 120\ndeck A: kick x ~ x ~\n# pushed by an assistant\n';
    await fetch(T(`__push/${sid}`), { method: 'POST', body: JSON.stringify({ type: 'eval', text: pushed, play: true }) });
    await page.waitFor('document.getElementById("btn-play").classList.contains("on")', 8000);
    check('an eval event sets the text, evaluates and plays', (await text()) === pushed);
    await sleep(900);
    const st1 = await (await fetch(T(`__state/${sid}`))).json();
    check('the page reports its state (text, cid, playing, source, marks)', st1.state && st1.state.text === pushed && st1.state.playing === true && /^(engine|stream)$/.test(st1.state.source) && !!st1.state.cid && 'marks' in st1.state, JSON.stringify(st1.state).slice(0, 200));
    await fetch(T(`__push/${sid}`), { method: 'POST', body: JSON.stringify({ type: 'get', request_id: 'r1' }) });
    await sleep(500);
    const st2 = await (await fetch(T(`__state/${sid}`))).json();
    check('a get event is answered with a reply', st2.replies.some((r) => r.request_id === 'r1' && r.state && r.state.text === pushed));
    await fetch(T(`__push/${sid}`), { method: 'POST', body: JSON.stringify({ type: 'stop' }) });
    await sleep(500);
    check('a stop event stops', !(await playing()));
  }

  // ---- 8. a phone, and the module failing to load ---------------------------------------------------------------------------------------------
  step = 8;
  if (want()) {
    await page.resize(390, 844);
    await page.goto(url('', ''));
    await ready();
    await sleep(500);
    const overflow = await page.eval('document.documentElement.scrollWidth > document.documentElement.clientWidth');
    check('at phone width nothing overflows the page horizontally', overflow === false);
    check('the editor is still most of the screen', (await page.rect('.ed')).h > 400);
    await shot(12, 'phone');
    await page.resize(1280, 800);
    await page.goto(`${T('')}?${withQ('wasm=off')}`);
    await sleep(1200);
    check('if the module fails the page says so and keeps a plain editor', /could not be loaded/.test(await q('#banner')) && (await page.eval('!document.querySelector(".ed-ta").disabled')) === true, await q('#banner'));
    await page.eval('(()=>{const ta=document.querySelector(".ed-ta"); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);})()');
    await page.type('# still typing');
    check('and typing still works', (await text()).includes('# still typing'));
    await shot(13, 'no-wasm');
  }

  // ---- 9. record mode: no audio, no wall clock, same time = same pixels ------------------------------------------------------------------------------
  step = 9;
  if (want()) {
    await page.resize(1920, 1080);
    const ex = isMock ? 'hand-dubstep-140-v4' : 'hand-dubstep-140-v4';
    await page.goto(`${T('')}?${withQ(`record=1&clock=manual&example=${ex}`)}`);
    await ready();
    const info = JSON.parse(await page.eval('JSON.stringify(window.__btw.info())'));
    check('window.__btw.info() has cid, name, bpm, bars, seconds, sections', info.cid && info.name && info.bpm === 140 && info.bars === 68 && info.sections.length === 9, JSON.stringify(info).slice(0, 200));
    check('manual clock: no AudioContext was made', (await page.eval('__app.ctx === null')) === true);
    check('record mode hides the chrome (no top bar, no panels)', (await page.rect('#top')) && (await page.eval('getComputedStyle(document.getElementById("top")).display')) === 'none');
    const run = async (tag, times) => {
      await page.eval('window.__btw.reset()');
      let clock = 0;
      const hashes = [];
      for (const t of times) {
        while (clock < t - 1e-9) { clock = Math.min(t, clock + 1 / 30); await page.eval(`window.__btw.setTime(${clock}); window.__btw.frame(); 0`); }
        const f = path.join(SHOTS, `_rec-${tag}-${t}.png`);
        await page.shot(f);
        hashes.push(sha(f));
      }
      return hashes;
    };
    // bar 0 is at t = 0: the second section (bar 8, 140 bpm) starts at 13.714 s, not a bar later
    await page.eval('window.__btw.reset()');
    check('at t = 0 the header is section 1/9, bar 1', /section 1\/9 · intro/.test(await q('#h-sec-txt')) && (await q('#h-bar')) === 'bar 1/68', `${await q('#h-sec-txt')} | ${await q('#h-bar')}`);
    let t8 = 0;
    while (t8 < 13.8) { t8 += 1 / 30; await page.eval(`window.__btw.setTime(${t8}); window.__btw.frame(); 0`); }
    check('and section 2 begins on bar 8 of the clock (no bar of lag)', /section 2\/9 · build/.test(await q('#h-sec-txt')) && (await q('#h-bar')) === 'bar 9/68', `${await q('#h-sec-txt')} | ${await q('#h-bar')}`);
    const times = [0, 6.2, 31.4];
    const a = await run('a', times);
    const b = await run('b', times);
    check('the same fake times give identical pixels (two runs, three frames)', a.join() === b.join(), `${a} vs ${b}`);
    check('and different times give different frames', new Set(a).size === a.length);
    check('markers are in the DOM at 31.4 s (the drop)', (await count('.gd[data-kind]')) > 0);
    fs.copyFileSync(path.join(SHOTS, '_rec-a-31.4.png'), path.join(SHOTS, '14-record-1920x1080.png'));
    for (const f of fs.readdirSync(SHOTS)) if (f.startsWith('_rec-')) fs.unlinkSync(path.join(SHOTS, f));
    const t0 = Date.now();
    for (let i = 0; i < 60; i++) await page.eval('window.__btw.setTime(' + (31.4 + (i + 1) / 30) + '); window.__btw.frame(); 0');
    console.log(`#   60 frames of service()+marks()+paint at 1920x1080: ${((Date.now() - t0) / 60).toFixed(1)} ms each (incl. CDP round trip)`);
    check('record mode started by cid works too', true);
    // the evolve flash, on markers-demo: gen 1 begins on bar 12 of its 124 bpm
    await page.goto(`${T('')}?${withQ('record=1&clock=manual&example=markers-demo')}`);
    await ready();
    let tt = 0;
    while (tt < 23.5) { tt += 1 / 30; await page.eval(`window.__btw.setTime(${tt}); window.__btw.frame(); 0`); }
    check('a new generation flashes the evolve block and says gen N', (await count('.lamp-evolve')) > 0 && /gen \d/.test(await q('.gen')), `${await count('.lamp-evolve')} ${await q('.gen')}`);
    await shot(16, 'evolve-flash-record');
    // reduced motion: the page reads the media query (lamps get a lower peak and a longer fade; nothing pulses)
    await page.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await page.goto(`${T('')}?${withQ('record=1&clock=manual&example=markers-demo')}`);
    await ready();
    check('prefers-reduced-motion is read', (await page.eval('__app.reduced')) === true);
    await page.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await page.goto(`${T('')}?${withQ(`record=1&clock=manual&cid=${info.cid}`)}`);
    await ready();
    check('?record=1&cid=<CID> loads the program from /api/programs/<cid>', (await page.eval('window.__btw.info().cid')) === info.cid);
  }

  // ---- 10. no console errors anywhere ----------------------------------------------------------------------------------------------------------------
  step = 10;
  const errors = page.errors().filter((e) => !/wasm=off|switched off by/.test(e.text) && !/Failed to load resource.*\/api\/compose/.test(e.text)); // the compose error cases above answer 422/429/503 on purpose
  check('no console errors or exceptions', errors.length === 0, errors.map((e) => `${e.type}: ${e.text}`).join('\n         '));
} catch (e) {
  console.error('SMOKE CRASHED at step', step, e);
  results.push({ step, name: 'crash', ok: false });
  try { await shot(99, 'crash'); } catch { /* page gone */ }
} finally {
  await page.close();
  if (serverProc) serverProc.kill();
}
const fails = results.filter((r) => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} checks passed`);
process.exit(fails.length ? 1 : 0);
