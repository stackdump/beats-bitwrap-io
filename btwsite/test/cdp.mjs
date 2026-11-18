// A tiny Chrome DevTools Protocol client for the browser smoke test (no npm: Node's global fetch and
// WebSocket, and the Chrome already on the machine). Launch headless Chrome, open a page, evaluate, click
// and type through Input.*, collect console messages and exceptions, screenshot to a PNG.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

// BTW_CHROME_ARGS="--disable-audio-output" adds Chrome flags to every launch (a null audio sink on a machine whose sound card is busy or absent)
export const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

export async function launch({ width = 1280, height = 800, args = [] } = {}) {
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'btw-chrome-'));
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`, '--force-device-scale-factor=1', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check', '--disable-gpu-vsync', '--font-render-hinting=none', ...(process.env.BTW_CHROME_ARGS || '').split(' ').filter(Boolean), ...args, 'about:blank'], { stdio: 'ignore' });
  const kill = () => { try { proc.kill('SIGKILL'); } catch { /* gone */ } try { rmSync(profile, { recursive: true, force: true }); } catch { /* busy */ } };
  process.on('exit', kill);
  let target;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
      target = await r.json();
      break;
    } catch { await sleep(100); }
  }
  if (!target) { kill(); throw new Error('Chrome did not come up'); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp socket')); });
  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  const logs = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      const { res, rej } = pending.get(d.id);
      pending.delete(d.id);
      if (d.error) rej(new Error(`${d.error.message}`)); else res(d.result);
    } else if (d.method) {
      for (const l of listeners) l(d);
    }
  };
  const cdp = (method, params = {}, ms = 60000) => new Promise((res, rej) => { const id = nextId++; const t = setTimeout(() => { pending.delete(id); rej(new Error(`cdp ${method} timed out after ${ms} ms`)); }, ms); pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); ws.send(JSON.stringify({ id, method, params })); });
  listeners.push((d) => {
    if (d.method === 'Runtime.consoleAPICalled') logs.push({ type: d.params.type, text: d.params.args.map((a) => a.value ?? a.description ?? '').join(' ') });
    if (d.method === 'Runtime.exceptionThrown') logs.push({ type: 'exception', text: d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text });
    if (d.method === 'Log.entryAdded') logs.push({ type: `log.${d.params.entry.level}`, text: `${d.params.entry.text} ${d.params.entry.url || ''}` });
  });
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Log.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  const page = {
    cdp, logs, port,
    async goto(url) {
      const loaded = new Promise((res) => { const l = (d) => { if (d.method === 'Page.loadEventFired') { listeners.splice(listeners.indexOf(l), 1); res(); } }; listeners.push(l); });
      await cdp('Page.navigate', { url });
      await Promise.race([loaded, sleep(15000)]);
    },
    async eval(expression, awaitPromise = false) {
      const r = await cdp('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      return r.result.value;
    },
    async waitFor(expr, ms = 15000, step = 100) {
      const t0 = Date.now();
      for (;;) {
        let v;
        try { v = await page.eval(expr); } catch { v = false; }
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error(`timeout waiting for: ${expr}`);
        await sleep(step);
      }
    },
    async rect(sel) {
      return page.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}})()`);
    },
    async click(sel, { dx, dy } = {}) {
      const r = await page.rect(sel);
      if (!r) throw new Error(`no element ${sel}`);
      const x = r.x + (dx ?? r.w / 2);
      const y = r.y + (dy ?? r.h / 2);
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    },
    async hover(x, y) { await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); },
    async type(text) { await cdp('Input.insertText', { text }); },
    async key(key, { meta = false, ctrl = false, shift = false, code, vk } = {}) {
      const modifiers = (meta ? 4 : 0) | (ctrl ? 2 : 0) | (shift ? 8 : 0);
      const codes = { Enter: ['Enter', 13], Escape: ['Escape', 27], Tab: ['Tab', 9], Backspace: ['Backspace', 8] };
      const [c, v] = codes[key] || [code || `Key${key.toUpperCase()}`, vk || key.toUpperCase().charCodeAt(0)];
      const text = key === 'Enter' ? '\r' : key.length === 1 ? key : undefined;
      await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: c, windowsVirtualKeyCode: v, modifiers, text: modifiers ? undefined : text });
      if (text && !modifiers) await cdp('Input.dispatchKeyEvent', { type: 'char', key, code: c, text, modifiers });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code: c, windowsVirtualKeyCode: v, modifiers });
    },
    async shot(file, { clip } = {}) {
      const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
      writeFileSync(file, Buffer.from(r.data, 'base64'));
      return file;
    },
    async resize(width, height) { await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 }); },
    errors() { return logs.filter((l) => l.type === 'error' || l.type === 'exception' || l.type === 'log.error'); },
    async close() { try { ws.close(); } catch { /* closed */ } kill(); },
  };
  return page;
}
