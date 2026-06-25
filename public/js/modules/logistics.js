function logisticsModule() {
  return {
    // ── State ────────────────────────────────────────────────────
    logisticsUnidades:      [],
    logisticsGeocercas:     [],
    logisticsSelectedId:    null,
    logisticsRuta:          null,  // { pedidos:[], eventos:[], hora_salida_bodega, estado }
    logisticsHistorial:     [],
    logisticsParadas:       [],
    logisticsCargando:      false,
    logisticsError:         null,
    _logPollTimer:          null,
    _logDetailTimer:        null,
    _logMapReady:           false,

    // ── Estado derivado (igual que Electron) ─────────────────────
    _deriveEstado(u) {
      if (!u.ultimo_ping) return 'sin_senal'
      if (Date.now() - new Date(u.ultimo_ping).getTime() > 2 * 60 * 1000) return 'sin_senal'
      return (u.velocidad_kmh ?? 0) >= 3 ? 'en_ruta' : 'en_bodega'
    },

    // ── Colors ───────────────────────────────────────────────────
    _logColor(estado) {
      const map = {
        en_ruta:    '#38bdf8',
        en_cliente: '#fbbf24',
        en_bodega:  '#34d399',
        sin_senal:  '#f87171',
        pendiente:  '#64748b',
      }
      return map[estado] || '#64748b'
    },

    logisticsEstadoLabel(estado) {
      const map = {
        en_ruta:    'En ruta',
        en_cliente: 'En cliente',
        en_bodega:  'En bodega',
        sin_senal:  'Sin señal',
        pendiente:  'Pendiente',
      }
      return map[estado] || (estado ? estado.replace(/_/g, ' ') : 'Inactivo')
    },

    logisticsNombreUnidad(u) {
      return u?.unidad_nombre || `Unidad ${u?.unidad_id}`
    },

    logisticsConductor(u) {
      return u?.conductor || u?.nombre_repartidor || ''
    },

    logisticsTimeSince(ts) {
      if (!ts) return '—'
      const diff = Date.now() - new Date(ts).getTime()
      const secs = Math.floor(diff / 1000)
      if (secs < 60) return `${secs}s`
      const mins = Math.floor(secs / 60)
      if (mins < 60) return `${mins}m`
      return `${Math.floor(mins / 60)}h ${mins % 60}m`
    },

    // ── Computed ─────────────────────────────────────────────────
    logisticsUnidadActual() {
      return this.logisticsUnidades.find(u => u.unidad_id === this.logisticsSelectedId) || null
    },

    logisticsProgreso() {
      if (!this.logisticsRuta?.pedidos?.length) return null
      const total = this.logisticsRuta.pedidos.length
      const done  = this.logisticsRuta.pedidos.filter(
        p => p.estado === 'entregado_probable' || p.estado === 'confirmado'
      ).length
      return { done, total, pct: Math.round((done / total) * 100) }
    },

    logisticsPedidoColor(estado) {
      const map = {
        entregado_probable: '#34d399',
        confirmado:         '#34d399',
        en_camino:          '#38bdf8',
        pendiente:          '#64748b',
        cancelado:          '#f87171',
      }
      return map[estado] || '#64748b'
    },

    logisticsPedidoLabel(estado) {
      const map = {
        entregado_probable: 'Entregado',
        confirmado:         'Confirmado',
        en_camino:          'En camino',
        pendiente:          'Pendiente',
        cancelado:          'Cancelado',
      }
      return map[estado] || estado
    },

    // ── Map init ─────────────────────────────────────────────────
    async initLogisticsMap() {
      if (this._logMapReady) {
        if (window._lmap) {
          window._lmap.invalidateSize()
          setTimeout(() => window._lmap && window._lmap.invalidateSize(), 300)
        }
        return
      }
      if (typeof L === 'undefined') { this.logisticsError = 'Leaflet no cargado'; return }
      const container = document.getElementById('logistics-map')
      if (!container) return

      this._logMapReady = true
      this.logisticsError = null

      window._lmap = L.map('logistics-map', {
        center: [19.7174, -101.1663],
        zoom: 13,
        zoomControl: true,
        attributionControl: false,
      })

      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        subdomains: 'abcd', maxZoom: 19,
      }).addTo(window._lmap)

      L.control.attribution({ prefix: false })
        .addAttribution('© OpenStreetMap © CartoDB')
        .addTo(window._lmap)

      window._lmarkers   = {}
      window._lgeocercas = []
      window._ltrail     = null
      window._lparadas   = []

      if (window._lmapRO) window._lmapRO.disconnect()
      window._lmapRO = new ResizeObserver(() => { if (window._lmap) window._lmap.invalidateSize() })
      window._lmapRO.observe(container)

      setTimeout(() => window._lmap && window._lmap.invalidateSize(), 150)
      setTimeout(() => window._lmap && window._lmap.invalidateSize(), 500)

      this.logisticsCargando = true
      await Promise.all([
        this.cargarLogisticsGeocercas(),
        this.cargarLogisticsUnidades(),
      ])
      this.logisticsCargando = false
      this._startLogisticsPoll()
    },

    destroyLogisticsMap() {
      this._stopLogisticsPoll()
      if (window._lmap) { window._lmap.remove(); window._lmap = null }
      window._lmarkers = null
      window._lgeocercas = null
      window._ltrail = null
      window._lparadas = null
      this._logMapReady = false
      this.logisticsSelectedId = null
      this.logisticsRuta = null
      this.logisticsHistorial = []
      this.logisticsParadas = []
    },

    _startLogisticsPoll() {
      this._stopLogisticsPoll()
      this._logPollTimer = setInterval(() => this.cargarLogisticsUnidades(), 5000)
    },

    _stopLogisticsPoll() {
      if (this._logPollTimer)  { clearInterval(this._logPollTimer);  this._logPollTimer  = null }
      if (this._logDetailTimer){ clearInterval(this._logDetailTimer); this._logDetailTimer = null }
    },

    // ── Data loading ─────────────────────────────────────────────
    async cargarLogisticsUnidades() {
      try {
        const r = await fetch('/api/telemetria/unidades/live')
        if (!r.ok) throw new Error()
        const data = await r.json()
        this.logisticsUnidades = Array.isArray(data) ? data : []
        this._actualizarMarkers()
        this.logisticsError = null
      } catch {
        this.logisticsError = 'Sin conexión con telemetría'
      }
    },

    async cargarLogisticsGeocercas() {
      try {
        const r = await fetch('/api/telemetria/geocercas')
        if (!r.ok) throw new Error()
        const data = await r.json()
        this.logisticsGeocercas = Array.isArray(data) ? data : []
        this._renderGeocercas()
      } catch {}
    },

    // ── Markers ──────────────────────────────────────────────────
    _markerIcon(unidad_id, estado) {
      const color = this._logColor(estado)
      const isSelected = this.logisticsSelectedId === unidad_id
      const u = this.logisticsUnidades.find(x => x.unidad_id === unidad_id)
      const nombre = u?.conductor || u?.nombre_repartidor || u?.unidad_nombre || `U${unidad_id}`
      const glow = isSelected
        ? `filter:drop-shadow(0 0 6px ${color})`
        : `filter:drop-shadow(0 0 3px ${color}88)`
      return L.divIcon({
        className: '',
        html: `<div style="display:flex;flex-direction:column;align-items:center;gap:3px;cursor:pointer">
          <div style="background:rgba(10,14,22,0.82);border:1px solid rgba(255,255,255,0.15);border-radius:4px;padding:2px 6px;font-size:11px;font-weight:600;color:#fff;white-space:nowrap;letter-spacing:0.03em;backdrop-filter:blur(4px)">${nombre}</div>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="${color}" xmlns="http://www.w3.org/2000/svg" style="${glow}">
            <rect x="1" y="3" width="15" height="13" rx="1"/>
            <path d="M16 8h3l3 3v5h-6V8z"/>
            <circle cx="5.5" cy="18.5" r="2.5"/>
            <circle cx="18.5" cy="18.5" r="2.5"/>
          </svg>
        </div>`,
        iconSize: [80, 52],
        iconAnchor: [40, 52],
        popupAnchor: [0, -52],
      })
    },

    _actualizarMarkers() {
      if (!window._lmap || !window._lmarkers) return
      const vistos = new Set()

      for (const u of this.logisticsUnidades) {
        if (!u.lat || !u.lng) continue
        vistos.add(u.unidad_id)
        const estado = this._deriveEstado(u)
        const icon = this._markerIcon(u.unidad_id, estado)

        if (window._lmarkers[u.unidad_id]) {
          window._lmarkers[u.unidad_id].setLatLng([u.lat, u.lng])
          window._lmarkers[u.unidad_id].setIcon(icon)
        } else {
          const m = L.marker([u.lat, u.lng], { icon })
            .addTo(window._lmap)
            .on('click', () => this.seleccionarLogisticsUnidad(u.unidad_id))
          window._lmarkers[u.unidad_id] = m
        }
      }

      for (const id in window._lmarkers) {
        if (!vistos.has(parseInt(id))) {
          window._lmap.removeLayer(window._lmarkers[id])
          delete window._lmarkers[id]
        }
      }
    },

    // ── Geofences ────────────────────────────────────────────────
    _renderGeocercas() {
      if (!window._lmap) return
      if (window._lgeocercas) window._lgeocercas.forEach(l => window._lmap.removeLayer(l))
      window._lgeocercas = []
      for (const g of this.logisticsGeocercas) {
        if (!g.activa) continue
        const color  = g.tipo === 'bodega' ? '#34d399' : '#38bdf8'
        const dashes = g.tipo === 'cliente' ? '5 4' : null
        const circle = L.circle([g.lat, g.lng], {
          radius: g.radio_m, color, fillColor: color, fillOpacity: 0.08,
          weight: g.tipo === 'bodega' ? 2 : 1.5, dashArray: dashes,
        }).addTo(window._lmap)
        circle.bindTooltip(g.nombre, { permanent: false, direction: 'top' })
        window._lgeocercas.push(circle)
      }
    },

    // ── Unit selection ────────────────────────────────────────────
    async seleccionarLogisticsUnidad(unidadId) {
      if (this.logisticsSelectedId === unidadId) {
        this.logisticsSelectedId = null
        this.logisticsRuta       = null
        this.logisticsHistorial  = []
        this._clearTrail()
        this._clearParadas()
        if (this._logDetailTimer) { clearInterval(this._logDetailTimer); this._logDetailTimer = null }
        this._actualizarMarkers()
        return
      }

      this.logisticsSelectedId = unidadId
      this._actualizarMarkers()

      const u = this.logisticsUnidades.find(x => x.unidad_id === unidadId)
      if (u?.lat && u?.lng && window._lmap) {
        window._lmap.flyTo([u.lat, u.lng], 15, { animate: true, duration: 0.8 })
      }

      if (u?.ruta_id) {
        await this._cargarDetalle(u.ruta_id)
        if (this._logDetailTimer) clearInterval(this._logDetailTimer)
        this._logDetailTimer = setInterval(async () => {
          const cur = this.logisticsUnidades.find(x => x.unidad_id === unidadId)
          if (cur?.ruta_id) await this._cargarDetalle(cur.ruta_id)
        }, 15000)
      } else {
        this.logisticsRuta      = null
        this.logisticsHistorial = []
        this._clearTrail()
        this._clearParadas()
      }
    },

    async _cargarDetalle(rutaId) {
      try {
        const [detRes, histRes, parRes] = await Promise.all([
          fetch(`/api/telemetria/rutas/${rutaId}/detalle`),
          fetch(`/api/telemetria/rutas/${rutaId}/historial`),
          fetch(`/api/telemetria/rutas/${rutaId}/paradas`),
        ])

        if (detRes.ok) {
          const d = await detRes.json()
          this.logisticsRuta = {
            id:                  d.id,
            estado:              d.estado,
            hora_salida_bodega:  d.hora_salida_bodega ?? null,
            hora_regreso_bodega: d.hora_regreso_bodega ?? null,
            pedidos: Array.isArray(d.pedidos) ? d.pedidos : [],
            eventos: Array.isArray(d.eventos) ? d.eventos : [],
          }
        }

        if (histRes.ok) {
          const hist = await histRes.json()
          const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })
          this.logisticsHistorial = Array.isArray(hist)
            ? hist.filter(p => {
                if (!p.timestamp_servidor) return true
                return new Date(p.timestamp_servidor).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' }) === hoy
              })
            : []
          this._renderTrail()
        }

        if (parRes.ok) {
          const par = await parRes.json()
          this.logisticsParadas = Array.isArray(par) ? par : []
          this._renderParadas()
        }
      } catch {}
    },

    // ── Trail polyline ────────────────────────────────────────────
    _renderTrail() {
      this._clearTrail()
      if (!window._lmap || !this.logisticsHistorial.length) return
      window._ltrail = L.polyline(
        this.logisticsHistorial.map(p => [parseFloat(p.lat), parseFloat(p.lng)]),
        { color: '#38bdf8', weight: 3, opacity: 0.7, smoothFactor: 1 }
      ).addTo(window._lmap)
    },

    _clearTrail() {
      if (window._lmap && window._ltrail) {
        window._lmap.removeLayer(window._ltrail)
        window._ltrail = null
      }
    },

    // ── Paradas ───────────────────────────────────────────────────
    _renderParadas() {
      this._clearParadas()
      if (!window._lmap || !this.logisticsParadas.length) return
      window._lparadas = []
      this.logisticsParadas.forEach((p, i) => {
        const hora = new Date(p.inicio).toLocaleTimeString('es-MX', {
          hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City'
        })
        const color   = p.cliente_nombre ? '#38bdf8' : '#fbbf24'
        const tooltip = p.cliente_nombre
          ? `${p.cliente_nombre} — ${p.duracion_min} min (${hora})`
          : `Parada ${i + 1}: ${p.duracion_min} min (${hora})`
        const m = L.circleMarker([p.lat, p.lng], {
          radius: 6, color, fillColor: color, fillOpacity: 0.9, weight: 2,
        }).addTo(window._lmap)
        m.bindTooltip(tooltip, { direction: 'top' })
        window._lparadas.push(m)
      })
    },

    _clearParadas() {
      if (window._lmap && window._lparadas) {
        window._lparadas.forEach(m => window._lmap.removeLayer(m))
      }
      window._lparadas = []
      this.logisticsParadas = []
    },

    // ── Helpers UI ────────────────────────────────────────────────
    logisticsEventoIcon(tipo) {
      const map = {
        inicio_ruta:            '▶',
        salida_bodega:          '▶',
        llegada_cliente:        '◉',
        entrega_probable:       '✓',
        parada_extraordinaria:  '!',
        sin_senal:              '✕',
        senal_recuperada:       '↑',
        fin_ruta:               '■',
        regreso_bodega:         '■',
      }
      return map[tipo] || '·'
    },

    logisticsEventoColor(tipo) {
      const map = {
        inicio_ruta:            '#38bdf8',
        salida_bodega:          '#38bdf8',
        llegada_cliente:        '#fbbf24',
        entrega_probable:       '#34d399',
        parada_extraordinaria:  '#f97316',
        sin_senal:              '#f87171',
        senal_recuperada:       '#34d399',
        fin_ruta:               '#94a3b8',
        regreso_bodega:         '#94a3b8',
      }
      return map[tipo] || '#64748b'
    },

    logisticsEventoLabel(tipo) {
      const map = {
        inicio_ruta:            'Salida de bodega',
        salida_bodega:          'Salida de bodega',
        llegada_cliente:        'Llegada a cliente',
        entrega_probable:       'Entrega',
        parada_extraordinaria:  'Parada extraordinaria',
        sin_senal:              'Sin señal',
        senal_recuperada:       'Señal recuperada',
        fin_ruta:               'Regreso a bodega',
        regreso_bodega:         'Regreso a bodega',
      }
      return map[tipo] || (tipo || '').replace(/_/g, ' ')
    },

    logisticsFormatHora(ts) {
      if (!ts) return '—'
      return new Date(ts).toLocaleTimeString('es-MX', {
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City'
      })
    },

    logisticsIrAParada(idx) {
      const p = this.logisticsParadas[idx]
      if (p && window._lmap) {
        window._lmap.flyTo([p.lat, p.lng], 17, { animate: true, duration: 0.5 })
      }
    },
  }
}
