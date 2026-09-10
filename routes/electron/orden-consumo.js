/**
 * routes/electron/orden-consumo.js — Consumo PEPS al guardar/revertir una orden
 * (H-5 Fase 4 — procesarVenta/revertirProcesamiento)
 *
 * Puerto casi literal de disfruleg-electron/src/main/handlers/orden-consumo.ts.
 * Es lógica pura + SQL sobre una `conn` genérica — nunca dependió de Electron.
 * `ordenes:crear`/`ordenes:guardar` (los otros consumidores de este módulo)
 * se quedan en Electron por ahora; no hay problema de consistencia porque
 * ambos lados pegan a la misma TiDB.
 *
 * Sin caché de conversiones: el original tenía un fallback a query directa
 * cuando `conv-cache` no cargaba (para no arrastrar una conexión de BD en
 * tests). Aquí se usa siempre ese camino — más simple y correcto en un
 * Worker (los isolates no garantizan vida útil para una caché en memoria).
 */

const { resolverCadenas, construirFuentes, consumirDeFuentes } = require('peps-engine-core')

/**
 * Extrae los ítems del carrito en el MISMO orden de enumeración que
 * procesarVenta (todosLosItems): itemIdx aquí = índice del detalle_factura
 * al facturar, lo que permite mapear orden_consumo_peps → detalle_venta_lote.
 */
function extraerItemsOrdenados(datosCarrito) {
  const carrito = typeof datosCarrito === 'string' ? JSON.parse(datosCarrito) : datosCarrito
  const items = []
  for (const [key, seccion] of Object.entries(carrito || {})) {
    if (key.startsWith('__')) continue
    const arr = Array.isArray(seccion) ? seccion : (seccion.items || [])
    for (const item of arr) {
      if (typeof item !== 'object' || item === null) continue
      const cantidad = parseFloat(String(item.cantidad))
      if (cantidad > 0) {
        items.push({
          id_producto: item.id_producto,
          cantidad,
          precio_unitario: item.precio_unitario || item.precio_final || 0,
          cantidad_sin_descuento: item.cantidad_sin_descuento,
        })
      }
    }
  }
  return items
}

/**
 * Cálculo puro del consumo: mismas reglas que procesarVenta (propios primero,
 * base de respaldo, cantidad_sin_descuento no toca stock). MUTA los lotes.
 */
function calcularConsumoOrden(items, convMap, ownConvs, lotesPorProducto) {
  const consumos = []
  const deltaLotes = {}
  const deltaStock = {}
  const pendientes = {}

  items.forEach((item, itemIdx) => {
    const fuentes = construirFuentes(item.id_producto, convMap[item.id_producto], ownConvs[item.id_producto])
    const sinDesc = Math.min(Number(item.cantidad_sin_descuento) || 0, item.cantidad)

    deltaStock[fuentes[0].idProd] = deltaStock[fuentes[0].idProd] || 0

    const { pendiente, consumos: cs } = consumirDeFuentes(item.cantidad - sinDesc, fuentes, lotesPorProducto)

    for (const c of cs) {
      consumos.push({
        id_producto: item.id_producto,
        loteId: c.loteId,
        consumir: c.consumir,
        derivadoTomado: c.derivadoTomado,
        costoLote: c.costoLote,
        precioVenta: item.precio_unitario,
        itemIdx,
      })
      deltaLotes[c.loteId] = (deltaLotes[c.loteId] || 0) + c.consumir
      deltaStock[c.idProd] = (deltaStock[c.idProd] || 0) + c.consumir
    }

    if (pendiente > 0.000001) {
      pendientes[item.id_producto] = Math.round(((pendientes[item.id_producto] || 0) + pendiente) * 1000) / 1000
    }
  })

  return { consumos, deltaLotes, deltaStock, pendientes }
}

/** Carga convMap con las mismas reglas de preferencia que procesarVenta — siempre por query directa. */
async function cargarConversiones(conn, idsProductos, idGrupo) {
  if (idsProductos.length === 0) return {}
  const ph = idsProductos.map(() => '?').join(',')
  const params = [...idsProductos]
  if (idGrupo != null) params.push(idGrupo)
  const [rows] = await conn.execute(`
    SELECT id_producto_derivado, id_producto_base, factor, id_grupo
    FROM producto_conversion_peps
    WHERE id_producto_derivado IN (${ph})
      AND activo = 1
      AND id_producto_derivado != id_producto_base
      AND (id_grupo IS NULL ${idGrupo != null ? 'OR id_grupo = ?' : ''})
    ORDER BY (id_grupo IS NULL) ASC`, params)

  const convMap = {}
  for (const row of rows) {
    const pid = Number(row.id_producto_derivado)
    if (!convMap[pid] || row.id_grupo !== null) {
      convMap[pid] = { idBase: Number(row.id_producto_base), factor: parseFloat(String(row.factor)) }
    }
  }

  const [allRows] = await conn.execute(
    `SELECT id_producto_derivado, id_producto_base, factor
     FROM producto_conversion_peps
     WHERE activo = 1 AND id_grupo IS NULL AND id_producto_derivado != id_producto_base`
  )
  const allConvMap = {}
  for (const row of allRows) {
    allConvMap[Number(row.id_producto_derivado)] = { idBase: Number(row.id_producto_base), factor: parseFloat(String(row.factor)) }
  }
  resolverCadenas(convMap, allConvMap)
  return convMap
}

