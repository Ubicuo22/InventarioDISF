/**
 * tests/entradas.test.js — Pruebas de routes/entradas.js
 *
 * Cubre:
 *   • GET /peps-info/:id  — estructura derivados / esDerivado
 *   • GET /lotes/:id      — lotes PEPS activos
 *   • GET /recientes      — últimas entradas
 *   • POST /              — validaciones + happy path con transacción
 *   • GET /conteo-fisico/estado — productos con verificaciones
 *   • POST /ajuste-inventario   — validaciones + delta positivo / negativo
 */

jest.mock('../db/pool', () => ({
  q:    jest.fn(),
  pool: { getConnection: jest.fn(), execute: jest.fn() }
}))

jest.mock('../middleware/auth', () => ({
  requireAuth:   (req, res, next) => { req.user = { rol: 'admin', username: 'test' }; next() },
  requireAdmin:  (req, res, next) => next(),
  requireModulo: () => (req, res, next) => next()
}))

jest.mock('../utils/actividad', () => ({ registrar: jest.fn() }))
jest.mock('../utils/push',      () => ({ enviarATodos: jest.fn().mockResolvedValue({ enviados: 0, total: 0 }) }))
jest.mock('../utils/fecha',     () => ({ fechaMexico: jest.fn().mockReturnValue('2026-08-17') }))

const request = require('supertest')
const app     = require('../app')
const { q, pool } = require('../db/pool')

// ── Mock de conexión con transacción ────────────────────────

function mockConn(executeResponses = []) {
  const conn = {
    execute:          jest.fn(),
    beginTransaction: jest.fn().mockResolvedValue(undefined),
    commit:           jest.fn().mockResolvedValue(undefined),
    rollback:         jest.fn().mockResolvedValue(undefined),
    release:          jest.fn()
  }
  // Carga respuestas en orden; el default es una fila vacía
  for (const resp of executeResponses) {
    conn.execute.mockResolvedValueOnce(resp)
  }
  conn.execute.mockResolvedValue([[], []])  // fallback
  pool.getConnection.mockResolvedValue(conn)
  return conn
}

beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {})
  jest.spyOn(console, 'log').mockImplementation(() => {})
})

beforeEach(() => jest.clearAllMocks())

// ─── GET /api/entradas/peps-info/:id ─────────────────────────

describe('GET /api/entradas/peps-info/:id', () => {
  it('devuelve derivados y esDerivado null cuando no hay conversión inversa', async () => {
    q
      .mockResolvedValueOnce([{ id_producto: 5, nombre_producto: 'Jugo Naranja', factor: 4 }])
      .mockResolvedValueOnce([])
    const res = await request(app).get('/api/entradas/peps-info/1')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.derivados).toHaveLength(1)
    expect(res.body.esDerivado).toBeNull()
  })

  it('devuelve esDerivado cuando el producto es derivado de otro', async () => {
    q
      .mockResolvedValueOnce([])  // no tiene derivados
      .mockResolvedValueOnce([{ id_producto: 10, nombre_producto: 'Naranja Base', factor: 0.25 }])
    const res = await request(app).get('/api/entradas/peps-info/5')
    expect(res.body.derivados).toHaveLength(0)
    expect(res.body.esDerivado).toMatchObject({ id_producto: 10, nombre_producto: 'Naranja Base' })
  })

  it('responde 500 si la BD falla', async () => {
    q.mockRejectedValue(new Error('DB error'))
    const res = await request(app).get('/api/entradas/peps-info/1')
    expect(res.status).toBe(500)
  })
})

// ─── GET /api/entradas/lotes/:id ─────────────────────────────

describe('GET /api/entradas/lotes/:id', () => {
  it('devuelve los lotes en orden PEPS', async () => {
    q.mockResolvedValue([
      { id_inventario_peps: 1, cantidad_inicial: 10, cantidad_restante: 6 },
      { id_inventario_peps: 2, cantidad_inicial: 8,  cantidad_restante: 8 }
    ])
    const res = await request(app).get('/api/entradas/lotes/3')
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
    expect(res.body.data[0].id_inventario_peps).toBe(1)
  })

  it('devuelve array vacío cuando no hay lotes', async () => {
    q.mockResolvedValue([])
    const res = await request(app).get('/api/entradas/lotes/99')
    expect(res.body.data).toEqual([])
  })

  it('responde 500 si la BD falla', async () => {
    q.mockRejectedValue(new Error('DB error'))
    const res = await request(app).get('/api/entradas/lotes/1')
    expect(res.status).toBe(500)
  })
})

