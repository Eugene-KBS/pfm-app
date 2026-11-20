/* The preview at next/ is retired: remove its service worker so it stops caching or receiving pushes here. */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => { if (r.scope.endsWith('/next/')) r.unregister(); })).catch(() => {});
}
