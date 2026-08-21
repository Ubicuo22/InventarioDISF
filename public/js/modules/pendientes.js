function pendientesModule() {
  return {
    pendientesHoy:      [],
    cargandoPendientes: false,
    pendientesAbiertos: [],   // folios expandidos

    // Edición de cantidad
    pendienteEditando:  null,
    pendienteEditCant:  '',

    // Cambio de producto
    pendienteCambiando: null,   // { folio, nombre, tipo, idGrupo, nombreGrupo }
    cambioQuery:        '',
    cambioResultados:   [],
    cambioBuscando:     false,

    // Modal de precio para producto sin precio en el grupo
    cambioPrecioModal:       null,   // { prod, folio, nombreViejo, tipo, idGrupo, nombreGrupo } | null
    cambioPrecioManual:      '',
    cambioPreciosGrupos:     [],
    cambioCargandoPrecios:   false,
    cambioPrecioGuardarGrupo: true,  // true = guardar en el grupo, false = solo esta nota

    // Resolución de faltante — pregunta llegó/no llegó
    pendienteResolviendo: null,   // { folio, nombre } | null

    async cargarPendientesHoy() {
      this.cargandoPendientes = true
      this.pendienteEditando  = null
      this.pendienteCambiando = null
      try {
        const r = await API.get('/api/ordenes/pendientes-hoy')
        if (r.ok) {
          this.pendientesHoy      = r.data || []
          this.pendientesAbiertos = this.pendientesHoy.map(o => o.folio_numero)
        } else {
          this.pendientesHoy = []
          this.mostrarToast(r.error || 'Error al cargar pendientes', true)
        }
      } catch (e) {
        this.pendientesHoy = []
        this.mostrarToast(e.message || 'Error de conexión', true)
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
      const orden = this.pendientesHoy.find(o => o.folio_numero === folio)
      this.pendienteCambiando = {
        folio,
        nombre:      item.nombre,
        tipo,
        idGrupo:     orden?.id_grupo    || null,
        nombreGrupo: orden?.nombre_grupo || ''
      }
      this.cambioQuery = ''
      this.cambioResultados = []
    },

    async buscarProductoCambio() {
      const q = this.cambioQuery.trim()
      if (q.length < 1) { this.cambioResultados = []; return }
      this.cambioBuscando = true
      try {
        const gid = this.pendienteCambiando?.idGrupo ? `&groupId=${this.pendienteCambiando.idGrupo}` : ''
        const r = await API.get(`/api/productos/buscar?q=${encodeURIComponent(q)}${gid}`)
        this.cambioResultados = r.data || []
      } catch {
        this.cambioResultados = []
      } finally {
        this.cambioBuscando = false
      }
    },

    async confirmarCambioProducto(prod) {
      if (!this.pendienteCambiando) return
      const { folio, nombre: nombreViejo, tipo, idGrupo, nombreGrupo } = this.pendienteCambiando
      const precio = parseFloat(prod.precio_final ?? prod.precio_base) || 0

      if (precio <= 0) {
        // Sin precio para este grupo — abrir modal de precio
        this.cambioPrecioModal = { prod, folio, nombreViejo, tipo, idGrupo, nombreGrupo }
        this.cambioPrecioManual       = ''
        this.cambioPreciosGrupos      = []
        this.cambioCargandoPrecios    = true
        this.cambioPrecioGuardarGrupo = true
        this.pendienteCambiando       = null
        this.cambioQuery              = ''
        this.cambioResultados         = []
        try {
          const r = await API.get(`/api/productos/${prod.id_producto}/precios-grupos`)
          this.cambioPreciosGrupos = r.ok ? (r.data || []) : []
        } catch { /* silent */ }
        finally { this.cambioCargandoPrecios = false }
        return
      }

      this.pendienteCambiando = null
      this.cambioQuery        = ''
      this.cambioResultados   = []
      await this._aplicarCambioProducto({ prod, folio, nombreViejo, tipo, precio })
    },

    async confirmarCambioPrecioManual() {
      if (!this.cambioPrecioModal) return
      const precio = parseFloat(this.cambioPrecioManual)
      if (!precio || precio <= 0) return

      const { prod, folio, nombreViejo, tipo, idGrupo } = this.cambioPrecioModal
      const guardarGrupo = this.cambioPrecioGuardarGrupo
      this.cambioPrecioModal = null

      if (guardarGrupo && idGrupo) {
        API.post('/api/productos/precio-rapido', {
          id_producto: prod.id_producto,
          id_grupo:    idGrupo,
          precio_base: precio
        }).catch(e => console.warn('precio-rapido:', e.message))
      }

      await this._aplicarCambioProducto({ prod, folio, nombreViejo, tipo, precio })
    },

    async _aplicarCambioProducto({ prod, folio, nombreViejo, tipo, precio }) {
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

      try {
        const r = await API.patch(`/api/ordenes/${folio}/cambiar-item`, {
          nombre_viejo: nombreViejo,
          id_nuevo:     prod.id_producto,
          nombre_nuevo: prod.nombre_producto,
          unidad_nueva: prod.unidad_producto,
          precio_nuevo: precio || null
        })
        if (!r.ok) throw new Error(r.error || 'Error')
        this.mostrarToast(`Cambiado a ${prod.nombre_producto}`)
      } catch (e) {
        await this.cargarPendientesHoy()
        this.mostrarToast(e.message || 'Error al cambiar', true)
      }
    },

    // ── Resolver / resolver todos ────────────────────────────
    // Para pendientes resuelve directo. Para faltantes abre la pregunta
    // llegó / no llegó (resolverFaltanteCon).
    async resolverPendiente(folio, tipo, nombre_producto) {
      if (tipo === 'faltante') {
        // Toggle de la pregunta llegó/no llegó
        if (this.pendienteResolviendo?.folio === folio && this.pendienteResolviendo?.nombre === nombre_producto) {
          this.pendienteResolviendo = null
        } else {
          this.pendienteResolviendo = { folio, nombre: nombre_producto }
          this.pendienteEditando = null
          this.pendienteCambiando = null
        }
        return
      }
      await this._resolverItem(folio, tipo, nombre_producto, undefined)
    },

    /** Resuelve un faltante indicando si llegó (true → se reintegra a la nota). */
    async resolverFaltanteCon(llego) {
      if (!this.pendienteResolviendo) return
      const { folio, nombre } = this.pendienteResolviendo
      this.pendienteResolviendo = null
      await this._resolverItem(folio, 'faltante', nombre, llego)
    },

    async _resolverItem(folio, tipo, nombre_producto, llego) {
      const orden = this.pendientesHoy.find(o => o.folio_numero === folio)
      if (!orden) return
      if (this.pendienteEditando?.nombre === nombre_producto) this.pendienteEditando = null
      if (this.pendienteCambiando?.nombre === nombre_producto) this.pendienteCambiando = null

      const campo = tipo === 'pendiente' ? 'pendientes' : 'faltantes'
      // Quitar UNA ocurrencia (puede haber duplicados del mismo nombre)
      const rIdx = orden[campo].findIndex(i => i.nombre === nombre_producto)
      if (rIdx >= 0) orden[campo].splice(rIdx, 1)
      if (orden.pendientes.length === 0 && orden.faltantes.length === 0) {
        this.pendientesHoy     = this.pendientesHoy.filter(o => o.folio_numero !== folio)
        this.pendientesAbiertos = this.pendientesAbiertos.filter(f => f !== folio)
      }

      try {
        const body = { tipo, nombre_producto }
        if (llego !== undefined) body.llego = llego
        const r = await API.patch(`/api/ordenes/${folio}/pendiente`, body)
        if (!r.ok) throw new Error(r.error || 'Error')
        if (llego === true) {
          this.mostrarToast(r.reintegrado
            ? `${nombre_producto} reintegrado a la nota`
            : `${nombre_producto} resuelto — agrégalo a la nota a mano (faltante sin datos de cantidad)`, !r.reintegrado)
        } else if (llego === false) {
          this.mostrarToast(`${nombre_producto} marcado como no llegó`)
        }
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
