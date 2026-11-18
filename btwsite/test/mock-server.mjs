#!/usr/bin/env node
// A small stand-in for the btw.bitwrap.io server, to develop and smoke-test the page against (no npm:
// node:http only). It speaks the routes of btwsite/DESIGN.md "HTTP API" well enough for the page:
// static files, /api/info, examples, check/fmt/share/open (through the REAL wasm when btwsite/web/wasm is
// built, else the page's JS mock), programs (PUT verifies the CID), a render stream (a synthesised click
// track as a streaming WAV: a kick on every beat, a hat on the off-beat, a bass note a bar), auth (any
// signature is accepted), compose (canned programs), sessions (SSE + reports) and two test-only routes
// (/__push/<id>, /__state/<id>).
//
//   node btwsite/test/mock-server.mjs [--port 18197] [--web btwsite/web] [--examples btwsite/examples] [--mock-wasm] [--csp strict|<policy>]
//
// --csp sets that Content-Security-Policy (and X-Frame-Options: DENY) on every response. `strict` is the policy the page
// needs and no more (see STRICT_CSP): the smoke run under it (`smoke.mjs --strict-csp`) is the proof that the server's
// policy can be this tight. No `blob:` for scripts or workers, no 'unsafe-inline' for styles (the page sets styles through
// the CSSOM, which a style-src without 'unsafe-inline' allows), nothing but 'self' to connect to.
//
// Compose behaviour by prompt: "FAIL" -> 422 unrepairable (with attempts), "LIMIT" -> 429 retry_after 38,
// "NOKEY" -> 503 not_configured, anything else -> a program (the first example, retuned).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i < 0 ? d : process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true;
};
const PORT = Number(arg('port', 18197));
const WEB = path.resolve(arg('web', path.join(here, '..', 'web')));
const EXAMPLES = path.resolve(arg('examples', path.join(here, '..', 'examples')));
const FORCE_MOCK = arg('mock-wasm', false) === true;
const STRICT_CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const CSP = arg('csp', null) === 'strict' ? STRICT_CSP : typeof arg('csp', null) === 'string' ? arg('csp', null) : null;

// ---- the checker: the real wasm if it is built, else the page's JS mock ----------------------------------------
let M; // {check, fmt, open, share, instruments}
let realWasm = false;
async function loadChecker() {
  const wasmJs = path.join(WEB, 'wasm', 'btw.js');
  if (!FORCE_MOCK && fs.existsSync(wasmJs)) {
    const m = await import(pathToFileURL(wasmJs).href);
    m.initSync({ module: fs.readFileSync(path.join(WEB, 'wasm', 'btw_bg.wasm')) });
    realWasm = true;
    M = { check: (t) => JSON.parse(m.btw_check(t)), fmt: (t) => JSON.parse(m.btw_fmt(t)), open: (s) => JSON.parse(m.btw_open(s)), share: (t) => JSON.parse(m.btw_share(t, null, false, 'https://btw.bitwrap.io')), instruments: () => JSON.parse(m.btw_instruments()) };
  } else {
    const w = await import(pathToFileURL(path.join(WEB, 'js', 'wasm-mock.js')).href);
    M = { check: w.mockCheck, fmt: w.mockFmt, open: w.mockOpen, share: (t) => w.mockShare(t), instruments: w.mockInstruments };
  }
}

// ---- state --------------------------------------------------------------------------------------------------------
const programs = new Map(); // cid -> {text, meta}
const examples = [];
const sessions = new Map(); // id -> {owner, res:Set, state, last}
const nonces = new Map();
const users = new Map(); // cookie -> user
const tokens = new Map(); // token -> user
const renderLog = [];

function loadExamples() {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(path.join(EXAMPLES, 'index.json'), 'utf8')); } catch { /* none */ }
  for (const ex of list) {
    const f = path.join(EXAMPLES, `${ex.name}.btw`);
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    const c = M.check(text);
    if (!c.ok) { console.error(`example ${ex.name} does not check:`, c.diagnostics && c.diagnostics[0] && c.diagnostics[0].message); continue; }
    examples.push({ name: ex.name, title: ex.title || ex.name, description: ex.description || '', cid: c.cid, bpm: c.tempo || 0, bars: c.song_bars || 0, license: ex.license || 'CC0-1.0', text });
    programs.set(c.cid, { text: c.canonical, meta: { license: 'CC0-1.0', name: ex.title || ex.name, source: 'example' } });
  }
}

// ---- helpers --------------------------------------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.wasm': 'application/wasm', '.btw': 'text/plain; charset=utf-8', '.png': 'image/png', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };

function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  const data = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', ...headers });
  res.end(data);
}
const err = (res, status, code, message, extra = {}, headers = {}) => send(res, status, { error: { code, message, ...extra } }, headers);

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}
const readJson = async (req) => { try { return JSON.parse((await readBody(req)) || '{}'); } catch { return {}; } };

