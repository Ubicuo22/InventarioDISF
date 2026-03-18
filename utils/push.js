/**
 * DISFRULEG BODEGA — Helper compartido de Web Push
 *
 * Exporta enviarATodos() para que cualquier ruta pueda
 * disparar notificaciones push sin duplicar lógica.
 */

const webpush = require('web-push')
const { pool }  = require('../db/pool')

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
 * @param {{ title: string, body?: string, icon?: string, url?: string }} payload
 * @returns {{ enviados: number, total: number }}
 */
async function enviarATodos(payload) {
  inicializarVapid()

  const [subs] = await pool.query(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE activo = 1'
  )
  if (!subs.length) return { enviados: 0, total: 0 }

  const payloadStr = JSON.stringify(payload)
  let enviados = 0

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payloadStr
        )
        enviados++
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await pool.query(
            'UPDATE push_subscriptions SET activo = 0 WHERE id = ?',
            [sub.id]
          )
          console.log(`[push] Sub ${sub.id} desactivada (endpoint expirado)`)
        } else {
          console.error(`[push] Error en sub ${sub.id}:`, err.message)
        }
      }
    })
  )

  return { enviados, total: subs.length }
}

module.exports = { enviarATodos }
