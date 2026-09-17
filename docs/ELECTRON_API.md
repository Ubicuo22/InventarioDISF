# Cableado Electron ↔ Bodega

Registro de cada endpoint que `disfruleg-bodega` expone bajo `/api/electron/*`,
qué handler de `disfruleg-electron` lo llama, y si ese handler tiene un
fallback local cuando el Worker no responde. Escrito a mano — no se
regenera solo, hay que actualizarlo cuando se toque cualquiera de los dos
lados. Última verificación: 2026-09-17.

## El patrón general

- **`bodegaClient`** (`disfruleg-electron/src/main/handlers/bodega-client.utils.ts`)
  — cliente HTTP genérico hacia el Worker.
- **`callBodega`** (`disfruleg-electron/src/main/handlers/bodega-session.utils.ts`)
  — envoltura consciente de sesión: agrega el `bodegaToken`, y si el Worker
  responde 401, dispara `auth:sessionExpired` hacia la ventana en vez de
  fallar en silencio.
- La mayoría de los canales de **lectura** siguen: intenta `callBodega(...)`
  → si falla y el error no es `NO_WORKER_SESSION` → cae a SQL local
  (`ejecutarQuery`/`obtenerUno`/`transaction` de
  `src/main/database/connection.js`, envueltos por `db.utils.ts`).
- La mayoría de los canales de **escritura** que tocan dinero o inventario
  real (pagos, procesar/revertir venta, altas/bajas de usuario y
  dispositivo) son **fail-closed a propósito** (fase 2 de la migración H-5,
  ver `[[Ubicuo Studio/Clientes/Disfruleg — Migración Backend H-5 (Fases 0-6)]]`
  en el vault) — si el Worker falla, el canal completo falla, sin caer a
  SQL local. Esto es intencional, no un hueco pendiente.

**Convención rota, cuidado al buscar:** todos los grupos usan
`src/main/handlers/<nombre>.handler.ts` con `ipcHandler('canal:accion', ...)`
llamando `callBodega(...)` — excepto **IA**, que vive en
`src/main/ia/inteligencia-negocio.js` (llama `bodegaClient.post` directo,
sin pasar por `callBodega`) con su registro de IPC en
`src/main/handlers/ia.handler.js` (`.js`, no `.ts`).

---

## 1. `auth` (`/api/electron/auth`)

| Endpoint | Caller (Electron) | Canal IPC | Fallback local |
|---|---|---|---|
| `POST /login` | `auth.handler.ts:330` (dentro de `obtenerBodegaToken()`, invocada desde `:476`) | `auth:login` (`:351`) | El login en sí **no depende de esto** — corre entero local con bcrypt + MySQL (`verificarPasswordConLockout`, `:248-318`). La llamada al Worker es un paso secundario fail-*open*: si falla, el login local igual funciona, solo que sin `bodegaToken` (y por tanto sin poder usar los canales fail-closed de abajo). |
| `POST /logout` | `auth.handler.ts:553` | `auth:logout` (`:549`) | `clearSession()` local siempre corre pase lo que pase (`:558`) — el POST al Worker es best-effort dentro de un try/catch. |
| `GET /whoami` | **Sin caller.** Verificado con grep repo-wide de `bodegaClient`/`whoami` — no hay ningún sitio en Electron que llame esta ruta. | — | — |

⚠️ **`auth:whoami`** (el canal IPC, `auth.handler.ts:567`, expuesto como
`checkSession` en `preload.js:33`) es un falso amigo del nombre — es
**100% local**, solo lee `getSession(event)` de la sesión en memoria del
proceso main. No es un proxy de `GET /api/electron/auth/whoami`.

