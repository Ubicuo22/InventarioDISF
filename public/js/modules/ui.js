function uiModule() {
  return {
    tab: 'home',
    dbOk: false,
    pedidosTab: 'activos',
    toast: { visible: false, msg: '', error: false },

    // Tema — espejo del key usado en Disfruleg Electron
    darkMode: localStorage.getItem('disfruleg-theme') !== 'light',

    // Pull-to-refresh
    ptrStartY:   0,
    ptrDy:       0,
    ptrSpinning: false,

    toggleDarkMode() {
      this.darkMode = !this.darkMode
      const theme = this.darkMode ? 'dark' : 'light'
      localStorage.setItem('disfruleg-theme', theme)
      const meta = document.querySelector('meta[name="theme-color"]')
      if (meta) meta.setAttribute('content', this.darkMode ? '#0a0a0a' : '#f9fafb')
    },

    mostrarToast(msg, error = false) {
      this.toast = { visible: true, msg, error }
      setTimeout(() => { this.toast.visible = false }, 3500)
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
      if (this.tab === 'inventario') return this.recargar()
      if (this.tab === 'pedidos')    return this.cargarOrdenes()
      if (this.tab === 'entradas')   return this.historialTab === 'entradas'
        ? this.cargarEntradasRecientes()
        : this.cargarPedidosHistorial()
      if (this.tab === 'analytics')  return this.cargarVentasHoy()
      if (this.tab === 'cobranza')   return this.cargarDeudas()
      return Promise.resolve()
    }
  }
}
