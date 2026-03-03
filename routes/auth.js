/**
 * routes/auth.js — Login con usuarios_sistema (bcrypt + JWT)
 * POST /api/auth/login
 */

const router = require('express').Router()
const bcrypt = require('bcryptjs')
const jwt    = require('jsonwebtoken')
const { pool } = require('../db/pool')

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

    // Verificar bloqueo temporal
    if (user.bloqueado_hasta && new Date(user.bloqueado_hasta) > new Date()) {
      const hasta = new Date(user.bloqueado_hasta).toLocaleTimeString('es-MX')
      return res.status(401).json({ ok: false, error: `Cuenta bloqueada hasta las ${hasta}` })
    }

    // Verificar contraseña con bcrypt
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

    const token = jwt.sign(
      {
        id:       user.id_usuario,
        username: user.username,
        nombre:   user.nombre_completo,
        rol:      user.rol,
        color:    user.avatar_color,
        avatar:   user.avatar_url_publica
      },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    )

    res.json({
      ok: true,
      token,
      user: {
        id:       user.id_usuario,
        username: user.username,
        nombre:   user.nombre_completo,
        rol:      user.rol,
        color:    user.avatar_color,
        avatar:   user.avatar_url_publica
      }
    })
  } catch (err) {
    console.error('[auth] login:', err.message)
    res.status(500).json({ ok: false, error: 'Error de servidor' })
  }
})

module.exports = router
