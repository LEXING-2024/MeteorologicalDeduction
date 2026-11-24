/**
 * V2 · 位涡核心（正压 QG）。
 * 设计锚点：docs/V2/01 §5.2–5.4。
 *
 * 这一层是文档「风场→位涡→反演→风场」闭环的最小实现：
 *   q = ∇²ψ + βy
 *   ∂q/∂t = -J(ψ, q) + D
 *   ∇²ψ = q - βy
 * 两层（ψ₁/ψ₂ + 厚度耦合）在 qgTwoLayer.ts 里扩展，本文件先保证
 * 卷一能在「位涡平流 + 泊松反演」的底层上跑通。
 */

import type { Grid } from '../core/grid';
import { advect } from './advection';
import { laplacianOf, solveHelmholtz } from './poisson';

export const OMEGA = 7.2921e-5;
export const EARTH_RADIUS_M = 6.371e6;
/** 可玩性标定的流函数-气压换算：ψ = PSI_PER_HPA · p'（hPa）。 */
export const PSI_PER_HPA = 8.5e4;
/** 位涡扩散（m²/s）：只压 10 km 级噪声，保留天气尺度。 */
export const QG_DIFFUSIVITY = 0;

export function betaAt(latitudeDeg: number): number {
  return (2 * OMEGA * Math.cos((latitudeDeg * Math.PI) / 180)) / EARTH_RADIUS_M;
}

/** q = ∇²ψ + β(y - y₀)。 */
export function pvFromPsi(
  psi: Float64Array,
  grid: Grid,
  beta: number,
  out: Float64Array,
): Float64Array {
  laplacianOf(psi, grid.n, grid.dxM, out);
  const y0 = (grid.domainKm * 1000) / 2;
  for (let j = 0; j < grid.n; j += 1) {
    const y = (j + 0.5) * grid.dxM - y0;
    const row = j * grid.n;
    for (let i = 0; i < grid.n; i += 1) {
      out[row + i] += beta * y;
    }
  }
  return out;
}

/** 由 q 反演 ψ：∇²ψ = q - βy，Dirichlet 边界。 */
export function invertPV(
  q: Float64Array,
  grid: Grid,
  beta: number,
  out?: Float64Array,
): Float64Array {
  const n = grid.n;
  const rhs = out && out.length === n * n ? out : new Float64Array(n * n);
  const y0 = (grid.domainKm * 1000) / 2;
  for (let j = 0; j < n; j += 1) {
    const y = (j + 0.5) * grid.dxM - y0;
    const row = j * n;
    for (let i = 0; i < n; i += 1) {
      rhs[row + i] = q[row + i] - beta * y;
    }
  }
  return solveHelmholtz(rhs, n, grid.dxM, 0, 1e-3, out);
}

/** 非辐散风：u = -∂ψ/∂y，v = +∂ψ/∂x。 */
export function windFromPsi(
  psi: Float64Array,
  grid: Grid,
  u: Float64Array,
  v: Float64Array,
): void {
  const n = grid.n;
  const dx = grid.dxM;
  for (let j = 0; j < n; j += 1) {
    const jm = j > 0 ? j - 1 : j;
    const jp = j < n - 1 ? j + 1 : j;
    for (let i = 0; i < n; i += 1) {
      const im = i > 0 ? i - 1 : i;
      const ip = i < n - 1 ? i + 1 : i;
      const k = j * n + i;
      u[k] = -(psi[jp * n + i] - psi[jm * n + i]) / ((jp - jm) * dx);
      v[k] = (psi[j * n + ip] - psi[j * n + im]) / ((ip - im) * dx);
    }
  }
}

export interface QGStepOptions {
  /** 平流风（总风：地转 + 背景 + 外部强迫），不含摩擦偏转。 */
  advU: Float64Array;
  advV: Float64Array;
  /** 摩擦/填塞时间尺度（小时）；<=0 表示不阻尼。 */
  dampingTauH: number;
}

/**
 * 正压 QG 单步：诊断 q → 半拉格朗日平流 → 反演 ψ。
 * 写入 core.psi，并同步 core.q。
 */
export function stepBarotropicQG(
  core: BarotropicQG,
  dtSeconds: number,
  options: QGStepOptions,
): void {
  advectPV(core, dtSeconds, options.advU, options.advV);
  invertPVField(core, dtSeconds, options.dampingTauH);
}

/** 只平流位涡，不做反演（用于每 N 步反演一次的节流）。 */
export function advectPV(
  core: BarotropicQG,
  dtSeconds: number,
  advU: Float64Array,
  advV: Float64Array,
): void {
  const { grid, q, qTmp } = core;
  advect(q, advU, advV, dtSeconds, grid, qTmp);
  q.set(qTmp);
  // ν∇²q：抑制半拉格朗日平流在 2Δx 尺度上的位涡噪声。
  laplacianOf(q, grid.n, grid.dxM, qTmp);
  const nuDt = QG_DIFFUSIVITY * dtSeconds;
  for (let k = 0; k < q.length; k += 1) q[k] += nuDt * qTmp[k];
}

/** 由当前 q 反演 ψ，并按时间尺度阻尼；边缘 8 格海绵层。 */
export function invertPVField(
  core: BarotropicQG,
  elapsedSeconds: number,
  dampingTauH: number,
): void {
  const { grid, psi, psiTmp, q, beta } = core;
  invertPV(q, grid, beta, psiTmp);
  const damp =
    dampingTauH > 0 ? Math.exp((-elapsedSeconds / 3600) / dampingTauH) : 1;
  const n = grid.n;
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const k = j * n + i;
      const d = Math.min(i, j, n - 1 - i, n - 1 - j);
      const sponge = d < 8 ? 1 - 0.12 * (1 - d / 8) ** 2 : 1;
      psi[k] = psiTmp[k] * damp * sponge;
    }
  }
  pvFromPsi(psi, grid, beta, q);
}

export class BarotropicQG {
  readonly grid: Grid;
  readonly beta: number;
  readonly psi: Float64Array;
  readonly q: Float64Array;
  readonly qTmp: Float64Array;
  readonly psiTmp: Float64Array;
  readonly u: Float64Array;
  readonly v: Float64Array;

  constructor(grid: Grid, latitudeDeg: number) {
    this.grid = grid;
    this.beta = betaAt(latitudeDeg);
    const size = grid.n * grid.n;
    this.psi = new Float64Array(size);
    this.q = new Float64Array(size);
    this.qTmp = new Float64Array(size);
    this.psiTmp = new Float64Array(size);
    this.u = new Float64Array(size);
    this.v = new Float64Array(size);
  }

  /** 用气压异常（hPa）覆盖流函数；固定场由调用方另行叠加。 */
  resetFromPressure(pressure: Float64Array): void {
    for (let k = 0; k < pressure.length; k += 1) {
      this.psi[k] = pressure[k] * PSI_PER_HPA;
    }
    pvFromPsi(this.psi, this.grid, this.beta, this.q);
  }

  addPressure(pressure: Float64Array): void {
    for (let k = 0; k < pressure.length; k += 1) {
      this.psi[k] += pressure[k] * PSI_PER_HPA;
    }
  }

  pressureInto(out: Float64Array): void {
    for (let k = 0; k < this.psi.length; k += 1) {
      out[k] = this.psi[k] / PSI_PER_HPA;
    }
  }

  windInto(u: Float64Array, v: Float64Array): void {
    windFromPsi(this.psi, this.grid, u, v);
  }
}

