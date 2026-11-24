/**
 * Surface field: the land/sea/elevation/SST/roughness grid shared by the
 * renderer and the surface physics.
 *
 * The chart is authored as a few polygons and a hill list; physics needs a
 * cheap, cacheable sample of the same world instead of re-deriving land/sea on
 * every point query.  A 64×64 grid is enough for a synoptic chart: one cell is
 * about 15 px (≈15 km on a 1000 km domain).
 */

import { MAP_SIZE } from '../config/constants';
import { elevationAt } from '../render/terrain';
import { getMap, pointInPolygon } from './geography';
import type { BaseConditions } from './types';

export interface SurfaceSample {
  land: boolean;
  /** Metres above sea level. */
  elevation: number;
  /** Sea-surface temperature, °C.  On land this falls back to air temperature. */
  sst: number;
  /** Aerodynamic roughness length, m. */
  roughness: number;
}

export interface SurfaceField {
  key: string;
  n: number;
  land: Uint8Array;
  elevation: Float32Array;
  sst: Float32Array;
  roughness: Float32Array;
}

const GRID = 64;
const cache = new Map<string, SurfaceField>();

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Climatological fallback when a level does not name an SST. */
export function seaSurfaceTemperature(base: BaseConditions): number {
  if (typeof base.sst === 'number' && Number.isFinite(base.sst)) return base.sst;
  return clamp(30.5 - Math.abs(base.latitude) * 0.42, 10, 30);
}

function roughnessFor(land: boolean, elevation: number): number {
  if (!land) return 0.0002;
  if (elevation >= 300) return 0.5;
  if (elevation >= 50) return 0.1;
  return 0.03;
}


/** Height of the map prototype's drawn hills, in metres. */
function hillHeight(map: ReturnType<typeof getMap>, x: number, y: number): number {
  let height = 0;
  for (const hill of map.hills) {
    const dx = x - hill.x;
    const dy = y - hill.y;
    const d2 = (dx * dx) / (hill.rx * hill.rx) + (dy * dy) / (hill.ry * hill.ry);
    height += 900 * Math.exp(-1.7 * d2);
  }
  return height;
}

