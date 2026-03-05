// Composición del store Alpine.js.
// Orden de spread: ui → auth → inventory → entries → orders → history → mermas
// Las dependencias implícitas entre módulos se resuelven en el objeto merged:
//   auth.js     llama: resetForm (entries), cargarProductos/cargarResumen/cargarProveedores (inventory), mostrarToast (ui)
//   entries.js  lee:   productos (inventory), llama: filtrar/cargarResumen (inventory), mostrarToast (ui)
//   orders.js   lee:   pedidosTab (ui), llama: mostrarToast (ui)
//   history.js  llama: mostrarToast (ui)
//   mermas.js   llama: cargarProductos/cargarResumen (inventory), mostrarToast (ui)
function bodega() {
  return {
    ...uiModule(),
    ...authModule(),
    ...inventoryModule(),
    ...entriesModule(),
    ...ordersModule(),
    ...historyModule(),
    ...mermasModule(),
  }
}
