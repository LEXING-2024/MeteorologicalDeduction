import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('capture', 'demo');
await fs.mkdir(OUT, { recursive: true });
for (const f of await fs.readdir(OUT)) await fs.unlink(path.join(OUT, f));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } },
});

await context.addInitScript(() => {
  localStorage.setItem('aerosphere.completed-levels.v2', JSON.stringify(Array.from({ length: 18 }, (_, i) => i + 1)));
  localStorage.setItem('aerosphere.settings.v1', JSON.stringify({ speed: 1 }));

  const install = () => {
    if (document.getElementById('demo-cursor')) return;
    const style = document.createElement('style');
    style.textContent = `
      #demo-cursor, #demo-ripple { position: fixed; pointer-events: none; z-index: 2147483647; }
      #demo-cursor { width: 26px; height: 26px; margin: -13px 0 0 -13px; border: 1px solid rgba(139,212,223,.92); border-radius: 50%; background: rgba(4,10,14,.24); box-shadow: 0 0 0 1px rgba(0,0,0,.35), 0 0 18px rgba(139,212,223,.2); transition: width .08s, height .08s, margin .08s, background .08s; opacity: 0; }
      #demo-cursor::after { content: ''; position: absolute; left: 50%; top: 50%; width: 4px; height: 4px; margin: -2px 0 0 -2px; border-radius: 50%; background: #8bd4df; }
      #demo-cursor.down { width: 20px; height: 20px; margin: -10px 0 0 -10px; background: rgba(139,212,223,.2); }
      #demo-ripple { width: 18px; height: 18px; margin: -9px 0 0 -9px; border: 1px solid rgba(139,212,223,.8); border-radius: 50%; opacity: 0; }
      #demo-ripple.go { animation: demo-ripple .45s ease-out; }
      @keyframes demo-ripple { 0% { opacity: .75; transform: scale(.4); } 100% { opacity: 0; transform: scale(3.2); } }
    `;
    document.head.appendChild(style);
    const cursor = document.createElement('div');
    cursor.id = 'demo-cursor';
    const ripple = document.createElement('div');
    ripple.id = 'demo-ripple';
    document.body.appendChild(cursor);
    document.body.appendChild(ripple);
    window.addEventListener('pointermove', (e) => {
      cursor.style.opacity = '1';
      cursor.style.left = `${e.clientX}px`;
      cursor.style.top = `${e.clientY}px`;
    }, true);
    window.addEventListener('pointerdown', (e) => {
      cursor.classList.add('down');
      ripple.classList.remove('go');
      void ripple.offsetWidth;
      ripple.style.left = `${e.clientX}px`;
      ripple.style.top = `${e.clientY}px`;
      ripple.classList.add('go');
    }, true);
    window.addEventListener('pointerup', () => cursor.classList.remove('down'), true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
});

const page = await context.newPage();
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await page.goto('http://127.0.0.1:4180/', { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(1600);

const sleep = (ms) => page.waitForTimeout(ms);
async function move(x, y, steps = 24) {
  await page.mouse.move(x, y, { steps });
  await sleep(180);
}
async function clickHere() {
  await page.mouse.down();
  await sleep(90);
  await page.mouse.up();
  await sleep(260);
}
async function clickSelector(selector) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`No box for ${selector}`);
  await move(box.x + box.width / 2, box.y + box.height / 2, 26);
  await clickHere();
}
async function clickWorld(x, y) {
  const p = await page.evaluate(([wx, wy]) => window.__weatherController.scene.worldToClient(wx, wy), [x, y]);
  await move(p.x, p.y, 26);
  await clickHere();
}
async function place(card, strength, x, y) {
  await clickSelector(`.weather-card[data-type="${card}"] .strength-chip[data-strength="${strength}"]`);
  await sleep(260);
  await clickWorld(x, y);
  await sleep(480);
}

// 1. home -> level overview
await clickSelector('#home-start');
await sleep(900);

// 2. open level 19
await clickSelector('.campaign-level[data-level="19"]');
await sleep(1300);

// 3. place a cold-front / three-city solution with real UI clicks
await place('cold', 10, 286, 322);
await place('warm', 5, 286, 322);
await place('wet', 40, 286, 322);

await place('H', 20, 486, 428);
// place a second H at the south side of C by selecting the chip once more
await clickSelector('.weather-card[data-type="H"] .strength-chip[data-strength="20"]');
await sleep(200);
await clickWorld(412, 680);
await sleep(420);

await place('L', 20, 412, 492);

// clear placement and inspect A city data
await page.keyboard.press('Escape');
await sleep(300);
{
  const p = await page.evaluate(() => window.__weatherController.scene.worldToClient(286, 322));
  await move(p.x, p.y, 28);
  await sleep(1300);
}
await move(760, 780, 20);
await sleep(400);

// 4. run the three-phase simulation
await clickSelector('#run-button');
await sleep(4200);

// hold on the result banner
await sleep(1800);

// 5. open the level overview and switch to the sea-breeze level
await clickSelector('#campaign-button');
await sleep(900);
await clickSelector('.campaign-level[data-level="24"]');
await sleep(1400);

// 6. place H / L and run again
await place('H', 20, 650, 428);
await place('L', 20, 320, 428);
await page.keyboard.press('Escape');
await sleep(300);
{
  const p = await page.evaluate(() => window.__weatherController.scene.worldToClient(486, 428));
  await move(p.x, p.y, 26);
  await sleep(1100);
}
await move(760, 780, 20);
await sleep(300);
await clickSelector('#run-button');
await sleep(4200);

// final hold
await sleep(2200);

const state = await page.evaluate(() => {
  const c = window.__weatherController;
  return {
    level: c.level?.name,
    round: c.round,
    running: c.running,
    passed: c.result?.evaluation?.passed,
    actual: c.result?.evaluation?.actual,
    entities: c.entities?.length,
  };
});
console.log('FINAL STATE', JSON.stringify(state));
await page.close();
await context.close();
await browser.close();
console.log('DONE', await fs.readdir(OUT));
