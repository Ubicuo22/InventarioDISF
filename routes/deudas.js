/**
 * routes/deudas.js — Cobranza: deudas pendientes para appweb móvil
 *
 * GET /api/deudas              — lista de deudas pendientes con semáforo
 * GET /api/deudas/stats        — totales: pendiente, parcial, vencidas
 * GET /api/deudas/:id          — detalle de una deuda
 * GET /api/deudas/:id/pagos    — historial de pagos de una deuda
 */

const router = require('express').Router()
const { q }  = require('../db/pool')
const { requireAuth, requireModulo } = require('../middleware/auth')

router.use(requireAuth, requireModulo('cobranza'))

// ── Semáforo: calcula estado según días de crédito ────────
const SEMAFORO_SQL = `
  CASE
    WHEN COALESCE(c.dias_credito_override, g.dias_credito, 0) = 0
      THEN 'sin_plazo'
    WHEN DATEDIFF(
      DATE_ADD(d.fecha_generada, INTERVAL COALESCE(c.dias_credito_override, g.dias_credito, 0) DAY),
      CURDATE()
    ) < 0
      THEN 'vencida'
    WHEN DATEDIFF(
      DATE_ADD(d.fecha_generada, INTERVAL COALESCE(c.dias_credito_override, g.dias_credito, 0) DAY),
      CURDATE()
    ) <= 3
      THEN 'por_vencer'
    ELSE 'al_dia'
  END
`

// ── GET /api/deudas ───────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { busqueda, estado } = req.query

    let where = `d.pagado = 0`
    const params = []

    if (busqueda) {
      where += ` AND (d.nombre_cliente LIKE ? OR d.nombre_grupo LIKE ? OR d.id_factura LIKE ?)`
      const b = `%${busqueda}%`
      params.push(b, b, b)
    }

    if (estado && estado !== 'todos') {
      // Filtrar por semáforo — se hace en JS después del query para simplicidad
    }

    const rows = await q(`
      SELECT
        d.id_deuda,
        d.id_factura,
        d.nombre_cliente,
        d.nombre_grupo,
        d.monto_total,
        d.monto_pagado,
        (d.monto_total - d.monto_pagado)                              AS saldo_pendiente,
        d.fecha_generada,
        d.metodo_pago,
        COALESCE(c.telefono, '')                                      AS telefono,
        COALESCE(c.dias_credito_override, g.dias_credito, 0)         AS dias_credito,
        DATE_ADD(d.fecha_generada,
          INTERVAL COALESCE(c.dias_credito_override, g.dias_credito, 0) DAY
        )                                                             AS fecha_vencimiento,
        DATEDIFF(
          DATE_ADD(d.fecha_generada,
            INTERVAL COALESCE(c.dias_credito_override, g.dias_credito, 0) DAY
          ), CURDATE()
        )                                                             AS dias_restantes,
        (${SEMAFORO_SQL})                                             AS semaforo
      FROM deudas d
      LEFT JOIN cliente c ON d.id_cliente = c.id_cliente
      LEFT JOIN grupo   g ON c.id_grupo   = g.id_grupo
      WHERE ${where}
      ORDER BY
        CASE (${SEMAFORO_SQL})
          WHEN 'vencida'    THEN 1
          WHEN 'por_vencer' THEN 2
          WHEN 'al_dia'     THEN 3
          ELSE 4
        END,
        dias_restantes ASC,
        d.monto_total DESC
    `, params)

    // Filtro de semáforo en JS si fue solicitado
    const data = estado && estado !== 'todos'
      ? rows.filter(r => r.semaforo === estado)
      : rows

    res.json({ ok: true, data })
  } catch (e) {
    console.error('[deudas] GET /:', e.message)
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── GET /api/deudas/stats ─────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [rows] = await Promise.all([
      q(`
        SELECT
          COUNT(*)                                         AS total,
          COALESCE(SUM(monto_total - monto_pagado), 0)    AS saldo_total,
          SUM(CASE WHEN monto_pagado = 0 THEN 1 ELSE 0 END)          AS pendientes,
          SUM(CASE WHEN monto_pagado > 0 AND monto_pagado < monto_total THEN 1 ELSE 0 END) AS parciales
        FROM deudas
        WHERE pagado = 0
      `)
    ])

    const vencidas = await q(`
      SELECT COUNT(*) AS vencidas
      FROM deudas d
      LEFT JOIN cliente c ON d.id_cliente = c.id_cliente
      LEFT JOIN grupo   g ON c.id_grupo   = g.id_grupo
      WHERE d.pagado = 0
        AND COALESCE(c.dias_credito_override, g.dias_credito, 0) > 0
        AND DATEDIFF(
          DATE_ADD(d.fecha_generada,
            INTERVAL COALESCE(c.dias_credito_override, g.dias_credito, 0) DAY
          ), CURDATE()
        ) < 0
    `)

    res.json({
      ok: true,
      data: {
        ...(rows[0] || {}),
        vencidas: parseInt(vencidas[0]?.vencidas || 0)
      }
    })
  } catch (e) {
    console.error('[deudas] GET /stats:', e.message)
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── GET /api/deudas/:id ───────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const rows = await q(`
      SELECT
        d.*,
        (d.monto_total - d.monto_pagado)                             AS saldo_pendiente,
        COALESCE(c.telefono, '')                                     AS telefono,
        COALESCE(c.dias_credito_override, g.dias_credito, 0)        AS dias_credito,
        DATE_ADD(d.fecha_generada,
          INTERVAL COALESCE(c.dias_credito_override, g.dias_credito, 0) DAY
        )                                                            AS fecha_vencimiento,
        DATEDIFF(
          DATE_ADD(d.fecha_generada,
            INTERVAL COALESCE(c.dias_credito_override, g.dias_credito, 0) DAY
          ), CURDATE()
        )                                                            AS dias_restantes,
        (${SEMAFORO_SQL})                                            AS semaforo
      FROM deudas d
      LEFT JOIN cliente c ON d.id_cliente = c.id_cliente
      LEFT JOIN grupo   g ON c.id_grupo   = g.id_grupo
      WHERE d.id_deuda = ?
    `, [req.params.id])

    if (!rows.length) return res.status(404).json({ ok: false, error: 'Deuda no encontrada' })
    res.json({ ok: true, data: rows[0] })
  } catch (e) {
    console.error('[deudas] GET /:id:', e.message)
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── GET /api/deudas/:id/pagos ─────────────────────────────
router.get('/:id/pagos', async (req, res) => {
  try {
    const rows = await q(`
      SELECT
        id_pago, monto_pagado, fecha_pago,
        metodo_pago, referencia_pago, notas,
        comentario, razon_pago_parcial,
        usuario_registro, timestamp, estado_pago
      FROM pago_registrado
      WHERE id_deuda = ?
        AND estado_pago != 'REVERSED'
      ORDER BY timestamp DESC
    `, [req.params.id])

    res.json({ ok: true, data: rows })
  } catch (e) {
    console.error('[deudas] GET /:id/pagos:', e.message)
    res.status(500).json({ ok: false, error: e.message })
  }
})

module.exports = router
