/**
 * V2 · 泊松 / Helmholtz 求解器（Dirichlet 边界）。
 * 设计锚点：docs/V2/01 §5.4、05 M1「fft.ts：DST 泊松 + Helmholtz」。
 *
 * 这里先用几何多重网格实现同一离散算子：
 *   (uE + uW + uN + uS - 4u) / dx² - λ·u = f,  边界 u = 0
 * 128² 单次求解约 1–2 ms；后续若换成文档里的 DST 版本，
 * 保持 solveHelmholtz 接口不变即可。
 */

interface Level {
  n: number;
  dx: number;
  lambda: number;
  u: Float64Array;
  f: Float64Array;
  r: Float64Array;
}

export type SolverBoundary = 'dirichlet' | 'neumann';

const SMOOTH_SWEEPS = 3;
const MAX_CYCLES = 40;

function alloc(n: number): Float64Array {
  return new Float64Array(n * n);
}

function residualMax(level: Level, neumann: boolean): number {
  const { n, dx, lambda, u, f } = level;
  const a = 1 / (dx * dx);
  let max = 0;
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const k = j * n + i;
      const left = i > 0 ? u[k - 1] : neumann ? u[k] : 0;
      const right = i < n - 1 ? u[k + 1] : neumann ? u[k] : 0;
      const up = j > 0 ? u[k - n] : neumann ? u[k] : 0;
      const down = j < n - 1 ? u[k + n] : neumann ? u[k] : 0;
      const res = f[k] - (a * (left + right + up + down - 4 * u[k]) - lambda * u[k]);
      const abs = Math.abs(res);
      if (abs > max) max = abs;
    }
  }
  return max;
}

function smooth(level: Level, sweeps: number, neumann: boolean): void {
  const { n, dx, lambda, u, f } = level;
  const a = 1 / (dx * dx);
  const diag = 4 * a + lambda;
  for (let s = 0; s < sweeps; s += 1) {
    for (let color = 0; color < 2; color += 1) {
      for (let j = 0; j < n; j += 1) {
        for (let i = (j + color) % 2; i < n; i += 2) {
          const k = j * n + i;
          const left = i > 0 ? u[k - 1] : neumann ? u[k] : 0;
          const right = i < n - 1 ? u[k + 1] : neumann ? u[k] : 0;
          const up = j > 0 ? u[k - n] : neumann ? u[k] : 0;
          const down = j < n - 1 ? u[k + n] : neumann ? u[k] : 0;
          u[k] = (a * (left + right + up + down) - f[k]) / diag;
        }
      }
    }
  }
}

function removeMean(a: Float64Array): void {
  let sum = 0;
  for (let k = 0; k < a.length; k += 1) sum += a[k];
  const mean = sum / a.length;
  for (let k = 0; k < a.length; k += 1) a[k] -= mean;
}

function restrict(fine: Level, coarse: Level, neumann: boolean): void {
  const { n } = coarse;
  const fn = fine.n;
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const fi = 2 * i;
      const fj = 2 * j;
      const k = fj * fn + fi;
      coarse.f[j * n + i] =
        0.25 * (fine.r[k] + fine.r[k + 1] + fine.r[k + fn] + fine.r[k + fn + 1]);
    }
  }
  if (neumann && coarse.lambda === 0) removeMean(coarse.f);
}

function prolongAdd(coarse: Level, fine: Level): void {
  const n = fine.n;
  const cn = coarse.n;
  const last = cn - 1;
  for (let j = 0; j < n; j += 1) {
    const cy = Math.max(0, Math.min(last, j / 2 - 0.25));
    const j0 = Math.floor(cy);
    const j1 = Math.min(last, j0 + 1);
    const ty = cy - j0;
    for (let i = 0; i < n; i += 1) {
      const cx = Math.max(0, Math.min(last, i / 2 - 0.25));
      const i0 = Math.floor(cx);
      const i1 = Math.min(last, i0 + 1);
      const tx = cx - i0;
      const a = coarse.u[j0 * cn + i0];
      const b = coarse.u[j0 * cn + i1];
      const c = coarse.u[j1 * cn + i0];
      const d = coarse.u[j1 * cn + i1];
      fine.u[j * n + i] +=
        a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
    }
  }
}

