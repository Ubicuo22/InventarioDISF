const router  = require('express').Router()
const { q }   = require('../db/pool')
const { requireAuth, requireModulo } = require('../middleware/auth')
const { registrar } = require('../utils/actividad')
const { fechaMexico, rangoUtcDelDia } = require('../utils/fecha')

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

  // La llave incluye un índice de ocurrencia (sec::id::n) porque el mismo
  // producto puede aparecer varias veces en la misma sección (logística);
  // sin el índice, los renglones duplicados se colapsarían en el diff.
  const llenar = (carrito, mapa) => {
    for (const [sec, items] of Object.entries(carrito || {})) {
      if (sec.startsWith('__')) continue
      if (!Array.isArray(items)) continue
      const vistos = {}
      for (const item of items) {
        const base = `${sec}::${item.id_producto}`
        const n = vistos[base] = (vistos[base] || 0) + 1
        mapa.set(`${base}::${n}`, { ...item, seccion: sec })
      }
    }
  }
  llenar(viejo, oldItems)
  llenar(nuevo, newItems)

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

/* ─── GET /api/ordenes?estado=guardada|registrada[&desde=YYYY-MM-DD&hasta=YYYY-MM-DD] ─── */
router.get('/', async (req, res) => {
  try {
    const estado = req.query.estado === 'registrada' ? 'registrada' : 'guardada'
    const { desde, hasta } = req.query

    const conditions = ['o.estado = ?', 'o.activo = 1']
    const params = [estado]

    if (desde) { conditions.push('DATE(o.fecha_creacion) >= ?'); params.push(desde) }
    if (hasta) { conditions.push('DATE(o.fecha_creacion) <= ?'); params.push(hasta) }

    const rows = await q(`
      SELECT o.folio_numero, o.id_cliente, c.nombre_cliente,
             g.id_grupo, g.nombre_grupo,
             o.total_estimado, o.estado,
             o.fecha_creacion, o.fecha_modificacion, o.usuario_creador,
             o.datos_carrito, o.fecha_envio,
             o.editing_by, o.editing_at, o.editing_source
      FROM   ordenes_guardadas o
      INNER JOIN cliente c ON o.id_cliente = c.id_cliente
      INNER JOIN grupo   g ON c.id_grupo   = g.id_grupo
      WHERE  ${conditions.join(' AND ')}
      ORDER  BY o.folio_numero DESC
    `, params)
    res.json({ ok: true, data: rows })
  } catch (e) {
    console.error('[ordenes] GET /', e.message)
    res.status(500).json({ ok: false, error: 'Error al obtener órdenes' })
  }
})

