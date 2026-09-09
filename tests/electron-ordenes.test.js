/**
 * tests/electron-ordenes.test.js — Pruebas de routes/electron/ordenes.js
 *
 * H-5 Fase 4: tramo B1 (lecturas puras, patrón híbrido igual que
 * tiposCliente/usuarios/dispositivos) + tramo B2 (bloqueo de edición,
 * compartido con bodega-web — ver tests/ordenes.test.js para el lado
 * espejo del candado no-Electron) + tramo B3 (escrituras simples, sin
 * respaldo local, con gate de rol real vía mockUser mutable — mismo
 * criterio que electron-usuarios.test.js).
 */

let mockUser = { id: 1, username: 'TEST', nombre: 'Usuario de Prueba', rol: 'admin' }

jest.mock('../db/pool', () => ({
  q:    jest.fn(),
  pool: { execute: jest.fn(), getConnection: jest.fn() }
}))

jest.mock('../middleware/auth-electron', () => ({
  requireAuthElectron: (req, res, next) => { req.user = mockUser; next() },
  requireRoleElectron: (roles) => (req, res, next) => {
    req.user = mockUser
    if (!roles.includes(mockUser.rol)) return res.status(403).json({ ok: false, error: 'No tienes permisos para realizar esta acción.' })
    next()
  },
  invalidarCacheElectron: () => {},
  AUD: 'disfruleg-electron'
}))

const request = require('supertest')
const app = require('../app')
const { q, pool } = require('../db/pool')

function mockConn(executeResponses = []) {
  const conn = {
    execute:          jest.fn(),
    beginTransaction: jest.fn().mockResolvedValue(undefined),
    commit:           jest.fn().mockResolvedValue(undefined),
    rollback:         jest.fn().mockResolvedValue(undefined),
    release:          jest.fn()
  }
  for (const resp of executeResponses) conn.execute.mockResolvedValueOnce(resp)
  conn.execute.mockResolvedValue([{ affectedRows: 1, insertId: 1 }, []])
  pool.getConnection.mockResolvedValue(conn)
  return conn
}

beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})
beforeEach(() => {
  jest.clearAllMocks()
  mockUser = { id: 1, username: 'TEST', nombre: 'Usuario de Prueba', rol: 'admin' }
})

describe('GET /api/electron/ordenes — obtenerTodas', () => {
  it('devuelve las órdenes con ok:true', async () => {
    q.mockResolvedValueOnce([
      { folio_numero: 500, total_estimado: '100.00', datos_carrito: JSON.stringify({ a: [{ cantidad: 2, precio_unitario: 50 }] }) }
    ])
    const res = await request(app).get('/api/electron/ordenes')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data).toHaveLength(1)
  })

  it('corrige el total en la respuesta y en BD si no cuadra con el carrito', async () => {
    q
      .mockResolvedValueOnce([
        { folio_numero: 501, total_estimado: '999.00', datos_carrito: JSON.stringify({ a: [{ cantidad: 2, precio_unitario: 50 }] }) }
      ])
      .mockResolvedValueOnce([]) // UPDATE de corrección
    const res = await request(app).get('/api/electron/ordenes')
    expect(res.body.data[0].total_estimado).toBe(100)
    expect(q).toHaveBeenCalledWith(
      'UPDATE ordenes_guardadas SET total_estimado = ? WHERE folio_numero = ?',
      [100, 501]
    )
  })

  it('500 si la BD falla', async () => {
    q.mockRejectedValue(new Error('boom'))
    const res = await request(app).get('/api/electron/ordenes')
    expect(res.status).toBe(500)
    expect(res.body.ok).toBe(false)
  })
})

describe('GET /api/electron/ordenes/activas y /historial', () => {
  it('activas filtra por estado guardada', async () => {
    q.mockResolvedValueOnce([])
    const res = await request(app).get('/api/electron/ordenes/activas')
    expect(res.status).toBe(200)
    expect(q.mock.calls[0][0]).toMatch(/estado = 'guardada'/)
  })

  it('historial filtra por estado registrada', async () => {
    q.mockResolvedValueOnce([])
    const res = await request(app).get('/api/electron/ordenes/historial')
    expect(res.status).toBe(200)
    expect(q.mock.calls[0][0]).toMatch(/estado = 'registrada'/)
  })
})

