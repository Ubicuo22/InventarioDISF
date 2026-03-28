/**
 * DISFRULEG BODEGA — Notificaciones Push
 *
 * POST /api/notificaciones/suscribir           — el iPhone se registra (sin auth, re-sync seguro)
 * POST /api/notificaciones/nuevo-pedido        — Electron avisa pedido nuevo (requiere NOTIF_SECRET)
 * POST /api/notificaciones/pedido-procesado    — Electron avisa venta procesada (requiere NOTIF_SECRET)
 * POST /api/notificaciones/stock-entrada       — Electron avisa entrada de stock (requiere NOTIF_SECRET)
 * POST /api/notificaciones/stock-bajo          — Electron avisa stock en cero (requiere NOTIF_SECRET)
 * POST /api/notificaciones/cotizacion-importada — Electron avisa importación de cotización (requiere NOTIF_SECRET)
 * POST /api/notificaciones/nueva-version       — deploy-update.js avisa nueva versión disponible (requiere NOTIF_SECRET)
 * GET  /api/notificaciones/vapid-key           — devuelve la clave pública VAPID (pública, sin auth)
 */

const express  = require('express')
const router   = express.Router()
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
// El iPhone registra su suscripción push (sin JWT — re-sync seguro)
// Body: { endpoint, keys: { p256dh, auth } }
// ════════════════════════════════════════════════════════════
router.post('/suscribir', async (req, res) => {
  try {
    const { endpoint, keys } = req.body
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ ok: false, error: 'Suscripción inválida' })
    }

    // Upsert: si el endpoint ya existe, actualiza keys y lo reactiva
    const [existing] = await pool.query(
      'SELECT id FROM push_subscriptions WHERE endpoint = ?',
      [endpoint]
    )

    if (existing.length > 0) {
      await pool.query(
        'UPDATE push_subscriptions SET p256dh = ?, auth = ?, activo = 1 WHERE endpoint = ?',
        [keys.p256dh, keys.auth, endpoint]
      )
      console.log(`[push] Suscripción ${existing[0].id} reactivada/actualizada`)
    } else {
      await pool.query(
        'INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)',
        [endpoint, keys.p256dh, keys.auth]
      )
      console.log('[push] Nueva suscripción registrada')
    }

    res.json({ ok: true })
  } catch (e) {
    console.error('[notificaciones] POST /suscribir', e.message)
    res.status(500).json({ ok: false, error: 'Error al registrar suscripción' })
  }
})

// ════════════════════════════════════════════════════════════
// POST /api/notificaciones/nuevo-pedido
// Electron llama esto cuando guarda un nuevo pedido
// Body: { cliente, folio, usuario }
// ════════════════════════════════════════════════════════════
router.post('/nuevo-pedido', requireNotifSecret, async (req, res) => {
  try {
    const { cliente, folio, usuario, grupo } = req.body
    const folioStr = folio ? `#${String(folio).padStart(4, '0')}` : ''
    const esAeropuerto = grupo && grupo.toLowerCase().includes('aeropuerto')

    const result = await enviarATodos({
      title: esAeropuerto ? `📦 Pedido nuevo — ${cliente}` : `📦 Pedido nuevo`,
      body:  [folioStr, usuario].filter(Boolean).join(' · '),
      icon:  '/assets/icon.png',
      tag:   `pedido-${folio || Date.now()}`
    })

    console.log(`[push] Pedido nuevo — ${result.enviados}/${result.total} dispositivos`)
    res.json({ ok: true, ...result })
  } catch (e) {
    console.error('[notificaciones] POST /nuevo-pedido', e.message)
    res.status(500).json({ ok: false, error: 'Error al enviar notificación' })
  }
})

