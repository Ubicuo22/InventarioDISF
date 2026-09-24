/**
 * tests/revision-regla.test.js — ¿Cuándo una nota cuenta como revisada?
 *
 * Una sola regla en los tres lugares: getReviewInfo() de Electron, el home
 * (routes/dashboard.js) y Pedidos en bodega-web (isOrdenRevisada en
 * public/js/modules/review.js). Solo un CAMBIO de carrito posterior a la
 * revisión la invalida; eventos administrativos (impresión, procesamiento,
 * reversión) no.
 *
 * 24 sep 2026: Pedidos anulaba la revisión ante CUALQUIER evento posterior —
 * imprimir una nota revisada la devolvía a "Activos" (17 de 26 notas del día),
 * y el home decía 14 por revisar mientras Pedidos mostraba 26.
 */
const fs   = require('fs')
const path = require('path')
const vm   = require('vm')

const src = fs.readFileSync(path.join(__dirname, '../public/js/modules/review.js'), 'utf8')
// El módulo del navegador lee localStorage al construirse — uno en memoria basta
const ctx = { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } }
vm.runInNewContext(`${src}\nthis.reviewModule = reviewModule`, ctx)
const { isOrdenRevisada } = ctx.reviewModule()

const nota = (historial) => ({ datos_carrito: JSON.stringify({ General: [], __historial__: historial }) })
const revision = (pendientes = []) => ({ tipoEvento: 'revision', usuario: 'bodega', pendientes })

describe('isOrdenRevisada — misma regla que Electron y el home', () => {
  it('revisada sin pendientes → reviewed', () => {
    expect(isOrdenRevisada(nota([revision()]))?.reviewed).toBe(true)
  })

  it('imprimir DESPUÉS de revisar no anula la revisión', () => {
    expect(isOrdenRevisada(nota([revision(), { tipoEvento: 'impresion' }]))?.reviewed).toBe(true)
  })

  it('procesar o revertir después de revisar tampoco la anula', () => {
    const r = isOrdenRevisada(nota([revision(), { tipoEvento: 'procesamiento' }, { tipoEvento: 'reversion' }]))
    expect(r?.reviewed).toBe(true)
  })

  it('un cambio de carrito después de revisar SÍ la anula (con o sin tipoEvento)', () => {
    expect(isOrdenRevisada(nota([revision(), { tipoEvento: 'cambios', cambios: [] }]))).toBeNull()
    expect(isOrdenRevisada(nota([revision(), { usuario: 'x', cambios: [] }]))).toBeNull()
  })

  it('revisada con pendientes → no reviewed, conPendientes', () => {
    const r = isOrdenRevisada(nota([revision(['AJO'])]))
    expect(r?.reviewed).toBe(false)
    expect(r?.conPendientes).toBe(true)
  })

  it('sin revisión → null', () => {
    expect(isOrdenRevisada(nota([{ tipoEvento: 'impresion' }]))).toBeNull()
    expect(isOrdenRevisada(nota([]))).toBeNull()
  })
})
