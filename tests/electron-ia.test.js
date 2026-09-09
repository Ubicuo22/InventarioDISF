/**
 * tests/electron-ia.test.js — Pruebas de routes/electron/ia.js
 *
 * Fase 1 de H-5: proxy de llamarLLM (SambaNova → Groq) para Chumi. Solo la
 * llamada al proveedor vive aquí; las tools de negocio (SQL local) se
 * quedan en Electron. `fetch` mockeado para simular ambos proveedores.
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

const ORIGINAL_SAMBANOVA = process.env.SAMBANOVA_API_KEY
const ORIGINAL_GROQ = process.env.GROQ_API_KEY

beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})

afterAll(() => {
  process.env.SAMBANOVA_API_KEY = ORIGINAL_SAMBANOVA
  process.env.GROQ_API_KEY = ORIGINAL_GROQ
})

beforeEach(() => {
  jest.resetAllMocks()
  process.env.SAMBANOVA_API_KEY = 'sn-test-key'
  process.env.GROQ_API_KEY = 'groq-test-key'
})

const MENSAJES = [{ role: 'user', content: 'hola' }]

describe('POST /api/electron/ia/chat', () => {
  it('falta messages → 400', async () => {
    const res = await request(app).post('/api/electron/ia/chat').send({})
    expect(res.status).toBe(400)
  })

  it('SambaNova responde ok → usa SambaNova, no llama a Groq', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'hola de vuelta' } }] }),
    })

    const res = await request(app).post('/api/electron/ia/chat').send({ messages: MENSAJES })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.choices[0].message.content).toBe('hola de vuelta')
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(global.fetch.mock.calls[0][0]).toContain('sambanova')
  })

  it('SambaNova falla (no rate limit) → cae a Groq', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'sambanova down' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: 'respuesta de groq' } }] }) })

    const res = await request(app).post('/api/electron/ia/chat').send({ messages: MENSAJES })

    expect(res.status).toBe(200)
    expect(res.body.data.choices[0].message.content).toBe('respuesta de groq')
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(global.fetch.mock.calls[1][0]).toContain('groq')
  })

  it('ambos proveedores fallan → 502 sin exponer detalle crudo', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom interno' })

    const res = await request(app).post('/api/electron/ia/chat').send({ messages: MENSAJES })

    expect(res.status).toBe(502)
    expect(res.body.ok).toBe(false)
    expect(res.body.error).not.toMatch(/boom interno/)
  })

  it('rate limit (429) en el último proveedor → mensaje amigable con tiempo de espera', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 429, text: async () => 'rate limit exceeded. try again in 1m30s',
    })

    const res = await request(app).post('/api/electron/ia/chat').send({ messages: MENSAJES })

    expect(res.status).toBe(429)
    expect(res.body.error).toMatch(/1 minuto/)
  })

  it('sin ninguna API key configurada → 500', async () => {
    delete process.env.SAMBANOVA_API_KEY
    delete process.env.GROQ_API_KEY
    global.fetch = jest.fn()

    const res = await request(app).post('/api/electron/ia/chat').send({ messages: MENSAJES })

    expect(res.status).toBe(500)
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
