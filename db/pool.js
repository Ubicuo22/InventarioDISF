/**
 * db/pool.js — Acceso a TiDB Cloud
 * Exporta `q(sql, params)` para queries simples y `pool` (execute/query/getConnection).
 *
 * `q()` tiene dos implementaciones, elegidas por request vía `DB_HTTP_Q`:
 *   - mysql2 (de siempre) — TCP, pool por request en Workers (ver abajo).
 *   - @tidbcloud/serverless (HTTP, sin TCP) — sin pool-por-request, sin el
 *     handshake TLS que causaba 503 esporádicos en Workers. Ver
 *     scripts/parity-tidb.js para la validación de que ambos drivers
 *     devuelven exactamente la misma forma de datos.
 * `DB_HTTP_Q`: unset (default, mysql2 para todo) | 'read' (HTTP solo para
 * SELECT/WITH/SHOW/DESCRIBE/EXPLAIN) | 'all' (HTTP también para escrituras).
 * `pool`/`conContextoDb` (transacciones manuales) siguen en mysql2 siempre —
 * fuera de alcance de esta fase.
 *
 * Dos modos para `pool` (sin cambios):
 *   Node (Mac Mini)      — un pool global persistente, como siempre.
 *   Cloudflare Workers   — un pool POR REQUEST via AsyncLocalStorage, porque
 *                          Workers prohíbe reutilizar sockets creados en el
 *                          contexto de otro request ("Cannot perform I/O on
 *                          behalf of a different request"). worker.js envuelve
 *                          cada request/cron con `conContextoDb()`.
 */

const mysql = require('mysql2/promise')
const { connect: connectHttp, DatabaseError } = require('@tidbcloud/serverless')

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
 * Ejecuta una query por mysql2 (TCP) y retorna las filas.
 * Si la conexión estaba muerta (TiDB cerró la idle), reintenta automáticamente una vez.
 */
async function qMysql(sql, params = []) {
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

// ── Driver HTTP (@tidbcloud/serverless) — sin TCP, sin pool-por-request ──

const READ_SQL = /^\s*(SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i

// Decoders para que la salida de q() sea idéntica byte a byte a la de
// mysql2 con timezone:'-06:00' (verificado contra TiDB real en
// scripts/parity-tidb.js), mientras este driver convive con `pool`
// (mysql2, transacciones manuales, sin tocar en esta fase). Sin esto:
// COUNT(*)/BIGINT llegan como string, no número, y las fechas llegan como
// string plano sin objeto Date.
const HTTP_DECODERS = {
  BIGINT: Number,
  'UNSIGNED BIGINT': Number,
  DATE: (v) => new Date(v + 'T00:00:00-06:00'),
  DATETIME: (v) => new Date(v.replace(' ', 'T') + '-06:00'),
  TIMESTAMP: (v) => new Date(v.replace(' ', 'T') + '-06:00'),
}

let httpConn
function conexionHttp() {
  // connect() no abre un socket — es config para fetch por-query, se puede
  // compartir entre requests de Workers sin el problema de "I/O de otro
  // request" que obliga al pool-por-request de mysql2.
  if (!httpConn) {
    httpConn = connectHttp({
      host: process.env.TIDB_HOST,
      username: process.env.TIDB_USER,
      password: process.env.TIDB_PASSWORD,
      database: process.env.TIDB_DATABASE,
      decoders: HTTP_DECODERS,
    })
  }
  return httpConn
}

/**
 * Ejecuta una query por HTTP y retorna las filas.
 * Reproduce el contrato de mysql2: SELECT → array de filas; escritura →
 * array (vacío o no) con `.insertId`/`.affectedRows` no-enumerables, para
 * que `res.json(rows)` siga serializando como array plano y el único call
 * site que usa `.insertId` (routes/productos.js) siga funcionando.
 */
async function qHttp(sql, params = []) {
  // mysql2 lanza si un bind es undefined — es una protección real (evita
  // escribir/filtrar con un dato faltante); el driver HTTP lo convierte en
  // NULL en silencio, así que lo reproducimos a mano.
  for (const p of params) {
    if (p === undefined) {
      throw new TypeError('Bind parameters must not contain undefined. To pass SQL NULL specify JS null')
    }
  }

  const conn = conexionHttp()
  const esLectura = READ_SQL.test(sql)
  const ejecutar = () => conn.execute(sql, params.length ? params : null, { fullResult: true })

  let r
  try {
    r = await ejecutar()
  } catch (err) {
    // Nunca reintentar una escritura — un 5xx después de que la sentencia ya
    // corrió del lado del servidor podría duplicarla si se reintenta a ciegas.
    const reintentable = esLectura && (!(err instanceof DatabaseError) || err.status === 429 || err.status >= 500)
    if (!reintentable) throw err
    r = await ejecutar()
  }

  const rows = r.rows || []
  Object.defineProperty(rows, 'insertId', {
    value: r.lastInsertId != null ? Number(r.lastInsertId) : undefined,
    enumerable: false,
  })
  Object.defineProperty(rows, 'affectedRows', {
    value: r.rowsAffected ?? 0,
    enumerable: false,
  })
  return rows
}

/**
 * Ejecuta una query y retorna las filas. Elige el driver según `DB_HTTP_Q`
 * (unset = mysql2 para todo; 'read' = HTTP solo lecturas; 'all' = HTTP
 * también escrituras) — ver cabecera del archivo.
 */
async function q(sql, params = []) {
  const modo = process.env.DB_HTTP_Q
  if (modo === 'all' || (modo === 'read' && READ_SQL.test(sql))) {
    return qHttp(sql, params)
  }
  return qMysql(sql, params)
}

// Heartbeat: pinga TiDB cada 90s para mantener conexiones vivas dentro
// del idle timeout de MySQL (~300s en TiDB Cloud Serverless). El TCP keepAlive
// del config solo previene cierres a nivel de socket, no el idle timeout
// de la capa MySQL. En Workers no hay timers persistentes, se omite.
if (!esWorkers) {
  setInterval(async () => {
    try {
      await pool.query('SELECT 1')
    } catch {
      // Si el ping falla, el pool creará conexiones nuevas en el siguiente request.
    }
  }, 90_000)
}

module.exports = { pool, q, conContextoDb }
