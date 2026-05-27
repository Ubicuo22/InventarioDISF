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
    revisionCurrentIdx: 0,
    revisionReviewedIds: [],            // ["seccion::id_producto", ...]
    revisionMissingNames: [],
    revisionPendingIds: [],             // ["seccion::id_producto", ...] — sigue en carrito pero flagueado
    revisionPendingNames: [],
    revisionGuardando: false,
    revisionShowSidebar: false,         // collapsable en móvil
    // Undo toast
    revisionUndo: null,                 // { item, section } | null
    _revisionUndoTimer: null,
    // Swipe state
    revisionTouchX0: null,
    revisionTouchTx: 0,
    revisionSwipeLock: false,
    // Throttle para Siguiente (previene avanzar varios de golpe con clic rápido o flecha mantenida)
    _revisionLastNext: 0,
    // Estado de foco del input de cantidad (para guardar atajos de teclado)
    revisionInputFocused: false,
    // Snapshot del carrito original (para Reset)
    _revisionOriginalCart: null,
    // Ref al handler de teclado registrado
    _revisionKeyHandler: null,
    // Modal buscar/cambiar producto desde revisión
    revisionCambiarModal: { visible: false, busqueda: '', resultados: [], buscando: false },

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
        // Registrar atajos de teclado — mismos que ReviewModal.tsx del electron
        this._revisionKeyHandler = (e) => {
          if (!this.revisionModalOpen) return
          // Si el input de cantidad está enfocado: solo Enter avanza
          if (this.revisionInputFocused) {
            if (e.key === 'Enter') { e.preventDefault(); this.revisionGuardarYSiguiente() }
            return
          }
          if (e.key === 'ArrowRight') { e.preventDefault(); this.revisionSiguiente(); return }
          if (e.key === 'ArrowLeft')  { e.preventDefault(); this.revisionAnterior();  return }
          if (e.key === 'f' || e.key === 'F') { e.preventDefault(); this.revisionMarcarFaltante();  return }
          if (e.key === 'p' || e.key === 'P') { e.preventDefault(); this.revisionMarcarPendiente(); return }
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
      this.revisionIdGrupo = null
      this.revisionReviewedIds = []
      this.revisionMissingNames = []
      this.revisionPendingIds = []
      this.revisionPendingNames = []
      this.revisionCurrentIdx = 0
      this.revisionUndo = null
      this.revisionCambiarModal = { visible: false, busqueda: '', resultados: [], buscando: false }
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
      this.revisionReviewedIds = []
      this.revisionMissingNames = []
      this.revisionPendingIds = []
      this.revisionPendingNames = []
      this.revisionCurrentIdx = 0
      this.revisionUndo = null
      this._revisionLastNext = 0
      if (this._revisionUndoTimer) {
        clearTimeout(this._revisionUndoTimer)
        this._revisionUndoTimer = null
      }
    },

    // ── Enter en input de cantidad → guardar y avanzar ─────────────
    revisionGuardarYSiguiente () {
      // La cantidad ya se actualizó via @input reactivo; solo avanzamos
      this.$el?.querySelector('input[inputmode="decimal"]')?.blur()
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

    // ── Marcar pendiente (sigue en carrito, pero queda pendiente) ─
    revisionMarcarPendiente () {
      const c = this.revisionCurrent()
      if (!c) return
      const key = this.revisionItemKey(c.section, c.item.id_producto)

      if (this.revisionPendingIds.includes(key)) {
        // Toggle: si ya estaba pendiente, quitarlo
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
        this.revisionMarcarFaltante()     // ← Marcar como faltante
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
        const cartParaGuardar = JSON.parse(JSON.stringify(this.revisionCart))
        delete cartParaGuardar.__historial__
        delete cartParaGuardar.__orden__
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
          faltantes: this.revisionMissingNames,
          pendientes: this.revisionPendingNames
        }
        const rev = await API.post(`/api/ordenes/${this.revisionFolio}/revision`, revBody)
        if (!rev.ok) {
          this.mostrarToast(rev.error || 'Error al registrar la revisión', true)
          this.revisionGuardando = false
          return
        }

        if (window.sounds) window.sounds.finalize()
        const hasPendientes = this.revisionPendingNames.length > 0
        const hasFaltantes  = this.revisionMissingNames.length > 0
        const partes = []
        if (hasFaltantes) partes.push(`${this.revisionMissingNames.length} faltante${this.revisionMissingNames.length !== 1 ? 's' : ''}`)
        if (hasPendientes) partes.push(`${this.revisionPendingNames.length} pendiente${this.revisionPendingNames.length !== 1 ? 's' : ''}`)
        const sufijo = partes.length ? ` · ${partes.join(' · ')}` : ''
        this.mostrarToast(`Revisión completada${sufijo}`)
        this.cerrarRevision()
        await this.cargarOrdenes()
      } catch (e) {
        this.mostrarToast(e.message || 'Error de conexión', true)
      } finally {
        this.revisionGuardando = false
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
      this.revisionCambiarModal = { visible: true, busqueda: '', resultados: [], buscando: false }
      this.$nextTick(() => document.getElementById('rev-buscar-input')?.focus())
    },

    async revisionBuscarProducto () {
      const q = this.revisionCambiarModal.busqueda.trim()
      if (q.length < 2) { this.revisionCambiarModal.resultados = []; return }
      this.revisionCambiarModal.buscando = true
      try {
        const gid = this.revisionIdGrupo ? `&groupId=${this.revisionIdGrupo}` : ''
        const r = await API.get(`/api/productos/buscar?q=${encodeURIComponent(q)}${gid}`)
        this.revisionCambiarModal.resultados = r.data || []
      } catch { this.revisionCambiarModal.resultados = [] }
      finally { this.revisionCambiarModal.buscando = false }
    },

    revisionConfirmarCambio (prod) {
      const c = this.revisionCurrent()
      if (!c || !prod) return
      const items = this.revisionCart[c.section]
      if (!items) return
      const idx = items.findIndex(i => i.id_producto === c.item.id_producto)
      if (idx >= 0) {
        const cantidadActual = items[idx].cantidad
        items[idx] = {
          ...items[idx],
          id_producto:     prod.id_producto,
          nombre_producto: prod.nombre_producto,
          unidad:          prod.unidad_producto,
          precio_unitario: parseFloat(prod.precio_base) || items[idx].precio_unitario || 0,
          cantidad:        cantidadActual   // conservar cantidad pedida
        }
      }
      this.revisionCambiarModal = { visible: false, busqueda: '', resultados: [], buscando: false }
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
