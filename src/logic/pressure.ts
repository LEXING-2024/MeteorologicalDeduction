import {
  HIGH_P_GAIN,
  INFLUENCE_WOBBLE,
  MAP_SIZE,
  PRESSURE_FALLOFF,
  RIDGE_HIGH_P_GAIN,
  SHALLOW_HIGH_P_GAIN,
  SURFACE_ANISOTROPY,
  SURFACE_FALLOFF,
  SYNOPTIC_TILT_HPA,
  THERMAL_PRESSURE_COEFF,
  TROUGH_DEEPEN,
  TROUGH_HIGH_P_DROP,
  TYPHOON_HIGH_P_GAIN,
  isLowPressureType,
} from '../config/constants';
import { typhoonProfile } from './typhoon';
import type { BaseConditions, WeatherEntity } from './types';

/**
 * Pressure systems are deliberately not perfect circles. Real synoptic centres
 * are stretched and tilted by the surrounding flow; the same deformation makes
 * the isobars asymmetric, and gives ridges/troughs their elongated shape.
 */
interface PressureProfile {
  angle: number;
  aspect: number;
  bend: number;
  phase: number;
}

const TYPE_PROFILE: Record<
  'coldHigh' | 'warmHigh' | 'coldLow' | 'warmLow' | 'typhoon',
  { aspect: number; tilt: number; phase: number }
> = {
  coldHigh: { aspect: 1.78, tilt: -0.42, phase: 0.4 },
  warmHigh: { aspect: 2.05, tilt: 0.36, phase: 1.9 },
  coldLow: { aspect: 1.64, tilt: 0.62, phase: 3.1 },
  warmLow: { aspect: 1.88, tilt: -0.24, phase: 4.4 },
  // A mature tropical cyclone is axisymmetric, unlike a baroclinic centre.
  typhoon: { aspect: 1, tilt: 0, phase: 0 },
};

const boundaryCache = new Map<string, { points: Float32Array; hash: string }>();

/*
 * Per-pass memoisation.
 *
 * `pressureAt()` is evaluated once per analysis pixel (65k times for a 256²
 * isobar field).  Everything that depends only on the *entity set* — the
 * baroclinic orientation, the deformed profile, the elliptical air-mass shape
 * and the cold/warm pair list — used to be recomputed at every pixel, which
 * made the cost O(pixels × entities²) with a string allocation thrown in.
 *
 * A "pass" is one field build.  `field.clearPerSampleCaches()` bumps the token,
 * so a pass always sees a fresh cache, while a single build reuses the derived
 * values for every pixel.
 */
let pressurePassToken = 0;
let cachedPassToken = -1;
const orientationCache = new Map<string, number | undefined>();
const profileByEntity = new Map<string, PressureProfile>();
const profileByEntityNoOrientation = new Map<string, PressureProfile>();
const airShapeCache = new Map<string, AirShape>();
let passColds: WeatherEntity[] = [];
let passWarms: WeatherEntity[] = [];
let passPairsReady = false;
let passEntitiesRef: WeatherEntity[] | null = null;

interface AirShape {
  rx: number;
  ry: number;
  cos: number;
  sin: number;
  seedA: number;
}

/** Start a new derived-value epoch. Called once per field build. */
export function bumpPressurePass(): void {
  pressurePassToken += 1;
}

