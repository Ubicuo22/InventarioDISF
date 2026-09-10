/**
 * routes/electron/costo-promedio.js — Costo promedio estimado por producto
 * (H-5 Fase 4 — procesarVenta)
 *
 * Puerto de disfruleg-electron/src/main/handlers/costos.utils.ts
 * (`resolverCostos`/`costosPromedioHistorico` únicamente — `margenLinea` no
 * lo usa procesarVenta, se queda del lado Electron). SQL puro, portado tal
 * cual salvo `ejecutarQuery` → `q()`.
 *
 * Nota: el BFS de equivalencias (`buildFactorMap`) es un tercer duplicado
 * independiente del grafo que ya vive en peps-engine-core
 * (`factoresGrupoEquivalencia`) — no se consolida aquí a propósito, para no
 * arriesgar un cambio de semántica silencioso en código financiero durante
 * un port. Cabe como limpieza futura, fuera de esta fase.
 *
 * Reglas de negocio (4):
 *  1. Lotes PEPS activos → promedio ponderado por cantidad restante.
 *     Sin lotes activos → precio de la compra más reciente.
 *  2. Se combinan los lotes y compras de TODOS los equivalentes (BFS, N niveles).
 *  3. Internamente 4 decimales; redondear a 2 solo al mostrar al usuario.
 *  4. Resolución de equivalencias consistente en todos los módulos.
 */

const { q } = require('../../db/pool')

const FILTRO_COMPRA_REAL = `
  (notas IS NULL OR (
    notas NOT LIKE '%AJUSTE INVENTARIO%'
    AND notas NOT LIKE 'PHANTOM:%'
    AND notas NOT LIKE '%BOOTSTRAP%'
  ))
  AND (folio_factura IS NULL OR folio_factura NOT LIKE 'BOOTSTRAP%')
  AND precio_unitario_compra > 0.01
`

/** Igual que q(), pero nunca lanza — resolverCostos original degradaba a [] si una query fallaba. */
async function qSafe(sql, params) {
  try {
    return await q(sql, params)
  } catch (e) {
    console.warn('[costo-promedio] query falló, degradando a []:', e.message)
    return []
  }
}

function buildFactorMap(targetId, convRows) {
  const fm = new Map([[targetId, 1]])
  const queue = [targetId]
  while (queue.length > 0) {
    const cur = queue.shift()
    const cf = fm.get(cur)
    for (const c of convRows) {
      if (c.id_producto_derivado === cur && !fm.has(c.id_producto_base)) {
        fm.set(c.id_producto_base, c.factor * cf)
        queue.push(c.id_producto_base)
      } else if (c.id_producto_base === cur && !fm.has(c.id_producto_derivado)) {
        fm.set(c.id_producto_derivado, cf / c.factor)
        queue.push(c.id_producto_derivado)
      }
    }
  }
  return fm
}

/**
 * Resuelve el costo por unidad para cada producto aplicando las 4 reglas de negocio.
 */
