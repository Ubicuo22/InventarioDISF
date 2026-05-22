function authModule() {
  return {
    session:    null,
    logging:    false,
    loginError: '',
    loginChalan: false,   // true cuando el error es "Eres chalan"
    loginForm: { username: '', password: '', showPwd: false },

    async init() {
      this.resetForm()

      // Asegura que el atributo data-theme y meta theme-color reflejen el estado
      // actual de this.theme (resuelto en uiModule). El script anti-flash en <head>
      // ya lo aplicó antes de la primera pintura, esto es defensa en profundidad
      // para casos donde el script no haya corrido.
      if (typeof this._aplicarTema === 'function') this._aplicarTema(this.theme)

      const token = localStorage.getItem('bodega_token')
      const user  = localStorage.getItem('bodega_user')
      if (token && user) {
        try {
          const parsed = JSON.parse(user)
          // Limpiar sesión si es rol "usuario" (no tiene acceso a la appweb)
          if (parsed.rol === 'usuario') { this.logout(); return }

          // Verificar expiración del JWT antes de cargar
          if (this._tokenExpirado(token)) {
            this.logout()
            this.mostrarToast('Tu sesión expiró — vuelve a iniciar sesión', true)
            return
          }

          // Hidratar campos que pudieran faltar en sesiones viejas (avatar/color)
          // — el JWT siempre los lleva, así que los rescatamos de ahí.
          try {
            const payload = JSON.parse(atob(token.split('.')[1]))
            if (parsed.avatar === undefined && payload.avatar !== undefined) parsed.avatar = payload.avatar
            if (parsed.color  === undefined && payload.color  !== undefined) parsed.color  = payload.color
            localStorage.setItem('bodega_user', JSON.stringify(parsed))
          } catch {}

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

    /**
     * Decodifica el JWT (sin verificar firma, solo para leer exp)
     * y devuelve true si ya expiró o está a menos de 5 minutos de expirar.
     */
    _tokenExpirado(token) {
      try {
        const payload = JSON.parse(atob(token.split('.')[1]))
        if (!payload.exp) return false
        // Margen de 5 minutos para no sorprender al usuario a mitad de una acción
        return Date.now() >= (payload.exp - 5 * 60) * 1000
      } catch {
        return false // si no se puede parsear, dejamos que el servidor decida
      }
    },

    /**
     * Carga todos los módulos al iniciar sesión.
     * Cada llamada tiene su propio try/catch para que un fallo puntual
     * no derrumbe toda la carga ni deslogee al usuario.
     */
    async cargarTodo() {
      const cargar = async (fn, nombre) => {
        try { await fn() }
        catch (e) { console.warn(`[cargarTodo] ${nombre} falló:`, e.message) }
      }

      await Promise.all([
        cargar(() => this.verificarDB(),           'verificarDB'),
        cargar(() => this.cargarProductos(),        'cargarProductos'),
        cargar(() => this.cargarResumen(),          'cargarResumen'),
        cargar(() => this.cargarProveedores(),      'cargarProveedores'),
        cargar(() => this.cargarMermasRecientes(),  'cargarMermasRecientes'),
        cargar(() => this.cargarOrdenes(),          'cargarOrdenes'),
        cargar(() => this.cargarDashboard(),        'cargarDashboard'),
      ])
      this.initPush().catch(() => {})

      // Deep-link desde notificación push (app estaba cerrada)
      // El SW abre /?tab=pedidos — aquí leemos el param y navegamos al tab correcto
      const tabParam = new URLSearchParams(window.location.search).get('tab')
      const tabsValidos = ['pedidos', 'inventario', 'entradas', 'analytics', 'compras', 'cobranza']
      if (tabParam && tabsValidos.includes(tabParam)) {
        this.tab = tabParam
        window.history.replaceState({}, '', '/')
      }
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
        this.session   = r.user
        this.loginForm = { username: '', password: '', showPwd: false }
        await this.cargarTodo()
      } catch (e) {
        this.loginError = e._networkError
          ? e.message
          : 'No se pudo conectar al servidor'
      } finally {
        this.logging = false
      }
    },

    /**
     * Re-sincroniza la sesión local con BD. Usado cuando:
     *   - El avatar carga 404 (probablemente el archivo cambió en R2).
     *   - Queremos refrescar de forma proactiva en cada init().
     * No bloquea ni desloggea si falla — best effort.
     * Tiene throttling: no se llama más de 1 vez cada 30s para evitar
     * loops si el backend devuelve un avatar que también está muerto.
     */
    async refrescarSesion() {
      const now = Date.now()
      if (this._ultimoRefresh && (now - this._ultimoRefresh) < 30_000) return
      this._ultimoRefresh = now
      try {
        // Usamos fetch crudo (no API.get) para que un 401 transitorio en /me
        // NO dispare el global "session-expired" → logout → bounce al login.
        // Esta función es best-effort para refrescar el avatar; si falla, simplemente
        // se queda con la sesión actual hasta el próximo intento.
        const token = localStorage.getItem('bodega_token') || ''
        if (!token) return
        const res = await fetch('/api/auth/me', {
          headers: { 'Authorization': `Bearer ${token}` }
        })
        if (!res.ok) return
        const r = await res.json().catch(() => null)
        if (!r || !r.ok || !r.user) return

        const cambio =
          r.user.avatar !== this.session?.avatar ||
          r.user.color  !== this.session?.color  ||
          r.user.nombre !== this.session?.nombre ||
          r.user.rol    !== this.session?.rol
        if (cambio) {
          const merged = { ...this.session, ...r.user }
          this.session = merged
          localStorage.setItem('bodega_user', JSON.stringify(merged))
        }
      } catch { /* silencioso */ }
    },

    /**
     * Handler para <img @error> del avatar — el archivo en R2 ya no existe.
     * Refresca sesión y, si la nueva URL es distinta, fuerza un re-render
     * cambiando el src. Si tras el refresh el avatar sigue dando 404, el
     * throttle evita bucles.
     */
    async onAvatarError(evento) {
      const oldSrc = this.session?.avatar
      await this.refrescarSesion()
      const newSrc = this.session?.avatar
      if (newSrc && newSrc !== oldSrc && evento?.target) {
        // Re-asignar src dispara una nueva carga
        evento.target.style.display = ''
        evento.target.src = newSrc
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
