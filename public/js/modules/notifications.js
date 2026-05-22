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
      // Guarda de idempotencia: si ya se inicializó (o está en curso) no
      // repetimos el sync. Evita POSTs duplicados a /suscribir si initPush
      // se llama dos veces seguidas (cargarTodo, login + reload, etc.).
      if (this._pushIniciado) return
      this._pushIniciado = true

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

        // Escuchar instrucciones de navegación del SW (click en notificación con app abierta)
        navigator.serviceWorker.addEventListener('message', (event) => {
          if (event.data?.type === 'NAVIGATE_TAB' && event.data?.tab) {
            this.tab = event.data.tab
            // Si estamos en home, mostrar la sección directamente
            if (event.data.tab !== 'home') {
              // Cargar datos del módulo al que navegamos
              if (event.data.tab === 'pedidos')    this.cargarOrdenes?.()
              if (event.data.tab === 'entradas')   this.cargarEntradasRecientes?.()
              if (event.data.tab === 'inventario') this.cargarProductos?.()
            }
          }
        })

        // Verificar si ya hay suscripción activa
        const sub = await reg.pushManager.getSubscription()
        this.pushSuscrito = !!sub

        console.log('[push] SW registrado. Suscrito:', this.pushSuscrito)

        // Sincronizar suscripción local al servidor (por si falló al guardar antes)
        // Incluye JWT para que el servidor pueda desactivar suscripciones antiguas del mismo usuario
        if (sub) {
          const subJson = sub.toJSON()
          const token = localStorage.getItem('bodega_token') || ''
          fetch('/api/notificaciones/suscribir', {
            method:  'POST',
            headers: {
              'Content-Type':  'application/json',
              ...(token ? { 'Authorization': `Bearer ${token}` } : {})
            },
            body:    JSON.stringify({ endpoint: subJson.endpoint, keys: subJson.keys })
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

        // 4. Guardar suscripción en el servidor (incluye JWT para limpiar subs antiguas)
        const subJson = sub.toJSON()
        const token = localStorage.getItem('bodega_token') || ''
        const saveRes = await fetch('/api/notificaciones/suscribir', {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
          },
          body:    JSON.stringify({ endpoint: subJson.endpoint, keys: subJson.keys })
        }).then(r => r.json())
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
        if (sub) {
          const endpoint = sub.endpoint  // capturar antes de desuscribir
          await sub.unsubscribe()
          // Marcar inactiva en el servidor — best-effort
          const token = localStorage.getItem('bodega_token') || ''
          fetch('/api/notificaciones/desuscribir', {
            method:  'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { 'Authorization': `Bearer ${token}` } : {})
            },
            body: JSON.stringify({ endpoint })
          }).catch(() => {})
        }
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
