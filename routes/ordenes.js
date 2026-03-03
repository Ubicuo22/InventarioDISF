const router  = require('express').Router()
const { q }   = require('../db/pool')
const { requireAuth } = require('../middleware/auth')

router.use(requireAuth)

/* ─── helpers ─────────────────────────────────────── */
function calcTotal (datosCarrito) {
  let total = 0
  for (const items of Object.values(datosCarrito || {})) {
    for (const item of items) {
      total += (parseFloat(item.cantidad) || 0) * (parseFloat(item.precio_unitario) || 0)
    }
  }
  return Math.round(total * 100) / 100
}

/* ─── GET /api/ordenes?estado=guardada|registrada ─── */
router.get('/', async (req, res) => {
  try {
    const estado = req.query.estado === 'registrada' ? 'registrada' : 'guardada'
    const rows = await q(`
      SELECT o.folio_numero, o.id_cliente, c.nombre_cliente,
             g.id_grupo, g.nombre_grupo,
             o.total_estimado, o.estado,
             o.fecha_creacion, o.fecha_modificacion, o.usuario_creador
      FROM   ordenes_guardadas o
      INNER JOIN cliente c ON o.id_cliente = c.id_cliente
      INNER JOIN grupo   g ON c.id_grupo   = g.id_grupo
      WHERE  o.estado = ? AND o.activo = 1
      ORDER  BY o.folio_numero DESC
    `, [estado])
    res.json({ ok: true, data: rows })
  } catch (e) {
    console.error('[ordenes] GET /', e.message)
    res.status(500).json({ ok: false, error: 'Error al obtener órdenes' })
  }
})

/* ─── GET /api/ordenes/:folio ───────────────────────── */
router.get('/:folio', async (req, res) => {
  try {
    const [row] = await q(`
      SELECT o.*, c.nombre_cliente, c.id_grupo, g.nombre_grupo
      FROM   ordenes_guardadas o
      INNER JOIN cliente c ON o.id_cliente = c.id_cliente
      INNER JOIN grupo   g ON c.id_grupo   = g.id_grupo
      WHERE  o.folio_numero = ? AND o.activo = 1
    `, [req.params.folio])
    if (!row) return res.status(404).json({ ok: false, error: 'Orden no encontrada' })
    res.json({ ok: true, data: row })
  } catch (e) {
    console.error('[ordenes] GET /:folio', e.message)
    res.status(500).json({ ok: false, error: 'Error al obtener la orden' })
  }
})

/* ─── POST /api/ordenes — crear o actualizar ──────── */
router.post('/', async (req, res) => {
  try {
    const { folio_numero, id_cliente, datos_carrito } = req.body
    if (!id_cliente)      return res.status(400).json({ ok: false, error: 'id_cliente requerido' })
    if (!datos_carrito)   return res.status(400).json({ ok: false, error: 'datos_carrito requerido' })

    const usuario = req.user.username
    const total   = calcTotal(datos_carrito)
    const cartStr = JSON.stringify(datos_carrito)

    if (folio_numero) {
      // — UPDATE orden existente (solo si está en estado 'guardada')
      const [existing] = await q(
        'SELECT estado FROM ordenes_guardadas WHERE folio_numero = ? AND activo = 1',
        [folio_numero]
      )
      if (!existing) return res.status(404).json({ ok: false, error: 'Orden no encontrada' })
      if (existing.estado === 'registrada')
        return res.status(400).json({ ok: false, error: 'No se puede editar una orden ya registrada' })

      await q(`
        UPDATE ordenes_guardadas
        SET    datos_carrito = ?, total_estimado = ?, fecha_modificacion = NOW()
        WHERE  folio_numero = ?
      `, [cartStr, total, folio_numero])

      res.json({ ok: true, folio_numero })
    } else {
      // — INSERT nueva orden
      const [maxRow] = await q('SELECT COALESCE(MAX(folio_numero), 0) + 1 AS next FROM ordenes_guardadas')
      const nextFolio = maxRow.next

      await q(`
        INSERT INTO ordenes_guardadas
          (folio_numero, id_cliente, usuario_creador, datos_carrito, total_estimado, estado, activo)
        VALUES (?, ?, ?, ?, ?, 'guardada', 1)
      `, [nextFolio, id_cliente, usuario, cartStr, total])

      res.json({ ok: true, folio_numero: nextFolio })
    }
  } catch (e) {
    console.error('[ordenes] POST /', e.message)
    res.status(500).json({ ok: false, error: 'Error al guardar la orden' })
  }
})

module.exports = router
