/**
 * V2 · 4 标准层热力结构（1000 / 850 / 700 / 500 / 300 hPa）。
 *
 * 现有动力核心仍是两层 QG；这里不是再“估算一个 850 hPa 温度”，
 * 而是给每个格点维护 850/700/500/300 的温度与比湿场，并让它们随
 * 风场平流、向标准层结弱松弛、受垂直运动冷却/增湿影响。相态与 PW
 * 直接消费这些层，不再用 `T2m + 8.5 K` 这种反号近似。
 *
 * 物理边界：层结由地面热力强迫和标准廓线初始化，垂直速度目前是
 * 单柱诊断，不是完整 3D 原始方程；但层温/层湿是独立演化场，不是
 * 每帧临时算出来的常数偏移。
 */

import type { Grid } from '../core/grid';
import { clamp } from '../core/grid';
import { advectCubic } from './advection';
import { saturationMixingRatio } from './thermo';

export const LAYER_PRESSURES_HPA = [1000, 850, 700, 500, 300] as const;
const ABOVE_GROUND_HEIGHTS_KM = [0, 1.5, 3.0, 5.5, 9.0] as const;
const LAPSE_RATE_K_KM = 6.5;
/** 各层比湿相对地面的初始系数；越往上越干。 */
const Q_INIT_FACTOR = [1, 0.86, 0.62, 0.28, 0.10] as const;
/** 地面温度/水汽注入对四层的影响权重。 */
const T_IMPULSE_COUPLING = [0.85, 0.65, 0.42, 0.22] as const;
const Q_IMPULSE_COUPLING = [0.82, 0.58, 0.34, 0.16] as const;
/** 向标准层结的弱松弛时间（小时）；不压掉天气尺度异常。 */
const PROFILE_RELAX_H = 72;
/** 垂直运动对层温的绝热冷却/增暖系数，K per (cm/s·h)。 */
const W_ADIABAT_K_PER_CM_S_H = 0.006;

export interface LayerThermoInput {
  grid: Grid;
  sceneBaseTempC: number;
  heightM: Float64Array;
  tempAnomaly: Float64Array;
  qSurface: Float64Array;
  size: number;
}

export class LayerThermo {
  readonly t850: Float64Array;
  readonly t700: Float64Array;
  readonly t500: Float64Array;
  readonly t300: Float64Array;
  readonly q850: Float64Array;
  readonly q700: Float64Array;
  readonly q500: Float64Array;
  readonly q300: Float64Array;

  private readonly tmp: Float64Array;
  private readonly heightM: Float64Array;
  private readonly grid: Grid;

  constructor(input: LayerThermoInput) {
    const { size, grid } = input;
    this.grid = grid;
    this.t850 = new Float64Array(size);
    this.t700 = new Float64Array(size);
    this.t500 = new Float64Array(size);
    this.t300 = new Float64Array(size);
    this.q850 = new Float64Array(size);
    this.q700 = new Float64Array(size);
    this.q500 = new Float64Array(size);
    this.q300 = new Float64Array(size);
    this.tmp = new Float64Array(size);
    this.heightM = input.heightM;
    this.initialize(input.sceneBaseTempC, input.tempAnomaly, input.qSurface);
  }

  private initialize(
    baseTempC: number,
    tempAnomaly: Float64Array,
    qSurface: Float64Array,
  ): void {
    for (let k = 0; k < this.t850.length; k += 1) {
      const surfaceT = baseTempC + tempAnomaly[k];
      const groundKm = clamp((this.heightM[k] ?? 0) / 1000, 0, 2.2);
      const targetAt = (level: number): number => {
        const z = Math.max(0.08, ABOVE_GROUND_HEIGHTS_KM[level] - groundKm);
        return surfaceT - LAPSE_RATE_K_KM * z;
      };
      this.t850[k] = targetAt(1);
      this.t700[k] = targetAt(2);
      this.t500[k] = targetAt(3);
      this.t300[k] = targetAt(4);
      this.q850[k] = this.qAt(this.t850[k], 850, qSurface[k], Q_INIT_FACTOR[1]);
      this.q700[k] = this.qAt(this.t700[k], 700, qSurface[k], Q_INIT_FACTOR[2]);
      this.q500[k] = this.qAt(this.t500[k], 500, qSurface[k], Q_INIT_FACTOR[3]);
      this.q300[k] = this.qAt(this.t300[k], 300, qSurface[k], Q_INIT_FACTOR[4]);
    }
  }

  private qAt(tC: number, p: number, qSurface: number, factor: number): number {
    const qs = saturationMixingRatio(tC, p);
    return clamp(Math.min(qSurface * factor, qs * 0.92), 0, 35);
  }

  /** 地面温度/水汽卡注入后，按层结耦合权重同步到各层。 */
  syncFromSurface(deltaT: Float64Array, deltaQ: Float64Array): void {
    for (let k = 0; k < this.t850.length; k += 1) {
      this.t850[k] += deltaT[k] * T_IMPULSE_COUPLING[0];
      this.t700[k] += deltaT[k] * T_IMPULSE_COUPLING[1];
      this.t500[k] += deltaT[k] * T_IMPULSE_COUPLING[2];
      this.t300[k] += deltaT[k] * T_IMPULSE_COUPLING[3];
      const dq = deltaQ[k];
      if (dq !== 0) {
        this.q850[k] = clamp(this.q850[k] + dq * Q_IMPULSE_COUPLING[0], 0, 35);
        this.q700[k] = clamp(this.q700[k] + dq * Q_IMPULSE_COUPLING[1], 0, 30);
        this.q500[k] = clamp(this.q500[k] + dq * Q_IMPULSE_COUPLING[2], 0, 20);
        this.q300[k] = clamp(this.q300[k] + dq * Q_IMPULSE_COUPLING[3], 0, 12);
      }
    }
  }

