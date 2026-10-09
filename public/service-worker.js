const CACHE_NAME = 'ncgg-dashboard-shell-v2';
const APP_SHELL = [
    '/',
    '/index.html',
    '/styles.css',
    '/offline-store.js',
    '/app.js',
    '/images/ncgg-logo.jpg'
];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => Promise.all(
            keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
        ))
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

    if (request.mode === 'navigate') {
        event.respondWith((async () => {
            try {
                const response = await fetch(request);
                if (response.ok) {
                    await (await caches.open(CACHE_NAME)).put('/', response.clone());
                }
                return response;
            } catch {
                return (await caches.match(request)) || (await caches.match('/')) || Response.error();
            }
        })());
        return;
    }

    event.respondWith((async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) await (await caches.open(CACHE_NAME)).put(request, response.clone());
        return response;
    })());
});
