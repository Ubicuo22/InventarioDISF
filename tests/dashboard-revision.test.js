/**
 * tests/dashboard-revision.test.js — "Por revisar" del home (GET
 * /api/dashboard/metricas-hoy) cuenta solo los pedidos de HOY.
 *
 * 23 sep 2026: las ~2,400 notas guardadas de días anteriores ya se
 * entregaron y se procesan después por proceso interno (normal). Antes el home
 * traía TODAS con su datos_carrito (~10 MB por carga) y "Por revisar" /
 * "atrasados +1 día" salían en cientos/miles, sin relación con Pedidos (que
 * abre en hoy).
 */
jest.mock('../db/pool', () => ({
  q:    jest.fn(),
  pool: { execute: jest.fn(), getConnection: jest.fn() }
}))
jest.mock('../middleware/auth', () => ({
  requireAuth:   (req, res, next) => { req.user = { rol: 'ceo', username: 'test' }; next() },
  requireAdmin:  (req, res, next) => next(),
  requireModulo: () => (req, res, next) => next()
}))

const request = require('supertest')
const app     = require('../app')
const { q }   = require('../db/pool')

beforeAll(() => { jest.spyOn(console, 'error').mockImplementation(() => {}) })
beforeEach(() => jest.clearAllMocks())

const carrito = (hist) => JSON.stringify({ General: [{ id_producto: 1, cantidad: 1, precio_unitario: 10 }], __historial__: hist })
const PEDIDOS_HOY = [
  { folio_numero: 1, datos_carrito: carrito([]) },                                                   // sin revisar
  { folio_numero: 2, datos_carrito: carrito([{ tipoEvento: 'revision', pendientes: [] }]) },           // revisado
  { folio_numero: 3, datos_carrito: carrito([{ tipoEvento: 'revision', pendientes: [{ id: 9 }] }]) },  // con pendientes
]

function mockBD () {
  q.mockImplementation(async (sql) => {
    const s = sql.replace(/\s+/g, ' ')
    if (s.includes('SELECT folio_numero, datos_carrito')) return PEDIDOS_HOY
    if (s.includes("WHERE estado = 'guardada' AND activo = 1") && s.includes('COUNT(*)')) return [{ total: 2419 }]
    return []
  })
}

describe('GET /api/dashboard/metricas-hoy — revisión solo de hoy', () => {
  it('la consulta de carritos está limitada al rango de hoy (no trae las 2,400 guardadas)', async () => {
    mockBD()
    const res = await request(app).get('/api/dashboard/metricas-hoy')
    expect(res.status).toBe(200)
    const call = q.mock.calls.find(c => c[0].includes('SELECT folio_numero, datos_carrito'))
    expect(call[0]).toMatch(/fecha_creacion >= \? AND fecha_creacion < \?/)
    expect(call[1]).toHaveLength(2)
  })

  it('por_revisar / revisados cuentan solo los pedidos de hoy', async () => {
    mockBD()
    const res = await request(app).get('/api/dashboard/metricas-hoy')
    const p = res.body.data?.pedidos ?? res.body.pedidos
    expect(p.guardados_hoy).toBe(3)
    expect(p.por_revisar).toBe(2) // sin revisar + con pendientes
    expect(p.revisados).toBe(1)
    expect(p.activos).toBe(2419)  // total sigue disponible, solo como conteo
  })

  it('ya no reporta "atrasados" (casi todas las guardadas tienen >1 día por proceso normal)', async () => {
    mockBD()
    const res = await request(app).get('/api/dashboard/metricas-hoy')
    const p = res.body.data?.pedidos ?? res.body.pedidos
    expect(p).not.toHaveProperty('atrasados')
  })
})
