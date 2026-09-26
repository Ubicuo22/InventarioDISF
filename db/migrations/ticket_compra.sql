-- ticket_compra — foto/PDF del ticket original de una compra (26 sep 2026).
--
-- Había errores al capturar compras (precios, cantidades) y ninguna
-- evidencia contra la cual revisarlas. Un CEO sube el ticket desde la PWA,
-- queda en una bandeja y el capturista lo registra en Electron con la vista
-- previa al lado. Ver docs/PLAN-TICKETS-COMPRA.md.
--
-- Estados:
--   borrador   → creado, subiendo archivos. Invisible; el cron de las 06:00
--                UTC borra los que pasan de 24 h (subidas abandonadas).
--   pendiente  → en la bandeja, esperando captura
--   en_captura → apartado para `capturando_por`; sus compras ya se ligan
--   capturado  → cerrado con cuadre contra `total_ticket`
--   descartado → duplicado, ilegible o no era compra (el archivo se conserva)
--
-- Collation: en producción estas tablas quedaron con utf8mb4_unicode_ci
-- (default del editor de TiDB), distinta de usuarios_sistema.username
-- (utf8mb4_0900_ai_ci). Todo JOIN de texto contra tablas viejas necesita
-- COLLATE utf8mb4_0900_ai_ci — ver routes/electron/tickets.js.
--
-- El Worker no corre bootstrap de tablas: crear a mano en producción antes
-- del deploy, un statement por Run en el editor de TiDB.

CREATE TABLE IF NOT EXISTS ticket_compra (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  estado              VARCHAR(20)   NOT NULL DEFAULT 'borrador',
  nota                VARCHAR(255)  DEFAULT NULL,
  subido_por          VARCHAR(100)  NOT NULL,
  fecha_subida        DATETIME      NOT NULL DEFAULT NOW(),
  capturando_por      VARCHAR(100)  DEFAULT NULL,
  inicio_captura      DATETIME      DEFAULT NULL,
  id_proveedor        INT           DEFAULT NULL,
  fecha_ticket        DATE          DEFAULT NULL,
  folio               VARCHAR(50)   DEFAULT NULL,
  total_ticket        DECIMAL(12,2) DEFAULT NULL,
  -- suma capturada − total del ticket, solo cuando se cerró descuadrado
  diferencia_aceptada DECIMAL(12,2) DEFAULT NULL,
  motivo_diferencia   VARCHAR(255)  DEFAULT NULL,
  capturado_por       VARCHAR(100)  DEFAULT NULL,
  fecha_captura       DATETIME      DEFAULT NULL,
  descartado_por      VARCHAR(100)  DEFAULT NULL,
  fecha_descarte      DATETIME      DEFAULT NULL,
  motivo_descarte     VARCHAR(255)  DEFAULT NULL,
  -- Fase 2: lo que sugirió la IA, para medir cuánto corrige el capturista
  sugerencia_json     JSON          DEFAULT NULL,
  INDEX idx_estado (estado, fecha_subida)
);

CREATE TABLE IF NOT EXISTS ticket_compra_archivo (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  id_ticket    INT          NOT NULL,
  orden        TINYINT      NOT NULL DEFAULT 1,
  r2_key       VARCHAR(200) NOT NULL,
  tipo         VARCHAR(50)  NOT NULL,
  tamano       INT          NOT NULL,
  sha256       CHAR(64)     NOT NULL,
  fecha_subida DATETIME     NOT NULL DEFAULT NOW(),
  INDEX idx_ticket (id_ticket),
  INDEX idx_sha (sha256)
);

ALTER TABLE compra ADD COLUMN IF NOT EXISTS id_ticket INT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_compra_ticket ON compra(id_ticket);
