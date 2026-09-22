/**
 * tests/productos-precio-rapido.test.js — Pruebas de POST /api/productos/precio-rapido
 *
 * Regresión que este test previene: el precio recién fijado para un producto
 * sin precio en el grupo se usaba tal cual (precio_base, sin descuento) para
 * el renglón del carrito que lo disparó. El descuento del cliente solo se
 * aplicaba en búsquedas futuras, nunca a esa primera compra — bug real en
 * producción, confirmado el 22 sep 2026 (233 notas, $7,863.56 de exceso
 * acumulado desde el 4 ago 2026). Ver Bugs y Patrones.
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

describe('POST /api/productos/precio-rapido', () => {
  it('devuelve precio_final con el descuento del grupo ya aplicado', async () => {
    q.mockResolvedValueOnce(undefined) // INSERT ... ON DUPLICATE KEY UPDATE
    q.mockResolvedValueOnce([{ descuento: '10.00' }]) // SELECT descuento del grupo

    const res = await request(app)
      .post('/api/productos/precio-rapido')
      .send({ id_producto: 871088, id_grupo: 34, precio_base: 25 })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.precio_final).toBe(22.5)
    expect(res.body.data.descuento).toBe(10)
  })

  it('precio_final == precio_base cuando el grupo no tiene descuento', async () => {
    q.mockResolvedValueOnce(undefined)
    q.mockResolvedValueOnce([{ descuento: '0.00' }])

    const res = await request(app)
      .post('/api/productos/precio-rapido')
      .send({ id_producto: 1, id_grupo: 35, precio_base: 25 })

    expect(res.body.data.precio_final).toBe(25)
  })

  it('trata un grupo sin fila de descuento (LEFT JOIN vacío) como 0%', async () => {
    q.mockResolvedValueOnce(undefined)
    q.mockResolvedValueOnce([]) // sin match en tipo_cliente

    const res = await request(app)
      .post('/api/productos/precio-rapido')
      .send({ id_producto: 1, id_grupo: 99, precio_base: 40 })

    expect(res.body.data.precio_final).toBe(40)
    expect(res.body.data.descuento).toBe(0)
  })

  it('rechaza precio_base <= 0', async () => {
    const res = await request(app)
      .post('/api/productos/precio-rapido')
      .send({ id_producto: 1, id_grupo: 34, precio_base: 0 })

    expect(res.status).toBe(400)
    expect(q).not.toHaveBeenCalled()
  })
})
