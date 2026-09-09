/**
 * routes/electron/dispositivos.js — autorización de dispositivos de
 * Disfruleg Electron (Fase 2 de H-5, ver plan de migración)
 *
 * Esto es lo que de verdad cierra el hueco de seguridad de esta fase: hoy,
 * bloquear un dispositivo desde el cliente solo cambia una fila en BD — una
 * ventana ya logueada en ese dispositivo sigue con acceso completo hasta
 * que se reinicia. Aquí, block/delete además desactivan las
 * electron_sesiones activas de ese device_id, así que la siguiente llamada
 * de esa sesión a cualquier canal del Worker recibe 401. No es instantáneo
 * en todos los casos — el caché de sesión de auth-electron.js dura 5 min
 * por isolate de Cloudflare Workers, y esto solo invalida el isolate que
 * atendió el bloqueo — pero acota el máximo a esos 5 minutos, contra "nunca
 * hasta reiniciar la app" que es el comportamiento de hoy.
 *
 * Igual que usuarios.js: reads con respaldo local en Electron, writes sin
 * respaldo — si esta ruta no responde, la acción falla, no se degrada a
 * confiar en un rol local.
 */

const router = require('express').Router()
const { pool, q } = require('../../db/pool')
const { requireRoleElectron, invalidarCacheElectron } = require('../../middleware/auth-electron')

const ADMIN = requireRoleElectron(['admin', 'ceo'])

/** Desactiva las electron_sesiones activas de un device_id — ver comentario de archivo. */
async function invalidarSesionesDispositivo(deviceId) {
  try {
    const [jtis] = await pool.execute('SELECT jti FROM electron_sesiones WHERE device_id = ? AND activo = 1', [deviceId])
    await pool.execute('UPDATE electron_sesiones SET activo = 0 WHERE device_id = ? AND activo = 1', [deviceId])
    for (const row of jtis) invalidarCacheElectron(row.jti)
  } catch (e) {
    console.warn('[dispositivos] No se pudieron invalidar sesiones:', e.message)
  }
}

// Nota: dispositivos_eventos ya existía en la BD (tabla vacía, de una
// versión anterior no conectada a ningún código actual — confirmado antes
// de escribir aquí) con un esquema distinto al planeado originalmente. Se
// usa tal cual está, en vez de forzar un esquema nuevo sobre una tabla real:
// estado_anterior/estado_nuevo en vez de un solo campo "evento", y
// usuario_admin como el username (string, del JWT) en vez de un ID.
async function registrarEvento(idDispositivo, deviceId, estadoAnterior, estadoNuevo, usuarioAdmin, razon) {
  try {
    await pool.execute(
      `INSERT INTO dispositivos_eventos (id_dispositivo, device_id, estado_anterior, estado_nuevo, razon, usuario_admin) VALUES (?, ?, ?, ?, ?, ?)`,
      [idDispositivo, deviceId, estadoAnterior || null, estadoNuevo, razon || null, usuarioAdmin]
    )
  } catch (e) {
    console.warn('[dispositivos] No se pudo registrar evento de auditoría:', e.message)
  }
}

// ─── GET / (getAll) ───────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const filter = req.query.filter || 'all'
    let where = 'd.fecha_eliminacion IS NULL'
    if (filter === 'authorized') where += " AND d.estado = 'AUTORIZADO'"
    else if (filter === 'pending') where += " AND d.estado = 'PENDING'"
    else if (filter === 'blocked') where += " AND d.estado = 'BLOQUEADO'"

    const rows = await q(`
      SELECT d.id_dispositivo, d.device_id, d.device_name, d.device_info,
             d.id_usuario, u.username, u.nombre_completo,
             d.autorizado, d.fecha_registro, d.fecha_autorizacion,
             d.ultimo_acceso, d.activo, d.estado, d.notas
      FROM dispositivos_autorizados d
      LEFT JOIN usuarios_sistema u ON d.id_usuario = u.id_usuario
      WHERE ${where}
      ORDER BY d.fecha_registro DESC
    `)
    res.json({ ok: true, data: rows })
  } catch (e) {
    console.error('[dispositivos] getAll:', e.message)
    res.status(500).json({ ok: false, error: 'Error al obtener dispositivos' })
  }
})

// ─── GET /logins (getLastLogins) ─────────────────────────────
router.get('/logins', async (req, res) => {
  try {
    const rows = await q(`
      SELECT l.id_login, l.id_usuario, u.username, u.nombre_completo,
             l.fecha_login, l.ip_address, l.exito, l.razon_fallo,
             d.device_name, d.device_id, d.estado as estado_dispositivo
      FROM login_history l
      LEFT JOIN usuarios_sistema u ON l.id_usuario = u.id_usuario
      LEFT JOIN dispositivos_autorizados d ON l.id_dispositivo = d.id_dispositivo
      ORDER BY l.fecha_login DESC LIMIT 100
    `)
    res.json({ ok: true, data: rows })
  } catch (e) {
    console.error('[dispositivos] logins:', e.message)
    res.status(500).json({ ok: false, error: 'Error al obtener historial de logins' })
  }
})

