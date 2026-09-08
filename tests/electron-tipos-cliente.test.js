/**
 * tests/electron-tipos-cliente.test.js — Pruebas de routes/electron/tiposCliente.js
 *
 * Canal trivial de la Fase 0 (H-5): confirma que el middleware de auth de
 * Electron protege la ruta, y que la respuesta exitosa tiene el shape que
 * espera bodegaClient.ts del lado Electron.
 */

jest.mock('../db/pool', () => ({
  q:    jest.fn(),
  pool: { execute: jest.fn() }
}))

jest.mock('../middleware/auth-electron', () => ({
  requireAuthElectron: (req, res, next) => { req.user = { id: 1, username: 'TEST', rol: 'admin' }; next() },
  requireRoleElectron: () => (req, res, next) => next(),
  invalidarCacheElectron: () => {},
  AUD: 'disfruleg-electron'
}))

const request = require('supertest')
const app = require('../app')
const { q } = require('../db/pool')

beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {})
})

beforeEach(() => {
  jest.clearAllMocks()
})

describe('GET /api/electron/tipos-cliente', () => {
  it('devuelve la lista con ok:true cuando la sesión es válida', async () => {
    q.mockResolvedValue([
      { id_tipo_cliente: 1, nombre_tipo: 'Minorista', descuento: 0 },
      { id_tipo_cliente: 2, nombre_tipo: 'Mayorista', descuento: 10 }
    ])
    const res = await request(app).get('/api/electron/tipos-cliente')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data).toHaveLength(2)
    expect(res.body.data[0].nombre_tipo).toBe('Minorista')
  })

  it('devuelve ok:false y 500 sin exponer el error crudo si la query falla', async () => {
    q.mockRejectedValue(new Error('ER_NO_SUCH_TABLE: tipo_cliente doesn\'t exist'))
    const res = await request(app).get('/api/electron/tipos-cliente')
    expect(res.status).toBe(500)
    expect(res.body.ok).toBe(false)
    expect(res.body.error).not.toMatch(/ER_NO_SUCH_TABLE/)
  })
})

// La protección real de requireAuthElectron (JWT + aud + sesión en BD) se
// prueba sin mockear el middleware en tests/electron-auth.test.js — ahí
// mismo se confirma que un token con `aud` distinto se rechaza. Ese archivo
// no puede compartirse con este porque jest.mock() de un módulo se aplica a
// todo el archivo de test, y aquí necesitamos el middleware mockeado como
// passthrough para probar la ruta en aislamiento.
