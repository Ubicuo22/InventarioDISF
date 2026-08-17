/**
 * tests/precios.test.js — Pruebas de routes/precios.js
 *
 * Regressions que estos tests previenen:
 *   • SQL que referencia grupo.descuento (columna inexistente → crash silencioso)
 *   • Módulo entero sin datos porque el error no llegaba al frontend
 *   • Validaciones de entrada que el backend debe hacer primero
 */

// Mocks globales — se cargan ANTES de que app.js/precios.js requieran los módulos reales
jest.mock('../db/pool', () => ({
  q:    jest.fn(),
  pool: { execute: jest.fn() }
}))

// Suplanta auth para que los tests no dependan de JWT/TiDB
jest.mock('../middleware/auth', () => ({
  requireAuth:  (req, res, next) => { req.user = { rol: 'ceo', id_usuario: 1 }; next() },
  requireAdmin: (req, res, next) => next(),
  requireModulo: () => (req, res, next) => next()
}))

const request  = require('supertest')
const app      = require('../app')
const { q, pool } = require('../db/pool')

beforeEach(() => {
  jest.clearAllMocks()
})

// ─── GET /api/precios/grupos ──────────────────────────────────

describe('GET /api/precios/grupos', () => {
  it('devuelve la lista de grupos con ok:true', async () => {
    q.mockResolvedValue([
      { id_grupo: 1, nombre_grupo: 'Minorista', descuento: 0 },
      { id_grupo: 2, nombre_grupo: 'Mayorista', descuento: 10 }
    ])
    const res = await request(app).get('/api/precios/grupos')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data).toHaveLength(2)
  })

  it('NO referencia grupo.descuento directamente (regression bug)', async () => {
    q.mockResolvedValue([])
    await request(app).get('/api/precios/grupos')
    const sql = q.mock.calls[0][0]
    // El bug original: SELECT ... COALESCE(descuento, 0) FROM grupo
    // La corrección: join a tipo_cliente para obtener descuento
    expect(sql).not.toMatch(/\bFROM\s+grupo\b[^J]*COALESCE\s*\(\s*descuento/i)
    expect(sql).toMatch(/tipo_cliente/i)
  })

  it('responde 500 con ok:false si la BD falla', async () => {
    q.mockRejectedValue(new Error("Unknown column 'descuento' in 'field list'"))
    const res = await request(app).get('/api/precios/grupos')
    expect(res.status).toBe(500)
    expect(res.body.ok).toBe(false)
    expect(res.body.error).toMatch(/descuento/)
  })

  it('devuelve array vacío cuando no hay grupos', async () => {
    q.mockResolvedValue([])
    const res = await request(app).get('/api/precios/grupos')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })
})

// ─── GET /api/precios?id_grupo=X ─────────────────────────────

describe('GET /api/precios', () => {
  it('responde 400 sin id_grupo', async () => {
    const res = await request(app).get('/api/precios')
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
  })

  it('devuelve productos con precio_final calculado', async () => {
    q.mockResolvedValue([
      { id_producto: 5, nombre_producto: 'Naranja', unidad_producto: 'kg',
        precio_base: 20, descuento: 0, precio_final: 20 }
    ])
    const res = await request(app).get('/api/precios?id_grupo=1')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data[0].precio_final).toBe(20)
  })

  it('pasa id_grupo como parámetro al query', async () => {
    q.mockResolvedValue([])
    await request(app).get('/api/precios?id_grupo=7')
    expect(q).toHaveBeenCalledWith(expect.any(String), ['7'])
  })

  it('SQL no usa g.descuento — usa join a tipo_cliente (regression)', async () => {
    q.mockResolvedValue([])
    await request(app).get('/api/precios?id_grupo=1')
    const sql = q.mock.calls[0][0]
    expect(sql).not.toMatch(/g\.descuento/i)
    expect(sql).toMatch(/tipo_cliente/i)
    expect(sql).toMatch(/tc\.descuento/i)
  })

  it('responde 500 si la BD falla', async () => {
    q.mockRejectedValue(new Error('DB error'))
    const res = await request(app).get('/api/precios?id_grupo=1')
    expect(res.status).toBe(500)
    expect(res.body.ok).toBe(false)
  })
})

// ─── PUT /api/precios — upsert precio individual ─────────────

