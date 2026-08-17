function inventoryModule() {
  return {
    productos: [],
    filtrados: [],
    cargando: false,
    busqueda: '',
    filtroStock: '',
    resumen: {},
    proveedores: [],
    _filtrarTimer: null,

    async cargarProductos() {
      this.cargando = true
      try {
        const r = await API.get('/api/productos')
        if (r.ok) { this.productos = r.data || []; this.filtrar() }
        else       this.mostrarToast(r.error || 'Error al cargar productos', true)
      } catch (err) {
        this.mostrarToast(err.message || 'Error al cargar productos', true)
      } finally {
        this.cargando = false
      }
    },

    async cargarResumen() {
      try {
        const r = await API.get('/api/productos/resumen')
        if (r.ok) this.resumen = r.data || {}
        else      this.mostrarToast(r.error || 'Error al cargar resumen', true)
      } catch (err) {
        this.mostrarToast(err.message || 'Error al cargar resumen', true)
      }
    },

    async cargarProveedores() {
      try {
        const r = await API.get('/api/productos/proveedores')
        if (r.ok) this.proveedores = r.data || []
        else      this.mostrarToast(r.error || 'Error al cargar proveedores', true)
      } catch (err) {
        this.mostrarToast(err.message || 'Error al cargar proveedores', true)
      }
    },

    filtrar() {
      let lista = [...this.productos]
      const b = this.busqueda.toLowerCase().trim()
      if (b) lista = lista.filter(p => p.nombre_producto.toLowerCase().includes(b))
      if (this.filtroStock === 'ok')   lista = lista.filter(p => p.stock > 5)
      if (this.filtroStock === 'low')  lista = lista.filter(p => p.stock > 0 && p.stock <= 5)
      if (this.filtroStock === 'zero') lista = lista.filter(p => p.stock <= 0)
      this.filtrados = lista
    },

    // Versión debounced del filtro — para el input de búsqueda (300ms)
    filtrarDebounced() {
      clearTimeout(this._filtrarTimer)
      this._filtrarTimer = setTimeout(() => this.filtrar(), 300)
    },

    async recargar() {
      await Promise.all([this.cargarProductos(), this.cargarResumen()])
    },

    // ── Nuevo producto ────────────────────────────────────────
    modalProductoAbierto: false,
    guardandoProducto:    false,
    errorProducto:        '',
    productoForm: {
      nombre_producto: '',
      unidad_producto: 'kg',
      precio:          '',
      id_grupo:        ''
    },

    abrirNuevoProducto() {
      this.errorProducto = ''
      this.productoForm  = { nombre_producto: '', unidad_producto: 'kg', precio: '', id_grupo: '' }
      // Cargar grupos si aún no están (compartido con ordersModule via flat-merge)
      if (!this.grupos?.length) this.cargarGrupos()
      this.modalProductoAbierto = true
    },

    cerrarProducto() {
      this.modalProductoAbierto = false
      this.errorProducto        = ''
    },

    // ── Lotes PEPS ────────────────────────────────────────────
    lotesDrawerAbierto: false,
    lotesProducto:      null,
    lotes:              [],
    lotesCargando:      false,

    async abrirLotes(producto) {
      this.lotesProducto      = producto
      this.lotes              = []
      this.lotesDrawerAbierto = true
      this.lotesCargando      = true
      try {
        const r = await API.get(`/api/entradas/lotes/${producto.id_producto}`)
        if (r.ok) this.lotes = r.data || []
      } catch (_) {}
      this.lotesCargando = false
    },

    cerrarLotes() {
      this.lotesDrawerAbierto = false
      this.lotesProducto      = null
      this.lotes              = []
    },

    loteFechaCorta(fechaStr) {
      if (!fechaStr) return '—'
      const d = new Date(fechaStr + 'T12:00:00')
      return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: '2-digit' })
    },

    loteDiasDesde(fechaStr) {
      if (!fechaStr) return null
      const d = new Date(fechaStr + 'T12:00:00')
      return Math.floor((Date.now() - d.getTime()) / 86400000)
    },

    // Cuánto se ha consumido de un lote (%)
    lotePct(lote) {
      const ini = parseFloat(lote.cantidad_inicial)
      if (!ini) return 0
      return Math.round((1 - parseFloat(lote.cantidad_restante) / ini) * 100)
    },

    // Color de la barra de progreso según antigüedad del lote
    loteBarColor(dias, idx) {
      if (idx === 0) return 'bg-emerald-400'   // el que se consume primero
      if (dias === null || dias <= 30) return 'bg-slate-500'
      if (dias <= 75) return 'bg-amber-500'
      return 'bg-red-500'
    },

    async guardarProducto() {
      this.errorProducto = ''
      if (!this.productoForm.nombre_producto.trim())
        { this.errorProducto = 'El nombre es obligatorio'; return }
      if (!this.productoForm.unidad_producto)
        { this.errorProducto = 'Selecciona una unidad'; return }
      const precio = this.productoForm.precio !== '' ? parseFloat(this.productoForm.precio) : null
      if (precio !== null && (isNaN(precio) || precio <= 0))
        { this.errorProducto = 'Precio debe ser mayor a 0'; return }
      if (precio && !this.productoForm.id_grupo)
        { this.errorProducto = 'Selecciona un grupo para el precio'; return }

      this.guardandoProducto = true
      try {
        const body = {
          nombre_producto: this.productoForm.nombre_producto.trim(),
          unidad_producto: this.productoForm.unidad_producto
        }
        if (precio && this.productoForm.id_grupo) {
          body.precio   = precio
          body.id_grupo = this.productoForm.id_grupo
        }
        const r = await API.post('/api/productos', body)
        if (!r.ok) { this.errorProducto = r.error || 'Error al guardar'; return }
        this.cerrarProducto()
        this.mostrarToast(`Producto "${r.data.nombre_producto}" creado`)
        await this.recargar()
      } catch (e) {
        this.errorProducto = e.message || 'Error de conexión'
      } finally {
        this.guardandoProducto = false
      }
    }
  }
}
