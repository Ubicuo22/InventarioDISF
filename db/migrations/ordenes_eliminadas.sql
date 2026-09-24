-- ordenes_eliminadas — papelera de notas guardadas (24 sep 2026).
--
-- Antes, "Eliminar" en Electron hacía un DELETE real de ordenes_guardadas:
-- no quedaba ni la nota, ni quién la eliminó, ni cuándo, y la única forma de
-- recuperarla era un PITR de TiDB. Ahora DELETE /api/electron/ordenes/:folio
-- copia la fila completa aquí (`orden`, JSON) antes de borrarla; se puede
-- restaurar durante 7 días desde Notas › Eliminadas, y el cron de las 06:00
-- UTC (worker.js) borra definitivamente las que pasan de 7 días.
--
-- El Worker no corre bootstrap de tablas: crear a mano en producción antes
-- del deploy (sin la tabla, eliminar falla y la nota NO se borra).

CREATE TABLE IF NOT EXISTS ordenes_eliminadas (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  folio_numero       INT           NOT NULL,
  id_cliente         INT           DEFAULT NULL,
  total_estimado     DECIMAL(10,2) DEFAULT NULL,
  orden              JSON          NOT NULL,
  eliminado_por      VARCHAR(100)  NOT NULL,
  autorizado_por     VARCHAR(50)   DEFAULT NULL,
  fecha_eliminacion  DATETIME      NOT NULL DEFAULT NOW(),
  INDEX idx_fecha (fecha_eliminacion),
  INDEX idx_folio (folio_numero)
)
