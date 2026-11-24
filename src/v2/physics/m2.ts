/**
 * V2 · M2 十二项承重物理的可计算实现。
 * 设计锚点：docs/V2/01 §6.1–6.12。
 *
 * 这里放纯函数/小状态机，engine 负责把结果并入时间步；
 * 每个函数都有独立验收（scripts/v2/verify-m2.ts）。
 */

import type { Grid } from '../core/grid';
import { clamp } from '../core/grid';
import { relativeHumidity, saturationMixingRatio } from './thermo';

export const RHO_AIR = 1.2; // kg/m³
export const CP_AIR = 1004; // J/(kg·K)
export const LV = 2.5e6; // J/kg
export const G_ACC = 9.81;
export const OMEGA_EARTH = 7.2921e-5;
export const F0_DEFAULT = 7.29e-5;
export const H_EKMAN = 1000; // m

export function coriolis(latitudeDeg: number): number {
  return 2 * OMEGA_EARTH * Math.sin((latitudeDeg * Math.PI) / 180);
}

/** 6.5 拖曳系数：C_d = (κ / ln(z/z0))²。 */
export function dragCoefficient(roughnessM: number): number {
  const z0 = Math.max(roughnessM, 1e-4);
  const cd = (0.4 / Math.log(10 / z0)) ** 2;
  return clamp(cd, 1e-3, 3e-3);
}

/**
 * 6.5 Ekman 抽吸：w_E = curl(τ_s) / (ρ f H_ek)。
 * 返回 cm/s；海上小、城市/山地大。
 */
export function ekmanSuction(
  u: Float64Array,
  v: Float64Array,
  roughness: Float64Array,
  grid: Grid,
  latitudeDeg: number,
  out?: Float64Array,
): Float64Array {
  const n = grid.n;
  const f0 = Math.max(Math.abs(coriolis(latitudeDeg)), 1e-5);
  const result = out ?? new Float64Array(n * n);
  const tauU = new Float64Array(n * n);
  const tauV = new Float64Array(n * n);
  for (let k = 0; k < u.length; k += 1) {
    const speed = Math.hypot(u[k], v[k]);
    const cd = dragCoefficient(roughness[k]);
    tauU[k] = RHO_AIR * cd * speed * u[k];
    tauV[k] = RHO_AIR * cd * speed * v[k];
  }
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const k = j * n + i;
      const curl = grid.dfdx(tauV, i, j) - grid.dfdy(tauU, i, j);
      const we = curl / (RHO_AIR * f0 * H_EKMAN); // m/s
      result[k] = clamp(we * 100, -40, 40);
    }
  }
  return result;
}

/**
 * 6.10 高空强迫：急流入口辐合 / 出口辐散，经 Dines 补偿转成低层 w。
 * 用 forcingU/V 作为 200 hPa 急流代理；返回 cm/s。
 */
export function upperJetForcing(
  upperU: Float64Array,
  upperV: Float64Array,
  grid: Grid,
  latitudeDeg: number,
  out?: Float64Array,
): Float64Array {
  const n = grid.n;
  const f0 = Math.max(Math.abs(coriolis(latitudeDeg)), 1e-5);
  const result = out ?? new Float64Array(n * n);
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const div = grid.dfdx(upperU, i, j) + grid.dfdy(upperV, i, j);
      // w_low = -(H/f0)·∇·V_upper；乘 0.35 把 200 hPa 层厚折算到低层。
      const w = -(0.35 * 7000 / f0) * div;
      result[grid.idx(i, j)] = clamp(w * 100, -60, 60);
    }
  }
  return result;
}

/**
 * 6.8 冷池：降水蒸发冷却 → 负浮力 → 阵风锋。
 * 返回冷却率（K/h）、冷池强度（m/s²）、前沿抬升（cm/s）。
 */
export interface ColdPoolResult {
  coolingKPerH: number;
  buoyancy: number;
  gustSpeed: number;
  liftCmS: number;
}

export function coldPoolStep(
  precipRateMmH: number,
  temperatureC: number,
  dtH: number,
  out?: ColdPoolResult,
): ColdPoolResult {
  const target = out ?? { coolingKPerH: 0, buoyancy: 0, gustSpeed: 0, liftCmS: 0 };
  // 约 18% 的雨滴在冷性降水里蒸发；暖性降水蒸发弱。
  const evapFraction = temperatureC < 18 ? 0.18 : 0.08;
  const cooling = evapFraction * precipRateMmH * 0.075; // K/h
  target.coolingKPerH = cooling;
  const thetaAnom = cooling * dtH;
  const theta0 = Math.max(temperatureC + 273.15, 200);
  target.buoyancy = (G_ACC * thetaAnom) / theta0;
  // c = 0.7√(g'h)，取冷池厚度 1200 m。
  target.gustSpeed = 0.7 * Math.sqrt(Math.max(target.buoyancy, 0) * 1200);
  target.liftCmS = clamp(target.gustSpeed * 100 * 0.55, 0, 45);
  return target;
}

