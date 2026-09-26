/**
 * routes/electron/tickets.js — Bandeja y captura de tickets en Electron
 *
 * El capturista abre un ticket que subió un CEO desde la PWA, lo ve junto
 * al formulario de compras de siempre y lo cierra con cuadre contra el
 * total. Ver docs/PLAN-TICKETS-COMPRA.md.
 *
 * Todas las transiciones de estado del ticket viven aquí. Lo único que NO
 * pasa por el Worker es el alta de cada compra: esa lógica (PEPS,
 * rellenarLineasSinCosto, reconsumo) sigue en compras.handler.ts de
 * Electron, que solo acepta `idTicket` si el ticket está en_captura a
 * nombre del usuario de la sesión.
 *
 * Capturan los mismos roles que hoy registran compras (todos los de
 * Electron). Liberar un ticket ajeno o devolver uno descartado: admin/ceo.
 * La identidad sale siempre del JWT, nunca del body.
 */

const router = require('express').Router()
const { q } = require('../../db/pool')
const { requireRoleElectron } = require('../../middleware/auth-electron')
const T = require('../../utils/tickets')

const SOLO_ADMIN = requireRoleElectron(['admin', 'ceo'])

const usuario = (req) => req.user.username

// COLLATE en los JOIN: ticket_compra se creó con utf8mb4_unicode_ci (default
// del editor de TiDB) y usuarios_sistema.username es utf8mb4_0900_ai_ci. Sin
// forzarla, TiDB rechaza la comparación (ER_CANT_AGGREGATE_2COLLATIONS) y la
// bandeja respondía 500 — el contador no hace JOIN y por eso sí funcionaba.
const SELECT_TICKET = `
  SELECT t.id, t.estado, t.nota, t.fecha_subida,
         t.subido_por,     COALESCE(us.nombre_completo, t.subido_por)     AS subido_por_nombre,
         t.capturando_por, COALESCE(uc.nombre_completo, t.capturando_por) AS capturando_por_nombre,
         t.inicio_captura, t.id_proveedor, t.fecha_ticket, t.folio, t.total_ticket,
         t.diferencia_aceptada, t.motivo_diferencia, t.capturado_por, t.fecha_captura,
         t.motivo_descarte,
         (SELECT COUNT(*) FROM ticket_compra_archivo a WHERE a.id_ticket = t.id) AS archivos,
         (SELECT MIN(a.id) FROM ticket_compra_archivo a WHERE a.id_ticket = t.id) AS id_primer_archivo,
         (SELECT COUNT(*) FROM compra c WHERE c.id_ticket = t.id) AS compras
    FROM ticket_compra t
    LEFT JOIN usuarios_sistema us ON us.username = t.subido_por     COLLATE utf8mb4_0900_ai_ci
    LEFT JOIN usuarios_sistema uc ON uc.username = t.capturando_por COLLATE utf8mb4_0900_ai_ci`

async function comprasDelTicket(idTicket) {
  const compras = await q(
    `SELECT c.id_compra, c.id_producto, p.nombre_producto, p.unidad_producto,
            c.cantidad_compra, c.precio_unitario_compra, c.incluye_iva,
            c.total_con_impuestos, c.usuario_registro, c.fecha_registro
       FROM compra c
       JOIN producto p ON p.id_producto = c.id_producto
      WHERE c.id_ticket = ?
      ORDER BY c.id_compra`,
    [idTicket]
  )
  const suma = compras.reduce((s, c) => s + Number(c.total_con_impuestos || 0), 0)
  return { compras, suma: Math.round(suma * 100) / 100 }
}

// ─── GET / — bandeja ────────────────────────────────────────────
// Los que tengo en captura van primero ("Continuar"), luego por antigüedad.
router.get('/', async (req, res) => {
  try {
    const rows = await q(
      `${SELECT_TICKET}
        WHERE t.estado IN ('pendiente', 'en_captura')
        ORDER BY (t.estado = 'en_captura' AND t.capturando_por = ?) DESC, t.fecha_subida ASC
        LIMIT 100`,
      [usuario(req)]
    )
    res.json({ ok: true, data: rows })
  } catch (err) {
    console.error('[electron/tickets] GET /:', err.message)
    res.status(500).json({ ok: false, error: 'Error interno' })
  }
})

