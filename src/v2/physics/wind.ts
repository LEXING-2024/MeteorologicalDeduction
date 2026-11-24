/**
 * V2 · 平衡风与垂直运动。
 * 设计锚点：docs/V2/01 §5.1、§6.5、§6.6。
 *
 * 气压是慢流形：由气压梯度反演地转风，再叠加与粗糙度相关的
 * 跨等压线分量（海上约 12°、陆地约 26°）。垂直速度由散度、
 * 地形抬升、热力异常共同诊断。
 */

import { clamp } from '../core/grid';
import type { Grid } from '../core/grid';
import type { SceneDef } from '../core/types';
import type { SceneFields } from '../scene/scene';
import { froudeNumber } from './m2';

const K_GEOSTROPHIC = 8.5e4; // (m/s) / (hPa/m)，按 M 尺度可玩性标定
const H_SCALE = 5_000; // m
const K_THERMAL = 3.0; // cm/s per K
const K_HEAT_ISLAND = 1.6; // cm/s per K（城市）
const K_SEA_BREEZE = 0.5; // m/s per K
const URBAN_INFLOW = 5_000;
/** 6.6(c) 山口狭管加速：通道中心沿轴向最多加速 1.6 倍。 */
const K_CHANNEL = 0.6;

export interface WindResult {
  u: Float64Array;
  v: Float64Array;
  /** 地转风（用于跨等压线角诊断）。 */
  ug: Float64Array;
  vg: Float64Array;
  /** 平流用的平衡风（地转 + 背景 + 风卡，不含摩擦 / 海风 / 热岛）。 */
  ua: Float64Array;
  va: Float64Array;
  /** 物理气压驱动风（地转 + 跨等压线），用于散度与垂直速度诊断。 */
  up: Float64Array;
  vp: Float64Array;
  w: Float64Array;
  divergence: Float64Array;
}

/** 由粗糙度推导跨等压线角比例：海面 0.22（≈12°），陆地 0.48（≈26°）。 */
export function ageostrophicRatio(roughnessM: number): number {
  const t = clamp((Math.log10(Math.max(roughnessM, 1e-5)) + 4) / 4.5, 0, 1);
  return 0.22 + 0.45 * t;
}

