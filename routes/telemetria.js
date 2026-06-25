const router = require('express').Router()

const TELEMETRIA = 'http://localhost:3031'

router.all('/*', async (req, res) => {
  try {
    const qs = Object.keys(req.query).length
      ? '?' + new URLSearchParams(req.query).toString()
      : ''
    const url = `${TELEMETRIA}/api${req.path}${qs}`
    const opts = {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body && Object.keys(req.body).length) {
      opts.body = JSON.stringify(req.body)
    }
    const r = await fetch(url, opts)
    const data = await r.json()
    res.status(r.status).json(data)
  } catch {
    res.status(502).json({ ok: false, error: 'Telemetría no disponible' })
  }
})

module.exports = router
