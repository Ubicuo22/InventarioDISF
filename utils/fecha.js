const TZ = 'America/Mexico_City'

function fechaMexico(offsetDias = 0) {
  const d = new Date(Date.now() + offsetDias * 86400000)
  return d.toLocaleDateString('en-CA', { timeZone: TZ })
}

module.exports = { fechaMexico }
