#!/usr/bin/env node
//
// Record the scrolling lane view (the rolling note dots drawn by
// vizDrawTimeline) as video: headless Chrome over raw CDP (no npm, same
// approach as test-scope-browser.mjs), a timed Page.captureScreenshot loop
// clipped to the dot band, then ffmpeg -> a real-time MP4 and a slowed one.
//
//   ./beats-bitwrap-io -authoring -addr :18096 -public public -data /tmp/lane-data &
//   node scripts/record-lane-video.mjs <out-prefix> [http://localhost:18096] [query] [seconds]
//
// Writes <out-prefix>.mp4 (real time) and <out-prefix>-slow.mp4 (0.25x).
// Needs `google-chrome` (CHROME=) and `ffmpeg` on PATH.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2];
if (!OUT) { console.error('usage: record-lane-video.mjs <out-prefix> [host] [query] [seconds]'); process.exit(2); }
const HOST = process.argv[3] || 'http://localhost:18096';
const QUERY = process.argv[4] ?? 'genre=techno&seed=42';
const SECONDS = +(process.argv[5] || 10);
const PORT = +(process.env.CDP_PORT || 9351);
const CHROME = process.env.CHROME || 'google-chrome';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', `--user-data-dir=/tmp/lane-video-profile-${PORT}`,
    '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });

async function target() {
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
    ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    const send = (method, params = {}) => new Promise((res) => {
        const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
    });
    const evaluate = async (expr) => {
        const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
        return r.result?.result?.value;
    };
    return new Promise(res => { ws.onopen = () => res({ send, evaluate, close: () => ws.close() }); });
}

const cleanup = (code) => { try { chrome.kill(); } catch {} process.exit(code); };

try {
    const cdp = await connect(await target());
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: `${HOST}/?${QUERY}` });
    for (let i = 0; i < 100; i++) {
        await sleep(200);
        const ok = await cdp.evaluate(`(() => { const el = document.querySelector('petri-note'); return !!(el && el._project && Object.keys(el._project.nets||{}).length); })()`).catch(() => false);
        if (ok) break;
    }
    await sleep(1500);
    await cdp.evaluate(`(async () => {
        const el = document.querySelector('petri-note');
        document.querySelectorAll('.pn-welcome-overlay').forEach(n => n.remove());
        await el._ensureToneStarted();
        if (!el._playing) el._togglePlay();
    })()`);
    // Let the window fill so dots span the whole lane before recording.
    await sleep(6000);
    const box = await cdp.evaluate(`(() => { const c = document.querySelector('petri-note')._canvas; c.scrollIntoView({block: 'start'});
        const r = c.getBoundingClientRect();
        return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: Math.min(r.height, 70) }; })()`);

    const dir = `${OUT}-frames`;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const frames = [];
    const t0 = Date.now();
    while (Date.now() - t0 < SECONDS * 1000) {
        const at = Date.now() - t0;
        const r = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 85, clip: { ...box, scale: 2 } });
        const name = `f${String(frames.length).padStart(5, '0')}.jpg`;
        writeFileSync(join(dir, name), Buffer.from(r.result.data, 'base64'));
        frames.push({ name, at });
    }
    // concat list with each frame held until the next one was taken.
    const lines = ['ffconcat version 1.0'];
    frames.forEach((f, i) => {
        const next = i + 1 < frames.length ? frames[i + 1].at : f.at + 50;
        lines.push(`file '${f.name}'`, `duration ${((next - f.at) / 1000).toFixed(4)}`);
    });
    lines.push(`file '${frames.at(-1).name}'`);
    writeFileSync(join(dir, 'list.txt'), lines.join('\n') + '\n');
    const enc = (extra, out) => spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'),
        '-vf', `${extra}scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30,format=yuv420p`, '-c:v', 'libx264', '-crf', '20', out], { stdio: 'inherit' });
    enc('', `${OUT}.mp4`);
    enc('setpts=4*PTS,', `${OUT}-slow.mp4`);
    console.log(`${frames.length} frames over ${SECONDS}s -> ${OUT}.mp4, ${OUT}-slow.mp4`);
    cleanup(0);
} catch (e) { console.error(e); cleanup(1); }
