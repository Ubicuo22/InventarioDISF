/**
 * middleware/auth.js — JWT + control de sesiones y permisos
 *
 * requireAuth     — verifica JWT + sesión activa en BD (caché 5 min)
 * requireAdmin    — solo admins pasan
 * requireModulo   — verifica permiso de módulo (admin: todo, supervisor: según tabla)
 * invalidarCache  — elimina una entrada del caché (al revocar sesión)
 */

const jwt = require('jsonwebtoken')
const { q } = require('../db/pool')

// ── Caché de sesiones activas ─────────────────────────────
// jti → { activo: bool, expiresAt: timestamp }
const sessionCache = new Map()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutos

async function isSessionActive(jti) {
  const cached = sessionCache.get(jti)
  if (cached && Date.now() < cached.expiresAt) return cached.activo
  sessionCache.delete(jti)

  try {
    const rows = await q('SELECT activo FROM sesiones_activas WHERE jti = ?', [jti])
    const activo = rows.length > 0 && rows[0].activo === 1
    sessionCache.set(jti, { activo, expiresAt: Date.now() + CACHE_TTL })
    if (activo) {
      q('UPDATE sesiones_activas SET ultimo_uso = NOW() WHERE jti = ?', [jti]).catch(() => {})
    }
    return activo
  } catch {
    return true // fail open — si la BD no está disponible, no bloqueamos
  }
}

/** Elimina del caché (llamar al revocar o cerrar sesión) */
function invalidarCache(jti) {
  if (jti) sessionCache.delete(jti)
}

// ── requireAuth ───────────────────────────────────────────
async function requireAuth(req, res, next) {
  // Si ya fue autenticado por un middleware anterior, no repetir
  if (req.user) return next()

  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, error: 'No autenticado' })
  }
  try {
    req.user = jwt.verify(header.slice(7), process.env.JWT_SECRET)

    // Verificar que la sesión sigue activa (si tiene jti)
    if (req.user.jti) {
      const activo = await isSessionActive(req.user.jti)
      if (!activo) {
        return res.status(401).json({ ok: false, error: 'Sesión cerrada' })
      }
    }
    next()
  } catch {
    return res.status(401).json({ ok: false, error: 'Token inválido o expirado' })
  }
}

// ── requireAdmin ──────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.user?.rol !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Acceso restringido a administradores' })
  }
  next()
}

// ── requireModulo ─────────────────────────────────────────
// Admin: siempre pasa. Supervisor: debe tener el módulo en su lista.
function requireModulo(modulo) {
  return (req, res, next) => {
    const { rol, modulosPermitidos } = req.user || {}
    if (rol === 'admin') return next()
    if (rol === 'supervisor' && Array.isArray(modulosPermitidos) && modulosPermitidos.includes(modulo)) {
      return next()
    }
    return res.status(403).json({ ok: false, error: 'Sin permiso para este módulo' })
  }
}

module.exports = { requireAuth, requireAdmin, requireModulo, invalidarCache }
