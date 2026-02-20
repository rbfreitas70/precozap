/**
 * PreçoZap Service Worker
 * Estratégia: Cache-first para assets, Network-first para APIs
 */

const CACHE_NAME   = 'precozap-v1';
const API_CACHE    = 'precozap-api-v1';
const OFFLINE_URL  = '/index.html';

// Assets que sempre ficam em cache (app shell)
const PRECACHE = [
  '/index.html',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
];

// ── INSTALL: pré-cacheia o app shell ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: limpa caches antigos ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== API_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH: estratégia por tipo de request ──
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Ignora requests não-HTTP (chrome-extension://, etc)
  if (!request.url.startsWith('http')) return;

  // API local do servidor de scraping → Network only (não cacheia)
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    return event.respondWith(fetch(request).catch(() =>
      new Response(JSON.stringify({ error: 'Servidor offline', ok: false }),
        { headers: { 'Content-Type': 'application/json' } })
    ));
  }

  // Overpass / Nominatim → Network-first, fallback cache (30min TTL)
  if (url.hostname.includes('openstreetmap') || url.hostname.includes('overpass-api') || url.hostname.includes('nominatim')) {
    return event.respondWith(networkFirstWithCache(request, API_CACHE, 30 * 60 * 1000));
  }

  // CDN externos (Leaflet, fontes) → Cache-first
  if (url.hostname.includes('unpkg.com') || url.hostname.includes('fonts.googleapis') || url.hostname.includes('fonts.gstatic')) {
    return event.respondWith(cacheFirst(request));
  }

  // App shell (index.html, manifest, icons) → Cache-first com revalidação
  if (url.origin === self.location.origin) {
    return event.respondWith(staleWhileRevalidate(request));
  }
});

// ── ESTRATÉGIAS ──

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

async function staleWhileRevalidate(request) {
  const cache  = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => cached);

  return cached || fetchPromise;
}

async function networkFirstWithCache(request, cacheName, ttlMs) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      // Armazena com timestamp no header customizado
      const headers = new Headers(response.headers);
      headers.set('sw-cached-at', Date.now().toString());
      const cloned = new Response(await response.clone().text(), {
        status: response.status, headers
      });
      cache.put(request, cloned);
      return response;
    }
    throw new Error('bad response');
  } catch {
    const cache  = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) {
      const cachedAt = parseInt(cached.headers.get('sw-cached-at') || '0');
      if (Date.now() - cachedAt < ttlMs) return cached;
    }
    return new Response(JSON.stringify({ error: 'offline', elements: [] }),
      { headers: { 'Content-Type': 'application/json' } });
  }
}

// ── BACKGROUND SYNC: fila de comparações offline ──
self.addEventListener('sync', event => {
  if (event.tag === 'sync-comparisons') {
    event.waitUntil(syncPendingComparisons());
  }
});

async function syncPendingComparisons() {
  // Notifica clientes que a sync aconteceu
  const clients = await self.clients.matchAll();
  clients.forEach(client => client.postMessage({ type: 'SYNC_COMPLETE' }));
}

// ── PUSH NOTIFICATIONS (base) ──
self.addEventListener('push', event => {
  const data = event.data?.json() || {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'PreçoZap ⚡', {
      body:    data.body || 'Novos preços disponíveis!',
      icon:    '/icons/icon-192x192.png',
      badge:   '/icons/icon-96x96.png',
      vibrate: [200, 100, 200],
      data:    { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data?.url || '/'));
});
