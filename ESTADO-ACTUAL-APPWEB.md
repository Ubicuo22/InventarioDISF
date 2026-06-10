# Estado Actual — AppWeb Portal Bodega (DISFRULEG)

> Documento de referencia para sincronizar la lógica con Disfruleg Electron.
> Generado: 10/06/2026 — branch `main`, commit `4039b7f`.

---

## 1. Arquitectura general

| Aspecto | Detalle |
|---|---|
| Backend | Express.js (puerto 3030), Node sin framework adicional |
| Frontend | Alpine.js 3 + Tailwind (build local con `npm run build`), SPA en `public/index.html` |
| Bundle | `scripts/bundle-js.js` concatena `public/js/modules/*.js` → `bodega-bundle.<hash>.js` |
| BD | TiDB Cloud MySQL, schema `disfruleg` — **compartida con Disfruleg Electron** |
| Auth | JWT (12h) en localStorage + tabla `bodega_sesiones` (jti, revocables) |
| PWA | manifest + service worker + Web Push (VAPID) |
| Deploy | Mac Mini oficina → Cloudflare Tunnel → `https://disfruleg.ubicuo.icu` |
| Extra | Keep-alive de TiDB cada 3 min; resumen diario push a las 20:00; tabla `logs_actividad` |

### Tablas que la appweb lee/escribe

| Tabla | Uso en la web |
|---|---|
| `producto` | lectura + creación + **UPDATE de `stock`** |
| `inventario_peps` | INSERT de lotes (entradas) + UPDATE `cantidad_restante` (mermas FIFO) |
| `compra` | INSERT (entradas), lectura (historial/resumen) |
| `merma` | INSERT + lectura |
| `ordenes_guardadas` | INSERT/UPDATE (`datos_carrito` JSON con `__historial__`) |
| `cliente`, `grupo` | lectura |
| `precio_por_grupo` | lectura + UPSERT (`precio-rapido`, crear producto) |
| `deudas`, `pago_registrado` | lectura + INSERT pago + UPDATE deuda |
| `factura`, `detalle_factura`, `detalle_venta_lote` | **solo lectura** (analytics) |
| `merma_lote` | INSERT (lotes consumidos por merma, para revertir desde Electron) |
| `producto_conversion_peps` | **solo lectura** (`peps-info` advertencias) |
| `usuarios_sistema`, `permisos_usuario` | lectura + update intentos/último acceso |
| `ubicuoai_learning` | lectura + UPSERT correcciones |
| `bodega_sesiones`, `logs_actividad`, `push_subscriptions` | propias de la web |

---

## 2. Autenticación, roles y permisos

- **Login** (`POST /api/auth/login`): bcrypt contra `usuarios_sistema` (username en MAYÚSCULAS), rate limit 10 intentos/min por IP, respeta `bloqueado_hasta` e incrementa `intentos_fallidos`.
- **Roles**:
  - `admin` → acceso total.
  - `supervisor` → solo módulos listados en `permisos_usuario.modulo_id`; los permisos viajan **dentro del JWT** (`modulosPermitidos`), no se re-leen en cada request.
  - `usuario` → bloqueado en login con mensaje "Eres chalan, revisa tus permisos."
- **Módulos protegibles** (`requireModulo`): `pedidos`, `inventario`, `mermas`, `compras`, `analytics`, `cobranza`.
- **Sesiones**: JWT con `jti`; cada request verifica `bodega_sesiones.activo` (caché 5 min, fail-open si BD cae). Máx ~4 sesiones activas por usuario (al login se desactivan las viejas). Admin puede listar/revocar sesiones desde la web.
- `GET /api/auth/me` re-lee avatar/rol/permisos frescos de BD (sincroniza cambios hechos desde Electron sin relogin).

---

## 3. Entradas de inventario (compras desde bodega)

`POST /api/entradas` — transacción con 3 pasos (replica `compras.handler.js` de Electron v3.7.0+):

