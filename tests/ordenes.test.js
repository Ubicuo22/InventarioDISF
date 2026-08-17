/**
 * tests/ordenes.test.js — Pruebas de routes/ordenes.js
 *
 * Cubre:
 *   • GET / — filtros de estado y fecha
 *   • GET /pendientes-hoy — procesamiento de historial/carrito
 *   • GET /:folio — 404 y 200
 *   • POST / — crear y actualizar, calcTotal, computarDiffCarrito
 *   • PATCH /:folio/pendiente — resolver con y sin reintegración
 *   • PATCH /:folio/item-cantidad — editar cantidad en carrito y en faltantesDetalle
 *   • PATCH /:folio/mover-a-faltante — pendiente → faltante con detalle
 *   • PATCH /:folio/cambiar-item — sustitución de producto
 *   • PATCH /:folio/resolver-todos — vaciar pendientes y faltantes
 *   • GET/PATCH/DELETE /:folio/lock — locking concurrente
 */

jest.mock('../db/pool', () => ({
  q:    jest.fn(),
  pool: { execute: jest.fn() }
}))

jest.mock('../middleware/auth', () => ({
  requireAuth:   (req, res, next) => { req.user = { rol: 'admin', username: 'test', nombre_completo: 'Tester' }; next() },
  requireAdmin:  (req, res, next) => next(),
  requireModulo: () => (req, res, next) => next()
}))

jest.mock('../utils/actividad', () => ({ registrar: jest.fn() }))

const request = require('supertest')
const app     = require('../app')
const { q }   = require('../db/pool')

beforeEach(() => jest.clearAllMocks())

// ── Fixture helpers ───────────────────────────────────────────

function carritoConRevision({ pendientes = [], faltantes = [], faltantesDetalle = [] } = {}) {
  return {
    'Frutas': [
      { id_producto: 1, nombre_producto: 'Manzana', cantidad: 2, precio_unitario: 10, unidad: 'kg' },
      { id_producto: 2, nombre_producto: 'Naranja', cantidad: 3, precio_unitario: 5,  unidad: 'kg' }
    ],
    __historial__: [{
      tipoEvento: 'revision',
      fecha: '2026-08-17T10:00:00.000Z',
      usuario: 'test',
      totalProductos: 2,
      pendientes,
      faltantes,
      faltantesDetalle
    }]
  }
}

function ordenRow(overrides = {}) {
  return {
    folio_numero:    42,
    id_cliente:      1,
    nombre_cliente:  'Cliente Test',
    nombre_grupo:    'Minorista',
    estado:          'guardada',
    datos_carrito:   JSON.stringify(carritoConRevision()),
    ...overrides
  }
}

// ─── GET /api/ordenes ─────────────────────────────────────────

describe('GET /api/ordenes', () => {
  it('usa estado=guardada por defecto', async () => {
    q.mockResolvedValue([])
    await request(app).get('/api/ordenes')
    expect(q).toHaveBeenCalledWith(
      expect.stringContaining('o.estado = ?'),
      expect.arrayContaining(['guardada'])
    )
  })

  it('respeta estado=registrada cuando se pide', async () => {
    q.mockResolvedValue([])
    await request(app).get('/api/ordenes?estado=registrada')
    expect(q).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['registrada'])
    )
  })

  it('aplica filtro desde cuando se pasa', async () => {
    q.mockResolvedValue([])
    await request(app).get('/api/ordenes?desde=2026-08-01')
    const [, params] = q.mock.calls[0]
    expect(params).toContain('2026-08-01')
  })

  it('aplica filtro hasta cuando se pasa', async () => {
    q.mockResolvedValue([])
    await request(app).get('/api/ordenes?hasta=2026-08-31')
    const [, params] = q.mock.calls[0]
    expect(params).toContain('2026-08-31')
  })

  it('devuelve filas con ok:true', async () => {
    q.mockResolvedValue([{ folio_numero: 1, nombre_cliente: 'Test' }])
    const res = await request(app).get('/api/ordenes')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data).toHaveLength(1)
  })

  it('responde 500 si la BD falla', async () => {
    q.mockRejectedValue(new Error('DB error'))
    const res = await request(app).get('/api/ordenes')
    expect(res.status).toBe(500)
    expect(res.body.ok).toBe(false)
  })
})

