#!/usr/bin/env node
//
// test-djwasm-030-browser.mjs — the tri-render for djwasm 0.3.0 (plan step 2): every 0.3.0
// script (each net macro fired from the page, the macroCurve control dispatch, seek while
// playing / while stopped, groove 30/20, groove across a swap) and the four 0.2.0 live scripts
// give ONE sha256 four ways:
//   Node direct     the package's loader.js (test-djwasm-030.mjs renderDirect)
//   Node worklet    the package's worklet.js, TextEncoder/TextDecoder deleted, script hook
//   Offline         Chrome OfflineAudioContext, the same worklet.js, script hook
//   Live            a real Chrome AudioContext, engine → scripts/fixtures/capture-worklet.js tap
// The browser renderers land each scripted message with the worklet's `script` hook (applied
// before the quantum it names, counted from the engine's first quantum), so the live context
// plays the nominal schedule: no suspend/ack dance. Every renderer asserts 128-frame quanta
// (processorOptions.assertQuantum + the tap's histogram), and the worklet's own tapHash (a
// pure-JS sha256 on the audio thread) must equal crypto.subtle's of the same bytes.
//
//   DJRUST_WASM=../djrust-beats-studio/cabi/pkg node scripts/test-djwasm-030-browser.mjs [--port 18120] [--cdp 9370] [--only RE]
//
// It serves the candidate package itself (a small node:http server on --port): /pkg/loader.js,
// /pkg/worklet.js, /pkg/djwasm.wasm from the package, /tap.js from scripts/fixtures. The beats
// server and the pinned public/djrust/ files are not involved. Needs google-chrome ($CHROME).

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { loadPackage, buildScript030, SCRIPTS_030, renderDirect, renderWorklet } from './test-djwasm-030.mjs';
import { buildScript as buildScript020, SCRIPT_NAMES as SCRIPTS_020 } from './djrust-script.mjs';
import { readGolden } from './djrust-golden.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(opt('--port', process.env.DJRUST_BROWSER_PORT || 18120));
const CDP = Number(opt('--cdp', process.env.CDP_PORT || 9370));
const ONLY = opt('--only', null) ? new RegExp(opt('--only')) : null;
const CHROME = process.env.CHROME || 'google-chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0, passes = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if (ok) passes++; else failures++;
};

const mod = await loadPackage(opt('--wasm', process.env.DJRUST_WASM));
if (!mod) { console.error('test-djwasm-030-browser: DJRUST_WASM must name a djwasm package dir'); process.exit(2); }
console.log(`test-djwasm-030-browser: ${mod.wasmPath} (sha256 ${mod.sha256.slice(0, 16)}…), glue ${mod.glueDir}, http :${PORT}, cdp :${CDP}`);

// --- the server ---------------------------------------------------------------------------------
const files = {
    '/pkg/loader.js': [join(mod.glueDir, 'loader.js'), 'text/javascript'],
    '/pkg/worklet.js': [join(mod.glueDir, 'worklet.js'), 'text/javascript'],
    '/pkg/djwasm.wasm': [mod.wasmPath, 'application/wasm'],
    '/tap.js': [join(here, 'fixtures', 'capture-worklet.js'), 'text/javascript'],
};
const server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>djwasm 0.3.0 tri-render</title>'); return; }
    const f = files[path];
    if (!f) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': f[1], 'cache-control': 'no-store' });
    res.end(readFileSync(f[0]));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

// --- Chrome over raw CDP ------------------------------------------------------------------------
const profile = join(tmpdir(), `djwasm030-browser-profile-${CDP}`);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });

async function connect() {
    let url = null;
    for (let i = 0; i < 50 && !url; i++) {
        try { url = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl; } catch {}
        if (!url) await sleep(200);
    }
    if (!url) throw new Error('chrome did not come up');
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const logs = [];
    ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        else if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
        else if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + m.params.exceptionDetails.exception?.description);
    };
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const evaluate = async (expr) => {
        const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
        return r.result?.result?.value;
    };
    await new Promise((r) => { ws.onopen = r; });
    return { send, evaluate, logs, close: () => ws.close() };
}