function cookies(req) {
  const out = {};
  for (const p of (req.headers.cookie || '').split(/;\s*/)) { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i)] = p.slice(i + 1); }
  return out;
}
function userOf(req) {
  const a = req.headers.authorization || '';
  if (a.startsWith('Bearer ')) return tokens.get(a.slice(7)) || null;
  return users.get(cookies(req).btw_session) || null;
}

// ---- the render: a click track as a streaming WAV --------------------------------------------------------------------
function synth(text, c, from, n, sr) {
  const bpm = c.tempo || 120;
  const out = new Int16Array(n * 2);
  const beat = (60 / bpm) * sr;
  for (let i = 0; i < n; i++) {
    const s = from + i;
    const inBeat = s % beat;
    const bi = Math.floor(s / beat);
    let v = 0;
    const kt = inBeat / sr;
    if (kt < 0.18) v += Math.sin(2 * Math.PI * (45 + 120 * Math.exp(-kt * 28)) * kt) * Math.exp(-kt * 14) * 0.7;
    const half = (s + beat / 2) % beat;
    if (half / sr < 0.04) v += (((s * 1103515245 + 12345) >>> 8) % 2000 / 1000 - 1) * Math.exp(-(half / sr) * 90) * 0.18;
    if (bi % 4 === 0 && inBeat / sr < 0.5) v += Math.sin(2 * Math.PI * (55 + (Math.floor(bi / 4) % 4) * 4.5) * (s / sr)) * Math.exp(-(inBeat / sr) * 3) * 0.3;
    const q = Math.max(-1, Math.min(1, v));
    out[i * 2] = out[i * 2 + 1] = Math.round(q * 20000);
  }
  return Buffer.from(out.buffer);
}

function wavHeader(sr) {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0); b.writeUInt32LE(0xffffffff, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(0xffffffff, 40);
  return b;
}

async function handleRender(req, res, cid, url) {
  const p = programs.get(cid);
  if (!p) return err(res, 404, 'not_found', `no program ${cid}: PUT it to /api/programs/${cid} first`);
  const c = M.check(p.text);
  if (url.searchParams.get('busy')) return err(res, 429, 'busy', 'all render slots are taken', { retry_after: 7 }, { 'Retry-After': '7' });
  const sr = Number(url.searchParams.get('sr')) || 44100;
  const secs = Math.min(c.seconds || 30, Number(url.searchParams.get('max')) || 40);
  renderLog.push({ cid, t: Date.now() });
  res.writeHead(200, { 'Content-Type': 'audio/wav', 'X-Btw-Cid': cid, 'X-Btw-Seconds': String(secs), 'X-Btw-Bpm': String(c.tempo || 120), 'X-Btw-Cache': 'miss', 'Cache-Control': 'no-store', 'Transfer-Encoding': 'chunked' });
  res.write(wavHeader(sr));
  const total = Math.floor(secs * sr);
  const chunk = Math.floor(sr * 0.25);
  const pace = Number(url.searchParams.get('pace') || 60); // ms per 250 ms chunk: about 4x real time
  let done = 0;
  let open = true;
  res.on('close', () => { open = false; });
  while (open && done < total) {
    const n = Math.min(chunk, total - done);
    const buf = synth(p.text, c, done, n, sr);
    // split a chunk at an odd byte boundary now and then, as a network does
    const cut = done === 0 ? 7 : 0;
    if (cut) { res.write(buf.subarray(0, cut)); await new Promise((r) => setTimeout(r, 2)); res.write(buf.subarray(cut)); } else res.write(buf);
    done += n;
    const stall = Number(url.searchParams.get('stall') || 0);
    if (stall && done > sr * 6 && done < sr * 6 + chunk + 1) await new Promise((r) => setTimeout(r, stall));
    await new Promise((r) => setTimeout(r, pace));
  }
  res.end();
}

