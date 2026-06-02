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
