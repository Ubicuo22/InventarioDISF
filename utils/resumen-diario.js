/**
 * utils/resumen-diario.js — Resumen diario automático por push a las 20:00
 *
 * Uso en server.js:
 *   const { agendarResumenDiario } = require('./utils/resumen-diario')
 *   agendarResumenDiario()
 */

const { q }            = require('../db/pool')
const { enviarATodos } = require('./push')
const { fechaMexico } = require('./fecha')

async function enviarResumen() {
  try {
    const hoy = fechaMexico()

    // Pedidos del día (guardados + registrados)
    const [pedidosRow] = await q(
      `SELECT COUNT(*) AS total FROM ordenes_guardadas
       WHERE DATE(fecha_creacion) = ? AND activo = 1`,
      [hoy]
    )

    // Entradas de stock del día + gasto total
    const [entradasRow] = await q(
      `SELECT COUNT(*) AS total, COALESCE(SUM(total_con_impuestos), 0) AS gasto
       FROM compra
       WHERE DATE(fecha_compra) = ?`,
      [hoy]
    )

    // Mermas del día
    const [mermasRow] = await q(
      `SELECT COUNT(*) AS total FROM merma
       WHERE DATE(fecha_registro) = ? AND activo = 1`,
      [hoy]
    )

    const pedidos  = pedidosRow?.total  || 0
    const entradas = entradasRow?.total || 0
    const gasto    = parseFloat(entradasRow?.gasto || 0)
    const mermas   = mermasRow?.total   || 0

    const gastoStr = '$' + gasto.toLocaleString('es-MX', {
      minimumFractionDigits: 2, maximumFractionDigits: 2
    })

    const partes = []
    partes.push(`📋 Pedidos: ${pedidos}`)
    // Compras siempre se incluye (aunque el gasto sea $0.00)
    partes.push(`🛒 Compras: ${entradas} · ${gastoStr}`)
    if (mermas > 0) partes.push(`⚠️ Mermas: ${mermas}`)

    const fecha = new Date().toLocaleDateString('es-MX', {
      weekday: 'long', day: 'numeric', month: 'short'
    })

    const result = await enviarATodos({
      title: `📊 Resumen del día — ${fecha}`,
      body:  partes.join(' · '),
      icon:  '/assets/icon.png'
    })

    console.log(`[resumen-diario] Enviado — ${pedidos} pedidos, ${entradas} compras ($${gasto.toFixed(2)}), ${mermas} mermas — ${result.enviados}/${result.total} dispositivos`)
  } catch (e) {
    console.error('[resumen-diario] Error al enviar:', e.message)
  }
}

function agendarResumenDiario() {
  const ahora    = new Date()
  const objetivo = new Date(ahora)
  objetivo.setHours(20, 0, 0, 0)

  // Si ya pasaron las 8pm, programar para mañana
  if (objetivo <= ahora) {
    objetivo.setDate(objetivo.getDate() + 1)
  }

  const msHasta = objetivo - ahora
  const horas   = Math.floor(msHasta / 3_600_000)
  const mins    = Math.floor((msHasta % 3_600_000) / 60_000)

  console.log(`   ⏰ Resumen diario programado en ${horas}h ${mins}min (20:00 hora local)`)

  setTimeout(() => {
    enviarResumen()
    // Repetir cada 24 horas exactas
    setInterval(enviarResumen, 24 * 60 * 60 * 1000)
  }, msHasta)
}

module.exports = { agendarResumenDiario, enviarResumen }
