// harness.mjs: what run.mjs and loop.mjs share: the page's server (btwsite/ plus POST /upload/<name>), headless
// Chrome on web/parity.html, and one engine render through it.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const site = path.resolve(here, '..', '..');
if (!process.env.CHROME) for (const c of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) if (fs.existsSync(c)) { process.env.CHROME = c; break; }
const cdp = await import('../cdp.mjs');
export const CHROME = cdp.CHROME;
/** Another build of the module to test (a directory with btw.js, btw_bg.wasm): PARITY_WASM_DIR. */
export const WASM_DIR = process.env.PARITY_WASM_DIR ? path.resolve(process.env.PARITY_WASM_DIR) : null;
export const wasmDir = () => WASM_DIR || path.join(site, 'web', 'wasm');

/** Why the harness cannot run here, or null. */
export function missing(btwd) {
    if (!fs.existsSync(path.join(wasmDir(), 'btw_bg.wasm'))) return 'no built module in btwsite/web/wasm (djrust-vevr-se: scripts/build-web-wasm.sh <btwsite>/web/wasm)';
    if (!fs.existsSync(CHROME)) return `no Chrome at ${CHROME}`;
    if (btwd !== undefined && (!btwd || !fs.existsSync(btwd))) return 'no btwd (--btwd PATH, BTWD_BIN, or btwsite/bin/btwd)';
    return null;
}

export function findBtwd(argValue) {
    return argValue || process.env.BTWD_BIN || [path.join(site, 'bin', 'btwd'), path.resolve(site, '..', '..', 'djrust-vevr-se', 'target', 'release', 'btwd')].find((p) => fs.existsSync(p));
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.btw': 'text/plain', '.css': 'text/css' };

/** The page's server and Chrome on parity.html: {page, render(opts), close()}. */
export async function start() {
    const uploads = new Map();
    const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        if (req.method === 'POST' && u.pathname.startsWith('/upload/')) {
            const name = decodeURIComponent(u.pathname.slice(8));
            const chunks = [];
            req.on('data', (d) => chunks.push(d));
            req.on('end', () => { uploads.set(name, Buffer.concat(chunks)); res.writeHead(204); res.end(); });
            return;
        }
        // PARITY_WASM_DIR: serve another build of the module as web/wasm (the one a site has deployed, say)
        let p = path.join(site, path.normalize(decodeURIComponent(u.pathname)).replace(/^([/\\])+/, ''));
        if (WASM_DIR && u.pathname.startsWith('/web/wasm/')) p = path.join(WASM_DIR, path.basename(u.pathname));
        if ((!p.startsWith(site) && !(WASM_DIR && p.startsWith(WASM_DIR))) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        fs.createReadStream(p).pipe(res);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const page = await cdp.launch({ width: 800, height: 400, args: ['--disable-audio-output'] });
    await page.goto(`http://127.0.0.1:${port}/web/parity.html?perf=1`); // ?perf=1: the worklet's slow blocks (stats.slow) in every run
    await page.waitFor('window.parityRender !== undefined && window.parityReady === true', 20000);
    return {
        page,
        /** The engine's render of `program`: the page's answer plus `pcm` (interleaved s16 Buffer), or {ok:false, error}. */
        async render({ program, name, seconds, sampleRate = 48000, evals = [] }) {
            const before = page.logs.length;
            let v;
            try {
                const r = await page.cdp('Runtime.evaluate', { expression: `parityRender(${JSON.stringify({ program, name, seconds, sampleRate, evals })})`, awaitPromise: true, returnByValue: true }, 30 * 60 * 1000);
                if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
                v = r.result.value;
            } catch (e) { v = { ok: false, error: e.message }; }
            v.console = page.logs.slice(before).filter((l) => /ignoring|error|warn/i.test(l.text)).map((l) => `${l.type}: ${l.text}`).slice(0, 40);
            if (v.ok) { v.pcm = uploads.get(name); uploads.delete(name); }
            return v;
        },
        async close() { await page.close(); server.close(); },
    };
}

export function wav(pcmBuf, sr) {
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + pcmBuf.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 4, 28);
    h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcmBuf.length, 40);
    return Buffer.concat([h, pcmBuf]);
}

export const int16 = (buf) => new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);