/* ─── GET /api/ordenes/pendientes-hoy ─── */
router.get('/pendientes-hoy', async (req, res) => {
  try {
    const { inicio, fin } = rangoUtcDelDia(fechaMexico())
    const rows = await q(`
      SELECT o.folio_numero, o.id_cliente, c.nombre_cliente,
             g.id_grupo, g.nombre_grupo,
             o.datos_carrito, o.fecha_modificacion
      FROM   ordenes_guardadas o
      INNER JOIN cliente c ON o.id_cliente = c.id_cliente
      INNER JOIN grupo   g ON c.id_grupo   = g.id_grupo
      WHERE  o.estado = 'guardada' AND o.activo = 1
        AND  o.fecha_creacion >= ? AND o.fecha_creacion < ?
      ORDER  BY o.folio_numero ASC
    `, [inicio, fin])

    const result = []
    for (const row of rows) {
      const carrito = typeof row.datos_carrito === 'string'
        ? JSON.parse(row.datos_carrito)
        : (row.datos_carrito || {})

      const historial   = carrito.__historial__ || []
      const observacion = carrito.__observacion__ || null

      let lastRevision = null
      for (let i = historial.length - 1; i >= 0; i--) {
        if (historial[i].tipoEvento === 'revision') { lastRevision = historial[i]; break }
      }
      if (!lastRevision) continue

      const pendientes = Array.isArray(lastRevision.pendientes) ? lastRevision.pendientes : []
      const faltantes  = Array.isArray(lastRevision.faltantes)  ? lastRevision.faltantes  : []
      if (pendientes.length === 0 && faltantes.length === 0) continue

      // Build name→{cantidad,unidad} map from cart items
      const prodMap = {}
      for (const [sec, items] of Object.entries(carrito)) {
        if (sec.startsWith('__') || !Array.isArray(items)) continue
        for (const item of items) {
          prodMap[item.nombre_producto] = {
            cantidad: parseFloat(item.cantidad) || 0,
            unidad:   item.unidad || item.unidad_producto || '',
            seccion:  sec
          }
        }
      }

      const enriquecer = (nombre) => ({
        nombre,
        cantidad: prodMap[nombre]?.cantidad ?? null,
        unidad:   prodMap[nombre]?.unidad   ?? '',
        seccion:  prodMap[nombre]?.seccion  ?? ''
      })

      // Los faltantes ya no están en el carrito — su cantidad/sección sale del
      // detalle guardado al marcarlos (faltantesDetalle). Consume ocurrencias
      // en orden por si hay nombres duplicados.
      const detalles = Array.isArray(lastRevision.faltantesDetalle) ? [...lastRevision.faltantesDetalle] : []
      const enriquecerFaltante = (nombre) => {
        const dIdx = detalles.findIndex(d => d.nombre === nombre)
        if (dIdx >= 0) {
          const [d] = detalles.splice(dIdx, 1)
          return { nombre, cantidad: d.cantidad, unidad: d.unidad, seccion: d.seccion || '' }
        }
        return enriquecer(nombre)  // faltantes viejos sin detalle
      }

      result.push({
        folio_numero:     row.folio_numero,
        nombre_cliente:   row.nombre_cliente,
        nombre_grupo:     row.nombre_grupo,
        observacion,
        pendientes:       pendientes.map(enriquecer),
        faltantes:        faltantes.map(enriquecerFaltante),
        fecha_revision:   lastRevision.fecha,
        usuario_revision: lastRevision.usuario
      })
    }

    res.json({ ok: true, data: result })
  } catch (e) {
    console.error('[ordenes] GET /pendientes-hoy', e.message)
    res.status(500).json({ ok: false, error: 'Error al obtener pendientes' })
  }
})

