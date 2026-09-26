/**
 * tests/tickets.test.js — Tickets de compra: subida (PWA) y bandeja (Electron)
 *
 * Ver docs/PLAN-TICKETS-COMPRA.md. R2 va mockeado (utils/tickets-r2): en
 * Node no hay binding. Mismo patrón de mocks que electron-pagos.test.js.
 */

let mockUserWeb = { id: 1, username: 'CEO1', rol: 'ceo' }
let mockUserElectron = { id: 2, username: 'CAPT', nombre: 'Capturista', rol: 'cajero' }

jest.mock('../db/pool', () => ({
  q:    jest.fn(),
  pool: { execute: jest.fn(), getConnection: jest.fn() }
}))

jest.mock('../middleware/auth', () => ({
  requireAuth:   (req, res, next) => { req.user = mockUserWeb; next() },
  requireAdmin:  (req, res, next) => next(),
  requireModulo: () => (req, res, next) => next(),
  invalidarCache: () => {}
}))

jest.mock('../middleware/auth-electron', () => ({
  requireAuthElectron: (req, res, next) => { req.user = mockUserElectron; next() },
  requireRoleElectron: (roles) => (req, res, next) => {
    req.user = mockUserElectron
    if (!roles.includes(mockUserElectron.rol)) return res.status(403).json({ ok: false, error: 'No tienes permisos para realizar esta acción.' })
    next()
  },
  invalidarCacheElectron: () => {},
  AUD: 'disfruleg-electron'
}))

jest.mock('../utils/tickets-r2', () => ({
  disponible: jest.fn().mockResolvedValue(true),
  guardar:    jest.fn().mockResolvedValue(undefined),
  leer:       jest.fn(),
  borrar:     jest.fn().mockResolvedValue(undefined),
}))

const request = require('supertest')
const app = require('../app')
const { q } = require('../db/pool')
const r2 = require('../utils/tickets-r2')
const { detectarTipo } = require('../utils/tickets')

const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(200, 1)])
const PDF  = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200, 2)])

beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {})
})
beforeEach(() => {
  jest.clearAllMocks()
  q.mockReset()
  r2.disponible.mockResolvedValue(true)
  mockUserWeb = { id: 1, username: 'CEO1', rol: 'ceo' }
  mockUserElectron = { id: 2, username: 'CAPT', nombre: 'Capturista', rol: 'cajero' }
})

const subir = (buf, query = '') => request(app)
  .post(`/api/tickets/7/archivos${query}`)
  .set('Content-Type', 'application/octet-stream')
  .send(buf)

// ═══ detectarTipo ═══════════════════════════════════════════════
describe('detectarTipo', () => {
  it('reconoce por contenido, no por nombre', () => {
    expect(detectarTipo(JPEG)).toBe('image/jpeg')
    expect(detectarTipo(PDF)).toBe('application/pdf')
    expect(detectarTipo(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(10)]))).toBe('image/webp')
    expect(detectarTipo(Buffer.from('PK\x03\x04 esto es un zip.....'))).toBeNull()
    expect(detectarTipo(Buffer.from('<html>no</html>......'))).toBeNull()
  })
})

// ═══ PWA ════════════════════════════════════════════════════════
describe('POST /api/tickets', () => {
  it('solo el CEO puede crear (403 a admin)', async () => {
    mockUserWeb.rol = 'admin'
    const res = await request(app).post('/api/tickets').send({})
    expect(res.status).toBe(403)
    expect(q).not.toHaveBeenCalled()
  })

  it('crea en borrador a nombre de la sesión', async () => {
    q.mockResolvedValueOnce({ insertId: 7 })
    const res = await request(app).post('/api/tickets').send({ nota: '  mercado martes  ', subido_por: 'OTRO' })
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(7)
    expect(q.mock.calls[0][1]).toEqual(['mercado martes', 'CEO1'])
  })
})

