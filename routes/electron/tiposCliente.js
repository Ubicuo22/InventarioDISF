/**
 * routes/electron/tiposCliente.js — Equivalente de tiposCliente:obtenerTodos
 * (src/main/handlers/tipos.cliente.handler.ts en disfruleg-electron)
 *
 * Canal trivial elegido para la Fase 0: solo lectura, sin lógica de negocio,
 * usado para probar el mecanismo completo (Electron → Worker → TiDB → Electron)
 * de punta a punta antes de tocar nada sensible.
 */

const router = require('express').Router()
const { q } = require('../../db/pool')

// GET /api/electron/tipos-cliente
router.get('/', async (req, res) => {
  try {
    const rows = await q(`
      SELECT id_tipo_cliente, nombre_tipo, descuento
      FROM tipo_cliente
      ORDER BY nombre_tipo ASC
    `)
    res.json({ ok: true, data: rows })
  } catch (e) {
    console.error('[electron-tipos-cliente] obtenerTodos:', e.message)
    res.status(500).json({ ok: false, error: 'Error al obtener tipos de cliente' })
  }
})

module.exports = router
