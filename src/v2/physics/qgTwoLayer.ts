/**
 * V2 · 两层准地转核心。
 * 设计锚点：docs/V2/01 §5.2–5.4、§6.1。
 *
 *   q₁ = ∇²ψ₁ + βy − k_d²(ψ₁−ψ₂)
 *   q₂ = ∇²ψ₂ + βy + k_d²(ψ₁−ψ₂)
 *   ∇²T = q₁+q₂−2βy          （T = ψ₁+ψ₂，正压模）
 *   (∇²−2k_d²)C = q₁−q₂      （C = ψ₁−ψ₂，斜压模）
 *
 * 卷一的要素卡目前都是正压的（ψ₁=ψ₂），所以行为与正压核心一致；
 * 但温度/厚度卡接进来后，斜压模会直接在这个结构里生长。
 */

import type { Grid } from '../core/grid';
import { advectCubic } from './advection';
import { laplacianOf, solveHelmholtz } from './poisson';
import {
  PSI_PER_HPA,
  QG_DIFFUSIVITY,
  betaAt,
  windFromPsi,
} from './qg';

export const N_BRUNT = 0.01; // s⁻¹
export const H_SCALE = 7000; // m

export function kd2At(latitudeDeg: number): number {
  const f0 = 2 * 7.2921e-5 * Math.sin((latitudeDeg * Math.PI) / 180);
  const lr = (N_BRUNT * H_SCALE) / Math.max(f0, 1e-6);
  return 1 / (2 * lr * lr);
}

export class TwoLayerQG {
  readonly grid: Grid;
  readonly beta: number;
  readonly kd2: number;

  readonly psi1: Float64Array;
  readonly psi2: Float64Array;
  readonly q1: Float64Array;
  readonly q2: Float64Array;
  readonly q1Tmp: Float64Array;
  readonly q2Tmp: Float64Array;
  readonly psi1Tmp: Float64Array;
  readonly psi2Tmp: Float64Array;
  readonly tempMode: Float64Array;
  readonly baroMode: Float64Array;
  readonly rhs: Float64Array;
  readonly u: Float64Array;
  readonly v: Float64Array;

  constructor(grid: Grid, latitudeDeg: number) {
    this.grid = grid;
    this.beta = betaAt(latitudeDeg);
    this.kd2 = kd2At(latitudeDeg);
    const size = grid.n * grid.n;
    this.psi1 = new Float64Array(size);
    this.psi2 = new Float64Array(size);
    this.q1 = new Float64Array(size);
    this.q2 = new Float64Array(size);
    this.q1Tmp = new Float64Array(size);
    this.q2Tmp = new Float64Array(size);
    this.psi1Tmp = new Float64Array(size);
    this.psi2Tmp = new Float64Array(size);
    this.tempMode = new Float64Array(size);
    this.baroMode = new Float64Array(size);
    this.rhs = new Float64Array(size);
    this.u = new Float64Array(size);
    this.v = new Float64Array(size);
  }

  resetFromPressure(pressure: Float64Array): void {
    for (let k = 0; k < pressure.length; k += 1) {
      const psi = pressure[k] * PSI_PER_HPA;
      this.psi1[k] = psi;
      this.psi2[k] = psi;
    }
    this.applySponge();
    this.diagnosePV();
  }

  /** 8 格海绵层：流函数在边界平滑归零，避免 Dirichlet 反演造出边缘假急流。 */
  private applySponge(): void {
    const n = this.grid.n;
    for (let j = 0; j < n; j += 1) {
      for (let i = 0; i < n; i += 1) {
        const d = Math.min(i, j, n - 1 - i, n - 1 - j);
        if (d >= 8) continue;
        const factor = 0.5 * (1 - Math.cos((Math.PI * d) / 8));
        const k = j * n + i;
        this.psi1[k] *= factor;
        this.psi2[k] *= factor;
      }
    }
  }

  /** 放置卡：两层同时加（正压注入）。 */
  addPressure(pressure: Float64Array): void {
    for (let k = 0; k < pressure.length; k += 1) {
      const psi = pressure[k] * PSI_PER_HPA;
      this.psi1[k] += psi;
      this.psi2[k] += psi;
    }
  }

  /**
   * 6.1 温度/厚度强迫：暖异常 → 上层 ψ 增大、下层 ψ 减小，
   * 斜压模 C = ψ₁−ψ₂ 被真正驱动，而不是只改地面温度。
   */
  addTemperature(deltaT: Float64Array, cPerK = 2.4e4): void {
    for (let k = 0; k < deltaT.length; k += 1) {
      const c = deltaT[k] * cPerK;
      this.psi1[k] += 0.5 * c;
      this.psi2[k] -= 0.5 * c;
    }
    this.diagnosePV();
  }

  /** 温度场向斜压模缓慢松弛；只保留大尺度热成风，不让辐射噪声爆掉。 */
  nudgeBaroclinicity(temperature: Float64Array, cPerK: number, fraction: number): void {
    if (fraction <= 0) return;
    const f = Math.max(0, Math.min(1, fraction));
    for (let k = 0; k < temperature.length; k += 1) {
      const target = temperature[k] * cPerK;
      const current = this.psi1[k] - this.psi2[k];
      const delta = (target - current) * f;
      this.psi1[k] += 0.5 * delta;
      this.psi2[k] -= 0.5 * delta;
    }
    this.diagnosePV();
  }