// ─── GET /api/ordenes/pendientes-hoy ─────────────────────────

describe('GET /api/ordenes/pendientes-hoy', () => {
  it('omite órdenes sin revisión en historial', async () => {
    const sinRevision = {
      'Frutas': [{ id_producto: 1, nombre_producto: 'Manzana', cantidad: 1, precio_unitario: 10 }],
      __historial__: [{ tipoEvento: 'edicion', cambios: [] }]
    }
    q.mockResolvedValue([{ ...ordenRow(), datos_carrito: JSON.stringify(sinRevision) }])
    const res = await request(app).get('/api/ordenes/pendientes-hoy')
    expect(res.body.data).toHaveLength(0)
  })

  it('omite órdenes con revisión pero sin pendientes ni faltantes', async () => {
    q.mockResolvedValue([{ ...ordenRow(), datos_carrito: JSON.stringify(carritoConRevision()) }])
    const res = await request(app).get('/api/ordenes/pendientes-hoy')
    expect(res.body.data).toHaveLength(0)
  })

  it('incluye órdenes con pendientes y enriquece con cantidad/unidad del carrito', async () => {
    const carrito = carritoConRevision({ pendientes: ['Manzana'] })
    q.mockResolvedValue([{ ...ordenRow(), datos_carrito: JSON.stringify(carrito) }])
    const res = await request(app).get('/api/ordenes/pendientes-hoy')
    expect(res.body.ok).toBe(true)
    expect(res.body.data).toHaveLength(1)
    const pendiente = res.body.data[0].pendientes[0]
    expect(pendiente.nombre).toBe('Manzana')
    expect(pendiente.cantidad).toBe(2)
    expect(pendiente.unidad).toBe('kg')
  })

  it('incluye órdenes con faltantes y toma datos de faltantesDetalle', async () => {
    const carrito = carritoConRevision({
      faltantes: ['Naranja'],
      faltantesDetalle: [{ nombre: 'Naranja', cantidad: 3, unidad: 'kg', seccion: 'Frutas' }]
    })
    q.mockResolvedValue([{ ...ordenRow(), datos_carrito: JSON.stringify(carrito) }])
    const res = await request(app).get('/api/ordenes/pendientes-hoy')
    const faltante = res.body.data[0].faltantes[0]
    expect(faltante.nombre).toBe('Naranja')
    expect(faltante.cantidad).toBe(3)
  })

  it('parsea datos_carrito cuando viene como string', async () => {
    const carrito = carritoConRevision({ pendientes: ['Manzana'] })
    q.mockResolvedValue([{ ...ordenRow(), datos_carrito: JSON.stringify(carrito) }])
    const res = await request(app).get('/api/ordenes/pendientes-hoy')
    expect(res.body.data[0].pendientes).toHaveLength(1)
  })

  it('responde 500 si la BD falla', async () => {
    q.mockRejectedValue(new Error('DB error'))
    const res = await request(app).get('/api/ordenes/pendientes-hoy')
    expect(res.status).toBe(500)
  })
})

// ─── GET /api/ordenes/:folio ──────────────────────────────────

describe('GET /api/ordenes/:folio', () => {
  it('devuelve la orden cuando existe', async () => {
    q.mockResolvedValue([{ folio_numero: 42, nombre_cliente: 'Test' }])
    const res = await request(app).get('/api/ordenes/42')
    expect(res.status).toBe(200)
    expect(res.body.data.folio_numero).toBe(42)
  })

  it('devuelve 404 cuando no existe', async () => {
    q.mockResolvedValue([])
    const res = await request(app).get('/api/ordenes/999')
    expect(res.status).toBe(404)
    expect(res.body.ok).toBe(false)
  })
})

// ─── POST /api/ordenes — crear / actualizar ───────────────────

