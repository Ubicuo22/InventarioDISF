const TZ = 'America/Mexico_City'

function fechaMexico(offsetDias = 0) {
  const d = new Date(Date.now() + offsetDias * 86400000)
  return d.toLocaleDateString('en-CA', { timeZone: TZ })
}

// Devuelve { inicio, fin } como strings UTC para usar en rangos de fecha.
// Evita DATE(col)=? que bloquea el índice cuando la tabla es grande.
// Ejemplo: '2026-08-29' → { inicio: '2026-08-29 05:00:00', fin: '2026-08-30 05:00:00' }
function rangoUtcDelDia(fechaMX) {
  const toSQL = (d) => d.toISOString().slice(0, 19).replace('T', ' ')
  const [y, m, d] = fechaMX.split('-').map(Number)
  // Detecta el offset de CDMX en esta fecha concreta (maneja CDT -5h y CST -6h)
  const ref = new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
  const mxHour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false })
      .formatToParts(ref)
      .find(p => p.type === 'hour').value
  )
  const offsetHours = mxHour - 12 // CDT: 7-12=-5 | CST: 6-12=-6
  const inicio = new Date(Date.UTC(y, m - 1, d, -offsetHours, 0, 0))
  return { inicio: toSQL(inicio), fin: toSQL(new Date(inicio.getTime() + 86400000)) }
}

module.exports = { fechaMexico, rangoUtcDelDia }
