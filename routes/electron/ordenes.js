/**
 * routes/electron/ordenes.js — Ordenes de Disfruleg Electron
 * (H-5 Fase 4 — ver plan de migración)
 *
 * Tramo B1: las 10 lecturas puras. Tramo B2: el bloqueo de edición
 * (checkLock/acquireLock/releaseLock/renewLock) — comparte columnas
 * (editing_by/editing_at/editing_source) con el candado propio de
 * bodega-web en routes/ordenes.js (`PATCH /api/ordenes/:folio/lock`),
 * así que ambos deben seguir interoperando: mismo timeout (5 min) y
 * mismos valores de editing_source ('electron' / 'bodega-web').
 *
 * Los canales que mutan PEPS (crear, guardar, actualizar, eliminar,
 * procesarVenta, revertirProcesamiento) quedan para un tramo posterior
 * — ver db/PEPS-RECONCILIATION-AUDIT.md para el porqué de ese orden.
 *
 * Todas las lecturas son abiertas a cualquier rol autenticado, igual que
 * hoy en Electron (sin gate de rol adicional). El candado también: ver
 * ordenes.handler.ts, ningún rol lo restringe hoy.
 */

const router = require('express').Router()
const bcrypt = require('bcryptjs')
const { q, pool } = require('../../db/pool')
const { fechaMexico, rangoUtcDelDia } = require('../../utils/fecha')
const { requireRoleElectron } = require('../../middleware/auth-electron')
const {
  resolverCadenas,
  construirFuentes,
  consumirDeFuentes,
  factoresGrupoEquivalencia,
} = require('peps-engine-core')
const { consumirPepsParaOrden, revertirConsumoOrden, tieneConsumoOrden } = require('./orden-consumo')
const { costosPromedioHistorico } = require('./costo-promedio')

const ADMIN = requireRoleElectron(['admin', 'ceo'])

// Folios ≤ este número son pre-inventario: al procesarse generan lotes fantasma
// en vez de consumir stock real. A partir del siguiente, comportamiento normal PEPS.
const FOLIO_CORTE_INVENTARIO = 337

/**
 * Verifica usuario+contraseña de un admin/ceo real contra la BD — mismo
 * bcrypt+lockout que routes/electron/auth.js usa para el login normal.
 *
 * Fix de seguridad (H-5, procesarVenta/revertirProcesamiento): antes, el
 * modal AdminAuthModal validaba la contraseña solo localmente en Electron
 * (auth:verifyAdminPassword) y el Worker se limitaba a confiar en el
 * username que mandaba el body — un renderer parchado podía saltarse el
 * modal por completo. Ahora la contraseña se re-verifica AQUÍ, en el mismo
 * request que ejecuta la acción — no en una llamada separada que se pueda
 * omitir.
 */
async function verificarAdminPassword(req, username, password) {
  const u = String(username ?? '').trim()
  const p = String(password ?? '').trim()
  if (!u || !p) return { ok: false, error: 'Usuario y contraseña de administrador son requeridos' }

  const ip = (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '').slice(0, 45)

  try {
    const intentos = await q(
      `SELECT COUNT(*) as cnt FROM intentos_fallidos
       WHERE ip_address = ? AND razon = 'Admin venta/reversión' AND fecha_intento >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)`,
      [ip]
    )
    if ((intentos[0]?.cnt || 0) >= 5) {
      return { ok: false, error: 'Demasiados intentos fallidos. Espera 5 minutos.' }
    }
  } catch (_) { /* tabla aún no existe — continuar */ }

  const rows = await q(
    "SELECT password_hash FROM usuarios_sistema WHERE UPPER(username) = UPPER(?) AND rol IN ('admin','ceo') AND activo = 1",
    [u]
  )

  const registrarFallo = () =>
    q(`INSERT INTO intentos_fallidos (ip_address, razon, usuario_intentado) VALUES (?, 'Admin venta/reversión', ?)`, [ip, u]).catch(() => {})

  if (rows.length === 0) {
    await registrarFallo()
    return { ok: false, error: 'Usuario o contraseña de administrador incorrectos' }
  }

  const valido = await bcrypt.compare(p, String(rows[0].password_hash ?? ''))
  if (!valido) {
    await registrarFallo()
    return { ok: false, error: 'Usuario o contraseña de administrador incorrectos' }
  }

  return { ok: true }
}

async function consumirReservas(conn, folioNumero) {
  await conn.execute(
    `UPDATE reserva_inventario SET estado = 'consumida' WHERE folio_numero = ? AND estado = 'activa'`,
    [folioNumero]
  )
}

async function obtenerIdGrupoCliente(conn, idCliente) {
  try {
    const [rows] = await conn.execute('SELECT id_grupo FROM cliente WHERE id_cliente = ?', [idCliente])
    return rows?.[0]?.id_grupo ?? null
  } catch (_) {
    return null
  }
}

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

// ═══════════════════════════════════════════════════════════════
// BLOQUEO DE EDICIÓN CONCURRENTE (B2)
// ═══════════════════════════════════════════════════════════════
//
// La identidad para el candado (almacenada en editing_by Y usada para el
// check de "es la misma persona") sale del JWT (req.user.nombre || username),
// nunca del body — mismo criterio que ya usa bodega-web en su propio
// PATCH /api/ordenes/:folio/lock. El valor que la app Electron le pasaba
// históricamente a este canal (`usuario` del body) queda solo como dato
// informativo, no autoritativo.

const LOCK_TIMEOUT_SECONDS = 5 * 60

function identidadCandado(req) {
  return req.user.nombre || req.user.username
}

// ─── GET /lock/:folio — checkLock ──────────────────────────────
router.get('/lock/:folio', async (req, res) => {
  try {
    const rows = await q(
      `SELECT editing_by, editing_source, TIMESTAMPDIFF(SECOND, editing_at, NOW()) as elapsed_s
       FROM ordenes_guardadas WHERE folio_numero = ? AND activo = 1`,
      [req.params.folio]
    )
    if (rows.length === 0) return res.json({ ok: true, data: { locked: false } })

    const row = rows[0]
    if (row.editing_by && row.elapsed_s != null && row.elapsed_s < LOCK_TIMEOUT_SECONDS) {
      return res.json({ ok: true, data: { locked: true, editing_by: row.editing_by, editing_source: row.editing_source } })
    }
    res.json({ ok: true, data: { locked: false } })
  } catch (e) {
    console.error('[ordenes] checkLock:', e.message)
    res.status(500).json({ ok: false, error: 'Error al consultar el bloqueo' })
  }
})

// ─── POST /lock/:folio — acquireLock ───────────────────────────
// Adquisición atómica: el UPDATE solo ocurre si nadie más tiene el lock
// activo — elimina la carrera SELECT→check→UPDATE de dos pasos (la misma
// que sigue teniendo bodega-web en routes/ordenes.js, ver nota ahí).
router.post('/lock/:folio', async (req, res) => {
  const folio = req.params.folio
  const usuario = identidadCandado(req)
  try {
    const upd = await pool.execute(
      `UPDATE ordenes_guardadas
       SET editing_by = ?, editing_at = NOW(), editing_source = 'electron'
       WHERE folio_numero = ? AND activo = 1
         AND (
           editing_by IS NULL
           OR editing_by = ?
           OR TIMESTAMPDIFF(SECOND, editing_at, NOW()) >= ?
         )`,
      [usuario, folio, usuario, LOCK_TIMEOUT_SECONDS]
    )
    if (upd[0].affectedRows > 0) return res.json({ ok: true, data: { locked: false } })

    // affectedRows = 0 → no encontrado o lock activo de otro usuario
    const rows = await q('SELECT editing_by, editing_source FROM ordenes_guardadas WHERE folio_numero = ? AND activo = 1', [folio])
    if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Orden no encontrada' })
    const row = rows[0]
    if (!row.editing_by) return res.json({ ok: true, data: { locked: false } })

    const desde = row.editing_source === 'bodega-web' ? 'la app web (bodega)' : 'la aplicación de escritorio'
    res.json({
      ok: true,
      data: {
        locked: true,
        adquirido: false,
        message: `${row.editing_by} está editando esta nota desde ${desde}`,
        editing_by: row.editing_by,
        editing_source: row.editing_source,
      }
    })
  } catch (e) {
    console.error('[ordenes] acquireLock:', e.message)
    res.status(500).json({ ok: false, error: 'Error al adquirir el bloqueo' })
  }
})

// ─── DELETE /lock/:folio — releaseLock ─────────────────────────
router.delete('/lock/:folio', async (req, res) => {
  try {
    await pool.execute(
      'UPDATE ordenes_guardadas SET editing_by = NULL, editing_at = NULL, editing_source = NULL WHERE folio_numero = ?',
      [req.params.folio]
    )
    res.json({ ok: true, data: { released: true } })
  } catch (e) {
    console.error('[ordenes] releaseLock:', e.message)
    res.status(500).json({ ok: false, error: 'Error al liberar el bloqueo' })
  }
})

