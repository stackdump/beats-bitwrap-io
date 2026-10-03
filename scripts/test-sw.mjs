#!/usr/bin/env node
//
// Service-worker fetch policy (public/sw.js), tested directly: index.html
// unregisters the worker on localhost, so browser tests can't reach it.
// Runs sw.js against a mocked `self` / fetch / caches.
//
//   node scripts/test-sw.mjs        (also run by `make test-wave`)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../public/sw.js'), 'utf8');
const ORIGIN = 'https://beats.bitwrap.io';
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

function load(fetchImpl) {
    const listeners = {};
    const stores = new Map();
    const caches = {
        async open(name) {
            if (!stores.has(name)) stores.set(name, new Map());
            const m = stores.get(name);
            return {
                async put(req, res) {
                    if (req.method !== 'GET') throw new TypeError('POST is unsupported');
                    m.set(req.url, res);
                },
                async match(req) { return m.get(req.url); },
                async addAll() {},
            };
        },
        async match(req) { for (const m of stores.values()) if (m.has(req.url)) return m.get(req.url); },
        async keys() { return [...stores.keys()]; },
        async delete(k) { return stores.delete(k); },
    };
    const self = { location: { origin: ORIGIN }, addEventListener: (t, fn) => { listeners[t] = fn; },
        skipWaiting() {}, clients: { claim() {} } };
    new Function('self', 'caches', 'fetch', src)(self, caches, fetchImpl);
    return { listeners, stores, cacheName: /const CACHE = '([^']+)'/.exec(src)[1] };
}

function res(status) {
    return { status, ok: status >= 200 && status < 300, type: 'basic', clone() { return this; } };
}

async function dispatch(sw, method, url) {
    let responded = null;
    const ev = { request: { method, url }, respondWith(p) { responded = p; } };
    sw.listeners.fetch(ev);
    const r = responded ? await responded : null;
    await new Promise(r2 => setTimeout(r2, 0)); // let the cache put settle
    return { intercepted: !!responded, r };
}

const statusFor = { '/petri-note.js': 200, '/lib/perf/telemetry.js': 429, '/api/feed': 200, '/': 200 };
const sw = load(async (req) => res(statusFor[new URL(req.url).pathname] ?? 200));
const cached = () => [...(sw.stores.get(sw.cacheName) || new Map()).keys()].map(u => new URL(u).pathname);

let d = await dispatch(sw, 'POST', `${ORIGIN}/api/telemetry`);
check('POST is not intercepted (cannot be cached)', !d.intercepted);
d = await dispatch(sw, 'GET', `${ORIGIN}/api/feed`);
check('GET /api/* is not intercepted (live data)', !d.intercepted);
d = await dispatch(sw, 'GET', `https://unpkg.com/tone@15.1.22/build/Tone.js`);
check('cross-origin is not intercepted', !d.intercepted);
d = await dispatch(sw, 'GET', `${ORIGIN}/petri-note.js`);
check('200 GET is served and cached', d.intercepted && d.r.status === 200 && cached().includes('/petri-note.js'));
d = await dispatch(sw, 'GET', `${ORIGIN}/lib/perf/telemetry.js`);
check('429 GET is passed through but NOT cached', d.intercepted && d.r.status === 429 && !cached().includes('/lib/perf/telemetry.js'),
    `cached: ${cached().join(', ')}`);

// Offline: network fails → the good cached copy is served.
const offline = load(async () => { throw new TypeError('offline'); });
offline.stores.set(offline.cacheName, new Map([[`${ORIGIN}/petri-note.js`, res(200)]]));
d = await dispatch(offline, 'GET', `${ORIGIN}/petri-note.js`);
check('offline falls back to the cached copy', d.r?.status === 200);

if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall service-worker checks passed');
