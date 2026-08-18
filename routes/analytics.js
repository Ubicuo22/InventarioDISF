/**
 * DISFRULEG BODEGA — Análisis de Ventas
 *
 * GET /api/analytics/hoy            — Métricas del día actual
 * GET /api/analytics/periodo        — Métricas por rango de fechas (?fechaInicio=&fechaFin=)
 * GET /api/analytics/top-productos  — Top 10 productos por período
 */

const router      = require('express').Router()
const { q }       = require('../db/pool')
const { requireAuth } = require('../middleware/auth')
const { fechaMexico } = require('../utils/fecha')

router.use(requireAuth)

// ════════════════════════════════════════════════════════════
// GET /api/analytics/hoy
// ════════════════════════════════════════════════════════════
router.get('/hoy', async (req, res) => {
  try {
    const hoy = fechaMexico()
    // Q1: Ventas del día (notas, clientes, total)
    const [ventas, peps] = await Promise.all([
      q(`
        SELECT
          COUNT(DISTINCT f.id_factura)                                        AS total_notas,
          COUNT(DISTINCT f.id_cliente)                                        AS clientes_activos,
          COALESCE(SUM(df.cantidad_factura * df.precio_unitario_venta), 0)   AS total_vendido
        FROM factura f
        INNER JOIN detalle_factura df ON f.id_factura = df.id_factura
        WHERE DATE(f.fecha_factura) = ?
      `, [hoy]),
      // Q2: Ganancias PEPS del día
      q(`
        SELECT
          COALESCE(SUM(dvl.utilidad_total), 0)                               AS ganancia_total,
          COALESCE(SUM(dvl.cantidad_consumida * dvl.costo_unitario), 0)      AS costo_total
        FROM detalle_venta_lote dvl
        INNER JOIN detalle_factura df ON df.id_detalle = dvl.id_detalle_factura
        INNER JOIN factura f          ON f.id_factura  = df.id_factura
        WHERE DATE(f.fecha_factura) = ?
      `, [hoy])
    ])

    const v = ventas[0]  || {}
    const p = peps[0]    || {}

    const totalVendido = parseFloat(v.total_vendido  || 0)
    const ganancia     = parseFloat(p.ganancia_total || 0)
    const margen       = totalVendido > 0
      ? parseFloat(((ganancia / totalVendido) * 100).toFixed(1))
      : 0

    res.json({
      ok: true,
      data: {
        total_notas:       parseInt(v.total_notas       || 0),
        clientes_activos:  parseInt(v.clientes_activos  || 0),
        total_vendido:     totalVendido,
        ganancia_total:    ganancia,
        costo_total:       parseFloat(p.costo_total     || 0),
        margen_porcentaje: margen
      }
    })
  } catch (err) {
    console.error('[analytics] GET /hoy:', err.message)
    res.status(500).json({ ok: false, error: 'Error interno' })
  }
})