describe('POST /api/ordenes', () => {
  it('responde 400 sin id_cliente', async () => {
    const res = await request(app).post('/api/ordenes').send({ datos_carrito: {} })
    expect(res.status).toBe(400)
  })

  it('responde 400 sin datos_carrito', async () => {
    const res = await request(app).post('/api/ordenes').send({ id_cliente: 1 })
    expect(res.status).toBe(400)
  })

  it('crea nueva orden — calcTotal suma cantidad×precio correctamente', async () => {
    q.mockResolvedValueOnce([{ next: 7 }])  // MAX folio
    q.mockResolvedValueOnce([])              // INSERT

    const res = await request(app).post('/api/ordenes').send({
      id_cliente: 1,
      datos_carrito: {
        Frutas: [
          { id_producto: 1, nombre_producto: 'Manzana', cantidad: 2, precio_unitario: 10 },
          { id_producto: 2, nombre_producto: 'Naranja', cantidad: '3', precio_unitario: '5' }
        ],
        __observacion__: 'nota interna'   // claves __ deben ignorarse en calcTotal
      }
    })

    expect(res.status).toBe(200)
    expect(res.body.folio_numero).toBe(7)

    // INSERT debe recibir total = 2×10 + 3×5 = 35
    const insertCall = q.mock.calls.find(c => c[0].includes('INSERT INTO ordenes_guardadas'))
    expect(insertCall[1]).toContain(35)
  })

  it('no suma claves que empiezan con __ al total', async () => {
    q.mockResolvedValueOnce([{ next: 1 }])
    q.mockResolvedValueOnce([])

    await request(app).post('/api/ordenes').send({
      id_cliente: 1,
      datos_carrito: {
        __historial__: 'algo que no es array',
        Frutas: [{ id_producto: 1, nombre_producto: 'Mango', cantidad: 1, precio_unitario: 8 }]
      }
    })

    const insertCall = q.mock.calls.find(c => c[0].includes('INSERT INTO ordenes_guardadas'))
    expect(insertCall[1]).toContain(8) // solo 1×8, no procesa __historial__
  })

  it('actualiza orden existente y detecta cambios en el diff', async () => {
    const carritoViejo = {
      Frutas: [{ id_producto: 1, nombre_producto: 'Manzana', cantidad: 2, precio_unitario: 10 }],
      __historial__: []
    }
    const carritoNuevo = {
      Frutas: [{ id_producto: 1, nombre_producto: 'Manzana', cantidad: 5, precio_unitario: 10 }]
      // Manzana cambió de 2 → 5
    }

    q.mockResolvedValueOnce([{ estado: 'guardada', datos_carrito: JSON.stringify(carritoViejo) }])
    q.mockResolvedValueOnce([]) // UPDATE

    const res = await request(app).post('/api/ordenes').send({
      folio_numero: 42,
      id_cliente: 1,
      datos_carrito: carritoNuevo
    })

    expect(res.status).toBe(200)

    // El carrito guardado debe incluir el historial con el cambio
    const updateCall = q.mock.calls.find(c => c[0].includes('UPDATE ordenes_guardadas'))
    const carritoGuardado = JSON.parse(updateCall[1][0])
    const cambios = carritoGuardado.__historial__[0].cambios
    expect(cambios.some(c => c.campo === 'cantidad' && c.antes === 2 && c.despues === 5)).toBe(true)
  })

  it('no agrega entrada de historial si el carrito no cambió', async () => {
    const carrito = {
      Frutas: [{ id_producto: 1, nombre_producto: 'Manzana', cantidad: 2, precio_unitario: 10 }],
      __historial__: []
    }
    q.mockResolvedValueOnce([{ estado: 'guardada', datos_carrito: JSON.stringify(carrito) }])
    q.mockResolvedValueOnce([])

    await request(app).post('/api/ordenes').send({
      folio_numero: 42,
      id_cliente: 1,
      datos_carrito: {
        Frutas: [{ id_producto: 1, nombre_producto: 'Manzana', cantidad: 2, precio_unitario: 10 }]
      }
    })

    const updateCall = q.mock.calls.find(c => c[0].includes('UPDATE ordenes_guardadas'))
    const carritoGuardado = JSON.parse(updateCall[1][0])
    expect(carritoGuardado.__historial__).toHaveLength(0)
  })

  it('rechaza actualizar una orden ya registrada', async () => {
    q.mockResolvedValueOnce([{ estado: 'registrada', datos_carrito: '{}' }])
    const res = await request(app).post('/api/ordenes').send({
      folio_numero: 42, id_cliente: 1, datos_carrito: {}
    })
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
  })

  it('responde 404 si la orden a actualizar no existe', async () => {
    q.mockResolvedValueOnce([])
    const res = await request(app).post('/api/ordenes').send({
      folio_numero: 999, id_cliente: 1, datos_carrito: {}
    })
    expect(res.status).toBe(404)
  })
})

