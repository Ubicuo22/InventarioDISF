/**
 * tests/nota-pdf.test.js — Nota de impresión en PDF (utils/nota-html.js,
 * utils/nota-pdf.js, GET /api/ordenes/:folio/pdf).
 *
 * La nota que se comparte desde bodega-web debe ser idéntica a la que se
 * imprime en Electron: si el repo disfruleg-electron está al lado, se compara
 * el HTML de ambos generadores para el mismo pedido.
 */
jest.mock('../db/pool', () => ({
  q:    jest.fn(),
  pool: { execute: jest.fn(), getConnection: jest.fn() }
}))
jest.mock('../middleware/auth', () => ({
  requireAuth:   (req, res, next) => { req.user = { rol: 'admin', username: 'test' }; next() },
  requireAdmin:  (req, res, next) => next(),
  requireModulo: () => (req, res, next) => next()
}))
jest.mock('../utils/actividad', () => ({ registrar: jest.fn() }))

const fs      = require('fs')
const path    = require('path')
const request = require('supertest')
const app     = require('../app')
const { q }   = require('../db/pool')
const { generateReceiptHTML } = require('../utils/nota-html')
const { extractSectionsFromCart, enrichItemsWithDiscount, nombreArchivoNota } = require('../utils/nota-pdf')

beforeAll(() => { jest.spyOn(console, 'error').mockImplementation(() => {}) })
beforeEach(() => jest.clearAllMocks())

const carrito = {
  Frutas:  [{ id_producto: 1, nombre_producto: 'MANZANA', cantidad: 2, precio_unitario: 45, unidad: 'KG', clave_sat: '50301500', unidad_sat: 'KGM' }],
  General: [{ id_producto: 2, nombre_producto: 'AJO', cantidad: 1, precio_unitario: 90, unidad: 'KG' }],
  __orden__: ['Frutas', 'General'],
  __observacion__: 'BARRA'
}

describe('nota-html — mismo HTML que Electron', () => {
  const electronGen = path.resolve(__dirname, '../../disfruleg-electron/src/main/handlers/print.generator.js')
  const hayElectron = fs.existsSync(electronGen)

  ;(hayElectron ? it : it.skip)('genera exactamente el mismo HTML que print.generator.js de Electron', () => {
    const { generateReceiptHTML: deElectron } = require(electronGen)
    // El generador de Electron busca el logo en process.cwd()/public/logos —
    // en la app real el cwd es el repo de Electron; aquí se simula igual.
    const cwd = jest.spyOn(process, 'cwd').mockReturnValue(path.resolve(__dirname, '../../disfruleg-electron'))
    const datos = {
      folio_numero: 3144, nombre_cliente: 'DANDY DN TA', nombre_grupo: 'GENERAL',
      fecha_creacion: '2026-09-23 15:00:00', fecha_envio: null, observacion: 'BARRA',
      calculo: null, secciones: extractSectionsFromCart(carrito), total: 180, descuento_nominal: 0
    }
    const html = deElectron(datos)
    cwd.mockRestore()
    expect(html).toContain('data:image/png;base64,') // Electron sí encontró el logo
    expect(generateReceiptHTML(datos)).toBe(html)
  })

  it('incluye el logo en base64 (no depende de archivos en disco)', () => {
    const html = generateReceiptHTML({ folio_numero: 1, nombre_cliente: 'X', secciones: {}, total: 0 })
    expect(html).toMatch(/data:image\/png;base64,/)
  })

  it('fecha de una nota creada de noche (UTC del día siguiente) sale con el día de México', () => {
    // 01:30 UTC del 24 = 19:30 del 23 en CDMX
    const html = generateReceiptHTML({
      folio_numero: 1, nombre_cliente: 'X', secciones: {}, total: 0,
      fecha_creacion: '2026-09-24 01:30:00'
    })
    expect(html.toLowerCase()).toContain('miércoles')
    expect(html).toMatch(/\b23\b/)
  })
})

describe('nota-pdf — preparación de datos (igual que Electron)', () => {
  it('respeta __orden__ de las secciones', () => {
    expect(Object.keys(extractSectionsFromCart(carrito))).toEqual(['Frutas', 'General'])
  })

  it('sin __orden__ pone General primero', () => {
    const { __orden__, ...sinOrden } = carrito
    expect(Object.keys(extractSectionsFromCart({ Verduras: [], ...sinOrden }))[0]).toBe('General')
  })

  it('aplica el descuento del tipo de cliente: precio_base = precio / (1 - pct)', async () => {
    q.mockResolvedValueOnce([{ descuento: 10 }])
    const secciones = extractSectionsFromCart(JSON.parse(JSON.stringify(carrito)))
    const desc = await enrichItemsWithDiscount(secciones, 7)
    expect(desc).toBe(10)
    expect(secciones.Frutas[0].descuento_pct).toBe(10)
    expect(secciones.Frutas[0].precio_base).toBe(50) // 45 / 0.9
  })

  it('nombre de archivo como Electron: FOLIO_DDMMYY_CLIENTE_OBS.pdf', () => {
    expect(nombreArchivoNota('Dandy DN Tá', 3144, 'Barra 2')).toMatch(/^003144_\d{6}_DANDY_DN_TA_BARRA_2\.pdf$/)
  })
})

describe('GET /api/ordenes/:folio/pdf', () => {
  const fila = {
    folio_numero: 3144, id_cliente: 7, datos_carrito: JSON.stringify(carrito), total_estimado: 180,
    fecha_creacion: '2026-09-23 15:00:00', fecha_envio: null, nombre_cliente: 'DANDY DN TA', nombre_grupo: 'GENERAL'
  }
  const mockNota = () => {
    q.mockImplementation(async (sql) => {
      if (sql.includes('FROM   ordenes_guardadas')) return [fila]
      if (sql.includes('tipo_cliente'))            return [{ descuento: 0 }]
      if (sql.includes('clave_sat'))               return [{ id_producto: 2, clave_sat: '50401700', unidad_sat: 'KGM' }]
      return []
    })
  }

  it('?formato=html devuelve la nota en HTML', async () => {
    mockNota()
    const res = await request(app).get('/api/ordenes/3144/pdf?formato=html')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    expect(res.text).toContain('DANDY DN TA')
    expect(res.text).toContain('AJO')
  })

  it('pide las fechas como texto (CAST AS CHAR), no como Date corrido por el timezone del pool', async () => {
    mockNota()
    await request(app).get('/api/ordenes/3144/pdf?formato=html')
    const sql = q.mock.calls.find(c => c[0].includes('FROM   ordenes_guardadas'))[0]
    expect(sql).toMatch(/CAST\(o\.fecha_creacion AS CHAR\)/)
    expect(sql).toMatch(/CAST\(o\.fecha_envio AS CHAR\)/)
  })

  it('404 si la nota no existe', async () => {
    q.mockResolvedValue([])
    const res = await request(app).get('/api/ordenes/999/pdf')
    expect(res.status).toBe(404)
  })

  it('fuera del Worker (sin Browser Rendering) responde 501 con mensaje claro', async () => {
    mockNota()
    const res = await request(app).get('/api/ordenes/3144/pdf')
    expect(res.status).toBe(501)
    expect(res.body.error).toMatch(/Browser Rendering/)
  })
})