1. **INSERT en `compra`** con: `metodo_pago='PUE'`, `forma_pago='03'`, `importe_ieps=0`, `tasa_interes=0`, `peso_por_pieza` (si se capturó peso de lote).
2. **INSERT lote en `inventario_peps`**: `cantidad_inicial = cantidad_restante = cantidad`, `costo_unitario = precio sin IVA`, `factor_conversion = 1 / (pesoLote / cantidad)` si se capturó peso (NULL si no), `fecha_movimiento = fecha_compra`.
3. **Reconciliación de stock**: `producto.stock = SUM(cantidad_restante)` de lotes activos (no aritmética acumulativa).

> **Alineado con Electron 4.1.0**: ya NO se actualiza stock de equivalentes por familia al comprar. Las familias son solo agrupación visual/clave SAT; el stock compartido lo resuelven las conversiones PEPS (`producto_conversion_peps`) al vender.

**IVA**: el precio capturado **ya incluye IVA** si `incluirIva=true` → `precioUnitario = precio/1.16`, `iva = cantidad*precio − subtotal`. Si `incluirIva=false` → iva = 0 (no se suma 16% encima).

Endpoints auxiliares:
- `GET /api/entradas/peps-info/:id` — advierte si el producto es **derivado** de una conversión PEPS (compra incorrecta; debería comprarse el base) y lista los derivados que consumen su stock. Filtra auto-conversiones (`id_producto_derivado != id_producto_base`, Electron 4.2.1).
- `GET /api/entradas/lotes/:id` — lotes PEPS activos en orden FIFO con proveedor/folio.
- `GET /api/entradas/recientes` — últimas 50 compras (excluye sintéticas `PHANTOM:%` y `BOOTSTRAP:%` a ≤$0.01).

Tras guardar: push a todos los dispositivos + log de actividad.

> **Nota importante**: la web **no descuenta stock por ventas** ni procesa facturas — eso es exclusivo de Electron. La web solo agrega stock (entradas), lo resta por mermas, y lee todo lo demás.

---

## 4. Mermas

`POST /api/mermas` — transacción (replica `mermas:registrar` de Electron 4.2.x):

1. Valida tipo (`VENCIMIENTO | DAÑO | ROBO | AJUSTE_INVENTARIO | OTRO`), motivo obligatorio, y **stock virtual** suficiente (propio + cobertura del producto base vía `producto_conversion_peps`, un nivel, con filtro anti auto-conversión) — un derivado con stock propio 0 pero cobertura en el base no se bloquea.
2. INSERT en `merma` con `costo_unitario = 0, costo_total = 0` (simplificado en la web; Electron sí calcula costo).
3. **Consume lotes PEPS FIFO** (`fecha_movimiento ASC`) descontando `cantidad_restante`, y **registra cada lote consumido en `merma_lote`** (`id_merma, id_inventario_peps, cantidad_consumida`) — Electron usa estos registros para revertir/eliminar la merma devolviendo cantidades al lote exacto.
4. **Reconciliación**: `producto.stock = SUM(cantidad_restante)` de lotes activos (FIX I-5 de Electron; ya no resta aritmético).

`GET /api/mermas/recientes` — últimas 30.

---

## 5. Pedidos (órdenes)

Tabla `ordenes_guardadas`, carrito en JSON `datos_carrito` con formato:
```js
{ "NombreSeccion": [ { id_producto, nombre_producto, unidad_producto, cantidad, precio_unitario } ],
  "__historial__": [ { usuario, fecha, cambios[] } | { usuario, fecha, tipoEvento:'revision', totalProductos, faltantes[], pendientes[] } ] }
```
Las claves `__*` son metadatos y se ignoran al calcular totales.

- `GET /api/ordenes?estado=guardada|registrada` — lista con cliente y grupo.
- `POST /api/ordenes`:
  - **Sin folio** → INSERT con `folio_numero = MAX+1`, `estado='guardada'`.
  - **Con folio** → UPDATE solo si `estado='guardada'` (rechaza editar registradas). Calcula **diff carrito viejo vs nuevo** (agregado/eliminado/cantidad/precio, clave `seccion::id_producto`) y lo anexa a `__historial__` — formato compatible con Electron v3.6.8.
  - `total_estimado` = Σ cantidad × precio_unitario (redondeado a 2 decimales).
