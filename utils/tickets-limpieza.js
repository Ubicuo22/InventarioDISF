/**
 * utils/tickets-limpieza.js — Borra tickets que se quedaron en borrador
 *
 * Un borrador es una subida que nunca se envió (se cerró la PWA, se fue la
 * señal a medias). Pasadas 24 h ya no se va a terminar: se borran sus
 * archivos de R2 y sus filas. Los enviados nunca se tocan.
 */

const { q } = require('../db/pool')
const r2 = require('./tickets-r2')

async function limpiarTicketsBorrador() {
  const viejos = await q(
    `SELECT id FROM ticket_compra
      WHERE estado = 'borrador' AND fecha_subida < DATE_SUB(NOW(), INTERVAL 24 HOUR)
      LIMIT 200`
  )
  if (!viejos.length) return 0
  const ids = viejos.map(t => t.id)
  const marcas = ids.map(() => '?').join(',')
  const archivos = await q(`SELECT r2_key FROM ticket_compra_archivo WHERE id_ticket IN (${marcas})`, ids)
  // R2 primero: si falla, las filas se quedan y el próximo cron reintenta.
  // Al revés quedarían archivos en R2 sin ninguna fila que los encuentre.
  await r2.borrar(archivos.map(a => a.r2_key))
  await q(`DELETE FROM ticket_compra_archivo WHERE id_ticket IN (${marcas})`, ids)
  await q(`DELETE FROM ticket_compra WHERE id IN (${marcas}) AND estado = 'borrador'`, ids)
  return ids.length
}

module.exports = { limpiarTicketsBorrador }
