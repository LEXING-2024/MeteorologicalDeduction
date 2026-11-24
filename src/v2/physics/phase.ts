/**
 * 01 §8.5 · 降水相态分配。
 *
 * 引擎已维护 850 hPa 独立温度场；这里保留缺省估计只作为纯函数/单测的
 * 兜底，按标准对流层减温率约 -9.5 K（850 hPa 约 1.5 km），不再使用
 * “地面 + 8.5 K”这种反号近似。
 */
import { clamp, smoothstep } from '../core/grid';
import type { PrecipPhase } from '../core/types';

export interface PhasePartition {
  rain: number;
  sleet: number;
  snow: number;
  freezingRain: number;
  hail: number;
}

export interface PhaseInput {
  tempC: number;
  qGkg: number;
  /** 垂直速度，cm/s（与 engine 内部一致）。 */
  wCmS: number;
  /** CAPE 代理，J/kg。 */
  capeJkg: number;
  /** 总降水率，mm/h，水当量。 */
  precipRate: number;
  /** 850 hPa 温度；缺省时按地面温度 - 9.5 K 估计。 */
  t850C?: number;
  /** 地面暖平流，K/h；用于识别“冷地面 + 暖中层”的冻雨暖鼻。 */
  warmAdvectionKPerH?: number;
}

const EMPTY: PhasePartition = {
  rain: 0,
  sleet: 0,
  snow: 0,
  freezingRain: 0,
  hail: 0,
};

/**
 * 把总降水率拆成互斥的五类。分相比例之和恒为 1，
 * 因此水汽账本仍可按“总降水”闭合。
 */
export function partitionPrecipitation(input: PhaseInput): PhasePartition {
  if (!(input.precipRate > 1e-4)) return { ...EMPTY };

  const temp = input.tempC;
  const t850 = input.t850C ?? temp - 9.5;
  const warmNose =
    (input.warmAdvectionKPerH ?? 0) > 0.05 &&
    (input.qGkg ?? 0) > 2.5;

  // 冰雹：强上升 + 高 CAPE + 有冰相潜势的冷性对流。
  // 当前暖云方案没有冰晶/霰，直接把夏季低地降水的大比例记成冰雹
  // 会制造“每个强对流都下冰雹”的假象；因此只在较冷的环境里
  // 给出很小的冰雹份额，作为相态诊断而非完整冰相微物理。
  let hail = 0;
  if (
    input.capeJkg >= 2500 &&
    input.wCmS >= 120 &&
    input.precipRate >= 8 &&
    temp <= 18
  ) {
    hail =
      0.003 +
      0.032 *
        smoothstep(2500, 4200, input.capeJkg) *
        smoothstep(120, 220, input.wCmS);
    hail = clamp(hail, 0, 0.04);
  }

  const residual = 1 - hail;
  let rain = 0;
  let sleet = 0;
  let snow = 0;
  let freezingRain = 0;

  if (temp > 2) {
    rain = residual;
  } else if (temp > 0) {
    // 0–2 ℃ 是雨夹雪过渡带；越接近 0 ℃，固相比例越高。
    const frozen = residual * smoothstep(2, 0, temp);
    sleet = frozen;
    rain = residual - frozen;
  } else if (t850 > 0 || warmNose) {
    // 地面低于 0 ℃、中层高于 0 ℃：过冷雨滴落到地面即冻雨。
    freezingRain = residual;
  } else {
    snow = residual;
  }

  return { rain, sleet, snow, freezingRain, hail };
}

export function dominantPhase(p: PhasePartition): PrecipPhase {
  let best: PrecipPhase = 'none';
  let value = 0.005;
  if (p.rain > value) {
    best = 'rain';
    value = p.rain;
  }
  if (p.sleet > value) {
    best = 'sleet';
    value = p.sleet;
  }
  if (p.snow > value) {
    best = 'snow';
    value = p.snow;
  }
  if (p.freezingRain > value) {
    best = 'freezingRain';
    value = p.freezingRain;
  }
  if (p.hail > value) best = 'hail';
  return best;
}

export function phaseLabel(phase: PrecipPhase): string {
  switch (phase) {
    case 'rain':
      return '雨';
    case 'sleet':
      return '雨夹雪';
    case 'snow':
      return '雪';
    case 'freezingRain':
      return '冻雨';
    case 'hail':
      return '冰雹';
    default:
      return '—';
  }
}
