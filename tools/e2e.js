const { chromium } = require('playwright-core');

(async () => {
  const b = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await b.newPage({ viewport: { width: 390, height: 844 } });

  await page.goto('http://127.0.0.1:8765/?v=iG9CE55wbtY', { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Wrap speak after page scripts load (headless often rejects native speak)
  await page.evaluate(() => {
    window.__speakLog = [];
    const proto = window.speechSynthesis;
    const nativeSpeak = proto.speak.bind(proto);
    proto.speak = function (u) {
      window.__speakLog.push(u && u.text);
      if (window.__ytCast) window.__ytCast.state._speakCalls += 1;
      try {
        nativeSpeak(u);
      } catch (_) {
        try { u.onstart && u.onstart(); } catch (_) {}
        setTimeout(() => { try { u.onend && u.onend(); } catch (_) {} }, 40);
      }
    };
  });

  await page.waitForFunction(() => window.__ytCast?.state?.segments?.length > 10, null, { timeout: 120000 });

  const info = await page.evaluate(() => {
    const s = window.__ytCast.state;
    return {
      videoId: s.videoId,
      segs: s.segments.length,
      sample: s.segments.slice(0, 4).map((x) => ({ start: x.start, textEs: (x.textEs || '').slice(0, 70) })),
      status: s.status,
    };
  });
  console.log('CAPTIONS', JSON.stringify(info, null, 2));

  await page.evaluate(() => {
    const s = window.__ytCast.state.segments[1];
    window.__ytCast.speakSegment(s, 1);
  });
  await page.waitForTimeout(300);
  const speakCount = await page.evaluate(() => ({
    log: window.__speakLog,
    calls: window.__ytCast.state._speakCalls,
  }));
  console.log('TTS', JSON.stringify(speakCount));

  if (info.segs < 10) throw new Error('too few segments');
  if (!speakCount.log.length) throw new Error('speechSynthesis.speak was not called');
  const hasEs = info.sample.some((x) => /[áéíóúñ¿¡]|Buenos|Ha sido|abrumado|increíble/i.test(x.textEs || ''));
  if (!hasEs) throw new Error('Spanish text not detected');
  console.log('hasSpanishLike', true);
  console.log('E2E_OK');
  await b.close();
})().catch((e) => { console.error('E2E_FAIL', e); process.exit(1); });
