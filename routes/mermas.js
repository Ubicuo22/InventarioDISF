const router = require('express').Router()
const { q }   = require('../db/pool')
const { requireAuth } = require('../middleware/auth')

router.use(requireAuth)

/* ─── POST /api/mermas — registrar merma/ajuste ─── */
router.post('/', async (req, res) => {
  const { id_producto, tipo_merma, cantidad_merma, motivo, fecha_merma, notas } = req.body
  if (!id_producto)    return res.status(400).json({ ok: false, error: 'id_producto requerido' })
  if (!tipo_merma)     return res.status(400).json({ ok: false, error: 'tipo_merma requerido' })
  if (!cantidad_merma || cantidad_merma <= 0)
                       return res.status(400).json({ ok: false, error: 'cantidad_merma debe ser mayor a 0' })
  if (!motivo?.trim()) return res.status(400).json({ ok: false, error: 'motivo requerido' })

  const tiposValidos = ['VENCIMIENTO','DAÑO','ROBO','AJUSTE_INVENTARIO','OTRO']
  if (!tiposValidos.includes(tipo_merma))
    return res.status(400).json({ ok: false, error: 'tipo_merma inválido' })

  const fecha  = fecha_merma || new Date().toISOString().slice(0, 10)
  const usuario = req.user.username

  const conn = await require('../db/pool').pool.getConnection()
  try {
    await conn.beginTransaction()

    // Verificar stock actual
    const [[prod]] = await conn.execute(
      'SELECT stock, nombre_producto, unidad_producto FROM producto WHERE id_producto = ? AND activo = 1',
      [id_producto]
    )
    if (!prod) { await conn.rollback(); return res.status(404).json({ ok: false, error: 'Producto no encontrado' }) }
    if (prod.stock < cantidad_merma)
      return res.status(400).json({ ok: false, error: `Stock insuficiente. Disponible: ${prod.stock} ${prod.unidad_producto}` })

    // Insertar merma (sin costo — simplificado para web)
    const [ins] = await conn.execute(`
      INSERT INTO merma (id_producto, cantidad_merma, tipo_merma, motivo, fecha_merma,
                         costo_unitario, costo_total, usuario_registro, notas)
      VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
    `, [id_producto, cantidad_merma, tipo_merma, motivo.trim(), fecha, usuario, notas?.trim() || null])

    // Actualizar stock del producto
    await conn.execute(
      'UPDATE producto SET stock = stock - ? WHERE id_producto = ?',
      [cantidad_merma, id_producto]
    )

    await conn.commit()
    res.json({ ok: true, id_merma: ins.insertId, nombre_producto: prod.nombre_producto })
  } catch (e) {
    await conn.rollback()
    console.error('[mermas] POST /', e.message)
    res.status(500).json({ ok: false, error: 'Error al registrar la merma' })
  } finally {
    conn.release()
  }
})

/* ─── GET /api/mermas/recientes — últimas 30 ─── */
router.get('/recientes', async (req, res) => {
  try {
    const rows = await q(`
      SELECT m.id_merma, m.tipo_merma, m.cantidad_merma, m.motivo,
             m.fecha_merma, m.usuario_registro, m.fecha_registro,
             p.nombre_producto, p.unidad_producto
      FROM   merma m
      INNER JOIN producto p ON m.id_producto = p.id_producto
      WHERE  m.activo = 1
      ORDER  BY m.fecha_registro DESC
      LIMIT  30
    `)
    res.json({ ok: true, data: rows })
  } catch (e) {
    console.error('[mermas] GET /recientes', e.message)
    res.status(500).json({ ok: false, error: 'Error al obtener mermas' })
  }
})

module.exports = router