// ─── PATCH /:folio/pendiente ──────────────────────────────────

describe('PATCH /api/ordenes/:folio/pendiente', () => {
  it('responde 400 con folio inválido', async () => {
    const res = await request(app).patch('/api/ordenes/abc/pendiente')
      .send({ tipo: 'pendiente', nombre_producto: 'Manzana' })
    expect(res.status).toBe(400)
  })

  it('responde 400 sin tipo', async () => {
    const res = await request(app).patch('/api/ordenes/42/pendiente')
      .send({ nombre_producto: 'Manzana' })
    expect(res.status).toBe(400)
  })

  it('responde 400 con tipo inválido', async () => {
    const res = await request(app).patch('/api/ordenes/42/pendiente')
      .send({ tipo: 'otro', nombre_producto: 'Manzana' })
    expect(res.status).toBe(400)
  })

  it('responde 404 cuando la orden no existe', async () => {
    q.mockResolvedValue([])
    const res = await request(app).patch('/api/ordenes/42/pendiente')
      .send({ tipo: 'pendiente', nombre_producto: 'Manzana' })
    expect(res.status).toBe(404)
  })

  it('responde 400 si la orden ya está registrada', async () => {
    q.mockResolvedValue([{ estado: 'registrada', datos_carrito: '{}' }])
    const res = await request(app).patch('/api/ordenes/42/pendiente')
      .send({ tipo: 'pendiente', nombre_producto: 'Manzana' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/registrada/i)
  })

  it('responde 400 cuando no hay revisión en el historial', async () => {
    const carrito = { __historial__: [{ tipoEvento: 'edicion', cambios: [] }] }
    q.mockResolvedValue([{ estado: 'guardada', datos_carrito: JSON.stringify(carrito) }])
    const res = await request(app).patch('/api/ordenes/42/pendiente')
      .send({ tipo: 'pendiente', nombre_producto: 'Manzana' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/revisión/i)
  })

  it('resuelve un pendiente eliminándolo del array', async () => {
    const carrito = carritoConRevision({ pendientes: ['Manzana', 'Naranja'] })
    q.mockResolvedValueOnce([{ estado: 'guardada', datos_carrito: JSON.stringify(carrito) }])
    q.mockResolvedValueOnce([]) // UPDATE

    const res = await request(app).patch('/api/ordenes/42/pendiente')
      .send({ tipo: 'pendiente', nombre_producto: 'Manzana' })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)

    // El carrito guardado debe tener solo 'Naranja' en pendientes
    const updateCall = q.mock.calls.find(c => c[0].includes('UPDATE'))
    const carritoGuardado = JSON.parse(updateCall[1][0])
    const rev = carritoGuardado.__historial__[0]
    expect(rev.pendientes).toEqual(['Naranja'])
  })

  it('faltante con llego=true reintegra al carrito (reintegrado:true)', async () => {
    const carrito = carritoConRevision({
      faltantes: ['Naranja'],
      faltantesDetalle: [{
        nombre: 'Naranja', id_producto: 2, cantidad: 3,
        unidad: 'kg', precio_unitario: 5, seccion: 'Frutas'
      }]
    })
    q.mockResolvedValueOnce([{ estado: 'guardada', datos_carrito: JSON.stringify(carrito) }])
    q.mockResolvedValueOnce([]) // UPDATE

    const res = await request(app).patch('/api/ordenes/42/pendiente')
      .send({ tipo: 'faltante', nombre_producto: 'Naranja', llego: true })

    expect(res.status).toBe(200)
    expect(res.body.reintegrado).toBe(true)

    const updateCall = q.mock.calls.find(c => c[0].includes('UPDATE'))
    const carritoGuardado = JSON.parse(updateCall[1][0])
    // Naranja debe estar de vuelta en la sección Frutas
    expect(carritoGuardado['Frutas'].some(i => i.nombre_producto === 'Naranja')).toBe(true)
  })

  it('faltante sin detalle guardado → reintegrado:false', async () => {
    const carrito = carritoConRevision({
      faltantes: ['Limón'],
      faltantesDetalle: []  // sin detalle (faltante viejo)
    })
    q.mockResolvedValueOnce([{ estado: 'guardada', datos_carrito: JSON.stringify(carrito) }])
    q.mockResolvedValueOnce([])

    const res = await request(app).patch('/api/ordenes/42/pendiente')
      .send({ tipo: 'faltante', nombre_producto: 'Limón', llego: true })

    expect(res.body.reintegrado).toBe(false)
  })
})

// ─── PATCH /:folio/item-cantidad ──────────────────────────────

describe('PATCH /api/ordenes/:folio/item-cantidad', () => {
  it('responde 400 sin nombre_producto', async () => {
    const res = await request(app).patch('/api/ordenes/42/item-cantidad').send({ cantidad: 3 })
    expect(res.status).toBe(400)
  })

  it('responde 400 con cantidad negativa', async () => {
    const res = await request(app).patch('/api/ordenes/42/item-cantidad')
      .send({ nombre_producto: 'Manzana', cantidad: -1 })
    expect(res.status).toBe(400)
  })

  it('actualiza la cantidad del producto en el carrito', async () => {
    q.mockResolvedValueOnce([{ estado: 'guardada', datos_carrito: JSON.stringify(carritoConRevision()) }])
    q.mockResolvedValueOnce([])

    const res = await request(app).patch('/api/ordenes/42/item-cantidad')
      .send({ nombre_producto: 'Manzana', cantidad: 10 })

    expect(res.status).toBe(200)
    const updateCall = q.mock.calls.find(c => c[0].includes('UPDATE'))
    const carritoGuardado = JSON.parse(updateCall[1][0])
    const manzana = carritoGuardado['Frutas'].find(i => i.nombre_producto === 'Manzana')
    expect(manzana.cantidad).toBe(10)
  })

  it('actualiza cantidad en faltantesDetalle si el producto ya no está en el carrito', async () => {
    const carrito = carritoConRevision({
      faltantes: ['Limón'],
      faltantesDetalle: [{ nombre: 'Limón', cantidad: 2, unidad: 'kg' }]
    })
    // Limón no está en la sección Frutas del carrito
    q.mockResolvedValueOnce([{ estado: 'guardada', datos_carrito: JSON.stringify(carrito) }])
    q.mockResolvedValueOnce([])

    const res = await request(app).patch('/api/ordenes/42/item-cantidad')
      .send({ nombre_producto: 'Limón', cantidad: 7 })

    expect(res.status).toBe(200)
    const updateCall = q.mock.calls.find(c => c[0].includes('UPDATE'))
    const carritoGuardado = JSON.parse(updateCall[1][0])
    const det = carritoGuardado.__historial__[0].faltantesDetalle[0]
    expect(det.cantidad).toBe(7)
  })

  it('responde 404 si el producto no está ni en el carrito ni en faltantesDetalle', async () => {
    q.mockResolvedValueOnce([{ estado: 'guardada', datos_carrito: JSON.stringify(carritoConRevision()) }])
    const res = await request(app).patch('/api/ordenes/42/item-cantidad')
      .send({ nombre_producto: 'Producto inexistente', cantidad: 1 })
    expect(res.status).toBe(404)
  })
})

// ─── PATCH /:folio/mover-a-faltante ──────────────────────────

describe('PATCH /api/ordenes/:folio/mover-a-faltante', () => {
  it('responde 400 sin nombre_producto', async () => {
    const res = await request(app).patch('/api/ordenes/42/mover-a-faltante').send({})
    expect(res.status).toBe(400)
  })

  it('mueve el producto de pendientes → faltantes y guarda detalle', async () => {
    const carrito = carritoConRevision({ pendientes: ['Manzana'] })
    q.mockResolvedValueOnce([{ estado: 'guardada', datos_carrito: JSON.stringify(carrito) }])
    q.mockResolvedValueOnce([])

    const res = await request(app).patch('/api/ordenes/42/mover-a-faltante')
      .send({ nombre_producto: 'Manzana' })

    expect(res.status).toBe(200)
    const updateCall = q.mock.calls.find(c => c[0].includes('UPDATE'))
    const carritoGuardado = JSON.parse(updateCall[1][0])
    const rev = carritoGuardado.__historial__[0]
    expect(rev.pendientes).not.toContain('Manzana')
    expect(rev.faltantes).toContain('Manzana')
    expect(rev.faltantesDetalle[0].nombre).toBe('Manzana')
  })

  it('descuenta Manzana del carrito al moverla a faltantes (no suma al total)', async () => {
    const carrito = carritoConRevision({ pendientes: ['Manzana'] })
    q.mockResolvedValueOnce([{ estado: 'guardada', datos_carrito: JSON.stringify(carrito) }])
    q.mockResolvedValueOnce([])

    await request(app).patch('/api/ordenes/42/mover-a-faltante')
      .send({ nombre_producto: 'Manzana' })

    const updateCall = q.mock.calls.find(c => c[0].includes('UPDATE'))
    const carritoGuardado = JSON.parse(updateCall[1][0])
    // Manzana debe haber sido eliminada de la sección Frutas
    const manzanas = (carritoGuardado['Frutas'] || []).filter(i => i.nombre_producto === 'Manzana')
    expect(manzanas).toHaveLength(0)
  })
})

// ─── PATCH /:folio/cambiar-item ───────────────────────────────

describe('PATCH /api/ordenes/:folio/cambiar-item', () => {
  it('responde 400 sin nombre_viejo', async () => {
    const res = await request(app).patch('/api/ordenes/42/cambiar-item')
      .send({ id_nuevo: 5, nombre_nuevo: 'Plátano' })
    expect(res.status).toBe(400)
  })

  it('responde 400 sin id_nuevo', async () => {
    const res = await request(app).patch('/api/ordenes/42/cambiar-item')
      .send({ nombre_viejo: 'Manzana', nombre_nuevo: 'Plátano' })
    expect(res.status).toBe(400)
  })

  it('sustituye el producto en el carrito', async () => {
    q.mockResolvedValueOnce([{ estado: 'guardada', datos_carrito: JSON.stringify(carritoConRevision()) }])
    q.mockResolvedValueOnce([])

    const res = await request(app).patch('/api/ordenes/42/cambiar-item')
      .send({ nombre_viejo: 'Manzana', id_nuevo: 9, nombre_nuevo: 'Plátano', unidad_nueva: 'kg' })

    expect(res.status).toBe(200)
    const updateCall = q.mock.calls.find(c => c[0].includes('UPDATE'))
    const carritoGuardado = JSON.parse(updateCall[1][0])
    expect(carritoGuardado['Frutas'].some(i => i.nombre_producto === 'Plátano')).toBe(true)
    expect(carritoGuardado['Frutas'].some(i => i.nombre_producto === 'Manzana')).toBe(false)
  })

  it('responde 404 si el producto no existe en el carrito', async () => {
    q.mockResolvedValueOnce([{ estado: 'guardada', datos_carrito: JSON.stringify(carritoConRevision()) }])
    const res = await request(app).patch('/api/ordenes/42/cambiar-item')
      .send({ nombre_viejo: 'Sandía', id_nuevo: 9, nombre_nuevo: 'Plátano' })
    expect(res.status).toBe(404)
  })
})

// ─── PATCH /:folio/resolver-todos ────────────────────────────

describe('PATCH /api/ordenes/:folio/resolver-todos', () => {
  it('responde 400 con folio inválido', async () => {
    const res = await request(app).patch('/api/ordenes/xyz/resolver-todos')
    expect(res.status).toBe(400)
  })

  it('vacía pendientes y faltantes de la última revisión', async () => {
    const carrito = carritoConRevision({ pendientes: ['Manzana'], faltantes: ['Naranja'] })
    q.mockResolvedValueOnce([{ estado: 'guardada', datos_carrito: JSON.stringify(carrito) }])
    q.mockResolvedValueOnce([])

    const res = await request(app).patch('/api/ordenes/42/resolver-todos')
    expect(res.status).toBe(200)

    const updateCall = q.mock.calls.find(c => c[0].includes('UPDATE'))
    const carritoGuardado = JSON.parse(updateCall[1][0])
    const rev = carritoGuardado.__historial__[0]
    expect(rev.pendientes).toHaveLength(0)
    expect(rev.faltantes).toHaveLength(0)
    expect(rev.faltantesDetalle).toHaveLength(0)
  })

  it('responde 400 si la orden no tiene revisión', async () => {
    q.mockResolvedValue([{ estado: 'guardada', datos_carrito: '{"__historial__":[]}' }])
    const res = await request(app).patch('/api/ordenes/42/resolver-todos')
    expect(res.status).toBe(400)
  })
})

// ─── GET/PATCH/DELETE /:folio/lock ───────────────────────────

describe('Lock concurrente', () => {
  it('GET /:folio/lock → locked:false cuando editing_by es null', async () => {
    q.mockResolvedValue([{ editing_by: null, editing_at: null, editing_source: null }])
    const res = await request(app).get('/api/ordenes/42/lock')
    expect(res.status).toBe(200)
    expect(res.body.locked).toBe(false)
  })

  it('GET /:folio/lock → locked:true cuando hay lock reciente (< 5 min)', async () => {
    const hace2min = new Date(Date.now() - 2 * 60 * 1000).toISOString()
    q.mockResolvedValue([{ editing_by: 'otro-usuario', editing_at: hace2min, editing_source: 'electron' }])
    const res = await request(app).get('/api/ordenes/42/lock')
    expect(res.body.locked).toBe(true)
    expect(res.body.editing_by).toBe('otro-usuario')
  })

  it('GET /:folio/lock → locked:false cuando el lock expiró (> 5 min)', async () => {
    const hace10min = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    q.mockResolvedValue([{ editing_by: 'otro', editing_at: hace10min, editing_source: 'electron' }])
    const res = await request(app).get('/api/ordenes/42/lock')
    expect(res.body.locked).toBe(false)
  })

  it('GET /:folio/lock → 404 cuando la orden no existe', async () => {
    q.mockResolvedValue([])
    const res = await request(app).get('/api/ordenes/42/lock')
    expect(res.status).toBe(404)
  })

  it('PATCH /:folio/lock → adquiere el lock cuando no hay lock activo', async () => {
    q.mockResolvedValueOnce([{ editing_by: null, editing_at: null }]) // SELECT
    q.mockResolvedValueOnce([])                                         // UPDATE
    const res = await request(app).patch('/api/ordenes/42/lock')
    expect(res.body.ok).toBe(true)
    expect(res.body.locked).toBe(false)
  })

  it('PATCH /:folio/lock → rechaza si otro usuario tiene el lock', async () => {
    const hace1min = new Date(Date.now() - 60 * 1000).toISOString()
    q.mockResolvedValue([{ editing_by: 'otro-usuario', editing_at: hace1min, editing_source: 'electron' }])
    const res = await request(app).patch('/api/ordenes/42/lock')
    expect(res.body.ok).toBe(false)
    expect(res.body.locked).toBe(true)
  })

  it('DELETE /:folio/lock → libera el lock', async () => {
    q.mockResolvedValue([])
    const res = await request(app).delete('/api/ordenes/42/lock')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(q).toHaveBeenCalledWith(
      expect.stringContaining('editing_by = NULL'),
      expect.anything()
    )
  })
})
