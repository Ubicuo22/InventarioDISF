/**
 * middleware/auth-electron.js — JWT + sesiones para el Electron de Disfruleg
 *
 * Hermano de middleware/auth.js (el de la app web bodega), pero deliberadamente
 * separado — mismo criterio que ya usa este repo para no colisionar:
 *   - Tabla propia `electron_sesiones` (bodega_sesiones ya colisionó una vez
 *     con las sesiones de Electron cuando compartían tabla).
 *   - Secret propio JWT_SECRET_ELECTRON (no JWT_SECRET) + claim `aud` para
 *     que un token emitido para una app no sirva para la otra por error.
 *   - Vocabulario de roles de Electron (admin/supervisor/cajero/ceo), no el
 *     de bodega (admin/ceo/supervisor/usuario) — no coinciden 1:1.
 *
 * requireAuthElectron — verifica JWT + sesión activa en BD (caché 5 min)
 * requireRoleElectron(roles) — exige que el rol del token esté en `roles`
 * invalidarCacheElectron — elimina una entrada del caché (al revocar sesión)
 */

const jwt = require('jsonwebtoken')
const { q } = require('../db/pool')

const AUD = 'disfruleg-electron'

// ── Caché de sesiones activas (Map separado del de bodega) ────
const sessionCache = new Map()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutos

async function isSessionActive(jti) {
  const cached = sessionCache.get(jti)
  if (cached && Date.now() < cached.expiresAt) return cached.activo
  sessionCache.delete(jti)

  try {
    const rows = await q('SELECT activo FROM electron_sesiones WHERE jti = ?', [jti])

    // Misma política fail-open que middleware/auth.js: fila ausente (replication
    // lag del INSERT de login, o BD momentáneamente inconsistente) se trata como
    // activa por 30s — el JWT (con su propia expiración) es la fuente de verdad
    // en ese caso, para no rebotar al usuario en el primer login por una carrera.
    let activo
    if (rows.length === 0) {
      activo = true
      sessionCache.set(jti, { activo, expiresAt: Date.now() + 30_000 })
    } else {
      activo = rows[0].activo === 1
      sessionCache.set(jti, { activo, expiresAt: Date.now() + CACHE_TTL })
      if (activo) {
        q('UPDATE electron_sesiones SET ultimo_uso = NOW() WHERE jti = ?', [jti]).catch(() => {})
      }
    }
    return activo
  } catch {
    sessionCache.set(jti, { activo: true, expiresAt: Date.now() + 30_000 })
    return true
  }
}

function invalidarCacheElectron(jti) {
  if (jti) sessionCache.delete(jti)
}

async function requireAuthElectron(req, res, next) {
  if (req.user) return next()

  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, error: 'No autenticado' })
  }
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET_ELECTRON, { audience: AUD })
    req.user = payload

    if (payload.jti) {
      const activo = await isSessionActive(payload.jti)
      if (!activo) {
        return res.status(401).json({ ok: false, error: 'Sesión cerrada' })
      }
    }
    next()
  } catch {
    return res.status(401).json({ ok: false, error: 'Token inválido o expirado' })
  }
}

/** Exige que el rol del token esté en la lista dada (vocabulario de Electron: admin/supervisor/cajero/ceo). */
function requireRoleElectron(roles) {
  return (req, res, next) => {
    const rol = req.user?.rol
    if (!roles.includes(rol)) {
      return res.status(403).json({ ok: false, error: 'No tienes permisos para realizar esta acción.' })
    }
    next()
  }
}

module.exports = { requireAuthElectron, requireRoleElectron, invalidarCacheElectron, AUD }
