#!/usr/bin/env node
// The browser smoke run of btwsite/test/smoke.md: headless Chrome (a tiny CDP client, no npm) against a server.
//
//   node btwsite/test/smoke.mjs                       start the mock server (real wasm if built), run everything
//   node btwsite/test/smoke.mjs --server http://127.0.0.1:18097   run against a real server instead (compose and
//                                                     session steps that need the mock's test routes are skipped)
//   node btwsite/test/smoke.mjs --only 3,5            run only steps whose number is listed
//   --mock-wasm                                       the mock server and the page both use the JS mock (?mock=1)
//   --strict-csp                                      the mock server sends the tightest Content-Security-Policy the page can live
//                                                     with (mock-server.mjs STRICT_CSP): a violation is a console error, so the whole
//                                                     run is the proof that the policy is enough
//
// Screenshots go to btwsite/test/shots/. Exit code 1 if any check failed or the page logged a console error.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(here, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true; };
const ONLY = arg('only', null) ? String(arg('only')).split(',').map(Number) : null;
const MOCKWASM = arg('mock-wasm', false) === true;
const STRICT = arg('strict-csp', false) === true;
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
  serverProc = spawn('node', [path.join(here, 'mock-server.mjs'), '--port', String(port), ...(MOCKWASM ? ['--mock-wasm'] : []), ...(STRICT ? ['--csp', 'strict'] : [])], { stdio: ['ignore', 'ignore', 'inherit'] });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* starting */ } await sleep(100); }
}
console.log(`# server ${base} (${isMock ? 'mock' : 'real'})${MOCKWASM ? ', JS-mock wasm' : ''}${STRICT && isMock ? ', strict CSP' : ''}`);

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
    // a one-click "did you mean": Apply replaces the span in one undoable edit, re-checks, and Undo brings the text back
    await setText('tempp 120\ndeck A: kick x ~ x ~\n');
    await sleep(500);
    if ((await q('#pr-sum-txt')) !== 'no problems') {
      await page.click('#pr-sum');
      await sleep(100);
      const label = await page.eval('(document.querySelector(".pr-apply")||{}).getAttribute ? document.querySelector(".pr-apply").getAttribute("aria-label") : ""');
      check('a misspelt keyword gets an Apply button with an aria-label naming the change', /tempp.*tempo/.test(label || ''), String(label));
      await page.eval('document.querySelector(".pr-apply").focus()');
      await page.eval('document.querySelector(".pr-apply").click()');
      await sleep(500);
      check('Apply fixes the text and the re-check is clean', (await page.eval('__app.editor.text')).startsWith('tempo 120') && (await q('#pr-sum-txt')) === 'no problems');
      await page.eval('document.querySelector(".ed-ta").focus(); document.execCommand("undo")');
      await sleep(500);
      check('Undo restores the misspelt text', (await page.eval('__app.editor.text')).startsWith('tempp 120'));
    } else check('a misspelt keyword is reported', false, 'no problems');
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
      // a line the engine cannot play is said beside the problems, not hidden under "no problems" (test/parity)
      await page.eval('(()=>{const ta=document.querySelector(".ed-ta"); ta.focus(); ta.value=ta.value.replace(/\\n*$/, "\\nmaster: delay 0.3\\n"); ta.dispatchEvent(new Event("input",{bubbles:true}));})()');
      await page.key('Enter', { meta: true });
      const noted = await page.waitFor('(()=>{const t=document.getElementById("pr-sum-txt").textContent; return /not played here/.test(t) ? t : null})()', 8000).catch(() => null);
      check('a dropped insert (master delay) shows as "not played here" with the problems', !!noted && (await page.eval('[...document.querySelectorAll("#pr-list .pr-note")].some(e => /delay/.test(e.textContent))')) === true, `${await q('#pr-sum-txt')}`);
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
    await setText('#! btw 1\n#! name: tidy\ntempo   126  # speed\nkey  am\n\n\ndeck A:   kick x ~ x ~   |   snare ~ x ~ x\n');
    await sleep(400);
    await page.click('#btn-fmt');
    await sleep(300);
    const formatted = '#! btw 1\n#! name: tidy\ntempo 126  # speed\nkey am\n\ndeck A: kick x ~ x ~ | snare ~ x ~ x\n';
    check('fmt puts the formatted text in the editor: canonical lines, the header, the comment and one blank line kept', (await text()) === formatted, JSON.stringify(await text()));
    await page.eval('document.querySelector(".ed-ta").focus(); document.execCommand("undo")');
    await sleep(200);
    check('and Cmd+Z brings the old text back (the browser keeps its undo stack)', (await text()).includes('tempo   126  # speed'), JSON.stringify(await text()));
    await page.click('#btn-fmt');
    await sleep(200);
    check('fmt again gives the same text', (await text()) === formatted, JSON.stringify(await text()));
    await page.eval('document.getElementById("toasts").replaceChildren(); 0');
    await page.click('#btn-fmt');
    await sleep(200);
    check('and then says it is already in canonical form: what the server sends is what this button makes', (await text()) === formatted && /Already in canonical form/.test(await q('#toasts')), await q('#toasts'));
    await page.click('#btn-share');
    await page.waitFor('document.querySelector(".pop input")', 4000);
    const link = await page.eval('document.querySelector(".pop input").value');
    check('share shows a self-sealing link', /^https?:\/\/[^/]+\/#z[1-9A-HJ-NP-Za-km-z]{20,}\.[A-Za-z0-9_-]+$/.test(link), link.slice(0, 80));
    check('and puts it in the address bar', (await page.eval('location.hash')).startsWith('#z'));
    check('and says how many characters', /\d+ characters/.test(await page.eval('document.querySelector(".pop").textContent')));
    check('and offers the social /c/ form', (await page.eval('[...document.querySelectorAll(".pop input")].some(i=>/\\/c\\/z/.test(i.value))')) === true);
    check('and says in one line what rights it has, linking /authorship', (await page.eval('!!document.querySelector(".pop p.rights a[href=\\"/authorship\\"]")')) === true);
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
  if (want()) {
    await page.goto(url());
    await ready();
    await page.click('#btn-compose');
    await page.waitFor('!document.getElementById("drawer").hidden', 3000);
    check('signed out, the compose button says it needs a sign-in', (await page.eval('document.getElementById("btn-compose").title')) === 'Compose with a model (sign in)');
    check('compose is visible but disabled until signed in, with the reason', (await page.eval('document.querySelector("#drawer-body fieldset").disabled')) === true && /signed-in|sign in/i.test(await q('#drawer-body')));
    await shot(7, 'compose-signed-out');
    await page.click('#btn-user');
    await page.waitFor('document.getElementById("drawer-title").textContent==="Sign in"', 3000);
    await shot(8, 'signin');
    await page.eval('[...document.querySelectorAll("#drawer-body button")].find(b=>/browser key/i.test(b.textContent)).click()');
    await page.waitFor('__app.user', 6000);
    check('sign in with a browser-local Ed25519 key', /ed25519:/.test(await page.eval('__app.user.id')));
    check('the compose button stops asking to sign in once there is a session', (await page.eval('document.getElementById("btn-compose").title')) === 'Compose with a model');
    check('the key is kept in localStorage btw-ed25519-v1', (await page.eval('!!localStorage.getItem("btw-ed25519-v1")')) === true);
    const keyState = JSON.parse(await page.eval(`(async () => {
      const ls = localStorage.getItem('btw-ed25519-v1');
      const rec = await new Promise((res, rej) => { const r = indexedDB.open('btw-keys', 1); r.onsuccess = () => { const g = r.result.transaction('keys').objectStore('keys').get('ed25519'); g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error); }; r.onerror = () => rej(r.error); });
      let exp = 'exported';
      try { await crypto.subtle.exportKey('jwk', rec.privateKey); } catch (e) { exp = e.name; }
      return JSON.stringify({ ls, hasRec: !!rec, extractable: rec && rec.privateKey.extractable, type: rec && rec.privateKey.type, pub: rec && rec.publicKeyHex, exp });
    })()`, true));
    check('the private key is a non-extractable CryptoKey in IndexedDB: a script can use it to sign and cannot read it out', keyState.hasRec && keyState.extractable === false && keyState.type === 'private' && keyState.exp !== 'exported', JSON.stringify(keyState));
    check('and localStorage holds only its public half, no JWK', Object.keys(JSON.parse(keyState.ls)).join() === 'publicKeyHex' && JSON.parse(keyState.ls).publicKeyHex === keyState.pub && !/"d"|privateKey/.test(keyState.ls), keyState.ls);
    await page.click('#btn-compose');
    await page.waitFor('!document.querySelector("#drawer-body fieldset").disabled', 3000);
    check('compose is enabled once signed in', true);
    await page.eval('(()=>{const t=document.getElementById("c-prompt"); t.focus();})()');
    await page.type('dark techno with an acid line');
    await page.eval('[...document.querySelectorAll("#drawer-body button")].find(b=>b.textContent==="Compose").click()');
    await page.waitFor('document.querySelector("#drawer-body .okbox")', 10000);
    await page.waitFor('document.getElementById("btn-play").classList.contains("on")', 8000);
    check('compose puts the program in the editor and starts the stream at once', (await page.eval('__app.driver.kind')) === 'stream' && (isMock ? /composed from/.test(await text()) : /section/.test(await text())), await page.eval('__app.driver.kind'));
    await shot(9, 'compose-done');
    check('fork-current is possible now that the program is stored', (await page.eval('!document.getElementById("c-fork").disabled')) === true);
    if (isMock) for (const [prompt, expect] of [['FAIL', /unrepairable: see attempts/], ['LIMIT', /rate limited, try again in 38 s/], ['NOKEY', /compose is not configured/]]) {
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
    check('create MCP token shows the token once with the claude mcp add command', /^btw_/.test(tok || '') && /claude mcp add --transport http beatscript .*\/mcp --header "Authorization: Bearer btw_/.test(await q('#drawer-body .okbox')), String(tok));
    await shot(11, 'mcp-token');
    await page.eval('__app.emit("session"); __app.emit("user"); 0'); // a reconnect or a sign-in event re-renders the open panel
    await sleep(150);
    check('a token that is shown stays while the panel is re-rendered (the page\'s reconnects must not eat it)', (await q('#drawer-body .okbox pre')) === tok, String(await q('#drawer-body .okbox pre')));
    await page.click('#drawer-close');
    await sleep(100);
    check('closing the panel removes the token from the page', !(await page.eval('document.documentElement.outerHTML')).includes(tok));
    check('the token is nowhere else: not the address bar, the title, localStorage, sessionStorage or the console', !(await page.eval('[location.href, document.title, JSON.stringify(localStorage), JSON.stringify(sessionStorage)].join("\\n")')).includes(tok) && !page.logs.some((l) => l.text.includes(tok)));
    await page.click('#btn-mcp');
    await page.waitFor('document.getElementById("drawer-title").textContent==="MCP"', 3000);
    check('and opening the panel again does not show it', !(await q('#drawer-body')).includes(tok));
  }

  // ---- 7. the MCP bridge: a pushed eval, a get ----------------------------------------------------------------------------------------------
  step = 7;
  if (want() && !isMock) {
    // the real bridge: a token from the page's own MCP panel, then JSON-RPC to /mcp drives this tab
    await page.goto(url());
    await ready();
    await sleep(600);
    if (!(await page.eval('!!__app.user'))) { // the cookie of step 6 may still be there
      await page.click('#btn-user');
      await page.waitFor('document.getElementById("drawer-title").textContent==="Sign in"', 3000);
      await page.eval('[...document.querySelectorAll("#drawer-body button")].find(b=>/browser key/i.test(b.textContent)).click()');
      await page.waitFor('__app.user', 8000);
    }
    await sleep(800);
    await page.click('#btn-mcp');
    await page.waitFor('document.getElementById("drawer-title").textContent==="MCP"', 3000);
    await page.eval('[...document.querySelectorAll("#drawer-body button")].find(b=>/Create an MCP token/.test(b.textContent)).click()');
    await page.waitFor('document.querySelector("#drawer-body .okbox")', 5000);
    const token = await q('#drawer-body .okbox pre');
    const mcp = async (name, args, id = 1) => {
      const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) });
      const j = JSON.parse((await r.text()).replace(/^event:.*\ndata: /s, ''));
      return { isError: !!j.result.isError, body: (() => { try { return JSON.parse(j.result.content[0].text); } catch { return j.result.content[0].text; } })() };
    };
    // loose text, as an assistant might write it: the server formats it on the way in (the canonical lines, the comment kept)
    const pushed = 'tempo   120   # pushed over MCP\ndeck A:  kick x ~ x ~\n';
    const shown = 'tempo 120  # pushed over MCP\ndeck A: kick x ~ x ~\n';
    const ev = await mcp('eval', { text: pushed, play: true });
    check('MCP eval reaches this tab: text set, evaluated, playing', !ev.isError, JSON.stringify(ev.body).slice(0, 200));
    await page.waitFor('document.getElementById("btn-play").classList.contains("on")', 10000);
    check('the page took the program the assistant sent, formatted on the way in', (await text()) === shown, JSON.stringify(await text()));
    await sleep(900);
    const g = await mcp('get', {}, 2);
    check('MCP get reports the page state (text, cid, playing, source)', !g.isError && g.body && g.body.text === shown && g.body.playing === true && !!g.body.cid, JSON.stringify(g.body).slice(0, 200));
    const st = await mcp('stop', {}, 3);
    await sleep(500);
    check('MCP stop stops it', !st.isError && !(await playing()));
  }
  if (want() && isMock) {
    await page.goto(url());
    await ready();
    await sleep(800);
    const sid = await page.eval('__app.session && __app.session.id');
    check('the page opens a session and an event stream', !!sid && (await page.eval('__app.session.connected')) === true, String(sid));
    await page.click('.ed-ta');
    // (the server formats a program before it sends it: its canonical lines with the header and comments kept)
    const pushed = '#! btw 1\n#! name: pushed\ntempo 120\n# pushed by an assistant\ndeck A: kick x ~ x ~  # four\n';
    await fetch(T(`__push/${sid}`), { method: 'POST', body: JSON.stringify({ type: 'eval', text: pushed, play: true }) });
    await page.waitFor('document.getElementById("btn-play").classList.contains("on")', 8000);
    check('an eval event sets the text, evaluates and plays', (await text()) === pushed);
    await page.eval('document.getElementById("toasts").replaceChildren(); document.getElementById("btn-fmt").click(); 0');
    await sleep(300);
    check('the text that arrived is not reformatted by the page, and fmt finds nothing to change in it', (await text()) === pushed && /Already in canonical form/.test(await q('#toasts')), `${JSON.stringify(await text())} ${await q('#toasts')}`);
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

  // ---- 11. hostile input and secrets (the SEC-3 review: what a link, the server, an assistant or a script can hand the page) ----------------------------
  step = 11;
  if (want()) {
    const hookFetch = () => page.eval(`(() => { window.__reqs = []; window.__rej = []; if (!window.__fetchHooked) { window.__fetchHooked = true; const of = window.fetch; window.fetch = function (u, i) { window.__reqs.push(((i && i.method) || 'GET') + ' ' + String(u instanceof Request ? u.url : u)); return of.apply(this, arguments); }; addEventListener('unhandledrejection', (e) => window.__rej.push(String((e.reason && e.reason.message) || e.reason))); } })()`);
    // the requests that matter here: anything that names a program, an example, the render, /api/info or another origin
    const reqs = async () => (await page.eval('window.__reqs')).filter((r) => /\/examples\/|\/api\/programs\/|\/api\/render\/|\/api\/info|evil\.example/.test(r));
    const errs0 = () => page.errors().length;
    const evolveProgram = (n, gens = 256) => {
      let t = 'tempo 140\nkey am\n';
      for (let i = 0; i < n; i++) t += `section s${i} ${gens} bars {\n  deck A: kick x ~ x ~ | hihat x*8 vel=50..80\n  deck B: melody a4 ~ c5 ~ e5 ~ c5 ~ a4 ~ c5 ~ e5 ~ c5 ~ | bass a2 ~ e2 ~ a2 ~ e2 ~\n  evolve every 1 bars {\n    melody: rotate <0 2 4 1 3> | transpose <0 3 7 5 2 9 11>\n    hihat: thin 0.1 seed=${i}\n    bass: invert when gen % 2 == 1\n    stop when gen == ${gens - 1}\n  }\n}\n`;
      return `${t}arrange ${Array.from({ length: n }, (_, i) => `s${i}`).join(' ')}\n`;
    };

    // a link somebody mangled (#%) must not stop the page from starting
    await fresh(url('', '#%'));
    await ready();
    await sleep(900);
    check('a mangled link (#%) does not stop the page from starting: module up, frame loop and session running', (await page.eval('__app.wasmOk')) === true && (await page.eval('!!__app.session')) === true && !/could not start/.test(await q('#toasts')), `${await q('#toasts')}`);
    check('and the page says it is not a link it can open', /Refused/.test(await q('#banner')), await q('#banner'));
    await hookFetch();
    const e0 = errs0();
    await page.eval(`location.hash = '#%E0%A4%A'`);
    await sleep(600);
    check('a link that turns mangled while the page is open is refused in words, with no unhandled rejection', /Refused/.test(await q('#banner')) && (await page.eval('window.__rej')).length === 0 && errs0() === e0, JSON.stringify(await page.eval('window.__rej')));

    // a link of 33 KB that is a megabyte of program (minutes of checking in the page's one thread): refused before the module is asked
    {
      const cid = 'z4EBG9jB3vwMeCJNSp8WJLWDRM7ADEWxi23HyNSij5cHBL94r7v';
      const big = evolveProgram(3000);
      const packed = zlib.deflateRawSync(Buffer.from(big), { level: 9 }).toString('base64url');
      const t0 = Date.now();
      await fresh(url('', `#${cid}.${packed}`));
      await ready();
      const dt = Date.now() - t0;
      check(`a ${(packed.length / 1000).toFixed(0)} KB link that inflates to ${(big.length / 1048576).toFixed(2)} MiB of program is refused (in ${dt} ms, not minutes)`, /Refused.*larger than 32,768 bytes/.test(await q('#banner')) && dt < 20000, `${dt} ms ${await q('#banner')}`);
      check('and nothing of it was loaded into the editor', !(await text()).includes('section s2999') && (await page.eval('__app.editor.text.length')) < 40000);
      const bomb = zlib.deflateRawSync(Buffer.alloc(64 << 20, 'a'), { level: 9 }).toString('base64url');
      await fresh(url('', `#${cid}.${bomb}`));
      await ready();
      check('a deflate bomb (64 MiB of "a" in 65 KB) is refused too', /Refused/.test(await q('#banner')), await q('#banner'));
    }

    // hostile text in a program, a name and an assistant's push is text, never markup
    await page.goto(url());
    await ready();
    await hookFetch();
    const evil = '#! name: <img src=x onerror="window.__pwn=1"> ‮\n# </pre><script>window.__pwn=2</script>\n# "><svg onload=window.__pwn=3>\ntempo 120\ndeck A: kick x ~ x ~\n';
    const scripts0 = await count('script');
    await page.eval(`__app.setProgram(${JSON.stringify(evil)}, { name: '<b>bold</b>\\u202e\\u0000x' })`);
    await sleep(200);
    const dom = JSON.parse(await page.eval(`JSON.stringify({
      kids: [...document.querySelectorAll('.ly-hl *')].filter((e) => !(e.tagName === 'SPAN' && /^c-[a-z]+$/.test(e.className))).map((e) => e.outerHTML.slice(0, 60)),
      hl: document.querySelector('.ly-hl').textContent, pwn: window.__pwn, handlers: document.querySelectorAll('[onerror],[onload],[onclick],[onmouseover]').length,
      imgs: document.querySelectorAll('img, iframe, object, embed').length, title: document.title, name: document.getElementById('h-name').textContent })`));
    check('hostile program text is shown as text: the highlighted layer holds only the page\'s own spans, and its text is the program\'s', dom.kids.length === 0 && dom.hl.replace(/ $/, '') === evil && dom.pwn === undefined && dom.handlers === 0 && dom.imgs === 0 && (await count('script')) === scripts0, JSON.stringify(dom).slice(0, 300));
    check('a hostile name is cleaned (no marks that reverse text, no control characters) and shown as text in the title and the header', dom.title === '<b>bold</b> x · BeatScript' && dom.name === '<b>bold</b> x', `${dom.title} | ${dom.name}`);

    // pushed events: only strings of the right shape do anything, and nothing makes the page fetch a URL of the pusher's choosing
    const before = await text();
    const href0 = await page.eval('location.href');
    const push = (type, o) => page.eval(`__app.session.onEvent(${JSON.stringify(type)}, ${JSON.stringify(JSON.stringify(o))}).then(() => 0)`, true);
    await push('eval', { text: 'x'.repeat(100000) });
    check('a pushed program of 100,000 characters is refused (an error, not a frozen editor)', (await text()) === before && /characters; the page loads programs of at most/.test(await q('#toasts')), await q('#toasts'));
    await push('load', { extra: { example: '../../api/info' } });
    await push('load', { extra: { example: '..%2f..%2fapi%2finfo' } });
    await push('load', { cid: 'z/../../api/info' });
    await push('load', { cid: '../../api/info' });
    await push('load', { extra: { url: 'javascript:alert(1)' } });
    await push('load', { extra: { url: 'https://evil.example/#z4EBG9jB3vwMeCJNSp8WJLWDRM7ADEWxi23HyNSij5cHBL94r7v' } });
    await push('eval', { text: 5, play: 'yes' });
    await push('eval', 'text');
    await push('get', { request_id: { a: 1 } });
    const rq = await reqs();
    check('hostile load events (path tricks, a javascript: URL, another origin) make the page fetch nothing', rq.length === 0, JSON.stringify(rq));
    check('and the page did not navigate, play or change its text', (await page.eval('location.href')) === href0 && !(await playing()) && (await text()) === before);
    check('an example\'s name and a CID are refused in words that the page can show', /is not an example name/.test(await q('#toasts')) && /is not a CID/.test(await q('#toasts')), await q('#toasts'));

    // a private program stays in the page
    const pub = 'tempo 120\ndeck A: kick x ~ x ~\n# a public tune of mine\n';
    const priv = `#! visibility: private\n${pub}`;
    await page.eval(`__app.setProgram(${JSON.stringify(priv)}, { name: 'mine' })`);
    await page.eval('window.__reqs.length = 0; __app.setSourcePref("stream"); 0');
    await page.eval('__app.play("eval").then(() => 0)', true);
    await sleep(300);
    const rp = await reqs();
    check('a program marked #! visibility: private is not sent to the server to stream: no PUT, no render request, and the page says why', !rp.some((r) => /\/api\/(programs|render)\//.test(r)) && !(await playing()) && /private/.test(await q('#toasts')), JSON.stringify(rp));
    const rs = JSON.parse(await page.eval('JSON.stringify(__app.reportState())'));
    check('and the state the page reports to an assistant carries no text, CID, section, marks or diagnostics for it', rs.withheld === true && rs.text === '' && rs.cid === '' && rs.section === '' && rs.marks === null && rs.diagnostics.length === 0, JSON.stringify(rs).slice(0, 200));
    await page.eval('document.getElementById("toasts").replaceChildren(); document.getElementById("btn-share").click(); 0');
    await sleep(300);
    check('and there is no share link for it (a link carries the text, and its social form is carded by the server)', (await count('.pop')) === 0 && /no share link/.test(await q('#toasts')), await q('#toasts'));
    await page.eval(`__app.setProgram(${JSON.stringify(pub)}, { name: 'mine' })`);
    const rs2 = JSON.parse(await page.eval('JSON.stringify(__app.reportState())'));
    check('a public program is reported as before', rs2.withheld === false && rs2.text === pub && !!rs2.cid, JSON.stringify(rs2).slice(0, 200));
    // streaming a public program the server does not have says that the server keeps it, once
    await page.eval('window.__reqs.length = 0; document.getElementById("toasts").replaceChildren(); 0');
    await page.eval('__app.play("eval").then(() => 0)', true);
    await page.waitFor('document.getElementById("btn-play").classList.contains("on")', 8000);
    check('streaming a program the server does not have stores it and says so (public, CC0, found by its CID)', (await reqs()).some((r) => /^PUT \/api\/programs\/z/.test(r)) && /stored publicly as CC0-1\.0/.test(await q('#toasts')), await q('#toasts'));
    await page.eval('__app.stop(); __app.setSourcePref("stream"); 0');

    // the key and the account
    {
      await page.goto(url());
      await ready();
      if (!(await page.eval('!!__app.user'))) {
        await page.click('#btn-user');
        await page.waitFor('document.getElementById("drawer-title").textContent==="Sign in"', 3000);
        await page.eval('[...document.querySelectorAll("#drawer-body button")].find(b=>/browser key/i.test(b.textContent)).click()');
        await page.waitFor('__app.user', 6000);
      }
      await page.goto(url()); // a reload: the cookie and the key are all there is
      await ready();
      const addr = await page.eval('__app.user && __app.user.address');
      const again = await page.eval(`import('/js/auth.js').then((a) => a.signEd25519('x')).then((s) => s.address)`, true);
      check('after a reload the same browser key signs (the account survives)', again === addr, `${again} vs ${addr}`);
      await page.click('#btn-user');
      await page.waitFor('document.getElementById("drawer-title").textContent==="Account"', 3000);
      await page.eval('[...document.querySelectorAll("#drawer-body button")].find(b=>/Sign out/.test(b.textContent)).click()');
      await page.waitFor('!__app.user && document.getElementById("drawer-title").textContent==="Sign in"', 4000);
      check('signing out ends the session but keeps the key (it is the account)', (await page.eval('!!localStorage.getItem("btw-ed25519-v1")')) === true);
      await page.eval('[...document.querySelectorAll("#drawer-body button")].find(b=>/Forget this key/.test(b.textContent)).click()');
      await sleep(400);
      const gone = await page.eval(`(async () => new Promise((res) => { const r = indexedDB.open('btw-keys', 1); r.onsuccess = () => { const g = r.result.transaction('keys').objectStore('keys').get('ed25519'); g.onsuccess = () => res(g.result === undefined); }; r.onerror = () => res(true); }))()`, true);
      check('"Forget this key" removes it everywhere: localStorage and IndexedDB', (await page.eval('localStorage.getItem("btw-ed25519-v1")')) === null && gone === true);
      // a challenge that is not this site's sign-in message is never signed
      const refused = await page.eval(`import('/js/auth.js').then((a) => a.signIn({ challenge: async () => ({ nonce: 'n', message: 'evil.example sign-in\\nnonce: n' }), login: async () => { window.__posted = true; return { user: {} }; } }, 'ed25519', { hosts: [location.host] })).then(() => 'signed', (e) => e.message)`, true);
      check('a sign-in challenge for another site is refused before anything signs it', /not for this site/.test(refused) && (await page.eval('window.__posted')) === undefined && (await page.eval('localStorage.getItem("btw-ed25519-v1")')) === null, refused);
    }

    // ?mock=1 is for this machine only
    {
      const port = new URL(base).port;
      const other = await launch({ width: 800, height: 600, args: ['--host-resolver-rules=MAP btw.example.test 127.0.0.1'] });
      try {
        await other.goto(`http://btw.example.test:${port}/?mock=1`);
        await other.eval('(async()=>{ for (let i=0;i<300 && !(window.__btw);i++) await new Promise(r=>setTimeout(r,50)); await window.__btw.ready; return true })()', true);
        check('?mock=1 does nothing on a host that is not this machine: the real module loads', (await other.eval('__app.mock')) === false && (await other.eval('__app.btw ? __app.btw.mock : null')) === false, `${await other.eval('__app.mock')}`);
      } finally { await other.close(); }
      await page.goto(`${T('')}?mock=1`);
      await ready();
      check('and on this machine it still switches the stand-in on (development)', (await page.eval('__app.mock')) === true && (await page.eval('__app.btw.mock')) === true);
    }

    // the policy the server sends, and what the page needs of it
    if (!isMock || STRICT) {
      const h = (await fetch(T(''))).headers;
      const csp = h.get('content-security-policy') || '';
      check('every page says: no framing (frame-ancestors none, X-Frame-Options DENY), no plugins, a fixed base', /frame-ancestors 'none'/.test(csp) && h.get('x-frame-options') === 'DENY' && /object-src 'none'/.test(csp) && /base-uri/.test(csp), csp);
      check('script-src has no unsafe-inline or unsafe-eval', /script-src [^;]*/.test(csp) && !/script-src[^;]*'unsafe-(inline|eval)'/.test(csp), csp);
    }

    // accessibility basics: every control has a name; Esc closes a panel and gives the focus back
    {
      await page.goto(url());
      await ready();
      const unnamed = async () => page.eval(`[...document.querySelectorAll('button, a[href], input, select, textarea')].filter((e) => !e.closest('[hidden]') && e.type !== 'hidden' && !(e.getAttribute('aria-label') || (e.getAttribute('aria-labelledby') && document.getElementById(e.getAttribute('aria-labelledby')) && document.getElementById(e.getAttribute('aria-labelledby')).textContent) || (e.labels && [...e.labels].map((l) => l.textContent).join('')) || e.textContent || e.title || '').trim()).map((e) => e.outerHTML.slice(0, 90))`);
      let bad = await unnamed();
      for (const b of ['btn-compose', 'btn-mcp', 'btn-user']) {
        await page.click(`#${b}`);
        await page.waitFor('!document.getElementById("drawer").hidden', 3000);
        bad = bad.concat(await unnamed());
        const inDrawer = await page.eval('document.getElementById("drawer").contains(document.activeElement)');
        await page.key('Escape');
        await sleep(150);
        check(`${b}: the panel takes the focus when it opens, and Esc closes it and returns the focus to its button`, inDrawer && (await page.eval('document.getElementById("drawer").hidden')) && (await page.eval('document.activeElement && document.activeElement.id')) === b, `${inDrawer} ${await page.eval('document.activeElement && document.activeElement.id')}`);
      }
      for (const b of ['btn-share', 'btn-open']) {
        await page.click(`#${b}`);
        await sleep(300);
        bad = bad.concat(await unnamed());
        await page.key('Escape');
        await sleep(150);
      }
      check('every button, link, input and select has an accessible name (page and each panel)', bad.length === 0, bad.join('\n         '));
    }
  }

  // ---- 12. number and range scrubbing (scrub.js over the module's btw/numberAt) -----------------------------------------------------------------------
  step = 12;
  if (want() && !MOCKWASM) {
    await fresh(url());
    await ready();
    await page.waitFor('!!__app.scrub', 8000).catch(() => null);
    if (!(await page.eval('!!__app.scrub'))) {
      check('the scrubber is on (a module with the language service)', false, 'no __app.scrub: build the module from djrust feat/btwls');
    } else {
      const PROG = 'tempo 124\nkey am\ndeck A: kick x ~ x ~ vel=90..110 | hihat x*8\ndeck B: melody c4 ~ e4 ~\nmaster: level 0.8\n';
      await setText(PROG);
      await sleep(400);
      const checks = () => page.eval('__app.btw.check(__app.editor.text).ok');
      const caretAt = (needle, k = 0) => page.eval(`(()=>{const ta=document.querySelector(".ed-ta"); const i=__app.editor.text.indexOf(${JSON.stringify(needle)})+${k}; ta.focus(); ta.setSelectionRange(i,i); return i})()`);
      const altKey = async (key, shift = false) => {
        const vk = { ArrowUp: 38, ArrowDown: 40, PageUp: 33, PageDown: 34 }[key];
        const modifiers = 1 | (shift ? 8 : 0);
        await page.cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: vk, modifiers });
        await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: vk, modifiers });
      };
      // keys: Alt+Up on the tempo is one step; Shift ten; only that literal changes, and it stays checkable
      await caretAt('124', 1);
      await altKey('ArrowUp');
      check('Alt+Up on a number moves it one step, and nothing else changes', (await text()) === PROG.replace('124', '125'), JSON.stringify(await text()));
      await altKey('ArrowUp', true);
      check('Shift+Alt+Up moves it ten', (await text()).startsWith('tempo 135\n'), (await text()).slice(0, 12));
      check('and the program still checks', (await checks()) === true);
      check('the new value is read out', /tempo \(BPM\) 135 bpm/.test(await q('.sc-live')), await q('.sc-live'));
      // a limit is a limit: the level cannot go past 1
      await caretAt('0.8', 1);
      for (let i = 0; i < 3; i++) await altKey('ArrowUp', true);
      check('a level stops at its maximum (1)', /master: level 1\n/.test(await text()), (await text()).split('\n')[4]);
      // a range end does not cross the other: vel=90..110 low end up by 30 stops at 110
      await caretAt('90..', 0);
      for (let i = 0; i < 3; i++) await altKey('ArrowUp', true);
      check('the low end of a range stops at the high end', /vel=110\.\.110/.test(await text()), (await text()).split('\n')[2]);
      // Alt+PageDown moves both ends
      await altKey('PageDown');
      check('Alt+PageDown moves both ends of the range', /vel=109\.\.109/.test(await text()), (await text()).split('\n')[2]);
      // a note moves through the key: c4 up one in A minor is d4
      await caretAt('c4', 1);
      await altKey('ArrowUp');
      check('a note moves by the key (c4 -> d4 in A minor)', /melody d4 ~ e4/.test(await text()), (await text()).split('\n')[3]);
      // Alt+drag on the tempo: one undo step, only that literal changed
      const before = await text();
      const pos = await page.eval(`(()=>{const ed=__app.editor; const t=ed.text; const i=t.indexOf("135")+1; const r=ed.code.getBoundingClientRect(); const s=t.lastIndexOf("\\n", i-1)+1; const p=ed.wrap.lines[0]; return {x: r.left + ed.metrics.padLeft + (i - s) * ed.metrics.charW + 2, y: r.top + p.top + ed.metrics.lineH / 2}})()`);
      await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y, modifiers: 1 });
      await page.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1, modifiers: 1 });
      for (let dx = 6; dx <= 30; dx += 6) await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x + dx, y: pos.y, button: 'left', buttons: 1, modifiers: 1 });
      const mid = await page.eval('[__app.editor.previewing, __app.editor.text.slice(0, 9), document.querySelector(".ed-ta").value.slice(0, 9)]');
      check('while dragging the editor previews the value and the textarea is untouched', mid[0] === true && mid[1] === 'tempo 140' && mid[2] === 'tempo 135', JSON.stringify(mid));
      await page.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x + 30, y: pos.y, button: 'left', clickCount: 1, modifiers: 1 });
      await sleep(100);
      const after = await text();
      check('Alt+drag right five steps: tempo 135 -> 140, only that literal changed', after === before.replace('tempo 135', 'tempo 140'), JSON.stringify(after.slice(0, 20)));
      check('and the program still checks', (await checks()) === true);
      await page.eval('document.querySelector(".ed-ta").focus(); document.execCommand("undo")');
      await sleep(50);
      check('one Undo puts the whole drag back', (await text()) === before, JSON.stringify((await text()).slice(0, 20)));
      // the handle shows on hover over a number
      await page.hover(pos.x, pos.y);
      await sleep(80);
      check('a handle shows beside a number under the pointer', (await page.eval('!document.querySelector(".sc-handle").hidden')) === true);
      await page.shot(path.join(SHOTS, '12-scrub-handle.png'));
      // the range popover: a click on the handle of a range
      await caretAt('vel=', 4);
      const hpos = await page.eval(`(()=>{const ed=__app.editor; const t=ed.text; const i=t.indexOf("vel=")+4; const r=ed.code.getBoundingClientRect(); const s=t.lastIndexOf("\\n", i-1)+1; const l=t.slice(0,i).split("\\n").length-1; const p=ed.wrap.lines[l]; return {x: r.left + ed.metrics.padLeft + (i - s) * ed.metrics.charW + 2, y: r.top + p.top + ed.metrics.lineH / 2}})()`);
      await page.hover(hpos.x, hpos.y);
      await sleep(80);
      await page.click('.sc-handle');
      await sleep(120);
      check('a click on the handle of a range opens a two-handle slider', (await page.eval('document.querySelectorAll(".sc-pop .sc-thumb[role=slider]").length')) === 2);
      await page.shot(path.join(SHOTS, '12-scrub-range.png'));
      await page.key('Escape');
    }
  }

  // ---- 13. the caret is where the text is drawn: the textarea and the highlight layer overlap on every row --------------
  // A click on a glyph as the highlight <pre> draws it must put the textarea's caret just before that glyph: on a short
  // line, and on the first and a later row of a line that soft-wraps. (btw.css once gave both layers `text-indent:
  // <hang> hanging each-line`; Chrome's <textarea> indented every row, the <pre> only the later ones, so the caret drew
  // 4ch right of the text.)
  step = 13;
  if (want()) {
    await fresh(url());
    await ready();
    const long = `deck A: kick x ~ x ~ | hihat x*8 ${Array.from({ length: 30 }, (_, i) => `# wrapped word ${i + 1}`).join(' ')}`;
    const prog = `tempo 120\n${long}\ndeck B: snare ~ x ~ x\n`;
    await page.eval(`(()=>{const ta=document.querySelector(".ed-ta"); ta.focus(); ta.value=${JSON.stringify(prog)}; ta.dispatchEvent(new Event("input",{bubbles:true})); ta.blur(); document.querySelector(".ed-code").scrollIntoView({block:"start"});})()`);
    await sleep(500);
    // where the <pre> draws the glyph at each text offset, relative to the textarea's box
    const glyphs = await page.eval(`(()=>{
      const pre=document.querySelector(".ly-hl"), ta=document.querySelector(".ed-ta"), t=ta.value;
      const nodes=[]; const w=document.createTreeWalker(pre, NodeFilter.SHOW_TEXT); let n, at=0;
      while((n=w.nextNode())){ nodes.push([n, at]); at+=n.data.length; }
      const rect=(k)=>{ for (const [nd, a] of nodes) if (k>=a && k<a+nd.data.length){ const r=document.createRange(); r.setStart(nd,k-a); r.setEnd(nd,k-a+1); const q=r.getClientRects()[0]; return q && {x:q.left, y:q.top, h:q.height}; } return null; };
      const tr=ta.getBoundingClientRect(); const L=t.indexOf("deck A"); const first=rect(L);
      const out={rows:0, picks:[]};
      const add=(name,k)=>{ const q=rect(k); if(q) out.picks.push({name, k, dx:q.x-tr.left+1.5, dy:q.y-tr.top+q.h/2}); };
      add("a short line", t.indexOf("deck B")+5);
      add("a wrapped line, first row", L+8);
      // the first glyph of the long line's second row, and one further along it
      for (let k=L+1;k<L+${long.length};k++){ const q=rect(k); if (q && q.y>first.y+first.h/2 && t[k]!==" "){ add("a wrapped line, a later row (its first glyph)", k); add("a wrapped line, a later row", k+6); break; } }
      const tops=new Set(); for (let k=L;k<L+${long.length};k++){ const q=rect(k); if(q) tops.add(Math.round(q.y)); } out.rows=tops.size;
      return out; })()`);
    check('the long line soft-wraps (the check has a later row to look at)', glyphs.rows >= 2 && glyphs.picks.length === 4, JSON.stringify(glyphs));
    for (const g of glyphs.picks) {
      await page.click('.ed-ta', { dx: g.dx, dy: g.dy });
      await sleep(60);
      const got = await page.eval('document.querySelector(".ed-ta").selectionStart');
      check(`a click on a glyph the highlight draws puts the caret there: ${g.name}`, got === g.k, `caret at ${got}, the glyph is at ${g.k} (${got - g.k} columns off)`);
    }
    await shot(13, 'caret-aligned');
  }

  // ---- 14. the gutter rows sit on the text lines --------------------------------------------------------------------------------------------------
  step = 14;
  if (want()) {
    const prog = `tempo 120\n${Array.from({ length: 59 }, (_, i) => `# line ${i + 2}`).join('\n')}\n`;
    // gutter row N's top and text line N's top (the glyph box of the line's first character, centred in its line box)
    const rowsVsText = () => page.eval(`(()=>{
      const pre=document.querySelector(".ly-hl"), t=document.querySelector(".ed-ta").value, rows=[...document.querySelectorAll(".ed-gutter .gl")];
      const lh=parseFloat(getComputedStyle(pre).lineHeight);
      const nodes=[]; const w=document.createTreeWalker(pre, NodeFilter.SHOW_TEXT); let n, at=0; while((n=w.nextNode())){ nodes.push([n, at]); at+=n.data.length; }
      const top=(k)=>{ for (const [nd, a] of nodes) if (k>=a && k<a+nd.data.length){ const r=document.createRange(); r.setStart(nd,k-a); r.setEnd(nd,k-a+1); const q=r.getClientRects()[0]; return q ? q.top + q.height/2 - lh/2 : null; } return null; };
      const starts=[0]; for (let i=0;i<t.length;i++) if (t[i]==="\\n") starts.push(i+1);
      return [1, 20, 50].map((L)=>({ L, gutter: rows[L-1] ? rows[L-1].getBoundingClientRect().top : null, text: top(starts[L-1]) })); })()`);
    const load = async () => {
      await page.eval(`(()=>{const ta=document.querySelector(".ed-ta"); ta.focus(); ta.value=${JSON.stringify(prog)}; ta.dispatchEvent(new Event("input",{bubbles:true})); ta.blur();})()`);
      await sleep(400);
    };
    const judge = (how, got) => {
      for (const g of got) check(`${how}: gutter row ${g.L} is on text line ${g.L} (within 1 px)`, g.gutter != null && g.text != null && Math.abs(g.gutter - g.text) <= 1, JSON.stringify(g));
    };
    await fresh(url());
    await ready();
    await load();
    judge('at 1280 px', await rowsVsText());
    // the case Matt saw: a page that loads under the 760 px breakpoint (--lh 20px) and is then widened (--lh 21px)
    await page.resize(700, 800);
    await fresh(url());
    await ready();
    await load();
    await page.resize(1280, 800);
    await page.eval('window.dispatchEvent(new Event("resize"))');
    await sleep(400);
    judge('loaded at 700 px, widened to 1280 px', await rowsVsText());
    await shot(14, 'gutter-aligned');
  }

  // ---- 15. an import of a CID: fetched once, kept, told to the module; one that is not there says so ------------------------------------------------
  step = 15;
  if (want()) {
    await fresh(url());
    await ready();
    const post = (u, body, ct = 'application/json') => fetch(T(u), { method: u.startsWith('api/programs/') ? 'PUT' : 'POST', headers: { 'Content-Type': ct }, body });
    const lib = 'let riff = c2 e2 g2 b2\n';
    const f = await (await post('api/fmt', JSON.stringify({ text: lib }))).json();
    await post(`api/programs/${f.cid}`, f.canonical, 'text/plain');
    const type = async (text) => {
      await page.eval(`(()=>{const ta=document.querySelector(".ed-ta"); ta.focus(); ta.value=${JSON.stringify(text)}; ta.dispatchEvent(new Event("input",{bubbles:true})); ta.blur();})()`);
      await sleep(500);
      // what the text draws on is on its way at most a moment: wait for it (no fixed sleep to be too short on a busy machine), then look
      await page.eval('(async()=>{ await __app.resolver.settled(); __app.runCheckNow(); return true })()', true);
    };
    const gets = async (cid) => (await (await fetch(T('__gets'))).json()).filter((c) => c === cid).length;
    const prog = `tempo 120\nimport ${f.cid}\ndeck A: bass riff\n`;
    await type(prog);
    check('a program that imports a CID checks once the page has fetched it (no "not here" left)', (await page.eval('__app.report && __app.report.ok')) === true, JSON.stringify(await page.eval('__app.report && __app.report.diagnostics')));
    check('it was fetched once', (await gets(f.cid)) === 1, `${await gets(f.cid)} fetches`);
    await type(`${prog}deck B: kick x ~ x ~\n`);
    check('an edit of it checks again with nothing fetched: the program is kept by CID', (await page.eval('__app.report && __app.report.ok')) === true && (await gets(f.cid)) === 1, `${await gets(f.cid)} fetches`);
    // a CID the server does not have: not here, in the module's words, on the import's line; asked for once, not on every keystroke
    const ghost = `z${'2'.repeat(44)}`;
    await type(`tempo 120\nimport ${ghost}\ndeck A: bass riff\n`);
    const d = await page.eval('(__app.report && __app.report.diagnostics || []).map((x) => x.message)');
    check('a CID that is not here says so, in words', d.some((m) => /is not here/.test(m)), JSON.stringify(d));
    await type(`tempo 121\nimport ${ghost}\ndeck A: bass riff\n`);
    check('and is asked for once, however often the text is checked', (await gets(ghost)) === 1, `${await gets(ghost)} fetches`);
    await shot(15, 'import-by-cid');
  }

  // ---- 10. no console errors anywhere ----------------------------------------------------------------------------------------------------------------
  step = 10;
  const errors = page.errors().filter((e) => !/wasm=off|switched off by/.test(e.text) && !/Failed to load resource.*\/api\/compose/.test(e.text) && !/Failed to load resource.*\/api\/programs\/z2222/.test(e.text)); // the compose error cases above answer 422/429/503 on purpose, and step 15 asks for a program that is not there
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
