/**
 * api.js — Wrapper de fetch con autenticación JWT
 * Todas las llamadas al servidor pasan por aquí
 */

const API = {
  _base: '',  // mismo origen

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

  async _handle(res) {
    const data = await res.json()
    if (!data.ok && res.status === 401) {
      // Token expirado — forzar logout
      window.dispatchEvent(new CustomEvent('session-expired'))
    }
    return data
  },

  async get(path) {
    const res = await fetch(this._base + path, { headers: this._headers() })
    return this._handle(res)
  },

  async post(path, body) {
    const res = await fetch(this._base + path, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body)
    })
    return this._handle(res)
  },

  // Login — no requiere token previo
  async login(username, password) {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    })
    return res.json()
  }
}
