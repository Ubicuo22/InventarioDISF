# Plan — Tickets de compra (Fase 1)

**Fecha:** 26 sep 2026 · **Estado:** implementado en la rama `feat/tickets-compra` de ambos repos, sin desplegar (ver §9)
**Repos:** `disfruleg-bodega` (Worker + PWA) y `disfruleg-electron`

---

## Objetivo

Hay errores al capturar compras (precios y cantidades) y no queda evidencia
contra la cual revisar. La Fase 1 agrega el ticket original como registro de
primera clase:

1. Un **CEO** toma foto del ticket (o sube un PDF) desde la **PWA** en el celular.
2. El ticket queda **pendiente** en una bandeja. No toca inventario.
3. En **Electron → Registro de compras**, un aviso dice "N tickets sin
   capturar · Ver". El capturista abre uno y ve la **vista previa del ticket**
   junto al formulario de siempre (individual o lote, el que use hoy). Indica
   proveedor, productos, cantidades y precios sin tener el papel en la mano.
4. Al guardar, las compras quedan ligadas al ticket (`compra.id_ticket`) y el
   original se puede consultar desde el historial.

**Fuera de alcance de esta fase:** IA/OCR (Fase 2), registro automático
(Fase 3), bot de Telegram, cola offline en el celular y lectura de XML CFDI.
La tabla nace preparada para la Fase 2 (`sugerencia_json`).

## Decisiones de diseño

| Decisión | Por qué |
|---|---|
| Los archivos pasan por el **Worker**, no por Electron | Electron trae hoy credenciales de R2 (`r2Service.js`) y H-5 Fase 6 las va a quitar. No se agrega un bucket más a esa deuda. |
| Bucket **nuevo y privado** `disfruleg-tickets` | El de avatares es público (`R2_PUBLIC_URL`). Los tickets traen precios de proveedores. Se sirven solo por endpoint con sesión. |
| La captura (INSERT de compras) va por **SQL directo en Electron** | La lógica real de compras vive en `compras.handler.ts` (`rellenarLineasSinCosto`, reconsumo) y no está migrada. Hacerla en el Worker crearía una tercera copia. |
| La captura usa **el formulario de hoy**, individual o lote | Individual es el modo por default (`Purchases.tsx:104`). No se cambia la forma de trabajar; solo se agrega la vista previa al lado. |
| El ticket se **cierra con cuadre** ("Terminar ticket") | Como en modo individual cada producto se guarda por separado, un guardado atómico no aplica. El control es otro: al cerrar, la suma de lo capturado tiene que cuadrar con el total del ticket o se registra el motivo de la diferencia. |
| Un ticket en captura queda **apartado** para quien lo abrió | Evita que dos capturistas registren el mismo ticket. |
| Solo `ceo` sube | Decisión de negocio. Se valida en el servidor, no solo en la interfaz. |
| Subir no pide ningún campo obligatorio | Hoy nadie toma fotos. Si subir cuesta más de unos segundos, no se va a hacer. |

## 1. Base de datos

Archivo: `db/migrations/ticket_compra.sql`. Siguiendo la convención del repo,
**se crea a mano en producción antes del deploy** (el Worker no corre bootstrap).

```sql
-- ticket_compra — foto/PDF del ticket original de una compra (26 sep 2026).
-- Ver docs/PLAN-TICKETS-COMPRA.md. Estados:
--   borrador   → creado, subiendo archivos (invisible; el cron limpia a las 24 h)
--   pendiente  → en la bandeja, esperando captura
--   en_captura → alguien lo abrió; sus compras ya se van ligando
--   capturado  → cerrado con cuadre; compras ligadas por compra.id_ticket
--   descartado → duplicado, ilegible o no era compra (se conserva el archivo)
CREATE TABLE IF NOT EXISTS ticket_compra (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  estado              VARCHAR(20)   NOT NULL DEFAULT 'borrador',
  nota                VARCHAR(255)  DEFAULT NULL,
  subido_por          VARCHAR(100)  NOT NULL,
  fecha_subida        DATETIME      NOT NULL DEFAULT NOW(),
  -- Captura
  capturando_por      VARCHAR(100)  DEFAULT NULL,
  inicio_captura      DATETIME      DEFAULT NULL,
  id_proveedor        INT           DEFAULT NULL,
  fecha_ticket        DATE          DEFAULT NULL,
  folio               VARCHAR(50)   DEFAULT NULL,
  total_ticket        DECIMAL(12,2) DEFAULT NULL,
  diferencia_aceptada DECIMAL(12,2) DEFAULT NULL,
  motivo_diferencia   VARCHAR(255)  DEFAULT NULL,
  capturado_por       VARCHAR(100)  DEFAULT NULL,
  fecha_captura       DATETIME      DEFAULT NULL,
  -- Descarte
  descartado_por      VARCHAR(100)  DEFAULT NULL,
  fecha_descarte      DATETIME      DEFAULT NULL,
  motivo_descarte     VARCHAR(255)  DEFAULT NULL,
  -- Fase 2: lo que sugirió la IA, para comparar contra lo capturado
  sugerencia_json     JSON          DEFAULT NULL,
  INDEX idx_estado (estado, fecha_subida)
);

CREATE TABLE IF NOT EXISTS ticket_compra_archivo (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  id_ticket    INT          NOT NULL,
  orden        TINYINT      NOT NULL DEFAULT 1,
  r2_key       VARCHAR(200) NOT NULL,
  tipo         VARCHAR(50)  NOT NULL,   -- image/jpeg | image/png | image/webp | application/pdf
  tamano       INT          NOT NULL,
  sha256       CHAR(64)     NOT NULL,
  fecha_subida DATETIME     NOT NULL DEFAULT NOW(),
  INDEX idx_ticket (id_ticket),
  INDEX idx_sha (sha256)
);

ALTER TABLE compra ADD COLUMN IF NOT EXISTS id_ticket INT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_compra_ticket ON compra(id_ticket);
```

