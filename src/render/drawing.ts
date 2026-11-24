import Phaser from 'phaser';

export function drawDashedCircle(
  graphics: Phaser.GameObjects.Graphics,
  cx: number,
  cy: number,
  radius: number,
  color: number,
  alpha: number,
  lineWidth = 1,
  dashCount = 30,
): void {
  graphics.lineStyle(lineWidth, color, alpha);
  const step = (Math.PI * 2) / dashCount;
  for (let i = 0; i < dashCount; i += 1) {
    const a0 = i * step;
    const a1 = a0 + step * 0.48;
    graphics.beginPath();
    graphics.arc(cx, cy, radius, a0, a1, false);
    graphics.strokePath();
  }
}

export function drawDashedLine(
  graphics: Phaser.GameObjects.Graphics,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: number,
  alpha: number,
  dash = 6,
  gap = 5,
  lineWidth = 1,
): void {
  const length = Math.hypot(x2 - x1, y2 - y1);
  if (length < 0.01) return;
  const dx = (x2 - x1) / length;
  const dy = (y2 - y1) / length;
  graphics.lineStyle(lineWidth, color, alpha);
  let travelled = 0;
  while (travelled < length) {
    const end = Math.min(length, travelled + dash);
    graphics.beginPath();
    graphics.moveTo(x1 + dx * travelled, y1 + dy * travelled);
    graphics.lineTo(x1 + dx * end, y1 + dy * end);
    graphics.strokePath();
    travelled += dash + gap;
  }
}

export function drawArrowHead(
  graphics: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  angle: number,
  size: number,
  color: number,
  alpha: number,
): void {
  graphics.lineStyle(1, color, alpha);
  graphics.beginPath();
  graphics.moveTo(x, y);
  graphics.lineTo(x - Math.cos(angle - 0.45) * size, y - Math.sin(angle - 0.45) * size);
  graphics.moveTo(x, y);
  graphics.lineTo(x - Math.cos(angle + 0.45) * size, y - Math.sin(angle + 0.45) * size);
  graphics.strokePath();
}

export function drawCross(
  graphics: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  size: number,
  color: number,
  alpha: number,
): void {
  graphics.lineStyle(1, color, alpha);
  graphics.beginPath();
  graphics.moveTo(x - size, y);
  graphics.lineTo(x + size, y);
  graphics.moveTo(x, y - size);
  graphics.lineTo(x, y + size);
  graphics.strokePath();
}

/** Catmull-Rom smoothing for an open polyline (endpoints are preserved). */
export function smoothOpenPoints(
  points: Array<{ x: number; y: number }>,
  samplesPerSpan = 12,
): Array<{ x: number; y: number }> {
  if (points.length < 2) return points.map((point) => ({ ...point }));
  const output: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    for (let s = 0; s < samplesPerSpan; s += 1) {
      const t = s / samplesPerSpan;
      const t2 = t * t;
      const t3 = t2 * t;
      output.push({
        x:
          0.5 *
          (2 * p1.x +
            (-p0.x + p2.x) * t +
            (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
            (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y:
          0.5 *
          (2 * p1.y +
            (-p0.y + p2.y) * t +
            (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
            (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  output.push({ ...points[points.length - 1] });
  return output;
}

export function smoothClosedPoints(
  points: Array<{ x: number; y: number }>,
  samplesPerSpan = 8,
): Array<{ x: number; y: number }> {
  const output: Array<{ x: number; y: number }> = [];
  const n = points.length;
  for (let i = 0; i < n; i += 1) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    for (let s = 0; s < samplesPerSpan; s += 1) {
      const t = s / samplesPerSpan;
      const t2 = t * t;
      const t3 = t2 * t;
      output.push({
        x:
          0.5 *
          (2 * p1.x +
            (-p0.x + p2.x) * t +
            (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
            (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y:
          0.5 *
          (2 * p1.y +
            (-p0.y + p2.y) * t +
            (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
            (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  return output;
}

export function pathFromPoints(
  graphics: Phaser.GameObjects.Graphics,
  points: Array<{ x: number; y: number }>,
  close = true,
): void {
  if (points.length === 0) return;
  graphics.beginPath();
  graphics.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) {
    graphics.lineTo(points[i].x, points[i].y);
  }
  if (close) graphics.closePath();
}