/* ─── PATCH /api/ordenes/:folio/pendiente — resolver un item ─── */
router.patch('/:folio/pendiente', requireModulo('pedidos'), async (req, res) => {
  try {
    const folio = parseInt(req.params.folio, 10)
    if (!folio || isNaN(folio)) return res.status(400).json({ ok: false, error: 'folio inválido' })
    const { tipo, nombre_producto } = req.body
    if (!tipo || !nombre_producto) return res.status(400).json({ ok: false, error: 'tipo y nombre_producto requeridos' })
    if (tipo !== 'pendiente' && tipo !== 'faltante') return res.status(400).json({ ok: false, error: 'tipo inválido' })

    const [row] = await q(
      'SELECT datos_carrito, estado FROM ordenes_guardadas WHERE folio_numero = ? AND activo = 1',
      [folio]
    )
    if (!row) return res.status(404).json({ ok: false, error: 'Orden no encontrada' })
    if (row.estado === 'registrada') return res.status(400).json({ ok: false, error: 'Orden ya registrada' })

    const carrito   = typeof row.datos_carrito === 'string' ? JSON.parse(row.datos_carrito) : (row.datos_carrito || {})
    const historial = carrito.__historial__ || []

    let lastRevIdx = -1
    for (let i = historial.length - 1; i >= 0; i--) {
      if (historial[i].tipoEvento === 'revision') { lastRevIdx = i; break }
    }
    if (lastRevIdx === -1) return res.status(400).json({ ok: false, error: 'No hay revisión registrada' })

    const rev   = historial[lastRevIdx]
    const campo = tipo === 'pendiente' ? 'pendientes' : 'faltantes'
    const arr   = Array.isArray(rev[campo]) ? rev[campo] : []
    // Quitar UNA ocurrencia (puede haber duplicados del mismo nombre)
    const nIdx = arr.indexOf(nombre_producto)
    if (nIdx >= 0) arr.splice(nIdx, 1)
    rev[campo] = arr

    // Faltante resuelto con "llegó" → reintegrar el renglón a la nota usando
    // el detalle guardado al marcarlo (cantidad/sección/precio originales).
    let reintegrado = false
    if (tipo === 'faltante') {
      const detalles = Array.isArray(rev.faltantesDetalle) ? rev.faltantesDetalle : []
      const dIdx = detalles.findIndex(d => d.nombre === nombre_producto)
      const llego = req.body.llego === true
      if (dIdx >= 0) {
        const [d] = detalles.splice(dIdx, 1)
        if (llego) {
          const sec = d.seccion || 'General'
          if (!Array.isArray(carrito[sec])) carrito[sec] = []
          carrito[sec].push({
            id_producto:     d.id_producto,
            nombre_producto: d.nombre,
            unidad:          d.unidad,
            cantidad:        d.cantidad,
            precio_unitario: d.precio_unitario,
            seccion:         sec
          })
          reintegrado = true
        }
      }
      // Sin detalle (faltantes viejos, previos a este cambio): si llegó, no hay
      // datos para reintegrar — el frontend avisa que se agregue a mano.
    }
    carrito.__historial__ = historial

    await q('UPDATE ordenes_guardadas SET datos_carrito = ?, total_estimado = ?, fecha_modificacion = NOW() WHERE folio_numero = ?',
      [JSON.stringify(carrito), calcTotal(carrito), folio])

    registrar(req, 'pedidos', 'pendiente_resuelto', { folio, tipo, producto: nombre_producto, llego: req.body.llego === true, reintegrado })
    res.json({ ok: true, reintegrado })
  } catch (e) {
    console.error('[ordenes] PATCH /:folio/pendiente', e.message)
    res.status(500).json({ ok: false, error: 'Error al resolver pendiente' })
  }
})

/* ─── PATCH /api/ordenes/:folio/item-cantidad — editar cantidad de un producto pendiente ─── */
router.patch('/:folio/item-cantidad', requireModulo('pedidos'), async (req, res) => {
  try {
    const folio = parseInt(req.params.folio, 10)
    if (!folio || isNaN(folio)) return res.status(400).json({ ok: false, error: 'folio inválido' })
    const { nombre_producto, cantidad } = req.body
    if (!nombre_producto || cantidad == null) return res.status(400).json({ ok: false, error: 'nombre_producto y cantidad requeridos' })
    const cant = parseFloat(cantidad)
    if (isNaN(cant) || cant < 0) return res.status(400).json({ ok: false, error: 'cantidad inválida' })

    const [row] = await q(
      'SELECT datos_carrito, estado FROM ordenes_guardadas WHERE folio_numero = ? AND activo = 1',
      [folio]
    )
    if (!row) return res.status(404).json({ ok: false, error: 'Orden no encontrada' })
    if (row.estado === 'registrada') return res.status(400).json({ ok: false, error: 'Orden ya registrada' })

    const carrito = typeof row.datos_carrito === 'string' ? JSON.parse(row.datos_carrito) : (row.datos_carrito || {})

    let actualizado = false
    for (const [sec, items] of Object.entries(carrito)) {
      if (sec.startsWith('__') || !Array.isArray(items)) continue
      for (const item of items) {
        if (item.nombre_producto === nombre_producto) {
          item.cantidad = cant
          actualizado = true
        }
      }
    }

    // Los faltantes ya no viven en el carrito — su cantidad se edita en el
    // detalle guardado en la última revisión (se usa al reintegrar si llega).
    if (!actualizado) {
      const historial = carrito.__historial__ || []
      for (let i = historial.length - 1; i >= 0; i--) {
        if (historial[i].tipoEvento !== 'revision') continue
        const detalles = Array.isArray(historial[i].faltantesDetalle) ? historial[i].faltantesDetalle : []
        const d = detalles.find(x => x.nombre === nombre_producto)
        if (d) { d.cantidad = cant; actualizado = true; carrito.__historial__ = historial }
        break
      }
    }
    if (!actualizado) return res.status(404).json({ ok: false, error: 'Producto no encontrado en el carrito' })

    const total = calcTotal(carrito)
    await q('UPDATE ordenes_guardadas SET datos_carrito = ?, total_estimado = ?, fecha_modificacion = NOW() WHERE folio_numero = ?',
      [JSON.stringify(carrito), total, folio])

    registrar(req, 'pedidos', 'item_cantidad_editada', { folio, producto: nombre_producto, cantidad: cant })
    res.json({ ok: true })
  } catch (e) {
    console.error('[ordenes] PATCH /:folio/item-cantidad', e.message)
    res.status(500).json({ ok: false, error: 'Error al actualizar cantidad' })
  }
})

