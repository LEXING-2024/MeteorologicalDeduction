/**
 * 01 §6.11 / 03 §9.3 · 整层可降水量（PW, mm）。
 *
 * 引擎只有一层湿度。为了不把“单层 q 求和”冒充 PW，这里用
 * 地面 q、地面温度和标准大气温度/湿度廓线做 5 层梯形积分：
 *   PW = (1/g) ∫ q dp
 * 其中 q 为 kg/kg，dp 为 Pa；1 kg/m² = 1 mm。
 *
 * 这是“单层湿度 + 气候廓线”的诊断积分，不是 4 标准层预报。
 * 它的用途是让 PW 有量级正确、随湿度/温度连续变化的读数，
 * 并为 M3 的水汽类配方提供可检验的变量。
 */
import { clamp } from '../core/grid';
import { relativeHumidity, saturationMixingRatio } from './thermo';

const LEVELS_HPA = [1000, 850, 700, 500, 300] as const;
/** 各层相对湿度相对地面的系数；越往上越干。 */
const RH_FACTOR = [1, 0.95, 0.82, 0.6, 0.42] as const;

/** 标准大气高度（m），用国际民航组织公式。 */
function heightM(pHpa: number): number {
  return 44330 * (1 - Math.pow(pHpa / 1013.25, 0.1903));
}

/** 五层高度在模块加载时算一次，避免逐格重复 pow。 */
const LEVEL_HEIGHTS_M = LEVELS_HPA.map(heightM);

/**
 * 由地面 q、地面温度、地面 RH 积分 PW。
 * @param qGkg 地面比湿，g/kg
 * @param tempC 地面气温，℃
 * @param rhPercent 地面相对湿度，%
 */
export function precipitableWaterMm(
  qGkg: number,
  tempC: number,
  rhPercent: number,
): number {
  const q0 = clamp(qGkg, 0, 40);
  const rh0 = clamp(rhPercent, 0, 110) / 100;

  // 逐层算 q 并直接做梯形积分，不分配中间数组。
  let previousQ = 0;
  let pw = 0;
  for (let i = 0; i < LEVELS_HPA.length; i += 1) {
    const p = LEVELS_HPA[i];
    const z = LEVEL_HEIGHTS_M[i];
    // 标准对流层减温率 6.5 K/km；到 300 hPa 后不再继续外推。
    const tLevel = tempC - 6.5 * (z / 1000);
    const qs = saturationMixingRatio(tLevel, p);
    const rh = clamp(rh0 * RH_FACTOR[i], 0, 1.05);
    const q = Math.min(q0, qs * rh);

    if (i > 0) {
      const dpPa = (LEVELS_HPA[i - 1] - p) * 100;
      pw += 0.5 * ((previousQ + q) / 1000) * dpPa;
    }
    previousQ = q;
  }
  pw /= 9.81;
  return clamp(pw, 0, 100);
}

/** 便捷入口：直接传 q / 温度 / 地面气压，内部算 RH。 */
export function precipitableWaterFromState(
  qGkg: number,
  tempC: number,
  pressureHpa = 1000,
): number {
  return precipitableWaterMm(qGkg, tempC, relativeHumidity(qGkg, tempC, pressureHpa));
}
