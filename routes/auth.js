/**
 * routes/auth.js — Autenticación con usuarios_sistema
 *
 * POST /api/auth/login   — login (público)
 * POST /api/auth/logout  — cerrar sesión (requiere JWT)
 *
 * Roles:
 *   admin      → acceso completo a la appweb
 *   supervisor → acceso a módulos que el admin haya habilitado
 *   usuario    → SIN acceso a la appweb (bloqueado aquí mismo)
 */

const router  = require('express').Router()
const bcrypt  = require('bcryptjs')
const jwt     = require('jsonwebtoken')
const crypto  = require('crypto')
const { pool } = require('../db/pool')
const { requireAuth, invalidarCache } = require('../middleware/auth')

// ─── POST /api/auth/login ─────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body
    if (!username || !password) {
      return res.status(400).json({ ok: false, error: 'Usuario y contraseña requeridos' })
    }

    const [users] = await pool.execute(
      `SELECT id_usuario, username, password_hash, nombre_completo,
              rol, activo, bloqueado_hasta, avatar_color, avatar_url_publica
       FROM usuarios_sistema
       WHERE username = ? AND activo = 1`,
      [username.toUpperCase()]
    )

    if (users.length === 0) {
      return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' })
    }

    const user = users[0]

    // ── Rol "usuario" — sin acceso a la appweb ─────────────
    if (user.rol === 'usuario') {
      return res.status(403).json({
        ok:     false,
        error:  'Eres chalan, revisa tus permisos.',
        chalan: true
      })
    }

    // Verificar bloqueo temporal
    if (user.bloqueado_hasta && new Date(user.bloqueado_hasta) > new Date()) {
      const hasta = new Date(user.bloqueado_hasta).toLocaleTimeString('es-MX')
      return res.status(401).json({ ok: false, error: `Cuenta bloqueada hasta las ${hasta}` })
    }

    // Verificar contraseña
    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) {
      await pool.execute(
        `UPDATE usuarios_sistema SET intentos_fallidos = intentos_fallidos + 1 WHERE id_usuario = ?`,
        [user.id_usuario]
      )
      return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' })
    }

    // Resetear intentos + registrar acceso
    await pool.execute(
      `UPDATE usuarios_sistema SET intentos_fallidos = 0, ultimo_acceso = NOW() WHERE id_usuario = ?`,
      [user.id_usuario]
    )

    // Módulos permitidos para supervisores (reutiliza tabla permisos_usuario del Electron)
    let modulosPermitidos = null
    if (user.rol === 'supervisor') {
      const [perms] = await pool.execute(
        'SELECT modulo_id FROM permisos_usuario WHERE id_usuario = ?',
        [user.id_usuario]
      )
      modulosPermitidos = perms.map(r => r.modulo_id)
    }

    // JTI único para rastrear esta sesión
    const jti = crypto.randomUUID()

    const token = jwt.sign(
      {
        jti,
        id:       user.id_usuario,
        username: user.username,
        nombre:   user.nombre_completo,
        rol:      user.rol,
        color:    user.avatar_color,
        avatar:   user.avatar_url_publica,
        ...(modulosPermitidos !== null ? { modulosPermitidos } : {})
      },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    )

    // Guardar sesión en BD (no crítico — si falla, igual devolvemos el token)
    const ip = (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '').slice(0, 45)
    const ua = (req.headers['user-agent'] || '').slice(0, 255)
    try {
      await pool.execute(
        `INSERT INTO sesiones_activas (jti, id_usuario, ip, user_agent) VALUES (?, ?, ?, ?)`,
        [jti, user.id_usuario, ip, ua]
      )
    } catch (e) {
      console.warn('[auth] No se pudo guardar sesión (tabla sesiones_activas?):', e.message)
    }

    res.json({
      ok: true,
      token,
      user: {
        id:               user.id_usuario,
        username:         user.username,
        nombre:           user.nombre_completo,
        rol:              user.rol,
        color:            user.avatar_color,
        avatar:           user.avatar_url_publica,
        modulosPermitidos
      }
    })
  } catch (err) {
    console.error('[auth] login:', err.message)
    res.status(500).json({ ok: false, error: 'Error de servidor' })
  }
})

// ─── POST /api/auth/logout ────────────────────────────────
router.post('/logout', requireAuth, async (req, res) => {
  try {
    if (req.user?.jti) {
      await pool.execute(
        'UPDATE sesiones_activas SET activo = 0 WHERE jti = ?',
        [req.user.jti]
      )
      invalidarCache(req.user.jti)
    }
  } catch (e) {
    console.warn('[auth] logout BD:', e.message)
  }
  res.json({ ok: true })
})

module.exports = router
