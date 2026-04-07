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

  // Pool
  connectionLimit:    5,
  waitForConnections: true,
  queueLimit:         20,       // máx requests en cola antes de rechazar (evita colgar indefinidamente)

  // Keep-alive — previene que TiDB cierre conexiones inactivas silenciosamente
  enableKeepAlive:       true,
  keepAliveInitialDelay: 30000, // 30s — primer ping tras estar inactiva

  // Timeouts
  connectTimeout: 10000,        // 10s para establecer conexión (antes podía colgar 30s+)
})

// Errores que indican conexión muerta — vale la pena reintentar una vez
const RETRYABLE = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
  'EPIPE', 'PROTOCOL_CONNECTION_LOST', 'ER_SERVER_LOST'
])

/**
 * Ejecuta una query y retorna las filas.
 * Si la conexión estaba muerta (TiDB cerró la idle), reintenta automáticamente una vez.
 */
async function q(sql, params = []) {
  try {
    const [rows] = await pool.execute(sql, params)
    return rows
  } catch (err) {
    if (RETRYABLE.has(err.code)) {
      // Conexión muerta — el pool abrirá una nueva en el reintento
      const [rows] = await pool.execute(sql, params)
      return rows
    }
    throw err
  }
}

module.exports = { pool, q }
