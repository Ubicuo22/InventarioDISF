# Auditoría de reconciliación PEPS — H-5 Fase 4

> Parte A del plan de Fase 4 (órdenes/precios/compras → Worker). Objetivo: antes de decidir cómo compartir la lógica PEPS entre `disfruleg-electron` y `disfruleg-bodega`, confirmar si las dos implementaciones ya calculan distinto hoy.
> Fecha: 2026-09-09.

## Resumen ejecutivo

El motor FIFO/PEPS existe en **dos implementaciones independientes, no una**:
- `disfruleg-electron`: `peps-engine.ts` (puro, TS) + `orden-consumo.ts` (transaccional) — cubre consumo al vender/guardar una orden.
- `disfruleg-bodega`: `routes/entradas.js` (creación de lotes al comprar) + `routes/mermas.js` (consumo FIFO por merma), en JS plano — porteadas a mano en algún punto ("mismo criterio que electron vX.Y.Z" en comentarios), sin módulo compartido.

Se encontró **un bug real y confirmado** (no solo divergencia teórica) en `mermas.js`, ya corregido como parte de este trabajo — ver Hallazgo #1. El resto de los escenarios comparados son consistentes o son divergencias de alcance intencional (mermas nunca tuvo concepto de "phantom"/backorder).

**Recomendación para la decisión workspace-vs-hand-port:** el patrón de porteo a mano ya establecido en el repo (`entradas.js`/`mermas.js`) es viable siempre que cada porteo pase por una comparación explícita como esta, no solo "traducir y confiar". El bug del Hallazgo #1 muestra que porteado a mano sin verificación cruzada, si diverge en silencio. No se encontró evidencia de que un workspace npm real fuera a prevenir este bug en particular (el bug no era un desfase de versión, era una omisión al traducir de TS a JS) — pero si Fase 4 termina necesitando portear el motor de consumo *al momento de vender* (que hoy no existe en el Worker en absoluto), ese es un porteo mucho más grande y ahí sí conviene reconsiderar workspace real en vez de repetir el patrón de traducción manual.

---

## Hallazgo #1 — Bug real, confirmado y ya corregido (incluyendo cadenas multi-hop)

**Archivo:** `disfruleg-bodega/routes/mermas.js`
**Síntoma:** una merma sobre un producto derivado (ej. "caja") con 0 lotes propios en `inventario_peps`, cuya validación de stock pasa por cobertura virtual del producto base (ej. "pieza", vía `producto_conversion_peps`), se **registraba en la tabla `merma` sin ningún efecto real en inventario** — ni el derivado ni el base se descontaban. Si el stock propio era positivo pero insuficiente, el sobrante (`pendiente`) se descartaba silenciosamente tras el loop.

**Causa:** la validación de stock (`stock_virtual = pb.stock/factor + p.stock`) sí cruza la frontera de equivalencia; el consumo real (el loop FIFO sobre `inventario_peps`) nunca lo hacía — solo consultaba y descontaba lotes de `id_producto = ?` (el propio), nunca del base.

