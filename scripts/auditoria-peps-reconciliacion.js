/**
 * auditoria-peps-reconciliacion.js — Parte A del plan H-5 Fase 4.
 *
 * Dos queries de SOLO LECTURA:
 *   1. ¿Existe alguna cadena de conversión PEPS de 2+ saltos hoy en producción?
 *      (peps-engine.ts la resuelve hasta 10 saltos; entradas.js/mermas.js solo 1)
 *   2. ¿Cuántas mermas históricas quedaron sin efecto real en inventario por el
 *      bug de mermas.js corregido en esta misma sesión (derivado con 0 stock
 *      propio, cobertura solo por base, consumo real nunca cruzaba la frontera)?
 *
 * Script de un solo uso, no se ejecuta en CI ni se referencia desde app.js.
 */

require('dotenv').config()
const { q } = require('../db/pool')

async function main () {
  console.log('=== 1. Cadenas de conversión multi-hop (excluyendo pares bidireccionales A↔B) ===')
  const conversiones = await q(`
    SELECT id_conversion, id_producto_derivado, id_producto_base, factor, id_grupo, activo
    FROM producto_conversion_peps
    WHERE activo = 1
  `)
  // Mapa derivado -> base (prioriza fila con id_grupo NULL como hace resolverCadenas)
  const baseDe = {}
  for (const c of conversiones) {
    const d = c.id_producto_derivado
    if (!baseDe[d] || c.id_grupo === null) baseDe[d] = c.id_producto_base
  }
  // Cadena real: derivado D -> base B, y B es a su vez derivado de un tercero C != D
  const cadenasReales = []
  for (const [d, b] of Object.entries(baseDe)) {
    const bNum = Number(b)
    if (baseDe[bNum] !== undefined && Number(baseDe[bNum]) !== Number(d)) {
      cadenasReales.push({ derivado: Number(d), base: bNum, base_del_base: Number(baseDe[bNum]) })
    }
  }
  console.log(`Total conversiones activas: ${conversiones.length}`)
  if (cadenasReales.length === 0) {
    console.log('✅ Ninguna cadena real de 2+ saltos (A→B→C con C≠A) — todo lo que parece multi-hop son pares bidireccionales A↔B, que ni siquiera el motor de Electron necesita resolver como cadena.')
  } else {
    console.log(`⚠️ ${cadenasReales.length} cadenas reales de 2+ saltos encontradas:`)
    console.table(cadenasReales)
  }

  console.log('\n=== 2. Mermas con posible efecto nulo (bug ya corregido) ===')
  // Mermas sobre productos que:
  //   a) tienen conversión a un producto base, Y
  //   b) al momento de la merma, el producto no tenía lotes propios activos
  //      suficientes para cubrir toda la cantidad (aproximación: comparamos
  //      cantidad_merma contra la suma de cantidad_consumida en merma_lote
  //      para esa merma — si es menor a cantidad_merma, hubo un faltante que
  //      el bug dejaba sin consumir de ningún lado antes del fix).
  const mermasAfectadas = await q(`
    SELECT
      m.id_merma, m.id_producto, p.nombre_producto, m.cantidad_merma,
      m.fecha_merma, m.usuario_registro,
      COALESCE(SUM(ml.cantidad_consumida), 0) AS total_consumido_lotes,
      cp.id_producto_base, pb.nombre_producto AS nombre_base
    FROM merma m
    INNER JOIN producto p ON p.id_producto = m.id_producto
    LEFT JOIN merma_lote ml ON ml.id_merma = m.id_merma
    LEFT JOIN producto_conversion_peps cp
      ON cp.id_producto_derivado = m.id_producto AND cp.activo = 1 AND cp.id_grupo IS NULL
    LEFT JOIN producto pb ON pb.id_producto = cp.id_producto_base
    WHERE m.activo = 1
    GROUP BY m.id_merma, m.id_producto, p.nombre_producto, m.cantidad_merma,
             m.fecha_merma, m.usuario_registro, cp.id_producto_base, pb.nombre_producto
    HAVING total_consumido_lotes < m.cantidad_merma - 0.001
    ORDER BY m.fecha_merma DESC
  `)
  console.log(`Total mermas con déficit de consumo real: ${mermasAfectadas.length}`)
  if (mermasAfectadas.length > 0) {
    console.table(mermasAfectadas.map(r => ({
      id_merma: r.id_merma, producto: r.nombre_producto, cantidad: r.cantidad_merma,
      consumido: r.total_consumido_lotes, faltante: (r.cantidad_merma - r.total_consumido_lotes).toFixed(4),
      tenia_conversion_a_base: r.id_producto_base ? `sí (${r.nombre_base})` : 'no',
      fecha: r.fecha_merma
    })))
  }

  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
