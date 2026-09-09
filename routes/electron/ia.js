/**
 * routes/electron/ia.js — proxy de llamarLLM para Chumi (UbicuoAI)
 * (Fase 1 de H-5: solo la llamada al proveedor de LLM se mueve aquí — las
 * ~20 funciones "tool" que corren SQL de solo lectura se quedan en Electron
 * hasta las fases 5/6 del plan, ya que necesitan la BD local).
 *
 * Equivalente de llamarLLM() en src/main/ia/inteligencia-negocio.js. Mismo
 * criterio de fallback (SambaNova → Groq), mismas API keys — ahora viven
 * solo como secrets del Worker.
 *
 * POST /api/electron/ia/chat — { messages, tools, tool_choice, max_tokens }
 * Responde el mismo shape que devuelven los proveedores: { choices: [...] }
 */

const router = require('express').Router()

const PROVEEDORES = [
  {
    nombre: 'SambaNova',
    url: 'https://api.sambanova.ai/v1/chat/completions',
    envKey: 'SAMBANOVA_API_KEY',
    modelo: 'Meta-Llama-3.3-70B-Instruct',
  },
  {
    nombre: 'Groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    envKey: 'GROQ_API_KEY',
    modelo: 'llama-3.3-70b-versatile',
  },
]

function parseRateLimitWait(mensaje) {
  const match = String(mensaje).match(/try again in (\d+)m([\d.]+)s/)
  if (match) {
    const mins = parseInt(match[1], 10)
    const secs = Math.ceil(parseFloat(match[2]))
    if (mins > 0) return `${mins} minuto${mins > 1 ? 's' : ''}`
    return `${secs} segundo${secs > 1 ? 's' : ''}`
  }
  return null
}

async function llamarProveedor(prov, body) {
  const res = await fetch(prov.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env[prov.envKey]}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: prov.modelo, ...body }),
  })
  if (!res.ok) {
    const texto = await res.text().catch(() => '')
    const err = new Error(`${res.status} ${texto}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

router.post('/chat', async (req, res) => {
  try {
    const { messages, tools, tool_choice, max_tokens } = req.body
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ ok: false, error: 'Falta messages' })
    }

    const disponibles = PROVEEDORES.filter(p => process.env[p.envKey])
    if (!disponibles.length) {
      console.error('[ia] Ningún proveedor de LLM configurado (SAMBANOVA_API_KEY/GROQ_API_KEY)')
      return res.status(500).json({ ok: false, error: 'Servidor sin configurar' })
    }

    const body = { max_tokens: max_tokens || 2048, tools, tool_choice, messages }

    let ultimoError = null
    for (let i = 0; i < disponibles.length; i++) {
      const prov = disponibles[i]
      const esUltimo = i === disponibles.length - 1
      try {
        const data = await llamarProveedor(prov, body)
        return res.json({ ok: true, data })
      } catch (e) {
        ultimoError = e
        const esRateLimit = e.status === 429
        if (!esUltimo) {
          console.warn(`[ia] ${prov.nombre} ${esRateLimit ? 'rate limited' : 'error'}: ${e.message}. Cambiando a ${disponibles[i + 1].nombre}...`)
          continue
        }
      }
    }

    const esRateLimit = ultimoError?.status === 429
    if (esRateLimit) {
      const espera = parseRateLimitWait(ultimoError.message)
      return res.status(429).json({
        ok: false,
        error: espera ? `Estoy descansando un momento. Vuelve a intentar en ${espera}.` : 'Estoy recibiendo muchas consultas. Espera unos minutos e intenta de nuevo.',
      })
    }
    console.error('[ia] Todos los proveedores fallaron:', ultimoError?.message)
    res.status(502).json({ ok: false, error: 'No se pudo contactar al asistente. Intenta de nuevo.' })
  } catch (e) {
    console.error('[ia] error:', e.message)
    res.status(500).json({ ok: false, error: 'Error interno del servidor' })
  }
})

module.exports = router
