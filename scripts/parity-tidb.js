#!/usr/bin/env node
/**
 * scripts/parity-tidb.js — Paridad mysql2 vs @tidbcloud/serverless
 *
 * Corre ~30 SELECTs representativos (lifted de dashboard.js, deudas.js,
 * analytics.js, productos.js, ordenes.js, electron/ordenes.js) contra
 * TiDB real por AMBOS drivers, y compara la salida JSON byte a byte.
 *
 * Por qué existe: los 12 archivos de test que mockean db/pool.js seguirían
 * en verde aunque la implementación HTTP fuera incorrecta — no dan ninguna
 * protección real contra diferencias de tipo del driver nuevo. Este script
 * sí prueba contra la BD real.
 *
 * La config `decoders` de abajo es la misma que se piensa poner en
 * db/pool.js — este script prueba que funciona ANTES de comprometerla ahí.
 *
 * Uso: node scripts/parity-tidb.js
 * Solo lectura — no escribe nada. Requiere .env con TIDB_*.
 */

require('dotenv').config()
const mysql = require('mysql2/promise')
const { connect } = require('@tidbcloud/serverless')

const MYSQL_CFG = {
  host: process.env.TIDB_HOST,
  port: parseInt(process.env.TIDB_PORT || '4000'),
  user: process.env.TIDB_USER,
  password: process.env.TIDB_PASSWORD,
  database: process.env.TIDB_DATABASE,
  ssl: { rejectUnauthorized: true },
  timezone: '-06:00',
  disableEval: true,
}

// Decoders de compatibilidad — reproducen EXACTAMENTE lo que mysql2 devuelve
// con timezone:'-06:00'. Ver plan de sesión (Fase 1) para el porqué de cada
// uno: BIGINT llega como string del driver HTTP (mysql2 lo da como número,
// típico de COUNT(*)); DATE/DATETIME/TIMESTAMP llegan como string crudo sin
// zona (mysql2 da un objeto Date con la zona ya aplicada).
const DECODERS = {
  BIGINT: (v) => Number(v),
  'UNSIGNED BIGINT': (v) => Number(v),
  DATE: (v) => (v == null ? v : new Date(v + 'T00:00:00-06:00')),
  DATETIME: (v) => (v == null ? v : new Date(v.replace(' ', 'T') + '-06:00')),
  TIMESTAMP: (v) => (v == null ? v : new Date(v.replace(' ', 'T') + '-06:00')),
}

const HTTP_CFG = {
  host: process.env.TIDB_HOST,
  username: process.env.TIDB_USER,
  password: process.env.TIDB_PASSWORD,
  database: process.env.TIDB_DATABASE,
  decoders: DECODERS,
}

// ── Casos de prueba — SQL real lifted de las rutas, parametrizado con
// fechas relativas a hoy para que el script siga siendo útil con el tiempo ──

function hoyMX() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })
}
function haceDias(n) {
  return new Date(Date.now() - n * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })
}

