/* Auto Lab service worker — caches the app shell + all modules for offline use */
const VERSION = 'autolab-v4.9';
const CORE    = `${VERSION}-core`;
const RUNTIME = `${VERSION}-runtime`;

const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './modules.js',
  './perf-guard.js',
  './base.css',
  './embed-fix.css',
  './module-base.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  // ── modules ────────────────────────────────────────────────
  './engine.html',
  './carburetor.html',
  './clutch.html',
  './cooling.html',
  './differential.html',
  './gearbox.html',
  './steering.html',
  './transmission.html',
  './braking.html',
  './ignition.html',
  './mpfi.html',
  './suspension.html',
  './turbocharger.html'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CORE);
    // Cache individually so one 404 can't kill the whole install
    await Promise.all(CORE_ASSETS.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res && res.ok) await cache.put(url, res);
      } catch (_) {}
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k !== CORE && k !== RUNTIME)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Navigation → network-first, fall back to cached shell
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CORE);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch (_) {
        const cached = await caches.match('./index.html');
        return cached || new Response('Offline', { status: 503 });
      }
    })());
    return;
  }

  // Same-origin static assets → stale-while-revalidate
  if (url.origin === location.origin) {
    event.respondWith((async () => {
      const cache  = await caches.open(CORE);
      const cached = await cache.match(req);
      const fetchP = fetch(req).then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      return cached || (await fetchP) || new Response('Offline', { status: 503 });
    })());
    return;
  }

  // Three.js CDN (unpkg) — cache-first, these URLs are versioned
  if (url.hostname.endsWith('unpkg.com')) {
    event.respondWith((async () => {
      const cache  = await caches.open(RUNTIME);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch (_) {
        return new Response('Offline', { status: 503 });
      }
    })());
    return;
  }
  // anything else → straight network
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
