/**
 * routes/pagos.js — Registro de pagos desde appweb móvil
 *
 * POST /api/pagos — registrar pago (total o parcial)
 */

const router = require('express').Router()
const { pool } = require('../db/pool')
const { requireAuth, requireModulo } = require('../middleware/auth')
const { registrar } = require('../utils/actividad')

router.use(requireAuth, requireModulo('cobranza'))

// ── POST /api/pagos ───────────────────────────────────────
router.post('/', async (req, res) => {
  const conn = await pool.getConnection()
  try {
    const {
      idDeuda,
      monto,
      metodoPago,           // 'efectivo' | 'transferencia' | 'cheque' | 'tarjeta'
      referencia    = null,
      notas         = null,
      razonParcial  = null  // obligatorio si monto < saldo pendiente
    } = req.body

    const usuario = req.user?.nombre || req.user?.username || 'BODEGA'

    // ── Validaciones ──────────────────────────────────────
    if (!idDeuda || !monto || !metodoPago) {
      return res.status(400).json({ ok: false, error: 'Faltan campos: idDeuda, monto, metodoPago' })
    }
    const montoNum = parseFloat(monto)
    if (isNaN(montoNum) || montoNum <= 0) {
      return res.status(400).json({ ok: false, error: 'Monto inválido' })
    }

    await conn.beginTransaction()

    // Leer deuda actual
    const [deudas] = await conn.execute(
      'SELECT id_deuda, monto_total, monto_pagado, pagado FROM deudas WHERE id_deuda = ? FOR UPDATE',
      [idDeuda]
    )
    if (!deudas.length) {
      await conn.rollback()
      return res.status(404).json({ ok: false, error: 'Deuda no encontrada' })
    }
    const deuda = deudas[0]
    if (deuda.pagado) {
      await conn.rollback()
      return res.status(400).json({ ok: false, error: 'Esta deuda ya está pagada' })
    }

    const saldoPendiente = parseFloat(deuda.monto_total) - parseFloat(deuda.monto_pagado)
    if (montoNum > saldoPendiente + 0.01) {
      await conn.rollback()
      return res.status(400).json({ ok: false, error: `El monto ($${montoNum}) excede el saldo pendiente ($${saldoPendiente.toFixed(2)})` })
    }

    // Pago parcial requiere razón
    const esParcial = montoNum < saldoPendiente - 0.01
    if (esParcial && !razonParcial) {
      await conn.rollback()
      return res.status(400).json({ ok: false, error: 'Los pagos parciales requieren una razón' })
    }

    // ── Insertar pago_registrado ──────────────────────────
    const [result] = await conn.execute(
      `INSERT INTO pago_registrado
         (id_deuda, monto_pagado, fecha_pago, metodo_pago, referencia_pago,
          notas, razon_pago_parcial, usuario_registro, estado_pago)
       VALUES (?, ?, CURDATE(), ?, ?, ?, ?, ?, 'PROCESSED')`,
      [idDeuda, montoNum, metodoPago, referencia, notas, razonParcial || null, usuario]
    )

    // ── Actualizar deudas ─────────────────────────────────
    const nuevoMontoPagado = parseFloat(deuda.monto_pagado) + montoNum
    const pagada = nuevoMontoPagado >= parseFloat(deuda.monto_total) - 0.01 ? 1 : 0

    await conn.execute(
      `UPDATE deudas
       SET monto_pagado   = ?,
           pagado         = ?,
           fecha_pago     = CASE WHEN ? = 1 THEN NOW() ELSE fecha_pago END,
           metodo_pago    = ?,
           referencia_pago = ?
       WHERE id_deuda = ?`,
      [nuevoMontoPagado, pagada, pagada, metodoPago, referencia || null, idDeuda]
    )

    await conn.commit()

    registrar(req, 'cobranza', 'pago', {
      idDeuda, monto: montoNum, metodo: metodoPago, pagada: pagada === 1
    })

    res.json({
      ok:            true,
      id_pago:       result.insertId,
      pagada:        pagada === 1,
      saldo_nuevo:   Math.max(0, saldoPendiente - montoNum)
    })
  } catch (e) {
    await conn.rollback().catch(() => {})
    console.error('[pagos] POST /:', e.message)
    res.status(500).json({ ok: false, error: e.message })
  } finally {
    conn.release()
  }
})

module.exports = router
