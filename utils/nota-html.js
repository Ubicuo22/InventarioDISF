/**
 * utils/nota-html.js — HTML de la nota de impresión (mismo formato que Electron)
 *
 * COPIA de disfruleg-electron/src/main/handlers/print.generator.js — la nota
 * que se comparte desde bodega-web debe verse idéntica a la que se imprime en
 * escritorio. Si se cambia el formato allá, copiar el cambio aquí (lo vigila
 * tests/nota-html.test.js comparando ambas versiones cuando el repo de
 * Electron está al lado).
 *
 * Única diferencia: el logo viene de utils/nota-logo.js (base64 generado por
 * scripts/gen-nota-logo.js) en vez de leerse del disco — en Workers no hay fs.
 */

const { LOGO_NOTA_BASE64 } = require('./nota-logo')

// ── Helpers ────────────────────────────────────────────────────────────────────

function getLogoBase64() {
  return LOGO_NOTA_BASE64 ? `data:image/png;base64,${LOGO_NOTA_BASE64}` : null
}

const fmt = (n) =>
  new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n || 0)

function hasAnyDiscount(secciones) {
  for (const items of Object.values(secciones)) {
    if (!Array.isArray(items)) continue
    for (const item of items) {
      if ((item.descuento_pct || 0) > 0) return true
    }
  }
  return false
}

