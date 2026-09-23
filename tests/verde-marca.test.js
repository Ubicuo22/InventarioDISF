/**
 * tests/verde-marca.test.js — Un solo verde de marca en el frontend.
 *
 * El 23 sep 2026 se eliminó el esmeralda de Tailwind: competía con el verde
 * de marca (--accent) y con green-*, y sus overrides de CSS volvían sólidos
 * los fondos translúcidos. Ahora `green` ES la paleta de marca
 * (tailwind.config.js). Este test falla si reaparece una clase emerald-* o
 * un verde de Tailwind escrito a mano (hex/rgba) en lugar de la paleta.
 *
 * Excepción intencional: el botón de WhatsApp (verde de WhatsApp, no de marca).
 */
const fs   = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

const ARCHIVOS = [
  'public/index.html',
  'public/dashboard.html',
  'public/tracker.html',
  'public/css/style.css',
  'public/css/tailwind.min.css',
  'public/js/bodega.js',
  'public/js/api.js',
  ...fs.readdirSync(path.join(ROOT, 'public/js/modules')).map(f => `public/js/modules/${f}`),
]

// Tonos de emerald-* y green-* de Tailwind por defecto (hex y rgb)
const VERDES_TAILWIND = [
  '#ecfdf5', '#d1fae5', '#a7f3d0', '#6ee7b7', '#34d399', '#10b981', '#059669', '#047857', '#065f46', '#064e3b',
  '#f0fdf4', '#dcfce7', '#bbf7d0', '#86efac', '#4ade80', '#22c55e', '#16a34a', '#166534', '#14532d',
  'rgba(16,185,129', 'rgba(52,211,153', 'rgba(34,197,94', 'rgba(22,163,74', 'rgba(5,150,105', 'rgba(6,78,59',
  'rgba(74,222,128', 'rgb(110,231,183', 'rgb(16 185 129', 'rgb(52 211 153', 'rgb(34 197 94', 'rgb(74 222 128',
]

function leer (rel) {
  let s = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  // El bloque de WhatsApp conserva su verde propio (#15803d en modo claro)
  if (rel === 'public/css/style.css') {
    const i = s.indexOf('/* ── Botón WhatsApp ── */')
    const j = s.indexOf('/* ── Panel "dark"', i)
    if (i !== -1 && j !== -1) s = s.slice(0, i) + s.slice(j)
  }
  return s
}

describe('verde de marca — sin esmeralda ni verdes de Tailwind a mano', () => {
  it.each(ARCHIVOS)('%s no usa clases emerald-*', (rel) => {
    const hits = leer(rel).match(/emerald-\d/g) || []
    expect(hits).toEqual([])
  })

  it.each(ARCHIVOS)('%s no trae verdes de Tailwind escritos a mano', (rel) => {
    const s = leer(rel).toLowerCase().replace(/\s+/g, '')
    const hits = VERDES_TAILWIND.filter(v => s.includes(v.replace(/\s+/g, '')))
    expect(hits).toEqual([])
  })

  it('tailwind.config.js define green como la paleta de marca y no redefine emerald', () => {
    const cfg = require('../tailwind.config.js')
    const colors = cfg.theme.extend.colors
    expect(colors.emerald).toBeUndefined()
    expect(colors.green[500]).toBe('#4CAF72') // --accent-dark
    expect(colors.green[800]).toBe('#1E5C3A') // --accent
  })
})
