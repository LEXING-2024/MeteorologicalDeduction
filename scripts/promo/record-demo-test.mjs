import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('capture', 'demo-test');
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
  const install = () => {
    if (document.getElementById('demo-cursor')) return;
    const style = document.createElement('style');
    style.textContent = `
      #demo-cursor, #demo-ripple { position: fixed; pointer-events: none; z-index: 2147483647; }
      #demo-cursor { width: 26px; height: 26px; margin: -13px 0 0 -13px; border: 1px solid rgba(139,212,223,.9); border-radius: 50%; background: rgba(4,10,14,.28); box-shadow: 0 0 0 1px rgba(0,0,0,.35), 0 0 18px rgba(139,212,223,.18); transition: width .08s, height .08s, margin .08s, background .08s; opacity: 0; }
      #demo-cursor::after { content: ''; position: absolute; left: 50%; top: 50%; width: 4px; height: 4px; margin: -2px 0 0 -2px; border-radius: 50%; background: #8bd4df; }
      #demo-cursor.down { width: 20px; height: 20px; margin: -10px 0 0 -10px; background: rgba(139,212,223,.22); }
      #demo-ripple { width: 18px; height: 18px; margin: -9px 0 0 -9px; border: 1px solid rgba(139,212,223,.8); border-radius: 50%; opacity: 0; }
      #demo-ripple.go { animation: demo-ripple .45s ease-out; }
      @keyframes demo-ripple { 0% { opacity: .75; transform: scale(.4); } 100% { opacity: 0; transform: scale(3.2); } }
      #demo-badge { position: fixed; right: 28px; top: 62px; z-index: 2147483646; display: flex; align-items: center; gap: 8px; padding: 7px 11px; border: 1px solid rgba(139,212,223,.26); border-radius: 2px; background: rgba(5,12,17,.7); color: #a7c4ce; font: 12px/1 "Microsoft YaHei", sans-serif; letter-spacing: .16em; pointer-events: none; }
      #demo-badge i { width: 6px; height: 6px; border-radius: 50%; background: #8ee0c4; box-shadow: 0 0 8px rgba(142,224,196,.8); }
    `;
    document.head.appendChild(style);
    const cursor = document.createElement('div');
    cursor.id = 'demo-cursor';
    const ripple = document.createElement('div');
    ripple.id = 'demo-ripple';
    const badge = document.createElement('div');
    badge.id = 'demo-badge';
    badge.innerHTML = '<i></i>实机演示';
    document.body.appendChild(cursor);
    document.body.appendChild(ripple);
    document.body.appendChild(badge);
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
await page.goto('http://127.0.0.1:4180/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const box = await page.locator('#home-start').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 24 });
await page.waitForTimeout(400);
await page.mouse.down();
await page.waitForTimeout(100);
await page.mouse.up();
await page.waitForTimeout(1800);
await page.mouse.move(960, 500, { steps: 30 });
await page.waitForTimeout(1200);
await page.close();
await context.close();
await browser.close();
console.log('done', await fs.readdir(OUT));
