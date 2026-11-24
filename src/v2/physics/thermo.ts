/**
 * V2: 01 §6.11 · 湿绝热与饱和。
 *
 * 全部用 Tetens/Bolton 经验式，精度足够支撑判题（±0.5 K），并且是纯函数。
 */

/** 海平面气压显示基准；内部 QG 场仍存距平，UI 显示时统一加回该值。 */
export const REFERENCE_PRESSURE_HPA = 1000;

export function absolutePressureHpa(anomalyHpa: number): number {
  return REFERENCE_PRESSURE_HPA + anomalyHpa;
}

/** 饱和水汽压，hPa。 */
export function saturationVapourPressure(tC: number): number {
  return 6.112 * Math.exp((17.67 * tC) / (tC + 243.5));
}

/** 饱和混合比，g/kg。 */
export function saturationMixingRatio(tC: number, pressureHpa = 1000): number {
  const es = saturationVapourPressure(tC);
  return (622 * es) / Math.max(pressureHpa - es, 1);
}

export function relativeHumidity(qGkg: number, tC: number, pressureHpa = 1000): number {
  const qs = saturationMixingRatio(tC, pressureHpa);
  return qs <= 1e-6 ? 0 : Math.min(160, (qGkg / qs) * 100);
}

/** 露点，°C（Bolton 反解）。 */
export function dewpoint(qGkg: number, pressureHpa = 1000): number {
  const q = Math.max(qGkg, 0.01);
  const e = (q * pressureHpa) / (622 + q);
  const ln = Math.log(e / 6.112);
  return (243.5 * ln) / (17.67 - ln);
}

/** 位温，K。 */
export function potentialTemperature(tC: number, pressureHpa: number): number {
  const tK = tC + 273.15;
  return tK * Math.pow(1000 / Math.max(pressureHpa, 100), 0.286);
}

/** 给定气压下的饱和比湿（g/kg）——供参数化使用。 */
export function saturationSpecificHumidity(tC: number, pressureHpa: number): number {
  return saturationMixingRatio(tC, pressureHpa);
}

/** 相对湿度 → 云量（01 §8.4）。 */
export function cloudCoverFromRh(rh: number): number {
  return Math.max(0, Math.min(1, (rh - 82) / 16));
}

/**
 * 体感温度：暖季用 Steadman 的湿热+风冷公式，低温强风用加拿大
 * wind-chill。它只用于读图，不改变模式的空气温度场。
 */
export function apparentTemperatureC(
  tempC: number,
  rhPercent: number,
  windMs: number,
): number {
  const rh = Math.max(0, Math.min(100, rhPercent));
  const wind = Math.max(0, windMs);
  const windKmh = wind * 3.6;
  if (tempC <= 10 && windKmh >= 4.8) {
    const v = Math.pow(windKmh, 0.16);
    return 13.12 + 0.6215 * tempC - 11.37 * v + 0.3965 * tempC * v;
  }
  const vapourPressure = (rh / 100) * saturationVapourPressure(tempC);
  return tempC + 0.33 * vapourPressure - 0.7 * wind - 4;
}
