/**
 * routes/electron/pagos.js — Pagos de Disfruleg Electron
 * (H-5 Fase 3 — ver plan de migración)
 *
 * `pagos:registrar` y `pagos:registrarPorCliente` no tenían NINGÚN check de
 * rol en Electron — cualquier renderer podía escribir un pago sin pasar por
 * nada. Decisión de negocio del usuario (9 sep 2026): solo admin/supervisor/
 * ceo pueden registrar pagos, cajero queda fuera. Sin respaldo local
 * (fail-closed) — mismo criterio que usuarios/dispositivos (Fase 2) y las
 * escrituras de notas CEO (Fase 4 B3).
 *
 * Los comprobantes llegan YA subidos a R2 — Electron conserva las
 * credenciales de R2 hasta la Fase 6, así que este endpoint solo persiste
 * los metadatos (r2_key/r2_url/nombre/tipo/tamaño), nunca recibe el archivo.
 *
 * La identidad para `usuario_registro` sale del JWT (req.user.nombre ||
 * username), nunca del body — mismo criterio que el resto de H-5.
 */

const router = require('express').Router()
const { pool } = require('../../db/pool')
const { requireRoleElectron } = require('../../middleware/auth-electron')

const PAGOS_ROLES = requireRoleElectron(['admin', 'supervisor', 'ceo'])

function identidad(req) {
  return req.user.nombre || req.user.username
}

async function insertarComprobantes(conn, idPago, comprobantes) {
  for (const archivo of comprobantes) {
    await conn.execute(
      `INSERT INTO pago_adjuntos
       (id_pago, nombre_archivo, tipo_archivo, r2_key, r2_url, tamano, fecha_subida)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [idPago, archivo.nombre_archivo, archivo.tipo_archivo, archivo.r2_key, archivo.r2_url, archivo.tamano]
    )
  }
}

// ─── POST /registrar ────────────────────────────────────────────
router.post('/registrar', PAGOS_ROLES, async (req, res) => {
  const {
    idDeuda, monto, metodoPago, referencia, notas,
    comentario, razon_pago_parcial, comprobantes = []
  } = req.body

  if (!idDeuda) return res.status(400).json({ ok: false, error: 'idDeuda es requerido' })
  if (!(monto > 0)) return res.status(400).json({ ok: false, error: 'El monto debe ser mayor a $0' })

  const usuario = identidad(req)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [result] = await conn.execute(
      `INSERT INTO pago_registrado
       (id_deuda, monto_pagado, fecha_pago, metodo_pago, referencia_pago, notas, comentario, razon_pago_parcial, usuario_registro)
       VALUES (?, ?, NOW(), ?, ?, ?, ?, ?, ?)`,
      [idDeuda, monto, metodoPago, referencia || null, notas || null, comentario || null, razon_pago_parcial || null, usuario]
    )
    const idPago = result.insertId

    await insertarComprobantes(conn, idPago, comprobantes)

    await conn.execute(
      `UPDATE deudas
       SET monto_pagado = monto_pagado + ?,
           pagado = CASE WHEN (monto_pagado + ?) >= monto_total THEN 1 ELSE 0 END,
           fecha_pago = CASE WHEN (monto_pagado + ?) >= monto_total THEN NOW() ELSE fecha_pago END,
           metodo_pago = ?,
           referencia_pago = ?
       WHERE id_deuda = ?`,
      [monto, monto, monto, metodoPago, referencia || null, idDeuda]
    )

    // Detectar sobrepago → generar saldo a favor
    let credito_generado = null
    const [deudaRows] = await conn.execute(
      'SELECT id_cliente, monto_pagado, monto_total FROM deudas WHERE id_deuda = ?',
      [idDeuda]
    )

    if (deudaRows.length > 0) {
      const deuda = deudaRows[0]
      const montoPagado = parseFloat(deuda.monto_pagado)
      const montoTotal = parseFloat(deuda.monto_total)

      if (montoPagado > montoTotal) {
        const excedente = +(montoPagado - montoTotal).toFixed(2)

        await conn.execute('UPDATE deudas SET monto_pagado = monto_total WHERE id_deuda = ?', [idDeuda])

        const [creditoResult] = await conn.execute(
          `INSERT INTO credito_cliente
           (id_cliente, monto_total, monto_usado, fecha_creacion, origen, id_deuda_origen, id_pago_origen, estado, notas)
           VALUES (?, ?, 0, NOW(), 'OVERPAYMENT', ?, ?, 'ACTIVO', ?)`,
          [deuda.id_cliente, excedente, idDeuda, idPago, `Excedente de pago #${idPago}`]
        )
        credito_generado = { monto: excedente, id_credito: creditoResult.insertId }
      }
    }

    await conn.commit()
    res.json({ ok: true, data: { id_pago: idPago, credito_generado } })
  } catch (e) {
    await conn.rollback()
    console.error('[pagos] registrar:', e.message)
    res.status(500).json({ ok: false, error: 'Error al registrar el pago' })
  } finally {
    conn.release()
  }
})

