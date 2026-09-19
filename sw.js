const CACHE = 'reading-notebook-shell-v3-0';
const FILES = ['./','./index.html','./src/app.js','./src/core.js','./src/storage.js','./src/style.css','./src/config.js','./icon.svg','./manifest.json','./assets/room-empty.webp','./assets/paper.webp'];
self.addEventListener('install',event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))); });
self.addEventListener('activate',event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('reading-notebook-shell-') && k !== CACHE).map(k => caches.delete(k))))); });
self.addEventListener('fetch',event => {
  const url = new URL(event.request.url);
  url.hash = '';
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const known = FILES.map(f => new URL(f,self.registration.scope).href);
  if (!known.includes(url.href)) return;
  // Navigation updates online; the installed shell remains usable offline.
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(c => c.put(url.href,copy))); }
    return response;
  }).catch(async () => (await caches.match(url.href)) || (event.request.mode === 'navigate' ? await caches.match(new URL('./index.html',self.registration.scope).href) : Response.error())));
});
