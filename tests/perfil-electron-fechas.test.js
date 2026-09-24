/**
 * tests/perfil-electron-fechas.test.js — las rutas /api/electron/* leen la BD
 * con el mismo contrato de fechas que disfruleg-electron (timezone '+00:00',
 * dateStrings), no con el de bodega-web (timezone '-06:00', objetos Date).
 *
 * 24 sep 2026: con el CONFIG de bodega-web cada DATETIME llegaba a Electron
 * 6 h adelantado (TiDB guarda NOW() en UTC; el pool lo interpretaba como hora
 * de México) — p. ej. el "último acceso" de Usuarios. Afectaba a toda pantalla
 * de Electron migrada al Worker (H-5).
 */
const creados = []
jest.mock('mysql2/promise', () => ({
  createPool: (cfg) => {
    creados.push(cfg)
    return { execute: async () => [[{ ok: 1 }]], end: async () => {} }
  },
}))

delete process.env.DB_HTTP_Q  // forzar el camino mysql2
const { q, perfilElectron } = require('../db/pool')

describe('perfil de fechas de Electron (db/pool.js)', () => {
  it('fuera del perfil usa la config de bodega-web', async () => {
    await q('SELECT 1')
    const cfg = creados[creados.length - 1]
    expect(cfg.timezone).toBe('-06:00')
    expect(cfg.dateStrings).toBeFalsy()
  })

  it('dentro de perfilElectron usa timezone +00:00 y dateStrings, como Electron', async () => {
    await new Promise((resolve, reject) => perfilElectron({}, {}, () => q('SELECT 1').then(resolve, reject)))
    const cfg = creados[creados.length - 1]
    expect(cfg.timezone).toBe('+00:00')
    expect(cfg.dateStrings).toBe(true)
  })

  it('el perfil no se filtra a la siguiente query fuera del middleware', async () => {
    const antes = creados.length
    await q('SELECT 1')
    // reutiliza el pool web ya creado (no crea uno con perfil electron)
    expect(creados.slice(antes).every(c => c.timezone === '-06:00')).toBe(true)
  })
})
