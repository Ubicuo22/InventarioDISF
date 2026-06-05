/* bodega-bundle.f99e80d1.js — 2026-06-05T19:34:55.501Z */

;/* ── public/js/api.js ── */
/**
 * api.js — Wrapper de fetch con autenticación JWT
 * Todas las llamadas al servidor pasan por aquí
 *
 * Mejoras de robustez:
 *  - Timeout de 15s en cada request (AbortController)
 *  - _handle() tolera respuestas no-JSON (502, nginx, etc.)
 *  - Errores de red distinguidos de errores de auth
 */

const API = {
  _base:    '',   // mismo origen
  _TIMEOUT: 15000, // 15 segundos

  _token() {
    return localStorage.getItem('bodega_token') || ''
  },

  _headers(extra = {}) {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this._token()}`,
      ...extra
    }
  },

  /**
   * Fetch con timeout automático.
   * Lanza { _networkError: true } si hay fallo de red o timeout.
   */
  async _fetch(url, opts = {}) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this._TIMEOUT)
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal })
      clearTimeout(timer)
      return res
    } catch (err) {
      clearTimeout(timer)
      const isTimeout = err.name === 'AbortError'
      const error = new Error(isTimeout ? 'La solicitud tardó demasiado. Verifica tu conexión.' : 'No se pudo conectar al servidor.')
      error._networkError = true
      throw error
    }
  },

  /**
   * Parsea la respuesta tolerando cuerpos no-JSON (502, HTML de proxy, etc.)
   * Siempre devuelve un objeto { ok, error?, ... }
   */
  async _handle(res) {
    let data
    const ct = res.headers.get('content-type') || ''
    if (ct.includes('application/json')) {
      try { data = await res.json() }
      catch { data = { ok: false, error: `Error de servidor (${res.status})` } }
    } else {
      await res.text().catch(() => {})
      data = { ok: false, error: `Error de servidor (${res.status})` }
    }

    if (!data.ok && res.status === 401) {
      window.dispatchEvent(new CustomEvent('session-expired'))
    }
    return data
  },

  async get(path) {
    const res = await this._fetch(this._base + path, { headers: this._headers() })
    return this._handle(res)
  },

  async post(path, body) {
    const res = await this._fetch(this._base + path, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body)
    })
    return this._handle(res)
  },

  async put(path, body) {
    const res = await this._fetch(this._base + path, {
      method: 'PUT',
      headers: this._headers(),
      body: JSON.stringify(body)
    })
    return this._handle(res)
  },

  async delete(path) {
    const res = await this._fetch(this._base + path, {
      method: 'DELETE',
      headers: this._headers()
    })
    return this._handle(res)
  },

  // Login — no requiere token previo
  async login(username, password) {
    const res = await this._fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    })
    const ct = res.headers.get('content-type') || ''
    if (ct.includes('application/json')) {
      try { return await res.json() } catch { /* cae al return de abajo */ }
    }
    return { ok: false, error: `Error de servidor (${res.status})` }
  },

  // Logout — invalida la sesión en BD
  async logout() {
    try {
      await this.post('/api/auth/logout', {})
    } catch { /* no bloquear logout aunque falle */ }
  },

  // ── Admin ─────────────────────────────────────────────────
  async getSesiones()          { return this.get('/api/admin/sesiones') },
  async revocarSesion(jti)     { return this.delete(`/api/admin/sesiones/${jti}`) },
  async getUsuariosAdmin()     { return this.get('/api/admin/usuarios') },
  async updatePermisos(id, modulos) {
    return this.put(`/api/admin/usuarios/${id}/permisos`, { modulos })
  },
  async getActividad(params = {}) {
    const qs = new URLSearchParams(params).toString()
    return this.get(`/api/admin/actividad${qs ? '?' + qs : ''}`)
  }
}


;/* ── public/js/sounds.js ── */
/**
 * sounds.js — Sonidos sintéticos vía Web Audio API.
 * Misma firma que la app Electron (utils/sounds.ts) para mantener consistencia UX.
 * Sin archivos externos.
 */
(function () {
  let _ctx = null

  function getCtx () {
    if (typeof window === 'undefined') return null
    if (!_ctx) {
      try {
        const AC = window.AudioContext || window.webkitAudioContext
        if (!AC) return null
        _ctx = new AC()
      } catch {
        return null
      }
    }
    if (_ctx.state === 'suspended') {
      _ctx.resume().catch(() => {})
    }
    return _ctx
  }

  function tone ({ frequency, duration, type = 'sine', volume = 0.4, startTime = 0 }) {
    const ctx = getCtx()
    if (!ctx) return
    const now = ctx.currentTime + startTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(frequency, now)
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(volume, now + 0.005)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(now)
    osc.stop(now + duration + 0.01)
  }

  window.sounds = {
    /** Tick suave al marcar revisado */
    reviewed () {
      tone({ frequency: 800, duration: 0.06, type: 'sine', volume: 0.4 })
    },
    /** Tono bajo de advertencia al marcar faltante */
    missing () {
      tone({ frequency: 320, duration: 0.1, type: 'triangle', volume: 0.4 })
    },
    /** Campanita ascendente al finalizar revisión completa */
    finalize () {
      tone({ frequency: 660, duration: 0.12, type: 'sine', volume: 0.4 })
      tone({ frequency: 880, duration: 0.18, type: 'sine', volume: 0.4, startTime: 0.08 })
    },
    /** Tono neutro al deshacer */
    undo () {
      tone({ frequency: 500, duration: 0.08, type: 'sine', volume: 0.4 })
    }
  }
})()


;/* ── public/js/modules/ui.js ── */
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


;/* ── public/js/modules/auth.js ── */
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

      // Primera tanda: datos críticos para la vista inicial (inventario + pedidos)
      await Promise.all([
        cargar(() => this.verificarDB(),           'verificarDB'),
        cargar(() => this.cargarProductos(),        'cargarProductos'),
        cargar(() => this.cargarOrdenes(),          'cargarOrdenes'),
      ])

      // Segunda tanda: dashboard (~17 queries en paralelo internamente) +
      // datos secundarios. Corre después para no saturar el pool en startup.
      await Promise.all([
        cargar(() => this.cargarDashboard(),        'cargarDashboard'),
        cargar(() => this.cargarResumen(),          'cargarResumen'),
        cargar(() => this.cargarProveedores(),      'cargarProveedores'),
        cargar(() => this.cargarMermasRecientes(),  'cargarMermasRecientes'),
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


;/* ── public/js/modules/inventory.js ── */
function inventoryModule() {
  return {
    productos: [],
    filtrados: [],
    cargando: false,
    busqueda: '',
    filtroStock: '',
    resumen: {},
    proveedores: [],
    _filtrarTimer: null,

    async cargarProductos() {
      this.cargando = true
      try {
        const r = await API.get('/api/productos')
        this.productos = r.data || []
        this.filtrar()
      } catch (err) {
        this.mostrarToast(err.message || 'Error al cargar productos', true)
      } finally {
        this.cargando = false
      }
    },

    async cargarResumen() {
      try {
        const r = await API.get('/api/productos/resumen')
        this.resumen = r.data || {}
      } catch (err) {
        this.mostrarToast(err.message || 'Error al cargar resumen', true)
      }
    },

    async cargarProveedores() {
      try {
        const r = await API.get('/api/productos/proveedores')
        this.proveedores = r.data || []
      } catch (err) {
        this.mostrarToast(err.message || 'Error al cargar proveedores', true)
      }
    },

    filtrar() {
      let lista = [...this.productos]
      const b = this.busqueda.toLowerCase().trim()
      if (b) lista = lista.filter(p => p.nombre_producto.toLowerCase().includes(b))
      if (this.filtroStock === 'ok')   lista = lista.filter(p => p.stock > 5)
      if (this.filtroStock === 'low')  lista = lista.filter(p => p.stock > 0 && p.stock <= 5)
      if (this.filtroStock === 'zero') lista = lista.filter(p => p.stock <= 0)
      this.filtrados = lista
    },

    // Versión debounced del filtro — para el input de búsqueda (300ms)
    filtrarDebounced() {
      clearTimeout(this._filtrarTimer)
      this._filtrarTimer = setTimeout(() => this.filtrar(), 300)
    },

    async recargar() {
      await Promise.all([this.cargarProductos(), this.cargarResumen()])
    },

    // ── Nuevo producto ────────────────────────────────────────
    modalProductoAbierto: false,
    guardandoProducto:    false,
    errorProducto:        '',
    productoForm: {
      nombre_producto: '',
      unidad_producto: 'kg',
      precio:          '',
      id_grupo:        ''
    },

    abrirNuevoProducto() {
      this.errorProducto = ''
      this.productoForm  = { nombre_producto: '', unidad_producto: 'kg', precio: '', id_grupo: '' }
      // Cargar grupos si aún no están (compartido con ordersModule via flat-merge)
      if (!this.grupos?.length) this.cargarGrupos()
      this.modalProductoAbierto = true
    },

    cerrarProducto() {
      this.modalProductoAbierto = false
      this.errorProducto        = ''
    },

    // ── Lotes PEPS ────────────────────────────────────────────
    lotesDrawerAbierto: false,
    lotesProducto:      null,
    lotes:              [],
    lotesCargando:      false,

    async abrirLotes(producto) {
      this.lotesProducto      = producto
      this.lotes              = []
      this.lotesDrawerAbierto = true
      this.lotesCargando      = true
      try {
        const r = await API.get(`/api/entradas/lotes/${producto.id_producto}`)
        if (r.ok) this.lotes = r.data || []
      } catch (_) {}
      this.lotesCargando = false
    },

    cerrarLotes() {
      this.lotesDrawerAbierto = false
      this.lotesProducto      = null
      this.lotes              = []
    },

    loteFechaCorta(fechaStr) {
      if (!fechaStr) return '—'
      const d = new Date(fechaStr + 'T12:00:00')
      return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: '2-digit' })
    },

    loteDiasDesde(fechaStr) {
      if (!fechaStr) return null
      const d = new Date(fechaStr + 'T12:00:00')
      return Math.floor((Date.now() - d.getTime()) / 86400000)
    },

    // Cuánto se ha consumido de un lote (%)
    lotePct(lote) {
      const ini = parseFloat(lote.cantidad_inicial)
      if (!ini) return 0
      return Math.round((1 - parseFloat(lote.cantidad_restante) / ini) * 100)
    },

    // Color de la barra de progreso según antigüedad del lote
    loteBarColor(dias, idx) {
      if (idx === 0) return 'bg-emerald-400'   // el que se consume primero
      if (dias === null || dias <= 30) return 'bg-slate-500'
      if (dias <= 75) return 'bg-amber-500'
      return 'bg-red-500'
    },

    async guardarProducto() {
      this.errorProducto = ''
      if (!this.productoForm.nombre_producto.trim())
        { this.errorProducto = 'El nombre es obligatorio'; return }
      if (!this.productoForm.unidad_producto)
        { this.errorProducto = 'Selecciona una unidad'; return }
      const precio = this.productoForm.precio !== '' ? parseFloat(this.productoForm.precio) : null
      if (precio !== null && (isNaN(precio) || precio <= 0))
        { this.errorProducto = 'Precio debe ser mayor a 0'; return }
      if (precio && !this.productoForm.id_grupo)
        { this.errorProducto = 'Selecciona un grupo para el precio'; return }

      this.guardandoProducto = true
      try {
        const body = {
          nombre_producto: this.productoForm.nombre_producto.trim(),
          unidad_producto: this.productoForm.unidad_producto
        }
        if (precio && this.productoForm.id_grupo) {
          body.precio   = precio
          body.id_grupo = this.productoForm.id_grupo
        }
        const r = await API.post('/api/productos', body)
        if (!r.ok) { this.errorProducto = r.error || 'Error al guardar'; return }
        this.cerrarProducto()
        this.mostrarToast(`Producto "${r.data.nombre_producto}" creado`)
        await this.recargar()
      } catch (e) {
        this.errorProducto = e.message || 'Error de conexión'
      } finally {
        this.guardandoProducto = false
      }
    }
  }
}


;/* ── public/js/modules/entries.js ── */
function entriesModule() {
  return {
    modalAbierto: false,
    guardando: false,
    guardadoOk: false,
    errorModal: '',
    dropdownVisible: false,
    dropResults: [],
    form: {},
    equivalentes: [],           // sinónimos (familia) — misma unidad, stock manual
    equivalentesChecked: [],    // ids seleccionados para actualizar stock
    pepsDerivados: [],          // productos de venta que usan este como base (solo informativo)
    pepsEsDerivado: null,       // si el producto seleccionado ES un derivado (alerta)

    abrirModal(prod = null) {
      this.resetForm()
      this.errorModal = ''
      if (prod) {
        this.form.idProducto     = prod.id_producto
        this.form.nombreProducto = prod.nombre_producto
        this.form.stockActual    = prod.stock
        this.form.unidad         = prod.unidad_producto || ''
        this.form.busqueda       = prod.nombre_producto
        this.cargarEquivalentes(prod.id_producto)
      }
      this.modalAbierto = true
    },

    cerrarModal() {
      this.modalAbierto = false
      this.guardadoOk   = false
      this.resetForm()
    },

    resetForm() {
      const hoy = new Date().toISOString().slice(0, 10)
      this.form = {
        idProducto: null, nombreProducto: '', stockActual: 0,
        unidad: '',
        busqueda: '', cantidad: '', precio: '',
        incluirIva: true, fechaCompra: hoy,
        idProveedor: '', folio: '', notas: '',
        pesoLote: ''     // kg totales del lote — opcional, para factor PEPS
      }
      this.dropResults          = []
      this.dropdownVisible      = false
      this.equivalentes         = []
      this.equivalentesChecked  = []
    },

    buscarProducto() {
      const s = this.form.busqueda.toLowerCase().trim()
      if (!s) { this.dropResults = []; return }
      this.dropResults = this.productos
        .filter(p => p.nombre_producto.toLowerCase().includes(s))
        .slice(0, 10)
      this.dropdownVisible = true
      if (this.form.idProducto && this.form.busqueda !== this.form.nombreProducto) {
        this.form.idProducto = null; this.form.nombreProducto = ''; this.form.stockActual = 0
      }
    },

    async cargarEquivalentes(idProducto) {
      this.equivalentes        = []
      this.equivalentesChecked = []
      this.pepsDerivados       = []
      this.pepsEsDerivado      = null
      try {
        const [re, rp] = await Promise.all([
          API.get(`/api/entradas/equivalentes/${idProducto}`),
          API.get(`/api/entradas/peps-info/${idProducto}`)
        ])
        if (re.ok && re.data.length > 0) {
          this.equivalentes        = re.data
          this.equivalentesChecked = re.data.map(e => e.id_producto)
        }
        if (rp.ok) {
          this.pepsDerivados  = rp.derivados  || []
          this.pepsEsDerivado = rp.esDerivado || null
        }
      } catch (_) {}
    },

    async seleccionar(p) {
      this.form.idProducto     = p.id_producto
      this.form.nombreProducto = p.nombre_producto
      this.form.stockActual    = p.stock
      this.form.unidad         = p.unidad_producto || ''
      this.form.busqueda       = p.nombre_producto
      this.dropdownVisible     = false
      this.dropResults         = []
      this.cargarEquivalentes(p.id_producto)
    },

    limpiarSeleccion() {
      this.form.idProducto     = null; this.form.nombreProducto = ''
      this.form.stockActual    = 0;    this.form.busqueda = ''
      this.form.unidad         = ''
      this.equivalentes        = []
      this.equivalentesChecked = []
      this.pepsDerivados       = []
      this.pepsEsDerivado      = null
    },

    // ── Cálculos de peso del lote ─────────────────────────────
    calcKgPorUnidad() {
      const peso = parseFloat(this.form.pesoLote)
      const cant = parseFloat(this.form.cantidad)
      if (!peso || !cant || peso <= 0 || cant <= 0) return null
      return (peso / cant).toFixed(4)
    },

    calcFactorLote() {
      const kgU = parseFloat(this.calcKgPorUnidad())
      if (!kgU || kgU <= 0) return null
      return (1 / kgU).toFixed(3)
    },

    calcDesglose() {
      const cant   = parseFloat(this.form.cantidad) || 0
      const precio = parseFloat(this.form.precio)   || 0
      if (!cant || !precio) return null
      if (this.form.incluirIva) {
        const baseUnit = precio / 1.16
        const ivaUnit  = precio - baseUnit
        return {
          base:  (cant * baseUnit).toFixed(2),
          iva:   (cant * ivaUnit).toFixed(2),
          total: (cant * precio).toFixed(2)
        }
      } else {
        return {
          base:  (cant * precio).toFixed(2),
          iva:   null,
          total: (cant * precio).toFixed(2)
        }
      }
    },

    async guardarEntrada() {
      this.errorModal = ''
      if (!this.form.idProducto) { this.errorModal = 'Selecciona un producto'; return }
      this.guardandoOk = false
      this.guardando   = true
      try {
        const r = await API.post('/api/entradas', {
          idProducto:      this.form.idProducto,
          idProveedor:     this.form.idProveedor || null,
          cantidad:        this.form.cantidad,
          precio:          this.form.precio,
          fechaCompra:     this.form.fechaCompra,
          folio:           this.form.folio || null,
          incluirIva:      this.form.incluirIva,
          notas:           this.form.notas || null,
          idsEquivalentes: this.equivalentesChecked,
          pesoLote:        this.form.pesoLote ? parseFloat(this.form.pesoLote) : null
        })
        if (!r.ok) { this.errorModal = r.error || 'Error al guardar'; return }

        // Actualizar stock local sin recargar lista completa
        const cantAgregada = parseFloat(this.form.cantidad)
        const idx = this.productos.findIndex(p => p.id_producto === this.form.idProducto)
        if (idx !== -1) {
          this.productos[idx] = { ...this.productos[idx], stock: parseFloat(this.productos[idx].stock) + cantAgregada }
        }
        // Actualizar stock local de equivalentes seleccionados
        for (const idEq of this.equivalentesChecked) {
          const idxEq = this.productos.findIndex(p => p.id_producto === idEq)
          if (idxEq !== -1) {
            this.productos[idxEq] = { ...this.productos[idxEq], stock: parseFloat(this.productos[idxEq].stock) + cantAgregada }
          }
        }
        this.filtrar()
        await this.cargarResumen()

        const msg = `${this.form.cantidad} × ${this.form.nombreProducto}`

        // Confirmación visual — botón verde con check por 700ms antes de cerrar
        this.guardando   = false
        this.guardadoOk  = true
        await new Promise(res => setTimeout(res, 700))
        this.cerrarModal()
        this.mostrarToast(msg)
      } catch (err) {
        this.errorModal = err.message || 'Error de conexión'
      } finally {
        this.guardando  = false
        this.guardadoOk = false
      }
    }
  }
}


;/* ── public/js/modules/orders.js ── */
function ordersModule() {
  return {
    ordenes: [],
    cargandoOrdenes: false,
    ordenesFiltroRevision: 'todas',  // 'todas' | 'pendientes' | 'revisadas'
    filtroFechaPedidos: '',
    filtroClientePedidos: '',
    grupos: [],
    clientesGrupo: [],
    modalOrdenAbierto: false,
    ordenReadOnly: false,
    guardandoOrden: false,
    ordenGuardadaOk: false,
    errorOrden: '',
    ordenBusqueda: '',
    ordenResultados: [],
    ordenForm: {},
    ordenCarrito: { General: [] },
    seccionActual: 'General',
    nuevaSeccionNombre: '',
    mostrarNuevaSeccion: false,
    observacion: '',
    mostrarObservacion: false,
    confirmarGuardadoModal: { visible: false },
    agregarModal: { visible: false, producto: null, precio: '', cantidad: '1', guardarPrecio: true },

    ordenesFiltradas() {
      return this.ordenes.filter(o => {
        if (this.filtroClientePedidos) {
          const txt = this.filtroClientePedidos.toLowerCase()
          const coincide = (o.nombre_cliente || '').toLowerCase().includes(txt)
            || (o.nombre_grupo || '').toLowerCase().includes(txt)
          if (!coincide) return false
        }
        if (this.filtroFechaPedidos) {
          const fecha = o.fecha_creacion ? o.fecha_creacion.slice(0, 10) : ''
          if (fecha !== this.filtroFechaPedidos) return false
        }
        return true
      })
    },

    limpiarFiltrosPedidos() {
      this.filtroFechaPedidos = ''
      this.filtroClientePedidos = ''
    },

    async cargarOrdenes() {
      this.cargandoOrdenes = true
      try {
        const estado = this.pedidosTab === 'registrados' ? 'registrada' : 'guardada'
        // 'activos' y 'revisadas' son vistas del mismo estado=guardada (filtro client-side)
        const r = await API.get(`/api/ordenes?estado=${estado}`)
        this.ordenes = r.data || []
      } catch (err) {
        this.ordenes = []
        this.mostrarToast(err.message || 'Error al cargar pedidos', true)
      } finally {
        this.cargandoOrdenes = false
      }
    },

    async cargarGrupos() {
      try {
        const r = await API.get('/api/clientes/grupos')
        this.grupos = r.data || []
      } catch (err) {
        this.mostrarToast(err.message || 'Error al cargar grupos', true)
      }
    },

    async cargarClientesPorGrupo() {
      this.clientesGrupo = []
      this.ordenForm.id_cliente = ''
      if (!this.ordenForm.id_grupo) return
      try {
        const r = await API.get(`/api/clientes?groupId=${this.ordenForm.id_grupo}`)
        this.clientesGrupo = r.data || []
      } catch (err) {
        this.mostrarToast(err.message || 'Error al cargar clientes', true)
      }
    },

    actualizarNombreCliente() {
      const c = this.clientesGrupo.find(c => c.id_cliente == this.ordenForm.id_cliente)
      const g = this.grupos.find(g => g.id_grupo == this.ordenForm.id_grupo)
      this.ordenForm.nombreCliente = c ? c.nombre_cliente : ''
      this.ordenForm.nombreGrupo   = g ? g.nombre_grupo   : ''
    },

    async abrirNuevaOrden() {
      if (!this.grupos.length) await this.cargarGrupos()
      this.ordenForm           = { folio_numero: null, id_grupo: '', id_cliente: '', nombreCliente: '', nombreGrupo: '' }
      this.ordenCarrito        = { General: [] }
      this.seccionActual       = 'General'
      this.nuevaSeccionNombre  = ''
      this.mostrarNuevaSeccion = false
      this.errorOrden          = ''
      this.ordenBusqueda       = ''
      this.ordenResultados     = []
      this.clientesGrupo       = []
      this.observacion         = ''
      this.mostrarObservacion  = false
      this.modalOrdenAbierto   = true
    },

    async abrirEditarOrden(orden) {
      this.errorOrden          = ''
      this.ordenBusqueda       = ''
      this.ordenResultados     = []
      this.nuevaSeccionNombre  = ''
      this.mostrarNuevaSeccion = false
      this.ordenReadOnly       = orden.estado === 'registrada'
      try {
        const r = await API.get(`/api/ordenes/${orden.folio_numero}`)
        if (!r.ok) { this.mostrarToast('Error al cargar el pedido', true); return }
        const o = r.data
        this.ordenForm = {
          folio_numero:  o.folio_numero,
          id_cliente:    o.id_cliente,
          id_grupo:      o.id_grupo,
          nombreCliente: o.nombre_cliente,
          nombreGrupo:   o.nombre_grupo
        }
        // Preservar secciones tal como vienen del DB (compatibilidad con electron)
        const cart = (typeof o.datos_carrito === 'string')
          ? JSON.parse(o.datos_carrito) : (o.datos_carrito || {})
        this.ordenCarrito       = Object.keys(cart).length ? cart : { General: [] }
        this.seccionActual      = this.sectionNames()[0] || 'General'
        this.observacion        = cart.__observacion__ || ''
        this.mostrarObservacion = !!cart.__observacion__
        this.modalOrdenAbierto  = true
      } catch (err) {
        this.mostrarToast(err.message || 'Error al cargar el pedido', true)
      }
    },

    cerrarOrden() {
      this.modalOrdenAbierto   = false
      this.ordenReadOnly       = false
      this.ordenForm           = {}
      this.ordenCarrito        = { General: [] }
      this.seccionActual       = 'General'
      this.nuevaSeccionNombre  = ''
      this.mostrarNuevaSeccion = false
      this.errorOrden          = ''
      this.ordenBusqueda       = ''
      this.ordenResultados     = []
      this.observacion              = ''
      this.mostrarObservacion       = false
      this.confirmarGuardadoModal   = { visible: false }
    },

    /** Extrae la observación de una orden de la lista (datos_carrito puede ser string o objeto) */
    getOrdenObservacion(o) {
      try {
        const c = typeof o.datos_carrito === 'string'
          ? JSON.parse(o.datos_carrito)
          : (o.datos_carrito || {})
        return c.__observacion__ || ''
      } catch { return '' }
    },

    // Retorna los nombres de sección con General siempre primero
    // Filtra keys internas que empiecen con _ (metadata del Electron)
    sectionNames() {
      const keys = Object.keys(this.ordenCarrito).filter(k => !k.startsWith('_'))
      if (keys.includes('General')) {
        return ['General', ...keys.filter(k => k !== 'General')]
      }
      return keys
    },

    // Lista plana de todos los items (para conteo y total)
    // Excluye keys internas que empiecen con _
    cartItems() {
      return Object.entries(this.ordenCarrito)
        .filter(([k]) => !k.startsWith('_'))
        .flatMap(([, v]) => v)
    },

    async buscarProductoPedido() {
      const s = this.ordenBusqueda.trim()
      if (!s) { this.ordenResultados = []; return }
      try {
        const gid = this.ordenForm.id_grupo || ''
        const r = await API.get(`/api/productos/buscar?q=${encodeURIComponent(s)}&groupId=${gid}`)
        this.ordenResultados = r.data || []
      } catch (err) {
        this.ordenResultados = []
        this.mostrarToast(err.message || 'Error al buscar productos', true)
      }
    },

    abrirAgregarModal(producto) {
      const precio = parseFloat(producto.precio_base)
      const sinPrecio = !precio || precio <= 0
      this.agregarModal = {
        visible:      true,
        producto,
        precio:       sinPrecio ? '' : precio.toFixed(2),
        cantidad:     '1',
        guardarPrecio: sinPrecio  // solo sugerir guardar cuando no hay precio previo
      }
      this.ordenBusqueda   = ''
      this.ordenResultados = []
    },

    async confirmarAgregar() {
      const prod     = this.agregarModal.producto
      const precio   = parseFloat(this.agregarModal.precio)
      const cantidad = parseFloat(this.agregarModal.cantidad) || 1
      if (!precio || precio <= 0) return

      // Guardar precio en el grupo si el usuario lo pidió
      if (this.agregarModal.guardarPrecio && this.ordenForm.id_grupo) {
        try {
          await API.post('/api/productos/precio-rapido', {
            id_producto: prod.id_producto,
            id_grupo:    this.ordenForm.id_grupo,
            precio_base: precio
          })
        } catch (e) {
          console.warn('No se pudo guardar el precio:', e.message)
        }
      }

      const sec = this.seccionActual || 'General'
      if (!this.ordenCarrito[sec]) this.ordenCarrito[sec] = []
      const existing = this.ordenCarrito[sec].find(i => i.id_producto === prod.id_producto)
      if (existing) {
        existing.cantidad        += cantidad
        existing.precio_unitario  = precio
      } else {
        this.ordenCarrito[sec].push({
          id_producto:     prod.id_producto,
          nombre_producto: prod.nombre_producto,
          unidad:          prod.unidad_producto,
          cantidad,
          precio_unitario: precio,
          seccion:         sec
        })
      }
      this.agregarModal = { visible: false, producto: null, precio: '', cantidad: '1', guardarPrecio: true }
    },

    cerrarAgregarModal() {
      this.agregarModal = { visible: false, producto: null, precio: '', cantidad: '1', guardarPrecio: true }
    },

    agregarAlCarrito(producto) {
      const sec = this.seccionActual || 'General'
      if (!this.ordenCarrito[sec]) this.ordenCarrito[sec] = []
      const existing = this.ordenCarrito[sec].find(i => i.id_producto === producto.id_producto)
      if (existing) {
        existing.cantidad += 1
      } else {
        this.ordenCarrito[sec].push({
          id_producto:     producto.id_producto,
          nombre_producto: producto.nombre_producto,
          unidad:          producto.unidad_producto,
          cantidad:        1,
          precio_unitario: parseFloat(producto.precio_base) || 0,
          seccion:         sec
        })
      }
      this.ordenBusqueda   = ''
      this.ordenResultados = []
    },

    quitarDelCarrito(seccion, idx) {
      if (!this.ordenCarrito[seccion]) return
      this.ordenCarrito[seccion].splice(idx, 1)
    },

    agregarSeccion() {
      const nombre = this.nuevaSeccionNombre.trim()
      if (!nombre) return
      if (!this.ordenCarrito[nombre]) {
        this.ordenCarrito[nombre] = []
      }
      this.seccionActual       = nombre
      this.nuevaSeccionNombre  = ''
      this.mostrarNuevaSeccion = false
    },

    calcTotalOrden() {
      return this.cartItems().reduce((sum, item) =>
        sum + ((item.cantidad || 0) * (item.precio_unitario || 0)), 0)
    },

    abrirConfirmarGuardado() {
      if (this.ordenReadOnly) return
      if (!this.ordenForm.id_cliente) { this.errorOrden = 'Selecciona un cliente'; return }
      if (this.cartItems().length === 0) { this.errorOrden = 'Agrega al menos un producto'; return }
      this.errorOrden = ''
      this.confirmarGuardadoModal = { visible: true }
    },

    async guardarOrden() {
      if (this.ordenReadOnly) return
      this.confirmarGuardadoModal = { visible: false }
      this.errorOrden     = ''
      this.ordenGuardadaOk = false
      if (!this.ordenForm.id_cliente) { this.errorOrden = 'Selecciona un cliente'; return }
      if (this.cartItems().length === 0) { this.errorOrden = 'Agrega al menos un producto'; return }
      this.guardandoOrden = true
      try {
        const datosCarrito = { ...this.ordenCarrito }
        if (this.observacion.trim()) {
          datosCarrito.__observacion__ = this.observacion.trim()
        } else {
          delete datosCarrito.__observacion__
        }
        const body = {
          id_cliente:    this.ordenForm.id_cliente,
          datos_carrito: datosCarrito
        }
        if (this.ordenForm.folio_numero) body.folio_numero = this.ordenForm.folio_numero
        const r = await API.post('/api/ordenes', body)
        if (!r.ok) { this.errorOrden = r.error || 'Error al guardar'; return }

        // Confirmación visual — botón verde con check por 700ms antes de cerrar
        this.guardandoOrden  = false
        this.ordenGuardadaOk = true
        const folio = r.folio_numero
        await new Promise(res => setTimeout(res, 700))
        this.cerrarOrden()
        this.mostrarToast(`Pedido #${String(folio).padStart(4, '0')} guardado`)
        await this.cargarOrdenes()
      } catch (e) {
        this.errorOrden = e.message || 'Error de conexión'
      } finally {
        this.guardandoOrden  = false
        this.ordenGuardadaOk = false
      }
    }
  }
}


