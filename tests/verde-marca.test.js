/**
 * tests/verde-marca.test.js — Un solo verde de marca en el frontend, el mismo
 * que Electron.
 *
 * 23 sep 2026: se eliminó el esmeralda de Tailwind (competía con el verde de
 * marca y sus overrides volvían sólidos los fondos translúcidos) y se alineó
 * la marca al verde de Electron: `green` estándar de Tailwind, con dos roles
 * — texto/acento #22C55E (oscuro) / #15803D (claro), y sólido con texto
 * blanco #15803D en ambos modos. Este test falla si reaparece una clase
 * emerald-*, un tono esmeralda escrito a mano, o el verde bosque anterior
 * (#4CAF72 y familia).
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

// Esmeralda de Tailwind + el verde bosque que se usó antes de alinear con Electron
const VERDES_PROHIBIDOS = [
  '#ecfdf5', '#d1fae5', '#a7f3d0', '#6ee7b7', '#34d399', '#10b981', '#059669', '#047857', '#065f46', '#064e3b',
  'rgba(16,185,129', 'rgba(52,211,153', 'rgba(5,150,105', 'rgba(6,78,59', 'rgb(110,231,183',
  'rgb(16 185 129', 'rgb(52 211 153',
  '#4caf72', '#66cc8c', '#9edbb8', '#1e5c3a', '#2e7d52', '#3a9460', '#143d28',
  'rgba(76,175,114', 'rgba(102,204,140', 'rgba(30,92,58', 'rgba(58,148,96',
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

describe('verde de marca — sin esmeralda, alineado con Electron', () => {
  it.each(ARCHIVOS)('%s no usa clases emerald-*', (rel) => {
    const hits = leer(rel).match(/emerald-\d/g) || []
    expect(hits).toEqual([])
  })

  it.each(ARCHIVOS)('%s no trae tonos esmeralda ni el verde bosque anterior', (rel) => {
    const s = leer(rel).toLowerCase().replace(/\s+/g, '')
    const hits = VERDES_PROHIBIDOS.filter(v => s.includes(v.replace(/\s+/g, '')))
    expect(hits).toEqual([])
  })

  it('tailwind.config.js no redefine green ni emerald (green estándar = Electron)', () => {
    const cfg = require('../tailwind.config.js')
    const colors = cfg.theme.extend?.colors || {}
    expect(colors.green).toBeUndefined()
    expect(colors.emerald).toBeUndefined()
  })

  it('style.css: tokens con los mismos valores que ubicuo-green de Electron', () => {
    const css = leer('public/css/style.css')
    expect(css).toMatch(/--accent:\s*#15803D;/)             // texto/acento en claro
    expect(css).toMatch(/--accent-dark:\s*#22C55E;/)        // texto/acento en oscuro
    expect(css).toMatch(/--color-primary-solid:\s*#15803D;/) // botones, ambos modos
    expect(css).toMatch(/\.btn-primary \{\s*background: var\(--color-primary-solid\)/)
  })
})