/* ─── PATCH /api/ordenes/:folio/mover-a-faltante — mueve item de pendientes → faltantes ─── */
router.patch('/:folio/mover-a-faltante', requireModulo('pedidos'), async (req, res) => {
  try {
    const folio = parseInt(req.params.folio, 10)
    if (!folio || isNaN(folio)) return res.status(400).json({ ok: false, error: 'folio inválido' })
    const { nombre_producto } = req.body
    if (!nombre_producto) return res.status(400).json({ ok: false, error: 'nombre_producto requerido' })

    const [row] = await q('SELECT datos_carrito, estado FROM ordenes_guardadas WHERE folio_numero = ? AND activo = 1', [folio])
    if (!row) return res.status(404).json({ ok: false, error: 'Orden no encontrada' })
    if (row.estado === 'registrada') return res.status(400).json({ ok: false, error: 'Orden ya registrada' })

    const carrito = typeof row.datos_carrito === 'string' ? JSON.parse(row.datos_carrito) : (row.datos_carrito || {})
    const historial = carrito.__historial__ || []

    let lastRevIdx = -1
    for (let i = historial.length - 1; i >= 0; i--) {
      if (historial[i].tipoEvento === 'revision') { lastRevIdx = i; break }
    }
    if (lastRevIdx === -1) return res.status(400).json({ ok: false, error: 'No hay revisión registrada' })

    const rev = historial[lastRevIdx]
    // Quitar UNA ocurrencia de pendientes (puede haber duplicados del mismo nombre)
    const pendArr = rev.pendientes || []
    const pIdx = pendArr.indexOf(nombre_producto)
    if (pIdx >= 0) pendArr.splice(pIdx, 1)
    rev.pendientes = pendArr

    if (!rev.faltantes) rev.faltantes = []
    rev.faltantes.push(nombre_producto)

    // Quitar el renglón de la nota (una ocurrencia) — un faltante no debe seguir
    // sumando al total. Se guarda su detalle para poder reintegrarlo si llega.
    let detalle = null
    for (const [sec, items] of Object.entries(carrito)) {
      if (sec.startsWith('__') || !Array.isArray(items)) continue
      const iIdx = items.findIndex(i => i.nombre_producto === nombre_producto)
      if (iIdx >= 0) {
        const it = items[iIdx]
        detalle = {
          nombre:          it.nombre_producto,
          id_producto:     it.id_producto ?? null,
          cantidad:        parseFloat(it.cantidad) || 0,
          unidad:          it.unidad || it.unidad_producto || '',
          precio_unitario: parseFloat(it.precio_unitario) || 0,
          seccion:         sec
        }
        items.splice(iIdx, 1)
        break
      }
    }
    if (detalle) {
      if (!Array.isArray(rev.faltantesDetalle)) rev.faltantesDetalle = []
      rev.faltantesDetalle.push(detalle)
    }
    carrito.__historial__ = historial

    await q('UPDATE ordenes_guardadas SET datos_carrito = ?, total_estimado = ?, fecha_modificacion = NOW() WHERE folio_numero = ?',
      [JSON.stringify(carrito), calcTotal(carrito), folio])

    registrar(req, 'pedidos', 'item_movido_a_faltante', { folio, producto: nombre_producto })
    res.json({ ok: true })
  } catch (e) {
    console.error('[ordenes] PATCH /:folio/mover-a-faltante', e.message)
    res.status(500).json({ ok: false, error: 'Error al mover a faltante' })
  }
})