describe('GET /api/electron/ordenes/folio/:folio', () => {
  it('devuelve la orden cuando existe', async () => {
    q.mockResolvedValueOnce([{ folio_numero: 502, total_estimado: '10.00', datos_carrito: '{}' }])
    const res = await request(app).get('/api/electron/ordenes/folio/502')
    expect(res.status).toBe(200)
    expect(res.body.data.folio_numero).toBe(502)
  })

  it('404 si no existe', async () => {
    q.mockResolvedValueOnce([])
    const res = await request(app).get('/api/electron/ordenes/folio/999999')
    expect(res.status).toBe(404)
  })
})

describe('GET /api/electron/ordenes/siguiente-folio', () => {
  it('devuelve el primer folio libre', async () => {
    q.mockResolvedValueOnce([{ folio_numero: 1 }, { folio_numero: 2 }, { folio_numero: 4 }])
    const res = await request(app).get('/api/electron/ordenes/siguiente-folio')
    expect(res.body.data.folio).toBe(3)
  })

  it('devuelve 1 si no hay órdenes', async () => {
    q.mockResolvedValueOnce([])
    const res = await request(app).get('/api/electron/ordenes/siguiente-folio')
    expect(res.body.data.folio).toBe(1)
  })
})

describe('GET /api/electron/ordenes/cliente/:idCliente', () => {
  it('devuelve las órdenes del cliente', async () => {
    q.mockResolvedValueOnce([{ folio_numero: 10 }])
    const res = await request(app).get('/api/electron/ordenes/cliente/7')
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
  })
})

describe('GET /api/electron/ordenes/estadisticas', () => {
  it('devuelve el resumen agregado', async () => {
    q.mockResolvedValueOnce([{ total: 5, guardadas: 3, registradas: 2, valor_total: '500.00' }])
    const res = await request(app).get('/api/electron/ordenes/estadisticas')
    expect(res.status).toBe(200)
    expect(res.body.data.total).toBe(5)
  })
})

describe('GET /api/electron/ordenes/notas-cliente-hoy/:idCliente', () => {
  it('extrae la observación del carrito', async () => {
    q.mockResolvedValueOnce([
      { folio_numero: 11, estado: 'guardada', datos_carrito: JSON.stringify({ __observacion__: 'ojo con el cambio' }), fecha_creacion: '2026-09-09 10:00:00' }
    ])
    const res = await request(app).get('/api/electron/ordenes/notas-cliente-hoy/7')
    expect(res.status).toBe(200)
    expect(res.body.data[0].observacion).toBe('ojo con el cambio')
  })
})

describe('GET /api/electron/ordenes/reservas/:idProducto', () => {
  it('sin conversión: solo trae reservas del producto consultado', async () => {
    q
      .mockResolvedValueOnce([]) // sin conversiones
      .mockResolvedValueOnce([{ id_producto: 5, folio_numero: 1, cantidad_reservada: 3 }])
    const res = await request(app).get('/api/electron/ordenes/reservas/5')
    expect(res.status).toBe(200)
    expect(q.mock.calls[1][1]).toEqual([5])
    expect(res.body.data[0].es_equivalente).toBe(false)
  })

  it('con conversión: trae reservas de todo el grupo de equivalencia', async () => {
    q
      .mockResolvedValueOnce([{ id_producto_derivado: 5, id_producto_base: 9, factor: 12 }])
      .mockResolvedValueOnce([
        { id_producto: 5, folio_numero: 1, cantidad_reservada: 2 },
        { id_producto: 9, folio_numero: 2, cantidad_reservada: 24 },
      ])
    const res = await request(app).get('/api/electron/ordenes/reservas/5')
    expect(res.status).toBe(200)
    expect(q.mock.calls[1][1].sort()).toEqual([5, 9])
    const porProducto = Object.fromEntries(res.body.data.map(r => [r.id_producto, r.es_equivalente]))
    expect(porProducto[5]).toBe(false)
    expect(porProducto[9]).toBe(true)
  })
})