/**
 * Consume PEPS para una orden dentro de una transacción abierta.
 * Bloquea lotes con FOR UPDATE, inserta la traza en orden_consumo_peps,
 * descuenta lotes, reconcilia producto.stock y persiste consumo_pendiente.
 */
async function consumirPepsParaOrden(conn, folioNumero, datosCarrito, idGrupo = null) {
  const items = extraerItemsOrdenados(datosCarrito)
  if (items.length === 0) {
    await conn.execute('UPDATE ordenes_guardadas SET consumo_pendiente = NULL WHERE folio_numero = ?', [folioNumero])
    return { pendientes: {}, consumos: [] }
  }

  const idsProductos = [...new Set(items.map(i => i.id_producto))]
  const convMap = await cargarConversiones(conn, idsProductos, idGrupo)

  const idsParaPeps = [...new Set(idsProductos.flatMap(id => {
    const baseId = convMap[id]?.idBase
    return (baseId && baseId !== id) ? [baseId, id] : [id]
  }))]
  const phProd = idsParaPeps.map(() => '?').join(',')
  const [loteRows] = await conn.execute(
    `SELECT id_inventario_peps, id_producto, cantidad_restante, costo_unitario, factor_conversion
     FROM inventario_peps
     WHERE id_producto IN (${phProd})
       AND cantidad_restante > 0 AND activo = 1
     ORDER BY fecha_movimiento ASC, id_inventario_peps ASC
     FOR UPDATE`,
    idsParaPeps
  )

  const lotesPorProducto = {}
  for (const lote of loteRows) {
    const pid = Number(lote.id_producto)
    if (!lotesPorProducto[pid]) lotesPorProducto[pid] = []
    lotesPorProducto[pid].push({
      id: Number(lote.id_inventario_peps),
      restante: parseFloat(String(lote.cantidad_restante)),
      costo: parseFloat(String(lote.costo_unitario)),
      factorConversion: lote.factor_conversion != null ? parseFloat(String(lote.factor_conversion)) : null,
    })
  }

  const ownConvs = {}
  for (const id of idsProductos) {
    const conv = convMap[id]
    if (conv && lotesPorProducto[id]?.length) {
      ownConvs[id] = conv
      delete convMap[id]
    }
  }

  const { consumos, deltaLotes, deltaStock, pendientes } = calcularConsumoOrden(items, convMap, ownConvs, lotesPorProducto)

  if (consumos.length > 0) {
    const ph = consumos.map(() => '(?,?,?,?,?,?,?,?)').join(',')
    const params = consumos.flatMap(c => [
      folioNumero, c.id_producto, c.loteId, c.consumir, c.derivadoTomado, c.costoLote, c.precioVenta, c.itemIdx,
    ])
    await conn.execute(
      `INSERT INTO orden_consumo_peps
         (folio_numero, id_producto, id_inventario_peps, cantidad_consumida, cantidad_derivada, costo_unitario, precio_venta_unitario, item_idx)
       VALUES ${ph}`,
      params
    )
  }

  const loteEntries = Object.entries(deltaLotes)
  if (loteEntries.length > 0) {
    const loteIds = loteEntries.map(([id]) => {
      const n = Number(id); if (!Number.isFinite(n) || n <= 0) throw new Error(`ID de lote inválido: ${id}`); return n
    })
    const loteRestars = loteEntries.map(([, restar]) => {
      const n = Number(restar); if (!Number.isFinite(n) || n < 0) throw new Error(`Cantidad a restar inválida: ${restar}`); return n
    })
    const caseCantidad = loteIds.map((id, i) => `WHEN ${id} THEN GREATEST(0, cantidad_restante - ${loteRestars[i]})`).join(' ')
    const caseActivo = loteIds.map((id, i) => `WHEN id_inventario_peps = ${id} AND cantidad_restante - ${loteRestars[i]} <= 0 THEN 0`).join(' ')
    const phLoteIds = loteIds.map(() => '?').join(',')
    await conn.execute(
      `UPDATE inventario_peps
       SET cantidad_restante = CASE id_inventario_peps ${caseCantidad} ELSE cantidad_restante END,
           activo = CASE ${caseActivo} ELSE activo END
       WHERE id_inventario_peps IN (${phLoteIds})`,
      loteIds
    )
  }

  await reconciliarStock(conn, Object.keys(deltaStock).map(Number), deltaStock)

  await conn.execute(
    'UPDATE ordenes_guardadas SET consumo_pendiente = ? WHERE folio_numero = ?',
    [Object.keys(pendientes).length > 0 ? JSON.stringify(pendientes) : null, folioNumero]
  )

  return { pendientes, consumos }
}

