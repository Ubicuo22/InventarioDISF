/**
 * utils/tickets-r2.js — Bucket privado de tickets (binding R2_TICKETS)
 *
 * Separado del bucket de avatares a propósito: ese es público
 * (R2_PUBLIC_URL) y los tickets traen precios de proveedores. Aquí nada
 * tiene URL pública; se sirven solo por endpoint con sesión.
 *
 * El binding solo existe en Workers. En la Mac Mini (server.js) no hay
 * bucket: `disponible()` da false y las rutas responden 503 en vez de
 * aceptar un archivo que no pueden guardar.
 */

const esWorkers = globalThis.navigator?.userAgent === 'Cloudflare-Workers'

async function bucket() {
  if (!esWorkers) return null
  const { env } = await import('cloudflare:workers')
  return env.R2_TICKETS ?? null
}

async function disponible() {
  return !!(await bucket())
}

async function guardar(key, buf, tipo) {
  const b = await bucket()
  if (!b) throw new Error('Bucket de tickets no disponible')
  await b.put(key, buf, { httpMetadata: { contentType: tipo } })
}

/**
 * Devuelve el archivo completo como Buffer, o null si no existe. Se lee
 * entero en vez de hacer stream: son ≤ 15 MB y así `res.send()` de Express
 * funciona igual en Workers que en Node, sin puentear ReadableStream web.
 */
async function leer(key) {
  const b = await bucket()
  if (!b) throw new Error('Bucket de tickets no disponible')
  const obj = await b.get(key)
  return obj ? Buffer.from(await obj.arrayBuffer()) : null
}

async function borrar(keys) {
  const b = await bucket()
  if (!b || !keys.length) return
  await b.delete(keys)
}

module.exports = { disponible, guardar, leer, borrar }