// ─── GET /contar — para el aviso de Registro de compras ─────────
router.get('/contar', async (req, res) => {
  try {
    const [r] = await q(
      `SELECT SUM(estado = 'pendiente') AS pendientes,
              SUM(estado = 'en_captura' AND capturando_por = ?) AS mios_en_captura,
              SUM(estado = 'en_captura') AS en_captura
         FROM ticket_compra
        WHERE estado IN ('pendiente', 'en_captura')`,
      [usuario(req)]
    )
    res.json({ ok: true, data: {
      pendientes:      Number(r?.pendientes || 0),
      mios_en_captura: Number(r?.mios_en_captura || 0),
      en_captura:      Number(r?.en_captura || 0),
    } })
  } catch (err) {
    console.error('[electron/tickets] GET /contar:', err.message)
    res.status(500).json({ ok: false, error: 'Error interno' })
  }
})

// ─── GET /:id — detalle con archivos y compras ya ligadas ───────
router.get('/:id', async (req, res) => {
  try {
    const [t] = await q(`${SELECT_TICKET} WHERE t.id = ? AND t.estado <> 'borrador'`, [req.params.id])
    if (!t) return res.status(404).json({ ok: false, error: 'Ticket no encontrado' })
    const archivos = await q(
      'SELECT id, orden, tipo, tamano FROM ticket_compra_archivo WHERE id_ticket = ? ORDER BY orden, id',
      [t.id]
    )
    const { compras, suma } = await comprasDelTicket(t.id)
    res.json({ ok: true, data: { ...t, archivos, compras_ligadas: compras, suma } })
  } catch (err) {
    console.error('[electron/tickets] GET /:id:', err.message)
    res.status(500).json({ ok: false, error: 'Error interno' })
  }
})

// ─── GET /:id/archivos/:idArchivo ───────────────────────────────
router.get('/:id/archivos/:idArchivo', async (req, res) => {
  try {
    await T.servirArchivo(res, req.params.id, req.params.idArchivo)
  } catch (err) {
    console.error('[electron/tickets] GET archivo:', err.message)
    res.status(500).json({ ok: false, error: 'Error interno' })
  }
})

// ─── POST /:id/tomar — apartar para capturar ────────────────────
// Un solo UPDATE condicionado: si dos capturistas lo abren a la vez, solo
// uno cambia la fila. Reabrir uno propio en_captura también pasa.
router.post('/:id/tomar', async (req, res) => {
  try {
    const u = usuario(req)
    const r = await q(
      `UPDATE ticket_compra
          SET estado = 'en_captura', capturando_por = ?,
              inicio_captura = CASE WHEN estado = 'pendiente' THEN NOW() ELSE inicio_captura END
        WHERE id = ?
          AND (estado = 'pendiente' OR (estado = 'en_captura' AND capturando_por = ?))`,
      [u, req.params.id, u]
    )
    if (r.affectedRows !== 1) {
      const [t] = await q(`${SELECT_TICKET} WHERE t.id = ?`, [req.params.id])
      if (!t || t.estado === 'borrador') return res.status(404).json({ ok: false, error: 'Ticket no encontrado' })
      const error = t.estado === 'en_captura'
        ? `${t.capturando_por_nombre} ya está capturando este ticket`
        : 'Este ticket ya no está pendiente'
      return res.status(409).json({ ok: false, error, reason: 'TICKET_OCUPADO' })
    }
    res.json({ ok: true, data: { id: Number(req.params.id) } })
  } catch (err) {
    console.error('[electron/tickets] POST /:id/tomar:', err.message)
    res.status(500).json({ ok: false, error: 'Error interno' })
  }
})

