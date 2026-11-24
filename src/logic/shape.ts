import type { WeatherEntity } from './types';

export interface ShapeMetrics {
  elongated: boolean;
  angle: number;
  majorRadius: number;
  minorRadius: number;
  ratio: number;
  isTrough: boolean;
  isRidge: boolean;
}

export function shapeMetrics(entity: WeatherEntity): ShapeMetrics | null {
  if (!entity.shape || entity.shape.length < 5) return null;
  const points = entity.shape;
  let cx = 0;
  let cy = 0;
  for (const point of points) {
    cx += point.x;
    cy += point.y;
  }
  cx /= points.length;
  cy /= points.length;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const point of points) {
    const dx = point.x - cx;
    const dy = point.y - cy;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  sxx /= points.length;
  syy /= points.length;
  sxy /= points.length;

  const trace = sxx + syy;
  const delta = Math.sqrt(Math.max(0, (sxx - syy) ** 2 + 4 * sxy * sxy));
  const majorVariance = Math.max(0.01, (trace + delta) / 2);
  const minorVariance = Math.max(0.01, (trace - delta) / 2);
  const ratio = Math.sqrt(majorVariance / minorVariance);
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const isLow = entity.type === 'coldLow' || entity.type === 'warmLow';
  const isHigh = entity.type === 'coldHigh' || entity.type === 'warmHigh';

  return {
    elongated: ratio >= 1.3,
    angle,
    majorRadius: Math.sqrt(majorVariance) * 1.9,
    minorRadius: Math.sqrt(minorVariance) * 1.9,
    ratio,
    isTrough: isLow && ratio >= 1.3,
    isRidge: isHigh && ratio >= 1.3,
  };
}
