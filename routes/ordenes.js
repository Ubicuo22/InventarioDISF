const router  = require('express').Router()
const { q }   = require('../db/pool')
const { requireAuth } = require('../middleware/auth')
const { registrar } = require('../utils/actividad')

router.use(requireAuth)

/* ─── helpers ─────────────────────────────────────── */
function calcTotal (datosCarrito) {
  let total = 0
  for (const [key, items] of Object.entries(datosCarrito || {})) {
    if (key.startsWith('__')) continue
    if (!Array.isArray(items)) continue
    for (const item of items) {
      total += (parseFloat(item.cantidad) || 0) * (parseFloat(item.precio_unitario) || 0)
    }
  }
  return Math.round(total * 100) / 100
}

/**
 * Compara carrito viejo vs nuevo y genera un array de cambios.
 * Formato compatible con app Electron (v3.6.8). Ignora claves internas (__*).
 */
function computarDiffCarrito (viejo, nuevo) {
  const cambios = []
  const oldItems = new Map()
  const newItems = new Map()

  for (const [sec, items] of Object.entries(viejo || {})) {
    if (sec.startsWith('__')) continue
    if (!Array.isArray(items)) continue
    for (const item of items) {
      oldItems.set(`${sec}::${item.id_producto}`, { ...item, seccion: sec })
    }
  }
  for (const [sec, items] of Object.entries(nuevo || {})) {
    if (sec.startsWith('__')) continue
    if (!Array.isArray(items)) continue
    for (const item of items) {
      newItems.set(`${sec}::${item.id_producto}`, { ...item, seccion: sec })
    }
  }

  for (const [key, oldItem] of oldItems) {
    const newItem = newItems.get(key)
    if (!newItem) {
      cambios.push({ producto: oldItem.nombre_producto, tipo: 'eliminado', seccion: oldItem.seccion })
    } else {
      const oldCant = parseFloat(oldItem.cantidad) || 0
      const newCant = parseFloat(newItem.cantidad) || 0
      const oldPrec = parseFloat(oldItem.precio_unitario) || 0
      const newPrec = parseFloat(newItem.precio_unitario) || 0
      if (oldCant !== newCant) {
        cambios.push({ producto: oldItem.nombre_producto, campo: 'cantidad', antes: oldCant, despues: newCant })
      }
      if (oldPrec !== newPrec) {
        cambios.push({ producto: oldItem.nombre_producto, campo: 'precio', antes: oldPrec, despues: newPrec })
      }
    }
  }
  for (const [key, newItem] of newItems) {
    if (!oldItems.has(key)) {
      cambios.push({
        producto: newItem.nombre_producto,
        tipo: 'agregado',
        seccion: newItem.seccion,
        cantidad: parseFloat(newItem.cantidad) || 0,
        precio: parseFloat(newItem.precio_unitario) || 0
      })
    }
  }
  return cambios
}

