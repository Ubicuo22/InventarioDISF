function uiModule() {
  return {
    tab: 'home',
    dbOk: false,
    pedidosTab: 'activos',
    toast: { visible: false, msg: '', type: 'success' },
    _toastTimer: null,

    // Tema — 'dark' | 'light'
    // El valor inicial lo resuelve el script anti-flash en <head> (var global __THEME),
    // pero si por alguna razón no corrió, hacemos fallback aquí mismo.
    theme: (window.__THEME) || (
      localStorage.getItem('disfruleg-theme') === 'light' ? 'light' :
      localStorage.getItem('disfruleg-theme') === 'dark'  ? 'dark'  :
      (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    ),

    // Compat: algunos módulos antiguos pueden seguir leyendo darkMode
    get darkMode() { return this.theme === 'dark' },

    // Pull-to-refresh
    ptrStartY:   0,
    ptrDy:       0,
    ptrSpinning: false,

    /**
     * Alterna tema, persiste y actualiza atributos de <html> + meta theme-color.
     * El observer en CSS aplica las variables; las transiciones declaradas en
     * style.css hacen el cross-fade automático.
     */
    toggleTheme() {
      this.theme = this.theme === 'dark' ? 'light' : 'dark'
      this._aplicarTema(this.theme)
    },

    // Compat con llamadas viejas
    toggleDarkMode() { this.toggleTheme() },

    _aplicarTema(theme) {
      try { localStorage.setItem('disfruleg-theme', theme) } catch {}
      document.documentElement.setAttribute('data-theme', theme)
      const meta = document.querySelector('meta[name="theme-color"]')
      if (meta) meta.setAttribute('content', theme === 'dark' ? '#060608' : '#f2f2f7')
    },

    // mostrarToast(msg)                → success
    // mostrarToast(msg, true)          → error  (compat con todos los módulos existentes)
    // mostrarToast(msg, 'warning')     → warning ámbar
    // mostrarToast(msg, 'info')        → info azul
    mostrarToast(msg, typeOrError = false) {
      let type = 'success'
      if (typeOrError === true)               type = 'error'
      else if (typeof typeOrError === 'string') type = typeOrError
      if (this._toastTimer) clearTimeout(this._toastTimer)
      this.toast = { visible: true, msg, type, error: type === 'error' }
      const duration = type === 'error' ? 4500 : type === 'warning' ? 4000 : 3000
      this._toastTimer = setTimeout(() => { this.toast.visible = false }, duration)
    },

    // ── Pull-to-refresh ──────────────────────────────────────────
    ptrTouchStart(e) {
      if ((window.scrollY || window.pageYOffset || 0) > 10) {
        this.ptrStartY = 0
        return
      }
      this.ptrStartY = e.touches[0].clientY
    },

    ptrTouchMove(e) {
      if (!this.ptrStartY) return
      const dy = e.touches[0].clientY - this.ptrStartY
      if (dy > 0) this.ptrDy = Math.min(dy, 80)
    },

    ptrTouchEnd() {
      if (this.ptrDy >= 60) {
        this.ptrSpinning = true
        this.ptrDy = 0
        this.ptrStartY = 0
        this._ptrRefreshTab().finally(() => {
          this.ptrSpinning = false
        })
      } else {
        this.ptrDy = 0
        this.ptrStartY = 0
      }
    },

    _ptrRefreshTab() {
      if (this.tab === 'home')       return this.cargarDashboard()
      if (this.tab === 'inventario') return this.recargar()
      if (this.tab === 'pedidos')    return this.cargarOrdenes()
      if (this.tab === 'entradas')   return this.historialTab === 'entradas'
        ? this.cargarEntradasRecientes()
        : this.cargarPedidosHistorial()
      if (this.tab === 'analytics')  return this.cargarVentasHoy()
      if (this.tab === 'cobranza')   return this.cargarDeudas()
      if (this.tab === 'compras')    return this.cargarCompras()
      return Promise.resolve()
    }
  }
}
