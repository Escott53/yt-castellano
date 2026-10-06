/* YT Castellano — PWA de doblaje español vía subtítulos + Web Speech API */
(() => {
  'use strict';

  const APP_VERSION = '5';
  const IS_ANDROID = /Android/i.test(navigator.userAgent);
  const CHARS_PER_SEC = 14;      // velocidad aproximada de TTS español a rate 1
  const MAX_UTTERANCE = 200;     // Android/Chrome fallan con frases muy largas

  const STORAGE = {
    settings: 'ytcast-settings-v1',
    recent: 'ytcast-recent-v1',
    translations: 'ytcast-tr-v2',
  };
  try { localStorage.removeItem('ytcast-tr-v1'); } catch { /* */ }

  // ---------- network helpers ----------
  async function fetchJSON(url, timeoutMs = 20000) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctrl?.abort(), timeoutMs);
    try {
      const res = await fetch(url, { credentials: 'omit', signal: ctrl?.signal });
      let data = null;
      try { data = await res.json(); } catch { /* not json */ }
      return { res, data };
    } catch (e) {
      throw codedError(e?.name === 'AbortError' ? 'timeout' : 'network', String(e?.message || e));
    } finally {
      clearTimeout(timer);
    }
  }
  function codedError(code, msg) {
    const e = new Error(msg || code);
    e.code = code;
    return e;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---------- caption sources ----------
  const CAPTION_SOURCES = [
    {
      name: 'youtubegpt.ai',
      async fetch(videoId, lang) {
        const url = `https://youtubegpt.ai/api/transcript?v=${encodeURIComponent(videoId)}&format=json&lang=${encodeURIComponent(lang)}`;
        let res; let data;
        try {
          ({ res, data } = await fetchJSON(url, 20000));
        } catch (e) {
          // Las respuestas de error (404 sin subtítulos, 451 login…) vienen SIN cabecera CORS,
          // así que el navegador solo ve "network error". Sondeamos en modo no-cors:
          // si el servidor contesta, no es un problema de conexión sino del vídeo.
          if (e.code === 'network') {
            let reachable = false;
            try { await fetch(url, { mode: 'no-cors', credentials: 'omit' }); reachable = true; } catch { /* offline */ }
            if (reachable) throw codedError('no_captions_or_blocked', 'El servicio respondió con error');
          }
          throw e;
        }
        if (!res.ok || !data || data.ok === false) {
          const code = data?.code || (res.status === 429 ? 'rate_limited' : `http_${res.status}`);
          throw codedError(code, data?.message || data?.error || `HTTP ${res.status}`);
        }
        const raw = Array.isArray(data.segments) ? data.segments : [];
        if (!raw.length) throw codedError('no_captions', 'Sin segmentos');
        // La API devuelve start/dur en milisegundos; lo comprobamos contra la duración del vídeo.
        const maxStart = Math.max(...raw.map((s) => Number(s.start) || 0));
        const durSec = Number(data.video?.durationSeconds) || 0;
        const looksMs = durSec ? maxStart > durSec + 5 : raw.slice(0, 12).some((s) => Number(s.dur) > 120 || Number(s.start) > 500);
        const div = looksMs ? 1000 : 1;
        return {
          // ¡OJO! si no hay pista en el idioma pedido, la API devuelve la pista por defecto (p. ej. inglés)
          lang: String(data.track?.language || lang),
          generated: !!data.track?.generated,
          title: data.video?.title || '',
          segments: raw.map((s) => ({
            start: (Number(s.start) || 0) / div,
            dur: (Number(s.dur) || 0) / div,
            text: cleanText(s.text || ''),
          })).filter((s) => s.text),
        };
      },
    },
    {
      name: 'worker',
      async fetch(videoId, lang) {
        const base = (state.settings.captionProxy || '').trim().replace(/\/$/, '');
        if (!base) throw codedError('no_proxy', 'Sin proxy configurado');
        const url = `${base}/?v=${encodeURIComponent(videoId)}&lang=${encodeURIComponent(lang)}`;
        const { res, data } = await fetchJSON(url, 25000);
        if (!res.ok || !data?.segments?.length) {
          throw codedError(res.status === 404 ? 'no_captions' : `http_${res.status}`, data?.error || `HTTP ${res.status}`);
        }
        return {
          lang: String(data.lang || data.language || lang),
          generated: false,
          title: data.title || '',
          segments: data.segments.map((s) => ({
            start: Number(s.start),
            dur: Number(s.dur || s.duration || 2),
            text: cleanText(s.text || ''),
          })).filter((s) => s.text),
        };
      },
    },
  ];

  const DEFINITIVE_CAPTION_ERRORS = ['no_captions', 'no_captions_or_blocked', 'login_required', 'not_found', 'http_404', 'http_451', 'http_400'];

  function captionErrorMessage(err) {
    const code = err?.code || '';
    if (code === 'no_captions' || code === 'http_404') return 'Este vídeo no tiene subtítulos: no se puede doblar automáticamente';
    if (code === 'login_required' || code === 'http_451') return 'Este vídeo exige iniciar sesión en YouTube (edad/privado): no se puede leer su transcripción';
    if (code === 'not_found') return 'Vídeo no disponible';
    if (code === 'no_captions_or_blocked') return 'Este vídeo no tiene subtítulos (o exige iniciar sesión en YouTube): no se puede doblar automáticamente. Puedes pegar una transcripción';
    if (code === 'rate_limited') return 'El servicio de subtítulos está saturado; inténtalo en un minuto';
    if (code === 'timeout' || code === 'network') return 'No se pudo conectar con el servicio de subtítulos (¿sin conexión?)';
    return `No se pudo obtener la transcripción (${err?.message || 'error'})`;
  }

  const DEFAULT_SETTINGS = {
    originalVolume: 8,       // original residual mientras habla la voz (si no está silenciado)
    idleVolume: 25,          // original entre frases (si no está silenciado)
    muteOriginal: true,      // por defecto: oír la voz española, no el inglés
    voiceRate: 1.05,
    voicePitch: 1,
    showCaptions: false,
    lookahead: 0.35,
    ducking: true,
    preferSpanishTrack: true,
    captionProxy: '',
    micLang: 'en-US',        // Modo micrófono: idioma que se escucha
    micShowText: false,      // Modo micrófono: texto en pantalla (opcional, desactivado)
  };

  const state = {
    view: 'home',
    settings: loadJSON(STORAGE.settings, DEFAULT_SETTINGS),
    recent: loadJSON(STORAGE.recent, []),
    videoId: null,
    title: '',
    segments: [],           // [{start, dur, text, textEs?, trFailed?, queued?, spoken?}]
    sourceLang: '',
    player: null,
    playerReady: false,
    playing: false,
    ytReady: false,
    load: { phase: 'idle', msg: '', done: 0 },
    status: { kind: 'idle', msg: 'Pega un enlace de YouTube' },
    currentIdx: -1,
    loadToken: 0,
    demoMode: false,
  };

  // ---------- utils ----------
  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return structuredClone(fallback);
      const parsed = JSON.parse(raw);
      if (Array.isArray(fallback)) return Array.isArray(parsed) ? parsed : structuredClone(fallback);
      if (parsed && typeof parsed === 'object') return { ...fallback, ...parsed };
      return structuredClone(fallback);
    } catch {
      return structuredClone(fallback);
    }
  }
  function saveJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* quota */ }
  }
  function cleanText(t) {
    return String(t)
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
      .replace(/^\s*(>>|-)\s*/, '')
      .replace(/♪+/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  function extractVideoId(input) {
    if (!input) return null;
    const s = String(input).trim();
    if (/^[\w-]{11}$/.test(s)) return s;
    try {
      const u = new URL(s);
      if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split('/')[0] || null;
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const m = u.pathname.match(/\/(embed|shorts|live)\/([\w-]{11})/);
      if (m) return m[2];
    } catch { /* not url */ }
    const m2 = s.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/);
    return m2 ? m2[1] : null;
  }
  function toast(msg, ms = 2600) {
    const root = document.getElementById('toast-root');
    root.innerHTML = `<div class="toast">${escapeHtml(msg)}</div>`;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { root.innerHTML = ''; }, ms);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function thumb(id) { return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`; }

  // ---------- segment processing ----------
  function normalizeSegments(segs) {
    const s = segs
      .filter((x) => x.text && Number.isFinite(x.start))
      .map((x) => ({ ...x }))
      .sort((a, b) => a.start - b.start);
    // Los subtítulos automáticos se solapan (cada línea dura hasta que sale la siguiente+1).
    for (let i = 0; i < s.length; i++) {
      const next = s[i + 1];
      let end = s[i].start + (s[i].dur > 0 ? s[i].dur : 2);
      if (next && next.start > s[i].start && end > next.start) end = next.start;
      s[i].dur = Math.max(0.3, end - s[i].start);
    }
    // fuera [Music], (Applause), [Música]…
    return s.filter((x) => !/^[[(].*[\])]$/.test(x.text));
  }

  function mergeChunks(segs, maxChars = 150, maxDur = 7.5) {
    const out = [];
    let buf = null;
    const endsSentence = (t) => /[.!?…]["')\]]?$/.test(t);
    for (const s of segs) {
      if (/^(traductor|traducción|revisor|translator|reviewer|subtítulos por|subtitles by)\b\s*:/i.test(s.text)) continue;
      if (!buf) { buf = { start: s.start, end: s.start + s.dur, text: s.text }; continue; }
      const gap = s.start - buf.end;
      const combined = `${buf.text} ${s.text}`;
      const dur = s.start + s.dur - buf.start;
      const canMerge = gap < 0.8 && combined.length <= maxChars && dur <= maxDur
        && !(endsSentence(buf.text) && buf.text.length >= 45);
      if (canMerge) {
        buf.text = combined;
        buf.end = Math.max(buf.end, s.start + s.dur);
      } else {
        out.push(buf);
        buf = { start: s.start, end: s.start + s.dur, text: s.text };
      }
    }
    if (buf) out.push(buf);
    return out.map((b) => ({ start: b.start, dur: Math.max(0.3, b.end - b.start), text: b.text }));
  }

  // Back-compat for older callers/tests
  function mergeSegments(segments) { return mergeChunks(normalizeSegments(segments)); }

  // ---------- translation ----------
  function trCacheKey(videoId, text) { return `${videoId}::${text}`; }
  function setTrCache(map) {
    const keys = Object.keys(map);
    if (keys.length > 1500) keys.slice(0, keys.length - 1100).forEach((k) => delete map[k]);
    saveJSON(STORAGE.translations, map);
  }

  function parseClients5(data, n) {
    if (!Array.isArray(data)) return null;
    const pick = (item) => (typeof item === 'string' ? item : Array.isArray(item) && typeof item[0] === 'string' ? item[0] : '');
    if (data.length === n) return data.map(pick);
    if (n === 1) return [data.map(pick).join(' ')];
    return null;
  }

  async function translateOne(text, srcLang) {
    // 2) translate.googleapis (gtx)
    try {
      const { res, data } = await fetchJSON(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=es&dt=t&q=${encodeURIComponent(text)}`, 12000);
      if (res.ok && Array.isArray(data?.[0])) {
        const out = cleanText(data[0].map((x) => (Array.isArray(x) ? x[0] : '')).join(''));
        if (out) return out;
      }
    } catch { /* next */ }
    // 3) MyMemory
    try {
      const sl = /^[a-z]{2}/i.test(srcLang) ? srcLang.slice(0, 2) : 'en';
      const { res, data } = await fetchJSON(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 450))}&langpair=${sl}|es`, 12000);
      const out = cleanText(data?.responseData?.translatedText || '');
      if (res.ok && out && !/MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(out)) return out;
    } catch { /* fail */ }
    return null;
  }

  async function translateBatch(texts, srcLang) {
    // 1) Google clients5 (CORS *), admite varias q= en una sola petición
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const qs = texts.map((t) => `q=${encodeURIComponent(t)}`).join('&');
        const { res, data } = await fetchJSON(`https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=es&${qs}`, 15000);
        if (res.ok) {
          const out = parseClients5(data, texts.length);
          if (out && out.every((x) => cleanText(x))) return out.map(cleanText);
        }
      } catch { /* retry / fallback */ }
      await sleep(600);
    }
    const out = [];
    for (const t of texts) out.push(await translateOne(t, srcLang));
    return out;
  }

  async function translateChunks(chunks, videoId, srcLang, token, onProgress) {
    const cache = loadJSON(STORAGE.translations, {});
    for (const c of chunks) {
      const hit = cache[trCacheKey(videoId, c.text)];
      if (hit) c.textEs = hit;
    }
    const pending = chunks.filter((c) => !c.textEs);
    onProgress?.();
    // lotes pequeños al principio para empezar a hablar enseguida
    const batches = [];
    let cur = [];
    let curLen = 0;
    for (const c of pending) {
      const len = encodeURIComponent(c.text).length + 3;
      const limit = batches.length === 0 ? 6 : 25;
      if (cur.length && (cur.length >= limit || curLen + len > 5000)) { batches.push(cur); cur = []; curLen = 0; }
      cur.push(c); curLen += len;
    }
    if (cur.length) batches.push(cur);

    for (const batch of batches) {
      if (token !== state.loadToken) return;
      const out = await translateBatch(batch.map((c) => c.text), srcLang);
      if (token !== state.loadToken) return;
      batch.forEach((c, i) => {
        if (out[i]) {
          c.textEs = out[i];
          cache[trCacheKey(videoId, c.text)] = out[i];
        } else {
          c.trFailed = true;
        }
      });
      setTrCache(cache);
      onProgress?.();
    }
  }

  // ---------- captions ----------
  async function fetchCaptions(videoId) {
    const errors = [];
    const sources = CAPTION_SOURCES.filter((s) => s.name !== 'worker' || (state.settings.captionProxy || '').trim());
    for (const src of sources) {
      const plan = [['es', 0], ['es', 1500], ['en', 2500]];
      for (const [lang, wait] of plan) {
        if (wait) await sleep(wait);
        try {
          const r = await src.fetch(videoId, lang);
          if (r.segments.length) return { ...r, source: src.name };
          throw codedError('no_captions', 'Sin segmentos');
        } catch (e) {
          errors.push(e);
          console.warn('[captions]', src.name, lang, e.code, e.message);
          if (DEFINITIVE_CAPTION_ERRORS.includes(e.code)) break; // no insistir con esta fuente
        }
      }
    }
    // el error más informativo: preferimos los definitivos
    const best = errors.find((e) => DEFINITIVE_CAPTION_ERRORS.includes(e.code)) || errors[errors.length - 1];
    throw best || codedError('no_captions', 'Sin subtítulos');
  }

  // ---------- TTS (Web Speech) ----------
  // Peculiaridades de Chrome Android que gestionamos aquí:
  //  - speak() necesita un gesto del usuario la primera vez → ttsUnlock() en los toques.
  //  - getVoices() vacío hasta 'voiceschanged' (a veces nunca llega) → sondeo.
  //  - asignar utterance.voice a veces deja la voz muda → en Android solo usamos lang='es-ES'
  //    y si una voz concreta falla, reintentamos sin ella.
  //  - cancel()+speak() en el mismo tick se pierde → pequeño retraso.
  //  - frases largas o >15 s se cortan → trozos ≤ 200 caracteres + keepalive resume().
  //  - a veces no llega onend → temporizador de seguridad para no bloquear la cola.
  const tts = {
    supported: 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function',
    voices: [],
    esVoice: null,
    voicesKnown: false,
    useVoiceObject: !IS_ANDROID,
    unlocked: false,
    speaking: false,
    current: null,
    keep: new Set(),
    failStreak: 0,
    broken: false,
    brokenMsg: '',
    lastError: '',
    lastCancelAt: 0,
    speakCalls: 0,
    log: [],
  };

  function ttsLoadVoices() {
    if (!tts.supported) return;
    let v = [];
    try { v = speechSynthesis.getVoices() || []; } catch { /* */ }
    if (v.length) {
      tts.voices = v;
      tts.voicesKnown = true;
      tts.esVoice = pickSpanishVoice(v);
      renderStatusOnly();
      updateVoiceInfo();
    }
  }
  function pickSpanishVoice(voices) {
    const isEs = (v) => /^es([-_]|$)/i.test(v.lang || '');
    const prefer = [
      (v) => /^es[-_]ES/i.test(v.lang) && v.localService && /google|sabina|monica|mónica|jorge|helena|laura|pablo/i.test(v.name),
      (v) => /^es[-_]ES/i.test(v.lang) && v.localService,
      (v) => /^es[-_]ES/i.test(v.lang),
      (v) => isEs(v) && v.localService,
      isEs,
      (v) => /spanish|español/i.test(v.name),
    ];
    for (const pred of prefer) {
      const hit = voices.find(pred);
      if (hit) return hit;
    }
    return null;
  }
  function hasSpanishVoice() {
    if (!tts.voicesKnown) return null; // desconocido (Android a veces no lista voces)
    return !!tts.voices.find((v) => /^es([-_]|$)/i.test(v.lang || '') || /spanish|español/i.test(v.name || ''));
  }
  function ttsInit() {
    if (!tts.supported) return;
    ttsLoadVoices();
    try { speechSynthesis.addEventListener('voiceschanged', ttsLoadVoices); } catch { speechSynthesis.onvoiceschanged = ttsLoadVoices; }
    let n = 0;
    const poll = setInterval(() => { ttsLoadVoices(); if (tts.voicesKnown || ++n > 25) clearInterval(poll); }, 300);
    // keepalive: algunos Chrome pausan la síntesis a los ~15 s; y a veces se queda "en pausa".
    setInterval(() => {
      const rec = tts.current;
      if (!rec || rec.done) return;
      try {
        if (speechSynthesis.paused) speechSynthesis.resume();
        else if (!IS_ANDROID && rec.started && performance.now() - rec.startedAt > 10000) {
          speechSynthesis.pause(); speechSynthesis.resume();
        }
      } catch { /* */ }
    }, 4000);
  }

  function ttsFail(code) {
    tts.lastError = code;
    if (code === 'not-allowed') {
      // falta gesto del usuario: recuperable tocando un botón; mientras tanto, que suene el original
      applyAudio(false);
      renderStatusOnly();
      return;
    }
    tts.failStreak += 1;
    if (tts.failStreak >= 3 && !tts.broken) {
      tts.broken = true;
      tts.brokenMsg = hasSpanishVoice() === false
        ? 'Tu móvil no tiene voz en español: instálala en Ajustes › Accesibilidad › Texto a voz (Google)'
        : `La voz del móvil no responde (${code}). Prueba «Probar voz» en Ajustes`;
      applyAudio(); // no dejar al usuario en silencio
    }
    renderStatusOnly();
  }

  function ttsSpeakNow(text, opts = {}) {
    if (!tts.supported) { opts.onerror?.('unsupported'); return null; }
    const u = new SpeechSynthesisUtterance(text);
    const useVoice = !!(tts.useVoiceObject && tts.esVoice && !opts.noVoice);
    if (useVoice) {
      u.voice = tts.esVoice;
      u.lang = String(tts.esVoice.lang || 'es-ES').replace('_', '-');
    } else {
      u.lang = 'es-ES';
    }
    u.rate = clamp(Number(opts.rate) || Number(state.settings.voiceRate) || 1, 0.5, 2);
    u.pitch = Number(state.settings.voicePitch) || 1;
    u.volume = opts.volume ?? 1;
    const rec = { u, text, started: false, done: false, cancelled: false, usedVoice: useVoice, startedAt: 0, opts };
    tts.keep.add(u); // evitar que el GC se coma la utterance antes de onend (bug de Chrome)
    tts.current = rec;

    const finish = (ok, err) => {
      if (rec.done) return;
      rec.done = true;
      clearTimeout(rec.watchdog);
      clearTimeout(rec.maxTimer);
      tts.keep.delete(u);
      if (tts.current === rec) { tts.current = null; tts.speaking = false; }
      if (ok) opts.onend?.(rec); else opts.onerror?.(err, rec);
    };
    const retryWithoutVoice = () => {
      tts.useVoiceObject = false;
      rec.done = true;
      clearTimeout(rec.watchdog);
      tts.keep.delete(u);
      if (tts.current === rec) tts.current = null;
      try { speechSynthesis.cancel(); } catch { /* */ }
      setTimeout(() => ttsSpeakNow(text, { ...opts, isRetry: true, noVoice: true }), 120);
    };

    u.onstart = () => {
      if (rec.done) return;
      rec.started = true;
      rec.startedAt = performance.now();
      const wasBlocked = tts.broken || tts.lastError === 'not-allowed';
      tts.unlocked = true;
      tts.speaking = true;
      tts.failStreak = 0;
      tts.lastError = '';
      tts.broken = false;
      if (wasBlocked) applyAudio(true);
      // seguridad: si onend nunca llega, liberar la cola
      const maxMs = (text.length / (8 * u.rate)) * 1000 + 4000;
      rec.maxTimer = setTimeout(() => { if (!rec.done) { try { speechSynthesis.cancel(); } catch { /* */ } finish(true); } }, maxMs);
      opts.onstart?.(rec);
      renderStatusOnly();
    };
    u.onend = () => finish(true);
    u.onerror = (e) => {
      const code = e?.error || 'error';
      if (rec.cancelled || code === 'interrupted' || code === 'canceled') { finish(true); return; }
      console.warn('[tts] error', code);
      if (!rec.started && rec.usedVoice && !opts.isRetry && code !== 'not-allowed') { retryWithoutVoice(); return; }
      ttsFail(code);
      finish(false, code);
    };
    rec.watchdog = setTimeout(() => {
      if (rec.done || rec.started) return;
      if (rec.usedVoice && !opts.isRetry) { retryWithoutVoice(); return; }
      ttsFail('no-start');
      try { speechSynthesis.cancel(); } catch { /* */ }
      finish(false, 'no-start');
    }, opts.watchdogMs || 5000);

    tts.speakCalls += 1;
    tts.log.push({ text, lang: u.lang, voice: useVoice ? tts.esVoice.name : null, rate: u.rate, at: Date.now() });
    if (tts.log.length > 200) tts.log.shift();
    try {
      try { if (speechSynthesis.paused) speechSynthesis.resume(); } catch { /* */ }
      speechSynthesis.speak(u);
    } catch (e) {
      ttsFail('speak-throw');
      finish(false, 'speak-throw');
    }
    return rec;
  }

  function ttsStop() {
    const rec = tts.current;
    if (rec) rec.cancelled = true;
    tts.current = null;
    tts.speaking = false;
    tts.lastCancelAt = performance.now();
    if (!tts.supported) return;
    try { if (speechSynthesis.speaking || speechSynthesis.pending || rec) speechSynthesis.cancel(); } catch { /* */ }
  }

  // Habla cancelando lo anterior con un pequeño retraso (cancel+speak en el mismo tick falla en Android)
  function ttsSay(text, opts = {}) {
    if (!tts.supported) { opts.onerror?.('unsupported'); return; }
    let busy = !!tts.current;
    try { busy = busy || speechSynthesis.speaking || speechSynthesis.pending; } catch { /* */ }
    if (busy) {
      ttsStop();
      setTimeout(() => ttsSpeakNow(text, opts), 120);
    } else {
      ttsSpeakNow(text, opts);
    }
  }

  // Llamar SIEMPRE de forma síncrona dentro de un gesto (tap/click)
  function ttsUnlock(phrase) {
    if (!tts.supported) return;
    ttsLoadVoices();
    try { speechSynthesis.resume(); } catch { /* */ }
    if (tts.unlocked && tts.lastError !== 'not-allowed') return;
    if (tts.current) return; // ya hay algo sonando/arrancando
    const go = () => { if (!tts.current) ttsSpeakNow(phrase || 'Vale', { watchdogMs: 6000 }); };
    // justo tras un cancel() Android descarta el speak: esperar un poco (la activación del gesto sigue valiendo)
    if (performance.now() - (tts.lastCancelAt || 0) < 150) setTimeout(go, 160); else go();
  }

  function splitForSpeech(text, max = MAX_UTTERANCE) {
    const parts = [];
    let rest = String(text).trim();
    while (rest.length > max) {
      let cut = -1;
      for (const re of [/[.!?…;:](\s|$)/g, /,\s/g, /\s/g]) {
        let m; let last = -1;
        re.lastIndex = 0;
        while ((m = re.exec(rest)) && m.index < max) last = m.index + 1;
        if (last > max * 0.4) { cut = last; break; }
      }
      if (cut < 0) cut = max;
      parts.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) parts.push(rest);
    return parts;
  }

  // ---------- dubbing scheduler ----------
  // Cada frase se encola UNA vez cuando el reproductor pasa por su inicio (puntero monótono,
  // así no se pierde ninguna aunque el sondeo vaya a saltos). Se reinicia solo si hay seek.
  const dub = { timer: 0, nextIdx: 0, queue: [], item: null, lastT: -1, lastWall: 0, wasPlaying: false, pumpTimer: 0 };

  function dubFirstIdxAt(t) {
    const segs = state.segments;
    const i = segs.findIndex((s) => s.start + s.dur > t + 0.25);
    return i < 0 ? segs.length : i;
  }
  function dubReset(t = 0) {
    ttsStop();
    clearTimeout(dub.pumpTimer); dub.pumpTimer = 0;
    dub.queue = [];
    dub.item = null;
    dub.nextIdx = dubFirstIdxAt(t);
  }
  function dubStart() {
    clearInterval(dub.timer);
    dub.lastT = -1; dub.lastWall = 0; dub.wasPlaying = false;
    dub.timer = setInterval(dubTick, 150);
  }
  function dubStop() {
    clearInterval(dub.timer); dub.timer = 0;
    dubReset(0);
  }
  function playerTime() {
    try { return state.player?.getCurrentTime?.() || 0; } catch { return 0; }
  }

  function dubTick() {
    const p = state.player;
    if (!p || !state.playerReady) return;
    let t; let ps;
    try { t = p.getCurrentTime() || 0; ps = p.getPlayerState(); } catch { return; }
    const now = performance.now();
    const playing = ps === 1;
    const buffering = ps === 3;
    if (!playing) {
      if (!buffering && dub.wasPlaying) {
        // pausa: cortar la voz y volver a decir la frase al reanudar
        if (dub.item) dub.queue.unshift(...dub.item.idxs.filter((i) => !dub.queue.includes(i)));
        dub.item = null;
        ttsStop();
        clearTimeout(dub.pumpTimer); dub.pumpTimer = 0;
      }
      if (!buffering) { dub.wasPlaying = false; dub.lastWall = 0; state.playing = false; }
      dub.lastT = t;
      return;
    }
    // detección de saltos (seek) en ambos sentidos
    if (dub.lastWall) {
      const rate = Number(p.getPlaybackRate?.()) || 1;
      const expected = dub.lastT + ((now - dub.lastWall) / 1000) * rate;
      if (Math.abs(t - expected) > 1.6) dubReset(t);
    } else if (dub.lastT >= 0 && Math.abs(t - dub.lastT) > 1.6) {
      dubReset(t);
    }
    dub.lastT = t; dub.lastWall = now; dub.wasPlaying = true;
    state.playing = true;
    if (!state.segments.length) return;

    const segs = state.segments;
    const look = Number(state.settings.lookahead) || 0.35;
    while (dub.nextIdx < segs.length && segs[dub.nextIdx].start <= t + look) {
      const s = segs[dub.nextIdx];
      if (!s.textEs) {
        if (s.trFailed || t > s.start + s.dur + 1) { dub.nextIdx++; continue; }
        break; // aún traduciéndose: esperar
      }
      dub.queue.push(dub.nextIdx);
      s.queued = (s.queued || 0) + 1;
      dub.nextIdx++;
    }
    dubPump(t);
    updateCaptionBox(t);
  }

  function dubPump(t) {
    if (tts.current || dub.pumpTimer || !tts.supported) return;
    if (tts.broken) { dub.queue = []; return; }
    if (!state.playing) return;
    if (tts.lastError === 'not-allowed') return; // esperar a que el usuario toque un botón
    if (performance.now() - (tts.lastCancelAt || 0) < 150) {
      // no hablar en el mismo instante que un cancel() (Android lo descarta)
      dub.pumpTimer = setTimeout(() => { dub.pumpTimer = 0; dubPump(playerTime()); }, 160);
      return;
    }
    const segs = state.segments;
    if (dub.item?.pieces?.length) {
      dubSpeakPiece(dub.item.pieces.shift());
      return;
    }
    if (!dub.queue.length) return;
    // si vamos muy retrasados, descartar frases muy viejas (pero nunca la última)
    while (dub.queue.length > 1) {
      const s = segs[dub.queue[0]];
      if (t > s.start + s.dur + 6) dub.queue.shift(); else break;
    }
    const idxs = [dub.queue.shift()];
    let text = segs[idxs[0]].textEs;
    while (dub.queue.length && `${text} ${segs[dub.queue[0]].textEs}`.length <= MAX_UTTERANCE) {
      const i = dub.queue.shift();
      idxs.push(i);
      text += ` ${segs[i].textEs}`;
    }
    const lastIdx = idxs[idxs.length - 1];
    const last = segs[lastIdx];
    const next = segs[lastIdx + 1];
    const slotEnd = next ? next.start : last.start + last.dur + 2;
    const avail = Math.max(1.2, slotEnd - Math.max(t, segs[idxs[0]].start));
    const base = Number(state.settings.voiceRate) || 1;
    const need = text.length / CHARS_PER_SEC / avail; // rate necesario para caber en el hueco
    const rate = clamp(Math.max(base, need), base, Math.max(base, base * 1.35));
    idxs.forEach((i) => { segs[i].spoken = (segs[i].spoken || 0) + 1; });
    state.currentIdx = idxs[0];
    const pieces = splitForSpeech(text);
    dub.item = { idxs, text, rate, pieces };
    dubSpeakPiece(pieces.shift());
  }

  function dubSpeakPiece(piece) {
    const item = dub.item;
    if (!item || !piece) { dub.item = null; return; }
    ttsSpeakNow(piece, {
      rate: item.rate,
      onstart: () => { applyAudio(true); updateCaptionBox(); },
      onend: () => dubAfterSpeech(item),
      onerror: () => dubAfterSpeech(item),
    });
  }
  function dubAfterSpeech(item) {
    if (dub.item === item && !item.pieces.length) dub.item = null;
    applyAudio(false);
    renderStatusOnly();
    clearTimeout(dub.pumpTimer);
    dub.pumpTimer = setTimeout(() => { dub.pumpTimer = 0; dubPump(playerTime()); }, 60);
  }

  function dubAvailable() {
    return tts.supported && !tts.broken && tts.lastError !== 'not-allowed' && state.segments.some((s) => s.textEs);
  }

  // Silenciar el original SOLO si hay voz española lista para sonar
  function applyAudio(speakingNow) {
    const p = state.player;
    if (!p || !state.playerReady || typeof p.setVolume !== 'function') { updateVoiceBanner(); return; }
    const speaking = speakingNow ?? tts.speaking;
    try {
      if (!dubAvailable()) {
        p.unMute?.();
        p.setVolume(100);
      } else if (state.settings.muteOriginal) {
        p.mute?.();
      } else if (state.settings.ducking) {
        p.unMute?.();
        p.setVolume(clamp(Number(speaking ? state.settings.originalVolume : state.settings.idleVolume) || 0, 0, 100));
      } else {
        p.unMute?.();
        p.setVolume(100);
      }
    } catch { /* player not ready */ }
    updateVoiceBanner();
  }

  // ---------- status ----------
  function computeStatus() {
    const L = state.load;
    const n = state.segments.length;
    const ready = state.segments.filter((s) => s.textEs).length;
    if (L.phase === 'error') return { kind: 'err', msg: L.msg };
    if (L.phase === 'loading') return { kind: 'busy', msg: 'Cargando transcripción…' };
    if (L.phase === 'translating' && ready === 0) return { kind: 'busy', msg: `Traduciendo al español… 0/${n}` };
    if (L.phase === 'ready' && !n) return { kind: 'err', msg: 'Este vídeo no tiene subtítulos utilizables: no se puede doblar' };
    if (L.phase === 'ready' && ready === 0) {
      return { kind: 'err', msg: 'No se pudo traducir al español; el audio original seguirá sonando' };
    }
    if (L.phase === 'idle') return { kind: 'idle', msg: 'Pega un enlace de YouTube' };
    if (!tts.supported) return { kind: 'err', msg: 'Este navegador no tiene voz sintética (usa Chrome); el audio original no se silencia' };
    if (tts.broken) return { kind: 'err', msg: tts.brokenMsg };
    if (tts.lastError === 'not-allowed') return { kind: 'err', msg: 'Voz bloqueada: toca «▶ Reproducir con voz» para activarla' };
    const trans = L.phase === 'translating' ? ` · traduciendo ${ready}/${n}` : '';
    if (tts.speaking && dub.item) return { kind: 'ok', msg: `Hablando… frase ${state.currentIdx + 1}/${n}${trans}` };
    const noEs = hasSpanishVoice() === false ? ' · ⚠️ tu móvil no lista voz en español' : '';
    if (state.playing) return { kind: noEs ? 'warn' : 'ok', msg: `Doblando · ${ready} frases listas${trans}${noEs}` };
    return { kind: noEs ? 'warn' : 'ok', msg: `${ready} frases listas · pulsa ▶ Reproducir con voz${trans}${noEs}` };
  }

  function renderStatusOnly() {
    state.status = computeStatus();
    const el = document.getElementById('status-pill');
    if (!el) return;
    const html = `<i class="dot"></i><span>${escapeHtml(state.status.msg)}</span>`;
    if (el.innerHTML !== html) el.innerHTML = html;
    el.className = `status-pill ${state.status.kind}`;
    updateVoiceBanner();
  }

  function updateVoiceBanner() {
    const title = document.getElementById('voice-banner-title');
    const sub = document.getElementById('voice-banner-sub');
    if (!title || !sub) return;
    const active = dubAvailable();
    title.textContent = tts.speaking && dub.item ? 'Hablando en español…' : 'Doblaje en español';
    let txt;
    if (!active) txt = 'Audio original activo (aún no hay voz española)';
    else if (state.settings.muteOriginal) txt = 'Audio original silenciado · voz TTS es-ES';
    else if (state.settings.ducking) txt = `Original atenuado (${state.settings.originalVolume}%) mientras habla la voz`;
    else txt = 'Voz TTS + audio original a volumen normal';
    if (sub.textContent !== txt) sub.textContent = txt;
  }

  function updatePlayButton() {
    const b = document.getElementById('btn-playpause');
    if (!b) return;
    const txt = state.playing ? '⏸ Pausa' : '▶ Reproducir con voz';
    if (b.textContent !== txt) b.textContent = txt;
  }

  function updateCaptionBox(t) {
    const el = document.getElementById('caption-box');
    if (!el || !state.settings.showCaptions) return;
    let idx = state.currentIdx;
    if (typeof t === 'number') {
      const found = state.segments.findIndex((s) => t >= s.start && t <= s.start + Math.max(s.dur, 1));
      if (found >= 0) idx = found;
    }
    if (idx < 0 || !state.segments[idx]) {
      el.innerHTML = '<span style="color:var(--muted);font-weight:600">Reproduciendo voz en español…</span>';
      return;
    }
    const s = state.segments[idx];
    const html = `${escapeHtml(s.textEs || '…')}${s.text && s.textEs && s.text !== s.textEs ? `<span class="orig">${escapeHtml(s.text)}</span>` : ''}`;
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  // ---------- Modo micrófono: voz del vídeo (por el altavoz) → reconocimiento → traducción → voz ES ----------
  // Pensado para Instagram/Facebook (sin subtítulos accesibles): el vídeo suena en voz alta y
  // Chrome lo escucha con SpeechRecognition. Reutiliza translateBatch (clients5 → gtx → MyMemory)
  // y las primitivas TTS de arriba (ttsSpeakNow/ttsUnlock/splitForSpeech, retraso tras cancel…).
  // Bucle de realimentación: el móvil oiría su propia voz española, así que el reconocimiento se
  // DETIENE mientras habla la voz y se reanuda cuando calla (y cualquier resultado que llegue
  // mientras suena la voz se descarta).
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  const MIC_LANGS = [
    ['en-US', 'Inglés (EE. UU.)'], ['en-GB', 'Inglés (Reino Unido)'], ['fr-FR', 'Francés'],
    ['it-IT', 'Italiano'], ['pt-PT', 'Portugués'], ['de-DE', 'Alemán'],
  ];
  const micLangName = (code) => (MIC_LANGS.find((l) => l[0] === code) || MIC_LANGS[0])[1];
  const micLangWord = (code) => ({ en: 'inglés', fr: 'francés', it: 'italiano', pt: 'portugués', de: 'alemán' }[String(code || 'en').slice(0, 2)] || 'inglés');
  const MIC_FATAL = ['not-allowed', 'service-not-allowed', 'language-not-supported', 'unsupported'];
  const mic = {
    supported: !!SR,
    active: false,          // el usuario pulsó «Empezar»
    rec: null,              // SpeechRecognition en curso
    starting: false,        // start() llamado, aún sin onstart
    running: false,         // entre onstart y onend
    hold: '',               // '' | 'stop' | 'abort': parado a propósito porque va a hablar / habla la voz
    holdTimer: 0,
    startTimer: 0,
    nextStartAt: 0,         // cuándo se puede volver a arrancar (backoff)
    backoff: 0,
    endedAt: 0,
    quietSince: 0,          // desde cuándo la voz TTS está callada
    session: { at: 0, results: 0, error: '', forced: false },
    token: 0,               // cambia al parar: descarta traducciones en vuelo
    interim: '',
    interimSince: 0,
    lastFinal: '',
    lastFinalAt: 0,
    trChain: Promise.resolve(),
    trPending: 0,
    queue: [],              // frases en español pendientes de decir
    item: null,             // { text, pieces, rate }
    lines: [],              // [{ en, es, failed }]
    error: '',              // último error relevante (código)
    fatal: '',              // error que detiene el modo
    ignored: 0,
    dropped: 0,
    tick: 0,
    wakeLock: null,
    stats: { starts: 0, ends: 0, results: 0, finals: 0, translated: 0, trFailed: 0, spoken: 0, restarts: 0, holds: 0 },
  };

  function ttsBusy() {
    if (tts.current) return true;
    try { return !!(tts.supported && (speechSynthesis.speaking || speechSynthesis.pending)); } catch { return false; }
  }

  function micStartTap() {
    // ¡Síncrono dentro del gesto! (desbloquea la voz en Chrome Android, como «▶ Reproducir con voz»)
    if (!mic.supported) { mic.fatal = 'unsupported'; micUpdateUI(); return; }
    ttsUnlock('Escuchando');
    mic.active = true;
    mic.token += 1;
    mic.fatal = ''; mic.error = ''; mic.backoff = 0; mic.nextStartAt = 0;
    mic.queue = []; mic.item = null; mic.interim = '';
    mic.quietSince = ttsBusy() ? 0 : performance.now() - 1000;
    clearInterval(mic.tick);
    mic.tick = setInterval(micTick, 200);
    micWakeLock(true);
    // Si no suena la frase de desbloqueo, arrancar ya (dentro del gesto: el aviso de permiso sale antes)
    if (!ttsBusy()) micRecStart();
    micUpdateUI();
  }

  function micStopTap() {
    micStop();
    micUpdateUI();
  }

  function micStop() {
    mic.active = false;
    mic.token += 1;
    clearInterval(mic.tick); mic.tick = 0;
    clearTimeout(mic.holdTimer); clearTimeout(mic.startTimer);
    const rec = mic.rec;
    micDetach();
    if (rec) { try { rec.abort(); } catch { /* */ } }
    if (mic.item || mic.queue.length) ttsStop();
    mic.item = null; mic.queue = []; mic.interim = ''; mic.hold = '';
    micWakeLock(false);
  }

  function micDetach() {
    const rec = mic.rec;
    if (rec) { rec.onstart = rec.onresult = rec.onerror = rec.onend = null; }
    mic.rec = null; mic.running = false; mic.starting = false;
  }

  function micRecStart() {
    if (!mic.active || !SR || mic.rec || mic.fatal) return;
    let rec;
    try { rec = new SR(); } catch { mic.fatal = 'unsupported'; micStop(); micUpdateUI(); return; }
    rec.lang = state.settings.micLang || 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    const processed = new Set(); // índices finales ya tratados (Chrome Android repite resultados)
    rec.onstart = () => {
      if (mic.rec !== rec) return;
      clearTimeout(mic.startTimer);
      mic.starting = false; mic.running = true;
      mic.stats.starts += 1;
      if (mic.error !== 'network') mic.error = '';
      micUpdateUI();
    };
    rec.onresult = (e) => { if (mic.rec === rec) micOnResult(e, processed); };
    rec.onerror = (e) => { if (mic.rec === rec) micOnError(e?.error || 'error'); };
    rec.onend = () => { if (mic.rec === rec) micOnEnd(); };
    mic.rec = rec;
    mic.starting = true;
    mic.hold = '';
    mic.session = { at: performance.now(), results: 0, error: '', forced: false };
    mic.interim = ''; mic.interimSince = 0;
    try {
      rec.start();
    } catch (err) {
      console.warn('[mic] start() falló', err);
      micDetach();
      mic.session.error = 'start-throw';
      micScheduleRestart();
      return;
    }
    // si onstart no llega, abortar y reintentar
    clearTimeout(mic.startTimer);
    mic.startTimer = setTimeout(() => {
      if (mic.rec === rec && mic.starting) {
        try { rec.abort(); } catch { /* */ }
        micDetach();
        mic.session.error = 'no-start';
        micScheduleRestart();
        micUpdateUI();
      }
    }, 8000);
  }

  // Parar el reconocimiento porque va a hablar (stop: entrega lo ya oído) o ya suena una voz (abort)
  function micHold(kind) {
    if (!mic.rec) return;
    if (mic.hold === 'abort' || mic.hold === kind) return;
    mic.hold = kind;
    mic.stats.holds += 1;
    const rec = mic.rec;
    try { if (kind === 'abort') rec.abort(); else rec.stop(); } catch { /* */ }
    clearTimeout(mic.holdTimer);
    mic.holdTimer = setTimeout(() => {
      if (mic.rec !== rec) return;
      try { rec.abort(); } catch { /* */ }
      mic.holdTimer = setTimeout(() => { if (mic.rec === rec) micOnEnd(); }, 700); // onend nunca llegó
    }, 900);
  }

  function micOnResult(e, processed) {
    mic.stats.results += 1;
    const finals = [];
    let interim = '';
    const results = e?.results || [];
    for (let i = e?.resultIndex || 0; i < results.length; i++) {
      const r = results[i];
      const text = cleanText(r?.[0]?.transcript || '');
      if (r?.isFinal) {
        if (processed.has(i)) continue;
        processed.add(i);
        if (text) finals.push(text);
      } else if (text) {
        interim += (interim ? ' ' : '') + text;
      }
    }
    // Realimentación: lo que llegue mientras suena la voz española (o justo después) es eco nuestro
    if (ttsBusy() || mic.item || mic.hold === 'abort') {
      mic.ignored += Math.max(1, finals.length);
      mic.interim = '';
      return;
    }
    mic.session.results += 1;
    mic.backoff = 0;
    if (mic.error === 'no-speech' || mic.error === 'network') mic.error = '';
    if (finals.length) mic.interimSince = interim ? performance.now() : 0;
    else if (interim && !mic.interim) mic.interimSince = performance.now();
    else if (!interim) mic.interimSince = 0;
    mic.interim = interim;
    finals.forEach(micHandleFinal);
    micUpdateUI();
  }

  function micHandleFinal(raw) {
    const norm = (x) => x.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, '').replace(/\s+/g, ' ').trim();
    let text = raw;
    const cur = norm(text);
    if (cur.replace(/\s/g, '').length < 2) return;
    const prev = norm(mic.lastFinal);
    const recent = performance.now() - mic.lastFinalAt < 10000;
    if (prev && recent) {
      if (cur === prev) return; // duplicado (bug de Chrome Android)
      if (cur.startsWith(`${prev} `)) {
        // resultado acumulado: quedarse solo con lo nuevo
        text = text.split(/\s+/).slice(prev.split(' ').length).join(' ');
        if (norm(text).length < 2) return;
      }
    }
    mic.lastFinal = raw;
    mic.lastFinalAt = performance.now();
    mic.stats.finals += 1;
    const line = { en: text, es: '', failed: false };
    mic.lines.push(line);
    if (mic.lines.length > 30) mic.lines.shift();
    const token = mic.token;
    const src = state.settings.micLang || 'en-US';
    mic.trPending += 1;
    // traducir en paralelo, pero decirlo en orden
    const job = translateBatch([text], src).catch(() => [null]);
    mic.trChain = mic.trChain.then(() => job).then((out) => {
      mic.trPending = Math.max(0, mic.trPending - 1);
      if (token !== mic.token || !mic.active) return;
      const es = out?.[0];
      if (!es) { line.failed = true; mic.stats.trFailed += 1; micUpdateUI(); return; }
      line.es = es;
      mic.stats.translated += 1;
      micEnqueue(es);
      micUpdateUI();
    }).catch((err) => console.warn('[mic] traducción', err));
    micUpdateUI();
  }

  function micEnqueue(es) {
    mic.queue.push(es);
    // si vamos muy retrasados, descartar lo más viejo (mejor ir al día que leer frases de hace 20 s)
    while (mic.queue.length > 3) { mic.queue.shift(); mic.dropped += 1; }
    micPump();
  }

  function micPump() {
    if (!mic.active || mic.item || !mic.queue.length) return;
    if (!tts.supported || tts.broken) { mic.queue = []; micUpdateUI(); return; }
    if (tts.lastError === 'not-allowed') { micUpdateUI(); return; } // esperar a un toque
    if (tts.current) return;
    if (mic.rec) { micHold('stop'); return; } // primero cerrar el micrófono; onend vuelve a llamar aquí
    const now = performance.now();
    if (now - (tts.lastCancelAt || 0) < 150 || now - mic.endedAt < 120) return; // el tick reintenta
    let text = mic.queue.shift();
    while (mic.queue.length && `${text} ${mic.queue[0]}`.length <= MAX_UTTERANCE) text += ` ${mic.queue.shift()}`;
    const base = Number(state.settings.voiceRate) || 1;
    const rate = clamp(mic.queue.length ? base * 1.15 : base, 0.5, 2);
    mic.item = { text, pieces: splitForSpeech(text), rate };
    micSpeakPiece();
  }

  function micSpeakPiece() {
    const item = mic.item;
    if (!item) return;
    const piece = item.pieces.shift();
    if (!piece || !mic.active) {
      mic.item = null;
      mic.quietSince = performance.now();
      micUpdateUI();
      setTimeout(micPump, 60);
      return;
    }
    ttsSpeakNow(piece, {
      rate: item.rate,
      onstart: () => { mic.stats.spoken += 1; micUpdateUI(); },
      onend: () => { if (mic.item === item) setTimeout(micSpeakPiece, 60); },
      onerror: (code) => {
        if (mic.item !== item) return;
        if (code === 'not-allowed') {
          // voz bloqueada por falta de gesto: guardar el texto para cuando el usuario toque
          mic.queue.unshift([piece, ...item.pieces].join(' '));
          mic.item = null;
          mic.quietSince = performance.now();
          micUpdateUI();
          return;
        }
        setTimeout(micSpeakPiece, 60);
      },
    });
    micUpdateUI();
  }

  function micOnError(code) {
    mic.session.error = code;
    if (code === 'aborted') return; // lo hemos parado nosotros
    console.warn('[mic] error', code);
    if (MIC_FATAL.includes(code)) {
      mic.fatal = code;
      micStop();
      micUpdateUI();
      return;
    }
    if (code === 'no-speech' || code === 'network' || code === 'audio-capture') mic.error = code;
    micUpdateUI();
  }

  function micOnEnd() {
    clearTimeout(mic.holdTimer); clearTimeout(mic.startTimer);
    const held = mic.hold;
    const s = mic.session;
    micDetach();
    mic.hold = '';
    mic.endedAt = performance.now();
    mic.stats.ends += 1;
    mic.interim = '';
    if (!mic.active || mic.fatal) { micUpdateUI(); return; }
    if (held) {
      // parado para hablar: se reanuda cuando la voz calle (micTick)
      mic.nextStartAt = 0;
      micPump();
      micUpdateUI();
      return;
    }
    micScheduleRestart(s);
    micUpdateUI();
  }

  // Chrome (sobre todo Android) corta el reconocimiento tras unos segundos de silencio: relanzar con backoff
  function micScheduleRestart(s = mic.session) {
    if (!mic.active || mic.fatal) return;
    const dur = performance.now() - (s.at || 0);
    const err = s.error || '';
    let delay;
    if (s.results > 0 || s.forced) {
      mic.backoff = 0; delay = 150;
    } else if (err === 'network') {
      mic.backoff = clamp((mic.backoff || 1000) * 2, 2000, 15000); delay = mic.backoff;
    } else if (err === 'no-speech' || (!err && dur > 4000)) {
      // silencio normal: relanzar rápido, con tope bajo para no perder la siguiente frase
      mic.backoff = clamp((mic.backoff || 150) * 2, 300, 1500); delay = mic.backoff;
    } else {
      // terminó enseguida sin resultados (mic ocupado, foco de audio, error raro…)
      mic.backoff = clamp((mic.backoff || 250) * 2, 500, 8000); delay = mic.backoff;
    }
    mic.nextStartAt = performance.now() + delay;
    mic.stats.restarts += 1;
  }

  function micTick() {
    if (!mic.active) return;
    const now = performance.now();
    const busy = ttsBusy();
    if (busy) {
      mic.quietSince = 0;
      if (mic.rec && !mic.item) micHold('abort'); // otra voz (desbloqueo, Probar voz…) sonando con el micro abierto
      else if (mic.rec && mic.item && tts.speaking) micHold('abort');
    } else if (!mic.quietSince) {
      mic.quietSince = now;
    }
    if (mic.queue.length && !mic.item) micPump();
    // frase interminable sin resultado final (música, monólogo): forzar el cierre para traducir lo oído
    if (mic.running && !mic.hold && mic.interim && mic.interimSince && now - mic.interimSince > 7000) {
      mic.session.forced = true;
      mic.interimSince = 0;
      try { mic.rec.stop(); } catch { /* */ }
    }
    // (re)arrancar cuando todo está tranquilo
    if (!mic.rec && !busy && !mic.item && !mic.queue.length && mic.quietSince && now - mic.quietSince >= 350
      && now >= mic.nextStartAt && !mic.fatal) {
      micRecStart();
      micUpdateUI();
    }
  }

  async function micWakeLock(on) {
    try {
      if (on) {
        if (mic.wakeLock || document.hidden || !navigator.wakeLock?.request) return;
        const lock = await navigator.wakeLock.request('screen');
        if (!mic.active) { lock.release().catch(() => {}); return; }
        mic.wakeLock = lock;
        lock.addEventListener?.('release', () => { if (mic.wakeLock === lock) mic.wakeLock = null; });
      } else if (mic.wakeLock) {
        const lock = mic.wakeLock;
        mic.wakeLock = null;
        await lock.release();
      }
    } catch { /* sin wake lock: no pasa nada */ }
  }

  function micPhase() {
    if (!mic.supported || mic.fatal === 'unsupported') return 'unsupported';
    if (mic.fatal) return 'fatal';
    if (!mic.active) return 'idle';
    if (tts.supported && tts.broken) return 'tts-broken';
    if (tts.lastError === 'not-allowed' && (mic.queue.length || mic.item)) return 'tts-blocked';
    if (mic.item || (ttsBusy() && !mic.rec)) return 'speaking';
    if (mic.hold) return 'pausing';
    if (mic.running) return mic.interim ? 'hearing' : 'listening';
    if (mic.starting) return 'starting';
    if (mic.trPending) return 'translating';
    return 'restarting';
  }

  function micStatus() {
    const ph = micPhase();
    const lang = micLangName(state.settings.micLang);
    const fatalMsgs = {
      'not-allowed': 'Permiso de micrófono denegado. Toca el candado 🔒 junto a la dirección › Permisos › Micrófono › Permitir, y vuelve a pulsar Empezar.',
      'service-not-allowed': 'Este navegador no permite el reconocimiento de voz. Abre la app en Google Chrome (no en modo incógnito ni dentro de otra app).',
      'language-not-supported': `Chrome no reconoce «${lang}» en este dispositivo. Elige otro idioma.`,
    };
    switch (ph) {
      case 'unsupported': return { kind: 'err', title: 'Sin reconocimiento de voz', msg: 'Este navegador no puede escuchar por el micrófono. Usa Google Chrome actualizado en Android.' };
      case 'fatal': return { kind: 'err', title: 'Micrófono detenido', msg: fatalMsgs[mic.fatal] || `Error: ${mic.fatal}` };
      case 'idle': return { kind: 'idle', title: 'Listo', msg: 'Pulsa «Empezar», permite el micrófono y reproduce el vídeo en voz alta.' };
      case 'tts-broken': return { kind: 'err', title: 'La voz no funciona', msg: tts.brokenMsg || 'La voz del móvil no responde. Prueba «Probar voz».' };
      case 'tts-blocked': return { kind: 'err', title: 'Voz bloqueada', msg: 'Toca la pantalla para activar la voz en español.' };
      case 'speaking': return { kind: 'ok', title: 'Hablando en español…', msg: 'Micrófono en pausa mientras habla (para no oírse a sí mismo).' };
      case 'pausing': return { kind: 'busy', title: 'Preparando la voz…', msg: 'Cerrando el micrófono para hablar.' };
      case 'hearing': return { kind: 'ok', title: 'Oyendo voz…', msg: `Reconociendo ${micLangWord(state.settings.micLang)}. La traducción llega al terminar cada frase.` };
      case 'translating': return { kind: 'busy', title: 'Traduciendo…', msg: 'Pasando la frase al español.' };
      case 'listening':
      case 'starting':
      case 'restarting': {
        if (document.hidden) return { kind: 'warn', title: 'Chrome en segundo plano', msg: 'Puede dejar de escuchar. Usa pantalla dividida para que Chrome siga visible.' };
        if (mic.error === 'network') return { kind: 'err', title: 'Sin conexión', msg: 'El reconocimiento de voz de Chrome necesita internet. Reintentando…' };
        if (mic.error === 'audio-capture') return { kind: 'err', title: 'Micrófono ocupado', msg: 'No se puede usar el micrófono (¿lo está usando otra app?). Reintentando…' };
        if (ph === 'starting') return { kind: 'busy', title: 'Activando el micrófono…', msg: 'Si Chrome lo pregunta, toca «Permitir».' };
        if (ph === 'restarting') return { kind: 'busy', title: 'Escuchando…', msg: mic.error === 'no-speech' ? 'No se oye voz: sube el volumen del vídeo y acerca el móvil al altavoz.' : 'Reactivando el micrófono…' };
        return { kind: 'ok', title: 'Escuchando…', msg: mic.error === 'no-speech' ? 'No se oye voz: sube el volumen del vídeo y acerca el móvil al altavoz.' : `Reproduce el vídeo en ${micLangWord(state.settings.micLang)} con el volumen alto.` };
      }
      default: return { kind: 'idle', title: '', msg: '' };
    }
  }

  function micUpdateUI() {
    if (state.view !== 'mic') return;
    const ph = micPhase();
    const btn = document.getElementById('mic-btn');
    if (btn) {
      const cls = `mic-btn${mic.active ? ' on' : ''}${['listening', 'hearing'].includes(ph) ? ' listening' : ''}${ph === 'speaking' ? ' speaking' : ''}${!mic.supported ? ' disabled' : ''}`;
      if (btn.className !== cls) btn.className = cls;
      const label = mic.active ? 'Parar' : 'Empezar';
      const lab = btn.querySelector('.lbl');
      if (lab && lab.textContent !== label) lab.textContent = label;
      const ico = btn.querySelector('.ico');
      const icon = mic.active ? (ph === 'speaking' ? '🔊' : '■') : '🎙️';
      if (ico && ico.textContent !== icon) ico.textContent = icon;
      btn.setAttribute('aria-pressed', String(mic.active));
    }
    const st = micStatus();
    const box = document.getElementById('mic-status');
    if (box) {
      const html = `<i class="dot"></i><div><b>${escapeHtml(st.title)}</b><small>${escapeHtml(st.msg)}</small></div>`;
      if (box.innerHTML !== html) box.innerHTML = html;
      box.className = `mic-status ${st.kind}`;
    }
    const counts = document.getElementById('mic-counts');
    if (counts) {
      const t = mic.stats.finals ? `${mic.stats.finals} frases oídas · ${mic.stats.translated} traducidas · ${mic.stats.spoken} dichas${mic.stats.trFailed ? ` · ${mic.stats.trFailed} sin traducir` : ''}` : '';
      if (counts.textContent !== t) counts.textContent = t;
    }
    micRenderLive();
  }

  function micRenderLive() {
    const el = document.getElementById('mic-live');
    if (!el) return;
    el.classList.toggle('hidden', !state.settings.micShowText);
    if (!state.settings.micShowText) return;
    const lines = mic.lines.slice(-6).reverse().map((l) => `
      <div class="mic-line"><div class="es">${l.es ? escapeHtml(l.es) : (l.failed ? '<span class="fail">No se pudo traducir</span>' : '<span class="pending">Traduciendo…</span>')}</div><div class="en">${escapeHtml(l.en)}</div></div>`).join('');
    const html = `${mic.interim ? `<div class="interim">${escapeHtml(mic.interim)}…</div>` : ''}${lines || (mic.interim ? '' : '<div class="empty">Aquí aparecerá el texto reconocido y su traducción.</div>')}`;
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  function renderMic() {
    const s = state.settings;
    const opts = MIC_LANGS.map(([code, name]) => `<option value="${code}" ${code === s.micLang ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('');
    return `
    <div class="view" id="view-mic">
      <div class="player-top">
        <button class="icon-btn" id="btn-back" aria-label="Volver">←</button>
        <h2>Modo micrófono</h2>
        <button class="icon-btn" id="btn-settings" title="Ajustes" aria-label="Ajustes">⚙️</button>
      </div>

      <section class="mic-stage">
        <p class="mic-kicker">Instagram · Facebook · cualquier vídeo que suene en voz alta</p>
        <button type="button" class="mic-btn" id="mic-btn" aria-pressed="false" aria-label="Empezar o parar el modo micrófono">
          <span class="ico">🎙️</span><span class="lbl">Empezar</span>
        </button>
        <div class="mic-status idle" id="mic-status" role="status" aria-live="polite"></div>
        <p class="mic-counts" id="mic-counts"></p>
      </section>

      <div class="mic-live caption-box hidden" id="mic-live" aria-live="polite"></div>

      <div class="card controls">
        <h3>Ajustes rápidos</h3>
        <div class="ctrl-row">
          <label for="mic-lang">Idioma del vídeo</label>
          <select id="mic-lang" class="select">${opts}</select>
        </div>
        <div class="ctrl-row">
          <label for="rng-rate">Velocidad voz</label>
          <input type="range" id="rng-rate" min="0.7" max="1.4" step="0.05" value="${s.voiceRate}">
          <output id="out-rate">${Number(s.voiceRate).toFixed(2)}×</output>
        </div>
        <div class="toggle"><span>Mostrar texto en pantalla</span><button type="button" class="switch ${s.micShowText ? 'on' : ''}" data-key="micShowText" aria-pressed="${!!s.micShowText}" aria-label="Mostrar texto en pantalla"></button></div>
        <button type="button" class="btn-ghost" id="btn-test-voice-inline" style="width:100%">🔊 Probar voz</button>
      </div>

      <section class="card help-card">
        <h3>Cómo usarlo</h3>
        <ol class="help-list">
          <li>Abre Instagram o Facebook en <b>pantalla dividida</b>, en <b>ventana flotante</b> o en <b>otro dispositivo</b>.</li>
          <li>Reproduce el vídeo con el <b>volumen alto</b> y <b>sin auriculares</b>.</li>
          <li>Pulsa <b>Empezar</b> aquí y <b>permite el micrófono</b>.</li>
          <li>Cuenta con <b>3–5 s de retraso</b>; la <b>música de fondo</b> empeora el reconocimiento.</li>
        </ol>
        <div class="tip"><b>Truco Android:</b> usa la pantalla dividida (botón de apps recientes › toca el icono de la app › <b>«Pantalla dividida»</b>) para tener Chrome y el vídeo a la vez. O reproduce el vídeo en una tablet/PC y escucha con el móvil.</div>
        <details class="limits">
          <summary>Limitaciones</summary>
          <ul>
            <li>Mientras habla la voz española el micrófono se pausa: lo que se diga en el vídeo en ese momento se pierde.</li>
            <li>En algunos Android, al activarse el micrófono la otra app <b>pausa o baja</b> su vídeo (Android le da el audio a Chrome). Si pasa, vuelve a darle a play o usa otro dispositivo para el vídeo: es lo más fiable.</li>
            <li>Si Chrome pasa a segundo plano o se apaga la pantalla, deja de escuchar. Con la pantalla dividida Chrome sigue visible.</li>
            <li>El reconocimiento de Chrome necesita internet. En Android puede sonar un pitido cada vez que el micrófono se reactiva.</li>
            <li>Funciona mejor con una sola persona hablando claro; canciones, ruido o varias voces a la vez fallan más.</li>
          </ul>
        </details>
      </section>
      <p class="footer-note">El audio se procesa con el reconocimiento de voz de Chrome (Google) · v${APP_VERSION}</p>
    </div>`;
  }

  function openMic() {
    state.loadToken += 1;
    ttsStop();
    destroyPlayer();
    state.videoId = null;
    state.segments = [];
    state.load = { phase: 'idle', msg: '', done: 0 };
    state.view = 'mic';
    render();
  }

  // ---------- YouTube player ----------
  window.onYouTubeIframeAPIReady = () => {
    state.ytReady = true;
    if (state.videoId && state.view === 'player' && !state.player) mountPlayer();
  };
  if (window.YT?.Player) state.ytReady = true;

  function mountPlayer() {
    const host = document.getElementById('yt-host');
    if (!host || !state.videoId || !window.YT?.Player) return;
    host.innerHTML = '';
    const div = document.createElement('div');
    div.id = 'yt-player';
    host.appendChild(div);
    state.playerReady = false;
    state.playing = false;
    const videoId = state.videoId;
    state.player = new YT.Player('yt-player', {
      videoId,
      width: '100%',
      height: '100%',
      playerVars: { rel: 0, modestbranding: 1, playsinline: 1, cc_load_policy: 0, origin: location.origin },
      events: {
        onReady: () => {
          if (state.videoId !== videoId) return;
          state.playerReady = true;
          applyAudio(false);
          dubStart();
          renderStatusOnly();
          // Sin autoplay: el usuario pulsa «▶ Reproducir con voz» (ese toque desbloquea la voz)
        },
        onStateChange: (ev) => {
          if (ev.data === 1) state.playing = true;
          if (ev.data === 2 || ev.data === 0 || ev.data === 5) state.playing = false;
          if (ev.data === 1) applyAudio(false);
          if (ev.data === 0) { dubReset(0); }
          updatePlayButton();
          renderStatusOnly();
        },
      },
    });
  }

  function destroyPlayer() {
    dubStop();
    try { state.player?.destroy?.(); } catch { /* */ }
    state.player = null;
    state.playerReady = false;
    state.playing = false;
  }

  // ---------- recent ----------
  function pushRecent(videoId, title) {
    const item = { id: videoId, title: title || videoId, at: Date.now() };
    state.recent = [item, ...state.recent.filter((r) => r.id !== videoId)].slice(0, 12);
    saveJSON(STORAGE.recent, state.recent);
  }

  // ---------- UI ----------
  function render() {
    const app = document.getElementById('app');
    if (state.view !== 'mic' && mic.active) micStop(); // salir del modo micrófono apaga el micro
    if (state.view === 'home') app.innerHTML = renderHome();
    else if (state.view === 'mic') app.innerHTML = renderMic();
    else app.innerHTML = renderPlayer();
    bindView();
  }

  function renderHome() {
    const recent = state.recent.map((r) => `
      <button class="recent-item" data-open="${escapeHtml(r.id)}">
        <img src="${thumb(r.id)}" alt="" loading="lazy" width="88" height="50">
        <div class="meta"><b>${escapeHtml(r.title)}</b><small>Hace ${timeAgo(r.at)}</small></div>
      </button>`).join('');
    return `
    <div class="view" id="view-home">
      <header class="home-head">
        <div>
          <div class="eyebrow">Doblaje personal</div>
          <h1>YT <span>Castellano</span></h1>
        </div>
        <button class="icon-btn" id="btn-settings" title="Ajustes" aria-label="Ajustes">⚙️</button>
      </header>

      <section class="hero-card">
        <h2>Pega un enlace de YouTube</h2>
        <p>Escucha el vídeo en <b>voz española</b>: traducimos el habla (vía subtítulos internos) y la narramos con TTS. El audio original va silenciado o atenuado.</p>
        <div class="url-row">
          <input id="url-input" type="url" inputmode="url" autocomplete="off" spellcheck="false"
            placeholder="https://youtube.com/watch?v=…">
          <button class="btn-primary" id="btn-load">Abrir</button>
        </div>
      </section>

      <button type="button" class="mic-entry" id="btn-mic">
        <span class="mic-entry-icon">🎙️</span>
        <div class="meta"><b>Modo micrófono <span class="badge-new">Nuevo</span></b><small>Para Instagram, Facebook… Pon el vídeo en voz alta y lo oyes en español.</small></div>
        <span class="chev" aria-hidden="true">›</span>
      </button>

      <section class="card">
        <h3>Cómo funciona</h3>
        <p class="hint">1) Obtenemos la transcripción del vídeo (solo como fuente) → 2) la pasamos a español → 3) <b>voz TTS en español</b> sincronizada con el vídeo (retraso típico 1–3 s). Pulsa <b>«▶ Reproducir con voz»</b> (no el botón de YouTube) para que el móvil permita hablar. Si no oyes nada, usa <b>Ajustes › Probar voz</b>.</p>
      </section>

      <section class="card">
        <h3>Recientes</h3>
        <div class="recent-list" id="recent-list">
          ${recent || '<p class="hint">Aún no hay vídeos. Prueba un TED talk con subtítulos.</p>'}
        </div>
      </section>

      <p class="footer-note">Uso educativo personal · no redistribuye el vídeo · depende de pistas de subtítulos públicas de YouTube · v${APP_VERSION}</p>
    </div>`;
  }

  function renderPlayer() {
    return `
    <div class="view" id="view-player">
      <div class="player-top">
        <button class="icon-btn" id="btn-back" aria-label="Volver">←</button>
        <h2 title="${escapeHtml(state.title)}">${escapeHtml(state.title || 'Reproduciendo')}</h2>
        <button class="icon-btn" id="btn-settings" title="Ajustes" aria-label="Ajustes">⚙️</button>
      </div>

      <div class="yt-wrap"><div id="yt-host"></div></div>

      <div class="status-pill ${state.status.kind}" id="status-pill" role="status" aria-live="polite">
        <i class="dot"></i><span>${escapeHtml(state.status.msg)}</span>
      </div>

      <div class="play-bar">
        <button type="button" id="btn-seek-back">−10 s</button>
        <button type="button" class="main" id="btn-playpause">▶ Reproducir con voz</button>
        <button type="button" id="btn-seek-fwd">+10 s</button>
      </div>

      <div class="voice-banner" id="voice-banner" aria-live="polite" style="margin-top:14px">
        <span class="vb-icon">🎙️</span>
        <div style="flex:1;min-width:0">
          <b id="voice-banner-title">Doblaje en español</b>
          <small id="voice-banner-sub">Preparando…</small>
        </div>
        <button type="button" class="btn-ghost vb-test" id="btn-test-voice-inline">🔊 Probar voz</button>
      </div>

      <div class="caption-box ${state.settings.showCaptions ? '' : 'hidden'}" id="caption-box">
        <span style="color:var(--muted);font-weight:600">Preparando voz en español…</span>
      </div>

      <div class="card controls">
        <h3>Audio y voz</h3>
        <div class="ctrl-row">
          <label for="rng-orig">Original al hablar</label>
          <input type="range" id="rng-orig" min="0" max="100" value="${state.settings.originalVolume}">
          <output id="out-orig">${state.settings.originalVolume}%</output>
        </div>
        <div class="ctrl-row">
          <label for="rng-idle">Original en silencio</label>
          <input type="range" id="rng-idle" min="0" max="100" value="${state.settings.idleVolume}">
          <output id="out-idle">${state.settings.idleVolume}%</output>
        </div>
        <div class="ctrl-row">
          <label for="rng-rate">Velocidad voz</label>
          <input type="range" id="rng-rate" min="0.7" max="1.4" step="0.05" value="${state.settings.voiceRate}">
          <output id="out-rate">${Number(state.settings.voiceRate).toFixed(2)}×</output>
        </div>
        <div class="toggle" id="tog-mute"><span>Silenciar audio original (recomendado)</span><button type="button" class="switch ${state.settings.muteOriginal ? 'on' : ''}" data-key="muteOriginal" aria-pressed="${state.settings.muteOriginal}"></button></div>
        <div class="toggle" id="tog-caps"><span>Mostrar texto (opcional)</span><button type="button" class="switch ${state.settings.showCaptions ? 'on' : ''}" data-key="showCaptions" aria-pressed="${state.settings.showCaptions}"></button></div>
      </div>

      <button class="btn-ghost block" id="btn-paste" style="width:100%;margin-top:14px">Pegar transcripción manual…</button>
    </div>`;
  }

  function timeAgo(ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return 'un momento';
    if (s < 3600) return `${Math.floor(s / 60)} min`;
    if (s < 86400) return `${Math.floor(s / 3600)} h`;
    return `${Math.floor(s / 86400)} d`;
  }

  function goHome() {
    micStop();
    state.loadToken += 1;
    ttsStop();
    destroyPlayer();
    state.videoId = null;
    state.segments = [];
    state.load = { phase: 'idle', msg: '', done: 0 };
    state.view = 'home';
    render();
  }

  function onPlayTap() {
    // ¡Síncrono dentro del gesto! Desbloquea la voz en Chrome Android.
    ttsUnlock('Doblaje activado');
    const p = state.player;
    if (!p || !state.playerReady) { toast('El reproductor aún está cargando…'); return; }
    let st = -1;
    try { st = p.getPlayerState(); } catch { /* */ }
    if (st === 1 || st === 3) {
      p.pauseVideo();
    } else {
      applyAudio(false);
      p.playVideo();
    }
  }

  function bindView() {
    document.getElementById('btn-settings')?.addEventListener('click', openSettings);
    document.getElementById('btn-back')?.addEventListener('click', goHome);
    document.getElementById('btn-mic')?.addEventListener('click', () => openMic());
    document.getElementById('btn-load')?.addEventListener('click', () => {
      openVideo(document.getElementById('url-input')?.value || '');
      ttsUnlock('Preparando el doblaje');
    });
    document.getElementById('url-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { openVideo(e.target.value); ttsUnlock('Preparando el doblaje'); }
    });
    document.querySelectorAll('[data-open]').forEach((btn) => {
      btn.addEventListener('click', () => { openVideo(btn.getAttribute('data-open')); ttsUnlock('Preparando el doblaje'); });
    });

    const bindRange = (id, outId, key, fmt) => {
      const el = document.getElementById(id);
      const out = document.getElementById(outId);
      el?.addEventListener('input', () => {
        state.settings[key] = Number(el.value);
        if (out) out.textContent = fmt(state.settings[key]);
        saveJSON(STORAGE.settings, state.settings);
        if (key === 'originalVolume' || key === 'idleVolume') applyAudio();
      });
    };
    bindRange('rng-orig', 'out-orig', 'originalVolume', (v) => `${v}%`);
    bindRange('rng-idle', 'out-idle', 'idleVolume', (v) => `${v}%`);
    bindRange('rng-rate', 'out-rate', 'voiceRate', (v) => `${Number(v).toFixed(2)}×`);

    document.querySelectorAll('.switch[data-key]').forEach((sw) => {
      sw.addEventListener('click', () => {
        const key = sw.getAttribute('data-key');
        state.settings[key] = !state.settings[key];
        sw.classList.toggle('on', state.settings[key]);
        sw.setAttribute('aria-pressed', String(state.settings[key]));
        saveJSON(STORAGE.settings, state.settings);
        if (key === 'showCaptions') document.getElementById('caption-box')?.classList.toggle('hidden', !state.settings.showCaptions);
        if (key === 'muteOriginal') applyAudio();
        if (key === 'micShowText') micUpdateUI();
      });
    });

    document.getElementById('btn-playpause')?.addEventListener('click', onPlayTap);
    const seekBy = (d) => {
      if (!state.player || !state.playerReady) { ttsUnlock('Doblaje activado'); return; }
      const t = Math.max(0, playerTime() + d);
      dubReset(t);
      ttsUnlock('Doblaje activado');
      dub.lastT = t; dub.lastWall = 0;
      state.player.seekTo(t, true);
    };
    document.getElementById('btn-seek-back')?.addEventListener('click', () => seekBy(-10));
    document.getElementById('btn-seek-fwd')?.addEventListener('click', () => seekBy(10));
    document.getElementById('btn-paste')?.addEventListener('click', openPasteSheet);
    document.getElementById('btn-test-voice-inline')?.addEventListener('click', () => testVoice());

    if (state.view === 'mic') {
      document.getElementById('mic-btn')?.addEventListener('click', () => {
        if (mic.active) micStopTap(); else micStartTap();
      });
      const sel = document.getElementById('mic-lang');
      sel?.addEventListener('change', () => {
        state.settings.micLang = sel.value;
        saveJSON(STORAGE.settings, state.settings);
        if (mic.rec) { // reiniciar el reconocimiento con el idioma nuevo
          const rec = mic.rec;
          micDetach();
          try { rec.abort(); } catch { /* */ }
          mic.backoff = 0; mic.nextStartAt = performance.now() + 250; mic.endedAt = performance.now();
        }
        toast(`Idioma del vídeo: ${micLangName(sel.value)}`);
        micUpdateUI();
      });
      ttsLoadVoices();
      micUpdateUI();
    }

    if (state.view === 'player') {
      if (state.ytReady && !state.player) mountPlayer();
      ttsLoadVoices();
      renderStatusOnly();
      updatePlayButton();
    }
  }

  // ---------- Probar voz ----------
  const TEST_SENTENCE = 'Hola. Esta es la voz en español del doblaje. Si me oyes, todo funciona.';
  function voiceInfoText() {
    if (!tts.supported) return 'Este navegador no tiene síntesis de voz. Usa Google Chrome.';
    const es = hasSpanishVoice();
    const n = tts.voices.length;
    if (es === null) return 'El navegador aún no ha listado voces (normal en Android). Pulsa «Probar voz».';
    if (!es) return `⚠️ No se detecta ninguna voz en español entre ${n} voces. Instala «Español (España)» en Ajustes del móvil › Texto a voz › Servicios de Google.`;
    const v = tts.esVoice;
    const mode = tts.useVoiceObject ? 'voz concreta' : 'idioma es-ES (modo Android)';
    return `Voz española: ${v ? `${v.name} (${v.lang})` : 'predeterminada es-ES'} · ${mode} · ${n} voces`;
  }
  function updateVoiceInfo() {
    const el = document.getElementById('voice-info');
    if (el) el.textContent = voiceInfoText();
  }
  function testVoice(resultEl) {
    // síncrono en el gesto
    if (!tts.supported) { toast('Este navegador no tiene voz sintética'); if (resultEl) resultEl.textContent = voiceInfoText(); return; }
    try { if (state.playing) state.player?.pauseVideo?.(); } catch { /* */ }
    dub.item = null;
    const show = (msg) => { if (resultEl) resultEl.textContent = msg; else toast(msg, 4200); };
    show('Probando…');
    const run = () => ttsSpeakNow(TEST_SENTENCE, {
      watchdogMs: 6000,
      onstart: () => show('✅ La voz está sonando. ¿No la oyes? Sube el volumen MULTIMEDIA del móvil.'),
      onend: (rec) => { if (rec?.started) show('✅ Voz OK. Si no la oíste, sube el volumen multimedia y revisa Texto a voz de Google.'); },
      onerror: (code) => {
        show(code === 'not-allowed'
          ? '❌ El navegador bloqueó la voz. Vuelve a pulsar «Probar voz».'
          : `❌ La voz no arrancó (${code}). Instala/actualiza «Servicios de voz de Google» y la voz Español en Ajustes › Texto a voz.`);
      },
    });
    let busy = !!tts.current;
    try { busy = busy || speechSynthesis.speaking || speechSynthesis.pending; } catch { /* */ }
    if (busy) { ttsStop(); setTimeout(run, 150); } else run();
    updateVoiceInfo();
  }

  function openSettings() {
    const s = state.settings;
    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.innerHTML = `
      <div class="sheet-panel" role="dialog" aria-label="Ajustes">
        <div class="sheet-handle"></div>
        <h2 style="margin:0 0 12px;font-size:22px">Ajustes</h2>
        <div class="card">
          <h3>Voz en español</h3>
          <p class="hint" id="voice-info">${escapeHtml(voiceInfoText())}</p>
          <button type="button" class="btn-primary solid block" id="set-test-voice">🔊 Probar voz</button>
          <p class="hint" id="voice-test-result" style="margin-top:8px;font-weight:700"></p>
        </div>
        <div class="card">
          <h3>Sincronización</h3>
          <div class="ctrl-row">
            <label>Anticipación TTS</label>
            <input type="range" id="set-look" min="0" max="1.5" step="0.05" value="${s.lookahead}">
            <output id="out-look">${Number(s.lookahead).toFixed(2)} s</output>
          </div>
          <div class="toggle" style="margin-top:10px"><span>Atenuar original al hablar</span>
            <button type="button" class="switch ${s.ducking ? 'on' : ''}" id="set-duck"></button></div>
        </div>
        <div class="card">
          <h3>Proxy de subtítulos (opcional)</h3>
          <p class="hint">URL de un Cloudflare Worker propio si el origen público falla. Vacío = youtubegpt.ai</p>
          <input id="set-proxy" type="url" placeholder="https://….workers.dev" value="${escapeHtml(s.captionProxy || '')}"
            style="width:100%;margin-top:8px;border-radius:14px;border:1px solid var(--line);padding:12px;background:var(--card)">
        </div>
        <div class="card">
          <h3>Acerca de</h3>
          <p class="hint">Versión ${APP_VERSION}. Esta app no descarga ni redistribuye vídeos de YouTube. Solo usa pistas de subtítulos públicas y la API de iframe. Uso educativo personal.</p>
        </div>
        <button class="btn-primary solid block" id="set-save">Guardar</button>
        <button class="btn-ghost" id="set-close" style="width:100%;margin-top:10px">Cerrar</button>
      </div>`;
    document.body.appendChild(sheet);
    const close = () => sheet.remove();
    sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });
    sheet.querySelector('#set-close').onclick = close;
    sheet.querySelector('#set-test-voice').onclick = () => testVoice(sheet.querySelector('#voice-test-result'));
    const look = sheet.querySelector('#set-look');
    const out = sheet.querySelector('#out-look');
    look.oninput = () => { out.textContent = `${Number(look.value).toFixed(2)} s`; };
    const duck = sheet.querySelector('#set-duck');
    duck.onclick = () => duck.classList.toggle('on');
    sheet.querySelector('#set-save').onclick = () => {
      state.settings.lookahead = Number(look.value);
      state.settings.ducking = duck.classList.contains('on');
      state.settings.captionProxy = sheet.querySelector('#set-proxy').value.trim();
      saveJSON(STORAGE.settings, state.settings);
      applyAudio();
      toast('Ajustes guardados');
      close();
    };
  }

  function openPasteSheet() {
    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.innerHTML = `
      <div class="sheet-panel">
        <div class="sheet-handle"></div>
        <h2 style="margin:0 0 8px;font-size:20px">Transcripción manual</h2>
        <p class="hint">Pega texto con tiempos opcionales: <code>[mm:ss] frase</code> o SRT/VTT. Se traducirá a español si hace falta.</p>
        <textarea class="paste" id="paste-area" placeholder="[00:27] Good morning. How are you?&#10;[00:31] It's been great, hasn't it?"></textarea>
        <button class="btn-primary solid block" id="paste-apply">Usar esta transcripción</button>
        <button class="btn-ghost" id="paste-close" style="width:100%;margin-top:10px">Cancelar</button>
      </div>`;
    document.body.appendChild(sheet);
    const close = () => sheet.remove();
    sheet.querySelector('#paste-close').onclick = close;
    sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });
    sheet.querySelector('#paste-apply').onclick = async () => {
      ttsUnlock('Preparando el doblaje');
      const raw = sheet.querySelector('#paste-area').value;
      const parsed = parseManualTranscript(raw);
      if (!parsed.length) { toast('No se pudo interpretar el texto'); return; }
      close();
      const token = ++state.loadToken;
      const chunks = mergeChunks(normalizeSegments(parsed));
      state.segments = chunks;
      state.load = { phase: 'translating', msg: '', done: 0 };
      dubReset(playerTime());
      renderStatusOnly();
      await translateChunks(chunks, state.videoId || 'manual', 'auto', token, () => { applyAudio(); renderStatusOnly(); });
      if (token !== state.loadToken) return;
      state.load = { phase: 'ready', msg: '', done: chunks.length };
      applyAudio();
      renderStatusOnly();
      toast('Transcripción lista');
    };
  }

  function parseManualTranscript(raw) {
    const text = String(raw || '').trim();
    if (!text) return [];
    // SRT / VTT
    if (/\d{1,2}:\d{2}(:\d{2})?[,.]\d{3}\s+-->/.test(text)) {
      const blocks = text.replace(/\r/g, '').split(/\n\s*\n/);
      const segs = [];
      const toSec = (h, m, s, ms) => (+h || 0) * 3600 + (+m) * 60 + (+s) + (+ms) / 1000;
      for (const b of blocks) {
        const m = b.match(/(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{3})\s+-->\s+(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{3})[^\n]*\n([\s\S]+)/);
        if (!m) continue;
        const start = toSec(m[1], m[2], m[3], m[4]);
        const end = toSec(m[5], m[6], m[7], m[8]);
        segs.push({ start, dur: Math.max(0.5, end - start), text: cleanText(m[9]) });
      }
      return segs.filter((s) => s.text);
    }
    const lines = text.split(/\n+/);
    const timed = [];
    for (const line of lines) {
      const m = line.match(/^\s*\[?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]?\s*(.+)\s*$/);
      if (m) {
        const h = m[1] ? +m[1] : 0;
        timed.push({ start: h * 3600 + (+m[2]) * 60 + (+m[3]), text: cleanText(m[4]) });
      }
    }
    if (timed.length) {
      return timed.map((t, i) => ({
        start: t.start,
        dur: i + 1 < timed.length ? Math.max(0.8, timed[i + 1].start - t.start) : 3,
        text: t.text,
      }));
    }
    return text.split(/(?<=[.!?])\s+/).filter(Boolean).map((t, i) => ({ start: i * 4, dur: 3.5, text: cleanText(t) }));
  }

  async function openVideo(input) {
    const id = extractVideoId(input);
    if (!id) { toast('URL o ID de YouTube no válido'); return; }
    const token = ++state.loadToken;
    ttsStop();
    destroyPlayer();
    state.videoId = id;
    state.title = id;
    state.segments = [];
    state.sourceLang = '';
    state.currentIdx = -1;
    state.load = { phase: 'loading', msg: '', done: 0 };
    state.view = 'player';
    render(); // monta el reproductor; el audio original NO se silencia hasta que haya voz española

    let cap;
    try {
      cap = await fetchCaptions(id);
    } catch (err) {
      if (token !== state.loadToken) return;
      console.error(err);
      state.load = { phase: 'error', msg: captionErrorMessage(err), done: 0 };
      applyAudio();
      renderStatusOnly();
      toast('No hay transcripción automática; puedes pegar una para doblar', 4000);
      return;
    }
    if (token !== state.loadToken) return;

    state.title = cap.title || id;
    if (!cap.title) {
      try {
        const { res, data } = await fetchJSON(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`, 8000);
        if (res.ok && data?.title) state.title = data.title;
      } catch { /* */ }
    }
    if (token !== state.loadToken) return;
    document.querySelector('.player-top h2')?.replaceChildren(document.createTextNode(state.title));
    pushRecent(id, state.title);

    const chunks = mergeChunks(normalizeSegments(cap.segments));
    state.sourceLang = cap.lang;
    const isEs = /^es/i.test(cap.lang);
    if (isEs) chunks.forEach((c) => { c.textEs = c.text; });
    state.segments = chunks;
    dub.nextIdx = dubFirstIdxAt(playerTime());

    if (!isEs) {
      state.load = { phase: 'translating', msg: '', done: 0 };
      renderStatusOnly();
      await translateChunks(chunks, id, cap.lang, token, () => {
        if (token !== state.loadToken) return;
        state.load.done = chunks.filter((c) => c.textEs).length;
        applyAudio();
        renderStatusOnly();
      });
      if (token !== state.loadToken) return;
    }
    state.load = { phase: 'ready', msg: '', done: chunks.length };
    applyAudio();
    renderStatusOnly();
  }

  // ---------- boot ----------
  function boot() {
    ttsInit();
    if ('serviceWorker' in navigator) {
      const hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
        .then((reg) => reg.update?.().catch(() => {}))
        .catch(() => {});
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || reloaded) return;
        reloaded = true;
        if (!state.playing) location.reload();
        else toast('Nueva versión disponible: recarga la página', 5000);
      });
    }
    // cualquier toque en la página reactiva la voz si el navegador la bloqueó por falta de gesto
    document.addEventListener('click', () => {
      if (tts.lastError === 'not-allowed') ttsUnlock(state.view === 'mic' ? 'Voz activada' : 'Doblaje activado');
    }, true);
    // Modo micrófono: reflejar segundo plano y recuperar el bloqueo de pantalla al volver
    document.addEventListener('visibilitychange', () => {
      if (!mic.active) return;
      if (!document.hidden) { micWakeLock(true); mic.nextStartAt = Math.min(mic.nextStartAt, performance.now()); }
      micUpdateUI();
    });
    const params = new URLSearchParams(location.search);
    if (params.get('demo') === '1') state.demoMode = true;
    window.__ytCast = {
      version: APP_VERSION,
      state,
      tts,
      dub,
      extractVideoId,
      fetchCaptions,
      openVideo,
      parseManualTranscript,
      mergeSegments,
      mergeChunks,
      normalizeSegments,
      translateBatch,
      ttsSay,
      ttsUnlock,
      testVoice,
      hasSpanishVoice,
      mic,
      micStartTap,
      micStopTap,
      openMic,
    };
    if (params.get('micro') === '1' || location.hash === '#micro') state.view = 'mic';
    render();
    if (params.get('v')) openVideo(params.get('v'));
  }

  boot();
})();
