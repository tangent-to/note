/* eslint-env serviceworker */
/**
 * The offline cache.
 *
 * Cells load their libraries from a CDN at run time — `import "d3"` becomes a
 * request to jsDelivr, jmon fetches its own packages and its soundfonts — so a
 * notebook that runs perfectly today does not run at all on a train. Nothing in
 * the app can fix that by rewriting imports: a library builds its own URLs while
 * it runs (`${CDN}/${name}@${ref}`), and code that has not run yet cannot be
 * rewritten. A service worker sits below all of it, at the network, and sees
 * every request the page and its workers make, whoever built the URL.
 *
 * Two caches, because the two have different truths:
 *
 * - **The app** (same origin). Its assets carry a hash in the name, so a cached
 *   one is never stale: served from cache first, which also means the app opens
 *   with no network at all. The page itself is fetched fresh when possible, so a
 *   rebuilt app is picked up on the next load.
 * - **Everything else** (a CDN, a soundfont). Network first while there is a
 *   network — this is the unfrozen mode, where a notebook follows what its
 *   imports resolve to today — and the stored copy when there is not. Freezing
 *   (a later step) will invert this for the versions a notebook is pinned to.
 *
 * Requests that are not plain GETs, or that ask for a byte range, are passed
 * straight through: a partial response is not a copy of anything.
 */

const VERSION = 'v1';
const APP_CACHE = `tangent-app-${VERSION}`;
const REMOTE_CACHE = `tangent-remote-${VERSION}`;
const KEEP = new Set([APP_CACHE, REMOTE_CACHE]);

/**
 * Put the app itself in the cache, at install.
 *
 * It cannot be a fixed list: the file names carry build hashes this file does
 * not know. So the page is fetched and its own asset links are read out of it.
 * Waiting for a later visit to fill the cache does not work either — the very
 * first navigation happens before any worker controls the page, so the page
 * would be the one thing missing when the network goes away.
 */
async function cacheAppShell() {
  const cache = await caches.open(APP_CACHE);
  const response = await fetch('/', { cache: 'reload' });
  if (!response.ok) return;
  const html = await response.clone().text();
  await cache.put('/', response);
  const assets = [...new Set(html.match(/\/assets\/[A-Za-z0-9._-]+/g) ?? [])];
  await Promise.all(
    assets.map(async (path) => {
      try {
        const asset = await fetch(path, { cache: 'reload' });
        if (asset.ok) await cache.put(path, asset);
      } catch {
        // One missing asset must not fail the install; it is fetched later.
      }
    })
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(cacheAppShell().catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('tangent-') && !KEEP.has(name)) await caches.delete(name);
      }
      await self.clients.claim();
    })()
  );
});

/** The companion's own endpoints: live state and the reader's files, never cached. */
function isCompanion(url) {
  return url.pathname === '/__sync' || url.pathname.startsWith('/__files/');
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    // Opaque responses (status 0) are cached too: they cannot be read here, but
    // the browser can still replay them, which is what offline needs.
    if (response.ok || response.type === 'opaque') await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('range')) return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  const sameOrigin = url.origin === self.location.origin;
  if (sameOrigin && isCompanion(url)) return;

  if (sameOrigin) {
    // Hashed assets never change under their name; the page might.
    const hashed = /\/assets\/.+\.[A-Za-z0-9_-]{8,}\.(js|css|svg|woff2?|png|jpg|webp)$/.test(url.pathname);
    event.respondWith(hashed ? cacheFirst(request, APP_CACHE) : networkFirst(request, APP_CACHE));
    return;
  }

  event.respondWith(networkFirst(request, REMOTE_CACHE));
});

/** What the Storage panel asks about the cache, and what it asks it to do. */
self.addEventListener('message', (event) => {
  const { type } = event.data ?? {};
  const reply = (payload) => event.source?.postMessage({ type: `${type}:result`, ...payload });

  if (type === 'cache-stats') {
    event.waitUntil(
      (async () => {
        const counts = {};
        for (const name of [APP_CACHE, REMOTE_CACHE]) {
          counts[name === APP_CACHE ? 'app' : 'remote'] = (await (await caches.open(name)).keys()).length;
        }
        reply(counts);
      })()
    );
  } else if (type === 'cache-clear') {
    event.waitUntil(
      (async () => {
        // Only what was fetched from elsewhere: clearing the app's own files
        // would leave the reader offline with nothing to open.
        await caches.delete(REMOTE_CACHE);
        reply({ cleared: true });
      })()
    );
  }
});
