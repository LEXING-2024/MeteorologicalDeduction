export interface IsobarSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface IsobarLine {
  level: number;
  segments: IsobarSegment[];
}

export interface ContourGrid {
  n: number;
  spacing: number;
}

type EdgePoint = { x: number; y: number };

function contourPoint(
  grid: ContourGrid,
  values: Float32Array,
  i: number,
  j: number,
  edge: number,
  level: number,
): EdgePoint {
  const n = grid.n;
  const x0 = i * grid.spacing;
  const y0 = j * grid.spacing;
  const p0 = values[j * n + i];
  const p1 = values[j * n + i + 1];
  const p2 = values[(j + 1) * n + i + 1];
  const p3 = values[(j + 1) * n + i];

  if (edge === 0) {
    return { x: x0 + grid.spacing * ((level - p0) / (p1 - p0 || 1)), y: y0 };
  }
  if (edge === 1) {
    return { x: x0 + grid.spacing, y: y0 + grid.spacing * ((level - p1) / (p2 - p1 || 1)) };
  }
  if (edge === 2) {
    return { x: x0 + grid.spacing * ((level - p3) / (p2 - p3 || 1)), y: y0 + grid.spacing };
  }
  return { x: x0, y: y0 + grid.spacing * ((level - p0) / (p3 - p0 || 1)) };
}

export function buildIsobars(
  grid: ContourGrid,
  values: Float32Array = new Float32Array(0),
  interval = 4,
  maxLevels = 24,
  minRange = 0,
): IsobarLine[] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 0.01) return [];

  const start = Math.ceil(min / interval) * interval;
  const end = Math.floor(max / interval) * interval;
  const levels: number[] = [];
  for (let level = start; level <= end && levels.length < maxLevels; level += interval) {
    levels.push(level);
  }

  return traceContours(grid, values, levels, minRange);
}

function bilinearSaddle(p0: number, p1: number, p2: number, p3: number): number {
  const denominator = p0 + p2 - p1 - p3;
  if (Math.abs(denominator) < 0.00001) return (p0 + p1 + p2 + p3) / 4;
  return (p0 * p2 - p1 * p3) / denominator;
}

/**
 * Marching squares for every requested level in ONE pass over the cells.
 *
 * The previous version scanned the whole grid once per level, so a 256²
 * analysis field with 13 isobar levels visited 850k cells just to emit a few
 * thousand segments.  A cell can only cross levels that lie inside its own
 * [min, max] range, so the level loop is entered only for those.
 */
export function traceContours(
  grid: ContourGrid,
  values: Float32Array,
  levels: number[],
  minRange = 0,
): IsobarLine[] {
  const n = grid.n;
  const lines: IsobarLine[] = levels.map((level) => ({ level, segments: [] }));
  const order = levels
    .map((level, index) => ({ level, index }))
    .sort((a, b) => a.level - b.level);

  for (let j = 0; j < n - 1; j += 1) {
    for (let i = 0; i < n - 1; i += 1) {
      const p0 = values[j * n + i];
      const p1 = values[j * n + i + 1];
      const p2 = values[(j + 1) * n + i + 1];
      const p3 = values[(j + 1) * n + i];
      const cellMin = Math.min(p0, p1, p2, p3);
      const cellMax = Math.max(p0, p1, p2, p3);
      // A cell that is essentially flat at the contour level produces a
      // staircase along the grid edge (the old "1012 hPa flat background"
      // artifact). Skip near-zero-range cells; the real crossing still has a
      // finite gradient.
      if (cellMax - cellMin < minRange) continue;

      for (let k = 0; k < order.length; k += 1) {
        const level = order[k].level;
        // Outside the cell range the original bit test can only produce
        // 0 (all below) or 15 (all above); both are skipped anyway.
        if (level <= cellMin || level > cellMax) continue;
        const segments = lines[order[k].index].segments;

        let code = 0;
        if (p0 >= level) code |= 1;
        if (p1 >= level) code |= 2;
        if (p2 >= level) code |= 4;
        if (p3 >= level) code |= 8;
        if (code === 0 || code === 15) continue;

        const point = (edge: number) => contourPoint(grid, values, i, j, edge, level);
        const push = (a: number, b: number) => {
          const pa = point(a);
          const pb = point(b);
          segments.push({ x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y });
        };

        if (code === 1) push(3, 0);
        else if (code === 2) push(0, 1);
        else if (code === 3) push(3, 1);
        else if (code === 4) push(1, 2);
        else if (code === 5) {
          const saddle = bilinearSaddle(p0, p1, p2, p3);
          if (saddle >= level) {
            push(0, 1);
            push(3, 2);
          } else {
            push(3, 0);
            push(1, 2);
          }
        } else if (code === 6) push(0, 2);
        else if (code === 7) push(3, 2);
        else if (code === 8) push(3, 2);
        else if (code === 9) push(0, 2);
        else if (code === 10) {
          const saddle = bilinearSaddle(p0, p1, p2, p3);
          if (saddle >= level) {
            push(3, 0);
            push(1, 2);
          } else {
            push(0, 1);
            push(3, 2);
          }
        } else if (code === 11) push(1, 2);
        else if (code === 12) push(3, 1);
        else if (code === 13) push(0, 1);
        else if (code === 14) push(3, 0);
      }
    }
  }

  return lines.filter((line) => line.segments.length > 0);
}
