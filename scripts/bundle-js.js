/**
 * scripts/bundle-js.js
 * Concatena todos los módulos JS de la app en un solo archivo versionado.
 * Genera: public/js/bodega-bundle.<hash>.js
 * Actualiza el <script src> en public/index.html automáticamente.
 */

const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')

const ROOT = path.join(__dirname, '..')

const FILES = [
  'public/js/api.js',
  'public/js/sounds.js',
  'public/js/modules/ui.js',
  'public/js/modules/auth.js',
  'public/js/modules/inventory.js',
  'public/js/modules/entries.js',
  'public/js/modules/orders.js',
  'public/js/modules/review.js',
  'public/js/modules/history.js',
  'public/js/modules/mermas.js',
  'public/js/modules/notifications.js',
  'public/js/modules/analytics.js',
  'public/js/modules/admin.js',
  'public/js/modules/cobranza.js',
  'public/js/modules/compras.js',
  'public/js/modules/dashboard.js',
  'public/js/modules/pendientes.js',
  'public/js/bodega.js',
]

const bundle = FILES.map(f => {
  const full = path.join(ROOT, f)
  const src  = fs.readFileSync(full, 'utf8')
  // Punto y coma de seguridad al inicio: evita que una IIFE del archivo siguiente
  // sea interpretada como llamada al valor final del archivo anterior
  return `\n;/* ── ${f} ── */\n${src}`
}).join('\n')

// Hash corto (8 chars) del contenido — cambia solo cuando el código cambia
const hash    = crypto.createHash('sha1').update(bundle).digest('hex').slice(0, 8)
const outName = `bodega-bundle.${hash}.js`
const outPath = path.join(ROOT, 'public/js', outName)

// Borrar bundles anteriores para no acumular
const jsDir = path.join(ROOT, 'public/js')
fs.readdirSync(jsDir)
  .filter(f => f.startsWith('bodega-bundle.') && f.endsWith('.js') && f !== outName)
  .forEach(f => fs.unlinkSync(path.join(jsDir, f)))

const banner = `/* ${outName} — ${new Date().toISOString()} */\n`
fs.writeFileSync(outPath, banner + bundle)

// Actualizar la referencia en index.html
const htmlPath = path.join(ROOT, 'public/index.html')
let html = fs.readFileSync(htmlPath, 'utf8')

// Reemplazar cualquier bodega-bundle.*.js (script src y preload)
html = html.replace(/bodega-bundle\.[a-f0-9]+\.js/g, outName)
fs.writeFileSync(htmlPath, html)

const kb = (fs.statSync(outPath).size / 1024).toFixed(1)
console.log(`✓ ${outName} generado — ${kb} KB (${FILES.length} archivos)`)
