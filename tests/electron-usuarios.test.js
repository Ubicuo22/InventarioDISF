/**
 * tests/electron-usuarios.test.js — Pruebas de routes/electron/usuarios.js
 *
 * Fase 2 de H-5: identidad y control de acceso. `requireRoleElectron` se
 * mockea de forma que SÍ aplica el chequeo de rol contra un `mockUser`
 * mutable (no un passthrough ciego) — así un solo archivo cubre tanto el
 * camino feliz (admin/ceo) como el rechazo por rol (supervisor/cajero),
 * sin necesitar la partición mocked-vs-real-middleware de otros archivos.
 *
 * Los casos no-negociables de esta fase: un cambio de rol o eliminación de
 * usuario invalida sus electron_sesiones activas — eso es lo que de verdad
 * hace que "bajarle el rol a alguien" tenga efecto real, no solo cosmético.
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

describe('GET /api/electron/usuarios', () => {
  it('devuelve usuarios con avatar_url_publica y sin r2_key, con permisos de supervisores', async () => {
    q.mockResolvedValueOnce([
      { id_usuario: 1, username: 'SUP1', rol: 'supervisor', avatar_r2_key: 'avatars/1.jpg' },
      { id_usuario: 2, username: 'ADM1', rol: 'admin', avatar_r2_key: null },
    ]).mockResolvedValueOnce([{ id_usuario: 1, modulo_id: 'compras' }])

    const res = await request(app).get('/api/electron/usuarios')

    expect(res.status).toBe(200)
    expect(res.body.data[0].avatar_url_publica).toContain('/avatars/1.jpg')
    expect(res.body.data[0].avatar_r2_key).toBeUndefined()
    expect(res.body.data[0].modulos_permitidos).toEqual(['compras'])
  })
})

describe('POST /api/electron/usuarios (crear)', () => {
  it('rechaza a un supervisor (no admin/ceo) con 403', async () => {
    mockUser = { id: 5, username: 'SUP', rol: 'supervisor' }
    const res = await request(app).post('/api/electron/usuarios').send({ username: 'X', password: 'x', nombre_completo: 'X' })
    expect(res.status).toBe(403)
  })

  it('admin no puede crear un usuario con rol ceo', async () => {
    const res = await request(app).post('/api/electron/usuarios').send({ username: 'NUEVO', password: 'x', nombre_completo: 'Nuevo', rol: 'ceo' })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/CEO/)
  })

  it('admin crea un usuario normal correctamente', async () => {
    q.mockResolvedValueOnce([{ count: 0 }]) // existeRows
    pool.execute.mockResolvedValueOnce([{ insertId: 42 }])

    const res = await request(app).post('/api/electron/usuarios').send({ username: 'NUEVO', password: 'x', nombre_completo: 'Nuevo' })

    expect(res.status).toBe(200)
    expect(res.body.data.insertId).toBe(42)
  })

  it('rechaza username duplicado', async () => {
    q.mockResolvedValueOnce([{ count: 1 }])
    const res = await request(app).post('/api/electron/usuarios').send({ username: 'YA_EXISTE', password: 'x', nombre_completo: 'X' })
    expect(res.status).toBe(409)
  })
})

describe('PUT /api/electron/usuarios/:id (actualizar)', () => {
  it('admin no puede modificar una cuenta CEO', async () => {
    q.mockResolvedValueOnce([{ rol: 'ceo' }]) // getRolUsuario
    const res = await request(app).put('/api/electron/usuarios/7').send({ nombre_completo: 'X', rol: 'ceo', activo: true })
    expect(res.status).toBe(403)
  })

  it('cambio de rol invalida las electron_sesiones activas del usuario (regresión del hueco de seguridad)', async () => {
    q.mockResolvedValueOnce([{ rol: 'admin' }]) // getRolUsuario — rol actual distinto al nuevo
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 1, changedRows: 1 }]) // UPDATE usuarios_sistema
      .mockResolvedValueOnce([{}])                                   // DELETE permisos_usuario
      .mockResolvedValueOnce([[{ jti: 'jti-viejo-1' }, { jti: 'jti-viejo-2' }]]) // SELECT jti activos
      .mockResolvedValueOnce([{}])                                   // UPDATE electron_sesiones activo=0

    const res = await request(app).put('/api/electron/usuarios/7').send({ nombre_completo: 'X', rol: 'supervisor', activo: true })

    expect(res.status).toBe(200)
    expect(pool.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE electron_sesiones SET activo = 0 WHERE id_usuario'),
      [7]
    )
    expect(mockInvalidarCacheElectron).toHaveBeenCalledWith('jti-viejo-1')
    expect(mockInvalidarCacheElectron).toHaveBeenCalledWith('jti-viejo-2')
  })

  it('sin cambio de rol ni desactivación, NO invalida sesiones', async () => {
    q.mockResolvedValueOnce([{ rol: 'supervisor' }])
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 1, changedRows: 1 }])
      .mockResolvedValueOnce([{}])

    const res = await request(app).put('/api/electron/usuarios/7').send({ nombre_completo: 'X', rol: 'supervisor', activo: true })

    expect(res.status).toBe(200)
    expect(pool.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE electron_sesiones'),
      expect.anything()
    )
  })
})

describe('DELETE /api/electron/usuarios/:id (eliminar)', () => {
  it('elimina y siempre invalida sesiones, incondicionalmente', async () => {
    q.mockResolvedValueOnce([{ rol: 'usuario' }]) // getRolUsuario
      .mockResolvedValueOnce([{ avatar_r2_key: null }]) // SELECT avatar
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // DELETE
      .mockResolvedValueOnce([[{ jti: 'jti-x' }]])    // SELECT jti activos
      .mockResolvedValueOnce([{}])                    // UPDATE electron_sesiones

    const res = await request(app).delete('/api/electron/usuarios/7')

    expect(res.status).toBe(200)
    expect(pool.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE electron_sesiones SET activo = 0 WHERE id_usuario'),
      [7]
    )
  })
})

describe('POST /api/electron/usuarios/:id/desbloquear', () => {
  it('rechaza a un rol no-admin', async () => {
    mockUser = { id: 5, username: 'CAJERO', rol: 'cajero' }
    const res = await request(app).post('/api/electron/usuarios/7/desbloquear')
    expect(res.status).toBe(403)
  })

  it('desbloquea correctamente', async () => {
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 }])
    const res = await request(app).post('/api/electron/usuarios/7/desbloquear')
    expect(res.status).toBe(200)
    expect(pool.execute).toHaveBeenCalledWith(expect.stringContaining('bloqueado_hasta = NULL'), ['7'])
  })
})
