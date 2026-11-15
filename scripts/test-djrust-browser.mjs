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
//  - the studio (no engine parameter: djrust is the only engine) loads the wasm module into the
//    worklet and plays techno/42: the module says ready, ticks reach the page, the marking reaches
//    the canvas state, the output is not silent, and Tone.js is not on the page at all;
//  - the same module rendered in an OfflineAudioContext gives the bytes Node gives for the same
//    project (one engine, one answer, whatever runs it);
//  - when the module cannot be fetched there is no engine to fall back to: the page says why
//    (banner + el._djrustError) and nothing plays;
//  - a browser that will not clone a Module into a worklet still plays (bytes path);
//  - the features that depended on Tone are hidden (lib/ui/engine-gaps.js), master volume and
//    mutes still reach the engine;
//  - the legacy ?engine=djrust / ?engine=wave links still open the djrust studio.

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
        await el._ensureToneStarted();
        if (!el._playing) el._togglePlay();
    })()`);
    await sleep(4000);
    return cdp.evaluate(`(async () => {
        const el = document.querySelector('petri-note');
        const toneRequested = performance.getEntriesByType('resource').some(e => /tone@|tone-engine\.js|Tone\.js/.test(e.name));
        const out = { tick: el._tick, tone: typeof window.Tone !== 'undefined' || toneRequested, playing: el._playing, wave: !!el._wave,
            banner: el.querySelector('.pn-engine-error')?.textContent || null,
            engine: el._engineName || null, info: el._djrustInfo || null, err: el._djrustError || null,
            source: el._djrustSource || null };
        const w = el._wave ? await el._wave.catch(() => null) : null;
        if (w) {
            out.viaModule = w.viaModule;
            const { audioHost } = await import('/audio/host.js');
            const ctx = audioHost.getContext();
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

    // --- djrust, live (the default page) ---
    const d = await run(cdp, 'genre=techno&seed=42');
    check('djrust: the module is running in the worklet (engine name + module info)',
        d.engine === 'djrust' && d.info && d.info.abi === 1, JSON.stringify({ engine: d.engine, info: d.info, err: d.err, viaModule: d.viaModule }));
    // Before the pinned version is on npm the CDN 404s and the local build plays; after, the CDN.
    check('djrust: the module came from the pinned CDN version or the local build',
        /^cdn djwasm@\d+\.\d+\.\d+$|^local$/.test(d.source || ''), d.source);
    check('djrust: transport playing, ticks reach the page', d.playing && d.tick > 8, `tick ${d.tick}, ctx ${d.ctxState}`);
    check('djrust: marking reaches the canvas state', d.markingSeen);
    check('djrust: worklet output is not silent', d.peak > 0.01, `peak ${d.peak?.toFixed(3)}`);
    check('djrust: Tone.js is not loaded or requested', d.tone === false);
    check('djrust: no console errors from the engine', !cdp.logs.some(l => /djrust|djwasm|EXC/.test(l) && /error|EXC|unavailable/i.test(l)),
        cdp.logs.filter(l => /djrust|djwasm|EXC/.test(l)).slice(0, 3).join(' | '));

    // --- what is switched off, and what still reaches the engine ---
    const gaps = await cdp.evaluate(`(async () => {
        const el = document.querySelector('petri-note');
        const shown = (sel) => { const n = el.querySelector(sel); return !!n && getComputedStyle(n).display !== 'none'; };
        const out = {
            macros: shown('.pn-macros-btn'), autodj: shown('.pn-autodj-btn'), bypass: shown('.pn-fx-bypass'),
            reverb: shown('.pn-effects-panel .pn-fx-group:nth-child(2)'), masterVol: shown('.pn-effects-panel .pn-fx-group:first-child'),
            strip: shown('.pn-mixer-slider-group'),
        };
        const w = await el._wave;
        const { audioHost } = await import('/audio/host.js');
        const ctx = audioHost.getContext();
        const an = ctx.createAnalyser(); an.fftSize = 2048; audioHost.output.connect(an);
        const rms = async () => { let s = 0, n = 0; for (let k = 0; k < 16; k++) {
            await new Promise(r => setTimeout(r, 50)); const b = new Float32Array(an.fftSize); an.getFloatTimeDomainData(b);
            for (const x of b) { s += x * x; n++; } } return Math.sqrt(s / n); };
        out.before = await rms();
        // A fired macro is a no-op (no worker message, no running mark).
        let sent = 0; const orig = el._sendWs.bind(el); el._sendWs = (m) => { if (m.type === 'fire-macro') sent++; return orig(m); };
        el._fireMacro('cut'); out.macroSent = sent; out.macroRunning = !!el._runningMacro; el._sendWs = orig;
        // Master volume is the host gain.
        const vol = el.querySelector('.pn-fx-slider[data-fx="master-vol"]');
        vol.value = 5; vol.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 300));
        out.quiet = await rms();
        vol.value = 80; vol.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 300));
        // Mute every music net through the studio's own path.
        const music = Object.entries(el._project.nets).filter(([, n]) => n.role !== 'control').map(([id]) => id);
        for (const id of music) el._sendWs({ type: 'mute', netId: id, muted: true });
        await new Promise(r => setTimeout(r, 600));
        out.muted = await rms();
        for (const id of music) el._sendWs({ type: 'mute', netId: id, muted: false });
        return out;
    })()`);
    check('gaps: macros, Auto-DJ, FX bypass, reverb and the channel strip are hidden; master volume is shown',
        !gaps.macros && !gaps.autodj && !gaps.bypass && !gaps.reverb && !gaps.strip && gaps.masterVol, JSON.stringify(gaps));
    check('gaps: firing a macro does nothing (no worker message, nothing marked running)',
        gaps.macroSent === 0 && !gaps.macroRunning);
    check('engine: master volume reaches the output', gaps.before > 0.005 && gaps.quiet < gaps.before * 0.1,
        `rms ${gaps.before?.toFixed(4)} → ${gaps.quiet?.toFixed(4)}`);
    check('engine: muting every music net silences the output', gaps.muted < gaps.before * 0.25,
        `rms ${gaps.before?.toFixed(4)} → ${gaps.muted?.toFixed(4)}`);

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

    // --- no module: no engine, and the page says so ---
    cdp.logs.length = 0;
    const f = await run(cdp, 'djrust-wasm=/no-such-module.wasm&genre=techno&seed=42');
    check('no module: no engine starts, the reason is recorded and shown',
        f.engine === null && /404/.test(f.err || '') && /404/.test(f.banner || ''), JSON.stringify({ engine: f.engine, err: f.err, banner: f.banner }));
    check('no module: Tone.js is not a fallback', f.tone === false);

    // --- a browser that will not clone a Module into a worklet: the bytes go in a message ---
    const inj = await cdp.send('Page.addScriptToEvaluateOnNewDocument',
        { source: 'WebAssembly.compile = () => Promise.reject(new Error("compile disabled by the test"));' });
    const b = await run(cdp, 'genre=techno&seed=42');
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: inj.result.identifier });
    check('bytes path: with no Module to hand over, the worklet compiles the bytes it is sent and plays',
        b.engine === 'djrust' && b.viaModule === false && b.tick > 8 && b.peak > 0.01 && b.tone === false,
        JSON.stringify({ engine: b.engine, viaModule: b.viaModule, tick: b.tick, peak: b.peak?.toFixed(3), err: b.err }));

    // --- legacy links ---
    for (const q of ['engine=djrust', 'engine=wave']) {
        const l = await run(cdp, `${q}&genre=techno&seed=42`);
        check(`legacy: ?${q} opens the djrust studio`, l.engine === 'djrust' && l.tick > 8 && l.peak > 0.01 && l.tone === false,
            JSON.stringify({ engine: l.engine, tick: l.tick, err: l.err }));
    }

    cdp.close();
} catch (err) {
    console.error(err);
    failures++;
} finally {
    chrome.kill();
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
