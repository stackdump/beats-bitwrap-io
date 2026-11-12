#!/usr/bin/env node
//
// Browser test for ?engine=djrust — headless Chrome over raw CDP (no npm, same approach as
// test-wave-browser.mjs).
//
//   make djrust-wasm
//   ./beats-bitwrap-io -addr :18095 -public public -data /tmp/djrust-data &
//   node scripts/test-djrust-browser.mjs [http://localhost:18095]
//
// Asserts, in a real browser:
//  - ?engine=djrust loads the wasm module into the worklet and plays techno/42: the module says
//    ready, ticks reach the page, the marking reaches the canvas state, the output is not silent,
//    and Tone.js plays no notes;
//  - the same module rendered in an OfflineAudioContext gives the bytes Node gives for the same
//    project (one engine, one answer, whatever runs it);
//  - when the module cannot be fetched the page falls back to the JS wave engine and still plays;
//  - ?engine=wave and the default engine are unchanged.

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { instantiate } from '../public/djrust/loader.js';

const HOST = process.argv[2] || 'http://localhost:18095';
const PORT = 9342;
const CHROME = process.env.CHROME || 'google-chrome';
const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = join(here, '..', 'public', 'djrust', 'djwasm.wasm');
if (!existsSync(wasmPath)) { console.error('no public/djrust/djwasm.wasm: make djrust-wasm'); process.exit(2); }

let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) failures++;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', '--user-data-dir=/tmp/djrust-browser-profile', 'about:blank',
], { stdio: 'ignore' });

async function cdpTarget() {
    for (let i = 0; i < 50; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
            const page = list.find(t => t.type === 'page');
            if (page) return page.webSocketDebuggerUrl;
        } catch {}
        await sleep(200);
    }
    throw new Error('chrome did not come up');
}

function connect(url) {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const logs = [];
    ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        else if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map(a => a.value ?? a.description).join(' '));
        else if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + m.params.exceptionDetails.exception?.description);
    };
    const send = (method, params = {}) => new Promise((res) => {
        const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
    });
    const evaluate = async (expr) => {
        const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || 'eval failed');
        return r.result?.result?.value;
    };
    return new Promise(res => { ws.onopen = () => res({ send, evaluate, logs, close: () => ws.close() }); });
}

/** Open the studio with `query`, press play, listen for 4 s, report what happened. */
async function run(cdp, query) {
    await cdp.send('Page.navigate', { url: `${HOST}/?${query}` });
    for (let i = 0; i < 100; i++) {
        await sleep(200);
        const ok = await cdp.evaluate(`(() => { const el = document.querySelector('petri-note'); return !!(el && el._project && Object.keys(el._project.nets||{}).length); })()`).catch(() => false);
        if (ok) break;
    }
    await sleep(2000); // let the boot path (generate → project-sync) settle
    await cdp.evaluate(`(async () => {
        const el = document.querySelector('petri-note');
        const { toneEngine } = await import('/audio/tone-engine.js');
        window.__toneNotes = 0;
        const orig = toneEngine.playNote.bind(toneEngine);
        toneEngine.playNote = (...a) => { window.__toneNotes++; return orig(...a); };
        await el._ensureToneStarted();
        if (!el._playing) el._togglePlay();
    })()`);
    await sleep(4000);
    return cdp.evaluate(`(async () => {
        const el = document.querySelector('petri-note');
        const out = { tick: el._tick, toneNotes: window.__toneNotes, playing: el._playing, wave: !!el._wave,
            engine: el._engineName || null, info: el._djrustInfo || null, err: el._djrustError || null };
        if (el._wave) {
            const w = await el._wave;
            out.viaModule = w.viaModule;
            const ctx = window.Tone.getContext().rawContext;
            const an = ctx.createAnalyser(); an.fftSize = 2048;
            w.node.connect(an);
            let peak = 0;
            for (let k = 0; k < 20; k++) {
                await new Promise(r => setTimeout(r, 50));
                const buf = new Float32Array(an.fftSize); an.getFloatTimeDomainData(buf);
                for (const x of buf) peak = Math.max(peak, Math.abs(x));
            }
            out.peak = peak;
            out.ctxState = ctx.state;
        }
        const net = el._project.nets.kick || Object.values(el._project.nets)[0];
        out.markingSeen = Object.values(net.places).some(p => Array.isArray(p.tokens));
        out.project = el._waveProject ? JSON.stringify(el._waveProject) : null;
        return out;
    })()`);
}