describe('POST /api/electron/ordenes/validar-stock', () => {
  const carritoSuficiente = { seccion1: [{ id_producto: 1, cantidad: 5, nombre_producto: 'Jitomate', unidad_producto: 'kg' }] }

  it('400 sin carrito ni folio', async () => {
    const res = await request(app).post('/api/electron/ordenes/validar-stock').send({})
    expect(res.status).toBe(400)
  })

  it('404 si el folio no existe', async () => {
    q.mockResolvedValueOnce([])
    const res = await request(app).post('/api/electron/ordenes/validar-stock').send({ folio_numero: 999999 })
    expect(res.status).toBe(404)
  })

  it('suficiente cuando hay lotes propios que cubren la cantidad', async () => {
    q
      .mockResolvedValueOnce([])                                          // conversiones del carrito
      .mockResolvedValueOnce([])                                          // todas las conversiones globales
      .mockResolvedValueOnce([{ id_producto: 1, cantidad_restante: '10.0000', factor_conversion: null }]) // lotes
    const res = await request(app).post('/api/electron/ordenes/validar-stock').send({ datos_carrito: carritoSuficiente })
    expect(res.status).toBe(200)
    expect(res.body.data.suficiente).toBe(true)
  })

  it('insuficiente cuando los lotes no alcanzan', async () => {
    q
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id_producto: 1, cantidad_restante: '2.0000', factor_conversion: null }])
    const res = await request(app).post('/api/electron/ordenes/validar-stock').send({ datos_carrito: carritoSuficiente })
    expect(res.status).toBe(200)
    expect(res.body.data.suficiente).toBe(false)
    expect(res.body.data.productos_faltantes[0].faltante).toBeCloseTo(3, 4)
  })

  it('cruza a la base cuando el derivado no tiene lotes propios', async () => {
    const carritoDerivado = { seccion1: [{ id_producto: 5, cantidad: 2, nombre_producto: 'Caja Manzana', unidad_producto: 'caja' }] }
    q
      .mockResolvedValueOnce([{ id_producto_derivado: 5, id_producto_base: 9, factor: 12, id_grupo: null }]) // conv del carrito
      .mockResolvedValueOnce([{ id_producto_derivado: 5, id_producto_base: 9, factor: 12 }])                 // todas las conversiones
      .mockResolvedValueOnce([])                                                                             // stock propio de derivados con conv -> ninguno
      .mockResolvedValueOnce([{ id_producto: 9, cantidad_restante: '30.0000', factor_conversion: null }])    // lotes del base
    const res = await request(app).post('/api/electron/ordenes/validar-stock').send({ datos_carrito: carritoDerivado })
    expect(res.status).toBe(200)
    expect(res.body.data.suficiente).toBe(true) // 2 cajas * 12 = 24 pz, hay 30
  })
})

describe('GET /api/electron/ordenes/lock/:folio — checkLock', () => {
  it('locked:false cuando no hay editing_by', async () => {
    q.mockResolvedValueOnce([{ editing_by: null, editing_source: null, elapsed_s: null }])
    const res = await request(app).get('/api/electron/ordenes/lock/42')
    expect(res.status).toBe(200)
    expect(res.body.data.locked).toBe(false)
  })

  it('locked:true cuando hay un lock reciente', async () => {
    q.mockResolvedValueOnce([{ editing_by: 'Otra Persona', editing_source: 'bodega-web', elapsed_s: 30 }])
    const res = await request(app).get('/api/electron/ordenes/lock/42')
    expect(res.body.data.locked).toBe(true)
    expect(res.body.data.editing_by).toBe('Otra Persona')
  })

  it('locked:false cuando el lock expiró (>= 300s)', async () => {
    q.mockResolvedValueOnce([{ editing_by: 'Otra Persona', editing_source: 'electron', elapsed_s: 301 }])
    const res = await request(app).get('/api/electron/ordenes/lock/42')
    expect(res.body.data.locked).toBe(false)
  })

  it('locked:false cuando la orden no existe (sin 404 — mismo criterio que bodega-web)', async () => {
    q.mockResolvedValueOnce([])
    const res = await request(app).get('/api/electron/ordenes/lock/999999')
    expect(res.status).toBe(200)
    expect(res.body.data.locked).toBe(false)
  })
})

describe('POST /api/electron/ordenes/lock/:folio — acquireLock', () => {
  it('adquiere el lock cuando nadie más lo tiene (UPDATE atómico afecta 1 fila)', async () => {
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 }])
    const res = await request(app).post('/api/electron/ordenes/lock/42')
    expect(res.status).toBe(200)
    expect(res.body.data.locked).toBe(false)
    expect(q).not.toHaveBeenCalled() // no consulta el SELECT de respaldo

    const [sql, params] = pool.execute.mock.calls[0]
    expect(sql).toMatch(/editing_source = 'electron'/)
    // La identidad sale del JWT (req.user.nombre), nunca del body
    expect(params[0]).toBe('Usuario de Prueba')
  })

  it('rechaza si otro usuario ya tiene el lock (UPDATE afecta 0 filas)', async () => {
    pool.execute.mockResolvedValueOnce([{ affectedRows: 0 }])
    q.mockResolvedValueOnce([{ editing_by: 'Otra Persona', editing_source: 'bodega-web' }])
    const res = await request(app).post('/api/electron/ordenes/lock/42')
    expect(res.body.data.locked).toBe(true)
    expect(res.body.data.adquirido).toBe(false)
    expect(res.body.data.message).toMatch(/Otra Persona/)
  })

  it('404 si la orden no existe', async () => {
    pool.execute.mockResolvedValueOnce([{ affectedRows: 0 }])
    q.mockResolvedValueOnce([])
    const res = await request(app).post('/api/electron/ordenes/lock/999999')
    expect(res.status).toBe(404)
  })

  it('ignora cualquier "usuario" que mande el body — la identidad es del JWT', async () => {
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 }])
    await request(app).post('/api/electron/ordenes/lock/42').send({ usuario: 'Alguien Que No Soy' })
    const [, params] = pool.execute.mock.calls[0]
    expect(params[0]).toBe('Usuario de Prueba')
    expect(params).not.toContain('Alguien Que No Soy')
  })
})

