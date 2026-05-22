/**
 * routes/entradas.js — Registro de entradas de inventario
 * POST /api/entradas          — Crear entrada (compra + lote PEPS + stock)
 * GET  /api/entradas/recientes — Últimas 50 entradas
 */

const router = require('express').Router()
const { pool, q } = require('../db/pool')
const { requireAuth } = require('../middleware/auth')
const { enviarATodos } = require('../utils/push')
const { registrar } = require('../utils/actividad')

// Productos equivalentes (familia) de un producto
router.get('/equivalentes/:idProducto', requireAuth, async (req, res) => {
  try {
    const { idProducto } = req.params
    // Familias a las que pertenece el producto
    const familias = await q(`
      SELECT f.id_familia
      FROM producto_familia_miembro m
      JOIN producto_familia f ON f.id_familia = m.id_familia
      WHERE m.id_producto = ? AND f.activo = 1
    `, [idProducto])

    if (!familias.length) return res.json({ ok: true, data: [] })

    const ids = familias.map(f => f.id_familia)
    const placeholders = ids.map(() => '?').join(',')

    const miembros = await q(`
      SELECT p.id_producto, p.nombre_producto, p.unidad_producto, p.stock
      FROM producto_familia_miembro m
      JOIN producto p ON p.id_producto = m.id_producto
      WHERE m.id_familia IN (${placeholders})
        AND m.id_producto != ?
        AND p.activo = 1
      GROUP BY p.id_producto
      ORDER BY p.nombre_producto
    `, [...ids, idProducto])

    res.json({ ok: true, data: miembros })
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
      idsEquivalentes = []
    } = req.body

    // Validaciones
    if (!idProducto || !cantidad || precio == null || !fechaCompra) {
      return res.status(400).json({ ok: false, error: 'Faltan campos: idProducto, cantidad, precio, fechaCompra' })
    }
    const cantidadNum  = parseFloat(cantidad)
    const precioConIVA = parseFloat(precio)
    if (isNaN(cantidadNum) || cantidadNum <= 0)  return res.status(400).json({ ok: false, error: 'Cantidad inválida' })
    if (isNaN(precioConIVA) || precioConIVA < 0) return res.status(400).json({ ok: false, error: 'Precio inválido' })

    // Calcular impuestos — misma lógica que compras.handler.js
    // El precio recibido ya incluye IVA (se desglosa, no se suma encima)
    const precioUnitario = incluirIva ? precioConIVA / 1.16 : precioConIVA
    const subtotal = cantidadNum * precioUnitario
    const iva      = incluirIva ? cantidadNum * precioConIVA - subtotal : 0
    const total    = subtotal + iva
    const usuario  = req.user.username

    await conn.beginTransaction()

    // 1. Insertar en tabla compra
    const [compraResult] = await conn.execute(
      `INSERT INTO compra (
        id_producto, id_proveedor, cantidad_compra, precio_unitario_compra,
        fecha_compra, folio_factura, importe_ieps, metodo_pago, forma_pago,
        subtotal, iva, incluye_iva, total_con_impuestos,
        usuario_registro, notas, tasa_interes
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 'PUE', '03', ?, ?, ?, ?, ?, ?, 0)`,
      [
        idProducto, idProveedor || null, cantidadNum, precioUnitario,
        fechaCompra, folio || null,
        subtotal, iva, incluirIva ? 1 : 0, total,
        usuario, notas || null
      ]
    )
    const idCompra = compraResult.insertId

    // 2. Crear lote en inventario_peps (FIFO)
    await conn.execute(
      `INSERT INTO inventario_peps (
        id_producto, id_compra, fecha_movimiento,
        cantidad_inicial, cantidad_restante, costo_unitario
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [idProducto, idCompra, fechaCompra, cantidadNum, cantidadNum, precioUnitario]
    )

    // 3. Reconciliar stock desde lotes PEPS activos (misma lógica que compras:crear en electron v3.7.0).
    //    El lote que acabamos de insertar ya está en inventario_peps con cantidad_restante = cantidadNum,
    //    así que la subquery devuelve el valor correcto directamente sin aritmética acumulativa.
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

    // 4. Actualizar stock de equivalentes seleccionados (solo stock, sin PEPS)
    const equivalentesValidos = Array.isArray(idsEquivalentes)
      ? idsEquivalentes.map(Number).filter(n => n > 0 && n !== Number(idProducto))
      : []
    for (const idEq of equivalentesValidos) {
      await conn.execute(
        `UPDATE producto SET stock = stock + ? WHERE id_producto = ?`,
        [cantidadNum, idEq]
      )
    }

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
      data: { idCompra, cantidad: cantidadNum, total: parseFloat(total.toFixed(2)) }
    })
  } catch (err) {
    await conn.rollback()
    conn.release()
    console.error('[entradas] POST /:', err.message)
    res.status(500).json({ ok: false, error: err.message })
  }
})

module.exports = router
