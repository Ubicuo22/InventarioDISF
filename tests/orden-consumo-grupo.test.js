/**
 * tests/orden-consumo-grupo.test.js — equivalencias mixtas en el consumo del
 * Worker (routes/electron/orden-consumo.js), espejo de disfruleg-electron.
 *
 * 24 sep 2026: LIMÓN (kg) ↔ bulto de 30 kg y además costal de 15 kg
 * (1 costal = 14.7 kg). La base del kg es el bulto; los 160 costales nunca se
 * descontaban y las ventas quedaban pendientes con mercancía en bodega. Con
 * agregarFuentesDeGrupo (peps-engine-core 1.1.0) el resto del grupo entra
 * como respaldo cuando la base no alcanza.
 */
jest.mock('../db/pool', () => ({ q: jest.fn(), pool: { execute: jest.fn(), getConnection: jest.fn() } }))

const { factoresGrupoEquivalencia } = require('peps-engine-core')
const { calcularConsumoOrden } = require('../routes/electron/orden-consumo')

const KG = 961075, BULTO = 1741063, COSTAL = 2611062
const convRows = [
  { id_producto_derivado: BULTO,  id_producto_base: KG,    factor: 30 },
  { id_producto_derivado: KG,     id_producto_base: BULTO, factor: 0.033333 },
  { id_producto_derivado: COSTAL, id_producto_base: KG,    factor: 14.7 },
]
const convMap = () => ({ [KG]: { idBase: BULTO, factor: 0.033333 } })
const grupos  = { [KG]: factoresGrupoEquivalencia(KG, convRows) }
const item    = [{ id_producto: KG, cantidad: 147, precio_unitario: 30 }]

describe('calcularConsumoOrden (Worker) — respaldo del grupo de equivalencia', () => {
  it('sin bultos, el kg se cubre con costales y no queda pendiente', () => {
    const lotes = { [BULTO]: [], [COSTAL]: [{ id: 50, restante: 160, costo: 300, factorConversion: null }] }
    const r = calcularConsumoOrden(item, convMap(), {}, lotes, grupos)
    expect(r.pendientes).toEqual({})
    expect(r.deltaLotes[50]).toBeCloseTo(10, 6)
    expect(r.deltaStock[COSTAL]).toBeCloseTo(10, 6)
  })

  it('si el bulto alcanza, no toca el costal', () => {
    const lotes = {
      [BULTO]:  [{ id: 40, restante: 10, costo: 600, factorConversion: null }],
      [COSTAL]: [{ id: 50, restante: 160, costo: 300, factorConversion: null }],
    }
    const r = calcularConsumoOrden(item, convMap(), {}, lotes, grupos)
    expect(r.pendientes).toEqual({})
    expect(r.deltaLotes[50]).toBeUndefined()
    expect(lotes[COSTAL][0].restante).toBe(160)
  })

  it('sin grupos (llamada vieja) se comporta como antes: queda pendiente', () => {
    const lotes = { [BULTO]: [], [COSTAL]: [{ id: 50, restante: 160, costo: 300, factorConversion: null }] }
    const r = calcularConsumoOrden(item, convMap(), {}, lotes)
    expect(r.pendientes[KG]).toBe(147)
  })
})
