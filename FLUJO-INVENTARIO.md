# Flujo de Inventario — DISFRULEG
> Versión del sistema: 3.8.4 | Actualizado: 27/05/2026

---

## Índice

1. [Conceptos clave](#1-conceptos-clave)
2. [Antes de empezar: configurar conversiones](#2-antes-de-empezar-configurar-conversiones)
3. [Editar una conversión existente](#3-editar-una-conversión-existente)
4. [Registrar una compra](#4-registrar-una-compra)
5. [Cómo se guarda el stock (PEPS)](#5-cómo-se-guarda-el-stock-peps)
6. [Cómo se descuenta el stock al vender](#6-cómo-se-descuenta-el-stock-al-vender)
7. [Flujo completo: ejemplo real](#7-flujo-completo-ejemplo-real)
8. [Productos que se venden en kg y en pz](#8-productos-que-se-venden-en-kg-y-en-pz)
9. [Validación de stock al procesar una venta](#9-validación-de-stock-al-procesar-una-venta)
10. [Revertir una venta](#10-revertir-una-venta)
11. [Eliminar una compra](#11-eliminar-una-compra)
12. [Reglas y limitaciones importantes](#12-reglas-y-limitaciones-importantes)
13. [Catálogo de productos base vs derivados](#13-catálogo-de-productos-base-vs-derivados)

---

## 1. Conceptos clave

### PEPS (Primeras Entradas, Primeras Salidas)
El sistema registra cada compra como un **lote independiente**. Cuando se vende, se consume primero del lote más antiguo. Esto permite calcular el costo real de cada venta y la utilidad por producto.

### Producto Base
El producto tal como se **compra y cuenta físicamente**. Siempre en la unidad en que llega del proveedor.
- Ejemplo: `LECHUGA ITALIANA.` en **pz**

### Producto Derivado
El mismo producto pero en una **unidad distinta para venta**. Solo existe para ciertos clientes.
- Ejemplo: `LECHUGA ITALIANA` en **kg** (solo para AEROCOMIDAS)

### Factor de Conversión
Cuántas unidades base se consumen por cada unidad derivada vendida.
- Ejemplo: 1 kg de LECHUGA = 1.667 piezas (si cada pieza pesa 0.6 kg)
- Se define en el módulo **Conversiones PEPS** y puede refinarse por lote de compra.

### Factor de Lote
Cada compra puede tener su propio factor (peso por pieza), más preciso que el factor global. Si se registra, el sistema lo usa en lugar del factor global.

---

## 2. Antes de empezar: configurar conversiones

Para que el inventario funcione con productos que se venden en unidades distintas a como se compran, hay que definir las conversiones en **Registro de Compras → Conversiones PEPS**.

### ¿Cuándo necesita conversión un producto?

| Situación | ¿Necesita conversión? |
|---|---|
| Se compra en kg y se vende en kg | ❌ No |
| Se compra en pz y se vende en pz | ❌ No |
| Se compra en kg y se vende en manojo/pz | ✅ Sí |
| Se compra en pz y se vende en kg | ✅ Sí |
| Se compra en pz y se vende en pz Y en kg (distintos clientes) | ✅ Sí (para la versión kg) |

### Cómo crear una conversión

1. Abrir **Registro de Compras**
2. Clic en **⚙️ Herramientas → Equivalencias de Venta** (o Conversiones PEPS)
3. Clic en **"+ Agregar equivalencia"** al fondo del modal
4. Seleccionar:
   - **Producto que se vende** → el producto derivado (ej: LECHUGA ITALIANA kg)
   - **Stock que se descuenta** → el producto base (ej: LECHUGA ITALIANA. pz)
   - **¿Solo para un grupo?** → dejar vacío para que aplique a todos los clientes, o seleccionar uno
5. Elegir tipo de factor:
   - **Factor fijo** → ingresar número constante (ej: SETAS = 4 charolas/kg — siempre igual)
   - **Varía por lote** → activar checkbox — no se pone número; el factor se captura al registrar cada compra ingresando el **peso total del lote**
6. Vista previa: el sistema muestra exactamente qué pasará antes de guardar
7. Clic **"Guardar equivalencia"**

### Tipos de factor: fijo vs variable por lote

| Tipo | Cuándo usarlo | Cómo se configura | Indicador visual |
|---|---|---|---|
| **Factor fijo** | El peso/cantidad es siempre igual (ej. SETAS: 1 charola = 250g → 4/kg) | Número exacto en campo "Factor" | Texto teal: "Al vender 1 kg → descuenta 4 pz" |
| **Variable por lote** | El peso cambia de compra en compra (ej. manojos de cilantro de distinto tamaño) | Checkbox "El factor varía por lote" activo | Badge azul "Peso del lote requerido al comprar" |
| **Factor pendiente** | Se creó con factor=1 sin marcar como variable (hay que configurar) | — | Aviso ámbar "Factor pendiente — edita para configurarlo" |

#### Comportamiento del factor en ventas (`ordenes.handler.ts`)
```
loteFactor = lote.factor_conversion ?? conversionGlobal.factor
```
- Si el lote tiene `factor_conversion` registrado (se ingresó peso total al comprar) → **usa el factor del lote** (más preciso)
- Si no tiene `factor_conversion` → **usa el factor global** de `producto_conversion_peps`
- Por eso en conversiones "variable por lote", es **obligatorio** ingresar el peso total al registrar cada compra.

#### Marcador interno para conversiones variables
Las conversiones de tipo "varía por lote" se guardan con:
- `factor = 1` en la base de datos (valor numérico válido como fallback)
- `notas` prefijadas con `[var]` → ej: `[var]` o `[var] el peso varía según proveedor`
- El frontend detecta este prefijo para mostrar el badge azul (no el aviso ámbar de "pendiente")

### Conversiones ya configuradas en el sistema

#### Conversiones previas (históricas)
| Producto que se vende | Stock que se descuenta | Factor |
|---|---|---|
| CILANTRO (manojo) | CILANTRO FRESCO (kg) | 0.25 |
| PEREJIL (mj) | PEREJIL LISO (kg) | 1.0 |

#### Conversiones creadas el 27/05/2026 — Lechugas y verduras kg→pz
| Producto derivado (venta) | Unidad | Producto base (stock) | Unidad | Factor global |
|---|---|---|---|---|
| LECHUGA ITALIANA (id=871116) | kg | LECHUGA ITALIANA. (id=1411063) | pz | 1* |
| LECHUGA OREJONA (id=871117) | kg | LECHUGA OREJONA (id=961084) | pz | 1* |
| LECHUGA ROMANA (id=871118) | kg | LECHUGA ROMANA (id=961085) | pz | 1* |
| LECHUGA SANGRIA (id=871119) | kg | LECHUGA SANGRIA (id=961086) | pz | 1* |
| COL BLANCA (id=871092) | kg | COL BLANCA (id=961069) | pz | 1* |
| PORO (id=871136) | kg | PORO (id=961088) | pz | 1* |
| HIERBABUENA (id=871106) | kg | HIERBABUENA (id=961076) | manojo | 1* |
| ESPINACA (id=871097) | kg | ESPINACA GRANDE (id=961072) | manojo | 1* |
| CEBOLLA CAMBRAY KG (id=1351073) | kg | CEBOLLA CAMBRAY (id=961071) | mj | 1* |
| SETAS KG (id=1351074) | kg | SETAS (id=931214) | pz | 4 ✅ |
| EPAZOTE (id=1141066) | kg | EPAZOTE MANOJO (id=1321062) | manojo | 1* |
| MENTA KG (id=1321076) | kg | MENTA (id=931160) | manojo | 1* |
| PEREJIL CHINO KG (id=1321074) | kg | PEREJIL CHINO (id=931180) | manojo | 1* |

> `*` Factor global = 1 (placeholder). El factor real se establece por lote en cada compra mediante el campo **Peso por pieza**.
> SETAS confirmado: 1 charola = 250 g = 0.25 kg → 4 charolas/kg ✅

#### Conversiones creadas el 27/05/2026 — Hierbas nuevas kg (productos creados también)
Se crearon 11 productos kg nuevos + sus conversiones. **Factor global = 1 (placeholder)**; capturar peso real en cada compra.

| Producto kg creado | id | Unidad base | id base |
|---|---|---|---|
| ACELGA KG | 1471069 | manojo | 1201072 |
| ALBAHACA KG | 1471070 | manojo | 931063 |
| BERRO KG | 1471071 | manojo | 931077 |
| ENELDO KG | 1471072 | manojo | 931106 |
| FLOR DE CALABAZA KG | 1471073 | manojo | 931112 |
| MEJORANA KG | 1471074 | manojo | 931155 |
| RABANITOS KG | 1471075 | manojo | 931192 |
| ROMERO FRESCO KG | 1471076 | manojo | 931194 |
| TE DE LIMON KG | 1471077 | manojo | 1321070 |
| TOMILLO KG | 1471078 | manojo | 931202 |
| VERDOLAGAS KG | 1471079 | manojo | 931207 |

> Estos productos tienen precio=$0 configurado. **Antes de vender, actualizar precios en el módulo Precios.**

---

## 3. Editar una conversión existente

A partir de v3.8.4, el panel de edición permite **modificar completamente** una conversión — no solo el factor, sino también los productos y el grupo.

### Cómo editar

1. Abrir **⚙️ Herramientas → Equivalencias de Venta**
2. Localizar la conversión en la lista
3. Clic en botón **"Editar"** (lápiz) de la tarjeta
4. El panel se expande con 5 secciones:

### Secciones del panel de edición

#### A — Productos
Dos selectores con búsqueda en tiempo real. Permiten cambiar cualquiera de los dos extremos de la conversión:
- **Producto que se vende** (derivado): lo que el cliente pide
- **Stock que se descuenta** (base): lo que existe físicamente en el almacén

#### B — Grupo de clientes
Select para afinar a qué clientes aplica la conversión:
- **"No — aplica a todos"**: todos los grupos usarán este factor
- **Grupo específico**: solo ese grupo usa este factor (útil si AEROCOMIDAS necesita un factor distinto al de GENERAL para el mismo producto)

#### C — Tipo de factor
Toggle **"El factor varía por lote"**:
- **Activo** → el input de número desaparece; se captura en cada compra mediante el peso del lote
- **Inactivo** → input numérico obligatorio con preview de ejemplo: "Pedido de 4 kg → descuenta X unidades"

#### D — Notas
Campo libre opcional. Si la conversión es variable, las notas se guardan junto con el marcador `[var]` pero se muestran sin él.

#### E — ¿Cómo afecta esta equivalencia? (dinámico)
Panel azul que se actualiza en tiempo real según los productos y tipo de factor seleccionados:

| Contexto | Mensaje si factor fijo | Mensaje si varía por lote |
|---|---|---|
| 🛒 Al registrar una compra de [BASE] | No necesitas ingresar peso adicional. El sistema usa factor X | Debes ingresar el peso total del lote para calcular el factor |
| 📈 Al procesar una venta de [DERIVADO] | Se descuentan X [unidad_base] por cada [unidad_derivada] del lote más antiguo | Se descuenta según el factor registrado en cada lote (FIFO) |

### Cuándo usar edición completa vs eliminar y recrear

| Situación | Acción recomendada |
|---|---|
| Cambiar el factor (ej: se confirmó el peso real del lote) | Editar — clic Editar → cambiar factor |
| Mover de "factor fijo" a "varía por lote" | Editar — activar el checkbox |
| Cambiar a qué grupo aplica | Editar — sección B |
| El producto base está mal (apunta a producto equivocado) | Editar — sección A, cambiar selector |
| Eliminar una equivalencia que ya no tiene sentido | Botón 🗑️ en la tarjeta |

---

## 4. Registrar una compra

### Módulo
**Registro de Compras** — acceder desde el menú principal

### Campos requeridos

| Campo | Descripción |
|---|---|
| **Producto** | El producto BASE (en la unidad en que llega del proveedor) |
| **Cantidad** | Cuántas unidades llegaron (piezas, kg, manojos, etc.) |
| **Precio unitario** | Precio por unidad tal como lo cobra el proveedor |
| **Fecha de compra** | Fecha en que llegó la mercancía |

### Cuándo ingresar el peso del lote

La sección **"Peso del lote"** (opcional) aparece en el formulario de compra. Es **obligatorio llenarla** si el producto tiene una conversión de tipo "varía por lote":

| Campo | Quién lo llena | Descripción |
|---|---|---|
| **Peso total del lote (kg)** | El usuario | Se pesa el bulto completo en báscula y se escribe ese número |
| **kg / unidad** | Solo lectura, calculado | `peso total ÷ cantidad` — se muestra en ámbar |
| **Factor lote** | Solo lectura, calculado | `1 / (kg por unidad)` — se guarda en `inventario_peps.factor_conversion` |

Si se cambia la **cantidad**, el kg/unidad y el factor se recalculan automáticamente con el mismo peso total.

> Si la conversión es de **factor fijo** (ej. SETAS = 4 charolas/kg), no es necesario llenar el peso — el sistema usará el factor configurado en la equivalencia.

**Ejemplo (lechugas):**
```
Producto:          LECHUGA ITALIANA. (pz)
Cantidad:          20 pz
Peso total lote:   13.0 kg  ← usuario escribe
─────────────────────────────────────────
Calculado:  0.6500 kg/pz  ·  Factor: 1.538 pz/kg
```

**Ejemplo (cilantro por manojo):**
```
Producto:          CILANTRO (manojo)
Cantidad:          10 manojos
Peso total lote:   2.0 kg  ← usuario escribe
─────────────────────────────────────────
Calculado:  0.2000 kg/manojo  ·  Factor: 5.000 manojos/kg
```

El factor se guarda en `inventario_peps.factor_conversion = 1 / (pesoTotal / cantidad)`. Cuando un cliente pida 1 kg de CILANTRO KG, el sistema consume exactamente 5 manojos de ese lote.

### Información fiscal (opcional)
- Folio de factura del proveedor
- RFC
- IVA, IEPS
- Método y forma de pago

### ¿A qué producto registrar la compra?

Siempre al **producto base** — el que se compra físicamente.

| ✅ Correcto | ❌ Incorrecto |
|---|---|
| Comprar LECHUGA ITALIANA. (pz) | Comprar LECHUGA ITALIANA (kg) |
| Comprar CILANTRO FRESCO (kg) | Comprar CILANTRO (manojo) |
| Comprar PEREJIL LISO (kg) | Comprar PEREJIL (mj) |

> Registrar la compra en el producto derivado hace que el inventario nunca se cruce con las ventas y el stock quede mal.

---

## 5. Cómo se guarda el stock (PEPS)

Al registrar una compra, el sistema crea:

### 1. Registro en `compra`
Guarda todos los datos fiscales y el peso por pieza si se proporcionó.

### 2. Lote en `inventario_peps`
```
id_producto:      el producto base
cantidad_inicial: las unidades compradas
cantidad_restante: igual a cantidad_inicial (aún sin consumir)
costo_unitario:   precio sin IVA por unidad
factor_conversion: piezas/kg de este lote (si se capturó peso)
fecha_movimiento: fecha de la compra (determina orden FIFO)
```

### 3. Actualización de `producto.stock`
```
stock = SUM(cantidad_restante) de todos los lotes activos del producto
```

El campo `stock` siempre refleja la suma de todos los lotes PEPS del producto. Es la **fuente de verdad**.

### Ejemplo con múltiples compras

```
Compra 1 — 15/05/2026:  20 piezas × $18, peso 0.60 kg/pz
  → Lote 1: 20 piezas, factor 1.667 pz/kg

Compra 2 — 22/05/2026:  15 piezas × $19, peso 0.70 kg/pz
  → Lote 2: 15 piezas, factor 1.429 pz/kg

Stock total: 35 piezas
```

---

## 6. Cómo se descuenta el stock al vender

El stock **solo se descuenta cuando se procesa una venta** (no al guardar una nota).

### Flujo al procesar

1. El sistema identifica los productos del carrito
2. Busca si cada producto tiene una **conversión PEPS** (derivado → base)
3. Carga los lotes del producto base ordenados por fecha (FIFO)
4. Para cada producto vendido, consume de los lotes más antiguos primero
5. Guarda exactamente qué lote se consumió y cuánto (trazabilidad de costo)
6. Actualiza `cantidad_restante` en cada lote y recalcula `producto.stock`

### Sin conversión (producto se compra y vende en la misma unidad)

```
Vendes: 5 kg de JITOMATE
Stock:  Lote A: 8 kg (más antiguo)
→ Consumes 5 kg de Lote A
→ Lote A queda en 3 kg
```

### Con conversión (pz comprado, kg vendido)

```
Vendes: 3 kg de LECHUGA ITALIANA (para AEROCOMIDAS)
Conversión: LECHUGA ITALIANA kg → LECHUGA ITALIANA. pz

Lotes disponibles:
  Lote 1 (15/05): 20 pz, factor 1.667 pz/kg (0.60 kg/pz)
  Lote 2 (22/05): 15 pz, factor 1.429 pz/kg (0.70 kg/pz)

Consumo FIFO desde Lote 1:
  Capacidad del Lote 1 en kg: 20 pz ÷ 1.667 = 12.0 kg disponibles
  Necesitamos 3 kg → tomar de Lote 1 solamente
  Piezas consumidas: 3 × 1.667 = 5.0 piezas

Resultado:
  Lote 1: 20 − 5.0 = 15.0 piezas restantes
  Lote 2: sin cambios
  Stock total: 30 piezas
```

### Al mismo tiempo, otra venta al mismo producto en pz

```
Vendes: 4 piezas de LECHUGA ITALIANA. (para GENERAL)
→ Sin conversión (mismo producto, misma unidad)
→ Consumes 4 piezas de Lote 1

Lote 1: 15.0 − 4 = 11.0 piezas restantes
Stock total: 26 piezas
```

Ambas ventas (kg y pz) drenan del **mismo inventario físico**.

---

## 7. Flujo completo: ejemplo real

### Escenario: LECHUGA ITALIANA, semana del 27/05/2026

**Lunes — Compra:**
- Llegan 25 piezas a $17/pz
- Se pesan todas en báscula: 16.25 kg → se escribe ese número en "Peso total del lote"
- El sistema calcula automáticamente: `16.25 ÷ 25 = 0.65 kg/pz` · Factor: `1.538 pz/kg`
- Se registra: Producto=`LECHUGA ITALIANA. pz`, Cantidad=25, Precio=17, PesoPorPieza=0.65
- Stock: 25 piezas | Lote con factor 1.538 pz/kg

**Martes — Venta a GENERAL (notas guardadas, no procesadas):**
- GENERAL pide 6 piezas de LECHUGA ITALIANA.
- La nota se guarda — el stock **no cambia** todavía: 25 piezas

**Miércoles — Se procesa la venta de GENERAL:**
- Sistema consume 6 piezas del lote
- Stock: 19 piezas

**Jueves — Venta a AEROCOMIDAS:**
- AEROCOMIDAS pide 4 kg de LECHUGA ITALIANA
- Sistema usa conversión: 4 kg × 1.538 pz/kg = 6.15 piezas
- Consume 6.15 piezas del lote
- Stock: 12.85 piezas

**Viernes — Segunda compra:**
- Llegan 20 piezas más a $18/pz, pesan 0.55 kg c/u
- Nuevo lote con factor 1.818 pz/kg
- Stock: 12.85 + 20 = 32.85 piezas (2 lotes activos)

---

## 8. Productos que se venden en kg y en pz

Algunos productos tienen dos presentaciones de venta:
- En **pz** para la mayoría de grupos (GENERAL, ULTRA, MRL, etc.)
- En **kg** para AEROCOMIDAS

### Estructura en el catálogo

| Producto | Unidad | Uso |
|---|---|---|
| LECHUGA ITALIANA. (id=1411063) | pz | Stock base + venta a grupos regulares |
| LECHUGA ITALIANA (id=871116) | kg | Solo para venta a AEROCOMIDAS |

### Cómo conectarlos

Crear conversión en **Conversiones PEPS**:
- Producto que se vende: `LECHUGA ITALIANA` (kg)
- Stock que se descuenta: `LECHUGA ITALIANA.` (pz)
- Factor global: estimado inicial (ej. 1.6 pz/kg si se estima 0.625 kg/pz)

El factor global es solo un punto de partida. Cada compra puede refinarlo con el **peso por pieza** específico de ese lote.

### Lechugas que necesitan conversión configurada

| Producto kg (venta AEROCOMIDAS) | Producto pz (stock) |
|---|---|
| LECHUGA ITALIANA (id=871116) | LECHUGA ITALIANA. (id=1411063) |
| LECHUGA OREJONA (id=871117) | LECHUGA OREJONA pz (verificar id) |
| LECHUGA ROMANA (id=871118) | LECHUGA ROMANA pz (verificar id) |
| LECHUGA SANGRIA (id=871119) | LECHUGA SANGRIA pz (verificar id) |

---

## 9. Validación de stock al procesar una venta

Antes de procesar, el sistema verifica si hay stock suficiente.

### Comportamiento

- Si hay stock suficiente → procesa normalmente
- Si **no** hay stock suficiente → muestra lista de productos faltantes con la cantidad que falta
- El operador puede **forzar el procesamiento** aunque no haya stock (queda en negativo)

### Stock negativo

Cuando se fuerza una venta sin stock:
- El lote PEPS queda en 0 (no puede ser negativo en `inventario_peps`)
- `producto.stock` queda negativo (vía resta aritmética)
- La venta queda registrada normalmente
- La deuda o el cobro se generan igual

El stock negativo se corrige al registrar la siguiente compra.

### Nota sobre la validación con conversiones

La validación usa el **factor global** de `producto_conversion_peps`, no el factor específico de cada lote. Puede haber una pequeña diferencia si los lotes tienen factores distintos al global. Esto es intencional — la validación es una estimación, el consumo real usa los factores precisos de cada lote.

---

## 10. Revertir una venta

Si se revierte un procesamiento (`Revertir` en gestión de órdenes):

1. El sistema lee los registros de `detalle_venta_lote` (qué lote se consumió y cuánto)
2. Restaura `cantidad_restante` en cada lote PEPS
3. Elimina los registros de factura y detalle
4. La orden vuelve a estado `guardada`
5. `producto.stock` se recalcula automáticamente

Las piezas consumidas vuelven exactamente al mismo lote del que salieron, manteniendo la trazabilidad FIFO intacta.

---

## 11. Eliminar una compra

Una compra **solo puede eliminarse si el lote no ha sido consumido** (cantidad_inicial = cantidad_restante).

Si ya se vendió algo de ese lote:
- El sistema bloquea la eliminación
- Muestra cuántas unidades ya se consumieron
- Razón: eliminarla rompería la trazabilidad de costos de ventas ya procesadas

Para "corregir" una compra mal registrada cuyo lote ya tiene consumos, la opción es registrar una compra de ajuste con cantidad negativa o contactar al administrador del sistema.

---

## 12. Reglas y limitaciones importantes

### 🔒 Reglas de integridad automáticas

| Regla | Implementación |
|---|---|
| Los productos derivados no aparecen en búsqueda de compras | `productos:buscarParaCompra` excluye `id_producto_derivado` de conversiones activas |
| Al registrar una compra, siempre es en el producto base | El usuario no puede seleccionar accidentalmente CILANTRO KG para comprar |

### ✅ Lo que funciona bien

- Múltiples lotes del mismo producto (FIFO automático)
- Productos sin conversión (kg comprado, kg vendido)
- Productos con conversión global (manojo → kg, con factor fijo)
- Productos con conversión por lote (pz comprado, kg vendido, con peso por pieza variable)
- Revertir ventas con restauración exacta de lotes
- Stock negativo forzado con seguimiento

### ⚠️ Limitaciones conocidas

| Limitación | Descripción |
|---|---|
| **Validación usa factor global** | Al validar stock antes de procesar, usa el factor global, no el del lote. Puede haber diferencia de 5-15% si el peso varía mucho. |
| **Un solo producto base por derivado** | Un producto derivado (kg) solo puede apuntar a un producto base (pz). No puede distribuir entre varios bases. |
| **Sin conversión en cadena** | No se soporta A → B → C. Solo un nivel de conversión. |
| **El stock del derivado siempre muestra 0** | El stock visible de LECHUGA ITALIANA (kg) es 0 — el inventario real vive en LECHUGA ITALIANA. (pz). Esto es correcto pero puede confundir. |
| **Ajustes manuales** | No hay módulo de ajuste de inventario por conteo físico. Si el conteo difiere del sistema, hay que registrar una compra de ajuste o hablar con el admin. |

### 📌 Buenas prácticas

1. **Siempre registrar compras en el producto base** — el que llega físicamente del proveedor
2. **Marcar como "varía por lote"** todas las conversiones donde el peso del manojo/pieza no es constante (hierbas, lechugas, verduras de hoja)
3. **Ingresar el peso total del lote** cada vez que se registre una compra de un producto con conversión variable — sin ese dato, el sistema usa el factor placeholder y el descuento de ventas será impreciso
4. **Configurar la conversión antes de la primera compra** — crearla después no afecta lotes pasados
5. **Actualizar el factor fijo** en Conversiones PEPS cuando cambie el peso promedio de la temporada (solo aplica a conversiones con factor fijo)
6. **Usar "Editar" para corregir** conversiones mal configuradas — no es necesario eliminar y recrear; el panel de edición permite cambiar todo

---

## 13. Catálogo de productos base vs derivados

> **Estado al 27/05/2026:** Todas las conversiones conocidas están configuradas en la tabla `producto_conversion_peps`. Total: 26 registros activos.

### Productos con conversión configurada ✅

#### Hierbas y verduras de hoja — kg vendido, manojo/pz comprado
| Producto derivado (se vende) | id | Producto base (stock) | id | Factor | Notas |
|---|---|---|---|---|---|
| ACELGA KG | 1471069 | ACELGA (manojo) | 1201072 | 1* | peso varía por compra |
| ALBAHACA KG | 1471070 | ALBAHACA (manojo) | 931063 | 1* | |
| BERRO KG | 1471071 | BERRO (manojo) | 931077 | 1* | |
| ENELDO KG | 1471072 | ENELDO (manojo) | 931106 | 1* | |
| EPAZOTE | 1141066 | EPAZOTE MANOJO | 1321062 | 1* | |
| ESPINACA | 871097 | ESPINACA GRANDE | 961072 | 1* | |
| FLOR DE CALABAZA KG | 1471073 | FLOR DE CALABAZA (manojo) | 931112 | 1* | |
| HIERBABUENA | 871106 | HIERBABUENA (manojo) | 961076 | 1* | |
| MEJORANA KG | 1471074 | MEJORANA (manojo) | 931155 | 1* | |
| MENTA KG | 1321076 | MENTA (manojo) | 931160 | 1* | |
| PEREJIL CHINO KG | 1321074 | PEREJIL CHINO (manojo) | 931180 | 1* | |
| RABANITOS KG | 1471075 | RABANITOS (manojo) | 931192 | 1* | |
| ROMERO FRESCO KG | 1471076 | ROMERO FRESCO (manojo) | 931194 | 1* | |
| TE DE LIMON KG | 1471077 | TE DE LIMON (manojo) | 1321070 | 1* | |
| TOMILLO KG | 1471078 | TOMILLO (manojo) | 931202 | 1* | |
| VERDOLAGAS KG | 1471079 | VERDOLAGAS (manojo) | 931207 | 1* | |

#### Lechugas, col, poro — kg vendido, pz comprado
| Producto derivado | id | Producto base | id | Factor |
|---|---|---|---|---|
| LECHUGA ITALIANA | 871116 | LECHUGA ITALIANA. | 1411063 | 1* |
| LECHUGA OREJONA | 871117 | LECHUGA OREJONA | 961084 | 1* |
| LECHUGA ROMANA | 871118 | LECHUGA ROMANA | 961085 | 1* |
| LECHUGA SANGRIA | 871119 | LECHUGA SANGRIA | 961086 | 1* |
| COL BLANCA | 871092 | COL BLANCA | 961069 | 1* |
| PORO | 871136 | PORO | 961088 | 1* |

#### Otros
| Producto derivado | id | Producto base | id | Factor | Notas |
|---|---|---|---|---|---|
| CEBOLLA CAMBRAY KG | 1351073 | CEBOLLA CAMBRAY | 961071 | 1* | mj→kg |
| SETAS KG | 1351074 | SETAS | 931214 | **4** | 1 charola = 250g ✅ |
| CILANTRO (manojo) | 961067 | CILANTRO FRESCO | 871091 | 0.25 | histórico |
| PEREJIL (mj) | — | PEREJIL LISO | — | 1.0 | histórico |

> `*` Factor = 1 con marcador `[var]` en notas. El factor real se calcula en cada compra cuando el usuario ingresa el **Peso total del lote**. Si no se ingresa peso, se usa factor=1 como fallback (descuento impreciso).
> `†` Factor = 1 sin marcador `[var]` — conversión histórica pendiente de configurar correctamente.

### Productos sin conversión (compra y venta en la misma unidad)

El stock se descuenta directamente sin transformación. Incluye la mayoría de productos kg:
- Jitomate, Papa, Zanahoria, Limón, Naranja, Aguacate, Cebolla, etc.

### Regla para nuevos productos

Al crear un producto que se vende en unidad diferente a la de compra:
1. Crear el **producto base** (unidad de compra — ej. RÚCULA mj)
2. Crear el **producto derivado** (unidad de venta — ej. RÚCULA KG) — activar la sección **"Conversión PEPS"** en el formulario de alta
3. En esa sección:
   - Buscar y seleccionar el producto base
   - Elegir "Factor fijo" (con número) o "Varía por lote" (sin número)
4. Al guardar, se inserta automáticamente en `producto_conversion_peps`

Si el producto ya existe y falta la conversión, crearla desde **⚙️ Herramientas → Equivalencias de Venta → + Agregar equivalencia**.

#### Sección "Conversión PEPS" en CreateProductModal
Implementada en `src/renderer/components/CreateProductModal.tsx`.
- Toggle que activa/desactiva la sección (desactivado por defecto)
- Búsqueda de producto base con debounce (usa `buscarProductosParaCompra`)
- Campo de factor numérico (solo si no es variable)
- Checkbox "varía por lote" — mismo comportamiento que en ConversionesPepsModal
- Al guardar llama `crearConversionPeps({ idProductoDerivado, idProductoBase, factor, notas })`

---

## Resumen del flujo en 5 pasos

```
1. CONFIGURAR
   ⚙️ Herramientas → Equivalencias de Venta
   → Definir qué producto base corresponde a cada derivado
   → Elegir: factor fijo (número) o varía por lote (checkbox)

2. COMPRAR
   Registro de Compras → producto BASE, cantidad, precio
   → Si la conversión es variable: ingresar Peso total del lote
   → Se crea lote PEPS con factor_conversion específico del lote

3. VENDER (guardar nota)
   El stock NO cambia — la nota queda en estado "guardada"

4. PROCESAR VENTA
   El stock se descuenta usando FIFO + factor del lote (o global si no hay)
   → Se registra exactamente qué lote cubrió qué venta (trazabilidad de costos)

5. (OPCIONAL) REVERTIR
   El stock se restaura exactamente en los lotes originales
```

---

*Documento generado para el equipo de operaciones de DISFRULEG.*
*Para cambios en la lógica de inventario, consultar con Ubicuo Studio.*
