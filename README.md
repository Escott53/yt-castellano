# YT Castellano (PWA)

Doblaje aproximado en español de vídeos de YouTube: pegas el enlace y **oyes una voz TTS en español** del contenido hablado. Los subtítulos/transcripción son solo la fuente interna (traducción → voz); el texto en pantalla es opcional y viene **desactivado**. Por defecto el audio original va **silenciado**.

**Uso educativo / personal.** No descarga ni redistribuye el media de YouTube; depende de las pistas de subtítulos públicas y del reproductor iframe oficial. No redistribuir contenidos de terceros.

## Demo

- GitHub Pages: https://escott53.github.io/yt-castellano/
- Ejemplo: `?v=iG9CE55wbtY` (TED — Sir Ken Robinson)

## Qué funciona (oct 2026)

| Pieza | Origen elegido |
| --- | --- |
| Subtítulos | `https://youtubegpt.ai/api/transcript?v=…&lang=es` (CORS `*`). Preferimos pista ES ya traducida por YouTube. |
| Reserva | Cloudflare Worker opcional (`worker/caption-proxy.js`) vía Innertube ANDROID. |
| Sin subtítulos | Pegar transcripción manual (SRT / `[mm:ss] texto`). |
| Traducción extra | Si solo hay EN: `clients5.google.com/translate_a/t` (CORS `*`), luego MyMemory. Caché en `localStorage`. |
| Voz | `speechSynthesis` con voz `es-ES` si el sistema la tiene. |
| Vídeo | YouTube IFrame Player API + `setVolume` para ducking/mute. |

## Limitaciones

- Retraso típico **1–3 s** respecto al habla original (cola TTS + anticipación).
- Sin subtítulos disponibles → no hay doblaje automático.
- Calidad TTS = voces del sistema/navegador; en pestaña en segundo plano el navegador puede pausar `speechSynthesis`.
- Orígenes públicos de subtítulos pueden rate-limitar o cambiar; configura un Worker propio en Ajustes si hace falta.
- Instalación PWA en Android a veces falla (limitación conocida); la web en Chrome funciona.

## Local

```bash
cd app-doblaje
python3 -m http.server 8080
# http://localhost:8080
```

Tras cambiar estáticos, sube `CACHE_VERSION` en `sw.js`.

## Worker opcional

```bash
cd worker
npx wrangler deploy
# pega la URL https://….workers.dev en Ajustes → Proxy
```
