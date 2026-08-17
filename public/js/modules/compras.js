/**
 * compras.js — Módulo Alpine.js para el tab de Compras
 *
 * Muestra resumen diario de gastos de compra con desglose por producto y proveedor.
 * Se mezcla en bodega() mediante spread en bodega.js.
 */

function comprasModule() {
  const hoy    = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })
  const hace30 = () => new Date(Date.now() - 30 * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })

  return {
    // ── Estado ────────────────────────────────────────────────
    comprasCargando:    false,
    comprasDias:        [],          // array de { fecha, total_gasto, compras: [...], ... }
    comprasResumen:     {},          // { total_periodo, total_compras, dias_con_gasto }
    comprasDesde:       hace30(),
    comprasHasta:       hoy(),
    comprasDiaOpen:     null,        // fecha del día expandido (null = todos cerrados)
    comprasError:       '',

    // ── Cargar datos ──────────────────────────────────────────
    async cargarCompras() {
      this.comprasCargando = true
      this.comprasError    = ''
      try {
        const r = await API.get(
          `/api/compras/resumen?desde=${this.comprasDesde}&hasta=${this.comprasHasta}`
        )
        if (!r.ok) { this.comprasError = r.error || 'Error al cargar compras'; return }
        this.comprasDias    = r.dias    || []
        this.comprasResumen = r.resumen || {}
        this.comprasDiaOpen = null
      } catch (e) {
        this.comprasError = e.message || 'Error de conexión'
      } finally {
        this.comprasCargando = false
      }
    },

    // ── Filtros rápidos ───────────────────────────────────────
    async filtroCompras(periodo) {
      const mxDate = (d) => d.toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })
      const h = new Date()
      if (periodo === 'hoy') {
        this.comprasDesde = this.comprasHasta = mxDate(h)
      } else if (periodo === '7d') {
        this.comprasDesde = mxDate(new Date(Date.now() - 7 * 86400000))
        this.comprasHasta = mxDate(h)
      } else if (periodo === '30d') {
        this.comprasDesde = mxDate(new Date(Date.now() - 30 * 86400000))
        this.comprasHasta = mxDate(h)
      } else if (periodo === 'mes') {
        const mx = mxDate(h)
        this.comprasDesde = `${mx.slice(0, 7)}-01`
        this.comprasHasta = mx
      }
      await this.cargarCompras()
    },

    // ── Expandir / colapsar día ───────────────────────────────
    toggleDiaCompras(fecha) {
      this.comprasDiaOpen = this.comprasDiaOpen === fecha ? null : fecha
    },

    // ── Helpers de formato ────────────────────────────────────
    fmtFechaCompra(f) {
      if (!f) return '—'
      const ymd = typeof f === 'string' ? f.slice(0, 10) : new Date(f).toISOString().slice(0, 10)
      const d = new Date(ymd + 'T12:00:00Z')
      return d.toLocaleDateString('es-MX', {
        weekday: 'short', day: 'numeric', month: 'short',
        timeZone: 'America/Mexico_City'
      })
    },

    fmtMoney(v) {
      return '$' + parseFloat(v || 0).toLocaleString('es-MX', {
        minimumFractionDigits: 2, maximumFractionDigits: 2
      })
    },

    // Agrupar compras del día por proveedor
    comprasPorProveedor(compras) {
      const map = {}
      for (const c of compras) {
        const prov = c.proveedor || '—'
        if (!map[prov]) map[prov] = { proveedor: prov, items: [], total: 0 }
        map[prov].items.push(c)
        map[prov].total += c.total
      }
      return Object.values(map).sort((a, b) => b.total - a.total)
    }
  }
}
