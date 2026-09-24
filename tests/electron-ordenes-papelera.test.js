/**
 * tests/electron-ordenes-papelera.test.js — papelera de notas (24 sep 2026)
 *
 * Eliminar una nota ya no es un DELETE sin rastro: se copia completa a
 * ordenes_eliminadas con quién la eliminó (JWT) y qué admin autorizó
 * (re-verificado con bcrypt), se lista 7 días y se puede restaurar con su
 * mismo folio, volviendo a consumir PEPS.
 */

let mockUser = { id: 1, username: 'CAJERO1', nombre: 'Cajero Uno', rol: 'cajero' }

jest.mock('../db/pool', () => ({
  q: jest.fn(),
  pool: { execute: jest.fn(), getConnection: jest.fn() }
}))

jest.mock('../middleware/auth-electron', () => ({
  requireAuthElectron: (req, res, next) => { req.user = mockUser; next() },
  requireRoleElectron: (roles) => (req, res, next) => {
    req.user = mockUser
    if (!roles.includes(mockUser.rol)) return res.status(403).json({ ok: false, error: 'No tienes permisos para realizar esta acción.' })
    next()
  },
  invalidarCacheElectron: () => {},
  AUD: 'disfruleg-electron'
}))

jest.mock('../routes/electron/orden-consumo', () => ({
  consumirPepsParaOrden: jest.fn().mockResolvedValue(undefined),
  revertirConsumoOrden: jest.fn().mockResolvedValue(undefined),
  tieneConsumoOrden: jest.fn().mockResolvedValue(true),
}))

const bcrypt = require('bcryptjs')
const request = require('supertest')
const app = require('../app')
const { q, pool } = require('../db/pool')
const { consumirPepsParaOrden, revertirConsumoOrden } = require('../routes/electron/orden-consumo')

const HASH = bcrypt.hashSync('clave-admin', 4)

// q() y conn.execute() responden por patrón de SQL; lo no cubierto → []
function rutaQ(rutas) {
  q.mockImplementation(async (sql) => {
    const r = rutas.find(x => x.match.test(sql))
    return r ? r.rows : []
  })
}
function mockConn(rutas = []) {
  const conn = {
    execute: jest.fn(async (sql) => {
      const r = rutas.find(x => x.match.test(sql))
      return r ? [r.rows, []] : [{ affectedRows: 1, insertId: 1 }, []]
    }),
    beginTransaction: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
    release: jest.fn()
  }
  pool.getConnection.mockResolvedValue(conn)
  return conn
}
const llamadas = (conn, patron) => conn.execute.mock.calls.filter(c => patron.test(c[0]))
const ADMIN_OK = { match: /FROM usuarios_sistema WHERE UPPER\(username\)/, rows: [{ password_hash: HASH }] }

const ORDEN = {
  id_orden: 900, folio_numero: 3200, id_cliente: 7, usuario_creador: 'CAJERO1',
  datos_carrito: { FRUTA: [{ id_producto: 101, cantidad: 5 }], __historial__: [{ tipoEvento: 'creacion' }] },
  total_estimado: '150.00', estado: 'guardada', activo: 1,
  fecha_creacion: '2026-09-24 18:00:00', fecha_envio: null,
}

beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})
beforeEach(() => {
  jest.clearAllMocks()
  mockUser = { id: 1, username: 'CAJERO1', nombre: 'Cajero Uno', rol: 'cajero' }
})

describe('DELETE /api/electron/ordenes/:folio — a la papelera', () => {
  it('copia la nota completa con quién la eliminó y qué admin autorizó, y luego la borra', async () => {
    rutaQ([{ match: /SELECT estado FROM ordenes_guardadas/, rows: [{ estado: 'guardada' }] }, ADMIN_OK])
    const conn = mockConn([{ match: /SELECT \* FROM ordenes_guardadas/, rows: [ORDEN] }])

    const res = await request(app).delete('/api/electron/ordenes/3200')
      .send({ admin_usuario: 'ANTONIO', admin_password: 'clave-admin' })
    expect(res.body.ok).toBe(true)

    const [insert] = llamadas(conn, /INSERT INTO ordenes_eliminadas/)
    const [folio, idCliente, total, orden, eliminadoPor, autorizadoPor] = insert[1]
    expect([folio, idCliente, total]).toEqual([3200, 7, '150.00'])
    expect(JSON.parse(orden).datos_carrito.FRUTA[0].id_producto).toBe(101)
    expect(eliminadoPor).toBe('Cajero Uno')   // del JWT, nunca del body
    expect(autorizadoPor).toBe('ANTONIO')
    expect(revertirConsumoOrden).toHaveBeenCalled()
    // la copia va antes del DELETE, en la misma transacción
    const orden_sql = conn.execute.mock.calls.map(c => c[0])
    expect(orden_sql.findIndex(s => /INSERT INTO ordenes_eliminadas/.test(s)))
      .toBeLessThan(orden_sql.findIndex(s => /DELETE FROM ordenes_guardadas/.test(s)))
    expect(conn.commit).toHaveBeenCalled()
  })

  it('contraseña de admin incorrecta → 401 y no toca nada', async () => {
    rutaQ([ADMIN_OK])
    const res = await request(app).delete('/api/electron/ordenes/3200')
      .send({ admin_usuario: 'ANTONIO', admin_password: 'mala' })
    expect(res.status).toBe(401)
    expect(pool.getConnection).not.toHaveBeenCalled()
  })

  it('sin admin (Electron ≤ 10.0.6) sigue funcionando y deja autorizado_por en NULL', async () => {
    rutaQ([{ match: /SELECT estado FROM ordenes_guardadas/, rows: [{ estado: 'guardada' }] }])
    const conn = mockConn([{ match: /SELECT \* FROM ordenes_guardadas/, rows: [ORDEN] }])
    const res = await request(app).delete('/api/electron/ordenes/3200')
    expect(res.body.ok).toBe(true)
    const [insert] = llamadas(conn, /INSERT INTO ordenes_eliminadas/)
    expect(insert[1][4]).toBe('Cajero Uno')
    expect(insert[1][5]).toBeNull()
  })

  it('si falla la copia a la papelera, no se borra la nota (rollback)', async () => {
    rutaQ([{ match: /SELECT estado FROM ordenes_guardadas/, rows: [{ estado: 'guardada' }] }])
    const conn = mockConn([{ match: /SELECT \* FROM ordenes_guardadas/, rows: [ORDEN] }])
    const base = conn.execute.getMockImplementation()
    conn.execute.mockImplementation(async (sql, p) => {
      if (/INSERT INTO ordenes_eliminadas/.test(sql)) throw new Error("Table 'ordenes_eliminadas' doesn't exist")
      return base(sql, p)
    })
    const res = await request(app).delete('/api/electron/ordenes/3200')
    expect(res.status).toBe(500)
    expect(conn.rollback).toHaveBeenCalled()
    expect(conn.commit).not.toHaveBeenCalled()
  })
})

