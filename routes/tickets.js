/**
 * routes/tickets.js — Subida de tickets de compra desde la PWA
 *
 * Solo el CEO sube (decisión de negocio, 26 sep 2026); se valida aquí y no
 * solo en la interfaz. Subir no pide ningún dato: hoy nadie toma fotos de
 * tickets, y si cuesta más de unos segundos no se va a hacer. Proveedor,
 * productos y precios los captura después alguien en Electron.
 *
 * Flujo: POST / (borrador) → POST /:id/archivos, uno por petición → POST
 * /:id/enviar (pendiente). Un archivo por petición para que, con mala señal,
 * se reintente solo el que falló y no el ticket completo.
 * Ver docs/PLAN-TICKETS-COMPRA.md.
 */

const express = require('express')
const router  = express.Router()
const { q }   = require('../db/pool')
const T       = require('../utils/tickets')
const r2      = require('../utils/tickets-r2')

function soloCeo(req, res, next) {
  if (req.user?.rol !== 'ceo') {
    return res.status(403).json({ ok: false, error: 'Solo los CEO pueden subir tickets' })
  }
  next()
}

// El ticket en borrador de quien sube, o una respuesta de error ya enviada
async function borradorPropio(req, res) {
  const [t] = await q('SELECT id, estado, subido_por FROM ticket_compra WHERE id = ?', [req.params.id])
  if (!t || t.subido_por !== req.user.username) {
    res.status(404).json({ ok: false, error: 'Ticket no encontrado' })
    return null
  }
  if (t.estado !== 'borrador') {
    res.status(409).json({ ok: false, error: 'Este ticket ya se envió' })
    return null
  }
  return t
}

// ─── POST / — crear ticket en borrador ──────────────────────────
router.post('/', soloCeo, async (req, res) => {
  try {
    const nota = String(req.body?.nota ?? '').trim().slice(0, 255) || null
    const r = await q(
      'INSERT INTO ticket_compra (estado, nota, subido_por) VALUES (\'borrador\', ?, ?)',
      [nota, req.user.username]
    )
    res.json({ ok: true, data: { id: r.insertId } })
  } catch (err) {
    console.error('[tickets] POST /:', err.message)
    res.status(500).json({ ok: false, error: 'Error interno' })
  }
})

// ─── POST /:id/archivos — subir un archivo (cuerpo binario) ─────
router.post(
  '/:id/archivos',
  soloCeo,
  express.raw({ type: () => true, limit: T.LIMITE_MAXIMO }),
  async (req, res) => {
    try {
      const buf = Buffer.isBuffer(req.body) ? req.body : null
      if (!buf || !buf.length) return res.status(400).json({ ok: false, error: 'Archivo vacío' })

      const tipo = T.detectarTipo(buf)
      if (!tipo) return res.status(415).json({ ok: false, error: 'Formato no admitido. Sube una foto (JPG, PNG, WebP) o un PDF.' })
      if (T.excedeLimite(tipo, buf.length)) return res.status(413).json({ ok: false, error: 'El archivo es demasiado grande' })

      const t = await borradorPropio(req, res)
      if (!t) return

      const [{ n }] = await q('SELECT COUNT(*) AS n FROM ticket_compra_archivo WHERE id_ticket = ?', [t.id])
      if (Number(n) >= T.MAX_ARCHIVOS_POR_TICKET) {
        return res.status(400).json({ ok: false, error: `Máximo ${T.MAX_ARCHIVOS_POR_TICKET} archivos por ticket` })
      }

      const sha = await T.sha256Hex(buf)

      // Pasa seguido con fotos reenviadas por WhatsApp: el mismo archivo dos
      // veces sería la misma compra capturada dos veces. Se avisa, no se
      // bloquea — `?forzar=1` si de verdad es otro ticket.
      if (req.query.forzar !== '1') {
        const [dup] = await q(
          `SELECT t.id, t.fecha_subida, t.subido_por, t.estado
             FROM ticket_compra_archivo a
             JOIN ticket_compra t ON t.id = a.id_ticket
            WHERE a.sha256 = ? AND t.id <> ? AND t.estado NOT IN ('descartado', 'borrador')
            LIMIT 1`,
          [sha, t.id]
        )
        if (dup) return res.status(409).json({ ok: false, error: 'Este archivo ya se había subido', duplicado: dup })
      }

      if (!(await r2.disponible())) {
        return res.status(503).json({ ok: false, error: 'Almacenamiento de tickets no disponible' })
      }
      const key = T.claveR2(tipo)
      await r2.guardar(key, buf, tipo)

      const ins = await q(
        `INSERT INTO ticket_compra_archivo (id_ticket, orden, r2_key, tipo, tamano, sha256)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [t.id, Number(n) + 1, key, tipo, buf.length, sha]
      )
      res.json({ ok: true, data: { id: ins.insertId, tipo, tamano: buf.length } })
    } catch (err) {
      console.error('[tickets] POST /:id/archivos:', err.message)
      res.status(500).json({ ok: false, error: 'Error interno' })
    }
  }
)

// ─── POST /:id/enviar — borrador → pendiente ────────────────────
router.post('/:id/enviar', soloCeo, async (req, res) => {
  try {
    const t = await borradorPropio(req, res)
    if (!t) return
    const [{ n }] = await q('SELECT COUNT(*) AS n FROM ticket_compra_archivo WHERE id_ticket = ?', [t.id])
    if (!Number(n)) return res.status(400).json({ ok: false, error: 'El ticket no tiene archivos' })
    await q(`UPDATE ticket_compra SET estado = 'pendiente', fecha_subida = NOW() WHERE id = ? AND estado = 'borrador'`, [t.id])
    res.json({ ok: true, data: { id: t.id } })
  } catch (err) {
    console.error('[tickets] POST /:id/enviar:', err.message)
    res.status(500).json({ ok: false, error: 'Error interno' })
  }
})

// ─── GET /mios — lo que subí y cuántos faltan por capturar ──────
// El contador es de todos los tickets, no solo los propios: al CEO le sirve
// para dar seguimiento a la captura, no solo a sus subidas.
router.get('/mios', soloCeo, async (req, res) => {
  try {
    const tickets = await q(
      `SELECT t.id, t.estado, t.nota, t.fecha_subida, t.fecha_captura, t.capturado_por,
              (SELECT COUNT(*) FROM ticket_compra_archivo a WHERE a.id_ticket = t.id) AS archivos,
              (SELECT MIN(a.id) FROM ticket_compra_archivo a WHERE a.id_ticket = t.id) AS id_primer_archivo
         FROM ticket_compra t
        WHERE t.subido_por = ? AND t.estado <> 'borrador'
        ORDER BY t.fecha_subida DESC
        LIMIT 20`,
      [req.user.username]
    )
    const [{ n }] = await q(`SELECT COUNT(*) AS n FROM ticket_compra WHERE estado IN ('pendiente', 'en_captura')`)
    res.json({ ok: true, data: { tickets, sinCapturar: Number(n) } })
  } catch (err) {
    console.error('[tickets] GET /mios:', err.message)
    res.status(500).json({ ok: false, error: 'Error interno' })
  }
})

// ─── GET /:id/archivos/:idArchivo — ver un archivo ──────────────
router.get('/:id/archivos/:idArchivo', soloCeo, async (req, res) => {
  try {
    await T.servirArchivo(res, req.params.id, req.params.idArchivo)
  } catch (err) {
    console.error('[tickets] GET archivo:', err.message)
    res.status(500).json({ ok: false, error: 'Error interno' })
  }
})

module.exports = router
