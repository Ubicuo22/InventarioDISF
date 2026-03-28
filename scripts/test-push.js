#!/usr/bin/env node
/**
 * Diagnóstico de push notifications
 * Corre: node scripts/test-push.js
 */

try { require('dotenv').config() } catch (_) {}

const webpush = require('web-push')
const mysql   = require('mysql2/promise')

async function main() {
  console.log('\n📋 Diagnóstico Push Notifications\n')

  // 1. Verificar variables de entorno
  const vars = ['VAPID_EMAIL', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'TIDB_HOST', 'TIDB_USER']
  let ok = true
  for (const v of vars) {
    const val = process.env[v]
    if (!val) { console.log(`  ❌ Falta: ${v}`); ok = false }
    else       { console.log(`  ✅ ${v}: ${val.substring(0, 30)}...`) }
  }
  if (!ok) { console.log('\n❌ Faltan variables de entorno'); process.exit(1) }

  // 2. Conectar a BD
  console.log('\n🔌 Conectando a TiDB...')
  const conn = await mysql.createConnection({
    host:     process.env.TIDB_HOST,
    port:     parseInt(process.env.TIDB_PORT || '4000'),
    user:     process.env.TIDB_USER,
    password: process.env.TIDB_PASSWORD,
    database: process.env.TIDB_DATABASE,
    ssl:      { rejectUnauthorized: false }
  })
  console.log('  ✅ Conectado')

  // 3. Ver suscripciones
  const [rows] = await conn.execute(
    'SELECT id, LEFT(endpoint, 80) as endpoint_short, LENGTH(p256dh) as p256dh_len, LENGTH(auth) as auth_len, activo, fecha_creacion FROM push_subscriptions ORDER BY fecha_creacion DESC'
  )

  console.log(`\n📱 Suscripciones en DB: ${rows.length} total`)
  if (rows.length === 0) {
    console.log('  ⚠️  No hay suscripciones guardadas.')
    console.log('  → El iPhone nunca completó la suscripción o falló al guardar.')
    await conn.end()
    return
  }

  for (const r of rows) {
    console.log(`\n  ID: ${r.id} | activo: ${r.activo} | creada: ${r.created_at}`)
    console.log(`  endpoint: ${r.endpoint_short}...`)
    console.log(`  p256dh len: ${r.p256dh_len} (esperado: 87)`)
    console.log(`  auth len: ${r.auth_len} (esperado: 24)`)
  }

  // 4. Intentar enviar test push a todas las suscripciones activas
  const [activeSubs] = await conn.execute(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE activo = 1'
  )
  await conn.end()

  if (activeSubs.length === 0) {
    console.log('\n⚠️  No hay suscripciones activas (activo=1)')
    return
  }

  console.log(`\n🚀 Enviando test push a ${activeSubs.length} suscripción(es)...`)

  webpush.setVapidDetails(
    process.env.VAPID_EMAIL,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  )

  for (const sub of activeSubs) {
    const subscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth }
    }
    try {
      await webpush.sendNotification(subscription, JSON.stringify({
        title: '🧪 Test de notificación',
        body:  'Si ves esto, ¡las push funcionan! 🎉',
        icon:  '/assets/icon.png'
      }))
      console.log(`  ✅ Push enviado a sub ${sub.id}`)
    } catch (err) {
      console.log(`  ❌ Error en sub ${sub.id}: [${err.statusCode}] ${err.message}`)
      if (err.body) console.log(`     Detalle: ${err.body}`)
    }
  }

  console.log('\n✅ Diagnóstico completado\n')
}

main().catch(err => {
  console.error('\n❌ Error fatal:', err.message)
  process.exit(1)
})
