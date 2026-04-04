/**
 * routes/admin.js — Gestión de sesiones y permisos (solo admin)
 *
 * GET    /api/admin/sesiones               — listar sesiones activas
 * DELETE /api/admin/sesiones/:jti          — forzar cierre de sesión
 * GET    /api/admin/usuarios               — listar usuarios + permisos
 * PUT    /api/admin/usuarios/:id/permisos  — actualizar permisos de supervisor
 */

const router = require('express').Router()
const { pool } = require('../db/pool')
const { requireAuth, requireAdmin, invalidarCache } = require('../middleware/auth')

// Todas las rutas de este router requieren ser admin
router.use(requireAuth, requireAdmin)

// ─── GET /api/admin/sesiones ──────────────────────────────
router.get('/sesiones', async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT
        s.id, s.jti, s.ip, s.user_agent,
        s.fecha_login, s.ultimo_uso,
        u.id_usuario, u.username, u.nombre_completo, u.rol, u.avatar_color, u.avatar_url_publica
      FROM sesiones_activas s
      JOIN usuarios_sistema u ON s.id_usuario = u.id_usuario
      WHERE s.activo = 1
      ORDER BY s.ultimo_uso DESC
    `)
    res.json({ ok: true, sesiones: rows })
  } catch (e) {
    console.error('[admin] GET /sesiones:', e.message)
    res.status(500).json({ ok: false, error: 'Error al obtener sesiones' })
  }
})

// ─── DELETE /api/admin/sesiones/:jti ─────────────────────
router.delete('/sesiones/:jti', async (req, res) => {
  try {
    const { jti } = req.params
    if (jti === req.user.jti) {
      return res.status(400).json({ ok: false, error: 'No puedes cerrar tu propia sesión desde aquí' })
    }
    await pool.execute(
      'UPDATE sesiones_activas SET activo = 0 WHERE jti = ?',
      [jti]
    )
    invalidarCache(jti)
    res.json({ ok: true })
  } catch (e) {
    console.error('[admin] DELETE /sesiones:', e.message)
    res.status(500).json({ ok: false, error: 'Error al cerrar sesión' })
  }
})

// ─── GET /api/admin/usuarios ──────────────────────────────
router.get('/usuarios', async (req, res) => {
  try {
    const [users] = await pool.execute(`
      SELECT id_usuario, username, nombre_completo, rol, activo, ultimo_acceso, avatar_color, avatar_url_publica
      FROM usuarios_sistema
      ORDER BY FIELD(rol,'admin','supervisor','usuario'), nombre_completo
    `)

    // Permisos de supervisores
    const supervisorIds = users.filter(u => u.rol === 'supervisor').map(u => u.id_usuario)
    const permisosPorUsuario = {}
    if (supervisorIds.length > 0) {
      const placeholders = supervisorIds.map(() => '?').join(',')
      const [perms] = await pool.execute(
        `SELECT id_usuario, modulo_id FROM permisos_usuario WHERE id_usuario IN (${placeholders})`,
        supervisorIds
      )
      for (const p of perms) {
        if (!permisosPorUsuario[p.id_usuario]) permisosPorUsuario[p.id_usuario] = []
        permisosPorUsuario[p.id_usuario].push(p.modulo_id)
      }
    }

    res.json({
      ok: true,
      usuarios: users.map(u => ({
        ...u,
        modulosPermitidos: u.rol === 'supervisor' ? (permisosPorUsuario[u.id_usuario] || []) : null
      }))
    })
  } catch (e) {
    console.error('[admin] GET /usuarios:', e.message)
    res.status(500).json({ ok: false, error: 'Error al obtener usuarios' })
  }
})

// ─── PUT /api/admin/usuarios/:id/permisos ─────────────────
router.put('/usuarios/:id/permisos', async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const { modulos } = req.body
    if (!Array.isArray(modulos)) {
      return res.status(400).json({ ok: false, error: 'modulos debe ser un array' })
    }

    const [users] = await pool.execute(
      'SELECT id_usuario, rol FROM usuarios_sistema WHERE id_usuario = ?',
      [id]
    )
    if (!users.length) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' })
    if (users[0].rol !== 'supervisor') {
      return res.status(400).json({ ok: false, error: 'Solo se asignan permisos a supervisores' })
    }

    // Reemplazar permisos
    await pool.execute('DELETE FROM permisos_usuario WHERE id_usuario = ?', [id])
    for (const modulo of modulos) {
      await pool.execute(
        'INSERT IGNORE INTO permisos_usuario (id_usuario, modulo_id) VALUES (?, ?)',
        [id, String(modulo).slice(0, 50)]
      )
    }

    res.json({ ok: true })
  } catch (e) {
    console.error('[admin] PUT /permisos:', e.message)
    res.status(500).json({ ok: false, error: 'Error al actualizar permisos' })
  }
})

// ─── GET /api/admin/actividad ─────────────────────────────
router.get('/actividad', async (req, res) => {
  try {
    const limit   = Math.min(parseInt(req.query.limit)  || 50, 200)
    const offset  = parseInt(req.query.offset) || 0
    const usuario = req.query.usuario || null
    const modulo  = req.query.modulo  || null

    const { q } = require('../db/pool')
    const params = []
    const where  = []

    if (usuario) { where.push('usuario = ?'); params.push(usuario) }
    if (modulo)  { where.push('modulo = ?');  params.push(modulo)  }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    params.push(limit, offset)

    const rows = await q(
      `SELECT id, usuario, nombre, modulo, accion, detalles, ip, fecha
       FROM logs_actividad
       ${whereClause}
       ORDER BY fecha DESC
       LIMIT ? OFFSET ?`,
      params
    )

    res.json({ ok: true, data: rows })
  } catch (e) {
    console.error('[admin] GET /actividad:', e.message)
    res.status(500).json({ ok: false, error: 'Error al obtener actividad' })
  }
})

module.exports = router
