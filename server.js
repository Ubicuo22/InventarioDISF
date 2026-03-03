/**
 * ═══════════════════════════════════════════════════════════════
 * DISFRULEG — Portal Bodega
 * Punto de entrada del servidor Express
 *
 * Rutas:
 *   POST /api/auth/login          — Login (público)
 *   GET  /api/status              — Health check (público)
 *   GET  /api/productos           — Lista con stock (protegido)
 *   GET  /api/productos/resumen   — Stats de stock (protegido)
 *   GET  /api/productos/proveedores
 *   POST /api/entradas            — Registrar entrada (protegido)
 *   GET  /api/entradas/recientes  — Historial (protegido)
 * ═══════════════════════════════════════════════════════════════
 */

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '.env') })

const express = require('express')

const app  = express()
const PORT = process.env.PORT || process.env.BODEGA_PORT || 3030

// ─── Middleware global ────────────────────────────────────────
app.use(require('cors')())
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// ─── Rutas ───────────────────────────────────────────────────
app.use('/api/auth',      require('./routes/auth'))
app.use('/api/productos', require('./routes/productos'))
app.use('/api/entradas',  require('./routes/entradas'))
app.use('/api/ordenes',   require('./routes/ordenes'))
app.use('/api/clientes',  require('./routes/clientes'))

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
  } catch (err) {
    console.error('❌ Error conectando DB:', err.message)
  }
})