// ════════════════════════════════════════════════════════════
// GET /api/analytics/periodo?fechaInicio=YYYY-MM-DD&fechaFin=YYYY-MM-DD
// ════════════════════════════════════════════════════════════
router.get('/periodo', async (req, res) => {
  try {
    const { fechaInicio, fechaFin } = req.query
    if (!fechaInicio || !fechaFin) {
      return res.status(400).json({ ok: false, error: 'Faltan fechaInicio y fechaFin' })
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaInicio) || !/^\d{4}-\d{2}-\d{2}$/.test(fechaFin)) {
      return res.status(400).json({ ok: false, error: 'Formato de fecha inválido, use YYYY-MM-DD' })
    }

    // 3 queries en paralelo — mismo patrón que Electron analytics handler
    const [facturas, totalesPorFactura, pepsPorFactura] = await Promise.all([

      // Q1: Facturas del período con cliente
      q(`
        SELECT
          f.id_factura,
          DATE(f.fecha_factura) AS fecha,
          f.id_cliente
        FROM factura f
        WHERE DATE(f.fecha_factura) BETWEEN ? AND ?
      `, [fechaInicio, fechaFin]),

      // Q2: Total vendido por factura
      q(`
        SELECT
          df.id_factura,
          SUM(df.cantidad_factura * df.precio_unitario_venta) AS total_vendido
        FROM detalle_factura df
        INNER JOIN factura f ON f.id_factura = df.id_factura
        WHERE DATE(f.fecha_factura) BETWEEN ? AND ?
        GROUP BY df.id_factura
      `, [fechaInicio, fechaFin]),

      // Q3: Ganancias PEPS por factura
      q(`
        SELECT
          df.id_factura,
          COALESCE(SUM(dvl.cantidad_consumida * dvl.costo_unitario), 0) AS costo_total,
          COALESCE(SUM(dvl.utilidad_total), 0)                          AS ganancia
        FROM detalle_venta_lote dvl
        INNER JOIN detalle_factura df ON df.id_detalle = dvl.id_detalle_factura
        INNER JOIN factura f          ON f.id_factura  = df.id_factura
        WHERE DATE(f.fecha_factura) BETWEEN ? AND ?
        GROUP BY df.id_factura
      `, [fechaInicio, fechaFin])
    ])

    // — Merge en JS —
    const ventaMap = {}
    for (const r of totalesPorFactura) ventaMap[r.id_factura] = parseFloat(r.total_vendido || 0)
    const pepsMap = {}
    for (const r of pepsPorFactura)   pepsMap[r.id_factura]  = { costo: parseFloat(r.costo_total || 0), ganancia: parseFloat(r.ganancia || 0) }

    // Agrupar por día
    const porDiaMap = {}
    const clientesGlobal = new Set()
    let totalVendido = 0, gananciaTotal = 0, costoTotal = 0, totalNotas = 0

    for (const f of facturas) {
      const fecha    = f.fecha instanceof Date ? f.fecha.toISOString().split('T')[0] : String(f.fecha)
      const vendido  = ventaMap[f.id_factura] || 0
      const peps     = pepsMap[f.id_factura]  || { costo: 0, ganancia: 0 }

      clientesGlobal.add(f.id_cliente)
      totalVendido  += vendido
      gananciaTotal += peps.ganancia
      costoTotal    += peps.costo
      totalNotas    += 1

      if (!porDiaMap[fecha]) {
        porDiaMap[fecha] = { fecha, total_notas: 0, total_vendido: 0, ganancia: 0 }
      }
      porDiaMap[fecha].total_notas   += 1
      porDiaMap[fecha].total_vendido += vendido
      porDiaMap[fecha].ganancia      += peps.ganancia
    }

    // Ordenar días desc y redondear
    const por_dia = Object.values(porDiaMap)
      .sort((a, b) => b.fecha.localeCompare(a.fecha))
      .map(d => ({
        ...d,
        total_vendido:     parseFloat(d.total_vendido.toFixed(2)),
        ganancia:          parseFloat(d.ganancia.toFixed(2)),
        margen_porcentaje: d.total_vendido > 0
          ? parseFloat(((d.ganancia / d.total_vendido) * 100).toFixed(1))
          : 0
      }))

    const margenGlobal = totalVendido > 0
      ? parseFloat(((gananciaTotal / totalVendido) * 100).toFixed(1))
      : 0

    res.json({
      ok: true,
      data: {
        resumen: {
          total_notas:       totalNotas,
          clientes_activos:  clientesGlobal.size,
          total_vendido:     parseFloat(totalVendido.toFixed(2)),
          ganancia_total:    parseFloat(gananciaTotal.toFixed(2)),
          costo_total:       parseFloat(costoTotal.toFixed(2)),
          margen_porcentaje: margenGlobal
        },
        por_dia
      }
    })
  } catch (err) {
    console.error('[analytics] GET /periodo:', err.message)
    res.status(500).json({ ok: false, error: 'Error interno' })
  }
})

