/**
 * V2 · 半拉格朗日平流。
 * 设计锚点：docs/V2/01 §5.5。
 * 双线性插值 + 边缘夹取；写入调用方提供的 out，避免每步分配。
 */

import type { Grid } from '../core/grid';

export function advect(
  field: Float64Array,
  u: Float64Array,
  v: Float64Array,
  dtSeconds: number,
  grid: Grid,
  out: Float64Array,
): Float64Array {
  const n = grid.n;
  const dx = grid.dxM;

  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const k = grid.idx(i, j);
      const xBack = i - (u[k] * dtSeconds) / dx;
      const yBack = j - (v[k] * dtSeconds) / dx;
      out[k] = sampleCell(field, grid, xBack, yBack);
    }
  }
  return out;
}

export function sampleCell(
  field: Float64Array,
  grid: Grid,
  x: number,
  y: number,
): number {
  const n = grid.n;
  const cx = x < 0 ? 0 : x > n - 1 ? n - 1 : x;
  const cy = y < 0 ? 0 : y > n - 1 ? n - 1 : y;
  const i0 = Math.floor(cx);
  const j0 = Math.floor(cy);
  const i1 = Math.min(i0 + 1, n - 1);
  const j1 = Math.min(j0 + 1, n - 1);
  const tx = cx - i0;
  const ty = cy - j0;
  const a = field[grid.idx(i0, j0)];
  const b = field[grid.idx(i1, j0)];
  const c = field[grid.idx(i0, j1)];
  const d = field[grid.idx(i1, j1)];
  return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
}

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t)
  );
}

/** 双三次（Catmull–Rom）采样：比双线性更保形，用于位涡平流。 */
export function sampleCellCubic(
  field: Float64Array,
  grid: Grid,
  x: number,
  y: number,
): number {
  const n = grid.n;
  const cx = x < 0 ? 0 : x > n - 1 ? n - 1 : x;
  const cy = y < 0 ? 0 : y > n - 1 ? n - 1 : y;
  const i1 = Math.floor(cx);
  const j1 = Math.floor(cy);
  const tx = cx - i1;
  const ty = cy - j1;
  const im = Math.max(0, i1 - 1);
  const ip = Math.min(n - 1, i1 + 1);
  const ipp = Math.min(n - 1, i1 + 2);
  const jm = Math.max(0, j1 - 1);
  const jp = Math.min(n - 1, j1 + 1);
  const jpp = Math.min(n - 1, j1 + 2);
  const row0 = catmull(
    field[grid.idx(im, jm)],
    field[grid.idx(i1, jm)],
    field[grid.idx(ip, jm)],
    field[grid.idx(ipp, jm)],
    tx,
  );
  const row1 = catmull(
    field[grid.idx(im, j1)],
    field[grid.idx(i1, j1)],
    field[grid.idx(ip, j1)],
    field[grid.idx(ipp, j1)],
    tx,
  );
  const row2 = catmull(
    field[grid.idx(im, jp)],
    field[grid.idx(i1, jp)],
    field[grid.idx(ip, jp)],
    field[grid.idx(ipp, jp)],
    tx,
  );
  const row3 = catmull(
    field[grid.idx(im, jpp)],
    field[grid.idx(i1, jpp)],
    field[grid.idx(ip, jpp)],
    field[grid.idx(ipp, jpp)],
    tx,
  );
  return catmull(row0, row1, row2, row3, ty);
}

/** 高阶半拉格朗日平流（双三次），用于位涡/流函数。 */
export function advectCubic(
  field: Float64Array,
  u: Float64Array,
  v: Float64Array,
  dtSeconds: number,
  grid: Grid,
  out: Float64Array,
): Float64Array {
  const n = grid.n;
  const dx = grid.dxM;
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const k = grid.idx(i, j);
      const xBack = i - (u[k] * dtSeconds) / dx;
      const yBack = j - (v[k] * dtSeconds) / dx;
      out[k] = sampleCellCubic(field, grid, xBack, yBack);
    }
  }
  return out;
}
