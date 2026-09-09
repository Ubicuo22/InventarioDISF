-- dispositivos_eventos — Fase 2 de H-5 (identidad y control de acceso).
--
-- NOTA (2026-09-09): esta tabla YA EXISTÍA en la TiDB de producción antes de
-- este trabajo — vacía (0 filas), de una versión anterior sin ningún código
-- actual escribiéndole (solo aparecía mencionada en DOCUMENTACION_DEFINITIVA_BD.md,
-- que ya se sabía desactualizada). Se confirmó con un SELECT antes de escribir
-- nada. En vez de forzar el esquema que se había planeado originalmente sobre
-- una tabla real, routes/electron/dispositivos.js se adaptó a este esquema tal
-- cual — es, de hecho, mejor: estado_anterior/estado_nuevo capturan la
-- transición completa, no solo una palabra de evento. usuario_admin guarda el
-- username (string, del JWT), no un ID.
--
-- Este archivo documenta el esquema real, para que quede como referencia
-- correcta — no crea nada nuevo (CREATE TABLE IF NOT EXISTS es un no-op aquí).

CREATE TABLE IF NOT EXISTS dispositivos_eventos (
  id_evento         INT AUTO_INCREMENT PRIMARY KEY,
  id_dispositivo    INT          NOT NULL,
  device_id         VARCHAR(255) NOT NULL,
  estado_anterior   VARCHAR(50)  DEFAULT NULL,
  estado_nuevo      VARCHAR(50)  NOT NULL,
  razon             VARCHAR(255) DEFAULT NULL,
  usuario_admin     VARCHAR(100) DEFAULT NULL,
  fecha_evento      DATETIME     DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_dispositivo (id_dispositivo),
  INDEX idx_device_id   (device_id),
  INDEX idx_estado_nuevo (estado_nuevo),
  INDEX idx_usuario_admin (usuario_admin),
  INDEX idx_fecha_evento  (fecha_evento)
)
