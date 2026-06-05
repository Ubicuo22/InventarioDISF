# Flujo de Inventario — DISFRULEG
> Versión del sistema: 3.11.0 | Actualizado: 05/06/2026

---

## Índice

1. [Conceptos clave](#1-conceptos-clave)
2. [Equivalencias de venta](#2-equivalencias-de-venta)
3. [Registrar una compra](#3-registrar-una-compra)
4. [Cómo se guarda el stock (PEPS)](#4-cómo-se-guarda-el-stock-peps)
5. [Cómo se muestra el stock (con equivalencias)](#5-cómo-se-muestra-el-stock-con-equivalencias)
6. [Cómo se descuenta el stock al vender](#6-cómo-se-descuenta-el-stock-al-vender)
7. [Flujo completo: ejemplo real](#7-flujo-completo-ejemplo-real)
8. [Equivalencias bilaterales vs unidireccionales](#8-equivalencias-bilaterales-vs-unidireccionales)
9. [Análisis de margen por nota](#9-análisis-de-margen-por-nota)
10. [Inventario PEPS: semáforo y filtros](#10-inventario-peps-semáforo-y-filtros)
11. [Validación de stock al procesar una venta](#11-validación-de-stock-al-procesar-una-venta)
12. [Revertir una venta](#12-revertir-una-venta)
13. [Eliminar una compra](#13-eliminar-una-compra)
14. [Reglas y limitaciones importantes](#14-reglas-y-limitaciones-importantes)

---

## 1. Conceptos clave

### PEPS (Primeras Entradas, Primeras Salidas)
El sistema registra cada compra como un **lote independiente**. Cuando se vende, se consume primero del lote más antiguo. Esto permite calcular el costo real de cada venta y la utilidad por producto.

### Producto Base
El producto tal como se **compra y cuenta físicamente**. Siempre en la unidad en que llega del proveedor.
- Ejemplo: `PASTA TORNILLO` en **caja**

### Producto Derivado
El mismo producto pero en una **unidad distinta para venta**. El stock se descuenta del producto base.
- Ejemplo: `PASTA TORNILLO` en **pz** (cada caja tiene 20 pz)

### Factor de Conversión
Cuántas unidades base se consumen por cada unidad derivada vendida.
- Ejemplo: 1 caja de PASTA TORNILLO = 20 pz → factor = 20
- Se define en **Equivalencias de Venta** (Compras → Herramientas) o directo desde el **Editor de Precios**

### Factor de Lote
Cada compra puede tener su propio factor (peso por pieza), más preciso que el factor global. Si se registra, el sistema lo usa en lugar del factor global.

### Equivalencia Bilateral
Cuando dos productos tienen una relación simétrica (caja ↔ pz), el sistema crea **ambas direcciones automáticamente**:
- caja → pz (factor 20)
- pz → caja (factor 0.05)

Esto permite que el stock se muestre correctamente en ambos productos.

### Equivalencia Unidireccional
Cuando varios productos comparten un solo inventario base, solo se crea **una dirección por producto**. Ejemplo: MORRÓN VERDE, ROJO y AMARILLO → todos descargan de MORRÓN COLORES.

---

## 2. Equivalencias de venta

### ¿Cuándo necesita equivalencia un producto?

| Situación | ¿Necesita equivalencia? | Tipo |
|---|---|---|
| Se compra en kg y se vende en kg | No | — |
| Se compra en caja y se vende en pz | **Sí** | Bilateral |
| Se compra en pz y se vende en kg (otro grupo) | **Sí** | Bilateral |
| Varios colores de un mismo producto se compran juntos | **Sí** | Unidireccional |
| Se compra en bulto y se vende en kg | **Sí** | Bilateral |

### Dónde crear equivalencias

Hay **dos formas** de crear equivalencias:

#### Opción 1: Desde el Editor de Precios (recomendado para equivalencias simples)

1. Abrir **Editor de Precios**
2. En la columna **Equiv.** de cualquier producto:
   - Si ya tiene equivalencia → badge teal `⚖ 20 pz` — clic para editar
   - Si no tiene → icono apagado `⚖ +` — clic para crear
3. Se abre un modal ligero con:
   - Producto pre-seleccionado
   - Sugerencias automáticas de productos con nombre similar
   - Campo de factor
   - Toggle unidireccional
4. Clic "Crear equivalencia" → guarda ambas direcciones (o solo una si es unidireccional)

#### Opción 2: Desde Compras → Herramientas → Equivalencias de Venta (para gestión avanzada)

Página completa con lista a la izquierda y formulario a la derecha.

1. **A — Productos**: seleccionar "Producto que se vende" y "Stock que se descuenta"
2. **Toggle Unidireccional**: activar si varios productos comparten el mismo stock base
3. **B — Factor**: número fijo o "varía por lote"
4. **C — Grupo**: aplica a todos o solo a un grupo de clientes
5. **D — Notas**: campo libre opcional
6. **Guardar**: crea ambas direcciones automáticamente (o solo una si es unidireccional)

### Tipos de factor

| Tipo | Cuándo usarlo | Cómo se configura |
|---|---|---|
| **Factor fijo** | El contenido es siempre igual (1 caja = 20 pz) | Número exacto |
| **Variable por lote** | El peso cambia de compra en compra (hierbas, manojos) | Checkbox "El factor varía por lote" |
| **Factor pendiente** | Se creó con factor=1 sin marcar como variable | ⚠️ Hay que configurar antes de usar |

### Cómo funciona el guardado bilateral

Al guardar una equivalencia normal (sin toggle unidireccional):

```
El usuario configura:
  Producto que se vende: PASTA TORNILLO (caja)
  Stock que se descuenta: PASTA TORNILLO (pz)
  Factor: 20

El sistema guarda automáticamente 2 filas en producto_conversion_peps:
  1. caja → pz, factor 20    (al vender 1 caja, descuenta 20 pz)
  2. pz → caja, factor 0.05  (al vender 1 pz, descuenta 1/20 de caja)
```

Si ya existía la inversa, la **actualiza** en vez de duplicar.

### Cómo funciona el guardado unidireccional

Al guardar con toggle unidireccional activado:

```
El usuario configura:
  Producto que se vende: PIMIENTO MORRÓN VERDE (kg)
  Stock que se descuenta: PIMIENTO COLORES (kg)
  Factor: 1
  ☑ Unidireccional

El sistema guarda SOLO 1 fila:
  1. MORRÓN VERDE → PIMIENTO COLORES, factor 1

Repite para cada color:
  2. MORRÓN ROJO → PIMIENTO COLORES, factor 1
  3. MORRÓN AMARILLO → PIMIENTO COLORES, factor 1
  4. MORRÓN NARANJA → PIMIENTO COLORES, factor 1
```

Al vender cualquier color, se descuenta del stock de PIMIENTO COLORES.

---

## 3. Registrar una compra

### Campos requeridos

| Campo | Descripción |
|---|---|
| **Producto** | El producto BASE (en la unidad en que llega del proveedor) |
| **Cantidad** | Cuántas unidades llegaron (piezas, kg, manojos, cajas, bultos, etc.) |
| **Precio unitario** | Precio por unidad tal como lo cobra el proveedor |
| **Fecha de compra** | Fecha en que llegó la mercancía |

### Todos los productos aparecen en el buscador de compras

A partir de v3.11.0, **cualquier producto activo** aparece en el buscador de compras, incluyendo productos con equivalencias configuradas. La equivalencia es solo para controlar cómo se descuenta en ventas — no restringe qué puedes comprar.

### Peso del lote (para conversiones variables)

| Campo | Quién lo llena | Descripción |
|---|---|---|
| **Peso total del lote (kg)** | El usuario | Se pesa el bulto completo en báscula |
| **kg / unidad** | Calculado | `peso total ÷ cantidad` |
| **Factor lote** | Calculado | `1 / (kg por unidad)` — se guarda en `inventario_peps.factor_conversion` |

**Ejemplo:**
```
Producto:          LIMÓN ARPILLA (bulto)
Cantidad:          5 bultos
Equivalencia:      1 bulto = 30 kg de LIMÓN
─────────────────────────────────────────
→ Lote PEPS: 5 bultos, factor 30
→ Al vender 10 kg de LIMÓN, el sistema descuenta 10/30 = 0.333 bultos
```

---

## 4. Cómo se guarda el stock (PEPS)

Al registrar una compra, el sistema crea:

### 1. Registro en tabla `compra`
Guarda todos los datos fiscales y el peso por pieza si se proporcionó.

### 2. Lote en tabla `inventario_peps`
```
id_producto:       el producto base
cantidad_inicial:  las unidades compradas
cantidad_restante: igual a cantidad_inicial (aún sin consumir)
costo_unitario:    precio sin IVA por unidad
factor_conversion: unidades derivadas por unidad base (si se capturó peso)
fecha_movimiento:  fecha de la compra (determina orden FIFO)
```

### 3. Actualización de `producto.stock`
```
stock = SUM(cantidad_restante) de todos los lotes activos del producto
```

El campo `stock` siempre refleja la suma de todos los lotes PEPS del producto.

### Ejemplo con múltiples lotes

```
Compra 1 — 02/06/2026:  71 cajas × $138, cada caja = 20 pz
  → Lote 1: 71 cajas, costo $138, factor_conversion = 20

Compra 2 — 03/06/2026:  2 pz sueltas × $6.90
  → Lote 2: 2 pz, costo $6.90

Stock de PASTA TORNILLO caja: 71
Stock de PASTA TORNILLO pz: 2
```

---

## 5. Cómo se muestra el stock (con equivalencias)

### Cálculo del stock enriquecido

Cuando un producto tiene una equivalencia configurada, el stock visible incluye lo que representan las unidades del otro producto:

```
PASTA TORNILLO (pz):
  Stock propio:     2 pz
  Stock de caja:    71 cajas × 20 = 1420 pz
  ─────────────────────────────────────────
  Stock visible:    1422 pz
  (se muestra "↔ 71 caja" debajo)

PASTA TORNILLO (caja):
  Stock propio:     71 cajas
  Stock de pz:      2 pz ÷ 20 = 0.1 caja
  ─────────────────────────────────────────
  Stock visible:    71 cajas
  (se muestra "↔ 1422 pz" debajo)
```

### Dónde se muestra

| Módulo | Qué muestra |
|---|---|
| **Editor de Precios** | Columna "Stock" con badge de color + columna "Equiv." con badge del par |
| **Vista Global de Precios** | Columna "Stock" con badge de color |
| **PEPS Inventario** | Stock + equivalencia debajo en texto pequeño (ej. `↔ 71 caja`) |

### Protección anti-circular

Con equivalencias bilaterales (A→B y B→A), la query de stock solo usa **un nivel** de conversión por producto. Si detecta que el segundo nivel vuelve al producto original, lo ignora para no contar doble:

```sql
CASE
  WHEN cp2.id_conversion IS NOT NULL AND pb2.stock IS NOT NULL
    AND pb2.id_producto != p.id_producto  -- ← protección anti-circular
  THEN ROUND(pb2.stock / (cp.factor * cp2.factor) + pb.stock / cp.factor + p.stock, 4)
  WHEN cp.id_conversion IS NOT NULL AND pb.stock IS NOT NULL
  THEN ROUND(pb.stock / cp.factor + p.stock, 4)
  ELSE p.stock
END AS stock
```

### Unidades discretas

Para pz, caja, bolsa, bote, botella, lata, sobre y paquete, el stock se redondea con `FLOOR` (no puede haber 0.4 piezas). Para kg, g, ml, lt se muestran los decimales.

---

## 6. Cómo se descuenta el stock al vender

El stock **solo se descuenta cuando se procesa una venta** (no al guardar una nota).

### Flujo al procesar

1. El sistema identifica los productos del carrito
2. Busca si cada producto tiene una **equivalencia PEPS** (derivado → base)
3. Resuelve cadenas de equivalencias (A→B→C), con protección contra loops circulares bilaterales
4. Carga los lotes del producto base ordenados por fecha (FIFO)
5. Para cada producto vendido, consume de los lotes más antiguos primero
6. Guarda exactamente qué lote se consumió y cuánto (trazabilidad de costo)
7. Actualiza `cantidad_restante` en cada lote y recalcula `producto.stock`

### Protección contra loops en cadenas de equivalencias

Con equivalencias bilaterales, la resolución de cadenas puede crear un loop:
```
caja → pz → caja → pz → ... (infinito)
```

El sistema detecta esto: si al resolver la cadena el resultado vuelve al producto original, usa solo el primer nivel:

```javascript
// Si la cadena es circular (bilateral: A→B→A),
// usar el primer nivel directamente
convMap[pidNum] = current.id_base === pidNum ? firstLevel : current
```

### Sin conversión

```
Vendes: 5 kg de JITOMATE
Stock:  Lote A: 8 kg (más antiguo)
→ Consumes 5 kg de Lote A
→ Lote A queda en 3 kg
```

### Con conversión bilateral

```
Vendes: 3 cajas de PASTA TORNILLO
Equivalencia: caja → pz, factor 20

Lotes de pz:
  Lote 1 (02/06): 1420 pz restantes (fue 1420, se vendieron 2)
  Lote 2 (03/06): 2 pz

Consumo: 3 cajas × 20 = 60 pz
→ Consume 60 pz de Lote 1
→ Lote 1: 1420 − 60 = 1360 pz
```

### Con equivalencia unidireccional (N→1)

```
Vendes: 2 kg de PIMIENTO MORRÓN VERDE
Equivalencia: VERDE → COLORES, factor 1 (unidireccional)

Lotes de PIMIENTO COLORES:
  Lote 1: 10 kg

Consumo: 2 kg × 1 = 2 kg
→ Lote 1: 10 − 2 = 8 kg

Vendes: 1 kg de PIMIENTO MORRÓN ROJO
→ Lote 1: 8 − 1 = 7 kg

Ambos colores drenan del mismo inventario de COLORES.
```

---

## 7. Flujo completo: ejemplo real

### Escenario: ACEITE 800 ML, semana del 02/06/2026

**Lunes — Configurar equivalencia (una sola vez):**
- Desde el Editor de Precios, clic en `⚖ +` de ACEITE 800 ML (pz)
- Seleccionar ACEITE 800 ML CAJA como stock base
- Factor: 0.083333 (1 pz = 1/12 de caja, porque 1 caja = 12 pz)
- Guardar → se crean ambas direcciones automáticamente

**Martes — Compra:**
- Llegan 10 cajas a $470/caja
- Registrar compra en ACEITE 800 ML CAJA
- Stock: 10 cajas | Equivale a: 120 pz

**Miércoles — Venta de 24 pz a GENERAL:**
- La nota se guarda con 24 pz de ACEITE 800 ML
- Al procesar: 24 pz × 0.083333 = 2 cajas consumidas del Lote 1
- Stock: 8 cajas | Equivale a: 96 pz

**Jueves — Venta de 3 cajas a MRL:**
- La nota tiene 3 cajas de ACEITE 800 ML CAJA
- Al procesar: 3 cajas directas del Lote 1
- Stock: 5 cajas | Equivale a: 60 pz

---

## 8. Equivalencias bilaterales vs unidireccionales

### Cuándo usar cada tipo

| Tipo | Usar cuando | Ejemplo | Toggle |
|---|---|---|---|
| **Bilateral** (default) | Par 1:1 — un producto tiene exactamente un par en otra unidad | ACEITE 800 ML (pz) ↔ ACEITE 800 ML CAJA | Desactivado |
| **Unidireccional** | N→1 — varios productos comparten un mismo inventario base | MORRÓN VERDE/ROJO/AMARILLO → MORRÓN COLORES | ☑ Activado |

### Qué pasa si se usa el tipo incorrecto

| Error | Consecuencia | Solución |
|---|---|---|
| Bilateral cuando debería ser unidireccional | El producto base (COLORES) termina con N inversas; la query solo usa una y el stock se muestra incorrecto | Eliminar inversas sobrantes, recrear como unidireccionales |
| Unidireccional cuando debería ser bilateral | El stock del producto base no refleja el stock del derivado | Desmarcar toggle, guardar de nuevo |

### Cómo se ve en el sistema

**En la lista de equivalencias:**
```
[venta] → [stock]  Pasta Tornillo → descuenta Pasta Tornillo
                    1 caja → descuenta 20 pz · todos los grupos

[venta] → [stock]  Pasta Tornillo → descuenta Pasta Tornillo
                    1 pz → descuenta 0.05 caja · todos los grupos
```
Las dos filas aparecen automáticamente para equivalencias bilaterales.

**En el Editor de Precios:**
```
PASTA TORNILLO  pz   ⚖ 20 pz    $8.50   $8.50
PASTA TORNILLO  caja ⚖ 0.05 caja $154.00 $154.00
```

---

## 9. Análisis de margen por nota

A partir de v3.11.0, los administradores pueden ver la **ganancia estimada** de cada nota directamente en la vista previa.

### Cómo acceder

1. Gestión de Órdenes → clic en cualquier nota
2. En la vista previa, panel **"Análisis de margen"** (violeta, colapsado por defecto)
3. Clic para expandir → carga los costos PEPS de cada producto

### Qué muestra

| Columna | Fuente |
|---|---|
| **Venta** | precio_unitario × cantidad de la nota |
| **Costo PEPS** | Promedio ponderado de lotes activos en inventario_peps |
| **Ganancia** | Venta − Costo |
| **Margen %** | (Ganancia / Venta) × 100 |

### Códigos de color

| Color | Margen |
|---|---|
| 🟢 Verde | ≥ 30% |
| 🟡 Amarillo | 15% – 29% |
| 🔴 Rojo | < 15% |

### Limitaciones

- **Solo visible para admins** (`user.rol === 'admin'`)
- **Solo para notas del 2 de junio 2026 en adelante** (fecha inicio de inventario PEPS). Notas anteriores muestran "No disponible — nota anterior al inventario"
- Si un producto no tiene lotes activos, usa el **promedio histórico de compras** como fallback y lo marca con `~` (aproximado)
- Si un producto no tiene ningún historial de compra, muestra `—`

---

## 10. Inventario PEPS: semáforo y filtros

### Días estimados de stock

El sistema calcula cuántos días le quedan a cada producto antes de agotarse, basado en la velocidad de ventas de los últimos 30 días:

```
Días estimados = stock_actual / (ventas_30_días / 30)
```

### Semáforo visual

| Color | Significado | Acción sugerida |
|---|---|---|
| 🔴 Rojo | ≤ 3 días de stock | Compra urgente |
| 🟡 Amarillo | 4 – 7 días | Planificar compra |
| 🟢 Verde | > 7 días | Sin urgencia |
| ⚫ Gris | Sin ventas en 30 días | Revisar si el producto sigue activo |

### Filtros rápidos

6 chips encima de la tabla, cada uno con conteo:

| Filtro | Qué muestra |
|---|---|
| **Todos** | Todos los productos con stock |
| **🔴 Crítico** | ≤ 3 días estimados |
| **🟡 Stock bajo** | ≤ 7 días estimados |
| **⚫ Sin movimiento** | Con stock pero sin ventas en 30 días |
| **🟠 Lotes viejos** | Lotes con más de 60 días en almacén |
| **↔ Equivalencias** | Productos con equivalencia configurada |

### Tabla completa del inventario

A partir de v3.11.0, la tabla muestra **todos los productos** (antes era solo Top 10):

| Columna | Descripción | Ordenable |
|---|---|---|
| # | Ranking (top 3 resaltado cuando se ordena por valor) | — |
| Producto | Nombre del producto | ✅ |
| Unidad | pz, kg, caja, etc. | — |
| Stock | Cantidad + punto de semáforo + equivalencia debajo | ✅ |
| Días est. | Badge con color y días restantes | — |
| Lotes | Número de lotes PEPS activos | ✅ |
| Costo Prom. | Promedio ponderado + rango min–max | ✅ |
| Valor Total | Stock × costo promedio (en pesos) | ✅ |
| Ver | Botón para abrir modal con detalle de cada lote | — |

Búsqueda por nombre + paginación de 50 en 50.

---

## 11. Validación de stock al procesar una venta

Antes de procesar, el sistema verifica si hay stock suficiente.

- Si hay stock suficiente → procesa normalmente
- Si **no** hay stock suficiente → muestra lista de productos faltantes
- El operador puede **forzar el procesamiento** (stock queda negativo)

### Stock negativo

Cuando se fuerza una venta sin stock:
- El lote PEPS queda en 0
- `producto.stock` queda negativo
- La venta se registra normalmente
- El stock se corrige al registrar la siguiente compra

---

## 12. Revertir una venta

Si se revierte un procesamiento:

1. El sistema lee `detalle_venta_lote` (qué lote se consumió y cuánto)
2. Restaura `cantidad_restante` en cada lote PEPS
3. Elimina los registros de factura y detalle
4. La orden vuelve a estado `guardada`
5. `producto.stock` se recalcula automáticamente

Las piezas consumidas vuelven exactamente al mismo lote del que salieron.

---

## 13. Eliminar una compra

Una compra **solo puede eliminarse si el lote no ha sido consumido** (cantidad_inicial = cantidad_restante).

Si ya se vendió algo de ese lote, el sistema bloquea la eliminación y muestra cuántas unidades ya se consumieron.

---

## 14. Reglas y limitaciones importantes

### ✅ Lo que funciona bien

- Equivalencias bilaterales automáticas (stock correcto en ambas unidades)
- Equivalencias unidireccionales (N productos → 1 base central)
- Múltiples lotes del mismo producto (FIFO automático)
- Protección anti-circular en cálculo de stock y en cadenas de conversión de ventas
- Días estimados de stock basados en velocidad de ventas real
- Análisis de margen por nota con costos PEPS reales
- Todos los productos aparecen en búsqueda de compras (sin restricción por equivalencias)
- Revertir ventas con restauración exacta de lotes

### ⚠️ Limitaciones conocidas

| Limitación | Descripción |
|---|---|
| **Inventario empezó el 02/06/2026** | Notas anteriores a esa fecha no tienen costos PEPS reales. El análisis de margen no está disponible para notas previas. |
| **Validación usa factor global** | Al validar stock antes de procesar, usa el factor global, no el del lote. Puede haber diferencia si el peso varía mucho. |
| **Un solo nivel efectivo de cadena** | A→B→C funciona, pero si B tiene una equivalencia bilateral, la cadena se limita a un nivel para evitar loops. |
| **Ajustes manuales** | No hay módulo de ajuste de inventario por conteo físico. Usar compra de ajuste o módulo de mermas. |

### 📌 Buenas prácticas

1. **Usar equivalencias bilaterales** para pares simples (caja ↔ pz)
2. **Usar equivalencias unidireccionales** cuando N colores/variantes comparten un inventario
3. **Siempre registrar compras en el producto base** — el que llega físicamente
4. **Revisar el semáforo** diariamente para anticipar compras urgentes
5. **Ingresar el peso total del lote** en cada compra de productos con conversión variable
6. **Crear equivalencias desde el Editor de Precios** para agilizar — tiene sugerencias automáticas

---

## Resumen del flujo en 5 pasos

```
1. CONFIGURAR EQUIVALENCIA (una sola vez)
   Editor de Precios → clic en ⚖ + → seleccionar par → factor → guardar
   O bien: Compras → Herramientas → Equivalencias de Venta

2. COMPRAR
   Registro de Compras → producto BASE, cantidad, precio
   → Si la conversión es variable: ingresar Peso total del lote

3. GUARDAR NOTA
   El stock NO cambia — la nota queda en estado "guardada"

4. PROCESAR VENTA
   El stock se descuenta usando FIFO + factor del lote (o global)
   → Trazabilidad: se registra qué lote cubrió qué venta

5. REVISAR MARGEN (admin)
   Gestión de Órdenes → vista previa → "Análisis de margen"
   → Ganancia real basada en costos PEPS
```

---

*Documento generado para el equipo de operaciones de DISFRULEG.*
*v3.11.0 — Ubicuo Studio — 05/06/2026*
