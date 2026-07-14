/**
 * Shim de iconv-lite para Cloudflare Workers (ver alias en wrangler.jsonc).
 *
 * El iconv-lite real no bundlea bien en workerd (su carga condicional de
 * node:stream rompe). La app solo recibe JSON UTF-8, así que basta cubrir
 * la superficie que raw-body/body-parser usan: encodingExists, decode y
 * getDecoder, delegando en Buffer.
 */

// cesu8: mysql2 lo usa para columnas utf8mb3. CESU-8 solo difiere de UTF-8
// en caracteres fuera del BMP (emojis raros); para texto es-MX es equivalente.
const UTF8_ALIASES = new Set(['utf8', 'utf-8', 'cesu8', 'cesu-8', 'ascii', 'latin1', 'iso-8859-1', 'binary'])

function normalizar(enc) {
  return String(enc || 'utf-8').toLowerCase()
}

function encodingExists(enc) {
  return UTF8_ALIASES.has(normalizar(enc))
}

function aBufferEncoding(e) {
  if (e === 'utf-8' || e === 'cesu8' || e === 'cesu-8') return 'utf8'
  if (e === 'iso-8859-1') return 'latin1'
  return e
}

function decode(buf, enc) {
  return Buffer.from(buf).toString(aBufferEncoding(normalizar(enc)))
}

function encode(str, enc) {
  return Buffer.from(String(str), aBufferEncoding(normalizar(enc)))
}

function getDecoder(enc) {
  const encoding = aBufferEncoding(normalizar(enc))
  let pendiente = Buffer.alloc(0)
  return {
    write(buf) {
      // Acumular por si un carácter multibyte quedó partido entre chunks
      pendiente = Buffer.concat([pendiente, buf])
      const str = pendiente.toString(encoding)
      pendiente = Buffer.alloc(0)
      return str
    },
    end() {
      return pendiente.length ? pendiente.toString(encoding) : ''
    },
  }
}

module.exports = { encodingExists, decode, encode, getDecoder }
