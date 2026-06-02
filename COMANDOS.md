# Comandos del proyecto

## Producción — reflejar cambios en la app

```bash
npm run deploy
```

Hace todo en un paso: compila el CSS, reinicia el servidor. Listo.

---

## Desarrollo local (modo dev)

```bash
npm run dev
```

El script limpia el puerto automáticamente antes de arrancar. No hace falta detener nada manualmente.

Cuando termines de desarrollar, vuelve a producción con:

```bash
npm run deploy
```

---

## Otros comandos útiles

| Comando | Qué hace |
|---|---|
| `npm run build:css` | Compila Tailwind → `tailwind.min.css` (necesario si agregaste clases nuevas) |
| `npm run watch:css` | Compila CSS en modo watch mientras desarrollas |
| `tail -f logs/server.log` | Ver logs del servidor de producción en tiempo real |

---

## Error común

❌ `npx run dev` → **incorrecto** (instala un paquete externo que no sirve)

✅ `npm run dev` → **correcto**
