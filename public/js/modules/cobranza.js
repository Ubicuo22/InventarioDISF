/**
 * cobranza.js — Módulo Alpine.js para el panel de cobranza móvil
 *
 * Vista: lista de deudas con semáforo → detalle → registrar pago → WhatsApp
 */

function cobranzaModule() {
  return {
    // ── Estado ────────────────────────────────────────────
    cobranzaVista:      'lista',    // 'lista' | 'detalle'
    deudas:             [],
    deudaStats:         {},
    deudaSeleccionada:  null,
    pagosDeuda:         [],
    cargandoDeudas:     false,
    cargandoPagos:      false,
    cobranzaFiltro:     'todos',    // 'todos' | 'vencida' | 'por_vencer' | 'al_dia'
    cobranzaBusqueda:   '',

    // ── Modal de pago ─────────────────────────────────────
    modalPagoAbierto:   false,
    pagoForm: {
      monto:        '',
      metodoPago:   'efectivo',
      referencia:   '',
      notas:        '',
      razonParcial: ''
    },
    guardandoPago:      false,
    pagoError:          '',

    // ── Cargar lista ──────────────────────────────────────
    async cargarDeudas() {
      this.cargandoDeudas = true
      try {
        const params = new URLSearchParams()
        if (this.cobranzaFiltro !== 'todos') params.set('estado', this.cobranzaFiltro)
        if (this.cobranzaBusqueda.trim())    params.set('busqueda', this.cobranzaBusqueda.trim())

        const [r, s] = await Promise.all([
          API.get(`/api/deudas?${params}`),
          API.get('/api/deudas/stats')
        ])
        if (r.ok) this.deudas      = r.data
        if (s.ok) this.deudaStats  = s.data
      } catch { /* silent */ }
      finally { this.cargandoDeudas = false }
    },

    async abrirDeuda(deuda) {
      this.deudaSeleccionada = deuda
      this.cobranzaVista     = 'detalle'
      this.cargandoPagos     = true
      try {
        const r = await API.get(`/api/deudas/${deuda.id_deuda}/pagos`)
        if (r.ok) this.pagosDeuda = r.data
      } catch { /* silent */ }
      finally { this.cargandoPagos = false }
    },

    volverALista() {
      this.cobranzaVista    = 'lista'
      this.deudaSeleccionada = null
      this.pagosDeuda        = []
    },

    // ── WhatsApp ──────────────────────────────────────────
    abrirWhatsApp(deuda) {
      const tel = (deuda.telefono || '').replace(/\D/g, '')
      if (!tel) {
        this.mostrarToast('Este cliente no tiene teléfono registrado', true)
        return
      }
      const numero   = tel.startsWith('52') ? tel : `52${tel}`
      const saldo    = this.fmtMoney(deuda.saldo_pendiente)
      const folio    = deuda.id_factura ? `#${String(deuda.id_factura).padStart(4, '0')}` : ''
      const vence    = deuda.fecha_vencimiento
        ? new Date(deuda.fecha_vencimiento).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: '2-digit' })
        : ''

      let msg = `Hola ${deuda.nombre_cliente}, le recordamos que tiene un saldo pendiente de ${saldo}`
      if (folio) msg += ` correspondiente a la nota ${folio}`
      if (vence) msg += `, con fecha de vencimiento el ${vence}`
      msg += `.\n\nPor favor contáctenos para coordinar el pago.\n\nDISFRULEG`

      window.open(`https://wa.me/${numero}?text=${encodeURIComponent(msg)}`, '_blank')
    },

    // ── Modal de pago ─────────────────────────────────────
    abrirModalPago(deuda) {
      this.deudaSeleccionada = deuda
      this.pagoForm = {
        monto:        parseFloat(deuda.saldo_pendiente).toFixed(2),
        metodoPago:   'efectivo',
        referencia:   '',
        notas:        '',
        razonParcial: ''
      }
      this.pagoError        = ''
      this.modalPagoAbierto = true
    },

    cerrarModalPago() {
      this.modalPagoAbierto = false
      this.pagoError        = ''
    },

    esPagoParcial() {
      const deuda = this.deudaSeleccionada
      if (!deuda) return false
      const monto = parseFloat(this.pagoForm.monto) || 0
      return monto < parseFloat(deuda.saldo_pendiente) - 0.01
    },

    async confirmarPago() {
      const deuda = this.deudaSeleccionada
      if (!deuda) return

      this.pagoError = ''
      const monto = parseFloat(this.pagoForm.monto)
      if (!monto || monto <= 0) { this.pagoError = 'Ingresa un monto válido'; return }
      if (this.esPagoParcial() && !this.pagoForm.razonParcial.trim()) {
        this.pagoError = 'Explica el motivo del pago parcial'
        return
      }

      this.guardandoPago = true
      try {
        const r = await API.post('/api/pagos', {
          idDeuda:      deuda.id_deuda,
          monto,
          metodoPago:   this.pagoForm.metodoPago,
          referencia:   this.pagoForm.referencia || null,
          notas:        this.pagoForm.notas || null,
          razonParcial: this.pagoForm.razonParcial || null
        })

        if (!r.ok) { this.pagoError = r.error || 'Error al registrar pago'; return }

        this.cerrarModalPago()

        if (r.pagada) {
          this.mostrarToast(`✅ Deuda de ${deuda.nombre_cliente} saldada`)
          // Quitar de la lista
          this.deudas = this.deudas.filter(d => d.id_deuda !== deuda.id_deuda)
          this.volverALista()
        } else {
          this.mostrarToast(`Pago de ${this.fmtMoney(monto)} registrado`)
          // Actualizar saldo en lista y detalle
          const nuevo = parseFloat(deuda.saldo_pendiente) - monto
          const idx   = this.deudas.findIndex(d => d.id_deuda === deuda.id_deuda)
          if (idx !== -1) {
            this.deudas[idx].saldo_pendiente = nuevo
            this.deudas[idx].monto_pagado    = parseFloat(deuda.monto_pagado) + monto
          }
          if (this.deudaSeleccionada?.id_deuda === deuda.id_deuda) {
            this.deudaSeleccionada.saldo_pendiente = nuevo
            this.deudaSeleccionada.monto_pagado    = parseFloat(deuda.monto_pagado) + monto
            // Recargar historial de pagos
            const hp = await API.get(`/api/deudas/${deuda.id_deuda}/pagos`)
            if (hp.ok) this.pagosDeuda = hp.data
          }
        }
        // Actualizar stats
        const s = await API.get('/api/deudas/stats')
        if (s.ok) this.deudaStats = s.data
      } catch {
        this.pagoError = 'Error de conexión'
      } finally {
        this.guardandoPago = false
      }
    },

    // ── Helpers ───────────────────────────────────────────
    semaforoClass(semaforo) {
      switch (semaforo) {
        case 'vencida':     return 'text-red-400 bg-red-400/10 border-red-400/30'
        case 'por_vencer':  return 'text-amber-400 bg-amber-400/10 border-amber-400/30'
        case 'al_dia':      return 'text-emerald-400 bg-emerald-400/10 border-emerald-400/30'
        default:            return 'text-slate-400 bg-slate-400/10 border-slate-400/20'
      }
    },

    semaforoDot(semaforo) {
      switch (semaforo) {
        case 'vencida':     return 'bg-red-400'
        case 'por_vencer':  return 'bg-amber-400'
        case 'al_dia':      return 'bg-emerald-400'
        default:            return 'bg-slate-500'
      }
    },

    semaforoLabel(semaforo, diasRestantes) {
      switch (semaforo) {
        case 'vencida':     return `Vencida hace ${Math.abs(diasRestantes)} día${Math.abs(diasRestantes) !== 1 ? 's' : ''}`
        case 'por_vencer':  return diasRestantes === 0 ? 'Vence hoy' : `Vence en ${diasRestantes} día${diasRestantes !== 1 ? 's' : ''}`
        case 'al_dia':      return `${diasRestantes} días restantes`
        default:            return 'Sin plazo'
      }
    },

    porcentajePagado(deuda) {
      if (!deuda.monto_total || deuda.monto_total <= 0) return 0
      return Math.min(100, Math.round((deuda.monto_pagado / deuda.monto_total) * 100))
    },

    fmtMoney(v) {
      return '$' + parseFloat(v || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    },

    fmtFechaPago(f) {
      if (!f) return '—'
      return new Date(f).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: '2-digit' })
    }
  }
}
