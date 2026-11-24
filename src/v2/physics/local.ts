/**
 * V2 · M2 七项局地模块。
 * 设计锚点：docs/V2/01 §7。
 *
 * 海陆风与狭管效应已在 wind.ts 的动量诊断里；
 * 这里补山谷风、城市热岛、湖效应、冷空气坝、焚风，并把它们的
 * 附加风/垂直速度/温湿倾向作为源项交给 engine.step 积分。
 * 所有模块都是确定性的，不引入随机数。
 */

import { clamp, type Grid } from '../core/grid';
import type { SceneDef } from '../core/types';
import type { SceneFields } from '../scene/scene';

export interface LocalForcing {
  /** 附加水平风（m/s）。 */
  du: Float64Array;
  dv: Float64Array;
  /** 附加垂直速度（cm/s）。 */
  w: Float64Array;
  /** 温度倾向（K/h）。 */
  dTemp: Float64Array;
  /** 比湿倾向（g/kg/h）。 */
  dQ: Float64Array;
}

export function createLocalForcing(size: number): LocalForcing {
  return {
    du: new Float64Array(size),
    dv: new Float64Array(size),
    w: new Float64Array(size),
    dTemp: new Float64Array(size),
    dQ: new Float64Array(size),
  };
}

/** 山谷风：坡面加热/冷却产生的沿谷风，白天谷风、夜间山风。 */
export function valleyWindSpeed(thermalAnomalyK: number, solar: number): number {
  const buoyancy = 9.81 * thermalAnomalyK / 300;
  const magnitude = Math.sqrt(Math.abs(buoyancy) * 1000) * 0.8;
  // 白天暖坡 → 沿谷向上；夜间冷坡 → 沿谷向下。夜间不反向，
  // 只把幅度压到白天的 0.5。
  const dayNight = solar > 0.05 ? 1 : 0.5;
  return clamp(magnitude * Math.sign(buoyancy) * dayNight, -4, 4);
}

/** 城市热岛：夜间最强，白天被混合削弱。 */
export function urbanHeatTendency(urban: number, solar: number): number {
  return 0.14 * urban * (1 - 0.75 * solar);
}

/** 湖效应：冷空气过暖湖，蒸发与下游抬升随温差增大。 */
export function lakeEffectFlux(
  lakeMinusAirK: number,
  windSpeed: number,
): { q: number; w: number } {
  if (lakeMinusAirK <= 5) return { q: 0, w: 0 };
  const wind = clamp(windSpeed / 4, 0.25, 2.5);
  return {
    q: clamp(0.28 * (lakeMinusAirK - 5) * wind, 0, 10),
    w: clamp(0.22 * (lakeMinusAirK - 5) * wind, 0, 18),
  };
}

/** 冷空气坝：盆地内冷池越厚，山口溢流抬升越强。 */
export function coldAirDamLift(coldAnomalyK: number, heightM: number, baseHeightM: number): number {
  if (coldAnomalyK >= -0.6) return 0;
  const aboveFloor = Math.max(0, heightM - baseHeightM);
  return clamp(0.18 * -coldAnomalyK * Math.min(1, aboveFloor / 300), 0, 8);
}

/** 焚风：背风下沉增温，随下沉分量增强；同时变干。 */
export function foehnTendency(downslopeMs: number): { dTemp: number; dQ: number } {
  if (downslopeMs <= 0) return { dTemp: 0, dQ: 0 };
  const dTemp = clamp(0.8 * downslopeMs * 10, 0, 4);
  return { dTemp, dQ: -0.22 * dTemp };
}

/**
 * 计算七项局地模块的源项。
 * 海陆风与狭管已在 computeWind 中生效，这里不重复叠加；
 * 其他五项在这里生成源项。
 */
export function computeLocalForcing(
  scene: SceneDef,
  fields: SceneFields,
  grid: Grid,
  temperature: Float64Array,
  u: Float64Array,
  v: Float64Array,
  tod: number,
  out?: LocalForcing,
): LocalForcing {
  const n = grid.n;
  const size = n * n;
  const forcing = out ?? createLocalForcing(size);
  forcing.du.fill(0);
  forcing.dv.fill(0);
  forcing.w.fill(0);
  forcing.dTemp.fill(0);
  forcing.dQ.fill(0);

  const kind = scene.terrain.kind;
  const axisDeg = scene.terrain.axisDeg ?? 0;
  const axisRad = (axisDeg * Math.PI) / 180;
  const axisX = -Math.sin(axisRad);
  const axisY = Math.cos(axisRad);
  const solar = Math.max(0, Math.sin(((tod - 6) / 12) * Math.PI));
  const baseHeight = scene.terrain.baseHeightM ?? 60;

  let meanT = 0;
  for (let k = 0; k < size; k += 1) meanT += temperature[k];
  meanT /= Math.max(1, size);

  const valley = kind === 'valley';
  const basin = kind === 'basin';
  const lake = kind === 'lake';
  const foehn = kind === 'ridge' || kind === 'mountainCoast' || kind === 'pass';

  const lakeCenterX = scene.domainKm / 2 + (scene.terrain.axisXKm ?? 0);
  const lakeCenterY = scene.domainKm / 2;
  const lakeRadius = scene.terrain.lakeRadiusKm ?? scene.terrain.islandRadiusKm ?? 80;

  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const k = j * n + i;
      const isLand = fields.land[k] > 0.5;
      const urban = fields.urban[k];
      const temp = temperature[k];
      const speed = Math.hypot(u[k], v[k]);

      if (valley) {
        const speedAlong = valleyWindSpeed(temp - meanT, solar);
        forcing.du[k] += speedAlong * axisX;
        forcing.dv[k] += speedAlong * axisY;
      }

      if (urban > 0.02) {
        forcing.dTemp[k] += urbanHeatTendency(urban, solar);
        // 城市边缘辐合已在 computeWind 中处理，这里只加弱的水汽下沉。
        forcing.dQ[k] -= 0.03 * urban * (1 - 0.5 * solar);
      }

      if (lake && !isLand) {
        const deltaT = scene.sstC - (scene.baseTempC + temp);
        const flux = lakeEffectFlux(deltaT, speed);
        forcing.dQ[k] += flux.q;
        forcing.w[k] += flux.w;
        forcing.dTemp[k] -= 0.03 * Math.max(0, deltaT);
      } else if (lake && isLand) {
        const dx = grid.xKm(i) - lakeCenterX;
        const dy = grid.yKm(j) - lakeCenterY;
        const dist = Math.hypot(dx, dy);
        if (dist > lakeRadius && dist < lakeRadius + 90) {
          const deltaT = scene.sstC - (scene.baseTempC + temp);
          const flux = lakeEffectFlux(deltaT, speed);
          forcing.w[k] += 0.55 * flux.w;
          forcing.dQ[k] += 0.35 * flux.q;
        }
      }

      if (basin && temp < -0.5) {
        forcing.w[k] += coldAirDamLift(temp, fields.height[k], baseHeight);
        forcing.dTemp[k] -= 0.05 * -temp;
      }

      if (foehn && isLand) {
        const upslope = u[k] * fields.slopeX[k] + v[k] * fields.slopeY[k];
        const downslope = Math.max(0, -upslope * 100);
        if (downslope > 0.01) {
          const tendency = foehnTendency(downslope);
          forcing.dTemp[k] += tendency.dTemp;
          forcing.dQ[k] += tendency.dQ;
        }
      }
    }
  }

  return forcing;
}
