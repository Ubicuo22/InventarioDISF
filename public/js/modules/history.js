function historyModule() {
  return {
    // ── Entradas de inventario ────────────────────────────────
    entradas: [],
    cargandoEntradas: false,

    // ── Sub-tabs del historial ────────────────────────────────
    historialTab: 'entradas',   // 'entradas' | 'pedidos'

    // ── Pedidos registrados (historial) ───────────────────────
    pedidosHistorial: [],
    cargandoPedidosHistorial: false,

    // ── Modal de detalle de pedido (solo lectura) ─────────────
    modalDetalleOrden: false,
    ordenDetalle: null,
    cargandoDetalle: false,

    // ── Cargar entradas recientes ─────────────────────────────
    async cargarEntradasRecientes() {
      this.cargandoEntradas = true
      try {
        const r = await API.get('/api/entradas/recientes')
        this.entradas = r.data || []
      } catch (err) {
        this.entradas = []
        this.mostrarToast(err.message || 'Error al cargar historial', true)
      } finally {
        this.cargandoEntradas = false
      }
    },

    // ── Cargar pedidos registrados ────────────────────────────
    async cargarPedidosHistorial() {
      this.cargandoPedidosHistorial = true
      try {
        const r = await API.get('/api/ordenes?estado=registrada')
        this.pedidosHistorial = r.data || []
      } catch (err) {
        this.pedidosHistorial = []
        this.mostrarToast(err.message || 'Error al cargar pedidos', true)
      } finally {
        this.cargandoPedidosHistorial = false
      }
    },

    // ── Abrir modal de detalle ────────────────────────────────
    async abrirDetalleOrden(orden) {
      this.cargandoDetalle = true
      this.modalDetalleOrden = true
      this.ordenDetalle = null
      try {
        const r = await API.get(`/api/ordenes/${orden.folio_numero}`)
        if (!r.ok) {
          this.mostrarToast('Error al cargar el pedido', true)
          this.modalDetalleOrden = false
          return
        }
        const o = r.data
        const cart = (typeof o.datos_carrito === 'string')
          ? JSON.parse(o.datos_carrito) : (o.datos_carrito || {})
        this.ordenDetalle = { ...o, datos_carrito: cart }
      } catch (err) {
        this.mostrarToast(err.message || 'Error al cargar el pedido', true)
        this.modalDetalleOrden = false
      } finally {
        this.cargandoDetalle = false
      }
    },

    cerrarDetalleOrden() {
      this.modalDetalleOrden = false
      this.ordenDetalle = null
      this.cargandoDetalle = false
    },

    // ── Helpers del modal detalle ─────────────────────────────
    detalleSectionNames() {
      if (!this.ordenDetalle?.datos_carrito) return []
      const keys = Object.keys(this.ordenDetalle.datos_carrito)
      if (keys.includes('General')) {
        return ['General', ...keys.filter(k => k !== 'General')]
      }
      return keys
    },

    detalleCartItems() {
      if (!this.ordenDetalle?.datos_carrito) return []
      return Object.values(this.ordenDetalle.datos_carrito).flat()
    },

    detalleTotalOrden() {
      return this.detalleCartItems().reduce(
        (sum, item) => sum + ((item.cantidad || 0) * (item.precio_unitario || 0)), 0
      )
    },

    // ── Formato de fecha ──────────────────────────────────────
    fmtFecha(f) {
      if (!f) return '—'
      const d = new Date(f)
      const utc = new Date(d.getTime() + d.getTimezoneOffset() * 60000)
      return utc.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: '2-digit' })
    }
  }
}
