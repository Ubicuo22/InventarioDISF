function historyModule() {
  return {
    entradas: [],
    cargandoEntradas: false,

    async cargarEntradasRecientes() {
      this.cargandoEntradas = true
      try {
        const r = await API.get('/api/entradas/recientes')
        this.entradas = r.data || []
      } catch (err) {
        this.entradas = []
        this.mostrarToast(err.message || 'Error al cargar historial', true)
      } finally {
        this.cargandoEntradas = false
      }
    },

    fmtFecha(f) {
      if (!f) return '—'
      const d = new Date(f)
      const utc = new Date(d.getTime() + d.getTimezoneOffset() * 60000)
      return utc.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: '2-digit' })
    }
  }
}
