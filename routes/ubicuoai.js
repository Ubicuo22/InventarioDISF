/**
 * routes/ubicuoai.js — Análisis de texto con motor IA
 * Misma lógica que ubicuoai.handler.js del electron, adaptada a Express + MySQL
 *
 * POST /api/ubicuoai/analizar    — Parsea texto libre → carrito con secciones
 * POST /api/ubicuoai/correccion  — Guarda corrección en ubicuoai_learning
 */

const router = require('express').Router()
const { q }  = require('../db/pool')
const { requireAuth } = require('../middleware/auth')
const { UbicuoEngine } = require('../ia/ubicuo-engine')

router.use(requireAuth)

/* ─── helpers ─────────────────────────────────────────────── */

/**
 * Normalización idéntica a UbicuoMatcher.normalize() y al handler de electron.
 * Garantiza que "Limón", "LIMON" y "limon" sean la misma clave en BD y no
 * creen filas duplicadas en ubicuoai_learning.
 */
function normalizeText (text) {
  return text
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quitar acentos / diacríticos
    .replace(/\s+/g, ' ')
}

async function getProducts (groupId) {
  if (groupId) {
    return q(`
      SELECT p.id_producto, p.nombre_producto, p.unidad_producto,
             COALESCE(ppg.precio_base, 0) AS precio_base
      FROM   producto p
      LEFT JOIN precio_por_grupo ppg
             ON p.id_producto = ppg.id_producto AND ppg.id_grupo = ?
      WHERE  p.activo = 1
      ORDER  BY p.nombre_producto ASC
    `, [groupId])
  }
  return q(`
    SELECT id_producto, nombre_producto, unidad_producto, 0 AS precio_base
    FROM   producto
    WHERE  activo = 1
    ORDER  BY nombre_producto ASC
  `)
}

async function getLearningDict (groupId) {
  // Globales (id_grupo IS NULL) primero; las específicas del grupo las sobreescriben.
  // Misma estrategia que getCachedLearning() del electron.
  const rows = await q(
    `SELECT incorrect, correct, id_grupo
     FROM ubicuoai_learning
     WHERE id_grupo IS NULL OR id_grupo = ?
     ORDER BY id_grupo IS NULL DESC`,
    [groupId ?? 0]
  )
  const dict = {}
  rows.forEach(r => { dict[normalizeText(r.incorrect)] = r.correct })
  return dict
}

/* ─── POST /api/ubicuoai/analizar ─────────────────────────── */
router.post('/analizar', async (req, res) => {
  try {
    const { text, groupId } = req.body
    if (!text || !text.trim()) {
      return res.status(400).json({ ok: false, error: 'Texto requerido' })
    }

    const [products, learningDict] = await Promise.all([
      getProducts(groupId || null),
      getLearningDict(groupId || null)
    ])

    const result = UbicuoEngine.process({ text, products, learningDict, threshold: 0.75 })

    if (!result.success) {
      return res.json({ ok: true, data: { ...result, productos: [], secciones: [] } })
    }

    // Enriquecer cada producto con su precio (el engine no lo incluye)
    const preciosMap = new Map(products.map(p => [p.id_producto, p.precio_base || 0]))
    result.productos.forEach(prod => {
      if (prod.producto_id) prod.precio = preciosMap.get(prod.producto_id) || 0
    })

    res.json({ ok: true, data: result })
  } catch (e) {
    console.error('[ubicuoai] POST /analizar:', e.message)
    res.status(500).json({ ok: false, error: 'Error al analizar el texto' })
  }
})

/* ─── POST /api/ubicuoai/correccion ───────────────────────── */
router.post('/correccion', async (req, res) => {
  try {
    const { incorrect, correct, grupoId = null } = req.body
    if (!incorrect || !correct) {
      return res.status(400).json({ ok: false, error: 'incorrect y correct son requeridos' })
    }

    // Misma normalización que getCachedLearning() en el electron: NFD + sin acentos + lowercase
    const inc = normalizeText(incorrect).substring(0, 200)
    const cor = correct.trim().substring(0, 200)
    const gid = grupoId ?? null

    // Buscar fila existente para el mismo (incorrect, id_grupo) — evita duplicados
    const [existing] = await q(
      `SELECT id FROM ubicuoai_learning
       WHERE incorrect = ?
         AND (id_grupo = ? OR (id_grupo IS NULL AND ? IS NULL))`,
      [inc, gid, gid]
    )

    if (existing) {
      await q(`
        UPDATE ubicuoai_learning
        SET    correct = ?, times_used = times_used + 1, last_used = NOW()
        WHERE  incorrect = ?
          AND  (id_grupo = ? OR (id_grupo IS NULL AND ? IS NULL))
      `, [cor, inc, gid, gid])
    } else {
      await q(`
        INSERT INTO ubicuoai_learning (incorrect, correct, id_grupo, times_used, first_added, last_used)
        VALUES (?, ?, ?, 1, NOW(), NOW())
      `, [inc, cor, gid])
    }

    res.json({ ok: true })
  } catch (e) {
    console.error('[ubicuoai] POST /correccion:', e.message)
    res.status(500).json({ ok: false, error: 'Error al guardar corrección' })
  }
})

module.exports = router
