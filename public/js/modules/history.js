function historyModule() {
  return {
    // ── Modal de detalle de pedido (solo lectura) ─────────────
    modalDetalleOrden: false,
    ordenDetalle: null,
    cargandoDetalle: false,

    // ── Nota en PDF (mismo formato que la impresión de Electron) ──────
    compartiendoNota: false,
    notaPdfLista:     null,   // { folio, file } si el navegador pidió un 2º toque

    /**
     * Genera el PDF de la nota en el servidor y abre el menú de compartir del
     * sistema (WhatsApp con el archivo adjunto). Si el navegador no comparte
     * archivos, se descarga.
     *
     * Safari (iPhone) solo permite compartir justo después de un toque; si
     * generar el PDF tardó más, share() lanza NotAllowedError — el archivo se
     * queda listo en notaPdfLista y el botón pasa a "Compartir ahora".
     */
    async compartirNotaPDF(folio) {
      if (this.compartiendoNota) return
      const lista = this.notaPdfLista
      if (lista && lista.folio === folio) return this._compartirArchivoNota(lista.file)

      this.compartiendoNota = true
      this.notaPdfLista = null
      try {
        const res = await fetch(`/api/ordenes/${folio}/pdf`, {
          headers: { Authorization: `Bearer ${API._token()}` }
        })
        if (!res.ok) {
          if (res.status === 401) window.dispatchEvent(new CustomEvent('session-expired'))
          const j = await res.json().catch(() => ({}))
          throw new Error(j.error || `No se pudo generar el PDF (${res.status})`)
        }
        const blob   = await res.blob()
        const nombre = res.headers.get('X-Nombre-Archivo') || `nota_${String(folio).padStart(6, '0')}.pdf`
        const file   = new File([blob], nombre, { type: 'application/pdf' })
        await this._compartirArchivoNota(file, folio)
      } catch (e) {
        this.mostrarToast(e.message || 'No se pudo generar el PDF', true)
      } finally {
        this.compartiendoNota = false
      }
    },

    async _compartirArchivoNota(file, folio) {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: file.name })
          this.notaPdfLista = null
        } catch (e) {
          if (e.name === 'AbortError') { this.notaPdfLista = null; return }   // el usuario cerró el menú
          if (e.name === 'NotAllowedError' && folio != null) {
            this.notaPdfLista = { folio, file }
            this.mostrarToast('PDF listo — toca "Compartir ahora"')
            return
          }
          throw e
        }
        return
      }
      // Sin Web Share de archivos (p. ej. Firefox de escritorio): descargar
      const url = URL.createObjectURL(file)
      const a = document.createElement('a')
      a.href = url
      a.download = file.name
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
      this.notaPdfLista = null
      this.mostrarToast('PDF descargado')
    },

    // ── Abrir modal de detalle ────────────────────────────────
    async abrirDetalleOrden(orden) {
      this.notaPdfLista = null
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
      // Parsear YYYY-MM-DD al mediodía UTC para evitar el cambio de día
      // al mostrar en timezone local (UTC-6 Mexico = 6h detrás de UTC midnight)
      const s = typeof f === 'string' ? f : new Date(f).toISOString()
      const ymd = s.slice(0, 10)
      const d = new Date(ymd + 'T12:00:00Z')
      return d.toLocaleDateString('es-MX', {
        day: '2-digit', month: 'short', year: 'numeric',
        timeZone: 'America/Mexico_City'
      })
    }
  }
}
