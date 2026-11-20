/* Retired preview: unregister this worker and clear the preview caches. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('pfm-shell-2') || k.startsWith('pfm-next-')).map((k) => caches.delete(k))))
    .then(() => self.registration.unregister()));
});
