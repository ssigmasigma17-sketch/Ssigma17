// Lets the dashboard open without internet. The page and events.json: network first, the last copy offline.
// The fonts are served with the page. Live sources (NEPTUN, the Worker) are not cached here; the page keeps their last data itself.
const CACHE = 'dash-v2';
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', 'index.html', 'fonts/manrope-latin.woff2', 'fonts/manrope-cyrillic.woff2'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('dash-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.origin === location.origin && url.pathname.startsWith(new URL('./', location).pathname)) {
    const key = url.origin + url.pathname; // events.json?t=… is one entry
    if (url.pathname.includes('/fonts/')) { e.respondWith(caches.match(key).then(r => r || fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); return res; }))); return; }
    e.respondWith(fetch(req, { cache: 'no-store' })
      .then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); } return res; })
      .catch(() => caches.match(key).then(r => r || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
  }
});
