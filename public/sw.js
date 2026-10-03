// Bump to drop every cached copy on activate (activate deletes other
// caches). v6: server sends no-store / no-cache + ETag (staticcache).
// v7: only successful GETs are cached — v6 also stored error responses
// (e.g. nginx 429s), which an offline fallback could then serve.
const CACHE = 'beats-v7';
const ASSETS = [
  '/',
  '/index.html',
  '/petri-note.css',
  '/petri-note.js',
  '/sequencer-worker.js',
  '/favicon.svg',
  '/manifest.json',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Network-first for same-origin GETs; skip cross-origin (Tone.js CDN),
  // non-GET (telemetry / bench POSTs can't be cached) and the API (live
  // data, never an offline fallback).
  const req = e.request;
  if (req.method !== 'GET') return;
  if (!req.url.startsWith(self.location.origin)) return;
  const path = new URL(req.url).pathname;
  if (path.startsWith('/api/') || path.startsWith('/audio/')) return;
  e.respondWith(
    fetch(req)
      .then(r => {
        // Only keep good copies: a cached 429 / 5xx would be served as
        // the offline fallback later.
        if (r.ok && r.type === 'basic') {
          const clone = r.clone();
          caches.open(CACHE).then(c => c.put(req, clone)).catch(() => {});
        }
        return r;
      })
      .catch(() => caches.match(req))
  );
});