// ─── GET /stats ───────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const rows = await q(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN estado = 'AUTORIZADO' THEN 1 ELSE 0 END) as authorized,
             SUM(CASE WHEN estado = 'PENDING' THEN 1 ELSE 0 END) as pending,
             SUM(CASE WHEN estado = 'BLOQUEADO' THEN 1 ELSE 0 END) as blocked,
             SUM(CASE WHEN activo = 1 THEN 1 ELSE 0 END) as activos,
             (SELECT COUNT(*) FROM intentos_fallidos WHERE DATE(CONVERT_TZ(fecha_intento, '+00:00', '-06:00')) = DATE(CONVERT_TZ(NOW(), '+00:00', '-06:00'))) as failed_attempts_today
      FROM dispositivos_autorizados WHERE fecha_eliminacion IS NULL
    `)
    res.json({ ok: true, data: rows[0] })
  } catch (e) {
    console.error('[dispositivos] stats:', e.message)
    res.status(500).json({ ok: false, error: 'Error al obtener estadísticas' })
  }
})

// ─── POST /:id/authorize ──────────────────────────────────────
router.post('/:id/authorize', ADMIN, async (req, res) => {
  const id = Number(req.params.id)
  try {
    const rows = await q('SELECT device_id, id_usuario, estado FROM dispositivos_autorizados WHERE id_dispositivo = ?', [id])
    if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Dispositivo no encontrado' })
    if (!rows[0].id_usuario) {
      return res.status(400).json({ ok: false, error: 'Debe asignar un usuario al dispositivo antes de autorizarlo' })
    }

    const [upd] = await pool.execute(
      `UPDATE dispositivos_autorizados SET autorizado=1, estado='AUTORIZADO', fecha_autorizacion=NOW(), activo=1 WHERE id_dispositivo=?`,
      [id]
    )
    await registrarEvento(id, rows[0].device_id, rows[0].estado, 'AUTORIZADO', req.user.username, null)
    res.json({ ok: true, data: { affectedRows: upd.affectedRows } })
  } catch (e) {
    console.error('[dispositivos] authorize:', e.message)
    res.status(500).json({ ok: false, error: 'Error al autorizar dispositivo' })
  }
})

// ─── POST /:id/block ───────────────────────────────────────────
router.post('/:id/block', ADMIN, async (req, res) => {
  const id = Number(req.params.id)
  try {
    const rows = await q('SELECT device_id, estado FROM dispositivos_autorizados WHERE id_dispositivo = ?', [id])
    if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Dispositivo no encontrado' })
    const deviceId = rows[0].device_id
    const razon = req.body?.razon || req.body?.reason || null

    const [upd] = await pool.execute(
      `UPDATE dispositivos_autorizados SET estado='BLOQUEADO', activo=0, razon_bloqueo=? WHERE id_dispositivo=?`,
      [razon, id]
    )

    await invalidarSesionesDispositivo(deviceId)
    await registrarEvento(id, deviceId, rows[0].estado, 'BLOQUEADO', req.user.username, razon)

    res.json({ ok: true, data: { affectedRows: upd.affectedRows } })
  } catch (e) {
    console.error('[dispositivos] block:', e.message)
    res.status(500).json({ ok: false, error: 'Error al bloquear dispositivo' })
  }
})

// ─── POST /:id/reactivate ───────────────────────────────────────
router.post('/:id/reactivate', ADMIN, async (req, res) => {
  const id = Number(req.params.id)
  try {
    const rows = await q('SELECT device_id, estado FROM dispositivos_autorizados WHERE id_dispositivo = ?', [id])
    if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Dispositivo no encontrado' })

    const [upd] = await pool.execute(
      `UPDATE dispositivos_autorizados SET estado='AUTORIZADO', activo=1, razon_bloqueo=NULL WHERE id_dispositivo=?`,
      [id]
    )
    await registrarEvento(id, rows[0].device_id, rows[0].estado, 'AUTORIZADO', req.user.username, null)
    res.json({ ok: true, data: { affectedRows: upd.affectedRows } })
  } catch (e) {
    console.error('[dispositivos] reactivate:', e.message)
    res.status(500).json({ ok: false, error: 'Error al reactivar dispositivo' })
  }
})

// ─── PUT /:id/notas ───────────────────────────────────────────
router.put('/:id/notas', ADMIN, async (req, res) => {
  try {
    const [upd] = await pool.execute(
      'UPDATE dispositivos_autorizados SET notas = ? WHERE id_dispositivo = ?',
      [req.body?.notas ?? null, req.params.id]
    )
    res.json({ ok: true, data: { affectedRows: upd.affectedRows } })
  } catch (e) {
    console.error('[dispositivos] notas:', e.message)
    res.status(500).json({ ok: false, error: 'Error al actualizar notas' })
  }
})

// ─── DELETE /:id (?callerDeviceId=) ────────────────────────────
router.delete('/:id', ADMIN, async (req, res) => {
  const id = Number(req.params.id)
  try {
    const rows = await q('SELECT device_id, estado FROM dispositivos_autorizados WHERE id_dispositivo = ?', [id])
    if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Dispositivo no encontrado' })
    const deviceId = rows[0].device_id

    const callerDeviceId = req.query.callerDeviceId
    if (callerDeviceId && callerDeviceId === deviceId) {
      return res.status(400).json({ ok: false, error: 'No puedes eliminar el dispositivo actual' })
    }

    const [upd] = await pool.execute(
      `UPDATE dispositivos_autorizados SET estado='ELIMINADO', fecha_eliminacion=NOW(), activo=0 WHERE id_dispositivo=?`,
      [id]
    )

    await invalidarSesionesDispositivo(deviceId)
    await registrarEvento(id, deviceId, rows[0].estado, 'ELIMINADO', req.user.username, null)

    res.json({ ok: true, data: { affectedRows: upd.affectedRows } })
  } catch (e) {
    console.error('[dispositivos] delete:', e.message)
    res.status(500).json({ ok: false, error: 'Error al eliminar dispositivo' })
  }
})

module.exports = router
