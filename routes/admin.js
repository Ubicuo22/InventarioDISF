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
const { resolverAvatares } = require('../utils/avatar')

// Todas las rutas de este router requieren ser admin
router.use(requireAuth, requireAdmin)

// ─── GET /api/admin/sesiones ──────────────────────────────
// Devuelve las 5 sesiones más recientes por usuario (no muestra las 49 acumuladas)
router.get('/sesiones', async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT
        s.id, s.jti, s.ip, s.user_agent,
        s.fecha_login, s.ultimo_uso,
        u.id_usuario, u.username, u.nombre_completo, u.rol, u.avatar_color, u.avatar_r2_key
      FROM bodega_sesiones s
      JOIN usuarios_sistema u ON s.id_usuario = u.id_usuario
      WHERE s.activo = 1
        AND s.id IN (
          SELECT id FROM (
            SELECT id,
              ROW_NUMBER() OVER (PARTITION BY id_usuario ORDER BY ultimo_uso DESC) AS rn
            FROM bodega_sesiones WHERE activo = 1
          ) ranked WHERE rn <= 5
        )
      ORDER BY s.ultimo_uso DESC
    `)

    // Total de sesiones activas por usuario (para mostrar badge "49 sesiones" en la UI)
    const [totals] = await pool.execute(`
      SELECT id_usuario, COUNT(*) AS total
      FROM bodega_sesiones WHERE activo = 1
      GROUP BY id_usuario
    `)
    const totalPorUsuario = {}
    for (const t of totals) totalPorUsuario[t.id_usuario] = parseInt(t.total)

    const sesiones = resolverAvatares(rows).map(s => ({
      ...s,
      total_sesiones: totalPorUsuario[s.id_usuario] || 1
    }))

    res.json({ ok: true, sesiones })
  } catch (e) {
    console.error('[admin] GET /sesiones:', e.message)
    res.status(500).json({ ok: false, error: 'Error al obtener sesiones' })
  }
})

// ─── POST /api/admin/sesiones/limpiar ─────────────────────
// Cierra todas las sesiones antiguas del usuario, dejando solo la más reciente
router.post('/sesiones/limpiar', async (req, res) => {
  try {
    const { id_usuario } = req.body
    if (!id_usuario) return res.status(400).json({ ok: false, error: 'Falta id_usuario' })

    const [result] = await pool.execute(`
      UPDATE bodega_sesiones
      SET activo = 0
      WHERE id_usuario = ?
        AND activo = 1
        AND jti != (
          SELECT jti FROM (
            SELECT jti FROM bodega_sesiones
            WHERE id_usuario = ? AND activo = 1
            ORDER BY ultimo_uso DESC LIMIT 1
          ) sub
        )
    `, [id_usuario, id_usuario])

    res.json({ ok: true, cerradas: result.affectedRows })
  } catch (e) {
    console.error('[admin] POST /sesiones/limpiar:', e.message)
    res.status(500).json({ ok: false, error: e.message })
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
      'UPDATE bodega_sesiones SET activo = 0 WHERE jti = ?',
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
      SELECT id_usuario, username, nombre_completo, rol, activo, ultimo_acceso, avatar_color, avatar_r2_key
      FROM usuarios_sistema
      ORDER BY FIELD(rol,'admin','supervisor','usuario'), nombre_completo
    `)
    // Resolver avatar_r2_key → avatar_url_publica antes de ensamblar la respuesta
    resolverAvatares(users)

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
    // Clamp y parseo defensivo — luego se inlinean en SQL porque mysql2.execute
    // (prepared statements) manda LIMIT/OFFSET como strings y TiDB falla con
    // "Incorrect arguments to LIMIT".
    const limit   = Math.max(1, Math.min(parseInt(req.query.limit)  || 50, 200))
    const offset  = Math.max(0, parseInt(req.query.offset) || 0)
    const usuario = req.query.usuario || null
    const modulo  = req.query.modulo  || null

    const { q } = require('../db/pool')
    const params = []
    const where  = []

    if (usuario) { where.push('usuario = ?'); params.push(usuario) }
    if (modulo)  { where.push('modulo = ?');  params.push(modulo)  }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const rows = await q(
      `SELECT id, usuario, nombre, modulo, accion, detalles, ip, fecha
       FROM logs_actividad
       ${whereClause}
       ORDER BY fecha DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    )

    res.json({ ok: true, data: rows })
  } catch (e) {
    console.error('[admin] GET /actividad:', e.message)
    res.status(500).json({ ok: false, error: 'Error al obtener actividad' })
  }
})

module.exports = router
