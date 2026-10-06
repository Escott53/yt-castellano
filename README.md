# YT Castellano (PWA)

Doblaje aproximado en español de vídeos de YouTube: pegas el enlace y **oyes una voz TTS en español** del contenido hablado. Los subtítulos/transcripción son solo la fuente interna (traducción → voz); el texto en pantalla es opcional y viene **desactivado**. Por defecto el audio original va **silenciado**.

**Uso educativo / personal.** No descarga ni redistribuye el media de YouTube; depende de las pistas de subtítulos públicas y del reproductor iframe oficial. No redistribuir contenidos de terceros.

## Demo

- **Repo:** https://github.com/Escott53/yt-castellano
- **GitHub Pages (objetivo):** https://escott53.github.io/yt-castellano/
- Ejemplo: `?v=iG9CE55wbtY` (TED — Sir Ken Robinson)
- Local: `python3 -m http.server 8080` en esta carpeta

## Qué funciona (oct 2026)

| Pieza | Origen elegido |
| --- | --- |
| Subtítulos | `https://youtubegpt.ai/api/transcript?v=…&lang=es` (CORS `*`). Preferimos pista ES ya traducida por YouTube. |
| Reserva | Cloudflare Worker opcional (`worker/caption-proxy.js`) vía Innertube ANDROID. |
| Sin subtítulos | Pegar transcripción manual (SRT / `[mm:ss] texto`). |
| Traducción extra | Si solo hay EN: `clients5.google.com/translate_a/t` (CORS `*`), luego MyMemory. Caché en `localStorage`. |
| Voz | `speechSynthesis` `lang=es-ES` (en Android sin fijar `utterance.voice`; en escritorio voz es-ES concreta con reintento sin ella). Se desbloquea con el toque en «▶ Reproducir con voz». |
| Vídeo | YouTube IFrame Player API + `setVolume` para ducking/mute. |

## Robustez de la voz (v4)

- La voz se **desbloquea con un gesto** (Abrir / «▶ Reproducir con voz» / cualquier toque si el navegador devolvió `not-allowed`).
- Cola de doblaje con puntero monótono: cada frase se encola **una vez** al pasar su inicio; reinicio solo en seek. Nunca `cancel()+speak()` en el mismo tick; frases ≤ 200 caracteres; keepalive `resume()`; temporizadores de seguridad si no llega `onstart`/`onend`.
- Si la pista pedida (`es`) no existe, la API devuelve otra (p. ej. inglés automático): se detecta por `track.language` y se **traduce** (clients5 por lotes → gtx → MyMemory).
- El audio original **solo se silencia** cuando hay frases en español listas y la voz funciona; si no, suena el original y la línea de estado explica el motivo.
- Ajustes › **Probar voz** dice una frase de prueba y muestra la voz detectada.
- Tests: `tools/e2e-dub.js <url> <videoId>` y `tools/e2e-dub-edge.js <url>` (Chromium headless, tamaño móvil, motor TTS simulado tipo Android).

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