export function computeWind(
  scene: SceneDef,
  fields: SceneFields,
  grid: Grid,
  pressure: Float64Array,
  temperature: Float64Array,
  hourOfDay: number,
  forcingU: Float64Array,
  forcingV: Float64Array,
  out: WindResult,
): WindResult {
  const n = grid.n;
  const { u, v, ug, vg, ua, va, up, vp, w, divergence } = out;
  const axisDeg = scene.terrain.axisDeg ?? 0;
  // 岛屿没有轴线，若沿用 axisXKm=0 会在岛中央画出一条并不存在的海岸线。
  const hasCoast = scene.terrain.kind === 'coast';
  const daylight = Math.max(0, Math.sin(((hourOfDay - 6) / 12) * Math.PI));
  const coastAcross = scene.terrain.axisXKm ?? 0;
  const cx = scene.domainKm / 2;
  const cy = scene.domainKm / 2;
  const rad = (axisDeg * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);

  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const k = grid.idx(i, j);
      const dpdx = grid.dfdx(pressure, i, j);
      const dpdy = grid.dfdy(pressure, i, j);

      const ugc = -K_GEOSTROPHIC * dpdy;
      const vgc = K_GEOSTROPHIC * dpdx;
      const ratio = ageostrophicRatio(fields.roughness[k]);
      let uu = ugc - ratio * K_GEOSTROPHIC * dpdx + scene.bgWindU;
      let vv = vgc - ratio * K_GEOSTROPHIC * dpdy + scene.bgWindV;

      const isLand = fields.land[k] > 0.5;
      const urban = fields.urban[k];
      const friction = isLand ? (urban > 0.25 ? 0.6 : 0.82) : 0.97;
      uu *= friction;
      vv *= friction;

      const block = clamp(
        fields.height[k] / 3500 +
          0.12 * Math.max(1 - froudeNumber(Math.hypot(uu, vv), 0.01, fields.height[k]), 0) *
            clamp(fields.height[k] / 1200, 0, 1),
        0,
        0.55,
      );
      uu *= 1 - block;
      vv *= 1 - block;

      // 6.6(c) 狭管：山口通道中心沿轴向加速，两侧山脊仍由上面的
      // 高度/Froude 阻挡减速。
      if (scene.terrain.kind === 'pass') {
        const ridgeOffset = scene.terrain.ridgeOffsetKm ?? 80;
        const sigma = Math.max(ridgeOffset * 0.55, 30);
        const acrossAxis =
          (grid.xKm(i) - cx) * cos + (grid.yKm(j) - cy) * sin;
        const channel = Math.exp(-((acrossAxis - coastAcross) ** 2) / (2 * sigma * sigma));
        const along = uu * sin + vv * cos;
        if (along > 0) {
          uu += K_CHANNEL * channel * along * sin;
          vv += K_CHANNEL * channel * along * cos;
        }
      }

      // 风卡动量（低空急流）。
      uu += forcingU[k];
      vv += forcingV[k];

      // 城市热岛：沿温度梯度向热中心辐合。
      const dTdx = grid.dfdx(temperature, i, j);
      const dTdy = grid.dfdy(temperature, i, j);
      uu -= URBAN_INFLOW * dTdx * urban;
      vv -= URBAN_INFLOW * dTdy * urban;

      // 海风：白天向岸、夜间离岸。海在“轴负侧”。
      if (hasCoast) {
        const x = grid.xKm(i);
        const y = grid.yKm(j);
        const across = (x - cx) * cos + (y - cy) * sin;
        const inland = across - coastAcross;
        const near = Math.abs(inland) < 55 ? 1 : 0;
        if (near) {
          const decay = Math.exp(-Math.max(Math.abs(inland), 0) / 26);
          const thermal = temperature[k] * Math.max(daylight, 0.12);
          const onshore = daylight > 0.35 ? 1 : -0.45;
          // 法向单位向量（指向陆侧）。
          uu += cos * K_SEA_BREEZE * thermal * decay * onshore;
          vv += sin * K_SEA_BREEZE * thermal * decay * onshore;
        }
      }

      u[k] = uu;
      v[k] = vv;
      ug[k] = ugc;
      vg[k] = vgc;
      ua[k] = ugc + scene.bgWindU + forcingU[k];
      va[k] = vgc + scene.bgWindV + forcingV[k];
      up[k] = ugc - ratio * K_GEOSTROPHIC * dpdx;
      vp[k] = vgc - ratio * K_GEOSTROPHIC * dpdy;
    }
  }

  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const k = grid.idx(i, j);
      // 垂直速度由气压驱动的风散度诊断；摩擦、海风、热岛与风卡
      // 都是动量项，不直接生成垂直运动。
      const div = grid.dfdx(up, i, j) + grid.dfdy(vp, i, j);
      const wDiv = -div * H_SCALE * 100;
      const wOro = (u[k] * fields.slopeX[k] + v[k] * fields.slopeY[k]) * 100;
      // 暖异常显著增强上升；冷异常只轻微抑制（冷低仍可出层云）。
      const thermal = temperature[k] > 0 ? temperature[k] : 0.4 * temperature[k];
      const wThermal = K_THERMAL * thermal;
      const wHeat = K_HEAT_ISLAND * Math.max(temperature[k], 0) * fields.urban[k];
      // 边界总 w 由 engine.step 在叠加 Ekman/急流/冷池后统一做四次阻尼；
      // 这里只给原始诊断值，避免两层海绵重复衰减。
      divergence[k] = div;
      w[k] = clamp(wDiv + wOro + wThermal + wHeat, -90, 220);
    }
  }

  return out;
}
