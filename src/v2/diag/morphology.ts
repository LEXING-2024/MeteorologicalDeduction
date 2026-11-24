/**
 * M3 · 空间形态诊断。
 *
 * 这里只做“可解释的几何量”：雨带的覆盖率、长宽比、轴向，
 * 以及锋区、温度平流、辐合、风向切变。配方识别读取这些量，
 * 地图/侧栏也可以直接展示。所有计算都是 O(N²)，单帧 128²
 * 约 1.6 万格，几十次基本运算，不影响逐小时演化。
 */
import { clamp, Grid } from '../core/grid';
import type { Frame, FrameMorphology } from '../core/types';
import type { SceneDef } from '../core/types';
import type { SceneFields } from '../scene/scene';
import { relativeHumidity } from '../physics/thermo';

const RAIN_THRESHOLD = 0.15; // mm/h，与地图雨层一致

export function analyzeMorphology(
  scene: SceneDef,
  frame: Frame,
  fields: SceneFields,
): FrameMorphology {
  const grid = new Grid(scene.domainKm, scene.n);
  const n = grid.n;
  const total = n * n;
  const dxKm = grid.dxKm;

  // ── 雨带几何：以雨强为权重的二阶矩 ───────────────────────────────
  let mass = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let wetCells = 0;
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const k = grid.idx(i, j);
      const rate = frame.precipRate[k];
      if (!(rate >= RAIN_THRESHOLD)) continue;
      const x = grid.xKm(i);
      const y = grid.yKm(j);
      const w = rate;
      mass += w;
      sx += w * x;
      sy += w * y;
      sxx += w * x * x;
      syy += w * y * y;
      sxy += w * x * y;
      wetCells += 1;
    }
  }

  let rainElongation = 0;
  let rainAxisDeg = 0;
  let rainLengthKm = 0;
  let rainWidthKm = 0;
  if (mass > 0) {
    const cx = sx / mass;
    const cy = sy / mass;
    const cxx = Math.max(0, sxx / mass - cx * cx);
    const cyy = Math.max(0, syy / mass - cy * cy);
    const cxy = sxy / mass - cx * cy;
    // 2×2 协方差矩阵的特征值；λ1 为长轴，λ2 为短轴。
    const tr = cxx + cyy;
    const det = cxx * cyy - cxy * cxy;
    const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const l1 = Math.max(0, tr / 2 + disc);
    const l2 = Math.max(1e-6, tr / 2 - disc);
    rainElongation = Math.sqrt(l1 / l2);
    // 4σ 作为雨带长度/宽度，避免把单个格点放大成一条长带。
    rainLengthKm = 4 * Math.sqrt(l1);
    rainWidthKm = 4 * Math.sqrt(l2);
    // 长轴方向（正东为 0，逆时针为正；和地图风向约定一致）。
    const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    rainAxisDeg = ((angle * 180) / Math.PI + 360) % 360;
    if (rainAxisDeg > 180) rainAxisDeg -= 180;
  }

  // ── 场量极值 / 梯度 ─────────────────────────────────────────────
  let minW = Infinity;
  let maxW = -Infinity;
  let minWind = Infinity;
  let maxWind = -Infinity;
  let maxRh = 0;
  let minRh = 100;
  let frontStrength = 0;
  let maxWarmAdvection = 0;
  let maxColdAdvection = 0;
  let maxConvergence = 0;
  let maxWindDirShiftDeg = 0;
  let maxWindShear = 0;
  let urbanTempSum = 0;
  let urbanCount = 0;
  let ruralTempSum = 0;
  let ruralCount = 0;

  const dirAt = (k: number): number => {
    return (Math.atan2(frame.u[k], frame.v[k]) * 180) / Math.PI;
  };
  const angleDiff = (a: number, b: number): number => {
    let d = Math.abs(a - b) % 360;
    if (d > 180) d = 360 - d;
    return d;
  };

  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const k = grid.idx(i, j);
      const w = frame.w[k];
      minW = Math.min(minW, w);
      maxW = Math.max(maxW, w);
      const wind = Math.hypot(frame.u[k], frame.v[k]);
      minWind = Math.min(minWind, wind);
      maxWind = Math.max(maxWind, wind);
      const temp = scene.baseTempC + frame.temp[k];
      if (fields.urban[k] >= 0.2) {
        urbanTempSum += temp;
        urbanCount += 1;
      } else {
        ruralTempSum += temp;
        ruralCount += 1;
      }
      const rh = relativeHumidity(frame.humidity[k], temp);
      maxRh = Math.max(maxRh, rh);
      minRh = Math.min(minRh, rh);

      const dTdx = grid.dfdx(frame.temp, i, j);
      const dTdy = grid.dfdy(frame.temp, i, j);
      // dfdx 的单位是 K/m，换算成 K/10km。
      // （早期按 K/km 估过一次，会把所有锋区低估计 100 倍。）
      frontStrength = Math.max(frontStrength, Math.hypot(dTdx, dTdy) * 10000);
      const adv = -(frame.u[k] * dTdx + frame.v[k] * dTdy) * 3600;
      if (adv > maxWarmAdvection) maxWarmAdvection = adv;
      if (adv < maxColdAdvection) maxColdAdvection = adv;

      const divergence =
        grid.dfdx(frame.u, i, j) + grid.dfdy(frame.v, i, j);
      maxConvergence = Math.max(maxConvergence, -divergence);

      const shearX = Math.hypot(
        grid.dfdx(frame.u, i, j),
        grid.dfdx(frame.v, i, j),
      );
      const shearY = Math.hypot(
        grid.dfdy(frame.u, i, j),
        grid.dfdy(frame.v, i, j),
      );
      maxWindShear = Math.max(maxWindShear, Math.hypot(shearX, shearY) * 10000);

      if (wind > 1.5) {
        const dir = dirAt(k);
        if (i + 1 < n) {
          const k2 = grid.idx(i + 1, j);
          if (Math.hypot(frame.u[k2], frame.v[k2]) > 1.5) {
            maxWindDirShiftDeg = Math.max(
              maxWindDirShiftDeg,
              angleDiff(dir, dirAt(k2)),
            );
          }
        }
        if (j + 1 < n) {
          const k2 = grid.idx(i, j + 1);
          if (Math.hypot(frame.u[k2], frame.v[k2]) > 1.5) {
            maxWindDirShiftDeg = Math.max(
              maxWindDirShiftDeg,
              angleDiff(dir, dirAt(k2)),
            );
          }
        }
      }
    }
  }

  // ── 低压中心暖核 / 台风眼 ─────────────────────────────────────────
  let centerWarmCoreK = 0;
  let eyeCloud = 1;
  let eyewallWind = 0;
  let meanTemp = 0;
  for (let k = 0; k < total; k += 1) meanTemp += frame.temp[k];
  meanTemp /= Math.max(1, total);

  const lows = frame.centers.filter((center) => center.type === 'L');
  if (lows.length > 0) {
    const low = lows.reduce((a, b) => (a.value < b.value ? a : b));
    const centerTemp = grid.sample(frame.temp, low.xKm, low.yKm);
    centerWarmCoreK = centerTemp - meanTemp;
    eyeCloud = clamp(
      grid.sample(frame.cloud, low.xKm, low.yKm) / 0.4,
      0,
      1,
    );
    // 眼墙：距中心 20–60 km 的风速最大值；没有台风时也只是一个
    // 半径环上的最大风，配方会同时要求热带气旋条件。
    for (let j = 0; j < n; j += 1) {
      for (let i = 0; i < n; i += 1) {
        const k = grid.idx(i, j);
        const dx = grid.xKm(i) - low.xKm;
        const dy = grid.yKm(j) - low.yKm;
        const r = Math.hypot(dx, dy);
        if (r < 20 || r > 60) continue;
        eyewallWind = Math.max(eyewallWind, Math.hypot(frame.u[k], frame.v[k]));
      }
    }
  }

  return {
    rainCoverage: wetCells / Math.max(1, total),
    rainAreaKm2: wetCells * dxKm * dxKm,
    rainElongation,
    rainAxisDeg,
    rainLengthKm,
    rainWidthKm,
    minW,
    maxW,
    minWind,
    maxWind,
    maxRh,
    minRh,
    frontStrength,
    maxWarmAdvection,
    maxColdAdvection,
    maxConvergence,
    maxWindDirShiftDeg,
    maxWindShear,
    urbanHeatK:
      urbanCount > 0 && ruralCount > 0
        ? urbanTempSum / urbanCount - ruralTempSum / ruralCount
        : 0,
    centerWarmCoreK,
    eyeCloud,
    eyewallWind,
  };
}
