// Composición del store Alpine.js.
// Orden de spread: ui → auth → inventory → entries → orders → history → mermas → notifications → analytics → admin
// Las dependencias implícitas entre módulos se resuelven en el objeto merged:
//   auth.js          llama: resetForm (entries), cargarProductos/cargarResumen/cargarProveedores (inventory), mostrarToast (ui), initPush (notifications)
//   entries.js       lee:   productos (inventory), llama: filtrar/cargarResumen (inventory), mostrarToast (ui)
//   orders.js        lee:   pedidosTab (ui), llama: mostrarToast (ui)
//   history.js       llama: mostrarToast (ui)
//   mermas.js        llama: cargarProductos/cargarResumen (inventory), mostrarToast (ui)
//   notifications.js llama: mostrarToast (ui), API (global)
//   analytics.js     llama: mostrarToast (ui), fmtFecha (history), API (global)
//   admin.js         llama: mostrarToast (ui), API (global)
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
  }
}
