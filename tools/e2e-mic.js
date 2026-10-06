// E2E Modo micrófono: node tools/e2e-mic.js <baseUrl> [expectVersion]
// Chromium headless, tamaño móvil, UA Android, TTS simulado (fake-tts.js) y reconocimiento simulado (fake-sr.js).
const { chromium } = require('playwright-core');
const BASE = process.argv[2] || 'http://127.0.0.1:8765/';
const EXPECT = process.argv[3] || '5';
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
function assert(c, m) { if (!c) throw new Error('ASSERT: ' + m); console.log('  ✔', m); }
const ES = { 'Hello, how are you today?': 'Hola, ¿cómo estás hoy?', 'This is a great recipe for pasta.': 'Esta es una gran receta de pasta.', 'Thank you for watching.': 'Gracias por ver el vídeo.' };

(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const mk = async ({ fakeSR = true, routeTr = true } = {}) => {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, userAgent: UA, colorScheme: 'dark' });
    await ctx.addInitScript({ path: __dirname + '/fake-tts.js' });
    if (fakeSR) await ctx.addInitScript({ path: __dirname + '/fake-sr.js' });
    else await ctx.addInitScript(() => { window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined; });
    const page = await ctx.newPage();
    page.trRequests = [];
    if (routeTr) {
      await page.route(/clients5\.google\.com\/translate_a/, (route) => {
        const u = new URL(route.request().url());
        const qs = u.searchParams.getAll('q');
        page.trRequests.push(qs);
        if (page.failClients5) return route.fulfill({ status: 500, body: 'x' });
        route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(qs.map((q) => ES[q] || `ES(${q})`)) });
      });
      await page.route(/translate\.googleapis\.com/, (route) => {
        const q = new URL(route.request().url()).searchParams.get('q');
        page.trRequests.push(['gtx', q]);
        route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify([[[ES[q] || `GTX(${q})`, q]]]) });
      });
    }
    page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
    return page;
  };
  const speaks = (page) => page.evaluate(() => window.__tts.speaks.filter((s) => !s.dropped && !s.na));

  // 1) Inicio → tarjeta «Modo micrófono» → pantalla Micrófono
  const page = await mk();
  await page.goto(BASE + '?t=' + Date.now(), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ytCast);
  assert(await page.evaluate(() => window.__ytCast.version) === EXPECT, `app version ${EXPECT}`);
  assert(await page.isVisible('#btn-mic'), 'home shows «Modo micrófono» entry');
  await page.tap('#btn-mic');
  await page.waitForSelector('#mic-btn');
  const ui = await page.evaluate(() => ({
    btn: document.querySelector('#mic-btn').textContent.trim(), status: document.querySelector('#mic-status').textContent.trim(),
    help: document.querySelector('.help-card').textContent, live: document.querySelector('#mic-live').classList.contains('hidden'),
    langs: [...document.querySelectorAll('#mic-lang option')].map((o) => o.value), rate: !!document.querySelector('#rng-rate'),
  }));
  console.log('ui:', ui.btn, '|', ui.status);
  assert(/Empezar/.test(ui.btn) && /Pulsa «Empezar»/.test(ui.status), 'big Empezar button + Spanish idle status');
  assert(/Cómo usarlo/.test(ui.help) && /Pantalla dividida/.test(ui.help) && /3–5 s/.test(ui.help), 'help card «Cómo usarlo» with split-screen tip');
  assert(ui.live === true, 'live text OFF by default');
  assert(ui.langs.join() === 'en-US,en-GB,fr-FR,it-IT,pt-PT,de-DE' && ui.rate, 'language selector + rate slider present');
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/workspace/app-doblaje/screenshots/micro.png' });
  console.log('  screenshot saved');

  // 2) Empezar: desbloqueo de voz con el toque, reconocimiento arranca al callar la voz
  await page.evaluate(() => { window.__requireTap = true; window.__tapped = false; });
  await page.tap('#mic-btn');
  await page.waitForFunction(() => window.__sr.active, null, { timeout: 5000 });
  const st = await page.evaluate(() => { const r = window.__sr.instances[window.__sr.instances.length - 1]; return { lang: r.lang, cont: r.continuous, interim: r.interimResults, unlock: window.__tts.speaks[0], during: window.__sr.startedDuringTts || 0, status: document.querySelector('#mic-status b').textContent }; });
  console.log('start:', JSON.stringify(st));
  assert(st.unlock && st.unlock.text === 'Escuchando' && st.unlock.lang === 'es-ES' && !st.unlock.voice && !st.unlock.na, 'tap unlocked TTS (es-ES, no forced voice on Android)');
  assert(st.lang === 'en-US' && st.cont === true && st.interim === true, 'recognition en-US, continuous, interimResults');
  assert(st.during === 0, 'recognition not started while unlock phrase was speaking');
  assert(/Escuchando/.test(st.status), 'status «Escuchando…»');

  // 3) Resultado simulado → traducción → voz en español; micro parado mientras habla y reanudado después
  const s0 = await page.evaluate(() => ({ starts: window.__sr.starts, n: window.__tts.speaks.length }));
  await page.evaluate(() => window.__sr.say('Hello, how are you today?'));
  await page.waitForFunction((n) => window.__tts.speaks.length > n, s0.n, { timeout: 8000 });
  const sp = await page.evaluate(() => ({ last: window.__tts.speaks[window.__tts.speaks.length - 1], micOpen: !!window.__sr.active, status: document.querySelector('#mic-status b').textContent, btn: document.querySelector('#mic-btn').className }));
  console.log('speak:', JSON.stringify(sp), 'tr:', JSON.stringify(page.trRequests));
  assert(page.trRequests.some((q) => q[0] === 'Hello, how are you today?'), 'final result sent to translateBatch (clients5)');
  assert(sp.last.text === 'Hola, ¿cómo estás hoy?' && sp.last.lang === 'es-ES', 'speak() called with Spanish translation, lang es-ES');
  assert(!sp.micOpen, 'recognition stopped before/while TTS speaks');
  await page.waitForTimeout(250);
  assert(/Hablando en español/.test(await page.textContent('#mic-status b')), 'status «Hablando en español…» while speaking');
  await page.waitForFunction(() => window.__sr.active && !window.speechSynthesis.speaking, null, { timeout: 8000 });
  const s1 = await page.evaluate(() => ({ starts: window.__sr.starts, during: window.__sr.activeDuringTts, startedDuring: window.__sr.startedDuringTts || 0 }));
  console.log('after speak:', JSON.stringify(s1));
  assert(s1.starts > s0.starts, 'recognition restarted after TTS finished');
  assert(s1.during === 0 && s1.startedDuring === 0, 'mic never open while TTS speaking (no feedback loop)');

  // 4) Frase larga + duplicado tipo Android → una sola traducción
  page.trRequests.length = 0;
  await page.evaluate(() => window.__sr.say('This is a great recipe for pasta.', { dupFinal: true }));
  await page.waitForFunction(() => window.__tts.speaks.some((s) => s.text === 'Esta es una gran receta de pasta.'), null, { timeout: 8000 });
  await page.waitForTimeout(400);
  assert(page.trRequests.filter((q) => q[0] === 'This is a great recipe for pasta.').length === 1, 'duplicate final (Android bug) translated only once');
  await page.waitForFunction(() => window.__sr.active && !window.speechSynthesis.speaking, null, { timeout: 8000 });

  // 5) Silencio: Chrome corta (no-speech) → auto-reinicio con backoff (tope bajo)
  const a = await page.evaluate(() => window.__sr.starts);
  await page.waitForTimeout(7000);
  const auto = await page.evaluate(() => ({ starts: window.__sr.starts, times: window.__sr.startTimes.slice(-5), backoff: window.__ytCast.mic.backoff, active: window.__ytCast.mic.active, status: document.querySelector('#mic-status').textContent }));
  const gaps = auto.times.slice(1).map((t, i) => t - auto.times[i]);
  console.log('auto-restart:', auto.starts - a, 'restarts in 7s; gaps', gaps, 'backoff', auto.backoff, '|', auto.status.trim());
  assert(auto.starts - a >= 2 && auto.active, 'auto-restart on end while mode active');
  assert(auto.backoff <= 1500, 'no-speech backoff capped (≤1.5 s)');
  assert(/No se oye voz|Escuchando/.test(auto.status), 'Spanish no-speech hint');

  // 6) Texto en pantalla (opcional) + otro idioma
  await page.tap('.switch[data-key="micShowText"]');
  await page.waitForFunction(() => window.__sr.active, null, { timeout: 5000 });
  await page.evaluate(() => window.__sr.say('Thank you for watching.'));
  await page.waitForFunction(() => /Gracias por ver/.test(document.querySelector('#mic-live').textContent), null, { timeout: 8000 });
  const live = await page.evaluate(() => ({ hidden: document.querySelector('#mic-live').classList.contains('hidden'), txt: document.querySelector('#mic-live').innerText }));
  console.log('live text:', JSON.stringify(live.txt.slice(0, 160)));
  assert(!live.hidden && /Thank you for watching/.test(live.txt), 'live text shows English + Spanish when enabled');
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/workspace/app-doblaje/screenshots/micro-live.png' });
  await page.waitForFunction(() => window.__sr.active, null, { timeout: 8000 });
  await page.selectOption('#mic-lang', 'fr-FR');
  await page.waitForFunction(() => window.__sr.active && window.__sr.active.lang === 'fr-FR', null, { timeout: 5000 });
  assert(true, 'changing language restarts recognition with fr-FR');
  await page.selectOption('#mic-lang', 'en-US');

  // 7) Otra voz (Probar voz) con el micro abierto → micro se para y vuelve
  await page.waitForFunction(() => window.__sr.active, null, { timeout: 5000 });
  await page.tap('#btn-test-voice-inline');
  await page.waitForTimeout(600);
  const tv = await page.evaluate(() => ({ open: !!window.__sr.active, speaking: window.speechSynthesis.speaking }));
  assert(tv.speaking && !tv.open, 'any TTS (Probar voz) pauses recognition');
  await page.waitForFunction(() => window.__sr.active && !window.speechSynthesis.speaking, null, { timeout: 12000 });
  assert(true, 'recognition resumes after Probar voz');

  // 8) Parar
  await page.tap('#mic-btn');
  await page.waitForTimeout(300);
  const stp = await page.evaluate(() => ({ active: window.__ytCast.mic.active, open: !!window.__sr.active, btn: document.querySelector('#mic-btn').textContent.trim() }));
  assert(!stp.active && !stp.open && /Empezar/.test(stp.btn), 'Parar stops recognition and resets button');
  const s2 = await page.evaluate(() => window.__sr.starts);
  await page.waitForTimeout(2500);
  assert(await page.evaluate(() => window.__sr.starts) === s2, 'no restarts after Parar');

  // 9) Volver al inicio apaga el micro y el flujo de YouTube sigue ahí
  await page.tap('#mic-btn');
  await page.waitForFunction(() => window.__sr.active, null, { timeout: 5000 });
  await page.tap('#btn-back');
  await page.waitForTimeout(300);
  assert(await page.evaluate(() => !window.__ytCast.mic.active && !window.__sr.active && !!document.querySelector('#url-input')), 'back to home stops mic; YouTube input present');

  // 10) Errores
  {
    const p = await mk();
    await p.goto(BASE + '?micro=1', { waitUntil: 'domcontentloaded' });
    await p.evaluate(() => { window.__sr.deny = true; });
    await p.tap('#mic-btn');
    await p.waitForTimeout(1500);
    const r = await p.evaluate(() => ({ status: document.querySelector('#mic-status').textContent.trim(), active: window.__ytCast.mic.active }));
    console.log('not-allowed:', r.status);
    assert(/Permiso de micrófono denegado/.test(r.status) && !r.active, 'not-allowed → clear Spanish message, mode stopped');
  }
  {
    const p = await mk();
    await p.goto(BASE + '?micro=1', { waitUntil: 'domcontentloaded' });
    await p.evaluate(() => { window.__sr.networkFail = true; });
    await p.tap('#mic-btn');
    await p.waitForTimeout(9000);
    const r = await p.evaluate(() => ({ status: document.querySelector('#mic-status').textContent.trim(), times: window.__sr.startTimes, backoff: window.__ytCast.mic.backoff }));
    const gaps = r.times.slice(1).map((t, i) => t - r.times[i]);
    console.log('network:', r.status, '| gaps', gaps);
    assert(/necesita internet/.test(r.status), 'network → "necesita internet" message');
    assert(gaps.length >= 1 && gaps.length <= 3 && gaps.every((g, i) => i === 0 || g > gaps[i - 1]), 'network errors retried with growing backoff');
  }
  {
    const p = await mk({ fakeSR: false });
    await p.goto(BASE + '?micro=1', { waitUntil: 'domcontentloaded' });
    await p.tap('#mic-btn');
    await p.waitForTimeout(300);
    const r = await p.evaluate(() => document.querySelector('#mic-status').textContent.trim());
    console.log('unsupported:', r);
    assert(/no puede escuchar|Usa Google Chrome/.test(r), 'unsupported browser → clear Spanish message');
  }
  // 11) Ruta de traducción con reserva: clients5 falla → gtx
  {
    const p = await mk();
    p.failClients5 = true;
    await p.goto(BASE + '?micro=1', { waitUntil: 'domcontentloaded' });
    await p.tap('#mic-btn');
    await p.waitForFunction(() => window.__sr.active, null, { timeout: 5000 });
    await p.evaluate(() => window.__sr.say('Hello, how are you today?'));
    await p.waitForFunction(() => window.__tts.speaks.some((s) => s.text === 'Hola, ¿cómo estás hoy?'), null, { timeout: 15000 });
    assert(p.trRequests.some((q) => q[0] === 'gtx'), 'translation falls back to gtx when clients5 fails, still spoken');
  }
  // 12) Traducción real (red) sin simular
  {
    const p = await mk({ routeTr: false });
    await p.goto(BASE + '?micro=1', { waitUntil: 'domcontentloaded' });
    await p.tap('#mic-btn');
    await p.waitForFunction(() => window.__sr.active, null, { timeout: 5000 });
    await p.evaluate(() => window.__sr.say('Good morning everyone, today we are going to cook a delicious chicken.'));
    await p.waitForFunction(() => window.__tts.speaks.length >= 2, null, { timeout: 20000 });
    const last = await p.evaluate(() => window.__tts.speaks[window.__tts.speaks.length - 1]);
    console.log('real translation spoken:', JSON.stringify(last.text), last.lang);
    assert(/buen|hoy|pollo|cocinar/i.test(last.text) && last.lang === 'es-ES', 'real network translation spoken in Spanish');
  }
  console.log('E2E_MIC_OK');
  await b.close();
})().catch((e) => { console.error('E2E_MIC_FAIL', e.message); process.exit(1); });
