/**
 * prices.js — Módulo Alpine.js para gestión de precios por grupo (solo CEO)
 */

function preciosModule() {
  return {
    // ── Estado ────────────────────────────────────────────
    preciosGrupos:       [],
    preciosIdGrupo:      null,
    preciosProductos:    [],
    preciosBusqueda:     '',
    preciosCargando:     false,
    preciosGuardando:    {},   // { id_producto: true } mientras se guarda
    precioEditando:      {},   // { id_producto: 'string' } valor en edición

    preciosAjusteModal: {
      visible: false,
      pct:     '',
      error:   null,
      guardando: false,
    },

    preciosCopiarModal: {
      visible:          false,
      id_grupo_destino: '',
      sobrescribir:     false,
      error:            null,
      guardando:        false,
    },

    // ── Init ──────────────────────────────────────────────
    async cargarPreciosGrupos() {
      if (this.session?.rol !== 'ceo') return
      try {
        const r = await API.get('/api/precios/grupos')
        if (r.ok) {
          this.preciosGrupos = r.data || []
          if (this.preciosGrupos.length && !this.preciosIdGrupo) {
            this.preciosIdGrupo = this.preciosGrupos[0].id_grupo
            await this.cargarPrecios()
          }
        } else {
          this.mostrarToast(r.error || 'Error al cargar grupos', true)
        }
      } catch (e) {
        this.mostrarToast('Error de conexión', true)
      }
    },

    async cargarPrecios() {
      if (!this.preciosIdGrupo) return
      this.preciosCargando = true
      this.precioEditando  = {}
      try {
        const r = await API.get(`/api/precios?id_grupo=${this.preciosIdGrupo}`)
        if (r.ok) {
          this.preciosProductos = r.data || []
        } else {
          this.preciosProductos = []
          this.mostrarToast(r.error || 'Error al cargar precios', true)
        }
      } catch (e) {
        this.preciosProductos = []
        this.mostrarToast('Error de conexión', true)
      } finally {
        this.preciosCargando = false
      }
    },

    async preciosCambiarGrupo(id_grupo) {
      this.preciosIdGrupo  = id_grupo
      this.preciosBusqueda = ''
      await this.cargarPrecios()
    },

    // ── Filtrado ──────────────────────────────────────────
    preciosFiltrados() {
      const q = this.preciosBusqueda.trim().toLowerCase()
      if (!q) return this.preciosProductos
      return this.preciosProductos.filter(p =>
        p.nombre_producto.toLowerCase().includes(q)
      )
    },

    // ── Edición inline ────────────────────────────────────
    precioIniciarEdicion(prod) {
      this.precioEditando = {
        ...this.precioEditando,
        [prod.id_producto]: prod.precio_base > 0 ? String(prod.precio_base) : ''
      }
      this.$nextTick(() => {
        document.getElementById(`precio-input-${prod.id_producto}`)?.focus()
      })
    },

    async precioGuardar(id_producto) {
      const raw    = (this.precioEditando[id_producto] ?? '').trim()
      const precio = parseFloat(raw.replace(',', '.'))

      if (raw !== '' && (isNaN(precio) || precio < 0)) {
        this.mostrarToast('Precio inválido', true)
        return
      }

      const precio_base = raw === '' ? 0 : precio
      this.preciosGuardando = { ...this.preciosGuardando, [id_producto]: true }

      try {
        const r = await API.put('/api/precios', {
          id_producto,
          id_grupo: this.preciosIdGrupo,
          precio_base,
        })
        if (r.ok) {
          const idx = this.preciosProductos.findIndex(p => p.id_producto === id_producto)
          if (idx >= 0) {
            const grupo = this.preciosGrupos.find(g => g.id_grupo === this.preciosIdGrupo)
            const desc  = grupo ? parseFloat(grupo.descuento) : 0
            this.preciosProductos[idx] = {
              ...this.preciosProductos[idx],
              precio_base,
              precio_final: desc > 0 ? +(precio_base * (1 - desc / 100)).toFixed(2) : precio_base,
            }
          }
          const del = { ...this.precioEditando }
          delete del[id_producto]
          this.precioEditando = del
        } else {
          this.mostrarToast(r.error || 'No se pudo guardar', true)
        }
      } catch (e) {
        this.mostrarToast('Error al guardar precio', true)
      } finally {
        const g = { ...this.preciosGuardando }
        delete g[id_producto]
        this.preciosGuardando = g
      }
    },

    preciosCancelarEdicion(id_producto) {
      const del = { ...this.precioEditando }
      delete del[id_producto]
      this.precioEditando = del
    },

    // ── Ajuste masivo ─────────────────────────────────────
    preciosAbrirAjuste() {
      this.preciosAjusteModal = { visible: true, pct: '', error: null, guardando: false }
      this.$nextTick(() => document.getElementById('precios-ajuste-pct')?.focus())
    },

    async preciosConfirmarAjuste() {
      const pct = parseFloat(String(this.preciosAjusteModal.pct).replace(',', '.'))
      if (isNaN(pct) || pct === 0) {
        this.preciosAjusteModal.error = 'Ingresa un porcentaje válido (ej: 10 o -5)'
        return
      }
      this.preciosAjusteModal.guardando = true
      this.preciosAjusteModal.error     = null
      try {
        const r = await API.post('/api/precios/ajuste-masivo', {
          id_grupo: this.preciosIdGrupo,
          pct,
        })
        if (r.ok) {
          this.mostrarToast(`${r.data?.actualizados ?? 0} precios actualizados`)
          this.preciosAjusteModal.visible = false
          await this.cargarPrecios()
        } else {
          this.preciosAjusteModal.error = r.error || 'Error al aplicar ajuste'
        }
      } catch {
        this.preciosAjusteModal.error = 'Error de conexión'
      } finally {
        this.preciosAjusteModal.guardando = false
      }
    },

    // ── Copiar grupo ──────────────────────────────────────
    preciosAbrirCopiar() {
      this.preciosCopiarModal = {
        visible:          true,
        id_grupo_destino: '',
        sobrescribir:     false,
        error:            null,
        guardando:        false,
      }
    },

    async preciosConfirmarCopiar() {
      const { id_grupo_destino, sobrescribir } = this.preciosCopiarModal
      if (!id_grupo_destino) {
        this.preciosCopiarModal.error = 'Selecciona el grupo destino'
        return
      }
      this.preciosCopiarModal.guardando = true
      this.preciosCopiarModal.error     = null
      try {
        const r = await API.post('/api/precios/copiar-grupo', {
          id_grupo_origen:  this.preciosIdGrupo,
          id_grupo_destino,
          sobrescribir,
        })
        if (r.ok) {
          this.mostrarToast(`${r.data?.copiados ?? 0} precios copiados`)
          this.preciosCopiarModal.visible = false
        } else {
          this.preciosCopiarModal.error = r.error || 'Error al copiar'
        }
      } catch {
        this.preciosCopiarModal.error = 'Error de conexión'
      } finally {
        this.preciosCopiarModal.guardando = false
      }
    },

    // ── Helpers ───────────────────────────────────────────
    preciosFmtMoney(v) {
      const n = parseFloat(v) || 0
      return n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 })
    },

    preciosGrupoActual() {
      return this.preciosGrupos.find(g => g.id_grupo === this.preciosIdGrupo) || null
    },

    preciosGruposDestino() {
      return this.preciosGrupos.filter(g => g.id_grupo !== this.preciosIdGrupo)
    },
  }
}
