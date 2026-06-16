/**
 * conteo.js — Corte físico de inventario
 *
 * Pantalla para capturar conteo físico producto por producto, comparando contra
 * el stock del sistema y aplicando ajustes (positivos o negativos).
 * Marca los productos verificados hoy para no contarlos dos veces.
 */
function conteoModule() {
  return {
    conteoListaProductos:    [],
    conteoCargando:          false,
    conteoQuery:             '',
    conteoFiltroUnidad:      '',
    conteoSoloPendientes:    false,
    conteoSeleccionado:      null,   // producto activo
    conteoCantidadFisica:    '',
    conteoGuardando:         false,
    conteoErrorAjuste:       '',
    conteoUltimoResultado:   null,

    async cargarConteoLista() {
      this.conteoCargando = true
      try {
        const params = new URLSearchParams()
        if (this.conteoQuery)          params.set('q', this.conteoQuery)
        if (this.conteoFiltroUnidad)   params.set('unidad', this.conteoFiltroUnidad)
        if (this.conteoSoloPendientes) params.set('soloPendientes', 'true')
        const r = await API.get('/api/entradas/conteo-fisico/estado?' + params.toString())
        this.conteoListaProductos = r.ok ? (r.data || []) : []
      } catch (e) {
        this.conteoListaProductos = []
      } finally {
        this.conteoCargando = false
      }
    },

    conteoStats() {
      const total = this.conteoListaProductos.length
      const contados = this.conteoListaProductos.filter(p => p.ultima_fecha).length
      return { total, contados, pendientes: total - contados }
    },

    conteoSeleccionar(prod) {
      this.conteoSeleccionado = prod
      this.conteoCantidadFisica = ''
      this.conteoErrorAjuste = ''
      this.conteoUltimoResultado = null
      this.$nextTick(() => document.getElementById('conteo-input-fisica')?.focus())
    },

    conteoLimpiarSeleccion() {
      this.conteoSeleccionado = null
      this.conteoCantidadFisica = ''
      this.conteoErrorAjuste = ''
    },

    conteoDelta() {
      if (!this.conteoSeleccionado || this.conteoCantidadFisica === '') return null
      const fisica = parseFloat(this.conteoCantidadFisica)
      if (isNaN(fisica)) return null
      const sis = parseFloat(this.conteoSeleccionado.stock)
      return +(fisica - sis).toFixed(4)
    },

    async conteoAplicarAjuste() {
      if (!this.conteoSeleccionado) return
      const fisica = parseFloat(this.conteoCantidadFisica)
      if (isNaN(fisica) || fisica < 0) { this.conteoErrorAjuste = 'Cantidad inválida'; return }

      this.conteoGuardando = true
      this.conteoErrorAjuste = ''
      try {
        const r = await API.post('/api/entradas/ajuste-inventario', {
          idProducto: this.conteoSeleccionado.id_producto,
          cantidadFisica: fisica
        })
        if (!r.ok) { this.conteoErrorAjuste = r.error || 'Error al ajustar'; return }

        // Actualizar localmente sin recargar todo
        const p = this.conteoListaProductos.find(x => x.id_producto === this.conteoSeleccionado.id_producto)
        if (p) {
          p.stock = fisica
          p.ultima_fisica = fisica
          p.ultima_sistema = r.data.stockAntes
          p.ultima_delta = r.data.delta
          p.ultima_usuario = this.session?.username || ''
          p.ultima_fecha = new Date().toISOString()
        }
        this.conteoUltimoResultado = r.data
        this.conteoCantidadFisica = ''
        this.toastShow?.('Ajuste aplicado: ' + (r.data.delta > 0 ? '+' : '') + r.data.delta, 'success')

        // Auto-avanzar al siguiente pendiente si está activo "soloPendientes"
        if (this.conteoSoloPendientes) {
          const idx = this.conteoListaProductos.findIndex(x => x.id_producto === this.conteoSeleccionado.id_producto)
          const siguiente = this.conteoListaProductos.slice(idx + 1).find(x => !x.ultima_fecha)
          if (siguiente) this.conteoSeleccionar(siguiente)
          else this.conteoSeleccionado = null
        }
      } catch (e) {
        this.conteoErrorAjuste = !navigator.onLine ? 'Sin conexión' : (e.message || 'Error al ajustar')
      } finally {
        this.conteoGuardando = false
      }
    }
  }
}
