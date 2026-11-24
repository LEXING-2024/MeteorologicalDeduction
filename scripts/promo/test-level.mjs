import { chromium } from 'playwright-core';
import path from 'node:path';

const out = path.resolve('capture');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error') console.log('PAGE ERROR', m.text()); });
page.on('pageerror', (e) => console.log('PAGE EXCEPTION', e.message));
await page.goto('http://127.0.0.1:5173/?level=4', { waitUntil: 'networkidle' });
await page.waitForTimeout(2200);
console.log('metrics', await page.evaluate(() => {
  const r = (s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect().toJSON() : null; };
  return { mapFrame: r('#map-frame'), canvas: r('#weather-map canvas'), deck: r('.deck-panel'), objective: r('.objective-card'), body: [innerWidth, innerHeight] };
}));
await page.screenshot({ path: path.join(out, 'test-level4-before.png') });
await page.evaluate(() => {
  const c = window.__weatherController;
  c.chooseVariant('H', 'warmHigh');
  c.chooseStrength('H', 20);
  c.placeAt(286, 322, 'H');
});
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(out, 'test-level4-placed.png') });
await page.click('#run-button');
await page.waitForTimeout(9000);
await page.screenshot({ path: path.join(out, 'test-level4-result.png') });
console.log('state', await page.evaluate(() => ({
  header: document.getElementById('header-name')?.textContent,
  result: document.getElementById('result-banner')?.hidden,
  resultTitle: document.getElementById('result-title')?.textContent,
  bannerRect: document.getElementById('result-banner')?.getBoundingClientRect().toJSON(),
})));
await browser.close();
