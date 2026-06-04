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
const { fechaMexico } = require('../utils/fecha')

function requireDashboardToken(req, res, next) {
  const token = req.query.token
  if (!token || token !== process.env.DASHBOARD_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Token inválido' })
  }
  next()
}

router.get('/data', requireDashboardToken, async (req, res) => {
  try {
    const hoy = fechaMexico()

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
        WHERE DATE(f.fecha_factura) = ?
      `, [hoy]),

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
        WHERE DATE(c.fecha_registro) = ?
      `, [hoy]),

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
          COALESCE(SUM(cantidad_merma), 0) AS cantidad_total
        FROM merma
        WHERE DATE(fecha_merma) = ?
      `, [hoy])
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
    const hoy = fechaMexico()
    const ayer = fechaMexico(-1)

    // ── Batch 1: queries ligeras (sin JOINs pesados) ─────────────────────────
    const [
      pedidosHoy,
      pedidosAyer,
      pedidosActivosRows,
      compras,
      comprasAyer,
      stockStats,
      topCritico,
      inventarioStats,
      pedidosAtrasados,
      lotesAntiguos
    ] = await Promise.all([

      // Pedidos creados hoy
      q(`SELECT COUNT(*) AS total
         FROM ordenes_guardadas
         WHERE DATE(fecha_creacion) = ? AND activo = 1`, [hoy]),

      // Pedidos creados ayer
      q(`SELECT COUNT(*) AS total
         FROM ordenes_guardadas
         WHERE DATE(fecha_creacion) = ? AND activo = 1`, [ayer]),

      // Pedidos activos con su carrito (para detectar revisados/no revisados)
      q(`SELECT folio_numero, datos_carrito, fecha_creacion
         FROM ordenes_guardadas
         WHERE estado = 'guardada' AND activo = 1`),

      // Compras del día
      q(`SELECT
           COUNT(*)                                AS num_compras,
           COALESCE(SUM(total_con_impuestos), 0)  AS total_gasto
         FROM compra
         WHERE DATE(fecha_registro) = ?`, [hoy]),

      // Compras ayer (para tendencia)
      q(`SELECT COALESCE(SUM(total_con_impuestos), 0) AS total_gasto
         FROM compra
         WHERE DATE(fecha_registro) = ?`, [ayer]),

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

      // Totales de inventario para el tile del dashboard
      q(`SELECT
           COUNT(*)                                             AS total_productos,
           SUM(CASE WHEN stock > 0 THEN 1 ELSE 0 END)         AS con_stock,
           SUM(CASE WHEN stock = 0 THEN 1 ELSE 0 END)         AS sin_stock,
           SUM(CASE WHEN stock > 0 AND stock <= 5 THEN 1 ELSE 0 END) AS stock_bajo
         FROM producto
         WHERE activo = 1`),

      // Pedidos atrasados (activos creados hace >24h)
      q(`SELECT COUNT(*) AS total
         FROM ordenes_guardadas
         WHERE estado = 'guardada' AND activo = 1
           AND fecha_creacion < DATE_SUB(NOW(), INTERVAL 1 DAY)`),

      // Lotes PEPS estancados: con stock restante > 0 y más de 60 días desde entrada
      q(`SELECT COUNT(DISTINCT ip.id_producto) AS total
         FROM inventario_peps ip
         WHERE ip.activo = 1
           AND ip.cantidad_restante > 0
           AND ip.fecha_movimiento < DATE_SUB(?, INTERVAL 60 DAY)`, [hoy])
    ])

    // ── Batch 2: queries con JOINs (ventas, mermas, deudas) ──────────────────
    const [
      ventas,
      ventasAyer,
      mermas,
      mermasAyer,
      deudas,
      ultimaEntrada,
      gananciaHoy
    ] = await Promise.all([

      // Ventas del día
      q(`SELECT
           COUNT(DISTINCT f.id_factura)                                     AS notas,
           COUNT(DISTINCT f.id_cliente)                                     AS clientes,
           COALESCE(SUM(df.cantidad_factura * df.precio_unitario_venta), 0) AS total_vendido
         FROM factura f
         INNER JOIN detalle_factura df ON f.id_factura = df.id_factura
         WHERE DATE(f.fecha_factura) = ?`, [hoy]),

      // Ventas ayer (solo total, para tendencia)
      q(`SELECT COALESCE(SUM(df.cantidad_factura * df.precio_unitario_venta), 0) AS total_vendido
         FROM factura f
         INNER JOIN detalle_factura df ON f.id_factura = df.id_factura
         WHERE DATE(f.fecha_factura) = ?`, [ayer]),

      // Mermas del día (incluye monto)
      q(`SELECT
           COUNT(*) AS total,
           COALESCE(SUM(m.cantidad_merma *
             COALESCE(
               (SELECT ip.costo_unitario
                FROM inventario_peps ip
                WHERE ip.id_producto = m.id_producto
                ORDER BY ip.fecha_movimiento DESC, ip.id_inventario_peps DESC
                LIMIT 1),
               0
             )
           ), 0) AS monto_perdido
         FROM merma m
         WHERE DATE(m.fecha_registro) = ? AND m.activo = 1`, [hoy]),

      // Mermas ayer (solo monto para tendencia)
      q(`SELECT
           COALESCE(SUM(m.cantidad_merma *
             COALESCE(
               (SELECT ip.costo_unitario
                FROM inventario_peps ip
                WHERE ip.id_producto = m.id_producto
                ORDER BY ip.fecha_movimiento DESC, ip.id_inventario_peps DESC
                LIMIT 1),
               0
             )
           ), 0) AS monto_perdido
         FROM merma m
         WHERE DATE(m.fecha_registro) = ? AND m.activo = 1`, [ayer]),

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
                 ), ?
               ) < 0`, [hoy]),

      // Última entrada de inventario (para tarjeta Historial)
      q(`SELECT c.fecha_registro, c.cantidad_compra, c.total_con_impuestos,
                p.nombre_producto, p.unidad_producto,
                COALESCE(c.usuario_registro, '—') AS usuario
         FROM compra c
         LEFT JOIN producto p ON p.id_producto = c.id_producto
         ORDER BY c.fecha_registro DESC
         LIMIT 1`),

      // Ganancia del día (utilidad real PEPS)
      q(`SELECT COALESCE(SUM(dvl.utilidad_total), 0) AS ganancia
         FROM detalle_venta_lote dvl
         INNER JOIN detalle_factura df ON df.id_detalle = dvl.id_detalle_factura
         INNER JOIN factura f ON f.id_factura = df.id_factura
         WHERE DATE(f.fecha_factura) = ?`, [hoy])
    ])

    // Computar revisados / por revisar parseando __historial__
    // Misma lógica que getReviewInfo() / isOrdenRevisada() del electron:
    //   1. Busca la última entrada con tipoEvento === 'revision' (no necesariamente la última)
    //   2. Si hay cambios de carrito POSTERIORES a esa revisión → no revisada
    //   3. Si tiene pendientes → cuenta como "por revisar" (necesita atención)
    let porRevisar = 0
    let revisados = 0
    for (const orden of (pedidosActivosRows || [])) {
      try {
        const cart = typeof orden.datos_carrito === 'string'
          ? JSON.parse(orden.datos_carrito)
          : (orden.datos_carrito || {})
        const hist = cart.__historial__ || []

        // Buscar la última revisión
        let lastReview = null
        let lastReviewIdx = -1
        for (let i = hist.length - 1; i >= 0; i--) {
          if (hist[i].tipoEvento === 'revision') { lastReview = hist[i]; lastReviewIdx = i; break }
        }

        if (!lastReview) {
          porRevisar++
          continue
        }

        // ¿Hubo cambios de carrito DESPUÉS de la revisión?
        const hayCambiosPosteriores = hist
          .slice(lastReviewIdx + 1)
          .some(e => !e.tipoEvento || e.tipoEvento === 'cambios')

        if (hayCambiosPosteriores) { porRevisar++; continue }

        // ¿Tiene pendientes? → también necesita atención
        const pendientes = lastReview.pendientes || []
        if (pendientes.length > 0) { porRevisar++; continue }

        revisados++
      } catch {
        porRevisar++
      }
    }

    res.json({
      ok: true,
      ts: new Date().toISOString(),
      pedidos: {
        total_hoy:  parseInt(pedidosHoy[0]?.total  || 0),
        total_ayer: parseInt(pedidosAyer[0]?.total || 0),
        activos:    (pedidosActivosRows || []).length,
        por_revisar: porRevisar,
        revisados,
        atrasados:  parseInt(pedidosAtrasados[0]?.total || 0)
      },
      ventas: {
        total_vendido:      parseFloat(ventas[0]?.total_vendido || 0),
        total_vendido_ayer: parseFloat(ventasAyer[0]?.total_vendido || 0),
        notas:              parseInt(ventas[0]?.notas    || 0),
        clientes:           parseInt(ventas[0]?.clientes || 0),
        ganancia_hoy:       parseFloat(gananciaHoy[0]?.ganancia || 0)
      },
      lotes_antiguos: parseInt(lotesAntiguos[0]?.total || 0),
      compras: {
        num_compras:     parseInt(compras[0]?.num_compras || 0),
        total_gasto:     parseFloat(compras[0]?.total_gasto || 0),
        total_gasto_ayer: parseFloat(comprasAyer[0]?.total_gasto || 0)
      },
      mermas: {
        total:              parseInt(mermas[0]?.total || 0),
        monto_perdido:      parseFloat(mermas[0]?.monto_perdido || 0),
        monto_perdido_ayer: parseFloat(mermasAyer[0]?.monto_perdido || 0)
      },
      stock: {
        criticos:   parseInt(stockStats[0]?.criticos   || 0),
        sin_stock:  parseInt(stockStats[0]?.sin_stock  || 0),
        bajo_stock: parseInt(stockStats[0]?.bajo_stock || 0),
        top:        topCritico || []
      },
      deudas: {
        vencidas:      parseInt(deudas[0]?.vencidas      || 0),
        monto_vencido: parseFloat(deudas[0]?.monto_vencido || 0)
      },
      inventario: {
        total_productos: parseInt(inventarioStats[0]?.total_productos || 0),
        con_stock:       parseInt(inventarioStats[0]?.con_stock       || 0),
        sin_stock:       parseInt(inventarioStats[0]?.sin_stock       || 0),
        stock_bajo:      parseInt(inventarioStats[0]?.stock_bajo      || 0)
      },
      ultima_entrada: ultimaEntrada[0] || null
    })
  } catch (e) {
    console.error('[dashboard] GET /metricas-hoy:', e.message)
    res.status(500).json({ ok: false, error: e.message })
  }
})

module.exports = router
