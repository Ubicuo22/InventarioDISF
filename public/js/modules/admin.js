/**
 * admin.js — Módulo Alpine.js para gestión de sesiones y permisos
 * Solo visible/funcional para rol "admin"
 */

// Módulos disponibles en la appweb bodega
const MODULOS_BODEGA = [
  { id: 'inventario', label: 'Inventario',  desc: 'Stock y entradas' },
  { id: 'pedidos',    label: 'Pedidos',     desc: 'Órdenes y UbicuoAI' },
  { id: 'historial',  label: 'Historial',   desc: 'Historial de movimientos' },
  { id: 'analytics',  label: 'Ventas',      desc: 'Analytics y ganancias' },
  { id: 'mermas',     label: 'Mermas',      desc: 'Registro de mermas' },
]

function adminModule() {
  return {
    // ── Estado ────────────────────────────────────────────
    adminPanelAbierto:   false,
    adminTab:            'sesiones',   // 'sesiones' | 'usuarios'
    sesiones:            [],
    cargandoSesiones:    false,
    usuariosAdmin:       [],
    cargandoUsuarios:    false,
    modulosBodega:       MODULOS_BODEGA,

    // Edición de permisos de supervisor
    editandoUsuario:     null,         // objeto usuario seleccionado
    editPermisos:        [],           // array de modulo_id seleccionados

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
      if (tab === 'sesiones' && !this.sesiones.length) await this.cargarSesiones()
      if (tab === 'usuarios' && !this.usuariosAdmin.length) await this.cargarUsuarios()
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
      if (rol === 'admin')      return 'text-emerald-400 bg-emerald-400/10'
      if (rol === 'supervisor') return 'text-blue-400 bg-blue-400/10'
      return 'text-slate-500 bg-slate-500/10'
    }
  }
}
