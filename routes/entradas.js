/**
 * routes/entradas.js — Registro de entradas de inventario
 * POST /api/entradas               — Crear entrada (compra + lote PEPS + stock)
 * GET  /api/entradas/recientes     — Últimas 50 entradas
 * GET  /api/entradas/lotes/:id     — Lotes PEPS activos de un producto (orden PEPS)
 * GET  /api/entradas/peps-info/:id — Conversiones PEPS (derivados / alerta de derivado)
 */

const router = require('express').Router()
const { pool, q } = require('../db/pool')
const { requireAuth } = require('../middleware/auth')
const { enviarATodos } = require('../utils/push')
const { registrar } = require('../utils/actividad')
const { fechaMexico } = require('../utils/fecha')

// Conversiones PEPS activas cuyo BASE es este producto
// Retorna los derivados que usan este producto como fuente de stock
router.get('/peps-info/:idProducto', requireAuth, async (req, res) => {
  try {
    const { idProducto } = req.params

    const [derivados, esDerivado] = await Promise.all([
      // ¿Este producto ES BASE de alguna conversión?
      q(`
        SELECT
          c.factor,
          c.notas,
          pd.id_producto,
          pd.nombre_producto,
          pd.unidad_producto
        FROM producto_conversion_peps c
        JOIN producto pd ON pd.id_producto = c.id_producto_derivado
        WHERE c.id_producto_base = ? AND c.activo = 1
          AND c.id_producto_derivado != c.id_producto_base
        ORDER BY pd.nombre_producto
      `, [idProducto]),

      // ¿Este producto ES DERIVADO de alguna conversión? (alerta: compra incorrecta)
      q(`
        SELECT
          c.factor,
          pb.id_producto,
          pb.nombre_producto,
          pb.unidad_producto
        FROM producto_conversion_peps c
        JOIN producto pb ON pb.id_producto = c.id_producto_base
        WHERE c.id_producto_derivado = ? AND c.activo = 1
          AND c.id_producto_derivado != c.id_producto_base
        LIMIT 1
      `, [idProducto])
    ])

    res.json({
      ok: true,
      // Productos de venta que consumen el stock de este producto base
      derivados,
      // Si este producto es en realidad un derivado, advertir y mostrar cuál es el base correcto
      esDerivado: esDerivado.length > 0 ? esDerivado[0] : null
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// Lotes PEPS activos de un producto — orden PEPS (más antiguo primero)
router.get('/lotes/:idProducto', requireAuth, async (req, res) => {
  try {
    const { idProducto } = req.params
    const rows = await q(`
      SELECT
        ip.id_inventario_peps,
        ip.fecha_movimiento,
        ip.cantidad_inicial,
        ip.cantidad_restante,
        ip.costo_unitario,
        ip.factor_conversion,
        ip.fecha_registro,
        COALESCE(prov.nombre_proveedor, c.proveedor, '—') AS proveedor,
        c.folio_factura,
        c.notas
      FROM inventario_peps ip
      LEFT JOIN compra c ON c.id_compra = ip.id_compra
      LEFT JOIN proveedor prov ON prov.id_proveedor = c.id_proveedor
      WHERE ip.id_producto = ? AND ip.activo = 1
      ORDER BY ip.fecha_movimiento ASC, ip.id_inventario_peps ASC
    `, [idProducto])
    res.json({ ok: true, data: rows })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// Últimas entradas registradas
router.get('/recientes', requireAuth, async (req, res) => {
  try {
    const rows = await q(`
      SELECT
        c.id_compra,
        c.fecha_compra,
        c.fecha_registro,
        p.nombre_producto,
        p.unidad_producto,
        c.cantidad_compra,
        c.precio_unitario_compra,
        c.total_con_impuestos,
        COALESCE(prov.nombre_proveedor, c.proveedor, '—') AS proveedor,
        c.folio_factura,
        c.usuario_registro
      FROM compra c
      INNER JOIN producto p ON c.id_producto = p.id_producto
      LEFT  JOIN proveedor prov ON c.id_proveedor = prov.id_proveedor
      WHERE (c.notas IS NULL OR (
              c.notas NOT LIKE 'PHANTOM:%'
          AND c.notas NOT LIKE 'AJUSTE:%'
          AND NOT (c.notas LIKE 'BOOTSTRAP:%' AND c.precio_unitario_compra <= 0.01)
      ))
      ORDER BY c.fecha_registro DESC
      LIMIT 50
    `)
    res.json({ ok: true, data: rows })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// Registrar nueva entrada de inventario
router.post('/', requireAuth, async (req, res) => {
  const conn = await pool.getConnection()
  try {
    const {
      idProducto,
      idProveedor    = null,
      cantidad,
      precio,
      fechaCompra,
      folio          = null,
      incluirIva     = true,
      notas          = null,
      pesoLote       = null   // kg totales del lote — opcional, para factor PEPS
    } = req.body

    // Validaciones
    if (!idProducto || !cantidad || precio == null || !fechaCompra) {
      return res.status(400).json({ ok: false, error: 'Faltan campos: idProducto, cantidad, precio, fechaCompra' })
    }
    const cantidadNum  = parseFloat(cantidad)
    const precioConIVA = parseFloat(precio)
    if (isNaN(cantidadNum) || cantidadNum <= 0)  return res.status(400).json({ ok: false, error: 'Cantidad inválida' })
    if (isNaN(precioConIVA) || precioConIVA < 0) return res.status(400).json({ ok: false, error: 'Precio inválido' })

    // Verificar que el producto existe y está activo
    const [prodRows] = await conn.execute(
      'SELECT id_producto FROM producto WHERE id_producto = ? AND activo = 1',
      [idProducto]
    )
    if (!prodRows.length) {
      return res.status(400).json({ ok: false, error: 'Producto no encontrado o inactivo' })
    }

    // Peso del lote — calcula peso_por_pieza y factor_conversion del lote
    const pesoLoteNum = pesoLote != null ? parseFloat(pesoLote) : NaN
    const pesoPorPieza      = (!isNaN(pesoLoteNum) && pesoLoteNum > 0 && cantidadNum > 0)
      ? parseFloat((pesoLoteNum / cantidadNum).toFixed(6))
      : null
    const factorConversionLote = pesoPorPieza
      ? parseFloat((1 / pesoPorPieza).toFixed(6))
      : null

    // Calcular impuestos — misma lógica que compras.handler.js
    // El precio recibido ya incluye IVA (se desglosa, no se suma encima)
    const precioUnitario = incluirIva ? precioConIVA / 1.16 : precioConIVA
    const subtotal = cantidadNum * precioUnitario
    const iva      = incluirIva ? cantidadNum * precioConIVA - subtotal : 0
    const total    = subtotal + iva
    const usuario  = req.user.username

    await conn.beginTransaction()

    // 1. Insertar en tabla compra (con peso_por_pieza si viene)
    const [compraResult] = await conn.execute(
      `INSERT INTO compra (
        id_producto, id_proveedor, cantidad_compra, precio_unitario_compra,
        fecha_compra, folio_factura, importe_ieps, metodo_pago, forma_pago,
        subtotal, iva, incluye_iva, total_con_impuestos,
        usuario_registro, notas, tasa_interes, peso_por_pieza
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 'PUE', '03', ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        idProducto, idProveedor || null, cantidadNum, precioUnitario,
        fechaCompra, folio || null,
        subtotal, iva, incluirIva ? 1 : 0, total,
        usuario, notas || null,
        pesoPorPieza  // NULL si no se capturó peso
      ]
    )
    const idCompra = compraResult.insertId

    // 2. Crear lote en inventario_peps con factor_conversion si se capturó peso
    await conn.execute(
      `INSERT INTO inventario_peps (
        id_producto, id_compra, fecha_movimiento,
        cantidad_inicial, cantidad_restante, costo_unitario, factor_conversion
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [idProducto, idCompra, fechaCompra, cantidadNum, cantidadNum, precioUnitario,
       factorConversionLote]  // NULL si no se capturó peso
    )

    // 2.5 Reconciliación de PHANTOMS — ventas hechas sin stock que ahora pueden saldarse.
    //
    // Cuando Electron procesa una nota sin inventario suficiente, crea una compra
    // marcada como 'PHANTOM:GUARDADAS' o 'PHANTOM:REGISTRADAS' para que la venta tenga lote.
    // Al llegar el inventario real (esta entrada), descontamos esa deuda del nuevo lote
    // para que producto.stock refleje lo que realmente queda disponible.
    //
    // Además del descuento de cantidad, actualizamos el precio del phantom al promedio
    // ponderado del costo real que lo cubrió. Así esos phantoms dejan de tener $0.01 (que
    // contamina el promedio de compras) y heredan el costo del inventario que los saldó.
    //
    // Marcador en notas: 'PHANTOM:TIPO|REC:<qty>|COST:<costo_acumulado>'
    //   - REC = cantidad ya reconciliada del phantom
    //   - COST = suma acumulada de (qty_cubierta × precio_lote) para todos los lotes que lo cubrieron
    // El precio_unitario_compra se actualiza a COST/REC = promedio ponderado.
    //
    // Solo se reconcilian phantoms posteriores al 2026-06-01 — todo lo anterior queda
    // intacto para no alterar el histórico previo al conteo físico.
    const [phantomsRows] = await conn.execute(
      `SELECT id_compra, cantidad_compra, notas, incluye_iva
         FROM compra
        WHERE id_producto = ?
          AND notas LIKE 'PHANTOM:%'
          AND fecha_registro > '2026-06-01 23:59:59'
        ORDER BY fecha_registro ASC, id_compra ASC
        FOR UPDATE`,
      [idProducto]
    )

    let descontadoTotal = 0
    let restantePorDescontar = cantidadNum
    for (const ph of phantomsRows) {
      if (restantePorDescontar <= 0) break
      const cantPhantom = parseFloat(ph.cantidad_compra)
      const mRec  = (ph.notas || '').match(/\|REC:([\d.]+)/)
      const mCost = (ph.notas || '').match(/\|COST:([\d.]+)/)
      const yaReconciliado = mRec  ? parseFloat(mRec[1])  : 0
      const costAcumulado  = mCost ? parseFloat(mCost[1]) : 0
      const pendiente = cantPhantom - yaReconciliado
      if (pendiente <= 0) continue

      const aDescontar = Math.min(pendiente, restantePorDescontar)
      const costoAplicado     = aDescontar * precioUnitario
      const nuevoReconciliado = +(yaReconciliado + aDescontar).toFixed(4)
      const nuevoCostAcum     = +(costAcumulado + costoAplicado).toFixed(6)
      const precioPromedio    = +(nuevoCostAcum / nuevoReconciliado).toFixed(4)

      // Recalcular subtotal/iva/total con el nuevo precio promedio
      const incluyeIva   = ph.incluye_iva === 1
      const nuevoSubtot  = +(cantPhantom * precioPromedio).toFixed(2)
      const nuevoIva     = incluyeIva ? +(nuevoSubtot * 0.16).toFixed(2) : 0
      const nuevoTotal   = +(nuevoSubtot + nuevoIva).toFixed(2)

      const base = (ph.notas || '').split('|REC:')[0].split('|COST:')[0]
      const nuevasNotas = `${base}|REC:${nuevoReconciliado}|COST:${nuevoCostAcum}`

      await conn.execute(
        `UPDATE compra
            SET notas = ?,
                precio_unitario_compra = ?,
                subtotal = ?,
                iva = ?,
                total_con_impuestos = ?
          WHERE id_compra = ?`,
        [nuevasNotas, precioPromedio, nuevoSubtot, nuevoIva, nuevoTotal, ph.id_compra]
      )
      // Mantener costo_unitario del lote PEPS coherente con el nuevo precio
      await conn.execute(
        `UPDATE inventario_peps SET costo_unitario = ? WHERE id_compra = ?`,
        [precioPromedio, ph.id_compra]
      )

      descontadoTotal += aDescontar
      restantePorDescontar -= aDescontar
    }

    // Si descontamos algo, reducir el cantidad_restante del lote recién insertado
    if (descontadoTotal > 0) {
      const nuevoRestante = +(cantidadNum - descontadoTotal).toFixed(4)
      await conn.execute(
        `UPDATE inventario_peps
           SET cantidad_restante = ?,
               activo = CASE WHEN ? <= 0 THEN 0 ELSE 1 END
         WHERE id_compra = ?`,
        [nuevoRestante, nuevoRestante, idCompra]
      )
    }

    // 3. Reconciliar stock desde lotes PEPS activos (misma lógica que compras:crear en electron v3.7.0).
    //    Tras la reconciliación de phantoms, el SUM refleja solo lo que queda realmente disponible.
    await conn.execute(
      `UPDATE producto
       SET stock = (
         SELECT COALESCE(SUM(ip.cantidad_restante), 0)
         FROM inventario_peps ip
         WHERE ip.id_producto = ? AND ip.activo = 1
       )
       WHERE id_producto = ?`,
      [idProducto, idProducto]
    )

    // NOTA (Electron 4.1.0): las familias son solo agrupación visual/clave SAT.
    // El stock compartido se resuelve vía producto_conversion_peps al VENDER,
    // nunca al comprar — no se actualiza stock de equivalentes aquí.

    await conn.commit()
    conn.release()

    // Notificar a todos los dispositivos — fire-and-forget
    const [prodRow] = await q(
      'SELECT nombre_producto, unidad_producto FROM producto WHERE id_producto = ?',
      [idProducto]
    )
    const nombre  = prodRow?.nombre_producto || 'Producto'
    const unidad  = prodRow?.unidad_producto || ''
    const cantStr = `+${cantidadNum}${unidad ? ' ' + unidad : ''}`
    enviarATodos({
      title: `📦 Entrada de stock · ${nombre} · ${cantStr} · ${usuario}`,
      body:  '',
      icon:  '/assets/icon.png'
    }).then(r => {
      console.log(`[push] Stock entrada web — ${r.enviados}/${r.total} dispositivos`)
    }).catch(() => {})

    registrar(req, 'inventario', 'entrada', {
      producto: nombre, cantidad: cantidadNum, total: parseFloat(total.toFixed(2))
    })

    res.json({
      ok: true,
      data: {
        idCompra,
        cantidad: cantidadNum,
        total: parseFloat(total.toFixed(2)),
        reconciliado: parseFloat(descontadoTotal.toFixed(4)),  // kg/pz que saldaron deuda phantom
        disponible:   parseFloat((cantidadNum - descontadoTotal).toFixed(4))  // lo que entra al stock real
      }
    })
  } catch (err) {
    await conn.rollback()
    conn.release()
    console.error('[entradas] POST /:', err.message)
    res.status(500).json({ ok: false, error: err.message })
  }
})

// ═══════════════════════════════════════════════════════════
// CORTE FÍSICO DE INVENTARIO — ajustes manuales por conteo físico
// ═══════════════════════════════════════════════════════════

/**
 * GET /api/entradas/conteo-fisico/estado
 * Lista productos activos con stock actual + última verificación (si la hay hoy).
 * Query params:
 *   - q: filtro por nombre (opcional)
 *   - unidad: filtro por unidad (opcional)
 *   - soloPendientes: si true, oculta los ya contados hoy
 */
router.get('/conteo-fisico/estado', requireAuth, async (req, res) => {
  try {
    const { q: filtroNombre = '', unidad = '', soloPendientes = 'false' } = req.query
    const wheres = ['p.activo = 1']
    const params = []
    if (filtroNombre.trim()) { wheres.push('p.nombre_producto LIKE ?'); params.push('%' + filtroNombre.trim() + '%') }
    if (unidad.trim())       { wheres.push('p.unidad_producto = ?');   params.push(unidad.trim()) }

    // TiDB no soporta subqueries en ON, así que hacemos dos queries y mezclamos en JS
    const [productos, verifs] = await Promise.all([
      q(`SELECT p.id_producto, p.nombre_producto, p.unidad_producto, p.stock
           FROM producto p
          WHERE ${wheres.join(' AND ')}
          ORDER BY p.nombre_producto`, params),
      q(`SELECT v1.id_producto, v1.cantidad_fisica, v1.cantidad_sistema,
                v1.delta, v1.usuario, v1.fecha
           FROM verificaciones_inventario v1
          INNER JOIN (
            SELECT id_producto, MAX(id) AS maxid
              FROM verificaciones_inventario
             WHERE DATE(fecha) = CURDATE()
             GROUP BY id_producto
          ) v2 ON v2.maxid = v1.id`)
    ])

    const verifByProd = new Map(verifs.map(v => [v.id_producto, v]))
    const rows = productos.map(p => {
      const v = verifByProd.get(p.id_producto)
      return {
        ...p,
        ultima_fisica:  v?.cantidad_fisica  ?? null,
        ultima_sistema: v?.cantidad_sistema ?? null,
        ultima_delta:   v?.delta            ?? null,
        ultima_usuario: v?.usuario          ?? null,
        ultima_fecha:   v?.fecha            ?? null
      }
    })

    const data = soloPendientes === 'true' ? rows.filter(r => !r.ultima_fecha) : rows
    res.json({ ok: true, data })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

/**
 * POST /api/entradas/ajuste-inventario
 * Body: { idProducto, cantidadFisica, notas? }
 * Calcula delta vs stock sistema, crea ajuste apropiado y registra verificación.
 */
router.post('/ajuste-inventario', requireAuth, async (req, res) => {
  const conn = await pool.getConnection()
  try {
    const { idProducto, cantidadFisica, notas = '' } = req.body
    if (!idProducto || cantidadFisica == null) {
      return res.status(400).json({ ok: false, error: 'Faltan campos: idProducto, cantidadFisica' })
    }
    const fisicaNum = parseFloat(cantidadFisica)
    if (isNaN(fisicaNum) || fisicaNum < 0) {
      return res.status(400).json({ ok: false, error: 'Cantidad física inválida' })
    }

    await conn.beginTransaction()

    // Leer stock actual y datos producto
    const [[prod]] = await conn.execute(
      `SELECT id_producto, nombre_producto, unidad_producto, stock FROM producto WHERE id_producto = ? AND activo = 1`,
      [idProducto]
    )
    if (!prod) {
      await conn.rollback(); conn.release()
      return res.status(404).json({ ok: false, error: 'Producto no encontrado' })
    }

    const stockSistema = parseFloat(prod.stock)
    const delta        = +(fisicaNum - stockSistema).toFixed(4)
    const usuario      = req.user.username
    const fecha        = fechaMexico()
    let idCompraAjuste = null

    if (delta > 0) {
      // Sobrante físico → crear compra AJUSTE + lote positivo al último precio conocido
      const [[ult]] = await conn.execute(
        `SELECT precio_unitario_compra
           FROM compra
          WHERE id_producto = ?
            AND (notas IS NULL OR notas NOT LIKE 'PHANTOM:%')
            AND precio_unitario_compra > 1
          ORDER BY fecha_compra DESC, id_compra DESC LIMIT 1`,
        [idProducto]
      )
      const precio = ult ? parseFloat(ult.precio_unitario_compra) : 0.01
      const subtotal = +(delta * precio).toFixed(2)

      const [r] = await conn.execute(
        `INSERT INTO compra (
          id_producto, id_proveedor, cantidad_compra, precio_unitario_compra,
          fecha_compra, importe_ieps, metodo_pago, forma_pago,
          subtotal, iva, incluye_iva, total_con_impuestos,
          usuario_registro, notas, tasa_interes
        ) VALUES (?, NULL, ?, ?, ?, 0, 'PUE', '03', ?, 0, 0, ?, ?, ?, 0)`,
        [idProducto, delta, precio, fecha, subtotal, subtotal, usuario, `AJUSTE:conteo-fisico:+${delta}${notas ? '|' + notas : ''}`]
      )
      idCompraAjuste = r.insertId

      await conn.execute(
        `INSERT INTO inventario_peps (id_producto, id_compra, fecha_movimiento, cantidad_inicial, cantidad_restante, costo_unitario, activo)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [idProducto, idCompraAjuste, fecha, delta, delta, precio]
      )
    } else if (delta < 0) {
      // Faltante físico → consumir lotes activos en orden PEPS (más antiguos primero)
      let porDescontar = Math.abs(delta)
      const [lotes] = await conn.execute(
        `SELECT id_inventario_peps, cantidad_restante
           FROM inventario_peps
          WHERE id_producto = ? AND activo = 1 AND cantidad_restante > 0
          ORDER BY fecha_movimiento ASC, id_inventario_peps ASC`,
        [idProducto]
      )
      for (const l of lotes) {
        if (porDescontar <= 0) break
        const disp = parseFloat(l.cantidad_restante)
        const a = Math.min(disp, porDescontar)
        const nuevoRestante = +(disp - a).toFixed(4)
        await conn.execute(
          `UPDATE inventario_peps
              SET cantidad_restante = ?, activo = CASE WHEN ? <= 0 THEN 0 ELSE 1 END
            WHERE id_inventario_peps = ?`,
          [nuevoRestante, nuevoRestante, l.id_inventario_peps]
        )
        porDescontar -= a
      }
      // Si quedó pendiente sin lotes que descontar, el stock no podía cuadrar — se permite y queda como inconsistencia menor que el recálculo final manejará.
    }

    // Recalcular stock del producto
    await conn.execute(
      `UPDATE producto
          SET stock = (SELECT COALESCE(SUM(cantidad_restante),0) FROM inventario_peps WHERE id_producto = ? AND activo = 1)
        WHERE id_producto = ?`,
      [idProducto, idProducto]
    )

    // Registrar verificación (audit trail)
    await conn.execute(
      `INSERT INTO verificaciones_inventario
         (id_producto, cantidad_sistema, cantidad_fisica, delta, usuario, id_compra_ajuste, notas)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [idProducto, stockSistema, fisicaNum, delta, usuario, idCompraAjuste, notas || null]
    )

    await conn.commit()
    conn.release()

    registrar(req, 'inventario', 'ajuste-conteo-fisico', {
      producto: prod.nombre_producto, sistema: stockSistema, fisico: fisicaNum, delta
    })

    res.json({
      ok: true,
      data: { id_producto: idProducto, stockAntes: stockSistema, stockNuevo: fisicaNum, delta, idCompraAjuste }
    })
  } catch (err) {
    await conn.rollback()
    conn.release()
    console.error('[entradas] POST /ajuste-inventario:', err.message)
    res.status(500).json({ ok: false, error: err.message })
  }
})

module.exports = router
