/**
 * utils/nota-pdf.js — PDF de la nota de impresión, idéntico al de Electron
 *
 * Mismo pipeline que ordenes:exportarPDF / ordenes:imprimirPDF en
 * disfruleg-electron (ordenes.handler.ts + export.utils.js):
 *   1. secciones del carrito respetando __orden__ (extractSectionsFromCart)
 *   2. clave/unidad SAT faltantes desde producto (enrichItemsWithFiscalData)
 *   3. descuento del tipo de cliente → precio_base / descuento_pct
 *      (enrichItemsWithDiscount)
 *   4. HTML de utils/nota-html.js (copia de print.generator.js)
 *   5. Chromium → PDF A4 con el mismo pie "Folio · Página X de Y"
 *
 * En Workers el Chromium es Browser Rendering (binding BROWSER, ver
 * wrangler.jsonc). En Node (npm run dev) no hay binding: renderizarPDF lanza
 * SIN_NAVEGADOR y la ruta ofrece ?formato=html para revisar el contenido.
 */

const { q } = require('../db/pool')
const { generateReceiptHTML } = require('./nota-html')

// ── 1. Secciones del carrito (export.utils.js::extractSectionsFromCart) ──────
function extractSectionsFromCart (datosCarrito) {
  const secciones = {}
  if (!datosCarrito) return secciones

  let carrito
  try {
    carrito = typeof datosCarrito === 'string' ? JSON.parse(datosCarrito) : datosCarrito
  } catch {
    return secciones
  }
  if (!carrito || typeof carrito !== 'object') return secciones

  const orden = carrito.__orden__
  const keys  = Object.keys(carrito).filter(k => !k.startsWith('__'))
  let orderedKeys
  if (orden && Array.isArray(orden)) {
    const validOrden = orden.filter(k => keys.includes(k))
    const missing    = keys.filter(k => !validOrden.includes(k))
    orderedKeys = [...validOrden, ...missing]
  } else {
    orderedKeys = keys.includes('General')
      ? ['General', ...keys.filter(k => k !== 'General')]
      : keys
  }

  for (const nombre of orderedKeys) {
    const data = carrito[nombre]
    if (Array.isArray(data)) secciones[nombre] = data
    else if (data && Array.isArray(data.items)) secciones[nombre] = data.items
  }
  return secciones
}

// ── 2. Datos fiscales (export.utils.js::enrichItemsWithFiscalData) ───────────
async function enrichItemsWithFiscalData (secciones) {
  const ids = new Set()
  for (const items of Object.values(secciones)) {
    for (const item of items) {
      const falta = item.clave_sat == null || item.unidad_sat == null
      if (falta && item.id_producto) ids.add(item.id_producto)
    }
  }
  if (ids.size === 0) return

  const lista = [...ids]
  let rows = []
  try {
    rows = await q(
      `SELECT id_producto, clave_sat, unidad_sat FROM producto
       WHERE id_producto IN (${lista.map(() => '?').join(',')})`,
      lista
    )
  } catch {
    return // igual que Electron: sin datos fiscales, la nota sale igual
  }
  const fiscal = new Map(rows.map(r => [Number(r.id_producto), r]))
  for (const items of Object.values(secciones)) {
    for (const item of items) {
      const f = fiscal.get(Number(item.id_producto))
      if (!f) continue
      if (item.clave_sat == null)  item.clave_sat  = f.clave_sat ?? null
      if (item.unidad_sat == null) item.unidad_sat = f.unidad_sat ?? null
    }
  }
}

// ── 3. Descuento del cliente (ordenes.handler.ts::enrichItemsWithDiscount) ───
async function enrichItemsWithDiscount (secciones, idCliente) {
  let descuentoGrupo = 0
  if (idCliente) {
    try {
      const [row] = await q(
        `SELECT tc.descuento
         FROM cliente c
         JOIN grupo g ON c.id_grupo = g.id_grupo
         JOIN tipo_cliente tc ON g.id_tipo_cliente = tc.id_tipo_cliente
         WHERE c.id_cliente = ?`,
        [idCliente]
      )
      descuentoGrupo = parseFloat(row?.descuento ?? 0) || 0
    } catch { /* sin descuento de grupo */ }
  }

  for (const items of Object.values(secciones)) {
    for (const item of items) {
      if (!item.precio_unitario) continue
      if (descuentoGrupo > 0) item.descuento_pct = descuentoGrupo
      const pct = Number(item.descuento_pct) || 0
      item.precio_base = pct > 0
        ? Math.round((item.precio_unitario / (1 - pct / 100)) * 100) / 100
        : item.precio_unitario
    }
  }
  return descuentoGrupo
}

