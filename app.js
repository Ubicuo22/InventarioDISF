/**
 * app.js — Aplicación Express compartida
 *
 * La app (middleware + rutas) vive aquí para poder usarse desde dos entradas:
 *   server.js  → Node.js en la Mac Mini (listen + init de tablas + intervals)
 *   worker.js  → Cloudflare Workers (httpServerHandler + cron triggers)
 */

const express = require('express')
const app = express()

// En Workers los estáticos los sirve Workers Assets (wrangler.jsonc) y no
// existe __dirname; express.static y sendFile solo aplican en Node.
const esWorkers = globalThis.navigator?.userAgent === 'Cloudflare-Workers'

const { requireAuth, requireModulo } = require('./middleware/auth')

// ─── Middleware global ────────────────────────────────────────
app.use(require('cors')())
app.use(express.json())

if (!esWorkers) {
  const path = require('path')
  // JS usa nombres con hash → immutable 7d; CSS no tiene hash → sin cache para detectar cambios
  app.use('/js',  express.static(path.join(__dirname, 'public/js'),  { maxAge: '7d', immutable: true }))
  app.use('/css', express.static(path.join(__dirname, 'public/css'), { maxAge: 0 }))
  app.use('/assets', express.static(path.join(__dirname, 'public/assets'), { maxAge: '30d', immutable: true }))
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }))
}

// ─── Rutas públicas / con auth propio ────────────────────────
app.use('/api/auth',           require('./routes/auth'))
app.use('/api/notificaciones', require('./routes/notificaciones'))

// ─── Rutas protegidas — acceso general (cualquier rol válido) ─
app.use('/api/productos',  requireAuth, require('./routes/productos'))
app.use('/api/clientes',   requireAuth, require('./routes/clientes'))
app.use('/api/ordenes',    requireAuth, requireModulo('pedidos'),    require('./routes/ordenes'))
app.use('/api/entradas',   requireAuth, requireModulo('inventario'), require('./routes/entradas'))
app.use('/api/mermas',     requireAuth, requireModulo('mermas'),     require('./routes/mermas'))
app.use('/api/compras',    requireAuth, requireModulo('compras'),    require('./routes/compras'))
app.use('/api/analytics',  requireAuth, requireModulo('analytics'),  require('./routes/analytics'))

// ─── Cobranza (requiere módulo 'cobranza') ───────────────────
app.use('/api/deudas', require('./routes/deudas'))
app.use('/api/pagos',  require('./routes/pagos'))

// ─── Dashboard TV (token público) ────────────────────────────
app.use('/api/dashboard', require('./routes/dashboard'))

// ─── Rutas de administración (solo admin) ────────────────────
app.use('/api/admin', require('./routes/admin'))

// ─── Precios por grupo (solo CEO) ────────────────────────────
app.use('/api/precios', require('./routes/precios'))

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


// Fallback — debe ir al final.
// Node: SPA (index.html). Workers: solo llegan /api/* aquí → 404 JSON.
app.get('*', (req, res) => {
  if (esWorkers) {
    return res.status(404).json({ ok: false, error: 'Ruta no encontrada' })
  }
  const path = require('path')
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

// ─── Middleware de errores Express (catch-all) ────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] ❌ Express error:`, err.message)
  res.status(500).json({ ok: false, error: 'Error interno del servidor' })
})

module.exports = app