export function buildSurfaceField(base: BaseConditions): SurfaceField {
  // Derive the chart from the level itself, never from module-global state:/n  // sampleSurface() is also called outside simulateRound.
  const map = getMap(base.mapId);
  const sstSea = seaSurfaceTemperature(base);
  const profile = base.terrainProfile ?? 'default';
  const key = `${map.id}:${profile}:${sstSea.toFixed(2)}:${base.T.toFixed(1)}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const n = GRID;
  const land = new Uint8Array(n * n);
  const elevation = new Float32Array(n * n);
  const sst = new Float32Array(n * n);
  const roughness = new Float32Array(n * n);
  const step = MAP_SIZE / n;
  // Sea temperature is not uniform: lower latitudes are warmer.  The gradient
  // gives the chart a real SST field so moisture supply can vary over water.
  // Kept within ±1 °C across the chart so the water-budget invariant (SST must
  // stay in the level's climatology band) still holds.
  const sstLatitudeGradient = 0.1;

  for (let j = 0; j < n; j += 1) {
    const rowLatitude = surfaceLatitudeAt(base, (j + 0.5) * step);
    const sstAtRow = sstSea + (Math.abs(base.latitude) - rowLatitude) * sstLatitudeGradient;
    const y = (j + 0.5) * step;
    for (let i = 0; i < n; i += 1) {
      const x = (i + 0.5) * step;
      const isLand = pointInPolygon(x, y, map.land);
      // The chart's ridge is drawn from the map prototype, so the surface field
      // must include it too; elevationAt() only knows the legacy/default peaks.
      const height = isLand
        ? Math.max(elevationAt(x, y, base.terrainProfile), hillHeight(map, x, y))
        : 0;
      const index = j * n + i;
      land[index] = isLand ? 1 : 0;
      elevation[index] = height;
      sst[index] = isLand ? base.T : sstAtRow;
      roughness[index] = roughnessFor(isLand, height);
    }
  }

  const field: SurfaceField = { key, n, land, elevation, sst, roughness };
  cache.set(key, field);
  return field;
}

function bilinear(values: ArrayLike<number>, n: number, x: number, y: number): number {
  const fx = clamp((x / MAP_SIZE) * (n - 1), 0, n - 1);
  const fy = clamp((y / MAP_SIZE) * (n - 1), 0, n - 1);
  const i0 = Math.floor(fx);
  const j0 = Math.floor(fy);
  const i1 = Math.min(n - 1, i0 + 1);
  const j1 = Math.min(n - 1, j0 + 1);
  const tx = fx - i0;
  const ty = fy - j0;
  const a = values[j0 * n + i0] * (1 - tx) + values[j0 * n + i1] * tx;
  const b = values[j1 * n + i0] * (1 - tx) + values[j1 * n + i1] * tx;
  return a * (1 - ty) + b * ty;
}

export function sampleSurface(base: BaseConditions, x: number, y: number): SurfaceSample {
  const field = buildSurfaceField(base);
  const n = field.n;
  const isLand = bilinear(field.land, n, x, y) >= 0.5;
  return {
    land: isLand,
    elevation: bilinear(field.elevation, n, x, y),
    sst: bilinear(field.sst, n, x, y),
    roughness: bilinear(field.roughness, n, x, y),
  };
}

/**
 * Surface air-temperature correction against `base.T`, in °C.
 *
 * The campaign used to give every city exactly `base.T`, so a coastal plain
 * and a 2 km plateau at the same map position read the same temperature.
 * Real station temperatures vary with latitude and altitude; adding a
 * conservative correction (0.3 °C per degree, 2 °C per km) keeps the campaign
 * calibration while making the station readout physically meaningful.
 * Northern-hemisphere maps cool toward the north edge; southern maps cool
 * toward the south edge (larger absolute latitude).
 */
export const LATITUDE_TEMPERATURE_LAPSE = 0.3;
export const ELEVATION_TEMPERATURE_LAPSE = 2.0;

/** Absolute latitude at a map row, derived from the chart's physical height. */
export function surfaceLatitudeAt(base: BaseConditions, y: number): number {
  const latitudeSpan = (base.domainScale ?? 1000) / 111;
  const north = (MAP_SIZE / 2 - y) / MAP_SIZE;
  const delta = base.hemisphere === 'S' ? -north * latitudeSpan : north * latitudeSpan;
  return Math.abs(base.latitude) + delta;
}

export function surfaceTemperatureCorrection(base: BaseConditions, x: number, y: number): number {
  const latitudeDelta = surfaceLatitudeAt(base, y) - Math.abs(base.latitude);
  const elevationKm = Math.min(2500, sampleSurface(base, x, y).elevation) / 1000;
  return -latitudeDelta * LATITUDE_TEMPERATURE_LAPSE - elevationKm * ELEVATION_TEMPERATURE_LAPSE;
}

/** Evaporation transfer coefficient, in strength units per (m/s · g/m³). */
export const SURFACE_EVAP_COEFF = 0.012;
/** Cap on one round's evaporation so a gale cannot refill a source instantly. */
export const SURFACE_EVAP_MAX_PER_ROUND = 2.5;
/** Land evapotranspiration is supply-limited, sea is not. */
export const SURFACE_LAND_BETA = 0.45;

/**
 * Bulk evaporation from the surface into the column, in the same units as a
 * moisture card's strength (g/m³).  It is driven by wind and by the deficit
 * between saturation at the surface temperature and the ambient moisture, so
 * a calm or saturated atmosphere evaporates nothing.
 */
export function evaporationFlux(
  airMoisture: number,
  sample: SurfaceSample,
  windSpeed: number,
  saturationAt: (temperature: number) => number,
): number {
  const deficit = Math.max(0, saturationAt(sample.sst) - airMoisture);
  const beta = sample.land ? SURFACE_LAND_BETA : 1;
  const flux = SURFACE_EVAP_COEFF * Math.max(0, windSpeed) * deficit * beta;
  return Math.min(SURFACE_EVAP_MAX_PER_ROUND, flux);
}
