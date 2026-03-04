function ordersModule() {
  return {
    ordenes: [],
    cargandoOrdenes: false,
    grupos: [],
    clientesGrupo: [],
    modalOrdenAbierto: false,
    guardandoOrden: false,
    errorOrden: '',
    ordenBusqueda: '',
    ordenResultados: [],
    ordenForm: {},
    ordenCarrito: { General: [] },
    seccionActual: 'General',
    nuevaSeccionNombre: '',
    mostrarNuevaSeccion: false,

    // ── Estado UbicuoAI ──────────────────────────────────────
    modoIA: false,
    textoIA: '',
    analizando: false,
    resultadoIA: null,
    iaResultados: [],          // copia mutable de secciones para edición interactiva
    iaCambiarModal: {
      visible: false,
      secIdx: -1,
      prodIdx: -1,
      busqueda: '',
      resultados: [],
      buscando: false,
      seleccionado: null
    },

    // ─────────────────────────────────────────────────────────

    async cargarOrdenes() {
      this.cargandoOrdenes = true
      try {
        const estado = this.pedidosTab === 'registrados' ? 'registrada' : 'guardada'
        const r = await API.get(`/api/ordenes?estado=${estado}`)
        this.ordenes = r.data || []
      } catch (err) {
        this.ordenes = []
        this.mostrarToast(err.message || 'Error al cargar pedidos', true)
      } finally {
        this.cargandoOrdenes = false
      }
    },

    async cargarGrupos() {
      try {
        const r = await API.get('/api/clientes/grupos')
        this.grupos = r.data || []
      } catch (err) {
        this.mostrarToast(err.message || 'Error al cargar grupos', true)
      }
    },

    async cargarClientesPorGrupo() {
      this.clientesGrupo = []
      this.ordenForm.id_cliente = ''
      if (!this.ordenForm.id_grupo) return
      try {
        const r = await API.get(`/api/clientes?groupId=${this.ordenForm.id_grupo}`)
        this.clientesGrupo = r.data || []
      } catch (err) {
        this.mostrarToast(err.message || 'Error al cargar clientes', true)
      }
    },

    actualizarNombreCliente() {
      const c = this.clientesGrupo.find(c => c.id_cliente == this.ordenForm.id_cliente)
      const g = this.grupos.find(g => g.id_grupo == this.ordenForm.id_grupo)
      this.ordenForm.nombreCliente = c ? c.nombre_cliente : ''
      this.ordenForm.nombreGrupo   = g ? g.nombre_grupo   : ''
    },

    _resetIA() {
      this.modoIA      = false
      this.textoIA     = ''
      this.analizando  = false
      this.resultadoIA = null
      this.iaResultados = []
      this.iaCambiarModal = {
        visible: false, secIdx: -1, prodIdx: -1,
        busqueda: '', resultados: [], buscando: false, seleccionado: null
      }
    },

    async abrirNuevaOrden() {
      if (!this.grupos.length) await this.cargarGrupos()
      this.ordenForm           = { folio_numero: null, id_grupo: '', id_cliente: '', nombreCliente: '', nombreGrupo: '' }
      this.ordenCarrito        = { General: [] }
      this.seccionActual       = 'General'
      this.nuevaSeccionNombre  = ''
      this.mostrarNuevaSeccion = false
      this.errorOrden          = ''
      this.ordenBusqueda       = ''
      this.ordenResultados     = []
      this.clientesGrupo       = []
      this._resetIA()
      this.modalOrdenAbierto   = true
    },

    async abrirEditarOrden(orden) {
      this.errorOrden          = ''
      this.ordenBusqueda       = ''
      this.ordenResultados     = []
      this.nuevaSeccionNombre  = ''
      this.mostrarNuevaSeccion = false
      this._resetIA()
      try {
        const r = await API.get(`/api/ordenes/${orden.folio_numero}`)
        if (!r.ok) { this.mostrarToast('Error al cargar el pedido', true); return }
        const o = r.data
        this.ordenForm = {
          folio_numero:  o.folio_numero,
          id_cliente:    o.id_cliente,
          id_grupo:      o.id_grupo,
          nombreCliente: o.nombre_cliente,
          nombreGrupo:   o.nombre_grupo
        }
        // Preservar secciones tal como vienen del DB (compatibilidad con electron)
        const cart = (typeof o.datos_carrito === 'string')
          ? JSON.parse(o.datos_carrito) : (o.datos_carrito || {})
        this.ordenCarrito  = Object.keys(cart).length ? cart : { General: [] }
        this.seccionActual = this.sectionNames()[0] || 'General'
        this.modalOrdenAbierto = true
      } catch (err) {
        this.mostrarToast(err.message || 'Error al cargar el pedido', true)
      }
    },

    cerrarOrden() {
      this.modalOrdenAbierto   = false
      this.ordenForm           = {}
      this.ordenCarrito        = { General: [] }
      this.seccionActual       = 'General'
      this.nuevaSeccionNombre  = ''
      this.mostrarNuevaSeccion = false
      this.errorOrden          = ''
      this.ordenBusqueda       = ''
      this.ordenResultados     = []
      this._resetIA()
    },

    // Retorna los nombres de sección con General siempre primero
    sectionNames() {
      const keys = Object.keys(this.ordenCarrito)
      if (keys.includes('General')) {
        return ['General', ...keys.filter(k => k !== 'General')]
      }
      return keys
    },

    // Lista plana de todos los items (para conteo y total)
    cartItems() {
      return Object.values(this.ordenCarrito).flat()
    },

    async buscarProductoPedido() {
      const s = this.ordenBusqueda.trim()
      if (!s) { this.ordenResultados = []; return }
      try {
        const gid = this.ordenForm.id_grupo || ''
        const r = await API.get(`/api/productos/buscar?q=${encodeURIComponent(s)}&groupId=${gid}`)
        this.ordenResultados = r.data || []
      } catch (err) {
        this.ordenResultados = []
        this.mostrarToast(err.message || 'Error al buscar productos', true)
      }
    },

    agregarAlCarrito(producto) {
      const sec = this.seccionActual || 'General'
      if (!this.ordenCarrito[sec]) this.ordenCarrito[sec] = []
      const existing = this.ordenCarrito[sec].find(i => i.id_producto === producto.id_producto)
      if (existing) {
        existing.cantidad += 1
      } else {
        this.ordenCarrito[sec].push({
          id_producto:     producto.id_producto,
          nombre_producto: producto.nombre_producto,
          unidad:          producto.unidad_producto,
          cantidad:        1,
          precio_unitario: parseFloat(producto.precio_base) || 0,
          seccion:         sec
        })
      }
      this.ordenBusqueda   = ''
      this.ordenResultados = []
    },

    quitarDelCarrito(seccion, idx) {
      if (!this.ordenCarrito[seccion]) return
      this.ordenCarrito[seccion].splice(idx, 1)
    },

    agregarSeccion() {
      const nombre = this.nuevaSeccionNombre.trim()
      if (!nombre) return
      if (!this.ordenCarrito[nombre]) {
        this.ordenCarrito[nombre] = []
      }
      this.seccionActual       = nombre
      this.nuevaSeccionNombre  = ''
      this.mostrarNuevaSeccion = false
    },

    calcTotalOrden() {
      return this.cartItems().reduce((sum, item) =>
        sum + ((item.cantidad || 0) * (item.precio_unitario || 0)), 0)
    },

    // ══════════════════════════════════════════════════════════
    // UBICUOAI — FASE 2
    // ══════════════════════════════════════════════════════════

    toggleModoIA() {
      this.modoIA = !this.modoIA
      if (!this.modoIA) this._resetIA()
    },

    async analizarTexto() {
      const text = this.textoIA.trim()
      if (!text) return
      this.analizando   = true
      this.resultadoIA  = null
      this.iaResultados = []
      try {
        const r = await API.post('/api/ubicuoai/analizar', {
          text,
          groupId: this.ordenForm.id_grupo || null
        })
        if (!r.ok) { this.mostrarToast(r.error || 'Error al analizar', true); return }
        this.resultadoIA  = r.data
        // Copia mutable profunda para edición interactiva
        this.iaResultados = JSON.parse(JSON.stringify(r.data.secciones || []))
      } catch (e) {
        this.mostrarToast(e.message || 'Error de conexión', true)
      } finally {
        this.analizando = false
      }
    },

    // ── Conteos y totales ────────────────────────────────────

    iaSinMatchCount() {
      return this.iaResultados.reduce((sum, sec) =>
        sec.productos.reduce((s, p) => s + (p.tipo === 'sin_match' ? 1 : 0), sum), 0)
    },

    iaMatchCount() {
      return this.iaResultados.reduce((sum, sec) =>
        sec.productos.reduce((s, p) => s + (p.tipo !== 'sin_match' && p.producto_id ? 1 : 0), sum), 0)
    },

    iaTotalIA() {
      let total = 0
      for (const sec of this.iaResultados) {
        for (const p of sec.productos) {
          if (p.tipo !== 'sin_match' && p.precio) {
            total += (parseFloat(p.cantidad) || 1) * parseFloat(p.precio)
          }
        }
      }
      return total
    },

    // ── Edición de productos en iaResultados ─────────────────

    iaEliminarProducto(secIdx, prodIdx) {
      this.iaResultados[secIdx].productos.splice(prodIdx, 1)
      if (this.iaResultados[secIdx].productos.length === 0) {
        this.iaResultados.splice(secIdx, 1)
      }
    },

    // Convierte un sin_match en sección: saca todos los productos
    // subsiguientes de la sección actual y los mueve a la nueva sección
    iaMarcarSeccion(secIdx, prodIdx) {
      const sec        = this.iaResultados[secIdx]
      const prod       = sec.productos[prodIdx]
      const nombreNueva = prod.texto_original || 'Nueva sección'
      const nuevaSecId  = `sec-user-${Date.now()}`

      // Todos los productos a partir de este (inclusive) se mueven a la nueva sección
      const productosDespues = sec.productos.splice(prodIdx)
      productosDespues.shift()   // quitar el item sin_match (se convierte en encabezado)

      const nuevaSec = {
        id: nuevaSecId,
        nombre: nombreNueva,
        productos: productosDespues,
        seleccionada: true
      }
      this.iaResultados.splice(secIdx + 1, 0, nuevaSec)

      // Limpiar secciones vacías excepto la recién creada
      this.iaResultados = this.iaResultados.filter(s =>
        s.productos.length > 0 || s.id === nuevaSecId
      )
      this.mostrarToast(`Sección "${nombreNueva}" creada`)
    },

    iaEditarCantidad(secIdx, prodIdx, value) {
      const v = parseFloat(value)
      if (!isNaN(v) && v > 0) {
        this.iaResultados[secIdx].productos[prodIdx].cantidad = v
      }
    },

    // ── Modal buscar/cambiar producto ────────────────────────

    iaAbrirCambiar(secIdx, prodIdx) {
      const prod = this.iaResultados[secIdx].productos[prodIdx]
      this.iaCambiarModal = {
        visible:      true,
        secIdx,
        prodIdx,
        busqueda:     prod.texto_original || '',
        resultados:   [],
        buscando:     false,
        seleccionado: null
      }
      // Auto-buscar con el texto del producto
      this.$nextTick(() => {
        document.getElementById('ia-search-input')?.focus()
        if (prod.texto_original?.length >= 2) this.iaBuscarProducto()
      })
    },

    async iaBuscarProducto() {
      const q = this.iaCambiarModal.busqueda.trim()
      if (q.length < 2) { this.iaCambiarModal.resultados = []; return }
      this.iaCambiarModal.buscando = true
      try {
        const gid = this.ordenForm.id_grupo || ''
        const r   = await API.get(
          `/api/productos/buscar?q=${encodeURIComponent(q)}&groupId=${gid}`
        )
        this.iaCambiarModal.resultados   = r.data || []
        this.iaCambiarModal.seleccionado = null
      } catch (e) {
        this.iaCambiarModal.resultados = []
      } finally {
        this.iaCambiarModal.buscando = false
      }
    },

    async iaConfirmarCambio() {
      const { secIdx, prodIdx, seleccionado } = this.iaCambiarModal
      if (!seleccionado) return

      const prod = this.iaResultados[secIdx].productos[prodIdx]

      // Guardar corrección al sistema de aprendizaje
      if (
        prod.texto_original &&
        prod.texto_original.toLowerCase() !== seleccionado.nombre_producto.toLowerCase()
      ) {
        try {
          await API.post('/api/ubicuoai/correccion', {
            incorrect: prod.texto_original,
            correct:   seleccionado.nombre_producto
          })
        } catch (e) { /* silent */ }
      }

      // Actualizar el producto en iaResultados (mantenemos otras props como cantidad)
      this.iaResultados[secIdx].productos[prodIdx] = {
        ...prod,
        tipo:            'perfecto',
        nombre_producto: seleccionado.nombre_producto,
        producto_id:     seleccionado.id_producto,
        unidad:          seleccionado.unidad_producto,
        precio:          parseFloat(seleccionado.precio_base) || 0,
        confianza:       100
      }

      this.iaCambiarModal = {
        visible: false, secIdx: -1, prodIdx: -1,
        busqueda: '', resultados: [], buscando: false, seleccionado: null
      }
    },

    // ── Confirmar: vuelca iaResultados al carrito ─────────────

    // Para compatibilidad con botón de confirmar antiguo (si se llama sin arg)
    iaConMatch() { return this.iaMatchCount() },

    confirmarIA() {
      for (const sec of this.iaResultados) {
        for (const prod of sec.productos) {
          if (prod.tipo === 'sin_match' || !prod.producto_id) continue

          const secName = sec.nombre || 'General'
          if (!this.ordenCarrito[secName]) this.ordenCarrito[secName] = []

          const existing = this.ordenCarrito[secName].find(
            i => i.id_producto === prod.producto_id
          )
          if (existing) {
            existing.cantidad += parseFloat(prod.cantidad) || 1
          } else {
            this.ordenCarrito[secName].push({
              id_producto:     prod.producto_id,
              nombre_producto: prod.nombre_producto,
              unidad:          prod.unidad || '',
              cantidad:        parseFloat(prod.cantidad) || 1,
              precio_unitario: parseFloat(prod.precio) || 0,
              seccion:         secName
            })
          }
        }
      }
      this.seccionActual = this.sectionNames()[0] || 'General'
      this._resetIA()
    },

    // ══════════════════════════════════════════════════════════

    async guardarOrden() {
      this.errorOrden = ''
      if (!this.ordenForm.id_cliente) { this.errorOrden = 'Selecciona un cliente'; return }
      if (this.cartItems().length === 0) { this.errorOrden = 'Agrega al menos un producto'; return }
      this.guardandoOrden = true
      try {
        const body = {
          id_cliente:    this.ordenForm.id_cliente,
          datos_carrito: this.ordenCarrito
        }
        if (this.ordenForm.folio_numero) body.folio_numero = this.ordenForm.folio_numero
        const r = await API.post('/api/ordenes', body)
        if (!r.ok) { this.errorOrden = r.error || 'Error al guardar'; return }
        this.cerrarOrden()
        this.mostrarToast(`Pedido #${String(r.folio_numero).padStart(4, '0')} guardado`)
        await this.cargarOrdenes()
      } catch (e) {
        this.errorOrden = e.message || 'Error de conexión'
      } finally {
        this.guardandoOrden = false
      }
    }
  }
}
