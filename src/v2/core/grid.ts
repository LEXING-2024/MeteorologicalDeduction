/**
 * V2 · 网格与微分算子。
 * 设计锚点：docs/V2/01 §2、05 §2。
 * 全部使用 TypedArray，索引 k = j * n + i。
 */

export function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** 归一化高斯核，用于要素卡落点注入。 */
export function gaussian2D(dxKm: number, dyKm: number, sigmaKm: number): number {
  const s = Math.max(sigmaKm, 1e-6);
  return Math.exp(-(dxKm * dxKm + dyKm * dyKm) / (2 * s * s));
}

/** 确定性哈希噪声（0–1），用于地形起伏，保证同关每次生成一致。 */
export function hash2(i: number, j: number, seed = 0): number {
  const s = Math.sin(i * 12.9898 + j * 78.233 + seed * 3.719) * 43758.5453;
  return s - Math.floor(s);
}

export class Grid {
  readonly n: number;
  readonly domainKm: number;
  readonly dxKm: number;
  readonly dxM: number;

  constructor(domainKm: number, n: number) {
    this.n = n;
    this.domainKm = domainKm;
    this.dxKm = domainKm / n;
    this.dxM = this.dxKm * 1000;
  }

  idx(i: number, j: number): number {
    return j * this.n + i;
  }

  clampI(i: number): number {
    return i < 0 ? 0 : i >= this.n ? this.n - 1 : i;
  }

  xKm(i: number): number {
    return (i + 0.5) * this.dxKm;
  }

  yKm(j: number): number {
    return (j + 0.5) * this.dxKm;
  }

  /** 中心差分（x），边缘单侧。 */
  dfdx(field: Float32Array | Float64Array, i: number, j: number): number {
    const ip = this.clampI(i + 1);
    const im = this.clampI(i - 1);
    return (field[this.idx(ip, j)] - field[this.idx(im, j)]) / ((ip - im) * this.dxM);
  }

  /** 中心差分（y），边缘单侧。 */
  dfdy(field: Float32Array | Float64Array, i: number, j: number): number {
    const jp = this.clampI(j + 1);
    const jm = this.clampI(j - 1);
    return (field[this.idx(i, jp)] - field[this.idx(i, jm)]) / ((jp - jm) * this.dxM);
  }

  laplacian(field: Float64Array, i: number, j: number): number {
    const c = field[this.idx(i, j)];
    const l = field[this.idx(this.clampI(i - 1), j)];
    const r = field[this.idx(this.clampI(i + 1), j)];
    const d = field[this.idx(i, this.clampI(j - 1))];
    const u = field[this.idx(i, this.clampI(j + 1))];
    return (l + r + d + u - 4 * c) / (this.dxM * this.dxM);
  }

  divergence(u: Float64Array, v: Float64Array, i: number, j: number): number {
    return this.dfdx(u, i, j) + this.dfdy(v, i, j);
  }

  /** 双线性采样，位置单位 km。 */
  sample(field: Float32Array | Float64Array, xKm: number, yKm: number): number {
    const fx = clamp(xKm / this.dxKm - 0.5, 0, this.n - 1);
    const fy = clamp(yKm / this.dxKm - 0.5, 0, this.n - 1);
    const i0 = Math.floor(fx);
    const j0 = Math.floor(fy);
    const i1 = Math.min(i0 + 1, this.n - 1);
    const j1 = Math.min(j0 + 1, this.n - 1);
    const tx = fx - i0;
    const ty = fy - j0;
    const a = field[this.idx(i0, j0)];
    const b = field[this.idx(i1, j0)];
    const c = field[this.idx(i0, j1)];
    const d = field[this.idx(i1, j1)];
    return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
  }

  /** 双线性采样，格点坐标（用于风场等）。 */
  sampleCell(field: Float32Array | Float64Array, x: number, y: number): number {
    const n = this.n;
    const cx = x < 0 ? 0 : x > n - 1 ? n - 1 : x;
    const cy = y < 0 ? 0 : y > n - 1 ? n - 1 : y;
    const i0 = Math.floor(cx);
    const j0 = Math.floor(cy);
    const i1 = Math.min(i0 + 1, n - 1);
    const j1 = Math.min(j0 + 1, n - 1);
    const tx = cx - i0;
    const ty = cy - j0;
    const a = field[this.idx(i0, j0)];
    const b = field[this.idx(i1, j0)];
    const c = field[this.idx(i0, j1)];
    const d = field[this.idx(i1, j1)];
    return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
  }
}
