/**
 * utils/tickets.js — Reglas de los archivos de tickets de compra
 *
 * Compartido por routes/tickets.js (PWA, sube) y routes/electron/tickets.js
 * (Electron, captura). Ver docs/PLAN-TICKETS-COMPRA.md.
 */

const { randomUUID } = require('node:crypto')

// Solo formatos que son un ticket y que ambos visores muestran. El HEIC del
// iPhone llega ya convertido a JPEG por la PWA; Word/Excel/ZIP no son ticket.
const TIPOS = {
  'image/jpeg':      { ext: 'jpg',  limite: 3 * 1024 * 1024 },
  'image/png':       { ext: 'png',  limite: 3 * 1024 * 1024 },
  'image/webp':      { ext: 'webp', limite: 3 * 1024 * 1024 },
  'application/pdf': { ext: 'pdf',  limite: 15 * 1024 * 1024 },
}

// El límite del parser va al del tipo más grande; el de cada tipo se
// revisa después de detectar qué es.
const LIMITE_MAXIMO = 15 * 1024 * 1024
const MAX_ARCHIVOS_POR_TICKET = 10

// Tolerancia del cuadre suma capturada vs total del ticket — redondeos de IVA
const TOLERANCIA_CUADRE = 1

/**
 * Tipo real por magic bytes. El Content-Type y la extensión los decide el
 * cliente, así que no cuentan: un .pdf que en realidad es otra cosa se
 * serviría luego con un tipo equivocado al visor.
 */
function detectarTipo(buf) {
  if (!buf || buf.length < 12) return null
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png'
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (buf.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf'
  return null
}

function excedeLimite(tipo, tamano) {
  return tamano > TIPOS[tipo].limite
}

async function sha256Hex(buf) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buf)
  return Buffer.from(digest).toString('hex')
}

function claveR2(tipo, fecha = new Date()) {
  const aaaa = fecha.getUTCFullYear()
  const mm   = String(fecha.getUTCMonth() + 1).padStart(2, '0')
  return `tickets/${aaaa}/${mm}/${randomUUID()}.${TIPOS[tipo].ext}`
}

/**
 * Responde con el archivo de un ticket. Lo usan la PWA y Electron; cada
 * router decide antes quién puede verlo. El id del archivo se busca junto
 * con el del ticket para que no se pueda pedir un archivo por otro ticket.
 */
async function servirArchivo(res, idTicket, idArchivo) {
  const { q } = require('../db/pool')
  const r2 = require('./tickets-r2')
  const [a] = await q(
    'SELECT r2_key, tipo FROM ticket_compra_archivo WHERE id = ? AND id_ticket = ?',
    [idArchivo, idTicket]
  )
  if (!a) return res.status(404).json({ ok: false, error: 'Archivo no encontrado' })
  if (!(await r2.disponible())) {
    return res.status(503).json({ ok: false, error: 'Almacenamiento de tickets no disponible' })
  }
  const buf = await r2.leer(a.r2_key)
  if (!buf) return res.status(404).json({ ok: false, error: 'Archivo no encontrado' })
  res.set('Content-Type', a.tipo)
  // El archivo de una clave nunca cambia; privado porque trae precios
  res.set('Cache-Control', 'private, max-age=86400, immutable')
  res.set('X-Content-Type-Options', 'nosniff')
  res.send(buf)
}

module.exports = {
  TIPOS, LIMITE_MAXIMO, MAX_ARCHIVOS_POR_TICKET, TOLERANCIA_CUADRE,
  detectarTipo, excedeLimite, sha256Hex, claveR2, servirArchivo,
}
