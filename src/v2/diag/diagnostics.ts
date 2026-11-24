/**
 * V2 · 诊断层。
 * 设计锚点：docs/V2/01 §8、05 §2。
 * 只读取状态，输出特征对象；不参与积分。
 */

import { clamp, type Grid } from '../core/grid';
import type { Frame, PressureCenter } from '../core/types';

/** 气压中心（L/H）检测：局部极值 + 聚类 + 等效半径。 */
export function detectCenters(pressure: Float64Array, grid: Grid): PressureCenter[] {
  const n = grid.n;
  const candidates: Array<{ type: 'L' | 'H'; i: number; j: number; value: number }> = [];

  for (let j = 2; j < n - 2; j += 1) {
    for (let i = 2; i < n - 2; i += 1) {
      const k = grid.idx(i, j);
      const c = pressure[k];
      if (Math.abs(c) < 3) continue;
      let isExtremum = true;
      for (let dj = -2; dj <= 2 && isExtremum; dj += 1) {
        for (let di = -2; di <= 2; di += 1) {
          if (di === 0 && dj === 0) continue;
          const other = pressure[grid.idx(i + di, j + dj)];
          if (c < 0 ? other < c : other > c) {
            isExtremum = false;
            break;
          }
        }
      }
      if (isExtremum) {
        candidates.push({ type: c < 0 ? 'L' : 'H', i, j, value: c });
      }
    }
  }

  candidates.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const picked: Array<{ type: 'L' | 'H'; i: number; j: number; value: number }> = [];
  // 同一系统被急流/合并过程撕成两个极值点时，两中心往往只隔 1–2 个格点。
  // 文档 §8.2 要求先看闭合等压线与半径：小于一个系统半径（约 100 km）
  // 的同类型极值点不另算一个中心。
  const minSepKm = 100;
  for (const cand of candidates) {
    if (picked.some((p) => p.type === cand.type && distKm(grid, p.i, p.j, cand.i, cand.j) < minSepKm)) {
      continue;
    }
    picked.push(cand);
  }

  const centers: PressureCenter[] = [];
  for (const cand of picked) {
    const sign = cand.type === 'L' ? -1 : 1;
    let sumW = 0;
    let sx = 0;
    let sy = 0;
    let area = 0;
    const reach = 150;
    const i0 = Math.max(0, Math.floor(cand.i - reach / grid.dxKm));
    const i1 = Math.min(n - 1, Math.ceil(cand.i + reach / grid.dxKm));
    const j0 = Math.max(0, Math.floor(cand.j - reach / grid.dxKm));
    const j1 = Math.min(n - 1, Math.ceil(cand.j + reach / grid.dxKm));
    for (let j = j0; j <= j1; j += 1) {
      for (let i = i0; i <= i1; i += 1) {
        const v = pressure[grid.idx(i, j)] * sign;
        if (v <= 1.5) continue;
        const w = v - 1.5;
        sumW += w;
        sx += grid.xKm(i) * w;
        sy += grid.yKm(j) * w;
        area += 1;
      }
    }
    if (sumW <= 0) continue;
    const radiusKm = Math.sqrt(area / Math.PI) * grid.dxKm;
    centers.push({
      type: cand.type,
      xKm: sx / sumW,
      yKm: sy / sumW,
      value: cand.value,
      radiusKm,
      closedIsobars: Math.max(1, Math.floor((Math.abs(cand.value) - 1.5) / 2.5)),
    });
  }

  centers.sort((a, b) => (a.type === b.type ? Math.abs(b.value) - Math.abs(a.value) : a.type === 'L' ? -1 : 1));
  return centers;
}

function distKm(grid: Grid, i1: number, j1: number, i2: number, j2: number): number {
  return Math.hypot(grid.xKm(i1) - grid.xKm(i2), grid.yKm(j1) - grid.yKm(j2));
}

export interface RainArea {
  radiusKm: number;
  centroidXKm: number;
  centroidYKm: number;
  areaKm2: number;
}

/** 降水掩膜：率超过阈值的格子。 */
export function rainArea(
  precipRate: Float64Array,
  grid: Grid,
  threshold = 2.0,
): RainArea {
  const n = grid.n;
  let count = 0;
  let sx = 0;
  let sy = 0;
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const k = grid.idx(i, j);
      if (precipRate[k] >= threshold) {
        count += 1;
        sx += grid.xKm(i);
        sy += grid.yKm(j);
      }
    }
  }
  if (count === 0) {
    return { radiusKm: 0, centroidXKm: 0, centroidYKm: 0, areaKm2: 0 };
  }
  return {
    radiusKm: Math.sqrt(count / Math.PI) * grid.dxKm,
    centroidXKm: sx / count,
    centroidYKm: sy / count,
    areaKm2: count * grid.dxKm * grid.dxKm,
  };
}

/** 风与地转风的夹角（度）。用于摩擦角诊断。
 *  静风（或地转风接近 0）时没有“夹角”可言，返回 NaN：
 *  否则「偏角 < 15°」这类判据会在无风时白白成立。
 */