try {
    const cdp = await connect(await cdpTarget());
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    // --- djrust, live ---
    const d = await run(cdp, 'engine=djrust&genre=techno&seed=42');
    check('djrust: the module is running in the worklet (engine name + module info)',
        d.engine === 'djrust' && d.info && d.info.abi === 1, JSON.stringify({ engine: d.engine, info: d.info, err: d.err, viaModule: d.viaModule }));
    check('djrust: transport playing, ticks reach the page', d.playing && d.tick > 8, `tick ${d.tick}, ctx ${d.ctxState}`);
    check('djrust: marking reaches the canvas state', d.markingSeen);
    check('djrust: worklet output is not silent', d.peak > 0.01, `peak ${d.peak?.toFixed(3)}`);
    check('djrust: Tone.js plays no notes', d.toneNotes === 0, `${d.toneNotes} Tone notes`);
    check('djrust: no console errors from the engine', !cdp.logs.some(l => /djrust|djwasm|EXC/.test(l) && /error|EXC|unavailable/i.test(l)),
        cdp.logs.filter(l => /djrust|djwasm|EXC/.test(l)).slice(0, 3).join(' | '));

    // --- the browser renders what Node renders ---
    if (d.project) {
        const seconds = 5, sr = 48000;
        const page = await cdp.evaluate(`(async () => {
            const { createDjrustEngine } = await import('/djrust/node.js');
            const project = ${JSON.stringify(d.project)};
            const octx = new OfflineAudioContext(2, ${sr * seconds}, ${sr});
            const dj = await createDjrustEngine(octx, null, { processorOptions: { project: JSON.parse(project), play: true, quiet: true } });
            const buf = await octx.startRendering();
            const l = buf.getChannelData(0), r = buf.getChannelData(1);
            const all = new Uint8Array(l.byteLength + r.byteLength);
            all.set(new Uint8Array(l.buffer, l.byteOffset, l.byteLength), 0);
            all.set(new Uint8Array(r.buffer, r.byteOffset, r.byteLength), l.byteLength);
            const h = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
            let peak = 0; for (const x of l) peak = Math.max(peak, Math.abs(x));
            return { sha: Array.from(h, b => b.toString(16).padStart(2, '0')).join(''), peak, viaModule: dj.viaModule, info: dj.info };
        })()`);
        const dj = await instantiate(readFileSync(wasmPath));
        dj.init(sr); dj.load(d.project); dj.play();
        const hash = createHash('sha256'), rights = [];
        const lefts = [];
        for (let b = 0; b < sr * seconds / 128; b++) {
            dj.process(128);
            const [l, r] = dj.blocks(128);
            lefts.push(l.slice()); rights.push(r.slice());
        }
        const cat = (parts) => { const o = new Float32Array(parts.length * 128); parts.forEach((p, i) => o.set(p, i * 128)); return o; };
        const L = cat(lefts), R = cat(rights);
        hash.update(Buffer.from(L.buffer)); hash.update(Buffer.from(R.buffer));
        check('offline: a Module in processorOptions is ready before the first quantum (the render is not silent)', page.peak > 0.05 && page.viaModule, `peak ${page.peak?.toFixed(3)}, viaModule ${page.viaModule}`);
        check('offline: the browser renders the same bytes Node renders (5 s, 48 kHz, stereo)', page.sha === hash.digest('hex'), `browser ${page.sha?.slice(0, 16)}`);
    } else {
        check('offline: project available from the page', false, 'el._waveProject was empty');
    }

    // --- fallback ---
    cdp.logs.length = 0;
    const f = await run(cdp, 'engine=djrust&djrust-wasm=/no-such-module.wasm&genre=techno&seed=42');
    check('fallback: a missing module falls back to the JS wave engine and says why',
        f.engine === 'wave' && /404/.test(f.err || ''), JSON.stringify({ engine: f.engine, err: f.err }));
    check('fallback: the JS wave engine plays', f.playing && f.tick > 8 && f.peak > 0.01 && f.toneNotes === 0, `tick ${f.tick}, peak ${f.peak?.toFixed(3)}`);

    // --- a browser that will not clone a Module into a worklet: the bytes go in a message ---
    const inj = await cdp.send('Page.addScriptToEvaluateOnNewDocument',
        { source: 'WebAssembly.compile = () => Promise.reject(new Error("compile disabled by the test"));' });
    const b = await run(cdp, 'engine=djrust&genre=techno&seed=42');
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: inj.result.identifier });
    check('bytes path: with no Module to hand over, the worklet compiles the bytes it is sent and plays',
        b.engine === 'djrust' && b.viaModule === false && b.tick > 8 && b.peak > 0.01 && b.toneNotes === 0,
        JSON.stringify({ engine: b.engine, viaModule: b.viaModule, tick: b.tick, peak: b.peak?.toFixed(3), err: b.err }));

    // --- unchanged ---
    const w = await run(cdp, 'engine=wave&genre=techno&seed=42');
    check('wave: ?engine=wave is unchanged (JS wave engine)', w.engine === 'wave' && !w.err && w.tick > 8 && w.peak > 0.01, JSON.stringify({ engine: w.engine, tick: w.tick }));
    const t = await run(cdp, 'genre=techno&seed=42');
    check('default engine: unchanged, still plays through Tone', !t.wave && t.engine === null && t.toneNotes > 0 && t.tick > 8,
        `tick ${t.tick}, ${t.toneNotes} Tone notes`);

    cdp.close();
} catch (err) {
    console.error(err);
    failures++;
} finally {
    chrome.kill();
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