describe('PUT /api/precios', () => {
  it('responde 400 sin id_producto', async () => {
    const res = await request(app).put('/api/precios').send({ id_grupo: 1, precio_base: 10 })
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
  })

  it('responde 400 sin id_grupo', async () => {
    const res = await request(app).put('/api/precios').send({ id_producto: 1, precio_base: 10 })
    expect(res.status).toBe(400)
  })

  it('responde 400 sin precio_base', async () => {
    const res = await request(app).put('/api/precios').send({ id_producto: 1, id_grupo: 1 })
    expect(res.status).toBe(400)
  })

  it('responde 400 con precio negativo', async () => {
    const res = await request(app).put('/api/precios').send({ id_producto: 1, id_grupo: 1, precio_base: -5 })
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
  })

  it('precio_base = 0 → ejecuta DELETE', async () => {
    pool.execute.mockResolvedValue([{ affectedRows: 1 }, []])
    const res = await request(app).put('/api/precios').send({ id_producto: 3, id_grupo: 1, precio_base: 0 })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(pool.execute).toHaveBeenCalledWith(
      expect.stringContaining('DELETE'),
      [3, 1]
    )
  })

  it('precio_base > 0 → ejecuta UPSERT (INSERT ... ON DUPLICATE KEY)', async () => {
    pool.execute.mockResolvedValue([{ affectedRows: 1 }, []])
    const res = await request(app).put('/api/precios').send({ id_producto: 3, id_grupo: 1, precio_base: 25.5 })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(pool.execute).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT.*ON DUPLICATE KEY/s),
      [3, 1, 25.5]
    )
  })

  it('responde 500 si la BD falla', async () => {
    pool.execute.mockRejectedValue(new Error('DB error'))
    const res = await request(app).put('/api/precios').send({ id_producto: 1, id_grupo: 1, precio_base: 10 })
    expect(res.status).toBe(500)
    expect(res.body.ok).toBe(false)
  })
})

// ─── POST /api/precios/ajuste-masivo ─────────────────────────

describe('POST /api/precios/ajuste-masivo', () => {
  it('responde 400 sin id_grupo', async () => {
    const res = await request(app).post('/api/precios/ajuste-masivo').send({ pct: 10 })
    expect(res.status).toBe(400)
  })

  it('responde 400 sin pct', async () => {
    const res = await request(app).post('/api/precios/ajuste-masivo').send({ id_grupo: 1 })
    expect(res.status).toBe(400)
  })

  it('aplica el aumento y devuelve actualizados', async () => {
    pool.execute.mockResolvedValue([{ affectedRows: 12 }, []])
    const res = await request(app).post('/api/precios/ajuste-masivo').send({ id_grupo: 1, pct: 10 })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.actualizados).toBe(12)
  })

  it('calcula el factor correcto (10% → ×1.10)', async () => {
    pool.execute.mockResolvedValue([{ affectedRows: 5 }, []])
    await request(app).post('/api/precios/ajuste-masivo').send({ id_grupo: 1, pct: 10 })
    expect(pool.execute).toHaveBeenCalledWith(
      expect.any(String),
      [1.1, 1]
    )
  })

  it('responde 400 con pct que produce factor ≤ 0', async () => {
    const res = await request(app).post('/api/precios/ajuste-masivo').send({ id_grupo: 1, pct: -200 })
    expect(res.status).toBe(400)
  })
})

// ─── POST /api/precios/copiar-grupo ──────────────────────────

describe('POST /api/precios/copiar-grupo', () => {
  it('responde 400 sin id_grupo_origen', async () => {
    const res = await request(app).post('/api/precios/copiar-grupo').send({ id_grupo_destino: 2 })
    expect(res.status).toBe(400)
  })

  it('responde 400 sin id_grupo_destino', async () => {
    const res = await request(app).post('/api/precios/copiar-grupo').send({ id_grupo_origen: 1 })
    expect(res.status).toBe(400)
  })

  it('responde 400 cuando origen y destino son el mismo grupo', async () => {
    const res = await request(app).post('/api/precios/copiar-grupo')
      .send({ id_grupo_origen: 3, id_grupo_destino: 3 })
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
    expect(res.body.error).toMatch(/mismo grupo/i)
  })

  it('sobrescribir=false → usa INSERT IGNORE', async () => {
    pool.execute.mockResolvedValue([{ affectedRows: 8 }, []])
    await request(app).post('/api/precios/copiar-grupo')
      .send({ id_grupo_origen: 1, id_grupo_destino: 2, sobrescribir: false })
    expect(pool.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT IGNORE'),
      [2, 1]
    )
  })

  it('sobrescribir=true → usa ON DUPLICATE KEY UPDATE', async () => {
    pool.execute.mockResolvedValue([{ affectedRows: 8 }, []])
    await request(app).post('/api/precios/copiar-grupo')
      .send({ id_grupo_origen: 1, id_grupo_destino: 2, sobrescribir: true })
    expect(pool.execute).toHaveBeenCalledWith(
      expect.stringContaining('ON DUPLICATE KEY UPDATE'),
      [2, 1]
    )
  })

  it('devuelve copiados con el count de filas afectadas', async () => {
    pool.execute.mockResolvedValue([{ affectedRows: 15 }, []])
    const res = await request(app).post('/api/precios/copiar-grupo')
      .send({ id_grupo_origen: 1, id_grupo_destino: 2 })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.copiados).toBe(15)
  })
})