describe('GET /api/electron/ordenes/eliminadas', () => {
  it('lista solo los últimos 7 días, con quién, quién autorizó y cuándo expira', async () => {
    q.mockResolvedValueOnce([{ id: 1, folio_numero: 3200, eliminado_por: 'Cajero Uno', autorizado_por: 'ANTONIO' }])
    const res = await request(app).get('/api/electron/ordenes/eliminadas')
    expect(res.body.ok).toBe(true)
    expect(res.body.data).toHaveLength(1)
    const sql = q.mock.calls[0][0]
    expect(sql).toMatch(/INTERVAL 7 DAY/)
    expect(sql).toMatch(/eliminado_por/)
    expect(sql).toMatch(/AS expira/)
  })
})

describe('POST /api/electron/ordenes/eliminadas/:id/restaurar', () => {
  const EN_PAPELERA = { match: /FROM ordenes_eliminadas/, rows: [{ id: 5, folio_numero: 3200, orden: JSON.stringify(ORDEN) }] }

  it('exige contraseña de admin', async () => {
    rutaQ([ADMIN_OK])
    const res = await request(app).post('/api/electron/ordenes/eliminadas/5/restaurar')
      .send({ admin_usuario: 'ANTONIO', admin_password: 'mala' })
    expect(res.status).toBe(401)
    expect(pool.getConnection).not.toHaveBeenCalled()
  })

  it('reinserta la nota con su mismo folio, vuelve a consumir PEPS y la saca de la papelera', async () => {
    rutaQ([ADMIN_OK])
    const conn = mockConn([EN_PAPELERA, { match: /SELECT id_grupo FROM cliente/, rows: [{ id_grupo: 3 }] }])
    const res = await request(app).post('/api/electron/ordenes/eliminadas/5/restaurar')
      .send({ admin_usuario: 'ANTONIO', admin_password: 'clave-admin' })
    expect(res.body.ok).toBe(true)
    expect(res.body.data.folio_numero).toBe(3200)

    const [insert] = llamadas(conn, /INSERT INTO ordenes_guardadas/)
    const [idOrden, folio, idCliente, creador, carritoJson, total, fechaCreacion] = insert[1]
    expect([idOrden, folio, idCliente, creador, total, fechaCreacion])
      .toEqual([900, 3200, 7, 'CAJERO1', '150.00', '2026-09-24 18:00:00'])
    const carrito = JSON.parse(carritoJson)
    expect(carrito.__historial__.at(-1)).toMatchObject({ tipoEvento: 'restauracion', adminUsuario: 'ANTONIO' })
    expect(consumirPepsParaOrden).toHaveBeenCalledWith(conn, 3200, carrito, 3)
    expect(llamadas(conn, /DELETE FROM ordenes_eliminadas WHERE id = \?/)[0][1]).toEqual([5])
    expect(conn.commit).toHaveBeenCalled()
  })

  it('pasados 7 días ya no se puede restaurar', async () => {
    rutaQ([ADMIN_OK])
    const conn = mockConn([{ match: /FROM ordenes_eliminadas/, rows: [] }]) // el filtro de 7 días no la encuentra
    const res = await request(app).post('/api/electron/ordenes/eliminadas/5/restaurar')
      .send({ admin_usuario: 'ANTONIO', admin_password: 'clave-admin' })
    expect(res.body.ok).toBe(false)
    expect(res.body.error).toMatch(/7 días/)
    expect(llamadas(conn, /INSERT INTO ordenes_guardadas/)).toHaveLength(0)
  })

  it('no pisa una nota que ya exista con ese folio', async () => {
    rutaQ([ADMIN_OK])
    const conn = mockConn([EN_PAPELERA, { match: /SELECT 1 FROM ordenes_guardadas/, rows: [{ 1: 1 }] }])
    const res = await request(app).post('/api/electron/ordenes/eliminadas/5/restaurar')
      .send({ admin_usuario: 'ANTONIO', admin_password: 'clave-admin' })
    expect(res.body.ok).toBe(false)
    expect(llamadas(conn, /INSERT INTO ordenes_guardadas/)).toHaveLength(0)
    expect(consumirPepsParaOrden).not.toHaveBeenCalled()
  })
})
