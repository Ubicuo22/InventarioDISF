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

const crypto = require('crypto')
const router = require('express').Router()
const { q }  = require('../db/pool')
const { requireAuth } = require('../middleware/auth')
const { fechaMexico } = require('../utils/fecha')

function requireDashboardToken(req, res, next) {
  const token = req.query.token
  const expected = process.env.DASHBOARD_TOKEN
  if (!token || !expected) {
    return res.status(401).json({ ok: false, error: 'Token inválido' })
  }
  // timingSafeEqual evita ataques de timing — ambos buffers deben tener el mismo largo
  const a = Buffer.from(token)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
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
          AND (c.notas IS NULL OR (
                c.notas NOT LIKE 'PHANTOM:%'
            AND c.notas NOT LIKE 'AJUSTE:%'
            AND NOT (c.notas LIKE 'BOOTSTRAP:%' AND c.precio_unitario_compra <= 0.01)
          ))
      `, [hoy]),

      // ── Stock crítico (≤ 5 unidades) ────────────────────
      q(`
        SELECT p.nombre_producto, CASE
            WHEN cp2.id_conversion IS NOT NULL AND pb2.stock IS NOT NULL AND pb2.id_producto != p.id_producto
            THEN ROUND(pb2.stock / (cp.factor * cp2.factor) + pb.stock / cp.factor + p.stock, 4)
            WHEN cp.id_conversion IS NOT NULL AND pb.stock IS NOT NULL
            THEN ROUND(pb.stock / cp.factor + p.stock, 4)
            ELSE p.stock
          END AS stock, p.unidad_producto
        FROM producto p
        LEFT JOIN (SELECT id_producto_derivado, MIN(id_conversion) AS min_id FROM producto_conversion_peps WHERE activo = 1 AND id_grupo IS NULL AND id_producto_derivado != id_producto_base GROUP BY id_producto_derivado) cp_min
          ON p.id_producto = cp_min.id_producto_derivado
        LEFT JOIN producto_conversion_peps cp ON cp.id_conversion = cp_min.min_id
        LEFT JOIN producto pb ON cp.id_producto_base = pb.id_producto
        LEFT JOIN (SELECT id_producto_derivado, MIN(id_conversion) AS min_id FROM producto_conversion_peps WHERE activo = 1 AND id_grupo IS NULL AND id_producto_derivado != id_producto_base GROUP BY id_producto_derivado) cp2_min
          ON pb.id_producto = cp2_min.id_producto_derivado
        LEFT JOIN producto_conversion_peps cp2 ON cp2.id_conversion = cp2_min.min_id
        LEFT JOIN producto pb2 ON cp2.id_producto_base = pb2.id_producto
        WHERE p.activo = 1
        HAVING stock <= 5
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
         WHERE DATE(fecha_registro) = ?
           AND (notas IS NULL OR (
                 notas NOT LIKE 'PHANTOM:%'
             AND notas NOT LIKE 'AJUSTE:%'
             AND NOT (notas LIKE 'BOOTSTRAP:%' AND precio_unitario_compra <= 0.01)
           ))`, [hoy]),

      // Compras ayer (para tendencia)
      q(`SELECT COALESCE(SUM(total_con_impuestos), 0) AS total_gasto
         FROM compra
         WHERE DATE(fecha_registro) = ?
           AND (notas IS NULL OR (
                 notas NOT LIKE 'PHANTOM:%'
             AND notas NOT LIKE 'AJUSTE:%'
             AND NOT (notas LIKE 'BOOTSTRAP:%' AND precio_unitario_compra <= 0.01)
           ))`, [ayer]),

      // Stock crítico (≤ 5 unidades) — con equivalencias
      q(`SELECT
           COUNT(*) AS criticos,
           SUM(CASE WHEN sv.stock_v = 0 THEN 1 ELSE 0 END) AS sin_stock,
           SUM(CASE WHEN sv.stock_v > 0 AND sv.stock_v <= 5 THEN 1 ELSE 0 END) AS bajo_stock
         FROM (
           SELECT CASE
            WHEN cp2.id_conversion IS NOT NULL AND pb2.stock IS NOT NULL AND pb2.id_producto != p.id_producto
            THEN ROUND(pb2.stock / (cp.factor * cp2.factor) + pb.stock / cp.factor + p.stock, 4)
            WHEN cp.id_conversion IS NOT NULL AND pb.stock IS NOT NULL
            THEN ROUND(pb.stock / cp.factor + p.stock, 4)
            ELSE p.stock
          END AS stock_v
           FROM producto p
        LEFT JOIN (SELECT id_producto_derivado, MIN(id_conversion) AS min_id FROM producto_conversion_peps WHERE activo = 1 AND id_grupo IS NULL AND id_producto_derivado != id_producto_base GROUP BY id_producto_derivado) cp_min
          ON p.id_producto = cp_min.id_producto_derivado
        LEFT JOIN producto_conversion_peps cp ON cp.id_conversion = cp_min.min_id
        LEFT JOIN producto pb ON cp.id_producto_base = pb.id_producto
        LEFT JOIN (SELECT id_producto_derivado, MIN(id_conversion) AS min_id FROM producto_conversion_peps WHERE activo = 1 AND id_grupo IS NULL AND id_producto_derivado != id_producto_base GROUP BY id_producto_derivado) cp2_min
          ON pb.id_producto = cp2_min.id_producto_derivado
        LEFT JOIN producto_conversion_peps cp2 ON cp2.id_conversion = cp2_min.min_id
        LEFT JOIN producto pb2 ON cp2.id_producto_base = pb2.id_producto
           WHERE p.activo = 1
           HAVING stock_v <= 5
         ) sv`),

      // Top 5 productos con menos stock — con equivalencias
      q(`SELECT p.nombre_producto, CASE
            WHEN cp2.id_conversion IS NOT NULL AND pb2.stock IS NOT NULL AND pb2.id_producto != p.id_producto
            THEN ROUND(pb2.stock / (cp.factor * cp2.factor) + pb.stock / cp.factor + p.stock, 4)
            WHEN cp.id_conversion IS NOT NULL AND pb.stock IS NOT NULL
            THEN ROUND(pb.stock / cp.factor + p.stock, 4)
            ELSE p.stock
          END AS stock, p.unidad_producto
         FROM producto p
        LEFT JOIN (SELECT id_producto_derivado, MIN(id_conversion) AS min_id FROM producto_conversion_peps WHERE activo = 1 AND id_grupo IS NULL AND id_producto_derivado != id_producto_base GROUP BY id_producto_derivado) cp_min
          ON p.id_producto = cp_min.id_producto_derivado
        LEFT JOIN producto_conversion_peps cp ON cp.id_conversion = cp_min.min_id
        LEFT JOIN producto pb ON cp.id_producto_base = pb.id_producto
        LEFT JOIN (SELECT id_producto_derivado, MIN(id_conversion) AS min_id FROM producto_conversion_peps WHERE activo = 1 AND id_grupo IS NULL AND id_producto_derivado != id_producto_base GROUP BY id_producto_derivado) cp2_min
          ON pb.id_producto = cp2_min.id_producto_derivado
        LEFT JOIN producto_conversion_peps cp2 ON cp2.id_conversion = cp2_min.min_id
        LEFT JOIN producto pb2 ON cp2.id_producto_base = pb2.id_producto
         WHERE p.activo = 1
         HAVING stock <= 5
         ORDER BY stock ASC
         LIMIT 5`),

      // Totales de inventario para el tile del dashboard — con equivalencias
      q(`SELECT
           COUNT(*) AS total_productos,
           SUM(CASE WHEN sv.stock_v > 0 THEN 1 ELSE 0 END) AS con_stock,
           SUM(CASE WHEN sv.stock_v = 0 THEN 1 ELSE 0 END) AS sin_stock,
           SUM(CASE WHEN sv.stock_v > 0 AND sv.stock_v <= 5 THEN 1 ELSE 0 END) AS stock_bajo
         FROM (
           SELECT CASE
            WHEN cp2.id_conversion IS NOT NULL AND pb2.stock IS NOT NULL AND pb2.id_producto != p.id_producto
            THEN ROUND(pb2.stock / (cp.factor * cp2.factor) + pb.stock / cp.factor + p.stock, 4)
            WHEN cp.id_conversion IS NOT NULL AND pb.stock IS NOT NULL
            THEN ROUND(pb.stock / cp.factor + p.stock, 4)
            ELSE p.stock
          END AS stock_v
           FROM producto p
        LEFT JOIN (SELECT id_producto_derivado, MIN(id_conversion) AS min_id FROM producto_conversion_peps WHERE activo = 1 AND id_grupo IS NULL AND id_producto_derivado != id_producto_base GROUP BY id_producto_derivado) cp_min
          ON p.id_producto = cp_min.id_producto_derivado
        LEFT JOIN producto_conversion_peps cp ON cp.id_conversion = cp_min.min_id
        LEFT JOIN producto pb ON cp.id_producto_base = pb.id_producto
        LEFT JOIN (SELECT id_producto_derivado, MIN(id_conversion) AS min_id FROM producto_conversion_peps WHERE activo = 1 AND id_grupo IS NULL AND id_producto_derivado != id_producto_base GROUP BY id_producto_derivado) cp2_min
          ON pb.id_producto = cp2_min.id_producto_derivado
        LEFT JOIN producto_conversion_peps cp2 ON cp2.id_conversion = cp2_min.min_id
        LEFT JOIN producto pb2 ON cp2.id_producto_base = pb2.id_producto
           WHERE p.activo = 1
         ) sv`),

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

      // Última entrada de inventario real (para tarjeta Historial)
      q(`SELECT c.fecha_registro, c.cantidad_compra, c.total_con_impuestos,
                p.nombre_producto, p.unidad_producto,
                COALESCE(c.usuario_registro, '—') AS usuario
         FROM compra c
         LEFT JOIN producto p ON p.id_producto = c.id_producto
         WHERE c.notas IS NULL OR (
               c.notas NOT LIKE 'PHANTOM:%'
           AND c.notas NOT LIKE 'AJUSTE:%'
           AND NOT (c.notas LIKE 'BOOTSTRAP:%' AND c.precio_unitario_compra <= 0.01)
         )
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

// ─── GET /api/dashboard/ceo-insights — solo CEO ─────────────────────────────
router.get('/ceo-insights', requireAuth, async (req, res) => {
  if (req.user?.rol !== 'ceo') {
    return res.status(403).json({ ok: false, error: 'Acceso exclusivo CEO' })
  }
  try {
    const hoy  = fechaMexico()
    // Últimos 7 días (hoy inclusive)
    const d7 = new Date(hoy + 'T00:00:00')
    d7.setDate(d7.getDate() - 6)
    const desde = d7.toISOString().slice(0, 10)

    const [ganancia, mejorCliente, topProducto, estancados] = await Promise.all([

      // Ganancia real PEPS de la semana
      q(`SELECT
           COALESCE(SUM(dvl.utilidad_total), 0)                                        AS ganancia,
           COALESCE(SUM(df.cantidad_factura * df.precio_unitario_venta), 0)            AS ventas,
           COUNT(DISTINCT df.id_factura)                                                AS notas
         FROM detalle_venta_lote dvl
         INNER JOIN detalle_factura df ON df.id_detalle = dvl.id_detalle_factura
         INNER JOIN factura f          ON f.id_factura  = df.id_factura
         WHERE DATE(f.fecha_factura) >= ?`, [desde]),

      // Mejor cliente de la semana — subquery evita only_full_group_by
      q(`SELECT c.nombre_cliente,
                COALESCE(g.nombre_grupo, 'Sin grupo') AS nombre_grupo,
                t.total_vendido,
                t.notas
         FROM (
           SELECT f.id_cliente,
                  SUM(df.cantidad_factura * df.precio_unitario_venta) AS total_vendido,
                  COUNT(DISTINCT f.id_factura)                        AS notas
           FROM factura f
           INNER JOIN detalle_factura df ON f.id_factura = df.id_factura
           WHERE DATE(f.fecha_factura) >= ?
           GROUP BY f.id_cliente
           ORDER BY total_vendido DESC
           LIMIT 1
         ) t
         INNER JOIN cliente c ON c.id_cliente = t.id_cliente
         LEFT  JOIN grupo g   ON c.id_grupo   = g.id_grupo`, [desde]),

      // Producto más rentable de la semana — subquery evita only_full_group_by
      q(`SELECT p.nombre_producto,
                t.ganancia,
                t.venta,
                CASE WHEN t.venta > 0
                     THEN ROUND(t.ganancia / t.venta * 100, 1)
                     ELSE 0 END AS margen_pct
         FROM (
           SELECT df.id_producto,
                  SUM(dvl.utilidad_total)                              AS ganancia,
                  SUM(df.cantidad_factura * df.precio_unitario_venta) AS venta
           FROM detalle_venta_lote dvl
           INNER JOIN detalle_factura df ON df.id_detalle = dvl.id_detalle_factura
           INNER JOIN factura f          ON f.id_factura  = df.id_factura
           WHERE DATE(f.fecha_factura) >= ?
             AND df.precio_unitario_venta > 0
           GROUP BY df.id_producto
           HAVING ganancia > 0
           ORDER BY ganancia DESC
           LIMIT 1
         ) t
         INNER JOIN producto p ON p.id_producto = t.id_producto`, [desde]),

      // Lotes PEPS con stock pero sin movimiento de venta en 60+ días
      q(`SELECT
           COUNT(DISTINCT ip.id_producto)                         AS productos,
           COALESCE(SUM(ip.cantidad_restante * ip.costo_unitario), 0) AS monto_inmovilizado
         FROM inventario_peps ip
         WHERE ip.activo = 1
           AND ip.cantidad_restante > 0
           AND ip.fecha_movimiento < DATE_SUB(?, INTERVAL 60 DAY)
           AND NOT EXISTS (
             SELECT 1 FROM detalle_venta_lote dvl
             INNER JOIN detalle_factura df ON df.id_detalle = dvl.id_detalle_factura
             INNER JOIN factura f ON f.id_factura = df.id_factura
             WHERE dvl.id_inventario_peps = ip.id_inventario_peps
               AND DATE(f.fecha_factura) >= DATE_SUB(?, INTERVAL 60 DAY)
           )`, [hoy, hoy])
    ])

    res.json({
      ok:            true,
      semana_desde:  desde,
      ganancia: {
        total:  parseFloat(ganancia[0]?.ganancia || 0),
        ventas: parseFloat(ganancia[0]?.ventas   || 0),
        notas:  parseInt(ganancia[0]?.notas      || 0),
        margen: ganancia[0]?.ventas > 0
          ? Math.round(parseFloat(ganancia[0].ganancia) / parseFloat(ganancia[0].ventas) * 100)
          : 0
      },
      mejor_cliente: mejorCliente[0]
        ? {
            nombre:        mejorCliente[0].nombre_cliente,
            grupo:         mejorCliente[0].nombre_grupo,
            total_vendido: parseFloat(mejorCliente[0].total_vendido || 0),
            notas:         parseInt(mejorCliente[0].notas || 0)
          }
        : null,
      top_producto: topProducto[0]
        ? {
            nombre:     topProducto[0].nombre_producto,
            ganancia:   parseFloat(topProducto[0].ganancia   || 0),
            venta:      parseFloat(topProducto[0].venta      || 0),
            margen_pct: parseFloat(topProducto[0].margen_pct || 0)
          }
        : null,
      estancados: {
        productos:          parseInt(estancados[0]?.productos          || 0),
        monto_inmovilizado: parseFloat(estancados[0]?.monto_inmovilizado || 0)
      }
    })
  } catch (e) {
    console.error('[dashboard] GET /ceo-insights:', e.message)
    res.status(500).json({ ok: false, error: e.message })
  }
})

module.exports = router
