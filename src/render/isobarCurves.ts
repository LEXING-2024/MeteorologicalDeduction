import { buildIsobars, type ContourGrid, type IsobarSegment } from './isobars';

export interface ContourCurve {
  level: number;
  points: Array<{ x: number; y: number }>;
}

interface EdgeRef {
  segment: number;
  side: 'a' | 'b';
}

function key(point: { x: number; y: number }): string {
  return `${Math.round(point.x * 2)}:${Math.round(point.y * 2)}`;
}

function pointOf(segment: IsobarSegment, side: 'a' | 'b'): { x: number; y: number } {
  return side === 'a' ? { x: segment.x1, y: segment.y1 } : { x: segment.x2, y: segment.y2 };
}

function dedupeConsecutive(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (const point of points) {
    const previous = out[out.length - 1];
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) > 0.05) {
      out.push(point);
    }
  }
  return out;
}

function chainSegments(segments: IsobarSegment[]): Array<Array<{ x: number; y: number }>> {
  const map = new Map<string, EdgeRef[]>();
  segments.forEach((segment, index) => {
    for (const side of ['a', 'b'] as const) {
      const k = key(pointOf(segment, side));
      const list = map.get(k) ?? [];
      list.push({ segment: index, side });
      map.set(k, list);
    }
  });

  const used = new Set<number>();
  const curves: Array<Array<{ x: number; y: number }>> = [];

  const extend = (path: Array<{ x: number; y: number }>, atStart: boolean) => {
    while (true) {
      const endpoint = atStart ? path[0] : path[path.length - 1];
      const neighbour = atStart ? path[1] : path[path.length - 2];
      const candidates = (map.get(key(endpoint)) ?? []).filter(
        (candidate) => !used.has(candidate.segment),
      );
      if (candidates.length === 0) break;
      let next = candidates[0];
      if (neighbour) {
        const inX = endpoint.x - neighbour.x;
        const inY = endpoint.y - neighbour.y;
        const inLength = Math.hypot(inX, inY) || 1;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (const candidate of candidates) {
          const other = pointOf(
            segments[candidate.segment],
            candidate.side === 'a' ? 'b' : 'a',
          );
          const outX = other.x - endpoint.x;
          const outY = other.y - endpoint.y;
          const outLength = Math.hypot(outX, outY) || 1;
          const score = (inX * outX + inY * outY) / (inLength * outLength);
          if (score > bestScore) {
            bestScore = score;
            next = candidate;
          }
        }
        if (bestScore < -0.15) break;
      }
      used.add(next.segment);
      const other = pointOf(segments[next.segment], next.side === 'a' ? 'b' : 'a');
      if (atStart) path.unshift(other);
      else path.push(other);
    }
  };

  segments.forEach((segment, index) => {
    if (used.has(index)) return;
    used.add(index);
    const path = [
      { x: segment.x1, y: segment.y1 },
      { x: segment.x2, y: segment.y2 },
    ];
    extend(path, false);
    extend(path, true);
    const cleaned = dedupeConsecutive(path);
    if (cleaned.length >= 3) curves.push(cleaned);
  });
  return curves;
}

function chaikin(points: Array<{ x: number; y: number }>, closed: boolean): Array<{ x: number; y: number }> {
  if (points.length < 3) return points;
  const out: Array<{ x: number; y: number }> = [];
  const n = points.length;
  if (!closed) out.push(points[0]);
  const segments = closed ? n : n - 1;
  for (let i = 0; i < segments; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % n];
    out.push(
      { x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 },
      { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 },
    );
  }
  if (!closed) out.push(points[n - 1]);
  return out;
}

/**
 * Corner-cutting for contour polylines. This is a rendering-only pass: it does
 * not move the source pressure field or the station values, but it removes the
 * pixel-scale corners that terrain perturbations would otherwise draw as
 * creases in an isobar.
 */
export function smoothContourPoints(
  points: Array<{ x: number; y: number }>,
  closed: boolean,
  iterations = 2,
): Array<{ x: number; y: number }> {
  let result = points;
  for (let i = 0; i < iterations; i += 1) result = chaikin(result, closed);
  return result;
}

export function buildContourCurves(
  grid: ContourGrid,
  values: Float32Array,
  interval = 4,
): ContourCurve[] {
  const lines = buildIsobars(grid, values, interval);
  const out: ContourCurve[] = [];
  for (const line of lines) {
    for (const points of chainSegments(line.segments)) {
      out.push({ level: line.level, points });
    }
  }
  return out;
}
