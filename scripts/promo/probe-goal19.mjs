import { chromium } from 'playwright-core';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const page = await context.newPage();
await page.goto('http://127.0.0.1:4180/?level=19', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

async function trial(hy, ly) {
  const out = await page.evaluate(async ({ hy, ly }) => {
    const c = window.__weatherController;
    c.startLevel(18);
    c.scene.setAnimationSpeed(3);
    c.chooseVariant('H', 'warmHigh');
    c.chooseStrength('H', 20);
    c.placeAt(486, 428, 'H');
    c.placeAt(412, hy, 'H');
    c.chooseVariant('L', 'coldLow');
    c.chooseStrength('L', 20);
    c.placeAt(412, ly, 'L');
    c.chooseVariant('cold', 'coldAir'); c.chooseStrength('cold', 10); c.placeAt(286, 322, 'cold');
    c.chooseVariant('warm', 'warmAir'); c.chooseStrength('warm', 5); c.placeAt(286, 322, 'warm');
    c.chooseStrength('wet', 40); c.placeAt(286, 322, 'wet');
    c.clearPlacement();
    c.runRound();
    await new Promise(r => setTimeout(r, 100));
    c.scene.skipRun();
    await new Promise(r => setTimeout(r, 300));
    return {
      passed: c.result?.evaluation?.passed,
      actual: c.result?.evaluation?.actual,
      detail: c.result?.evaluation?.detail,
      cWind: c.snapshot?.cities?.C?.wind,
    };
  }, { hy, ly });
  console.log('H', hy, 'L', ly, JSON.stringify(out));
}

for (const hy of [650, 670, 680, 690, 700]) {
  await trial(hy, 492);
}
await browser.close();
