const { chromium } = require('playwright-core');
const fs = require('fs');
const out = '/workspace/app-doblaje/screenshots';
fs.mkdirSync(out, { recursive: true });

(async () => {
  const b = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await b.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'dark',
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();

  await page.goto('http://127.0.0.1:8765/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('ytcast-recent-v1', JSON.stringify([
      { id: 'iG9CE55wbtY', title: 'Do schools kill creativity? | Sir Ken Robinson | TED', at: Date.now() - 3600000 },
      { id: 'aircAruvnKk', title: 'But what is a neural network? | Deep learning', at: Date.now() - 86400000 },
    ]));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/home.png`, fullPage: false });
  console.log('home');

  await page.click('#btn-settings');
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${out}/settings.png`, fullPage: false });
  console.log('settings');
  await page.click('#set-close');

  await page.goto('http://127.0.0.1:8765/?v=iG9CE55wbtY', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ytCast?.state?.segments?.length > 10, null, { timeout: 120000 });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    // Product view: captions OFF, mute ON
    window.__ytCast.state.settings.showCaptions = false;
    window.__ytCast.state.settings.muteOriginal = true;
    const box = document.getElementById('caption-box');
    if (box) box.classList.add('hidden');
    document.querySelectorAll('.switch[data-key]').forEach((sw) => {
      const key = sw.getAttribute('data-key');
      const on = !!window.__ytCast.state.settings[key];
      sw.classList.toggle('on', on);
    });
    const pill = document.getElementById('status-pill');
    if (pill) {
      pill.className = 'status-pill ok';
      pill.innerHTML = '<i class="dot"></i><span>Voz española activa · 275 frases</span>';
    }
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/playing.png`, fullPage: false });
  console.log('playing');
  await b.close();
  console.log('SHOTS_OK');
})().catch((e) => { console.error(e); process.exit(1); });