/* ─── PATCH /api/ordenes/:folio/cambiar-item — sustituye un producto en el carrito ─── */
router.patch('/:folio/cambiar-item', requireModulo('pedidos'), async (req, res) => {
  try {
    const folio = parseInt(req.params.folio, 10)
    if (!folio || isNaN(folio)) return res.status(400).json({ ok: false, error: 'folio inválido' })
    const { nombre_viejo, id_nuevo, nombre_nuevo, unidad_nueva, precio_nuevo } = req.body
    if (!nombre_viejo || !id_nuevo || !nombre_nuevo) return res.status(400).json({ ok: false, error: 'nombre_viejo, id_nuevo y nombre_nuevo requeridos' })

    const [row] = await q('SELECT datos_carrito, estado FROM ordenes_guardadas WHERE folio_numero = ? AND activo = 1', [folio])
    if (!row) return res.status(404).json({ ok: false, error: 'Orden no encontrada' })
    if (row.estado === 'registrada') return res.status(400).json({ ok: false, error: 'Orden ya registrada' })

    const carrito = typeof row.datos_carrito === 'string' ? JSON.parse(row.datos_carrito) : (row.datos_carrito || {})

    // Reemplazar en todas las secciones del carrito
    let reemplazado = false
    for (const [sec, items] of Object.entries(carrito)) {
      if (sec.startsWith('__') || !Array.isArray(items)) continue
      for (const item of items) {
        if (item.nombre_producto === nombre_viejo) {
          item.id_producto      = id_nuevo
          item.nombre_producto  = nombre_nuevo
          item.unidad_producto  = unidad_nueva || item.unidad_producto
          if (precio_nuevo != null && precio_nuevo > 0) item.precio_unitario = precio_nuevo
          reemplazado = true
        }
      }
    }
    // Actualizar nombre en pendientes/faltantes del último historial de revisión.
    // Un faltante puede NO estar en el carrito (se quita al marcarse) — en ese
    // caso el cambio aplica solo en el historial y su detalle.
    const historial = carrito.__historial__ || []
    let lastRevIdx = -1
    for (let i = historial.length - 1; i >= 0; i--) {
      if (historial[i].tipoEvento === 'revision') { lastRevIdx = i; break }
    }
    if (lastRevIdx !== -1) {
      const rev = historial[lastRevIdx]
      const sustituir = (arr) => Array.isArray(arr) ? arr.map(n => n === nombre_viejo ? nombre_nuevo : n) : arr
      const enFaltantes = Array.isArray(rev.faltantes) && rev.faltantes.includes(nombre_viejo)
      rev.pendientes = sustituir(rev.pendientes)
      rev.faltantes  = sustituir(rev.faltantes)
      if (Array.isArray(rev.faltantesDetalle)) {
        for (const d of rev.faltantesDetalle) {
          if (d.nombre === nombre_viejo) {
            d.nombre      = nombre_nuevo
            d.id_producto = id_nuevo
            if (unidad_nueva) d.unidad = unidad_nueva
            if (precio_nuevo != null && precio_nuevo > 0) d.precio_unitario = precio_nuevo
          }
        }
      }
      if (enFaltantes) reemplazado = true
      carrito.__historial__ = historial
    }
    if (!reemplazado) return res.status(404).json({ ok: false, error: 'Producto no encontrado en el carrito' })

    const total = calcTotal(carrito)
    await q('UPDATE ordenes_guardadas SET datos_carrito = ?, total_estimado = ?, fecha_modificacion = NOW() WHERE folio_numero = ?',
      [JSON.stringify(carrito), total, folio])

    registrar(req, 'pedidos', 'item_sustituido', { folio, viejo: nombre_viejo, nuevo: nombre_nuevo })
    res.json({ ok: true })
  } catch (e) {
    console.error('[ordenes] PATCH /:folio/cambiar-item', e.message)
    res.status(500).json({ ok: false, error: 'Error al cambiar producto' })
  }
})

