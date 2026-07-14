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
 *   GET  /api/admin/sesiones          — Sesiones activas (solo admin)
 *   DELETE /api/admin/sesiones/:jti   — Revocar sesión (solo admin)
 *   GET  /api/admin/usuarios          — Usuarios + permisos (solo admin)
 *   PUT  /api/admin/usuarios/:id/permisos — Editar permisos supervisor (solo admin)
 * ═══════════════════════════════════════════════════════════════
 */

const path = require('path')
// TZ debe fijarse ANTES de dotenv y de cualquier new Date() para que Node
// interprete todas las fechas locales en zona de Morelia / CDMX
process.env.TZ = 'America/Mexico_City'
require('dotenv').config({ path: path.join(__dirname, '.env') })

// ─── Prevenir caídas por errores no capturados ────────────────
process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toISOString()}] ❌ uncaughtException:`, err.message, err.stack)
  // No terminar el proceso — registrar y continuar
})

process.on('unhandledRejection', (reason) => {
  console.error(`[${new Date().toISOString()}] ❌ unhandledRejection:`, reason)
  // No terminar el proceso — registrar y continuar
})

const { agendarResumenDiario } = require('./utils/resumen-diario')

// La app Express (middleware + rutas) vive en app.js — compartida con worker.js
const app  = require('./app')
const PORT = process.env.PORT || process.env.BODEGA_PORT || 3030

// ─── Iniciar ──────────────────────────────────────────────────
app.listen(PORT, async () => {
  try {
    const { q } = require('./db/pool')

    // Retry de conexión inicial — si TiDB no responde al arrancar (DNS lento,
    // cold-start de Serverless, red momentánea), reintenta hasta 5 veces con
    // backoff para no morir al primer intento.
    let dbOk = false
    for (let i = 1; i <= 5; i++) {
      try {
        await q('SELECT 1')
        dbOk = true
        break
      } catch (e) {
        console.warn(`[startup] Intento ${i}/5 DB falló: ${e.message}`)
        if (i < 5) await new Promise(r => setTimeout(r, i * 2000))
      }
    }
    if (!dbOk) throw new Error('No se pudo conectar a la BD después de 5 intentos')

    console.log(`✅ Disfruleg Bodega — http://localhost:${PORT}`)
    console.log(`   DB: ${process.env.TIDB_HOST}`)

    // Tabla propia de Bodega para sesiones JWT.
    //
    // Nombre con prefijo `bodega_` para no colisionar con `sesiones_activas`,
    // que pertenece a Disfruleg Electron y tiene un schema completamente
    // distinto (id_sesion, id_dispositivo, activa, etc.) — ambas apps comparten
    // la misma BD de TiDB y antes estaban pisándose la tabla.
    await q(`
      CREATE TABLE IF NOT EXISTS bodega_sesiones (
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
    console.log('   ✓ Tabla bodega_sesiones verificada')

    // Auto-crear tabla verificaciones_inventario (audit trail del corte físico)
    await q(`
      CREATE TABLE IF NOT EXISTS verificaciones_inventario (
        id                INT AUTO_INCREMENT PRIMARY KEY,
        id_producto       INT          NOT NULL,
        cantidad_sistema  DECIMAL(12,4) NOT NULL,
        cantidad_fisica   DECIMAL(12,4) NOT NULL,
        delta             DECIMAL(12,4) NOT NULL,
        usuario           VARCHAR(50)  NOT NULL,
        fecha             DATETIME     DEFAULT NOW(),
        id_compra_ajuste  INT          DEFAULT NULL,
        notas             VARCHAR(255) DEFAULT NULL,
        INDEX idx_producto (id_producto),
        INDEX idx_fecha    (fecha)
      )
    `)
    console.log('   ✓ Tabla verificaciones_inventario verificada')

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

    // Migración: fecha_envio en ordenes_guardadas (grupo Defensa)
    await q(`ALTER TABLE ordenes_guardadas ADD COLUMN IF NOT EXISTS fecha_envio DATE NULL DEFAULT NULL`)
    console.log('   ✓ Columna fecha_envio verificada en ordenes_guardadas')

    // Migración: bloqueo de edición concurrente
    await q(`ALTER TABLE ordenes_guardadas ADD COLUMN IF NOT EXISTS editing_by VARCHAR(100) NULL DEFAULT NULL`)
    await q(`ALTER TABLE ordenes_guardadas ADD COLUMN IF NOT EXISTS editing_at TIMESTAMP NULL DEFAULT NULL`)
    await q(`ALTER TABLE ordenes_guardadas ADD COLUMN IF NOT EXISTS editing_source VARCHAR(20) NULL DEFAULT NULL`)
    console.log('   ✓ Columnas de bloqueo de edición verificadas')

    // Programar resumen diario automático a las 20:00
    agendarResumenDiario()

    // ── Keep-alive de TiDB Serverless ────────────────────────
    // TiDB Serverless pausa las conexiones tras ~5 min sin actividad.
    // Un ping cada 3 minutos mantiene el pool caliente y evita que
    // el primer query de "revisionFinalizar" o "buscarProducto" tarde
    // 5-10s o falle con PROTOCOL_CONNECTION_LOST.
    setInterval(async () => {
      try { await q('SELECT 1') } catch { /* el pool se recuperará solo en el siguiente query real */ }
    }, 3 * 60 * 1000)

  } catch (err) {
    console.error('❌ Error iniciando:', err.message)
  }
})