Varios archivos por ticket, porque los tickets largos no caben en una foto.

## 2. Worker (`disfruleg-bodega`)

### 2.1 Configuración

- `wrangler.jsonc`: binding `R2_TICKETS` → bucket `disfruleg-tickets`, **sin**
  dominio público.
- El binding se lee con `import('cloudflare:workers')`, igual que
  `BROWSER` en `utils/nota-pdf.js`.

### 2.2 `utils/tickets.js` (lógica compartida)

- `detectarTipo(buffer)`: tipo real por magic bytes (JPEG `FF D8 FF`,
  PNG `89 50 4E 47`, WebP `RIFF....WEBP`, PDF `%PDF`). **No se confía en el
  `Content-Type`.**
- **Formatos admitidos:** JPG, PNG, WebP y PDF. El HEIC del iPhone llega ya
  convertido a JPEG por la PWA (ver 3.1). Nada más: Word, Excel o ZIP no son
  un ticket, y cada formato extra es un visor más que mantener.
- Límites: imagen ≤ 3 MB (llega comprimida, ~0.5 MB), PDF ≤ 15 MB.
- `sha256(buffer)` con `crypto.subtle`.
- Clave R2: `tickets/AAAA/MM/<uuid>.<ext>`.
- `leerArchivo(r2_key)`: stream desde R2.

### 2.3 Rutas de la PWA: `routes/tickets.js` → `/api/tickets`

Montadas con `requireAuth` y un check `rol === 'ceo'` para escribir.

| Método | Ruta | Qué hace |
|---|---|---|
| `POST` | `/` | Crea un ticket en `borrador` con `{ nota? }` y devuelve `{ id }` |
| `POST` | `/:id/archivos` | Cuerpo **raw** (`express.raw`, límite 15 MB), un archivo por petición. Valida tipo, tamaño y dueño (`subido_por`), y que siga en `borrador`. Si el hash ya existe en un ticket no descartado responde **409** `{ duplicado: { id, fecha_subida, subido_por } }`, salvo con `?forzar=1`. |
| `POST` | `/:id/enviar` | `borrador` → `pendiente`. Exige al menos un archivo. |
| `GET` | `/mios` | Los últimos 20 del usuario con estado, para el contador de pendientes. |

Un archivo por petición: con mala señal se reintenta solo el que falló, no todo el ticket.

### 2.4 Rutas de Electron: `routes/electron/tickets.js` → `/api/electron/tickets`

