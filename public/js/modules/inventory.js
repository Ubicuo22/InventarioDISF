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
