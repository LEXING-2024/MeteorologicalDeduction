/**
 * Thermodynamic field operations for the bottom-layer engine.
 *
 * These routines are deliberately independent of the solver: they take the
 * cell-centred wind from the shallow-water model and evolve / diagnose the
 * temperature, moisture and front fields.  Everything works on preallocated
 * `Float64Array`s; no routine allocates in its inner loop.
 */

import { PHYSICS } from './constants';
import { FRONT_SEMANTICS } from '../../../src/config/constants';
import type { FrontType } from '../../../src/logic/types';

/**
 * Codes emitted by the SWE temperature-field classifier. `classifyFronts()`
 * physically derives only 0..3 from the temperature gradient and advection;
 * code 4 is a *process* gate (frontAge), never a classifier output.
 */
export type FrontTypeCode = 0 | 1 | 2 | 3;
/** Full grid code space, including the process-gated occlusion at 4. */
export type FrontGridCode = FrontTypeCode | 4;

export const FRONT_NONE: FrontTypeCode = 0;
export const FRONT_COLD: FrontTypeCode = 1;
export const FRONT_WARM: FrontTypeCode = 2;
export const FRONT_STATIONARY: FrontTypeCode = 3;
/** Occlusion is produced by the shared frontAge gate in field.ts, not here. */
export const FRONT_OCCLUDED: FrontGridCode = 4;

/**
 * Grid code -> the shared FrontType union.  The wide overload returns the
 * COMPLETE FrontType union including 'occluded', so the interface no longer
 * silently downgrades an occlusion to 'none'.  The narrow overload exists so
 * WeatherField.FieldSample.front.type stays type-safe for the 0..3 codes that
 * `classifyFronts` can actually emit; no file outside the write whitelist has
 * to be touched to add code 4.
 */
export function frontTypeName(code: FrontTypeCode): Exclude<FrontType, 'occluded'>;
export function frontTypeName(code: FrontGridCode): FrontType;
export function frontTypeName(code: FrontGridCode): FrontType {
  if (code === FRONT_COLD) return 'cold';
  if (code === FRONT_WARM) return 'warm';
  if (code === FRONT_STATIONARY) return 'stationary';
  if (code === FRONT_OCCLUDED) return 'occluded';
  return 'none';
}

/** FrontType -> grid code, from the single shared semantics table. */
export function frontTypeCode(type: FrontType): FrontGridCode {
  return FRONT_SEMANTICS[type].code;
}

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge1 <= edge0) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Bilinear sample at a physical point (metres).  Cell centres are at
 * (i + 0.5) * dx, so the fractional index is x / dx - 0.5.
 */