/* ─── PATCH /api/ordenes/:folio/resolver-todos — vaciar pendientes y faltantes ─── */
router.patch('/:folio/resolver-todos', requireModulo('pedidos'), async (req, res) => {
  try {
    const folio = parseInt(req.params.folio, 10)
    if (!folio || isNaN(folio)) return res.status(400).json({ ok: false, error: 'folio inválido' })

    const [row] = await q(
      'SELECT datos_carrito, estado FROM ordenes_guardadas WHERE folio_numero = ? AND activo = 1',
      [folio]
    )
    if (!row) return res.status(404).json({ ok: false, error: 'Orden no encontrada' })
    if (row.estado === 'registrada') return res.status(400).json({ ok: false, error: 'Orden ya registrada' })

    const carrito   = typeof row.datos_carrito === 'string' ? JSON.parse(row.datos_carrito) : (row.datos_carrito || {})
    const historial = carrito.__historial__ || []

    let lastRevIdx = -1
    for (let i = historial.length - 1; i >= 0; i--) {
      if (historial[i].tipoEvento === 'revision') { lastRevIdx = i; break }
    }
    if (lastRevIdx === -1) return res.status(400).json({ ok: false, error: 'No hay revisión registrada' })

    historial[lastRevIdx].pendientes = []
    historial[lastRevIdx].faltantes  = []
    historial[lastRevIdx].faltantesDetalle = []  // resolver todos = "no llegaron"; no se reintegra nada
    carrito.__historial__ = historial

    await q('UPDATE ordenes_guardadas SET datos_carrito = ?, fecha_modificacion = NOW() WHERE folio_numero = ?',
      [JSON.stringify(carrito), folio])

    registrar(req, 'pedidos', 'pendientes_resueltos', { folio })
    res.json({ ok: true })
  } catch (e) {
    console.error('[ordenes] PATCH /:folio/resolver-todos', e.message)
    res.status(500).json({ ok: false, error: 'Error al resolver pendientes' })
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
router.post('/:folio/revision', requireModulo('pedidos'), async (req, res) => {
  try {
    const folio = parseInt(req.params.folio, 10)
    if (!folio || isNaN(folio)) {
      return res.status(400).json({ ok: false, error: 'folio inválido' })
    }
    const { totalProductos, faltantes, pendientes, faltantesDetalle } = req.body || {}
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
      pendientes: pendientesArr,
      // Detalle de cada faltante (cantidad/unidad/sección/precio) para poder
      // reintegrarlo a la nota si después sí llega. Electron ignora esta clave;
      // `faltantes` sigue siendo el array de nombres de siempre.
      faltantesDetalle: Array.isArray(faltantesDetalle)
        ? faltantesDetalle.map(d => ({
            nombre:          String(d.nombre || ''),
            id_producto:     d.id_producto ?? null,
            cantidad:        parseFloat(d.cantidad) || 0,
            unidad:          String(d.unidad || ''),
            precio_unitario: parseFloat(d.precio_unitario) || 0,
            seccion:         String(d.seccion || 'General')
          }))
        : []
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

/* ─── PATCH /api/ordenes/:folio/enviar — marcar fecha de envío real ─── */
router.patch('/:folio/enviar', requireAuth, async (req, res) => {
  try {
    const { folio } = req.params
    const [row] = await q(
      'SELECT estado FROM ordenes_guardadas WHERE folio_numero = ? AND activo = 1',
      [folio]
    )
    if (!row) return res.status(404).json({ ok: false, error: 'Orden no encontrada' })

    await q(
      'UPDATE ordenes_guardadas SET fecha_envio = CURDATE() WHERE folio_numero = ?',
      [folio]
    )
    registrar(req, 'pedidos', 'orden_enviada', { folio })
    res.json({ ok: true })
  } catch (e) {
    console.error('[ordenes] PATCH /:folio/enviar', e.message)
    res.status(500).json({ ok: false, error: 'Error al marcar envío' })
  }
})

/* ─── GET /api/ordenes/:folio/lock — consultar si la nota está bloqueada ─── */
router.get('/:folio/lock', async (req, res) => {
  try {
    const [row] = await q(
      'SELECT editing_by, editing_at, editing_source FROM ordenes_guardadas WHERE folio_numero = ? AND activo = 1',
      [req.params.folio]
    )
    if (!row) return res.status(404).json({ ok: false, error: 'Orden no encontrada' })

    const LOCK_TIMEOUT_MS = 5 * 60 * 1000
    if (row.editing_by && row.editing_at) {
      const elapsed = Date.now() - new Date(row.editing_at).getTime()
      if (elapsed < LOCK_TIMEOUT_MS) {
        return res.json({ ok: true, locked: true, editing_by: row.editing_by, editing_source: row.editing_source })
      }
    }
    res.json({ ok: true, locked: false })
  } catch (e) {
    console.error('[ordenes] GET /:folio/lock', e.message)
    res.status(500).json({ ok: false, error: 'Error al consultar bloqueo' })
  }
})

/* ─── PATCH /api/ordenes/:folio/lock — adquirir o renovar bloqueo ─── */
router.patch('/:folio/lock', requireAuth, async (req, res) => {
  try {
    const folio = req.params.folio
    const usuario = req.user.nombre_completo || req.user.username
    const source = 'bodega-web'

    const [row] = await q(
      'SELECT editing_by, editing_at, editing_source FROM ordenes_guardadas WHERE folio_numero = ? AND activo = 1',
      [folio]
    )
    if (!row) return res.status(404).json({ ok: false, error: 'Orden no encontrada' })

    const LOCK_TIMEOUT_MS = 5 * 60 * 1000
    if (row.editing_by && row.editing_at) {
      const elapsed = Date.now() - new Date(row.editing_at).getTime()
      if (elapsed < LOCK_TIMEOUT_MS && row.editing_by !== usuario) {
        const desde = row.editing_source === 'electron' ? 'la aplicación de escritorio' : 'la app web'
        return res.json({
          ok: false,
          locked: true,
          message: `${row.editing_by} está editando esta nota desde ${desde}`,
          editing_by: row.editing_by,
          editing_source: row.editing_source
        })
      }
    }

    await q(
      'UPDATE ordenes_guardadas SET editing_by = ?, editing_at = NOW(), editing_source = ? WHERE folio_numero = ?',
      [usuario, source, folio]
    )
    res.json({ ok: true, locked: false })
  } catch (e) {
    console.error('[ordenes] PATCH /:folio/lock', e.message)
    res.status(500).json({ ok: false, error: 'Error al adquirir bloqueo' })
  }
})

/* ─── DELETE /api/ordenes/:folio/lock — liberar bloqueo ─── */
router.delete('/:folio/lock', requireAuth, async (req, res) => {
  try {
    await q(
      'UPDATE ordenes_guardadas SET editing_by = NULL, editing_at = NULL, editing_source = NULL WHERE folio_numero = ?',
      [req.params.folio]
    )
    res.json({ ok: true })
  } catch (e) {
    console.error('[ordenes] DELETE /:folio/lock', e.message)
    res.status(500).json({ ok: false, error: 'Error al liberar bloqueo' })
  }
})

module.exports = router
