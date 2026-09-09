/**
 * routes/electron/usuarios.js — CRUD de usuarios de Disfruleg Electron
 * (Fase 2 de H-5: identidad y control de acceso, ver plan de migración)
 *
 * Los canales de solo lectura (obtenerTodos, obtenerEstadisticas,
 * obtenerAdministradores, obtenerAvatar, obtenerPermisos) los llama
 * Electron con respaldo a SQL local si el Worker falla — igual que
 * tiposCliente en la Fase 0. Los de escritura (crear, actualizar,
 * eliminar, desbloquear) NO tienen respaldo local del lado Electron: si
 * esta ruta no responde, la acción falla — es la única forma de que el rol
 * exigido aquí sea real y no un adorno que un cliente parchado pueda saltarse.
 *
 * `actualizar` invalida las sesiones activas del usuario en electron_sesiones
 * cuando cambia su rol o se desactiva — mismo mecanismo que dispositivos.js
 * usa para bloqueo de dispositivo. `eliminar` lo hace siempre.
 */

const router = require('express').Router()
const bcrypt = require('bcryptjs')
const { pool, q } = require('../../db/pool')
const { requireRoleElectron, invalidarCacheElectron } = require('../../middleware/auth-electron')

const ADMIN = requireRoleElectron(['admin', 'ceo'])

function urlPublicaAvatar(r2Key) {
  return r2Key ? `${process.env.R2_PUBLIC_URL}/${r2Key}` : null
}

async function getRolUsuario(idUsuario) {
  const rows = await q('SELECT rol FROM usuarios_sistema WHERE id_usuario = ? AND activo = 1', [idUsuario])
  return rows[0]?.rol ?? null
}

/** Desactiva las electron_sesiones activas de un usuario — corta el acceso a
 *  canales del Worker en su próxima llamada (ver caveat de aislados en el plan). */
async function invalidarSesionesUsuario(idUsuario) {
  try {
    const [jtis] = await pool.execute('SELECT jti FROM electron_sesiones WHERE id_usuario = ? AND activo = 1', [idUsuario])
    await pool.execute('UPDATE electron_sesiones SET activo = 0 WHERE id_usuario = ? AND activo = 1', [idUsuario])
    for (const row of jtis) invalidarCacheElectron(row.jti)
  } catch (e) {
    console.warn('[usuarios] No se pudieron invalidar sesiones:', e.message)
  }
}

// ─── GET /obtenerTodos ──────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const usuarios = await q(`
      SELECT id_usuario, username, nombre_completo, rol, activo,
             ultimo_acceso, intentos_fallidos, bloqueado_hasta,
             avatar_color, avatar_r2_key
      FROM usuarios_sistema ORDER BY nombre_completo ASC
    `)

    for (const u of usuarios) {
      if (u.avatar_r2_key) u.avatar_url_publica = urlPublicaAvatar(u.avatar_r2_key)
      delete u.avatar_r2_key
    }

    const supervisores = usuarios.filter(u => u.rol === 'supervisor')
    if (supervisores.length > 0) {
      const ids = supervisores.map(s => s.id_usuario)
      const placeholders = ids.map(() => '?').join(',')
      const permisos = await q(`SELECT id_usuario, modulo_id FROM permisos_usuario WHERE id_usuario IN (${placeholders})`, ids)
      const porUsuario = {}
      for (const row of permisos) {
        (porUsuario[row.id_usuario] ??= []).push(row.modulo_id)
      }
      for (const s of supervisores) s.modulos_permitidos = porUsuario[s.id_usuario] || []
    }

    res.json({ ok: true, data: usuarios })
  } catch (e) {
    console.error('[usuarios] obtenerTodos:', e.message)
    res.status(500).json({ ok: false, error: 'Error al obtener usuarios' })
  }
})

// ─── GET /estadisticas ──────────────────────────────────────
router.get('/estadisticas', async (req, res) => {
  try {
    const rows = await q(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN activo = 1 AND (bloqueado_hasta IS NULL OR bloqueado_hasta < NOW()) THEN 1 ELSE 0 END) as activos,
             SUM(CASE WHEN bloqueado_hasta IS NOT NULL AND bloqueado_hasta > NOW() THEN 1 ELSE 0 END) as bloqueados,
             SUM(CASE WHEN rol = 'admin' THEN 1 ELSE 0 END) as admins,
             SUM(CASE WHEN rol = 'usuario' THEN 1 ELSE 0 END) as usuarios_normales
      FROM usuarios_sistema
    `)
    res.json({ ok: true, data: rows[0] })
  } catch (e) {
    console.error('[usuarios] estadisticas:', e.message)
    res.status(500).json({ ok: false, error: 'Error al obtener estadísticas' })
  }
})

