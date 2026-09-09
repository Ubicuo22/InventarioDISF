/**
 * tests/electron-pagos.test.js — Pruebas de routes/electron/pagos.js
 *
 * H-5 Fase 3: pagos:registrar y pagos:registrarPorCliente migrados sin
 * respaldo local, gate de rol admin/supervisor/ceo (cajero fuera — decisión
 * de negocio del usuario, 9 sep 2026). Mismo patrón de mocks que
 * electron-ordenes.test.js (mockUser mutable + mockConn secuencial).
 */

let mockUser = { id: 1, username: 'TEST', nombre: 'Usuario de Prueba', rol: 'admin' }

jest.mock('../db/pool', () => ({
  q:    jest.fn(),
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

const request = require('supertest')
const app = require('../app')
const { pool } = require('../db/pool')

function mockConn(executeResponses = []) {
  const conn = {
    execute:          jest.fn(),
    beginTransaction: jest.fn().mockResolvedValue(undefined),
    commit:           jest.fn().mockResolvedValue(undefined),
    rollback:         jest.fn().mockResolvedValue(undefined),
    release:          jest.fn()
  }
  for (const resp of executeResponses) conn.execute.mockResolvedValueOnce(resp)
  conn.execute.mockResolvedValue([{ affectedRows: 1, insertId: 1 }, []])
  pool.getConnection.mockResolvedValue(conn)
  return conn
}

beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {})
})
beforeEach(() => {
  jest.clearAllMocks()
  mockUser = { id: 1, username: 'TEST', nombre: 'Usuario de Prueba', rol: 'admin' }
})

