/**
 * utils/actividad.js — Registro de historial de actividad por usuario
 *
 * Uso:
 *   const { registrar } = require('../utils/actividad')
 *   await registrar(req, 'inventario', 'entrada', { producto: 'Manzana', cantidad: 10 })
 */

const { q } = require('../db/pool')

/**
 * Registra una acción en logs_actividad.
 * Es fire-and-forget — nunca bloquea ni lanza excepción.
 *
 * @param {object} req      - objeto request de Express (para leer req.user e IP)
 * @param {string} modulo   - 'auth' | 'inventario' | 'mermas' | 'pedidos' | 'cobranza'
 * @param {string} accion   - descripción corta, ej: 'login', 'entrada', 'merma', 'orden', 'pago'
 * @param {object} detalles - datos extra (se guarda como JSON)
 */
async function registrar(req, modulo, accion, detalles = null) {
  try {
    const usuario = req.user?.username || 'SISTEMA'
    const nombre  = req.user?.nombre   || usuario
    const ip      = (
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress ||
      ''
    ).slice(0, 45)

    await q(
      `INSERT INTO logs_actividad (usuario, nombre, modulo, accion, detalles, ip)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [usuario, nombre, modulo, accion, detalles ? JSON.stringify(detalles) : null, ip]
    )
  } catch (e) {
    // No bloquear el flujo principal si falla el log
    console.warn('[actividad] No se pudo registrar:', e.message)
  }
}

module.exports = { registrar }
