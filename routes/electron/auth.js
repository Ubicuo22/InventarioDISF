/**
 * routes/electron/auth.js — Login/logout para Disfruleg Electron
 *
 * Replica la lógica de src/main/handlers/auth.handler.ts (bcrypt, lockout de
 * 5 intentos/15 min, gate de dispositivo autorizado) del lado del Worker, para
 * que ese control deje de depender de que el cliente Electron lo respete
 * voluntariamente. Fase 0: existe en paralelo al login local de Electron
 * (que sigue siendo el que de verdad autentica hoy) — Electron llama aquí
 * ADEMÁS, solo para obtener un token con el que probar el canal migrado de
 * esta fase. La sustitución completa del login local es trabajo de la Fase 2.
 *
 * POST /api/electron/auth/login   — { username, password, deviceId, deviceName }
 * POST /api/electron/auth/logout  — requiere Bearer token
 * GET  /api/electron/auth/whoami  — requiere Bearer token
 */

const router = require('express').Router()
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const { pool } = require('../../db/pool')
const { requireAuthElectron, invalidarCacheElectron, AUD } = require('../../middleware/auth-electron')

// Fase 2 de H-5: paridad de auditoría con el login local de Electron — esta
// ruta ya replicaba el bcrypt/lockout/gate de dispositivo, pero nunca
// escribía intentos_fallidos/login_history. Cada INSERT va en su propio
// try/catch (igual que el de electron_sesiones más abajo) para que un
// fallo de auditoría nunca tumbe el login.
async function registrarIntentoFallido(deviceId, razon, usuarioIntentado, ip) {
  try {
    await pool.execute(
      `INSERT INTO intentos_fallidos (device_id, ip_address, razon, usuario_intentado) VALUES (?, ?, ?, ?)`,
      [deviceId || null, ip || null, razon, usuarioIntentado || null]
    )
  } catch (e) {
    console.warn('[electron-auth] No se pudo registrar intento fallido:', e.message)
  }
}

async function registrarLoginHistory(idUsuario, idDispositivo, exito, razonFallo, ip) {
  try {
    await pool.execute(
      `INSERT INTO login_history (id_usuario, id_dispositivo, ip_address, device_info, exito, razon_fallo) VALUES (?, ?, ?, ?, ?, ?)`,
      [idUsuario, idDispositivo ?? null, ip || null, null, exito ? 1 : 0, razonFallo]
    )
  } catch (e) {
    console.warn('[electron-auth] No se pudo registrar login history:', e.message)
  }
}