export function sampleField(
  field: Float64Array,
  n: number,
  dx: number,
  x: number,
  y: number,
): number {
  const gx = clamp(x / dx - 0.5, 0, n - 1);
  const gy = clamp(y / dx - 0.5, 0, n - 1);
  const i0 = Math.floor(gx);
  const j0 = Math.floor(gy);
  const i1 = Math.min(n - 1, i0 + 1);
  const j1 = Math.min(n - 1, j0 + 1);
  const tx = gx - i0;
  const ty = gy - j0;
  const a = field[j0 * n + i0];
  const b = field[j0 * n + i1];
  const c = field[j1 * n + i0];
  const d = field[j1 * n + i1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/**
 * First-order semi-Lagrangian advection of a passive scalar on the cell grid.
 *
 * The departure point x_d = x - V dt is sampled with bilinear interpolation.
 * The scheme is unconditionally stable for advective CFL numbers, which lets
 * the caller use the full 10 s weather step instead of the gravity-wave
 * substep.  The domain is closed, so a departure point outside the chart is
 * clamped to the nearest cell (zero-gradient boundary).
 *
 * `field` and `out` must be distinct arrays; they are swapped by the caller.
 */
export function advectScalarSL(
  field: Float64Array,
  out: Float64Array,
  u: Float64Array,
  v: Float64Array,
  n: number,
  dx: number,
  dt: number,
): void {
  const maxIndex = n - 1;
  for (let j = 0; j < n; j += 1) {
    const y = (j + 0.5) * dx;
    const row = j * n;
    for (let i = 0; i < n; i += 1) {
      const index = row + i;
      const x = (i + 0.5) * dx;
      const departureX = x - u[index] * dt;
      const departureY = y - v[index] * dt;
      let gx = departureX / dx - 0.5;
      let gy = departureY / dx - 0.5;
      if (gx < 0) gx = 0;
      else if (gx > maxIndex) gx = maxIndex;
      if (gy < 0) gy = 0;
      else if (gy > maxIndex) gy = maxIndex;
      const i0 = gx | 0;
      const j0 = gy | 0;
      const i1 = i0 < maxIndex ? i0 + 1 : maxIndex;
      const j1 = j0 < maxIndex ? j0 + 1 : maxIndex;
      const tx = gx - i0;
      const ty = gy - j0;
      const a = field[j0 * n + i0];
      const b = field[j0 * n + i1];
      const c = field[j1 * n + i0];
      const d = field[j1 * n + i1];
      out[index] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
}

/** Central-difference gradient, one-sided on the boundary.  Units per metre. */
export function computeGradient(
  field: Float64Array,
  n: number,
  dx: number,
  outX: Float64Array,
  outY: Float64Array,
): void {
  const inv2Dx = 1 / (2 * dx);
  const invDx = 1 / dx;
  for (let j = 0; j < n; j += 1) {
    const row = j * n;
    const rowSouth = j > 0 ? row - n : row;
    const rowNorth = j < n - 1 ? row + n : row;
    const oneSidedY = j === 0 ? invDx : j === n - 1 ? invDx : inv2Dx;
    for (let i = 0; i < n; i += 1) {
      const index = row + i;
      if (i === 0) outX[index] = (field[index + 1] - field[index]) * invDx;
      else if (i === n - 1) outX[index] = (field[index] - field[index - 1]) * invDx;
      else outX[index] = (field[index + 1] - field[index - 1]) * inv2Dx;
      if (j === 0) outY[index] = (field[rowNorth + i] - field[index]) * oneSidedY;
      else if (j === n - 1) outY[index] = (field[index] - field[rowSouth + i]) * oneSidedY;
      else outY[index] = (field[rowNorth + i] - field[rowSouth + i]) * inv2Dx;
    }
  }
}

/** Central-difference relative vorticity, one-sided on the boundary. */
export function computeVorticity(
  u: Float64Array,
  v: Float64Array,
  n: number,
  dx: number,
  out: Float64Array,
): void {
  const inv2Dx = 1 / (2 * dx);
  const invDx = 1 / dx;
  for (let j = 0; j < n; j += 1) {
    const row = j * n;
    const rowSouth = j > 0 ? row - n : row;
    const rowNorth = j < n - 1 ? row + n : row;
    for (let i = 0; i < n; i += 1) {
      const index = row + i;
      let dvdx: number;
      if (i === 0) dvdx = (v[index + 1] - v[index]) * invDx;
      else if (i === n - 1) dvdx = (v[index] - v[index - 1]) * invDx;
      else dvdx = (v[index + 1] - v[index - 1]) * inv2Dx;
      let dudy: number;
      if (j === 0) dudy = (u[rowNorth + i] - u[index]) * invDx;
      else if (j === n - 1) dudy = (u[index] - u[rowSouth + i]) * invDx;
      else dudy = (u[rowNorth + i] - u[rowSouth + i]) * inv2Dx;
      out[index] = dvdx - dudy;
    }
  }
}

export interface FrontThresholds {
  /** |grad T| at which a frontal zone starts, K / 100 km. */
  threshold: number;
  /** |grad T| of a fully developed front, K / 100 km. */
  strong: number;
  /** Below this |thermal advection| the front is classified stationary, K/h. */
  stationaryAdvection: number;
}

export const DEFAULT_FRONT_THRESHOLDS: FrontThresholds = {
  threshold: PHYSICS.frontGradientThreshold,
  strong: PHYSICS.frontGradientStrong,
  stationaryAdvection: 0.05,
};

/**
 * Physical front extraction from the temperature field.
 *
 * A front is a zone where the wind has compressed the temperature gradient
 * above `threshold`.  The cold/warm classification uses the sign of the
 * thermal advection:
 *
 *   theta = V . grad(T)
 *   tendency = -theta
 *
 *   theta > 0  ->  cold advection (air arriving is colder)  ->  cold front
 *   theta < 0  ->  warm advection                            ->  warm front
 *
 * This is the same sign convention a synoptic chart uses: on the cold side of
 * a warm front the wind blows towards the warm air, i.e. V . grad(T) < 0.
 */
export function classifyFronts(
  _temperature: Float64Array,
  u: Float64Array,
  v: Float64Array,
  n: number,
  _dx: number,
  gradientX: Float64Array,
  gradientY: Float64Array,
  outStrength: Float64Array,
  outType: Uint8Array,
  outAdvectionKh: Float64Array,
  thresholds: FrontThresholds = DEFAULT_FRONT_THRESHOLDS,
): void {
  const scaleTo100Km = 1e5;
  const toPerHour = 3600;
  for (let j = 0; j < n; j += 1) {
    const row = j * n;
    for (let i = 0; i < n; i += 1) {
      const index = row + i;
      const gx = gradientX[index];
      const gy = gradientY[index];
      const gradientK100 = Math.hypot(gx, gy) * scaleTo100Km;
      const theta = u[index] * gx + v[index] * gy;
      const advectionKh = -theta * toPerHour;
      outAdvectionKh[index] = advectionKh;
      if (gradientK100 < thresholds.threshold) {
        outStrength[index] = 0;
        outType[index] = FRONT_NONE;
        continue;
      }
      const strength = smoothstep(thresholds.threshold, thresholds.strong, gradientK100);
      outStrength[index] = strength;
      if (Math.abs(advectionKh) < thresholds.stationaryAdvection) {
        outType[index] = FRONT_STATIONARY;
      } else if (theta > 0) {
        outType[index] = FRONT_COLD;
      } else {
        outType[index] = FRONT_WARM;
      }
    }
  }
}

/**
 * Orographic ascent W_terrain = V . grad(z), m/s.  Positive on a windward
 * slope, negative in the lee.  Terrain is in metres, so the gradient is
 * dimensionless and the result is metres per second.
 */
export function computeTerrainLift(
  u: Float64Array,
  v: Float64Array,
  terrain: Float64Array,
  n: number,
  dx: number,
  gradientScratchX: Float64Array,
  gradientScratchY: Float64Array,
  out: Float64Array,
): void {
  computeGradient(terrain, n, dx, gradientScratchX, gradientScratchY);
  for (let k = 0; k < n * n; k += 1) {
    out[k] = u[k] * gradientScratchX[k] + v[k] * gradientScratchY[k];
  }
}

/**
 * Physical ascent implied by horizontal convergence in a layer of depth H:
 * W = -H * div(V).  The solver's continuity already uses the face depths, but
 * this cell-centred diagnostic is what the HUD and the precipitation model
 * consume.
 */
export function computeConvergenceLift(
  divergence: Float64Array,
  meanDepth: number,
  height: Float64Array,
  terrain: Float64Array,
  n: number,
  out: Float64Array,
): void {
  const cells = n * n;
  for (let k = 0; k < cells; k += 1) {
    const depth = Math.max(PHYSICS.minDepth, meanDepth + height[k] - terrain[k]);
    out[k] = -divergence[k] * depth;
  }
}

/** Mixed-game vertical velocity from a physical ascent rate, clamped to the HUD range. */
export function ascentToGameW(ascentMetresPerSecond: number): number {
  return clamp(ascentMetresPerSecond * PHYSICS.gameWPerMetrePerSecond, -PHYSICS.gameWMax, PHYSICS.gameWMax);
}