// ════════════════════════════════════════════════════════════
// POST /api/notificaciones/pedido-procesado
// Electron llama esto cuando procesa la venta (genera nota)
// Body: { cliente, folio, usuario }
// ════════════════════════════════════════════════════════════
router.post('/pedido-procesado', requireNotifSecret, async (req, res) => {
  try {
    const { cliente, folio, usuario, grupo } = req.body
    const folioStr = folio ? `#${String(folio).padStart(4, '0')}` : ''
    const esAeropuerto = grupo && grupo.toLowerCase().includes('aeropuerto')

    const result = await enviarATodos({
      title: esAeropuerto ? `💰 Pedido procesado — ${cliente}` : `💰 Pedido procesado`,
      body:  [folioStr, usuario].filter(Boolean).join(' · '),
      icon:  '/assets/icon.png',
      tag:   `procesado-${folio || Date.now()}`
    })

    console.log(`[push] Pedido procesado — ${result.enviados}/${result.total} dispositivos`)
    res.json({ ok: true, ...result })
  } catch (e) {
    console.error('[notificaciones] POST /pedido-procesado', e.message)
    res.status(500).json({ ok: false, error: 'Error al enviar notificación' })
  }
})

// ════════════════════════════════════════════════════════════
// POST /api/notificaciones/stock-entrada
// Electron avisa cuando se registra una compra (entra stock)
// Body: { producto, cantidad, unidad, usuario }
// ════════════════════════════════════════════════════════════
router.post('/stock-entrada', requireNotifSecret, async (req, res) => {
  try {
    const { producto, cantidad, unidad, usuario } = req.body
    const cantStr = cantidad ? `+${cantidad}${unidad ? ' ' + unidad : ''}` : ''

    const result = await enviarATodos({
      title: `📥 Entrada de stock`,
      body:  [producto, cantStr, usuario].filter(Boolean).join(' · '),
      icon:  '/assets/icon.png',
      tag:   `stock-entrada-${Date.now()}`
    })

    console.log(`[push] Stock entrada — ${result.enviados}/${result.total} dispositivos`)
    res.json({ ok: true, ...result })
  } catch (e) {
    console.error('[notificaciones] POST /stock-entrada', e.message)
    res.status(500).json({ ok: false, error: 'Error al enviar notificación' })
  }
})

// ════════════════════════════════════════════════════════════
// POST /api/notificaciones/stock-bajo
// Electron avisa cuando un producto llega a 0 o negativo
// Body: { producto, stock, unidad, usuario }
// ════════════════════════════════════════════════════════════
router.post('/stock-bajo', requireNotifSecret, async (req, res) => {
  try {
    const { producto, stock, unidad, usuario } = req.body
    const stockStr = stock !== undefined ? `${stock} ${unidad || ''}`.trim() : ''

    const result = await enviarATodos({
      title: `⚠️ Stock bajo`,
      body:  [producto, stockStr, usuario].filter(Boolean).join(' · '),
      icon:  '/assets/icon.png',
      tag:   `stock-bajo-${producto || Date.now()}`
    })

    console.log(`[push] Stock bajo — ${result.enviados}/${result.total} dispositivos`)
    res.json({ ok: true, ...result })
  } catch (e) {
    console.error('[notificaciones] POST /stock-bajo', e.message)
    res.status(500).json({ ok: false, error: 'Error al enviar notificación' })
  }
})

// ════════════════════════════════════════════════════════════
// POST /api/notificaciones/cotizacion-importada
// Electron avisa cuando se importa una cotización de precios
// Body: { grupo, productos, usuario }
// ════════════════════════════════════════════════════════════
router.post('/cotizacion-importada', requireNotifSecret, async (req, res) => {
  try {
    const { grupo, productos, usuario } = req.body
    const productosStr = productos ? `${productos} producto${productos !== 1 ? 's' : ''}` : ''

    const result = await enviarATodos({
      title: `📋 Cotización importada`,
      body:  [grupo, productosStr, usuario].filter(Boolean).join(' · '),
      icon:  '/assets/icon.png',
      tag:   `cotizacion-${Date.now()}`
    })

    console.log(`[push] Cotización importada — ${result.enviados}/${result.total} dispositivos`)
    res.json({ ok: true, ...result })
  } catch (e) {
    console.error('[notificaciones] POST /cotizacion-importada', e.message)
    res.status(500).json({ ok: false, error: 'Error al enviar notificación' })
  }
})

// ════════════════════════════════════════════════════════════
// POST /api/notificaciones/nueva-version
// deploy-update.js avisa cuando sube una nueva versión a R2
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
