function authModule() {
  return {
    session:    null,
    logging:    false,
    loginError: '',
    loginChalan: false,   // true cuando el error es "Eres chalan"
    loginForm: { username: '', password: '', showPwd: false },

    async init() {
      this.resetForm()

      const token = localStorage.getItem('bodega_token')
      const user  = localStorage.getItem('bodega_user')
      if (token && user) {
        try {
          const parsed = JSON.parse(user)
          // Limpiar sesión si es rol "usuario" (no tiene acceso a la appweb)
          if (parsed.rol === 'usuario') {
            this.logout()
            return
          }
          this.session = parsed
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
      this.initPush().catch(() => {})
    },

    async verificarDB() {
      try {
        const r = await fetch('/api/status').then(r => r.json())
        this.dbOk = r.ok
      } catch { this.dbOk = false }
    },

    async login() {
      this.loginError  = ''
      this.loginChalan = false
      if (!this.loginForm.username || !this.loginForm.password) {
        this.loginError = 'Completa usuario y contraseña'
        return
      }
      this.logging = true
      try {
        const r = await API.login(this.loginForm.username, this.loginForm.password)
        if (!r.ok) {
          this.loginChalan = r.chalan === true
          this.loginError  = r.error || 'Error de autenticación'
          return
        }
        localStorage.setItem('bodega_token', r.token)
        localStorage.setItem('bodega_user', JSON.stringify(r.user))
        this.session  = r.user
        this.loginForm = { username: '', password: '', showPwd: false }
        await this.cargarTodo()
      } catch {
        this.loginError = 'No se pudo conectar al servidor'
      } finally {
        this.logging = false
      }
    },

    async logout() {
      // Invalidar sesión en BD (fire-and-forget)
      API.logout().catch(() => {})
      localStorage.removeItem('bodega_token')
      localStorage.removeItem('bodega_user')
      this.session   = null
      this.productos = []
      this.filtrados = []
      this.entradas  = []
      this.resumen   = {}
    },

    /**
     * Verifica si el usuario actual tiene acceso a un módulo.
     *   admin      → siempre true
     *   supervisor → true si el módulo está en su lista
     *   usuario    → siempre false (no debería llegar aquí)
     */
    tienePermiso(modulo) {
      const rol = this.session?.rol
      if (rol === 'admin') return true
      if (rol === 'supervisor') {
        const permisos = this.session?.modulosPermitidos
        return Array.isArray(permisos) && permisos.includes(modulo)
      }
      return false
    }
  }
}
