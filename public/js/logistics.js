function logisticsModule() {
  return {
    // ── State ────────────────────────────────────────────────────
    logisticsUnidades:    [],   // live positions from /api/telemetria/unidades/live
    logisticsGeocercas:   [],   // from /api/telemetria/geocercas
    logisticsSelectedId:  null, // selected unidad_id
    logisticsDetalle:     null, // { eventos: [] }
    logisticsHistorial:   [],   // [{lat, lng, timestamp_servidor}]
    logisticsCargando:    false,
    logisticsError:       null,
    _logPollTimer:        null,
    _logDetailTimer:      null,
    _logMapReady:         false,

    // ── Colors ──────────────────────────────────────────────────
    _logColor(estado) {
      const map = {
        en_ruta:    '#0ea5e9',
        en_cliente: '#f59e0b',
        en_bodega:  '#10b981',
        sin_senal:  '#ef4444',
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
      return map[estado] || (estado || '—')
    },

    logisticsTimeSince(ts) {
      if (!ts) return '—'
      const diff = Date.now() - new Date(ts).getTime()
      const mins = Math.floor(diff / 60000)
      if (mins < 1) return 'Ahora'
      if (mins < 60) return `${mins}m`
      return `${Math.floor(mins / 60)}h ${mins % 60}m`
    },

    // ── Map init ────────────────────────────────────────────────
    async initLogisticsMap() {
      if (this._logMapReady) {
        // already initialized — just trigger a resize in case layout changed
        if (window._lmap) window._lmap.invalidateSize()
        return
      }
      if (typeof L === 'undefined') {
        this.logisticsError = 'Leaflet no cargado'
        return
      }
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
        subdomains: 'abcd',
        maxZoom: 19,
      }).addTo(window._lmap)

      L.control.attribution({ prefix: false })
        .addAttribution('© OpenStreetMap © CartoDB')
        .addTo(window._lmap)

      window._lmarkers   = {}  // unidad_id → L.marker
      window._lgeocercas = []  // L.circle[]
      window._ltrail     = null

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
      if (window._lmap) {
        window._lmap.remove()
        window._lmap = null
      }
      window._lmarkers = null
      window._lgeocercas = null
      window._ltrail = null
      this._logMapReady = false
      this.logisticsSelectedId = null
      this.logisticsDetalle = null
      this.logisticsHistorial = []
    },

    _startLogisticsPoll() {
      this._stopLogisticsPoll()
      this._logPollTimer = setInterval(() => this.cargarLogisticsUnidades(), 5000)
    },

    _stopLogisticsPoll() {
      if (this._logPollTimer)  { clearInterval(this._logPollTimer);  this._logPollTimer  = null }
      if (this._logDetailTimer){ clearInterval(this._logDetailTimer); this._logDetailTimer = null }
    },

    // ── Data loading ────────────────────────────────────────────
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
    _deriveEstado(u) {
      if (!u.ultimo_ping) return 'sin_senal'
      if (Date.now() - new Date(u.ultimo_ping).getTime() > 2 * 60 * 1000) return 'sin_senal'
      if (u.ultimo_evento_geo === 'entrada_geocerca') return 'en_cliente'
      return (parseFloat(u.velocidad_kmh) || 0) >= 3 ? 'en_ruta' : 'en_bodega'
    },

    _markerIcon(unidad_id, estado, alerta) {
      const color = this._logColor(estado)
      const isSelected = this.logisticsSelectedId === unidad_id
      const ring = isSelected ? `box-shadow:0 0 0 3px ${color},0 0 20px ${color}88` : `box-shadow:0 0 12px ${color}66`
      const alertStyle = alerta ? 'animation:pulse-alert 1.5s infinite;' : ''
      return L.divIcon({
        className: '',
        html: `<style>@keyframes pulse-alert{0%,100%{box-shadow:0 0 0 0 #f9731666}50%{box-shadow:0 0 0 8px #f9731600}}</style><div style="${alertStyle}
          width:40px;height:40px;border-radius:50%;
          background:${color}22;border:2.5px solid ${color};
          display:flex;align-items:center;justify-content:center;
          ${ring};cursor:pointer">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="${color}" xmlns="http://www.w3.org/2000/svg">
            <rect x="1" y="3" width="15" height="13" rx="1"/>
            <path d="M16 8h3l3 3v5h-6V8z"/>
            <circle cx="5.5" cy="18.5" r="2.5" fill="${color}"/>
            <circle cx="18.5" cy="18.5" r="2.5" fill="${color}"/>
          </svg>
        </div>`,
        iconSize: [40, 40],
        iconAnchor: [20, 20],
        popupAnchor: [0, -20],
      })
    },

    _actualizarMarkers() {
      if (!window._lmap || !window._lmarkers) return
      const vistos = new Set()

      for (const u of this.logisticsUnidades) {
        if (!u.lat || !u.lng) continue
        vistos.add(u.unidad_id)
        const estado = this._deriveEstado(u)
        const icon = this._markerIcon(u.unidad_id, estado, u.alerta_tipo)

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

      // Remove markers for units no longer reporting
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
      if (window._lgeocercas) {
        window._lgeocercas.forEach(l => window._lmap.removeLayer(l))
      }
      window._lgeocercas = []

      for (const g of this.logisticsGeocercas) {
        if (!g.activa) continue
        const color  = g.tipo === 'bodega' ? '#10b981' : '#f59e0b'
        const dashes = g.tipo === 'cliente' ? '6 4' : null
        const circle = L.circle([g.lat, g.lng], {
          radius:      g.radio_m,
          color,
          fillColor:   color,
          fillOpacity: 0.07,
          weight:      g.tipo === 'bodega' ? 2 : 1.5,
          dashArray:   dashes,
        }).addTo(window._lmap)
        circle.bindTooltip(g.nombre, { permanent: false, direction: 'top' })
        window._lgeocercas.push(circle)
      }
    },

    // ── Unit selection ───────────────────────────────────────────
    async seleccionarLogisticsUnidad(unidadId) {
      // Deselect if already selected
      if (this.logisticsSelectedId === unidadId) {
        this.logisticsSelectedId = null
        this.logisticsDetalle    = null
        this.logisticsHistorial  = []
        this._clearTrail()
        if (this._logDetailTimer) { clearInterval(this._logDetailTimer); this._logDetailTimer = null }
        this._actualizarMarkers()
        return
      }

      this.logisticsSelectedId = unidadId
      this._actualizarMarkers()  // refresh icon ring

      const u = this.logisticsUnidades.find(x => x.unidad_id === unidadId)
      if (u?.lat && u?.lng && window._lmap) {
        window._lmap.setView([u.lat, u.lng], 15, { animate: true })
      }

      if (u?.ruta_id) {
        await this._cargarDetalle(u.ruta_id)
        if (this._logDetailTimer) clearInterval(this._logDetailTimer)
        this._logDetailTimer = setInterval(async () => {
          const cur = this.logisticsUnidades.find(x => x.unidad_id === unidadId)
          if (cur?.ruta_id) await this._cargarDetalle(cur.ruta_id)
        }, 15000)
      } else {
        this.logisticsDetalle   = null
        this.logisticsHistorial = []
        this._clearTrail()
      }
    },

    async _cargarDetalle(rutaId) {
      try {
        const [evRes, histRes] = await Promise.all([
          fetch(`/api/telemetria/rutas/${rutaId}/eventos`),
          fetch(`/api/telemetria/rutas/${rutaId}/historial`),
        ])
        const eventos = await evRes.json()
        const hist    = await histRes.json()
        this.logisticsDetalle   = { eventos: Array.isArray(eventos) ? eventos : [] }
        this.logisticsHistorial = Array.isArray(hist) ? hist : []
        this._renderTrail()
      } catch {}
    },

    // ── Trail polyline ───────────────────────────────────────────
    _renderTrail() {
      this._clearTrail()
      if (!window._lmap || !this.logisticsHistorial.length) return
      window._ltrail = L.polyline(
        this.logisticsHistorial.map(p => [p.lat, p.lng]),
        { color: '#0ea5e9', weight: 3, opacity: 0.6, smoothFactor: 1 }
      ).addTo(window._lmap)
    },

    _clearTrail() {
      if (window._lmap && window._ltrail) {
        window._lmap.removeLayer(window._ltrail)
        window._ltrail = null
      }
    },

    // ── Computed helpers ─────────────────────────────────────────
    logisticsUnidadActual() {
      const u = this.logisticsUnidades.find(x => x.unidad_id === this.logisticsSelectedId) || null
      if (u) u._estado = this._deriveEstado(u)
      return u
    },

    logisticsUnidadEstado(u) {
      return u ? this._deriveEstado(u) : 'sin_senal'
    },

    logisticsEventoIcon(tipo) {
      const map = {
        inicio_ruta:            '🚀',
        llegada_cliente:        '📍',
        entrega_probable:       '✅',
        parada_extraordinaria:  '⚠️',
        sin_senal:              '📵',
        senal_recuperada:       '📶',
        fin_ruta:               '🏁',
      }
      return map[tipo] || '•'
    },

    logisticsFormatHora(ts) {
      if (!ts) return '—'
      return new Date(ts).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
    },
  }
}