function ensurePressurePass(): void {
  if (cachedPassToken === pressurePassToken) return;
  cachedPassToken = pressurePassToken;
  orientationCache.clear();
  profileByEntity.clear();
  profileByEntityNoOrientation.clear();
  airShapeCache.clear();
  passColds = [];
  passWarms = [];
  passPairsReady = false;
  passEntitiesRef = null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function frontalHash(value: string): number {
  let out = 0;
  for (let i = 0; i < value.length; i += 1) out = (out * 31 + value.charCodeAt(i)) | 0;
  return Math.abs(out) / 2147483647;
}

function isPressureType(
  entity: WeatherEntity,
): entity is WeatherEntity & { type: keyof typeof TYPE_PROFILE } {
  return (
    entity.type === 'coldHigh' ||
    entity.type === 'warmHigh' ||
    entity.type === 'coldLow' ||
    entity.type === 'warmLow' ||
    entity.type === 'typhoon'
  );
}

/** Position-dependent profile, so the same placement always looks the same. */
export function pressureProfileFor(entity: WeatherEntity, orientation?: number): PressureProfile {
  if (!isPressureType(entity)) {
    return { angle: 0, aspect: 1, bend: 0, phase: 0 };
  }
  if (entity.type === 'typhoon') {
    return { angle: 0, aspect: 1, bend: 0, phase: 0 };
  }
  ensurePressurePass();
  // Two memo slots per entity: the baroclinic orientation and the fallback one
  // are both legitimate answers, and callers use them in different places.
  const memo = orientation === undefined ? profileByEntityNoOrientation : profileByEntity;
  const cached = memo.get(entity.id);
  if (cached) return cached;

  const meta = TYPE_PROFILE[entity.type];
  const drift = Math.sin(entity.x * 0.009 + entity.y * 0.013 + meta.phase);
  const cross = Math.cos(entity.x * 0.011 - entity.y * 0.007 + meta.phase * 1.7);
  const aspect = clamp(meta.aspect + drift * 0.28, 1.45, 2.35);
  const fallbackAngle =
    meta.tilt + Math.sin(entity.x * 0.006 + entity.y * 0.01 + meta.phase) * 0.4 + cross * 0.22;
  const angle = orientation ?? fallbackAngle;
  const bend = Math.sin(entity.x * 0.008 - entity.y * 0.011 + meta.phase * 0.6) * 0.32;
  const profile = { angle, aspect, bend, phase: meta.phase };
  memo.set(entity.id, profile);
  return profile;
}

/**
 * Elongate a centre along its baroclinic partner (the nearest pressure system).
 * This is how real highs and lows line up with the flow: it creates a ridge or
 * trough axis without twisting the pressure gradient that drives the wind.
 */
export function pressureOrientationFor(
  entity: WeatherEntity,
  entities: WeatherEntity[],
): number | undefined {
  if (!isPressureType(entity)) return undefined;
  // Tropical cyclones are axisymmetric; they do not align with a baroclinic partner.
  if (entity.type === 'typhoon') return undefined;
  ensurePressurePass();
  if (orientationCache.has(entity.id)) return orientationCache.get(entity.id);
  const ownLow = entity.type === 'coldLow' || entity.type === 'warmLow';
  let best: WeatherEntity | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const other of entities) {
    if (other.id === entity.id || !isPressureType(other)) continue;
    const dx = other.x - entity.x;
    const dy = other.y - entity.y;
    const distance = Math.hypot(dx, dy);
    if (distance > entity.radius * 4.2) continue;
    const otherLow = other.type === 'coldLow' || other.type === 'warmLow';
    if (ownLow === otherLow) continue;
    if (distance < bestDistance) {
      best = other;
      bestDistance = distance;
    }
  }
  const orientation = best ? Math.atan2(best.y - entity.y, best.x - entity.x) : undefined;
  orientationCache.set(entity.id, orientation);
  return orientation;
}

function polygonHash(points: Array<{ x: number; y: number }>): string {
  let hash = 0;
  for (const point of points) {
    hash = (hash * 31 + Math.round(point.x * 4)) | 0;
    hash = (hash * 31 + Math.round(point.y * 4)) | 0;
  }
  return String(hash >>> 0);
}

/**
 * Radial boundary of the edited shape, sampled by angle. Scaling this radius
 * keeps the isobars parallel to the drawn outline instead of replacing it with
 * a plain ellipse (the old pressure profile did exactly that).
 */
function boundaryFor(
  entity: WeatherEntity,
  points: Array<{ x: number; y: number }>,
): Float32Array {
  const hash = polygonHash(points);
  const key = `${entity.id}:${points.length}:${hash}`;
  const cached = boundaryCache.get(key);
  if (cached && cached.hash === hash) return cached.points;

  const samples = 96;
  const boundary = new Float32Array(samples);
  for (let index = 0; index < samples; index += 1) {
    const angle = (index / samples) * Math.PI * 2;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let best = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
      const ax = points[j].x;
      const ay = points[j].y;
      const bx = points[i].x;
      const by = points[i].y;
      const ex = bx - ax;
      const ey = by - ay;
      const denominator = dx * ey - dy * ex;
      if (Math.abs(denominator) < 0.0001) continue;
      const t = (ax * ey - ay * ex) / denominator;
      const s = (ax * dy - ay * dx) / denominator;
      if (t > 0 && s >= 0 && s <= 1) best = Math.max(best, t);
    }
    boundary[index] = best > 0 ? best : entity.radius;
  }
  if (boundaryCache.size > 600) boundaryCache.clear();
  boundaryCache.set(key, { points: boundary, hash });
  return boundary;
}