;/* ── public/js/modules/review.js ── */
/**
 * review.js — Modo Revisión para Bodega
 *
 * Portado de la app Electron (v3.6.8) adaptado a touch-first UX.
 * - Mobile: producto enorme + 2 botones grandes + swipe izq/der
 * - Tablet (≥sm): sidebar lateral con lista + panel central
 * - Edita cantidades tocando el número (abre teclado numérico nativo en iOS)
 * - Tap "Faltante" elimina del carrito + toast undo 5s
 * - Tap "Revisar" / swipe der → marca + avanza al siguiente
 * - Persiste cambios al guardar y registra revisión en historial
 */
function reviewModule () {
  return {
    // ── Estado del modo Revisión ───────────────────────────────
    revisionModalOpen: false,
    revisionCart: { General: [] },      // copia mutable del carrito durante revisión
    revisionFolio: null,
    revisionIdGrupo: null,
    revisionNombreCliente: '',
    revisionNombreGrupo: '',
    revisionIdCliente: null,            // guardado en abrirRevision para evitar GET extra al finalizar
    revisionCurrentIdx: 0,
    revisionReviewedIds: [],            // ["seccion::id_producto", ...]
    revisionMissingNames: [],
    revisionPendingIds: [],             // ["seccion::id_producto", ...] — sigue en carrito pero flagueado
    revisionPendingNames: [],
    revisionGuardando: false,
    revisionGuardandoMensaje: '',       // mensaje de progreso visible al usuario
    revisionErrorGuardado: null,        // null | string — error del último intento de guardar
    revisionShowSidebar: false,         // collapsable en móvil
    // Undo toast
    revisionUndo: null,                 // { item, section } | null
    _revisionUndoTimer: null,
    // Swipe state — todos deben estar en el estado inicial para que Alpine los trackee
    revisionTouchX0: null,
    revisionTouchY0: null,
    revisionTouchTx: 0,
    revisionSwipeLock: false,
    revisionSwipeAxisLocked: null,
    // Throttle para Siguiente (previene avanzar varios de golpe con clic rápido o flecha mantenida)
    _revisionLastNext: 0,
    // Estado de foco del input de cantidad (para guardar atajos de teclado)
    revisionInputFocused: false,
    // Snapshot del carrito original (para Reset)
    _revisionOriginalCart: null,
    // Ref al handler de teclado registrado
    _revisionKeyHandler: null,
    // Modal buscar/cambiar producto desde revisión
    revisionCambiarModal: { visible: false, busqueda: '', resultados: [], buscando: false, error: null },
    _revisionSearchId: null,            // anti-race: solo procesa el resultado de la última búsqueda

    // ── Helpers ────────────────────────────────────────────────
    _revisionFilteredKeys () {
      return Object.keys(this.revisionCart).filter(k => !k.startsWith('__'))
    },

    /** Lista plana de items, respetando orden de secciones (General primero si existe). */
    revisionFlatItems () {
      const keys = this._revisionFilteredKeys()
      const ordered = keys.includes('General')
        ? ['General', ...keys.filter(k => k !== 'General')]
        : keys
      const out = []
      for (const sec of ordered) {
        const items = this.revisionCart[sec]
        if (!Array.isArray(items)) continue
        for (const item of items) {
          out.push({ item, section: sec })
        }
      }
      return out
    },

    revisionTotal () {
      return this.revisionFlatItems().length
    },

    revisionCurrent () {
      const flat = this.revisionFlatItems()
      return flat[this.revisionCurrentIdx] || null
    },

    revisionItemKey (section, productId) {
      return `${section}::${productId}`
    },

    revisionIsReviewed (section, productId) {
      return this.revisionReviewedIds.includes(this.revisionItemKey(section, productId))
    },

    revisionIsCurrentReviewed () {
      const c = this.revisionCurrent()
      return c ? this.revisionIsReviewed(c.section, c.item.id_producto) : false
    },

    revisionIsPending (section, productId) {
      return this.revisionPendingIds.includes(this.revisionItemKey(section, productId))
    },

    revisionIsCurrentPending () {
      const c = this.revisionCurrent()
      return c ? this.revisionIsPending(c.section, c.item.id_producto) : false
    },

    revisionReviewedCount () {
      return this.revisionReviewedIds.length
    },

    revisionAllReviewed () {
      const total = this.revisionTotal()
      return total > 0 && this.revisionReviewedCount() === total
    },

    revisionProgressPct () {
      const total = this.revisionTotal()
      return total === 0 ? 0 : Math.round((this.revisionReviewedCount() / total) * 100)
    },

    /** Agrupa items por sección para el sidebar. */
    revisionItemsBySection () {
      const groups = {}
      this.revisionFlatItems().forEach(fi => {
        if (!groups[fi.section]) groups[fi.section] = []
        groups[fi.section].push(fi)
      })
      return groups
    },

    revisionSectionStats (section) {
      const items = this.revisionItemsBySection()[section] || []
      const done = items.filter(fi => this.revisionIsReviewed(fi.section, fi.item.id_producto)).length
      return { done, total: items.length }
    },

    // ── Abrir / cerrar ─────────────────────────────────────────
    async abrirRevision (orden) {
      // Si viene desde la lista, cargar carrito completo
      try {
        const r = await API.get(`/api/ordenes/${orden.folio_numero}`)
        if (!r.ok) {
          this.mostrarToast(r.error || 'Error al cargar pedido', true)
          return
        }
        const o = r.data
        const cart = (typeof o.datos_carrito === 'string')
          ? JSON.parse(o.datos_carrito)
          : (o.datos_carrito || {})

        this.revisionCart = Object.keys(cart).length ? cart : { General: [] }
        this._revisionOriginalCart = JSON.parse(JSON.stringify(this.revisionCart))
        this.revisionFolio = o.folio_numero
        this.revisionIdCliente = o.id_cliente || null
        this.revisionIdGrupo = o.id_grupo || null
        this.revisionNombreCliente = o.nombre_cliente
        this.revisionNombreGrupo = o.nombre_grupo
        this.revisionCurrentIdx = 0
        this.revisionReviewedIds = []
        this.revisionMissingNames = []
        this.revisionPendingIds = []
        this.revisionPendingNames = []
        this.revisionUndo = null
        this.revisionShowSidebar = false
        this.revisionTouchX0 = null
        this.revisionTouchTx = 0
        // Solo Enter en el input de cantidad → avanzar.
        // Los atajos F/P/←/→ se eliminaron porque interceptan el buscador de "cambiar producto".
        this._revisionKeyHandler = (e) => {
          if (!this.revisionModalOpen) return
          if (this.revisionInputFocused && e.key === 'Enter') {
            e.preventDefault()
            this.revisionGuardarYSiguiente(e)
          }
        }
        window.addEventListener('keydown', this._revisionKeyHandler)
        this.revisionModalOpen = true
      } catch (e) {
        this.mostrarToast(e.message || 'Error al cargar pedido', true)
      }
    },

    cerrarRevision () {
      if (this._revisionKeyHandler) {
        window.removeEventListener('keydown', this._revisionKeyHandler)
        this._revisionKeyHandler = null
      }
      this._revisionOriginalCart = null
      this.revisionModalOpen = false
      this.revisionCart = { General: [] }
      this.revisionFolio = null
      this.revisionIdCliente = null
      this.revisionIdGrupo = null
      this.revisionReviewedIds = []
      this.revisionMissingNames = []
      this.revisionPendingIds = []
      this.revisionPendingNames = []
      this.revisionCurrentIdx = 0
      this.revisionUndo = null
      this.revisionCambiarModal   = { visible: false, busqueda: '', resultados: [], buscando: false, error: null }
      this._revisionSearchId      = null
      this.revisionGuardandoMensaje = ''
      this.revisionErrorGuardado  = null
      this.revisionTouchX0        = null
      this.revisionTouchY0        = null
      this.revisionTouchTx        = 0
      this.revisionSwipeAxisLocked = null
      if (this._revisionUndoTimer) {
        clearTimeout(this._revisionUndoTimer)
        this._revisionUndoTimer = null
      }
    },

    // ── Navegación ─────────────────────────────────────────────
    revisionMarcarRevisado () {
      const c = this.revisionCurrent()
      if (!c) return
      const key = this.revisionItemKey(c.section, c.item.id_producto)
      if (!this.revisionReviewedIds.includes(key)) {
        this.revisionReviewedIds.push(key)
        if (window.sounds) window.sounds.reviewed()
      }
    },

    revisionSiguiente () {
      const now = Date.now()
      if (now - this._revisionLastNext < 350) return
      this._revisionLastNext = now
      this.revisionMarcarRevisado()
      const total = this.revisionTotal()
      if (this.revisionCurrentIdx < total - 1) {
        this.revisionCurrentIdx++
      }
    },

    revisionAnterior () {
      if (this.revisionCurrentIdx > 0) {
        this.revisionCurrentIdx--
      }
    },

    // ── Reset — reinicia el estado de revisión restaurando el carrito original ──
    revisionReset () {
      if (this._revisionOriginalCart) {
        this.revisionCart = JSON.parse(JSON.stringify(this._revisionOriginalCart))
      }
      this.revisionReviewedIds    = []
      this.revisionMissingNames   = []
      this.revisionPendingIds     = []
      this.revisionPendingNames   = []
      this.revisionCurrentIdx     = 0
      this.revisionUndo           = null
      this._revisionLastNext      = 0
      this.revisionErrorGuardado  = null
      this.revisionGuardandoMensaje = ''
      if (this._revisionUndoTimer) {
        clearTimeout(this._revisionUndoTimer)
        this._revisionUndoTimer = null
      }
    },

    // ── Enter en input de cantidad → guardar y avanzar ─────────────
    revisionGuardarYSiguiente ($event) {
      // La cantidad ya se actualizó via @input reactivo; solo cerramos teclado y avanzamos
      if ($event?.target) $event.target.blur()
      this.revisionSiguiente()
    },

    revisionSaltarA (idx) {
      const total = this.revisionTotal()
      if (idx >= 0 && idx < total) {
        this.revisionCurrentIdx = idx
        this.revisionShowSidebar = false  // cierra sidebar en móvil tras seleccionar
      }
    },

    // ── Editar cantidad ────────────────────────────────────────
    revisionActualizarCantidad (valor) {
      const c = this.revisionCurrent()
      if (!c) return
      const num = parseFloat(valor)
      if (isNaN(num) || num <= 0) return
      // Mutación en el cart directamente
      const items = this.revisionCart[c.section]
      if (!items) return
      const idx = items.findIndex(i => i.id_producto === c.item.id_producto)
      if (idx >= 0) {
        items[idx].cantidad = num
      }
    },

    // ── Marcar faltante ────────────────────────────────────────
    revisionMarcarFaltante () {
      const c = this.revisionCurrent()
      if (!c) return
      const snapshot = JSON.parse(JSON.stringify(c.item))
      const section  = c.section
      const key      = this.revisionItemKey(section, c.item.id_producto)

      // Eliminar del carrito
      const items = this.revisionCart[section]
      if (!items) return
      const originalIdx = items.findIndex(i => i.id_producto === c.item.id_producto)
      if (originalIdx < 0) return
      items.splice(originalIdx, 1)

      // Limpiar de pendientes por si estaba flagueado antes de marcarse faltante
      if (this.revisionPendingIds.includes(key)) {
        this.revisionPendingIds   = this.revisionPendingIds.filter(k => k !== key)
        this.revisionPendingNames = this.revisionPendingNames.filter(n => n !== snapshot.nombre_producto)
      }
      // Limpiar de revisados también
      this.revisionReviewedIds = this.revisionReviewedIds.filter(k => k !== key)

      this.revisionMissingNames.push(snapshot.nombre_producto)
      if (window.sounds) window.sounds.missing()

      // Toast undo — guarda posición original para restaurar en su lugar
      this.revisionUndo = { item: snapshot, section, originalIdx }
      if (this._revisionUndoTimer) clearTimeout(this._revisionUndoTimer)
      this._revisionUndoTimer = setTimeout(() => {
        this.revisionUndo = null
        this._revisionUndoTimer = null
      }, 5000)

      // Ajustar índice si quedamos fuera de rango
      const total = this.revisionTotal()
      if (this.revisionCurrentIdx >= total && total > 0) {
        this.revisionCurrentIdx = total - 1
      }
    },

    revisionDeshacerFaltante () {
      if (!this.revisionUndo) return
      const { item, section, originalIdx } = this.revisionUndo
      if (!this.revisionCart[section]) this.revisionCart[section] = []
      // Restaurar en la posición original (o al final si ya no aplica)
      const arr = this.revisionCart[section]
      const insertAt = (originalIdx != null && originalIdx <= arr.length) ? originalIdx : arr.length
      arr.splice(insertAt, 0, item)
      this.revisionMissingNames = this.revisionMissingNames.filter(n => n !== item.nombre_producto)
      if (window.sounds) window.sounds.undo()
      this.revisionUndo = null
      if (this._revisionUndoTimer) {
        clearTimeout(this._revisionUndoTimer)
        this._revisionUndoTimer = null
      }
    },

    // ── Marcar pendiente (sigue en carrito, pero queda pendiente) ─
    revisionMarcarPendiente () {
      const c = this.revisionCurrent()
      if (!c) return
      const key = this.revisionItemKey(c.section, c.item.id_producto)

      if (this.revisionPendingIds.includes(key)) {
        // Toggle: si ya estaba pendiente, quitarlo sin avanzar
        this.revisionPendingIds = this.revisionPendingIds.filter(k => k !== key)
        this.revisionPendingNames = this.revisionPendingNames.filter(n => n !== c.item.nombre_producto)
        return
      }

      this.revisionPendingIds.push(key)
      this.revisionPendingNames.push(c.item.nombre_producto)

      // Marcar como revisado también para que avance el progreso
      if (!this.revisionReviewedIds.includes(key)) {
        this.revisionReviewedIds.push(key)
      }

      // Avanzar al siguiente automáticamente
      const total = this.revisionTotal()
      if (this.revisionCurrentIdx < total - 1) {
        this.revisionCurrentIdx++
      }
    },

    /**
     * Confirmar que un producto pendiente ya está listo.
     * Lo saca de pendientes, lo deja como revisado y avanza.
     */
    revisionConfirmarPendiente () {
      const c = this.revisionCurrent()
      if (!c) return
      const key = this.revisionItemKey(c.section, c.item.id_producto)

      this.revisionPendingIds   = this.revisionPendingIds.filter(k => k !== key)
      this.revisionPendingNames = this.revisionPendingNames.filter(n => n !== c.item.nombre_producto)

      if (!this.revisionReviewedIds.includes(key)) {
        this.revisionReviewedIds.push(key)
      }

      if (window.sounds) window.sounds.reviewed?.()

      const total = this.revisionTotal()
      if (this.revisionCurrentIdx < total - 1) {
        this.revisionCurrentIdx++
      }
    },

    // ── Swipe en card central (móvil) ──────────────────────────
    // Convención: swipe DERECHA = revisar ✓ · swipe IZQUIERDA = faltante ✗
    revisionTouchStart (e) {
      if (this.revisionSwipeLock) return
      // Solo escuchar el primer touch
      if (!e.touches || e.touches.length === 0) return
      this.revisionTouchX0 = e.touches[0].clientX
      this.revisionTouchY0 = e.touches[0].clientY
      this.revisionTouchTx = 0
      this.revisionSwipeAxisLocked = null  // 'x' | 'y' | null
    },
    revisionTouchMove (e) {
      if (this.revisionTouchX0 == null) return
      if (!e.touches || e.touches.length === 0) return
      const dx = e.touches[0].clientX - this.revisionTouchX0
      const dy = e.touches[0].clientY - (this.revisionTouchY0 ?? 0)

      // Bloquear eje: si el primer movimiento es claramente vertical (scroll),
      // ignoramos swipes horizontales para no robarle el scroll al usuario.
      if (this.revisionSwipeAxisLocked == null) {
        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
          this.revisionSwipeAxisLocked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
        }
      }
      if (this.revisionSwipeAxisLocked !== 'x') {
        this.revisionTouchTx = 0
        return
      }

      // Derecha → revisar (positivo) · Izquierda → faltante (negativo)
      this.revisionTouchTx = Math.max(-100, Math.min(120, dx))
    },
    revisionTouchEnd () {
      if (this.revisionTouchX0 == null) return
      const tx = Number(this.revisionTouchTx) || 0
      const axis = this.revisionSwipeAxisLocked
      // Reset state
      this.revisionTouchX0 = null
      this.revisionTouchY0 = null
      this.revisionTouchTx = 0
      this.revisionSwipeAxisLocked = null

      // Solo procesar si fue swipe horizontal
      if (axis !== 'x') return

      if (tx >= 80) {
        this.revisionSiguiente()          // → Revisar y avanzar
      } else if (tx <= -70) {
        this.revisionAnterior()           // ← Producto anterior
      }
    },

    // ── Finalizar ──────────────────────────────────────────────
    async revisionFinalizar () {
      if (this.revisionGuardando) return
      if (!this.revisionFolio) return
      this.revisionGuardando = true
      this.revisionErrorGuardado = null

      // Helper de retry — intenta la llamada hasta 2 veces con pausa entre intentos
      const tryFetch = async (fn, intentos = 2) => {
        for (let i = 0; i < intentos; i++) {
          try {
            return await fn()
          } catch (e) {
            const esRed = !navigator.onLine || e.message?.includes('fetch') || e.message?.includes('network')
            if (i < intentos - 1 && esRed) {
              this.revisionGuardandoMensaje = 'Reconectando…'
              await new Promise(r => setTimeout(r, 1800))
              this.revisionGuardandoMensaje = 'Reintentando…'
            } else throw e
          }
        }
      }

      try {
        // Paso 1 — guardar carrito
        this.revisionGuardandoMensaje = 'Guardando cambios…'
        const cartParaGuardar = JSON.parse(JSON.stringify(this.revisionCart))
        delete cartParaGuardar.__historial__
        delete cartParaGuardar.__orden__

        const saved = await tryFetch(() => API.post('/api/ordenes', {
          folio_numero:  this.revisionFolio,
          id_cliente:    this.revisionIdCliente,
          datos_carrito: cartParaGuardar
        }))
        if (!saved.ok) throw new Error(saved.error || 'Error al guardar cambios')

        // Paso 2 — registrar revisión en historial
        this.revisionGuardandoMensaje = 'Registrando revisión…'
        const rev = await tryFetch(() => API.post(`/api/ordenes/${this.revisionFolio}/revision`, {
          totalProductos: this.revisionTotal() + this.revisionMissingNames.length,
          faltantes:      this.revisionMissingNames,
          pendientes:     this.revisionPendingNames
        }))
        if (!rev.ok) throw new Error(rev.error || 'Error al registrar la revisión')

        if (window.sounds) window.sounds.finalize?.()
        const partes = []
        if (this.revisionMissingNames.length) partes.push(`${this.revisionMissingNames.length} faltante${this.revisionMissingNames.length !== 1 ? 's' : ''}`)
        if (this.revisionPendingNames.length)  partes.push(`${this.revisionPendingNames.length} pendiente${this.revisionPendingNames.length !== 1 ? 's' : ''}`)
        this.mostrarToast(`Revisión guardada${partes.length ? ' · ' + partes.join(' · ') : ''}`)
        this.cerrarRevision()
        await this.cargarOrdenes()
      } catch (e) {
        // Mostrar error en el modal con botón de reintentar (no cerrar el modal)
        const msg = !navigator.onLine
          ? 'Sin conexión — revisa tu red y vuelve a intentarlo'
          : (e.message || 'Error al guardar')
        this.revisionErrorGuardado = msg
        this.mostrarToast(msg, true)
      } finally {
        this.revisionGuardando = false
        this.revisionGuardandoMensaje = ''
      }
    },

    // ── Ajuste rápido de cantidad ±delta ──────────────────────
    revisionAjustarCantidad (delta) {
      const c = this.revisionCurrent()
      if (!c) return
      const unidad = (c.item.unidad || '').toLowerCase()
      // Para unidades de peso (kg, g, l) el paso mínimo es 0.5; para piezas es 1
      const esDecimal = ['kg','g','l','lt','lts','litro','litros'].includes(unidad)
      const paso = esDecimal ? 0.5 : 1
      const actual = parseFloat(c.item.cantidad) || 0
      const nueva = Math.max(paso, Math.round((actual + delta * paso) * 100) / 100)
      this.revisionActualizarCantidad(nueva)
    },

    // Indica si la cantidad del producto actual fue modificada respecto al original
    revisionCantidadModificada () {
      const c = this.revisionCurrent()
      if (!c || !this._revisionOriginalCart) return false
      const origSection = this._revisionOriginalCart[c.section]
      if (!origSection) return false
      const origItem = origSection.find(i => i.id_producto === c.item.id_producto)
      if (!origItem) return false
      return parseFloat(origItem.cantidad) !== parseFloat(c.item.cantidad)
    },

    revisionCantidadOriginal () {
      const c = this.revisionCurrent()
      if (!c || !this._revisionOriginalCart) return null
      const origSection = this._revisionOriginalCart[c.section]
      if (!origSection) return null
      const origItem = origSection.find(i => i.id_producto === c.item.id_producto)
      return origItem ? origItem.cantidad : null
    },

    // ── Cambiar producto desde revisión ───────────────────────
    revisionAbrirCambiar () {
      const c = this.revisionCurrent()
      if (!c) return
      this.revisionCambiarModal = { visible: true, busqueda: '', resultados: [], buscando: false, error: null }
      this.$nextTick(() => document.getElementById('rev-buscar-input')?.focus())
    },

    async revisionBuscarProducto () {
      const q = this.revisionCambiarModal.busqueda.trim()
      if (q.length < 2) {
        this.revisionCambiarModal.resultados = []
        this.revisionCambiarModal.error = null
        return
      }
      // Token de sesión para ignorar resultados de búsquedas anteriores (race condition)
      const searchId = Date.now()
      this._revisionSearchId = searchId

      this.revisionCambiarModal.buscando = true
      this.revisionCambiarModal.error = null
      try {
        const gid = this.revisionIdGrupo ? `&groupId=${this.revisionIdGrupo}` : ''
        const url = `/api/productos/buscar?q=${encodeURIComponent(q)}${gid}`
        let r
        try {
          r = await API.get(url)
        } catch {
          // Primer intento fallido — espera 1.5s y reintenta (TiDB cold-start)
          await new Promise(res => setTimeout(res, 1500))
          r = await API.get(url)
        }
        // Descartar si ya hay una búsqueda más reciente en vuelo
        if (this._revisionSearchId !== searchId) return
        this.revisionCambiarModal.resultados = r.ok ? (r.data || []) : []
        if (!r.ok) this.revisionCambiarModal.error = r.error || 'Error al buscar'
      } catch (e) {
        if (this._revisionSearchId !== searchId) return
        this.revisionCambiarModal.resultados = []
        this.revisionCambiarModal.error = !navigator.onLine ? 'Sin conexión' : 'Error al buscar productos'
      } finally {
        if (this._revisionSearchId === searchId) {
          this.revisionCambiarModal.buscando = false
        }
      }
    },

    revisionConfirmarCambio (prod) {
      const c = this.revisionCurrent()
      if (!c || !prod) return
      const items = this.revisionCart[c.section]
      if (!items) return
      const idx = items.findIndex(i => i.id_producto === c.item.id_producto)
      if (idx < 0) return

      const oldId      = c.item.id_producto
      const oldNombre  = c.item.nombre_producto
      const oldKey     = this.revisionItemKey(c.section, oldId)
      const newKey     = this.revisionItemKey(c.section, prod.id_producto)

      // Sustituir el item en el carrito
      items[idx] = {
        ...items[idx],
        id_producto:     prod.id_producto,
        nombre_producto: prod.nombre_producto,
        unidad:          prod.unidad_producto,
        precio_unitario: parseFloat(prod.precio_base) || items[idx].precio_unitario || 0,
        cantidad:        items[idx].cantidad   // conservar cantidad pedida
      }

      // Limpiar IDs huérfanos del producto viejo
      this.revisionReviewedIds = this.revisionReviewedIds.filter(k => k !== oldKey)
      if (this.revisionPendingIds.includes(oldKey)) {
        this.revisionPendingIds   = this.revisionPendingIds.filter(k => k !== oldKey)
        this.revisionPendingNames = this.revisionPendingNames.filter(n => n !== oldNombre)
      }

      // Marcar el producto nuevo como revisado (el usuario eligió activamente el reemplazo)
      if (!this.revisionReviewedIds.includes(newKey)) {
        this.revisionReviewedIds.push(newKey)
        if (window.sounds) window.sounds.reviewed?.()
      }

      this.revisionCambiarModal = { visible: false, busqueda: '', resultados: [], buscando: false, error: null }
      this.mostrarToast(`Cambiado a ${prod.nombre_producto}`)
    },

    // ── Detección de revisada (para badge en lista) ────────────
    /**
     * Lee __historial__ y devuelve si la nota está revisada (última entrada es 'revision').
     * Si después de la revisión hubo cambios → cuenta como no revisada.
     */
    isOrdenRevisada (orden) {
      try {
        const cart = (typeof orden.datos_carrito === 'string')
          ? JSON.parse(orden.datos_carrito)
          : (orden.datos_carrito || {})
        const hist = cart.__historial__ || []
        if (hist.length === 0) return null  // null = no info
        for (let i = hist.length - 1; i >= 0; i--) {
          const e = hist[i]
          if (e.tipoEvento === 'revision') {
            if (i !== hist.length - 1) return null  // hubo cambios después de la revisión
            const pendientes = e.pendientes || []
            return {
              reviewed: pendientes.length === 0,  // solo "revisada" si no hay pendientes
              conPendientes: pendientes.length > 0,
              usuario: e.usuario,
              fecha: e.fecha,
              faltantes: e.faltantes || [],
              pendientes
            }
          }
        }
        return null
      } catch { return null }
    }
  }
}