- **La web nunca cambia `estado` a `registrada`** — el procesamiento (facturación + descuento PEPS) es de Electron.

### Modo Revisión (solo frontend + 1 endpoint)
Portado de Electron v3.6.8, touch-first (swipe, undo 5s, sidebar en tablet):
- El bodeguero recorre cada item del carrito y lo marca: **Revisado**, **Faltante** (se elimina del carrito), o **Pendiente** (queda flagueado).
- Puede editar cantidades y cambiar/buscar producto durante la revisión.
- Al finalizar guarda el carrito modificado vía `POST /api/ordenes` (genera diff en historial) y luego `POST /api/ordenes/:folio/revision` agrega evento `tipoEvento:'revision'` al `__historial__` con faltantes y pendientes.

### UbicuoAI (texto libre → carrito)
Motor propio en `ia/` (parser + matcher Levenshtein + diccionario `ubicuoai_learning`), misma lógica que el handler de Electron:
- `POST /api/ubicuoai/analizar` — texto → secciones con items `{ tipo: perfecto ≥0.90 | incierto 0.70–0.89 | sin_match <0.70 }`, enriquecidos con `precio_base` de `precio_por_grupo`.
- `POST /api/ubicuoai/correccion` — UPSERT en `ubicuoai_learning` (normalización: lowercase, sin acentos). Diccionario: globales (`id_grupo IS NULL`) sobrescritos por entradas del grupo.
- Al confirmar, refuerzo positivo fire-and-forget para inciertos aceptados.
- Flujos auxiliares: cambiar producto (búsqueda), crear producto nuevo inline (`POST /api/productos`), asignar precio rápido (`POST /api/productos/precio-rapido`).

---

## 6. Cobranza (deudas + pagos)

Requiere módulo `cobranza`.

### Deudas (`GET /api/deudas`, `/stats`, `/:id`, `/:id/pagos`)
- Solo deudas con `pagado = 0`.
- **Días de crédito**: `COALESCE(cliente.dias_credito_override, grupo.dias_credito, 0)`.
- **Semáforo** (calculado en SQL con fecha México):
  - `sin_plazo` — días de crédito = 0
  - `vencida` — venció (días restantes < 0)
  - `por_vencer` — ≤ 3 días para vencer
  - `al_dia` — resto
- Orden: vencidas → por vencer → al día, luego días restantes asc, monto desc.
- Historial de pagos excluye `estado_pago = 'REVERSED'`.

### Pagos (`POST /api/pagos`)
Transacción con `SELECT ... FOR UPDATE`:
- Valida: deuda existe y no pagada, monto ≤ saldo + $0.01.
- **Pago parcial** (monto < saldo − $0.01) **requiere `razonParcial`**.
- INSERT en `pago_registrado` con `estado_pago='PROCESSED'`, fecha México.
- UPDATE `deudas`: acumula `monto_pagado`; marca `pagado=1` si `monto_pagado ≥ monto_total − 0.01` (tolerancia de centavo); actualiza `metodo_pago`, `referencia_pago` y `fecha_pago` solo al liquidar.
- Métodos: `efectivo | transferencia | cheque | tarjeta`.
- **La web no puede revertir pagos** (eso es de Electron).

---

## 7. Analytics (solo lectura)

Replica el patrón del handler de analytics de Electron:
- `GET /api/analytics/hoy` — notas, clientes activos, total vendido (`detalle_factura`), ganancia/costo PEPS (`detalle_venta_lote.utilidad_total`), margen %.
- `GET /api/analytics/periodo?fechaInicio&fechaFin` — 3 queries en paralelo (facturas, totales por factura, PEPS por factura), merge en JS, agrupado por día.
- `GET /api/analytics/top-productos` — top 10 por total vendido.
- `GET /api/analytics/notas?fecha` — lista de facturas del día con cliente, grupo, total, ganancia PEPS y margen %.

Fechas siempre en zona `America/Mexico_City` (`utils/fecha.js`).

---

## 8. Historial de compras

