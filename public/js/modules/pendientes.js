function pendientesModule() {
  return {
    pendientesHoy:      [],
    cargandoPendientes: false,
    pendientesAbiertos: [],   // folios expandidos

    // Edición de cantidad
    pendienteEditando:  null,
    pendienteEditCant:  '',

    // Cambio de producto
    pendienteCambiando: null,
    cambioQuery:        '',
    cambioResultados:   [],
    cambioBuscando:     false,

    async cargarPendientesHoy() {
      this.cargandoPendientes = true
      this.pendienteEditando  = null
      this.pendienteCambiando = null
      try {
        const r = await API.get('/api/ordenes/pendientes-hoy')
        this.pendientesHoy     = r.data || []
        // Expandir todos por defecto
        this.pendientesAbiertos = this.pendientesHoy.map(o => o.folio_numero)
      } catch {
        this.pendientesHoy = []
      } finally {
        this.cargandoPendientes = false
      }
    },

    pendientesTotalCount() {
      return this.pendientesHoy.reduce(
        (acc, o) => acc + o.pendientes.length + o.faltantes.length, 0
      )
    },

    togglePendiente(folio) {
      if (this.pendientesAbiertos.includes(folio)) {
        this.pendientesAbiertos = this.pendientesAbiertos.filter(f => f !== folio)
        if (this.pendienteEditando?.folio === folio)  this.pendienteEditando  = null
        if (this.pendienteCambiando?.folio === folio) this.pendienteCambiando = null
      } else {
        this.pendientesAbiertos = [...this.pendientesAbiertos, folio]
      }
    },

    estaAbierto(folio) {
      return this.pendientesAbiertos.includes(folio)
    },

    // Agrupa array de items [{nombre,cantidad,unidad,seccion}] por sección
    agruparPorSeccion(items) {
      const map = {}
      for (const item of items) {
        const sec = item.seccion || 'Sin sección'
        if (!map[sec]) map[sec] = []
        map[sec].push(item)
      }
      return Object.keys(map).map(sec => ({ seccion: sec, items: map[sec] }))
    },

    // ── Editar cantidad ──────────────────────────────────────
    abrirEdicionCantidad(folio, item, tipo) {
      this.pendienteCambiando = null
      if (this.pendienteEditando?.folio === folio && this.pendienteEditando?.nombre === item.nombre) {
        this.pendienteEditando = null
        return
      }
      this.pendienteEditando = { folio, nombre: item.nombre, tipo }
      this.pendienteEditCant = item.cantidad != null ? String(item.cantidad) : ''
    },

    async guardarCantidadPendiente() {
      if (!this.pendienteEditando) return
      const cant = parseFloat(this.pendienteEditCant)
      if (isNaN(cant) || cant < 0) { this.pendienteEditando = null; return }

      const { folio, nombre, tipo } = this.pendienteEditando
      const orden = this.pendientesHoy.find(o => o.folio_numero === folio)
      if (orden) {
        const campo = tipo === 'pendiente' ? 'pendientes' : 'faltantes'
        const item = orden[campo].find(i => i.nombre === nombre)
        if (item) item.cantidad = cant
      }
      this.pendienteEditando = null

      try {
        const r = await API.patch(`/api/ordenes/${folio}/item-cantidad`, { nombre_producto: nombre, cantidad: cant })
        if (!r.ok) throw new Error(r.error || 'Error')
      } catch (e) {
        await this.cargarPendientesHoy()
        this.mostrarToast(e.message || 'Error al guardar', true)
      }
    },

    // ── Mover pendiente → faltante ───────────────────────────
    async moverAFaltante(folio, nombre) {
      const orden = this.pendientesHoy.find(o => o.folio_numero === folio)
      if (!orden) return
      if (this.pendienteEditando?.nombre === nombre) this.pendienteEditando = null
      if (this.pendienteCambiando?.nombre === nombre) this.pendienteCambiando = null

      const item = orden.pendientes.find(i => i.nombre === nombre)
      orden.pendientes = orden.pendientes.filter(i => i.nombre !== nombre)
      if (item) orden.faltantes.push(item)

      try {
        const r = await API.patch(`/api/ordenes/${folio}/mover-a-faltante`, { nombre_producto: nombre })
        if (!r.ok) throw new Error(r.error || 'Error')
      } catch (e) {
        await this.cargarPendientesHoy()
        this.mostrarToast(e.message || 'Error al mover', true)
      }
    },

    // ── Cambiar producto ─────────────────────────────────────
    abrirCambioProducto(folio, item, tipo) {
      this.pendienteEditando = null
      if (this.pendienteCambiando?.folio === folio && this.pendienteCambiando?.nombre === item.nombre) {
        this.pendienteCambiando = null
        this.cambioQuery = ''
        this.cambioResultados = []
        return
      }
      this.pendienteCambiando = { folio, nombre: item.nombre, tipo }
      this.cambioQuery = ''
      this.cambioResultados = []
    },

    async buscarProductoCambio() {
      const q = this.cambioQuery.trim()
      if (q.length < 1) { this.cambioResultados = []; return }
      this.cambioBuscando = true
      try {
        const r = await API.get(`/api/productos/buscar?q=${encodeURIComponent(q)}`)
        this.cambioResultados = r.data || []
      } catch {
        this.cambioResultados = []
      } finally {
        this.cambioBuscando = false
      }
    },

    async confirmarCambioProducto(prod) {
      if (!this.pendienteCambiando) return
      const { folio, nombre: nombreViejo, tipo } = this.pendienteCambiando

      const orden = this.pendientesHoy.find(o => o.folio_numero === folio)
      if (orden) {
        const campo = tipo === 'pendiente' ? 'pendientes' : 'faltantes'
        const idx = orden[campo].findIndex(i => i.nombre === nombreViejo)
        if (idx !== -1) {
          orden[campo][idx] = {
            nombre:   prod.nombre_producto,
            cantidad: orden[campo][idx].cantidad,
            unidad:   prod.unidad_producto || orden[campo][idx].unidad,
            seccion:  orden[campo][idx].seccion
          }
        }
      }

      this.pendienteCambiando = null
      this.cambioQuery = ''
      this.cambioResultados = []

      try {
        const r = await API.patch(`/api/ordenes/${folio}/cambiar-item`, {
          nombre_viejo: nombreViejo,
          id_nuevo:     prod.id_producto,
          nombre_nuevo: prod.nombre_producto,
          unidad_nueva: prod.unidad_producto
        })
        if (!r.ok) throw new Error(r.error || 'Error')
        this.mostrarToast(`Cambiado a ${prod.nombre_producto}`)
      } catch (e) {
        await this.cargarPendientesHoy()
        this.mostrarToast(e.message || 'Error al cambiar', true)
      }
    },

    // ── Resolver / resolver todos ────────────────────────────
    async resolverPendiente(folio, tipo, nombre_producto) {
      const orden = this.pendientesHoy.find(o => o.folio_numero === folio)
      if (!orden) return
      if (this.pendienteEditando?.nombre === nombre_producto) this.pendienteEditando = null
      if (this.pendienteCambiando?.nombre === nombre_producto) this.pendienteCambiando = null

      const campo = tipo === 'pendiente' ? 'pendientes' : 'faltantes'
      orden[campo] = orden[campo].filter(i => i.nombre !== nombre_producto)
      if (orden.pendientes.length === 0 && orden.faltantes.length === 0) {
        this.pendientesHoy     = this.pendientesHoy.filter(o => o.folio_numero !== folio)
        this.pendientesAbiertos = this.pendientesAbiertos.filter(f => f !== folio)
      }

      try {
        const r = await API.patch(`/api/ordenes/${folio}/pendiente`, { tipo, nombre_producto })
        if (!r.ok) throw new Error(r.error || 'Error')
      } catch (e) {
        await this.cargarPendientesHoy()
        this.mostrarToast(e.message || 'Error al resolver', true)
      }
    },

    async resolverTodosOrden(folio) {
      this.pendientesHoy      = this.pendientesHoy.filter(o => o.folio_numero !== folio)
      this.pendientesAbiertos = this.pendientesAbiertos.filter(f => f !== folio)
      this.pendienteEditando  = null
      this.pendienteCambiando = null
      try {
        const r = await API.patch(`/api/ordenes/${folio}/resolver-todos`)
        if (!r.ok) throw new Error(r.error || 'Error')
        this.mostrarToast('Todos los pendientes resueltos')
      } catch (e) {
        await this.cargarPendientesHoy()
        this.mostrarToast(e.message || 'Error al resolver', true)
      }
    }
  }
}