describe('POST /api/electron/pagos/registrar', () => {
  it('rechaza a cajero (403)', async () => {
    mockUser.rol = 'cajero'
    const res = await request(app).post('/api/electron/pagos/registrar').send({ idDeuda: 1, monto: 50, metodoPago: 'efectivo' })
    expect(res.status).toBe(403)
  })

  it('acepta a supervisor', async () => {
    mockUser.rol = 'supervisor'
    mockConn([
      [{ insertId: 10 }],
      [{ affectedRows: 1 }],
      [[{ id_cliente: 1, monto_pagado: '50.00', monto_total: '100.00' }]],
    ])
    const res = await request(app).post('/api/electron/pagos/registrar').send({ idDeuda: 1, monto: 50, metodoPago: 'efectivo' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('400 si falta idDeuda', async () => {
    const res = await request(app).post('/api/electron/pagos/registrar').send({ monto: 50, metodoPago: 'efectivo' })
    expect(res.status).toBe(400)
  })

  it('400 si el monto no es mayor a 0', async () => {
    const res = await request(app).post('/api/electron/pagos/registrar').send({ idDeuda: 1, monto: 0, metodoPago: 'efectivo' })
    expect(res.status).toBe(400)
  })

  it('admin: registra el pago, usuario_registro sale del JWT (no del body)', async () => {
    const conn = mockConn([
      [{ insertId: 10 }],
      [{ affectedRows: 1 }],
      [[{ id_cliente: 1, monto_pagado: '50.00', monto_total: '100.00' }]],
    ])
    const res = await request(app).post('/api/electron/pagos/registrar').send({
      idDeuda: 1, monto: 50, metodoPago: 'efectivo', usuario: 'alguien-que-no-soy'
    })
    expect(res.status).toBe(200)
    expect(res.body.data.id_pago).toBe(10)
    expect(res.body.data.credito_generado).toBeNull()

    const insertPago = conn.execute.mock.calls.find(c => /INSERT INTO pago_registrado/.test(c[0]))
    expect(insertPago[1]).toContain('Usuario de Prueba')
    expect(insertPago[1]).not.toContain('alguien-que-no-soy')
  })

  it('admin: inserta los comprobantes ya subidos (solo metadatos, sin recibir el archivo)', async () => {
    const conn = mockConn([
      [{ insertId: 10 }],
      [{ affectedRows: 1 }], // insert comprobante
      [{ affectedRows: 1 }], // update deudas
      [[{ id_cliente: 1, monto_pagado: '50.00', monto_total: '100.00' }]],
    ])
    const res = await request(app).post('/api/electron/pagos/registrar').send({
      idDeuda: 1, monto: 50, metodoPago: 'efectivo',
      comprobantes: [{ r2_key: 'k1', r2_url: 'https://r2/k1', nombre_archivo: 'ticket.png', tipo_archivo: 'image/png', tamano: 123 }]
    })
    expect(res.status).toBe(200)
    const insertAdjunto = conn.execute.mock.calls.find(c => /INSERT INTO pago_adjuntos/.test(c[0]))
    expect(insertAdjunto[1]).toEqual([10, 'ticket.png', 'image/png', 'k1', 'https://r2/k1', 123])
  })

  it('genera crédito por sobrepago', async () => {
    mockConn([
      [{ insertId: 10 }],
      [{ affectedRows: 1 }],
      [[{ id_cliente: 1, monto_pagado: '120.00', monto_total: '100.00' }]],
      [{ affectedRows: 1 }],
      [{ insertId: 99 }],
    ])
    const res = await request(app).post('/api/electron/pagos/registrar').send({ idDeuda: 1, monto: 120, metodoPago: 'efectivo' })
    expect(res.status).toBe(200)
    expect(res.body.data.credito_generado).toEqual({ monto: 20, id_credito: 99 })
  })

  it('500 y rollback si la BD falla', async () => {
    const conn = mockConn()
    conn.execute.mockReset()
    conn.execute.mockRejectedValue(new Error('boom'))
    const res = await request(app).post('/api/electron/pagos/registrar').send({ idDeuda: 1, monto: 50, metodoPago: 'efectivo' })
    expect(res.status).toBe(500)
    expect(conn.rollback).toHaveBeenCalled()
  })
})

describe('POST /api/electron/pagos/registrar-por-cliente', () => {
  it('rechaza a cajero (403)', async () => {
    mockUser.rol = 'cajero'
    const res = await request(app).post('/api/electron/pagos/registrar-por-cliente').send({
      idCliente: 1, montoTotal: 50, deudasSeleccionadas: [1], metodoPago: 'efectivo'
    })
    expect(res.status).toBe(403)
  })

  it('400 si no hay deudas seleccionadas', async () => {
    const res = await request(app).post('/api/electron/pagos/registrar-por-cliente').send({
      idCliente: 1, montoTotal: 50, deudasSeleccionadas: [], metodoPago: 'efectivo'
    })
    expect(res.status).toBe(400)
  })

  it('ok:false si ninguna deuda seleccionada es válida para el cliente', async () => {
    mockConn([[[]]])
    const res = await request(app).post('/api/electron/pagos/registrar-por-cliente').send({
      idCliente: 1, montoTotal: 50, deudasSeleccionadas: [1], metodoPago: 'efectivo'
    })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
  })

  it('ceo: distribuye el pago entre dos notas', async () => {
    mockUser.rol = 'ceo'
    const conn = mockConn([
      [[
        { id_deuda: 1, monto_total: '50.00', monto_pagado: '0.00', saldo_pendiente: '50.00' },
        { id_deuda: 2, monto_total: '50.00', monto_pagado: '0.00', saldo_pendiente: '50.00' },
      ]],
      [{ insertId: 20 }],
      [{ affectedRows: 1 }],
      [{ insertId: 21 }],
      [{ affectedRows: 1 }],
    ])
    const res = await request(app).post('/api/electron/pagos/registrar-por-cliente').send({
      idCliente: 1, montoTotal: 100, deudasSeleccionadas: [1, 2], metodoPago: 'efectivo'
    })
    expect(res.status).toBe(200)
    expect(res.body.data.pagos).toHaveLength(2)
    expect(res.body.data.total_distribuido).toBe(100)
    expect(res.body.data.credito_generado).toBeNull()

    const insertPagos = conn.execute.mock.calls.filter(c => /INSERT INTO pago_registrado/.test(c[0]))
    expect(insertPagos).toHaveLength(2)
    expect(insertPagos[0][1]).toContain('Usuario de Prueba')
  })

  it('genera crédito por el excedente cuando el monto supera lo seleccionado', async () => {
    mockConn([
      [[{ id_deuda: 1, monto_total: '50.00', monto_pagado: '0.00', saldo_pendiente: '50.00' }]],
      [{ insertId: 20 }],
      [{ affectedRows: 1 }],
      [{ insertId: 99 }],
    ])
    const res = await request(app).post('/api/electron/pagos/registrar-por-cliente').send({
      idCliente: 1, montoTotal: 70, deudasSeleccionadas: [1], metodoPago: 'efectivo'
    })
    expect(res.status).toBe(200)
    expect(res.body.data.credito_generado).toEqual({ monto: 20, id_credito: 99 })
  })

  it('500 y rollback si la BD falla', async () => {
    const conn = mockConn()
    conn.execute.mockReset()
    conn.execute.mockRejectedValue(new Error('boom'))
    const res = await request(app).post('/api/electron/pagos/registrar-por-cliente').send({
      idCliente: 1, montoTotal: 50, deudasSeleccionadas: [1], metodoPago: 'efectivo'
    })
    expect(res.status).toBe(500)
    expect(conn.rollback).toHaveBeenCalled()
  })
})
