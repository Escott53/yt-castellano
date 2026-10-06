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

## Robustez de la voz (v4, se mantiene en v5)

- La voz se **desbloquea con un gesto** (Abrir / «▶ Reproducir con voz» / cualquier toque si el navegador devolvió `not-allowed`).
- Cola de doblaje con puntero monótono: cada frase se encola **una vez** al pasar su inicio; reinicio solo en seek. Nunca `cancel()+speak()` en el mismo tick; frases ≤ 200 caracteres; keepalive `resume()`; temporizadores de seguridad si no llega `onstart`/`onend`.
- Si la pista pedida (`es`) no existe, la API devuelve otra (p. ej. inglés automático): se detecta por `track.language` y se **traduce** (clients5 por lotes → gtx → MyMemory).
- El audio original **solo se silencia** cuando hay frases en español listas y la voz funciona; si no, suena el original y la línea de estado explica el motivo.
- Ajustes › **Probar voz** dice una frase de prueba y muestra la voz detectada.
- Tests: `tools/e2e-dub.js <url> <videoId>` y `tools/e2e-dub-edge.js <url>` (Chromium headless, tamaño móvil, motor TTS simulado tipo Android).

## Modo micrófono (v5) — Instagram, Facebook y otras apps

Para vídeos sin subtítulos accesibles: el vídeo suena **en voz alta** (en el mismo móvil o en otro dispositivo), la app lo **escucha por el micrófono**, reconoce el habla, la traduce y la **dice en español**.

- Inicio › **Modo micrófono** (o `?micro=1`). Botón grande Empezar/Parar, idioma del vídeo (en-US, en-GB, fr-FR, it-IT, pt-PT, de-DE), velocidad de voz (el mismo ajuste que el doblaje), texto en pantalla opcional (desactivado por defecto).
- `SpeechRecognition`/`webkitSpeechRecognition` con `continuous` + `interimResults`. Cada resultado **final** pasa por la misma traducción (`translateBatch`: clients5 → gtx → MyMemory) y se dice con las mismas primitivas TTS (desbloqueo con el toque, `lang=es-ES` sin forzar voz en Android, retraso tras `cancel()`, trozos ≤ 200, keepalive, temporizadores de seguridad).
- **Sin realimentación:** antes de hablar se hace `stop()` del reconocimiento (entrega lo ya oído) y se espera a `onend`; se reanuda 350 ms después de que la voz calle. Si suena cualquier otra voz (p. ej. Probar voz) con el micro abierto, `abort()`. Resultados que lleguen mientras suena la voz se descartan.
- **Auto-reinicio** en `onend` mientras el modo está activo, con backoff: silencio (`no-speech`) 300 ms → 1,5 s máx.; fallos rápidos 0,5 → 8 s; `network` 2 → 15 s. Frases interminables sin final se cierran a los 7 s para traducir lo oído. Duplicados de Chrome Android filtrados.
- Errores en español: permiso denegado (`not-allowed`), servicio no permitido, idioma no soportado, sin voz, sin red (el reconocimiento de Chrome necesita internet), micrófono ocupado, navegador sin soporte.
- Bloqueo de pantalla (`navigator.wakeLock`) mientras escucha, para que el móvil no se apague y Chrome no se suspenda.
- Test: `node tools/e2e-mic.js http://127.0.0.1:8765/ 5` (reconocimiento simulado `tools/fake-sr.js` tipo Android + TTS simulado).

### Limitaciones del modo micrófono (honestas)

- **Retraso 3–5 s** (fin de frase + traducción + voz). Mientras habla la voz española el micrófono está en pausa: lo que se diga en ese momento se pierde.
- **Android y foco de audio:** al arrancar el reconocimiento, Chrome Android pide el foco de audio y **otras apps pueden pausar o bajar su vídeo** (comportamiento documentado de Chrome Android con vídeos; depende de la app y del móvil). Como se reinicia tras cada frase, puede repetirse. Si pasa, la opción fiable es reproducir el vídeo en **otro dispositivo** (tablet/PC/TV) y escuchar con el móvil.
- Si Chrome pasa a **segundo plano** o se apaga la pantalla, deja de escuchar. **Pantalla dividida** mantiene Chrome visible (recomendado). La ventana flotante también, si el móvil la ofrece.
- El reconocimiento de Chrome usa los servidores de Google: **necesita internet**. En algunos Android suena un **pitido** cada vez que el micrófono se reactiva.
- Música de fondo, varias voces o audio flojo empeoran mucho el reconocimiento. Sin auriculares en el dispositivo que reproduce el vídeo.
- `SpeechRecognition.start(audioTrack)` (reconocer el audio de una pista sin micrófono) y el reconocimiento en el dispositivo no existen en Chrome Android (solo escritorio), así que el micrófono es la única vía.

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
