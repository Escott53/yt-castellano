const { chromium } = require('playwright-core');
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await b.newPage({ viewport: { width: 390, height: 844 } });
  page.on('console', (m) => console.log('CONSOLE', m.type(), m.text()));
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  page.on('requestfailed', (r) => console.log('REQFAIL', r.url(), r.failure()?.errorText));

  await page.goto('http://127.0.0.1:8765/', { waitUntil: 'networkidle' });
  const has = await page.evaluate(() => !!window.__ytCast);
  console.log('has ytCast', has);

  // Direct fetch from page
  const fetchTest = await page.evaluate(async () => {
    try {
      const res = await fetch('https://youtubegpt.ai/api/transcript?v=iG9CE55wbtY&format=json&lang=es');
      const t = await res.text();
      return { status: res.status, len: t.length, start: t.slice(0, 120) };
    } catch (e) {
      return { err: String(e) };
    }
  });
  console.log('fetchTest', fetchTest);

  const r = await page.evaluate(async () => {
    try {
      return await window.__ytCast.fetchCaptions('iG9CE55wbtY');
    } catch (e) {
      return { error: String(e), stack: e.stack };
    }
  });
  console.log('fetchCaptions', JSON.stringify(r).slice(0, 500));

  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