// ─── GET /api/entradas/recientes ─────────────────────────────

describe('GET /api/entradas/recientes', () => {
  it('devuelve las últimas entradas', async () => {
    q.mockResolvedValue([
      { id_compra: 1, nombre_producto: 'Manzana', cantidad_compra: 10 }
    ])
    const res = await request(app).get('/api/entradas/recientes')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data).toHaveLength(1)
  })

  it('SQL excluye phantoms de la consulta', async () => {
    q.mockResolvedValue([])
    await request(app).get('/api/entradas/recientes')
    const sql = q.mock.calls[0][0]
    expect(sql).toMatch(/PHANTOM/)
    expect(sql).toMatch(/NOT LIKE/)
  })
})

// ─── POST /api/entradas — validaciones ───────────────────────

describe('POST /api/entradas — validaciones', () => {
  it('responde 400 sin idProducto', async () => {
    const res = await request(app).post('/api/entradas').send({ cantidad: 5, precio: 10, fechaCompra: '2026-08-17' })
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
  })

  it('responde 400 sin cantidad', async () => {
    const res = await request(app).post('/api/entradas').send({ idProducto: 1, precio: 10, fechaCompra: '2026-08-17' })
    expect(res.status).toBe(400)
  })

  it('responde 400 sin precio', async () => {
    const res = await request(app).post('/api/entradas').send({ idProducto: 1, cantidad: 5, fechaCompra: '2026-08-17' })
    expect(res.status).toBe(400)
  })

  it('responde 400 sin fechaCompra', async () => {
    const res = await request(app).post('/api/entradas').send({ idProducto: 1, cantidad: 5, precio: 10 })
    expect(res.status).toBe(400)
  })

  it('responde 400 con cantidad = 0', async () => {
    const conn = mockConn()
    const res = await request(app).post('/api/entradas').send({ idProducto: 1, cantidad: 0, precio: 10, fechaCompra: '2026-08-17' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/cantidad/i)
    expect(conn.rollback).not.toHaveBeenCalled()
  })

  it('responde 400 con cantidad negativa', async () => {
    const conn = mockConn()
    const res = await request(app).post('/api/entradas').send({ idProducto: 1, cantidad: -3, precio: 10, fechaCompra: '2026-08-17' })
    expect(res.status).toBe(400)
  })

  it('responde 400 con precio negativo', async () => {
    const conn = mockConn()
    const res = await request(app).post('/api/entradas').send({ idProducto: 1, cantidad: 5, precio: -1, fechaCompra: '2026-08-17' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/precio/i)
  })

  it('responde 400 cuando el producto no existe o está inactivo', async () => {
    const conn = mockConn([
      [[], []]  // producto check → sin resultados
    ])
    const res = await request(app).post('/api/entradas').send({ idProducto: 999, cantidad: 5, precio: 10, fechaCompra: '2026-08-17' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/producto/i)
  })
})

// ─── POST /api/entradas — happy path ─────────────────────────

describe('POST /api/entradas — registro exitoso', () => {
  it('crea compra + lote + actualiza stock y devuelve ok:true', async () => {
    const conn = mockConn([
      [[{ id_producto: 1 }], []],   // producto check
      [{ insertId: 10 }, []],        // INSERT compra
      [{ insertId: 11 }, []],        // INSERT inventario_peps
      [[], []],                       // SELECT phantoms (sin phantoms)
      [{ affectedRows: 1 }, []]      // UPDATE producto stock
    ])
    q.mockResolvedValue([{ nombre_producto: 'Naranja', unidad_producto: 'kg' }])

    const res = await request(app).post('/api/entradas').send({
      idProducto: 1, cantidad: 5, precio: 23.2, fechaCompra: '2026-08-17'
    })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.idCompra).toBe(10)
    expect(res.body.data.cantidad).toBe(5)
    expect(conn.beginTransaction).toHaveBeenCalled()
    expect(conn.commit).toHaveBeenCalled()
    expect(conn.release).toHaveBeenCalled()
  })

  it('descuenta deuda de phantoms cuando existen', async () => {
    const conn = mockConn([
      [[{ id_producto: 1 }], []],            // producto check
      [{ insertId: 20 }, []],                 // INSERT compra
      [{ insertId: 21 }, []],                 // INSERT inventario_peps
      [[{                                     // SELECT phantoms → un phantom pendiente
        id_compra: 5, cantidad_compra: 3,
        notas: 'PHANTOM:GUARDADAS', incluye_iva: 0
      }], []],
      [{ affectedRows: 1 }, []],              // UPDATE phantom notas/precio
      [{ affectedRows: 1 }, []],              // UPDATE peps costo phantom
      [{ affectedRows: 1 }, []],              // UPDATE cantidad_restante lote nuevo
      [{ affectedRows: 1 }, []]              // UPDATE producto stock
    ])
    q.mockResolvedValue([{ nombre_producto: 'Naranja', unidad_producto: 'kg' }])

    const res = await request(app).post('/api/entradas').send({
      idProducto: 1, cantidad: 10, precio: 20, fechaCompra: '2026-08-17'
    })

    expect(res.status).toBe(200)
    // 3 unidades se fueron a cubrir el phantom
    expect(res.body.data.reconciliado).toBe(3)
    expect(res.body.data.disponible).toBe(7)
  })

  it('hace rollback si la BD falla durante la transacción', async () => {
    const conn = mockConn([
      [[{ id_producto: 1 }], []]  // producto check OK
    ])
    conn.execute.mockRejectedValueOnce(new Error('DB crash')) // siguiente falla

    const res = await request(app).post('/api/entradas').send({
      idProducto: 1, cantidad: 5, precio: 10, fechaCompra: '2026-08-17'
    })

    expect(res.status).toBe(500)
    expect(conn.rollback).toHaveBeenCalled()
    expect(conn.release).toHaveBeenCalled()
  })

  it('calcula precio sin IVA correctamente cuando incluirIva=true', async () => {
    const conn = mockConn([
      [[{ id_producto: 1 }], []],
      [{ insertId: 30 }, []],
      [{ insertId: 31 }, []],
      [[], []],
      [{ affectedRows: 1 }, []]
    ])
    q.mockResolvedValue([{ nombre_producto: 'X', unidad_producto: 'kg' }])

    await request(app).post('/api/entradas').send({
      idProducto: 1, cantidad: 1, precio: 116, fechaCompra: '2026-08-17', incluirIva: true
    })

    // Precio con IVA = 116 → precio sin IVA = 116/1.16 = 100
    const insertCompraCall = conn.execute.mock.calls.find(c => c[0].includes('INSERT INTO compra'))
    const precioUnitario = insertCompraCall[1][3]  // 4to parámetro = precio_unitario_compra
    expect(precioUnitario).toBeCloseTo(100, 2)
  })
})

// ─── GET /api/entradas/conteo-fisico/estado ──────────────────

describe('GET /api/entradas/conteo-fisico/estado', () => {
  it('devuelve productos combinados con verificaciones del día', async () => {
    q
      .mockResolvedValueOnce([
        { id_producto: 1, nombre_producto: 'Manzana', unidad_producto: 'kg', stock: 10 },
        { id_producto: 2, nombre_producto: 'Naranja', unidad_producto: 'kg', stock: 5  }
      ])
      .mockResolvedValueOnce([
        { id_producto: 1, cantidad_fisica: 9, cantidad_sistema: 10, delta: -1, usuario: 'test', fecha: '2026-08-17' }
      ])

    const res = await request(app).get('/api/entradas/conteo-fisico/estado')
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
    // Manzana tiene verificación
    const manzana = res.body.data.find(p => p.nombre_producto === 'Manzana')
    expect(manzana.ultima_fisica).toBe(9)
    expect(manzana.ultima_delta).toBe(-1)
    // Naranja no tiene verificación hoy
    const naranja = res.body.data.find(p => p.nombre_producto === 'Naranja')
    expect(naranja.ultima_fisica).toBeNull()
  })

  it('filtra por soloPendientes=true — solo los no verificados', async () => {
    q
      .mockResolvedValueOnce([
        { id_producto: 1, nombre_producto: 'Manzana', stock: 10 },
        { id_producto: 2, nombre_producto: 'Naranja', stock: 5 }
      ])
      .mockResolvedValueOnce([
        { id_producto: 1, cantidad_fisica: 9, delta: -1, usuario: 'test', fecha: '2026-08-17' }
      ])

    const res = await request(app).get('/api/entradas/conteo-fisico/estado?soloPendientes=true')
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].nombre_producto).toBe('Naranja')
  })
})

