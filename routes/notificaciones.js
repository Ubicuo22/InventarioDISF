/**
 * DISFRULEG BODEGA — Notificaciones Push
 *
 * GET  /api/notificaciones/vapid-key    — clave pública VAPID (pública)
 * POST /api/notificaciones/suscribir    — registrar dispositivo
 * POST /api/notificaciones/desuscribir  — dar de baja dispositivo
 * POST /api/notificaciones/nueva-version — deploy-update.js avisa nueva versión (requiere NOTIF_SECRET)
 *
 * El resumen diario de operaciones (pedidos, compras, mermas, stock)
 * se envía automáticamente a las 20:00 desde utils/resumen-diario.js
 */

const express  = require('express')
const router   = express.Router()
const { pool }  = require('../db/pool')
const { enviarATodos } = require('../utils/push')
const jwt      = require('jsonwebtoken')

// ── Middleware: verificar NOTIF_SECRET para llamadas de deploy ──
function requireNotifSecret(req, res, next) {
  const secret = req.headers['x-notif-secret'] || req.body?.secret
  if (!secret || secret !== process.env.NOTIF_SECRET) {
    return res.status(401).json({ ok: false, error: 'No autorizado' })
  }
  next()
}

// ════════════════════════════════════════════════════════════
// GET /api/notificaciones/vapid-key
// ════════════════════════════════════════════════════════════
router.get('/vapid-key', (req, res) => {
  res.json({ ok: true, key: process.env.VAPID_PUBLIC_KEY })
})

// ════════════════════════════════════════════════════════════
// POST /api/notificaciones/suscribir
// ════════════════════════════════════════════════════════════
router.post('/suscribir', async (req, res) => {
  try {
    const { endpoint, keys } = req.body
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ ok: false, error: 'Suscripción inválida' })
    }

    let userId = null
    const authHeader = req.headers.authorization || ''
    if (authHeader.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET)
        userId = decoded?.id_usuario ?? decoded?.id ?? null
      } catch {}
    }

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

    if (userId) {
      try {
        await pool.query(
          'UPDATE push_subscriptions SET activo = 0 WHERE endpoint != ? AND activo = 1 AND user_id = ?',
          [endpoint, userId]
        )
        await pool.query(
          'UPDATE push_subscriptions SET user_id = ? WHERE endpoint = ?',
          [userId, endpoint]
        )
      } catch (e) {
        console.warn('[push] Cleanup user_id falló:', e.message)
      }
    }

    res.json({ ok: true })
  } catch (e) {
    console.error('[notificaciones] POST /suscribir', e.message)
    res.status(500).json({ ok: false, error: 'Error al registrar suscripción' })
  }
})

// ════════════════════════════════════════════════════════════
// POST /api/notificaciones/desuscribir
// ════════════════════════════════════════════════════════════
router.post('/desuscribir', async (req, res) => {
  try {
    const { endpoint } = req.body
    if (!endpoint) return res.status(400).json({ ok: false, error: 'endpoint requerido' })

    await pool.query(
      'UPDATE push_subscriptions SET activo = 0 WHERE endpoint = ?',
      [endpoint]
    )
    res.json({ ok: true })
  } catch (e) {
    console.error('[notificaciones] POST /desuscribir', e.message)
    res.status(500).json({ ok: false, error: 'Error al desuscribir' })
  }
})

// ════════════════════════════════════════════════════════════
// POST /api/notificaciones/nueva-version
// deploy-update.js avisa cuando sube una nueva versión
// Body: { version }
// ════════════════════════════════════════════════════════════
router.post('/nueva-version', requireNotifSecret, async (req, res) => {
  try {
    const { version } = req.body

    const result = await enviarATodos({
      title: `🖥️ Nueva versión disponible`,
      body:  `DISFRULEG Escritorio v${version} ya está lista. Se instalará automáticamente al reiniciar.`,
      icon:  '/assets/icon.png',
      tag:   `nueva-version-${version}`
    })

    console.log(`[push] Nueva versión v${version} — ${result.enviados}/${result.total} dispositivos`)
    res.json({ ok: true, ...result })
  } catch (e) {
    console.error('[notificaciones] POST /nueva-version', e.message)
    res.status(500).json({ ok: false, error: 'Error al enviar notificación' })
  }
})

module.exports = router