// ─── POST /api/electron/auth/login ─────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { username, password, deviceId, deviceName } = req.body
    if (!username || !password) {
      return res.status(400).json({ ok: false, error: 'Usuario y contraseña son requeridos' })
    }
    const cleanUsername = String(username).trim()
    const cleanPassword = String(password).trim()
    const ip = (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '').slice(0, 45)

    const [rows] = await pool.execute(
      `SELECT id_usuario, username, password_hash, nombre_completo, rol, activo,
              intentos_fallidos, bloqueado_hasta,
              (bloqueado_hasta IS NOT NULL AND bloqueado_hasta > NOW()) AS esta_bloqueado
       FROM usuarios_sistema WHERE UPPER(username) = UPPER(?)`,
      [cleanUsername]
    )

    if (rows.length === 0) {
      await registrarIntentoFallido(deviceId, 'Usuario no encontrado', cleanUsername, ip)
      return res.status(401).json({ ok: false, error: 'Usuario no encontrado' })
    }
    const user = rows[0]

    // Cuenta bloqueada por intentos fallidos — comparación en SQL (NOW()),
    // nunca `new Date(...)` en JS. El mismo bug de timezone (string UTC de
    // TiDB interpretado como hora local) se corrigió hoy del lado Electron
    // y la regla aplica igual aquí.
    if (Number(user.esta_bloqueado)) {
      await registrarIntentoFallido(deviceId, 'Cuenta bloqueada temporalmente', cleanUsername, ip)
      return res.status(401).json({
        ok: false,
        error: 'Cuenta bloqueada por demasiados intentos fallidos. Intenta de nuevo en unos minutos o contacta a un administrador.',
        reason: 'ACCOUNT_LOCKED'
      })
    }

    const accessGranted = await bcrypt.compare(cleanPassword, user.password_hash)
    if (!accessGranted) {
      await registrarIntentoFallido(deviceId, 'Contraseña incorrecta', cleanUsername, ip)
      await registrarLoginHistory(user.id_usuario, null, false, 'Contraseña incorrecta', ip)
      const nuevosIntentos = (user.intentos_fallidos || 0) + 1
      if (nuevosIntentos >= 5) {
        await pool.execute(
          `UPDATE usuarios_sistema SET intentos_fallidos = ?, bloqueado_hasta = DATE_ADD(NOW(), INTERVAL 15 MINUTE) WHERE id_usuario = ?`,
          [nuevosIntentos, user.id_usuario]
        )
        return res.status(401).json({
          ok: false,
          error: 'Demasiados intentos fallidos. Cuenta bloqueada por 15 minutos.',
          reason: 'ACCOUNT_LOCKED'
        })
      }
      await pool.execute('UPDATE usuarios_sistema SET intentos_fallidos = ? WHERE id_usuario = ?', [nuevosIntentos, user.id_usuario])
      return res.status(401).json({ ok: false, error: 'Contraseña incorrecta' })
    }

    if (!user.activo) {
      await registrarIntentoFallido(deviceId, 'Usuario desactivado', cleanUsername, ip)
      await registrarLoginHistory(user.id_usuario, null, false, 'Usuario desactivado', ip)
      return res.status(401).json({ ok: false, error: 'Usuario desactivado' })
    }

    // Reset del contador de intentos en login exitoso
    if (user.intentos_fallidos) {
      await pool.execute('UPDATE usuarios_sistema SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id_usuario = ?', [user.id_usuario])
    }

    // ── Gate de dispositivo autorizado (mismo criterio que registrarDispositivo en auth.handler.ts) ──
    if (!deviceId) {
      return res.status(400).json({ ok: false, error: 'Falta el identificador de dispositivo' })
    }

    const [dispRows] = await pool.execute(
      'SELECT id_dispositivo, estado, autorizado FROM dispositivos_autorizados WHERE device_id = ? AND fecha_eliminacion IS NULL',
      [deviceId]
    )

    if (dispRows.length === 0) {
      // Dispositivo nuevo — se registra PENDING, no se autoriza aquí
      await pool.execute(
        `INSERT INTO dispositivos_autorizados (device_id, device_name, device_info, id_usuario, autorizado, estado, activo)
         VALUES (?, ?, ?, ?, 0, 'PENDING', 0)`,
        [deviceId, deviceName || 'Dispositivo desconocido', JSON.stringify({ origen: 'electron-worker-login' }), user.id_usuario]
      )
      await registrarIntentoFallido(deviceId, 'Dispositivo no autorizado', cleanUsername, ip)
      return res.status(401).json({
        ok: false,
        error: 'Dispositivo nuevo detectado. Un administrador debe autorizarlo antes de continuar.',
        reason: 'DEVICE_PENDING'
      })
    }

    const dispositivo = dispRows[0]
    await pool.execute('UPDATE dispositivos_autorizados SET ultimo_acceso = NOW() WHERE device_id = ?', [deviceId])

    if (dispositivo.estado === 'BLOQUEADO') {
      await registrarIntentoFallido(deviceId, 'Dispositivo bloqueado', cleanUsername, ip)
      await registrarLoginHistory(user.id_usuario, dispositivo.id_dispositivo, false, 'Dispositivo bloqueado', ip)
      return res.status(401).json({ ok: false, error: 'Este dispositivo ha sido bloqueado. Contacte al administrador.', reason: 'DEVICE_BLOCKED' })
    }
    if (dispositivo.estado !== 'AUTORIZADO' || !dispositivo.autorizado) {
      await registrarIntentoFallido(deviceId, 'Dispositivo no autorizado', cleanUsername, ip)
      await registrarLoginHistory(user.id_usuario, dispositivo.id_dispositivo, false, 'Dispositivo no autorizado', ip)
      return res.status(401).json({ ok: false, error: 'Dispositivo no autorizado. Contacte al administrador.', reason: 'DEVICE_NOT_AUTHORIZED' })
    }

    await pool.execute('UPDATE usuarios_sistema SET ultimo_acceso = NOW() WHERE id_usuario = ?', [user.id_usuario])

    const jti = crypto.randomUUID()
    const token = jwt.sign(
      { jti, id: user.id_usuario, username: user.username, nombre: user.nombre_completo, rol: user.rol },
      process.env.JWT_SECRET_ELECTRON,
      { expiresIn: '24h', audience: AUD, issuer: 'disfruleg-bodega' }
    )

    const ua = (req.headers['user-agent'] || '').slice(0, 255)
    await registrarLoginHistory(user.id_usuario, dispositivo.id_dispositivo, true, null, ip)
    try {
      // Igual que bodega_sesiones: cerrar sesiones viejas/en exceso y registrar la nueva en paralelo
      await Promise.all([
        pool.execute(
          `UPDATE electron_sesiones
           SET activo = 0
           WHERE id_usuario = ?
             AND activo = 1
             AND (
               fecha_login < DATE_SUB(NOW(), INTERVAL 2 DAY)
               OR id NOT IN (
                 SELECT id FROM (
                   SELECT id FROM electron_sesiones
                   WHERE id_usuario = ? AND activo = 1
                   ORDER BY ultimo_uso DESC LIMIT 4
                 ) sub
               )
             )`,
          [user.id_usuario, user.id_usuario]
        ),
        pool.execute(
          `INSERT INTO electron_sesiones (jti, id_usuario, device_id, ip, user_agent) VALUES (?, ?, ?, ?, ?)`,
          [jti, user.id_usuario, deviceId, ip, ua]
        )
      ])
    } catch (e) {
      console.warn('[electron-auth] No se pudo guardar sesión:', e.message)
      // No abortamos el login — mismo criterio fail-open que bodega
    }

    res.json({
      ok: true,
      token,
      user: {
        id_usuario: user.id_usuario,
        username: user.username,
        nombre_completo: user.nombre_completo,
        rol: user.rol
      }
    })
  } catch (err) {
    console.error('[electron-auth] login:', err.message)
    res.status(500).json({ ok: false, error: 'Error interno del sistema' })
  }
})

// ─── POST /api/electron/auth/logout ────────────────────────
router.post('/logout', requireAuthElectron, async (req, res) => {
  try {
    if (req.user?.jti) {
      await pool.execute('UPDATE electron_sesiones SET activo = 0 WHERE jti = ?', [req.user.jti])
      invalidarCacheElectron(req.user.jti)
    }
  } catch (e) {
    console.warn('[electron-auth] logout BD:', e.message)
  }
  res.json({ ok: true })
})

// ─── GET /api/electron/auth/whoami ─────────────────────────
router.get('/whoami', requireAuthElectron, (req, res) => {
  res.json({ ok: true, user: req.user })
})

module.exports = router
