/**
 * worker.js — Entrada para Cloudflare Workers
 *
 * Corre la misma app Express de app.js sobre el runtime de Workers
 * (nodejs_compat + httpServerHandler). Los archivos estáticos los sirve
 * Workers Assets directamente (ver wrangler.jsonc) — solo /api/* llega aquí.
 *
 * Las tareas programadas (setInterval en server.js) viven aquí como
 * Cron Triggers en el handler `scheduled`.
 */

import { httpServerHandler } from 'cloudflare:node'
import app from './app.js'
import { conContextoDb, q } from './db/pool.js'

const PORT = 3030
app.listen(PORT)

const httpHandler = httpServerHandler({ port: PORT })

export default {
  // Cada request corre con su propio pool de BD (ver db/pool.js)
  fetch(request, env, ctx) {
    return conContextoDb(() => httpHandler.fetch(request, env, ctx))
  },

  async scheduled(controller, env, ctx) {
    // 02:00 UTC = 20:00 en CDMX (CST, UTC-6) → resumen diario
    // 06:00 UTC = limpieza de sesiones expiradas
    const { enviarResumen } = await import('./utils/resumen-diario.js')

    switch (controller.cron) {
      case '0 2 * * *':
        ctx.waitUntil(conContextoDb(() => enviarResumen()))
        break
      case '0 6 * * *':
        ctx.waitUntil(conContextoDb(() => q(
          "DELETE FROM bodega_sesiones WHERE ultimo_uso < DATE_SUB(NOW(), INTERVAL 30 DAY)"
        )))
        break
    }
  },
}
