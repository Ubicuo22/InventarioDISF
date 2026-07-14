/**
 * db/pool.js — Pool de conexiones a TiDB Cloud
 * Exporta `q(sql, params)` para queries simples y `pool` (execute/query/getConnection).
 *
 * Dos modos:
 *   Node (Mac Mini)      — un pool global persistente, como siempre.
 *   Cloudflare Workers   — un pool POR REQUEST via AsyncLocalStorage, porque
 *                          Workers prohíbe reutilizar sockets creados en el
 *                          contexto de otro request ("Cannot perform I/O on
 *                          behalf of a different request"). worker.js envuelve
 *                          cada request/cron con `conContextoDb()`.
 */

const mysql = require('mysql2/promise')

const esWorkers = globalThis.navigator?.userAgent === 'Cloudflare-Workers'

const CONFIG = {
  host:     process.env.TIDB_HOST,
  port:     parseInt(process.env.TIDB_PORT || '4000'),
  user:     process.env.TIDB_USER,
  password: process.env.TIDB_PASSWORD,
  database: process.env.TIDB_DATABASE,
  ssl: { rejectUnauthorized: true },
  timezone: '-06:00',

  // Workers prohíbe eval/new Function; mysql2 usa parsers estáticos con esto.
  disableEval: true,

  // Pool — se sube porque /api/dashboard/metricas-hoy hace ~17 queries en paralelo
  // más las ~6 llamadas simultáneas de cargarTodo en startup (total ~23 concurrent).
  // TiDB Cloud Serverless soporta ≥25 conexiones; usamos 15 para tener margen.
  connectionLimit:    15,
  waitForConnections: true,
  queueLimit:         60,       // máx requests en cola antes de rechazar

  // Keep-alive — previene que TiDB cierre conexiones inactivas silenciosamente
  enableKeepAlive:       true,
  keepAliveInitialDelay: 30000, // 30s — primer ping tras estar inactiva

  // Timeouts
  connectTimeout: 10000,        // 10s para establecer conexión (antes podía colgar 30s+)
}

// Errores que indican conexión muerta — vale la pena reintentar una vez
const RETRYABLE = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
  'EPIPE', 'PROTOCOL_CONNECTION_LOST', 'ER_SERVER_LOST'
])

let pool
let conContextoDb

if (!esWorkers) {
  // ── Node: pool global persistente ─────────────────────────
  pool = mysql.createPool(CONFIG)
  conContextoDb = (fn) => fn()
} else {
  // ── Workers: pool por request ──────────────────────────────
  const { AsyncLocalStorage } = require('node:async_hooks')
  const als = new AsyncLocalStorage()

  const poolActual = () => {
    const store = als.getStore()
    if (!store) throw new Error('Query fuera de contexto de request (falta conContextoDb)')
    if (!store.pool) {
      // La config de config vive en process.env, poblado por los secrets del Worker
      store.pool = mysql.createPool({ ...CONFIG, connectionLimit: 6, keepAliveInitialDelay: 5000 })
    }
    return store.pool
  }

  // Mismo API que el pool real — delega al pool del request en curso
  pool = new Proxy({}, {
    get(_, prop) {
      const p = poolActual()
      const valor = p[prop]
      return typeof valor === 'function' ? valor.bind(p) : valor
    }
  })

  /**
   * Ejecuta fn dentro de un contexto con pool propio y lo cierra al terminar.
   * pool.end() espera a que las queries en vuelo terminen antes de cerrar.
   */
  conContextoDb = async (fn) => {
    const store = {}
    try {
      return await als.run(store, fn)
    } finally {
      if (store.pool) store.pool.end().catch(() => {})
    }
  }
}

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

module.exports = { pool, q, conContextoDb }
