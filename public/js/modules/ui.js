function uiModule() {
  return {
    tab: 'home',
    dbOk: false,
    pedidosTab: 'activos',
    toast: { visible: false, msg: '', error: false },

    // Tema — espejo del key usado en Disfruleg Electron
    darkMode: localStorage.getItem('disfruleg-theme') !== 'light',

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
    }
  }
}
