// Сайт відкривається і без інтернету: сторінка з кешу, шрифти з кешу. Броні (/api) завжди з мережі.
const VERSION = '8b-v1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'data.js', 'manifest.webmanifest', 'icons/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  // кеш спільний для всього домену, тож чистимо лише свої старі версії
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('8b-') && k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // шрифти Google не змінюються: спершу кеш
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(VERSION).then(c => c.put(e.request, copy));
      return res;
    })));
    return;
  }
  if (url.origin !== location.origin || url.pathname.includes('/api/')) return;
  // свої файли: спершу мережа, щоб оновлення приходили одразу
  e.respondWith(fetch(e.request, { cache: 'no-store' })
    .then(res => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); } return res; })
    .catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
});