function boundaryRadius(boundary: Float32Array, angle: number): number {
  const samples = boundary.length;
  const wrapped = ((angle / (Math.PI * 2)) % 1 + 1) % 1;
  const position = wrapped * samples;
  const index = Math.floor(position) % samples;
  const next = (index + 1) % samples;
  const t = position - Math.floor(position);
  return boundary[index] * (1 - t) + boundary[next] * t;
}

/**
 * Normalised influence in [0, 1]. The centre always reaches 1, so the strength
 * slider keeps its meaning; only the horizontal shape changes. The Gaussian is
 * kept smooth to the tails (no compact window): a hard edge created a kink in
 * the base isobar exactly where the anomaly reached zero.
 */
export function pressureInfluence(
  entity: WeatherEntity,
  x: number,
  y: number,
  orientation?: number,
): number {
  const dx = x - entity.x;
  const dy = y - entity.y;

  // Storms keep their axisymmetric profile even if a legacy shape is present.
  if (entity.type === 'typhoon') {
    return typhoonProfile(Math.hypot(dx, dy), entity.radius, 0, 0).pressure;
  }

  if (entity.shape && entity.shape.length >= 5) {
    const boundary = boundaryFor(entity, entity.shape);
    const distance = Math.hypot(dx, dy);
    if (distance < 0.001) return 1;
    const radius = boundaryRadius(boundary, Math.atan2(dy, dx));
    if (radius < 1) return 0;
    const q = distance / radius;
    return Math.exp(-PRESSURE_FALLOFF * q * q);
  }

  const profile = pressureProfileFor(entity, orientation);
  const cos = Math.cos(profile.angle);
  const sin = Math.sin(profile.angle);
  const localX = dx * cos + dy * sin;
  const localY = -dx * sin + dy * cos;
  const rx = entity.radius * Math.sqrt(profile.aspect);
  const ry = entity.radius / Math.sqrt(profile.aspect);
  const v = localY / ry;
  // The bend shifts contours sideways, but the zero of the quadratic stays at
  // the centre, so the pressure maximum/minimum is exactly on the marker.
  const u = localX / rx - profile.bend * v * v;
  const q = u * u + v * v;
  const theta = Math.atan2(v, u);
  const warp =
    1 +
    0.12 * Math.cos(theta * 3 + profile.phase) +
    0.06 * Math.cos(theta * 2 - profile.phase * 1.3);
  const qEffective = q * Math.max(0.78, warp);
  return Math.min(1.02, Math.exp(-PRESSURE_FALLOFF * qEffective));
}

/** Surface-air influence used only for the thermal pressure term. */
export function airInfluence(entity: WeatherEntity, x: number, y: number): number {
  const dx = x - entity.x;
  const dy = y - entity.y;
  const shape = airShapeOf(entity);
  const localX = dx * shape.cos + dy * shape.sin;
  const localY = -dx * shape.sin + dy * shape.cos;
  const normalized = (localX * localX) / (shape.rx * shape.rx) + (localY * localY) / (shape.ry * shape.ry);
  const theta = Math.atan2(localY / shape.ry, localX / shape.rx);
  const wobble =
    1 +
    INFLUENCE_WOBBLE *
      (Math.sin(theta * 3 + shape.seedA * Math.PI * 2) +
        0.62 * Math.sin(theta * 5 - shape.seedA * Math.PI * 2 * 1.7));
  return Math.exp(-SURFACE_FALLOFF * normalized * Math.max(0.7, wobble));
}

/**
 * The elliptical footprint and rotation of an air mass depend only on the
 * entity, never on the sample point.  Deriving them once per pass turns the
 * per-pixel cost from "hash two strings + two trig calls" into pure arithmetic.
 */
