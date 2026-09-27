/* HotPulse Service Worker：接收 Web Push 并展示系统通知 */
self.addEventListener('push', (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    data = { title: 'HotPulse', body: e.data?.text() || '' };
  }
  const opts = {
    body: data.body || '',
    tag: String(data.id || Date.now()),
    data: { url: data.link || '/' },
    icon: '/icon.svg',
    badge: '/icon.svg',
  };
  e.waitUntil(self.registration.showNotification(data.title || 'HotPulse 热点雷达', opts));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          c.navigate(url);
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
