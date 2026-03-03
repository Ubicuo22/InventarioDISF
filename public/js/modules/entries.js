function entriesModule() {
  return {
    modalAbierto: false,
    guardando: false,
    errorModal: '',
    dropdownVisible: false,
    dropResults: [],
    form: {},

    abrirModal(prod = null) {
      this.resetForm()
      this.errorModal = ''
      if (prod) {
        this.form.idProducto     = prod.id_producto
        this.form.nombreProducto = prod.nombre_producto
        this.form.stockActual    = prod.stock
        this.form.busqueda       = prod.nombre_producto
      }
      this.modalAbierto = true
    },

    cerrarModal() {
      this.modalAbierto = false
      this.resetForm()
    },

    resetForm() {
      const hoy = new Date().toISOString().slice(0, 10)
      this.form = {
        idProducto: null, nombreProducto: '', stockActual: 0,
        busqueda: '', cantidad: '', precio: '',
        incluirIva: true, fechaCompra: hoy,
        idProveedor: '', folio: '', notas: ''
      }
      this.dropResults     = []
      this.dropdownVisible = false
    },

    buscarProducto() {
      const s = this.form.busqueda.toLowerCase().trim()
      if (!s) { this.dropResults = []; return }
      this.dropResults = this.productos
        .filter(p => p.nombre_producto.toLowerCase().includes(s))
        .slice(0, 10)
      this.dropdownVisible = true
      if (this.form.idProducto && this.form.busqueda !== this.form.nombreProducto) {
        this.form.idProducto = null; this.form.nombreProducto = ''; this.form.stockActual = 0
      }
    },

    seleccionar(p) {
      this.form.idProducto     = p.id_producto
      this.form.nombreProducto = p.nombre_producto
      this.form.stockActual    = p.stock
      this.form.busqueda       = p.nombre_producto
      this.dropdownVisible     = false
      this.dropResults         = []
    },

    limpiarSeleccion() {
      this.form.idProducto = null; this.form.nombreProducto = ''
      this.form.stockActual = 0;   this.form.busqueda = ''
    },

    calcTotal() {
      return ((parseFloat(this.form.cantidad) || 0) * (parseFloat(this.form.precio) || 0)).toFixed(2)
    },

    async guardarEntrada() {
      this.errorModal = ''
      if (!this.form.idProducto) { this.errorModal = 'Selecciona un producto'; return }
      this.guardando = true
      try {
        const r = await API.post('/api/entradas', {
          idProducto:  this.form.idProducto,
          idProveedor: this.form.idProveedor || null,
          cantidad:    this.form.cantidad,
          precio:      this.form.precio,
          fechaCompra: this.form.fechaCompra,
          folio:       this.form.folio || null,
          incluirIva:  this.form.incluirIva,
          notas:       this.form.notas || null
        })
        if (!r.ok) { this.errorModal = r.error || 'Error al guardar'; return }

        // Actualizar stock local sin recargar lista completa
        const idx = this.productos.findIndex(p => p.id_producto === this.form.idProducto)
        if (idx !== -1) {
          this.productos[idx] = {
            ...this.productos[idx],
            stock: parseFloat(this.productos[idx].stock) + parseFloat(this.form.cantidad)
          }
        }
        this.filtrar()
        await this.cargarResumen()

        const msg = `${this.form.cantidad} × ${this.form.nombreProducto}`
        this.cerrarModal()
        this.mostrarToast(msg)
      } catch (err) {
        this.errorModal = err.message || 'Error de conexión'
      } finally {
        this.guardando = false
      }
    }
  }
}
