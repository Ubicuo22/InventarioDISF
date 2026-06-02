/**
 * dashboard.js — Módulo Alpine.js para el panel de métricas del día (pantalla home)
 *
 * Carga una sola llamada a /api/dashboard/metricas-hoy con:
 *   pedidos · ventas · compras · mermas · stock crítico · deudas vencidas
 *   tendencias vs ayer · pedidos por revisar · última entrada
 */

function dashboardModule() {
  return {
    // ── Estado ────────────────────────────────────────────
    dashMetricas:  null,       // respuesta completa del endpoint
    dashCargando:  false,
    dashTs:        null,       // Date del último refresh exitoso
    dashAnimNums:  {},         // valores animados de conteo { key: number }
    _dashAnimRaf:  null,

    // ── Carga ─────────────────────────────────────────────
    async cargarDashboard() {
      this.dashCargando = true
      try {
        const r = await API.get('/api/dashboard/metricas-hoy')
        if (r.ok) {
          this.dashMetricas = r
          this.dashTs       = new Date()
          this._dashAnimateNumbers()
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

    /** Fecha larga localizada, p.ej. "Miércoles, 27 de mayo" */
    dashFechaHoy() {
      const s = new Date().toLocaleDateString('es-MX', {
        weekday: 'long', day: 'numeric', month: 'long'
      })
      return s.charAt(0).toUpperCase() + s.slice(1)
    },

    /** ¿Llevan más de 5 minutos los datos sin refrescar? */
    dashDataStale() {
      if (!this.dashTs) return false
      return (Date.now() - this.dashTs.getTime()) > 5 * 60 * 1000
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
    },

    /**
     * Calcula delta porcentual entre actual y previo.
     * Retorna { pct: number, dir: '+'|'-'|null, label: string }
     * - Si previo = 0 y actual > 0 → muestra "nuevo"
     * - Si ambos 0 → null (no muestra nada)
     */
    dashTrend(actual, previo) {
      const a = parseFloat(actual) || 0
      const p = parseFloat(previo) || 0
      if (a === 0 && p === 0) return null
      if (p === 0)            return { pct: 100, dir: '+', label: 'nuevo' }
      const delta = ((a - p) / p) * 100
      const rounded = Math.round(Math.abs(delta))
      if (rounded === 0)      return { pct: 0, dir: null, label: '= ayer' }
      return {
        pct: rounded,
        dir: delta > 0 ? '+' : '-',
        label: `${delta > 0 ? '↑' : '↓'} ${rounded}% vs ayer`
      }
    },

    /** Tiempo relativo desde una fecha SQL, p.ej. "hace 2h" */
    dashTimeAgo(fecha) {
      if (!fecha) return ''
      const d = new Date(fecha)
      const diffMs = Date.now() - d.getTime()
      const min = Math.round(diffMs / 60000)
      if (min < 1) return 'ahora'
      if (min < 60) return `hace ${min}m`
      const h = Math.round(min / 60)
      if (h < 24) return `hace ${h}h`
      const days = Math.round(h / 24)
      if (days < 30) return `hace ${days}d`
      return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })
    },

    // ── Animación de conteo ───────────────────────────────
    /**
     * Anima de 0 al valor real las métricas numéricas principales (~400ms).
     * Usa requestAnimationFrame con easing cúbico.
     */
    _dashAnimateNumbers() {
      const targets = {
        pedidos_hoy:     this.dashMetricas?.pedidos?.total_hoy      || 0,
        pedidos_revisar: this.dashMetricas?.pedidos?.por_revisar    || 0,
        ventas:          this.dashMetricas?.ventas?.total_vendido   || 0,
        ganancia:        this.dashMetricas?.ventas?.ganancia_hoy    || 0,
        compras:         this.dashMetricas?.compras?.total_gasto    || 0,
        mermas:          this.dashMetricas?.mermas?.monto_perdido   || 0,
        deudas:          this.dashMetricas?.deudas?.monto_vencido   || 0,
        stock_critico:   this.dashMetricas?.stock?.criticos         || 0,
      }
      const start = { ...this.dashAnimNums }
      const t0 = performance.now()
      const dur = 400
      if (this._dashAnimRaf) cancelAnimationFrame(this._dashAnimRaf)
      const tick = (now) => {
        const t = Math.min(1, (now - t0) / dur)
        const eased = 1 - Math.pow(1 - t, 3)
        const next = {}
        for (const k in targets) {
          const s = start[k] || 0
          next[k] = s + (targets[k] - s) * eased
        }
        this.dashAnimNums = next
        if (t < 1) this._dashAnimRaf = requestAnimationFrame(tick)
      }
      this._dashAnimRaf = requestAnimationFrame(tick)
    },

    /** Valor animado para una métrica numérica entera */
    dashAnimInt(key) {
      const v = this.dashAnimNums?.[key]
      if (v == null) return '—'
      return Math.round(v).toLocaleString('es-MX')
    },

    /** Valor animado para una métrica de dinero (formato compacto) */
    dashAnimMoney(key) {
      const v = this.dashAnimNums?.[key]
      if (v == null) return '$0'
      return this.dashFmtMoney(v)
    },

    // ── Alertas críticas (banner arriba del bento) ─────────
    /**
     * Devuelve array de alertas accionables ordenadas por severidad.
     * Cada alerta: { tipo, color, mensaje, accion, onClick }
     */
    dashAlertas() {
      if (!this.dashMetricas) return []
      const out = []
      const m = this.dashMetricas

      // 1. Deudas vencidas (crítico)
      if ((m.deudas?.vencidas || 0) > 0) {
        out.push({
          tipo: 'deudas',
          color: 'red',
          mensaje: `${m.deudas.vencidas} ${m.deudas.vencidas === 1 ? 'deuda vencida' : 'deudas vencidas'}`,
          monto: this.dashFmtMoney(m.deudas.monto_vencido),
          accion: 'Ver',
          onClick: () => { this.tab = 'cobranza'; this.cargarDeudas?.() }
        })
      }

      // 2. Stock crítico (alto)
      if ((m.stock?.sin_stock || 0) > 0) {
        out.push({
          tipo: 'stock',
          color: 'orange',
          mensaje: `${m.stock.sin_stock} ${m.stock.sin_stock === 1 ? 'producto sin stock' : 'productos sin stock'}`,
          monto: '',
          accion: 'Ver',
          onClick: () => { this.tab = 'inventario' }
        })
      } else if ((m.stock?.criticos || 0) > 0) {
        out.push({
          tipo: 'stock_bajo',
          color: 'amber',
          mensaje: `${m.stock.criticos} con stock bajo`,
          monto: '',
          accion: 'Ver',
          onClick: () => { this.tab = 'inventario' }
        })
      }

      // 3. Lotes PEPS estancados (>60 días con stock)
      if ((m.lotes_antiguos || 0) > 0) {
        const n = m.lotes_antiguos
        out.push({
          tipo: 'lotes_antiguos',
          color: 'amber',
          mensaje: `${n} ${n === 1 ? 'producto con lote' : 'productos con lotes'} sin mover +60 días`,
          monto: '',
          accion: 'Ver',
          onClick: () => { this.tab = 'inventario' }
        })
      }

      // 4. Pedidos atrasados (medio)
      if ((m.pedidos?.atrasados || 0) > 0) {
        out.push({
          tipo: 'atrasados',
          color: 'amber',
          mensaje: `${m.pedidos.atrasados} ${m.pedidos.atrasados === 1 ? 'pedido pendiente hace más de 1 día' : 'pedidos pendientes hace más de 1 día'}`,
          monto: '',
          accion: 'Ver',
          onClick: () => { this.tab = 'pedidos'; this.pedidosTab = 'activos'; this.cargarOrdenes?.() }
        })
      }

      return out
    },

    /** ¿Hay al menos una alerta? */
    dashHasAlertas() {
      return this.dashAlertas().length > 0
    }
  }
}
