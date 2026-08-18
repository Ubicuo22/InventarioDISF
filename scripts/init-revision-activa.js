/**
 * Crea la tabla revision_activa (mutex bodega ↔ appweb).
 * Idempotente: no falla si ya existe.
 */
require('dotenv').config()
const mysql = require('mysql2/promise')

;(async () => {
  const conn = await mysql.createConnection({
    host:     process.env.TIDB_HOST,
    user:     process.env.TIDB_USER,
    password: process.env.TIDB_PASSWORD,
    database: process.env.TIDB_DATABASE,
    ssl:      { rejectUnauthorized: true },
  })

  await conn.execute(`
    CREATE TABLE IF NOT EXISTS revision_activa (
      id       INT         NOT NULL DEFAULT 1,
      activa   TINYINT     NOT NULL DEFAULT 0,
      inicio   DATETIME    NULL,
      usuario  VARCHAR(100) NULL,
      PRIMARY KEY (id),
      CONSTRAINT chk_singleton CHECK (id = 1)
    )
  `)

  const [rows] = await conn.execute('SELECT COUNT(*) AS n FROM revision_activa')
  if (rows[0].n === 0) {
    await conn.execute(
      'INSERT INTO revision_activa (id, activa) VALUES (1, 0)'
    )
    console.log('revision_activa: tabla creada e inicializada.')
  } else {
    console.log('revision_activa: ya existía — sin cambios.')
  }

  await conn.end()
})()