;/* ── public/js/modules/history.js ── */
function historyModule() {
  return {
    // ── Entradas de inventario ────────────────────────────────
    entradas: [],
    cargandoEntradas: false,

    // ── Sub-tabs del historial ────────────────────────────────
    historialTab: 'entradas',   // 'entradas' | 'pedidos'

    // ── Pedidos registrados (historial) ───────────────────────
    pedidosHistorial: [],
    cargandoPedidosHistorial: false,

    // ── Modal de detalle de pedido (solo lectura) ─────────────
    modalDetalleOrden: false,
    ordenDetalle: null,
    cargandoDetalle: false,

    // ── Cargar entradas recientes ─────────────────────────────
    async cargarEntradasRecientes() {
      this.cargandoEntradas = true
      try {
        const r = await API.get('/api/entradas/recientes')
        this.entradas = r.data || []
      } catch (err) {
        this.entradas = []
        this.mostrarToast(err.message || 'Error al cargar historial', true)
      } finally {
        this.cargandoEntradas = false
      }
    },

    // ── Cargar pedidos registrados ────────────────────────────
    async cargarPedidosHistorial() {
      this.cargandoPedidosHistorial = true
      try {
        const r = await API.get('/api/ordenes?estado=registrada')
        this.pedidosHistorial = r.data || []
      } catch (err) {
        this.pedidosHistorial = []
        this.mostrarToast(err.message || 'Error al cargar pedidos', true)
      } finally {
        this.cargandoPedidosHistorial = false
      }
    },

    // ── Abrir modal de detalle ────────────────────────────────
    async abrirDetalleOrden(orden) {
      this.cargandoDetalle = true
      this.modalDetalleOrden = true
      this.ordenDetalle = null
      try {
        const r = await API.get(`/api/ordenes/${orden.folio_numero}`)
        if (!r.ok) {
          this.mostrarToast('Error al cargar el pedido', true)
          this.modalDetalleOrden = false
          return
        }
        const o = r.data
        const cart = (typeof o.datos_carrito === 'string')
          ? JSON.parse(o.datos_carrito) : (o.datos_carrito || {})
        this.ordenDetalle = { ...o, datos_carrito: cart }
      } catch (err) {
        this.mostrarToast(err.message || 'Error al cargar el pedido', true)
        this.modalDetalleOrden = false
      } finally {
        this.cargandoDetalle = false
      }
    },

    cerrarDetalleOrden() {
      this.modalDetalleOrden = false
      this.ordenDetalle = null
      this.cargandoDetalle = false
    },

    // ── Helpers del modal detalle ─────────────────────────────
    detalleSectionNames() {
      if (!this.ordenDetalle?.datos_carrito) return []
      // Filtra claves internas (__historial__, __orden__)
      const keys = Object.keys(this.ordenDetalle.datos_carrito).filter(k => !k.startsWith('__'))
      if (keys.includes('General')) {
        return ['General', ...keys.filter(k => k !== 'General')]
      }
      return keys
    },

    detalleCartItems() {
      if (!this.ordenDetalle?.datos_carrito) return []
      return Object.entries(this.ordenDetalle.datos_carrito)
        .filter(([k]) => !k.startsWith('__'))
        .flatMap(([, v]) => Array.isArray(v) ? v : [])
    },

    detalleTotalOrden() {
      return this.detalleCartItems().reduce(
        (sum, item) => sum + ((item.cantidad || 0) * (item.precio_unitario || 0)), 0
      )
    },

    /**
     * Devuelve el historial de cambios de la orden actual (más reciente primero).
     * Compatible con app Electron (v3.6.8): entradas de cambios y de revisión.
     */
    detalleHistorial() {
      if (!this.ordenDetalle?.datos_carrito) return []
      const hist = this.ordenDetalle.datos_carrito.__historial__
      if (!Array.isArray(hist)) return []
      return [...hist].reverse()
    },

    // ── Formato de fecha ──────────────────────────────────────
    fmtFecha(f) {
      if (!f) return '—'
      const d = new Date(f)
      const utc = new Date(d.getTime() + d.getTimezoneOffset() * 60000)
      return utc.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' })
    }
  }
}


