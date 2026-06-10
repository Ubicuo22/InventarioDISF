// Composición del store Alpine.js.
// Orden: ui → auth → inventory → entries → orders → review → history → mermas → notifications → analytics → admin → cobranza → compras → dashboard → pendientes
function bodega() {
  return {
    ...uiModule(),
    ...authModule(),
    ...inventoryModule(),
    ...entriesModule(),
    ...ordersModule(),
    ...reviewModule(),
    ...historyModule(),
    ...mermasModule(),
    ...notificationsModule(),
    ...analyticsModule(),
    ...adminModule(),
    ...cobranzaModule(),
    ...comprasModule(),
    ...dashboardModule(),
    ...pendientesModule(),
  }
}
