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

    async abrirNuevaOrden() {
      if (!this.grupos.length) await this.cargarGrupos()
      this.ordenForm          = { folio_numero: null, id_grupo: '', id_cliente: '', nombreCliente: '', nombreGrupo: '' }
      this.ordenCarrito       = { General: [] }
      this.seccionActual      = 'General'
      this.nuevaSeccionNombre = ''
      this.mostrarNuevaSeccion = false
      this.errorOrden         = ''
      this.ordenBusqueda      = ''
      this.ordenResultados    = []
      this.clientesGrupo      = []
      this.modalOrdenAbierto  = true
    },

    async abrirEditarOrden(orden) {
      this.errorOrden          = ''
      this.ordenBusqueda       = ''
      this.ordenResultados     = []
      this.nuevaSeccionNombre  = ''
      this.mostrarNuevaSeccion = false
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
