// E2E: node e2e.js <baseUrl> <videoId> [expectVersion]
const { chromium } = require('playwright-core');
const BASE = process.argv[2] || 'http://127.0.0.1:8765/';
const VID = process.argv[3] || 'ZXsQAXx_ao0';
const EXPECT_VERSION = process.argv[4] || '4';
const PLAY_SECONDS = Number(process.env.PLAY_SECONDS || 30);
function assert(c, m) { if (!c) throw new Error('ASSERT: ' + m); console.log('  ✔', m); }
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  });
  // Motor TTS simulado "tipo Android": exige gesto, descarta speak() justo tras cancel(), voces cargan tarde.
  // Motor TTS simulado "tipo Android" (exige gesto, descarta speak() justo tras cancel())
  await ctx.addInitScript({ path: __dirname + '/fake-tts.js' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/web-share|adapters|Unrecognized/.test(m.text())) console.log('CONSOLE', m.type(), m.text().slice(0, 160)); });

  await page.goto(BASE + '?nocache=' + Date.now(), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ytCast, null, { timeout: 30000 });
  const ver = await page.evaluate(() => window.__ytCast.version);
  console.log('version', ver);
  assert(ver === EXPECT_VERSION, `app version ${EXPECT_VERSION} served`);

  await page.fill('#url-input', `https://www.youtube.com/watch?v=${VID}`);
  await page.tap('#btn-load');
  // antes de tener frases, el original NO debe estar silenciado
  await page.waitForFunction(() => window.__ytCast.state.playerReady, null, { timeout: 60000 });
  const early = await page.evaluate(() => ({ segs: window.__ytCast.state.segments.filter((s) => s.textEs).length, muted: window.__ytCast.state.player.isMuted(), status: window.__ytCast.state.status.msg }));
  console.log('early', early);
  if (early.segs === 0) assert(early.muted === false, 'original audio NOT muted while no Spanish segments');

  await page.waitForFunction(() => window.__ytCast.state.load.phase === 'ready' || window.__ytCast.state.load.phase === 'error', null, { timeout: 120000 });
  const loaded = await page.evaluate(() => {
    const s = window.__ytCast.state;
    return { phase: s.load.phase, status: s.status.msg, src: s.sourceLang, n: s.segments.length, ready: s.segments.filter((x) => x.textEs).length,
      sample: s.segments.slice(0, 4).map((x) => ({ start: +x.start.toFixed(2), en: x.text.slice(0, 60), es: (x.textEs || '').slice(0, 70) })) };
  });
  console.log('loaded', JSON.stringify(loaded, null, 1));
  assert(loaded.phase === 'ready', 'transcript loaded');
  assert(loaded.ready >= 3, `Spanish segments ready (${loaded.ready}/${loaded.n})`);
  const pill = await page.textContent('#status-pill');
  console.log('status pill:', pill.trim());
  assert(/frases listas/.test(pill), 'status line shows "frases listas"');

  await page.tap('#btn-playpause');
  for (let i = 0; i < PLAY_SECONDS / 5; i++) {
    await page.waitForTimeout(5000);
    const snap = await page.evaluate(() => { const s = window.__ytCast.state; let t = 0, m = null; try { t = s.player.getCurrentTime(); m = s.player.isMuted(); } catch (e) {} return { t: +t.toFixed(1), muted: m, speaks: window.__tts.speaks.length, status: s.status.msg }; });
    console.log(' ', JSON.stringify(snap));
  }
  const res = await page.evaluate(() => {
    const s = window.__ytCast.state;
    return {
      t: s.player.getCurrentTime(), muted: s.player.isMuted(), tts: window.__tts, appSpeakCalls: window.__ytCast.tts.speakCalls,
      segs: s.segments.map((x) => ({ start: x.start, queued: x.queued || 0, spoken: x.spoken || 0, es: x.textEs })),
      unlocked: window.__ytCast.tts.unlocked, lastError: window.__ytCast.tts.lastError, broken: window.__ytCast.tts.broken,
    };
  });
  const spoken = res.tts.speaks.filter((x) => !x.dropped);
  console.log('speak() calls:', res.tts.speaks.length, 'dropped:', res.tts.dropped, 'notAllowed:', res.tts.notAllowed, 'cancels:', res.tts.cancels);
  spoken.slice(0, 8).forEach((x) => console.log('   speak:', x.lang, x.voice, (x.rate || 1).toFixed(2), JSON.stringify(x.text.slice(0, 90))));
  const passed = res.segs.filter((x) => x.start < res.t - 1);
  assert(res.t > PLAY_SECONDS * 0.5, `video played (t=${res.t.toFixed(1)}s)`);
  assert(res.unlocked && !res.broken, 'TTS unlocked and healthy');
  const esSpeaks = spoken.filter((x) => /^es/.test(x.lang) && res.segs.some((sg) => sg.es && x.text.includes(sg.es.slice(0, 20))));
  assert(esSpeaks.length >= 2, `speak() called with Spanish segment text (${esSpeaks.length} times)`);
  assert(esSpeaks.every((x) => !/^[\x00-\x7F]*$/.test(x.text) || /\b(el|la|de|que|tu|tus|los|las|y|no|es|lo|hazlo|sueños)\b/i.test(x.text)), 'spoken text looks Spanish');
  assert(passed.every((x) => x.queued === 1 || !x.es), `every passed segment queued exactly once (${passed.length} segs)`);
  assert(res.tts.speaks.length < passed.length * 3 + 5, 'no speak() thrashing');
  assert(res.muted === true, 'original muted while Spanish dub active');
  console.log('E2E_OK');
  await b.close();
})().catch((e) => { console.error('E2E_FAIL', e.message); process.exit(1); });