function computeResidual(level: Level, neumann: boolean): void {
  const { n, dx, lambda, u, f, r } = level;
  const a = 1 / (dx * dx);
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const k = j * n + i;
      const left = i > 0 ? u[k - 1] : neumann ? u[k] : 0;
      const right = i < n - 1 ? u[k + 1] : neumann ? u[k] : 0;
      const up = j > 0 ? u[k - n] : neumann ? u[k] : 0;
      const down = j < n - 1 ? u[k + n] : neumann ? u[k] : 0;
      r[k] = f[k] - (a * (left + right + up + down - 4 * u[k]) - lambda * u[k]);
    }
  }
}

function buildLevels(n: number, dx: number, lambda: number): Level[] {
  const levels: Level[] = [];
  let cn = n;
  let cdx = dx;
  while (cn >= 2) {
    levels.push({ n: cn, dx: cdx, lambda, u: alloc(cn), f: alloc(cn), r: alloc(cn) });
    if (cn <= 4) break;
    cn = Math.max(4, Math.floor(cn / 2));
    cdx *= 2;
  }
  return levels;
}

function vCycle(levels: Level[], index: number, neumann: boolean): void {
  const level = levels[index];
  if (level.n <= 4) {
    // 最粗网格只有 16 个未知量，直接多迭代到收敛，避免最平滑模态残留。
    smooth(level, 200, neumann);
    if (neumann && level.lambda === 0) removeMean(level.u);
    return;
  }
  smooth(level, SMOOTH_SWEEPS, neumann);
  computeResidual(level, neumann);
  const coarse = levels[index + 1];
  restrict(level, coarse, neumann);
  coarse.u.fill(0);
  vCycle(levels, index + 1, neumann);
  prolongAdd(coarse, level);
  smooth(level, SMOOTH_SWEEPS, neumann);
  if (neumann && level.lambda === 0) removeMean(level.u);
}

const CACHE = new Map<string, Level[]>();

let lastCycles = 0;
let lastResidual = 0;

export function lastSolveInfo(): { cycles: number; residual: number } {
  return { cycles: lastCycles, residual: lastResidual };
}

function levelsFor(n: number, dx: number, lambda: number): Level[] {
  const key = `${n}:${dx}:${lambda}`;
  let levels = CACHE.get(key);
  if (!levels) {
    levels = buildLevels(n, dx, lambda);
    CACHE.set(key, levels);
  }
  return levels;
}

/**
 * Neumann 谱求解：DCT-II 余弦基，等价于 5 点 Laplacian + 法向零梯度。
 * 仅支持 2n 为 2 的幂的网格（128/256）；其它尺寸回退多重网格。
 */
function fftInPlace(re: Float64Array, im: Float64Array, invert: boolean): void {
  const n = re.length;
  let j = 0;
  for (let i = 1; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((invert ? 2 : -2) * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe;
        im[i + k + len / 2] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
  if (invert) {
    for (let i = 0; i < n; i += 1) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/** 1D DCT-II（未归一化）：F_k = 2 Σ x_i cos(π k (i+1/2)/n)。 */
function dct2Line(x: Float64Array, n: number, out: Float64Array): void {
  const m = 2 * n;
  const re = new Float64Array(m);
  const im = new Float64Array(m);
  for (let i = 0; i < n; i += 1) {
    re[i] = x[i];
    re[m - 1 - i] = x[i];
  }
  fftInPlace(re, im, false);
  for (let k = 0; k < n; k += 1) {
    const ang = (-Math.PI * k) / m;
    out[k] = re[k] * Math.cos(ang) - im[k] * Math.sin(ang);
  }
}

function idct2Line(spec: Float64Array, n: number, out: Float64Array): void {
  const tmp = new Float64Array(n);
  dct2Line(spec, n, tmp);
  const dc = spec[0];
  for (let i = 0; i < n; i += 1) out[i] = (tmp[i] - dc) / (2 * n);
}

function dct2Forward(src: Float64Array, n: number, dst: Float64Array): void {
  const line = new Float64Array(n);
  const spec = new Float64Array(n);
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) line[i] = src[j * n + i];
    dct2Line(line, n, spec);
    for (let i = 0; i < n; i += 1) dst[j * n + i] = spec[i];
  }
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) line[j] = dst[j * n + i];
    dct2Line(line, n, spec);
    for (let j = 0; j < n; j += 1) dst[j * n + i] = spec[j];
  }
}