;/* ── public/js/modules/mermas.js ── */
function mermasModule() {
  return {
    // ── Estado modal ──────────────────────────────────────────
    modalMermaAbierto: false,
    guardandoMerma:    false,
    errorMerma:        '',

    // ── Formulario ────────────────────────────────────────────
    mermaForm: {
      id_producto:    null,
      nombre_producto: '',
      unidad_producto: '',
      stock_actual:   null,
      tipo:           '',
      cantidad:       '',
      fecha:          '',
      motivo:         '',
      notas:          ''
    },

    // ── Búsqueda de producto ──────────────────────────────────
    mermaBusqueda:    '',
    mermaResultados:  [],
    mermaDropVisible: false,

    // ── Historial ─────────────────────────────────────────────
    mermasRecientes:       [],
    cargandoMermas:        false,

    // ─────────────────────────────────────────────────────────

    abrirMerma() {
      this.errorMerma      = ''
      this.mermaBusqueda   = ''
      this.mermaResultados = []
      this.mermaDropVisible = false
      const hoy = new Date().toISOString().slice(0, 10)
      this.mermaForm = {
        id_producto: null, nombre_producto: '', unidad_producto: '',
        stock_actual: null, tipo: '', cantidad: '', fecha: hoy, motivo: '', notas: ''
      }
      this.modalMermaAbierto = true
    },

    cerrarMerma() {
      this.modalMermaAbierto = false
      this.errorMerma        = ''
    },

    async buscarProductoMerma() {
      const s = this.mermaBusqueda.trim()
      if (s.length < 1) { this.mermaResultados = []; this.mermaDropVisible = false; return }
      try {
        const r = await API.get(`/api/productos/buscar?q=${encodeURIComponent(s)}`)
        this.mermaResultados = r.data || []
        this.mermaDropVisible = this.mermaResultados.length > 0
      } catch {
        this.mermaResultados = []
      }
    },

    seleccionarProductoMerma(p) {
      this.mermaForm.id_producto     = p.id_producto
      this.mermaForm.nombre_producto = p.nombre_producto
      this.mermaForm.unidad_producto = p.unidad_producto
      this.mermaForm.stock_actual    = p.stock
      this.mermaBusqueda             = p.nombre_producto
      this.mermaDropVisible          = false
      this.mermaResultados           = []
      // Foco en cantidad
      this.$nextTick(() => {
        const el = document.getElementById('merma-cantidad')
        if (el) el.focus()
      })
    },

    limpiarProductoMerma() {
      this.mermaForm.id_producto     = null
      this.mermaForm.nombre_producto = ''
      this.mermaForm.unidad_producto = ''
      this.mermaForm.stock_actual    = null
      this.mermaBusqueda             = ''
    },

    calcStockResultante() {
      if (this.mermaForm.stock_actual == null) return null
      const cant = parseFloat(this.mermaForm.cantidad) || 0
      return Math.round((this.mermaForm.stock_actual - cant) * 1000) / 1000
    },

    async guardarMerma() {
      this.errorMerma = ''
      if (!this.mermaForm.id_producto)  { this.errorMerma = 'Selecciona un producto'; return }
      if (!this.mermaForm.tipo)          { this.errorMerma = 'Selecciona el tipo de merma'; return }
      const cant = parseFloat(this.mermaForm.cantidad)
      if (!cant || cant <= 0)            { this.errorMerma = 'Ingresa una cantidad válida'; return }
      if (cant > this.mermaForm.stock_actual)
        { this.errorMerma = `Cantidad mayor al stock disponible (${this.mermaForm.stock_actual} ${this.mermaForm.unidad_producto})`; return }
      if (!this.mermaForm.motivo.trim()) { this.errorMerma = 'El motivo es obligatorio'; return }

      this.guardandoMerma = true
      try {
        const r = await API.post('/api/mermas', {
          id_producto:    this.mermaForm.id_producto,
          tipo_merma:     this.mermaForm.tipo,
          cantidad_merma: cant,
          motivo:         this.mermaForm.motivo,
          fecha_merma:    this.mermaForm.fecha,
          notas:          this.mermaForm.notas || undefined
        })
        if (!r.ok) { this.errorMerma = r.error || 'Error al guardar'; return }
        this.cerrarMerma()
        this.mostrarToast(`Merma registrada — ${r.data?.nombre_producto || this.mermaForm.nombre_producto}`)
        // Refrescar stock en inventario
        await this.cargarProductos()
        await this.cargarResumen()
        await this.cargarMermasRecientes()
      } catch (e) {
        this.errorMerma = e.message || 'Error de conexión'
      } finally {
        this.guardandoMerma = false
      }
    },

    async cargarMermasRecientes() {
      this.cargandoMermas = true
      try {
        const r = await API.get('/api/mermas/recientes')
        this.mermasRecientes = r.data || []
      } catch {
        this.mermasRecientes = []
      } finally {
        this.cargandoMermas = false
      }
    },

    fmtTipoMerma(tipo) {
      const map = {
        VENCIMIENTO:       'Vencimiento',
        'DAÑO':            'Daño',
        ROBO:              'Robo',
        AJUSTE_INVENTARIO: 'Ajuste',
        OTRO:              'Otro'
      }
      return map[tipo] || tipo
    },

    colorTipoMerma(tipo) {
      const map = {
        VENCIMIENTO:       'text-orange-400',
        'DAÑO':            'text-red-400',
        ROBO:              'text-red-500',
        AJUSTE_INVENTARIO: 'text-blue-400',
        OTRO:              'text-slate-400'
      }
      return map[tipo] || 'text-slate-400'
    }
  }
}


