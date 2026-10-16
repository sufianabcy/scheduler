// Service worker: makes the app installable and lets it open offline with the last data it saw.
// - Pages: network first, falling back to the saved copy.
// - /api GET requests: network first, falling back to the last saved answer (so Today works offline).
//   Changes (POST/PATCH/…) always need the network. Logging out deletes the saved API answers.
// - Other files (scripts, styles, icons): saved on first use. Built file names change with every build.
// Bump SHELL when this file's caching rules change, to drop the old caches.

const SHELL = 'shell-v1';
const API = 'api';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(['/', '/manifest.webmanifest', '/icons/icon-192.png']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== API).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request, API));
  } else if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, SHELL, '/'));
  } else {
    event.respondWith(cacheFirst(request));
  }
});

async function networkFirst(request, cacheName, key = request) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(key, response.clone());
    return response;
  } catch (err) {
    const saved = await cache.match(key);
    if (saved) return saved;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL);
  const saved = await cache.match(request);
  if (saved) return saved;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}
