// Service worker (RV-018). App shell only — chapter content stays online.
// Downloading chapters for offline reading is ER-007 and has undecided policy
// (what happens to a downloaded chapter when the work is unpublished, who may
// download what, how much space). Nothing here pre-empts any of it.
//
// A service worker is the hardest thing on a site to take back: a wrong
// caching rule leaves readers pinned to a stale build with no way out that
// they would ever think of. So this one is deliberately small, and every rule
// below says why it is safe rather than why it is fast.

const VERSION = 'v1';
const SHELL = `shell-${VERSION}`;
const ASSETS = `assets-${VERSION}`;

// Vite emits content-hashed filenames under /assets/, which nginx already
// serves as `immutable` (ops/nginx/ebook.conf). A hashed name never changes
// meaning, so cache-first here agrees with that header instead of inventing a
// second, conflicting policy.
const isImmutableAsset = (url) => url.pathname.startsWith('/assets/');

// Everything personal and everything writable. A cached /api/me/progress is
// the single worst bug this file could ship: the reader sees a position from
// three days ago and no amount of reloading fixes it, because the stale copy
// is on their device.
const isApi = (url) => url.pathname.startsWith('/api/');

self.addEventListener('install', (event) => {
  // The shell is cached on first navigation rather than precached: without a
  // build step injecting the hashed asset list, a precache list would be a
  // hand-maintained lie.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL, ASSETS]);
    await Promise.all((await caches.keys()).map((key) => (keep.has(key) ? null : caches.delete(key))));
    // Take over open tabs immediately. Old pages keep working because their
    // assets are content-hashed and still cached under their own names.
    await self.clients.claim();
  })());
});

// Escape hatch. If a rule here turns out to be wrong in production, this is
// how a release stops the bleeding without asking readers to clear storage:
//   navigator.serviceWorker.controller.postMessage('unregister')
self.addEventListener('message', (event) => {
  if (event.data !== 'unregister') return;
  event.waitUntil((async () => {
    await Promise.all((await caches.keys()).map((key) => caches.delete(key)));
    await self.registration.unregister();
    for (const client of await self.clients.matchAll()) client.navigate(client.url);
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isApi(url)) return;                      // never, under any condition

  if (request.mode === 'navigate') {
    // Network first: index.html is `no-cache` at the edge precisely so a new
    // build reaches readers immediately, and a service worker that answered
    // from cache would quietly undo that. The cached copy exists only for the
    // offline case, where the alternative is the browser's error page.
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        const cache = await caches.open(SHELL);
        cache.put('/index.html', response.clone());
        return response;
      } catch {
        return (await caches.match('/index.html'))
          ?? Response.error();
      }
    })());
    return;
  }

  if (isImmutableAsset(url)) {
    event.respondWith((async () => {
      const hit = await caches.match(request);
      if (hit) return hit;
      const response = await fetch(request);
      // Opaque and error responses are not worth keeping: a cached 404 for a
      // hashed asset would survive the deploy that fixes it.
      if (response.ok && response.type === 'basic') {
        (await caches.open(ASSETS)).put(request, response.clone());
      }
      return response;
    })());
  }
  // Everything else (icons, manifest, robots.txt, sitemaps) falls through to
  // the network and to nginx's own cache headers. They are small, they change
  // on their own schedule, and none of them is worth a second policy.
});
