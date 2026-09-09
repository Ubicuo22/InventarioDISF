/**
 * routes/electron/ordenes.js — Ordenes de Disfruleg Electron
 * (H-5 Fase 4, tramo B1: lecturas puras — ver plan de migración)
 *
 * Solo lecturas por ahora. Los canales que mutan PEPS (crear, guardar,
 * actualizar, eliminar, procesarVenta, revertirProcesamiento) y el
 * bloqueo de edición (checkLock/acquireLock/releaseLock/renewLock)
 * quedan para tramos posteriores — ver db/PEPS-RECONCILIATION-AUDIT.md
 * para el porqué de ese orden.
 *
 * Todas las lecturas son abiertas a cualquier rol autenticado, igual que
 * hoy en Electron (sin gate de rol adicional).
 */

const router = require('express').Router()
const { q } = require('../../db/pool')
const { fechaMexico, rangoUtcDelDia } = require('../../utils/fecha')
const {
  resolverCadenas,
  construirFuentes,
  consumirDeFuentes,
  factoresGrupoEquivalencia,
} = require('peps-engine-core')

const SELECT_ORDEN = `
  SELECT
    o.id_orden, o.folio_numero, o.id_cliente,
    c.nombre_cliente, g.nombre_grupo,
    o.total_estimado, o.estado, o.fecha_creacion,
    o.fecha_modificacion, o.datos_carrito, o.usuario_creador,
    o.fecha_envio,
    o.editing_by, o.editing_at, o.editing_source
  FROM ordenes_guardadas o
  INNER JOIN cliente c ON o.id_cliente = c.id_cliente
  INNER JOIN grupo g ON c.id_grupo = g.id_grupo
`

// Mismo cálculo que calcularTotal() en disfruleg-electron/ordenes.handler.ts —
// suma cantidad*precio_unitario de cada item del carrito. Aritmética simple
// sobre datos ya enviados, sin lógica PEPS: bajo riesgo de divergencia, no
// se subió a peps-engine-core (ese paquete es para lo que sí puede corromper
// inventario en silencio).
function calcularTotal(datosCarrito) {
  if (!datosCarrito) return 0
  const carrito = typeof datosCarrito === 'string' ? JSON.parse(datosCarrito) : datosCarrito
  let total = 0
  for (const [key, seccion] of Object.entries(carrito)) {
    if (key.startsWith('__')) continue
    const items = Array.isArray(seccion) ? seccion : (seccion.items || [])
    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue
      total += Math.round((item.cantidad || 0) * (item.precio_unitario || 0) * 100) / 100
    }
  }
  return Math.round(total * 100) / 100
}

// Auto-corrección de totales: si total_estimado no cuadra con el carrito, se
// corrige al vuelo en la respuesta y se repara en BD. A diferencia del lado
// Electron (que hace el UPDATE "fire and forget"), aquí se espera — en
// Workers una promesa sin await puede morir cuando termina el request.
async function sanearTotales(rows) {
  for (const row of rows) {
    try {
      const calc = calcularTotal(row.datos_carrito)
      if (Math.abs(calc - parseFloat(row.total_estimado)) >= 0.01) {
        console.warn(`⚠️ Total descuadrado en folio ${row.folio_numero}: BD $${row.total_estimado} vs carrito $${calc} — corrigiendo`)
        row.total_estimado = calc
        await q('UPDATE ordenes_guardadas SET total_estimado = ? WHERE folio_numero = ?', [calc, row.folio_numero])
      }
    } catch { /* carrito ilegible: dejar el total como está */ }
  }
  return rows
}

// ─── GET / — obtenerTodas ─────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const rows = await q(`${SELECT_ORDEN} WHERE o.activo = 1 ORDER BY o.folio_numero DESC`)
    res.json({ ok: true, data: await sanearTotales(rows) })
  } catch (e) {
    console.error('[ordenes] obtenerTodas:', e.message)
    res.status(500).json({ ok: false, error: 'Error al obtener órdenes' })
  }
})

