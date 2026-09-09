/**
 * tests/electron-dispositivos.test.js — Pruebas de routes/electron/dispositivos.js
 *
 * Fase 2 de H-5. El caso no-negociable de este archivo: `POST /:id/block`
 * debe (a) invalidar las electron_sesiones activas de ese device_id, (b)
 * registrar el evento en dispositivos_eventos con id_usuario_admin tomado
 * del JWT (req.user.id) — nunca del body, para que no se pueda falsificar
 * quién bloqueó qué.
 */

let mockUser = { id: 99, username: 'ADMIN_TEST', rol: 'admin' }
const mockInvalidarCacheElectron = jest.fn()

jest.mock('../db/pool', () => ({
  q:    jest.fn(),
  pool: { execute: jest.fn() }
}))

jest.mock('../middleware/auth-electron', () => ({
  requireAuthElectron: (req, res, next) => { req.user = mockUser; next() },
  requireRoleElectron: (roles) => (req, res, next) => {
    req.user = mockUser
    if (!roles.includes(mockUser.rol)) return res.status(403).json({ ok: false, error: 'No tienes permisos para realizar esta acción.' })
    next()
  },
  invalidarCacheElectron: mockInvalidarCacheElectron,
  AUD: 'disfruleg-electron'
}))

const request = require('supertest')
const app = require('../app')
const { q, pool } = require('../db/pool')

beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})

beforeEach(() => {
  jest.clearAllMocks()
  mockUser = { id: 99, username: 'ADMIN_TEST', rol: 'admin' }
})

describe('GET /api/electron/dispositivos', () => {
  it('lista dispositivos sin requerir rol específico', async () => {
    q.mockResolvedValueOnce([{ id_dispositivo: 1, device_id: 'abc', estado: 'AUTORIZADO' }])
    const res = await request(app).get('/api/electron/dispositivos')
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
  })
})

describe('POST /api/electron/dispositivos/:id/authorize', () => {
  it('rechaza a un rol no-admin', async () => {
    mockUser = { id: 5, username: 'SUP', rol: 'supervisor' }
    const res = await request(app).post('/api/electron/dispositivos/1/authorize')
    expect(res.status).toBe(403)
  })

  it('rechaza si el dispositivo no tiene usuario asignado', async () => {
    q.mockResolvedValueOnce([{ device_id: 'abc', id_usuario: null }])
    const res = await request(app).post('/api/electron/dispositivos/1/authorize')
    expect(res.status).toBe(400)
  })

  it('autoriza y registra el evento', async () => {
    q.mockResolvedValueOnce([{ device_id: 'abc', id_usuario: 7, estado: 'PENDING' }])
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE dispositivos_autorizados
      .mockResolvedValueOnce([{}])                   // INSERT dispositivos_eventos

    const res = await request(app).post('/api/electron/dispositivos/1/authorize')

    expect(res.status).toBe(200)
    expect(pool.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO dispositivos_eventos'),
      [1, 'abc', 'PENDING', 'AUTORIZADO', null, 'ADMIN_TEST']
    )
  })
})

describe('POST /api/electron/dispositivos/:id/block — el fix real del hueco de seguridad', () => {
  it('invalida electron_sesiones del device_id y audita con id_usuario_admin del JWT, no del body', async () => {
    q.mockResolvedValueOnce([{ device_id: 'device-abc', estado: 'AUTORIZADO' }])
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 1 }])                              // UPDATE dispositivos_autorizados
      .mockResolvedValueOnce([[{ jti: 'sesion-1' }, { jti: 'sesion-2' }]])        // SELECT jti activos
      .mockResolvedValueOnce([{}])                                                // UPDATE electron_sesiones
      .mockResolvedValueOnce([{}])                                                // INSERT dispositivos_eventos

    // El body intenta falsificar id_usuario_admin — la ruta debe ignorarlo
    const res = await request(app).post('/api/electron/dispositivos/1/block').send({ razon: 'sospechoso', id_usuario_admin: 1 })

    expect(res.status).toBe(200)
    expect(pool.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE electron_sesiones SET activo = 0 WHERE device_id'),
      ['device-abc']
    )
    expect(mockInvalidarCacheElectron).toHaveBeenCalledWith('sesion-1')
    expect(mockInvalidarCacheElectron).toHaveBeenCalledWith('sesion-2')
    expect(pool.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO dispositivos_eventos'),
      [1, 'device-abc', 'AUTORIZADO', 'BLOQUEADO', 'sospechoso', 'ADMIN_TEST']
    )
  })

  it('rechaza a un rol no-admin', async () => {
    mockUser = { id: 5, username: 'CAJERO', rol: 'cajero' }
    const res = await request(app).post('/api/electron/dispositivos/1/block')
    expect(res.status).toBe(403)
  })
})

describe('DELETE /api/electron/dispositivos/:id', () => {
  it('rechaza eliminar el dispositivo del propio caller', async () => {
    q.mockResolvedValueOnce([{ device_id: 'mi-propio-device' }])
    const res = await request(app).delete('/api/electron/dispositivos/1?callerDeviceId=mi-propio-device')
    expect(res.status).toBe(400)
  })

  it('elimina un dispositivo distinto e invalida sus sesiones', async () => {
    q.mockResolvedValueOnce([{ device_id: 'otro-device' }])
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[{ jti: 'sesion-x' }]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}])

    const res = await request(app).delete('/api/electron/dispositivos/1?callerDeviceId=mi-propio-device')

    expect(res.status).toBe(200)
    expect(mockInvalidarCacheElectron).toHaveBeenCalledWith('sesion-x')
  })
})

describe('POST /api/electron/dispositivos/:id/reactivate y PUT /:id/notas', () => {
  it('reactivate no invalida sesiones (es un otorgamiento, no una revocación)', async () => {
    q.mockResolvedValueOnce([{ device_id: 'abc' }])
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{}]) // solo el INSERT de auditoría

    const res = await request(app).post('/api/electron/dispositivos/1/reactivate')

    expect(res.status).toBe(200)
    expect(pool.execute).not.toHaveBeenCalledWith(expect.stringContaining('electron_sesiones'), expect.anything())
  })

  it('updateNotes rechaza a un rol no-admin', async () => {
    mockUser = { id: 5, username: 'CAJERO', rol: 'cajero' }
    const res = await request(app).put('/api/electron/dispositivos/1/notas').send({ notas: 'x' })
    expect(res.status).toBe(403)
  })
})
