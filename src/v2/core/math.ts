/**
 * V2: 01 §4 · 共享数学工具。
 *
 * 全部纯函数：公理 A3 要求同样输入得到同样输出，这里不存在 Math.random。
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

export function gaussian2D(dxKm: number, dyKm: number, sigmaKm: number): number {
  const s = Math.max(sigmaKm, 1e-6);
  return Math.exp(-(dxKm * dxKm + dyKm * dyKm) / (2 * s * s));
}

export function normalize(value: number, lo: number, hi: number): number {
  return clamp((value - lo) / (hi - lo), 0, 1);
}

/** 0–1 → RGB 渐变。stops = [t, r, g, b]。 */
export function ramp(
  stops: readonly (readonly [number, number, number, number])[],
  t: number,
): [number, number, number] {
  const x = clamp(t, 0, 1);
  for (let i = 1; i < stops.length; i += 1) {
    const [t1, r1, g1, b1] = stops[i - 1];
    const [t2, r2, g2, b2] = stops[i];
    if (x <= t2 || i === stops.length - 1) {
      const k = t2 === t1 ? 0 : clamp((x - t1) / (t2 - t1), 0, 1);
      return [lerp(r1, r2, k), lerp(g1, g2, k), lerp(b1, b2, k)];
    }
  }
  const last = stops[stops.length - 1];
  return [last[1], last[2], last[3]];
}

/** 米制来向（0 = 北，90 = 东）→ u,v 分量。 */
export function windFromDegToUV(deg: number, speed: number): { u: number; v: number } {
  const rad = (deg * Math.PI) / 180;
  return { u: -speed * Math.sin(rad), v: -speed * Math.cos(rad) };
}

/** u,v → 来向（0–360）。 */
export function uvToWindFromDeg(u: number, v: number): number {
  const deg = (Math.atan2(-u, -v) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** 两个方向之间的最小夹角（0–180）。 */
export function angleBetweenDeg(a: number, b: number): number {
  const d = Math.abs(((a - b + 540) % 360) - 180);
  return d;
}

/** 把向量旋转 deg 度（逆时针为正）。 */
export function rotate(u: number, v: number, deg: number): { u: number; v: number } {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { u: u * c - v * s, v: u * s + v * c };
}

/**
 * 平滑值噪声：格点哈希 + 双三次插值。
 *
 * 直接用 fract(sin(...)) 会在相邻格点之间跳变，做晕渲时会织出「灯芯绒」
 * 纹理；地形纹理必须是低频的，所以这里在整数格点上取哈希再插值。
 */
function latticeValue(ix: number, iy: number, seed: number): number {
  const s = Math.sin(ix * 127.1 + iy * 311.7 + seed * 74.7) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

export function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const v00 = latticeValue(x0, y0, seed);
  const v10 = latticeValue(x0 + 1, y0, seed);
  const v01 = latticeValue(x0, y0 + 1, seed);
  const v11 = latticeValue(x0 + 1, y0 + 1, seed);
  const top = v00 + (v10 - v00) * sx;
  const bottom = v01 + (v11 - v01) * sx;
  return top + (bottom - top) * sy;
}

/** 三倍频分形，保持确定性。 */
export function fractalNoise(x: number, y: number, seed: number): number {
  return (
    valueNoise(x, y, seed) * 0.62 +
    valueNoise(x * 2.1 + 5.3, y * 2.1 - 2.7, seed + 3) * 0.26 +
    valueNoise(x * 4.3 - 1.9, y * 4.3 + 3.1, seed + 7) * 0.12
  );
}
