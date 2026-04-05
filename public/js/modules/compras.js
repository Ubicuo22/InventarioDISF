/**
 * compras.js — Módulo Alpine.js para el tab de Compras
 *
 * Muestra resumen diario de gastos de compra con desglose por producto y proveedor.
 * Se mezcla en bodega() mediante spread en bodega.js.
 */

function comprasModule() {
  const hoy    = () => new Date().toISOString().slice(0, 10)
  const hace30 = () => new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)

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
      const h = new Date()
      if (periodo === 'hoy') {
        this.comprasDesde = this.comprasHasta = h.toISOString().slice(0, 10)
      } else if (periodo === '7d') {
        this.comprasDesde = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
        this.comprasHasta = h.toISOString().slice(0, 10)
      } else if (periodo === '30d') {
        this.comprasDesde = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
        this.comprasHasta = h.toISOString().slice(0, 10)
      } else if (periodo === 'mes') {
        this.comprasDesde = `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}-01`
        this.comprasHasta = h.toISOString().slice(0, 10)
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
      const [y, m, d] = f.split('-').map(Number)
      const utc = new Date(Date.UTC(y, m - 1, d))
      return utc.toLocaleDateString('es-MX', {
        weekday: 'short', day: 'numeric', month: 'short'
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
