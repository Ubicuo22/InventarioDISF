/**
 * scripts/bundle-js.js
 * Concatena todos los módulos JS de la app en un solo archivo.
 * Orden estricto: api → sounds → modules/* → bodega
 * Resultado: public/js/bodega-bundle.js
 */

const fs   = require('fs')
const path = require('path')

const ROOT   = path.join(__dirname, '..')
const OUT    = path.join(ROOT, 'public/js/bodega-bundle.js')

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
  'public/js/bodega.js',
]

const banner = `/* bodega-bundle.js — generado por scripts/bundle-js.js — ${new Date().toISOString()} */\n`

const bundle = FILES.map(f => {
  const full = path.join(ROOT, f)
  const src  = fs.readFileSync(full, 'utf8')
  return `/* ── ${f} ── */\n${src}`
}).join('\n\n')

fs.writeFileSync(OUT, banner + bundle)

const kb = (fs.statSync(OUT).size / 1024).toFixed(1)
console.log(`✓ bodega-bundle.js generado — ${kb} KB (${FILES.length} archivos)`)
