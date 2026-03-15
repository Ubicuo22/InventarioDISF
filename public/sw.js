/**
 * DISFRULEG BODEGA — Service Worker
 * Maneja notificaciones push en segundo plano.
 */

const CACHE_NAME = 'disfruleg-bodega-v1'

// ── Instalación ──────────────────────────────────────────────
self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

// ── Push recibido ────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = { title: 'Disfruleg Bodega', body: 'Nueva notificación', icon: '/assets/icon.png' }

  if (event.data) {
    try {
      data = { ...data, ...event.data.json() }
    } catch (e) {
      data.body = event.data.text()
    }
  }

  const options = {
    body:    data.body,
    icon:    data.icon || '/assets/icon.png',
    badge:   '/assets/icon.png',
    silent:  false,
    vibrate: [200, 100, 200],
    data:    { url: data.url || '/' }
  }

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  )
})

// ── Click en la notificación ─────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  // Enfoca la app si ya está abierta, o la abre en segundo plano
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus()
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow('/')
      }
    })
  )
})
