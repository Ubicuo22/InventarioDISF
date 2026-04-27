/**
 * utils/avatar.js — helpers para resolver avatares de usuarios.
 *
 * Disfruleg Electron y esta webapp comparten la tabla `usuarios_sistema` en
 * TiDB. Las columnas reales son `avatar_color` (hex) y `avatar_r2_key` (path
 * dentro del bucket público de Cloudflare R2). Antes este código intentaba
 * leer una columna `avatar_url_publica` que no existe — por eso ningún
 * avatar de imagen se mostraba y todo caía al fallback de la inicial con
 * fondo de color.
 *
 * Las dos funciones aquí se usan así:
 *   - SELECT debe pedir `avatar_r2_key` (no `avatar_url_publica`)
 *   - Antes de mandar al cliente, llamar resolverAvatar(usuario) o
 *     resolverAvatares(usuarios) para inyectar `avatar_url_publica`.
 */

const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || 'https://pub-80eceb450a664b75be4eed5049fb2ba7.r2.dev')
  .replace(/\/+$/, '') // sin slash final

/**
 * Convierte un avatar_r2_key (ej. "avatares/u3-1234567890.jpg") en URL pública.
 * Devuelve null si no hay key.
 */
function urlPublicaDeKey(r2_key) {
  if (!r2_key) return null
  // Si ya es una URL absoluta (caso edge donde algún proceso guardó la URL en
  // lugar de la key), regrésala tal cual.
  if (/^https?:\/\//i.test(r2_key)) return r2_key
  return `${R2_PUBLIC_URL}/${r2_key.replace(/^\/+/, '')}`
}

/**
 * Mutación in-place: añade `avatar_url_publica` al objeto usuario y elimina
 * `avatar_r2_key` (no la queremos exponer al cliente, no aporta nada extra).
 */
function resolverAvatar(usuario) {
  if (!usuario) return usuario
  usuario.avatar_url_publica = urlPublicaDeKey(usuario.avatar_r2_key)
  delete usuario.avatar_r2_key
  return usuario
}

/**
 * Igual que resolverAvatar pero para arrays. Devuelve el mismo array
 * (útil para chaining después de un await).
 */
function resolverAvatares(usuarios) {
  if (!Array.isArray(usuarios)) return usuarios
  for (const u of usuarios) resolverAvatar(u)
  return usuarios
}

module.exports = { urlPublicaDeKey, resolverAvatar, resolverAvatares, R2_PUBLIC_URL }
