# Tunnel temporal desde MacBook — 2026-06-02

## Qué se hizo

La Mac Mini no estaba accesible, así que se levantó la app desde el MacBook
usando un **nuevo tunnel de Cloudflare** para mantener `disfruleg.ubicuo.icu` funcionando.

### Pasos realizadåos en el MacBook

1. Se autenticó `cloudflared` con el cert de la cuenta (`~/.cloudflared/cert.pem`).
2. Se creó un tunnel nuevo llamado **disfruleg-macbook** (ID: `4eaf2756-c4fc-4f56-ba1f-03438a33c0c0`).
3. Se redirigió el DNS de `disfruleg.ubicuo.icu` al nuevo tunnel con `--overwrite-dns`.
4. Se creó config en `~/.cloudflared/config-bodega.yml` apuntando a `localhost:3030`.
5. Se levantó el servidor (`npm start`) y el tunnel (`cloudflared tunnel run`).

## Qué hacer al volver a la Mac Mini

### 1. Devolver el DNS al tunnel original

```bash
cloudflared tunnel route dns --overwrite-dns disfruleg-bodega disfruleg.ubicuo.icu
```

### 2. Verificar que el tunnel original esté corriendo

```bash
# Si usa launchctl:
launchctl load ~/Library/LaunchAgents/icu.ubicuo.disfruleg-bodega.plist

# O manualmente:
cloudflared tunnel --config ~/.cloudflared/config.yml run
```

### 3. (Opcional) Eliminar el tunnel temporal del MacBook

Desde cualquier máquina autenticada:

```bash
cloudflared tunnel delete disfruleg-macbook
```

## Datos de referencia

| Concepto | Valor |
|---|---|
| Tunnel original (Mac Mini) | `disfruleg-bodega` — `76c19a63-1426-485f-93d4-1d60ba123421` |
| Tunnel temporal (MacBook) | `disfruleg-macbook` — `4eaf2756-c4fc-4f56-ba1f-03438a33c0c0` |
| Dominio | `disfruleg.ubicuo.icu` |
| Puerto app | `3030` |