**Confirmado (17 sep 2026): `GET /whoami` es código muerto, pero a propósito.**
El encabezado de `routes/electron/auth.js` explica que todo este archivo es
el mecanismo paralelo de la Fase 0 — Electron llama `/login` solo para
obtener un `bodegaToken` con el que probar los canales ya migrados; la
autenticación real sigue siendo local. `/whoami` encaja como endpoint de
verificación manual (`curl`/Postman: "¿este token decodifica al usuario
correcto?"), nunca pensado para que Electron lo llame en producción — ya
sabe quién es su usuario localmente. Su único otro uso es
`tests/electron-auth.test.js:177`, y ni siquiera prueba algo propio de
`/whoami` — lo usa como ruta protegida genérica para verificar que
`requireAuthElectron` rechaza un token con `aud` (audience) equivocado.
Decisión: se deja como está — inofensivo, sigue sirviendo como herramienta
de depuración manual.

---

## 2. `tipos-cliente` (`/api/electron/tipos-cliente`)

| Endpoint | Caller | Canal IPC | Fallback local |
|---|---|---|---|
| `GET /` | `tipos.cliente.handler.ts:33` | `tiposCliente:obtenerTodos` (`:28`) | Sí — SQL sobre `tipo_cliente`, `:41-45`. |

Tiene además caché en memoria de 5 min (`cacheObtenerTodos`) que envuelve
ambos caminos (Worker y SQL).

---

## 3. `geocoding` (`/api/electron/geocoding`)

| Endpoint | Caller | Canal IPC | Fallback local |
|---|---|---|---|
| `POST /resolver` | `geocoding.handler.ts:51` | `geocoding:resolver` (`:50`) | Sí, pero no es SQL — es una llamada **directa a la API de Google Geocoding** con `GOOGLE_GEOCODING_KEY` local (`resolverLocal()`, `:13-41`, invocada en `:55`). El único fallback de este registro que no es una query. |

---

## 4. `ia` (`/api/electron/ia`)

| Endpoint | Caller | Canal IPC | Fallback local |
|---|---|---|---|
| `POST /chat` | `src/main/ia/inteligencia-negocio.js:653`, dentro de `llamarLLM(mensajes, bodegaToken)` — **no** en `src/main/handlers/`, y **no** usa `callBodega` (llama `bodegaClient.post` directo, con `bodegaToken` pasado como argumento plano). | `ia:chat`, registrado en `src/main/handlers/ia.handler.js:16` (`.js`, no `.ts`) — llama `chatConTools()` (`inteligencia-negocio.js:690`), que a su vez llama `llamarLLM()` dos veces (líneas 699 y 727: la llamada inicial y una vuelta post-tool-call). | Sí, fail-*open* — si el Worker falla, cae a llamar SambaNova/Groq **directo** con llaves locales del `.env` (`llamarConFetch`/`llamarConGroq`, `:606-623`, disparado desde el loop de `:668-688`). |

`bodegaToken` se obtiene de `getSession(event)` dentro de `ia.handler.js:24`.

---

## 5. `usuarios` (`/api/electron/usuarios`)

Todos en `usuarios.handler.ts`.

| Endpoint | Caller | Canal IPC | Fallback local |
|---|---|---|---|
| `GET /` | `:103` | `usuarios:obtenerTodos` (`:99`) | Sí — SQL, `:107-154` |
| `GET /estadisticas` | `:160` | `usuarios:obtenerEstadisticas` (`:159`) | Sí — SQL, `:164-172` |
| `GET /administradores` | `:271` | `usuarios:obtenerAdministradores` (`:267`) | Sí — SQL, `:275-280` |
| `GET /avatar/:username` | `:207` | `usuarios:obtenerAvatar` (`:206`) | Sí — SQL + resolución de URL de R2, `:211-231` |
| `GET /permisos/:idUsuario` | `:287` | `usuarios:obtenerPermisos` (`:283`) | Sí — SQL, `:294-302` (con su propia caché, `getCachedPermisos`) |
| `POST /` | `:178` | `usuarios:crear` (`:177`) | **No** — fail-closed (H-5 fase 2) |
| `PUT /:idUsuario` | `:186` | `usuarios:actualizar` (`:183`) | **No** — fail-closed |
| `DELETE /:idUsuario` | `:194` | `usuarios:eliminar` (`:191`) | **No** — fail-closed |
| `POST /:idUsuario/desbloquear` | `:201` | `usuarios:desbloquear` (`:199`) | **No** — fail-closed |

`usuarios:actualizarAvatar` (canal IPC, `:239`) es 100% local (sube a R2
directo) — no corresponde a ninguno de los 9 endpoints de arriba.

---

## 6. `dispositivos` (`/api/electron/dispositivos`)

Todos en `dispositivos.handler.ts`.

| Endpoint | Caller | Canal IPC | Fallback local |
|---|---|---|---|
| `GET /` | `:46` | `devices:getAll` (`:45`) | Sí — SQL, `:59-69` |
| `GET /logins` | `:73` | `devices:getLastLogins` (`:72`) | Sí — SQL, `:77-87` |
| `GET /stats` | `:91` | `devices:getStats` (`:90`) | Sí — SQL, `:96-106` |
| `POST /:id/authorize` | `:117` | `devices:authorize` (`:116`) | **No** — fail-closed (H-5 fase 2, `:22-35`: el fix real es que bloquear un dispositivo invalida sus sesiones activas del lado del servidor) |
| `POST /:id/block` | `:121` | `devices:block` (`:120`) | **No** — fail-closed |
| `POST /:id/reactivate` | `:125` | `devices:reactivate` (`:124`) | **No** — fail-closed |
| `PUT /:id/notas` | `:129` | `devices:updateNotes` (`:128`) | **No** — fail-closed |
| `DELETE /:id` | `:134` | `devices:delete` (`:132`) | **No** — fail-closed |

---

## 7. `ordenes` (`/api/electron/ordenes`)

Todos en `ordenes.handler.ts` (1652 líneas — el archivo más grande de todos).

| Endpoint | Caller | Canal IPC | Fallback local |
|---|---|---|---|
| `GET /` | `:681` | `ordenes:obtenerTodas` (`:680`) | Sí — SQL, `:684` |
| `GET /activas` | `:688` | `ordenes:obtenerActivas` (`:687`) | Sí — SQL, `:691` |
| `GET /historial` | `:695` | `ordenes:obtenerHistorial` (`:694`) | Sí — SQL, `:698` |
| `GET /folio/:folio` | `:702` | `ordenes:obtenerPorFolio` (`:701`) | Sí — `obtenerUno`, `:705` |
| `GET /siguiente-folio` | `:709` | `ordenes:obtenerSiguienteFolio` (`:708`) | Sí — calculado local escaneando huecos, `:712-717` |
| `GET /cliente/:idCliente` | `:1173` | `ordenes:obtenerPorCliente` (`:1172`) | Sí — SQL, `:1176-1181` |
| `GET /estadisticas` | `:1185` | `ordenes:estadisticas` (`:1184`) | Sí — SQL, `:1188-1198` |
| `GET /notas-cliente-hoy/:idCliente` | `:859` | `ordenes:notasClienteHoy` (`:856`) | Sí — SQL con aritmética de fecha en zona MX local, `:887-910` |
| `GET /reservas/:idProducto` | `:1574` | `ordenes:reservasProducto` (`:1573`) | Sí — SQL sobre `reserva_inventario`, `:1588+` |
| `POST /validar-stock` | `:1090` | `ordenes:validarStock` (`:1087`) | Sí — `validarStockCarrito()` local, `:1094-1110` |
| `GET /lock/:folio` | `:1002` | `ordenes:checkLock` (`:1001`) | Sí — lectura SQL de `editing_by`/`editing_at`, `:1006-1017` |
| `POST /lock/:folio` | `:1021` | `ordenes:acquireLock` (`:1020`) | Sí — `UPDATE` atómico, `:1027-1061` |
| `DELETE /lock/:folio` | `:1064` | `ordenes:releaseLock` (`:1063`) | Sí — `UPDATE` limpiando campos de lock, `:1067-1070` |
| `PUT /lock/:folio` | `:1074` | `ordenes:renewLock` (`:1073`) | Sí — `UPDATE editing_at`, `:1077-1080` |
| `PUT /estado/:folio` | `:953` | `ordenes:cambiarEstado` (`:952`) | **No** — fail-closed |
| `POST /revision/:folio` | `:921` | `ordenes:registrarRevision` (`:914`) | **No** — fail-closed |
| `PUT /enviado/:folio` | `:976` | `ordenes:marcarEnviado` (`:975`) | **No** — fail-closed |
| `POST /notas-ceo/:folio` | `:984` | `ordenes:guardarNotaCeo` (`:983`) | **No** — fail-closed |
| `POST /notas-ceo/:folio/vista` | `:988` | `ordenes:registrarVistaCeo` (`:987`) | **No** — fail-closed |
| `DELETE /notas-ceo/:folio/:index` | `:992` | `ordenes:eliminarNotaCeo` (`:991`) | **No** — fail-closed |
| `POST /procesar-venta/:folio` | `:1121-1129` | `ordenes:procesarVenta` (`:1117`) | **No** — fail-closed. Al éxito, dispara `analytics:datosActualizados`/`dashboard:invalidar` a todas las ventanas (`:1132-1136`). |
| `POST /revertir-procesamiento/:folio` | `:1151-1155` | `ordenes:revertirProcesamiento` (`:1146`) | **No** — fail-closed. Mismo broadcast al éxito (`:1157-1163`). |

`ordenes:crear`, `ordenes:guardar`, `ordenes:actualizar` y
`ordenes:eliminar` son canales **100% locales** (SQL transaccional sobre
`ordenes_guardadas` + consumo PEPS) — no existe `POST /`, `PUT /:folio` ni
`DELETE /:folio` en el Worker, así que no busques un endpoint que no está
pensado para existir.

---

## 8. `pagos` (`/api/electron/pagos`)

Ambos en `pagos.handler.ts`.

| Endpoint | Caller | Canal IPC | Fallback local |
|---|---|---|---|
| `POST /registrar` | `:83-87` | `pagos:registrar` (`:58`) | **No** — fail-closed. Verifica `getSession(event)?.bodegaToken` (`:65`) y responde `noWorkerSession()` (`:52-54`) **antes** de siquiera subir el comprobante a R2. |
| `POST /registrar-por-cliente` | `:378-386` | `pagos:registrarPorCliente` (`:343`) | **No** — fail-closed, mismo guard en `:361`. |

Ambos suben el comprobante a R2 **antes** de llamar al Worker
(`r2Service.subirComprobantePago`), y lo borran si el Worker rechaza la
llamada (`:89-95`, `:388-393`) — es un patrón de escritura en dos fases, no
un fallback.

`pagos:revertir`, `pagos:obtenerHistorial`, `pagos:obtenerPorDeuda`,
`pagos:obtenerPorDeudaConComprobantes`, `pagos:obtenerComprobante`,
`pagos:eliminarComprobante`, `pagos:obtenerEstadisticasPorPeriodo` y
`pagos:abonoDirecto` son canales IPC 100% locales, sin endpoint del Worker
correspondiente en esta lista de 2.

---

## Gotchas conocidos (no obvios leyendo un solo lado)

**Formato de fecha inconsistente según qué camino tomó la llamada.**
`db/pool.js` (bodega) no tiene `dateStrings` configurado — un campo
DATE/DATETIME que pasa por el Worker llega a Electron como ISO completo
(`"...T...Z"`, objeto `Date` de mysql2 serializado por `JSON.stringify`).
`src/main/database/connection.js` (Electron) sí tiene `dateStrings: true` —
el mismo campo, cuando la llamada cae al fallback local, llega como string
crudo de MySQL (`"YYYY-MM-DD HH:MM:SS"`, sin zona). Un mismo canal IPC
(p.ej. `ordenes:obtenerPorFolio`) puede devolver dos formatos distintos del
mismo campo según cuál de los dos caminos haya tomado esa llamada en
particular — no depende de qué endpoint sea, sino de si el Worker respondió
a tiempo. Usar siempre `parseUTC()` (`src/renderer/utils/dates.ts`) al leer
un campo de fecha que venga de cualquiera de estos dos caminos, nunca
`new Date(campo)` directo. Ver `[[Bitácora/2026-09-17]]` para el detalle
completo de esta investigación y los 6 sitios que se corrigieron por esto.

**Fail-closed es intencional, no un hueco.** Si ves un canal sin fallback
local y te preguntas si falta implementarlo — probablemente no. Es la fase
2 de H-5: mover el punto de verdad de permisos/dinero/inventario al Worker
para que no se pueda forjar localmente. Ver
`[[Ubicuo Studio/Clientes/Disfruleg — Migración Backend H-5 (Fases 0-6)]]`.

**`ia.js` no sigue la convención del resto.** Si agregas un canal de IA
nuevo, no repitas el patrón de `callBodega` de los otros 7 grupos —
`inteligencia-negocio.js` ya tiene su propio mecanismo de fallback
(SambaNova/Groq directo) que asume que `llamarLLM` recibe el
`bodegaToken` como argumento, no que lo resuelve él mismo.

## Pendiente

- [x] ~~Confirmar si `GET /api/electron/auth/whoami` tiene algún consumidor real~~ — confirmado 17 sep: es código muerto a propósito (utilidad de depuración de la Fase 0), se deja como está. Ver nota en la sección 1.
- [ ] Este doc es manual — no hay nada que lo mantenga sincronizado. Revisar
  cuando se agregue/quite un endpoint en `routes/electron/*.js` o un
  handler correspondiente en `disfruleg-electron/src/main/handlers/`.