// ─── POST /api/entradas/ajuste-inventario ────────────────────

describe('POST /api/entradas/ajuste-inventario — validaciones', () => {
  it('responde 400 sin idProducto', async () => {
    const res = await request(app).post('/api/entradas/ajuste-inventario').send({ cantidadFisica: 5 })
    expect(res.status).toBe(400)
  })

  it('responde 400 sin cantidadFisica', async () => {
    const res = await request(app).post('/api/entradas/ajuste-inventario').send({ idProducto: 1 })
    expect(res.status).toBe(400)
  })

  it('responde 400 con cantidad física negativa', async () => {
    const conn = mockConn()
    const res = await request(app).post('/api/entradas/ajuste-inventario').send({ idProducto: 1, cantidadFisica: -1 })
    expect(res.status).toBe(400)
  })

  it('responde 404 cuando el producto no existe', async () => {
    const conn = mockConn([
      [[], []]  // [[prod]] → prod = undefined → 404
    ])
    const res = await request(app).post('/api/entradas/ajuste-inventario').send({ idProducto: 999, cantidadFisica: 5 })
    expect(res.status).toBe(404)
    expect(conn.rollback).toHaveBeenCalled()
  })
})

describe('POST /api/entradas/ajuste-inventario — delta positivo (sobrante)', () => {
  it('crea compra AJUSTE + lote cuando la física supera el sistema', async () => {
    const conn = mockConn([
      [[{ id_producto: 1, nombre_producto: 'Manzana', unidad_producto: 'kg', stock: 8 }], []],  // [[prod]]
      [[{ precio_unitario_compra: 20 }], []],    // [[ult]] último precio
      [{ insertId: 50 }, []],                    // INSERT compra AJUSTE
      [{ insertId: 51 }, []],                    // INSERT inventario_peps
      [{ affectedRows: 1 }, []],                 // UPDATE stock
      [{ insertId: 52 }, []]                     // INSERT verificacion
    ])

    const res = await request(app).post('/api/entradas/ajuste-inventario')
      .send({ idProducto: 1, cantidadFisica: 10 })  // sobrante = 2

    expect(res.status).toBe(200)
    expect(res.body.data.delta).toBe(2)
    expect(conn.commit).toHaveBeenCalled()

    // El INSERT compra debe tener AJUSTE en las notas (8º parámetro)
    const insertCompra = conn.execute.mock.calls.find(c => c[0].includes('INSERT INTO compra'))
    expect(insertCompra[1].some(p => typeof p === 'string' && p.includes('AJUSTE'))).toBe(true)
  })
})

describe('POST /api/entradas/ajuste-inventario — delta negativo (faltante)', () => {
  it('consume lotes PEPS cuando la física es menor al sistema', async () => {
    const conn = mockConn([
      [[{ id_producto: 1, nombre_producto: 'Naranja', unidad_producto: 'kg', stock: 10 }], []],  // [[prod]]
      // delta < 0 → no se busca último precio, se van directo a lotes
      [[
        { id_inventario_peps: 1, cantidad_restante: 6 },
        { id_inventario_peps: 2, cantidad_restante: 5 }
      ], []],                                          // lotes activos
      [{ affectedRows: 1 }, []],                       // UPDATE lote 1
      [{ affectedRows: 1 }, []],                       // UPDATE stock
      [{ insertId: 60 }, []]                           // INSERT verificacion
    ])

    const res = await request(app).post('/api/entradas/ajuste-inventario')
      .send({ idProducto: 1, cantidadFisica: 7 })  // faltante = -3

    expect(res.status).toBe(200)
    expect(res.body.data.delta).toBe(-3)
    expect(conn.commit).toHaveBeenCalled()
  })
})
