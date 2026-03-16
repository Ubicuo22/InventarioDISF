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

    // ── Período personalizado ─────────────────────────────────
    periodoInicio:  '',
    periodoFin:     '',
    ventasPeriodo:  null,
    topProductos:   [],

    // ── Inicialización (llamada al abrir el tab) ──────────────
    async cargarVentasHoy() {
      this.cargandoAnalytics = true
      try {
        const r = await API.get('/api/analytics/hoy')
        this.ventasHoy = r.ok ? r.data : null
        if (!r.ok) this.mostrarToast(r.error || 'Error al cargar ventas del día', true)
      } catch (err) {
        this.mostrarToast(err.message || 'Error de red', true)
        this.ventasHoy = null
      } finally {
        this.cargandoAnalytics = false
      }
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
