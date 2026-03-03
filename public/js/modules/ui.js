function uiModule() {
  return {
    tab: 'inventario',
    dbOk: false,
    pedidosTab: 'activos',
    toast: { visible: false, msg: '', error: false },

    mostrarToast(msg, error = false) {
      this.toast = { visible: true, msg, error }
      setTimeout(() => { this.toast.visible = false }, 3500)
    }
  }
}
