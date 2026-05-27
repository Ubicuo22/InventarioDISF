/**
 * DISFRULEG BODEGA — Módulo de Análisis de Ventas
 *
 * Dependencias implícitas (resueltas en el objeto merged de bodega.js):
 *   llama: mostrarToast (ui), fmtFecha (history), API (global)
 */

function analyticsModule() {
  return {
    // ── Estado ────────────────────────────────────────────────
    analyticsTab:      'hoy',   // 'hoy' | 'periodo'
    cargandoAnalytics: false,

    // ── Ventas del día ────────────────────────────────────────
    ventasHoy: null,

    // ── Lista de notas del día ────────────────────────────────
    notasHoy:       [],
    notasFecha:     null,   // fecha YYYY-MM-DD que está en memoria
    notasFiltro:    '',     // búsqueda rápida por cliente/grupo
    notaDetalle:    null,   // nota abierta en sheet de detalle

    // ── Período personalizado ─────────────────────────────────
    periodoInicio:  '',
    periodoFin:     '',
    ventasPeriodo:  null,
    topProductos:   [],

    // ── Inicialización (llamada al abrir el tab) ──────────────
    async cargarVentasHoy() {
      this.cargandoAnalytics = true
      try {
        const hoy = new Date().toISOString().split('T')[0]
        const [r, rn] = await Promise.all([
          API.get('/api/analytics/hoy'),
          API.get(`/api/analytics/notas?fecha=${hoy}`)
        ])
        this.ventasHoy = r.ok  ? r.data  : null
        this.notasHoy  = rn.ok ? rn.data : []
        this.notasFecha = hoy
        if (!r.ok) this.mostrarToast(r.error || 'Error al cargar ventas del día', true)
      } catch (err) {
        this.mostrarToast(err.message || 'Error de red', true)
        this.ventasHoy = null
        this.notasHoy  = []
      } finally {
        this.cargandoAnalytics = false
      }
    },

    // ── Lista filtrada de notas ───────────────────────────────
    notasHoyFiltradas() {
      const q = (this.notasFiltro || '').toLowerCase().trim()
      if (!q) return this.notasHoy
      return this.notasHoy.filter(n =>
        (n.nombre_cliente || '').toLowerCase().includes(q) ||
        (n.nombre_grupo   || '').toLowerCase().includes(q)
      )
    },

    // ── Hora corta de una nota, p.ej. "14:32" ────────────────
    notaHora(fechaISO) {
      if (!fechaISO) return ''
      const d = new Date(fechaISO)
      return d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
    },

    // ── Cargar análisis por período ───────────────────────────
    async cargarVentasPeriodo() {
      if (!this.periodoInicio || !this.periodoFin) {
        this.mostrarToast('Selecciona fecha inicio y fin', true)
        return
      }
      if (this.periodoInicio > this.periodoFin) {
        this.mostrarToast('La fecha inicio debe ser anterior a la fecha fin', true)
        return
      }
      this.cargandoAnalytics = true
      try {
        const params = `fechaInicio=${this.periodoInicio}&fechaFin=${this.periodoFin}`
        const [r, rt] = await Promise.all([
          API.get(`/api/analytics/periodo?${params}`),
          API.get(`/api/analytics/top-productos?${params}`)
        ])
        this.ventasPeriodo = r.ok  ? r.data  : null
        this.topProductos  = rt.ok ? rt.data : []
        if (!r.ok) this.mostrarToast(r.error || 'Error al cargar período', true)
      } catch (err) {
        this.mostrarToast(err.message || 'Error de red', true)
      } finally {
        this.cargandoAnalytics = false
      }
    },

    // ── Accesos rápidos de fechas ─────────────────────────────
    periodoRapidoHoy() {
      const hoy = new Date().toISOString().split('T')[0]
      this.periodoInicio = hoy
      this.periodoFin    = hoy
      this.cargarVentasPeriodo()
    },

    periodoRapidoSemana() {
      const hoy   = new Date()
      const inicio = new Date(hoy)
      inicio.setDate(hoy.getDate() - 6)
      this.periodoInicio = inicio.toISOString().split('T')[0]
      this.periodoFin    = hoy.toISOString().split('T')[0]
      this.cargarVentasPeriodo()
    },

    periodoRapidoMes() {
      const hoy    = new Date()
      const inicio = new Date(hoy.getFullYear(), hoy.getMonth(), 1)
      this.periodoInicio = inicio.toISOString().split('T')[0]
      this.periodoFin    = hoy.toISOString().split('T')[0]
      this.cargarVentasPeriodo()
    },

    // ── Formato de dinero ─────────────────────────────────────
    fmtMoney(v) {
      return `$${(parseFloat(v) || 0).toLocaleString('es-MX', {
        minimumFractionDigits:  2,
        maximumFractionDigits:  2
      })}`
    },

    // ── Formato de número de cantidad ─────────────────────────
    fmtCantidad(v) {
      const n = parseFloat(v) || 0
      return n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)
    }
  }
}
