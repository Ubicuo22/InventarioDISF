/**
 * db/pool.js — Pool de conexiones a TiDB Cloud
 * Exporta `q(sql, params)` para queries simples
 */

const mysql = require('mysql2/promise')

const pool = mysql.createPool({
  host:     process.env.TIDB_HOST,
  port:     parseInt(process.env.TIDB_PORT || '4000'),
  user:     process.env.TIDB_USER,
  password: process.env.TIDB_PASSWORD,
  database: process.env.TIDB_DATABASE,
  ssl: { rejectUnauthorized: true },
  timezone: '-06:00',
  connectionLimit: 5,
  waitForConnections: true,
  enableKeepAlive: true
})

/**
 * Ejecuta una query y retorna las filas
 */
async function q(sql, params = []) {
  const [rows] = await pool.execute(sql, params)
  return rows
}

module.exports = { pool, q }
