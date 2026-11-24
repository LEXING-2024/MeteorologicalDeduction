import { chromium } from 'playwright-core';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const page = await context.newPage();
await page.goto('http://127.0.0.1:4180/?level=25', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const candidates = [
  [[520, 322], [100, 322]],
  [[500, 322], [180, 322]],
  [[460, 322], [180, 322]],
  [[400, 322], [180, 322]],
  [[520, 500], [100, 150]],
  [[520, 180], [100, 500]],
  [[500, 500], [150, 150]],
  [[500, 150], [150, 500]],
  [[600, 322], [100, 322]],
  [[600, 450], [100, 200]],
  [[600, 200], [100, 450]],
  [[450, 450], [200, 200]],
  [[450, 200], [200, 450]],
  [[520, 322], [150, 322]],
  [[480, 322], [220, 322]],
  [[420, 322], [220, 322]],
];
for (const [h, l] of candidates) {
  const result = await page.evaluate(({ h, l }) => {
    const c = window.__weatherController;
    c.startLevel(24);
    c.chooseVariant('H', 'warmHigh');
    c.chooseStrength('H', 20);
    c.placeAt(h[0], h[1], 'H');
    c.chooseVariant('L', 'coldLow');
    c.chooseStrength('L', 20);
    c.placeAt(l[0], l[1], 'L');
    c.refreshField(true);
    const w = c.snapshot.cities.A.wind;
    return { from: w.fromLabel, toward: w.towardLabel, speed: Number(w.speed.toFixed(2)), deg: Number(w.fromDeg.toFixed(0)), raw: w };
  }, { h, l });
  console.log(JSON.stringify([h, l]), JSON.stringify(result));
}
await browser.close();