const PAGE = `(() => {
    const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
    const wait = (port, pred, ms, what) => new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('timeout: ' + what)), ms);
        port.__w.push((m) => { if (pred(m)) { clearTimeout(t); res(m); return true; } return false; });
    });
    const listen = (node) => { node.port.__w = []; node.port.onmessage = (e) => {
        const w = node.port.__w; for (let i = 0; i < w.length; i++) if (w[i](e.data)) { w.splice(i, 1); break; }
        if (node.__on) node.__on(e.data); }; };
    let modP = null;
    const wasm = () => (modP ||= fetch('/pkg/djwasm.wasm').then((r) => r.arrayBuffer()).then((b) => WebAssembly.compile(b)));
    async function graph(ctx, s, collect) {
        await ctx.audioWorklet.addModule('/pkg/worklet.js');
        await ctx.audioWorklet.addModule('/tap.js');
        const frames = s.blocks * 128;
        const eng = new AudioWorkletNode(ctx, 'djrust-engine', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
            processorOptions: { module: await wasm(), json: s.text, play: true, quiet: true, ...s.options, script: s.steps,
                assertQuantum: 128, tapHash: true, tapFrames: frames } });
        listen(eng);
        const r = await wait(eng.port, (m) => m.type === 'ready' || m.type === 'error', 10000, 'engine ready');
        if (r.type !== 'ready') throw new Error('engine: ' + r.message);
        const engDone = wait(eng.port, (m) => m.type === 'tap-done' || m.type === 'error', frames / s.sr * 1000 + 30000, 'engine tap-done');
        const tap = new AudioWorkletNode(ctx, 'djrust-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
            channelCount: 2, channelCountMode: 'explicit', processorOptions: { frames, collect } });
        listen(tap);
        const chunks = [];
        let done; const tapDone = new Promise((r2) => (done = r2));
        tap.__on = (m) => { if (m.type === 'chunk') chunks.push(m); else if (m.type === 'done') done(m); };
        await wait(tap.port, (m) => m.type === 'hello', 10000, 'tap hello');
        eng.connect(tap);
        tap.connect(ctx.destination);
        return { eng, tap, frames, chunks, tapDone, engDone, ready: r };
    }
    window.__tri = {
        async offline(s) {
            const octx = new OfflineAudioContext(2, s.blocks * 128, s.sr);
            const g = await graph(octx, s, false);
            g.eng.connect(octx.destination);
            const buf = await octx.startRendering();
            const L = buf.getChannelData(0), R = buf.getChannelData(1);
            const inter = new Float32Array(2 * L.length);
            for (let i = 0; i < L.length; i++) { inter[2 * i] = L[i]; inter[2 * i + 1] = R[i]; }
            const t = await g.tapDone, e = await g.engDone;
            return { sha: hex(await crypto.subtle.digest('SHA-256', inter)), quanta: t.quanta, engine: e, features: g.ready.features };
        },
        async live(s) {
            const ctx = new AudioContext({ sampleRate: s.sr });
            await ctx.suspend();
            const g = await graph(ctx, s, true);
            await ctx.resume();
            const t = await g.tapDone, e = await g.engDone;
            const sr = ctx.sampleRate;
            await ctx.close();
            const inter = new Float32Array(2 * g.frames);
            for (const c of g.chunks) inter.set(c.data, 2 * c.offset);
            return { sha: hex(await crypto.subtle.digest('SHA-256', inter)), quanta: t.quanta, engine: e, sampleRate: sr };
        },
    };
    return true;
})()`;

const golden = readGolden();
const summary = {};
try {
    const cdp = await connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/` });
    await sleep(500);
    await cdp.evaluate(PAGE);
    const scripts = [
        ...SCRIPTS_030.map((n) => buildScript030(n)),
        ...SCRIPTS_020.map((n) => ({ ...buildScript020(n), name: `live:${n}`, options: {} })),
    ].filter((s) => !ONLY || ONLY.test(s.name));
    for (const s of scripts) {
        const direct = renderDirect(mod, s).audio;
        const worklet = (await renderWorklet(mod, s, { via: 'script' })).audio;
        let off, live;
        try {
            off = await cdp.evaluate(`window.__tri.offline(${JSON.stringify(s)})`);
            live = await cdp.evaluate(`window.__tri.live(${JSON.stringify(s)})`);
        } catch (err) { check(`tri-render ${s.name}: browser renders`, false, err.message); continue; }
        const only128 = (q) => Object.keys(q).length === 1 && q[128] === s.blocks;
        check(`tri-render ${s.name}: every render quantum is 128 frames (offline and live, tap histogram + engine assert)`,
            only128(off.quanta) && only128(live.quanta) && off.engine.type === 'tap-done' && live.engine.type === 'tap-done'
            && only128(off.engine.quanta) && only128(live.engine.quanta) && live.sampleRate === s.sr,
            JSON.stringify({ offline: off.quanta, live: live.quanta, engine: off.engine.type, sr: live.sampleRate }));
        const four = [direct, worklet, off.sha, live.sha];
        const equal = four.every((x) => x === direct);
        check(`tri-render ${s.name}: Node direct = Node worklet = OfflineAudioContext = live AudioContext`, equal,
            `direct ${direct.slice(0, 12)} worklet ${worklet.slice(0, 12)} offline ${off.sha.slice(0, 12)} live ${live.sha.slice(0, 12)}`);
        check(`tri-render ${s.name}: the worklet's own sha256 (tapHash) = crypto.subtle's, offline and live`,
            off.engine.sha === off.sha && live.engine.sha === live.sha);
        const want = s.name.startsWith('live:') ? golden.cases[`script:${s.name.slice(5)}@${s.sr}`] : null;
        if (want) check(`tri-render ${s.name}: = the golden (djwasm@${golden.module.version})`, direct === want.audio);
        summary[s.name] = { equal, sha: direct, blocks: s.blocks, steps: s.steps.map((x) => [x.q, x.msg.type, x.msg.id || x.msg.tick || x.msg.action || '']) };
    }
    const bad = cdp.logs.filter((l) => /EXC|error/i.test(l));
    check('tri-render: no page exceptions', !bad.length, bad.slice(0, 3).join(' | '));
    cdp.close();
} catch (err) {
    console.error(err);
    failures++;
} finally {
    chrome.kill();
    server.close();
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
console.log(`tri-render summary: ${JSON.stringify({ module: mod.sha256, scripts: summary })}`);
console.log(failures ? `\n${failures} check(s) FAILED, ${passes} passed` : `\nall ${passes} checks passed`);
process.exit(failures ? 1 : 0);
void resolve;