function dct2Inverse(spec: Float64Array, n: number, dst: Float64Array): void {
  const line = new Float64Array(n);
  const outLine = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) line[j] = spec[j * n + i];
    idct2Line(line, n, outLine);
    for (let j = 0; j < n; j += 1) dst[j * n + i] = outLine[j];
  }
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) line[i] = dst[j * n + i];
    idct2Line(line, n, outLine);
    for (let i = 0; i < n; i += 1) dst[j * n + i] = outLine[i];
  }
}

function isPow2(v: number): boolean {
  return v > 0 && (v & (v - 1)) === 0;
}

function solveNeumannDCT(
  f: Float64Array,
  n: number,
  dx: number,
  lambda: number,
  out: Float64Array,
): Float64Array {
  const spec = new Float64Array(n * n);
  spec.set(f);
  dct2Forward(spec, n, spec);
  const a = 4 / (dx * dx);
  for (let ky = 0; ky < n; ky += 1) {
    const sy = Math.sin((Math.PI * ky) / (2 * n));
    for (let kx = 0; kx < n; kx += 1) {
      const sx = Math.sin((Math.PI * kx) / (2 * n));
      const mu = -a * (sx * sx + sy * sy);
      const denom = mu - lambda;
      const k = ky * n + kx;
      if (Math.abs(denom) < 1e-14) {
        // 纯 Neumann 的常数零空间：显式固定在零均值。
        spec[k] = 0;
      } else {
        spec[k] /= denom;
      }
    }
  }
  dct2Inverse(spec, n, spec);
  out.set(spec);
  return out;
}

/**
 * 解 (∇² - λ)u = f。
 * @param boundary dirichlet: 边界 u=0；neumann: 法向零梯度（开放边界）
 * @param warmStart true 时把 out 的旧值作为初值；QG 连续反演可少跑多轮 V-cycle
 */
export function solveHelmholtz(
  f: Float64Array,
  n: number,
  dx: number,
  lambda: number,
  relTol = 1e-6,
  out?: Float64Array,
  boundary: SolverBoundary = 'dirichlet',
  warmStart = false,
): Float64Array {
  const neumann = boundary === 'neumann';
  const dst = out ?? new Float64Array(n * n);
  if (neumann && isPow2(2 * n)) {
    solveNeumannDCT(f, n, dx, lambda, dst);
    lastCycles = 0;
    lastResidual = 0;
    return dst;
  }
  const levels = levelsFor(n, dx, lambda);
  const root = levels[0];
  root.f.set(f);
  if (warmStart && out) root.u.set(out);
  else root.u.fill(0);

  let fmax = 0;
  let fsum = 0;
  for (let k = 0; k < f.length; k += 1) {
    const abs = Math.abs(f[k]);
    if (abs > fmax) fmax = abs;
    fsum += f[k];
  }
  // 纯 Neumann 泊松有常数零空间：先把右端均值去掉。
  if (neumann && lambda === 0) {
    const mean = fsum / f.length;
    for (let k = 0; k < root.f.length; k += 1) root.f[k] -= mean;
  }

  const tol = Math.max(1e-14, fmax * relTol);
  for (let cycle = 0; cycle < MAX_CYCLES; cycle += 1) {
    vCycle(levels, 0, neumann);
    if (neumann && lambda === 0) removeMean(root.u);
    lastCycles = cycle + 1;
    lastResidual = residualMax(root, neumann);
    if (lastResidual <= tol) break;
  }

  dst.set(root.u);
  if (neumann && lambda === 0) {
    let mean = 0;
    for (let k = 0; k < dst.length; k += 1) mean += dst[k];
    mean /= dst.length;
    for (let k = 0; k < dst.length; k += 1) dst[k] -= mean;
  }
  return dst;
}

