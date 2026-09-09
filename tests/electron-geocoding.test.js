/**
 * tests/electron-geocoding.test.js — Pruebas de routes/electron/geocoding.js
 *
 * Fase 1 de H-5: primer proxy de llave de API (Google Geocoding), sin
 * lógica de negocio. La ruta está protegida por requireAuthElectron
 * (mockeado aquí como passthrough — su comportamiento real ya se prueba en
 * tests/electron-auth.test.js) y llama a Google vía `fetch`, mockeado en
 * cada test.
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

const ORIGINAL_KEY = process.env.GOOGLE_GEOCODING_KEY

beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {})
  process.env.GOOGLE_GEOCODING_KEY = 'test-key'
})

afterAll(() => {
  process.env.GOOGLE_GEOCODING_KEY = ORIGINAL_KEY
})

beforeEach(() => {
  jest.resetAllMocks()
  process.env.GOOGLE_GEOCODING_KEY = 'test-key'
})

describe('POST /api/electron/geocoding/resolver', () => {
  it('falta la dirección → 400', async () => {
    const res = await request(app).post('/api/electron/geocoding/resolver').send({})
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
  })

  it('Google devuelve OK con resultados → 200 con lat/lng/dirección formateada', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({
        status: 'OK',
        results: [{
          geometry: { location: { lat: 19.7017, lng: -101.1926 } },
          formatted_address: 'Tte. Coronel Felipe Páramo 160, Morelia, Mich.'
        }]
      })
    })

    const res = await request(app).post('/api/electron/geocoding/resolver').send({ direccion: 'Bodega Disfruleg' })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.lat).toBe(19.7017)
    expect(res.body.data.direccion_formateada).toMatch(/Morelia/)
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('key=test-key'))
  })

  it('Google devuelve ZERO_RESULTS → 422 con mensaje amigable', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({ status: 'ZERO_RESULTS', results: [] })
    })

    const res = await request(app).post('/api/electron/geocoding/resolver').send({ direccion: 'xyz no existe' })

    expect(res.status).toBe(422)
    expect(res.body.ok).toBe(false)
    expect(res.body.error).toMatch(/no encontrada/)
  })

  it('sin GOOGLE_GEOCODING_KEY configurado → 500 sin exponer detalle', async () => {
    delete process.env.GOOGLE_GEOCODING_KEY
    global.fetch = jest.fn()

    const res = await request(app).post('/api/electron/geocoding/resolver').send({ direccion: 'algo' })

    expect(res.status).toBe(500)
    expect(res.body.ok).toBe(false)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('error de red al llamar a Google → 500 sin exponer el error crudo', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('fetch failed: ECONNRESET'))

    const res = await request(app).post('/api/electron/geocoding/resolver').send({ direccion: 'algo' })

    expect(res.status).toBe(500)
    expect(res.body.ok).toBe(false)
    expect(res.body.error).not.toMatch(/ECONNRESET/)
  })
})