// ─── POST /:id/soltar — abrí el equivocado ──────────────────────
// Solo sin compras ligadas: si ya capturé algo, soltarlo dejaría compras
// colgando de un ticket que otro podría capturar otra vez.
router.post('/:id/soltar', async (req, res) => {
  try {
    const r = await q(
      `UPDATE ticket_compra
          SET estado = 'pendiente', capturando_por = NULL, inicio_captura = NULL
        WHERE id = ? AND estado = 'en_captura' AND capturando_por = ?
          AND NOT EXISTS (SELECT 1 FROM compra c WHERE c.id_ticket = ticket_compra.id)`,
      [req.params.id, usuario(req)]
    )
    if (r.affectedRows !== 1) {
      return res.status(409).json({ ok: false, error: 'No se puede soltar: no lo tienes en captura o ya tiene compras registradas' })
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('[electron/tickets] POST /:id/soltar:', err.message)
    res.status(500).json({ ok: false, error: 'Error interno' })
  }
})

// ─── POST /:id/liberar — admin/ceo ──────────────────────────────
// Para el ticket que alguien dejó abierto (se fue, se enfermó) o uno que se
// descartó por error. Las compras ya ligadas se quedan: quien lo tome sigue
// desde ahí.
router.post('/:id/liberar', SOLO_ADMIN, async (req, res) => {
  try {
    const r = await q(
      `UPDATE ticket_compra
          SET estado = 'pendiente', capturando_por = NULL, inicio_captura = NULL,
              descartado_por = NULL, fecha_descarte = NULL, motivo_descarte = NULL
        WHERE id = ? AND estado IN ('en_captura', 'descartado')`,
      [req.params.id]
    )
    if (r.affectedRows !== 1) return res.status(409).json({ ok: false, error: 'Solo se liberan tickets en captura o descartados' })
    res.json({ ok: true })
  } catch (err) {
    console.error('[electron/tickets] POST /:id/liberar:', err.message)
    res.status(500).json({ ok: false, error: 'Error interno' })
  }
})

// ─── POST /:id/terminar — cerrar con cuadre ─────────────────────
// La suma se calcula aquí desde `compra`, nunca se toma del renderer: es
// justo el número que tiene que ser confiable.
router.post('/:id/terminar', async (req, res) => {
  try {
    const u = usuario(req)
    const { idProveedor = null, fechaTicket = null, folio = null, totalTicket, motivoDiferencia } = req.body ?? {}

    const total = Number(totalTicket)
    if (!(total > 0)) return res.status(400).json({ ok: false, error: 'Captura el total del ticket' })

    const [t] = await q('SELECT id, estado, capturando_por FROM ticket_compra WHERE id = ?', [req.params.id])
    if (!t || t.estado !== 'en_captura' || t.capturando_por !== u) {
      return res.status(409).json({ ok: false, error: 'No tienes este ticket en captura' })
    }

    const { compras, suma } = await comprasDelTicket(t.id)
    if (!compras.length) return res.status(400).json({ ok: false, error: 'El ticket no tiene compras registradas' })

    const diferencia = Math.round((suma - total) * 100) / 100
    const descuadrado = Math.abs(diferencia) > T.TOLERANCIA_CUADRE
    const motivo = String(motivoDiferencia ?? '').trim().slice(0, 255)
    if (descuadrado && !motivo) {
      return res.status(409).json({
        ok: false,
        error: `La suma capturada ($${suma.toFixed(2)}) no cuadra con el total del ticket ($${total.toFixed(2)})`,
        reason: 'DESCUADRE',
        descuadre: { suma, total, diferencia },
      })
    }

    const r = await q(
      `UPDATE ticket_compra
          SET estado = 'capturado', capturado_por = ?, fecha_captura = NOW(),
              id_proveedor = ?, fecha_ticket = ?, folio = ?, total_ticket = ?,
              diferencia_aceptada = ?, motivo_diferencia = ?
        WHERE id = ? AND estado = 'en_captura' AND capturando_por = ?`,
      [u, idProveedor || null, fechaTicket || null, String(folio ?? '').trim().slice(0, 50) || null, total,
       descuadrado ? diferencia : null, descuadrado ? motivo : null,
       t.id, u]
    )
    if (r.affectedRows !== 1) return res.status(409).json({ ok: false, error: 'No tienes este ticket en captura' })
    res.json({ ok: true, data: { id: t.id, suma, total, diferencia: descuadrado ? diferencia : 0 } })
  } catch (err) {
    console.error('[electron/tickets] POST /:id/terminar:', err.message)
    res.status(500).json({ ok: false, error: 'Error interno' })
  }
})

// ─── POST /:id/descartar ────────────────────────────────────────
// Duplicado, ilegible o no era compra. El archivo se conserva y admin/ceo
// pueden devolverlo a pendientes con /liberar. Nunca con compras ligadas:
// descartarlo dejaría compras reales apuntando a un ticket "que no era".
router.post('/:id/descartar', async (req, res) => {
  try {
    const u = usuario(req)
    const motivo = String(req.body?.motivo ?? '').trim().slice(0, 255)
    if (!motivo) return res.status(400).json({ ok: false, error: 'Indica por qué se descarta' })
    const r = await q(
      `UPDATE ticket_compra
          SET estado = 'descartado', descartado_por = ?, fecha_descarte = NOW(), motivo_descarte = ?,
              capturando_por = NULL, inicio_captura = NULL
        WHERE id = ?
          AND (estado = 'pendiente' OR (estado = 'en_captura' AND capturando_por = ?))
          AND NOT EXISTS (SELECT 1 FROM compra c WHERE c.id_ticket = ticket_compra.id)`,
      [u, motivo, req.params.id, u]
    )
    if (r.affectedRows !== 1) {
      return res.status(409).json({ ok: false, error: 'No se puede descartar: está en captura por otra persona o ya tiene compras registradas' })
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('[electron/tickets] POST /:id/descartar:', err.message)
    res.status(500).json({ ok: false, error: 'Error interno' })
  }
})

module.exports = router