;/* ── public/js/modules/notifications.js ── */
/**
 * DISFRULEG BODEGA — Módulo de Notificaciones Push
 *
 * Maneja el registro del Service Worker y la suscripción push.
 * Se inicializa automáticamente al cargar la app (initPush).
 */

function notificationsModule() {
  return {
    // ── Estado ────────────────────────────────────────────────
    pushSoportado:    false,   // El navegador soporta Web Push
    pushPermiso:      'default', // 'default' | 'granted' | 'denied'
    pushSuscrito:     false,   // Ya tiene suscripción activa
    pushCargando:     false,   // Procesando solicitud de suscripción

    // ── Inicialización (llamar tras login) ────────────────────
    async initPush() {
      // Guarda de idempotencia: si ya se inicializó (o está en curso) no
      // repetimos el sync. Evita POSTs duplicados a /suscribir si initPush
      // se llama dos veces seguidas (cargarTodo, login + reload, etc.).
      if (this._pushIniciado) return
      this._pushIniciado = true

      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        console.log('[push] No soportado en este navegador')
        this.pushSoportado = false
        return
      }
      this.pushSoportado  = true
      this.pushPermiso    = Notification.permission

      try {
        // Registrar service worker
        const reg = await navigator.serviceWorker.register('/sw.js')
        await navigator.serviceWorker.ready

        // Escuchar instrucciones de navegación del SW (click en notificación con app abierta)
        navigator.serviceWorker.addEventListener('message', (event) => {
          if (event.data?.type === 'NAVIGATE_TAB' && event.data?.tab) {
            this.tab = event.data.tab
            // Si estamos en home, mostrar la sección directamente
            if (event.data.tab !== 'home') {
              // Cargar datos del módulo al que navegamos
              if (event.data.tab === 'pedidos')    this.cargarOrdenes?.()
              if (event.data.tab === 'entradas')   this.cargarEntradasRecientes?.()
              if (event.data.tab === 'inventario') this.cargarProductos?.()
            }
          }
        })

        // Verificar si ya hay suscripción activa
        const sub = await reg.pushManager.getSubscription()
        this.pushSuscrito = !!sub

        console.log('[push] SW registrado. Suscrito:', this.pushSuscrito)

        // Sincronizar suscripción local al servidor (por si falló al guardar antes)
        // Incluye JWT para que el servidor pueda desactivar suscripciones antiguas del mismo usuario
        if (sub) {
          const subJson = sub.toJSON()
          const token = localStorage.getItem('bodega_token') || ''
          fetch('/api/notificaciones/suscribir', {
            method:  'POST',
            headers: {
              'Content-Type':  'application/json',
              ...(token ? { 'Authorization': `Bearer ${token}` } : {})
            },
            body:    JSON.stringify({ endpoint: subJson.endpoint, keys: subJson.keys })
          }).catch(() => {}) // best-effort, no bloquea
        }
      } catch (e) {
        console.warn('[push] Error al registrar SW:', e.message)
      }
    },

    // ── Activar notificaciones ────────────────────────────────
    async activarNotificaciones() {
      if (!this.pushSoportado || this.pushCargando) return
      this.pushCargando = true
      try {
        // 1. Pedir permiso al usuario
        const permiso = await Notification.requestPermission()
        this.pushPermiso = permiso
        if (permiso !== 'granted') {
          this.mostrarToast('Permiso de notificaciones denegado', true)
          return
        }

        // 2. Obtener VAPID public key del servidor
        const keyRes = await API.get('/api/notificaciones/vapid-key')
        if (!keyRes.ok) throw new Error('No se pudo obtener la clave VAPID')
        const vapidKey = urlBase64ToUint8Array(keyRes.key)

        // 3. Suscribirse al push manager
        const reg = await navigator.serviceWorker.ready
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly:      true,
          applicationServerKey: vapidKey
        })

        // 4. Guardar suscripción en el servidor (incluye JWT para limpiar subs antiguas)
        const subJson = sub.toJSON()
        const token = localStorage.getItem('bodega_token') || ''
        const saveRes = await fetch('/api/notificaciones/suscribir', {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
          },
          body:    JSON.stringify({ endpoint: subJson.endpoint, keys: subJson.keys })
        }).then(r => r.json())
        if (!saveRes.ok) throw new Error('No se pudo guardar la suscripción')

        this.pushSuscrito = true
        this.mostrarToast('Notificaciones activadas')
        console.log('[push] Suscripción guardada correctamente')
      } catch (e) {
        console.error('[push] Error al activar:', e.message)
        this.mostrarToast('Error al activar notificaciones', true)
      } finally {
        this.pushCargando = false
      }
    },

    // ── Desactivar notificaciones ─────────────────────────────
    async desactivarNotificaciones() {
      if (!this.pushSoportado || this.pushCargando) return
      this.pushCargando = true
      try {
        const reg = await navigator.serviceWorker.ready
        const sub = await reg.pushManager.getSubscription()
        if (sub) {
          const endpoint = sub.endpoint  // capturar antes de desuscribir
          await sub.unsubscribe()
          // Marcar inactiva en el servidor — best-effort
          const token = localStorage.getItem('bodega_token') || ''
          fetch('/api/notificaciones/desuscribir', {
            method:  'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { 'Authorization': `Bearer ${token}` } : {})
            },
            body: JSON.stringify({ endpoint })
          }).catch(() => {})
        }
        this.pushSuscrito = false
        this.mostrarToast('Notificaciones desactivadas')
      } catch (e) {
        console.error('[push] Error al desactivar:', e.message)
        this.mostrarToast('Error al desactivar notificaciones', true)
      } finally {
        this.pushCargando = false
      }
    }
  }
}

