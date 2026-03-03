const router = require('express').Router()
const { q }  = require('../db/pool')
const { requireAuth } = require('../middleware/auth')

router.use(requireAuth)

/* ─── GET /api/clientes/grupos ───────────────────── */
router.get('/grupos', async (req, res) => {
  try {
    const rows = await q('SELECT id_grupo, nombre_grupo FROM grupo ORDER BY nombre_grupo')
    res.json({ ok: true, data: rows })
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Error al obtener grupos' })
  }
})

/* ─── GET /api/clientes?groupId=X ────────────────── */
router.get('/', async (req, res) => {
  try {
    const { groupId } = req.query
    let rows
    if (groupId) {
      rows = await q(`
        SELECT id_cliente, nombre_cliente
        FROM   cliente
        WHERE  id_grupo = ? AND activo = 1
        ORDER  BY nombre_cliente
      `, [groupId])
    } else {
      rows = await q(`
        SELECT id_cliente, nombre_cliente, id_grupo
        FROM   cliente
        WHERE  activo = 1
        ORDER  BY nombre_cliente
      `)
    }
    res.json({ ok: true, data: rows })
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Error al obtener clientes' })
  }
})

module.exports = router
