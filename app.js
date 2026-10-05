/* YT Castellano — PWA de doblaje español vía subtítulos + Web Speech API */
(() => {
  'use strict';

  const STORAGE = {
    settings: 'ytcast-settings-v1',
    recent: 'ytcast-recent-v1',
    translations: 'ytcast-tr-v1',
  };

  const CAPTION_SOURCES = [
    {
      name: 'youtubegpt.ai',
      async fetch(videoId, lang) {
        const url = `https://youtubegpt.ai/api/transcript?v=${encodeURIComponent(videoId)}&format=json&lang=${encodeURIComponent(lang)}`;
        const res = await fetch(url, { credentials: 'omit' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data || data.ok === false) throw new Error(data?.error || 'Respuesta inválida');
        const raw = data.segments || [];
        // youtubegpt.ai returns start/dur in milliseconds
        const sample = raw.slice(0, 12);
        const looksMs = sample.some((s) => Number(s.dur) > 120 || Number(s.start) > 500);
        const div = looksMs ? 1000 : 1;
        return raw.map((s) => ({
          start: (Number(s.start) || 0) / div,
          dur: Math.max(0.4, (Number(s.dur) || 2000) / div),
          text: cleanText(s.text || ''),
        })).filter((s) => s.text);
      },
    },
    {
      name: 'worker',
      async fetch(videoId, lang) {
        const base = (state.settings.captionProxy || '').trim().replace(/\/$/, '');
        if (!base) throw new Error('Sin proxy configurado');
        const url = `${base}/?v=${encodeURIComponent(videoId)}&lang=${encodeURIComponent(lang)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data.segments?.length) throw new Error('Sin segmentos');
        return data.segments.map((s) => ({
          start: Number(s.start),
          dur: Number(s.dur || s.duration || 2),
          text: cleanText(s.text || ''),
        })).filter((s) => s.text);
      },
    },
  ];

  const DEFAULT_SETTINGS = {
    originalVolume: 8,       // residual original while Spanish speaks (if not muted)
    idleVolume: 25,          // original between Spanish phrases (if not muted)
    muteOriginal: true,      // product default: hear Spanish voice, not English audio
    voiceRate: 1.05,
    voicePitch: 1,
    showCaptions: false,     // on-screen Spanish text is optional; TTS is the product
    lookahead: 0.35,         // seconds before segment start to trigger TTS
    ducking: true,
    preferSpanishTrack: true,
    captionProxy: '',        // optional Cloudflare Worker URL
  };

  const state = {
    view: 'home',
    settings: loadJSON(STORAGE.settings, DEFAULT_SETTINGS),
    recent: loadJSON(STORAGE.recent, []),
    videoId: null,
    title: '',
    segments: [],           // [{start, dur, text, textEs?}]
    player: null,
    ytReady: false,
    status: { kind: 'idle', msg: 'Pega un enlace de YouTube' },
    currentIdx: -1,
    speaking: false,
    lastSpokenIdx: -1,
    raf: 0,
    demoMode: false,
    _speakCalls: 0,         // for tests
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

  // ---------- translation cache ----------
  function trCacheKey(videoId, text) {
    return `${videoId}::${text}`;
  }
  function getTrCache() {
    return loadJSON(STORAGE.translations, {});
  }
  function setTrCache(map) {
    // keep cache bounded
    const keys = Object.keys(map);
    if (keys.length > 800) {
      keys.slice(0, keys.length - 600).forEach((k) => delete map[k]);
    }
    saveJSON(STORAGE.translations, map);
  }

  async function translateToEs(text, videoId) {
    const cache = getTrCache();
    const key = trCacheKey(videoId, text);
    if (cache[key]) return cache[key];

    // 1) Google clients5 (CORS *)
    try {
      const url = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=es&q=${encodeURIComponent(text)}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        let out = '';
        if (Array.isArray(data)) {
          if (typeof data[0] === 'string') out = data[0];
          else if (Array.isArray(data[0])) out = data.map((row) => (Array.isArray(row) ? row[0] : row)).join('');
        }
        out = cleanText(out);
        if (out) {
          cache[key] = out;
          setTrCache(cache);
          return out;
        }
      }
    } catch { /* next */ }

    // 2) MyMemory
    try {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 450))}&langpair=en|es`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const out = cleanText(data?.responseData?.translatedText || '');
        if (out && !/MYMEMORY WARNING/i.test(out)) {
          cache[key] = out;
          setTrCache(cache);
          return out;
        }
      }
    } catch { /* next */ }

    return text; // fallback: original
  }

  async function ensureSpanish(segments, videoId, alreadyEs) {
    if (alreadyEs) {
      return segments.map((s) => ({ ...s, textEs: s.text }));
    }
    const out = [];
    // batch small groups to reduce API chatter
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      const textEs = await translateToEs(s.text, videoId);
      out.push({ ...s, textEs });
      if (i % 8 === 0) {
        state.status = { kind: 'busy', msg: `Traduciendo… ${i + 1}/${segments.length}` };
        renderStatusOnly();
        await new Promise((r) => setTimeout(r, 30));
      }
    }
    return out;
  }

  function mergeSegments(segments) {
    // Merge tiny cues into speakable chunks (~max 110 chars / 4.5s)
    const merged = [];
    let buf = null;
    for (const s of segments) {
      const t = s.textEs || s.text;
      if (!t) continue;
      // skip translator credits at start
      if (/^traductor:/i.test(t) || /^revisor:/i.test(t)) continue;
      if (!buf) {
        buf = { start: s.start, dur: s.dur, text: s.text, textEs: t };
        continue;
      }
      const gap = s.start - (buf.start + buf.dur);
      const combined = `${buf.textEs} ${t}`.trim();
      if (gap < 0.45 && combined.length <= 110 && buf.dur + s.dur < 5.2) {
        buf.dur = (s.start + s.dur) - buf.start;
        buf.textEs = combined;
        buf.text = `${buf.text || ''} ${s.text || ''}`.trim();
      } else {
        merged.push(buf);
        buf = { start: s.start, dur: s.dur, text: s.text, textEs: t };
      }
    }
    if (buf) merged.push(buf);
    return merged;
  }

  // ---------- captions ----------
  async function fetchCaptions(videoId) {
    let lastErr = null;
    let segments = null;
    let langUsed = 'es';
    let alreadyEs = true;

    // Prefer Spanish track from youtubegpt
    for (const src of CAPTION_SOURCES) {
      try {
        if (src.name === 'worker' && !state.settings.captionProxy) continue;
        const segs = await src.fetch(videoId, 'es');
        if (segs?.length) {
          segments = segs;
          langUsed = 'es';
          alreadyEs = true;
          state.status = { kind: 'ok', msg: `Subtítulos ES vía ${src.name} (${segs.length})` };
          break;
        }
      } catch (e) {
        lastErr = e;
      }
    }

    if (!segments) {
      for (const src of CAPTION_SOURCES) {
        try {
          if (src.name === 'worker' && !state.settings.captionProxy) continue;
          const segs = await src.fetch(videoId, 'en');
          if (segs?.length) {
            segments = segs;
            langUsed = 'en';
            alreadyEs = false;
            state.status = { kind: 'busy', msg: `Subtítulos EN vía ${src.name}; traduciendo…` };
            break;
          }
        } catch (e) {
          lastErr = e;
        }
      }
    }

    if (!segments?.length) {
      throw lastErr || new Error('No hay subtítulos disponibles para este vídeo');
    }

    let withEs = await ensureSpanish(segments, videoId, alreadyEs);
    withEs = mergeSegments(withEs);
    return { segments: withEs, langUsed };
  }

  // ---------- TTS ----------
  function pickSpanishVoice() {
    const voices = speechSynthesis.getVoices() || [];
    const prefer = [
      (v) => /es-ES/i.test(v.lang) && /google|microsoft|sabina|jorge|monica|paulina/i.test(v.name),
      (v) => /es-ES/i.test(v.lang),
      (v) => /^es[-_]/i.test(v.lang),
      (v) => /spanish|español/i.test(v.name),
    ];
    for (const pred of prefer) {
      const hit = voices.find(pred);
      if (hit) return hit;
    }
    return null;
  }

  function stopSpeech() {
    try { speechSynthesis.cancel(); } catch { /* */ }
    state.speaking = false;
  }

  function speakSegment(seg, idx) {
    if (!('speechSynthesis' in window)) return;
    stopSpeech();
    const u = new SpeechSynthesisUtterance(seg.textEs || seg.text);
    const voice = pickSpanishVoice();
    if (voice) u.voice = voice;
    u.lang = voice?.lang || 'es-ES';
    u.rate = Number(state.settings.voiceRate) || 1;
    u.pitch = Number(state.settings.voicePitch) || 1;
    u.onstart = () => {
      state.speaking = true;
      state._speakCalls += 1;
      applyDucking(true);
      state.currentIdx = idx;
      updateCaptionBox();
    };
    u.onend = () => {
      state.speaking = false;
      applyDucking(false);
    };
    u.onerror = () => {
      state.speaking = false;
      applyDucking(false);
    };
    speechSynthesis.speak(u);
  }

  function applyDucking(active) {
    if (!state.player || typeof state.player.setVolume !== 'function') return;
    if (state.settings.muteOriginal) {
      state.player.setVolume(0);
      state.player.mute?.();
      return;
    }
    if (!state.settings.ducking) {
      state.player.unMute?.();
      state.player.setVolume(Number(state.settings.idleVolume) || 50);
      return;
    }
    state.player.unMute?.();
    const vol = active ? Number(state.settings.originalVolume) : Number(state.settings.idleVolume);
    state.player.setVolume(Math.max(0, Math.min(100, vol)));
  }

  function syncLoop() {
    cancelAnimationFrame(state.raf);
    const tick = () => {
      state.raf = requestAnimationFrame(tick);
      if (!state.player || !state.segments.length) return;
      let t = 0;
      try { t = state.player.getCurrentTime() || 0; } catch { return; }
      const playing = state.player.getPlayerState?.() === 1; // YT.Playing
      if (!playing) {
        if (speechSynthesis.speaking && !speechSynthesis.paused) {
          try { speechSynthesis.pause(); } catch { /* */ }
        }
        return;
      }
      if (speechSynthesis.paused) {
        try { speechSynthesis.resume(); } catch { /* */ }
      }
      const look = Number(state.settings.lookahead) || 0.35;
      // find next segment to speak
      let idx = state.segments.findIndex((s, i) => i > state.lastSpokenIdx && t + look >= s.start);
      if (idx < 0) {
        // maybe seeked backwards
        const cur = state.segments.findIndex((s) => t >= s.start && t <= s.start + Math.max(s.dur, 0.8) + 0.5);
        if (cur >= 0 && cur !== state.currentIdx && cur < state.lastSpokenIdx) {
          state.lastSpokenIdx = cur - 1;
          idx = cur;
        }
      }
      if (idx >= 0 && idx !== state.lastSpokenIdx) {
        // skip if we're far past the segment end
        const s = state.segments[idx];
        if (t > s.start + Math.max(s.dur, 1.2) + 1.5) {
          state.lastSpokenIdx = idx;
          return;
        }
        state.lastSpokenIdx = idx;
        speakSegment(s, idx);
      }
      updateCaptionBox(t);
    };
    state.raf = requestAnimationFrame(tick);
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
    el.innerHTML = `${escapeHtml(s.textEs || s.text)}${s.text && s.textEs && s.text !== s.textEs ? `<span class="orig">${escapeHtml(s.text)}</span>` : ''}`;
  }

  // ---------- YouTube player ----------
  window.onYouTubeIframeAPIReady = () => {
    state.ytReady = true;
    if (state.videoId && state.view === 'player') mountPlayer();
  };
  // In case API already loaded
  if (window.YT?.Player) state.ytReady = true;

  function mountPlayer() {
    const host = document.getElementById('yt-host');
    if (!host || !state.videoId) return;
    host.innerHTML = '';
    const div = document.createElement('div');
    div.id = 'yt-player';
    host.appendChild(div);
    state.player = new YT.Player('yt-player', {
      videoId: state.videoId,
      width: '100%',
      height: '100%',
      playerVars: {
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        cc_load_policy: 0,
        origin: location.origin,
      },
      events: {
        onReady: (e) => {
          applyDucking(false);
          state.status = { kind: 'ok', msg: `Voz española activa · ${state.segments.length} frases` };
          renderStatusOnly();
          syncLoop();
          try { e.target.playVideo(); } catch { /* autoplay may block */ }
        },
        onStateChange: (ev) => {
          if (ev.data === 2 /* paused */ || ev.data === 0 /* ended */) {
            try { speechSynthesis.pause(); } catch { /* */ }
          }
          if (ev.data === 1) {
            try { speechSynthesis.resume(); } catch { /* */ }
          }
          if (ev.data === 0) stopSpeech();
        },
      },
    });
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
    if (state.view === 'home') app.innerHTML = renderHome();
    else app.innerHTML = renderPlayer();
    bindView();
  }

  function renderStatusOnly() {
    const el = document.getElementById('status-pill');
    if (!el) return;
    el.className = `status-pill ${state.status.kind}`;
    el.innerHTML = `<i class="dot"></i><span>${escapeHtml(state.status.msg)}</span>`;
  }

  function renderHome() {
    const recent = state.recent.map((r) => `
      <button class="recent-item" data-open="${r.id}">
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

      <section class="card">
        <h3>Cómo funciona</h3>
        <p class="hint">1) Obtenemos la transcripción del vídeo (solo como fuente) → 2) la pasamos a español → 3) <b>voz TTS en español</b> sincronizada con el vídeo (retraso típico 1–3 s). El texto en pantalla es opcional y viene desactivado. Sin transcripción no hay doblaje; puedes pegar una manualmente.</p>
      </section>

      <section class="card">
        <h3>Recientes</h3>
        <div class="recent-list" id="recent-list">
          ${recent || '<p class="hint">Aún no hay vídeos. Prueba un TED talk con subtítulos.</p>'}
        </div>
      </section>

      <p class="footer-note">Uso educativo personal · no redistribuye el vídeo · depende de pistas de subtítulos públicas de YouTube</p>
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

      <div class="status-pill ${state.status.kind}" id="status-pill">
        <i class="dot"></i><span>${escapeHtml(state.status.msg)}</span>
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

      <div class="play-bar">
        <button type="button" id="btn-seek-back">−10 s</button>
        <button type="button" class="main" id="btn-playpause">▶️ / ⏸️</button>
        <button type="button" id="btn-seek-fwd">+10 s</button>
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

  function bindView() {
    document.getElementById('btn-settings')?.addEventListener('click', openSettings);
    document.getElementById('btn-back')?.addEventListener('click', () => {
      stopSpeech();
      cancelAnimationFrame(state.raf);
      try { state.player?.destroy?.(); } catch { /* */ }
      state.player = null;
      state.view = 'home';
      render();
    });
    document.getElementById('btn-load')?.addEventListener('click', () => {
      const v = document.getElementById('url-input')?.value || '';
      openVideo(v);
    });
    document.getElementById('url-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') openVideo(e.target.value);
    });
    document.querySelectorAll('[data-open]').forEach((btn) => {
      btn.addEventListener('click', () => openVideo(btn.getAttribute('data-open')));
    });

    // player controls
    const bindRange = (id, outId, key, fmt) => {
      const el = document.getElementById(id);
      const out = document.getElementById(outId);
      el?.addEventListener('input', () => {
        state.settings[key] = Number(el.value);
        if (out) out.textContent = fmt(state.settings[key]);
        saveJSON(STORAGE.settings, state.settings);
        if (key === 'originalVolume' || key === 'idleVolume' || key === 'muteOriginal') applyDucking(state.speaking);
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
        if (key === 'showCaptions') {
          document.getElementById('caption-box')?.classList.toggle('hidden', !state.settings.showCaptions);
        }
        if (key === 'muteOriginal') applyDucking(state.speaking);
      });
    });

    document.getElementById('btn-playpause')?.addEventListener('click', () => {
      if (!state.player) return;
      const st = state.player.getPlayerState?.();
      if (st === 1) state.player.pauseVideo();
      else state.player.playVideo();
    });
    document.getElementById('btn-seek-back')?.addEventListener('click', () => {
      if (!state.player) return;
      const t = Math.max(0, (state.player.getCurrentTime?.() || 0) - 10);
      state.lastSpokenIdx = -1;
      stopSpeech();
      state.player.seekTo(t, true);
    });
    document.getElementById('btn-seek-fwd')?.addEventListener('click', () => {
      if (!state.player) return;
      const t = (state.player.getCurrentTime?.() || 0) + 10;
      state.lastSpokenIdx = -1;
      stopSpeech();
      state.player.seekTo(t, true);
    });
    document.getElementById('btn-paste')?.addEventListener('click', openPasteSheet);

    if (state.view === 'player') {
      if (state.ytReady) mountPlayer();
      // chrome loads voices async
      speechSynthesis.getVoices();
      speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
    }
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
          <p class="hint">Esta app no descarga ni redistribuye vídeos de YouTube. Solo usa pistas de subtítulos públicas y la API de iframe. Uso educativo personal.</p>
        </div>
        <button class="btn-primary solid block" id="set-save">Guardar</button>
        <button class="btn-ghost" id="set-close" style="width:100%;margin-top:10px">Cerrar</button>
      </div>`;
    document.body.appendChild(sheet);
    const close = () => sheet.remove();
    sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });
    sheet.querySelector('#set-close').onclick = close;
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
      const raw = sheet.querySelector('#paste-area').value;
      const parsed = parseManualTranscript(raw);
      if (!parsed.length) { toast('No se pudo interpretar el texto'); return; }
      close();
      state.status = { kind: 'busy', msg: 'Traduciendo transcripción…' };
      renderStatusOnly();
      let segs = await ensureSpanish(parsed, state.videoId || 'manual', false);
      segs = mergeSegments(segs);
      state.segments = segs;
      state.lastSpokenIdx = -1;
      state.status = { kind: 'ok', msg: `${segs.length} frases (manual)` };
      renderStatusOnly();
      updateCaptionBox(0);
      toast('Transcripción lista');
    };
  }

  function parseManualTranscript(raw) {
    const text = String(raw || '').trim();
    if (!text) return [];
    // SRT
    if (/\d+\s+\d{2}:\d{2}:\d{2},\d{3}\s+-->/.test(text)) {
      const blocks = text.split(/\n\s*\n/);
      const segs = [];
      for (const b of blocks) {
        const m = b.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*\n([\s\S]+)/);
        if (!m) continue;
        const start = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
        const end = (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000;
        segs.push({ start, dur: Math.max(0.5, end - start), text: cleanText(m[9]) });
      }
      return segs;
    }
    // [mm:ss] or [hh:mm:ss] lines
    const lines = text.split(/\n+/);
    const timed = [];
    for (const line of lines) {
      const m = line.match(/^\s*\[?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]?\s*(.+)\s*$/);
      if (m) {
        const h = m[1] ? +m[1] : 0;
        const start = h * 3600 + (+m[2]) * 60 + (+m[3]);
        timed.push({ start, text: cleanText(m[4]) });
      }
    }
    if (timed.length) {
      return timed.map((t, i) => ({
        start: t.start,
        dur: i + 1 < timed.length ? Math.max(0.8, timed[i + 1].start - t.start) : 3,
        text: t.text,
      }));
    }
    // plain paragraphs → 4s each
    return text.split(/(?<=[.!?])\s+/).filter(Boolean).map((t, i) => ({
      start: i * 4,
      dur: 3.5,
      text: cleanText(t),
    }));
  }

  async function openVideo(input) {
    const id = extractVideoId(input);
    if (!id) { toast('URL o ID de YouTube no válido'); return; }
    stopSpeech();
    cancelAnimationFrame(state.raf);
    try { state.player?.destroy?.(); } catch { /* */ }
    state.player = null;
    state.videoId = id;
    state.title = id;
    state.segments = [];
    state.lastSpokenIdx = -1;
    state.currentIdx = -1;
    state.status = { kind: 'busy', msg: 'Preparando doblaje en español…' };
    state.view = 'player';
    render();

    try {
      const { segments, langUsed } = await fetchCaptions(id);
      state.segments = segments;
      // title from oembed (CORS ok)
      try {
        const oe = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`);
        if (oe.ok) {
          const meta = await oe.json();
          state.title = meta.title || id;
          document.querySelector('.player-top h2')?.replaceChildren(document.createTextNode(state.title));
        }
      } catch { /* */ }
      pushRecent(id, state.title);
      state.status = { kind: 'ok', msg: `Voz ES lista · ${segments.length} frases` };
      renderStatusOnly();
      updateCaptionBox(0);
      if (state.ytReady) mountPlayer();
    } catch (err) {
      console.error(err);
      state.status = { kind: 'err', msg: 'Sin transcripción — pégala para poder doblar' };
      renderStatusOnly();
      toast('No hay transcripción automática; pega una para doblar');
      openPasteSheet();
    }
  }

  // ---------- boot ----------
  function boot() {
    // warm voices
    if ('speechSynthesis' in window) {
      speechSynthesis.getVoices();
      speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
    }
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
    // demo mode for screenshots / tests
    const params = new URLSearchParams(location.search);
    if (params.get('demo') === '1') state.demoMode = true;
    // expose for headless tests / deep links
    window.__ytCast = {
      state,
      extractVideoId,
      fetchCaptions,
      openVideo,
      parseManualTranscript,
      speakSegment,
      mergeSegments,
    };
    render();
    if (params.get('v')) openVideo(params.get('v'));
  }

  boot();
})();
