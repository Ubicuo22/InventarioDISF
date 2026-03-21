/**
 * DISFRULEG BODEGA — Helper compartido de Web Push
 *
 * Exporta enviarATodos() para que cualquier ruta pueda
 * disparar notificaciones push sin duplicar lógica.
 *
 * Cleanup automático de suscripciones:
 *   - 410 / 404 → endpoint expirado, se desactiva
 *   - 401 / 403 → credenciales inválidas, se desactiva
 *   - Otros errores → se registra pero NO se desactiva (podría ser transitorio)
 */

const webpush = require('web-push')
const { pool }  = require('../db/pool')

// Códigos HTTP de Apple/Google que indican suscripción inválida de forma permanente
const EXPIRED_CODES = new Set([401, 403, 404, 410])

let vapidInicializado = false

function inicializarVapid() {
  if (vapidInicializado) return
  if (!process.env.VAPID_EMAIL || !process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    throw new Error('Faltan variables VAPID_EMAIL, VAPID_PUBLIC_KEY o VAPID_PRIVATE_KEY')
  }
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  )
  vapidInicializado = true
}

/**
 * Envía un push a todos los dispositivos activos.
 * @param {{ title: string, body?: string, icon?: string, tag?: string, url?: string }} payload
 * @returns {{ enviados: number, total: number, fallidos: number }}
 */
async function enviarATodos(payload) {
  inicializarVapid()

  const [subs] = await pool.query(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE activo = 1'
  )
  if (!subs.length) return { enviados: 0, total: 0, fallidos: 0 }

  const payloadStr = JSON.stringify(payload)
  let enviados = 0
  let fallidos = 0

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payloadStr,
          { TTL: 3600 }  // expira en 1h si el dispositivo está offline
        )
        enviados++
      } catch (err) {
        fallidos++
        const code = err.statusCode

        if (EXPIRED_CODES.has(code)) {
          // Suscripción permanentemente inválida → desactivar
          try {
            await pool.query(
              'UPDATE push_subscriptions SET activo = 0 WHERE id = ?',
              [sub.id]
            )
            console.log(`[push] Sub ${sub.id} desactivada (HTTP ${code})`)
          } catch (dbErr) {
            console.error(`[push] Error desactivando sub ${sub.id}:`, dbErr.message)
          }
        } else {
          // Error transitorio (red, servidor push sobrecargado, etc.) → mantener suscripción
          console.warn(`[push] Sub ${sub.id} falló transitoriamente (HTTP ${code ?? 'N/A'}): ${err.message}`)
        }
      }
    })
  )

  return { enviados, total: subs.length, fallidos }
}

module.exports = { enviarATodos }