// ── Nombre de archivo (export.utils.js::generateFilename, rama pdf) ──────────
function sanitizeForFilename (name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, '_')
    .replace(/[^A-Z0-9_]/g, '')
}

function nombreArchivoNota (nombreCliente, folio, observacion = '') {
  // Fecha del día en México (el Worker corre en UTC)
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' })
    .format(new Date()).split('-')
  const safeName = sanitizeForFilename(nombreCliente) || 'CLIENTE'
  const safeObs  = sanitizeForFilename(observacion)
  return `${String(folio).padStart(6, '0')}_${d}${m}${y.slice(-2)}_${safeName}${safeObs ? '_' + safeObs : ''}.pdf`
}

/**
 * Carga la nota y arma el mismo objeto que Electron le pasa a
 * generateReceiptHTML. null si la nota no existe o está inactiva.
 */
async function prepararNota (folio) {
  // Fechas como texto, igual que Electron (dateStrings: true): el generador
  // interpreta 'YYYY-MM-DD HH:MM:SS' como UTC (así lo guarda NOW() en TiDB).
  // El pool de bodega usa timezone '-06:00' y devolvería un Date corrido 6 h
  // — una nota de después de las 6 pm saldría con la fecha del día siguiente.
  const [o] = await q(`
    SELECT o.folio_numero, o.id_cliente, o.datos_carrito, o.total_estimado,
           CAST(o.fecha_creacion AS CHAR) AS fecha_creacion,
           CAST(o.fecha_envio AS CHAR)    AS fecha_envio,
           c.nombre_cliente, g.nombre_grupo
    FROM   ordenes_guardadas o
    INNER JOIN cliente c ON o.id_cliente = c.id_cliente
    INNER JOIN grupo   g ON c.id_grupo   = g.id_grupo
    WHERE  o.folio_numero = ? AND o.activo = 1
  `, [folio])
  if (!o) return null

  const rawCart = typeof o.datos_carrito === 'string'
    ? JSON.parse(o.datos_carrito)
    : (o.datos_carrito || {})

  const secciones = extractSectionsFromCart(rawCart)
  await enrichItemsWithFiscalData(secciones)
  const descuentoNominal = await enrichItemsWithDiscount(secciones, o.id_cliente)

  // Electron recibe total del renderer (calculateTotals = Σ cantidad×precio);
  // aquí se recalcula igual desde el carrito guardado.
  let total = 0
  for (const items of Object.values(secciones)) {
    for (const item of items) total += (Number(item.cantidad) || 0) * (Number(item.precio_unitario) || 0)
  }
  const calculo = rawCart.__calculo__ || null
  if (calculo?.monto > 0) total += calculo.monto

  const datos = {
    folio_numero:      o.folio_numero,
    nombre_cliente:    o.nombre_cliente || 'Cliente',
    nombre_grupo:      o.nombre_grupo   || '',
    fecha_creacion:    o.fecha_creacion || null,
    fecha_envio:       o.fecha_envio    || null,
    observacion:       rawCart.__observacion__ || '',
    calculo,
    secciones,
    total,
    descuento_nominal: descuentoNominal
  }

  return {
    datos,
    html: generateReceiptHTML(datos),
    nombreArchivo: nombreArchivoNota(datos.nombre_cliente, datos.folio_numero, datos.observacion)
  }
}

/**
 * HTML → PDF con Browser Rendering. Mismas opciones que printToPDF en
 * Electron (A4, fondo, márgenes 0, mismo pie de página).
 */
async function renderizarPDF (html, folio) {
  let env
  try {
    ({ env } = await import('cloudflare:workers'))
  } catch {
    env = null
  }
  if (!env?.BROWSER) {
    const err = new Error('Generar PDF requiere el Worker (Browser Rendering); en local usa ?formato=html')
    err.code = 'SIN_NAVEGADOR'
    throw err
  }

  const puppeteer = (await import('@cloudflare/puppeteer')).default
  const browser = await puppeteer.launch(env.BROWSER)
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'load' })
    const folioStr = String(folio).padStart(6, '0')
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="font-size:7pt;color:#888888;width:100%;padding:0 12mm;display:flex;justify-content:space-between;font-family:Helvetica,Arial,sans-serif;"><span>DISFRULEG — Comercializadora Castruita | Folio ${folioStr}</span><span>Página <span class="pageNumber"></span> de <span class="totalPages"></span></span></div>`,
      margin: { top: 0, right: 0, bottom: 0, left: 0 }
    })
  } finally {
    await browser.close().catch(() => {})
  }
}

module.exports = {
  prepararNota,
  renderizarPDF,
  // exportados para tests
  extractSectionsFromCart,
  enrichItemsWithDiscount,
  nombreArchivoNota
}
