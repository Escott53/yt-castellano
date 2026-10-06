const { chromium } = require('playwright-core');
const BASE = process.argv[2] || 'http://127.0.0.1:8765/';
function assert(c, m) { if (!c) throw new Error('ASSERT: ' + m); console.log('  ✔', m); }
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const mk = async () => {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36' });
    await ctx.addInitScript({ path: __dirname + '/fake-tts.js' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
    return page;
  };
  // 1) vídeo sin subtítulos → error claro y audio original sin silenciar
  {
    const page = await mk();
    await page.goto(BASE + '?v=C0DPdy98e4c', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ytCast?.state.load.phase === 'error', null, { timeout: 90000 });
    await page.waitForFunction(() => window.__ytCast.state.playerReady, null, { timeout: 60000 });
    const r = await page.evaluate(() => ({ pill: document.querySelector('#status-pill').textContent.trim(), muted: window.__ytCast.state.player.isMuted() }));
    console.log('no-captions:', r);
    assert(/no tiene subtítulos/.test(r.pill), 'clear Spanish error for no captions');
    assert(r.muted === false, 'original not muted when no captions');
  }
  // 2) deep link sin gesto + pista ES nativa (TED): voz bloqueada → mensaje → tocar botón → habla
  {
    const page = await mk();
    await page.goto(BASE + '?v=8jPQjjsBbIc', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ytCast?.state.load.phase === 'ready' && window.__ytCast.state.playerReady, null, { timeout: 90000 });
    const info = await page.evaluate(() => ({ src: window.__ytCast.state.sourceLang, n: window.__ytCast.state.segments.length, first: window.__ytCast.state.segments.slice(0, 2).map((s) => s.textEs) }));
    console.log('ted es:', info);
    assert(info.src === 'es' && info.n > 50, 'Spanish track used directly');
    // empezar sin gesto (como tocar dentro del iframe de YouTube)
    await page.evaluate(() => { window.__requireTap = true; window.__tapped = false; window.__ytCast.state.player.seekTo(12, true); window.__ytCast.state.player.playVideo(); });
    await page.waitForTimeout(9000);
    const blocked = await page.evaluate(() => ({ pill: document.querySelector('#status-pill').textContent.trim(), na: window.__tts.notAllowed, err: window.__ytCast.tts.lastError, muted: window.__ytCast.state.player.isMuted() }));
    console.log('blocked:', blocked);
    assert(blocked.na >= 1 && /toca/i.test(blocked.pill), 'not-allowed detected and user told to tap');
    assert(blocked.muted === false, 'original unmuted while voice is blocked');
    await page.tap('#status-pill'); // cualquier toque reactiva
    await page.waitForTimeout(8000);
    const after = await page.evaluate(() => ({ muted: window.__ytCast.state.player.isMuted(), err: window.__ytCast.tts.lastError, ok: window.__tts.speaks.filter((s) => !s.dropped && !s.na).map((s) => s.text.slice(0, 60)), t: window.__ytCast.state.player.getCurrentTime() }));
    console.log('after tap:', after);
    assert(!after.err && after.ok.length >= 2, 'voice recovered after a tap and speaks Spanish');
    assert(after.muted === true, 'original muted again once voice works');
    // seek atrás: reinicia puntero, sin tormenta de cancel+speak
    const before = await page.evaluate(() => window.__tts.speaks.length);
    await page.tap('#btn-seek-back');
    await page.waitForTimeout(6000);
    const sk = await page.evaluate(() => ({ dropped: window.__tts.dropped, n: window.__tts.speaks.length }));
    console.log('seek:', sk, 'before', before);
    assert(sk.dropped === 0, 'no speak() dropped after cancel (delay respected)');
    assert(sk.n - before < 8, 'no thrash after seek');
    // pausa → la voz se calla
    await page.tap('#btn-playpause');
    await page.waitForTimeout(1500);
    const pz = await page.evaluate(() => ({ ps: window.__ytCast.state.player.getPlayerState(), speaking: window.speechSynthesis.speaking }));
    console.log('pause:', pz);
    assert(pz.ps === 2 && !pz.speaking, 'pause stops speech');
    // Probar voz
    await page.tap('#btn-settings');
    await page.tap('#set-test-voice');
    await page.waitForTimeout(800);
    const tv = await page.evaluate(() => ({ res: document.querySelector('#voice-test-result').textContent, info: document.querySelector('#voice-info').textContent, last: window.__tts.speaks.slice(-1)[0].text }));
    console.log('test voice:', tv);
    assert(/Hola\. Esta es la voz en español/.test(tv.last) && /✅/.test(tv.res), 'Probar voz speaks Spanish test sentence');
  }
  console.log('E2E2_OK');
  await b.close();
})().catch((e) => { console.error('E2E2_FAIL', e.message); process.exit(1); });