// ─── PUT /lock/:folio — renewLock (heartbeat) ──────────────────
// PUT y no PATCH: bodegaClient.ts (disfruleg-electron) solo expone
// get/post/put/del — no hay verbo PATCH en el cliente HTTP compartido.
router.put('/lock/:folio', async (req, res) => {
  const usuario = identidadCandado(req)
  try {
    const upd = await pool.execute(
      'UPDATE ordenes_guardadas SET editing_at = NOW() WHERE folio_numero = ? AND editing_by = ?',
      [req.params.folio, usuario]
    )
    res.json({ ok: true, data: { renewed: upd[0].affectedRows > 0 } })
  } catch (e) {
    console.error('[ordenes] renewLock:', e.message)
    res.status(500).json({ ok: false, error: 'Error al renovar el bloqueo' })
  }
})

// ═══════════════════════════════════════════════════════════════
// ESCRITURAS SIMPLES (B3) — sin respaldo local del lado Electron
// ═══════════════════════════════════════════════════════════════
//
// La identidad de "quién hizo esto" (usada en el historial de la orden y
// para el gate de rol) sale del JWT (req.user.nombre || username), nunca
// del body — cierra el hueco de verificarRolCeo(usuario) que dejaba
// verificar el rol de un username que el renderer podía mandar libremente,
// sin comprobar que la sesión activa fuera realmente de esa persona.

function identidadEscritura(req) {
  return req.user.nombre || req.user.username
}

// ─── PUT /estado/:folio — cambiarEstado ────────────────────────
router.put('/estado/:folio', async (req, res) => {
  try {
    const { nuevoEstado } = req.body
    const estado = nuevoEstado === 1 ? 'guardada' : 'registrada'
    const [upd] = await pool.execute(
      'UPDATE ordenes_guardadas SET estado = ? WHERE folio_numero = ?',
      [estado, req.params.folio]
    )
    res.json({ ok: true, data: { affectedRows: upd.affectedRows } })
  } catch (e) {
    console.error('[ordenes] cambiarEstado:', e.message)
    res.status(500).json({ ok: false, error: 'Error al cambiar el estado' })
  }
})

// ─── POST /revision/:folio — registrarRevision ─────────────────
router.post('/revision/:folio', async (req, res) => {
  const folio = req.params.folio
  const usuario = identidadEscritura(req)
  const { totalProductos, faltantes, pendientes } = req.body
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.execute('SELECT datos_carrito FROM ordenes_guardadas WHERE folio_numero = ?', [folio])
    if (rows.length === 0) { await conn.rollback(); return res.status(404).json({ ok: false, error: 'Orden no encontrada' }) }

    const carrito = typeof rows[0].datos_carrito === 'string' ? JSON.parse(rows[0].datos_carrito) : (rows[0].datos_carrito || {})
    const historialPrevio = carrito.__historial__ || []
    carrito.__historial__ = [...historialPrevio, {
      usuario,
      fecha: new Date().toISOString(),
      tipoEvento: 'revision',
      totalProductos: totalProductos || 0,
      faltantes: Array.isArray(faltantes) ? faltantes : [],
      pendientes: Array.isArray(pendientes) ? pendientes : [],
    }]

    await conn.execute(
      'UPDATE ordenes_guardadas SET datos_carrito = ?, fecha_modificacion = NOW() WHERE folio_numero = ?',
      [JSON.stringify(carrito), folio]
    )
    await conn.commit()
    res.json({ ok: true, data: null })
  } catch (e) {
    await conn.rollback()
    console.error('[ordenes] registrarRevision:', e.message)
    res.status(500).json({ ok: false, error: 'Error al registrar la revisión' })
  } finally {
    conn.release()
  }
})

// ─── PUT /enviado/:folio — marcarEnviado (admin/ceo) ───────────
router.put('/enviado/:folio', ADMIN, async (req, res) => {
  const folio = req.params.folio
  const usuario = identidadEscritura(req)
  const nuevaFecha = req.body.fecha || null
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.execute(
      'SELECT estado, fecha_envio, datos_carrito FROM ordenes_guardadas WHERE folio_numero = ? AND activo = 1',
      [folio]
    )
    if (rows.length === 0) { await conn.rollback(); return res.json({ ok: false, error: 'Orden no encontrada' }) }

    const row = rows[0]
    const carrito = typeof row.datos_carrito === 'string' ? JSON.parse(row.datos_carrito) : (row.datos_carrito || {})
    const historial = carrito.__historial__ || []
    historial.push({
      tipoEvento: 'fecha_envio',
      fecha: new Date().toISOString(),
      usuario,
      fecha_envio: nuevaFecha,
      fecha_anterior: row.fecha_envio || null,
    })
    carrito.__historial__ = historial

    await conn.execute('UPDATE ordenes_guardadas SET datos_carrito = ? WHERE folio_numero = ?', [JSON.stringify(carrito), folio])
    await conn.execute('UPDATE ordenes_guardadas SET fecha_envio = ? WHERE folio_numero = ?', [nuevaFecha, folio])
    await conn.commit()
    res.json({ ok: true, data: { success: true } })
  } catch (e) {
    await conn.rollback()
    console.error('[ordenes] marcarEnviado:', e.message)
    res.status(500).json({ ok: false, error: 'Error al marcar el envío' })
  } finally {
    conn.release()
  }
})