Con `requireAuthElectron`. Roles de lectura y captura: ver **Decisiones abiertas**.

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/?estado=pendiente` | Lista con número de archivos, nota, quién y cuándo |
| `GET` | `/:id` | Detalle con sus archivos (id, tipo, tamaño, orden) |
| `GET` | `/:id/archivos/:idArchivo` | Stream del archivo con su `Content-Type` y `Cache-Control: private` |
| `POST` | `/:id/descartar` | `{ motivo }` obligatorio, solo desde `pendiente` |

**No hay endpoint de captura en el Worker** (ver 4.1).

### 2.5 Cron

En el `0 6 * * *` existente: borrar de R2 y de la BD los tickets en
`borrador` con más de 24 h (subidas abandonadas).

### 2.6 Tests (`tests/tickets.test.js`)

- Rechaza un JPEG disfrazado de PDF y al revés (magic bytes).
- Un usuario que no es `ceo` recibe 403 al crear o subir.
- No se puede subir a un ticket ajeno ni a uno que ya no está en `borrador`.
- Duplicado → 409; con `?forzar=1` se acepta.
- `enviar` sin archivos → 400.

## 3. PWA (`disfruleg-bodega/public`)

### 3.1 `js/modules/tickets.js` (módulo Alpine nuevo, registrado en `bodega.js`)

- **Botón "Subir ticket"**, junto a los FAB existentes (`index.html` ~l.377),
  visible solo con `session.rol === 'ceo'` y en todas las pestañas.
- Un `<input type="file" accept="image/*,application/pdf" multiple>` ofrece
  cámara, fototeca y archivos en iOS y Android.
- **Compresión en el cliente:** `createImageBitmap(file, { imageOrientation: 'from-image' })`
  → canvas con lado mayor de 1600 px → `toBlob('image/jpeg', 0.8)`. Corrige la
  rotación EXIF y convierte HEIC a JPEG. Los PDF se suben tal cual.
- **Hoja de subida:** miniaturas de lo elegido, botón "+ otra foto", nota
  opcional de una línea y "Enviar".
- **Flujo:** `POST /api/tickets` → un `POST /:id/archivos` por archivo, con
  progreso → `POST /:id/enviar`.
- **Errores:**
  - sin red: mensaje claro y los archivos siguen en la hoja para reintentar;
  - 409: "Este ticket ya se subió el {fecha} — ¿subir de todos modos?".
- **Contador en la pestaña de inicio:** "N tickets pendientes de capturar"
  (desde `/mios`).

### 3.2 Build

`npm run build` (Tailwind + bundle de JS) y `npm run deploy`.

## 4. Electron (`disfruleg-electron`)

### 4.0 El flujo, como lo ve el capturista

```
Registro de compras
┌──────────────────────────────────────────────────────────┐
│  3 tickets sin capturar                          [ Ver ] │
└──────────────────────────────────────────────────────────┘
        │ clic
        ▼
Bandeja: miniatura · subido por · hace cuánto · nota · [Capturar] [Descartar]
        │ Capturar
        ▼
