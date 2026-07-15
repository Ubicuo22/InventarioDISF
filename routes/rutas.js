const router = require('express').Router()
const { q }  = require('../db/pool')
const { requireAuth } = require('../middleware/auth')

router.use(requireAuth)

router.get('/repartidores', async (req, res) => {
  try {
    const rows = await q('SELECT id, nombre, conductor FROM unidades WHERE activa = 1 ORDER BY nombre')
    res.json({ ok: true, data: rows })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

router.post('/rutas/asignar-pedido', async (req, res) => {
  const { folio_numero, unidad_id, conductor } = req.body
  if (!folio_numero || !unidad_id) return res.status(400).json({ ok: false, error: 'Faltan datos' })
  try {
    const hoy = new Date().toISOString().slice(0, 10)

    let [ruta] = await q(
      "SELECT id FROM rutas WHERE unidad_id = ? AND fecha = ? AND estado IN ('pendiente','en_curso') LIMIT 1",
      [unidad_id, hoy]
    )
    if (!ruta) {
      const [result] = await q(
        "INSERT INTO rutas (unidad_id, fecha, estado) VALUES (?, ?, 'pendiente')",
        [unidad_id, hoy]
      )
      ruta = { id: result.insertId }
    }

    const [orden] = await q(
      'SELECT id_cliente FROM ordenes_guardadas WHERE folio_numero = ? LIMIT 1',
      [folio_numero]
    )
    const id_cliente = orden?.id_cliente || null
    let geocerca_id = null
    if (id_cliente) {
      const [geo] = await q('SELECT id FROM geocercas WHERE cliente_id = ? AND activa = 1 LIMIT 1', [id_cliente])
      geocerca_id = geo?.id || null
    }

    const [[{ total }]] = await q('SELECT COUNT(*) AS total FROM ruta_pedidos WHERE ruta_id = ?', [ruta.id])
    const orden_planeado = (total || 0) + 1

    await q(
      'INSERT INTO ruta_pedidos (ruta_id, pedido_id, geocerca_id, orden_planeado, estado) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE ruta_id = VALUES(ruta_id)',
      [ruta.id, folio_numero, geocerca_id, orden_planeado, 'pendiente']
    )

    // Actualizar nombre del conductor del día en la unidad
    if (conductor) await q('UPDATE unidades SET conductor = ? WHERE id = ?', [conductor, unidad_id])

    res.json({ ok: true, ruta_id: ruta.id })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

module.exports = router
