/**
 * DISFRULEG BODEGA — Notificaciones Push
 *
 * POST /api/notificaciones/suscribir      — el iPhone se registra (requiere JWT)
 * POST /api/notificaciones/nuevo-pedido   — Electron avisa pedido nuevo (requiere NOTIF_SECRET)
 * POST /api/notificaciones/pedido-procesado — Electron avisa venta procesada (requiere NOTIF_SECRET)
 * GET  /api/notificaciones/vapid-key      — devuelve la clave pública VAPID (pública, sin auth)
 */

const express  = require('express')
const webpush  = require('web-push')
const router   = express.Router()
const { requireAuth } = require('../middleware/auth')
const { pool }  = require('../db/pool')

// ── Inicializar VAPID (lazy — al primer uso, no al cargar el módulo) ─
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

// ── Helper: obtener todas las suscripciones activas ──────────
async function getSuscripciones() {
  const [rows] = await pool.query(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE activo = 1'
  )
  return rows
}

// ── Helper: enviar push a todos los dispositivos ─────────────
async function enviarATodos(payload) {
  inicializarVapid()
  const suscripciones = await getSuscripciones()
  if (!suscripciones.length) return { enviados: 0 }

  const payloadStr = JSON.stringify(payload)
  let enviados = 0

  await Promise.allSettled(
    suscripciones.map(async (sub) => {
      const subscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth }
      }
      try {
        await webpush.sendNotification(subscription, payloadStr)
        enviados++
      } catch (err) {
        // Si el endpoint ya no es válido (410 Gone), lo desactivamos
        if (err.statusCode === 410 || err.statusCode === 404) {
          await pool.query(
            'UPDATE push_subscriptions SET activo = 0 WHERE id = ?',
            [sub.id]
          )
          console.log(`[push] Suscripción ${sub.id} desactivada (endpoint expirado)`)
        } else {
          console.error(`[push] Error enviando a sub ${sub.id}:`, err.message)
        }
      }
    })
  )

  return { enviados, total: suscripciones.length }
}

// ── Middleware: verificar NOTIF_SECRET para llamadas de Electron ──
function requireNotifSecret(req, res, next) {
  const secret = req.headers['x-notif-secret'] || req.body?.secret
  if (!secret || secret !== process.env.NOTIF_SECRET) {
    return res.status(401).json({ ok: false, error: 'No autorizado' })
  }
  next()
}

// ════════════════════════════════════════════════════════════
// GET /api/notificaciones/vapid-key
// Devuelve la VAPID public key para que el frontend se suscriba
// ════════════════════════════════════════════════════════════
router.get('/vapid-key', (req, res) => {
  res.json({ ok: true, key: process.env.VAPID_PUBLIC_KEY })
})

// ════════════════════════════════════════════════════════════
// POST /api/notificaciones/suscribir
// El iPhone registra su suscripción push (requiere JWT)
// Body: { endpoint, keys: { p256dh, auth } }
// ════════════════════════════════════════════════════════════
router.post('/suscribir', async (req, res) => {
  try {
    const { endpoint, keys } = req.body
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ ok: false, error: 'Suscripción inválida' })
    }

    // Upsert: si el endpoint ya existe, solo lo reactiva
    const [existing] = await pool.query(
      'SELECT id FROM push_subscriptions WHERE endpoint = ?',
      [endpoint]
    )

    if (existing.length > 0) {
      await pool.query(
        'UPDATE push_subscriptions SET p256dh = ?, auth = ?, activo = 1 WHERE endpoint = ?',
        [keys.p256dh, keys.auth, endpoint]
      )
    } else {
      await pool.query(
        'INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)',
        [endpoint, keys.p256dh, keys.auth]
      )
    }

    console.log('[push] Nueva suscripción registrada')
    res.json({ ok: true })
  } catch (e) {
    console.error('[notificaciones] POST /suscribir', e.message)
    res.status(500).json({ ok: false, error: 'Error al registrar suscripción' })
  }
})

// ════════════════════════════════════════════════════════════
// POST /api/notificaciones/nuevo-pedido
// Electron llama esto cuando guarda un nuevo pedido
// Body: { secret, cliente, folio }
// ════════════════════════════════════════════════════════════
router.post('/nuevo-pedido', requireNotifSecret, async (req, res) => {
  try {
    const { cliente, folio, usuario } = req.body
    const folioStr   = folio   ? ` · #${String(folio).padStart(4, '0')}` : ''
    const usuarioStr = usuario ? ` · ${usuario}` : ''

    const result = await enviarATodos({
      title: '📦 Pedido nuevo',
      body:  `${cliente || 'Sin cliente'}${folioStr}${usuarioStr}`,
      icon:  '/assets/icon.png'
    })

    console.log(`[push] Pedido nuevo notificado — ${result.enviados}/${result.total} dispositivos`)
    res.json({ ok: true, ...result })
  } catch (e) {
    console.error('[notificaciones] POST /nuevo-pedido', e.message)
    res.status(500).json({ ok: false, error: 'Error al enviar notificación' })
  }
})

// ════════════════════════════════════════════════════════════
// POST /api/notificaciones/pedido-procesado
// Electron llama esto cuando procesa la venta (genera jnota)
// Body: { secret, cliente, folio }
// ════════════════════════════════════════════════════════════
router.post('/pedido-procesado', requireNotifSecret, async (req, res) => {
  try {
    const { cliente, folio, usuario } = req.body
    const folioStr   = folio   ? ` · #${String(folio).padStart(4, '0')}` : ''
    const usuarioStr = usuario ? ` · ${usuario}` : ''

    const result = await enviarATodos({
      title: '💰 Pedido procesado',
      body:  `${cliente || 'Sin cliente'}${folioStr}${usuarioStr}`,
      icon:  '/assets/icon.png'
    })

    console.log(`[push] Pedido procesado notificado — ${result.enviados}/${result.total} dispositivos`)
    res.json({ ok: true, ...result })
  } catch (e) {
    console.error('[notificaciones] POST /pedido-procesado', e.message)
    res.status(500).json({ ok: false, error: 'Error al enviar notificación' })
  }
})

module.exports = router
