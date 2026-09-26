/**
 * tickets.js — Subir tickets de compra (solo CEO)
 *
 * El CEO toma foto del ticket (o elige una de la galería, o un PDF) y la
 * manda a la bandeja; el capturista la registra después en Electron con la
 * vista previa al lado. Aquí no se pide ningún dato: si subir cuesta más de
 * unos segundos no se va a hacer. Ver docs/PLAN-TICKETS-COMPRA.md.
 *
 * Las fotos se comprimen en el celular antes de subir (4–8 MB → ~0.5 MB):
 * importa con datos móviles, y re-codificar a JPEG corrige de paso la
 * rotación EXIF y convierte el HEIC del iPhone.
 */

const TICKET_LADO_MAX = 1600
const TICKET_CALIDAD  = 0.82
const TICKET_TIMEOUT  = 60000   // un PDF de 15 MB con mala señal tarda

function ticketsModule() {
  return {
    ticketsAbierto:     false,
    ticketsArchivos:    [],     // { id, nombre, tipo, blob, preview, estado: 'listo'|'subiendo'|'ok'|'error', error }
    ticketNota:         '',
    ticketIdServidor:   null,   // borrador ya creado en el servidor
    ticketEnviando:     false,
    ticketPreparando:   false,
    ticketError:        '',
    ticketDuplicado:    null,   // { idx, info } — pausa la subida hasta que el CEO decida
    ticketsMios:        [],
    ticketsSinCapturar: 0,
    _ticketSeq:         0,

    esCeo() {
      return this.session?.rol === 'ceo'
    },

    abrirSubirTicket() {
      this.ticketsAbierto = true
      // Abrir el selector de una vez: el gesto más común es "foto y listo"
      this.$nextTick(() => this.$refs.ticketInput?.click())
    },

    cerrarSubirTicket() {
      if (this.ticketEnviando) return
      for (const a of this.ticketsArchivos) if (a.preview) URL.revokeObjectURL(a.preview)
      this.ticketsAbierto   = false
      this.ticketsArchivos  = []
      this.ticketNota       = ''
      this.ticketIdServidor = null
      this.ticketError      = ''
      this.ticketDuplicado  = null
    },

    async ticketElegirArchivos(ev) {
      const files = [...(ev.target.files || [])]
      ev.target.value = ''   // permite volver a elegir el mismo archivo
      if (!files.length) return
      this.ticketError = ''
      this.ticketPreparando = true
      try {
        for (const f of files) {
          if (this.ticketsArchivos.length >= 10) { this.ticketError = 'Máximo 10 archivos por ticket'; break }
          try {
            const { blob, tipo } = await this._ticketPreparar(f)
            this.ticketsArchivos.push({
              id: ++this._ticketSeq,
              nombre: f.name || 'foto.jpg',
              tipo, blob,
              preview: tipo === 'application/pdf' ? null : URL.createObjectURL(blob),
              estado: 'listo', error: '',
            })
          } catch (err) {
            this.ticketError = err.message
          }
        }
      } finally {
        this.ticketPreparando = false
      }
    },

    ticketQuitar(idx) {
      const a = this.ticketsArchivos[idx]
      if (!a || a.estado === 'ok' || this.ticketEnviando) return
      if (a.preview) URL.revokeObjectURL(a.preview)
      this.ticketsArchivos.splice(idx, 1)
    },

    ticketTamano(bytes) {
      return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
    },

    // PDF tal cual (el servidor limita a 15 MB). Imagen → JPEG ≤ 1600 px.
    async _ticketPreparar(file) {
      const esPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')
      if (esPdf) {
        if (file.size > 15 * 1024 * 1024) throw new Error(`${file.name}: el PDF pasa de 15 MB`)
        return { blob: file, tipo: 'application/pdf' }
      }
      // Un <img> aplica la orientación EXIF al dibujar (Safari 13.1+, Chrome 81+)
      // y Safari decodifica HEIC; por eso se decodifica así y no a mano.
      const url = URL.createObjectURL(file)
      try {
        const img = await new Promise((resolve, reject) => {
          const i = new Image()
          i.onload  = () => resolve(i)
          i.onerror = () => reject(new Error(`${file.name || 'Archivo'}: formato no admitido. Sube una foto o un PDF.`))
          i.src = url
        })
        const escala = Math.min(1, TICKET_LADO_MAX / Math.max(img.naturalWidth, img.naturalHeight))
        const canvas = document.createElement('canvas')
        canvas.width  = Math.round(img.naturalWidth * escala)
        canvas.height = Math.round(img.naturalHeight * escala)
        const ctx = canvas.getContext('2d')
        // Fondo claro por si viene un PNG con transparencia
        ctx.fillStyle = '#f5f5f0'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', TICKET_CALIDAD))
        if (!blob) throw new Error(`${file.name || 'Archivo'}: no se pudo procesar la imagen`)
        return { blob, tipo: 'image/jpeg' }
      } finally {
        URL.revokeObjectURL(url)
      }
    },

    // Cuerpo binario: API.post solo manda JSON
    async _ticketSubirArchivo(idTicket, archivo, forzar = false) {
      const ctrl  = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), TICKET_TIMEOUT)
      try {
        const res = await fetch(`/api/tickets/${idTicket}/archivos${forzar ? '?forzar=1' : ''}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'Authorization': `Bearer ${API._token()}` },
          body: archivo.blob,
          signal: ctrl.signal,
        })
        const data = await API._handle(res)
        return { status: res.status, data }
      } catch {
        return { status: 0, data: { ok: false, error: 'Sin conexión. Revisa tu señal y vuelve a intentar.' } }
      } finally {
        clearTimeout(timer)
      }
    },

    async enviarTicket() {
      if (this.ticketEnviando || !this.ticketsArchivos.length) return
      this.ticketEnviando = true
      this.ticketError    = ''
      try {
        if (!this.ticketIdServidor) {
          const r = await API.post('/api/tickets', { nota: this.ticketNota })
          if (!r.ok) { this.ticketError = r.error || 'No se pudo crear el ticket'; return }
          this.ticketIdServidor = r.data.id
        }

        for (let i = 0; i < this.ticketsArchivos.length; i++) {
          const a = this.ticketsArchivos[i]
          if (a.estado === 'ok') continue
          a.estado = 'subiendo'
          a.error  = ''
          const { status, data } = await this._ticketSubirArchivo(this.ticketIdServidor, a)
          if (data.ok) { a.estado = 'ok'; continue }
          a.estado = 'error'
          a.error  = data.error || 'Error al subir'
          if (status === 409 && data.duplicado) {
            // Se pausa aquí: el CEO decide si es el mismo ticket o no
            this.ticketDuplicado = { idx: i, info: data.duplicado }
            return
          }
          this.ticketError = a.error
          return
        }

        const r = await API.post(`/api/tickets/${this.ticketIdServidor}/enviar`, {})
        if (!r.ok) { this.ticketError = r.error || 'No se pudo enviar el ticket'; return }

        const n = this.ticketsArchivos.length
        this.ticketEnviando = false
        this.cerrarSubirTicket()
        this.mostrarToast(n > 1 ? `Ticket enviado (${n} archivos)` : 'Ticket enviado', 'success')
        this.cargarTicketsMios()
      } catch (err) {
        this.ticketError = err.message || 'Error al enviar'
      } finally {
        this.ticketEnviando = false
      }
    },

    // Duplicado: "sí es otro ticket" → se sube forzado y se sigue con el resto
    async ticketDuplicadoSubirIgual() {
      const d = this.ticketDuplicado
      if (!d) return
      this.ticketDuplicado = null
      const a = this.ticketsArchivos[d.idx]
      this.ticketEnviando = true
      a.estado = 'subiendo'
      const { data } = await this._ticketSubirArchivo(this.ticketIdServidor, a, true)
      this.ticketEnviando = false
      if (!data.ok) { a.estado = 'error'; a.error = data.error || 'Error al subir'; this.ticketError = a.error; return }
      a.estado = 'ok'
      this.enviarTicket()
    },

    ticketDuplicadoQuitar() {
      const d = this.ticketDuplicado
      if (!d) return
      this.ticketDuplicado = null
      this.ticketQuitar(d.idx)
      if (this.ticketsArchivos.length) return this.enviarTicket()
      this.ticketError = 'Ya no quedan archivos en este ticket'
    },

    ticketFechaCorta(f) {
      if (!f) return ''
      const d = new Date(String(f).replace(' ', 'T'))
      return isNaN(d) ? '' : d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })
    },

    ticketEstadoTexto(e) {
      return { pendiente: 'Sin capturar', en_captura: 'Capturando', capturado: 'Capturado', descartado: 'Descartado' }[e] || e
    },

    async cargarTicketsMios() {
      if (!this.esCeo()) return
      try {
        const r = await API.get('/api/tickets/mios')
        if (r.ok) {
          this.ticketsMios        = r.data.tickets || []
          this.ticketsSinCapturar = r.data.sinCapturar || 0
        }
      } catch { /* sin red: el contador se queda como estaba */ }
    },
  }
}
