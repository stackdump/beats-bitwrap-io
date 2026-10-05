#!/usr/bin/env node
//
// Browser smoke test for the Scope tab (public/lib/ui/scope.js) — headless
// Chrome over raw CDP (no npm, same approach as test-wave-browser.mjs).
//
//   ./beats-bitwrap-io -addr :18094 -public public -data /tmp/scope-data &
//   node scripts/test-scope-browser.mjs [http://localhost:18094] [screenshot-dir]
//
// Asserts, for the default engine and ?engine=wave: playback starts, the
// Scope tab opens, the model kernel table renders, every view draws a
// non-empty canvas, model bands fill while playing, the measured path and
// residual work when toggled, the loop stops when the tab closes, and no
// console errors / exceptions are raised. While the tab is open the net
// workspace (ring + timeline dots) must be hidden and not painted, with
// state (tick, fire history) still advancing; closing restores and repaints
// it. On a loop project (no structure — the site default) the raster must
// cover one loop cycle with events. Saves a PNG per view when a
// screenshot directory is given and prints per-view frame cost.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HOST = process.argv[2] || 'http://localhost:18094';
const SHOTS = process.argv[3] || '';
const PORT = 9343;
const CHROME = process.env.CHROME || 'google-chrome';
const PLAY_MS = +(process.env.SCOPE_PLAY_MS || 9000);

let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) failures++;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', '--user-data-dir=/tmp/scope-browser-profile',
    '--window-size=1280,1600', 'about:blank',
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
    const errors = [];
    ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
            errors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
        } else if (m.method === 'Runtime.exceptionThrown') {
            errors.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
        }
    };
    const send = (method, params = {}) => new Promise((res) => {
        const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
    });
    const evaluate = async (expr) => {
        const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
        return r.result?.result?.value;
    };
    return new Promise(res => { ws.onopen = () => res({ send, evaluate, errors, close: () => ws.close() }); });
}

// Fraction of canvas pixels that differ from the background.
const INK = `(() => {
    const c = document.querySelector('.pn-scope-canvas');
    if (!c || !c.width || !c.height) return 0;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let ink = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 5) + Math.abs(d[i + 1] - 10) + Math.abs(d[i + 2] - 20) > 24) ink++;
    return ink / (d.length / 4);
})()`;

async function shot(cdp, name) {
    if (!SHOTS) return null;
    await cdp.evaluate(`document.querySelectorAll('.pn-welcome-overlay').forEach(n => n.remove())`);
    const box = await cdp.evaluate(`(() => { const p = document.querySelector('.pn-scope-panel'); p.scrollIntoView({block: 'center'});
        const r = p.getBoundingClientRect();
        return { x: r.x + scrollX, y: r.y + scrollY, width: Math.min(r.width, innerWidth - Math.max(0, r.x)), height: r.height }; })()`);
    await sleep(300);
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...box, scale: 1 } });
    const path = join(SHOTS, `scope-${name}.png`);
    writeFileSync(path, Buffer.from(r.result.data, 'base64'));
    return path;
}

