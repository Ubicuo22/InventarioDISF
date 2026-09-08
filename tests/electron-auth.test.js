/**
 * tests/electron-auth.test.js — Pruebas de routes/electron/auth.js
 *
 * Regressions que estos tests previenen:
 *   • El bloqueo de cuenta (esta_bloqueado) se calcula en SQL (NOW()), nunca
 *     con `new Date(...)` en JS — el mismo bug de timezone que se corrigió
 *     hoy del lado Electron (auth.handler.ts) no debe reaparecer aquí.
 *   • El gate de dispositivo autorizado bloquea login aunque la contraseña
 *     sea correcta.
 *   • JWT lleva `aud`/`iss` — un token de esta ruta no debe validar contra
 *     el middleware de la app web bodega ni viceversa.
 */

jest.mock('../db/pool', () => ({
  q:    jest.fn(),
  pool: { execute: jest.fn() }
}))

const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const request = require('supertest')
const app = require('../app')
const { pool } = require('../db/pool')

const PASSWORD_HASH = bcrypt.hashSync('clave-correcta', 4) // rounds bajos, solo para tests

beforeAll(() => {
  process.env.JWT_SECRET_ELECTRON = 'secreto-de-test-electron'
  jest.spyOn(console, 'error').mockImplementation(() => {})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})

beforeEach(() => {
  jest.resetAllMocks() // no solo clearAllMocks — también vacía valores mockResolvedValueOnce sin consumir de un test anterior
})

const usuarioBase = {
  id_usuario: 1,
  username: 'ANTONIO',
  password_hash: PASSWORD_HASH,
  nombre_completo: 'Antonio',
  rol: 'ceo',
  activo: 1,
  intentos_fallidos: 0,
  bloqueado_hasta: null,
  esta_bloqueado: 0
}

describe('POST /api/electron/auth/login', () => {
  it('requiere usuario y contraseña', async () => {
    const res = await request(app).post('/api/electron/auth/login').send({})
    expect(res.status).toBe(400)
  })

  it('usuario no encontrado → 401 sin filtrar si existe o no la cuenta', async () => {
    pool.execute.mockResolvedValueOnce([[]])
    const res = await request(app).post('/api/electron/auth/login').send({ username: 'nadie', password: 'x' })
    expect(res.status).toBe(401)
    expect(res.body.ok).toBe(false)
  })

  it('cuenta bloqueada (esta_bloqueado=1 calculado en SQL) rechaza incluso con contraseña correcta', async () => {
    pool.execute.mockResolvedValueOnce([[{ ...usuarioBase, esta_bloqueado: 1 }]])
    const res = await request(app).post('/api/electron/auth/login').send({ username: 'ANTONIO', password: 'clave-correcta' })
    expect(res.status).toBe(401)
    expect(res.body.reason).toBe('ACCOUNT_LOCKED')
  })

  it('contraseña incorrecta incrementa intentos_fallidos y no revela si el usuario existe', async () => {
    pool.execute
      .mockResolvedValueOnce([[usuarioBase]])   // SELECT usuario
      .mockResolvedValueOnce([{}])               // UPDATE intentos_fallidos
    const res = await request(app).post('/api/electron/auth/login').send({ username: 'ANTONIO', password: 'incorrecta' })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Contraseña incorrecta')
    expect(pool.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE usuarios_sistema SET intentos_fallidos'),
      [1, usuarioBase.id_usuario]
    )
  })

  it('5º intento fallido bloquea la cuenta 15 minutos', async () => {
    pool.execute
      .mockResolvedValueOnce([[{ ...usuarioBase, intentos_fallidos: 4 }]])
      .mockResolvedValueOnce([{}])
    const res = await request(app).post('/api/electron/auth/login').send({ username: 'ANTONIO', password: 'incorrecta' })
    expect(res.status).toBe(401)
    expect(res.body.reason).toBe('ACCOUNT_LOCKED')
    expect(pool.execute).toHaveBeenCalledWith(
      expect.stringContaining('DATE_ADD(NOW(), INTERVAL 15 MINUTE)'),
      [5, usuarioBase.id_usuario]
    )
  })

  it('falta deviceId → 400 aunque la contraseña sea correcta', async () => {
    pool.execute.mockResolvedValueOnce([[usuarioBase]])
    const res = await request(app).post('/api/electron/auth/login').send({ username: 'ANTONIO', password: 'clave-correcta' })
    expect(res.status).toBe(400)
  })

  it('dispositivo nuevo → se registra PENDING y rechaza el login', async () => {
    pool.execute
      .mockResolvedValueOnce([[usuarioBase]])  // SELECT usuario (intentos_fallidos=0 → se salta el UPDATE de reset)
      .mockResolvedValueOnce([[]])              // SELECT dispositivo → no existe
      .mockResolvedValueOnce([{}])              // INSERT dispositivo PENDING
    const res = await request(app).post('/api/electron/auth/login').send({
      username: 'ANTONIO', password: 'clave-correcta', deviceId: 'nuevo-device', deviceName: 'Mac de prueba'
    })
    expect(res.status).toBe(401)
    expect(res.body.reason).toBe('DEVICE_PENDING')
    expect(pool.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO dispositivos_autorizados'),
      expect.arrayContaining(['nuevo-device'])
    )
  })

  it('dispositivo bloqueado rechaza el login aunque la contraseña sea correcta', async () => {
    pool.execute
      .mockResolvedValueOnce([[usuarioBase]])
      .mockResolvedValueOnce([[{ id_dispositivo: 1, estado: 'BLOQUEADO', autorizado: 0 }]])
      .mockResolvedValueOnce([{}]) // UPDATE ultimo_acceso
    const res = await request(app).post('/api/electron/auth/login').send({
      username: 'ANTONIO', password: 'clave-correcta', deviceId: 'device-bloqueado', deviceName: 'x'
    })
    expect(res.status).toBe(401)
    expect(res.body.reason).toBe('DEVICE_BLOCKED')
  })

  it('login exitoso: usuario activo, contraseña correcta, dispositivo autorizado → token con aud correcto', async () => {
    pool.execute
      .mockResolvedValueOnce([[usuarioBase]])
      .mockResolvedValueOnce([[{ id_dispositivo: 1, estado: 'AUTORIZADO', autorizado: 1 }]])
      .mockResolvedValueOnce([{}]) // UPDATE ultimo_acceso dispositivo
      .mockResolvedValueOnce([{}]) // UPDATE ultimo_acceso usuario
      .mockResolvedValueOnce([{}]) // UPDATE sesiones viejas
      .mockResolvedValueOnce([{}]) // INSERT electron_sesiones

    const res = await request(app).post('/api/electron/auth/login').send({
      username: 'ANTONIO', password: 'clave-correcta', deviceId: 'device-ok', deviceName: 'x'
    })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(typeof res.body.token).toBe('string')
    expect(res.body.user.rol).toBe('ceo')

    const decoded = jwt.verify(res.body.token, process.env.JWT_SECRET_ELECTRON, { audience: 'disfruleg-electron' })
    expect(decoded.id).toBe(usuarioBase.id_usuario)
    expect(decoded.rol).toBe('ceo')
  })

  it('un token con aud distinto (simulando uno de la app web bodega) es rechazado por requireAuthElectron', async () => {
    const tokenOtraApp = jwt.sign({ jti: 'x', id: 1, rol: 'admin' }, process.env.JWT_SECRET_ELECTRON, { audience: 'otra-app' })
    const res = await request(app).get('/api/electron/auth/whoami').set('Authorization', `Bearer ${tokenOtraApp}`)
    expect(res.status).toBe(401)
  })
})
