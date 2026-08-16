/*
 * Lost Pines Creative — service worker
 *
 * The site argues that the tools you depend on should keep working when the
 * systems around them don't. This makes the site itself hold to that: once
 * visited, it loads with the network off, on a dead connection, or on a
 * connection slow enough that waiting would be the same as failing.
 *
 * Strategy:
 *   navigations  -> network-first with a short timeout, falling back to cache
 *                   (fresh content when online, instant content when not)
 *   everything    -> stale-while-revalidate
 *     else          (instant from cache, refreshed quietly in the background)
 */

const VERSION = 'v6';
const PRECACHE = `lpc-precache-${VERSION}`;
const RUNTIME = `lpc-runtime-${VERSION}`;

/* A slow network is a failed network. Stop waiting and serve the cache. */
const NETWORK_TIMEOUT_MS = 4000;

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/terms.html',
  '/manifest.webmanifest',
  '/lostpines.png',
  '/headshot.jpg',
  '/work-led-sign.webp',
  '/work-mandala.webp',
  '/work-cad.webp',
  '/work-feeder.webp',
  '/work-dragon.webp',
  '/work-texas.webp',
  '/nomadcore-screen.webp',
  '/rememberwho-screen.webp',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
  '/favicon-32.png',
  '/favicon-16.png',
];

/* Search Console verification must always hit the network. */
const NEVER_CACHE = ['/google0f174fbb9e565477.html'];

self.addEventListener('install', event => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(key => key !== PRECACHE && key !== RUNTIME)
            .map(key => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE.includes(url.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(event));
  } else {
    event.respondWith(staleWhileRevalidate(event));
  }
});

/*
 * Precache each URL independently. cache.addAll() rejects the whole install if
 * any single request fails, which would leave the site with no offline support
 * because one image 404'd. Anything missed here is picked up at runtime.
 */
async function precache() {
  const cache = await caches.open(PRECACHE);

  await Promise.all(
    PRECACHE_URLS.map(async url => {
      try {
        const response = await fetch(new Request(url, { cache: 'reload' }));
        if (response.ok) await cache.put(url, response);
      } catch (_) {
        /* Left uncached; runtime caching will pick it up on first use. */
      }
    })
  );
}

async function networkFirst(event) {
  const request = event.request;
  const cache = await caches.open(RUNTIME);

  try {
    const response = await withTimeout(fetch(request), NETWORK_TIMEOUT_MS);
    if (response && response.ok) {
      event.waitUntil(cache.put(request, response.clone()));
    }
    return response;
  } catch (_) {
    const cached =
      (await caches.match(request)) ||
      (await caches.match('/index.html')) ||
      (await caches.match('/'));

    if (cached) return cached;

    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Offline</title>' +
        '<body style="background:#0b1210;color:#e2e8e6;font-family:system-ui,sans-serif;' +
        'display:grid;place-items:center;height:100vh;margin:0;text-align:center">' +
        '<p>This page hasn’t been visited yet, so there’s no offline copy.<br>' +
        'Reconnect and try again.</p>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

async function staleWhileRevalidate(event) {
  const request = event.request;
  const cache = await caches.open(RUNTIME);
  const cached = await caches.match(request);

  const network = fetch(request)
    .then(response => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  if (cached) {
    /* Keep the worker alive long enough to finish refreshing in the background. */
    event.waitUntil(network);
    return cached;
  }

  const response = await network;
  return response || Response.error();
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('network timeout')), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
