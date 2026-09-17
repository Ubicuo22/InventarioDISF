-- margen_historico_revertido — preserva el margen real (venta/costo/ganancia)
-- de una venta que se revierte, antes de que revertir-procesamiento borre
-- factura/detalle_factura/detalle_venta_lote (routes/electron/ordenes.js,
-- handler POST /revertir-procesamiento/:folio).
--
-- Sin esto, una nota revertida pierde para siempre su costo real de compra
-- al momento de la venta: precios:margenFactura (disfruleg-electron) deja de
-- encontrar la factura y cae al costo PEPS PROMEDIO ACTUAL, que puede diferir
-- mucho del costo real si hubo compras nuevas entre la venta original y la
-- reversión — mostrando una "comparativa" engañosa para notas viejas.
--
-- datos_lineas guarda el mismo shape de fila crudo que ya usa la query de
-- precios:margenFactura (detalle_factura + producto + detalle_venta_lote
-- agregado) — así el cliente puede reusar exactamente la misma lógica de
-- formateo (margenLinea) sobre datos archivados en vez de datos en vivo.
--
-- El Worker de Cloudflare no corre bootstrap de tablas al arrancar — esta
-- tabla necesita crearse a mano en la TiDB de producción antes de desplegar
-- el cambio en ordenes.js que le hace INSERT.

CREATE TABLE IF NOT EXISTS margen_historico_revertido (
  id_snapshot             INT AUTO_INCREMENT PRIMARY KEY,
  folio_numero            INT NOT NULL,
  fecha_factura_original  DATE NOT NULL,
  fecha_reversion         DATETIME DEFAULT CURRENT_TIMESTAMP,
  admin_usuario           VARCHAR(100) DEFAULT NULL,
  datos_lineas            JSON NOT NULL,
  INDEX idx_folio (folio_numero),
  INDEX idx_fecha_reversion (fecha_reversion)
)
