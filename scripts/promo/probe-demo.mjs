import { chromium } from 'playwright-core';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, locale: 'zh-CN' });
const page = await context.newPage();
await page.goto('http://127.0.0.1:4180/?level=19', { waitUntil: 'networkidle' });
await page.waitForTimeout(1600);
console.log('map rect', await page.evaluate(() => {
  const r = document.getElementById('map-frame').getBoundingClientRect();
  const c = document.querySelector('#weather-map canvas').getBoundingClientRect();
  return { frame: r.toJSON(), canvas: c.toJSON() };
}));
const box = await page.locator('.weather-card[data-type="H"] .strength-chip[data-strength="20"]').boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(300);
for (const [x, y] of [[412, 772], [412, 740], [412, 720], [412, 700]]) {
  const p = await page.evaluate(([wx, wy]) => window.__weatherController.scene.worldToClient(wx, wy), [x, y]);
  const at = await page.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px, py);
    return { x: px, y: py, tag: el?.tagName, cls: el?.className, id: el?.id };
  }, [p.x, p.y]);
  console.log('world', x, y, 'client', p, 'at', at);
}
// place at 720
const p = await page.evaluate(() => window.__weatherController.scene.worldToClient(412, 720));
await page.mouse.click(p.x, p.y);
await page.waitForTimeout(500);
console.log('entities after UI click', await page.evaluate(() => window.__weatherController.entities.map(e => ({ type: e.type, x: e.x, y: e.y }))));
await browser.close();
