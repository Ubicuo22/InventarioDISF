const router = require('express').Router()
const { q }   = require('../db/pool')
const { requireAuth, requireModulo } = require('../middleware/auth')
const { registrar } = require('../utils/actividad')
const { fechaMexico } = require('../utils/fecha')
const { resolverCadenas } = require('peps-engine-core')

router.use(requireAuth)

/**
 * Resuelve la cadena de equivalencias de UN producto derivado hasta su base
 * final, usando el motor compartido (peps-engine-core) — fuente única con
 * disfruleg-electron, no una copia hand-porteada (ver auditoría H-5 Fase 4,
 * 2026-09-09, que encontró un bug real causado exactamente por una copia
 * desincronizada).
 *
 * @param {number} idProducto
 * @param {Record<number, {idBase:number, factor:number}>} allConvMap  grafo completo derivado -> {idBase, factor}
 * @returns {{idBase:number, factor:number}|null}
 */
function resolverCadenaGlobal (idProducto, allConvMap) {
  if (!allConvMap[idProducto]) return null
  const convMap = { [idProducto]: allConvMap[idProducto] }
  resolverCadenas(convMap, allConvMap)
  return convMap[idProducto]
}

/* ─── POST /api/mermas — registrar merma/ajuste ─── */
router.post('/', requireModulo('mermas'), async (req, res) => {
  const { id_producto, tipo_merma, cantidad_merma, motivo, fecha_merma, notas } = req.body
  if (!id_producto)    return res.status(400).json({ ok: false, error: 'id_producto requerido' })
  if (!tipo_merma)     return res.status(400).json({ ok: false, error: 'tipo_merma requerido' })
  const _cant = Number(cantidad_merma)
  if (!_cant || !isFinite(_cant) || _cant <= 0)
    return res.status(400).json({ ok: false, error: 'cantidad_merma debe ser mayor a 0' })
  if (!motivo?.trim()) return res.status(400).json({ ok: false, error: 'motivo requerido' })

  const tiposValidos = ['VENCIMIENTO','DAÑO','ROBO','AJUSTE_INVENTARIO','OTRO']
  if (!tiposValidos.includes(tipo_merma))
    return res.status(400).json({ ok: false, error: 'tipo_merma inválido' })

  const fecha  = fecha_merma || fechaMexico()
  const usuario = req.user.username

  const conn = await require('../db/pool').pool.getConnection()
  try {
    await conn.beginTransaction()

    const [[prod]] = await conn.execute(
      `SELECT stock, nombre_producto, unidad_producto FROM producto WHERE id_producto = ? AND activo = 1`,
      [id_producto]
    )
    if (!prod) { await conn.rollback(); return res.status(404).json({ ok: false, error: 'Producto no encontrado' }) }

    // Resolver la cadena de equivalencias completa (propio -> ... -> base final),
    // no solo un salto — ver resolverCadenaGlobal arriba.
    const [convRows] = await conn.execute(
      `SELECT id_producto_derivado, id_producto_base, factor
       FROM producto_conversion_peps
       WHERE activo = 1 AND id_grupo IS NULL AND id_producto_derivado != id_producto_base`
    )
    const baseDe = {}
    for (const r of convRows) {
      baseDe[r.id_producto_derivado] = { idBase: r.id_producto_base, factor: parseFloat(r.factor) }
    }
    const cadena = resolverCadenaGlobal(id_producto, baseDe)

    // Verificar stock VIRTUAL (propio + cobertura de la base final vía la cadena
    // completa de equivalencias). Sin esto se bloquearían mermas legítimas de
    // productos derivados con stock propio 0 pero cobertura en la cadena.
    let stockBaseFinal = null
    if (cadena) {
      const [[baseRow]] = await conn.execute('SELECT stock FROM producto WHERE id_producto = ?', [cadena.idBase])
      stockBaseFinal = baseRow ? parseFloat(baseRow.stock) : 0
    }
    const stockVirtual = cadena
      ? Math.round((parseFloat(prod.stock) + stockBaseFinal / cadena.factor) * 10000) / 10000
      : parseFloat(prod.stock)
    if (stockVirtual < _cant) {
      await conn.rollback()
      return res.status(400).json({ ok: false, error: `Stock insuficiente. Disponible: ${stockVirtual} ${prod.unidad_producto}` })
    }

    // Insertar merma (sin costo — simplificado para web)
    const [ins] = await conn.execute(`
      INSERT INTO merma (id_producto, cantidad_merma, tipo_merma, motivo, fecha_merma,
                         costo_unitario, costo_total, usuario_registro, notas)
      VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
    `, [id_producto, _cant, tipo_merma, motivo.trim(), fecha, usuario, notas?.trim() || null])

    // Consumir lotes PEPS en orden FIFO (idéntico a mermas:registrar del electron).
    // Sin esto, el stock de `producto` baja pero `inventario_peps.cantidad_restante` queda
    // inflado. La próxima compra desde electron reconciliaría stock = SUM(PEPS) y
    // revertiría silenciosamente la merma.
    let pendiente = _cant
    const [lotesPropios] = await conn.execute(
      `SELECT id_inventario_peps, cantidad_restante
       FROM inventario_peps
       WHERE id_producto = ? AND cantidad_restante > 0 AND activo = 1
       ORDER BY fecha_movimiento ASC, id_inventario_peps ASC`,
      [id_producto]
    )
    for (const lote of lotesPropios) {
      if (pendiente <= 0) break
      const consumir = Math.min(pendiente, parseFloat(lote.cantidad_restante))
      await conn.execute(
        'UPDATE inventario_peps SET cantidad_restante = cantidad_restante - ? WHERE id_inventario_peps = ?',
        [consumir, lote.id_inventario_peps]
      )
      // Registrar cada lote consumido — Electron usa merma_lote para
      // revertir/eliminar la merma devolviendo cantidades al lote exacto
      await conn.execute(
        'INSERT INTO merma_lote (id_merma, id_inventario_peps, cantidad_consumida) VALUES (?, ?, ?)',
        [ins.insertId, lote.id_inventario_peps, consumir]
      )
      pendiente -= consumir
    }

    // FIX (auditoría H-5 Fase 4, 2026-09-09): si los lotes propios no alcanzan,
    // cruzar la frontera de equivalencia y consumir de la BASE FINAL de la
    // cadena (no solo un salto) — la validación de arriba (stockVirtual) ya
    // contó esa cobertura, así que el consumo real tiene que hacer lo mismo
    // o la merma queda registrada sin ningún efecto en inventario. Semántica
    // del factor acumulado (igual que peps-engine.ts en Electron): 1 unidad
    // del DERIVADO original = factor unidades de la BASE final.
    let idBaseAfectado = null
    if (pendiente > 0 && cadena) {
      idBaseAfectado = cadena.idBase
      let pendienteBase = Math.round(pendiente * cadena.factor * 10000) / 10000
      const [lotesBase] = await conn.execute(
        `SELECT id_inventario_peps, cantidad_restante
         FROM inventario_peps
         WHERE id_producto = ? AND cantidad_restante > 0 AND activo = 1
         ORDER BY fecha_movimiento ASC, id_inventario_peps ASC`,
        [idBaseAfectado]
      )
      for (const lote of lotesBase) {
        if (pendienteBase <= 0) break
        const consumir = Math.min(pendienteBase, parseFloat(lote.cantidad_restante))
        await conn.execute(
          'UPDATE inventario_peps SET cantidad_restante = cantidad_restante - ? WHERE id_inventario_peps = ?',
          [consumir, lote.id_inventario_peps]
        )
        await conn.execute(
          'INSERT INTO merma_lote (id_merma, id_inventario_peps, cantidad_consumida) VALUES (?, ?, ?)',
          [ins.insertId, lote.id_inventario_peps, consumir]
        )
        pendienteBase -= consumir
      }
    }

    // Reconciliar stock desde lotes PEPS (igual que mermas:registrar de Electron,
    // FIX I-5: reemplaza la resta aritmética para no acumular drift)
    await conn.execute(
      `UPDATE producto
       SET stock = (
         SELECT COALESCE(SUM(ip.cantidad_restante), 0)
         FROM inventario_peps ip
         WHERE ip.id_producto = ? AND ip.activo = 1
       )
       WHERE id_producto = ?`,
      [id_producto, id_producto]
    )
    if (idBaseAfectado) {
      await conn.execute(
        `UPDATE producto
         SET stock = (
           SELECT COALESCE(SUM(ip.cantidad_restante), 0)
           FROM inventario_peps ip
           WHERE ip.id_producto = ? AND ip.activo = 1
         )
         WHERE id_producto = ?`,
        [idBaseAfectado, idBaseAfectado]
      )
    }

    await conn.commit()

    registrar(req, 'mermas', 'merma', {
      producto: prod.nombre_producto, tipo: tipo_merma, cantidad: cantidad_merma
    })

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
router.get('/recientes', requireModulo('mermas'), async (req, res) => {
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