`GET /api/compras/resumen?desde&hasta` (default últimos 30 días) — compras agrupadas por día con total gasto, IVA, número de compras, proveedores únicos y desglose por compra. **Excluye compras sintéticas** (Electron 4.2.2): `PHANTOM:%`, `%AJUSTE INVENTARIO%` y `BOOTSTRAP:%` a ≤$0.01 no cuentan en totales ni promedios.

---

## 9. Notificaciones push

- **Suscripción**: `POST /api/notificaciones/suscribir` (JWT opcional; si viene, desactiva suscripciones viejas del mismo usuario).
- **Webhooks que Electron llama** (header `x-notif-secret` = `NOTIF_SECRET`):
  - `/nuevo-pedido`, `/pedido-procesado`, `/stock-entrada`, `/stock-bajo`, `/cotizacion-importada`, `/nueva-version`
- La web también genera push propios: entrada de stock registrada desde la web y **resumen diario automático a las 20:00** (pedidos, compras+gasto, mermas, stock crítico ≤5).
- Stock bajo: si >3 productos en una ventana, se agrupa en una sola notificación.
- Deep-linking: las notificaciones abren el tab correspondiente en la PWA.

---

## 10. Dashboard TV

`GET /api/dashboard/data?token=DASHBOARD_TOKEN` — público con token fijo (sin JWT, para pantalla en bodega). Una sola llamada retorna: ventas del día, pedidos activos (estado `guardada`), entradas de hoy, stock crítico, mermas del día. Página `public/dashboard.html`.

---

## 11. Administración (solo admin)

- `GET /api/admin/sesiones` — sesiones activas (top 5 por usuario + conteo total).
- `DELETE /api/admin/sesiones/:jti` — revoca sesión (invalida caché).
- `GET /api/admin/usuarios` — usuarios + permisos.
- `PUT /api/admin/usuarios/:id/permisos` — edita módulos de un supervisor (nota: el JWT del supervisor conserva los permisos viejos hasta relogin/refresh vía `/me`).

---

## 12. Tabla completa de endpoints

| Método | Ruta | Protección | Descripción |
|---|---|---|---|
| POST | `/api/auth/login` | público + rate limit | Login, devuelve JWT 12h |
| GET | `/api/auth/me` | JWT | Datos frescos de usuario |
| POST | `/api/auth/logout` | JWT | Revoca sesión |
| GET | `/api/status` | público | Health check BD |
| GET | `/api/productos` | JWT | Lista productos activos |
| GET | `/api/productos/resumen` | JWT | Stats de stock (bajo = 0<stock≤5) |
| GET | `/api/productos/buscar?q&groupId` | JWT | Búsqueda con precio del grupo |
| GET | `/api/productos/:id/precios-grupos` | JWT | Precios del producto por grupo |
| POST | `/api/productos` | JWT | Crear producto (+ precio opcional) |
| POST | `/api/productos/precio-rapido` | JWT | UPSERT `precio_por_grupo` |
| GET | `/api/productos/proveedores` | JWT | Lista proveedores |
| GET | `/api/entradas/peps-info/:id` | JWT | Conversiones PEPS (base/derivado) |
| GET | `/api/entradas/lotes/:id` | JWT | Lotes PEPS activos FIFO |
| GET | `/api/entradas/recientes` | JWT + mód. inventario | Últimas 50 compras |
| POST | `/api/entradas` | JWT + mód. inventario | Entrada: compra + lote PEPS + stock |
| POST | `/api/mermas` | JWT + mód. mermas | Merma: FIFO + `merma_lote` + reconciliación |
| GET | `/api/mermas/recientes` | JWT + mód. mermas | Últimas 30 mermas |
| GET | `/api/ordenes?estado` | JWT + mód. pedidos | Lista órdenes |
| GET | `/api/ordenes/:folio` | JWT + mód. pedidos | Detalle de orden |
| POST | `/api/ordenes` | JWT + mód. pedidos | Upsert orden + diff `__historial__` |
| POST | `/api/ordenes/:folio/revision` | JWT + mód. pedidos | Registra evento revisión |
| GET | `/api/clientes/grupos` | JWT | Grupos |
| GET | `/api/clientes?groupId` | JWT | Clientes |
| POST | `/api/ubicuoai/analizar` | JWT | Texto libre → carrito |
| POST | `/api/ubicuoai/correccion` | JWT | UPSERT learning dict |
| GET | `/api/deudas` (+`/stats`, `/:id`, `/:id/pagos`) | JWT + mód. cobranza | Deudas con semáforo |
| POST | `/api/pagos` | JWT + mód. cobranza | Registrar pago total/parcial |
| GET | `/api/compras/resumen` | JWT + mód. compras | Compras agrupadas por día |
| GET | `/api/analytics/hoy` (+`/periodo`, `/top-productos`, `/notas`) | JWT + mód. analytics | Ventas y márgenes PEPS |
| GET | `/api/dashboard/data?token` | token fijo | Dashboard TV |
| POST | `/api/notificaciones/suscribir` | público (JWT opc.) | Registro push |
| POST | `/api/notificaciones/*` (webhooks) | `NOTIF_SECRET` | Avisos desde Electron |
| GET/DELETE/PUT | `/api/admin/*` | JWT + admin | Sesiones y permisos |

