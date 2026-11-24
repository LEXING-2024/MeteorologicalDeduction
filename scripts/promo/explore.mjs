import { chromium } from 'playwright-core';
import path from 'node:path';

const out = path.resolve('capture');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error') console.log('PAGE ERROR', m.text()); });
page.on('pageerror', (e) => console.log('PAGE EXCEPTION', e.message));
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
await page.screenshot({ path: path.join(out, 'explore-home.png') });
console.log('home', await page.evaluate(() => ({
  title: document.title,
  homeHidden: document.getElementById('home-screen')?.hidden,
  homeDisplay: getComputedStyle(document.getElementById('home-screen')).display,
  canvas: [...document.querySelectorAll('canvas')].map(c => [c.width, c.height]),
  body: [document.body.scrollWidth, document.body.scrollHeight],
})));

await page.click('#home-start');
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(out, 'explore-campaign.png') });
console.log('campaign', await page.evaluate(() => {
  const overlay = document.getElementById('campaign-overlay');
  const pageEl = overlay?.querySelector('.campaign-page');
  const levels = [...document.querySelectorAll('.campaign-level')];
  return {
    overlayHidden: overlay?.hidden,
    overlayRect: overlay?.getBoundingClientRect().toJSON(),
    pageRect: pageEl?.getBoundingClientRect().toJSON(),
    levels: levels.length,
    first: levels.slice(0, 3).map(n => ({ text: n.textContent.trim().slice(0, 60), cls: n.className, rect: n.getBoundingClientRect().toJSON() })),
    scrollHeight: pageEl?.scrollHeight,
    clientHeight: pageEl?.clientHeight,
    stages: [...document.querySelectorAll('.campaign-stage')].map(s => ({ head: s.querySelector('h3')?.textContent, count: s.querySelectorAll('.campaign-level').length })),
  };
}));

// Tall campaign screenshot with all 72 levels visible
await page.setViewportSize({ width: 1920, height: 2400 });
await page.waitForTimeout(800);
const overlay = await page.$('#campaign-overlay .campaign-page');
await overlay.screenshot({ path: path.join(out, 'explore-campaign-full.png') });
console.log('full campaign', await page.evaluate(() => {
  const p = document.querySelector('.campaign-page');
  const s = document.querySelector('.campaign-stages');
  return { page: p?.getBoundingClientRect().toJSON(), stages: s?.getBoundingClientRect().toJSON(), scrollH: s?.scrollHeight, clientH: s?.clientHeight };
}));

await browser.close();
