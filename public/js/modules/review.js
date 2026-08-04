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
    // ── Bloqueo de edición concurrente ─────────────────────────
    lockMessage: null,
    _lockRenewInterval: null,

    // ── Estado del modo Revisión ───────────────────────────────
    _revIdCounter: 0,                   // contador para IDs estables por item en sesión de revisión
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
    revisionMissingDetalle: [],         // [{nombre,id_producto,cantidad,unidad,precio_unitario,seccion}] para reintegrar si llega
    revisionPendingIds: [],             // ["seccion::id_producto", ...] — sigue en carrito pero flagueado
    revisionPendingNames: [],
    revisionGuardando: false,
    // Keypad integrado — buffer de captura de peso (null = sin captura, muestra la cantidad del item)
    revisionBuf: null,
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

    // Modal agregar producto a la orden desde revisión
    revisionAgregarModal: {
      visible:       false,
      busqueda:      '',
      resultados:    [],
      buscando:      false,
      modo:          'buscar',   // 'buscar' | 'crear'
      nuevaUnidad:   '',
      nuevoPrecio:   '',
      cantidades:    {},         // { id_producto: cantidad } para productos encontrados
      precios:       {},         // { id_producto: precio } para productos sin precio en el grupo
      guardandoNuevo: false,
      error:         null
    },
    _revisionAgregarSearchId: null,

    // ── Helpers ────────────────────────────────────────────────
    _revisionFilteredKeys () {
      return Object.keys(this.revisionCart).filter(k => !k.startsWith('__'))
    },

    /**
     * Quita UNA sola ocurrencia de un nombre en la lista (no todas).
     * Necesario porque el mismo producto puede estar varias veces en la nota
     * y cada renglón se maneja por separado.
     */
    _removeOneName (arr, nombre) {
      const idx = arr.indexOf(nombre)
      if (idx >= 0) arr.splice(idx, 1)
    },

    // ── Keypad integrado de captura de peso ────────────────────
    // Sin <input>: el teclado de iOS nunca se despliega. El primer dígito
    // reemplaza la cantidad pedida; ✓/swipe aplica el buffer y avanza.

    /** Color distintivo por unidad de medida (kg verde, caja morado, pz azul…) */
    unidadColor (u) {
      const m = {
        kg: '#34d399', g: '#34d399',
        l: '#2dd4bf', lt: '#2dd4bf', lts: '#2dd4bf', litro: '#2dd4bf', litros: '#2dd4bf',
        caja: '#a78bfa', cajas: '#a78bfa',
        pz: '#60a5fa', pza: '#60a5fa', pzas: '#60a5fa', pieza: '#60a5fa', piezas: '#60a5fa',
        manojo: '#fbbf24', manojos: '#fbbf24',
        bolsa: '#f472b6', bolsas: '#f472b6',
        costal: '#fb923c', costales: '#fb923c',
        arpilla: '#fb923c',
      }
      return m[String(u || '').toLowerCase().trim()] || '#94a3b8'
    },

    /** Valor que muestra el display: buffer en captura, o la cantidad del item */
    revisionValorMostrado () {
      const c = this.revisionCurrent()
      if (!c) return ''
      if (this.revisionBuf !== null) return this.revisionBuf === '' ? '0' : this.revisionBuf
      return String(c.item.cantidad)
    },

    revisionDigito (d) {
      if (this.revisionBuf === null) this.revisionBuf = ''   // primer dígito: reemplaza
      if (d === '.') {
        if (this.revisionBuf.includes('.')) return
        this.revisionBuf = this.revisionBuf === '' ? '0.' : this.revisionBuf + '.'
        return
      }
      if (this.revisionBuf.replace('.', '').length >= 6) return
      this.revisionBuf += d
    },

    revisionBorrarDigito () {
      if (this.revisionBuf === null || this.revisionBuf === '') {
        this.revisionBuf = null
        return
      }
      this.revisionBuf = this.revisionBuf.slice(0, -1)
    },

    /** Aplica el buffer del keypad a la cantidad del item actual (si es válido). */
    revisionAplicarBuf () {
      if (this.revisionBuf === null) return
      const n = parseFloat(this.revisionBuf)
      if (!isNaN(n) && n > 0) this.revisionActualizarCantidad(n)
      this.revisionBuf = null
    },

    /** Delta entre lo mostrado y lo pedido originalmente (para el chip ±). */
    revisionDelta () {
      const c = this.revisionCurrent()
      if (!c) return 0
      const orig = parseFloat(this.revisionCantidadOriginal() ?? c.item.cantidad)
      const val  = parseFloat(this.revisionValorMostrado()) || 0
      if (isNaN(orig)) return 0
      return Math.round((val - orig) * 100) / 100
    },

    /** Asigna un _revId estable y único a cada item del carrito al abrir revisión. */
    _assignRevIds () {
      this._revIdCounter = 0
      for (const sec of Object.keys(this.revisionCart)) {
        if (sec.startsWith('__') || !Array.isArray(this.revisionCart[sec])) continue
        for (const item of this.revisionCart[sec]) {
          item._revId = ++this._revIdCounter
        }
      }
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
          out.push({ item, section: sec, flatIdx: out.length })
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

    revisionItemKey (item) {
      return String(item._revId)
    },

    revisionIsReviewed (item) {
      return this.revisionReviewedIds.includes(this.revisionItemKey(item))
    },

    revisionIsCurrentReviewed () {
      const c = this.revisionCurrent()
      return c ? this.revisionIsReviewed(c.item) : false
    },

    revisionIsPending (item) {
      return this.revisionPendingIds.includes(this.revisionItemKey(item))
    },

    revisionIsCurrentPending () {
      const c = this.revisionCurrent()
      return c ? this.revisionIsPending(c.item) : false
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
      const done = items.filter(fi => this.revisionIsReviewed(fi.item)).length
      return { done, total: items.length }
    },

    // ── Abrir / cerrar ─────────────────────────────────────────
    async abrirRevision (orden) {
      // Intentar adquirir bloqueo de edición
      try {
        const lockRes = await API.patch(`/api/ordenes/${orden.folio_numero}/lock`)
        if (lockRes.locked) {
          this.lockMessage = lockRes.message || 'Esta nota está siendo editada por otro usuario'
          return
        }
      } catch (e) {
        console.warn('Error al verificar bloqueo:', e)
      }

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
        this._assignRevIds()
        this._revisionOriginalCart = JSON.parse(JSON.stringify(this.revisionCart))
        this.revisionFolio = o.folio_numero
        this.revisionIdCliente = o.id_cliente || null
        this.revisionIdGrupo = o.id_grupo || null
        this.revisionNombreCliente = o.nombre_cliente
        this.revisionNombreGrupo = o.nombre_grupo
        this.revisionCurrentIdx = 0
        this.revisionReviewedIds = []
        this.revisionMissingNames = []
      this.revisionMissingDetalle = []
      this.revisionBuf = null
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

        this._lockRenewInterval = setInterval(() => {
          API.patch(`/api/ordenes/${orden.folio_numero}/lock`).catch(() => {})
        }, 120000)
      } catch (e) {
        this.mostrarToast(e.message || 'Error al cargar pedido', true)
      }
    },

    cerrarRevision () {
      if (this.revisionFolio) {
        API.delete(`/api/ordenes/${this.revisionFolio}/lock`).catch(() => {})
      }
      if (this._lockRenewInterval) {
        clearInterval(this._lockRenewInterval)
        this._lockRenewInterval = null
      }
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
      this.revisionMissingDetalle = []
      this.revisionBuf = null
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
      const key = this.revisionItemKey(c.item)
      if (!this.revisionReviewedIds.includes(key)) {
        this.revisionReviewedIds.push(key)
        if (window.sounds) window.sounds.reviewed()
      }
    },

    revisionSiguiente () {
      const now = Date.now()
      if (now - this._revisionLastNext < 350) return
      this._revisionLastNext = now
      this.revisionAplicarBuf()
      this.revisionMarcarRevisado()
      const total = this.revisionTotal()
      if (this.revisionCurrentIdx < total - 1) {
        this.revisionCurrentIdx++
      }
    },

    revisionAnterior () {
      this.revisionBuf = null   // navegar hacia atrás descarta la captura en curso
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
      this.revisionMissingDetalle = []
      this.revisionBuf = null
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
        this.revisionBuf = null
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
      const items = this.revisionCart[c.section]
      if (!items) return
      const idx = items.findIndex(i => i._revId === c.item._revId)
      if (idx >= 0) {
        items[idx].cantidad = num
      }
    },

    // ── Marcar faltante ────────────────────────────────────────
    revisionMarcarFaltante () {
      const c = this.revisionCurrent()
      if (!c) return
      this.revisionBuf = null   // faltante descarta la captura en curso
      const snapshot = JSON.parse(JSON.stringify(c.item))
      const section  = c.section
      const key      = this.revisionItemKey(c.item)

      // Eliminar del carrito
      const items = this.revisionCart[section]
      if (!items) return
      const originalIdx = items.findIndex(i => i._revId === c.item._revId)
      if (originalIdx < 0) return
      items.splice(originalIdx, 1)

      // Limpiar de pendientes por si estaba flagueado antes de marcarse faltante
      if (this.revisionPendingIds.includes(key)) {
        this.revisionPendingIds = this.revisionPendingIds.filter(k => k !== key)
        this._removeOneName(this.revisionPendingNames, snapshot.nombre_producto)
      }
      // Limpiar de revisados también
      this.revisionReviewedIds = this.revisionReviewedIds.filter(k => k !== key)

      this.revisionMissingNames.push(snapshot.nombre_producto)
      this.revisionMissingDetalle.push({
        nombre:          snapshot.nombre_producto,
        id_producto:     snapshot.id_producto ?? null,
        cantidad:        parseFloat(snapshot.cantidad) || 0,
        unidad:          snapshot.unidad || '',
        precio_unitario: parseFloat(snapshot.precio_unitario) || 0,
        seccion:         section
      })
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
      this._removeOneName(this.revisionMissingNames, item.nombre_producto)
      // Quitar el detalle de ESTA instancia (con duplicados, matchear también
      // cantidad y sección; si no, la primera ocurrencia del nombre)
      let dIdx = this.revisionMissingDetalle.findIndex(d =>
        d.nombre === item.nombre_producto &&
        d.cantidad === (parseFloat(item.cantidad) || 0) &&
        d.seccion === section
      )
      if (dIdx < 0) dIdx = this.revisionMissingDetalle.findIndex(d => d.nombre === item.nombre_producto)
      if (dIdx >= 0) this.revisionMissingDetalle.splice(dIdx, 1)
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
      this.revisionAplicarBuf()   // conservar el peso capturado antes de flaguear
      const key = this.revisionItemKey(c.item)

      if (this.revisionPendingIds.includes(key)) {
        // Toggle: si ya estaba pendiente, quitarlo sin avanzar
        this.revisionPendingIds = this.revisionPendingIds.filter(k => k !== key)
        this._removeOneName(this.revisionPendingNames, c.item.nombre_producto)
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
      const key = this.revisionItemKey(c.item)

      this.revisionPendingIds = this.revisionPendingIds.filter(k => k !== key)
      this._removeOneName(this.revisionPendingNames, c.item.nombre_producto)

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
        // Quitar _revId (campo interno de sesión, no pertenece al carrito persistido)
        for (const [sec, items] of Object.entries(cartParaGuardar)) {
          if (sec.startsWith('__') || !Array.isArray(items)) continue
          for (const item of items) delete item._revId
        }

        const saved = await tryFetch(() => API.post('/api/ordenes', {
          folio_numero:  this.revisionFolio,
          id_cliente:    this.revisionIdCliente,
          datos_carrito: cartParaGuardar
        }))
        if (!saved.ok) throw new Error(saved.error || 'Error al guardar cambios')

        // Paso 2 — registrar revisión en historial
        this.revisionGuardandoMensaje = 'Registrando revisión…'
        const rev = await tryFetch(() => API.post(`/api/ordenes/${this.revisionFolio}/revision`, {
          totalProductos:   this.revisionTotal() + this.revisionMissingNames.length,
          faltantes:        this.revisionMissingNames,
          pendientes:       this.revisionPendingNames,
          faltantesDetalle: this.revisionMissingDetalle
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

    // Indica si la cantidad del producto actual fue modificada respecto al original.
    // Se compara por _revId (no id_producto) para distinguir renglones duplicados
    // del mismo producto; el snapshot original se toma DESPUÉS de asignar _revIds.
    revisionCantidadModificada () {
      const c = this.revisionCurrent()
      if (!c || !this._revisionOriginalCart) return false
      const origSection = this._revisionOriginalCart[c.section]
      if (!origSection) return false
      const origItem = origSection.find(i => i._revId === c.item._revId)
      if (!origItem) return false
      return parseFloat(origItem.cantidad) !== parseFloat(c.item.cantidad)
    },

    revisionCantidadOriginal () {
      const c = this.revisionCurrent()
      if (!c || !this._revisionOriginalCart) return null
      const origSection = this._revisionOriginalCart[c.section]
      if (!origSection) return null
      const origItem = origSection.find(i => i._revId === c.item._revId)
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
      // Por _revId: con duplicados, findIndex por id_producto cambiaría el primero
      const idx = items.findIndex(i => i._revId === c.item._revId)
      if (idx < 0) return

      const oldNombre  = c.item.nombre_producto
      const key        = this.revisionItemKey(c.item)   // _revId no cambia al sustituir

      // Sustituir el item en el carrito conservando _revId
      items[idx] = {
        ...items[idx],
        id_producto:     prod.id_producto,
        nombre_producto: prod.nombre_producto,
        unidad:          prod.unidad_producto,
        precio_unitario: parseFloat(prod.precio_base) || items[idx].precio_unitario || 0,
        cantidad:        items[idx].cantidad   // conservar cantidad pedida
      }

      // Limpiar estado anterior y marcar como revisado
      this.revisionReviewedIds = this.revisionReviewedIds.filter(k => k !== key)
      if (this.revisionPendingIds.includes(key)) {
        this.revisionPendingIds = this.revisionPendingIds.filter(k => k !== key)
        this._removeOneName(this.revisionPendingNames, oldNombre)
      }

      if (!this.revisionReviewedIds.includes(key)) {
        this.revisionReviewedIds.push(key)
        if (window.sounds) window.sounds.reviewed?.()
      }

      this.revisionCambiarModal = { visible: false, busqueda: '', resultados: [], buscando: false, error: null }
      this.mostrarToast(`Cambiado a ${prod.nombre_producto}`)
    },

    // ── Agregar producto al carrito desde revisión ─────────────
    revisionAbrirAgregar () {
      this.revisionAgregarModal = {
        visible: true, busqueda: '', resultados: [], buscando: false,
        modo: 'buscar', nuevaUnidad: '', nuevoPrecio: '',
        cantidades: {}, precios: {}, guardandoNuevo: false, error: null
      }
      this.$nextTick(() => document.getElementById('rev-agregar-input')?.focus())
    },

    revisionCerrarAgregar () {
      this.revisionAgregarModal.visible = false
    },

    async revisionBuscarParaAgregar () {
      const busq = this.revisionAgregarModal.busqueda.trim()
      if (busq.length < 2) { this.revisionAgregarModal.resultados = []; return }
      const searchId = Date.now()
      this._revisionAgregarSearchId = searchId
      this.revisionAgregarModal.buscando = true
      this.revisionAgregarModal.error = null
      try {
        const gid = this.revisionIdGrupo ? `&groupId=${this.revisionIdGrupo}` : ''
        const r = await API.get(`/api/productos/buscar?q=${encodeURIComponent(busq)}${gid}`)
        if (this._revisionAgregarSearchId !== searchId) return
        this.revisionAgregarModal.resultados = r.ok ? (r.data || []) : []
        if (!r.ok) this.revisionAgregarModal.error = r.error || 'Error al buscar'
      } catch {
        if (this._revisionAgregarSearchId !== searchId) return
        this.revisionAgregarModal.resultados = []
        this.revisionAgregarModal.error = !navigator.onLine ? 'Sin conexión' : 'Error al buscar'
      } finally {
        if (this._revisionAgregarSearchId === searchId) this.revisionAgregarModal.buscando = false
      }
    },

    revisionAgregarProductoAlCarrito (prod, cantidad, precioOverride) {
      const cant           = parseFloat(cantidad) || 1
      const precioExistente = parseFloat(prod.precio_final ?? prod.precio_base) || 0
      const precioManual   = parseFloat(precioOverride) || 0
      const precio         = precioExistente > 0 ? precioExistente : precioManual

      if (precio <= 0) {
        this.revisionAgregarModal.error = 'Ingresa el precio para este producto antes de agregarlo'
        return
      }

      // Buscar la sección donde insertar (General primero, si no la primera)
      const keys = this._revisionFilteredKeys()
      const section = keys.includes('General') ? 'General' : (keys[0] || 'General')
      if (!this.revisionCart[section]) this.revisionCart[section] = []

      // Siempre agrega un renglón nuevo — se permite el mismo producto varias
      // veces en la misma sección (requerimiento de logística).
      const nuevo = {
        id_producto:     prod.id_producto,
        nombre_producto: prod.nombre_producto,
        unidad:          prod.unidad_producto,
        precio_unitario: precio,
        cantidad:        cant,
        _revId:          ++this._revIdCounter
      }
      this.revisionCart[section].push(nuevo)
      this.mostrarToast(`${prod.nombre_producto} agregado`)

      // Marcar como revisado automáticamente (esta instancia exacta)
      const key = this.revisionItemKey(nuevo)
      if (!this.revisionReviewedIds.includes(key)) this.revisionReviewedIds.push(key)

      // Persistir el precio en la DB cuando el usuario lo ingresó manualmente.
      // Se guarda como precio_base = precioManual / (1 - descuento/100) para que
      // Electron calcule el mismo precio_final al leer la cotización del grupo.
      if (precioManual > 0 && precioExistente <= 0 && this.revisionIdGrupo) {
        const descuento  = parseFloat(prod.descuento ?? 0)
        const precioBase = descuento > 0
          ? Math.round(precioManual / (1 - descuento / 100) * 100) / 100
          : precioManual
        API.post('/api/productos/precio-rapido', {
          id_producto: prod.id_producto,
          id_grupo:    this.revisionIdGrupo,
          precio_base: precioBase
        }).catch(e => console.warn('No se pudo guardar el precio:', e.message))
      }

      this.revisionCerrarAgregar()
    },

    revisionIrAModoCrear () {
      this.revisionAgregarModal.modo = 'crear'
      this.revisionAgregarModal.error = null
      this.$nextTick(() => document.getElementById('rev-nuevo-unidad')?.focus())
    },

    async revisionCrearYAgregar () {
      const nombre = this.revisionAgregarModal.busqueda.trim()
      const unidad = this.revisionAgregarModal.nuevaUnidad.trim()
      if (!nombre) { this.revisionAgregarModal.error = 'Escribe el nombre del producto'; return }
      if (!unidad) { this.revisionAgregarModal.error = 'La unidad es requerida (ej: kg, pz, caja)'; return }

      this.revisionAgregarModal.guardandoNuevo = true
      this.revisionAgregarModal.error = null
      try {
        const precio = parseFloat(this.revisionAgregarModal.nuevoPrecio) || 0
        const r = await API.post('/api/productos', {
          nombre_producto: nombre,
          unidad_producto: unidad,
          precio: precio > 0 ? precio : undefined,
          id_grupo: this.revisionIdGrupo || undefined
        })
        if (!r.ok) { this.revisionAgregarModal.error = r.error || 'Error al crear producto'; return }
        // Agregar al carrito con el producto recién creado
        this.revisionAgregarProductoAlCarrito({
          id_producto:     r.data.id_producto,
          nombre_producto: r.data.nombre_producto,
          unidad_producto: unidad,
          precio_base:     precio
        }, 1)
      } catch (e) {
        this.revisionAgregarModal.error = e.message || 'Error al crear'
      } finally {
        this.revisionAgregarModal.guardandoNuevo = false
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