// ── Utilidad: convierte VAPID key de base64url a Uint8Array ──
function urlBase64ToUint8Array(base64String) {
  const padding  = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64   = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData  = atob(base64)
  return new Uint8Array([...rawData].map(c => c.charCodeAt(0)))
}


;/* ── public/js/modules/analytics.js ── */
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

    // ── Lista de notas ────────────────────────────────────────
    notasHoy:         [],
    notasFecha:       null,   // fecha YYYY-MM-DD cargada actualmente
    notasFiltro:      '',     // búsqueda rápida por cliente/grupo
    notaDetalle:      null,   // nota abierta en sheet de detalle
    cargandoNotas:    false,  // spinner independiente del summary

    // ── Período personalizado ─────────────────────────────────
    periodoInicio:  '',
    periodoFin:     '',
    ventasPeriodo:  null,
    topProductos:   [],

    // ── Inicialización (llamada al abrir el tab) ──────────────
    async cargarVentasHoy() {
      this.cargandoAnalytics = true
      try {
        const hoy = new Date().toISOString().split('T')[0]
        const [r, rn] = await Promise.all([
          API.get('/api/analytics/hoy'),
          API.get(`/api/analytics/notas?fecha=${hoy}`)
        ])
        this.ventasHoy = r.ok  ? r.data  : null
        this.notasHoy  = rn.ok ? rn.data : []
        this.notasFecha = hoy
        if (!r.ok) this.mostrarToast(r.error || 'Error al cargar ventas del día', true)
      } catch (err) {
        this.mostrarToast(err.message || 'Error de red', true)
        this.ventasHoy = null
        this.notasHoy  = []
      } finally {
        this.cargandoAnalytics = false
      }
    },

    // ── Cargar notas para una fecha específica (independiente del summary) ──
    async cargarNotas(fecha) {
      if (!fecha) fecha = new Date().toISOString().split('T')[0]
      this.cargandoNotas = true
      this.notasFiltro   = ''
      try {
        const r = await API.get(`/api/analytics/notas?fecha=${fecha}`)
        this.notasHoy   = r.ok ? r.data : []
        this.notasFecha = fecha
        if (!r.ok) this.mostrarToast(r.error || 'Error al cargar notas', true)
      } catch (err) {
        this.mostrarToast(err.message || 'Error de red', true)
        this.notasHoy = []
      } finally {
        this.cargandoNotas = false
      }
    },

    // ── Accesos rápidos de fecha para notas ──────────────────
    notasIrHoy() {
      this.cargarNotas(new Date().toISOString().split('T')[0])
    },

    notasIrAyer() {
      const d = new Date(); d.setDate(d.getDate() - 1)
      this.cargarNotas(d.toISOString().split('T')[0])
    },

    notasIrFecha(fecha) {
      if (fecha) this.cargarNotas(fecha)
    },

    // ── Etiqueta legible de la fecha cargada ─────────────────
    notasFechaLabel() {
      if (!this.notasFecha) return ''
      const hoy  = new Date().toISOString().split('T')[0]
      const ayer = (() => { const d = new Date(); d.setDate(d.getDate()-1); return d.toISOString().split('T')[0] })()
      if (this.notasFecha === hoy)  return 'Hoy'
      if (this.notasFecha === ayer) return 'Ayer'
      // Fecha larga: "mar 20 may"
      return new Date(this.notasFecha + 'T12:00:00').toLocaleDateString('es-MX', {
        weekday: 'short', day: 'numeric', month: 'short'
      })
    },

    notasFechaEsHoy() {
      return this.notasFecha === new Date().toISOString().split('T')[0]
    },

    notasFechaEsAyer() {
      const d = new Date(); d.setDate(d.getDate() - 1)
      return this.notasFecha === d.toISOString().split('T')[0]
    },

    // ── Lista filtrada de notas ───────────────────────────────
    notasHoyFiltradas() {
      const q = (this.notasFiltro || '').toLowerCase().trim()
      if (!q) return this.notasHoy
      return this.notasHoy.filter(n =>
        (n.nombre_cliente || '').toLowerCase().includes(q) ||
        (n.nombre_grupo   || '').toLowerCase().includes(q)
      )
    },

    // ── Hora corta de una nota, p.ej. "14:32" ────────────────
    notaHora(fechaISO) {
      if (!fechaISO) return ''
      const d = new Date(fechaISO)
      return d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
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


;/* ── public/js/modules/admin.js ── */
/**
 * admin.js — Módulo Alpine.js para gestión de sesiones y permisos
 * Solo visible/funcional para rol "admin"
 */

// Módulos disponibles en la appweb bodega
const MODULOS_BODEGA = [
  { id: 'inventario', label: 'Inventario',  desc: 'Stock y entradas' },
  { id: 'pedidos',    label: 'Pedidos',     desc: 'Crear y gestionar órdenes' },
  { id: 'historial',  label: 'Historial',   desc: 'Historial de movimientos' },
  { id: 'analytics',  label: 'Ventas',      desc: 'Analytics y ganancias' },
  { id: 'mermas',     label: 'Mermas',      desc: 'Registro de mermas' },
  { id: 'cobranza',   label: 'Cobranza',    desc: 'Deudas y registro de pagos' },
  { id: 'compras',    label: 'Compras',     desc: 'Historial de gastos de compra' },
]

const MODULOS_ACTIVIDAD = [
  { id: '',           label: 'Todos' },
  { id: 'auth',       label: 'Accesos' },
  { id: 'inventario', label: 'Inventario' },
  { id: 'pedidos',    label: 'Pedidos' },
  { id: 'mermas',     label: 'Mermas' },
  { id: 'cobranza',   label: 'Cobranza' },
]

const ACCION_ICONS = {
  login:             '🔑',
  entrada:           '📦',
  merma:             '⚠️',
  orden_nueva:       '🛒',
  orden_actualizada: '✏️',
  pago:              '💰',
}

function adminModule() {
  return {
    // ── Estado ────────────────────────────────────────────
    adminPanelAbierto:   false,
    adminTab:            'sesiones',   // 'sesiones' | 'usuarios' | 'actividad'
    sesiones:            [],
    cargandoSesiones:    false,
    usuariosAdmin:       [],
    cargandoUsuarios:    false,
    modulosBodega:       MODULOS_BODEGA,

    // Edición de permisos de supervisor
    editandoUsuario:     null,         // objeto usuario seleccionado
    editPermisos:        [],           // array de modulo_id seleccionados

    // Historial de actividad
    actividadLogs:       [],
    cargandoActividad:   false,
    actividadModulo:     '',           // filtro por módulo
    actividadUsuario:    '',           // filtro por usuario
    modulosActividad:    MODULOS_ACTIVIDAD,

    // ── Abrir / cerrar panel ──────────────────────────────
    async abrirAdminPanel() {
      this.adminPanelAbierto = true
      this.adminTab = 'sesiones'
      await this.cargarSesiones()
    },

    cerrarAdminPanel() {
      this.adminPanelAbierto = false
      this.editandoUsuario   = null
      this.editPermisos      = []
    },

    async cambiarAdminTab(tab) {
      this.adminTab = tab
      if (tab === 'sesiones'  && !this.sesiones.length)     await this.cargarSesiones()
      if (tab === 'usuarios'  && !this.usuariosAdmin.length) await this.cargarUsuarios()
      if (tab === 'actividad' && !this.actividadLogs.length) await this.cargarActividad()
    },

    // ── Sesiones ──────────────────────────────────────────
    async cargarSesiones() {
      this.cargandoSesiones = true
      try {
        const r = await API.getSesiones()
        if (r.ok) this.sesiones = r.sesiones
      } catch { /* silent */ }
      finally { this.cargandoSesiones = false }
    },

    async revocarSesion(jti, nombre) {
      if (!confirm(`¿Cerrar la sesión de ${nombre}?`)) return
      try {
        const r = await API.revocarSesion(jti)
        if (r.ok) {
          this.sesiones = this.sesiones.filter(s => s.jti !== jti)
          this.mostrarToast(`Sesión de ${nombre} cerrada`)
        } else {
          this.mostrarToast(r.error || 'Error al cerrar sesión', true)
        }
      } catch {
        this.mostrarToast('Error de conexión', true)
      }
    },

    /** Cierra todas las sesiones antiguas de un usuario dejando solo la más reciente */
    async limpiarSesionesUsuario(idUsuario, nombre) {
      try {
        const r = await API.post('/api/admin/sesiones/limpiar', { id_usuario: idUsuario })
        if (r.ok) {
          this.mostrarToast(`${r.cerradas} sesiones antiguas de ${nombre} cerradas`)
          await this.cargarSesiones()
        } else {
          this.mostrarToast(r.error || 'Error al limpiar', true)
        }
      } catch {
        this.mostrarToast('Error de conexión', true)
      }
    },

    fmtSesionFecha(fecha) {
      if (!fecha) return '—'
      const d = new Date(fecha)
      const hoy = new Date()
      const diff = Math.floor((hoy - d) / 60000) // minutos
      if (diff < 1)  return 'Ahora mismo'
      if (diff < 60) return `Hace ${diff} min`
      if (diff < 1440) return `Hace ${Math.floor(diff / 60)}h`
      return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })
    },

    fmtUserAgent(ua) {
      if (!ua) return 'Desconocido'
      if (/iPhone|iPad/i.test(ua))  return '📱 iPhone/iPad'
      if (/Android/i.test(ua))      return '📱 Android'
      if (/Mac/i.test(ua))          return '🖥️ Mac'
      if (/Windows/i.test(ua))      return '🖥️ Windows'
      return '🌐 Navegador'
    },

    // ── Usuarios y permisos ───────────────────────────────
    async cargarUsuarios() {
      this.cargandoUsuarios = true
      try {
        const r = await API.getUsuariosAdmin()
        if (r.ok) this.usuariosAdmin = r.usuarios
      } catch { /* silent */ }
      finally { this.cargandoUsuarios = false }
    },

    abrirEditarPermisos(usuario) {
      this.editandoUsuario = usuario
      this.editPermisos    = [...(usuario.modulosPermitidos || [])]
    },

    togglePermiso(moduloId) {
      if (this.editPermisos.includes(moduloId)) {
        this.editPermisos = this.editPermisos.filter(m => m !== moduloId)
      } else {
        this.editPermisos = [...this.editPermisos, moduloId]
      }
    },

    async guardarPermisos() {
      if (!this.editandoUsuario) return
      try {
        const r = await API.updatePermisos(this.editandoUsuario.id_usuario, this.editPermisos)
        if (r.ok) {
          // Actualizar en lista local
          const idx = this.usuariosAdmin.findIndex(u => u.id_usuario === this.editandoUsuario.id_usuario)
          if (idx !== -1) this.usuariosAdmin[idx].modulosPermitidos = [...this.editPermisos]
          this.editandoUsuario = null
          this.editPermisos    = []
          this.mostrarToast('Permisos actualizados')
        } else {
          this.mostrarToast(r.error || 'Error al guardar', true)
        }
      } catch {
        this.mostrarToast('Error de conexión', true)
      }
    },

    rolBadgeClass(rol) {
      // Nota: usamos colores con suficiente contraste entre texto y fondo
      // (text-* y bg-* en tonos distintos) para evitar que el badge salga
      // como pastilla sólida sin texto legible si el CDN de Tailwind colapsa
      // la variante /10 de opacidad.
      if (rol === 'admin')      return 'badge-rol badge-rol-admin'
      if (rol === 'supervisor') return 'badge-rol badge-rol-supervisor'
      return 'badge-rol badge-rol-usuario'
    },

    // ── Historial de actividad ─────────────────────────────
    async cargarActividad() {
      this.cargandoActividad = true
      try {
        const params = { limit: 60 }
        if (this.actividadModulo)  params.modulo  = this.actividadModulo
        if (this.actividadUsuario) params.usuario = this.actividadUsuario.toUpperCase()
        const r = await API.getActividad(params)
        if (r.ok) this.actividadLogs = r.data
      } catch { /* silent */ }
      finally { this.cargandoActividad = false }
    },

    async filtrarActividad() {
      this.actividadLogs = []
      await this.cargarActividad()
    },

    actividadIcono(accion) {
      return ACCION_ICONS[accion] || '•'
    },

    actividadFecha(fecha) {
      if (!fecha) return '—'
      const d = new Date(fecha)
      const hoy = new Date()
      const diff = Math.floor((hoy - d) / 60000)
      if (diff < 1)    return 'Ahora'
      if (diff < 60)   return `${diff} min`
      if (diff < 1440) return `${Math.floor(diff / 60)}h`
      return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' }) +
             ' ' + d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
    },

    actividadDetalles(detallesStr) {
      if (!detallesStr) return ''
      try {
        const d = JSON.parse(detallesStr)
        return Object.entries(d)
          .map(([k, v]) => `${k}: ${v}`)
          .join(' · ')
      } catch { return detallesStr }
    },

    actividadModuloClass(modulo) {
      const map = {
        auth:       'text-violet-400 bg-violet-400/10',
        inventario: 'text-blue-400 bg-blue-400/10',
        pedidos:    'text-emerald-400 bg-emerald-400/10',
        mermas:     'text-orange-400 bg-orange-400/10',
        cobranza:   'text-yellow-400 bg-yellow-400/10',
      }
      return map[modulo] || 'text-slate-400 bg-slate-400/10'
    }
  }
}