function parseOrderDate(dateStr) {
  if (!dateStr) return new Date()
  const raw = String(dateStr).trim()
  const utc = (raw.includes('Z') || raw.includes('+') || raw.includes('-', 10))
    ? raw
    : raw.replace(' ', 'T') + 'Z'
  const d = new Date(utc)
  return isNaN(d.getTime()) ? new Date() : d
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ── Generador principal ────────────────────────────────────────────────────────

function generateReceiptHTML(orderData) {
  const { folio_numero, nombre_cliente, fecha_creacion, fecha_envio, observacion, secciones, total, calculo, descuento_nominal } = orderData

  const modoDescuento = hasAnyDiscount(secciones)
  const logoSrc       = getLogoBase64()

  // ── Fecha ──────────────────────────────────────────────────────────────────
  const fechaSource = fecha_envio
    ? (fecha_envio.length === 10 ? fecha_envio + 'T12:00:00' : fecha_envio)
    : fecha_creacion
  const fecha = parseOrderDate(fechaSource)
  const tzOpts = { timeZone: 'America/Mexico_City' }
  const diaSem  = fecha.toLocaleDateString('es-MX', { weekday: 'long', ...tzOpts })
  const mes     = fecha.toLocaleDateString('es-MX', { month: 'long', ...tzOpts })
  const dia     = fecha.toLocaleDateString('es-MX', { day: 'numeric', ...tzOpts })
  const anio    = fecha.toLocaleDateString('es-MX', { year: 'numeric', ...tzOpts })
  const fechaStr = `${diaSem.charAt(0).toUpperCase()}${diaSem.slice(1)} / ${dia} / ${mes.charAt(0).toUpperCase()}${mes.slice(1)} / ${anio}`

  // ── Acumuladores ───────────────────────────────────────────────────────────
  let totalBruto    = 0
  let totalDescPesos = 0
  let totalGeneral  = 0

  // ── Encabezados de tabla ───────────────────────────────────────────────────
  const tableHead = modoDescuento
    ? `<th class="c-producto">PRODUCTO</th><th class="c-cant">CANT.</th><th class="c-unidad">UNIDAD</th><th class="c-pbruto">P. BRUTO</th><th class="c-total">TOTAL BRUTO</th>`
    : `<th class="c-producto">PRODUCTO</th><th class="c-cant">CANT.</th><th class="c-unidad">UNIDAD</th><th class="c-precio">P.UNIT</th><th class="c-total">TOTAL</th>`

  // ── Secciones ──────────────────────────────────────────────────────────────
  let seccionesHTML = ''
  for (const [secNombre, items] of Object.entries(secciones)) {
    if (!Array.isArray(items) || items.length === 0) continue

    let subtotalNeto  = 0
    let subtotalBruto = 0
    let rowsHTML = ''

    for (const item of items) {
      const precioBruto = modoDescuento
        ? (item.precio_base || item.precio_unitario || 0)
        : (item.precio_unitario || 0)
      const itemTotal = (item.cantidad || 0) * (item.precio_unitario || 0)
      const itemBruto = (item.cantidad || 0) * precioBruto
      const itemDesc  = itemBruto - itemTotal
      subtotalNeto   += itemTotal
      subtotalBruto  += itemBruto
      totalBruto     += itemBruto
      totalDescPesos += itemDesc

      const zeroCls = (item.precio_unitario || 0) === 0 ? ' zero' : ''

      if (modoDescuento) {
        const precioBrutoUnit = precioBruto
        rowsHTML += `
          <tr>
            <td class="c-producto">${escapeHtml(item.nombre_producto)}</td>
            <td class="c-cant center">${(item.cantidad || 0).toFixed(2)}</td>
            <td class="c-unidad center">${escapeHtml(item.unidad || item.unidad_producto || '')}</td>
            <td class="c-pbruto right${zeroCls}">${fmt(precioBrutoUnit)}</td>
            <td class="c-total right${zeroCls}">${fmt(itemBruto)}</td>
          </tr>`
      } else {
        rowsHTML += `
          <tr>
            <td class="c-producto">${escapeHtml(item.nombre_producto)}</td>
            <td class="c-cant center">${(item.cantidad || 0).toFixed(2)}</td>
            <td class="c-unidad center">${escapeHtml(item.unidad || item.unidad_producto || '')}</td>
            <td class="c-precio right${zeroCls}">${fmt(item.precio_unitario || 0)}</td>
            <td class="c-total right${zeroCls}">${fmt(itemTotal)}</td>
          </tr>`
      }
    }

    totalGeneral += subtotalNeto

    const secDescPesos = subtotalBruto - subtotalNeto
    let secDescHTML = ''
    if (modoDescuento && secDescPesos > 0.001) {
      const secPct = descuento_nominal > 0
        ? descuento_nominal.toFixed(1)
        : ((secDescPesos / subtotalBruto) * 100).toFixed(1)
      secDescHTML = `
        <div class="sec-desc">
          <div class="sec-desc-row gray"><span class="sec-desc-lbl">Total bruto ${escapeHtml(secNombre)}:</span><span class="sec-desc-val">${fmt(subtotalBruto)}</span></div>
          <div class="sec-desc-row green"><span class="sec-desc-lbl">Descuento (${secPct}%):</span><span class="sec-desc-val">-${fmt(secDescPesos)}</span></div>
          <div class="sec-desc-row bold"><span class="sec-desc-lbl">Total ${escapeHtml(secNombre)}:</span><span class="sec-desc-val">${fmt(subtotalNeto)}</span></div>
        </div>`
    }

    const subtotalLineHTML = (!modoDescuento || secDescPesos <= 0.001)
      ? `<div class="subtotal">Subtotal ${escapeHtml(secNombre)}: ${fmt(subtotalNeto)}</div>`
      : ''

    seccionesHTML += `
      <div class="seccion">
        <div class="sec-header">${escapeHtml(secNombre)}</div>
        <table class="tbl">
          <thead><tr>${tableHead}</tr></thead>
          <tbody>${rowsHTML}</tbody>
        </table>
        ${subtotalLineHTML}${secDescHTML}
      </div>`
  }

  // ── Sección cálculo ────────────────────────────────────────────────────────
  let calculoHTML = ''
  if (calculo?.monto > 0) {
    totalGeneral += calculo.monto
    calculoHTML = `
      <div class="seccion">
        <div class="sec-header">%</div>
        <table class="tbl">
          <thead><tr>
            <th class="c-concepto">CONCEPTO</th>
            <th class="c-base right">BASE</th>
            <th class="c-pct right">%</th>
            <th class="c-total right">TOTAL</th>
          </tr></thead>
          <tbody><tr>
            <td class="c-concepto">${escapeHtml(calculo.concepto || 'Cargo adicional')}</td>
            <td class="c-base right">${fmt(calculo.costo || 0)}</td>
            <td class="c-pct right">${calculo.pct || 0}%</td>
            <td class="c-total right">${fmt(calculo.monto)}</td>
          </tr></tbody>
        </table>
        <div class="subtotal">Subtotal ${escapeHtml(calculo.concepto || 'cálculo')}: ${fmt(calculo.monto)}</div>
      </div>`
  }

  // ── Resumen de descuento ───────────────────────────────────────────────────
  let descuentoHTML = ''
  if (modoDescuento && totalDescPesos > 0.001) {
    const pctStr = descuento_nominal > 0
      ? descuento_nominal.toFixed(1)
      : ((totalDescPesos / totalBruto) * 100).toFixed(1)
    descuentoHTML = `
      <div class="desc-resumen">
        <div class="desc-row gray"><span class="desc-lbl">TOTAL GLOBAL BRUTO:</span><span class="desc-val">${fmt(totalBruto)}</span></div>
        <div class="desc-row green"><span class="desc-lbl">DESCUENTO GLOBAL (${pctStr}%):</span><span class="desc-val">-${fmt(totalDescPesos)}</span></div>
      </div>`
  }

  const totalLabel = (modoDescuento && totalDescPesos > 0.001) ? 'TOTAL GLOBAL NETO:' : 'TOTAL GENERAL:'

  const obsHTML = observacion
    ? `<div class="obs-bar">${escapeHtml(observacion)}</div>`
    : ''

  const logoHTML = logoSrc
    ? `<img src="${logoSrc}" style="height:45px;width:auto;display:block;" alt="DISFRULEG" />`
    : `<strong style="font-size:16pt;color:#8B1A1A;">DISFRULEG</strong>`

  const folioStr = String(folio_numero).padStart(6, '0')

  // ── HTML completo ──────────────────────────────────────────────────────────
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<title>DISFRULEG — Folio ${folioStr}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: Helvetica, Arial, sans-serif;
    font-size: 8pt;
    color: #000;
    background: #fff;
  }

  /* ── HEADER ── */
  .hdr-bar {
    background: #F5F5F5;
    border: 1px solid #000;
    padding: 5px 10px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .hdr-client { font-size: 11pt; font-weight: bold; }
  .hdr-folio  { font-size: 11pt; font-weight: bold; }
  .hdr-fecha  {
    background: #F5F5F5;
    border: 1px solid #000;
    border-top: none;
    text-align: center;
    font-size: 10pt;
    font-weight: bold;
    padding: 3px 0;
    margin-bottom: 0;
  }

  /* ── OBSERVACIÓN ── */
  .obs-bar {
    background: #FFF3CD;
    border-bottom: 1px solid #E6A817;
    padding: 4px 10px;
    font-size: 9pt;
    font-style: italic;
    font-weight: bold;
    color: #5C3317;
  }

  /* ── LOGO ROW ── */
  .logo-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding: 8px 0 6px;
  }
  .logo-info {
    text-align: right;
    font-size: 7.5pt;
    color: #333;
    line-height: 1.6;
  }

  /* ── SECCIÓN ── */
  .seccion { margin-bottom: 8px; }
  .sec-header {
    border: 0.5px solid #000;
    text-align: center;
    font-size: 10pt;
    font-weight: bold;
    color: #8B1A1A;
    padding: 3px 0;
  }

  /* ── TABLA ── */
  .tbl {
    width: 100%;
    border-collapse: collapse;
    font-size: 8pt;
  }
  .tbl thead tr { background: #8B1A1A; color: #fff; }
  .tbl thead th {
    padding: 4px 5px;
    font-size: 8pt;
    font-weight: bold;
    border: 1px solid #000;
  }
  .tbl tbody td {
    padding: 4px 5px;
    border: 0.5px solid #000;
    vertical-align: middle;
    line-height: 1.3;
  }
  .right  { text-align: right; }
  .center { text-align: center; }
  .zero   { color: #FF6B6B; }
  .green  { color: #16A34A; font-weight: bold; }

  /* ── ANCHOS: modo normal ── */
  .c-producto { width: 44%; }
  .c-cant     { width: 11%; }
  .c-unidad   { width: 15%; }
  .c-precio   { width: 15%; }
  .c-total    { width: 15%; }

  /* ── ANCHOS: modo descuento ── */
  .c-pbruto   { width: 13%; }

  /* ── DESGLOSE POR SECCIÓN (modo descuento) ── */
  .sec-desc {
    padding: 3px 0;
    margin-top: 2px;
  }
  .sec-desc-row {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    font-size: 7.5pt;
    line-height: 1.7;
  }
  .sec-desc-lbl { }
  .sec-desc-val { font-weight: bold; min-width: 90px; text-align: right; }
  .sec-desc-row.gray .sec-desc-lbl,
  .sec-desc-row.gray .sec-desc-val { color: #6B7280; }
  .sec-desc-row.green .sec-desc-lbl,
  .sec-desc-row.green .sec-desc-val { color: #16A34A; font-weight: bold; }
  .sec-desc-row.bold .sec-desc-lbl,
  .sec-desc-row.bold .sec-desc-val { font-weight: bold; }

  /* ── ANCHOS: calculo ── */
  .c-concepto { width: 46%; }
  .c-base     { width: 22%; }
  .c-pct      { width: 12%; }

  /* ── SUBTOTAL ── */
  .subtotal {
    border-top: 0.3px solid #aaa;
    text-align: right;
    font-size: 8pt;
    font-weight: bold;
    padding: 2px 0;
    margin-top: 2px;
  }

  /* ── DESCUENTO RESUMEN ── */
  .desc-resumen {
    padding: 4px 0;
    margin: 6px 0;
  }
  .desc-row {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 16px;
    font-size: 8pt;
    line-height: 1.8;
  }
  .desc-lbl { }
  .desc-val { font-weight: bold; min-width: 100px; text-align: right; }
  .desc-row.gray .desc-lbl,
  .desc-row.gray .desc-val { color: #6B7280; }
  .desc-row.green .desc-lbl,
  .desc-row.green .desc-val { color: #16A34A; }

  /* ── TOTAL GENERAL ── */
  .total-gral {
    text-align: right;
    font-size: 11pt;
    font-weight: bold;
    color: #8B1A1A;
    margin: 6px 0;
  }

  /* ── RECEPCIÓN ── */
  .recep-title {
    font-size: 8pt;
    font-weight: bold;
    margin-top: 18px;
    margin-bottom: 6px;
  }
  .recep-fields {
    display: flex;
    gap: 8px;
  }
  .recep-field { flex: 1; }
  .recep-field label {
    display: block;
    font-size: 7pt;
    margin-bottom: 3px;
  }
  .recep-box {
    border: 0.5px solid #000;
    height: 28px;
    width: 100%;
    display: block;
  }

  /* ── PRINT ── */
  @page {
    size: A4;
    margin: 12mm 16mm 24mm 12mm;
  }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .no-print { display: none; }
    tr { break-inside: avoid; page-break-inside: avoid; }
  }
</style>
</head>
<body>

  <div class="hdr-bar">
    <span class="hdr-client">${escapeHtml(nombre_cliente.toUpperCase())}</span>
    <span class="hdr-folio">FOLIO: ${folioStr}</span>
  </div>
  <div class="hdr-fecha">${fechaStr}</div>
  ${obsHTML}

  <div class="logo-row">
    <div>${logoHTML}</div>
    <div class="logo-info">
      Felipe Páramo #160, Veinte de Noviembre C.P. 58219, Morelia, Michoacán<br>
      Cel. (443) 504 9098
    </div>
  </div>

  ${seccionesHTML}
  ${calculoHTML}
  ${descuentoHTML}

  <div class="total-gral">${totalLabel} ${fmt(total)}</div>

  <div class="recep-title">DATOS DE RECEPCIÓN</div>
  <div class="recep-fields">
    ${['HORA', 'ENTREGÓ', 'RECIBIÓ', 'FIRMA'].map(f => `
    <div class="recep-field">
      <label>${f}:</label>
      <div class="recep-box"></div>
    </div>`).join('')}
  </div>

</body>
</html>`
}

module.exports = { generateReceiptHTML }