// ---- compose (canned) ---------------------------------------------------------------------------------------------------
function compose(body, user) {
  if (!user) return [401, { error: { code: 'auth_required', message: 'sign in to compose' } }];
  const prompt = String(body.prompt || '');
  if (!prompt) return [400, { error: { code: 'bad_request', message: 'a prompt is required' } }];
  if (prompt === 'FAIL') {
    const attempts = [1, 2, 3].map((n) => ({ n, ok: false, errors: 2, diagnostics: [{ severity: 'error', line: 3, col: 14, end_col: 15, message: '`kick` has no pattern', expected: ['`x`', '`~`'], help: 'kick x ~ x ~' }, { severity: 'error', line: 5, col: 1, end_col: 4, message: 'expected a statement, found `foo`' }], tokens_in: 900, tokens_out: 200 }));
    return [422, { error: { code: 'unrepairable', message: 'the model could not write a program that checks', details: { attempts } } }];
  }
  if (prompt === 'LIMIT') return [429, { error: { code: 'rate_limited', message: 'slow down', retry_after: 38 } }, { 'Retry-After': '38' }];
  if (prompt === 'NOKEY') return [503, { error: { code: 'not_configured', message: 'no model key' } }];
  const base = examples.find((e) => /first|acid/.test(e.name)) || examples[0];
  let text = base.text.replace(/^tempo\s+\d+/m, `tempo ${body.bpm || 128}`);
  text = `# composed from: ${prompt.slice(0, 50)}\n${text}`;
  const c = M.check(text);
  programs.set(c.cid, { text: c.canonical, meta: { license: 'CC0-1.0', composed_by: 'gemini-fake', source: 'compose', name: prompt.slice(0, 40) } });
  const sh = M.share(text);
  return [200, { program: c.canonical, text, cid: c.cid, check: c, attempts: [{ n: 1, ok: false, errors: 1, diagnostics: [{ severity: 'error', line: 2, col: 1, end_col: 4, message: 'a first try the model got wrong' }], tokens_in: 800, tokens_out: 150 }, { n: 2, ok: true, errors: 0, tokens_in: 1100, tokens_out: 160 }], model: 'gemini-fake', forkedFrom: body.base_cid || null, license: 'CC0-1.0', composedBy: 'gemini-fake', header: ['#! license: CC0-1.0', '#! composed-by: gemini-fake'], render_url: `/api/render/${c.cid}?format=opus`, share_url: sh.url, cost_usd: 0.0007, usage: { in: 1900, out: 310 } }];
}