/* ─── GET /api/ordenes?estado=guardada|registrada ─── */
router.get('/', async (req, res) => {
  try {
    const estado = req.query.estado === 'registrada' ? 'registrada' : 'guardada'
    const rows = await q(`
      SELECT o.folio_numero, o.id_cliente, c.nombre_cliente,
             g.id_grupo, g.nombre_grupo,
             o.total_estimado, o.estado,
             o.fecha_creacion, o.fecha_modificacion, o.usuario_creador,
             o.datos_carrito
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

    if (folio_numero) {
      // — UPDATE orden existente (solo si está en estado 'guardada')
      const [existing] = await q(
        'SELECT estado, datos_carrito FROM ordenes_guardadas WHERE folio_numero = ? AND activo = 1',
        [folio_numero]
      )
      if (!existing) return res.status(404).json({ ok: false, error: 'Orden no encontrada' })
      if (existing.estado === 'registrada')
        return res.status(400).json({ ok: false, error: 'No se puede editar una orden ya registrada' })

      // Calcular diff vs carrito previo y agregar al __historial__
      const carritoViejo = typeof existing.datos_carrito === 'string'
        ? JSON.parse(existing.datos_carrito)
        : (existing.datos_carrito || {})

      // Compone el carrito final (clon del nuevo + historial preservado/extendido)
      const carritoFinal = { ...datos_carrito }
      const historialPrevio = carritoViejo.__historial__ || []
      const cambios = computarDiffCarrito(carritoViejo, carritoFinal)

      if (cambios.length > 0) {
        carritoFinal.__historial__ = [
          ...historialPrevio,
          { usuario: usuario || 'BODEGA', fecha: new Date().toISOString(), cambios }
        ]
      } else {
        carritoFinal.__historial__ = historialPrevio
      }

      await q(`
        UPDATE ordenes_guardadas
        SET    datos_carrito = ?, total_estimado = ?, fecha_modificacion = NOW()
        WHERE  folio_numero = ?
      `, [JSON.stringify(carritoFinal), total, folio_numero])

      registrar(req, 'pedidos', 'orden_actualizada', { folio: folio_numero, total, cambios: cambios.length })
      res.json({ ok: true, folio_numero })
    } else {
      // — INSERT nueva orden
      const [maxRow] = await q('SELECT COALESCE(MAX(folio_numero), 0) + 1 AS next FROM ordenes_guardadas')
      const nextFolio = maxRow.next

      await q(`
        INSERT INTO ordenes_guardadas
          (folio_numero, id_cliente, usuario_creador, datos_carrito, total_estimado, estado, activo)
        VALUES (?, ?, ?, ?, ?, 'guardada', 1)
      `, [nextFolio, id_cliente, usuario, JSON.stringify(datos_carrito), total])

      registrar(req, 'pedidos', 'orden_nueva', { folio: nextFolio, total })
      res.json({ ok: true, folio_numero: nextFolio })
    }
  } catch (e) {
    console.error('[ordenes] POST /', e.message)
    res.status(500).json({ ok: false, error: 'Error al guardar la orden' })
  }
})

/* ─── POST /api/ordenes/:folio/revision — registrar revisión completa ─── */
router.post('/:folio/revision', async (req, res) => {
  try {
    const folio = parseInt(req.params.folio, 10)
    if (!folio || isNaN(folio)) {
      return res.status(400).json({ ok: false, error: 'folio inválido' })
    }
    const { totalProductos, faltantes, pendientes } = req.body || {}
    const usuario = req.user.username

    const [row] = await q(
      'SELECT datos_carrito, estado FROM ordenes_guardadas WHERE folio_numero = ? AND activo = 1',
      [folio]
    )
    if (!row) return res.status(404).json({ ok: false, error: 'Orden no encontrada' })
    if (row.estado === 'registrada') {
      return res.status(400).json({ ok: false, error: 'No se puede revisar una orden ya registrada' })
    }

    const carrito = typeof row.datos_carrito === 'string'
      ? JSON.parse(row.datos_carrito)
      : (row.datos_carrito || {})

    const historialPrevio = carrito.__historial__ || []
    const pendientesArr = Array.isArray(pendientes) ? pendientes : []
    const nuevaEntrada = {
      usuario: usuario || 'BODEGA',
      fecha: new Date().toISOString(),
      tipoEvento: 'revision',
      totalProductos: parseInt(totalProductos, 10) || 0,
      faltantes: Array.isArray(faltantes) ? faltantes : [],
      pendientes: pendientesArr
    }
    carrito.__historial__ = [...historialPrevio, nuevaEntrada]

    await q(`
      UPDATE ordenes_guardadas
      SET    datos_carrito = ?, fecha_modificacion = NOW()
      WHERE  folio_numero = ?
    `, [JSON.stringify(carrito), folio])

    registrar(req, 'pedidos', 'orden_revisada', {
      folio,
      totalProductos: nuevaEntrada.totalProductos,
      faltantes: nuevaEntrada.faltantes.length,
      pendientes: pendientesArr.length
    })
    res.json({ ok: true })
  } catch (e) {
    console.error('[ordenes] POST /:folio/revision', e.message)
    res.status(500).json({ ok: false, error: 'Error al registrar la revisión' })
  }
})

module.exports = router