/**
 * Dirichlet DST-I 直接求解：φ_k(i)=sin(π(k+1)(i+1)/(n+1))。
 * 与多重网格使用同一 5 点 Laplacian；用于 128² 固定网格。
 */
const SIN_CACHE = new Map<number, Float64Array>();
function sineTable(n: number): Float64Array {
  let table = SIN_CACHE.get(n);
  if (table) return table;
  table = new Float64Array(n * n);
  for (let k = 0; k < n; k += 1) {
    for (let i = 0; i < n; i += 1) {
      table[k * n + i] = Math.sin((Math.PI * (k + 1) * (i + 1)) / (n + 1));
    }
  }
  SIN_CACHE.set(n, table);
  return table;
}

export function solveHelmholtzDST(
  f: Float64Array,
  n: number,
  dx: number,
  lambda: number,
  out?: Float64Array,
): Float64Array {
  const dst = out ?? new Float64Array(n * n);
  const sin = sineTable(n);
  const tmp = new Float64Array(n * n);
  const spec = new Float64Array(n * n);

  // 正向 x 变换。
  for (let j = 0; j < n; j += 1) {
    const row = j * n;
    for (let k = 0; k < n; k += 1) {
      let sum = 0;
      const sk = k * n;
      for (let i = 0; i < n; i += 1) sum += f[row + i] * sin[sk + i];
      tmp[row + k] = sum;
    }
  }
  // 正向 y 变换，结果按 [ky][kx] 存。
  for (let ky = 0; ky < n; ky += 1) {
    const sy = ky * n;
    for (let kx = 0; kx < n; kx += 1) {
      let sum = 0;
      for (let j = 0; j < n; j += 1) sum += tmp[j * n + kx] * sin[sy + j];
      spec[ky * n + kx] = sum;
    }
  }

  const a = 4 / (dx * dx);
  for (let ky = 0; ky < n; ky += 1) {
    const sy = Math.sin((Math.PI * (ky + 1)) / (2 * (n + 1)));
    for (let kx = 0; kx < n; kx += 1) {
      const sx = Math.sin((Math.PI * (kx + 1)) / (2 * (n + 1)));
      const mu = -a * (sx * sx + sy * sy);
      const denom = mu - lambda;
      spec[ky * n + kx] = Math.abs(denom) < 1e-14 ? 0 : spec[ky * n + kx] / denom;
    }
  }

  // 反向 y 变换。
  const tmp2 = new Float64Array(n * n);
  for (let j = 0; j < n; j += 1) {
    for (let kx = 0; kx < n; kx += 1) {
      let sum = 0;
      for (let ky = 0; ky < n; ky += 1) sum += spec[ky * n + kx] * sin[ky * n + j];
      tmp2[j * n + kx] = sum;
    }
  }
  // 反向 x 变换并归一化。
  const scale = (2 / (n + 1)) ** 2;
  for (let j = 0; j < n; j += 1) {
    const row = j * n;
    for (let i = 0; i < n; i += 1) {
      let sum = 0;
      for (let kx = 0; kx < n; kx += 1) sum += tmp2[row + kx] * sin[kx * n + i];
      dst[row + i] = sum * scale;
    }
  }
  return dst;
}

/** 5 点 Laplacian（与求解器内部离散算子一致）。 */
export function laplacianOf(
  field: Float64Array,
  n: number,
  dx: number,
  out: Float64Array,
  boundary: SolverBoundary = 'dirichlet',
): Float64Array {
  const a = 1 / (dx * dx);
  const neumann = boundary === 'neumann';
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const k = j * n + i;
      const left = i > 0 ? field[k - 1] : neumann ? field[k] : 0;
      const right = i < n - 1 ? field[k + 1] : neumann ? field[k] : 0;
      const up = j > 0 ? field[k - n] : neumann ? field[k] : 0;
      const down = j < n - 1 ? field[k + n] : neumann ? field[k] : 0;
      out[k] = a * (left + right + up + down - 4 * field[k]);
    }
  }
  return out;
}