/**
 * 6.12 辐射：太阳高度角 + 云遮蔽 + 长波，返回地面温度倾向（K/h）。
 */
export function radiationHeating(
  temperatureC: number,
  cloudCover: number,
  hourOfDay: number,
  isLand: boolean,
  urban: number,
  latitudeDeg = 30,
): number {
  const decl = ((23.44 * Math.PI) / 180) * Math.sin((2 * Math.PI * (hourOfDay - 81)) / 365);
  const lat = (latitudeDeg * Math.PI) / 180;
  const hourAngle = ((15 * (hourOfDay - 12)) * Math.PI) / 180;
  const sinAlt = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle);
  const solar = sinAlt > 0 ? 1361 * sinAlt : 0;
  const albedo = isLand ? 0.2 : 0.08;
  const cc = clamp(cloudCover, 0, 1);
  const shortwave = solar * (1 - 0.75 * cc ** 3) * (1 - albedo);
  const tK = temperatureC + 273.15;
  const longwave = 0.95 * 5.67e-8 * tK ** 4 * (1 - 0.35 * cc) - 0.95 * 5.67e-8 * (288 ** 4);
  const net = shortwave + longwave;
  const heatCapacity = isLand ? 1.5e6 : 2e7;
  const heating = (net / heatCapacity) * 3600; // K/h
  return heating + (isLand ? 0.06 * urban : 0);
}

/**
 * 6.4 地表通量。q 为 g/kg，风 m/s，返回 g/(kg·h) 与 K/h。
 */
export interface SurfaceFlux {
  evaporation: number;
  sensibleHeating: number;
}

export function surfaceFlux(
  windSpeed: number,
  temperatureC: number,
  humidityGkg: number,
  surfaceTempC: number,
  isLand: boolean,
  urban: number,
  dtH: number,
  out?: SurfaceFlux,
): SurfaceFlux {
  const target = out ?? { evaporation: 0, sensibleHeating: 0 };
  const qs = saturationMixingRatio(surfaceTempC);
  const moistLand = isLand && urban < 0.2;
  const cE = !isLand ? 1.2e-3 : urban > 0.25 ? 0.5e-3 : moistLand ? 1.5e-3 : 0.3e-3;
  const cH = !isLand ? 1.1e-3 : urban > 0.25 ? 1.5e-3 : 1.2e-3;
  const windFactor = clamp(windSpeed / 6, 0, 1.6);
  // 陆地蒸发约比海洋小一个量级；0.015 把 C_E 的物理量级折算到
  // 本模型 g/kg 的湿度单位，避免整张图被地面蒸发灌满。
  const evapScale = isLand ? 0.015 : 0.28;
  // 海气交换的平衡态不是 100% RH：边界层湍流交换会与夹卷/沉降平衡，
  // 取 84%（陆地 72%）。否则暖海面会一路补到饱和，整片海面过饱和生云。
  const targetRh = isLand ? 0.72 : 0.84;
  target.evaporation = clamp(
    evapScale * cE * 1000 * windFactor * Math.max(qs * targetRh - humidityGkg, 0) * dtH,
    0,
    8,
  );
  target.sensibleHeating = clamp(
    0.28 * cH * 1000 * windFactor * (surfaceTempC - temperatureC) * dtH,
    -3,
    3,
  );
  return target;
}

/** 6.3 凝结潜热：把凝结量（g/kg）换成气块升温（K）。 */
export function latentHeatingK(condensedGkg: number): number {
  return (LV * (condensedGkg / 1000)) / CP_AIR;
}

/** 6.6 Fr = U/(N h)；<1 绕流，>1 翻越。 */
export function froudeNumber(windSpeed: number, brunt: number, heightM: number): number {
  return windSpeed / Math.max(brunt * heightM, 1e-6);
}

