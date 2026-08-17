/**
 * tests/auth-middleware.test.js — Pruebas unitarias de middleware/auth.js
 *
 * Prueba las tres funciones: requireAuth, requireAdmin, requireModulo
 * Mockea db/pool para no depender de TiDB.
 */

process.env.JWT_SECRET = 'test-secret-bodega'

jest.mock('../db/pool', () => ({ q: jest.fn() }))

const jwt      = require('jsonwebtoken')
const { q }    = require('../db/pool')
const { requireAuth, requireAdmin, requireModulo } = require('../middleware/auth')

// ── Helpers ────────────────────────────────────────────────────

function mockRes() {
  const res = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json   = jest.fn().mockReturnValue(res)
  return res
}

function mockReq(overrides = {}) {
  return { headers: {}, ...overrides }
}

function token(payload, expiresIn = '1h') {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn })
}

beforeEach(() => jest.clearAllMocks())

// ─── requireAuth ───────────────────────────────────────────────

describe('requireAuth', () => {
  it('rechaza sin encabezado Authorization → 401', async () => {
    const req  = mockReq()
    const res  = mockRes()
    const next = jest.fn()
    await requireAuth(req, res, next)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('rechaza si Authorization no empieza con Bearer → 401', async () => {
    const req  = mockReq({ headers: { authorization: 'Basic abc' } })
    const res  = mockRes()
    const next = jest.fn()
    await requireAuth(req, res, next)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('rechaza token inválido → 401', async () => {
    const req  = mockReq({ headers: { authorization: 'Bearer no-es-un-jwt' } })
    const res  = mockRes()
    const next = jest.fn()
    await requireAuth(req, res, next)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('rechaza token expirado → 401', async () => {
    const tk   = token({ id: 1, rol: 'admin' }, '-1s') // ya expiró
    const req  = mockReq({ headers: { authorization: `Bearer ${tk}` } })
    const res  = mockRes()
    const next = jest.fn()
    await requireAuth(req, res, next)
    expect(res.status).toHaveBeenCalledWith(401)
  })

  it('token válido sin jti → pasa y pone req.user', async () => {
    const tk   = token({ id: 1, rol: 'ceo' })
    const req  = mockReq({ headers: { authorization: `Bearer ${tk}` } })
    const res  = mockRes()
    const next = jest.fn()
    await requireAuth(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(req.user).toMatchObject({ id: 1, rol: 'ceo' })
  })

  it('token válido, sesión activa en BD → pasa', async () => {
    q.mockResolvedValue([{ activo: 1 }])
    const tk   = token({ id: 1, rol: 'admin', jti: 'abc-123' })
    const req  = mockReq({ headers: { authorization: `Bearer ${tk}` } })
    const res  = mockRes()
    const next = jest.fn()
    await requireAuth(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('token válido, sesión revocada en BD (activo=0) → 401', async () => {
    q.mockResolvedValue([{ activo: 0 }])
    const tk   = token({ id: 1, rol: 'admin', jti: 'revoked-jti' })
    const req  = mockReq({ headers: { authorization: `Bearer ${tk}` } })
    const res  = mockRes()
    const next = jest.fn()
    await requireAuth(req, res, next)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
    expect(next).not.toHaveBeenCalled()
  })

  it('token válido, fila de sesión no existe → pasa (política: activo por defecto)', async () => {
    q.mockResolvedValue([]) // sin fila → tratar como activa
    const tk   = token({ id: 1, rol: 'admin', jti: 'new-jti' })
    const req  = mockReq({ headers: { authorization: `Bearer ${tk}` } })
    const res  = mockRes()
    const next = jest.fn()
    await requireAuth(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('ya fue autenticado (req.user existe) → llama next sin verificar token', async () => {
    const req  = mockReq({ user: { id: 99, rol: 'admin' } })
    const res  = mockRes()
    const next = jest.fn()
    await requireAuth(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(q).not.toHaveBeenCalled()
  })
})

// ─── requireAdmin ──────────────────────────────────────────────

describe('requireAdmin', () => {
  it('sin req.user → 403', () => {
    const req  = mockReq()
    const res  = mockRes()
    const next = jest.fn()
    requireAdmin(req, res, next)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('rol vendedor → 403', () => {
    const req  = mockReq({ user: { rol: 'vendedor' } })
    const res  = mockRes()
    const next = jest.fn()
    requireAdmin(req, res, next)
    expect(res.status).toHaveBeenCalledWith(403)
  })

  it('rol supervisor → 403', () => {
    const req  = mockReq({ user: { rol: 'supervisor' } })
    const res  = mockRes()
    const next = jest.fn()
    requireAdmin(req, res, next)
    expect(res.status).toHaveBeenCalledWith(403)
  })

  it('rol admin → pasa', () => {
    const req  = mockReq({ user: { rol: 'admin' } })
    const res  = mockRes()
    const next = jest.fn()
    requireAdmin(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
  })

  it('rol ceo → pasa', () => {
    const req  = mockReq({ user: { rol: 'ceo' } })
    const res  = mockRes()
    const next = jest.fn()
    requireAdmin(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
  })
})

// ─── requireModulo ─────────────────────────────────────────────

describe('requireModulo', () => {
  it('admin siempre pasa', () => {
    const mw   = requireModulo('pedidos')
    const req  = mockReq({ user: { rol: 'admin', modulosPermitidos: [] } })
    const res  = mockRes()
    const next = jest.fn()
    mw(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('ceo siempre pasa', () => {
    const mw   = requireModulo('inventario')
    const req  = mockReq({ user: { rol: 'ceo' } })
    const res  = mockRes()
    const next = jest.fn()
    mw(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('supervisor con el módulo permitido → pasa', () => {
    const mw   = requireModulo('mermas')
    const req  = mockReq({ user: { rol: 'supervisor', modulosPermitidos: ['mermas', 'inventario'] } })
    const res  = mockRes()
    const next = jest.fn()
    mw(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('supervisor sin el módulo → 403', () => {
    const mw   = requireModulo('analytics')
    const req  = mockReq({ user: { rol: 'supervisor', modulosPermitidos: ['mermas'] } })
    const res  = mockRes()
    const next = jest.fn()
    mw(req, res, next)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('supervisor sin modulosPermitidos → 403', () => {
    const mw   = requireModulo('pedidos')
    const req  = mockReq({ user: { rol: 'supervisor' } })
    const res  = mockRes()
    const next = jest.fn()
    mw(req, res, next)
    expect(res.status).toHaveBeenCalledWith(403)
  })

  it('devuelve una función (middleware factory)', () => {
    expect(typeof requireModulo('pedidos')).toBe('function')
  })
})
