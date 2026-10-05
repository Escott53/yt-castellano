const { chromium } = require('playwright-core');
const fs = require('fs');
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const svg = fs.readFileSync('/workspace/app-doblaje/icons/icon.svg', 'utf8');
  const out = '/workspace/app-doblaje/icons/';
  const jobs = [['icon-192.png', 192, 0.22, 1], ['icon-512.png', 512, 0.22, 1], ['apple-touch-icon.png', 180, 0, 1], ['icon-maskable-512.png', 512, 0, 0.8]];
  for (const [name, size, radius, scale] of jobs) {
    const p = await b.newPage({ viewport: { width: size, height: size } });
    const inner = scale < 1
      ? `<div style="width:${size}px;height:${size}px;background:linear-gradient(135deg,#7c3aed,#db2777);display:grid;place-items:center"><div style="width:${size*scale}px;height:${size*scale}px">${svg.replace(/<rect width="512" height="512"[^/]*\/>/, '')}</div></div>`
      : `<div style="width:${size}px;height:${size}px;border-radius:${size*radius}px;overflow:hidden">${svg}</div>`;
    await p.setContent(`<html><body style="margin:0;background:transparent">${inner}<style>svg{width:100%;height:100%;display:block}</style></body></html>`);
    await p.screenshot({ path: out + name, omitBackground: true });
    await p.close();
  }
  await b.close();
  console.log('icons ok');
})();
