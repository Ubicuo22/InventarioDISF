function authModule() {
  return {
    session: null,
    logging: false,
    loginError: '',
    loginForm: { username: '', password: '', showPwd: false },

    async init() {
      this.resetForm()

      const token = localStorage.getItem('bodega_token')
      const user  = localStorage.getItem('bodega_user')
      if (token && user) {
        try {
          this.session = JSON.parse(user)
          await this.cargarTodo()
        } catch {
          this.logout()
        }
      }

      window.addEventListener('session-expired', () => {
        this.logout()
        this.mostrarToast('Sesión expirada — vuelve a iniciar sesión', true)
      })
    },

    async cargarTodo() {
      await Promise.all([
        this.verificarDB(),
        this.cargarProductos(),
        this.cargarResumen(),
        this.cargarProveedores(),
        this.cargarMermasRecientes()
      ])
    },

    async verificarDB() {
      try {
        const r = await fetch('/api/status').then(r => r.json())
        this.dbOk = r.ok
      } catch { this.dbOk = false }
    },

    async login() {
      this.loginError = ''
      if (!this.loginForm.username || !this.loginForm.password) {
        this.loginError = 'Completa usuario y contraseña'
        return
      }
      this.logging = true
      try {
        const r = await API.login(this.loginForm.username, this.loginForm.password)
        if (!r.ok) { this.loginError = r.error || 'Error de autenticación'; return }
        localStorage.setItem('bodega_token', r.token)
        localStorage.setItem('bodega_user', JSON.stringify(r.user))
        this.session = r.user
        this.loginForm = { username: '', password: '', showPwd: false }
        await this.cargarTodo()
      } catch {
        this.loginError = 'No se pudo conectar al servidor'
      } finally {
        this.logging = false
      }
    },

    logout() {
      localStorage.removeItem('bodega_token')
      localStorage.removeItem('bodega_user')
      this.session  = null
      // Limpia estado de otros módulos (correcto con el patrón flat-merge)
      this.productos = []
      this.filtrados = []
      this.entradas  = []
      this.resumen   = {}
    }
  }
}
