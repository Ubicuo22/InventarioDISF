/**
 * routes/dashboard.js — Datos para el dashboard de bodega (pantalla TV/tableta)
 *
 * GET /api/dashboard/data?token=XXX — público, protegido por DASHBOARD_TOKEN
 *
 * Retorna en una sola llamada:
 *   - Ventas del día (total $, notas, clientes)
 *   - Pedidos activos (lista con cliente, grupo, monto)
 *   - Entradas de hoy (count, costo total)
 *   - Stock crítico (productos en 0 o bajo)
 *   - Mermas del día (count, monto)
 */

const router = require('express').Router()
const { q }  = require('../db/pool')

function requireDashboardToken(req, res, next) {
  const token = req.query.token
  if (!token || token !== process.env.DASHBOARD_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Token inválido' })
  }
  next()
}

router.get('/data', requireDashboardToken, async (req, res) => {
  try {
    const [
      ventasRows,
      pedidosRows,
      entradasRows,
      stockRows,
      mermasRows
    ] = await Promise.all([

      // ── Ventas del día ──────────────────────────────────
      q(`
        SELECT
          COUNT(DISTINCT f.id_factura)                                      AS total_notas,
          COUNT(DISTINCT f.id_cliente)                                      AS clientes_atendidos,
          COALESCE(SUM(df.cantidad_factura * df.precio_unitario_venta), 0)  AS total_vendido
        FROM factura f
        INNER JOIN detalle_factura df ON f.id_factura = df.id_factura
        WHERE DATE(f.fecha_factura) = CURDATE()
      `),

      // ── Pedidos activos (guardados, sin procesar) ───────
      q(`
        SELECT
          o.folio_numero,
          c.nombre_cliente,
          g.nombre_grupo,
          o.total_estimado,
          o.fecha_creacion,
          o.usuario_creador
        FROM ordenes_guardadas o
        INNER JOIN cliente c ON o.id_cliente = c.id_cliente
        INNER JOIN grupo   g ON c.id_grupo   = g.id_grupo
        WHERE o.estado = 'guardada' AND o.activo = 1
        ORDER BY o.folio_numero DESC
        LIMIT 12
      `),

      // ── Entradas de hoy ─────────────────────────────────
      q(`
        SELECT
          COUNT(*)                                    AS total_entradas,
          COALESCE(SUM(c.total_con_impuestos), 0)    AS costo_total
        FROM compra c
        WHERE DATE(c.fecha_registro) = CURDATE()
      `),

      // ── Stock crítico (≤ 5 unidades) ────────────────────
      q(`
        SELECT
          nombre_producto,
          stock,
          unidad_producto
        FROM producto
        WHERE activo = 1 AND stock <= 5
        ORDER BY stock ASC
        LIMIT 10
      `),

      // ── Mermas del día ──────────────────────────────────
      q(`
        SELECT
          COUNT(*)                         AS total_mermas,
          COALESCE(SUM(cantidad), 0)       AS cantidad_total
        FROM merma
        WHERE DATE(fecha_merma) = CURDATE()
      `)
    ])

    res.json({
      ok:          true,
      ts:          new Date().toISOString(),
      ventas:      ventasRows[0]  || {},
      pedidos:     pedidosRows    || [],
      entradas:    entradasRows[0] || {},
      stockCritico: stockRows     || [],
      mermas:      mermasRows[0]  || {}
    })
  } catch (e) {
    console.error('[dashboard] GET /data:', e.message)
    res.status(500).json({ ok: false, error: e.message })
  }
})

module.exports = router
