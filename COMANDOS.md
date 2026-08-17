# Comandos del proyecto

## Producción — reflejar cambios en la app

```bash
npm run deploy
```

Hace todo en un paso: compila CSS + JS y despliega a Cloudflare Workers. Listo.

> Requiere Node.js v22+. Si estás en v20, corre primero: `nvm use 22`

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
| `npx wrangler tail` | Ver logs del Worker en tiempo real (equivalente a tail en producción) |

---

## Error común

❌ `npx run dev` → **incorrecto** (instala un paquete externo que no sirve)

✅ `npm run dev` → **correcto**