// ─── GET /activas — obtenerActivas ────────────────────────────
router.get('/activas', async (req, res) => {
  try {
    const rows = await q(`${SELECT_ORDEN} WHERE o.estado = 'guardada' AND o.activo = 1 ORDER BY o.folio_numero DESC`)
    res.json({ ok: true, data: await sanearTotales(rows) })
  } catch (e) {
    console.error('[ordenes] obtenerActivas:', e.message)
    res.status(500).json({ ok: false, error: 'Error al obtener órdenes activas' })
  }
})

// ─── GET /historial — obtenerHistorial ────────────────────────
router.get('/historial', async (req, res) => {
  try {
    const rows = await q(`${SELECT_ORDEN} WHERE o.estado = 'registrada' AND o.activo = 1 ORDER BY o.folio_numero DESC`)
    res.json({ ok: true, data: await sanearTotales(rows) })
  } catch (e) {
    console.error('[ordenes] obtenerHistorial:', e.message)
    res.status(500).json({ ok: false, error: 'Error al obtener historial' })
  }
})

// ─── GET /folio/:folio — obtenerPorFolio ──────────────────────
router.get('/folio/:folio', async (req, res) => {
  try {
    const rows = await q(`${SELECT_ORDEN} WHERE o.folio_numero = ? AND o.activo = 1`, [req.params.folio])
    if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Orden no encontrada' })
    const [saneada] = await sanearTotales(rows)
    res.json({ ok: true, data: saneada })
  } catch (e) {
    console.error('[ordenes] obtenerPorFolio:', e.message)
    res.status(500).json({ ok: false, error: 'Error al obtener la orden' })
  }
})

// ─── GET /siguiente-folio — obtenerSiguienteFolio ─────────────
router.get('/siguiente-folio', async (req, res) => {
  try {
    const rows = await q('SELECT folio_numero FROM ordenes_guardadas ORDER BY folio_numero')
    const used = new Set(rows.map(r => Number(r.folio_numero)))
    let next = 1
    while (used.has(next)) next++
    res.json({ ok: true, data: { folio: next } })
  } catch (e) {
    console.error('[ordenes] obtenerSiguienteFolio:', e.message)
    res.status(500).json({ ok: false, error: 'Error al calcular el siguiente folio' })
  }
})

// ─── GET /cliente/:idCliente — obtenerPorCliente ──────────────
router.get('/cliente/:idCliente', async (req, res) => {
  try {
    const rows = await q(`
      SELECT o.id_orden, o.folio_numero, o.total_estimado, o.estado, o.fecha_creacion, o.usuario_creador
      FROM ordenes_guardadas o
      WHERE o.id_cliente = ? AND o.activo = 1
      ORDER BY o.folio_numero DESC
    `, [req.params.idCliente])
    res.json({ ok: true, data: rows })
  } catch (e) {
    console.error('[ordenes] obtenerPorCliente:', e.message)
    res.status(500).json({ ok: false, error: 'Error al obtener órdenes del cliente' })
  }
})

