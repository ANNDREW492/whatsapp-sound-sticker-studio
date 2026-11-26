# WhatsApp Sound Sticker Studio
https://whatsapp-sound-sticker-studio.onrender.com

Herramienta web para crear **stickers con audio en WhatsApp** a partir de videos cortos (`MP3`, `M4A`, `WAV`, `OGG`) y enviarlos directamente a tu propio chat personal

> Fué diseñado bajo el principio de **privacidad estricta**: no lee mensajes, no escucha grupos ni responde a terceros. Cada persona se envía los stickers únicamente a sí misma.


## Requisitos

- [Deno](https://deno.com/) 2.x
- [FFmpeg](https://ffmpeg.org/) (incluyendo `ffprobe`) disponible en el `PATH`
en el powershell puedes simplemente copiar:
```powershell
winget install DenoLand.Deno
winget install Gyan.FFmpeg
```
---
y ya les funcionará el archivo .bat

## TUTORIAL RAPIDO

### 1. En tu propia PC
En Windows, haz doble clic en `iniciar.bat` o ejecuta:

```powershell
$env:PERSIST_LOCAL_SESSION="true"
deno task start
```

Abre `http://127.0.0.1:3000`, haz clic en **Conectar WhatsApp**, escanea el QR y sube tu primer video.

### 2. Compartido con miembros de tu grupo (Modo Multi-sesión efímera)

#### Opción A — Desde tu PC por horarios con Cloudflare Tunnel (también gratis)
1. Inicia el servidor en modo multi-sesión (puedes ponerle una clave para tu grupo):
   ```powershell
   $env:PERSIST_LOCAL_SESSION="false"
   $env:ACCESS_CODE="clave-de-tu-grupo"
   deno task start
   ```
   *(O usa `iniciar-compartido.bat` sin clave).*
2. En otra terminal, crea un túnel HTTPS temporal con [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/):
   ```powershell
   cloudflared tunnel --url http://127.0.0.1:3000
   ```
3. Comparte la URL `https://....trycloudflare.com` (y tu `ACCESS_CODE` si pusiste una) con tu grupo. Cada persona vincula su propio WhatsApp, genera sus stickers y al terminar toca **Desvincular y borrar**.

#### Opción B — En la nube con Docker (Fly.io, Railway, Render, VPS)
```bash
docker build -t whatsapp-sound-stickers .
docker run -p 3000:3000 \
  -e ACCESS_CODE="clave-de-tu-grupo" \
  -e MAX_SESSIONS=12 \
  -e SESSION_TTL_MIN=10 \
  whatsapp-sound-stickers
```

---

## Variables de entorno

| Variable | Por defecto | Descripción |
| :--- | :--- | :--- |
| `HOST` | `127.0.0.1` (`0.0.0.0` en Docker) | Interfaz de red donde escucha el servidor |
| `PORT` | `3000` | Puerto HTTP |
| `PERSIST_LOCAL_SESSION` | `false` | `false` = multi-sesión efímera en RAM; `true` = sesión local única en `./auth_info` |
| `ACCESS_CODE` | *(vacío)* | Si se define, pide esta clave antes de usar la web |
| `MAX_SESSIONS` | `12` | Máximo de sesiones activas simultáneas en modo efímero |
| `SESSION_TTL_MIN` | `10` | Minutos de inactividad antes de desvincular y borrar una sesión temporal |
| `MAX_CONCURRENT_FFMPEG` | `2` | Límite de conversiones FFmpeg en paralelo (el resto hace cola) |

---

## Pruebas técnicas

Verifica tipos, la codificación Protobuf de `audioStickerMessage` (campo `134` directo y dentro de `deviceSentMessage`) y el pipeline real de FFmpeg:

```bash
deno task verify
```

---

## Estructura del proyecto

- `src/server.ts` — Servidor HTTP, cookies de sesión, clave de acceso y cola de FFmpeg
- `src/whatsapp.ts` — Gestor multi-sesión efímera en memoria y envío estricto al chat personal (`selfJid`)
- `src/soundStickerProto.ts` — Parche Protobuf (`Message.audioStickerMessage = 134`) para Baileys
- `src/media.ts` — Conversión FFmpeg a WebP `512×512` (con EXIF) y audio `Opus/OGG`
- `public/` — Interfaz web (`index.html`, `styles.css`, `app.js`)
- `tests/verify.ts` — Pruebas de codificación Protobuf y conversión multimedia

---