describe('POST /api/tickets/:id/archivos', () => {
  const borrador = [{ id: 7, estado: 'borrador', subido_por: 'CEO1' }]

  it('rechaza lo que no es imagen ni PDF, aunque diga serlo', async () => {
    const res = await request(app).post('/api/tickets/7/archivos')
      .set('Content-Type', 'image/jpeg').send(Buffer.from('esto no es un jpeg, es texto'))
    expect(res.status).toBe(415)
    expect(r2.guardar).not.toHaveBeenCalled()
  })

  it('rechaza imagen de más de 3 MB', async () => {
    const grande = Buffer.concat([JPEG, Buffer.alloc(3 * 1024 * 1024)])
    const res = await subir(grande)
    expect(res.status).toBe(413)
  })

  it('no deja subir a un ticket ajeno', async () => {
    q.mockResolvedValueOnce([{ id: 7, estado: 'borrador', subido_por: 'OTRO_CEO' }])
    const res = await subir(JPEG)
    expect(res.status).toBe(404)
    expect(r2.guardar).not.toHaveBeenCalled()
  })

  it('no deja subir a un ticket ya enviado', async () => {
    q.mockResolvedValueOnce([{ id: 7, estado: 'pendiente', subido_por: 'CEO1' }])
    const res = await subir(JPEG)
    expect(res.status).toBe(409)
  })

  it('avisa si el mismo archivo ya se subió en otro ticket', async () => {
    q.mockResolvedValueOnce(borrador)
      .mockResolvedValueOnce([{ n: 0 }])
      .mockResolvedValueOnce([{ id: 3, fecha_subida: '2026-09-20', subido_por: 'CEO1', estado: 'capturado' }])
    const res = await subir(JPEG)
    expect(res.status).toBe(409)
    expect(res.body.duplicado.id).toBe(3)
    expect(r2.guardar).not.toHaveBeenCalled()
  })

  it('con ?forzar=1 acepta el duplicado', async () => {
    q.mockResolvedValueOnce(borrador)
      .mockResolvedValueOnce([{ n: 0 }])
      .mockResolvedValueOnce({ insertId: 55 })
    const res = await subir(JPEG, '?forzar=1')
    expect(res.status).toBe(200)
    expect(r2.guardar).toHaveBeenCalledTimes(1)
    const [key, , tipo] = r2.guardar.mock.calls[0]
    expect(key).toMatch(/^tickets\/\d{4}\/\d{2}\/[0-9a-f-]+\.jpg$/)
    expect(tipo).toBe('image/jpeg')
  })

  it('guarda PDF con su tipo real', async () => {
    q.mockResolvedValueOnce(borrador)
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ insertId: 56 })
    const res = await subir(PDF)
    expect(res.status).toBe(200)
    expect(res.body.data.tipo).toBe('application/pdf')
    // orden = archivos previos + 1
    expect(q.mock.calls[3][1][1]).toBe(2)
  })

  it('503 si no hay bucket (Mac Mini)', async () => {
    r2.disponible.mockResolvedValue(false)
    q.mockResolvedValueOnce(borrador).mockResolvedValueOnce([{ n: 0 }]).mockResolvedValueOnce([])
    const res = await subir(JPEG)
    expect(res.status).toBe(503)
  })
})

describe('POST /api/tickets/:id/enviar', () => {
  it('400 sin archivos', async () => {
    q.mockResolvedValueOnce([{ id: 7, estado: 'borrador', subido_por: 'CEO1' }]).mockResolvedValueOnce([{ n: 0 }])
    const res = await request(app).post('/api/tickets/7/enviar')
    expect(res.status).toBe(400)
  })

  it('pasa a pendiente', async () => {
    q.mockResolvedValueOnce([{ id: 7, estado: 'borrador', subido_por: 'CEO1' }])
      .mockResolvedValueOnce([{ n: 2 }])
      .mockResolvedValueOnce({ affectedRows: 1 })
    const res = await request(app).post('/api/tickets/7/enviar')
    expect(res.status).toBe(200)
    expect(q.mock.calls[2][0]).toMatch(/estado = 'pendiente'/)
  })
})

// ═══ Electron ═══════════════════════════════════════════════════
describe('POST /api/electron/tickets/:id/tomar', () => {
  it('aparta un pendiente', async () => {
    q.mockResolvedValueOnce({ affectedRows: 1 })
    const res = await request(app).post('/api/electron/tickets/7/tomar')
    expect(res.status).toBe(200)
    expect(q.mock.calls[0][1]).toEqual(['CAPT', '7', 'CAPT'])
  })

  it('409 si otra persona ya lo está capturando', async () => {
    q.mockResolvedValueOnce({ affectedRows: 0 })
      .mockResolvedValueOnce([{ id: 7, estado: 'en_captura', capturando_por: 'OTRA', capturando_por_nombre: 'Otra Persona' }])
    const res = await request(app).post('/api/electron/tickets/7/tomar')
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/Otra Persona/)
  })
})

