function entriesModule() {
  return {
    modalAbierto: false,
    guardando: false,
    guardadoOk: false,
    errorModal: '',
    dropdownVisible: false,
    dropResults: [],
    form: {},
    equivalentes: [],           // productos equivalentes del producto seleccionado
    equivalentesChecked: [],    // ids seleccionados para actualizar stock

    abrirModal(prod = null) {
      this.resetForm()
      this.errorModal = ''
      if (prod) {
        this.form.idProducto     = prod.id_producto
        this.form.nombreProducto = prod.nombre_producto
        this.form.stockActual    = prod.stock
        this.form.unidad         = prod.unidad_producto || ''
        this.form.busqueda       = prod.nombre_producto
        this.cargarEquivalentes(prod.id_producto)
      }
      this.modalAbierto = true
    },

    cerrarModal() {
      this.modalAbierto = false
      this.guardadoOk   = false
      this.resetForm()
    },

    resetForm() {
      const hoy = new Date().toISOString().slice(0, 10)
      this.form = {
        idProducto: null, nombreProducto: '', stockActual: 0,
        unidad: '',
        busqueda: '', cantidad: '', precio: '',
        incluirIva: true, fechaCompra: hoy,
        idProveedor: '', folio: '', notas: '',
        pesoLote: ''     // kg totales del lote — opcional, para factor PEPS
      }
      this.dropResults          = []
      this.dropdownVisible      = false
      this.equivalentes         = []
      this.equivalentesChecked  = []
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

    async cargarEquivalentes(idProducto) {
      this.equivalentes        = []
      this.equivalentesChecked = []
      try {
        const r = await API.get(`/api/entradas/equivalentes/${idProducto}`)
        if (r.ok && r.data.length > 0) {
          this.equivalentes        = r.data
          this.equivalentesChecked = r.data.map(e => e.id_producto) // todos marcados por defecto
        }
      } catch (_) {}
    },

    async seleccionar(p) {
      this.form.idProducto     = p.id_producto
      this.form.nombreProducto = p.nombre_producto
      this.form.stockActual    = p.stock
      this.form.unidad         = p.unidad_producto || ''
      this.form.busqueda       = p.nombre_producto
      this.dropdownVisible     = false
      this.dropResults         = []
      this.cargarEquivalentes(p.id_producto)
    },

    limpiarSeleccion() {
      this.form.idProducto     = null; this.form.nombreProducto = ''
      this.form.stockActual    = 0;    this.form.busqueda = ''
      this.form.unidad         = ''
      this.equivalentes        = []
      this.equivalentesChecked = []
    },

    // ── Cálculos de peso del lote ─────────────────────────────
    calcKgPorUnidad() {
      const peso = parseFloat(this.form.pesoLote)
      const cant = parseFloat(this.form.cantidad)
      if (!peso || !cant || peso <= 0 || cant <= 0) return null
      return (peso / cant).toFixed(4)
    },

    calcFactorLote() {
      const kgU = parseFloat(this.calcKgPorUnidad())
      if (!kgU || kgU <= 0) return null
      return (1 / kgU).toFixed(3)
    },

    calcDesglose() {
      const cant   = parseFloat(this.form.cantidad) || 0
      const precio = parseFloat(this.form.precio)   || 0
      if (!cant || !precio) return null
      if (this.form.incluirIva) {
        const baseUnit = precio / 1.16
        const ivaUnit  = precio - baseUnit
        return {
          base:  (cant * baseUnit).toFixed(2),
          iva:   (cant * ivaUnit).toFixed(2),
          total: (cant * precio).toFixed(2)
        }
      } else {
        return {
          base:  (cant * precio).toFixed(2),
          iva:   null,
          total: (cant * precio).toFixed(2)
        }
      }
    },

    async guardarEntrada() {
      this.errorModal = ''
      if (!this.form.idProducto) { this.errorModal = 'Selecciona un producto'; return }
      this.guardandoOk = false
      this.guardando   = true
      try {
        const r = await API.post('/api/entradas', {
          idProducto:      this.form.idProducto,
          idProveedor:     this.form.idProveedor || null,
          cantidad:        this.form.cantidad,
          precio:          this.form.precio,
          fechaCompra:     this.form.fechaCompra,
          folio:           this.form.folio || null,
          incluirIva:      this.form.incluirIva,
          notas:           this.form.notas || null,
          idsEquivalentes: this.equivalentesChecked,
          pesoLote:        this.form.pesoLote ? parseFloat(this.form.pesoLote) : null
        })
        if (!r.ok) { this.errorModal = r.error || 'Error al guardar'; return }

        // Actualizar stock local sin recargar lista completa
        const cantAgregada = parseFloat(this.form.cantidad)
        const idx = this.productos.findIndex(p => p.id_producto === this.form.idProducto)
        if (idx !== -1) {
          this.productos[idx] = { ...this.productos[idx], stock: parseFloat(this.productos[idx].stock) + cantAgregada }
        }
        // Actualizar stock local de equivalentes seleccionados
        for (const idEq of this.equivalentesChecked) {
          const idxEq = this.productos.findIndex(p => p.id_producto === idEq)
          if (idxEq !== -1) {
            this.productos[idxEq] = { ...this.productos[idxEq], stock: parseFloat(this.productos[idxEq].stock) + cantAgregada }
          }
        }
        this.filtrar()
        await this.cargarResumen()

        const msg = `${this.form.cantidad} × ${this.form.nombreProducto}`

        // Confirmación visual — botón verde con check por 700ms antes de cerrar
        this.guardando   = false
        this.guardadoOk  = true
        await new Promise(res => setTimeout(res, 700))
        this.cerrarModal()
        this.mostrarToast(msg)
      } catch (err) {
        this.errorModal = err.message || 'Error de conexión'
      } finally {
        this.guardando  = false
        this.guardadoOk = false
      }
    }
  }
}