function airShapeOf(entity: WeatherEntity): AirShape {
  ensurePressurePass();
  const cached = airShapeCache.get(entity.id);
  if (cached) return cached;
  const seed =
    entity.seed ??
    hashString(`${entity.type}:${entity.x.toFixed(1)}:${entity.y.toFixed(1)}:${entity.radius}`);
  const key = `${seed.toFixed(6)}:${entity.type}:${entity.radius}`;
  const seedA = hashString(`${key}:a`);
  const seedB = hashString(`${key}:b`);
  const isTroughOrRidge = entity.type === 'trough' || entity.type === 'ridge';
  const aspect = isTroughOrRidge ? 2.8 : 1 + (seedA * 2 - 1) * SURFACE_ANISOTROPY;
  const rotation = seedB * Math.PI * 2;
  const shape: AirShape = {
    rx: entity.radius * Math.sqrt(aspect),
    ry: entity.radius / Math.sqrt(aspect),
    cos: Math.cos(rotation),
    sin: Math.sin(rotation),
    seedA,
  };
  airShapeCache.set(entity.id, shape);
  return shape;
}

/**
 * Fronts carry a pressure trough. The game's air masses are compact blobs, so
 * the thermal pressure alone would draw concentric rings; a narrow trough
 * along the frontal axis is what bends the isobars into the familiar kink.
 */
function frontalTroughAt(entities: WeatherEntity[], x: number, y: number): number {
  let deepest = 0;
  ensurePressurePass();
  if (!passPairsReady || passEntitiesRef !== entities) {
    passPairsReady = true;
    passEntitiesRef = entities;
    passColds = entities.filter((entity) => entity.type === 'coldAir');
    passWarms = entities.filter((entity) => entity.type === 'warmAir');
  }
  const colds = passColds;
  const warms = passWarms;
  for (const cold of colds) {
    for (const warm of warms) {
      const dx = warm.x - cold.x;
      const dy = warm.y - cold.y;
      const separation = Math.hypot(dx, dy);
      const limit = (cold.radius + warm.radius) * 1.12;
      if (separation > limit) continue;
      let axisX = 1;
      let axisY = 0;
      if (separation > 1) {
        axisX = dx / separation;
        axisY = dy / separation;
      } else {
        const angle =
          frontalHash(`${cold.seed ?? cold.type}:${warm.seed ?? warm.type}`) * Math.PI * 2;
        axisX = Math.cos(angle);
        axisY = Math.sin(angle);
      }
      const normalX = -axisY;
      const normalY = axisX;
      const midX = (cold.x + warm.x) / 2;
      const midY = (cold.y + warm.y) / 2;
      const halfLength = Math.min(cold.radius, warm.radius) * 1.18;
      const along = (x - midX) * normalX + (y - midY) * normalY;
      const clamped = Math.max(-halfLength, Math.min(halfLength, along));
      const px = midX + normalX * clamped;
      const py = midY + normalY * clamped;
      const cross = Math.hypot(x - px, y - py);
      if (cross > 70) continue;
      const strength = Math.max(0.5, Math.abs(cold.strength - warm.strength) * 0.1 + 0.8);
      const depth = strength * 0.8 * Math.exp(-((cross / 34) ** 2));
      deepest = Math.max(deepest, depth);
    }
  }
  return deepest;
}

/** Gentle background tilt so the base/zero isobar has one smooth path. */
function synopticTilt(x: number, y: number): number {
  return (
    (x / MAP_SIZE - 0.5) * SYNOPTIC_TILT_HPA +
    (y / MAP_SIZE - 0.5) * SYNOPTIC_TILT_HPA * 0.35
  );
}