---

## 13. Supuestos de lógica compartida con Electron (puntos sensibles a cambios)

Estos son los puntos donde la web **replica o depende de** la lógica de Electron — si Electron cambió alguno, hay que actualizar aquí:

1. **Desglose de IVA en compras** (`precio/1.16`, campos `metodo_pago='PUE'`, `forma_pago='03'`).
2. **Reconciliación `producto.stock = SUM(inventario_peps.cantidad_restante)`** al registrar compra y merma (patrón Electron v3.7.0 / FIX I-5).
3. **Factor de lote**: `factor_conversion = cantidad / pesoLote` (es decir `1/pesoPorPieza`) y `peso_por_pieza` en `compra`.
4. **Familias = solo agrupación visual** (Electron 4.1.0): comprar NO toca stock de equivalentes; el stock compartido es responsabilidad de `producto_conversion_peps` al vender. Las queries de conversiones llevan `id_producto_derivado != id_producto_base` (4.2.1).
5. **Mermas**: consumo FIFO + registro en `merma_lote` + reconciliación de stock; validación contra stock virtual; costo en 0 (la web no calcula costo de merma).
6. **Formato de `datos_carrito`** y del **diff de `__historial__`** (compatible Electron v3.6.8), incluido el evento `tipoEvento:'revision'`. Los items pueden traer **`cantidad_sin_descuento`** (4.2.0, función CEO): la web edita items in-place / con spread, por lo que el campo se preserva al editar órdenes y en Modo Revisión — nunca reconstruir items con campos fijos.
7. **Folio**: `MAX(folio_numero)+1` (riesgo de carrera si ambas apps crean órdenes a la vez).
8. **Estados de orden**: la web solo maneja `guardada`; `registrada` es terminal y no editable desde la web.
9. **Semáforo de deudas** y prioridad `cliente.dias_credito_override > grupo.dias_credito`.
10. **Pagos**: tolerancia ±$0.01, razón obligatoria en parciales, `estado_pago` `PROCESSED`/`REVERSED`.
11. **Analytics**: ganancia = `detalle_venta_lote.utilidad_total`; margen = ganancia/venta.
12. **UbicuoAI**: normalización de texto (lowercase + sin acentos), umbrales 0.90/0.70, dict global+grupo.
13. **Roles y permisos**: tabla `permisos_usuario.modulo_id` con ids `pedidos|inventario|mermas|compras|analytics|cobranza`; rol `usuario` sin acceso web.
14. **Tablas compartidas**: la web asume los schemas actuales de `compra`, `inventario_peps`, `merma`, `deudas`, `pago_registrado`, `ordenes_guardadas`, `precio_por_grupo`, `producto_conversion_peps`, `producto_familia_miembro`, `usuarios_sistema`.

---

*Ubicuo Studio — Portal Bodega — referencia para sincronización con Disfruleg Electron.*
