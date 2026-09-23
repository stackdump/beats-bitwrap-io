// Minimal raw-CDP driver for the headless checks (no dependencies, node >= 22).
import { spawn } from 'node:child_process';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch(url, { port = 9377 } = {}) {
    const chrome = spawn('google-chrome', ['--headless=new', `--remote-debugging-port=${port}`,
        `--user-data-dir=/tmp/jog-e2e-chrome-${port}`, '--autoplay-policy=no-user-gesture-required', '--disable-gpu',
        '--no-first-run', '--window-size=1300,1000', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' });
    process.on('exit', () => { try { chrome.kill(); } catch {} });

    let target;
    for (let i = 0; i < 40 && !target; i++) {
        await sleep(250);
        try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch {}
    }
    if (!target) throw new Error('chrome did not start');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0;
    const pending = new Map();
    const errors = [];
    ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
        if (m.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
        if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push('neterr: ' + m.params.entry.text);
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
    const mouse = (type, x, y, modifiers = 0) => send('Input.dispatchMouseEvent',
        { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, modifiers });
    const center = (selector) => ev(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, r: b.width / 2 }; })()`);
    const click = async (selector) => {
        await ev(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center' })`);
        const c = await center(selector); await mouse('mousePressed', c.x, c.y); await mouse('mouseReleased', c.x, c.y); };

    // Drag along an arc of the wheel at `selector`. radiusFrac < 0.76 = platter.
    async function arc(selector, radiusFrac, fromDeg, toDeg, ms, { press = true, release = true, modifiers = 0, each } = {}) {
        const c = await center(selector);
        const R = c.r * radiusFrac;
        const pt = (deg) => [c.x + R * Math.cos(deg * Math.PI / 180), c.y + R * Math.sin(deg * Math.PI / 180)];
        const steps = Math.max(2, Math.round(ms / 8));
        if (press) await mouse('mousePressed', ...pt(fromDeg), modifiers);
        for (let i = 1; i <= steps; i++) {
            await mouse('mouseMoved', ...pt(fromDeg + (toDeg - fromDeg) * i / steps), modifiers);
            await sleep(8);
            if (each) await each(i, steps);
        }
        if (release) await mouse('mouseReleased', ...pt(toDeg), modifiers);
    }

    await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
    await send('Page.navigate', { url });
    await sleep(1500);
    return { send, ev, mouse, center, click, arc, errors };
}
