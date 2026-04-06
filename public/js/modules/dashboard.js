/**
 * dashboard.js — Módulo Alpine.js para el panel de métricas del día (pantalla home)
 *
 * Carga una sola llamada a /api/dashboard/metricas-hoy con:
 *   pedidos · ventas · compras · mermas · stock crítico · deudas vencidas
 */

function dashboardModule() {
  return {
    // ── Estado ────────────────────────────────────────────
    dashMetricas:  null,       // respuesta completa del endpoint
    dashCargando:  false,
    dashTs:        null,       // Date del último refresh exitoso

    // ── Carga ─────────────────────────────────────────────
    async cargarDashboard() {
      this.dashCargando = true
      try {
        const r = await API.get('/api/dashboard/metricas-hoy')
        if (r.ok) {
          this.dashMetricas = r
          this.dashTs       = new Date()
        }
      } catch { /* silent — no romper la carga inicial */ }
      finally  { this.dashCargando = false }
    },

    // ── Helpers de presentación ───────────────────────────

    /** Hora del último refresh, p.ej. "10:23" */
    dashUltimaHora() {
      if (!this.dashTs) return ''
      return this.dashTs.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
    },

    /** Fecha larga localizada, p.ej. "sábado, 5 de abril" */
    dashFechaHoy() {
      return new Date().toLocaleDateString('es-MX', {
        weekday: 'long', day: 'numeric', month: 'long'
      })
    },

    /**
     * Formato compacto de dinero para las tarjetas pequeñas.
     * $0 → $0 · $850 → $850 · $1500 → $1.5k · $12500 → $12.5k · $1200000 → $1.2M
     */
    dashFmtMoney(n) {
      const v = parseFloat(n) || 0
      if (v === 0) return '$0'
      if (v >= 1_000_000) return '$' + (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
      if (v >= 10_000)    return '$' + Math.round(v / 1_000) + 'k'
      if (v >= 1_000)     return '$' + (v / 1_000).toFixed(1).replace(/\.0$/, '') + 'k'
      return '$' + Math.round(v).toLocaleString('es-MX')
    }
  }
}
