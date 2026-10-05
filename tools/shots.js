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

  // Seed recent + settings for prettier home
  await page.goto('http://127.0.0.1:8765/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.setItem('ytcast-recent-v1', JSON.stringify([
      { id: 'iG9CE55wbtY', title: 'Do schools kill creativity? | Sir Ken Robinson | TED', at: Date.now() - 3600000 },
      { id: 'aircAruvnKk', title: 'But what is a neural network? | Deep learning', at: Date.now() - 86400000 },
    ]));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/home.png`, fullPage: false });
  console.log('home.png');

  // Settings sheet on home
  await page.click('#btn-settings');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/settings.png`, fullPage: false });
  console.log('settings.png');
  await page.click('#set-close');

  // Playing view with captions
  await page.goto('http://127.0.0.1:8765/?v=iG9CE55wbtY', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ytCast?.state?.segments?.length > 10, null, { timeout: 120000 });
  await page.waitForTimeout(1500);
  // Force caption box content
  await page.evaluate(() => {
    window.__ytCast.state.currentIdx = 1;
    window.__ytCast.state.settings.showCaptions = true;
    const s = window.__ytCast.state.segments[1];
    const el = document.getElementById('caption-box');
    if (el) el.textContent = s.textEs;
    const pill = document.getElementById('status-pill');
    if (pill) {
      pill.className = 'status-pill ok';
      pill.innerHTML = '<i class="dot"></i><span>275 frases · origen es</span>';
    }
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/playing.png`, fullPage: false });
  console.log('playing.png');

  await b.close();
  console.log('SHOTS_OK');
})().catch((e) => { console.error(e); process.exit(1); });
