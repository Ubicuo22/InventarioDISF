/**
 * shims/extract-zip — reemplazo sin implementación de extract-zip.
 *
 * extract-zip@<=2.0.1 (la última publicada, sin mantenimiento) tiene dos
 * vulnerabilidades altas (GHSA-jmr9-qjv8-65gv, GHSA-7pqw-9j4j-h8q3: escritura
 * de archivos arbitrarios vía symlinks en el ZIP). Solo llega aquí como
 * dependencia de @cloudflare/puppeteer → @puppeteer/browsers, que la usa para
 * descomprimir un Chrome descargado en una máquina local. En el Worker nunca
 * se usa: Browser Rendering da el navegador por el binding BROWSER.
 *
 * Se sustituye con package.json "overrides". Si algo la llegara a invocar,
 * falla explícitamente en vez de descomprimir nada.
 */
module.exports = async function extractZip () {
  throw new Error('extract-zip está deshabilitado en disfruleg-bodega (ver shims/extract-zip/index.js)')
}
