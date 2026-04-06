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
const { requireAuth } = require('../middleware/auth')

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

// ─── GET /api/dashboard/metricas-hoy — autenticado, para el home de la appweb ─
router.get('/metricas-hoy', requireAuth, async (req, res) => {
  try {
    const hoy = new Date().toISOString().slice(0, 10)

    const [
      pedidosHoy,
      pedidosActivos,
      ventas,
      compras,
      mermas,
      stockStats,
      topCritico,
      deudas
    ] = await Promise.all([

      // Pedidos creados hoy
      q(`SELECT COUNT(*) AS total
         FROM ordenes_guardadas
         WHERE DATE(fecha_creacion) = ? AND activo = 1`, [hoy]),

      // Pedidos activos (sin importar fecha)
      q(`SELECT COUNT(*) AS total
         FROM ordenes_guardadas
         WHERE estado = 'guardada' AND activo = 1`),

      // Ventas del día
      q(`SELECT
           COUNT(DISTINCT f.id_factura)                                     AS notas,
           COUNT(DISTINCT f.id_cliente)                                     AS clientes,
           COALESCE(SUM(df.cantidad_factura * df.precio_unitario_venta), 0) AS total_vendido
         FROM factura f
         INNER JOIN detalle_factura df ON f.id_factura = df.id_factura
         WHERE DATE(f.fecha_factura) = ?`, [hoy]),

      // Compras del día
      q(`SELECT
           COUNT(*)                                AS num_compras,
           COALESCE(SUM(total_con_impuestos), 0)  AS total_gasto
         FROM compra
         WHERE DATE(fecha_compra) = ?`, [hoy]),

      // Mermas del día
      q(`SELECT COUNT(*) AS total
         FROM merma
         WHERE DATE(fecha_registro) = ? AND activo = 1`, [hoy]),

      // Stock crítico (≤ 5 unidades)
      q(`SELECT
           COUNT(*)                                          AS criticos,
           SUM(CASE WHEN stock = 0 THEN 1 ELSE 0 END)       AS sin_stock,
           SUM(CASE WHEN stock > 0 AND stock <= 5 THEN 1 ELSE 0 END) AS bajo_stock
         FROM producto
         WHERE activo = 1 AND stock <= 5`),

      // Top 5 productos con menos stock
      q(`SELECT nombre_producto, stock, unidad_producto
         FROM producto
         WHERE activo = 1 AND stock <= 5
         ORDER BY stock ASC
         LIMIT 5`),

      // Deudas vencidas y su monto total
      q(`SELECT
           COUNT(*)                                        AS vencidas,
           COALESCE(SUM(d.monto_total - d.monto_pagado), 0) AS monto_vencido
         FROM deudas d
         LEFT JOIN cliente c ON d.id_cliente = c.id_cliente
         LEFT JOIN grupo   g ON c.id_grupo   = g.id_grupo
         WHERE d.pagado = 0
           AND COALESCE(c.dias_credito_override, g.dias_credito, 0) > 0
           AND DATEDIFF(
                 DATE_ADD(d.fecha_generada,
                   INTERVAL COALESCE(c.dias_credito_override, g.dias_credito, 0) DAY
                 ), CURDATE()
               ) < 0`)
    ])

    res.json({
      ok: true,
      ts: new Date().toISOString(),
      pedidos: {
        total_hoy: parseInt(pedidosHoy[0]?.total  || 0),
        activos:   parseInt(pedidosActivos[0]?.total || 0)
      },
      ventas: {
        total_vendido: parseFloat(ventas[0]?.total_vendido || 0),
        notas:         parseInt(ventas[0]?.notas   || 0),
        clientes:      parseInt(ventas[0]?.clientes || 0)
      },
      compras: {
        num_compras: parseInt(compras[0]?.num_compras || 0),
        total_gasto: parseFloat(compras[0]?.total_gasto || 0)
      },
      mermas: {
        total: parseInt(mermas[0]?.total || 0)
      },
      stock: {
        criticos:  parseInt(stockStats[0]?.criticos  || 0),
        sin_stock: parseInt(stockStats[0]?.sin_stock  || 0),
        bajo_stock: parseInt(stockStats[0]?.bajo_stock || 0),
        top:       topCritico || []
      },
      deudas: {
        vencidas:      parseInt(deudas[0]?.vencidas     || 0),
        monto_vencido: parseFloat(deudas[0]?.monto_vencido || 0)
      }
    })
  } catch (e) {
    console.error('[dashboard] GET /metricas-hoy:', e.message)
    res.status(500).json({ ok: false, error: e.message })
  }
})

module.exports = router
