#!/usr/bin/env node
/**
 * scripts/repricing-phantoms.js
 *
 * Migración one-shot: actualiza el precio de los phantoms post-2026-06-01 que aún
 * no han sido reconciliados, asignándoles el último precio real conocido del producto.
 *
 * Objetivo: que esos phantoms a $0.01 dejen de contaminar el promedio de compra y
 * queden valuados con un costo razonable hasta que llegue inventario real que los salde.
 *
 * Uso:
 *   node scripts/repricing-phantoms.js            → dry-run (no escribe)
 *   node scripts/repricing-phantoms.js --apply    → ejecuta los UPDATEs
 *
 * Lógica:
 *   - Busca phantoms post-Jun-1 cuyo precio_unitario_compra <= 1 (placeholder)
 *   - Para cada producto: encuentra el último precio_unitario_compra de una compra
 *     real (no-phantom, no-bootstrap) — si no existe, salta el producto
 *   - Actualiza precio_unitario_compra, subtotal, total_con_impuestos y costo_unitario
 *     del lote PEPS asociado al precio histórico
 *   - NO toca cantidad_compra ni la marca de reconciliación
 */

process.env.TZ = 'America/Mexico_City'
require('dotenv').config()
const { pool, q } = require('../db/pool')

const APPLY = process.argv.includes('--apply')

;(async () => {
  console.log(`Modo: ${APPLY ? 'APLICAR cambios' : 'DRY-RUN (solo lectura)'}`)
  console.log('')

  // 1. Productos con phantoms placeholder post-Jun-1 + último precio real conocido
  const productos = await q(`
    SELECT
      p.id_producto,
      p.nombre_producto,
      p.unidad_producto,
      (
        SELECT c2.precio_unitario_compra
          FROM compra c2
         WHERE c2.id_producto = p.id_producto
           AND (c2.notas IS NULL OR c2.notas NOT LIKE 'PHANTOM:%')
           AND (c2.notas IS NULL OR c2.notas NOT LIKE 'BOOTSTRAP:%')
           AND c2.precio_unitario_compra > 1
         ORDER BY c2.fecha_compra DESC, c2.id_compra DESC
         LIMIT 1
      ) AS ultimo_precio_real,
      COUNT(c.id_compra) AS num_phantoms,
      SUM(c.cantidad_compra) AS qty_phantom
    FROM compra c
    JOIN producto p ON p.id_producto = c.id_producto
    WHERE c.notas LIKE 'PHANTOM:%'
      AND c.fecha_registro > '2026-06-01 23:59:59'
      AND c.precio_unitario_compra <= 1
    GROUP BY p.id_producto, p.nombre_producto, p.unidad_producto
    ORDER BY p.nombre_producto
  `)

  let totalUpdates = 0
  let productosConPrecio = 0
  let productosSinPrecio = 0

  console.log('PRODUCTO'.padEnd(40) + '| ÚLTIMO $ | # PHANTOMS | QTY  ')
  console.log('-'.repeat(85))

  const conn = await pool.getConnection()
  try {
    if (APPLY) await conn.beginTransaction()

    for (const p of productos) {
      const precio = p.ultimo_precio_real ? parseFloat(p.ultimo_precio_real) : null
      if (!precio) {
        productosSinPrecio++
        console.log(p.nombre_producto.padEnd(40) + '|   —      | ' + String(p.num_phantoms).padStart(10) + ' | ' + p.qty_phantom + '  (SIN PRECIO HISTÓRICO — SE SALTA)')
        continue
      }
      productosConPrecio++

      // Obtener phantoms placeholder de este producto
      const phantoms = await q(`
        SELECT id_compra, cantidad_compra, incluye_iva
          FROM compra
         WHERE id_producto = ?
           AND notas LIKE 'PHANTOM:%'
           AND fecha_registro > '2026-06-01 23:59:59'
           AND precio_unitario_compra <= 1
      `, [p.id_producto])

      for (const ph of phantoms) {
        const cant = parseFloat(ph.cantidad_compra)
        const subtotal = +(cant * precio).toFixed(2)
        const iva = ph.incluye_iva === 1 ? +(subtotal * 0.16).toFixed(2) : 0
        const total = +(subtotal + iva).toFixed(2)

        if (APPLY) {
          await conn.execute(
            `UPDATE compra
                SET precio_unitario_compra = ?, subtotal = ?, iva = ?, total_con_impuestos = ?
              WHERE id_compra = ?`,
            [precio, subtotal, iva, total, ph.id_compra]
          )
          await conn.execute(
            `UPDATE inventario_peps SET costo_unitario = ? WHERE id_compra = ?`,
            [precio, ph.id_compra]
          )
        }
        totalUpdates++
      }

      console.log(p.nombre_producto.padEnd(40) + '| ' + ('$' + precio.toFixed(2)).padStart(8) + ' | ' + String(p.num_phantoms).padStart(10) + ' | ' + parseFloat(p.qty_phantom).toFixed(2))
    }

    if (APPLY) await conn.commit()
    conn.release()

  } catch (e) {
    if (APPLY) await conn.rollback()
    conn.release()
    throw e
  }

  console.log('-'.repeat(85))
  console.log(`Productos con precio histórico:    ${productosConPrecio}`)
  console.log(`Productos sin precio (saltados):   ${productosSinPrecio}`)
  console.log(`Total phantoms ${APPLY ? 'actualizados' : 'a actualizar'}: ${totalUpdates}`)
  console.log('')
  if (!APPLY) console.log('Para aplicar: node scripts/repricing-phantoms.js --apply')

  process.exit(0)
})().catch(e => {
  console.error('ERROR:', e.message)
  process.exit(1)
})
