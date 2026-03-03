function inventoryModule() {
  return {
    productos: [],
    filtrados: [],
    cargando: false,
    busqueda: '',
    filtroStock: '',
    resumen: {},
    proveedores: [],

    async cargarProductos() {
      this.cargando = true
      try {
        const r = await API.get('/api/productos')
        this.productos = r.data || []
        this.filtrar()
      } catch (err) {
        this.mostrarToast(err.message || 'Error al cargar productos', true)
      } finally {
        this.cargando = false
      }
    },

    async cargarResumen() {
      try {
        const r = await API.get('/api/productos/resumen')
        this.resumen = r.data || {}
      } catch (err) {
        this.mostrarToast(err.message || 'Error al cargar resumen', true)
      }
    },

    async cargarProveedores() {
      try {
        const r = await API.get('/api/productos/proveedores')
        this.proveedores = r.data || []
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

    async recargar() {
      await Promise.all([this.cargarProductos(), this.cargarResumen()])
    }
  }
}