// ─── GET /administradores ───────────────────────────────────
router.get('/administradores', async (req, res) => {
  try {
    const rows = await q(`
      SELECT id_usuario, username, nombre_completo, rol
      FROM usuarios_sistema WHERE rol IN ('admin','ceo') AND activo = 1
      ORDER BY nombre_completo ASC
    `)
    res.json({ ok: true, data: rows })
  } catch (e) {
    console.error('[usuarios] administradores:', e.message)
    res.status(500).json({ ok: false, error: 'Error al obtener administradores' })
  }
})

// ─── GET /avatar/:username ───────────────────────────────────
router.get('/avatar/:username', async (req, res) => {
  try {
    const rows = await q('SELECT avatar_color, avatar_r2_key FROM usuarios_sistema WHERE username = ?', [req.params.username])
    if (rows.length === 0) return res.json({ ok: true, data: { color: null, url_publica: null } })
    const row = rows[0]
    res.json({ ok: true, data: { color: row.avatar_color, url_publica: urlPublicaAvatar(row.avatar_r2_key) } })
  } catch (e) {
    console.error('[usuarios] avatar:', e.message)
    res.status(500).json({ ok: false, error: 'Error al obtener avatar' })
  }
})

// ─── GET /permisos/:idUsuario ────────────────────────────────
router.get('/permisos/:idUsuario', async (req, res) => {
  try {
    const rows = await q('SELECT modulo_id FROM permisos_usuario WHERE id_usuario = ?', [req.params.idUsuario])
    res.json({ ok: true, data: rows.map(r => r.modulo_id) })
  } catch (e) {
    console.error('[usuarios] permisos:', e.message)
    res.status(500).json({ ok: false, error: 'Error al obtener permisos' })
  }
})

// ─── POST / (crear) ──────────────────────────────────────────
router.post('/', ADMIN, async (req, res) => {
  try {
    const { username, password, nombre_completo, rol, avatar_color, modulos_permitidos } = req.body
    if (!username || !password || !nombre_completo) {
      return res.status(400).json({ ok: false, error: 'Usuario, contraseña y nombre son requeridos' })
    }
    if (rol === 'ceo' && req.user.rol !== 'ceo') {
      return res.status(403).json({ ok: false, error: 'Solo el CEO puede crear otros usuarios CEO' })
    }

    const existeRows = await q('SELECT COUNT(*) as count FROM usuarios_sistema WHERE username = ?', [username])
    if (existeRows[0].count > 0) {
      return res.status(409).json({ ok: false, error: 'El nombre de usuario ya existe' })
    }

    const hash = await bcrypt.hash(password, 10)
    const [result] = await pool.execute(
      `INSERT INTO usuarios_sistema (username, password_hash, nombre_completo, rol, activo, avatar_color)
       VALUES (?, ?, ?, ?, 1, ?)`,
      [username.trim(), hash, nombre_completo.trim(), rol || 'usuario', avatar_color || '#3b82f6']
    )

    if (rol === 'supervisor' && modulos_permitidos?.length > 0) {
      const placeholders = modulos_permitidos.map(() => '(?, ?)').join(', ')
      const vals = modulos_permitidos.flatMap(m => [result.insertId, m])
      await pool.execute(`INSERT IGNORE INTO permisos_usuario (id_usuario, modulo_id) VALUES ${placeholders}`, vals)
    }

    res.json({ ok: true, data: { insertId: result.insertId } })
  } catch (e) {
    console.error('[usuarios] crear:', e.message)
    res.status(500).json({ ok: false, error: 'Error al crear usuario' })
  }
})

