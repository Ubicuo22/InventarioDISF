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

  async patch(path, body) {
    const res = await this._fetch(this._base + path, {
      method: 'PATCH',
      headers: this._headers(),
      body: JSON.stringify(body || {})
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
