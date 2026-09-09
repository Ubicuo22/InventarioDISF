/**
 * tests/mermas.test.js — Pruebas de routes/mermas.js
 *
 * Cubre en particular el FIX de la auditoría H-5 Fase 4 (2026-09-09):
 * antes, una merma sobre un derivado con stock propio 0 (cobertura solo por
 * el producto base) pasaba la validación de stock_virtual pero el consumo
 * real de lotes nunca cruzaba la frontera de equivalencia — la merma quedaba
 * registrada sin ningún efecto en inventario. Y una segunda vuelta del fix:
 * la resolución de cadena ahora compone MÚLTIPLES saltos (A→B→C), no solo
 * uno — confirmado contra producción que existen cadenas reales de 2+ saltos.
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
jest.mock('../utils/fecha',     () => ({ fechaMexico: jest.fn().mockReturnValue('2026-09-09') }))

const request = require('supertest')
const app     = require('../app')
const { pool } = require('../db/pool')

function mockConn(executeResponses = []) {
  const conn = {
    execute:          jest.fn(),
    beginTransaction: jest.fn().mockResolvedValue(undefined),
    commit:           jest.fn().mockResolvedValue(undefined),
    rollback:         jest.fn().mockResolvedValue(undefined),
    release:          jest.fn()
  }
  for (const resp of executeResponses) {
    conn.execute.mockResolvedValueOnce(resp)
  }
  conn.execute.mockResolvedValue([{ affectedRows: 1 }, []])
  pool.getConnection.mockResolvedValue(conn)
  return conn
}

// Placeholder genérico para llamadas UPDATE/INSERT cuyo valor de retorno no se usa
const NOOP = [{ affectedRows: 1 }, []]

beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {})
})
beforeEach(() => jest.clearAllMocks())

const body = (over = {}) => ({
  id_producto: 5, tipo_merma: 'DAÑO', cantidad_merma: 3, motivo: 'prueba', ...over
})

describe('POST /api/mermas — validaciones', () => {
  it('rechaza sin id_producto', async () => {
    const res = await request(app).post('/api/mermas').send(body({ id_producto: undefined }))
    expect(res.status).toBe(400)
  })
  it('rechaza tipo_merma inválido', async () => {
    const res = await request(app).post('/api/mermas').send(body({ tipo_merma: 'X' }))
    expect(res.status).toBe(400)
  })
  it('rechaza cantidad <= 0', async () => {
    const res = await request(app).post('/api/mermas').send(body({ cantidad_merma: 0 }))
    expect(res.status).toBe(400)
  })
  it('404 si el producto no existe', async () => {
    mockConn([[[]]]) // SELECT prod -> sin fila
    const res = await request(app).post('/api/mermas').send(body())
    expect(res.status).toBe(404)
  })
  it('400 si stock insuficiente sin conversión', async () => {
    const conn = mockConn([
      [[{ stock: 1, nombre_producto: 'Jitomate', unidad_producto: 'kg' }]], // SELECT prod
      [[]] // SELECT conversiones globales -> ninguna
    ])
    const res = await request(app).post('/api/mermas').send(body({ cantidad_merma: 5 }))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Stock insuficiente/)
  })
})

describe('POST /api/mermas — consumo FIFO propio (sin cruzar equivalencia)', () => {
  it('consume solo lotes propios cuando alcanzan, sin tocar producto base', async () => {
    const conn = mockConn([
      [[{ stock: 10, nombre_producto: 'Jitomate', unidad_producto: 'kg' }]], // SELECT prod
      [[]],                                                                  // SELECT conversiones -> ninguna
      [{ insertId: 900 }],                                                   // INSERT merma
      [[{ id_inventario_peps: 1, cantidad_restante: '5.0000' }, { id_inventario_peps: 2, cantidad_restante: '5.0000' }]] // SELECT lotesPropios
    ])
    const res = await request(app).post('/api/mermas').send(body({ cantidad_merma: 3 }))
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)

    const calls = conn.execute.mock.calls.map(c => c[0])
    expect(calls.filter(sql => /UPDATE inventario_peps/.test(sql))).toHaveLength(1)
    expect(calls.filter(sql => /INSERT INTO merma_lote/.test(sql))).toHaveLength(1)
    expect(calls.filter(sql => /UPDATE producto/.test(sql))).toHaveLength(1)
  })
})

describe('POST /api/mermas — FIX: cruce de un salto (derivado -> base directo)', () => {
  it('con stock propio 0, consume íntegro del producto base', async () => {
    // Derivado = caja (id 5), base = pz (id 9), factor = 12 (1 caja = 12 pz)
    const conn = mockConn([
      [[{ stock: 0, nombre_producto: 'Caja Manzana', unidad_producto: 'caja' }]],      // SELECT prod
      [[{ id_producto_derivado: 5, id_producto_base: 9, factor: '12.000000' }]],       // SELECT conversiones
      [[{ stock: 30 }]],                                                               // SELECT stock base (id 9) -> 30/12=2.5 cajas equivalente, alcanza para pedir 2
      [{ insertId: 901 }],                                                             // INSERT merma
      [[]],                                                                            // SELECT lotesPropios -> ninguno
      [[{ id_inventario_peps: 20, cantidad_restante: '24.0000' }]]                     // SELECT lotesBase
    ])
    const res = await request(app).post('/api/mermas').send(body({ id_producto: 5, cantidad_merma: 2 }))
    expect(res.status).toBe(200)

    const calls = conn.execute.mock.calls
    const updateLote = calls.find(c => /UPDATE inventario_peps/.test(c[0]))
    expect(updateLote).toBeTruthy()
    expect(updateLote[1][0]).toBeCloseTo(24, 4) // 2 cajas * factor 12 = 24 pz
    expect(updateLote[1][1]).toBe(20)           // id del lote BASE, no uno del derivado

    const insertLote = calls.find(c => /INSERT INTO merma_lote/.test(c[0]))
    expect(insertLote[1]).toEqual([901, 20, 24])

    const stockUpdates = calls.filter(c => /UPDATE producto/.test(c[0]))
    expect(stockUpdates).toHaveLength(2)
    expect(stockUpdates[1][1]).toEqual([9, 9])
  })

  it('con stock propio parcial, consume el resto del base', async () => {
    const conn = mockConn([
      [[{ stock: 1, nombre_producto: 'Caja Manzana', unidad_producto: 'caja' }]],
      [[{ id_producto_derivado: 5, id_producto_base: 9, factor: '12.000000' }]],
      [[{ stock: 50 }]],
      [{ insertId: 902 }],
      [[{ id_inventario_peps: 30, cantidad_restante: '1.0000' }]], // lotesPropios (1 caja)
      NOOP, // UPDATE inventario_peps (propio)
      NOOP, // INSERT merma_lote (propio)
      [[{ id_inventario_peps: 40, cantidad_restante: '50.0000' }]] // lotesBase
    ])
    // Pide 3 cajas: 1 sale del lote propio, faltan 2 cajas = 24 pz del base
    const res = await request(app).post('/api/mermas').send(body({ id_producto: 5, cantidad_merma: 3 }))
    expect(res.status).toBe(200)

    const updates = conn.execute.mock.calls.filter(c => /UPDATE inventario_peps/.test(c[0]))
    expect(updates).toHaveLength(2)
    expect(updates[0][1]).toEqual([1, 30])
    expect(updates[1][1][0]).toBeCloseTo(24, 4)
    expect(updates[1][1][1]).toBe(40)
  })
})

describe('POST /api/mermas — FIX: cadena de 2+ saltos (derivado -> base -> base final)', () => {
  it('con stock propio y del base directo en 0, consume de la base final compuesta', async () => {
    // Cadena real: caja(5) -> docena(9, factor 12) -> pieza(15, factor 12) => factor acumulado 144
    const conn = mockConn([
      [[{ stock: 0, nombre_producto: 'Caja Manzana', unidad_producto: 'caja' }]],       // SELECT prod (id 5)
      [[                                                                                 // SELECT conversiones globales
        { id_producto_derivado: 5, id_producto_base: 9,  factor: '12.000000' },
        { id_producto_derivado: 9, id_producto_base: 15, factor: '12.000000' }
      ]],
      [[{ stock: 300 }]],                                                                // SELECT stock base final (id 15) -> 300/144=2.08 cajas equivalente, alcanza para pedir 2
      [{ insertId: 950 }],                                                               // INSERT merma
      [[]],                                                                              // SELECT lotesPropios (id 5) -> ninguno
      [[{ id_inventario_peps: 70, cantidad_restante: '288.0000' }]]                       // SELECT lotesBase (id 15, la base FINAL, no la 9)
    ])
    const res = await request(app).post('/api/mermas').send(body({ id_producto: 5, cantidad_merma: 2 }))
    expect(res.status).toBe(200)

    const calls = conn.execute.mock.calls
    // La consulta de lotes de la base debe apuntar a la base FINAL (15), no al salto intermedio (9)
    const selectLotesBase = calls.find(c => /SELECT id_inventario_peps, cantidad_restante[\s\S]*WHERE id_producto = \? AND cantidad_restante > 0/.test(c[0]) && c[1][0] !== 5)
    expect(selectLotesBase[1]).toEqual([15])

    const updateLote = calls.find(c => /UPDATE inventario_peps/.test(c[0]))
    // 2 cajas * 12 (caja->docena) * 12 (docena->pieza) = 288 piezas
    expect(updateLote[1][0]).toBeCloseTo(288, 4)
    expect(updateLote[1][1]).toBe(70)

    const stockUpdates = calls.filter(c => /UPDATE producto/.test(c[0]))
    expect(stockUpdates).toHaveLength(2)
    expect(stockUpdates[1][1]).toEqual([15, 15]) // reconcilia la base FINAL (15), no el salto intermedio (9)
  })
})
