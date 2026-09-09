/**
 * routes/electron/geocoding.js — proxy a Google Geocoding API
 * (Fase 1 de H-5: primer proxy de llave de API, sin lógica de negocio)
 *
 * Equivalente de geocoding.handler.ts en disfruleg-electron. La llave real
 * (GOOGLE_GEOCODING_KEY) vive solo aquí, como secret del Worker — nunca en
 * el .env del cliente.
 *
 * POST /api/electron/geocoding/resolver — { direccion }
 */

const router = require('express').Router()

const GEOCODING_BASE = 'https://maps.googleapis.com/maps/api/geocode/json'

router.post('/resolver', async (req, res) => {
  try {
    const { direccion } = req.body
    if (!direccion || typeof direccion !== 'string') {
      return res.status(400).json({ ok: false, error: 'Falta la dirección a resolver' })
    }

    const key = process.env.GOOGLE_GEOCODING_KEY
    if (!key) {
      console.error('[geocoding] GOOGLE_GEOCODING_KEY no está configurado')
      return res.status(500).json({ ok: false, error: 'Servidor sin configurar' })
    }

    const url = `${GEOCODING_BASE}?address=${encodeURIComponent(direccion)}&key=${key}&language=es&region=MX`
    const googleRes = await fetch(url)
    const json = await googleRes.json()

    if (json.status !== 'OK' || !json.results?.length) {
      return res.status(422).json({
        ok: false,
        error: json.status === 'ZERO_RESULTS'
          ? 'Dirección no encontrada. Intenta ser más específico.'
          : `Error de Google: ${json.status}`,
      })
    }

    const { lat, lng } = json.results[0].geometry.location
    res.json({
      ok: true,
      data: { lat, lng, direccion_formateada: json.results[0].formatted_address },
    })
  } catch (e) {
    console.error('[geocoding] error:', e.message)
    res.status(500).json({ ok: false, error: 'Error interno del servidor' })
  }
})

module.exports = router
