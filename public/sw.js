// Bump to drop every cached copy on activate (activate deletes other
// caches). v6: server now sends no-store / no-cache + ETag (staticcache).
const CACHE = 'beats-v6';
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
  // Network-first for same-origin, skip cross-origin (Tone.js CDN)
  if (!e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    fetch(e.request)
      .then(r => {
        const clone = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});
