// Headless end-to-end check, dependency-free (raw CDP, node >= 22):
//   (cd public && python3 -m http.server 8765) & node public/jog/e2e.cdp.mjs
// Clicks Play, drags the virtual platter with real mouse events, and asserts
// that the message stream, the adapter, the worklet and the marking all moved.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const URL_ = process.env.JOG_URL || 'http://127.0.0.1:8765/jog/demo.html';
const PORT = 9377;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn('google-chrome', ['--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=/tmp/jog-e2e-chrome`, '--autoplay-policy=no-user-gesture-required', '--disable-gpu',
    '--no-first-run', '--window-size=1200,900', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} });

let target;
for (let i = 0; i < 40 && !target; i++) {
    await sleep(250);
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page'); } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
const logs = [];
ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') logs.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    if (m.method === 'Runtime.exceptionThrown') logs.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push('neterr: ' + m.params.entry.text);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)));
    ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
};
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
const read = () => ev(`(() => { const g = (i) => document.getElementById(i).textContent; return {
    rate: parseFloat(g('rate')), tick: parseFloat(g('tick')), touching: g('touching'), nudge: parseFloat(g('nudge')),
    msgrate: g('msgrate'), status: g('status'), log: g('log').split('\\n').length,
    tokens: [...document.querySelectorAll('.net-row')].map(r => [...r.querySelectorAll('i')].findIndex(c => c.classList.contains('token'))) }; })()`);

await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
await send('Page.navigate', { url: URL_ });
await sleep(1500);

// Play (a real click: Tone.start needs the gesture)
const btn = await ev(`(() => { const b = document.getElementById('play').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
await mouse('mousePressed', btn.x, btn.y); await mouse('mouseReleased', btn.x, btn.y);
for (let i = 0; i < 40 && !(await read()).status.startsWith('playing'); i++) await sleep(250);
await sleep(1200);
const playing = await read();
console.log('playing     ', playing);
assert.ok(playing.status.startsWith('playing'), 'never reached playing: ' + playing.status);
assert.ok(Math.abs(playing.rate - 1) < 0.05, 'rate should be 1x while playing');
assert.ok(playing.tick > 3, 'playhead should advance');
await ev(`(() => { window.__meter = new Tone.Meter(); Tone.getDestination().connect(window.__meter); })()`);
let loudest = -Infinity;
for (let i = 0; i < 10; i++) { await sleep(60); loudest = Math.max(loudest, await ev('Number(window.__meter.getValue())')); }
console.log('output level', loudest.toFixed(1), 'dB');
assert.ok(loudest > -40, 'worklet should be audible at the destination');

const box = await ev(`(() => { const b = document.querySelector('.jog').getBoundingClientRect(); return { cx: b.x + b.width / 2, cy: b.y + b.height / 2, r: b.width / 2 }; })()`);
async function arc(radiusFrac, fromDeg, toDeg, ms, { release = true, sample } = {}) {
    const R = box.r * radiusFrac;
    const pt = (deg) => [box.cx + R * Math.cos(deg * Math.PI / 180), box.cy + R * Math.sin(deg * Math.PI / 180)];
    const steps = Math.max(2, Math.round(ms / 8));
    await mouse('mousePressed', ...pt(fromDeg));
    const seen = [];
    for (let i = 1; i <= steps; i++) {
        await mouse('mouseMoved', ...pt(fromDeg + (toDeg - fromDeg) * i / steps));
        await sleep(8);
        if (sample && i % 10 === 0) seen.push(await read());
    }
    if (release) await mouse('mouseReleased', ...pt(toDeg));
    return seen;
}

// Hold still on the platter: clock frozen.
await arc(0.4, 0, 0.01, 400, { release: false });
const frozen = await read();
console.log('frozen      ', frozen);
assert.equal(frozen.touching, 'yes');
assert.ok(Math.abs(frozen.rate) < 0.05, 'touch should freeze the clock');

// Backspin half a turn, then forward half a turn, still touching.
const back = [];
{
    const R = box.r * 0.4;
    for (const [from, to] of [[0, -180], [-180, 0]]) {
        for (let i = 1; i <= 40; i++) {
            const deg = from + (to - from) * i / 40;
            await mouse('mouseMoved', box.cx + R * Math.cos(deg * Math.PI / 180), box.cy + R * Math.sin(deg * Math.PI / 180));
            await sleep(8);
            if (i % 8 === 0) back.push(await read());
        }
    }
}
console.log('scrub rates ', back.map((s) => s.rate).join(' '));
console.log('scrub ticks ', back.map((s) => s.tick).join(' '));
assert.ok(Math.min(...back.map((s) => s.rate)) < -0.5, 'backspin should run the platter in reverse');
assert.ok(Math.max(...back.map((s) => s.rate)) > 0.5, 'forward push should run it forwards');
await sleep(300);
const returned = await read();
assert.ok(Math.abs(returned.tick - frozen.tick) < 0.15, `out-and-back should return to the same position (${frozen.tick} -> ${returned.tick})`);
assert.deepEqual(returned.tokens, frozen.tokens, 'marking should be restored after out-and-back');

await mouse('mouseReleased', box.cx + box.r * 0.4, box.cy);
await sleep(600);
const resumed = await read();
console.log('resumed     ', resumed);
assert.equal(resumed.touching, 'no');
assert.ok(Math.abs(resumed.rate - 1) < 0.08, 'release should resume 1x');

// Outer ring: bend only, no touch.
const bend = await arc(0.88, 0, 120, 500, { sample: true });
console.log('bend nudges ', bend.map((s) => s.nudge).join(' '), ' touching:', bend.map((s) => s.touching).join(' '));
assert.ok(bend.every((s) => s.touching === 'no'));
assert.ok(Math.max(...bend.map((s) => s.nudge)) > 1, 'ring should nudge the rate up');
assert.ok(Math.max(...bend.map((s) => s.rate)) > 1.01);

console.log('msg rate    ', (await read()).msgrate);
console.log('page log    ', logs.length ? logs : 'clean');
assert.equal(logs.filter((l) => /^(error|exception|neterr)/.test(l)).length, 0, 'page errors');
console.log('OK');
process.exit(0);
