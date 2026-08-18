/**
 * routes/compras.js — Historial y resumen de compras
 *
 * GET /api/compras/resumen?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
 *   Devuelve compras agrupadas por día con desglose de productos y proveedor
 */

const router = require('express').Router()
const { q }  = require('../db/pool')
const { requireAuth } = require('../middleware/auth')
const { fechaMexico } = require('../utils/fecha')

router.get('/resumen', requireAuth, async (req, res) => {
  try {
    const hoy    = fechaMexico()
    const hace30 = fechaMexico(-30)

    const desde = req.query.desde || hace30
    const hasta = req.query.hasta || hoy
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
      return res.status(400).json({ ok: false, error: 'Formato de fecha inválido, use YYYY-MM-DD' })
    }

    const rows = await q(`
      SELECT
        DATE(c.fecha_compra)                           AS fecha,
        c.id_compra,
        p.nombre_producto,
        p.unidad_producto,
        c.cantidad_compra,
        c.precio_unitario_compra,
        c.subtotal,
        c.iva,
        c.total_con_impuestos,
        c.incluye_iva,
        c.folio_factura,
        c.usuario_registro,
        COALESCE(prov.nombre_proveedor, '—')           AS proveedor
      FROM compra c
      INNER JOIN producto p   ON c.id_producto  = p.id_producto
      LEFT  JOIN proveedor prov ON c.id_proveedor = prov.id_proveedor
      WHERE DATE(c.fecha_compra) BETWEEN ? AND ?
        -- Excluir compras sintéticas (4.2.2): phantom, ajustes y bootstrap a $0.01
        -- no cuentan en totales de gasto ni promedios
        AND (c.notas IS NULL OR (
              c.notas NOT LIKE 'PHANTOM:%'
          AND c.notas NOT LIKE 'AJUSTE:%'
          AND NOT (c.notas LIKE 'BOOTSTRAP:%' AND c.precio_unitario_compra <= 0.01)
        ))
      ORDER BY c.fecha_compra DESC, c.id_compra DESC
    `, [desde, hasta])

    // Agrupar por fecha
    const diasMap = new Map()
    for (const row of rows) {
      const fecha = typeof row.fecha === 'string'
        ? row.fecha.slice(0, 10)
        : new Date(row.fecha).toISOString().slice(0, 10)

      if (!diasMap.has(fecha)) {
        diasMap.set(fecha, {
          fecha,
          total_gasto:  0,
          total_iva:    0,
          num_compras:  0,
          proveedores:  new Set(),
          compras:      []
        })
      }

      const dia = diasMap.get(fecha)
      const total = parseFloat(row.total_con_impuestos) || 0
      const iva   = parseFloat(row.iva)   || 0
      dia.total_gasto += total
      dia.total_iva   += iva
      dia.num_compras++
      if (row.proveedor && row.proveedor !== '—') dia.proveedores.add(row.proveedor)

      dia.compras.push({
        id_compra:       row.id_compra,
        nombre_producto: row.nombre_producto,
        unidad_producto: row.unidad_producto,
        cantidad:        parseFloat(row.cantidad_compra) || 0,
        precio_unitario: parseFloat(row.precio_unitario_compra) || 0,
        subtotal:        parseFloat(row.subtotal) || 0,
        iva:             iva,
        total:           total,
        incluye_iva:     !!row.incluye_iva,
        folio:           row.folio_factura || null,
        usuario:         row.usuario_registro,
        proveedor:       row.proveedor
      })
    }

    // Serializar — convertir Set a array
    const dias = Array.from(diasMap.values()).map(d => ({
      ...d,
      total_gasto: parseFloat(d.total_gasto.toFixed(2)),
      total_iva:   parseFloat(d.total_iva.toFixed(2)),
      proveedores: Array.from(d.proveedores)
    }))

    // Totales del período
    const totalPeriodo = dias.reduce((s, d) => s + d.total_gasto, 0)
    const totalCompras = dias.reduce((s, d) => s + d.num_compras, 0)

    res.json({
      ok:    true,
      desde, hasta,
      resumen: {
        total_periodo:  parseFloat(totalPeriodo.toFixed(2)),
        total_compras:  totalCompras,
        dias_con_gasto: dias.length
      },
      dias
    })
  } catch (err) {
    console.error('[compras] GET /resumen:', err.message)
    res.status(500).json({ ok: false, error: 'Error interno' })
  }
})

module.exports = router
