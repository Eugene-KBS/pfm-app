/* 收支帳 v2 service worker: caches the app shell only (never the encrypted data or API calls), shows push
   notifications, opens the right screen when one is tapped, and sets the app badge. */
const CACHE = 'pfm-shell-2.0.0-1';
const ASSETS = ['./', 'index.html', 'css/app.css', 'js/main.js', 'js/util.js', 'js/crypto.js', 'js/data.js', 'js/charts.js', 'js/sheet.js',
  'js/actions.js', 'js/overview.js', 'js/tx.js', 'js/stocks.js', 'js/plan.js', 'js/settings.js', 'manifest.webmanifest',
  'demo-data.json', 'demo-prices.json', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS))); });
self.addEventListener('message', (e) => { if (e.data && e.data.type === 'skip') self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k.startsWith('pfm-shell-2')).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== self.location.origin || !u.pathname.startsWith(new URL('./', self.registration.scope).pathname)) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: '收支帳', body: e.data ? e.data.text() : '' }; }
  const title = d.title || '收支帳';
  const opts = { body: d.body || '', tag: d.tag || 'pfm', renotify: true, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
    data: { url: d.url || './', gen: d.gen || '' } };
  const jobs = [self.registration.showNotification(title, opts)];          // iOS requires a visible notification for every push
  if (typeof d.badge === 'number' && self.navigator && 'setAppBadge' in self.navigator) {
    jobs.push((d.badge ? self.navigator.setAppBadge(d.badge) : self.navigator.clearAppBadge()).catch(() => {}));
  }
  e.waitUntil(Promise.all(jobs));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope);
  const go = target.searchParams.get('go');
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    for (const c of cs) {
      if (c.url.startsWith(self.registration.scope)) { if (go) c.postMessage({ go }); return c.focus(); }
    }
    return self.clients.openWindow(target.href);
  }));
});