describe('POST /api/electron/tickets/:id/terminar', () => {
  const enCaptura = [{ id: 7, estado: 'en_captura', capturando_por: 'CAPT' }]
  const compras = (...totales) => totales.map((t, i) => ({ id_compra: i + 1, total_con_impuestos: t }))

  it('400 sin total', async () => {
    const res = await request(app).post('/api/electron/tickets/7/terminar').send({})
    expect(res.status).toBe(400)
  })

  it('409 si no lo tengo en captura', async () => {
    q.mockResolvedValueOnce([{ id: 7, estado: 'en_captura', capturando_por: 'OTRA' }])
    const res = await request(app).post('/api/electron/tickets/7/terminar').send({ totalTicket: 100 })
    expect(res.status).toBe(409)
  })

  it('400 sin compras ligadas', async () => {
    q.mockResolvedValueOnce(enCaptura).mockResolvedValueOnce([])
    const res = await request(app).post('/api/electron/tickets/7/terminar').send({ totalTicket: 100 })
    expect(res.status).toBe(400)
  })

  it('descuadre sin motivo: no cierra y devuelve la diferencia (suma calculada en BD)', async () => {
    q.mockResolvedValueOnce(enCaptura).mockResolvedValueOnce(compras('1050.00', '120.00'))
    const res = await request(app).post('/api/electron/tickets/7/terminar')
      .send({ totalTicket: 1270, suma: 1270 /* el renderer no decide la suma */ })
    expect(res.status).toBe(409)
    expect(res.body.reason).toBe('DESCUADRE')
    expect(res.body.descuadre).toEqual({ suma: 1170, total: 1270, diferencia: -100 })
    expect(q).toHaveBeenCalledTimes(2)
  })

  it('dentro de la tolerancia cierra sin motivo', async () => {
    q.mockResolvedValueOnce(enCaptura)
      .mockResolvedValueOnce(compras('1050.40', '120.00'))
      .mockResolvedValueOnce({ affectedRows: 1 })
    const res = await request(app).post('/api/electron/tickets/7/terminar').send({ totalTicket: 1170, idProveedor: 4 })
    expect(res.status).toBe(200)
    const params = q.mock.calls[2][1]
    expect(params[0]).toBe('CAPT')
    expect(params[5]).toBeNull() // diferencia_aceptada
  })

  it('descuadre con motivo: cierra y guarda la diferencia', async () => {
    q.mockResolvedValueOnce(enCaptura)
      .mockResolvedValueOnce(compras('1170.00'))
      .mockResolvedValueOnce({ affectedRows: 1 })
    const res = await request(app).post('/api/electron/tickets/7/terminar')
      .send({ totalTicket: 1270, motivoDiferencia: 'bolsas no se registran' })
    expect(res.status).toBe(200)
    const params = q.mock.calls[2][1]
    expect(params[5]).toBe(-100)
    expect(params[6]).toBe('bolsas no se registran')
  })
})

describe('POST /api/electron/tickets/:id/descartar y /liberar', () => {
  it('descartar exige motivo', async () => {
    const res = await request(app).post('/api/electron/tickets/7/descartar').send({})
    expect(res.status).toBe(400)
  })

  it('descartar con compras ligadas → 409', async () => {
    q.mockResolvedValueOnce({ affectedRows: 0 })
    const res = await request(app).post('/api/electron/tickets/7/descartar').send({ motivo: 'duplicado' })
    expect(res.status).toBe(409)
    expect(q.mock.calls[0][0]).toMatch(/NOT EXISTS \(SELECT 1 FROM compra/)
  })

  it('liberar es solo admin/ceo', async () => {
    const res = await request(app).post('/api/electron/tickets/7/liberar')
    expect(res.status).toBe(403)
    mockUserElectron.rol = 'admin'
    q.mockResolvedValueOnce({ affectedRows: 1 })
    const ok = await request(app).post('/api/electron/tickets/7/liberar')
    expect(ok.status).toBe(200)
  })
})

describe('GET /api/electron/tickets/:id/archivos/:idArchivo', () => {
  it('sirve con su tipo y sin caché compartida', async () => {
    q.mockResolvedValueOnce([{ r2_key: 'tickets/2026/09/x.pdf', tipo: 'application/pdf' }])
    r2.leer.mockResolvedValueOnce(PDF)
    const res = await request(app).get('/api/electron/tickets/7/archivos/3')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/pdf/)
    expect(res.headers['cache-control']).toMatch(/private/)
    // el archivo se busca junto con su ticket
    expect(q.mock.calls[0][1]).toEqual(['3', '7'])
  })
})