const CASOS = [
  // COUNT(*) simple — el caso que expuso que BIGINT llega como string
  { nombre: 'COUNT(*) productos', sql: 'SELECT COUNT(*) AS total FROM producto', params: [] },
  { nombre: 'COUNT(*) ordenes activas', sql: `SELECT COUNT(*) AS total FROM ordenes_guardadas WHERE activo = 1`, params: [] },

  // COUNT con rango de fecha (dashboard.js) — money-adjacent
  {
    nombre: 'COUNT pedidos rango fecha',
    sql: `SELECT COUNT(*) AS total FROM ordenes_guardadas WHERE fecha_creacion >= ? AND fecha_creacion < ? AND activo = 1`,
    params: [haceDias(1), hoyMX()],
  },

  // SUM sobre DECIMAL (dashboard.js) — money-critical
  {
    nombre: 'SUM total_con_impuestos (compras de ayer)',
    sql: `SELECT COALESCE(SUM(total_con_impuestos), 0) AS total_gasto FROM compra WHERE DATE(fecha_registro) = ?`,
    params: [haceDias(1)],
  },

  // Deudas — stats con money + fecha (deudas.js)
  {
    nombre: 'Deudas: total y saldo pendiente',
    sql: `SELECT COUNT(*) AS total, COALESCE(SUM(monto_total - monto_pagado), 0) AS saldo_total
          FROM deudas WHERE pagado = 0`,
    params: [],
  },
  {
    nombre: 'Deudas: filas con fecha_generada, montos y LEFT JOIN cliente/grupo',
    sql: `SELECT d.id_deuda, d.id_factura, d.nombre_cliente, d.monto_total, d.monto_pagado,
                 (d.monto_total - d.monto_pagado) AS saldo_pendiente, d.fecha_generada, d.metodo_pago,
                 COALESCE(c.telefono, '') AS telefono
          FROM deudas d
          LEFT JOIN cliente c ON d.id_cliente = c.id_cliente
          ORDER BY d.fecha_generada DESC LIMIT 5`,
    params: [],
  },

  // JSON column (datos_carrito) + fecha_creacion + activo (TINYINT-ish flag)
  {
    nombre: 'Ordenes: datos_carrito (JSON) + fecha_creacion + activo',
    sql: `SELECT folio_numero, datos_carrito, fecha_creacion, activo, estado
          FROM ordenes_guardadas WHERE activo = 1 ORDER BY folio_numero DESC LIMIT 5`,
    params: [],
  },

  // DATETIME/TIMESTAMP explícito
  {
    nombre: 'Ordenes: fecha_modificacion, editing_at (DATETIME nullable)',
    sql: `SELECT folio_numero, fecha_modificacion, editing_at, editing_by
          FROM ordenes_guardadas ORDER BY folio_numero DESC LIMIT 5`,
    params: [],
  },

  // LEFT JOIN con NULLs (proveedor puede no existir)
  {
    nombre: 'Compras con proveedor (LEFT JOIN, NULLs esperados)',
    sql: `SELECT c.id_compra, c.fecha_compra, c.total_con_impuestos, prov.nombre_proveedor
          FROM compra c LEFT JOIN proveedor prov ON c.id_proveedor = prov.id_proveedor
          ORDER BY c.id_compra DESC LIMIT 10`,
    params: [],
  },

  // Productos: stock (DECIMAL), activo (TINYINT flag) (productos.js)
  {
    nombre: 'Productos activos con stock',
    sql: `SELECT id_producto, numero_producto, nombre_producto, unidad_producto, stock, activo
          FROM producto WHERE activo = 1 ORDER BY id_producto DESC LIMIT 10`,
    params: [],
  },

  // Analytics: agregación por fecha con DECIMAL
  {
    nombre: 'Analytics: ventas por factura en rango',
    sql: `SELECT f.id_factura, DATE(f.fecha_factura) AS fecha, f.id_cliente
          FROM factura f WHERE DATE(f.fecha_factura) BETWEEN ? AND ? LIMIT 20`,
    params: [haceDias(30), hoyMX()],
  },

  // NOW()/CURDATE() — confirma que el reloj de sesión no diverge entre drivers
  { nombre: 'NOW() y CURDATE()', sql: 'SELECT NOW() AS ahora, CURDATE() AS hoy', params: [] },
]

// ── Runner ──────────────────────────────────────────────────────────────

function normalizar(rows) {
  // Los objetos Date no sobreviven JSON.stringify igual que un string plano
  // sin normalizar primero — ambos drivers deben producir el mismo ISO.
  return JSON.stringify(rows, (_, v) => (v instanceof Date ? v.toISOString() : v))
}

async function main() {
  const mysqlPool = mysql.createPool(MYSQL_CFG)
  const httpConn = connect(HTTP_CFG)

  let fallos = 0
  for (const caso of CASOS) {
    process.stdout.write(`▶ ${caso.nombre} … `)
    try {
      const [myRows] = await mysqlPool.execute(caso.sql, caso.params)
      const httpRows = await httpConn.execute(caso.sql, caso.params.length ? caso.params : null)

      const myJson = normalizar(myRows)
      const httpJson = normalizar(httpRows)

      if (myJson === httpJson) {
        console.log('✅')
      } else {
        fallos++
        console.log('❌ DIFERENTE')
        console.log('  mysql2:', myJson.slice(0, 400))
        console.log('  http  :', httpJson.slice(0, 400))
      }
    } catch (e) {
      fallos++
      console.log('❌ ERROR:', e.message)
    }
  }

  await mysqlPool.end()

  console.log(`\n${CASOS.length - fallos}/${CASOS.length} casos iguales.`)
  if (fallos > 0) {
    console.error(`\n❌ ${fallos} caso(s) con diferencias — no activar DB_HTTP_Q hasta resolver.`)
    process.exit(1)
  }
  console.log('\n✅ Paridad confirmada — el shim de db/pool.js puede proceder.')
}

main().catch((e) => {
  console.error('❌ Error fatal:', e)
  process.exit(1)
})