// ─── PUT /:idUsuario (actualizar) ────────────────────────────
router.put('/:idUsuario', ADMIN, async (req, res) => {
  const idUsuario = Number(req.params.idUsuario)
  try {
    const { nombre_completo, rol, activo, password, newPassword, modulos_permitidos } = req.body

    const rolActual = await getRolUsuario(idUsuario)
    if (rolActual === null) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' })
    if (rolActual === 'ceo' && req.user.rol !== 'ceo') {
      return res.status(403).json({ ok: false, error: 'La cuenta CEO solo puede ser modificada por otro CEO' })
    }
    if (rol === 'ceo' && req.user.rol !== 'ceo') {
      return res.status(403).json({ ok: false, error: 'Solo el CEO puede asignar el rol CEO' })
    }

    const datos = { nombre_completo: String(nombre_completo || '').trim(), rol, activo: activo ? 1 : 0 }
    const passwordToHash = password || newPassword
    if (passwordToHash) datos.password_hash = await bcrypt.hash(passwordToHash, 10)

    const columnas = Object.keys(datos)
    const setClauses = columnas.map(c => `\`${c}\` = ?`).join(', ')
    const [upd] = await pool.execute(
      `UPDATE usuarios_sistema SET ${setClauses} WHERE id_usuario = ?`,
      [...columnas.map(c => datos[c] ?? null), idUsuario]
    )

    await pool.execute('DELETE FROM permisos_usuario WHERE id_usuario = ?', [idUsuario])
    if (rol === 'supervisor' && modulos_permitidos?.length > 0) {
      const placeholders = modulos_permitidos.map(() => '(?, ?)').join(', ')
      const vals = modulos_permitidos.flatMap(m => [idUsuario, m])
      await pool.execute(`INSERT IGNORE INTO permisos_usuario (id_usuario, modulo_id) VALUES ${placeholders}`, vals)
    }

    // Fase 2 de H-5: si cambió el rol o se desactivó la cuenta, cortar sus
    // sesiones activas del Worker — un rol viejo en un JWT ya emitido no se
    // vuelve a validar solo, hay que invalidar la sesión explícitamente.
    if (rol !== rolActual || activo === false || activo === 0) {
      await invalidarSesionesUsuario(idUsuario)
    }

    res.json({ ok: true, data: { affectedRows: upd.affectedRows, changedRows: upd.changedRows } })
  } catch (e) {
    console.error('[usuarios] actualizar:', e.message)
    res.status(500).json({ ok: false, error: 'Error al actualizar usuario' })
  }
})

// ─── DELETE /:idUsuario (eliminar) ───────────────────────────
router.delete('/:idUsuario', ADMIN, async (req, res) => {
  const idUsuario = Number(req.params.idUsuario)
  try {
    const rolObjetivo = await getRolUsuario(idUsuario)
    if (rolObjetivo === 'ceo' && req.user.rol !== 'ceo') {
      return res.status(403).json({ ok: false, error: 'La cuenta CEO solo puede ser eliminada por otro CEO' })
    }

    const rows = await q('SELECT avatar_r2_key FROM usuarios_sistema WHERE id_usuario = ?', [idUsuario])
    // Nota: el borrado del archivo en R2 se queda pendiente — el Worker no
    // tiene credenciales de escritura a R2 todavía (ver decisión de Fase 2
    // sobre usuarios:actualizarAvatar, fuera de esta fase por la misma razón).
    if (rows[0]?.avatar_r2_key) {
      console.warn(`[usuarios] Avatar de usuario ${idUsuario} en R2 (${rows[0].avatar_r2_key}) no se borra — sin credenciales de R2 en el Worker todavía`)
    }

    const [del] = await pool.execute('DELETE FROM usuarios_sistema WHERE id_usuario = ?', [idUsuario])
    await invalidarSesionesUsuario(idUsuario)

    res.json({ ok: true, data: { affectedRows: del.affectedRows } })
  } catch (e) {
    console.error('[usuarios] eliminar:', e.message)
    res.status(500).json({ ok: false, error: 'Error al eliminar usuario' })
  }
})

// ─── POST /:idUsuario/desbloquear ────────────────────────────
router.post('/:idUsuario/desbloquear', ADMIN, async (req, res) => {
  try {
    const [upd] = await pool.execute(
      'UPDATE usuarios_sistema SET bloqueado_hasta = NULL, intentos_fallidos = 0 WHERE id_usuario = ?',
      [req.params.idUsuario]
    )
    res.json({ ok: true, data: { affectedRows: upd.affectedRows } })
  } catch (e) {
    console.error('[usuarios] desbloquear:', e.message)
    res.status(500).json({ ok: false, error: 'Error al desbloquear usuario' })
  }
})

module.exports = router
