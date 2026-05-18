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
    revisionNombreCliente: '',
    revisionNombreGrupo: '',
    revisionCurrentIdx: 0,
    revisionReviewedIds: [],            // ["seccion::id_producto", ...]
    revisionMissingNames: [],
    revisionGuardando: false,
    revisionShowSidebar: false,         // collapsable en móvil
    // Undo toast
    revisionUndo: null,                 // { item, section } | null
    _revisionUndoTimer: null,
    // Swipe state
    revisionTouchX0: null,
    revisionTouchTx: 0,
    revisionSwipeLock: false,

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
        this.revisionFolio = o.folio_numero
        this.revisionNombreCliente = o.nombre_cliente
        this.revisionNombreGrupo = o.nombre_grupo
        this.revisionCurrentIdx = 0
        this.revisionReviewedIds = []
        this.revisionMissingNames = []
        this.revisionUndo = null
        this.revisionShowSidebar = false
        this.revisionTouchX0 = null
        this.revisionTouchTx = 0
        this.revisionModalOpen = true
      } catch (e) {
        this.mostrarToast(e.message || 'Error al cargar pedido', true)
      }
    },

    cerrarRevision () {
      this.revisionModalOpen = false
      this.revisionCart = { General: [] }
      this.revisionFolio = null
      this.revisionReviewedIds = []
      this.revisionMissingNames = []
      this.revisionCurrentIdx = 0
      this.revisionUndo = null
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
      const section = c.section

      // Eliminar del carrito
      const items = this.revisionCart[section]
      if (!items) return
      const idx = items.findIndex(i => i.id_producto === c.item.id_producto)
      if (idx >= 0) items.splice(idx, 1)

      this.revisionMissingNames.push(snapshot.nombre_producto)
      if (window.sounds) window.sounds.missing()

      // Toast undo
      this.revisionUndo = { item: snapshot, section }
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
      const { item, section } = this.revisionUndo
      if (!this.revisionCart[section]) this.revisionCart[section] = []
      this.revisionCart[section].push(item)
      this.revisionMissingNames = this.revisionMissingNames.filter(n => n !== item.nombre_producto)
      if (window.sounds) window.sounds.undo()
      this.revisionUndo = null
      if (this._revisionUndoTimer) {
        clearTimeout(this._revisionUndoTimer)
        this._revisionUndoTimer = null
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

      // Limitamos a ±120px para feedback visual
      this.revisionTouchTx = Math.max(-120, Math.min(120, dx))
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
        // swipe DERECHA → marcar revisado y avanzar
        this.revisionSiguiente()
      } else if (tx <= -80) {
        // swipe IZQUIERDA → marcar faltante
        this.revisionMarcarFaltante()
      }
    },

    // ── Finalizar ──────────────────────────────────────────────
    async revisionFinalizar () {
      if (this.revisionGuardando) return
      if (!this.revisionFolio) return
      this.revisionGuardando = true
      try {
        // 1) Guardar cambios de cantidad (POST a /api/ordenes con folio existente)
        //    El backend computa el diff vs el carrito previo y agrega al __historial__
        const cartParaGuardar = { ...this.revisionCart }
        delete cartParaGuardar.__historial__  // backend lo regenera con diff
        // necesitamos id_cliente — lo buscamos por folio. Ya está cargado en revisionCart si llegó por GET,
        // pero por simplicidad lo pedimos al servidor:
        const detalle = await API.get(`/api/ordenes/${this.revisionFolio}`)
        if (!detalle.ok) {
          this.mostrarToast(detalle.error || 'Error al validar la orden', true)
          this.revisionGuardando = false
          return
        }

        const saveBody = {
          folio_numero: this.revisionFolio,
          id_cliente: detalle.data.id_cliente,
          datos_carrito: cartParaGuardar
        }
        const saved = await API.post('/api/ordenes', saveBody)
        if (!saved.ok) {
          this.mostrarToast(saved.error || 'Error al guardar cambios', true)
          this.revisionGuardando = false
          return
        }

        // 2) Registrar la revisión completa en el historial
        const revBody = {
          totalProductos: this.revisionTotal() + this.revisionMissingNames.length,
          faltantes: this.revisionMissingNames
        }
        const rev = await API.post(`/api/ordenes/${this.revisionFolio}/revision`, revBody)
        if (!rev.ok) {
          this.mostrarToast(rev.error || 'Error al registrar la revisión', true)
          this.revisionGuardando = false
          return
        }

        if (window.sounds) window.sounds.finalize()
        const faltantesMsg = this.revisionMissingNames.length > 0
          ? ` · ${this.revisionMissingNames.length} faltante${this.revisionMissingNames.length !== 1 ? 's' : ''}`
          : ''
        this.mostrarToast(`Revisión completada${faltantesMsg}`)
        this.cerrarRevision()
        await this.cargarOrdenes()
      } catch (e) {
        this.mostrarToast(e.message || 'Error de conexión', true)
      } finally {
        this.revisionGuardando = false
      }
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
            return i === hist.length - 1
              ? { reviewed: true, usuario: e.usuario, fecha: e.fecha, faltantes: e.faltantes || [] }
              : null
          }
        }
        return null
      } catch { return null }
    }
  }
}