;/* ── public/js/modules/cobranza.js ── */
/**
 * cobranza.js — Módulo Alpine.js para el panel de cobranza móvil
 *
 * Vista: lista de deudas con semáforo → detalle → registrar pago → WhatsApp
 */

function cobranzaModule() {
  return {
    // ── Estado ────────────────────────────────────────────
    cobranzaVista:      'lista',    // 'lista' | 'detalle'
    deudas:             [],
    deudaStats:         {},
    deudaSeleccionada:  null,
    pagosDeuda:         [],
    cargandoDeudas:     false,
    cargandoPagos:      false,
    cobranzaFiltro:     'todos',    // 'todos' | 'vencida' | 'por_vencer' | 'al_dia'
    cobranzaBusqueda:   '',

    // ── Modal de pago ─────────────────────────────────────
    modalPagoAbierto:   false,
    pagoForm: {
      monto:        '',
      metodoPago:   'efectivo',
      referencia:   '',
      notas:        '',
      razonParcial: ''
    },
    guardandoPago:      false,
    pagoError:          '',

    // ── Cargar lista ──────────────────────────────────────
    async cargarDeudas() {
      this.cargandoDeudas = true
      try {
        const params = new URLSearchParams()
        if (this.cobranzaFiltro !== 'todos') params.set('estado', this.cobranzaFiltro)
        if (this.cobranzaBusqueda.trim())    params.set('busqueda', this.cobranzaBusqueda.trim())

        const [r, s] = await Promise.all([
          API.get(`/api/deudas?${params}`),
          API.get('/api/deudas/stats')
        ])
        if (r.ok) this.deudas      = r.data
        if (s.ok) this.deudaStats  = s.data
      } catch { /* silent */ }
      finally { this.cargandoDeudas = false }
    },

    async abrirDeuda(deuda) {
      this.deudaSeleccionada = deuda
      this.cobranzaVista     = 'detalle'
      this.cargandoPagos     = true
      try {
        const r = await API.get(`/api/deudas/${deuda.id_deuda}/pagos`)
        if (r.ok) this.pagosDeuda = r.data
      } catch { /* silent */ }
      finally { this.cargandoPagos = false }
    },

    volverALista() {
      this.cobranzaVista    = 'lista'
      this.deudaSeleccionada = null
      this.pagosDeuda        = []
    },

    // ── WhatsApp ──────────────────────────────────────────
    abrirWhatsApp(deuda) {
      const tel = (deuda.telefono || '').replace(/\D/g, '')
      if (!tel) {
        this.mostrarToast('Este cliente no tiene teléfono registrado', true)
        return
      }
      const numero   = tel.startsWith('52') ? tel : `52${tel}`
      const saldo    = this.fmtMoney(deuda.saldo_pendiente)
      const folio    = deuda.id_factura ? `#${String(deuda.id_factura).padStart(4, '0')}` : ''
      const vence    = deuda.fecha_vencimiento
        ? new Date(deuda.fecha_vencimiento).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: '2-digit' })
        : ''

      let msg = `Hola ${deuda.nombre_cliente}, le recordamos que tiene un saldo pendiente de ${saldo}`
      if (folio) msg += ` correspondiente a la nota ${folio}`
      if (vence) msg += `, con fecha de vencimiento el ${vence}`
      msg += `.\n\nPor favor contáctenos para coordinar el pago.\n\nDISFRULEG`

      window.open(`https://wa.me/${numero}?text=${encodeURIComponent(msg)}`, '_blank')
    },

    // ── Modal de pago ─────────────────────────────────────
    abrirModalPago(deuda) {
      this.deudaSeleccionada = deuda
      this.pagoForm = {
        monto:        parseFloat(deuda.saldo_pendiente).toFixed(2),
        metodoPago:   'efectivo',
        referencia:   '',
        notas:        '',
        razonParcial: ''
      }
      this.pagoError        = ''
      this.modalPagoAbierto = true
    },

    cerrarModalPago() {
      this.modalPagoAbierto = false
      this.pagoError        = ''
    },

    esPagoParcial() {
      const deuda = this.deudaSeleccionada
      if (!deuda) return false
      const monto = parseFloat(this.pagoForm.monto) || 0
      return monto < parseFloat(deuda.saldo_pendiente) - 0.01
    },

    async confirmarPago() {
      const deuda = this.deudaSeleccionada
      if (!deuda) return

      this.pagoError = ''
      const monto = parseFloat(this.pagoForm.monto)
      if (!monto || monto <= 0) { this.pagoError = 'Ingresa un monto válido'; return }
      if (this.esPagoParcial() && !this.pagoForm.razonParcial.trim()) {
        this.pagoError = 'Explica el motivo del pago parcial'
        return
      }

      this.guardandoPago = true
      try {
        const r = await API.post('/api/pagos', {
          idDeuda:      deuda.id_deuda,
          monto,
          metodoPago:   this.pagoForm.metodoPago,
          referencia:   this.pagoForm.referencia || null,
          notas:        this.pagoForm.notas || null,
          razonParcial: this.pagoForm.razonParcial || null
        })

        if (!r.ok) { this.pagoError = r.error || 'Error al registrar pago'; return }

        this.cerrarModalPago()

        if (r.pagada) {
          this.mostrarToast(`✅ Deuda de ${deuda.nombre_cliente} saldada`)
          // Quitar de la lista
          this.deudas = this.deudas.filter(d => d.id_deuda !== deuda.id_deuda)
          this.volverALista()
        } else {
          this.mostrarToast(`Pago de ${this.fmtMoney(monto)} registrado`)
          // Actualizar saldo en lista y detalle
          const nuevo = parseFloat(deuda.saldo_pendiente) - monto
          const idx   = this.deudas.findIndex(d => d.id_deuda === deuda.id_deuda)
          if (idx !== -1) {
            this.deudas[idx].saldo_pendiente = nuevo
            this.deudas[idx].monto_pagado    = parseFloat(deuda.monto_pagado) + monto
          }
          if (this.deudaSeleccionada?.id_deuda === deuda.id_deuda) {
            this.deudaSeleccionada.saldo_pendiente = nuevo
            this.deudaSeleccionada.monto_pagado    = parseFloat(deuda.monto_pagado) + monto
            // Recargar historial de pagos
            const hp = await API.get(`/api/deudas/${deuda.id_deuda}/pagos`)
            if (hp.ok) this.pagosDeuda = hp.data
          }
        }
        // Actualizar stats
        const s = await API.get('/api/deudas/stats')
        if (s.ok) this.deudaStats = s.data
      } catch {
        this.pagoError = 'Error de conexión'
      } finally {
        this.guardandoPago = false
      }
    },

    // ── Helpers ───────────────────────────────────────────
    semaforoClass(semaforo) {
      switch (semaforo) {
        case 'vencida':     return 'text-red-400 bg-red-400/10 border-red-400/30'
        case 'por_vencer':  return 'text-amber-400 bg-amber-400/10 border-amber-400/30'
        case 'al_dia':      return 'text-emerald-400 bg-emerald-400/10 border-emerald-400/30'
        default:            return 'text-slate-400 bg-slate-400/10 border-slate-400/20'
      }
    },

    semaforoDot(semaforo) {
      switch (semaforo) {
        case 'vencida':     return 'bg-red-400'
        case 'por_vencer':  return 'bg-amber-400'
        case 'al_dia':      return 'bg-emerald-400'
        default:            return 'bg-slate-500'
      }
    },

    semaforoLabel(semaforo, diasRestantes) {
      switch (semaforo) {
        case 'vencida':     return `Vencida hace ${Math.abs(diasRestantes)} día${Math.abs(diasRestantes) !== 1 ? 's' : ''}`
        case 'por_vencer':  return diasRestantes === 0 ? 'Vence hoy' : `Vence en ${diasRestantes} día${diasRestantes !== 1 ? 's' : ''}`
        case 'al_dia':      return `${diasRestantes} días restantes`
        default:            return 'Sin plazo'
      }
    },

    porcentajePagado(deuda) {
      if (!deuda || !deuda.monto_total || deuda.monto_total <= 0) return 0
      return Math.min(100, Math.round((deuda.monto_pagado / deuda.monto_total) * 100))
    },

    fmtMoney(v) {
      return '$' + parseFloat(v || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    },

    fmtFechaPago(f) {
      if (!f) return '—'
      return new Date(f).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: '2-digit' })
    }
  }
}


