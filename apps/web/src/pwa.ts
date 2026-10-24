// Service worker registration (RV-018).
//
// Production only. The dev server serves modules straight off disk and runs
// HMR over its own endpoints; a worker sitting in front of that would at best
// do nothing and at worst serve a reader their own stale bundle while they are
// trying to see a change.
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;
  // Registration is deliberately after load: it competes with the first render
  // for the network otherwise, and nothing on the first visit depends on it.
  addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // A failed registration is not worth bothering the reader about — the
      // site works without it. It is only the offline shell that is lost.
    });
  });
}

/** Stop the service worker and drop its caches, for the case where a caching
 *  rule turns out to be wrong in production. Exposed on `window` so it can be
 *  run from a device's console without shipping a build. */
export function installServiceWorkerEscapeHatch(): void {
  if (!('serviceWorker' in navigator)) return;
  (globalThis as unknown as { unregisterServiceWorker?: () => Promise<void> })
    .unregisterServiceWorker = async () => {
      navigator.serviceWorker.controller?.postMessage('unregister');
      for (const registration of await navigator.serviceWorker.getRegistrations()) {
        await registration.unregister();
      }
      if ('caches' in globalThis) {
        await Promise.all((await caches.keys()).map((key) => caches.delete(key)));
      }
      location.reload();
    };
}