describe('DELETE /api/electron/ordenes/lock/:folio — releaseLock', () => {
  it('libera el lock', async () => {
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 }])
    const res = await request(app).delete('/api/electron/ordenes/lock/42')
    expect(res.status).toBe(200)
    expect(res.body.data.released).toBe(true)
    expect(pool.execute.mock.calls[0][0]).toMatch(/editing_by = NULL/)
  })
})

describe('PATCH /api/electron/ordenes/lock/:folio — renewLock', () => {
  it('renueva cuando el editing_by coincide con la identidad del JWT', async () => {
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 }])
    const res = await request(app).put('/api/electron/ordenes/lock/42')
    expect(res.body.data.renewed).toBe(true)
    expect(pool.execute.mock.calls[0][1]).toEqual(['42', 'Usuario de Prueba'])
  })

  it('renewed:false si el lock ya no es de esta persona (0 filas afectadas)', async () => {
    pool.execute.mockResolvedValueOnce([{ affectedRows: 0 }])
    const res = await request(app).put('/api/electron/ordenes/lock/42')
    expect(res.body.data.renewed).toBe(false)
  })
})

describe('PUT /api/electron/ordenes/estado/:folio — cambiarEstado', () => {
  it('cambia el estado sin gate de rol', async () => {
    mockUser.rol = 'cajero'
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 }])
    const res = await request(app).put('/api/electron/ordenes/estado/42').send({ nuevoEstado: 1 })
    expect(res.status).toBe(200)
    expect(pool.execute.mock.calls[0][1]).toEqual(['guardada', '42'])
  })
})

describe('POST /api/electron/ordenes/revision/:folio — registrarRevision', () => {
  it('agrega la entrada al historial con la identidad del JWT', async () => {
    const conn = mockConn([
      [[{ datos_carrito: JSON.stringify({}) }]], // SELECT datos_carrito
    ])
    const res = await request(app).post('/api/electron/ordenes/revision/42').send({ totalProductos: 5, faltantes: ['x'] })
    expect(res.status).toBe(200)
    const update = conn.execute.mock.calls.find(c => /UPDATE ordenes_guardadas SET datos_carrito/.test(c[0]))
    const carritoGuardado = JSON.parse(update[1][0])
    expect(carritoGuardado.__historial__[0].usuario).toBe('Usuario de Prueba')
    expect(carritoGuardado.__historial__[0].totalProductos).toBe(5)
  })

  it('404 si la orden no existe', async () => {
    mockConn([[[]]])
    const res = await request(app).post('/api/electron/ordenes/revision/999999').send({})
    expect(res.status).toBe(404)
  })
})

describe('PUT /api/electron/ordenes/enviado/:folio — marcarEnviado (admin/ceo)', () => {
  it('rechaza a un rol sin permiso (403)', async () => {
    mockUser.rol = 'cajero'
    const res = await request(app).put('/api/electron/ordenes/enviado/42').send({ fecha: '2026-09-10' })
    expect(res.status).toBe(403)
  })

  it('admin: marca el envío y registra el historial', async () => {
    const conn = mockConn([
      [[{ estado: 'guardada', fecha_envio: null, datos_carrito: JSON.stringify({}) }]],
    ])
    const res = await request(app).put('/api/electron/ordenes/enviado/42').send({ fecha: '2026-09-10' })
    expect(res.status).toBe(200)
    expect(res.body.data.success).toBe(true)
    const updates = conn.execute.mock.calls.filter(c => /UPDATE ordenes_guardadas/.test(c[0]))
    expect(updates).toHaveLength(2) // datos_carrito (historial) + fecha_envio
  })
})

