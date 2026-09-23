/**
 * info-compra.js — Página informativa: última compra, promedio de compra y
 * margen aproximado por producto. Solo lectura por ahora.
 *
 * Por defecto muestra los 25 productos más vendidos (histórico) — nunca
 * carga el catálogo completo. Buscar reemplaza esa lista por coincidencias
 * de nombre (también acotado a 25).
 */
function infoCompraModule() {
  return {
    infoCompraProductos: [],
    infoCompraBusqueda:  '',
    infoCompraCargando:  false,
    infoCompraCargado:   false,   // ya se hizo al menos una carga (para el empty-state inicial)
    _infoCompraTimer:    null,

    async cargarInfoCompra() {
      this.infoCompraCargando = true
      try {
        const q = this.infoCompraBusqueda.trim()
        const url = q ? `/api/productos/info-compra?busqueda=${encodeURIComponent(q)}` : '/api/productos/info-compra'
        const r = await API.get(url)
        this.infoCompraProductos = r.ok ? (r.data || []) : []
        if (!r.ok) this.mostrarToast(r.error || 'Error al cargar', true)
      } catch (e) {
        this.infoCompraProductos = []
        this.mostrarToast('Error de conexión', true)
      } finally {
        this.infoCompraCargando = false
        this.infoCompraCargado  = true
      }
    },

    infoCompraBuscarDebounced() {
      clearTimeout(this._infoCompraTimer)
      this._infoCompraTimer = setTimeout(() => this.cargarInfoCompra(), 350)
    },

    infoCompraFmtMoney(v) {
      if (v == null) return '—'
      return Number(v).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 })
    },

    infoCompraFmtFecha(f) {
      if (!f) return '—'
      return new Date(f).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    },
  }
}