// ─── GET /estadisticas ─────────────────────────────────────────
router.get('/estadisticas', async (req, res) => {
  try {
    const rows = await q(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN estado = 'guardada'   THEN 1 ELSE 0 END) as guardadas,
        SUM(CASE WHEN estado = 'registrada' THEN 1 ELSE 0 END) as registradas,
        SUM(CASE WHEN estado = 'guardada'   THEN total_estimado ELSE 0 END) as valor_guardadas,
        SUM(CASE WHEN estado = 'registrada' THEN total_estimado ELSE 0 END) as valor_registradas,
        SUM(total_estimado) as valor_total
      FROM ordenes_guardadas
      WHERE activo = 1
    `)
    res.json({ ok: true, data: rows[0] })
  } catch (e) {
    console.error('[ordenes] estadisticas:', e.message)
    res.status(500).json({ ok: false, error: 'Error al obtener estadísticas' })
  }
})

// ─── GET /notas-cliente-hoy/:idCliente — notasClienteHoy ──────
// Detecta posibles duplicados: notas activas creadas HOY (zona México) para
// el cliente. Usa rangoUtcDelDia (utils/fecha.js), que ya maneja el DST de
// CDMX — mismo resultado que el cálculo manual de tzOffsetMs de Electron.
router.get('/notas-cliente-hoy/:idCliente', async (req, res) => {
  try {
    const { inicio, fin } = rangoUtcDelDia(fechaMexico())
    const rows = await q(`
      SELECT folio_numero, estado, datos_carrito, fecha_creacion
      FROM ordenes_guardadas
      WHERE id_cliente = ? AND activo = 1
        AND fecha_creacion >= ? AND fecha_creacion < ?
      ORDER BY fecha_creacion ASC
    `, [req.params.idCliente, inicio, fin])

    const notas = rows.map(row => {
      let observacion = ''
      try {
        const carrito = typeof row.datos_carrito === 'string' ? JSON.parse(row.datos_carrito) : row.datos_carrito
        observacion = (carrito?.__observacion__ ?? '').toString()
      } catch { /* carrito corrupto → sin observación */ }
      return {
        folio_numero: row.folio_numero,
        estado: row.estado,
        observacion,
        fecha_creacion: row.fecha_creacion,
      }
    })
    res.json({ ok: true, data: notas })
  } catch (e) {
    console.error('[ordenes] notasClienteHoy:', e.message)
    res.status(500).json({ ok: false, error: 'Error al obtener notas del cliente' })
  }
})

// ─── GET /reservas/:idProducto — reservasProducto ─────────────
// El badge "en notas" muestra el reservado combinado del grupo de
// equivalencia — trae reservas de TODO el grupo (base + derivados), no solo
// del producto consultado. Usa factoresGrupoEquivalencia (peps-engine-core)
// para resolver el grupo, igual que calcularFactoresEnUnidad en Electron.
router.get('/reservas/:idProducto', async (req, res) => {
  const idProducto = Number(req.params.idProducto)
  try {
    const convRows = await q(`
      SELECT id_producto_derivado, id_producto_base, factor
      FROM producto_conversion_peps
      WHERE activo = 1 AND id_grupo IS NULL AND id_producto_derivado != id_producto_base
    `)
    const factores = factoresGrupoEquivalencia(idProducto, convRows)
    const miembros = factores.size > 0 ? [...factores.keys()] : [idProducto]
    const ph = miembros.map(() => '?').join(',')

    const rows = await q(`
      SELECT ri.id_producto, ri.folio_numero, ri.cantidad_reservada, ri.fecha_reserva,
             p.nombre_producto AS producto_origen, p.unidad_producto AS unidad_origen,
             COALESCE(c.nombre_cliente, 'Nota eliminada') AS nombre_cliente,
             COALESCE(g.nombre_grupo, '—') AS nombre_grupo
      FROM reserva_inventario ri
      LEFT JOIN producto p ON p.id_producto = ri.id_producto
      LEFT JOIN ordenes_guardadas o ON o.folio_numero = ri.folio_numero
      LEFT JOIN cliente c ON o.id_cliente = c.id_cliente
      LEFT JOIN grupo g ON c.id_grupo = g.id_grupo
      WHERE ri.id_producto IN (${ph}) AND ri.estado = 'activa'
      ORDER BY ri.fecha_reserva ASC
    `, miembros)

    for (const row of rows) row.es_equivalente = Number(row.id_producto) !== idProducto
    res.json({ ok: true, data: rows })
  } catch (e) {
    console.error('[ordenes] reservasProducto:', e.message)
    res.status(500).json({ ok: false, error: 'Error al obtener reservas' })
  }
})

// ─── POST /validar-stock — validarStock ───────────────────────
// Simula el consumo FIFO sin mutar (misma peps-engine-core que el consumo
// real) para saber si el carrito tiene stock suficiente. Réplica de
// validarStockCarrito en disfruleg-electron/ordenes.handler.ts.
router.post('/validar-stock', async (req, res) => {
  try {
    const { folio_numero, datos_carrito } = req.body
    let carrito = datos_carrito

    if (folio_numero && !datos_carrito) {
      const rows = await q('SELECT datos_carrito FROM ordenes_guardadas WHERE folio_numero = ? AND activo = 1', [folio_numero])
      if (rows.length === 0) return res.status(404).json({ ok: false, error: `Orden ${folio_numero} no encontrada` })
      carrito = typeof rows[0].datos_carrito === 'string' ? JSON.parse(rows[0].datos_carrito) : rows[0].datos_carrito
    }
    if (!carrito) return res.status(400).json({ ok: false, error: 'No se proporcionaron datos del carrito' })

    const resultado = await validarStockCarrito(carrito, folio_numero ?? null)
    res.json({ ok: true, data: resultado })
  } catch (e) {
    console.error('[ordenes] validarStock:', e.message)
    res.status(500).json({ ok: false, error: 'Error al validar stock' })
  }
})

async function validarStockCarrito(datosCarrito, folioExcluir) {
  const itemsAValidar = []
  for (const seccion of Object.values(datosCarrito)) {
    const items = Array.isArray(seccion) ? seccion : (seccion.items || [])
    for (const item of items) {
      const cantidad = parseFloat(String(item.cantidad))
      if (cantidad > 0) {
        itemsAValidar.push({
          id_producto: item.id_producto,
          cantidad,
          nombre_producto: item.nombre_producto,
          unidad_producto: item.unidad_producto,
          cantidad_sin_descuento: item.cantidad_sin_descuento,
        })
      }
    }
  }
  if (itemsAValidar.length === 0) return { suficiente: true, productos_faltantes: [] }

  const idsUnicos = [...new Set(itemsAValidar.map(i => i.id_producto))]
  const phConv = idsUnicos.map(() => '?').join(',')

  // Conversiones de los productos del carrito (solo globales, igual que Electron
  // cuando no se le pasa idGrupo — ver nota en la auditoría sobre id_grupo)
  const convRows = await q(`
    SELECT id_producto_derivado, id_producto_base, factor, id_grupo
    FROM producto_conversion_peps
    WHERE id_producto_derivado IN (${phConv})
      AND activo = 1 AND id_producto_derivado != id_producto_base
      AND id_grupo IS NULL
    ORDER BY (id_grupo IS NULL) ASC
  `, idsUnicos)

  const convMap = {}
  for (const row of convRows) {
    const pid = Number(row.id_producto_derivado)
    if (!convMap[pid] || row.id_grupo !== null) {
      convMap[pid] = { idBase: Number(row.id_producto_base), factor: parseFloat(String(row.factor)) }
    }
  }

  const allConvRows = await q(`
    SELECT id_producto_derivado, id_producto_base, factor
    FROM producto_conversion_peps
    WHERE activo = 1 AND id_grupo IS NULL AND id_producto_derivado != id_producto_base
  `)
  const allConvMap = {}
  for (const row of allConvRows) {
    allConvMap[Number(row.id_producto_derivado)] = { idBase: Number(row.id_producto_base), factor: parseFloat(String(row.factor)) }
  }
  resolverCadenas(convMap, allConvMap)

  // Lotes propios primero, igual que processarOrden: si el derivado tiene
  // stock propio, se guarda su conversión aparte para sumar el base como
  // respaldo en vez de reemplazarlo.
  const ownLotesConvs = {}
  const idsConConv = Object.keys(convMap).map(Number)
  if (idsConConv.length > 0) {
    const phConvIds = idsConConv.map(() => '?').join(',')
    const stockPropioRows = await q(`
      SELECT id_producto, SUM(cantidad_restante) AS stock_propio
      FROM inventario_peps
      WHERE id_producto IN (${phConvIds}) AND cantidad_restante > 0 AND activo = 1
      GROUP BY id_producto
    `, idsConConv)
    for (const row of stockPropioRows) {
      const pid = Number(row.id_producto)
      if (parseFloat(String(row.stock_propio)) > 0 && convMap[pid]) {
        ownLotesConvs[pid] = convMap[pid]
        delete convMap[pid]
      }
    }
  }

  const idsLotesVal = new Set()
  for (const item of itemsAValidar) {
    for (const fuente of construirFuentes(item.id_producto, convMap[item.id_producto], ownLotesConvs[item.id_producto])) {
      idsLotesVal.add(fuente.idProd)
    }
  }
  const idsValidar = [...idsLotesVal]
  const phValidar = idsValidar.map(() => '?').join(',')

  const loteRows = idsValidar.length > 0 ? await q(`
    SELECT id_producto, cantidad_restante, factor_conversion
    FROM inventario_peps
    WHERE id_producto IN (${phValidar}) AND cantidad_restante > 0 AND activo = 1
    ORDER BY fecha_movimiento ASC, id_inventario_peps ASC
  `, idsValidar) : []

  const lotesValPorProducto = {}
  for (const row of loteRows) {
    const pid = Number(row.id_producto)
    if (!lotesValPorProducto[pid]) lotesValPorProducto[pid] = []
    lotesValPorProducto[pid].push({
      restante: parseFloat(String(row.cantidad_restante)),
      factorConversion: row.factor_conversion != null ? parseFloat(String(row.factor_conversion)) : null,
    })
  }

  // Al editar una nota, su propio consumo se devuelve a los lotes en memoria
  // antes de simular — igual que Electron.
  if (folioExcluir !== null) {
    const consumoRows = await q(`
      SELECT ip.id_producto, SUM(ocp.cantidad_consumida) AS total
      FROM orden_consumo_peps ocp
      INNER JOIN inventario_peps ip ON ip.id_inventario_peps = ocp.id_inventario_peps
      WHERE ocp.folio_numero = ?
      GROUP BY ip.id_producto
    `, [folioExcluir]).catch(() => [])
    for (const row of consumoRows) {
      const pidLote = Number(row.id_producto)
      const total = parseFloat(String(row.total))
      const lotes = lotesValPorProducto[pidLote]
      if (lotes?.length) lotes[0].restante += total
      else lotesValPorProducto[pidLote] = [{ restante: total, factorConversion: null }]
    }
  }

  const productos_faltantes = []
  for (const item of itemsAValidar) {
    const sinDesc = Math.min(Number(item.cantidad_sin_descuento) || 0, item.cantidad)
    const cantidadEfectiva = item.cantidad - sinDesc
    if (cantidadEfectiva <= 0) continue

    const fuentes = construirFuentes(item.id_producto, convMap[item.id_producto], ownLotesConvs[item.id_producto])
    const { pendiente } = consumirDeFuentes(cantidadEfectiva, fuentes, lotesValPorProducto)

    if (pendiente > 0) {
      productos_faltantes.push({
        id_producto: item.id_producto,
        nombre_producto: item.nombre_producto || `Producto ${item.id_producto}`,
        unidad_producto: item.unidad_producto || '',
        cantidad_solicitada: cantidadEfectiva,
        stock_disponible: Math.round((cantidadEfectiva - pendiente) * 1000) / 1000,
        stock_reservado: 0,
        faltante: Math.round(pendiente * 1000) / 1000,
      })
    }
  }

  return productos_faltantes.length === 0
    ? { suficiente: true, productos_faltantes: [] }
    : { suficiente: false, productos_faltantes }
}

module.exports = router
