/**
 * routes/precios.js — Gestión de precios por grupo (CEO)
 *
 * GET  /api/precios/grupos              — lista todos los grupos
 * GET  /api/precios?id_grupo=X         — productos con sus precios para el grupo
 * PUT  /api/precios                    — upsert precio individual
 * POST /api/precios/ajuste-masivo      — aplica % a todos los precios de un grupo
 * POST /api/precios/copiar-grupo       — copia precios de un grupo a otro
 */

const router = require('express').Router()
const { q, pool } = require('../db/pool')
const { requireAuth, requireAdmin } = require('../middleware/auth')

router.use(requireAuth, requireAdmin)

// ── GET /api/precios/grupos ────────────────────────────────
router.get('/grupos', async (req, res) => {
  try {
    const rows = await q(
      `SELECT g.id_grupo, g.nombre_grupo, COALESCE(tc.descuento, 0) AS descuento
       FROM grupo g
       LEFT JOIN tipo_cliente tc ON tc.id_tipo_cliente = g.id_tipo_cliente
       ORDER BY g.nombre_grupo ASC`
    )
    res.json({ ok: true, data: rows })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── GET /api/precios?id_grupo=X ────────────────────────────
router.get('/', async (req, res) => {
  const { id_grupo } = req.query
  if (!id_grupo) return res.status(400).json({ ok: false, error: 'id_grupo requerido' })
  try {
    const rows = await q(
      `SELECT p.id_producto, p.nombre_producto, p.unidad_producto,
              COALESCE(pg.precio_base, 0)   AS precio_base,
              COALESCE(tc.descuento, 0)     AS descuento,
              CASE WHEN COALESCE(tc.descuento, 0) > 0
                   THEN ROUND(COALESCE(pg.precio_base, 0) * (1 - tc.descuento / 100), 2)
                   ELSE COALESCE(pg.precio_base, 0)
              END AS precio_final
       FROM producto p
       CROSS JOIN grupo g
       LEFT JOIN tipo_cliente tc ON tc.id_tipo_cliente = g.id_tipo_cliente
       LEFT JOIN precio_por_grupo pg
         ON pg.id_producto = p.id_producto AND pg.id_grupo = g.id_grupo
       WHERE g.id_grupo = ? AND p.activo = 1
       ORDER BY p.nombre_producto ASC`,
      [id_grupo]
    )
    res.json({ ok: true, data: rows })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── PUT /api/precios — upsert precio individual ────────────
router.put('/', async (req, res) => {
  const { id_producto, id_grupo, precio_base } = req.body
  if (!id_producto || !id_grupo || precio_base == null) {
    return res.status(400).json({ ok: false, error: 'id_producto, id_grupo y precio_base requeridos' })
  }
  const precio = parseFloat(precio_base)
  if (isNaN(precio) || precio < 0) {
    return res.status(400).json({ ok: false, error: 'precio_base inválido' })
  }
  try {
    if (precio === 0) {
      await pool.execute(
        `DELETE FROM precio_por_grupo WHERE id_producto = ? AND id_grupo = ?`,
        [id_producto, id_grupo]
      )
    } else {
      await pool.execute(
        `INSERT INTO precio_por_grupo (id_producto, id_grupo, precio_base)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE precio_base = VALUES(precio_base)`,
        [id_producto, id_grupo, precio]
      )
    }
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── POST /api/precios/ajuste-masivo ───────────────────────
// { id_grupo, pct }  — pct positivo = aumento, negativo = descuento
router.post('/ajuste-masivo', async (req, res) => {
  const { id_grupo, pct } = req.body
  if (!id_grupo || pct == null) {
    return res.status(400).json({ ok: false, error: 'id_grupo y pct requeridos' })
  }
  const factor = 1 + parseFloat(pct) / 100
  if (isNaN(factor) || factor <= 0) {
    return res.status(400).json({ ok: false, error: 'pct inválido' })
  }
  try {
    const [result] = await pool.execute(
      `UPDATE precio_por_grupo
       SET precio_base = ROUND(precio_base * ?, 2)
       WHERE id_grupo = ? AND precio_base > 0`,
      [factor, id_grupo]
    )
    res.json({ ok: true, actualizados: result.affectedRows })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── POST /api/precios/copiar-grupo ─────────────────────────
// { id_grupo_origen, id_grupo_destino, sobrescribir }
router.post('/copiar-grupo', async (req, res) => {
  const { id_grupo_origen, id_grupo_destino, sobrescribir = false } = req.body
  if (!id_grupo_origen || !id_grupo_destino) {
    return res.status(400).json({ ok: false, error: 'id_grupo_origen e id_grupo_destino requeridos' })
  }
  if (String(id_grupo_origen) === String(id_grupo_destino)) {
    return res.status(400).json({ ok: false, error: 'Origen y destino no pueden ser el mismo grupo' })
  }
  try {
    const sql = sobrescribir
      ? `INSERT INTO precio_por_grupo (id_producto, id_grupo, precio_base)
         SELECT id_producto, ?, precio_base FROM precio_por_grupo WHERE id_grupo = ?
         ON DUPLICATE KEY UPDATE precio_base = VALUES(precio_base)`
      : `INSERT IGNORE INTO precio_por_grupo (id_producto, id_grupo, precio_base)
         SELECT id_producto, ?, precio_base FROM precio_por_grupo WHERE id_grupo = ?`
    const [result] = await pool.execute(sql, [id_grupo_destino, id_grupo_origen])
    res.json({ ok: true, copiados: result.affectedRows })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

module.exports = router
