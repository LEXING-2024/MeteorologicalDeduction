/**
 * P3 sandbox UI: hourly timeline + seek + intervention on the prognostic state.
 * Dev page only (`/prognostic.html`), not part of the campaign.
 */

import { createEntity } from '../logic/entities';
import { PrognosticState } from '../logic/prognostic/state';
import { diagnoseStation, formatStationDiagnostics } from '../logic/prognostic/diagnostics';
import type { BaseConditions, WeatherEntity } from '../logic/types';
import type { FieldGrid } from '../../experiments/swe/physics/WeatherField';

const HOURS = 6;
const base: BaseConditions = { P: 1012, T: 23, Q: 7.4, latitude: 24, hemisphere: 'N' };
const points = {
  A: { x: 430, y: 400 },
  B: { x: 680, y: 330 },
  C: { x: 560, y: 650 },
};

const canvas = document.getElementById('map') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const scrub = document.getElementById('scrub') as HTMLInputElement;
const hourLabel = document.getElementById('hour')!;
const playButton = document.getElementById('play') as HTMLButtonElement;
const interveneButton = document.getElementById('intervene') as HTMLButtonElement;
const resetButton = document.getElementById('reset') as HTMLButtonElement;
const stationsBody = document.getElementById('stations')!;
const detail = document.getElementById('detail')!;
const status = document.getElementById('status')!;
const massLabel = document.getElementById('mass')!;

scrub.max = String(HOURS);

function board(): WeatherEntity[] {
  return [
    createEntity('coldLow', points.A.x, points.A.y, 15, { id: 'low', radius: 240 }),
    createEntity('wet', points.A.x - 56, points.A.y + 19, 40, { id: 'source', radius: 240 }),
    createEntity('coldAir', points.A.x - 80, points.A.y, 10, { id: 'cold', radius: 300 }),
    createEntity('warmAir', points.A.x + 90, points.A.y, 5, { id: 'warm', radius: 300 }),
  ];
}

let state: PrognosticState;
let grids: FieldGrid[] = [];
let hours: number[] = [];

function captureHour(): void {
  const hour = state.timeHours;
  grids[hour] = state.field.buildGrid(72, true);
  hours[hour] = hour;
}

function rebuild(): void {
  status.textContent = '积分中：96² 网格，每小时 360 步…';
  state = new PrognosticState(base, board(), { n: 96, domainKm: 1000 });
  grids = [];
  hours = [];
  captureHour();
  for (let h = 1; h <= HOURS; h += 1) {
    state.advance(1);
    captureHour();
  }
  scrub.value = '0';
  state.seek(0);
  render(0);
  status.textContent = '就绪：拖动时间轴回放，或在某一小时注入高压后重算。';
}

function pressureColor(pressure: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, (pressure - (base.P - 28)) / 56));
  if (t < 0.5) {
    const k = t / 0.5;
    return [42 + 21 * k, 76 + 67 * k, 160 - 20 * k];
  }
  const k = (t - 0.5) / 0.5;
  return [63 + 138 * k, 143 - 16 * k, 140 - 65 * k];
}

function drawGrid(grid: FieldGrid): void {
  const n = grid.n;
  const off = document.createElement('canvas');
  off.width = n;
  off.height = n;
  const octx = off.getContext('2d')!;
  const image = octx.createImageData(n, n);
  for (let i = 0; i < n * n; i += 1) {
    const [r, g, b] = pressureColor(grid.pressureHpa[i]);
    image.data[i * 4] = r;
    image.data[i * 4 + 1] = g;
    image.data[i * 4 + 2] = b;
    image.data[i * 4 + 3] = 255;
  }
  octx.putImageData(image, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, 0, canvas.width, canvas.height);

  // Cities.
  ctx.font = '12px "Noto Sans SC", sans-serif';
  for (const [id, point] of Object.entries(points)) {
    const x = (point.x / 1000) * canvas.width;
    const y = (point.y / 1000) * canvas.height;
    ctx.fillStyle = '#e9f4f8';
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(7, 12, 18, 0.75)';
    ctx.fillRect(x + 6, y - 9, 26, 16);
    ctx.fillStyle = '#cfe6ee';
    ctx.fillText(id, x + 10, y + 3);
  }
}

function render(hour: number): void {
  const grid = grids[hour];
  if (!grid) return;
  drawGrid(grid);
  hourLabel.textContent = `${hour} h`;
  massLabel.textContent = `质量漂移 ${(state.massDrift() * 100).toFixed(3)}%`;

  const rows: string[] = [];
  for (const [id, point] of Object.entries(points)) {
    const sample = diagnoseStation(state.sample(point.x, point.y));
    rows.push(
      `<tr><td>${id} 城</td><td class="mono">${sample.pressureHpa.toFixed(1)}</td>` +
        `<td class="mono">${sample.temperatureC.toFixed(1)}</td>` +
        `<td class="mono">${sample.moistureGm3.toFixed(1)}</td>` +
        `<td class="mono">${sample.wGame.toFixed(1)}</td>` +
        `<td>${frontLabel(sample.frontType)}</td><td class="mono">${sample.windSpeed.toFixed(1)}</td></tr>`,
    );
  }
  stationsBody.innerHTML = rows.join('');
  const a = diagnoseStation(state.sample(points.A.x, points.A.y));
  detail.textContent = `A 城：${formatStationDiagnostics(a)}`;
}

function frontLabel(type: string): string {
  switch (type) {
    case 'cold':
      return '冷锋';
    case 'warm':
      return '暖锋';
    case 'stationary':
      return '准静止锋';
    case 'occluded':
      return '锢囚锋';
    default:
      return '无';
  }
}

let timer = 0;
playButton.addEventListener('click', () => {
  if (timer) {
    window.clearInterval(timer);
    timer = 0;
    playButton.textContent = '播放';
    return;
  }
  playButton.textContent = '暂停';
  timer = window.setInterval(() => {
    const next = Math.min(HOURS, Number(scrub.value) + 1);
    scrub.value = String(next);
    state.seek(next);
    render(next);
    if (next >= HOURS) {
      window.clearInterval(timer);
      timer = 0;
      playButton.textContent = '播放';
    }
  }, 900);
});

scrub.addEventListener('input', () => {
  const hour = Number(scrub.value);
  state.seek(hour);
  render(hour);
});

interveneButton.addEventListener('click', () => {
  const hour = Number(scrub.value);
  if (hour >= HOURS) return;
  state.seek(hour);
  const high = createEntity('warmHigh', 560, 520, 10, { id: 'intervention-high', radius: 240 });
  state.intervene([high]);
  grids.length = hour + 1;
  captureHour();
  status.textContent = `已在第 ${hour} 小时注入 +10 hPa 高压，重算后续小时…`;
  for (let h = hour + 1; h <= HOURS; h += 1) {
    state.advance(1);
    captureHour();
  }
  state.seek(hour);
  render(hour);
  status.textContent = `第 ${hour} 小时干预完成，后续 ${HOURS - hour} 小时已重算。`;
});

resetButton.addEventListener('click', () => {
  if (timer) {
    window.clearInterval(timer);
    timer = 0;
    playButton.textContent = '播放';
  }
  rebuild();
});

// Let the status line paint before the synchronous 6 h integration.
window.setTimeout(rebuild, 30);
