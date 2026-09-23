/**
 * scripts/gen-nota-logo.js — Genera utils/nota-logo.js con el logo de la nota
 * en base64 (el mismo archivo que usa Electron: disfruleg-logo-light.png).
 * En Workers no hay fs, así que el logo viaja dentro del bundle.
 *
 * Uso: node scripts/gen-nota-logo.js
 */
const fs   = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const png  = fs.readFileSync(path.join(ROOT, 'public/assets/disfruleg-logo-light.png'))
const out  = `// GENERADO por scripts/gen-nota-logo.js — no editar a mano.
// Logo de la nota impresa (public/assets/disfruleg-logo-light.png).
module.exports = { LOGO_NOTA_BASE64: '${png.toString('base64')}' }
`
fs.writeFileSync(path.join(ROOT, 'utils/nota-logo.js'), out)
console.log(`✓ utils/nota-logo.js — ${png.length} bytes de logo`)
