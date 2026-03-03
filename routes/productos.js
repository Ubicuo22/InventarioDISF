/**
 * routes/productos.js — Consultas de productos e inventario
 * GET /api/productos
 * GET /api/resumen
 * GET /api/proveedores
 */

const router = require('express').Router()
const { q } = require('../db/pool')
const { requireAuth } = require('../middleware/auth')

// Lista de productos con stock actual
router.get('/', requireAuth, async (req, res) => {
  try {
    const { busqueda } = req.query
    const params = []
    let sql = `
      SELECT
        id_producto,
        numero_producto,
        nombre_producto,
        unidad_producto,
        stock
      FROM producto
      WHERE activo = 1
    `
    if (busqueda) {
      sql += ` AND nombre_producto LIKE ?`
      params.push(`%${busqueda}%`)
    }
    sql += ` ORDER BY nombre_producto ASC`

    const rows = await q(sql, params)
    res.json({ ok: true, data: rows })
  } catch (err) {
    console.error('[productos] GET /:', err.message)
    res.status(500).json({ ok: false, error: err.message })
  }
})

// Resumen rápido de stock
router.get('/resumen', requireAuth, async (req, res) => {
  try {
    const [stats] = await q(`
      SELECT
        COUNT(*)                                              AS total_productos,
        SUM(stock > 0)                                        AS con_stock,
        SUM(stock <= 0)                                       AS sin_stock,
        SUM(stock < 0)                                        AS stock_negativo,
        SUM(CASE WHEN stock > 0 AND stock <= 5 THEN 1 ELSE 0 END) AS stock_bajo
      FROM producto
      WHERE activo = 1
    `)
    res.json({ ok: true, data: stats })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// Lista de proveedores
router.get('/proveedores', requireAuth, async (req, res) => {
  try {
    const rows = await q(`SELECT id_proveedor, nombre_proveedor FROM proveedor ORDER BY nombre_proveedor ASC`)
    res.json({ ok: true, data: rows })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

module.exports = router
