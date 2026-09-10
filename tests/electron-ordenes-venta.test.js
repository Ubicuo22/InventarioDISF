/**
 * tests/electron-ordenes-venta.test.js — Pruebas de procesar-venta / revertir-procesamiento
 * (H-5 Fase 4 — ordenes:procesarVenta / ordenes:revertirProcesamiento)
 *
 * Sin respaldo local (fail-closed) — requireAuthElectron ya corre a nivel de
 * app.js para todo /api/electron/ordenes/*, así que solo se prueba aquí el
 * segundo factor real: verificarAdminPassword (bcrypt real contra
 * usuarios_sistema, mismo patrón que electron-auth.test.js) y la lógica de
 * negocio de las dos rutas.
 *
 * `q()` se mockea por patrón de SQL (no por orden de llamada) porque
 * procesarVenta hace ~10 lecturas distintas fuera de la transacción
 * (incluyendo las de costosPromedioHistorico) — mockear por posición sería
 * extremadamente frágil ante cualquier reordenamiento futuro.
 */

let mockUser = { id: 1, username: 'CAJERO1', nombre: 'Cajero Uno', rol: 'cajero' }

jest.mock('../db/pool', () => ({
  q: jest.fn(),
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

const bcrypt = require('bcryptjs')
const request = require('supertest')
const app = require('../app')
const { q, pool } = require('../db/pool')

const ADMIN_PASSWORD_HASH = bcrypt.hashSync('clave-admin-correcta', 4)

function mockConn(executeResponses = []) {
  const conn = {
    execute: jest.fn(),
    beginTransaction: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
    release: jest.fn()
  }
  for (const resp of executeResponses) conn.execute.mockResolvedValueOnce(resp)
  conn.execute.mockResolvedValue([{ affectedRows: 1, insertId: 1 }, []])
  pool.getConnection.mockResolvedValue(conn)
  return conn
}

/**
 * q() por patrón de SQL. `overrides` es un array de { match: RegExp, rows }
 * evaluado en orden (el primero que matchea gana); todo lo no cubierto
 * devuelve [] — seguro para las queries de costosPromedioHistorico/
 * conversiones globales que casi ningún test necesita personalizar.
 */
function makeQMock(overrides = []) {
  const defaults = [
    { match: /FROM revision_activa/, rows: [] },
    { match: /FROM inventario_peps[\s\S]*costo_unitario > 0\.01/, rows: [] }, // costo-promedio: pepsRows
    { match: /FROM inventario_peps[\s\S]*ORDER BY fecha_movimiento/, rows: [] }, // ruta principal: lotesPorProducto
    { match: /SELECT COUNT\(\*\) AS n FROM orden_consumo_peps/, rows: [{ n: 0 }] },
    { match: /SELECT id_grupo FROM cliente/, rows: [] },
    { match: /FROM producto_conversion_peps\s+WHERE id_producto_derivado IN/, rows: [] },
    { match: /FROM producto_conversion_peps\s+WHERE activo = 1 AND id_grupo IS NULL/, rows: [] },
    { match: /FROM compra[\s\S]*GROUP BY id_producto/, rows: [] }, // costo-promedio: comprasRows
    { match: /INNER JOIN \(\s*SELECT id_producto, MAX\(fecha_compra\)/, rows: [] }, // costo-promedio: ultimaRows
    { match: /FROM ordenes_guardadas\s+WHERE folio_numero = \? AND activo = 1 AND estado = 'guardada'/, rows: [] },
  ]
  const rules = [...overrides, ...defaults]
  return (sql) => {
    for (const rule of rules) {
      if (rule.match.test(sql)) return Promise.resolve(rule.rows)
    }
    return Promise.resolve([])
  }
}

const ORDEN_BASE = {
  id_cliente: 1,
  total_estimado: '100.00',
  datos_carrito: JSON.stringify({ productos: [{ id_producto: 10, cantidad: 2, precio_unitario: 50 }] }),
  usuario_creador: 'CAJERO1',
  fecha_creacion: '2026-09-09 10:00:00',
  fecha_envio: null,
  consumo_pendiente: null,
}

const LOTE_SUFICIENTE = [{ id_inventario_peps: 501, id_producto: 10, cantidad_restante: 5, costo_unitario: 20, factor_conversion: null }]

beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})

beforeEach(() => {
  jest.resetAllMocks()
  mockUser = { id: 1, username: 'CAJERO1', nombre: 'Cajero Uno', rol: 'cajero' }
})

describe('POST /api/electron/ordenes/procesar-venta/:folio', () => {
  test('401 si falta la contraseña del admin', async () => {
    q.mockImplementation(makeQMock())
    const res = await request(app).post('/api/electron/ordenes/procesar-venta/500').send({ admin_usuario: 'ADMIN' })
    expect(res.status).toBe(401)
  })

  test('401 si el admin no existe o no tiene rol admin/ceo', async () => {
    q.mockImplementation(makeQMock([
      { match: /FROM usuarios_sistema WHERE UPPER\(username\)/, rows: [] },
      { match: /FROM intentos_fallidos/, rows: [{ cnt: 0 }] },
    ]))
    const res = await request(app).post('/api/electron/ordenes/procesar-venta/500').send({ admin_usuario: 'NOEXISTE', admin_password: 'x' })
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/incorrectos/)
  })

  test('401 si la contraseña del admin es incorrecta', async () => {
    q.mockImplementation(makeQMock([
      { match: /FROM usuarios_sistema WHERE UPPER\(username\)/, rows: [{ password_hash: ADMIN_PASSWORD_HASH }] },
      { match: /FROM intentos_fallidos/, rows: [{ cnt: 0 }] },
    ]))
    const res = await request(app).post('/api/electron/ordenes/procesar-venta/500').send({ admin_usuario: 'ADMIN', admin_password: 'clave-mala' })
    expect(res.status).toBe(401)
  })

  test('401 tras 5 intentos fallidos recientes (rate limit)', async () => {
    q.mockImplementation(makeQMock([
      { match: /FROM intentos_fallidos/, rows: [{ cnt: 5 }] },
    ]))
    const res = await request(app).post('/api/electron/ordenes/procesar-venta/500').send({ admin_usuario: 'ADMIN', admin_password: 'clave-admin-correcta' })
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/Demasiados intentos/)
  })

  function withAdminOk(overrides = []) {
    return makeQMock([
      { match: /FROM usuarios_sistema WHERE UPPER\(username\)/, rows: [{ password_hash: ADMIN_PASSWORD_HASH }] },
      { match: /FROM intentos_fallidos/, rows: [{ cnt: 0 }] },
      ...overrides,
    ])
  }

  test('ok:false si la orden no existe o ya fue procesada', async () => {
    q.mockImplementation(withAdminOk())
    const res = await request(app).post('/api/electron/ordenes/procesar-venta/999').send({ admin_usuario: 'ADMIN', admin_password: 'clave-admin-correcta' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.error).toMatch(/no encontrada/)
  })

  test('venta simple con stock suficiente: crea factura, sin lote fantasma, deuda liquidada', async () => {
    q.mockImplementation(withAdminOk([
      { match: /FROM ordenes_guardadas\s+WHERE folio_numero = \? AND activo = 1 AND estado = 'guardada'/, rows: [ORDEN_BASE] },
      { match: /FROM inventario_peps[\s\S]*ORDER BY fecha_movimiento/, rows: LOTE_SUFICIENTE },
    ]))
    const conn = mockConn([
      [[{ estado: 'guardada' }]],                    // lock check
      [{ affectedRows: 1 }],                          // UPDATE estado=registrada
      [{ affectedRows: 0 }],                           // consumirReservas
      [LOTE_SUFICIENTE.map(l => ({ ...l }))],          // re-lock lotes (fresco)
      [{ insertId: 900 }],                             // INSERT factura
      [{ insertId: 5000 }],                            // INSERT detalle_factura bulk
      [{ affectedRows: 1 }],                           // INSERT detalle_venta_lote (W4)
      [{ affectedRows: 1 }],                           // UPDATE inventario_peps (W5)
      [{ affectedRows: 1 }],                           // UPDATE producto stock (W6)
    ])

    const res = await request(app).post('/api/electron/ordenes/procesar-venta/500').send({
      admin_usuario: 'ADMIN', admin_password: 'clave-admin-correcta', monto_pagado: 100
    })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.id_factura).toBe(900)
    expect(res.body.data.costo_real).toBe(40)     // 2 unidades × costo 20
    expect(res.body.data.utilidad_real).toBe(60)  // (50-20) × 2
    expect(res.body.data.monto_pendiente).toBe(0)

    // Nunca se crea nada PHANTOM cuando el stock alcanza
    const insertCompra = conn.execute.mock.calls.find(c => /INSERT INTO compra/.test(c[0]))
    expect(insertCompra).toBeUndefined()
  })

  test('overselling: genera lote PHANTOM:VENTA + detalle_venta_lote por lo que falta, no bloquea la venta', async () => {
    const loteInsuficiente = [{ id_inventario_peps: 501, id_producto: 10, cantidad_restante: 1, costo_unitario: 20, factor_conversion: null }]
    q.mockImplementation(withAdminOk([
      { match: /FROM ordenes_guardadas\s+WHERE folio_numero = \? AND activo = 1 AND estado = 'guardada'/, rows: [ORDEN_BASE] }, // pide 2, solo hay 1
      { match: /FROM inventario_peps[\s\S]*ORDER BY fecha_movimiento/, rows: loteInsuficiente },
    ]))
    const conn = mockConn([
      [[{ estado: 'guardada' }]],
      [{ affectedRows: 1 }],
      [{ affectedRows: 0 }],
      [loteInsuficiente.map(l => ({ ...l }))],         // re-lock: solo 1 unidad disponible
      [{ insertId: 900 }],                              // INSERT factura
      [{ insertId: 5000 }],                             // INSERT detalle_factura
      [{ affectedRows: 1 }],                            // INSERT detalle_venta_lote (W4, 1 unidad real)
      [{ affectedRows: 1 }],                             // UPDATE inventario_peps (W5)
      [{ affectedRows: 1 }],                             // UPDATE producto stock (W6)
      [[{ id_proveedor: 77 }]],                          // SELECT proveedor BOOTSTRAP-INVENTARIO
      [{ insertId: 3000 }],                              // INSERT compra PHANTOM:VENTA
      [{ insertId: 4000 }],                              // INSERT inventario_peps fantasma
      [{ affectedRows: 1 }],                             // INSERT detalle_venta_lote fantasma
    ])

    const res = await request(app).post('/api/electron/ordenes/procesar-venta/500').send({
      admin_usuario: 'ADMIN', admin_password: 'clave-admin-correcta', monto_pagado: 100
    })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true) // la venta se procesa, no se bloquea

    const insertCompraPh = conn.execute.mock.calls.find(c => /INSERT INTO compra/.test(c[0]))
    expect(insertCompraPh).toBeTruthy()
    expect(insertCompraPh[0]).toMatch(/PHANTOM:VENTA/)
    expect(insertCompraPh[1]).toContain(`PHANTOM-VENTA-F500`)
    expect(insertCompraPh[1]).toContain(10) // id_producto
    expect(insertCompraPh[1]).toContain(1)  // cantidadBase faltante = 2 pedidas - 1 disponible

    const insertPepsPh = conn.execute.mock.calls.find(c => /INSERT INTO inventario_peps/.test(c[0]))
    expect(insertPepsPh).toBeTruthy()

    // 2 INSERTs a detalle_venta_lote: el real (1 unidad) y el fantasma (1 unidad)
    const insertsDvl = conn.execute.mock.calls.filter(c => /INSERT INTO detalle_venta_lote/.test(c[0]))
    expect(insertsDvl).toHaveLength(2)
  })

  test('con sobrepago vía crédito activo: aplica el crédito y liquida la deuda', async () => {
    q.mockImplementation(withAdminOk([
      { match: /FROM ordenes_guardadas\s+WHERE folio_numero = \? AND activo = 1 AND estado = 'guardada'/, rows: [ORDEN_BASE] },
      { match: /FROM inventario_peps[\s\S]*ORDER BY fecha_movimiento/, rows: LOTE_SUFICIENTE },
    ]))
    const conn = mockConn([
      [[{ estado: 'guardada' }]],
      [{ affectedRows: 1 }],
      [{ affectedRows: 0 }],
      [LOTE_SUFICIENTE.map(l => ({ ...l }))],
      [{ insertId: 900 }],
      [{ insertId: 5000 }],
      [{ affectedRows: 1 }],
      [{ affectedRows: 1 }],
      [{ affectedRows: 1 }],
      [[{ id_credito: 55, monto_total: '100.00', monto_usado: '0.00', disponible: '100.00' }]], // créditos activos (monto_pagado=0, pendiente=100)
      [{ affectedRows: 1 }],                             // UPDATE credito_cliente
      [[{ nombre_cliente: 'Cliente X', nombre_grupo: 'Grupo X' }]], // cliente/grupo
      [{ insertId: 700 }],                               // INSERT deudas
      [{ affectedRows: 1 }],                              // INSERT aplicacion_credito
    ])

    const res = await request(app).post('/api/electron/ordenes/procesar-venta/500').send({
      admin_usuario: 'ADMIN', admin_password: 'clave-admin-correcta', monto_pagado: 0
    })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.credito_aplicado).toBe(100)
    expect(res.body.data.monto_pendiente).toBe(0)

    const updateCredito = conn.execute.mock.calls.find(c => /UPDATE credito_cliente/.test(c[0]))
    expect(updateCredito[1]).toEqual([100, 'AGOTADO', 55])
  })

  test('500 y rollback si la transacción falla', async () => {
    q.mockImplementation(withAdminOk([
      { match: /FROM ordenes_guardadas\s+WHERE folio_numero = \? AND activo = 1 AND estado = 'guardada'/, rows: [ORDEN_BASE] },
      { match: /FROM inventario_peps[\s\S]*ORDER BY fecha_movimiento/, rows: LOTE_SUFICIENTE },
    ]))
    const conn = mockConn()
    conn.execute.mockReset()
    conn.execute.mockRejectedValue(new Error('boom'))

    const res = await request(app).post('/api/electron/ordenes/procesar-venta/500').send({
      admin_usuario: 'ADMIN', admin_password: 'clave-admin-correcta', monto_pagado: 100
    })

    expect(res.status).toBe(500)
    expect(conn.rollback).toHaveBeenCalled()
  })
})

