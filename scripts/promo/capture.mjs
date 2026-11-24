import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';

const BASE = 'http://127.0.0.1:5173/';
const OUT = path.resolve('capture', 'raw');
await fs.mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--force-color-profile=srgb', '--hide-scrollbars'],
});

async function makePage({ completed = [], url = BASE } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'dark',
  });
  await context.addInitScript((levels) => {
    localStorage.setItem('aerosphere.completed-levels.v2', JSON.stringify(levels));
    localStorage.setItem('aerosphere.settings.v1', JSON.stringify({ speed: 1 }));
  }, completed);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1800);
  return { page, context };
}

const shot = async (page, name) => {
  await page.screenshot({ path: path.join(OUT, name) });
  console.log('captured', name);
};

// ---------------------------------------------------------------- home
{
  const { page, context } = await makePage({ completed: Array.from({ length: 18 }, (_, i) => i + 1) });
  await shot(page, '01-home.png');

  // settings on top of the home screen
  await page.click('#home-settings');
  await page.waitForTimeout(450);
  await shot(page, '02-settings.png');
  await page.click('#settings-close');
  await page.waitForTimeout(350);

  // level overview at normal viewport
  await page.click('#home-start');
  await page.waitForTimeout(900);
  await shot(page, '03-campaign-overview.png');

  // scroll to stage 2
  await page.evaluate(() => {
    const stages = document.querySelector('.campaign-stages');
    if (stages) stages.scrollTop = 430;
  });
  await page.waitForTimeout(500);
  await shot(page, '04-campaign-stage2.png');

  // expand the overlay so all 72 levels are visible in one image
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.id = 'promo-campaign-expand';
    style.textContent = `
      html, body { height: auto !important; overflow: visible !important; background: #090e14 !important; }
      #campaign-overlay { position: absolute !important; inset: 0 0 auto 0 !important; height: auto !important; overflow: visible !important; padding: 42px 0 48px !important; align-items: flex-start !important; }
      #campaign-overlay .campaign-page { width: 1560px !important; max-height: none !important; height: auto !important; overflow: visible !important; }
      #campaign-overlay .campaign-stages { overflow: visible !important; max-height: none !important; }
      #campaign-overlay .campaign-scroll-hint { display: none !important; }
    `;
    document.head.appendChild(style);
    const pageEl = document.querySelector('.campaign-page');
    if (pageEl) pageEl.scrollTop = 0;
  });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, '05-campaign-all.png'), fullPage: true });
  console.log('captured 05-campaign-all.png');

  await context.close();
}

// ---------------------------------------------------------------- gameplay
const GAMEPLAY = [
  {
    index: 8,
    slug: '08-cold-front',
    placements: [
      { card: 'cold', variant: 'coldAir', strength: 10, points: [[286, 322]] },
      { card: 'warm', variant: 'warmAir', strength: 5, points: [[286, 322]] },
      { card: 'wet', strength: 40, points: [[286, 322]] },
    ],
    midDelay: 1500,
  },
  {
    index: 10,
    slug: '10-stationary-front',
    placements: [
      { card: 'cold', variant: 'coldAir', strength: 10, points: [[286, 322]] },
      { card: 'warm', variant: 'warmAir', strength: 10, points: [[286, 322]] },
      { card: 'wet', strength: 40, points: [[286, 322]] },
    ],
    midDelay: 1500,
  },
  {
    index: 19,
    slug: '19-three-cities',
    placements: [
      { card: 'cold', variant: 'coldAir', strength: 10, points: [[286, 322]] },
      { card: 'warm', variant: 'warmAir', strength: 5, points: [[286, 322]] },
      { card: 'wet', strength: 40, points: [[286, 322]] },
      { card: 'H', variant: 'warmHigh', strength: 20, points: [[486, 428]] },
      { card: 'H', variant: 'warmHigh', strength: 20, points: [[412, 772]] },
      { card: 'L', variant: 'coldLow', strength: 20, points: [[412, 492]] },
    ],
    midDelay: 1650,
  },
  {
    index: 24,
    slug: '24-sea-breeze',
    placements: [
      { card: 'H', variant: 'warmHigh', strength: 20, points: [[650, 428]] },
      { card: 'L', variant: 'coldLow', strength: 20, points: [[320, 428]] },
    ],
    midDelay: 1300,
  },
  {
    index: 25,
    slug: '25-valley-wind',
    placements: [
      { card: 'H', variant: 'warmHigh', strength: 20, points: [[520, 322]] },
      { card: 'L', variant: 'coldLow', strength: 20, points: [[100, 322]] },
      { card: 'wet', strength: 20, points: [[286, 322]] },
    ],
    midDelay: 1300,
  },
];

for (const scene of GAMEPLAY) {
  const { page, context } = await makePage({ completed: Array.from({ length: 18 }, (_, i) => i + 1), url: `${BASE}?level=${scene.index}` });
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
  await page.waitForTimeout(900);
  await shot(page, `${scene.slug}-before.png`);

  await page.evaluate(() => window.__weatherController.runRound());
  await page.waitForTimeout(scene.midDelay);
  await shot(page, `${scene.slug}-running.png`);

  await page.waitForTimeout(2600);
  await page.evaluate(() => {
    const c = window.__weatherController;
    c.hideTooltip();
    c.hideEntityPopover();
  });
  await page.waitForTimeout(300);
  await shot(page, `${scene.slug}-result.png`);

  await page.evaluate(() => window.__weatherController.hideResult());
  await page.waitForTimeout(500);
  await shot(page, `${scene.slug}-clean.png`);

  const state = await page.evaluate(() => {
    const c = window.__weatherController;
    return {
      level: c.level?.name,
      passed: c.result?.evaluation.passed,
      actual: c.result?.evaluation.actual,
      detail: c.result?.evaluation.detail,
      round: c.round,
    };
  });
  console.log('state', scene.slug, JSON.stringify(state));
  await context.close();
}

await browser.close();
console.log('DONE');
