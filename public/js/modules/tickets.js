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
// Resolución de trabajo para recortar: la foto de un celular (12 MP) se
// reduce primero a esto, así el recorte sale con buena resolución sin
// rebasar el límite de canvas de iOS (~16 MP).
const TICKET_LADO_TRABAJO = 2400
// Recorte inicial: un margen chico, para que las esquinas se vean y se
// entienda que se pueden mover
const RECORTE_INICIAL = () => ({ x: 0.04, y: 0.04, w: 0.92, h: 0.92 })
const RECORTE_MIN = 0.08   // el recuadro no puede quedar más chico que esto
const TICKET_CALIDAD  = 0.82
const TICKET_TIMEOUT  = 60000   // un PDF de 15 MB con mala señal tarda

function ticketsModule() {
  return {
    ticketsAbierto:     false,
    ticketsArchivos:    [],     // { id, nombre, tipo, blob, preview, original, rot, recorte, estado: 'listo'|'subiendo'|'ok'|'error', error }
    ticketNota:         '',
    ticketIdServidor:   null,   // borrador ya creado en el servidor
    ticketEnviando:     false,
    ticketPreparando:   false,
    ticketError:        '',
    ticketDuplicado:    null,   // { idx, info } — pausa la subida hasta que el CEO decida
    ticketsMios:        [],
    ticketsSinCapturar: 0,
    _ticketSeq:         0,

    // Recortador: quitar el fondo (la mesa, la mano) antes de subir. El
    // recorte se aplica sobre la foto ORIGINAL, no sobre la ya comprimida,
    // para que el ticket conserve toda la resolución posible.
    recorteAbierto:     false,
    recorteId:          null,      // id del archivo que se está recortando
    recortePreview:     '',
    recorteRot:         0,
    recorte:            RECORTE_INICIAL(),
    recorteCola:        [],        // fotos recién elegidas que faltan por recortar
    recorteProcesando:  false,
    _recorteDrag:       null,

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
      if (this.recortePreview) URL.revokeObjectURL(this.recortePreview)
      this.recortePreview   = ''
      this.recorteAbierto   = false
      this.recorteCola      = []
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
            const id = ++this._ticketSeq
            const esFoto = tipo !== 'application/pdf'
            this.ticketsArchivos.push({
              id,
              nombre: f.name || 'foto.jpg',
              tipo, blob,
              preview: esFoto ? URL.createObjectURL(blob) : null,
              original: esFoto ? f : null, rot: 0, recorte: null,
              estado: 'listo', error: '',
            })
            if (esFoto) this.recorteCola.push(id)
          } catch (err) {
            this.ticketError = err.message
          }
        }
      } finally {
        this.ticketPreparando = false
      }
      // Cada foto nueva pasa por el recortador, una tras otra
      if (!this.recorteAbierto) this._recorteSiguiente()
    },

    ticketQuitar(idx) {
      const a = this.ticketsArchivos[idx]
      if (!a || a.estado === 'ok' || this.ticketEnviando) return
      if (a.preview) URL.revokeObjectURL(a.preview)
      this.ticketsArchivos.splice(idx, 1)
      this.recorteCola = this.recorteCola.filter(id => id !== a.id)
    },

    // ── Recortador ───────────────────────────────────────────────
    _recorteSiguiente() {
      const id = this.recorteCola.shift()
      if (id != null) this.abrirRecorte(id)
    },

    async abrirRecorte(id) {
      const a = this.ticketsArchivos.find(x => x.id === id)
      if (!a?.original || a.estado === 'ok' || this.ticketEnviando) return
      this.recorteId      = id
      this.recorteRot     = a.rot || 0
      this.recorte        = a.recorte ? { ...a.recorte } : RECORTE_INICIAL()
      this.recorteAbierto = true
      await this._recorteVistaPrevia()
    },

    async _recorteVistaPrevia() {
      const a = this.ticketsArchivos.find(x => x.id === this.recorteId)
      if (!a) return
      if (this.recortePreview) URL.revokeObjectURL(this.recortePreview)
      this.recortePreview = ''
      const canvas = await this._ticketCanvasGirado(a.original, this.recorteRot, 1200)
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85))
      this.recortePreview = blob ? URL.createObjectURL(blob) : ''
    },

    // Al girar cambian los ejes: el recuadro vuelve al inicial
    async recorteGirar() {
      this.recorteRot = (this.recorteRot + 90) % 360
      this.recorte = RECORTE_INICIAL()
      await this._recorteVistaPrevia()
    },

    recorteTodo() {
      this.recorte = { x: 0, y: 0, w: 1, h: 1 }
    },

    _recorteCerrar() {
      if (this.recortePreview) URL.revokeObjectURL(this.recortePreview)
      this.recortePreview = ''
      this.recorteAbierto = false
      this.recorteId = null
      this._recorteSiguiente()
    },

    // "Sin recortar": la foto se queda como estaba
    recorteOmitir() {
      this._recorteCerrar()
    },

    async recorteAplicar() {
      const a = this.ticketsArchivos.find(x => x.id === this.recorteId)
      if (!a || this.recorteProcesando) return
      this.recorteProcesando = true
      try {
        const { blob } = await this._ticketPreparar(a.original, { rot: this.recorteRot, recorte: this.recorte })
        if (a.preview) URL.revokeObjectURL(a.preview)
        a.blob = blob
        a.preview = URL.createObjectURL(blob)
        a.rot = this.recorteRot
        a.recorte = { ...this.recorte }
        a.estado = 'listo'
        a.error = ''
      } catch (err) {
        this.ticketError = err.message
      } finally {
        this.recorteProcesando = false
      }
      this._recorteCerrar()
    },

    // Arrastre de esquinas o del recuadro completo. Pointer events: el mismo
    // código sirve para dedo y mouse. Coordenadas normalizadas (0–1) sobre
    // la imagen mostrada, así no dependen del tamaño de la pantalla.
    recorteInicio(ev, modo) {
      const marco = this.$refs.recorteMarco?.getBoundingClientRect()
      if (!marco) return
      ev.preventDefault()
      this._recorteDrag = { modo, marco, x0: ev.clientX, y0: ev.clientY, r0: { ...this.recorte } }
      const mover = (e) => this._recorteMover(e)
      const soltar = () => {
        this._recorteDrag = null
        window.removeEventListener('pointermove', mover)
        window.removeEventListener('pointerup', soltar)
        window.removeEventListener('pointercancel', soltar)
      }
      window.addEventListener('pointermove', mover)
      window.addEventListener('pointerup', soltar)
      window.addEventListener('pointercancel', soltar)
    },

    _recorteMover(e) {
      const d = this._recorteDrag
      if (!d) return
      const dx = (e.clientX - d.x0) / d.marco.width
      const dy = (e.clientY - d.y0) / d.marco.height
      const r = { ...d.r0 }
      const lim = (v, a, b) => Math.min(b, Math.max(a, v))
      if (d.modo === 'mover') {
        r.x = lim(d.r0.x + dx, 0, 1 - d.r0.w)
        r.y = lim(d.r0.y + dy, 0, 1 - d.r0.h)
      } else {
        // Esquina: se mueven los dos lados que la forman, respetando el
        // tamaño mínimo y los bordes de la imagen
        let izq = d.r0.x, der = d.r0.x + d.r0.w, arr = d.r0.y, aba = d.r0.y + d.r0.h
        if (d.modo.includes('w')) izq = lim(izq + dx, 0, der - RECORTE_MIN)
        if (d.modo.includes('e')) der = lim(der + dx, izq + RECORTE_MIN, 1)
        if (d.modo.includes('n')) arr = lim(arr + dy, 0, aba - RECORTE_MIN)
        if (d.modo.includes('s')) aba = lim(aba + dy, arr + RECORTE_MIN, 1)
        r.x = izq; r.w = der - izq; r.y = arr; r.h = aba - arr
      }
      this.recorte = r
    },

    recorteEstilo() {
      const r = this.recorte
      return `left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%`
    },

    ticketTamano(bytes) {
      return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
    },

    // Un <img> aplica la orientación EXIF al dibujar (Safari 13.1+, Chrome 81+)
    // y Safari decodifica HEIC; por eso se decodifica así y no a mano.
    async _ticketCanvasGirado(file, rot, ladoMax) {
      const url = URL.createObjectURL(file)
      try {
        const img = await new Promise((resolve, reject) => {
          const i = new Image()
          i.onload  = () => resolve(i)
          i.onerror = () => reject(new Error(`${file.name || 'Archivo'}: formato no admitido. Sube una foto o un PDF.`))
          i.src = url
        })
        const escala = Math.min(1, ladoMax / Math.max(img.naturalWidth, img.naturalHeight))
        const w = Math.round(img.naturalWidth * escala)
        const h = Math.round(img.naturalHeight * escala)
        const girada = rot % 180 !== 0
        const canvas = document.createElement('canvas')
        canvas.width  = girada ? h : w
        canvas.height = girada ? w : h
        const ctx = canvas.getContext('2d')
        // Fondo claro por si viene un PNG con transparencia
        ctx.fillStyle = '#f5f5f0'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.translate(canvas.width / 2, canvas.height / 2)
        ctx.rotate(rot * Math.PI / 180)
        ctx.drawImage(img, -w / 2, -h / 2, w, h)
        return canvas
      } finally {
        URL.revokeObjectURL(url)
      }
    },

    // PDF tal cual (el servidor limita a 15 MB). Imagen → girada y recortada
    // sobre la foto original, y al final JPEG ≤ 1600 px.
    async _ticketPreparar(file, { rot = 0, recorte = null } = {}) {
      const esPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')
      if (esPdf) {
        if (file.size > 15 * 1024 * 1024) throw new Error(`${file.name}: el PDF pasa de 15 MB`)
        return { blob: file, tipo: 'application/pdf' }
      }
      const base = await this._ticketCanvasGirado(file, rot, TICKET_LADO_TRABAJO)
      const r = recorte ?? { x: 0, y: 0, w: 1, h: 1 }
      const sx = Math.round(r.x * base.width),  sy = Math.round(r.y * base.height)
      const sw = Math.max(1, Math.round(r.w * base.width)), sh = Math.max(1, Math.round(r.h * base.height))
      const escala = Math.min(1, TICKET_LADO_MAX / Math.max(sw, sh))
      const canvas = document.createElement('canvas')
      canvas.width  = Math.round(sw * escala)
      canvas.height = Math.round(sh * escala)
      canvas.getContext('2d').drawImage(base, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', TICKET_CALIDAD))
      if (!blob) throw new Error(`${file.name || 'Archivo'}: no se pudo procesar la imagen`)
      return { blob, tipo: 'image/jpeg' }
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
