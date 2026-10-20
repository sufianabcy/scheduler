// Service worker: makes the app installable and lets it open offline with the last data it saw.
// - Pages: network first, falling back to the saved copy.
// - /api GET requests: network first, falling back to the last saved answer (so Today works offline).
//   Changes (POST/PATCH/…) always need the network. Logging out deletes the saved API answers.
// - Other files (scripts, styles, icons): saved on first use. Built file names change with every build.
// Bump SHELL when this file's caching rules change, to drop the old caches.

const SHELL = 'shell-v5';
const API = 'api';
// Registered as /sw.js?dev by the development server: notifications only, no caching.
const DEV = new URL(self.location.href).searchParams.has('dev');

self.addEventListener('install', (event) => {
  if (DEV) {
    self.skipWaiting();
    return;
  }
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
  if (DEV || request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Connecting a mail account is a full-page trip to Google or Microsoft, and mail bodies are never saved on the
  // device: let both go straight to the network.
  if (/^\/api\/mail\/(connect|callback)\/|^\/api\/mail\/messages\/\d+\/body/.test(url.pathname)) return;

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request, API));
  } else if (request.mode === 'navigate') {
    // Only the app itself is saved as the offline page; other pages (like /privacy.html) just load normally.
    if (url.pathname === '/' || url.pathname === '/index.html') event.respondWith(networkFirst(request, SHELL, '/'));
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

// ---------- Notifications ----------
// The server sends { title, body, url, tag }. A newer message with the same tag replaces the older one.

self.addEventListener('push', (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = { body: event.data?.text() };
  }
  event.waitUntil(
    self.registration.showNotification(message.title ?? 'Planner', {
      body: message.body ?? '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag: message.tag,
      renotify: Boolean(message.tag),
      data: { url: message.url ?? '/' },
    }),
  );
});

// Tapping a notification opens the app at its page, reusing an open window when there is one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      // navigate() fails for a window this worker doesn't control yet; open a new one then.
      if (open) return open.navigate(url).then((w) => (w ?? open).focus(), () => self.clients.openWindow(url));
      return self.clients.openWindow(url);
    }),
  );
});
