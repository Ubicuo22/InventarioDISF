/**
 * tests/productos-info-compra.test.js — Pruebas de GET /api/productos/info-compra
 *
 * Página informativa (última compra, promedio ponderado, margen). Nunca debe
 * cargar el catálogo completo: sin búsqueda son los 25 más vendidos, con
 * búsqueda hasta 25 coincidencias — mismo criterio ya aplicado en
 * /api/ordenes (ver Bugs y Patrones, 22 sep 2026).
 */

jest.mock('../db/pool', () => ({
  q:    jest.fn(),
  pool: { execute: jest.fn() }
}))

jest.mock('../middleware/auth', () => ({
  requireAuth:  (req, res, next) => { req.user = { rol: 'ceo', id_usuario: 1 }; next() },
  requireAdmin: (req, res, next) => next(),
  requireModulo: () => (req, res, next) => next()
}))

const request = require('supertest')
const app     = require('../app')
const { q }   = require('../db/pool')

beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {})
})

beforeEach(() => {
  jest.clearAllMocks()
})

describe('GET /api/productos/info-compra', () => {
  it('sin búsqueda, trae los 25 más vendidos (no todo el catálogo)', async () => {
    q.mockResolvedValueOnce([]) // base
    const res = await request(app).get('/api/productos/info-compra')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
    const [sqlBase] = q.mock.calls[0]
    expect(sqlBase).toContain('ORDER  BY cantidad_vendida DESC')
    expect(sqlBase).toContain('LIMIT  25')
  })

  it('con búsqueda, filtra por nombre en vez de rankear por ventas', async () => {
    q.mockResolvedValueOnce([])
    await request(app).get('/api/productos/info-compra?busqueda=chile')
    const [sqlBase, params] = q.mock.calls[0]
    expect(sqlBase).toContain('p.nombre_producto LIKE ?')
    expect(sqlBase).not.toContain('cantidad_vendida DESC')
    expect(params).toContain('%chile%')
  })

  it('no dispara las queries de enriquecimiento si no hay productos base', async () => {
    q.mockResolvedValueOnce([])
    await request(app).get('/api/productos/info-compra')
    expect(q).toHaveBeenCalledTimes(1)
  })

  it('combina última compra, promedio ponderado y margen correctamente', async () => {
    q.mockResolvedValueOnce([
      { id_producto: 871088, nombre_producto: 'CHILE SERRANO', unidad_producto: 'kg', stock: 12, cantidad_vendida: 500 }
    ])
    q.mockResolvedValueOnce([
      { id_producto: 871088, fecha_compra: '2026-09-01', precio_unitario_compra: '18.00', proveedor: 'Proveedor X' }
    ])
    q.mockResolvedValueOnce([
      { id_producto: 871088, promedio: '17.500000', num_compras: 6 }
    ])
    q.mockResolvedValueOnce([
      { id_producto: 871088, precio_base: '25.00' }
    ])

    const res = await request(app).get('/api/productos/info-compra')
    expect(res.status).toBe(200)
    const [p] = res.body.data
    expect(p.ultimaCompra).toEqual({ fecha_compra: '2026-09-01', precio_unitario_compra: 18, proveedor: 'Proveedor X' })
    expect(p.promedioCompra).toBe(17.5)
    expect(p.numCompras).toBe(6)
    expect(p.precioVentaGeneral).toBe(25)
    // margen = (25 - 17.5) / 25 * 100 = 30%
    expect(p.margenPct).toBe(30)
  })

  it('producto nunca comprado → ultimaCompra y promedioCompra en null, sin romper', async () => {
    q.mockResolvedValueOnce([
      { id_producto: 1, nombre_producto: 'PRODUCTO NUEVO', unidad_producto: 'pz', stock: 0, cantidad_vendida: 0 }
    ])
    q.mockResolvedValueOnce([]) // sin última compra
    q.mockResolvedValueOnce([]) // sin promedio
    q.mockResolvedValueOnce([]) // sin precio de venta

    const res = await request(app).get('/api/productos/info-compra')
    const [p] = res.body.data
    expect(p.ultimaCompra).toBeNull()
    expect(p.promedioCompra).toBeNull()
    expect(p.numCompras).toBe(0)
    expect(p.margenPct).toBeNull()
  })

  it('excluye compras PHANTOM y precio en 0 en última compra y promedio', async () => {
    q.mockResolvedValueOnce([{ id_producto: 1, nombre_producto: 'X', unidad_producto: 'pz', stock: 0, cantidad_vendida: 0 }])
    q.mockResolvedValueOnce([])
    q.mockResolvedValueOnce([])
    q.mockResolvedValueOnce([])
    await request(app).get('/api/productos/info-compra')
    const sqlUltima   = q.mock.calls[1][0]
    const sqlPromedio = q.mock.calls[2][0]
    for (const sql of [sqlUltima, sqlPromedio]) {
      expect(sql).toContain('precio_unitario_compra > 0.01')
      expect(sql).toContain("NOT LIKE 'PHANTOM:%'")
    }
  })

  it('responde 500 si la BD falla', async () => {
    q.mockRejectedValueOnce(new Error('DB error'))
    const res = await request(app).get('/api/productos/info-compra')
    expect(res.status).toBe(500)
    expect(res.body.ok).toBe(false)
  })
})
