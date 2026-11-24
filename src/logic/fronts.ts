import type { FrontType, WeatherEntity } from './types';
export interface CycloneCurvePoint {
  x: number;
  y: number;
  tangent: number;
}

export interface CycloneCurve {
  type: Extract<FrontType, 'cold' | 'warm'>;
  points: CycloneCurvePoint[];
  center: { x: number; y: number };
}

interface CachedCurves {
  key: string;
  curves: CycloneCurve[] | null;
}

let cache: CachedCurves | null = null;

function curveKey(entities: WeatherEntity[]): string {
  return entities
    .filter(
      (entity) =>
        entity.type === 'coldLow' ||
        entity.type === 'warmLow' ||
        entity.type === 'coldAir' ||
        entity.type === 'warmAir',
    )
    .map(
      (entity) =>
        `${entity.type}:${entity.x.toFixed(1)}:${entity.y.toFixed(1)}:${entity.strength}:${entity.radius.toFixed(1)}`,
    )
    .join('|');
}

function cubic(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

function makeCurve(
  type: CycloneCurve['type'],
  center: { x: number; y: number },
  end: { x: number; y: number },
  controlA: { x: number; y: number },
  controlB: { x: number; y: number },
): CycloneCurve {
  const points: CycloneCurvePoint[] = [];
  const samples = 40;
  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples;
    const point = cubic(center, controlA, controlB, end, t);
    points.push({ x: point.x, y: point.y, tangent: 0 });
  }
  for (let i = 0; i < points.length; i += 1) {
    const previous = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    points[i].tangent = Math.atan2(next.y - previous.y, next.x - previous.x);
  }
  return { type, center, points };
}

export function buildCycloneCurves(entities: WeatherEntity[]): CycloneCurve[] | null {
  const key = curveKey(entities);
  if (cache && cache.key === key) return cache.curves;

  const strongLow = entities
    .filter((entity) => (entity.type === 'coldLow' || entity.type === 'warmLow') && Math.abs(entity.strength) >= 20)
    .sort((a, b) => b.strength - a.strength)[0];
  if (!strongLow) {
    cache = { key, curves: null };
    return null;
  }

  const coldNW = entities.some(
    (entity) =>
      entity.type === 'coldAir' &&
      entity.x - strongLow.x < -8 &&
      entity.y - strongLow.y < -8,
  );
  const warmSE = entities.some(
    (entity) =>
      entity.type === 'warmAir' &&
      entity.x - strongLow.x > 8 &&
      entity.y - strongLow.y > 8,
  );
  if (!coldNW || !warmSE) {
    cache = { key, curves: null };
    return null;
  }

  const r = Math.max(135, strongLow.radius);
  const center = { x: strongLow.x, y: strongLow.y };
  const coldEnd = { x: center.x - r * 0.78, y: center.y + r * 0.82 };
  const warmEnd = { x: center.x + r * 0.86, y: center.y + r * 0.44 };
  const curves: CycloneCurve[] = [
    makeCurve(
      'cold',
      center,
      coldEnd,
      { x: center.x - r * 0.26, y: center.y + r * 0.24 },
      { x: center.x - r * 0.52, y: center.y + r * 0.54 },
    ),
    makeCurve(
      'warm',
      center,
      warmEnd,
      { x: center.x + r * 0.26, y: center.y + r * 0.12 },
      { x: center.x + r * 0.56, y: center.y + r * 0.28 },
    ),
  ];
  cache = { key, curves };
  return curves;
}

// ---------------------------------------------------------------------------
// Drawing only.  `frontAt` in field.ts is the sole front *diagnosis*; these
// curves place the cold/warm/occluded symbols on the map and never decide the
// weather at a point.
// ---------------------------------------------------------------------------
export function frontLabel(type: FrontType): string {
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
      return '无锋面';
  }
}

// ---------------------------------------------------------------------------
// Occluded-front symbol.  Whether a front IS occluded is decided by the
// cold-front catching process (`frontAge` → `frontAt`), not by this curve;
// the curve only draws the purple line once the diagnosis says so.
// ---------------------------------------------------------------------------
export interface OccludedCurve {
  center: { x: number; y: number };
  points: CycloneCurvePoint[];
}

let occludedCache: { key: string; curve: OccludedCurve | null } | null = null;

export function buildOccludedCurve(entities: WeatherEntity[]): OccludedCurve | null {
  const key = curveKey(entities);
  if (occludedCache && occludedCache.key === key) return occludedCache.curve;

  const lows = entities
    .filter((entity) => entity.type === 'coldLow' || entity.type === 'warmLow')
    .sort((a, b) => b.strength - a.strength);
  const colds = entities.filter((entity) => entity.type === 'coldAir');
  const warms = entities.filter((entity) => entity.type === 'warmAir');

  for (const low of lows) {
    if (low.strength < 5) continue;
    const reach = low.radius * 3.2;
    const westColds = colds.filter(
      (cold) => cold.x - low.x < -8 && Math.hypot(cold.x - low.x, cold.y - low.y) <= reach,
    );
    const north = westColds.some((cold) => cold.y - low.y < -8);
    const south = westColds.some((cold) => cold.y - low.y > 8);
    const warm = warms.find(
      (item) =>
        item.x - low.x > 8 &&
        item.y - low.y > 8 &&
        Math.hypot(item.x - low.x, item.y - low.y) <= reach,
    );
    if (!north || !south || !warm) continue;

    const radius = Math.max(120, low.radius);
    const length = radius * 0.62;
    const points: CycloneCurvePoint[] = [];
    const samples = 28;
    for (let i = 0; i <= samples; i += 1) {
      const t = i / samples;
      // Westward axis with a slight equatorward bow where the warm sector is
      // being lifted, so the occlusion reads as a curve, not a ruler line.
      const x = low.x - length * t;
      const y = low.y + Math.sin(t * Math.PI) * radius * 0.08;
      points.push({ x, y, tangent: 0 });
    }
    for (let i = 0; i < points.length; i += 1) {
      const previous = points[Math.max(0, i - 1)];
      const next = points[Math.min(points.length - 1, i + 1)];
      points[i].tangent = Math.atan2(next.y - previous.y, next.x - previous.x);
    }
    const curve: OccludedCurve = { center: { x: low.x, y: low.y }, points };
    occludedCache = { key, curve };
    return curve;
  }

  occludedCache = { key, curve: null };
  return null;
}
