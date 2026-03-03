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

// Búsqueda de productos con precio por grupo (para módulo de pedidos)
router.get('/buscar', requireAuth, async (req, res) => {
  try {
    const { q: query = '', groupId } = req.query
    const search = `%${query}%`
    let rows
    if (groupId) {
      rows = await q(`
        SELECT p.id_producto, p.numero_producto, p.nombre_producto,
               p.unidad_producto, p.stock,
               COALESCE(pg.precio_base, 0) AS precio_base
        FROM   producto p
        LEFT   JOIN precio_por_grupo pg
               ON p.id_producto = pg.id_producto AND pg.id_grupo = ?
        WHERE  p.activo = 1
          AND  p.nombre_producto LIKE ?
        ORDER  BY p.nombre_producto
        LIMIT  25
      `, [groupId, search])
    } else {
      rows = await q(`
        SELECT id_producto, numero_producto, nombre_producto,
               unidad_producto, stock, 0 AS precio_base
        FROM   producto
        WHERE  activo = 1 AND nombre_producto LIKE ?
        ORDER  BY nombre_producto
        LIMIT  25
      `, [search])
    }
    res.json({ ok: true, data: rows })
  } catch (err) {
    console.error('[productos] GET /buscar:', err.message)
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
