/**
 * DISFRULEG BODEGA — Notificaciones Push
 *
 * POST /api/notificaciones/suscribir      — el iPhone se registra (requiere JWT)
 * POST /api/notificaciones/nuevo-pedido   — Electron avisa pedido nuevo (requiere NOTIF_SECRET)
 * POST /api/notificaciones/pedido-procesado — Electron avisa venta procesada (requiere NOTIF_SECRET)
 * GET  /api/notificaciones/vapid-key      — devuelve la clave pública VAPID (pública, sin auth)
 */

const express  = require('express')
const router   = express.Router()
const { requireAuth } = require('../middleware/auth')
const { pool }  = require('../db/pool')
const { enviarATodos } = require('../utils/push')

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
      title: `📦 Pedido nuevo · ${cliente || 'Sin cliente'}${folioStr}${usuarioStr}`,
      body:  '',
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
      title: `💰 Pedido procesado · ${cliente || 'Sin cliente'}${folioStr}${usuarioStr}`,
      body:  '',
      icon:  '/assets/icon.png'
    })

    console.log(`[push] Pedido procesado notificado — ${result.enviados}/${result.total} dispositivos`)
    res.json({ ok: true, ...result })
  } catch (e) {
    console.error('[notificaciones] POST /pedido-procesado', e.message)
    res.status(500).json({ ok: false, error: 'Error al enviar notificación' })
  }
})

// ════════════════════════════════════════════════════════════
// POST /api/notificaciones/stock-entrada
// Electron avisa cuando se registra una compra (entra stock)
// Body: { secret, producto, cantidad, unidad, usuario }
// ════════════════════════════════════════════════════════════
router.post('/stock-entrada', requireNotifSecret, async (req, res) => {
  try {
    const { producto, cantidad, unidad, usuario } = req.body
    const cantStr    = cantidad ? ` · +${cantidad}${unidad ? ' ' + unidad : ''}` : ''
    const usuarioStr = usuario  ? ` · ${usuario}` : ''

    const result = await enviarATodos({
      title: `📦 Entrada de stock · ${producto || 'Producto'}${cantStr}${usuarioStr}`,
      body:  '',
      icon:  '/assets/icon.png'
    })

    console.log(`[push] Stock entrada notificado — ${result.enviados}/${result.total} dispositivos`)
    res.json({ ok: true, ...result })
  } catch (e) {
    console.error('[notificaciones] POST /stock-entrada', e.message)
    res.status(500).json({ ok: false, error: 'Error al enviar notificación' })
  }
})

// ════════════════════════════════════════════════════════════
// POST /api/notificaciones/stock-bajo
// Electron avisa cuando un producto llega a 0 o negativo
// Body: { secret, producto, stock, unidad, usuario }
// ════════════════════════════════════════════════════════════
router.post('/stock-bajo', requireNotifSecret, async (req, res) => {
  try {
    const { producto, stock, unidad, usuario } = req.body
    const stockStr   = stock !== undefined ? ` · ${stock} ${unidad || ''}`.trimEnd() : ''
    const usuarioStr = usuario ? ` · ${usuario}` : ''

    const result = await enviarATodos({
      title: `⚠️ Stock bajo · ${producto || 'Producto'}${stockStr}${usuarioStr}`,
      body:  '',
      icon:  '/assets/icon.png'
    })

    console.log(`[push] Stock bajo notificado — ${result.enviados}/${result.total} dispositivos`)
    res.json({ ok: true, ...result })
  } catch (e) {
    console.error('[notificaciones] POST /stock-bajo', e.message)
    res.status(500).json({ ok: false, error: 'Error al enviar notificación' })
  }
})

module.exports = router
