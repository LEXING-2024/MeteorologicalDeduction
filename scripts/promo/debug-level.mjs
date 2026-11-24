import { chromium } from 'playwright-core';
import path from 'node:path';

const out = path.resolve('capture');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1 });
page.on('console', (m) => console.log('PAGE', m.type(), m.text()));
page.on('pageerror', (e) => console.log('PAGE EXCEPTION', e.message));
await page.goto('http://127.0.0.1:5173/?level=4', { waitUntil: 'networkidle' });
await page.waitForTimeout(1800);
await page.evaluate(() => {
  const c = window.__weatherController;
  c.chooseVariant('H', 'warmHigh');
  c.chooseStrength('H', 20);
  c.placeAt(286, 322, 'H');
});
await page.waitForTimeout(800);
const dump = () => page.evaluate(() => {
  const c = window.__weatherController;
  return {
    running: c.running,
    round: c.round,
    entities: c.entities.map(e => ({ type: e.type, x: e.x, y: e.y, strength: e.strength })),
    result: c.result ? { passed: c.result.evaluation.passed, actual: c.result.evaluation.actual, detail: c.result.evaluation.detail } : null,
    bannerHidden: document.getElementById('result-banner')?.hidden,
    bannerDisplay: getComputedStyle(document.getElementById('result-banner')).display,
    goalState: document.getElementById('goal-state')?.textContent,
    goalActual: document.getElementById('goal-actual')?.textContent,
    stationRain: document.getElementById('metric-rain')?.textContent,
    runLabel: document.getElementById('run-label')?.textContent,
    toast: document.getElementById('toast')?.textContent,
  };
});
console.log('placed', await dump());
await page.evaluate(() => window.__weatherController.runRound());
await page.waitForTimeout(1000);
console.log('1s', await dump());
await page.waitForTimeout(2500);
console.log('3.5s', await dump());
await page.screenshot({ path: path.join(out, 'debug-result.png') });
await browser.close();