export function pressureAt(
  entities: WeatherEntity[],
  base: BaseConditions,
  x: number,
  y: number,
  surfaceInfluence?: (entity: WeatherEntity, x: number, y: number) => number,
): number {
  let value = base.P + synopticTilt(x, y);
  let troughStrength = 0;
  for (const entity of entities) {
    if (
      entity.type === 'coldHigh' ||
      entity.type === 'warmHigh' ||
      entity.type === 'coldLow' ||
      entity.type === 'warmLow' ||
      entity.type === 'typhoon'
    ) {
      const influence = pressureInfluence(
        entity,
        x,
        y,
        pressureOrientationFor(entity, entities),
      );
      if (influence < 1e-6) continue;
      const isLow = isLowPressureType(entity.type);
      value += (isLow ? -1 : 1) * entity.strength * influence;
    } else if (entity.type === 'trough') {
      troughStrength += entity.strength * airInfluence(entity, x, y);
    }
  }
  value +=
    (base.T - thermalAirTemperature(entities, base, x, y, surfaceInfluence)) *
    THERMAL_PRESSURE_COEFF;
  value -= frontalTroughAt(entities, x, y);
  if (value < base.P && troughStrength > 0) {
    value = base.P - (base.P - value) * (1 + TROUGH_DEEPEN * troughStrength);
  }
  return value;
}

export function highPressureAt(
  entities: WeatherEntity[],
  x: number,
  y: number,
): number {
  let value = synopticTilt(x, y) * 0.5;
  for (const entity of entities) {
    if (
      entity.type === 'coldHigh' ||
      entity.type === 'warmHigh' ||
      entity.type === 'coldLow' ||
      entity.type === 'warmLow' ||
      entity.type === 'typhoon'
    ) {
      const influence = pressureInfluence(
        entity,
        x,
        y,
        pressureOrientationFor(entity, entities),
      );
      if (influence < 1e-6) continue;
      if (entity.type === 'typhoon') {
        // A warm core is anomalously high aloft: the outflow anticyclone.
        value += entity.strength * TYPHOON_HIGH_P_GAIN * influence;
        continue;
      }
      const isLow = entity.type === 'coldLow' || entity.type === 'warmLow';
      if (entity.depth === 'shallow') {
        value += (isLow ? 0.5 : 1) * entity.strength * SHALLOW_HIGH_P_GAIN * influence;
      } else {
        value += (isLow ? -1 : 1) * entity.strength * HIGH_P_GAIN * influence;
      }
    } else if (entity.type === 'trough') {
      value -= TROUGH_HIGH_P_DROP * entity.strength * airInfluence(entity, x, y);
    } else if (entity.type === 'ridge') {
      value += RIDGE_HIGH_P_GAIN * entity.strength * airInfluence(entity, x, y);
    }
  }
  return value;
}

function thermalAirTemperature(
  entities: WeatherEntity[],
  base: BaseConditions,
  x: number,
  y: number,
  surfaceInfluence?: (entity: WeatherEntity, x: number, y: number) => number,
): number {
  let cold = 0;
  let warm = 0;
  const influenceAt = surfaceInfluence ?? airInfluence;
  for (const entity of entities) {
    if (entity.type !== 'coldAir' && entity.type !== 'warmAir') continue;
    const influence = influenceAt(entity, x, y);
    if (influence < 0.001) continue;
    if (entity.type === 'coldAir') cold += entity.strength * influence;
    else warm += entity.strength * influence;
  }
  // Keep the thermal anomaly continuous. The old 35%-dominance snap created
  // a step in T and P along the curve where the condition flipped.
  return base.T + warm - cold;
}

export interface PressureGrid {
  n: number;
  spacing: number;
  values: Float32Array;
}

/**
 * Bicubic (Catmull-Rom) resample of the weather-grid pressure field. Bilinear
 * interpolation has slope discontinuities at every source cell boundary, which
 * made long, low-gradient isobars look like polygons; Catmull-Rom keeps the
 * drawn contours smooth without inventing new pressure features.
 */