┌─────────────────────────┬────────────────────────────────┐
│  VISTA PREVIA           │  Proveedor · Fecha · Folio     │ ← una vez por ticket
│  (zoom, girar,          │  Total del ticket: $______     │
│   foto 1/2 ◂ ▸,         │ ────────────────────────────── │
│   o el PDF)             │  [Individual | Lote]           │ ← el formulario de hoy
│                         │  producto · cantidad · precio  │
│                         │ ────────────────────────────── │
│                         │  Ya capturado de este ticket:  │
│                         │   Jitomate  3 cj   $1,050      │
│                         │   Chile     2 kg     $120      │
│                         │  Suma $1,170 / Total $1,170 ✓  │
│                         │           [ Terminar ticket ]  │
└─────────────────────────┴────────────────────────────────┘
```

- Proveedor, fecha y folio se capturan **una vez** y se heredan a cada producto.
- Individual o lote es la misma pestaña que ya existe; la vista previa se
  queda fija a la izquierda en los dos.
- La lista "Ya capturado de este ticket" permite corregir o borrar una
  compra antes de cerrar (con los modales que ya existen).
- **Terminar ticket:** si la suma cuadra con el total (± tolerancia), se cierra.
  Si no, un modal muestra la diferencia y pide un motivo para cerrar de
  todos modos.
- Salir sin terminar deja el ticket **en captura, a tu nombre**. Al volver, la
  bandeja lo muestra primero ("Continuar").

### 4.1 Main: `compras.handler.ts`

- `compras:crear` y `compras:crearLote` aceptan **`idTicket`** opcional y lo
  guardan en `compra.id_ticket`. Sin `idTicket`, todo sigue igual que hoy.
- Si viene `idTicket`, antes de escribir se valida en la misma transacción:
  `SELECT ... FROM ticket_compra WHERE id=? AND estado='en_captura' AND capturando_por=?`
  (usuario de la sesión). Si no coincide, se rechaza.
- `compras:obtenerRecientes`, `compras:buscar` y
  `compras:obtenerHistorialProducto` agregan `c.id_ticket` al SELECT.

### 4.2 Main: `tickets.handler.ts` (nuevo)

| IPC | Implementación |
|---|---|
| `tickets:listar` | `bodegaClient.get('/api/electron/tickets?estado=pendiente,en_captura')` |
| `tickets:contar` | Para el aviso "N sin capturar" |
| `tickets:archivo` | Nuevo `bodegaClient.getBinary()` (el actual solo parsea JSON). Devuelve `{ tipo, bytes }` al renderer. |
| `tickets:tomar` | `UPDATE ticket_compra SET estado='en_captura', capturando_por=?, inicio_captura=NOW() WHERE id=? AND estado='pendiente'`. Si `affectedRows !== 1`, otro ya lo tomó. Si ya es tuyo y está `en_captura`, se reabre. |
| `tickets:compras` | Las compras con ese `id_ticket` y su suma, para la lista "Ya capturado". |
| `tickets:terminar` | `{ idTicket, idProveedor, fechaTicket, folio, totalTicket, motivoDiferencia? }`. Recalcula la suma **en SQL** desde `compra` (no confía en la del renderer). Si hay descuadre sin motivo, devuelve `{ descuadre }` sin cerrar. Exige al menos una compra ligada. Pasa a `capturado`. |
| `tickets:soltar` | `en_captura` → `pendiente`, solo si no tiene compras ligadas (abrió el equivocado). |
| `tickets:liberar` | Solo `admin`/`ceo`: quita el apartado de un ticket que alguien dejó abierto. Las compras ya ligadas se quedan. |
| `tickets:descartar` | Vía Worker, con motivo. Solo si no tiene compras ligadas. |

La identidad siempre sale de la **sesión** (`requireRole`), no del renderer.
Exponer todo en `preload.js`.

### 4.3 Renderer: Compras

- **`TicketsAviso.tsx`:** franja arriba de `Purchases.tsx`, visible solo si
  hay pendientes: "N tickets sin capturar · Ver". Se refresca al entrar y
  cada 60 s mientras la pantalla está abierta.
- **`TicketsBandeja.tsx`:** miniatura, quién subió, hace cuánto, nota,
  número de fotos. Los tuyos `en_captura` van primero ("Continuar"); los de
  otros se ven como "en captura por X".
- **`TicketVisor.tsx`:** imagen con zoom (rueda y botones), arrastre,
  girar 90° y paginación entre archivos. El PDF va en un `<iframe>` con URL de
  blob, usando el visor de PDF de Chromium que trae Electron. Se revoca la URL
  al desmontar.
- **`TicketCaptura.tsx`:** el layout de 4.0. A la derecha monta los
  componentes **existentes** (`PurchaseForm` o `BatchPurchaseInput` →
  `BatchPurchaseReview`) con proveedor y fecha bloqueados a los del ticket, y
  pasa `idTicket` a `createPurchase`/`createPurchaseBatch`.
- **Historial:** `PurchaseHistoryModal`, `QuickHistory` y las búsquedas
  muestran un ícono en las compras con `id_ticket` que abre el visor.

### 4.4 Tests (`dist-handlers`)

- `tickets:tomar` dos veces con usuarios distintos → el segundo falla.
- `compras:crear` con `idTicket` de un ticket ajeno o ya capturado → rechazo y cero INSERT.
- `tickets:terminar` recalcula la suma desde la BD; con descuadre y sin motivo no cierra.
- `tickets:soltar` y `tickets:descartar` con compras ligadas → rechazo.
- `compras:crear` y `crearLote` **sin** `idTicket` se comportan igual que antes.

## 5. Orden de entrega

| # | Paso | Entrega |
|---|---|---|
| 0 | **Spike (½ día):** `express.raw` bajo `httpServerHandler` en Workers + R2 put/get; PDF de un blob en un `<iframe>` de Electron | Confirma las dos incógnitas técnicas |
| 1 | Migración en producción (a mano) | Tablas listas |
| 2 | Worker: rutas, utils, cron y tests → deploy | Compatible hacia atrás: nada lo usa aún |
| 3 | PWA: botón de subida → deploy | **Los CEOs empiezan a subir tickets ya**, aunque Electron todavía no los muestre |
| 4 | Electron: `idTicket` en compras, `tickets.handler`, aviso, bandeja, visor, captura e historial → versión nueva | Se captura con vista previa |

El paso 3 antes del 4 es a propósito: se junta una muestra de **tickets
reales** (tipo, calidad de foto, cuántos son PDF), y eso es lo que
dimensiona la Fase 2.

## 6. Cómo sabremos si funciona

```sql
-- Adopción: ¿qué parte de las compras ya trae ticket?
SELECT DATE_FORMAT(fecha_registro, '%Y-%u') AS semana,
       COUNT(*) AS compras,
       SUM(id_ticket IS NOT NULL) AS con_ticket
  FROM compra
 WHERE fecha_registro >= '2026-10-01'
   AND (notas IS NULL OR notas NOT LIKE 'PHANTOM:%')
 GROUP BY semana ORDER BY semana;

