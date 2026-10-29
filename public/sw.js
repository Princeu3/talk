// Push notifications only; no offline cache, so a deploy is never masked by a stale bundle.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (e) => {
  const data = e.data ? e.data.json() : { title: 'Talk', body: 'New message' }
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.convId,
      renotify: true,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { convId: data.convId },
    }),
  )
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const convId = e.notification.data?.convId
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const win = wins[0]
      if (win) {
        await win.focus()
        if (convId) win.postMessage({ convId })
      } else {
        await self.clients.openWindow(convId ? `/?c=${encodeURIComponent(convId)}` : '/')
      }
    })(),
  )
})