  diagnosePV(): void {
    const { grid, psi1, psi2, q1, q2, beta, kd2 } = this;
    laplacianOf(psi1, grid.n, grid.dxM, q1);
    laplacianOf(psi2, grid.n, grid.dxM, q2);
    const y0 = (grid.domainKm * 1000) / 2;
    for (let j = 0; j < grid.n; j += 1) {
      const y = (j + 0.5) * grid.dxM - y0;
      const row = j * grid.n;
      for (let i = 0; i < grid.n; i += 1) {
        const k = row + i;
        const c = kd2 * (psi1[k] - psi2[k]);
        q1[k] += beta * y - c;
        q2[k] += beta * y + c;
      }
    }
  }

  /** 两层是否完全重合（卷一的压力卡都是正压注入）。 */
  isBarotropic(): boolean {
    const { q1, q2 } = this;
    let maxDiff = 0;
    let maxAbs = 0;
    for (let k = 0; k < q1.length; k += 1) {
      const diff = Math.abs(q1[k] - q2[k]);
      if (diff > maxDiff) maxDiff = diff;
      const abs = Math.abs(q1[k]);
      if (abs > maxAbs) maxAbs = abs;
    }
    return maxDiff <= Math.max(1e-12, maxAbs * 1e-10);
  }

  /** 由 q 反演两层 ψ（正压模 + 斜压模）。 */
  invert(): void {
    const { grid, q1, q2, beta, kd2, tempMode, baroMode, rhs, psi1, psi2 } = this;
    const y0 = (grid.domainKm * 1000) / 2;
    for (let j = 0; j < grid.n; j += 1) {
      const y = (j + 0.5) * grid.dxM - y0;
      const row = j * grid.n;
      for (let i = 0; i < grid.n; i += 1) {
        const k = row + i;
        rhs[k] = q1[k] + q2[k] - 2 * beta * y;
      }
    }
    solveHelmholtz(rhs, grid.n, grid.dxM, 0, 1e-3, tempMode, 'dirichlet', true);
    if (this.isBarotropic()) {
      for (let k = 0; k < psi1.length; k += 1) {
        psi1[k] = 0.5 * tempMode[k];
        psi2[k] = 0.5 * tempMode[k];
      }
      return;
    }
    for (let k = 0; k < rhs.length; k += 1) rhs[k] = q1[k] - q2[k];
    solveHelmholtz(rhs, grid.n, grid.dxM, 2 * kd2, 1e-3, baroMode, 'dirichlet', true);
    for (let k = 0; k < psi1.length; k += 1) {
      psi1[k] = 0.5 * (tempMode[k] + baroMode[k]);
      psi2[k] = 0.5 * (tempMode[k] - baroMode[k]);
    }
  }

  surfacePsi(out: Float64Array): void {
    for (let k = 0; k < this.psi1.length; k += 1) {
      out[k] = this.psi2[k] + 0.1 * (this.psi1[k] - this.psi2[k]);
    }
  }

  pressureInto(out: Float64Array): void {
    for (let k = 0; k < this.psi1.length; k += 1) {
      const ps = this.psi2[k] + 0.1 * (this.psi1[k] - this.psi2[k]);
      out[k] = ps / PSI_PER_HPA;
    }
  }

  windInto(u: Float64Array, v: Float64Array): void {
    // 10 m 风取地面流函数。
    const surf = this.rhs;
    this.surfacePsi(surf);
    windFromPsi(surf, this.grid, u, v);
  }
}

/** 两层 QG 单步：位涡平流 + 两层反演。 */
export function advectTwoLayerPV(
  core: TwoLayerQG,
  dtSeconds: number,
  advU: Float64Array,
  advV: Float64Array,
): void {
  const { grid, q1, q2, q1Tmp, q2Tmp } = core;
  // 正压捷径：卷一的压力卡让两层完全重合，只平流一份 q。
  if (core.isBarotropic()) {
    advectCubic(q1, advU, advV, dtSeconds, grid, q1Tmp);
    q1.set(q1Tmp);
    q2.set(q1Tmp);
  } else {
    advectCubic(q1, advU, advV, dtSeconds, grid, q1Tmp);
    advectCubic(q2, advU, advV, dtSeconds, grid, q2Tmp);
    q1.set(q1Tmp);
    q2.set(q2Tmp);
  }

  laplacianOf(q1, grid.n, grid.dxM, q1Tmp);
  laplacianOf(q2, grid.n, grid.dxM, q2Tmp);
  const nuDt = QG_DIFFUSIVITY * dtSeconds;
  for (let k = 0; k < q1.length; k += 1) {
    q1[k] += nuDt * q1Tmp[k];
    q2[k] += nuDt * q2Tmp[k];
  }
}

export function invertTwoLayer(
  core: TwoLayerQG,
  elapsedSeconds: number,
  dampingTauH: number,
): void {
  const { grid, psi1, psi2, psi1Tmp, psi2Tmp } = core;
  core.invert();
  psi1Tmp.set(psi1);
  psi2Tmp.set(psi2);
  const damp =
    dampingTauH > 0 ? Math.exp((-elapsedSeconds / 3600) / dampingTauH) : 1;
  const n = grid.n;
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const k = j * n + i;
      const d = Math.min(i, j, n - 1 - i, n - 1 - j);
      const sponge = d < 8 ? 1 - 0.12 * (1 - d / 8) ** 2 : 1;
      const factor = damp * sponge;
      psi1[k] = psi1Tmp[k] * factor;
      psi2[k] = psi2Tmp[k] * factor;
    }
  }
  core.diagnosePV();
}