**Fix aplicado (dos vueltas):**
1. Tras agotar los lotes propios, si queda `pendiente > 0` y existe conversión a un producto base, se consume `pendiente × factor` del base en FIFO.
2. **Extendido a cadenas completas** tras confirmar contra producción que el caso no es solo teórico (ver Hallazgo #3): se agregó `resolverCadenaGlobal()`, que compone factores a través de múltiples saltos (A→B→C, hasta 10 niveles con guardia anti-ciclo) igual que `resolverCadenas` en `peps-engine.ts` del lado Electron — la validación de stock virtual y el consumo real ahora usan la **base final de la cadena completa**, no solo el primer salto.

Reconciliación final de `producto.stock` corre tanto para el producto propio como para la base final afectada. Cubierto por 9 pruebas en `tests/mermas.test.js`: validaciones, consumo propio sin cruzar equivalencia, cruce de un salto (0 stock propio y stock parcial), y cruce de **dos saltos** (cadena caja→docena→pieza con factor acumulado 144).

**Nota:** no se cuantificó contra datos reales cuántas mermas *con cadena multi-hop específicamente* quedaron con efecto nulo antes de esta segunda vuelta del fix — la query del Hallazgo #3 (mermas con déficit de consumo, cualquier causa) dio 0 resultados, así que el impacto histórico combinado (1 salto + multi-hop) es cero.

---

## Matriz de escenarios comparados

| # | Escenario | TS (Electron) | JS (Worker) | Veredicto |
|---|---|---|---|---|
| 1 | Merma sobre derivado con stock propio 0, cobertura por base | N/A directo (mermas no existe en Electron como IPC separado de este flujo) | **Bug confirmado y corregido** — ver Hallazgo #1 | 🔴→✅ Corregido |
| 2 | Lote completamente consumido por merma (restante→0) | `consumirDeFuentes` (orden-consumo) redondea a 0 exacto bajo 0.0001 | `mermas.js` resta aritméticamente sin redondeo especial ni tocar `activo` | Divergencia menor — un lote puede quedar con restante epsilon (ej. 0.00003) marcado `activo=1`; reaparecería en un futuro `ORDER BY ... WHERE cantidad_restante > 0` pero con cantidad tan pequeña que es inconsecuente en la práctica. No se considera bug bloqueante — anotado para revisión futura, no se tocó en este fix. |
| 3 | Cadena de conversión multi-hop (A→B→C) | `resolverCadenas` compone hasta 10 saltos | `mermas.js` **ya resuelve cadenas completas** tras el fix de esta auditoría (`resolverCadenaGlobal`) | 🔴→✅ **Confirmado como real, no teórico** (ver Hallazgo #3) y corregido en `mermas.js`. **`entradas.js` sigue sin resolverlo** — no se tocó en este trabajo porque está fuera del alcance de Fase 4 (compras/entradas no son parte del tramo de Ordenes), pero queda como hallazgo pendiente para cuando se trabaje `compras`/`entradas`. |
| 4 | Reconciliación de compra "phantom" (venta sin stock cubierta después por una compra real) | **Corrección a lo asumido inicialmente**: el mecanismo `PHANTOM:GUARDADAS` en `ordenes.handler.ts` (línea ~1677) es exclusivo del *bootstrap histórico* (`esPreInventario`, folio ≤ 337) — no es el flujo de venta-sin-stock corriente. `forzarSinStock = true` está **hardcodeado** (línea 1435): las ventas normales post-337 nunca bloquean por falta de stock, pero tampoco crean ningún marcador `PHANTOM:REGISTRADAS` — ese marcador aparece en comentarios de `entradas.js` pero **no existe ningún código en Electron que lo genere hoy**. | `entradas.js` sí implementa la reconciliación completa buscando `notas LIKE 'PHANTOM:%'` | **Divergencia real, pero no es un bug de cálculo — es una pieza incompleta del lado Electron.** Las ventas que hoy exceden el stock disponible (`derivadoPendiente > 0`) simplemente dejan `inventario_peps.cantidad_restante` en negativo, sin ningún rastro para reconciliar después. `entradas.js` está preparado para reconciliar phantoms que Electron ya no genera de forma corriente — la mecánica de reconciliación vive del lado Worker pero el productor del lado Electron parece haberse quedado solo en el caso histórico. **Esto es importante para el diseño de Fase 4**: si `ordenes:crear`/`guardar`/`procesarVenta` se migran al Worker, hay que decidir explícitamente si el overselling silencioso actual se replica tal cual, o si se aprovecha la migración para generar el marcador `PHANTOM:REGISTRADAS` que `entradas.js` ya sabe reconciliar. |
| 5 | Empate en `fecha_movimiento` al elegir lote FIFO | `ORDER BY fecha_movimiento ASC, id_inventario_peps ASC` | Idéntico en `entradas.js` y `mermas.js` | ✅ Consistente |
| 6 | Consumo parcial repartido en 2+ lotes | Itera FIFO, consume parcial por lote | Igual en ambos lados | ✅ Consistente |
| 7 | Factor de conversión por lote (peso variable) | `consumirDeFuentes` usa `lote.factorConversion` si existe, si no el factor global de la fuente | `entradas.js` calcula y guarda `factor_conversion` correctamente al crear el lote | ✅ Consistente en creación; el consumo cruzando equivalencia ahora también lo respeta tras el fix del Hallazgo #1 (usa el factor de conversión de producto, no el override de lote — el override de lote es para el caso peso-variable dentro del mismo producto, escenario distinto) |
| 8 | Cantidad solicitada ≤ 0 | Rechazado antes de llegar al motor | Rechazado a nivel de ruta (`_cant <= 0` → 400) | ✅ Consistente |
| 9 | Insuficiencia total de stock | Devuelve `pendiente` al caller (concepto de backorder/phantom) | `mermas.js` rechaza la petición completa con 400 si `stock_virtual < cantidad` — sin concepto de backorder | ✅ Divergencia segura e intencional — mermas nunca tuvo ni necesita concepto de backorder parcial |

---

## Hallazgo #3 — Confirmado contra producción (script `scripts/auditoria-peps-reconciliacion.js`)

Ejecutado 2026-09-09, dos queries de solo lectura contra la TiDB real:

1. **Cadenas multi-hop reales**: de 281 conversiones activas, **7 forman cadenas genuinas de 2+ saltos** (excluyendo pares bidireccionales A↔B, que son la mayoría de lo que a primera vista parece multi-hop). No era un caso teórico — llevó a extender el fix del Hallazgo #1 a resolución de cadena completa.
2. **Mermas históricas con déficit de consumo**: **0 resultados**. El bug del Hallazgo #1 (en cualquiera de sus dos formas, 1-hop o multi-hop) nunca llegó a manifestarse en un caso real hasta ahora — no hace falta backfill de datos históricos.

## Pendiente de esta auditoría

1. **`entradas.js` sigue con el mismo límite de 1 salto** que tenía `mermas.js` antes de este fix — no se tocó porque compras/entradas está fuera del alcance de este tramo de Fase 4 (que es Ordenes). Con 7 cadenas reales confirmadas, vale la pena portear `resolverCadenaGlobal` a `entradas.js` también cuando se trabaje la fase de compras — **no es urgente hoy** (crear una compra siempre es sobre el producto exacto que se compra, no depende de cadenas de equivalencia de la misma forma que consumir), pero su reconciliación de phantoms si podría cruzar la frontera de conversión en el futuro.
2. **Decisión de negocio nueva** (surgida de esta auditoría, no estaba en el plan original): ¿el overselling silencioso de `ordenes.handler.ts` (Hallazgo del escenario #4) se replica tal cual en el Worker al migrar `ordenes:crear`/`procesarVenta` en una fase posterior, o se aprovecha para generar el marcador `PHANTOM:REGISTRADAS` que `entradas.js` ya sabe reconciliar? No bloquea el arranque de Fase 4 (B1/B2/B3 no tocan estos canales), pero sí hay que resolverlo antes de la fase que sí los toque.

## Ver también

- Plan completo de Fase 4: `.claude/plans/tingly-cuddling-scroll.md` (sesión de planeación 2026-09-09)
- `disfruleg-electron/src/main/handlers/peps-engine.ts`, `orden-consumo.ts`, `ordenes.handler.ts`
- `disfruleg-bodega/routes/entradas.js`, `routes/mermas.js`
