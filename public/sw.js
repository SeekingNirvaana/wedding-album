// App shell cached for instant, low-data repeat opens. API calls always go to the network.
const SHELL = 'wa-shell-v1';
const THUMBS = 'wa-thumbs-v1';
const ASSETS = ['/', '/index.html', '/css/app.css', '/js/app.js', '/js/core.js', '/js/i18n.js', '/js/gallery.js', '/js/uploader.js',
  '/js/imaging.js', '/js/camera.js', '/art/hero-kashi.webp', '/art/sangam-dawn.webp', '/manifest.webmanifest'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => ![SHELL, THUMBS].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/img/thumb/')) {
    // Thumbnails are private to this signed-in phone; cleared on sign-out
    e.respondWith(caches.open(THUMBS).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  if (url.pathname.startsWith('/img/')) return;
  e.respondWith(caches.open(SHELL).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then((res) => { if (res.ok) c.put(e.request, res.clone()); return res; }).catch(() => hit);
    return hit || fresh;
  }));
});