-- Rezago: ¿cuánto tarda un ticket en capturarse? (afecta stock y PHANTOM)
SELECT AVG(TIMESTAMPDIFF(HOUR, fecha_subida, fecha_captura)) AS horas_promedio
  FROM ticket_compra WHERE estado = 'capturado';
```

Además, cuántas capturas terminan con `diferencia_aceptada`: es el indicador
más directo de errores atrapados.

## 7. Decisiones abiertas

1. **¿Quién captura en Electron?** Propuesta: los mismos roles que hoy
   registran compras. Liberar el ticket que dejó abierto otra persona: solo `admin`/`ceo`.
2. **Tolerancia del cuadre:** propuesta ±$1, por redondeos de IVA.
3. **¿Se permite subir desde Electron** (arrastrar un PDF que llegó por
   correo), también solo para `ceo`? Es poco trabajo extra sobre el mismo endpoint.
4. **Retención:** propuesta, indefinida (es evidencia de compra). R2 cobra
   ~$0.015 USD por GB al mes; 10 000 tickets de 0.5 MB son ~5 GB.

## 8. Deuda que se detectó (no se toca en esta fase)

- **Dos lógicas distintas de alta de compra:** `POST /api/entradas` (PWA)
  concilia PHANTOM y Electron usa `rellenarLineasSinCosto` más el reconsumo.
  Pueden dar resultados distintos para la misma compra. Conviene unificarlas
  cuando las compras entren a H-5.
- **`compras:crear` y `crearLote` reciben `usuario` desde el renderer**
  (`user?.username`). Con los tickets validan el apartado contra el usuario
  de la sesión, pero `usuario_registro` sigue saliendo del renderer. Debería
  salir de la sesión también (mismo criterio que el fix C-3). Es un cambio
  chico y se puede meter en esta fase si lo apruebas.

## 9. Cómo quedó al implementar (26 sep 2026)

Cambios contra lo planeado arriba:

- **Todas las transiciones del ticket viven en el Worker** (`/tomar`,
  `/soltar`, `/liberar`, `/terminar`, `/descartar` en
  `routes/electron/tickets.js`), no en SQL de Electron. Electron solo agrega
  `idTicket` a `compras:crear` / `compras:crearLote`, que validan con
  `SELECT … FOR UPDATE` que el ticket esté `en_captura` a nombre del usuario
  **de la sesión**.
- **PDF con pdf.js, no con `<iframe>`.** Con la CSP de la ventana principal
  (`object-src 'none'`) el visor de PDF de Chromium sale en blanco; se probó
  también `object-src blob:` sin éxito. pdf.js convierte cada página a
  imagen y no obliga a tocar la CSP. Va en `devDependencies` (Vite lo
  empaqueta) y se carga solo cuando hay un PDF.
- **Rueda del mouse en el visor:** Ctrl/Cmd + rueda (o pellizco) hace zoom;
  la rueda sola mueve el ticket si está ampliado y si no, desplaza la página.
- **Formulario individual con ticket abierto:** oculta su propio proveedor y
  fecha (se capturan una vez en la barra del ticket). En el historial, las
  compras de un mismo ticket se agrupan juntas y llevan un botón "Ticket".
- **Bug corregido de paso:** `compras:crearLote` no revisaba el resultado de
  `ejecutarTransaccion` (que no lanza, devuelve `{ success: false }`), así
  que una fila con rollback se contaba como exitosa.

Verificado: 25 tests nuevos del Worker (391 en total) y 6 nuevos en
Electron (183 en total); subida real en `wrangler dev` con R2 local (archivo
idéntico por SHA-256); PWA y pantalla de Compras probadas en navegador con
el API simulado (subida, duplicado, bandeja, captura, cuadre, historial,
temas claro y oscuro).

**Pendiente para desplegar**, en este orden:

1. `npx wrangler r2 bucket create disfruleg-tickets`
2. Correr `db/migrations/ticket_compra.sql` en TiDB (un statement por Run)
3. Worker: `npm run deploy` (Node 22)
4. Electron: versión nueva con el flujo de siempre

Limitaciones conocidas:

- Al **pausar** una captura, el total y el folio que no se hayan terminado no
  se guardan: se capturan de nuevo al continuar.
- Las compras se registran **sin IVA** (así está hoy la app). Un ticket con
  IVA desglosado no va a cuadrar y pedirá motivo; los de fruta y verdura
  (tasa 0 %) no tienen ese problema.
