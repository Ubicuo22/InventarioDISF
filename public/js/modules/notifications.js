/**
 * DISFRULEG BODEGA — Módulo de Notificaciones Push
 *
 * Maneja el registro del Service Worker y la suscripción push.
 * Se inicializa automáticamente al cargar la app (initPush).
 */

function notificationsModule() {
  return {
    // ── Estado ────────────────────────────────────────────────
    pushSoportado:    false,   // El navegador soporta Web Push
    pushPermiso:      'default', // 'default' | 'granted' | 'denied'
    pushSuscrito:     false,   // Ya tiene suscripción activa
    pushCargando:     false,   // Procesando solicitud de suscripción

    // ── Inicialización (llamar tras login) ────────────────────
    async initPush() {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        console.log('[push] No soportado en este navegador')
        this.pushSoportado = false
        return
      }
      this.pushSoportado  = true
      this.pushPermiso    = Notification.permission

      try {
        // Registrar service worker
        const reg = await navigator.serviceWorker.register('/sw.js')
        await navigator.serviceWorker.ready

        // Verificar si ya hay suscripción activa
        const sub = await reg.pushManager.getSubscription()
        this.pushSuscrito = !!sub

        console.log('[push] SW registrado. Suscrito:', this.pushSuscrito)

        // Sincronizar suscripción local al servidor (por si falló al guardar antes)
        // El token está en localStorage, no como propiedad del objeto Alpine
        if (sub && localStorage.getItem('bodega_token')) {
          const subJson = sub.toJSON()
          API.post('/api/notificaciones/suscribir', {
            endpoint: subJson.endpoint,
            keys:     subJson.keys
          }).catch(() => {}) // best-effort, no bloquea
        }
      } catch (e) {
        console.warn('[push] Error al registrar SW:', e.message)
      }
    },

    // ── Activar notificaciones ────────────────────────────────
    async activarNotificaciones() {
      if (!this.pushSoportado || this.pushCargando) return
      this.pushCargando = true
      try {
        // 1. Pedir permiso al usuario
        const permiso = await Notification.requestPermission()
        this.pushPermiso = permiso
        if (permiso !== 'granted') {
          this.mostrarToast('Permiso de notificaciones denegado', true)
          return
        }

        // 2. Obtener VAPID public key del servidor
        const keyRes = await API.get('/api/notificaciones/vapid-key')
        if (!keyRes.ok) throw new Error('No se pudo obtener la clave VAPID')
        const vapidKey = urlBase64ToUint8Array(keyRes.key)

        // 3. Suscribirse al push manager
        const reg = await navigator.serviceWorker.ready
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly:      true,
          applicationServerKey: vapidKey
        })

        // 4. Guardar suscripción en el servidor
        const subJson = sub.toJSON()
        const saveRes = await API.post('/api/notificaciones/suscribir', {
          endpoint: subJson.endpoint,
          keys:     subJson.keys
        })
        if (!saveRes.ok) throw new Error('No se pudo guardar la suscripción')

        this.pushSuscrito = true
        this.mostrarToast('Notificaciones activadas')
        console.log('[push] Suscripción guardada correctamente')
      } catch (e) {
        console.error('[push] Error al activar:', e.message)
        this.mostrarToast('Error al activar notificaciones', true)
      } finally {
        this.pushCargando = false
      }
    },

    // ── Desactivar notificaciones ─────────────────────────────
    async desactivarNotificaciones() {
      if (!this.pushSoportado || this.pushCargando) return
      this.pushCargando = true
      try {
        const reg = await navigator.serviceWorker.ready
        const sub = await reg.pushManager.getSubscription()
        if (sub) await sub.unsubscribe()
        this.pushSuscrito = false
        this.mostrarToast('Notificaciones desactivadas')
      } catch (e) {
        console.error('[push] Error al desactivar:', e.message)
        this.mostrarToast('Error al desactivar notificaciones', true)
      } finally {
        this.pushCargando = false
      }
    }
  }
}

// ── Utilidad: convierte VAPID key de base64url a Uint8Array ──
function urlBase64ToUint8Array(base64String) {
  const padding  = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64   = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData  = atob(base64)
  return new Uint8Array([...rawData].map(c => c.charCodeAt(0)))
}
