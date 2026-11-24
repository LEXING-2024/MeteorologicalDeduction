import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';

const BASE = 'http://127.0.0.1:4180/';
const OUT = path.resolve('capture', 'raw');
await fs.mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--force-color-profile=srgb', '--hide-scrollbars'] });

const scenes = [
  {
    index: 8,
    slug: '08-cold-front',
    placements: [
      { card: 'cold', variant: 'coldAir', strength: 10, points: [[286, 322]] },
      { card: 'warm', variant: 'warmAir', strength: 5, points: [[286, 322]] },
      { card: 'wet', strength: 40, points: [[286, 322]] },
    ],
  },
  {
    index: 24,
    slug: '24-sea-breeze',
    placements: [
      { card: 'H', variant: 'warmHigh', strength: 20, points: [[650, 428]] },
      { card: 'L', variant: 'coldLow', strength: 20, points: [[320, 428]] },
    ],
  },
  {
    index: 25,
    slug: '25-valley-wind',
    placements: [
      { card: 'H', variant: 'warmHigh', strength: 20, points: [[520, 322]] },
      { card: 'L', variant: 'coldLow', strength: 20, points: [[100, 322]] },
      { card: 'wet', strength: 20, points: [[286, 322]] },
    ],
  },
];

for (const scene of scenes) {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'dark',
  });
  await context.addInitScript(() => {
    localStorage.setItem('aerosphere.completed-levels.v2', JSON.stringify(Array.from({ length: 18 }, (_, i) => i + 1)));
    localStorage.setItem('aerosphere.settings.v1', JSON.stringify({ speed: 1 }));
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto(`${BASE}?level=${scene.index}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1800);

  await page.evaluate((placements) => {
    const c = window.__weatherController;
    c.scene.setAnimationSpeed(1);
    for (const p of placements) {
      if (p.variant) c.chooseVariant(p.card, p.variant);
      c.chooseStrength(p.card, p.strength);
      for (const [x, y] of p.points) c.placeAt(x, y, p.card);
    }
    c.clearPlacement();
    c.hideTooltip();
  }, scene.placements);
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, `${scene.slug}-before.png`) });

  const before = await page.evaluate(() => {
    const c = window.__weatherController;
    return { entities: c.entities.length, active: c.activeCard, running: c.running };
  });
  console.log(scene.slug, 'before', before);

  await page.evaluate(() => window.__weatherController.runRound());
  await page.waitForTimeout(1550);
  await page.screenshot({ path: path.join(OUT, `${scene.slug}-running.png`) });

  await page.waitForTimeout(2300);
  await page.evaluate(() => { window.__weatherController.hideTooltip(); window.__weatherController.hideEntityPopover(); });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, `${scene.slug}-result.png`) });
  const state = await page.evaluate(() => {
    const c = window.__weatherController;
    return {
      level: c.level?.name,
      round: c.round,
      running: c.running,
      passed: c.result?.evaluation?.passed,
      actual: c.result?.evaluation?.actual,
      detail: c.result?.evaluation?.detail,
      bannerHidden: document.getElementById('result-banner')?.hidden,
    };
  });
  console.log(scene.slug, 'state', JSON.stringify(state));

  await page.evaluate(() => window.__weatherController.hideResult());
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(OUT, `${scene.slug}-clean.png`) });
  await context.close();
}

await browser.close();
console.log('DONE');