describe('POST /api/electron/ordenes/revertir-procesamiento/:folio', () => {
  function withAdminOk(overrides = []) {
    return makeQMock([
      { match: /FROM usuarios_sistema WHERE UPPER\(username\)/, rows: [{ password_hash: ADMIN_PASSWORD_HASH }] },
      { match: /FROM intentos_fallidos/, rows: [{ cnt: 0 }] },
      ...overrides,
    ])
  }

  test('401 si la contraseña del admin es incorrecta', async () => {
    q.mockImplementation(makeQMock([
      { match: /FROM usuarios_sistema WHERE UPPER\(username\)/, rows: [{ password_hash: ADMIN_PASSWORD_HASH }] },
      { match: /FROM intentos_fallidos/, rows: [{ cnt: 0 }] },
    ]))
    const res = await request(app).post('/api/electron/ordenes/revertir-procesamiento/500').send({ admin_usuario: 'ADMIN', admin_password: 'mala' })
    expect(res.status).toBe(401)
  })

  test('ok:false si la orden no está procesada', async () => {
    q.mockImplementation(withAdminOk([
      { match: /FROM ordenes_guardadas WHERE folio_numero = \? AND activo = 1/, rows: [{ ...ORDEN_BASE, estado: 'guardada' }] },
    ]))
    const res = await request(app).post('/api/electron/ordenes/revertir-procesamiento/500').send({ admin_usuario: 'ADMIN', admin_password: 'clave-admin-correcta' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.error).toMatch(/no está procesada/)
  })

  test('bloquea la reversión si el lote PHANTOM:VENTA ya fue parcialmente reconciliado', async () => {
    q.mockImplementation(withAdminOk([
      { match: /FROM ordenes_guardadas WHERE folio_numero = \? AND activo = 1/, rows: [{ ...ORDEN_BASE, estado: 'registrada' }] },
    ]))
    pool.execute.mockResolvedValueOnce([[{ id_compra: 3000, notas: 'PHANTOM:VENTA|REC:1.5|COST:0.03' }]])

    const res = await request(app).post('/api/electron/ordenes/revertir-procesamiento/500').send({ admin_usuario: 'ADMIN', admin_password: 'clave-admin-correcta' })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.error).toMatch(/ya fue parcialmente reconciliado/)
  })

  test('rama legacy: restaura stock real y borra el lote PHANTOM:VENTA sin reconciliar', async () => {
    q.mockImplementation(withAdminOk([
      { match: /FROM ordenes_guardadas WHERE folio_numero = \? AND activo = 1/, rows: [{ ...ORDEN_BASE, estado: 'registrada' }] },
    ]))
    pool.execute.mockResolvedValueOnce([[]]) // sin phantoms pendientes para este folio

    const conn = mockConn([
      [[{ id_factura: 900 }]],                                              // R1
      [[{ id_detalle: 5000, id_producto: 10, cantidad_factura: 2 }]],       // R2 detalles
      [[]],                                                                  // tieneConsumoOrden (selección de rama) → legacy
      [[{ id_detalle_factura: 5000, id_inventario_peps: 501, id_producto_peps: 10, total: '2.00' }]], // lotes reales consumidos
      [[]],                                                                  // lotes PHANTOM:VENTA de esta factura (ninguno)
      [{ affectedRows: 1 }],                                                // UPDATE inventario_peps restaurar
      [{ affectedRows: 1 }],                                                // DELETE detalle_venta_lote
      [{ affectedRows: 1 }],                                                // UPDATE producto stock
      [{ affectedRows: 1 }],                                                // DELETE detalle_factura
      [{ affectedRows: 1 }],                                                // DELETE factura
      [[]],                                                                  // SELECT deudas (ninguna)
      [{ affectedRows: 1 }],                                                // UPDATE ordenes_guardadas → guardada
      [[]],                                                                  // tieneConsumoOrden (R9) → false, corre consumirPepsParaOrden
      [[]],                                                                  // obtenerIdGrupoCliente
      [[]],                                                                  // cargarConversiones: convMap
      [[]],                                                                  // cargarConversiones: allConvRows
      [[]],                                                                  // lotes FOR UPDATE (sin lotes → pendiente completo)
      [{ affectedRows: 1 }],                                                // reconciliarStock
      [{ affectedRows: 1 }],                                                // UPDATE consumo_pendiente
    ])

    const res = await request(app).post('/api/electron/ordenes/revertir-procesamiento/500').send({ admin_usuario: 'ADMIN', admin_password: 'clave-admin-correcta' })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(conn.commit).toHaveBeenCalled()

    const deleteFactura = conn.execute.mock.calls.find(c => /DELETE FROM factura/.test(c[0]))
    expect(deleteFactura).toBeTruthy()
  })

  test('500 y rollback si la transacción falla', async () => {
    q.mockImplementation(withAdminOk([
      { match: /FROM ordenes_guardadas WHERE folio_numero = \? AND activo = 1/, rows: [{ ...ORDEN_BASE, estado: 'registrada' }] },
    ]))
    pool.execute.mockResolvedValueOnce([[]])
    const conn = mockConn()
    conn.execute.mockReset()
    conn.execute.mockRejectedValue(new Error('boom'))

    const res = await request(app).post('/api/electron/ordenes/revertir-procesamiento/500').send({ admin_usuario: 'ADMIN', admin_password: 'clave-admin-correcta' })

    expect(res.status).toBe(500)
    expect(conn.rollback).toHaveBeenCalled()
  })
})
