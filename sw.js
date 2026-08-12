/* Оффлайн-кэш: оболочка + точки + тайлы уже просмотренных районов.
   Приложение для прогулки по городу, связь по дороге пропадает регулярно. */
const V     = 'pechati-v7';
const SHELL = `${V}-shell`;
const TILES = `${V}-tiles`;
const TILE_CAP = 900;

const ASSETS = [
  './', 'index.html', 'app.css', 'app.js',
  'data/points.json', 'manifest.webmanifest', 'icon.svg',
  'vendor/leaflet.js', 'vendor/leaflet.css',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => !k.startsWith(V)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trimTiles() {
  const c = await caches.open(TILES);
  const keys = await c.keys();
  if (keys.length > TILE_CAP) await Promise.all(keys.slice(0, keys.length - TILE_CAP).map(k => c.delete(k)));
}

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;                    // POST /api/suggest — всегда в сеть
  const url = new URL(request.url);

  if (url.pathname.startsWith('/api/')) return;

  if (/basemaps\.cartocdn\.com/.test(url.hostname)) {      // тайлы: сначала кэш
    e.respondWith((async () => {
      const c = await caches.open(TILES);
      const hit = await c.match(request);
      if (hit) return hit;
      try {
        const res = await fetch(request);
        if (res.ok) { c.put(request, res.clone()); trimTiles(); }
        return res;
      } catch { return new Response('', { status: 504 }); }
    })());
    return;
  }

  if (url.origin !== location.origin) return;

  e.respondWith((async () => {                             // статика: сеть, откат в кэш
    const c = await caches.open(SHELL);
    try {
      const res = await fetch(request);
      if (res.ok) c.put(request, res.clone());
      return res;
    } catch {
      return (await c.match(request)) || (await c.match('index.html')) ||
             new Response('Оффлайн', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