;/* ── public/js/modules/compras.js ── */
/**
 * compras.js — Módulo Alpine.js para el tab de Compras
 *
 * Muestra resumen diario de gastos de compra con desglose por producto y proveedor.
 * Se mezcla en bodega() mediante spread en bodega.js.
 */

function comprasModule() {
  const hoy    = () => new Date().toISOString().slice(0, 10)
  const hace30 = () => new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)

  return {
    // ── Estado ────────────────────────────────────────────────
    comprasCargando:    false,
    comprasDias:        [],          // array de { fecha, total_gasto, compras: [...], ... }
    comprasResumen:     {},          // { total_periodo, total_compras, dias_con_gasto }
    comprasDesde:       hace30(),
    comprasHasta:       hoy(),
    comprasDiaOpen:     null,        // fecha del día expandido (null = todos cerrados)
    comprasError:       '',

    // ── Cargar datos ──────────────────────────────────────────
    async cargarCompras() {
      this.comprasCargando = true
      this.comprasError    = ''
      try {
        const r = await API.get(
          `/api/compras/resumen?desde=${this.comprasDesde}&hasta=${this.comprasHasta}`
        )
        if (!r.ok) { this.comprasError = r.error || 'Error al cargar compras'; return }
        this.comprasDias    = r.dias    || []
        this.comprasResumen = r.resumen || {}
        this.comprasDiaOpen = null
      } catch (e) {
        this.comprasError = e.message || 'Error de conexión'
      } finally {
        this.comprasCargando = false
      }
    },

    // ── Filtros rápidos ───────────────────────────────────────
    async filtroCompras(periodo) {
      const h = new Date()
      if (periodo === 'hoy') {
        this.comprasDesde = this.comprasHasta = h.toISOString().slice(0, 10)
      } else if (periodo === '7d') {
        this.comprasDesde = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
        this.comprasHasta = h.toISOString().slice(0, 10)
      } else if (periodo === '30d') {
        this.comprasDesde = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
        this.comprasHasta = h.toISOString().slice(0, 10)
      } else if (periodo === 'mes') {
        this.comprasDesde = `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}-01`
        this.comprasHasta = h.toISOString().slice(0, 10)
      }
      await this.cargarCompras()
    },

    // ── Expandir / colapsar día ───────────────────────────────
    toggleDiaCompras(fecha) {
      this.comprasDiaOpen = this.comprasDiaOpen === fecha ? null : fecha
    },

    // ── Helpers de formato ────────────────────────────────────
    fmtFechaCompra(f) {
      if (!f) return '—'
      const [y, m, d] = f.split('-').map(Number)
      const utc = new Date(Date.UTC(y, m - 1, d))
      return utc.toLocaleDateString('es-MX', {
        weekday: 'short', day: 'numeric', month: 'short'
      })
    },

    fmtMoney(v) {
      return '$' + parseFloat(v || 0).toLocaleString('es-MX', {
        minimumFractionDigits: 2, maximumFractionDigits: 2
      })
    },

    // Agrupar compras del día por proveedor
    comprasPorProveedor(compras) {
      const map = {}
      for (const c of compras) {
        const prov = c.proveedor || '—'
        if (!map[prov]) map[prov] = { proveedor: prov, items: [], total: 0 }
        map[prov].items.push(c)
        map[prov].total += c.total
      }
      return Object.values(map).sort((a, b) => b.total - a.total)
    }
  }
}


;/* ── public/js/modules/dashboard.js ── */
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


;/* ── public/js/bodega.js ── */
// Composición del store Alpine.js.
// Orden: ui → auth → inventory → entries → orders → review → history → mermas → notifications → analytics → admin → cobranza → compras → dashboard
function bodega() {
  return {
    ...uiModule(),
    ...authModule(),
    ...inventoryModule(),
    ...entriesModule(),
    ...ordersModule(),
    ...reviewModule(),
    ...historyModule(),
    ...mermasModule(),
    ...notificationsModule(),
    ...analyticsModule(),
    ...adminModule(),
    ...cobranzaModule(),
    ...comprasModule(),
    ...dashboardModule(),
  }
}
