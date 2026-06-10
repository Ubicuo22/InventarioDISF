function pendientesModule() {
  return {
    pendientesHoy:      [],
    cargandoPendientes: false,

    async cargarPendientesHoy() {
      this.cargandoPendientes = true
      try {
        const r = await API.get('/api/ordenes/pendientes-hoy')
        this.pendientesHoy = r.data || []
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

    async resolverPendiente(folio, tipo, nombre_producto) {
      const orden = this.pendientesHoy.find(o => o.folio_numero === folio)
      if (!orden) return

      // Optimistic update
      const campo = tipo === 'pendiente' ? 'pendientes' : 'faltantes'
      orden[campo] = orden[campo].filter(n => n !== nombre_producto)
      if (orden.pendientes.length === 0 && orden.faltantes.length === 0) {
        this.pendientesHoy = this.pendientesHoy.filter(o => o.folio_numero !== folio)
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
      // Optimistic: remove order from list immediately
      this.pendientesHoy = this.pendientesHoy.filter(o => o.folio_numero !== folio)
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