async function run(cdp, label, query, shots, opts = {}) {
    cdp.errors.length = 0;
    await cdp.send('Page.navigate', { url: `${HOST}/?${query}` });
    for (let i = 0; i < 100; i++) {
        await sleep(200);
        const ok = await cdp.evaluate(`(() => { const el = document.querySelector('petri-note'); return !!(el && el._project && Object.keys(el._project.nets||{}).length); })()`).catch(() => false);
        if (ok) break;
    }
    await sleep(2000);
    await cdp.evaluate(`(async () => {
        const el = document.querySelector('petri-note');
        document.querySelectorAll('.pn-welcome-overlay').forEach(n => n.remove());
        await el._ensureToneStarted();
        if (!el._playing) el._togglePlay();
        el.querySelector('.pn-scope-btn').click();
    })()`);
    // Kernel table: rendered once per instrument/patch, then cached.
    let status = '';
    for (let i = 0; i < 60; i++) {
        await sleep(250);
        status = await cdp.evaluate(`document.querySelector('.pn-scope-status')?.textContent || ''`);
        if (/kernels/.test(status) && !/rendering/.test(status)) break;
    }
    check(`${label}: kernel table ready`, /model · \d+ kernels/.test(status), status);
    await cdp.evaluate(`document.querySelector('.pn-scope-measured input').click()`);
    await sleep(PLAY_MS);

    const out = {};
    for (const view of ['live', 'spectro', 'bands', 'raster']) {
        await cdp.evaluate(`document.querySelector('.pn-scope-views button[data-view="${view}"]').click()`);
        await sleep(view === 'raster' ? 1500 : 1200);
        const ink = await cdp.evaluate(INK);
        check(`${label}: ${view} canvas is not empty`, ink > 0.01, `ink ${(ink * 100).toFixed(1)}%`);
        if (shots) out[view] = await shot(cdp, `${shots}-${view}`);
    }
    // Net workspace hidden + idle while Scope is open; state keeps moving.
    const hid = await cdp.evaluate(`(async () => {
        const el = document.querySelector('petri-note');
        const ws = el.querySelector('.pn-workspace');
        const a = { paints: el._netPaints | 0, renders: el._netRenders | 0, tick: el._tick, hist: el._vizHistory.length,
                    last: el._vizHistory.at(-1)?.time || 0 };
        await new Promise(r => setTimeout(r, 1500));
        return { display: getComputedStyle(ws).display, paints: (el._netPaints | 0) - a.paints,
                 renders: (el._netRenders | 0) - a.renders, ticks: el._tick - a.tick,
                 hist: (el._vizHistory.at(-1)?.time || 0) > a.last, rasterStatus: document.querySelector('.pn-scope-status').textContent,
                 loop: !(el._structure && el._structure.length), raster: el._scope.raster && { n: el._scope.raster.n, steps: el._scope.raster.steps,
                     loop: el._scope.raster.loop, cycle: el._scope.raster.cycle, failed: !!el._scope.raster.failed } };
    })()`);
    check(`${label}: net workspace hidden while Scope is open`, hid.display === 'none', `display ${hid.display}`);
    check(`${label}: ring + timeline dots not drawn while hidden`, hid.paints === 0 && hid.renders === 0,
        `${hid.paints} paints, ${hid.renders} net renders in 1.5 s`);
    check(`${label}: transport state keeps running while hidden`, hid.ticks > 0 && hid.hist, `${hid.ticks} ticks, history ${hid.hist ? 'advancing' : 'stalled'}`);
    if (opts.loop) {
        const r = hid.raster || {};
        check(`${label}: loop project (no structure) raster covers a loop cycle with events`,
            hid.loop && !r.failed && r.loop && r.n > 0 && r.steps >= 16 && /loop/.test(hid.rasterStatus), `${hid.rasterStatus} · ${JSON.stringify(r)}`);
    }
    const st = await cdp.evaluate(`(() => {
        const el = document.querySelector('petri-note');
        const s = el._scope;
        const st = el._scopeStats();
        return { stats: st, running: s.running, bars: s.maxBar + 1, fires: s.fires, playing: el._playing,
                 perf: el._perf?.last?.vizMs || null };
    })()`);
    // The model-only default for comparison screenshots.
    if (shots) {
        await cdp.evaluate(`document.querySelector('.pn-scope-measured input').click()`);
        for (const view of ['spectro', 'bands']) {
            await cdp.evaluate(`document.querySelector('.pn-scope-views button[data-view="${view}"]').click()`);
            await sleep(800);
            out[view + '-model'] = await shot(cdp, `${shots}-${view}-model`);
        }
        await cdp.evaluate(`document.querySelector('.pn-scope-measured input').click()`);
    }
    check(`${label}: scope loop running while open + playing`, st.running && st.playing);
    check(`${label}: fires reach the scope`, st.fires > 20, `${st.fires} fires`);
    check(`${label}: model bands fill bar by bar`, st.bars >= 2, `${st.bars} bars`);
    check(`${label}: model vs measured stats computed`, st.stats.bars >= 2, JSON.stringify(st.stats.bands.map(b => [b.band, b.corr, b.rmsResidualDb])));
    // Closing the tab stops the loop and drops the analyser tap.
    const closed = await cdp.evaluate(`(async () => {
        const el = document.querySelector('petri-note');
        const p0 = el._netPaints | 0;
        el.querySelector('.pn-scope-btn').click();
        await new Promise(r => setTimeout(r, 300));
        const ws = el.querySelector('.pn-workspace');
        const r = { running: el._scope.running, analyser: !!el._scope.an, display: getComputedStyle(ws).display,
                    paints: (el._netPaints | 0) - p0, canvasW: el._canvas.width, nodes: el._stage.childElementCount, dirty: !!el._netDirty };
        el._togglePlay();
        return r;
    })()`);
    check(`${label}: closing the tab stops the loop and the analyser`, !closed.running && !closed.analyser);
    check(`${label}: closing restores the net workspace and repaints it`,
        closed.display !== 'none' && closed.paints > 0 && closed.canvasW > 0 && closed.nodes > 0 && !closed.dirty, JSON.stringify(closed));
    const errs = cdp.errors.filter(e => !/favicon|ERR_|Failed to load resource|telemetry/i.test(e));
    check(`${label}: no console errors`, errs.length === 0, errs.slice(0, 3).join(' | '));
    return { ...st, shots: out };
}

try {
    if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    const cdp = await connect(await cdpTarget());
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1600, deviceScaleFactor: 1, mobile: false });
    const results = {};
    // genre=techno&seed=42 loads in the site default loop mode (no structure).
    results.default = await run(cdp, 'default', 'genre=techno&seed=42', 'techno42', { loop: true });
    results.wave = await run(cdp, 'wave', 'engine=wave&genre=techno&seed=42', null, { loop: true });
    // Phone width: layout must not overflow.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    results.mobile = await run(cdp, 'mobile', 'genre=techno&seed=42', SHOTS ? 'mobile' : null, { loop: true });
    // The app's own row may be wider than a phone (pre-existing); the Scope
    // panel must not widen it further.
    const overflow = await cdp.evaluate(`(async () => {
        document.querySelector('.pn-scope-btn').click();
        await new Promise(r => setTimeout(r, 300));
        const p = document.querySelector('.pn-scope-panel').getBoundingClientRect();
        const t = document.querySelector('.pn-effects-toggle').getBoundingClientRect();
        return Math.round(p.right - t.right);
    })()`);
    check('mobile: scope panel does not widen the layout', overflow <= 1, `panel right − toggle row right = ${overflow}px`);
    console.log('RESULT ' + JSON.stringify(results));
    cdp.close();
} catch (err) {
    console.error(err);
    failures++;
} finally {
    chrome.kill();
}
console.log(failures ? `\n${failures} failure(s)` : '\nall scope checks passed');
process.exit(failures ? 1 : 0);