export function upsamplePressureGrid(
  source: Float32Array,
  sourceN: number,
  sourceSpacing: number,
  n = 161,
  size = MAP_SIZE,
): PressureGrid {
  const spacing = size / (n - 1);
  const values = new Float32Array(n * n);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of source) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const clampIndex = (index: number) => Math.max(0, Math.min(sourceN - 1, index));
  const catmull = (p0: number, p1: number, p2: number, p3: number, t: number) => {
    const t2 = t * t;
    const t3 = t2 * t;
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  };
  const rowAt = (row: number, ix0: number, ix1: number, ix2: number, ix3: number, tx: number) => {
    const base = row * sourceN;
    return catmull(source[base + ix0], source[base + ix1], source[base + ix2], source[base + ix3], tx);
  };

  for (let j = 0; j < n; j += 1) {
    const gy = Math.max(0, Math.min(sourceN - 1, (j * spacing) / sourceSpacing));
    const y0 = Math.floor(gy);
    const ty = gy - y0;
    const iy0 = clampIndex(y0 - 1);
    const iy1 = clampIndex(y0);
    const iy2 = clampIndex(y0 + 1);
    const iy3 = clampIndex(y0 + 2);
    for (let i = 0; i < n; i += 1) {
      const gx = Math.max(0, Math.min(sourceN - 1, (i * spacing) / sourceSpacing));
      const x0 = Math.floor(gx);
      const tx = gx - x0;
      const ix0 = clampIndex(x0 - 1);
      const ix1 = clampIndex(x0);
      const ix2 = clampIndex(x0 + 1);
      const ix3 = clampIndex(x0 + 2);
      const v0 = rowAt(iy0, ix0, ix1, ix2, ix3, tx);
      const v1 = rowAt(iy1, ix0, ix1, ix2, ix3, tx);
      const v2 = rowAt(iy2, ix0, ix1, ix2, ix3, tx);
      const v3 = rowAt(iy3, ix0, ix1, ix2, ix3, tx);
      const value = catmull(v0, v1, v2, v3, ty);
      // Catmull-Rom can ring near a sharp edge; keep the analysis within the
      // source range so the drawn isobars never overshoot the data.
      values[j * n + i] = Math.max(min, Math.min(max, value));
    }
  }
  return { n, spacing, values };
}

/**
 * Higher-resolution pressure analysis grid used for isobars and axes. The
 * weather grid stays at its normal resolution, while contours get enough
 * samples to keep kinks, ridges and troughs crisp.
 */
export function buildPressureGrid(
  entities: WeatherEntity[],
  base: BaseConditions,
  n = 161,
  highLayer = false,
  size = MAP_SIZE,
): PressureGrid {
  const spacing = size / (n - 1);
  const values = new Float32Array(n * n);

  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const x = i * spacing;
      const y = j * spacing;
      values[j * n + i] = highLayer
        ? highPressureAt(entities, x, y)
        : pressureAt(entities, base, x, y);
    }
  }

  return { n, spacing, values };
}