  /**
   * 每 10 分钟推进一步：四层温湿分别随 10 m 风平流，向标准层结弱松弛，
   * 再用单柱 w 做弱的绝热调整与层湿饱和截断。
   */
  step(
    u: Float64Array,
    v: Float64Array,
    w: Float64Array,
    dtSeconds: number,
    baseTempC: number,
    tempAnomaly: Float64Array,
    qSurface: Float64Array,
  ): void {
    // 先平流温度。四层共用同一风场；这比“每帧由地面温度重算”多保留了
    // 水平温度平流，但还没有垂直风切变，因此不冒充 3D 原始方程。
    this.advectField(this.t850, u, v, dtSeconds);
    this.advectField(this.t700, u, v, dtSeconds);
    this.advectField(this.t500, u, v, dtSeconds);
    this.advectField(this.t300, u, v, dtSeconds);
    // 层湿平流；湿场只作为 PW/相态诊断，不参与地面水汽账本。
    this.advectField(this.q850, u, v, dtSeconds);
    this.advectField(this.q700, u, v, dtSeconds);
    this.advectField(this.q500, u, v, dtSeconds);
    this.advectField(this.q300, u, v, dtSeconds);

    const relax = dtSeconds / 3600 / PROFILE_RELAX_H;
    const wCool = dtSeconds / 3600;
    for (let k = 0; k < this.t850.length; k += 1) {
      const surfaceT = baseTempC + tempAnomaly[k];
      const groundKm = clamp((this.heightM[k] ?? 0) / 1000, 0, 2.2);
      const z850 = Math.max(0.08, ABOVE_GROUND_HEIGHTS_KM[1] - groundKm);
      const z700 = Math.max(0.08, ABOVE_GROUND_HEIGHTS_KM[2] - groundKm);
      const z500 = Math.max(0.08, ABOVE_GROUND_HEIGHTS_KM[3] - groundKm);
      const z300 = Math.max(0.08, ABOVE_GROUND_HEIGHTS_KM[4] - groundKm);
      const target850 = surfaceT - LAPSE_RATE_K_KM * z850;
      const target700 = surfaceT - LAPSE_RATE_K_KM * z700;
      const target500 = surfaceT - LAPSE_RATE_K_KM * z500;
      const target300 = surfaceT - LAPSE_RATE_K_KM * z300;

      const wAdj = clamp(w[k], -90, 220) * W_ADIABAT_K_PER_CM_S_H * wCool;
      // 上升冷却、下沉增暖：把单柱 w 作为四层共用的垂直位移代理。
      const signCool = wAdj;

      this.t850[k] = clamp(
        this.t850[k] + (target850 - this.t850[k]) * relax - signCool * 1.0,
        -70,
        45,
      );
      this.t700[k] = clamp(
        this.t700[k] + (target700 - this.t700[k]) * relax - signCool * 1.2,
        -75,
        40,
      );
      this.t500[k] = clamp(
        this.t500[k] + (target500 - this.t500[k]) * relax - signCool * 1.6,
        -85,
        35,
      );
      this.t300[k] = clamp(
        this.t300[k] + (target300 - this.t300[k]) * relax - signCool * 1.9,
        -95,
        30,
      );

      // 层湿向层温对应的饱和值截断；过量只作为云/降水诊断丢弃，
      // 不混入地面水汽账本，避免把“层湿”当成第二个地面 q。
      this.q850[k] = clamp(
        Math.min(this.q850[k], saturationMixingRatio(this.t850[k], 850) * 1.02),
        0,
        35,
      );
      this.q700[k] = clamp(
        Math.min(this.q700[k], saturationMixingRatio(this.t700[k], 700) * 1.02),
        0,
        30,
      );
      this.q500[k] = clamp(
        Math.min(this.q500[k], saturationMixingRatio(this.t500[k], 500) * 1.02),
        0,
        20,
      );
      this.q300[k] = clamp(
        Math.min(this.q300[k], saturationMixingRatio(this.t300[k], 300) * 1.02),
        0,
        12,
      );
      // 干空气不会因数值平流凭空变湿：以近地层 q 的层结比例做弱约束。
      const cap850 = Math.max(qSurface[k] * 1.1, 0.2);
      this.q850[k] = Math.min(this.q850[k], cap850);
    }
  }

  private advectField(field: Float64Array, u: Float64Array, v: Float64Array, dtSeconds: number): void {
    advectCubic(field, u, v, dtSeconds, this.grid, this.tmp);
    field.set(this.tmp);
  }

  /** PW：1000/850/700/500/300 五层梯形积分，q 为各层实际比湿。 */
  precipitableWaterMm(k: number, qSurface: number): number {
    const q = [
      clamp(qSurface, 0, 40),
      this.q850[k],
      this.q700[k],
      this.q500[k],
      this.q300[k],
    ];
    let pw = 0;
    for (let i = 0; i < LAYER_PRESSURES_HPA.length - 1; i += 1) {
      const dpPa = (LAYER_PRESSURES_HPA[i] - LAYER_PRESSURES_HPA[i + 1]) * 100;
      pw += 0.5 * ((q[i] + q[i + 1]) / 1000) * dpPa;
    }
    return clamp(pw / 9.81, 0, 100);
  }
}
