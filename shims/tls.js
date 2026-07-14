/**
 * Shim de node:tls para Cloudflare Workers (ver alias en wrangler.jsonc).
 *
 * workerd implementa tls.connect pero rechaza la opción checkServerIdentity,
 * que mysql2 pasa siempre. La quitamos: workerd valida certificado y hostname
 * (via servername) por su cuenta durante el handshake TLS.
 */

const tls = require('node:tls')

module.exports = {
  ...tls,
  connect(options, callback) {
    if (options && typeof options === 'object' && 'checkServerIdentity' in options) {
      const { checkServerIdentity, ...resto } = options
      return tls.connect(resto, callback)
    }
    return tls.connect(options, callback)
  },
  // mysql2 la invoca tras el handshake cuando verifyIdentity=true; con
  // verifyIdentity=false (nuestro caso) no se llama, pero por si acaso:
  checkServerIdentity: tls.checkServerIdentity || (() => undefined),
}