export function crossIsobarAngle(
  u: number,
  v: number,
  ug: number,
  vg: number,
): number {
  const speed = Math.hypot(u, v);
  const geo = Math.hypot(ug, vg);
  if (speed < 0.6 || geo < 0.6) return Number.NaN;
  const dot = u * ug + v * vg;
  const cos = clamp(dot / (speed * geo), -1, 1);
  return (Math.acos(cos) * 180) / Math.PI;
}

/** 两点距离（km）。 */
export function distanceKm(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x2 - x1, y2 - y1);
}

/** 低压周围的平均切向风：北半球逆时针为正。 */
export function circulationSign(
  center: PressureCenter,
  u: Float64Array | Float32Array,
  v: Float64Array | Float32Array,
  grid: Pick<Grid, 'n' | 'domainKm' | 'dxKm' | 'idx'>,
): number {
  const n = grid.n;
  const radiusKm = clamp(center.radiusKm * 1.2, 30, 110);
  const samples = 20;
  let sum = 0;
  let count = 0;
  for (let s = 0; s < samples; s += 1) {
    const a = (s / samples) * Math.PI * 2;
    const x = center.xKm + Math.cos(a) * radiusKm;
    const y = center.yKm + Math.sin(a) * radiusKm;
    if (x < 0 || y < 0 || x > grid.domainKm || y > grid.domainKm) continue;
    const i = clamp(Math.floor(x / grid.dxKm), 0, n - 1);
    const j = clamp(Math.floor(y / grid.dxKm), 0, n - 1);
    const k = grid.idx(i, j);
    // 逆时针切向单位向量 (-sin, cos)。
    const tx = -Math.sin(a);
    const ty = Math.cos(a);
    sum += u[k] * tx + v[k] * ty;
    count += 1;
  }
  if (count === 0) return 0;
  return sum / count;
}

/** 气压中心的等效移动距离（km）。 */
export function centerDisplacement(
  from: PressureCenter,
  to: PressureCenter,
): number {
  return Math.hypot(to.xKm - from.xKm, to.yKm - from.yKm);
}

/** 相邻两帧之间气压中心移动的最小间距。 */
export function minCenterSeparation(centers: PressureCenter[], type: 'L' | 'H'): number {
  const list = centers.filter((c) => c.type === type);
  if (list.length < 2) return Infinity;
  let min = Infinity;
  for (let a = 0; a < list.length; a += 1) {
    for (let b = a + 1; b < list.length; b += 1) {
      min = Math.min(min, centerDisplacement(list[a], list[b]));
    }
  }
  return min;
}

/** 从帧序列中挑选某类气压中心（优先最强）。 */
export function pickCenter(frames: readonly Frame[], type: 'L' | 'H'): PressureCenter | null {
  for (const frame of frames) {
    const found = frame.centers.find((c) => c.type === type);
    if (found) return found;
  }
  return null;
}

/**
 * 帧序列中某类系统的轨迹。
 *
 * 早期实现把同一帧里所有中心按强度加权平均；急流把低压拉成多个碎片后，
 * 质心会被西侧的残余中心拽住，轨迹看起来「没走」甚至「倒退」。
 * 这里改成连续性跟踪：优先挑离上一帧位置最近、且强度不弱太多的中心。
 */
export function centerTrack(frames: readonly Frame[], type: 'L' | 'H'): PressureCenter[] {
  const track: PressureCenter[] = [];
  let previous: PressureCenter | null = null;

  for (const frame of frames) {
    const list = frame.centers.filter((c) => c.type === type);
    if (list.length === 0) continue;

    let pick: PressureCenter;
    if (!previous) {
      pick = list.reduce((best, c) =>
        Math.abs(c.value) > Math.abs(best.value) ? c : best,
      );
    } else {
      const strongest = list.reduce((max, c) => Math.max(max, Math.abs(c.value)), 0);
      let bestScore = Infinity;
      pick = list[0];
      for (const candidate of list) {
        // 1 hPa 的强度差折算 2 km：宁可跟住强中心，也不为了几公里跳轨。
        const score =
          distanceKm(previous.xKm, previous.yKm, candidate.xKm, candidate.yKm) +
          (strongest - Math.abs(candidate.value)) * 2;
        if (score < bestScore) {
          bestScore = score;
          pick = candidate;
        }
      }
    }

    track.push({
      type: pick.type,
      xKm: pick.xKm,
      yKm: pick.yKm,
      value: pick.value,
      radiusKm: pick.radiusKm,
      closedIsobars: pick.closedIsobars,
    });
    previous = pick;
  }
  return track;
}

/** 降水掩膜在帧序列中的最大等效半径。 */
export function maxRainRadius(frames: readonly Frame[]): number {
  let max = 0;
  for (const frame of frames) max = Math.max(max, frame.stats.rainRadiusKm);
  return max;
}

/** 降水落区是否落在以 (x,y) 为圆心、radiusKm 为半径的圆内。 */
export function rainNear(
  frame: Frame,
  xKm: number,
  yKm: number,
  radiusKm: number,
): boolean {
  const d = Math.hypot(frame.stats.rainCentroidXKm - xKm, frame.stats.rainCentroidYKm - yKm);
  return frame.stats.rainRadiusKm > 0 && d <= radiusKm;
}