function sampleGrid(grid: PressureGrid, x: number, y: number): number {
  const gx = Math.max(0, Math.min(grid.n - 1, x / grid.spacing));
  const gy = Math.max(0, Math.min(grid.n - 1, y / grid.spacing));
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(grid.n - 1, x0 + 1);
  const y1 = Math.min(grid.n - 1, y0 + 1);
  const tx = gx - x0;
  const ty = gy - y0;
  const a = grid.values[y0 * grid.n + x0];
  const b = grid.values[y0 * grid.n + x1];
  const c = grid.values[y1 * grid.n + x0];
  const d = grid.values[y1 * grid.n + x1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

interface FieldSample {
  p: number;
  gx: number;
  gy: number;
  lambda1: number;
  lambda2: number;
  e1x: number;
  e1y: number;
}

function sampleField(grid: PressureGrid, x: number, y: number): FieldSample {
  const eps = 7;
  const p = sampleGrid(grid, x, y);
  const gx = (sampleGrid(grid, x + eps, y) - sampleGrid(grid, x - eps, y)) / (2 * eps);
  const gy = (sampleGrid(grid, x, y + eps) - sampleGrid(grid, x, y - eps)) / (2 * eps);
  const pxx =
    (sampleGrid(grid, x + eps, y) - 2 * p + sampleGrid(grid, x - eps, y)) / (eps * eps);
  const pyy =
    (sampleGrid(grid, x, y + eps) - 2 * p + sampleGrid(grid, x, y - eps)) / (eps * eps);
  const pxy =
    (sampleGrid(grid, x + eps, y + eps) -
      sampleGrid(grid, x + eps, y - eps) -
      sampleGrid(grid, x - eps, y + eps) +
      sampleGrid(grid, x - eps, y - eps)) /
    (4 * eps * eps);
  const trace = pxx + pyy;
  const disc = Math.sqrt(Math.max(0, (pxx - pyy) ** 2 + 4 * pxy * pxy));
  const lambda1 = (trace + disc) / 2;
  const lambda2 = (trace - disc) / 2;
  let e1x = lambda1 - pyy;
  let e1y = pxy;
  if (Math.hypot(e1x, e1y) < 0.000001) {
    e1x = 1;
    e1y = 0;
  }
  const length = Math.hypot(e1x, e1y) || 1;
  e1x /= length;
  e1y /= length;
  return { p, gx, gy, lambda1, lambda2, e1x, e1y };
}

export interface TracedAxis {
  kind: 'ridge' | 'trough';
  points: Array<{ x: number; y: number }>;
}

/**
 * Trace one continuous ridge/trough crest through a pressure centre. The
 * tangent follows the weak-curvature eigenvector; a Newton correction along the
 * strong-curvature direction keeps the path on the line where the
 * cross-gradient vanishes. This produces one axis from end to end, instead of
 * the two disconnected half-axes that contour-cusp clustering used to emit.
 */
export function tracePressureAxis(
  grid: PressureGrid,
  entity: WeatherEntity,
  basePressure: number,
): TracedAxis | null {
  if (!isPressureType(entity)) return null;
  const isLow = entity.type === 'coldLow' || entity.type === 'warmLow';
  const start = sampleField(grid, entity.x, entity.y);
  const ratio =
    Math.abs(isLow ? start.lambda1 : start.lambda2) /
    Math.max(0.000001, Math.abs(isLow ? start.lambda2 : start.lambda1));
  if (ratio < 1.18) return null;

  const centerAnomaly = Math.abs(start.p - basePressure);
  const stop = Math.max(0.25, centerAnomaly * 0.04);
  const maxDistance = Math.min(340, entity.radius * 2.4);
  const step = 5;

  const traceSide = (sign: number): Array<{ x: number; y: number }> => {
    const points: Array<{ x: number; y: number }> = [];
    let x = entity.x;
    let y = entity.y;
    let previousX = isLow ? -start.e1y : start.e1x;
    let previousY = isLow ? start.e1x : start.e1y;
    if (sign < 0) {
      previousX = -previousX;
      previousY = -previousY;
    }

    for (let iteration = 0; iteration < 90; iteration += 1) {
      const field = sampleField(grid, x, y);
      let tangentX = isLow ? -field.e1y : field.e1x;
      let tangentY = isLow ? field.e1x : field.e1y;
      if (tangentX * previousX + tangentY * previousY < 0) {
        tangentX = -tangentX;
        tangentY = -tangentY;
      }
      const normalX = isLow ? field.e1x : -field.e1y;
      const normalY = isLow ? field.e1y : field.e1x;
      const curvature = isLow ? field.lambda1 : field.lambda2;
      const slope = field.gx * normalX + field.gy * normalY;
      const safeCurvature =
        Math.abs(curvature) < 0.00008 ? Math.sign(curvature || 1) * 0.00008 : curvature;
      const correction = Math.max(-5, Math.min(5, -slope / safeCurvature));
      x += tangentX * step + normalX * correction;
      y += tangentY * step + normalY * correction;
      if (
        x < MAP_SIZE * 0.012 ||
        y < MAP_SIZE * 0.012 ||
        x > MAP_SIZE * 0.988 ||
        y > MAP_SIZE * 0.988
      ) {
        break;
      }
      const value = sampleGrid(grid, x, y);
      if (Math.abs(value - basePressure) < stop) break;
      points.push({ x, y });
      previousX = tangentX;
      previousY = tangentY;
      if (points.length * step > maxDistance) break;
    }
    return points;
  };

  const forward = traceSide(1);
  const backward = traceSide(-1);
  if (forward.length + backward.length < 6) return null;
  const points = [
    ...backward.reverse(),
    { x: entity.x, y: entity.y },
    ...forward,
  ].filter(
    (point, index, list) =>
      index === 0 || Math.hypot(point.x - list[index - 1].x, point.y - list[index - 1].y) > 1.5,
  );
  return { kind: isLow ? 'trough' : 'ridge', points };
}

