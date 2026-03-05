function mermasModule() {
  return {
    // ── Estado modal ──────────────────────────────────────────
    modalMermaAbierto: false,
    guardandoMerma:    false,
    errorMerma:        '',

    // ── Formulario ────────────────────────────────────────────
    mermaForm: {
      id_producto:    null,
      nombre_producto: '',
      unidad_producto: '',
      stock_actual:   null,
      tipo:           '',
      cantidad:       '',
      fecha:          '',
      motivo:         '',
      notas:          ''
    },

    // ── Búsqueda de producto ──────────────────────────────────
    mermaBusqueda:    '',
    mermaResultados:  [],
    mermaDropVisible: false,

    // ── Historial ─────────────────────────────────────────────
    mermasRecientes:       [],
    cargandoMermas:        false,

    // ─────────────────────────────────────────────────────────

    abrirMerma() {
      this.errorMerma      = ''
      this.mermaBusqueda   = ''
      this.mermaResultados = []
      this.mermaDropVisible = false
      const hoy = new Date().toISOString().slice(0, 10)
      this.mermaForm = {
        id_producto: null, nombre_producto: '', unidad_producto: '',
        stock_actual: null, tipo: '', cantidad: '', fecha: hoy, motivo: '', notas: ''
      }
      this.modalMermaAbierto = true
    },

    cerrarMerma() {
      this.modalMermaAbierto = false
      this.errorMerma        = ''
    },

    async buscarProductoMerma() {
      const s = this.mermaBusqueda.trim()
      if (s.length < 1) { this.mermaResultados = []; this.mermaDropVisible = false; return }
      try {
        const r = await API.get(`/api/productos/buscar?q=${encodeURIComponent(s)}`)
        this.mermaResultados = r.data || []
        this.mermaDropVisible = this.mermaResultados.length > 0
      } catch {
        this.mermaResultados = []
      }
    },

    seleccionarProductoMerma(p) {
      this.mermaForm.id_producto     = p.id_producto
      this.mermaForm.nombre_producto = p.nombre_producto
      this.mermaForm.unidad_producto = p.unidad_producto
      this.mermaForm.stock_actual    = p.stock
      this.mermaBusqueda             = p.nombre_producto
      this.mermaDropVisible          = false
      this.mermaResultados           = []
      // Foco en cantidad
      this.$nextTick(() => {
        const el = document.getElementById('merma-cantidad')
        if (el) el.focus()
      })
    },

    limpiarProductoMerma() {
      this.mermaForm.id_producto     = null
      this.mermaForm.nombre_producto = ''
      this.mermaForm.unidad_producto = ''
      this.mermaForm.stock_actual    = null
      this.mermaBusqueda             = ''
    },

    calcStockResultante() {
      if (this.mermaForm.stock_actual == null) return null
      const cant = parseFloat(this.mermaForm.cantidad) || 0
      return Math.round((this.mermaForm.stock_actual - cant) * 1000) / 1000
    },

    async guardarMerma() {
      this.errorMerma = ''
      if (!this.mermaForm.id_producto)  { this.errorMerma = 'Selecciona un producto'; return }
      if (!this.mermaForm.tipo)          { this.errorMerma = 'Selecciona el tipo de merma'; return }
      const cant = parseFloat(this.mermaForm.cantidad)
      if (!cant || cant <= 0)            { this.errorMerma = 'Ingresa una cantidad válida'; return }
      if (cant > this.mermaForm.stock_actual)
        { this.errorMerma = `Cantidad mayor al stock disponible (${this.mermaForm.stock_actual} ${this.mermaForm.unidad_producto})`; return }
      if (!this.mermaForm.motivo.trim()) { this.errorMerma = 'El motivo es obligatorio'; return }

      this.guardandoMerma = true
      try {
        const r = await API.post('/api/mermas', {
          id_producto:    this.mermaForm.id_producto,
          tipo_merma:     this.mermaForm.tipo,
          cantidad_merma: cant,
          motivo:         this.mermaForm.motivo,
          fecha_merma:    this.mermaForm.fecha,
          notas:          this.mermaForm.notas || undefined
        })
        if (!r.ok) { this.errorMerma = r.error || 'Error al guardar'; return }
        this.cerrarMerma()
        this.mostrarToast(`Merma registrada — ${r.nombre_producto}`)
        // Refrescar stock en inventario
        await this.cargarProductos()
        await this.cargarResumen()
        await this.cargarMermasRecientes()
      } catch (e) {
        this.errorMerma = e.message || 'Error de conexión'
      } finally {
        this.guardandoMerma = false
      }
    },

    async cargarMermasRecientes() {
      this.cargandoMermas = true
      try {
        const r = await API.get('/api/mermas/recientes')
        this.mermasRecientes = r.data || []
      } catch {
        this.mermasRecientes = []
      } finally {
        this.cargandoMermas = false
      }
    },

    fmtTipoMerma(tipo) {
      const map = {
        VENCIMIENTO:       'Vencimiento',
        'DAÑO':            'Daño',
        ROBO:              'Robo',
        AJUSTE_INVENTARIO: 'Ajuste',
        OTRO:              'Otro'
      }
      return map[tipo] || tipo
    },

    colorTipoMerma(tipo) {
      const map = {
        VENCIMIENTO:       'text-orange-400',
        'DAÑO':            'text-red-400',
        ROBO:              'text-red-500',
        AJUSTE_INVENTARIO: 'text-blue-400',
        OTRO:              'text-slate-400'
      }
      return map[tipo] || 'text-slate-400'
    }
  }
}
