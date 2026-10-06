/* Service worker — red primero para la app (así las actualizaciones llegan al recargar),
   caché como respaldo sin conexión. */
const CACHE_VERSION = 'yt-castellano-v4';
const ASSETS = [
  './', './index.html', './styles.css', './app.js', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys
      .filter((k) => k !== CACHE_VERSION && k !== CACHE_VERSION + '-thumbs')
      .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'i.ytimg.com') {
    e.respondWith(
      caches.open(CACHE_VERSION + '-thumbs').then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res.ok || res.type === 'opaque') c.put(req, res.clone());
          return res;
        } catch (_) {
          return Response.error();
        }
      })
    );
    return;
  }
  if (url.origin !== self.location.origin) return;
  // red primero (sin caché HTTP), caché si no hay conexión
  e.respondWith(
    fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        const key = req.mode === 'navigate' ? './index.html' : req;
        caches.open(CACHE_VERSION).then((c) => c.put(key, copy));
      }
      return res;
    }).catch(async () => (await caches.match(req, { ignoreSearch: req.mode === 'navigate' }))
      || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()))
  );
});