/** 6.7 Q 矢量锋生：返回逐格锋生率（K/10km/h），正值为锋生。 */
export function qVectorFrontogenesisField(
  theta: Float64Array,
  u: Float64Array,
  v: Float64Array,
  grid: Grid,
  out?: Float64Array,
): Float64Array {
  const n = grid.n;
  const result = out ?? new Float64Array(n * n);
  result.fill(0);
  for (let j = 1; j < n - 1; j += 1) {
    for (let i = 1; i < n - 1; i += 1) {
      const tx = grid.dfdx(theta, i, j);
      const ty = grid.dfdy(theta, i, j);
      const grad = Math.hypot(tx, ty);
      if (grad < 1e-8) continue;
      const ux = grid.dfdx(u, i, j);
      const uy = grid.dfdy(u, i, j);
      const vx = grid.dfdx(v, i, j);
      const vy = grid.dfdy(v, i, j);
      const qx = -(ux * tx + vx * ty);
      const qy = -(uy * tx + vy * ty);
      const f = -(qx * tx + qy * ty) / grad;
      result[j * n + i] = clamp(f * 1e4, -5, 5);
    }
  }
  return result;
}

/** 6.7 Q 矢量锋生：返回最大锋生率（K/10km/h）。 */
export function qVectorFrontogenesis(
  theta: Float64Array,
  u: Float64Array,
  v: Float64Array,
  grid: Grid,
): number {
  const field = qVectorFrontogenesisField(theta, u, v, grid);
  let max = 0;
  for (const value of field) max = Math.max(max, value);
  return max;
}

/** 6.8 CAPE 代理：暖湿气块相对环境的正浮力（J/kg）。 */
export function capeProxy(temperatureC: number, humidityGkg: number, baseTempC: number): number {
  const excess = Math.max(temperatureC - baseTempC, 0);
  const rh = relativeHumidity(humidityGkg, temperatureC);
  return clamp(1200 * excess * (rh / 100), 0, 4000);
}

/** ω 方程诊断：ω = −ρ g w（w 为 cm/s，ω 为 Pa/s）。 */
export function omegaFromW(wCmS: number): number {
  return -RHO_AIR * G_ACC * (wCmS / 100);
}

/**
 * 6.11 水汽四栏账本。单位统一为“网格水汽总量”（g/kg 求和）。
 */
export class WaterLedger {
  start = 0;
  evaporated = 0;
  rained = 0;
  end = 0;
  /** 开放边界的水汽通量（诊断项，不改变四栏主账）。 */
  boundary = 0;
  /** 数值截断移除的水汽（上限 45/12 g/kg）。 */
  clampLoss = 0;
  /** 逐步质量守恒诊断：未被上述项解释的残差。 */
  unaccounted = 0;
  private stepStartMass = 0;
  private stepSource = 0;
  private stepRain = 0;
  private stepBoundary = 0;
  private stepClamp = 0;

  reset(humidity: Float64Array, cloud: Float64Array): void {
    this.start = this.total(humidity, cloud);
    this.evaporated = 0;
    this.rained = 0;
    this.boundary = 0;
    this.clampLoss = 0;
    this.unaccounted = 0;
    this.stepStartMass = 0;
    this.stepSource = 0;
    this.stepRain = 0;
    this.stepBoundary = 0;
    this.stepClamp = 0;
    this.end = this.start;
  }

  beginStep(humidity: Float64Array, cloud: Float64Array): void {
    this.stepStartMass = this.total(humidity, cloud);
    this.stepSource = 0;
    this.stepRain = 0;
    this.stepBoundary = 0;
    this.stepClamp = 0;
  }

  endStep(humidity: Float64Array, cloud: Float64Array): void {
    this.end = this.total(humidity, cloud);
    this.unaccounted +=
      this.end -
      this.stepStartMass -
      (this.stepSource + this.stepBoundary + this.stepClamp - this.stepRain);
  }

  addMoisture(delta: number): void {
    // 玩家放入的水汽卡也算初始水汽，避免账本出现“无源水汽”。
    this.start += delta;
  }

  addEvaporation(delta: number): void {
    this.evaporated += delta;
    this.stepSource += delta;
  }

  addRain(delta: number): void {
    this.rained += Math.max(delta, 0);
    this.stepRain += Math.max(delta, 0);
  }

  addBoundary(delta: number): void {
    this.boundary += delta;
    this.stepBoundary += delta;
  }

  addClamp(delta: number): void {
    this.clampLoss += delta;
    this.stepClamp += delta;
  }

  update(humidity: Float64Array, cloud: Float64Array): void {
    this.end = this.total(humidity, cloud);
  }

  closure(): number {
    if (this.start <= 1e-9) return 0;
    return (
      Math.abs(
        this.start + this.evaporated + this.boundary + this.clampLoss - this.rained - this.end,
      ) /
        this.start
    );
  }

  total(humidity: Float64Array, cloud: Float64Array): number {
    let sum = 0;
    for (let k = 0; k < humidity.length; k += 1) sum += humidity[k] + cloud[k];
    return sum;
  }
}