describe('POST /api/electron/ordenes/notas-ceo/:folio — guardarNotaCeo (admin/ceo)', () => {
  it('rechaza a un rol sin permiso (403)', async () => {
    mockUser.rol = 'supervisor'
    const res = await request(app).post('/api/electron/ordenes/notas-ceo/42').send({ nota: 'ojo con esto' })
    expect(res.status).toBe(403)
  })

  it('400 si la nota viene vacía', async () => {
    const res = await request(app).post('/api/electron/ordenes/notas-ceo/42').send({ nota: '   ' })
    expect(res.status).toBe(400)
  })

  it('admin: guarda la nota, inserta el mensaje y notifica a otros admins/ceo/supervisor', async () => {
    const conn = mockConn([
      [[{ id_orden: 7, datos_carrito: JSON.stringify({}) }]],                     // check orden
      [{ affectedRows: 1 }],                                                       // UPDATE datos_carrito
      [[{ id_usuario: 1, nombre_completo: 'Usuario de Prueba' }]],                 // autor
      [{ insertId: 55 }],                                                          // INSERT orden_mensajes
      [[{ id_usuario: 2 }, { id_usuario: 3 }]],                                    // destinatarios
    ])
    const res = await request(app).post('/api/electron/ordenes/notas-ceo/42').send({ nota: 'revisar precio' })
    expect(res.status).toBe(200)
    expect(res.body.data.success).toBe(true)

    const insertNotif = conn.execute.mock.calls.find(c => /INSERT INTO notificaciones_mensajes/.test(c[0]))
    expect(insertNotif).toBeTruthy()
    expect(insertNotif[1]).toEqual([2, 55, 7, '42', 'revisar precio', 3, 55, 7, '42', 'revisar precio'])
  })

  it('no notifica a nadie si no hay otros admins/ceo/supervisor', async () => {
    const conn = mockConn([
      [[{ id_orden: 7, datos_carrito: JSON.stringify({}) }]],
      [{ affectedRows: 1 }],
      [[{ id_usuario: 1, nombre_completo: 'Usuario de Prueba' }]],
      [{ insertId: 55 }],
      [[]], // sin destinatarios
    ])
    const res = await request(app).post('/api/electron/ordenes/notas-ceo/42').send({ nota: 'nota sola' })
    expect(res.status).toBe(200)
    const insertNotif = conn.execute.mock.calls.find(c => /INSERT INTO notificaciones_mensajes/.test(c[0]))
    expect(insertNotif).toBeUndefined()
  })
})

describe('POST /api/electron/ordenes/notas-ceo/:folio/vista — registrarVistaCeo', () => {
  it('sin gate de rol: cualquier usuario autenticado puede marcar vista', async () => {
    mockUser.rol = 'cajero'
    q.mockResolvedValueOnce([{ datos_carrito: JSON.stringify({ __notas_ceo__: [{ texto: 'x' }] }) }])
    const res = await request(app).post('/api/electron/ordenes/notas-ceo/42/vista')
    expect(res.status).toBe(200)
    expect(res.body.data.success).toBe(true)
    const update = pool.execute.mock.calls.find(c => /UPDATE ordenes_guardadas/.test(c[0]))
    const carrito = JSON.parse(update[1][0])
    expect(carrito.__notas_ceo_vistas__[0].usuario).toBe('Usuario de Prueba')
  })

  it('success:true sin tocar BD si no hay notas CEO', async () => {
    q.mockResolvedValueOnce([{ datos_carrito: JSON.stringify({}) }])
    const res = await request(app).post('/api/electron/ordenes/notas-ceo/42/vista')
    expect(res.body.data.success).toBe(true)
    expect(pool.execute).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/electron/ordenes/notas-ceo/:folio/:index — eliminarNotaCeo (admin/ceo)', () => {
  it('rechaza a un rol sin permiso (403)', async () => {
    mockUser.rol = 'usuario'
    const res = await request(app).delete('/api/electron/ordenes/notas-ceo/42/0')
    expect(res.status).toBe(403)
  })

  it('admin: elimina la nota por índice', async () => {
    q.mockResolvedValueOnce([{ datos_carrito: JSON.stringify({ __notas_ceo__: ['a', 'b', 'c'] }) }])
    const res = await request(app).delete('/api/electron/ordenes/notas-ceo/42/1')
    expect(res.status).toBe(200)
    const update = pool.execute.mock.calls[0]
    const carrito = JSON.parse(update[1][0])
    expect(carrito.__notas_ceo__).toEqual(['a', 'c'])
  })

  it('error si el índice es inválido', async () => {
    q.mockResolvedValueOnce([{ datos_carrito: JSON.stringify({ __notas_ceo__: ['a'] }) }])
    const res = await request(app).delete('/api/electron/ordenes/notas-ceo/42/9')
    expect(res.body.ok).toBe(false)
  })
})