// ─── POST /notas-ceo/:folio — guardarNotaCeo (admin/ceo) ───────
router.post('/notas-ceo/:folio', ADMIN, async (req, res) => {
  const folio = req.params.folio
  const usuario = identidadEscritura(req)
  const nota = String(req.body.nota || '').trim()
  if (!nota) return res.status(400).json({ ok: false, error: 'La nota no puede estar vacía' })

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [checkRows] = await conn.execute(
      'SELECT id_orden, datos_carrito FROM ordenes_guardadas WHERE folio_numero = ? AND activo = 1', [folio]
    )
    if (checkRows.length === 0) { await conn.rollback(); return res.json({ ok: false, error: 'Orden no encontrada' }) }

    const { id_orden, datos_carrito } = checkRows[0]
    const carrito = typeof datos_carrito === 'string' ? JSON.parse(datos_carrito) : (datos_carrito || {})
    carrito.__notas_ceo__ = carrito.__notas_ceo__ || []
    carrito.__notas_ceo__.push({ texto: nota, usuario, fecha: new Date().toISOString() })

    await conn.execute('UPDATE ordenes_guardadas SET datos_carrito = ? WHERE folio_numero = ?', [JSON.stringify(carrito), folio])

    const [autorRows] = await conn.execute(
      'SELECT id_usuario, nombre_completo FROM usuarios_sistema WHERE username = ? AND activo = 1 LIMIT 1',
      [req.user.username]
    )
    const autorId = autorRows[0]?.id_usuario
    const autorNombre = autorRows[0]?.nombre_completo || usuario

    const [msgResult] = await conn.execute(
      `INSERT INTO orden_mensajes (id_orden, id_usuario, username, nombre_completo, texto, menciones, folio_numero)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id_orden, autorId ?? 0, req.user.username, autorNombre, nota, '[]', String(folio)]
    )
    const idMensaje = msgResult.insertId

    if (idMensaje) {
      const [destRows] = await conn.execute(
        `SELECT id_usuario FROM usuarios_sistema WHERE activo = 1 AND rol IN ('admin','ceo','supervisor') AND id_usuario != ?`,
        [autorId ?? 0]
      )
      const destinatarios = (destRows ?? []).map(r => r.id_usuario)
      if (destinatarios.length > 0) {
        const values = destinatarios.map(() => '(?, ?, ?, ?, ?)').join(',')
        const flat = destinatarios.flatMap(d => [d, idMensaje, id_orden, String(folio), nota.slice(0, 80)])
        await conn.execute(
          `INSERT INTO notificaciones_mensajes (id_usuario_destino, id_mensaje, id_orden, folio_numero, texto_preview) VALUES ${values}`,
          flat
        )
      }
    }

    await conn.commit()
    res.json({ ok: true, data: { success: true } })
  } catch (e) {
    await conn.rollback()
    console.error('[ordenes] guardarNotaCeo:', e.message)
    res.status(500).json({ ok: false, error: 'Error al guardar la nota' })
  } finally {
    conn.release()
  }
})

// ─── POST /notas-ceo/:folio/vista — registrarVistaCeo ──────────
// Sin gate de rol — cualquier usuario autenticado puede marcar como vistas
// las notas que YA puede ver (igual que hoy en Electron).
router.post('/notas-ceo/:folio/vista', async (req, res) => {
  const folio = req.params.folio
  const usuario = identidadEscritura(req)
  try {
    const rows = await q('SELECT datos_carrito FROM ordenes_guardadas WHERE folio_numero = ? AND activo = 1', [folio])
    if (rows.length === 0) return res.json({ ok: true, data: { success: false } })

    const carrito = typeof rows[0].datos_carrito === 'string' ? JSON.parse(rows[0].datos_carrito) : (rows[0].datos_carrito || {})
    if (!Array.isArray(carrito.__notas_ceo__) || carrito.__notas_ceo__.length === 0) {
      return res.json({ ok: true, data: { success: true } })
    }

    const vistas = carrito.__notas_ceo_vistas__ || []
    const ya = vistas.find(v => v.usuario === usuario)
    if (ya) ya.fecha = new Date().toISOString()
    else vistas.push({ usuario, fecha: new Date().toISOString() })
    carrito.__notas_ceo_vistas__ = vistas

    await pool.execute('UPDATE ordenes_guardadas SET datos_carrito = ? WHERE folio_numero = ?', [JSON.stringify(carrito), folio])
    res.json({ ok: true, data: { success: true } })
  } catch (e) {
    console.error('[ordenes] registrarVistaCeo:', e.message)
    res.status(500).json({ ok: false, error: 'Error al registrar la vista' })
  }
})

// ─── DELETE /notas-ceo/:folio/:index — eliminarNotaCeo (admin/ceo) ─
router.delete('/notas-ceo/:folio/:index', ADMIN, async (req, res) => {
  const folio = req.params.folio
  const index = Number(req.params.index)
  try {
    const rows = await q('SELECT datos_carrito FROM ordenes_guardadas WHERE folio_numero = ? AND activo = 1', [folio])
    if (rows.length === 0) return res.json({ ok: false, error: 'Orden no encontrada' })

    const carrito = typeof rows[0].datos_carrito === 'string' ? JSON.parse(rows[0].datos_carrito) : (rows[0].datos_carrito || {})
    const notas = carrito.__notas_ceo__ || []
    if (index < 0 || index >= notas.length) return res.json({ ok: false, error: 'Índice de nota inválido' })

    notas.splice(index, 1)
    carrito.__notas_ceo__ = notas

    await pool.execute('UPDATE ordenes_guardadas SET datos_carrito = ? WHERE folio_numero = ?', [JSON.stringify(carrito), folio])
    res.json({ ok: true, data: { success: true } })
  } catch (e) {
    console.error('[ordenes] eliminarNotaCeo:', e.message)
    res.status(500).json({ ok: false, error: 'Error al eliminar la nota' })
  }
})

// ═══════════════════════════════════════════════════════════════
// PROCESAR VENTA (H-5 Fase 4 — procesarVenta)
//
// Fail-closed (requireAuthElectron ya corrió a nivel de app.js — cualquier
// rol autenticado puede llamar esta ruta, porque un cajero legítimamente la
// dispara después de que un admin/ceo autoriza vía AdminAuthModal). La
// identidad que de verdad importa (admin_usuario) se re-verifica aquí con
// su contraseña real — ver verificarAdminPassword arriba.
//
// Overselling (decisión de negocio, Opción A): cuando la rama post-
// inventario/legacy no tiene lotes suficientes, en vez de vender en
// silencio se genera una compra PHANTOM:VENTA-F<folio> + su lote PEPS por
// la cantidad faltante — entradas.js (sin tocar) ya sabe reconciliarla
// cuando llegue la próxima compra real de ese producto.
// ═══════════════════════════════════════════════════════════════

router.post('/procesar-venta/:folio', async (req, res) => {
  const folio = req.params.folio
  const { admin_usuario, admin_password, monto_pagado } = req.body

  const auth = await verificarAdminPassword(req, admin_usuario, admin_password)
  if (!auth.ok) return res.status(401).json({ ok: false, error: auth.error })

  try {
    // Mutex: bloquear si la appweb tiene una revisión de inventario activa.
    try {
      const revRows = await q(
        `SELECT activa, (inicio IS NULL OR inicio < NOW() - INTERVAL 30 MINUTE) AS stale
         FROM revision_activa WHERE id = 1`
      )
      const rev = revRows[0]
      if (rev && Number(rev.activa) === 1 && Number(rev.stale) !== 1) {
        return res.json({ ok: false, error: 'Hay una revisión de inventario en curso desde la appweb. Espera a que termine antes de procesar la nota.' })
      }
    } catch (e) {
      if (!e.message?.includes('revision_activa')) throw e
    }

    // ── FASE 1: LECTURAS (fuera de transacción) ──────────────────
    const ordenRows = await q(
      `SELECT id_cliente, total_estimado, datos_carrito, usuario_creador, fecha_creacion, fecha_envio, consumo_pendiente
       FROM ordenes_guardadas
       WHERE folio_numero = ? AND activo = 1 AND estado = 'guardada'`,
      [folio]
    )
    if (ordenRows.length === 0) {
      return res.json({ ok: false, error: `Orden ${folio} no encontrada o ya procesada` })
    }
    const orden = ordenRows[0]
    const datosCarrito = typeof orden.datos_carrito === 'string' ? JSON.parse(orden.datos_carrito) : orden.datos_carrito

    const todosLosItems = []
    for (const [key, seccion] of Object.entries(datosCarrito)) {
      if (key.startsWith('__')) continue
      const items = Array.isArray(seccion) ? seccion : (seccion.items || [])
      for (const item of items) {
        const cantidad = parseFloat(String(item.cantidad))
        if (cantidad > 0) {
          todosLosItems.push({
            id_producto: item.id_producto,
            cantidad,
            precio_unitario: item.precio_unitario || item.precio_final || 0,
            cantidad_sin_descuento: item.cantidad_sin_descuento,
          })
        }
      }
    }
    if (todosLosItems.length === 0) return res.json({ ok: false, error: 'El carrito está vacío' })

    const esPreInventario = Number(folio) <= FOLIO_CORTE_INVENTARIO

    let flujoNuevo = false
    if (!esPreInventario) {
      try {
        const ocpCountRows = await q('SELECT COUNT(*) AS n FROM orden_consumo_peps WHERE folio_numero = ?', [folio])
        flujoNuevo = Number(ocpCountRows[0]?.n ?? 0) > 0
      } catch (_) { /* tabla aún no existe → camino viejo */ }
    }

    const consumoPendiente = (() => {
      try {
        const cp = orden.consumo_pendiente
        return cp ? (typeof cp === 'string' ? JSON.parse(cp) : cp) : {}
      } catch (_) { return {} }
    })()

    let idGrupo = null
    try {
      const clienteGrupoRows = await q('SELECT id_grupo FROM cliente WHERE id_cliente = ?', [orden.id_cliente])
      idGrupo = clienteGrupoRows[0]?.id_grupo ?? null
    } catch (_) { /* sin grupo */ }

    const idsProductos = [...new Set(todosLosItems.map(i => i.id_producto))]
    const phConv = idsProductos.map(() => '?').join(',')
    const convParams = [...idsProductos]
    if (idGrupo != null) convParams.push(idGrupo)
    const convRows = await q(`
      SELECT id_producto_derivado, id_producto_base, factor, id_grupo
      FROM producto_conversion_peps
      WHERE id_producto_derivado IN (${phConv})
        AND activo = 1
        AND id_producto_derivado != id_producto_base
        AND (id_grupo IS NULL ${idGrupo != null ? 'OR id_grupo = ?' : ''})
      ORDER BY (id_grupo IS NULL) ASC
    `, convParams)

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

    let costoPromMap = {}
    if (!esPreInventario) {
      try {
        costoPromMap = await costosPromedioHistorico(idsProductos)
      } catch (e) {
        console.error(`  ⚠️ costosPromedioHistorico falló (folio ${folio}): ${e.message} — líneas sin lote quedarán SIN_COSTO`)
      }
    }

    // Overselling ya no bloquea — se cubre con lote PHANTOM:VENTA en la rama legacy (Opción A).
    const forzarSinStock = true

    if (flujoNuevo && Object.keys(consumoPendiente).length > 0 && !forzarSinStock) {
      return res.json({ ok: false, error: `Orden ${folio} tiene faltantes de stock pendientes — registra la compra o fuerza el procesamiento` })
    }

    const lotesPorProducto = {}
    const ownConvs = {}
    if (!esPreInventario && !flujoNuevo) {
      const idsParaPeps = [...new Set(idsProductos.flatMap(id => {
        const baseId = convMap[id]?.idBase
        return (baseId && baseId !== id) ? [baseId, id] : [id]
      }))]
      const phProd = idsParaPeps.map(() => '?').join(',')
      const lotesRows = await q(
        `SELECT id_inventario_peps, id_producto, cantidad_restante, costo_unitario, factor_conversion
         FROM inventario_peps
         WHERE id_producto IN (${phProd})
           AND cantidad_restante > 0 AND activo = 1
         ORDER BY fecha_movimiento ASC, id_inventario_peps ASC`,
        idsParaPeps
      )
      for (const lote of lotesRows) {
        const pid = Number(lote.id_producto)
        if (!lotesPorProducto[pid]) lotesPorProducto[pid] = []
        lotesPorProducto[pid].push({
          id: Number(lote.id_inventario_peps),
          restante: parseFloat(String(lote.cantidad_restante)),
          costo: parseFloat(String(lote.costo_unitario)),
          factorConversion: lote.factor_conversion != null ? parseFloat(String(lote.factor_conversion)) : null
        })
      }

      for (const id of idsProductos) {
        const conv = convMap[id]
        if (conv && lotesPorProducto[id]?.length) {
          ownConvs[id] = conv
          delete convMap[id]
        }
      }
    }

    // Calcular asignaciones PEPS en memoria (Fase 1 — se recalcula fresco dentro de la TX)
    const itemsProcessed = []
    const pepsPorItem = []
    const deltaLotes = {}
    const deltaStock = {}
    let costoTotalVenta = 0
    let utilidadTotalVenta = 0

    for (const item of todosLosItems) {
      const fuentes = construirFuentes(item.id_producto, convMap[item.id_producto], ownConvs[item.id_producto])
      const sinDesc = Math.min(Number(item.cantidad_sin_descuento) || 0, item.cantidad)

      deltaStock[fuentes[0].idProd] = deltaStock[fuentes[0].idProd] || 0

      const { pendiente: derivadoPendiente, consumos } = consumirDeFuentes(item.cantidad - sinDesc, fuentes, lotesPorProducto)

      let costoAcumulado = 0
      let utilidadTotal = 0
      for (const c of consumos) {
        const utilidadUnit = item.precio_unitario - c.costoDerivado
        const utilidadLote = Math.round(utilidadUnit * c.derivadoTomado * 100) / 100
        pepsPorItem.push({ loteId: c.loteId, consumir: c.consumir, costo: c.costoLote, precioVenta: item.precio_unitario, utilidadUnit, utilidadLote, itemIdx: itemsProcessed.length })
        deltaLotes[c.loteId] = (deltaLotes[c.loteId] || 0) + c.consumir
        deltaStock[c.idProd] = (deltaStock[c.idProd] || 0) + c.consumir
        costoAcumulado = Math.round((costoAcumulado + c.derivadoTomado * c.costoDerivado) * 100) / 100
        utilidadTotal = Math.round((utilidadTotal + utilidadLote) * 100) / 100
      }

      costoTotalVenta = Math.round((costoTotalVenta + costoAcumulado) * 100) / 100
      utilidadTotalVenta = Math.round((utilidadTotalVenta + utilidadTotal) * 100) / 100
      itemsProcessed.push({ ...item, costoAcumulado, utilidadTotal, cantidadPendiente: derivadoPendiente, fuentes })
    }

    // ── FASE 2: ESCRITURAS EN BULK (transacción corta) ───────────
    const historialActual = Array.isArray(datosCarrito.__historial__) ? datosCarrito.__historial__ : []
    const entradaProcesamiento = {
      tipoEvento: 'procesamiento',
      fecha: new Date().toISOString(),
      adminUsuario: admin_usuario || 'ADMIN',
      usuarioOrden: orden.usuario_creador || '',
    }
    const datosCarritoConHistorial = { ...datosCarrito, __historial__: [...historialActual, entradaProcesamiento] }
    const datosCarritoStr = JSON.stringify(datosCarritoConHistorial)

    const conn = await pool.getConnection()
    let resultadoVenta
    try {
      await conn.beginTransaction()

      // W0. Bloquear la orden para evitar procesamiento concurrente
      const [lockRows] = await conn.execute(`SELECT estado FROM ordenes_guardadas WHERE folio_numero = ? FOR UPDATE`, [folio])
      if (!lockRows?.length || lockRows[0].estado !== 'guardada') {
        throw new Error(`Orden ${folio} ya fue procesada por otro proceso`)
      }

      // W1. Marcar orden como registrada + historial
      const [updateRes] = await conn.execute(
        `UPDATE ordenes_guardadas
         SET estado = 'registrada', datos_carrito = ?, fecha_modificacion = NOW()
         WHERE folio_numero = ? AND estado = 'guardada'`,
        [datosCarritoStr, folio]
      )
      if (updateRes.affectedRows === 0) {
        throw new Error(`Orden ${folio} ya fue procesada por otro proceso`)
      }

      // W1a. Consumir reservas de inventario
      await consumirReservas(conn, folio)

      // W1b. Bloquear lotes PEPS dentro de TX y recalcular PEPS con datos frescos
      if (!esPreInventario && Object.keys(deltaLotes).length > 0) {
        const loteIdsCheck = Object.keys(deltaLotes).map(Number)
        const phLotes = loteIdsCheck.map(() => '?').join(',')
        const [lotesActuales] = await conn.execute(
          `SELECT id_inventario_peps, id_producto, cantidad_restante, costo_unitario, factor_conversion
           FROM inventario_peps
           WHERE id_inventario_peps IN (${phLotes}) FOR UPDATE`,
          loteIdsCheck
        )

        const lotesBloqueados = {}
        for (const lote of lotesActuales) {
          const pid = Number(lote.id_producto)
          if (!lotesBloqueados[pid]) lotesBloqueados[pid] = []
          lotesBloqueados[pid].push({
            id: Number(lote.id_inventario_peps),
            restante: parseFloat(String(lote.cantidad_restante)),
            costo: parseFloat(String(lote.costo_unitario)),
            factorConversion: lote.factor_conversion != null ? parseFloat(String(lote.factor_conversion)) : null
          })
        }
        for (const pid in lotesBloqueados) lotesBloqueados[pid].sort((a, b) => a.id - b.id)

        pepsPorItem.length = 0
        for (const k of Object.keys(deltaLotes)) delete deltaLotes[Number(k)]
        for (const k of Object.keys(deltaStock)) delete deltaStock[Number(k)]
        costoTotalVenta = 0
        utilidadTotalVenta = 0

        for (const item of itemsProcessed) {
          const fuentes = item.fuentes
          const itemIdx = itemsProcessed.indexOf(item)
          const sinDescTx = Math.min(Number(item.cantidad_sin_descuento) || 0, item.cantidad)

          deltaStock[fuentes[0].idProd] = deltaStock[fuentes[0].idProd] || 0

          const { pendiente: derivadoPendiente, consumos } = consumirDeFuentes(item.cantidad - sinDescTx, fuentes, lotesBloqueados)

          let costoAcumulado = 0
          let utilidadTotal = 0
          for (const c of consumos) {
            const utilidadUnit = item.precio_unitario - c.costoDerivado
            const utilidadLote = Math.round(utilidadUnit * c.derivadoTomado * 100) / 100
            pepsPorItem.push({ loteId: c.loteId, consumir: c.consumir, costo: c.costoLote, precioVenta: item.precio_unitario, utilidadUnit, utilidadLote, itemIdx })
            deltaLotes[c.loteId] = (deltaLotes[c.loteId] || 0) + c.consumir
            deltaStock[c.idProd] = (deltaStock[c.idProd] || 0) + c.consumir
            costoAcumulado = Math.round((costoAcumulado + c.derivadoTomado * c.costoDerivado) * 100) / 100
            utilidadTotal = Math.round((utilidadTotal + utilidadLote) * 100) / 100
          }

          costoTotalVenta = Math.round((costoTotalVenta + costoAcumulado) * 100) / 100
          utilidadTotalVenta = Math.round((utilidadTotalVenta + utilidadTotal) * 100) / 100
          item.costoAcumulado = costoAcumulado
          item.utilidadTotal = utilidadTotal
          item.cantidadPendiente = derivadoPendiente

          if (derivadoPendiente > 0 && !forzarSinStock) {
            throw new Error(`Lote de producto ${item.id_producto} fue consumido por otra venta concurrente`)
          }
        }
      }

      // W2. Crear factura
      const fechaFactura = orden.fecha_creacion || new Date().toISOString().slice(0, 19).replace('T', ' ')
      const [facturaRes] = await conn.execute(
        'INSERT INTO factura (fecha_factura, id_cliente, folio_numero) VALUES (?, ?, ?)',
        [fechaFactura, orden.id_cliente, folio]
      )
      const idFactura = facturaRes.insertId

      // W3. Insertar detalles de factura (bulk)
      const dfPlaceholders = itemsProcessed.map(() => '(?,?,?,?)').join(',')
      const dfParams = itemsProcessed.flatMap(item => [idFactura, item.id_producto, item.cantidad, item.precio_unitario])
      const [dfBulk] = await conn.execute(
        `INSERT INTO detalle_factura (id_factura, id_producto, cantidad_factura, precio_unitario_venta)
         VALUES ${dfPlaceholders}`,
        dfParams
      )
      const firstDetalleId = Number(dfBulk.insertId)
      const idsDetalles = itemsProcessed.map((_, i) => firstDetalleId + i)

      const coveredDerivada = {}

      if (esPreInventario) {
        // ── PRE-INVENTARIO (folio ≤ 337): crear lotes fantasma en vez de consumir reales ──
        const [provRows] = await conn.execute(
          "SELECT id_proveedor FROM proveedor WHERE nombre_proveedor = 'BOOTSTRAP-INVENTARIO' LIMIT 1"
        )
        const phantomProvId = provRows.length > 0 ? provRows[0].id_proveedor : null

        const phantomItems = itemsProcessed.map(item => {
          const conv = convMap[item.id_producto]
          const idPepsProducto = conv ? conv.idBase : item.id_producto
          const cantidadBase = conv ? item.cantidad * conv.factor : item.cantidad
          return { idPepsProducto, cantidadBase, precio_unitario: item.precio_unitario }
        })

        const compraPlaceholders = phantomItems.map(() => '(?, ?, ?, 0.01, \'2020-06-01\', ?, ?, 0, 0, ?, \'SISTEMA\', \'PHANTOM:GUARDADAS\', 0, 0, NULL, NULL, 0)').join(',')
        const compraParams = phantomItems.flatMap(pi => [
          pi.idPepsProducto, phantomProvId, pi.cantidadBase, `PHANTOM-F${folio}`,
          pi.cantidadBase * 0.01, pi.cantidadBase * 0.01
        ])
        const [comprasBulk] = await conn.execute(
          `INSERT INTO compra (
            id_producto, id_proveedor, cantidad_compra, precio_unitario_compra,
            fecha_compra, folio_factura, subtotal, iva, incluye_iva, total_con_impuestos,
            usuario_registro, notas, tasa_interes,
            importe_ieps, metodo_pago, forma_pago, peso_por_pieza
          ) VALUES ${compraPlaceholders}`,
          compraParams
        )
        const firstCompraId = Number(comprasBulk.insertId)

        const pepsPlaceholders = phantomItems.map(() => '(?, ?, \'2020-06-01\', ?, 0, 0.01, 1)').join(',')
        const pepsParams = phantomItems.flatMap((pi, i) => [pi.idPepsProducto, firstCompraId + i, pi.cantidadBase])
        const [pepsBulk] = await conn.execute(
          `INSERT INTO inventario_peps (
            id_producto, id_compra, fecha_movimiento,
            cantidad_inicial, cantidad_restante, costo_unitario, activo
          ) VALUES ${pepsPlaceholders}`,
          pepsParams
        )
        const firstPepsId = Number(pepsBulk.insertId)

        const dvlPlaceholders = phantomItems.map(() => '(?,?,?,0.01,?,?,?)').join(',')
        const dvlParams = phantomItems.flatMap((pi, i) => [
          idsDetalles[i], firstPepsId + i, pi.cantidadBase, pi.precio_unitario,
          pi.precio_unitario - 0.01,
          Math.round((pi.precio_unitario - 0.01) * pi.cantidadBase * 100) / 100
        ])
        await conn.execute(
          `INSERT INTO detalle_venta_lote
             (id_detalle_factura, id_inventario_peps, cantidad_consumida, costo_unitario,
              precio_venta_unitario, utilidad_unitaria, utilidad_total)
           VALUES ${dvlPlaceholders}`,
          dvlParams
        )
      } else if (flujoNuevo) {
        // ── FLUJO NUEVO: el inventario ya se descontó al guardar la orden ──
        const [ocpRows] = await conn.execute(
          `SELECT id_producto, id_inventario_peps, cantidad_consumida, cantidad_derivada, costo_unitario, item_idx
           FROM orden_consumo_peps WHERE folio_numero = ? ORDER BY id_consumo`,
          [folio]
        )
        if (ocpRows.length > 0) {
          const derivadaPorProducto = {}
          for (const r of ocpRows) {
            const pid = Number(r.id_producto)
            derivadaPorProducto[pid] = (derivadaPorProducto[pid] || 0) + parseFloat(String(r.cantidad_derivada))
          }
          const carritoDescontable = {}
          for (const item of itemsProcessed) {
            const pid = Number(item.id_producto)
            const sinDesc = Math.min(Number(item.cantidad_sin_descuento) || 0, item.cantidad)
            carritoDescontable[pid] = (carritoDescontable[pid] || 0) + (item.cantidad - sinDesc)
          }
          for (const [pid, derivada] of Object.entries(derivadaPorProducto)) {
            if (derivada > (carritoDescontable[Number(pid)] || 0) + 0.01) {
              throw new Error(
                `El consumo de inventario del folio ${folio} no coincide con el carrito actual ` +
                `(producto ${pid}: consumido ${derivada}, en carrito ${carritoDescontable[Number(pid)] || 0}). ` +
                `Edita y guarda la orden de nuevo antes de procesarla.`
              )
            }
          }

          const dvlParams = []
          for (const r of ocpRows) {
            let itemIdx = Number(r.item_idx)
            const ocpProducto = Number(r.id_producto)
            const derivada = parseFloat(String(r.cantidad_derivada))
            if (!itemsProcessed[itemIdx] || Number(itemsProcessed[itemIdx].id_producto) !== ocpProducto) {
              let mejor = -1
              let mejorConCapacidad = -1
              for (let i = 0; i < itemsProcessed.length; i++) {
                if (Number(itemsProcessed[i].id_producto) !== ocpProducto) continue
                const capacidad = Number(itemsProcessed[i].cantidad) - (coveredDerivada[i] || 0)
                if (capacidad >= derivada - 0.001 &&
                    (mejorConCapacidad === -1 || (coveredDerivada[i] || 0) < (coveredDerivada[mejorConCapacidad] || 0))) {
                  mejorConCapacidad = i
                }
                if (mejor === -1 || (coveredDerivada[i] || 0) < (coveredDerivada[mejor] || 0)) mejor = i
              }
              if (mejorConCapacidad !== -1) mejor = mejorConCapacidad
              if (mejor === -1) throw new Error(`Consumo PEPS del folio ${folio} no coincide con el carrito (producto ${ocpProducto}) — edita y guarda la orden de nuevo`)
              itemIdx = mejor
            }
            const item = itemsProcessed[itemIdx]
            const consumida = parseFloat(String(r.cantidad_consumida))
            const costoLote = parseFloat(String(r.costo_unitario))
            const costoDerivado = derivada > 0 ? (costoLote * consumida) / derivada : costoLote
            const utilidadUnit = item.precio_unitario - costoDerivado
            const utilidadLote = Math.round(utilidadUnit * derivada * 100) / 100

            dvlParams.push(idsDetalles[itemIdx], r.id_inventario_peps, consumida, costoLote, item.precio_unitario, utilidadUnit, utilidadLote)
            coveredDerivada[itemIdx] = (coveredDerivada[itemIdx] || 0) + derivada
            costoTotalVenta = Math.round((costoTotalVenta + costoLote * consumida) * 100) / 100
            utilidadTotalVenta = Math.round((utilidadTotalVenta + utilidadLote) * 100) / 100
          }
          const dvlPh = ocpRows.map(() => '(?,?,?,?,?,?,?)').join(',')
          await conn.execute(
            `INSERT INTO detalle_venta_lote
               (id_detalle_factura, id_inventario_peps, cantidad_consumida, costo_unitario,
                precio_venta_unitario, utilidad_unitaria, utilidad_total)
             VALUES ${dvlPh}`,
            dvlParams
          )
        }
      } else {
        // ── POST-INVENTARIO (folio ≥ 338): consumo PEPS normal ──

        // W4. Bulk INSERT detalle_venta_lote (lotes reales)
        if (pepsPorItem.length > 0) {
          const pepPlaceholders = pepsPorItem.map(() => '(?,?,?,?,?,?,?)').join(',')
          const pepParams = pepsPorItem.flatMap(p => [idsDetalles[p.itemIdx], p.loteId, p.consumir, p.costo, p.precioVenta, p.utilidadUnit, p.utilidadLote])
          await conn.execute(
            `INSERT INTO detalle_venta_lote
               (id_detalle_factura, id_inventario_peps, cantidad_consumida, costo_unitario,
                precio_venta_unitario, utilidad_unitaria, utilidad_total)
             VALUES ${pepPlaceholders}`,
            pepParams
          )
        }

        // W5. UPDATE inventario_peps (bulk CASE WHEN)
        const loteEntries = Object.entries(deltaLotes)
        if (loteEntries.length > 0) {
          const loteIds = loteEntries.map(([id]) => {
            const n = Number(id)
            if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) throw new Error(`ID de lote inválido: ${id}`)
            return n
          })
          const loteRestars = loteEntries.map(([, restar]) => {
            const n = Number(restar)
            if (!Number.isFinite(n) || n < 0) throw new Error(`Cantidad a restar inválida: ${restar}`)
            return n
          })
          const caseCantidad = loteIds.map(() => 'WHEN ? THEN GREATEST(0, cantidad_restante - ?)').join(' ')
          const caseActivo = loteIds.map(() => 'WHEN id_inventario_peps = ? AND cantidad_restante - ? <= 0 THEN 0').join(' ')
          const phLoteIds = loteIds.map(() => '?').join(',')
          await conn.execute(
            `UPDATE inventario_peps
             SET cantidad_restante = CASE id_inventario_peps ${caseCantidad} ELSE cantidad_restante END,
                 activo = CASE ${caseActivo} ELSE activo END
             WHERE id_inventario_peps IN (${phLoteIds})`,
            [
              ...loteIds.flatMap((id, i) => [id, loteRestars[i]]),
              ...loteIds.flatMap((id, i) => [id, loteRestars[i]]),
              ...loteIds,
            ]
          )
        }

        // W6. UPDATE producto.stock — bulk reconcile from PEPS lotes
        const stockEntries = Object.entries(deltaStock)
        if (stockEntries.length > 0) {
          const stockIds = stockEntries.map(([id]) => {
            const n = Number(id)
            if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) throw new Error(`ID de producto inválido: ${id}`)
            return n
          })
          const stockRestars = stockEntries.map(([, restar]) => {
            const n = Number(restar)
            if (!Number.isFinite(n)) throw new Error(`Delta de stock inválido: ${restar}`)
            return n
          })
          const caseStock = stockIds.map(() => 'WHEN ? THEN ?').join(' ')
          const phStockIds = stockIds.map(() => '?').join(',')
          await conn.execute(
            `UPDATE producto p
             SET stock = CASE
               WHEN EXISTS (SELECT 1 FROM inventario_peps ip WHERE ip.id_producto = p.id_producto)
               THEN (SELECT COALESCE(SUM(ip2.cantidad_restante), 0) FROM inventario_peps ip2 WHERE ip2.id_producto = p.id_producto AND ip2.activo = 1)
               ELSE stock - CASE p.id_producto ${caseStock} ELSE 0 END
             END
             WHERE p.id_producto IN (${phStockIds})`,
            [
              ...stockIds.flatMap((id, i) => [id, stockRestars[i]]),
              ...stockIds,
            ]
          )
        }

        // W6-phantom. Opción A: cubrir cualquier faltante (derivadoPendiente > 0)
        // con una compra/lote PHANTOM:VENTA — entradas.js ya sabe reconciliarlo
        // cuando llegue la próxima compra real de ese producto.
        const itemsConFaltante = itemsProcessed
          .map((item, i) => ({ item, idx: i }))
          .filter(({ item }) => Number(item.cantidadPendiente) > 0.000001)

        if (itemsConFaltante.length > 0) {
          const [provRows] = await conn.execute(
            "SELECT id_proveedor FROM proveedor WHERE nombre_proveedor = 'BOOTSTRAP-INVENTARIO' LIMIT 1"
          )
          const phantomProvId = provRows.length > 0 ? provRows[0].id_proveedor : null

          const phantomFaltantes = itemsConFaltante.map(({ item }) => {
            const ultimaFuente = item.fuentes[item.fuentes.length - 1]
            const idPepsProducto = ultimaFuente.idProd
            const factorAPeps = ultimaFuente.esConv ? ultimaFuente.factor : 1
            const cantidadBase = item.cantidadPendiente * factorAPeps
            return { idPepsProducto, cantidadBase, precio_unitario: item.precio_unitario }
          })

          const compraPhPlaceholders = phantomFaltantes.map(() => '(?, ?, ?, 0.01, NOW(), ?, ?, 0, 0, ?, \'SISTEMA\', \'PHANTOM:VENTA\', 0, 0, NULL, NULL, 0)').join(',')
          const compraPhParams = phantomFaltantes.flatMap(pf => [
            pf.idPepsProducto, phantomProvId, pf.cantidadBase, `PHANTOM-VENTA-F${folio}`,
            pf.cantidadBase * 0.01, pf.cantidadBase * 0.01
          ])
          const [comprasPhBulk] = await conn.execute(
            `INSERT INTO compra (
              id_producto, id_proveedor, cantidad_compra, precio_unitario_compra,
              fecha_compra, folio_factura, subtotal, iva, incluye_iva, total_con_impuestos,
              usuario_registro, notas, tasa_interes,
              importe_ieps, metodo_pago, forma_pago, peso_por_pieza
            ) VALUES ${compraPhPlaceholders}`,
            compraPhParams
          )
          const firstCompraPhId = Number(comprasPhBulk.insertId)

          const pepsPhPlaceholders = phantomFaltantes.map(() => '(?, ?, NOW(), ?, 0, 0.01, 1)').join(',')
          const pepsPhParams = phantomFaltantes.flatMap((pf, i) => [pf.idPepsProducto, firstCompraPhId + i, pf.cantidadBase])
          const [pepsPhBulk] = await conn.execute(
            `INSERT INTO inventario_peps (
              id_producto, id_compra, fecha_movimiento,
              cantidad_inicial, cantidad_restante, costo_unitario, activo
            ) VALUES ${pepsPhPlaceholders}`,
            pepsPhParams
          )
          const firstPepsPhId = Number(pepsPhBulk.insertId)

          const dvlPhPlaceholders = phantomFaltantes.map(() => '(?,?,?,0.01,?,?,?)').join(',')
          const dvlPhParams = phantomFaltantes.flatMap((pf, i) => [
            idsDetalles[itemsConFaltante[i].idx], firstPepsPhId + i, pf.cantidadBase, pf.precio_unitario,
            pf.precio_unitario - 0.01,
            Math.round((pf.precio_unitario - 0.01) * pf.cantidadBase * 100) / 100
          ])
          await conn.execute(
            `INSERT INTO detalle_venta_lote
               (id_detalle_factura, id_inventario_peps, cantidad_consumida, costo_unitario,
                precio_venta_unitario, utilidad_unitaria, utilidad_total)
             VALUES ${dvlPhPlaceholders}`,
            dvlPhParams
          )

          // Costo/utilidad de la porción fantasma se suma al total de la venta
          // (mismo nominal $0.01 que el resto de fantasmas del sistema — se
          // corrige solo cuando entradas.js reconcilie con inventario real).
          for (const { item } of itemsConFaltante) {
            costoTotalVenta = Math.round((costoTotalVenta + item.cantidadPendiente * 0.01) * 100) / 100
            utilidadTotalVenta = Math.round((utilidadTotalVenta + item.cantidadPendiente * (item.precio_unitario - 0.01)) * 100) / 100
          }

          // Ya cubierto por el lote fantasma — W6a-bis no debe volver a
          // congelar esta porción como costo_no_peps/SIN_STOCK.
          for (const { item } of itemsConFaltante) item.cantidadPendiente = 0
        }
      }

      // W6a-bis. Congelar el costo de la porción NO cubierta con lotes reales
      if (!esPreInventario) {
        const EPS = 0.001
        const setSinDesc = []
        const setCosto = []
        const setOrigen = []
        const idsUpdate = []

        itemsProcessed.forEach((item, i) => {
          const sinDesc = Math.min(Number(item.cantidad_sin_descuento) || 0, item.cantidad)
          const descontable = item.cantidad - sinDesc
          const sinCubrir = flujoNuevo
            ? Math.max(0, descontable - (coveredDerivada[i] || 0))
            : Math.max(0, Number(item.cantidadPendiente) || 0)

          if (sinDesc <= EPS && sinCubrir <= EPS) return

          const costoProm = costoPromMap[item.id_producto]
          let costoNoPeps
          let origen
          if (sinCubrir > EPS) {
            if (costoProm != null) {
              costoNoPeps = Math.round(sinCubrir * costoProm * 100) / 100
              origen = sinDesc > EPS ? 'MIXTO' : 'SIN_STOCK'
            } else {
              costoNoPeps = null
              origen = 'SIN_COSTO'
            }
          } else {
            costoNoPeps = null
            origen = 'SIN_DESCUENTO'
          }

          const idDetalle = idsDetalles[i]
          idsUpdate.push(idDetalle)
          setSinDesc.push(`WHEN ${idDetalle} THEN ${Math.round(sinDesc * 100) / 100}`)
          setCosto.push(`WHEN ${idDetalle} THEN ${costoNoPeps === null ? 'NULL' : costoNoPeps}`)
          setOrigen.push(`WHEN ${idDetalle} THEN '${origen}'`)
        })

        if (idsUpdate.length > 0) {
          const phU = idsUpdate.map(() => '?').join(',')
          await conn.execute(
            `UPDATE detalle_factura SET
               cantidad_sin_descuento = CASE id_detalle ${setSinDesc.join(' ')} ELSE cantidad_sin_descuento END,
               costo_no_peps          = CASE id_detalle ${setCosto.join(' ')} ELSE costo_no_peps END,
               origen_costo           = CASE id_detalle ${setOrigen.join(' ')} ELSE origen_costo END
             WHERE id_detalle IN (${phU})`,
            idsUpdate
          )
        }
      }

      // W7. Crear deuda si aplica (con auto-aplicación de saldo a favor)
      const montoPagadoInicial = monto_pagado || 0
      let montoPendiente = parseFloat(String(orden.total_estimado)) - montoPagadoInicial
      let creditoAplicado = 0
      const aplicacionesCredito = []

      if (montoPendiente > 0) {
        const [creditosActivos] = await conn.execute(
          `SELECT id_credito, monto_total, monto_usado,
                  (monto_total - monto_usado) as disponible
           FROM credito_cliente
           WHERE id_cliente = ? AND estado IN ('ACTIVO','PARCIALMENTE_USADO')
           ORDER BY fecha_creacion ASC
           FOR UPDATE`,
          [orden.id_cliente]
        )

        for (const credito of creditosActivos) {
          if (montoPendiente <= 0) break
          const disponible = parseFloat(credito.disponible)
          if (disponible <= 0) continue

          const aplicar = Math.min(disponible, montoPendiente)
          const nuevoUsado = parseFloat(credito.monto_usado) + aplicar
          const nuevoEstado = nuevoUsado >= parseFloat(credito.monto_total) ? 'AGOTADO' : 'PARCIALMENTE_USADO'

          await conn.execute(
            'UPDATE credito_cliente SET monto_usado = ?, estado = ? WHERE id_credito = ?',
            [+nuevoUsado.toFixed(2), nuevoEstado, credito.id_credito]
          )

          creditoAplicado += aplicar
          montoPendiente -= aplicar
          aplicacionesCredito.push({ id_credito: credito.id_credito, monto: +aplicar.toFixed(2) })
        }

        const [clienteRows] = await conn.execute(
          `SELECT c.nombre_cliente, g.nombre_grupo FROM cliente c INNER JOIN grupo g ON c.id_grupo = g.id_grupo WHERE c.id_cliente = ?`,
          [orden.id_cliente]
        )
        const cliente = clienteRows[0] || {}
        const montoPagadoTotal = +(montoPagadoInicial + creditoAplicado).toFixed(2)
        const deudaPagada = montoPendiente <= 0
        const observacionDeuda = (datosCarrito.__observacion__ ?? '').toString().trim() || null

        const fechaDeuda = orden.fecha_creacion || new Date().toISOString().slice(0, 19).replace('T', ' ')
        const [deudaResult] = await conn.execute(
          `INSERT INTO deudas (id_cliente, id_factura, nombre_cliente, nombre_grupo, monto_total, monto_pagado, pagado, fecha_generada, descripcion${deudaPagada ? ', fecha_pago' : ''})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?${deudaPagada ? ', NOW()' : ''})`,
          [orden.id_cliente, String(folio), cliente.nombre_cliente || 'Cliente desconocido', cliente.nombre_grupo || 'Sin grupo', orden.total_estimado, montoPagadoTotal, deudaPagada ? 1 : 0, fechaDeuda, observacionDeuda]
        )

        const idDeuda = deudaResult.insertId
        for (const ap of aplicacionesCredito) {
          await conn.execute(
            `INSERT INTO aplicacion_credito (id_credito, id_deuda, monto_aplicado, fecha_aplicacion, usuario, notas)
             VALUES (?, ?, ?, NOW(), ?, ?)`,
            [ap.id_credito, idDeuda, ap.monto, admin_usuario || 'sistema', `Auto-aplicado en orden ${folio}`]
          )
        }
      }

      const totalNum = parseFloat(String(orden.total_estimado)) || 0

      resultadoVenta = {
        folio_numero: folio,
        id_factura: idFactura,
        monto_pendiente: Math.max(montoPendiente, 0),
        credito_aplicado: creditoAplicado > 0 ? creditoAplicado : undefined,
        costo_real: costoTotalVenta,
        utilidad_real: utilidadTotalVenta,
        margen_porcentaje: totalNum > 0 ? (utilidadTotalVenta / totalNum) * 100 : 0
      }

      await conn.commit()
    } catch (e) {
      await conn.rollback()
      throw e
    } finally {
      conn.release()
    }

    res.json({ ok: true, data: resultadoVenta })
  } catch (e) {
    console.error('[ordenes] procesarVenta:', e.message)
    res.status(500).json({ ok: false, error: e.message || 'Error al procesar la venta' })
  }
})

// ═══════════════════════════════════════════════════════════════
// REVERTIR PROCESAMIENTO (H-5 Fase 4 — revertirProcesamiento)
// ═══════════════════════════════════════════════════════════════

router.post('/revertir-procesamiento/:folio', async (req, res) => {
  const folio = req.params.folio
  const { admin_usuario, admin_password } = req.body

  const auth = await verificarAdminPassword(req, admin_usuario, admin_password)
  if (!auth.ok) return res.status(401).json({ ok: false, error: auth.error })

  try {
    const ordenRows = await q(`SELECT datos_carrito, estado, id_cliente FROM ordenes_guardadas WHERE folio_numero = ? AND activo = 1`, [folio])
    if (ordenRows.length === 0) return res.json({ ok: false, error: `Orden ${folio} no encontrada` })
    const ordenData = ordenRows[0]
    if (ordenData.estado !== 'registrada') return res.json({ ok: false, error: `Orden ${folio} no está procesada` })

    const carrito = typeof ordenData.datos_carrito === 'string' ? JSON.parse(ordenData.datos_carrito) : (ordenData.datos_carrito || {})
    const historialActual = Array.isArray(carrito.__historial__) ? carrito.__historial__ : []
    const entradaReversion = { tipoEvento: 'reversion', fecha: new Date().toISOString(), adminUsuario: admin_usuario }
    const carritoConHistorial = { ...carrito, __historial__: [...historialActual, entradaReversion] }

    const esPreInventarioRevert = Number(folio) <= FOLIO_CORTE_INVENTARIO

    // Opción A: si la venta dejó un lote PHANTOM:VENTA sin reconciliar, se
    // borra junto con su compra (mismo patrón que la rama pre-inventario).
    // Si ya fue parcialmente reconciliado por una compra real (REC > 0), se
    // bloquea la reversión — evita corromper una reconciliación que ya
    // ocurrió. Edge case infrecuente (vender de más y revertir después de
    // que ya llegó inventario real).
    const [phantomVentaRows] = await pool.execute(
      `SELECT id_compra, notas FROM compra WHERE notas LIKE 'PHANTOM:VENTA%' AND folio_factura = ?`,
      [`PHANTOM-VENTA-F${folio}`]
    )
    for (const ph of phantomVentaRows) {
      const mRec = (ph.notas || '').match(/\|REC:([\d.]+)/)
      const yaReconciliado = mRec ? parseFloat(mRec[1]) : 0
      if (yaReconciliado > 0) {
        return res.json({
          ok: false,
          error: `La venta ${folio} generó un lote de inventario pendiente (PHANTOM:VENTA) que ya fue parcialmente reconciliado con una compra real. No se puede revertir automáticamente — contacta a un administrador para resolverlo a mano.`
        })
      }
    }

    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()

      // R1. Encontrar la factura asociada
      const [facturaRows] = await conn.execute(`SELECT id_factura FROM factura WHERE folio_numero = ?`, [folio])
      const idFactura = facturaRows[0]?.id_factura ?? null

      if (idFactura !== null) {
        const [detalles] = await conn.execute(`SELECT id_detalle, id_producto, cantidad_factura FROM detalle_factura WHERE id_factura = ?`, [idFactura])
        const idDetalles = detalles.map(d => d.id_detalle)

        if (esPreInventarioRevert) {
          if (idDetalles.length > 0) {
            const phD = idDetalles.map(() => '?').join(',')
            const [lotes] = await conn.execute(
              `SELECT dvl.id_inventario_peps, ip.id_compra
               FROM detalle_venta_lote dvl
               INNER JOIN inventario_peps ip ON dvl.id_inventario_peps = ip.id_inventario_peps
               WHERE dvl.id_detalle_factura IN (${phD})`,
              idDetalles
            )
            await conn.execute(`DELETE FROM detalle_venta_lote WHERE id_detalle_factura IN (${phD})`, idDetalles)
            if (lotes.length > 0) {
              const phantomLoteIds = lotes.map(l => l.id_inventario_peps)
              const phantomCompraIds = [...new Set(lotes.map(l => l.id_compra))]
              await conn.execute(`DELETE FROM inventario_peps WHERE id_inventario_peps IN (${phantomLoteIds.map(() => '?').join(',')})`, phantomLoteIds)
              await conn.execute(`DELETE FROM compra WHERE id_compra IN (${phantomCompraIds.map(() => '?').join(',')})`, phantomCompraIds)
            }
          }
        } else if (await tieneConsumoOrden(conn, folio)) {
          // ── FLUJO NUEVO: la traza en orden_consumo_peps sigue siendo dueña del consumo ──
          if (idDetalles.length > 0) {
            const phD = idDetalles.map(() => '?').join(',')
            await conn.execute(`DELETE FROM detalle_venta_lote WHERE id_detalle_factura IN (${phD})`, idDetalles)
          }
        } else {
          // ── POST-INVENTARIO legacy: restaurar PEPS y stock normalmente ──
          if (idDetalles.length > 0) {
            const phD = idDetalles.map(() => '?').join(',')
            const [lotes] = await conn.execute(
              `SELECT dvl.id_detalle_factura, dvl.id_inventario_peps,
                      ip.id_producto AS id_producto_peps,
                      SUM(dvl.cantidad_consumida) AS total
               FROM detalle_venta_lote dvl
               INNER JOIN inventario_peps ip ON dvl.id_inventario_peps = ip.id_inventario_peps
               WHERE dvl.id_detalle_factura IN (${phD})
               GROUP BY dvl.id_detalle_factura, dvl.id_inventario_peps, ip.id_producto`,
              idDetalles
            )

            // Los lotes PHANTOM:VENTA generados por Opción A se borran (no se restauran
            // como si fueran reales) — mismo criterio que la rama pre-inventario.
            const [phantomLoteRows] = await conn.execute(
              `SELECT dvl.id_inventario_peps, ip.id_compra
               FROM detalle_venta_lote dvl
               INNER JOIN inventario_peps ip ON dvl.id_inventario_peps = ip.id_inventario_peps
               INNER JOIN compra c ON c.id_compra = ip.id_compra
               WHERE dvl.id_detalle_factura IN (${phD}) AND c.notas LIKE 'PHANTOM:VENTA%'`,
              idDetalles
            )
            const phantomLoteIdsSet = new Set(phantomLoteRows.map(r => Number(r.id_inventario_peps)))

            if (lotes.length > 0) {
              const lotesReales = lotes.filter(l => !phantomLoteIdsSet.has(Number(l.id_inventario_peps)))
              if (lotesReales.length > 0) {
                const caseRestore = lotesReales.map(l => `WHEN ${Number(l.id_inventario_peps)} THEN cantidad_restante + ${parseFloat(String(l.total))}`).join(' ')
                const caseActivo = lotesReales.map(l => `WHEN ${Number(l.id_inventario_peps)} THEN CASE WHEN cantidad_restante + ${parseFloat(String(l.total))} > 0 THEN 1 ELSE activo END`).join(' ')
                const restoreIds = lotesReales.map(l => Number(l.id_inventario_peps))
                await conn.execute(
                  `UPDATE inventario_peps
                   SET cantidad_restante = CASE id_inventario_peps ${caseRestore} ELSE cantidad_restante END,
                       activo = CASE id_inventario_peps ${caseActivo} ELSE activo END
                   WHERE id_inventario_peps IN (${restoreIds.map(() => '?').join(',')})`,
                  restoreIds
                )
              }

              if (phantomLoteRows.length > 0) {
                const phantomLoteIds = phantomLoteRows.map(r => r.id_inventario_peps)
                const phantomCompraIds = [...new Set(phantomLoteRows.map(r => r.id_compra))]
                await conn.execute(`DELETE FROM inventario_peps WHERE id_inventario_peps IN (${phantomLoteIds.map(() => '?').join(',')})`, phantomLoteIds)
                await conn.execute(`DELETE FROM compra WHERE id_compra IN (${phantomCompraIds.map(() => '?').join(',')})`, phantomCompraIds)
              }

              await conn.execute(`DELETE FROM detalle_venta_lote WHERE id_detalle_factura IN (${phD})`, idDetalles)

              const stockDelta = {}
              const detallesCubiertos = new Set()
              for (const lote of lotes) {
                const pid = Number(lote.id_producto_peps)
                stockDelta[pid] = (stockDelta[pid] || 0) + parseFloat(String(lote.total))
                detallesCubiertos.add(Number(lote.id_detalle_factura))
              }
              const allRestoreIds = new Set()
              for (const pid of Object.keys(stockDelta)) allRestoreIds.add(Number(pid))
              const fallbackItems = []
              for (const d of detalles) {
                if (!detallesCubiertos.has(d.id_detalle)) {
                  allRestoreIds.add(Number(d.id_producto))
                  fallbackItems.push({ pid: Number(d.id_producto), cantidad: parseFloat(d.cantidad_factura) })
                }
              }
              if (allRestoreIds.size > 0) {
                const restoreProductIds = [...allRestoreIds]
                const caseFallback = fallbackItems.length > 0 ? fallbackItems.map(f => `WHEN ${f.pid} THEN ${f.cantidad}`).join(' ') : ''
                const phRestore = restoreProductIds.map(() => '?').join(',')
                await conn.execute(
                  `UPDATE producto p
                   SET stock = CASE
                     WHEN EXISTS (SELECT 1 FROM inventario_peps ip WHERE ip.id_producto = p.id_producto AND ip.activo = 1)
                     THEN (SELECT COALESCE(SUM(ip2.cantidad_restante), 0) FROM inventario_peps ip2 WHERE ip2.id_producto = p.id_producto AND ip2.activo = 1)
                     ELSE stock + CASE p.id_producto ${caseFallback || 'WHEN 0 THEN 0'} ELSE 0 END
                   END
                   WHERE p.id_producto IN (${phRestore})`,
                  restoreProductIds
                )
              }
            } else if (detalles.length > 0) {
              const caseCant = detalles.map(d => `WHEN ${Number(d.id_producto)} THEN stock + ${parseFloat(d.cantidad_factura)}`).join(' ')
              const detProdIds = detalles.map(d => Number(d.id_producto))
              await conn.execute(
                `UPDATE producto SET stock = CASE id_producto ${caseCant} ELSE stock END
                 WHERE id_producto IN (${detProdIds.map(() => '?').join(',')})`,
                detProdIds
              )
            }
          }
        }

        // R6. Eliminar detalle_factura y factura
        await conn.execute(`DELETE FROM detalle_factura WHERE id_factura = ?`, [idFactura])
        await conn.execute(`DELETE FROM factura WHERE id_factura = ?`, [idFactura])
      }

      // R7. Revertir créditos aplicados y eliminar deuda
      const [deudaRows] = await conn.execute(`SELECT id_deuda FROM deudas WHERE id_factura = ?`, [String(folio)])
      if (deudaRows.length > 0) {
        const idDeuda = deudaRows[0].id_deuda
        const [aplicaciones] = await conn.execute(`SELECT id_credito, monto_aplicado FROM aplicacion_credito WHERE id_deuda = ?`, [idDeuda])
        if (aplicaciones.length > 0) {
          for (const ap of aplicaciones) {
            await conn.execute(
              `UPDATE credito_cliente
               SET monto_usado = GREATEST(0, monto_usado - ?),
                   estado = CASE
                     WHEN GREATEST(0, monto_usado - ?) <= 0 THEN 'ACTIVO'
                     WHEN GREATEST(0, monto_usado - ?) < monto_total THEN 'PARCIALMENTE_USADO'
                     ELSE estado
                   END
               WHERE id_credito = ?`,
              [ap.monto_aplicado, ap.monto_aplicado, ap.monto_aplicado, ap.id_credito]
            )
          }
          await conn.execute(`DELETE FROM aplicacion_credito WHERE id_deuda = ?`, [idDeuda])
        }
        await conn.execute(`DELETE FROM deudas WHERE id_deuda = ?`, [idDeuda])
      }

      // R8. Revertir orden a guardada + actualizar historial
      await conn.execute(
        `UPDATE ordenes_guardadas
         SET estado = 'guardada', datos_carrito = ?, fecha_modificacion = NOW()
         WHERE folio_numero = ?`,
        [JSON.stringify(carritoConHistorial), folio]
      )

      // R9. Traer la orden al flujo nuevo si era legacy
      if (!esPreInventarioRevert && !(await tieneConsumoOrden(conn, folio))) {
        const idGrupoRevert = ordenData.id_cliente ? await obtenerIdGrupoCliente(conn, ordenData.id_cliente) : null
        await consumirPepsParaOrden(conn, folio, carritoConHistorial, idGrupoRevert)
      }

      await conn.commit()
    } catch (e) {
      await conn.rollback()
      throw e
    } finally {
      conn.release()
    }

    res.json({ ok: true, data: { success: true } })
  } catch (e) {
    console.error('[ordenes] revertirProcesamiento:', e.message)
    res.status(500).json({ ok: false, error: e.message || 'Error al revertir el procesamiento' })
  }
})

module.exports = router
