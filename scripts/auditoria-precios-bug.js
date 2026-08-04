/**
 * auditoria-precios-bug.js
 *
 * Sondeo de notas afectadas por el bug de precio inflado en la app web.
 *
 * Bug: al agregar productos desde la web, se usaba precio_base en lugar de
 *      precio_final = precio_base * (1 - descuento/100).
 *
 * Detecta ítems donde precio_unitario ≈ precio_base cuando debería ser precio_final < precio_base.
 * Rango de búsqueda: 27 jul – 3 ago 2026.
 */

require('dotenv').config()
const { q } = require('../db/pool')

const FECHA_INICIO = '2026-07-27'
const FECHA_FIN    = '2026-08-03'
const TOLERANCIA   = 0.02   // diferencia máxima en $ para considerar "igual"

async function main () {
  // 1. Obtener todas las notas modificadas en el rango
  const ordenes = await q(`
    SELECT o.folio_numero, o.id_cliente, o.datos_carrito,
           c.nombre_cliente, g.id_grupo, g.nombre_grupo,
           COALESCE(tc.descuento, 0) AS descuento
    FROM   ordenes_guardadas o
    INNER  JOIN cliente      c  ON c.id_cliente    = o.id_cliente
    INNER  JOIN grupo        g  ON g.id_grupo      = c.id_grupo
    LEFT   JOIN tipo_cliente tc ON tc.id_tipo_cliente = g.id_tipo_cliente
    WHERE  o.activo = 1
      AND  o.fecha_modificacion >= ?
      AND  o.fecha_modificacion <  DATE_ADD(?, INTERVAL 1 DAY)
      AND  COALESCE(tc.descuento, 0) > 0
  `, [FECHA_INICIO, FECHA_FIN])

  if (!ordenes.length) {
    console.log('No hay notas con descuento modificadas en ese rango.')
    process.exit(0)
  }

  // 2. Obtener todos los precios por grupo de los productos que aparecen en esas notas
  //    Primero, recolectar todos los id_producto únicos
  const idProductoSet = new Set()
  const ordenesConItems = []

  for (const orden of ordenes) {
    let cart
    try {
      cart = typeof orden.datos_carrito === 'string'
        ? JSON.parse(orden.datos_carrito)
        : orden.datos_carrito
    } catch {
      continue
    }

    const items = []
    for (const [sec, arr] of Object.entries(cart)) {
      if (sec.startsWith('__') || !Array.isArray(arr)) continue
      for (const item of arr) {
        if (item.id_producto) {
          idProductoSet.add(item.id_producto)
          items.push({ ...item, seccion: sec })
        }
      }
    }
    if (items.length) ordenesConItems.push({ ...orden, items })
  }

  if (!idProductoSet.size) {
    console.log('Sin ítems que analizar.')
    process.exit(0)
  }

  // 3. Traer precios por grupo en un solo query
  const ids = [...idProductoSet]
  const placeholders = ids.map(() => '?').join(',')

  const precios = await q(`
    SELECT ppg.id_producto, ppg.id_grupo, ppg.precio_base
    FROM   precio_por_grupo ppg
    WHERE  ppg.id_producto IN (${placeholders})
  `, ids)

  // Mapa: "id_producto|id_grupo" → precio_base
  const precioMap = {}
  for (const p of precios) {
    precioMap[`${p.id_producto}|${p.id_grupo}`] = parseFloat(p.precio_base)
  }

  // 4. Analizar cada nota
  const notasAfectadas = []

  for (const orden of ordenesConItems) {
    const { descuento, id_grupo } = orden
    const factor = 1 - descuento / 100   // e.g. 0.90 para 10% descuento

    const itemsAfectados = []
    for (const item of orden.items) {
      const precioBase = precioMap[`${item.id_producto}|${id_grupo}`]
      if (precioBase == null || precioBase <= 0) continue   // sin precio en grupo → skip

      const precioFinalEsperado = Math.round(precioBase * factor * 100) / 100
      const precioUnitario      = parseFloat(item.precio_unitario) || 0

      // Detectar: precio_unitario ≈ precio_base (sin descuento) cuando debería ser precio_final
      const igualABase    = Math.abs(precioUnitario - precioBase) <= TOLERANCIA
      const diferenteFinal = Math.abs(precioUnitario - precioFinalEsperado) > TOLERANCIA

      if (igualABase && diferenteFinal) {
        itemsAfectados.push({
          producto:        item.nombre_producto,
          seccion:         item.seccion,
          cantidad:        item.cantidad,
          precio_cobrado:  precioUnitario,
          precio_correcto: precioFinalEsperado,
          precio_base:     precioBase,
          exceso_unitario: Math.round((precioUnitario - precioFinalEsperado) * 100) / 100,
          exceso_total:    Math.round((precioUnitario - precioFinalEsperado) * item.cantidad * 100) / 100,
        })
      }
    }

    if (itemsAfectados.length) {
      notasAfectadas.push({
        folio:    String(orden.folio_numero).padStart(6, '0'),
        cliente:  orden.nombre_cliente,
        grupo:    orden.nombre_grupo,
        descuento: `${descuento}%`,
        items_afectados: itemsAfectados,
        exceso_total_nota: itemsAfectados.reduce((s, i) => s + i.exceso_total, 0),
      })
    }
  }

  // 5. Resultado
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  AUDITORÍA BUG PRECIO — ${FECHA_INICIO} → ${FECHA_FIN}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  Notas con descuento modificadas en el rango : ${ordenes.length}`)
  console.log(`  Notas con ítems al precio incorrecto        : ${notasAfectadas.length}`)

  if (!notasAfectadas.length) {
    console.log('\n  ✅ No se encontraron ítems con precio inflado.\n')
    process.exit(0)
  }

  const totalExceso = notasAfectadas.reduce((s, n) => s + n.exceso_total_nota, 0)
  console.log(`  Exceso total cobrado (estimado)             : $${totalExceso.toFixed(2)}\n`)

  for (const nota of notasAfectadas) {
    console.log(`  📋 Folio #${nota.folio} — ${nota.cliente} (${nota.grupo}, ${nota.descuento} dto.)`)
    console.log(`     Exceso en esta nota: $${nota.exceso_total_nota.toFixed(2)}`)
    for (const i of nota.items_afectados) {
      console.log(
        `       • ${i.producto} [${i.seccion}]` +
        `  x${i.cantidad}  cobrado: $${i.precio_cobrado.toFixed(2)}` +
        `  correcto: $${i.precio_correcto.toFixed(2)}` +
        `  (+$${i.exceso_unitario.toFixed(2)}/u = $${i.exceso_total.toFixed(2)} total)`
      )
    }
    console.log()
  }
}

main().catch(err => {
  console.error('Error en auditoría:', err.message)
  process.exit(1)
})
