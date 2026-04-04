/**
 * ═══════════════════════════════════════════════════════════════
 * DISFRULEG — Portal Bodega
 * Punto de entrada del servidor Express
 *
 * Roles de acceso:
 *   admin      → acceso completo
 *   supervisor → módulos según permisos configurados por admin
 *   usuario    → bloqueado en login (no accede a la appweb)
 *
 * Rutas:
 *   POST /api/auth/login              — Login (público)
 *   POST /api/auth/logout             — Logout (protegido)
 *   GET  /api/status                  — Health check (público)
 *   GET  /api/productos               — Lista con stock (protegido)
 *   POST /api/entradas                — Registrar entrada (admin + supervisor/inventario)
 *   POST /api/mermas                  — Registrar merma (admin + supervisor/mermas)
 *   GET  /api/analytics/*             — Ventas (admin + supervisor/analytics)
 *   POST /api/ubicuoai/analizar       — IA pedidos (admin + supervisor/pedidos)
 *   GET  /api/admin/sesiones          — Sesiones activas (solo admin)
 *   DELETE /api/admin/sesiones/:jti   — Revocar sesión (solo admin)
 *   GET  /api/admin/usuarios          — Usuarios + permisos (solo admin)
 *   PUT  /api/admin/usuarios/:id/permisos — Editar permisos supervisor (solo admin)
 * ═══════════════════════════════════════════════════════════════
 */

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '.env') })

const { agendarResumenDiario } = require('./utils/resumen-diario')

const express = require('express')
const app  = express()
const PORT = process.env.PORT || process.env.BODEGA_PORT || 3030

const { requireAuth, requireModulo } = require('./middleware/auth')

// ─── Middleware global ────────────────────────────────────────
app.use(require('cors')())
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// ─── Rutas públicas / con auth propio ────────────────────────
app.use('/api/auth',           require('./routes/auth'))
app.use('/api/notificaciones', require('./routes/notificaciones'))

// ─── Rutas protegidas — acceso general (cualquier rol válido) ─
app.use('/api/productos',  requireAuth, require('./routes/productos'))
app.use('/api/clientes',   requireAuth, require('./routes/clientes'))
app.use('/api/ordenes',    requireAuth, requireModulo('pedidos'),    require('./routes/ordenes'))
app.use('/api/entradas',   requireAuth, requireModulo('inventario'), require('./routes/entradas'))
app.use('/api/mermas',     requireAuth, requireModulo('mermas'),     require('./routes/mermas'))
app.use('/api/ubicuoai',   requireAuth, requireModulo('pedidos'),    require('./routes/ubicuoai'))
app.use('/api/analytics',  requireAuth, requireModulo('analytics'),  require('./routes/analytics'))

// ─── Cobranza (requiere módulo 'cobranza') ───────────────────
app.use('/api/deudas', require('./routes/deudas'))
app.use('/api/pagos',  require('./routes/pagos'))

// ─── Dashboard TV (token público) ────────────────────────────
app.use('/api/dashboard', require('./routes/dashboard'))

// ─── Rutas de administración (solo admin) ────────────────────
app.use('/api/admin', require('./routes/admin'))

// Health check público
app.get('/api/status', async (req, res) => {
  try {
    const { q } = require('./db/pool')
    await q('SELECT 1')
    res.json({ ok: true, ts: new Date().toISOString() })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// Fallback SPA — debe ir al final
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

// ─── Iniciar ──────────────────────────────────────────────────
app.listen(PORT, async () => {
  try {
    const { q } = require('./db/pool')
    await q('SELECT 1')
    console.log(`✅ Disfruleg Bodega — http://localhost:${PORT}`)
    console.log(`   DB: ${process.env.TIDB_HOST}`)

    // Auto-crear tabla sesiones_activas si no existe
    await q(`
      CREATE TABLE IF NOT EXISTS sesiones_activas (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        jti         VARCHAR(36)  NOT NULL UNIQUE,
        id_usuario  INT          NOT NULL,
        ip          VARCHAR(45)  DEFAULT '',
        user_agent  VARCHAR(255) DEFAULT '',
        fecha_login DATETIME     DEFAULT NOW(),
        ultimo_uso  DATETIME     DEFAULT NOW(),
        activo      TINYINT      DEFAULT 1,
        INDEX idx_activo   (activo),
        INDEX idx_usuario  (id_usuario)
      )
    `)
    console.log('   ✓ Tabla sesiones_activas verificada')

    // Auto-crear tabla logs_actividad si no existe
    await q(`
      CREATE TABLE IF NOT EXISTS logs_actividad (
        id       INT AUTO_INCREMENT PRIMARY KEY,
        usuario  VARCHAR(50)  NOT NULL,
        nombre   VARCHAR(100) DEFAULT '',
        modulo   VARCHAR(50)  NOT NULL,
        accion   VARCHAR(100) NOT NULL,
        detalles TEXT         DEFAULT NULL,
        ip       VARCHAR(45)  DEFAULT '',
        fecha    DATETIME     DEFAULT NOW(),
        INDEX idx_fecha   (fecha),
        INDEX idx_usuario (usuario),
        INDEX idx_modulo  (modulo)
      )
    `)
    console.log('   ✓ Tabla logs_actividad verificada')

    // Programar resumen diario automático a las 20:00
    agendarResumenDiario()
  } catch (err) {
    console.error('❌ Error iniciando:', err.message)
  }
})