// ════════════════════════════════════════════════════════════
// GET /api/analytics/top-productos?fechaInicio=&fechaFin=
// ════════════════════════════════════════════════════════════
router.get('/top-productos', async (req, res) => {
  try {
    const { fechaInicio, fechaFin } = req.query
    if (!fechaInicio || !fechaFin) {
      return res.status(400).json({ ok: false, error: 'Faltan fechaInicio y fechaFin' })
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaInicio) || !/^\d{4}-\d{2}-\d{2}$/.test(fechaFin)) {
      return res.status(400).json({ ok: false, error: 'Formato de fecha inválido, use YYYY-MM-DD' })
    }

    const rows = await q(`
      SELECT
        p.nombre_producto,
        p.unidad_producto,
        SUM(df.cantidad_factura)                                              AS cantidad_vendida,
        SUM(df.cantidad_factura * df.precio_unitario_venta)                   AS total_vendido,
        COUNT(DISTINCT f.id_factura)                                          AS veces_vendido
      FROM producto p
      INNER JOIN detalle_factura df ON p.id_producto = df.id_producto
      INNER JOIN factura f          ON df.id_factura  = f.id_factura
      WHERE DATE(f.fecha_factura) BETWEEN ? AND ?
        AND p.activo = 1
      GROUP BY p.id_producto, p.nombre_producto, p.unidad_producto
      ORDER BY total_vendido DESC
      LIMIT 10
    `, [fechaInicio, fechaFin])

    res.json({ ok: true, data: rows })
  } catch (err) {
    console.error('[analytics] GET /top-productos:', err.message)
    res.status(500).json({ ok: false, error: 'Error interno' })
  }
})

// ════════════════════════════════════════════════════════════
// GET /api/analytics/notas?fecha=YYYY-MM-DD
// Lista individual de facturas de un día con cliente, grupo,
// monto, productos y ganancia PEPS.
// ════════════════════════════════════════════════════════════
router.get('/notas', async (req, res) => {
  try {
    const fecha = req.query.fecha || new Date().toISOString().split('T')[0]

    const [notas, detalles] = await Promise.all([

      // — Cabecera de cada nota —
      q(`
        SELECT
          f.id_factura,
          f.fecha_factura,
          c.nombre_cliente,
          g.nombre_grupo,
          COALESCE(SUM(df.cantidad_factura * df.precio_unitario_venta), 0) AS total_vendido,
          COUNT(df.id_detalle)                                              AS num_productos
        FROM factura f
        INNER JOIN cliente c         ON c.id_cliente = f.id_cliente
        INNER JOIN grupo   g         ON g.id_grupo   = c.id_grupo
        LEFT  JOIN detalle_factura df ON df.id_factura = f.id_factura
        WHERE DATE(f.fecha_factura) = ?
        GROUP BY f.id_factura, f.fecha_factura, c.nombre_cliente, g.nombre_grupo
        ORDER BY f.fecha_factura DESC
      `, [fecha]),

      // — Ganancia PEPS por nota —
      q(`
        SELECT
          df.id_factura,
          COALESCE(SUM(dvl.utilidad_total), 0) AS ganancia
        FROM detalle_venta_lote dvl
        INNER JOIN detalle_factura df ON df.id_detalle = dvl.id_detalle_factura
        INNER JOIN factura f          ON f.id_factura  = df.id_factura
        WHERE DATE(f.fecha_factura) = ?
        GROUP BY df.id_factura
      `, [fecha])
    ])

    // Merge ganancia a cada nota
    const gananciaMap = {}
    for (const r of detalles) gananciaMap[r.id_factura] = parseFloat(r.ganancia || 0)

    const lista = notas.map(n => {
      const totalVendido = parseFloat(n.total_vendido || 0)
      const ganancia     = gananciaMap[n.id_factura] || 0
      const margen       = totalVendido > 0
        ? parseFloat(((ganancia / totalVendido) * 100).toFixed(1))
        : 0
      // Serializa la fecha MySQL como ISO string si viene como Date
      const fechaISO = n.fecha_factura instanceof Date
        ? n.fecha_factura.toISOString()
        : String(n.fecha_factura)
      return {
        id_factura:     n.id_factura,
        fecha_factura:  fechaISO,
        nombre_cliente: n.nombre_cliente,
        nombre_grupo:   n.nombre_grupo,
        total_vendido:  totalVendido,
        ganancia:       parseFloat(ganancia.toFixed(2)),
        margen,
        num_productos:  parseInt(n.num_productos || 0)
      }
    })

    res.json({ ok: true, fecha, data: lista })
  } catch (err) {
    console.error('[analytics] GET /notas:', err.message)
    res.status(500).json({ ok: false, error: 'Error interno' })
  }
})

module.exports = router