async function resolverCostos(idsProductos) {
  const out = new Map()
  if (!idsProductos?.length) return out

  const ids = [...new Set(idsProductos)]

  const convRows = (await qSafe(`
    SELECT id_producto_derivado, id_producto_base, factor
    FROM producto_conversion_peps
    WHERE activo = 1 AND id_grupo IS NULL
      AND id_producto_derivado != id_producto_base
  `)).map(r => ({
    id_producto_derivado: Number(r.id_producto_derivado),
    id_producto_base: Number(r.id_producto_base),
    factor: parseFloat(String(r.factor)),
  })).filter(c => c.factor > 0 && isFinite(c.factor))

  const factorMaps = new Map()
  const allIds = new Set(ids)
  for (const id of ids) {
    const fm = buildFactorMap(id, convRows)
    factorMaps.set(id, fm)
    fm.forEach((_, pid) => allIds.add(pid))
  }
  const allIdsArr = [...allIds]
  const phAll = allIdsArr.map(() => '?').join(',')

  const pepsRows = await qSafe(`
    SELECT id_producto, costo_unitario, cantidad_restante
    FROM inventario_peps
    WHERE id_producto IN (${phAll})
      AND activo = 1 AND cantidad_restante > 0 AND costo_unitario > 0.01
  `, allIdsArr)
  const pepsMap = new Map()
  for (const row of pepsRows) {
    const pid = Number(row.id_producto)
    if (!pepsMap.has(pid)) pepsMap.set(pid, [])
    pepsMap.get(pid).push({ costo: parseFloat(String(row.costo_unitario)), qty: parseFloat(String(row.cantidad_restante)) })
  }

  const comprasRows = await qSafe(`
    SELECT id_producto,
           COUNT(*) AS num_compras,
           MAX(fecha_compra) AS ultima_compra,
           MIN(precio_unitario_compra) AS precio_min,
           MAX(precio_unitario_compra) AS precio_max
    FROM compra
    WHERE id_producto IN (${phAll}) AND ${FILTRO_COMPRA_REAL}
    GROUP BY id_producto
  `, allIdsArr)
  const comprasMap = new Map()
  for (const row of comprasRows) {
    comprasMap.set(Number(row.id_producto), {
      num: Number(row.num_compras),
      ultima: row.ultima_compra ? String(row.ultima_compra) : null,
      min: row.precio_min != null ? parseFloat(String(row.precio_min)) : null,
      max: row.precio_max != null ? parseFloat(String(row.precio_max)) : null,
    })
  }

  const ultimaRows = await qSafe(`
    SELECT c.id_producto, c.precio_unitario_compra AS precio, c.fecha_compra
    FROM compra c
    INNER JOIN (
      SELECT id_producto, MAX(fecha_compra) AS max_fecha
      FROM compra
      WHERE id_producto IN (${phAll}) AND ${FILTRO_COMPRA_REAL}
      GROUP BY id_producto
    ) latest ON c.id_producto = latest.id_producto AND c.fecha_compra = latest.max_fecha
    WHERE c.id_producto IN (${phAll}) AND ${FILTRO_COMPRA_REAL}
  `, [...allIdsArr, ...allIdsArr])
  const ultimaMap = new Map()
  for (const row of ultimaRows) {
    const pid = Number(row.id_producto)
    const fecha = String(row.fecha_compra)
    if (!ultimaMap.has(pid) || fecha > ultimaMap.get(pid).fecha) {
      ultimaMap.set(pid, { precio: parseFloat(String(row.precio)), fecha })
    }
  }

  for (const id of ids) {
    const fm = factorMaps.get(id)

    let weightedSum = 0
    let totalQty = 0
    let stockEnLotes = 0
    for (const [pid, factor] of fm.entries()) {
      for (const lot of (pepsMap.get(pid) ?? [])) {
        const qtyTarget = lot.qty / factor
        weightedSum += lot.costo * lot.qty
        totalQty += qtyTarget
        stockEnLotes += qtyTarget
      }
    }
    const costoPeps = totalQty > 0 ? Math.round((weightedSum / totalQty) * 10000) / 10000 : null

    let bestFecha = null
    let costoUltimo = null
    for (const [pid, factor] of fm.entries()) {
      const u = ultimaMap.get(pid)
      if (!u) continue
      if (bestFecha === null || u.fecha > bestFecha) {
        bestFecha = u.fecha
        costoUltimo = Math.round(u.precio * factor * 10000) / 10000
      }
    }

    let numCompras = 0
    let ultimaCompra = null
    let precioMin = null
    let precioMax = null
    for (const [pid, factor] of fm.entries()) {
      const cs = comprasMap.get(pid)
      if (!cs) continue
      numCompras += cs.num
      if (cs.ultima && (ultimaCompra === null || cs.ultima > ultimaCompra)) ultimaCompra = cs.ultima
      if (cs.min != null) {
        const v = Math.round(cs.min * factor * 10000) / 10000
        if (precioMin === null || v < precioMin) precioMin = v
      }
      if (cs.max != null) {
        const v = Math.round(cs.max * factor * 10000) / 10000
        if (precioMax === null || v > precioMax) precioMax = v
      }
    }

    out.set(id, { costoPeps, costoUltimo, costoFinal: costoPeps ?? costoUltimo, stockEnLotes, numCompras, ultimaCompra, precioMin, precioMax })
  }

  return out
}

/**
 * Devuelve el costo estimado por unidad para cada producto (null si no hay ningún dato).
 * Usado para congelar costo_no_peps en detalle_factura al facturar.
 */
async function costosPromedioHistorico(idsProductos) {
  if (!idsProductos?.length) return {}
  const mapa = await resolverCostos(idsProductos)
  const resultado = {}
  for (const id of idsProductos) {
    resultado[id] = mapa.get(id)?.costoFinal ?? null
  }
  return resultado
}

module.exports = { resolverCostos, costosPromedioHistorico }