// ---- routes ---------------------------------------------------------------------------------------------------------------
async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const m = req.method;
  if (p === '/healthz') return send(res, 200, 'ok');
  if (p === '/api/info') return send(res, 200, { name: 'btw.bitwrap.io (mock)', version: 'mock', model: 'fake', public_url: 'https://btw.bitwrap.io', compose: { enabled: true, configured: true, limits: { user_per_hour: 10 } }, render: { max_bars: 256 }, auth: ['eth', 'ed25519'], real_wasm: realWasm });
  if (p === '/api/examples') return send(res, 200, examples.map(({ text, ...e }) => e));
  let mm;
  if ((mm = /^\/examples\/([\w.-]+)\.btw$/.exec(p))) { const e = examples.find((x) => x.name === mm[1]); return e ? send(res, 200, e.text) : err(res, 404, 'not_found', 'no such example'); }
  if (p === '/api/instruments') return send(res, 200, M.instruments());
  if (m === 'POST' && p === '/api/check') return send(res, 200, M.check((await readJson(req)).text || ''));
  if (m === 'POST' && p === '/api/fmt') return send(res, 200, M.fmt((await readJson(req)).text || ''));
  if (m === 'POST' && p === '/api/share') return send(res, 200, M.share((await readJson(req)).text || ''));
  if (m === 'POST' && p === '/api/open') return send(res, 200, M.open((await readJson(req)).url || ''));
  if ((mm = /^\/api\/programs\/([^/]+?)(\.btw)?$/.exec(p))) {
    const cid = decodeURIComponent(mm[1]);
    if (m === 'PUT') {
      const text = await readBody(req);
      if (text.length > 16384) return err(res, 413, 'too_large', 'too big');
      const c = M.check(text);
      if (!c.ok) return err(res, 422, 'bad_request', 'the program does not check', { details: { diagnostics: c.diagnostics } });
      if (c.restricted || c.uses_assets) return err(res, 422, 'restricted', 'this program uses private or restricted assets');
      if (c.cid !== cid) return err(res, 422, 'cid_mismatch', `the program's CID is ${c.cid}, not ${cid}`);
      programs.set(cid, programs.get(cid) || { text: c.canonical, meta: { license: 'CC0-1.0', source: 'put' } });
      return send(res, 200, { cid, ok: true });
    }
    const pr = programs.get(cid);
    if (!pr) return err(res, 404, 'not_found', `no program ${cid}`);
    if (mm[2]) return send(res, 200, `#! license: CC0-1.0\n${pr.text}`);
    return send(res, 200, { cid, text: pr.text, meta: pr.meta });
  }
  if ((mm = /^\/api\/render\/([^/]+?)(\/status)?$/.exec(p))) {
    if (mm[2]) return send(res, 200, { cid: mm[1], state: programs.has(mm[1]) ? 'ready' : 'unknown' });
    return handleRender(req, res, decodeURIComponent(mm[1]), url);
  }
  // auth
  if (p === '/api/auth/challenge') { const nonce = crypto.randomBytes(12).toString('hex'); nonces.set(nonce, Date.now()); const issued = new Date().toISOString(); return send(res, 200, { nonce, message: `btw.bitwrap.io sign-in\nnonce: ${nonce}\nissued: ${issued}\nexpires: ${new Date(Date.now() + 300000).toISOString()}`, expires: new Date(Date.now() + 300000).toISOString() }); }
  if (m === 'POST' && p === '/api/auth/login') {
    const b = await readJson(req);
    if (!nonces.delete(b.nonce)) return err(res, 401, 'challenge_stale', 'that challenge is stale: try again');
    if (!b.signature || String(b.signature).length < 10) return err(res, 401, 'bad_signature', 'bad signature');
    const u = { id: b.type === 'eth' ? `eip155:${String(b.address).toLowerCase()}` : `ed25519:${b.address}`, kind: b.type, address: b.address, via: 'cookie' };
    const cookie = crypto.randomBytes(16).toString('hex');
    users.set(cookie, u);
    return send(res, 200, { user: u }, { 'Set-Cookie': `btw_session=${cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800` });
  }
  if (m === 'POST' && p === '/api/auth/logout') { users.delete(cookies(req).btw_session); return send(res, 200, { ok: true }, { 'Set-Cookie': 'btw_session=; Max-Age=0; Path=/' }); }
  if (p === '/api/auth/me') return send(res, 200, { user: userOf(req) });
  if (p === '/api/auth/token') {
    const u = userOf(req);
    if (!u) return err(res, 401, 'auth_required', 'sign in first');
    if (m === 'POST') { const t = `btw_${crypto.randomBytes(32).toString('base64url').slice(0, 43)}`; tokens.set(t, { ...u, via: 'token' }); return send(res, 200, { token: t }); }
    if (m === 'DELETE') { for (const [k, v] of tokens) if (v.id === u.id) tokens.delete(k); return send(res, 200, { ok: true }); }
  }
  if (m === 'POST' && p === '/api/compose') { const [st, body, hd] = compose(await readJson(req), userOf(req)); return send(res, st, body, hd || {}); }
  // sessions
  if (m === 'POST' && p === '/api/session') {
    const id = crypto.randomBytes(16).toString('base64url').slice(0, 22);
    const u = userOf(req);
    sessions.set(id, { owner: u ? u.id : '', res: new Set(), state: null, last: Date.now(), replies: [] });
    return send(res, 200, { id, user: u });
  }
  if ((mm = /^\/api\/session\/([^/]+)\/(events|report|reply)$/.exec(p))) {
    const s = sessions.get(mm[1]);
    if (!s) return err(res, 404, 'no_session', 'no such session');
    if (mm[2] === 'events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('event: ping\ndata: {}\n\n');
      s.res.add(res);
      const t = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 8000);
      req.on('close', () => { clearInterval(t); s.res.delete(res); });
      return undefined;
    }
    const b = await readJson(req);
    if (mm[2] === 'report') { s.state = b; s.last = Date.now(); return send(res, 200, { ok: true }); }
    s.replies.push(b);
    return send(res, 200, { ok: true });
  }
  if (m === 'POST' && (mm = /^\/__push\/([^/]+)$/.exec(p))) {
    const s = sessions.get(mm[1]);
    if (!s) return err(res, 404, 'no_session', 'no such session');
    const ev = await readJson(req);
    for (const r of s.res) r.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    return send(res, 200, { delivered: s.res.size });
  }
  if ((mm = /^\/__state\/([^/]+)$/.exec(p))) { const s = sessions.get(mm[1]); return s ? send(res, 200, { state: s.state, replies: s.replies, last: s.last }) : err(res, 404, 'no_session', 'no such session'); }
  if (p === '/__sessions') return send(res, 200, [...sessions.keys()]);
  if (p === '/__renders') return send(res, 200, renderLog);

  // static
  let file = path.join(WEB, p === '/' ? 'index.html' : p);
  if (!file.startsWith(WEB)) return err(res, 403, 'forbidden', 'no');
  if (p.startsWith('/examples/')) file = path.join(EXAMPLES, p.slice('/examples/'.length));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) return err(res, 404, 'not_found', `no ${p}`);
  const data = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: `"${crypto.createHash('md5').update(data).digest('hex')}"` });
  res.end(data);
  return undefined;
}

await loadChecker();
loadExamples();
const server = http.createServer((req, res) => {
  if (CSP) { res.setHeader('Content-Security-Policy', CSP); res.setHeader('X-Frame-Options', 'DENY'); }
  route(req, res).catch((e) => { console.error(e); if (!res.headersSent) err(res, 500, 'internal', String(e && e.message)); else res.end(); });
});
server.listen(PORT, '127.0.0.1', () => {
  console.error(`btw mock server on http://127.0.0.1:${PORT}  web=${WEB}  wasm=${realWasm ? 'real' : 'mock'}  examples=${examples.length}`);
});
