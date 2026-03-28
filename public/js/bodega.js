// Composición del store Alpine.js.
// Orden: ui → auth → inventory → entries → orders → history → mermas → notifications → analytics → admin → cobranza
function bodega() {
  return {
    ...uiModule(),
    ...authModule(),
    ...inventoryModule(),
    ...entriesModule(),
    ...ordersModule(),
    ...historyModule(),
    ...mermasModule(),
    ...notificationsModule(),
    ...analyticsModule(),
    ...adminModule(),
    ...cobranzaModule(),
  }
}
