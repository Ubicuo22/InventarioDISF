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
const { registrar } = require('../utils/actividad')
const { resolverAvatar } = require('../utils/avatar')

// ─── Rate limiter en memoria (sin dependencias externas) ──────
// Máx 10 intentos por IP en ventana de 1 minuto
const loginAttempts = new Map()
const RATE_WINDOW_MS = 60_000  // 1 minuto
const RATE_MAX       = 10      // intentos permitidos por ventana

function rateLimitLogin(req, res, next) {
  const ip  = (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown')
  const now = Date.now()
  const entry = loginAttempts.get(ip) || { count: 0, resetAt: now + RATE_WINDOW_MS }

  // Resetear ventana si ya expiró
  if (now > entry.resetAt) {
    entry.count   = 0
    entry.resetAt = now + RATE_WINDOW_MS
  }

  entry.count++
  loginAttempts.set(ip, entry)

  if (entry.count > RATE_MAX) {
    const segsRestantes = Math.ceil((entry.resetAt - now) / 1000)
    return res.status(429).json({
      ok:    false,
      error: `Demasiados intentos. Espera ${segsRestantes}s antes de intentar de nuevo.`
    })
  }

  next()
}

// Limpiar IPs antiguas cada 5 minutos para no acumular memoria.
// En Workers no hay timers a nivel de módulo (y la memoria es efímera por
// aislamiento), así que solo aplica en Node.
if (globalThis.navigator?.userAgent !== 'Cloudflare-Workers') {
  setInterval(() => {
    const now = Date.now()
    for (const [ip, entry] of loginAttempts) {
      if (now > entry.resetAt) loginAttempts.delete(ip)
    }
  }, 5 * 60_000)
}

// ─── POST /api/auth/login ─────────────────────────────────
router.post('/login', rateLimitLogin, async (req, res) => {
  try {
    const { username, password } = req.body
    if (!username || !password) {
      return res.status(400).json({ ok: false, error: 'Usuario y contraseña requeridos' })
    }

    const [users] = await pool.execute(
      `SELECT id_usuario, username, password_hash, nombre_completo,
              rol, activo, bloqueado_hasta, avatar_color, avatar_r2_key
       FROM usuarios_sistema
       WHERE username = ? AND activo = 1`,
      [username.toUpperCase()]
    )

    if (users.length === 0) {
      return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' })
    }

    // Resolver avatar_r2_key → avatar_url_publica (URL pública del bucket R2)
    const user = resolverAvatar(users[0])

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

    // Correr en paralelo: resetear intentos + obtener permisos de supervisor
    const [, permsResult] = await Promise.all([
      pool.execute(
        `UPDATE usuarios_sistema SET intentos_fallidos = 0, ultimo_acceso = NOW() WHERE id_usuario = ?`,
        [user.id_usuario]
      ),
      user.rol === 'supervisor'
        ? pool.execute('SELECT modulo_id FROM permisos_usuario WHERE id_usuario = ?', [user.id_usuario])
        : Promise.resolve([null])
    ])

    const modulosPermitidos = user.rol === 'supervisor'
      ? (permsResult[0] || []).map(r => r.modulo_id)
      : null

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

    // Guardar sesión antes de responder — garantiza que el jti existe en BD
    // cuando el cliente lo use en la siguiente petición
    const ip = (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '').slice(0, 45)
    const ua = (req.headers['user-agent'] || '').slice(0, 255)
    try {
      // Limpiar sesiones viejas y registrar la nueva en paralelo
      await Promise.all([
        pool.execute(
          `UPDATE bodega_sesiones
           SET activo = 0
           WHERE id_usuario = ?
             AND activo = 1
             AND (
               fecha_login < DATE_SUB(NOW(), INTERVAL 30 DAY)
               OR id NOT IN (
                 SELECT id FROM (
                   SELECT id FROM bodega_sesiones
                   WHERE id_usuario = ? AND activo = 1
                   ORDER BY ultimo_uso DESC LIMIT 4
                 ) sub
               )
             )`,
          [user.id_usuario, user.id_usuario]
        ),
        pool.execute(
          `INSERT INTO bodega_sesiones (jti, id_usuario, ip, user_agent) VALUES (?, ?, ?, ?)`,
          [jti, user.id_usuario, ip, ua]
        )
      ])
    } catch (e) {
      console.warn('[auth] No se pudo guardar sesión:', e.message)
      // No abortamos el login — el JWT sigue siendo válido y el middleware
      // acepta jti sin fila por replication lag (fail-open intencional)
    }

    // Registrar en historial de actividad
    req.user = { username: user.username, nombre: user.nombre_completo }
    registrar(req, 'auth', 'login', { rol: user.rol })

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

// ─── GET /api/auth/me ─────────────────────────────────────
// Devuelve los datos frescos del usuario autenticado (lee de BD,
// no del JWT). Útil cuando el avatar/color cambia en Disfruleg
// Electron y queremos resincronizar el cliente sin pedirle logout.
router.get('/me', requireAuth, async (req, res) => {
  try {
    const id = req.user?.id
    if (!id) return res.status(401).json({ ok: false, error: 'No autenticado' })

    const [users] = await pool.execute(
      `SELECT id_usuario, username, nombre_completo, rol, activo,
              avatar_color, avatar_r2_key
       FROM usuarios_sistema
       WHERE id_usuario = ? AND activo = 1`,
      [id]
    )
    if (!users.length) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' })

    const user = resolverAvatar(users[0])

    // Módulos permitidos (solo aplica para supervisores)
    let modulosPermitidos = null
    if (user.rol === 'supervisor') {
      const [perms] = await pool.execute(
        'SELECT modulo_id FROM permisos_usuario WHERE id_usuario = ?',
        [user.id_usuario]
      )
      modulosPermitidos = perms.map(r => r.modulo_id)
    }

    res.json({
      ok: true,
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
  } catch (e) {
    console.error('[auth] GET /me:', e.message)
    res.status(500).json({ ok: false, error: 'Error de servidor' })
  }
})

// ─── POST /api/auth/logout ────────────────────────────────
router.post('/logout', requireAuth, async (req, res) => {
  try {
    if (req.user?.jti) {
      await pool.execute(
        'UPDATE bodega_sesiones SET activo = 0 WHERE jti = ?',
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
