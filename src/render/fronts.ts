import { FRONT_OCCLUSION_ROUNDS, FRONT_STRENGTH_GAP, MAP_SIZE } from '../config/constants';
import { buildCycloneCurves, buildOccludedCurve } from '../logic/fronts';
import type { FrontType, WeatherEntity } from '../logic/types';

/** Keep symbols off the chart frame. */
const EDGE = MAP_SIZE * 0.03;

export interface FrontPoint {
  x: number;
  y: number;
  tangent: number;
}

export interface FrontVisual {
  type: Exclude<FrontType, 'none'>;
  cyclone?: boolean;
  points: FrontPoint[];
  axisX: number;
  axisY: number;
  normalX: number;
  normalY: number;
}

function hash(value: string): number {
  let out = 0;
  for (let i = 0; i < value.length; i += 1) out = (out * 31 + value.charCodeAt(i)) | 0;
  return Math.abs(out) / 2147483647;
}

/**
 * Build the symbolic front graphics.
 *
 * `diagnose` is the physics diagnosis (`frontAt`) sampled at the front's own
 * midpoint.  The drawing must not invent a second classification: the chart is
 * the player's only evidence, so a front that renders as stationary but is
 * judged as cold (or the other way round) is a bug, not a style choice.  The
 * strength-difference rule survives only as a fallback for layouts the
 * diagnosis cannot resolve (e.g. a schematic cyclone whose air masses are too
 * far apart to form a θe front).
 */
export function buildFrontVisuals(
  entities: WeatherEntity[],
  diagnose?: (x: number, y: number) => Exclude<FrontType, 'none'> | null,
): FrontVisual[] {
  const cyclone = buildCycloneCurves(entities);
  // The purple occlusion line is drawn only after the cold front has actually
  // caught the warm front (frontAge), not as soon as the blobs are arranged.
  const matured = entities.some(
    (entity) =>
      (entity.type === 'coldLow' || entity.type === 'warmLow') &&
      (entity.frontAge ?? 0) >= FRONT_OCCLUSION_ROUNDS,
  );
  const occluded = matured ? buildOccludedCurve(entities) : null;
  const occludedVisual: FrontVisual[] = occluded
    ? [
        {
          type: 'occluded',
          points: occluded.points,
          axisX: 0,
          axisY: 1,
          normalX: 1,
          normalY: 0,
        },
      ]
    : [];
  if (cyclone) {
    return [
      ...occludedVisual,
      ...cyclone.map((curve) => {
        const mid = curve.points[Math.floor(curve.points.length / 2)];
        const symbolSide = curve.type === 'warm' ? -1 : 1;
        return {
          type: curve.type,
          cyclone: true,
          points: curve.points,
          axisX: symbolSide * Math.sin(mid.tangent),
          axisY: -symbolSide * Math.cos(mid.tangent),
          normalX: Math.cos(mid.tangent),
          normalY: Math.sin(mid.tangent),
        };
      }),
    ];
  }

  const colds = entities.filter((entity) => entity.type === 'coldAir');
  const warms = entities.filter((entity) => entity.type === 'warmAir');
  const fronts: FrontVisual[] = [];

  for (const cold of colds) {
    for (const warm of warms) {
      const dx = warm.x - cold.x;
      const dy = warm.y - cold.y;
      const distance = Math.hypot(dx, dy);
      const maxDistance = (cold.radius + warm.radius) * 1.12;
      if (distance > maxDistance) continue;

      const midX = (cold.x + warm.x) / 2;
      const midY = (cold.y + warm.y) / 2;
      const difference = cold.strength - warm.strength;
      const fallback: Exclude<FrontType, 'none'> =
        difference >= FRONT_STRENGTH_GAP
          ? 'cold'
          : difference <= -FRONT_STRENGTH_GAP
            ? 'warm'
            : 'stationary';
      const type: Exclude<FrontType, 'none'> = diagnose?.(midX, midY) ?? fallback;

      let axisX = 1;
      let axisY = 0;
      if (distance > 1) {
        axisX = dx / distance;
        axisY = dy / distance;
      } else {
        const angle = hash(`${cold.seed ?? cold.type}:${warm.seed ?? warm.type}`) * Math.PI * 2;
        axisX = Math.cos(angle);
        axisY = Math.sin(angle);
      }

      const normalX = -axisY;
      const normalY = axisX;
      // Must match frontalTroughAt() in pressure.ts: the front lies on the
      // pressure-trough axis, so no decorative bow/skew is applied here.
      const halfLength = Math.min(cold.radius, warm.radius) * 1.18;

      const points: FrontPoint[] = [];
      const samples = 64;
      for (let i = 0; i <= samples; i += 1) {
        const t = i / samples;
        const u = t * 2 - 1;
        const along = u * halfLength;
        points.push({
          x: Math.max(EDGE, Math.min(MAP_SIZE - EDGE, midX + normalX * along)),
          y: Math.max(EDGE, Math.min(MAP_SIZE - EDGE, midY + normalY * along)),
          tangent: 0,
        });
      }

      for (let i = 0; i < points.length; i += 1) {
        const previous = points[Math.max(0, i - 1)];
        const next = points[Math.min(points.length - 1, i + 1)];
        points[i].tangent = Math.atan2(next.y - previous.y, next.x - previous.x);
      }

      fronts.push({ type, points, axisX, axisY, normalX, normalY });
    }
  }

  return [...occludedVisual, ...fronts];
}