// ─── POST /registrar-por-cliente ────────────────────────────────
// Distribución automática de un monto entre varias notas del mismo cliente,
// en una sola transacción — espejo de pagos:registrarPorCliente.
router.post('/registrar-por-cliente', PAGOS_ROLES, async (req, res) => {
  const {
    idCliente, montoTotal, deudasSeleccionadas = [],
    metodoPago, referencia, notas, comprobantes = []
  } = req.body

  if (!idCliente) return res.status(400).json({ ok: false, error: 'idCliente es requerido' })
  if (!deudasSeleccionadas.length) return res.status(400).json({ ok: false, error: 'Debe seleccionar al menos una nota' })
  if (!(montoTotal > 0)) return res.status(400).json({ ok: false, error: 'El monto debe ser mayor a $0' })

  const usuario = identidad(req)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const placeholders = deudasSeleccionadas.map(() => '?').join(',')
    const [deudaRows] = await conn.execute(
      `SELECT id_deuda, monto_total, monto_pagado, (monto_total - monto_pagado) as saldo_pendiente
       FROM deudas
       WHERE id_deuda IN (${placeholders}) AND id_cliente = ? AND pagado = 0`,
      [...deudasSeleccionadas, idCliente]
    )

    if (deudaRows.length === 0) {
      await conn.rollback()
      return res.json({ ok: false, error: 'No se encontraron notas pendientes válidas para este cliente' })
    }

    const deudaMap = new Map(deudaRows.map(d => [d.id_deuda, d]))
    const deudasOrdenadas = deudasSeleccionadas.map(id => deudaMap.get(id)).filter(Boolean)

    let montoRestante = montoTotal
    const pagosCreados = []

    for (const deuda of deudasOrdenadas) {
      if (montoRestante <= 0) break
      const saldo = parseFloat(deuda.saldo_pendiente)
      if (saldo <= 0) continue

      const montoParaEsta = Math.min(montoRestante, saldo)
      const liquidada = montoParaEsta >= saldo

      const [result] = await conn.execute(
        `INSERT INTO pago_registrado
         (id_deuda, monto_pagado, fecha_pago, metodo_pago, referencia_pago, notas, usuario_registro)
         VALUES (?, ?, NOW(), ?, ?, ?, ?)`,
        [deuda.id_deuda, +montoParaEsta.toFixed(2), metodoPago, referencia || null, notas || null, usuario]
      )

      await conn.execute(
        `UPDATE deudas
         SET monto_pagado = monto_pagado + ?,
             pagado = CASE WHEN (monto_pagado + ?) >= monto_total THEN 1 ELSE 0 END,
             fecha_pago = CASE WHEN (monto_pagado + ?) >= monto_total THEN NOW() ELSE fecha_pago END,
             metodo_pago = ?,
             referencia_pago = ?
         WHERE id_deuda = ?`,
        [montoParaEsta, montoParaEsta, montoParaEsta, metodoPago, referencia || null, deuda.id_deuda]
      )

      pagosCreados.push({ id_pago: result.insertId, id_deuda: deuda.id_deuda, monto: +montoParaEsta.toFixed(2), liquidada })
      montoRestante = +(montoRestante - montoParaEsta).toFixed(2)
    }

    for (const pago of pagosCreados) {
      await insertarComprobantes(conn, pago.id_pago, comprobantes)
    }

    let credito_generado = null
    if (montoRestante > 0) {
      const primerPagoId = pagosCreados[0]?.id_pago ?? null
      const [creditoResult] = await conn.execute(
        `INSERT INTO credito_cliente
         (id_cliente, monto_total, monto_usado, fecha_creacion, origen, id_pago_origen, estado, notas)
         VALUES (?, ?, 0, NOW(), 'OVERPAYMENT', ?, 'ACTIVO', ?)`,
        [idCliente, montoRestante, primerPagoId, `Excedente de pago global (${pagosCreados.length} notas)`]
      )
      credito_generado = { monto: montoRestante, id_credito: creditoResult.insertId }
    }

    await conn.commit()
    res.json({
      ok: true,
      data: {
        pagos: pagosCreados,
        total_distribuido: +(montoTotal - montoRestante).toFixed(2),
        credito_generado
      }
    })
  } catch (e) {
    await conn.rollback()
    console.error('[pagos] registrarPorCliente:', e.message)
    res.status(500).json({ ok: false, error: 'Error al registrar el pago' })
  } finally {
    conn.release()
  }
})

module.exports = router