/**
 * Restaura los lotes exactos consumidos por una orden y borra su traza.
 */
async function revertirConsumoOrden(conn, folioNumero) {
  const [lotes] = await conn.execute(
    `SELECT ocp.id_inventario_peps, ip.id_producto, SUM(ocp.cantidad_consumida) AS total
     FROM orden_consumo_peps ocp
     INNER JOIN inventario_peps ip ON ip.id_inventario_peps = ocp.id_inventario_peps
     WHERE ocp.folio_numero = ?
     GROUP BY ocp.id_inventario_peps, ip.id_producto`,
    [folioNumero]
  )

  if (lotes.length > 0) {
    const restoreIds = lotes.map(l => Number(l.id_inventario_peps))

    await conn.execute(
      `SELECT id_inventario_peps FROM inventario_peps
       WHERE id_inventario_peps IN (${restoreIds.map(() => '?').join(',')}) FOR UPDATE`,
      restoreIds
    )

    const caseRestore = lotes.map(l => `WHEN ${Number(l.id_inventario_peps)} THEN cantidad_restante + ${parseFloat(String(l.total))}`).join(' ')
    const caseActivo = lotes.map(l => `WHEN ${Number(l.id_inventario_peps)} THEN CASE WHEN cantidad_restante + ${parseFloat(String(l.total))} > 0 THEN 1 ELSE activo END`).join(' ')
    await conn.execute(
      `UPDATE inventario_peps
       SET cantidad_restante = CASE id_inventario_peps ${caseRestore} ELSE cantidad_restante END,
           activo = CASE id_inventario_peps ${caseActivo} ELSE activo END
       WHERE id_inventario_peps IN (${restoreIds.map(() => '?').join(',')})`,
      restoreIds
    )

    const productIds = [...new Set(lotes.map(l => Number(l.id_producto)))]
    await reconciliarStock(conn, productIds, {})

    await conn.execute('DELETE FROM orden_consumo_peps WHERE folio_numero = ?', [folioNumero])
  }

  await conn.execute('UPDATE ordenes_guardadas SET consumo_pendiente = NULL WHERE folio_numero = ?', [folioNumero])
}

/** ¿Esta orden ya tiene traza de consumo PEPS (flujo nuevo)? */
async function tieneConsumoOrden(conn, folioNumero) {
  try {
    const [rows] = await conn.execute('SELECT 1 FROM orden_consumo_peps WHERE folio_numero = ? LIMIT 1', [folioNumero])
    return rows.length > 0
  } catch (_) {
    return false
  }
}

/**
 * Reconcilia producto.stock desde los lotes PEPS: si el producto tiene
 * lotes, stock = SUM(cantidad_restante); si no, aplica el delta directo.
 */
async function reconciliarStock(conn, productIds, deltaStock) {
  if (productIds.length === 0) return
  const caseElse = productIds.map(id => `WHEN ${id} THEN ${deltaStock[id] || 0}`).join(' ')
  const ph = productIds.map(() => '?').join(',')
  await conn.execute(
    `UPDATE producto p
     LEFT JOIN (
       SELECT id_producto, SUM(cantidad_restante) AS total_peps
       FROM inventario_peps WHERE activo = 1 AND id_producto IN (${ph})
       GROUP BY id_producto
     ) agg ON agg.id_producto = p.id_producto
     SET p.stock = CASE
       WHEN agg.id_producto IS NOT NULL THEN COALESCE(agg.total_peps, 0)
       ELSE p.stock - CASE p.id_producto ${caseElse} ELSE 0 END
     END
     WHERE p.id_producto IN (${ph})`,
    [...productIds, ...productIds]
  )
}

module.exports = {
  extraerItemsOrdenados,
  calcularConsumoOrden,
  consumirPepsParaOrden,
  revertirConsumoOrden,
  tieneConsumoOrden,
}
