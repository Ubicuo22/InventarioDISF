-- electron_sesiones — Fase 0 de H-5 (migración de disfruleg-electron fuera
-- del cliente pesado). Espejo de bodega_sesiones (server.js) pero con
-- namespace propio para no colisionar con `sesiones_activas`, que ya
-- pertenece a Disfruleg Electron con un schema distinto — mismo motivo por
-- el que bodega_sesiones se separó de esa tabla en su momento.
--
-- device_id es nuevo respecto a bodega_sesiones: permite, en fases futuras,
-- invalidar todas las sesiones de un dispositivo específico sin afectar a
-- los demás dispositivos del mismo usuario.
--
-- El Worker de Cloudflare (worker.js) no corre el bootstrap de tablas que sí
-- corre server.js al arrancar en la Mac Mini — esta tabla no existe todavía
-- en la TiDB de producción y necesita crearse a mano antes de que
-- routes/electron/auth.js pueda insertar sesiones exitosamente.

CREATE TABLE IF NOT EXISTS electron_sesiones (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  jti         VARCHAR(36)  NOT NULL UNIQUE,
  id_usuario  INT          NOT NULL,
  device_id   VARCHAR(255) DEFAULT NULL,
  ip          VARCHAR(45)  DEFAULT '',
  user_agent  VARCHAR(255) DEFAULT '',
  fecha_login DATETIME     DEFAULT NOW(),
  ultimo_uso  DATETIME     DEFAULT NOW(),
  activo      TINYINT      DEFAULT 1,
  INDEX idx_activo   (activo),
  INDEX idx_usuario  (id_usuario)
)
