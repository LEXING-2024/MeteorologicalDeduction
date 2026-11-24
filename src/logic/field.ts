import {
  AIR_MASS_MOIST_ANOMALY,
  AIR_MASS_THETA_E_NEUTRAL_K,
  BASE_FRICTION,
  COLD_POOL_KM,
  COLD_POOL_OUTFLOW,
  CLOUD_TOP_HIGH_Q_FRACTION,
  CLOUD_TOP_HIGH_Z_KM,
  CLOUD_TOP_LAPSE_RATE,
  CLOUD_TOP_MAX_KM,
  CLOUD_TOP_MID_Q_FRACTION,
  CLOUD_TOP_THETA_E_DROP_REFERENCE,
  CLOUD_TOP_THETA_E_GAIN,
  CLOUD_TOP_THETA_E_LATENT,
  CLOUD_TOP_WARM_NOSE_GAIN,
  MAX_COLD_POOL_OUTFLOW,
  CORIOLIS_DEFLECTION_DEG,
  CROSS_ISOBAR_LAND_DEG,
  CROSS_ISOBAR_MOUNTAIN_DEG,
  CROSS_ISOBAR_SEA_DEG,
  DRYLINE_CONVERGENCE_THRESHOLD,
  DRYLINE_LIFT,
  DRYLINE_THRESHOLD,
  BACKGROUND_RAIN_CAP_MM,
  EKMAN_APERTURE_KM,
  EKMAN_LIFT,
  EKMAN_MAX_LIFT,
  FRONT_CONTRAST_LENGTH_KM,
  FRONT_DENSITY_CURRENT,
  FRONT_GRADIENT_FULL,
  FRONT_GRADIENT_THRESHOLD,
  FRONT_OCCLUSION_REACH,
  FRONT_OCCLUSION_ROUNDS,
  FRONT_OVERLAP_MIN,
  FRONT_SEMANTICS,
  FRONT_STATIONARY_SPEED,
  GRID_N,
  HIGH_LEVEL_COUPLING,
  HIGH_P_GAIN,
  HIGH_SINK_PER_HPA,
  HIGH_W_LIFT_PER_HPA,
  HIGH_W_SINK_PER_HPA,
  INFLUENCE_WOBBLE,
  INVERSION_STABLE_MULTIPLIER,
  INVERSION_UNSTABLE_MULTIPLIER,
  ISOBAR_GRID_N,
  JET_EXIT_LIFT,
  JET_HIGH_W,
  JET_MAX_CORE_PER_TIER,
  JET_REFERENCE_CORE_SPEED,
  JET_THERMAL_WIND_COEFF,
  JET_DEFAULT_ANGLE,
  JET_STEERING_SCALE,
  LAND_FRICTION,
  LOW_LIFT_PER_HPA,
  MAP_SIZE,
  MAX_HIGH_WIND_SPEED,
  MAX_VERTICAL_VELOCITY,
  MAX_WIND_SPEED,
  MOISTURE_FLUX_KM,
  MOUNTAIN_FRICTION,
  OROGRAPHIC_LIFT,
  PRESSURE_ANISOTROPY,
  RIDGE_HIGH_P_GAIN,
  RIDGE_HIGH_SINK,
  SHEAR_LIFT,
  SHEAR_THRESHOLD_DEG,
  PRESSURE_FALLOFF,
  SHALLOW_HIGH_P_GAIN,
  SHALLOW_HIGH_W,
  STEERING_FACTOR,
  SURFACE_ANISOTROPY,
  SURFACE_FALLOFF,
  SHAPE_FEATURE_LIFT,
  TEMPERATURE_ADVECTION,
  TERRAIN_LEE_P,
  TERRAIN_THERMAL_P,
  TERRAIN_WINDWARD_P,
  TROUGH_HIGH_LIFT,
  TROUGH_HIGH_P_DROP,
  WIND_GRADIENT_SCALE,
  FREEZING_RAIN_MID_T,
  FREEZING_RAIN_SURFACE_T,
  FREEZING_RAIN_WARM_NOSE,
  MID_LAYER_TEMPERATURE_GAIN,
  TORNADO_SHEAR,
  TORNADO_VORTICITY,
  TYPHOON_EYE_SINK_PER_HPA,
  TYPHOON_HIGH_DIVERGENCE_PER_HPA,
  TYPHOON_LIFT_PER_HPA,
  TYPHOON_MOISTURE_PER_HPA,
  TYPHOON_WARM_CORE_PER_HPA,
} from '../config/constants';
import { diagnosticKm, kmPerPixel, kmToPx } from '../config/scale';
import { elevationAt } from '../render/terrain';
import { getActiveMap, isLandPoint, signedCoastDistance } from './geography';
import { sampleSurface, surfaceTemperatureCorrection } from './surface';
import { bumpPressurePass, pressureAt, highPressureAt, pressureInfluence, pressureOrientationFor } from './pressure';
import type { PressureGrid } from './pressure';
import { shapeMetrics } from './shape';
import { cloneEntities, isUpperType } from './entities';
import { typhoonProfile } from './typhoon';
import { WeatherField } from '../../experiments/swe/physics/WeatherField';
import type { FieldSample } from '../../experiments/swe/physics/WeatherField';
import { frontTypeCode } from '../../experiments/swe/physics/thermal';
import { pressureHpaToDepth } from '../../experiments/swe/physics/constants';
import {
  precipitationRate,
  precipitationRateFromFlux,
  precipitationType,
  coldPoolCooling,
  rainGradeFrom24h,
  saturationVapourDensity,
} from './precipitation';
import type {
  AirMass,
  BaseConditions,
  City,
  FrontType,
  HazardType,
  Hemisphere,
  PointWeather,
  SampleGrid,
  SimulationSnapshot,
  WeatherEntity,
  WindVector,
} from './types';

const COMPASS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];

// ---------------------------------------------------------------------------
// Stage-1 physical runtime (1000 km shallow-water engine)
// ---------------------------------------------------------------------------
/** Runtime grid.  96 keeps a 3 h round near one second on the interactive map. */
const SWE_RUNTIME_GRID_N = 96;
/** A round is three hours of physical time. */
export const PHYSICAL_ROUND_SECONDS = 3 * 3600;
export const PHYSICAL_STEP_SECONDS = 10;
/** The pressure anomaly uses the UI radius directly (no hidden expansion). */
const SWE_PRESSURE_SPREAD = 1;
/** Temperature/moisture blobs also use the UI radius directly. */
const SWE_THERMAL_SPREAD = 1;
/** Effective layer depth for the static temperature -> pressure coupling in play. */
const SWE_THERMAL_LAYER_DEPTH = 600;
/** Preview spin-up. Zero shows the balanced initial state immediately. */
const SWE_PREVIEW_SECONDS = 0;
/** Physical wind is reported up to this speed (the old HUD capped at 28 m/s). */
const MAX_REPORTED_WIND = 60;

interface PhysicalFieldCache {
  key: string;
  field: WeatherField;
}

let physicalFieldCache: PhysicalFieldCache | null = null;

/** True when a level opts into the shallow-water runtime. */
export function isPhysicalBase(base: BaseConditions): boolean {
  return base.physics === 'swe';
}

/** Invalidate the cached physical field (level load, reset, undo). */
export function invalidatePhysicalField(): void {
  physicalFieldCache = null;
}

/**
 * Make a field the current state for `entities`.  Used after a round so hover
 * and station sampling see the evolved field instead of re-initialising it.
 */
export function commitPhysicalField(
  entities: WeatherEntity[],
  base: BaseConditions,
  field: WeatherField,
): void {
  physicalFieldCache = { key: physicalKey(entities, base), field };
}

/** Get (or build) the current physical field for this card/base state. */
export function getPhysicalField(entities: WeatherEntity[], base: BaseConditions): WeatherField {
  const key = physicalKey(entities, base);
  if (physicalFieldCache && physicalFieldCache.key === key) {
    return physicalFieldCache.field;
  }
  const field = buildPhysicalField(entities, base);
  physicalFieldCache = { key, field };
  return field;
}

/** Advance the cached/current physical field by a round. */
export function advancePhysicalField(field: WeatherField, seconds = PHYSICAL_ROUND_SECONDS): void {
  field.run(seconds, PHYSICAL_STEP_SECONDS);
}

function physicalKey(entities: WeatherEntity[], base: BaseConditions): string {
  let key = `${base.physics}|${base.domainScale}|${base.P}|${base.T}|${base.Q}|${base.hemisphere}|${base.hasTerrain ? 1 : 0}`;
  for (const entity of entities) {
    key += `|${entity.type}:${entity.x.toFixed(1)}:${entity.y.toFixed(1)}:${entity.strength}:${entity.radius.toFixed(1)}:${entity.inversionMode ?? ''}:${entity.depth}`;
    if (entity.shape) {
      key += `:${entity.shape.length}`;
      for (const point of entity.shape) key += `,${point.x.toFixed(0)},${point.y.toFixed(0)}`;
    }
  }
  return key;
}

/**
 * Build the shallow-water initial state from the cards.
 *
 * Pressure centres keep their designed shape (pressureInfluence) but are
 * stretched horizontally so a 20 hPa card is a synoptic system instead of a
 * 200 km bomb; cold/warm cards produce both the temperature field and the
 * hydrostatic thickness anomaly; wet cards seed the moisture tracer.
 */
function buildPhysicalField(entities: WeatherEntity[], base: BaseConditions): WeatherField {
  const domainKm = base.domainScale ?? 1000;
  const field = new WeatherField({
    n: SWE_RUNTIME_GRID_N,
    domainKm,
    base,
    thermalCoupling: false,
    spongeCells: 10,
    cflLimit: 0.5,
    smoothing: 0.03,
    viscosity: 800,
  });
  const n = field.n;
  const cells = n * n;
  const height = new Float64Array(cells);
  const temperature = new Float64Array(cells);
  const moisture = new Float64Array(cells);
  const stability = new Float64Array(cells);
  const upper = new Float64Array(cells);
  temperature.fill(base.T);
  moisture.fill(base.Q);
  const domainMetres = field.domainMetres;
  if (base.hasTerrain) {
    field.setTerrainFromCallback((xMetres, yMetres) => {
      const px = (xMetres / domainMetres) * MAP_SIZE;
      const py = MAP_SIZE - (yMetres / domainMetres) * MAP_SIZE;
      return elevationAt(px, py, base.terrainProfile);
    });
  }
  const referenceKelvin = base.T + 273.15;

  const cellX = (i: number) => ((i + 0.5) / n) * MAP_SIZE;
  const cellY = (j: number) => MAP_SIZE - ((j + 0.5) / n) * MAP_SIZE;
  const clampIndexX = (value: number) => Math.max(0, Math.min(n - 1, value));
  const clampIndexY = (value: number) => Math.max(0, Math.min(n - 1, value));
  const indexXFor = (px: number) => (px / MAP_SIZE) * n;
  const indexYFor = (py: number) => ((MAP_SIZE - py) / MAP_SIZE) * n;

  for (const entity of entities) {
    const strength = Math.abs(entity.strength);
    if (!(strength > 0)) continue;
    const isPressure =
      entity.type === 'coldHigh' ||
      entity.type === 'warmHigh' ||
      entity.type === 'coldLow' ||
      entity.type === 'warmLow';
    const isThermal = entity.type === 'coldAir' || entity.type === 'warmAir';
    const isMoisture = entity.type === 'wet';
    const isInversion = entity.type === 'inversion';
    const isUpper =
      entity.type === 'trough' || entity.type === 'ridge' || entity.type === 'jet';
    if (!isPressure && !isThermal && !isMoisture && !isInversion && !isUpper) continue;

    const spread = isPressure ? SWE_PRESSURE_SPREAD : SWE_THERMAL_SPREAD;
    const reach = entity.radius * spread * 3;
    const orientation = isPressure ? pressureOrientationFor(entity, entities) : undefined;
    const i0 = clampIndexX(Math.floor(indexXFor(entity.x - reach)));
    const i1 = clampIndexX(Math.ceil(indexXFor(entity.x + reach)));
    const j0 = clampIndexY(Math.floor(indexYFor(entity.y + reach)));
    const j1 = clampIndexY(Math.ceil(indexYFor(entity.y - reach)));
    const pressureSign =
      entity.type === 'coldHigh' || entity.type === 'warmHigh' ? 1 : -1;
    const thermalSign = entity.type === 'warmAir' ? 1 : -1;
    const pressureDepth = pressureHpaToDepth(strength);

    for (let j = j0; j <= j1; j += 1) {
      const py = cellY(j);
      const row = j * n;
      for (let i = i0; i <= i1; i += 1) {
        const px = cellX(i);
        const index = row + i;
        if (isPressure) {
          const influence = Math.min(
            1,
            pressureInfluence(
              entity,
              entity.x + (px - entity.x) / spread,
              entity.y + (py - entity.y) / spread,
              orientation,
            ),
          );
          height[index] += pressureSign * pressureDepth * influence;
        } else if (isThermal) {
          const influence = Math.min(
            1,
            influenceAt(
              entity,
              entity.x + (px - entity.x) / spread,
              entity.y + (py - entity.y) / spread,
            ),
          );
          const deltaT = thermalSign * strength * influence;
          temperature[index] += deltaT;
          height[index] -= (SWE_THERMAL_LAYER_DEPTH / referenceKelvin) * deltaT;
        } else if (isMoisture) {
          const influence = Math.min(
            1,
            influenceAt(
              entity,
              entity.x + (px - entity.x) / spread,
              entity.y + (py - entity.y) / spread,
            ),
          );
          moisture[index] += strength * influence;
        } else if (isInversion) {
          const influence = Math.min(
            1,
            influenceAt(
              entity,
              entity.x + (px - entity.x) / spread,
              entity.y + (py - entity.y) / spread,
            ),
          );
          stability[index] +=
            (entity.inversionMode === 'stable' ? -1 : 1) * strength * influence;
        } else {
          const influence = Math.min(
            1,
            influenceAt(
              entity,
              entity.x + (px - entity.x) / spread,
              entity.y + (py - entity.y) / spread,
            ),
          );
          if (entity.type === 'trough') {
            height[index] -= pressureHpaToDepth(0.6 * strength) * influence;
            upper[index] += 0.06 * strength * influence;
          } else if (entity.type === 'ridge') {
            height[index] += pressureHpaToDepth(0.6 * strength) * influence;
            upper[index] -= 0.06 * strength * influence;
          } else {
            upper[index] += 0.04 * strength * influence;
          }
        }
      }
    }
  }

  field.setHeight(height);
  field.setTemperature(temperature);
  field.setMoisture(moisture);
  field.setStability(stability);
  field.upperForcing.set(upper);
  field.commit(true);
  if (SWE_PREVIEW_SECONDS > 0) {
    field.run(SWE_PREVIEW_SECONDS, PHYSICAL_STEP_SECONDS);
  }
  return field;
}

function samplePhysicalGrid(
  field: WeatherField,
  entities: WeatherEntity[],
  base: BaseConditions,
  n: number,
  size: number,
): SampleGrid {
  const spacing = size / (n - 1);
  const count = n * n;
  const pLow = new Float32Array(count);
  const tLow = new Float32Array(count);
  const qLow = new Float32Array(count);
  const wLow = new Float32Array(count);
  const pHigh = new Float32Array(count);
  const wHigh = new Float32Array(count);
  const r = new Float32Array(count);
  const uLow = new Float32Array(count);
  const vLow = new Float32Array(count);
  const uHigh = new Float32Array(count);
  const vHigh = new Float32Array(count);
  const frontStrength = new Float32Array(count);
  const frontType = new Uint8Array(count);
  const wConvergence = new Float32Array(count);
  const wTerrain = new Float32Array(count);
  const sampleScale = MAP_SIZE / size;
  for (let j = 0; j < n; j += 1) {
    const py = j * spacing * sampleScale;
    for (let i = 0; i < n; i += 1) {
      const px = i * spacing * sampleScale;
      const sample = field.sampleScreen(px, py);
      const raw = sampleRaw(entities, base, px, py);
      const windHigh = highWindAt(entities, base, px, py);
      const index = j * n + i;
      pLow[index] = sample.pressureHpa;
      tLow[index] = sample.temperatureC;
      qLow[index] = sample.moisture;
      wLow[index] = sample.wGame;
      r[index] = precipitationRate(sample.temperatureC, sample.moisture, sample.wGame);
      uLow[index] = sample.u;
      vLow[index] = -sample.v;
      pHigh[index] = raw.pHigh;
      wHigh[index] = raw.wHigh;
      uHigh[index] = windHigh.x;
      vHigh[index] = windHigh.y;
      const resolvedFront: FrontType = occlusionAt(entities, px, py)
        ? 'occluded'
        : sample.front.type;
      frontStrength[index] = sample.front.strength;
      frontType[index] = frontTypeCode(resolvedFront);
      wConvergence[index] = sample.wConvergence;
      wTerrain[index] = sample.wTerrain;
    }
  }
  return {
    n,
    size,
    spacing,
    pLow,
    tLow,
    qLow,
    wLow,
    pHigh,
    wHigh,
    r,
    uLow,
    vLow,
    uHigh,
    vHigh,
    frontStrength,
    frontType,
    wConvergence,
    wTerrain,
  };
}

function samplePhysicalPressure(field: WeatherField, n: number, size: number): PressureGrid {
  const spacing = size / (n - 1);
  const values = new Float32Array(n * n);
  const scale = MAP_SIZE / size;
  for (let j = 0; j < n; j += 1) {
    const py = j * spacing * scale;
    for (let i = 0; i < n; i += 1) {
      const px = i * spacing * scale;
      values[j * n + i] = field.sampleScreen(px, py).pressureHpa;
    }
  }
  return { n, spacing, values };
}

function physicalDryline(field: WeatherField, x: number, y: number): number {
  const eps = 22;
  const east = field.sampleScreen(x + eps, y).moisture;
  const west = field.sampleScreen(x - eps, y).moisture;
  const south = field.sampleScreen(x, y + eps).moisture;
  const north = field.sampleScreen(x, y - eps).moisture;
  return (Math.abs(east - west) + Math.abs(south - north)) / (4 * eps);
}

function buildPhysicalPointWeather(
  field: WeatherField,
  entities: WeatherEntity[],
  base: BaseConditions,
  x: number,
  y: number,
): PointWeather {
  const sample: FieldSample = field.sampleScreen(x, y);
  const wind = windFromVector(sample.u, -sample.v, MAX_REPORTED_WIND);
  const raw = sampleRaw(entities, base, x, y);
  const pHigh = raw.pHigh;
  const wHigh = raw.wHigh;
  const hasUpper = entities.some((entity) => isUpperType(entity.type));
  const windHigh = hasUpper ? highWindAt(entities, base, x, y) : windFromVector(0, 0, MAX_HIGH_WIND_SPEED);
  // classifyFronts() derives the type from the SWE temperature field; the
  // shared process gate can still upgrade it to an occlusion, and the shared
  // semantics table supplies one label / lift scale for both engines.
  const resolvedFront: FrontType = occlusionAt(entities, x, y)
    ? 'occluded'
    : sample.front.type;
  const frontLift = sample.front.strength * FRONT_SEMANTICS[resolvedFront].lift;
  const W = sample.wGame;
  const wLow = W;
  const qSat = saturationVapourDensity(sample.temperatureC);
  // Keep the rain convention identical to the analytic engine: rate is driven
  // by moisture-flux convergence and a source-less column cannot rain without
  // limit.  Previously SWE used the bare precipitationRate here, so the same
  // board produced a different rain reading just by switching engines.
  const fluxConvergence = moistureFluxConvergenceAt(entities, base, x, y);
  let R = precipitationRateFromFlux(sample.temperatureC, sample.moisture, W, fluxConvergence);
  if (!hasMoistureSource(entities, x, y)) R = Math.min(R, BACKGROUND_RAIN_CAP_MM);
  const rain24h = R * 8;
  const cloudTop = cloudTopFromProfile({
    w: W,
    surfaceT: sample.temperatureC,
    surfaceQ: sample.moisture,
    midT: base.T,
    warmNose: 0,
  });
  const cloud = clamp(28 + Math.max(0, W) * 7 + (sample.moisture / Math.max(1, qSat)) * 30, 0, 100);
  const relativeHumidity = clamp((sample.moisture / Math.max(0.1, qSat)) * 100, 0, 100);
  const dewPoint = sample.temperatureC - (100 - relativeHumidity) * 0.18;
  const deepLow = entities.some(
    (entity) => entity.type === 'coldLow' && influenceAt(entity, x, y) > 0.1,
  );
  const hazard = hazardFor(
    W,
    cloudTop,
    sample.temperatureC,
    sample.moisture,
    qSat,
    wind,
    sample.stability,
    deepLow,
    isLandAt(x, y),
    R,
    0,
  );
  let visibility = 30;
  if (R > 0.01) visibility -= Math.min(24, R * 3.2);
  if (hazard === 'fog') visibility = Math.min(visibility, 0.8);
  if (hazard === 'dust') visibility = Math.min(visibility, 4);
  if (hazard === 'hail') visibility = Math.min(visibility, 12);
  if (hazard === 'freezingRain') visibility = Math.min(visibility, 6);
  const shear = shearAt(entities, base, x, y);
  const thetaE = sample.temperatureC + 273.15 + 2.5 * sample.moisture;

  return {
    pLow: sample.pressureHpa,
    tLow: sample.temperatureC,
    qLow: sample.moisture,
    wLow,
    pHigh,
    wHigh,
    W,
    P: sample.pressureHpa,
    T: sample.temperatureC,
    Q: sample.moisture,
    R,
    qSat,
    cloud,
    cloudTop,
    visibility,
    dewPoint,
    thetaE,
    coldPool: 0,
    rain24h,
    rainGrade: rainGradeFrom24h(rain24h),
    wind,
    windHigh,
    precipitationType:
      hazard === 'hail'
        ? 'hail'
        : hazard === 'freezingRain'
          ? 'freezingRain'
          : precipitationType(sample.temperatureC, R),
    frontType: resolvedFront,
    frontLift,
    stability: sample.stability,
    midTemperature: base.T,
    vorticity: 0,
    hazard,
    airMass: classifyAirMass(thetaE, sample.moisture, base),
    shear,
    dryline: physicalDryline(field, x, y),
    convection: convectiveLevel(W),
    wConvergence: sample.wConvergence,
    wEkman: sample.wEkman,
    wTerrain: sample.wTerrain,
    wFront: frontLift,
    pressureAnomaly: sample.pressureHpa - base.P,
  };
}

function samplePhysicalSnapshot(
  field: WeatherField,
  entities: WeatherEntity[],
  base: BaseConditions,
  cities: City[],
): SimulationSnapshot {
  const grid = samplePhysicalGrid(field, entities, base, GRID_N, MAP_SIZE);
  grid.pressureFine = samplePhysicalPressure(field, ISOBAR_GRID_N, MAP_SIZE).values;
  grid.pressureFineN = ISOBAR_GRID_N;
  // Rotation is a grid diagnostic.  Sampling it here (instead of leaving the
  // hardcoded vorticity:0 from buildPhysicalPointWeather) keeps SWE stations
  // consistent with the wind arrows and with the analytic engine's rule that
  // judged readings come from the field the player sees.
  const kmPerPx = kmPerPixel(base);
  const cityWeather: SimulationSnapshot['cities'] = {};
  for (const city of cities) {
    const weather = buildPhysicalPointWeather(field, entities, base, city.x, city.y);
    weather.vorticity = vorticityFromGrid(grid, city.x, city.y, kmPerPx);
    applyRotationHazard(weather);
    cityWeather[city.id] = weather;
  }
  return {
    entities: cloneEntities(entities),
    grid,
    cities: cityWeather,
  };
}

/** Public snapshot helper used by weather.ts for SWE levels. */
export function computePhysicalSnapshot(
  entities: WeatherEntity[],
  base: BaseConditions,
  cities: City[],
  field?: WeatherField,
): SimulationSnapshot {
  const active = field ?? getPhysicalField(entities, base);
  return samplePhysicalSnapshot(active, entities, base, cities);
}

/** Public field handle for the round loop. */
export function physicalFieldFor(
  entities: WeatherEntity[],
  base: BaseConditions,
): WeatherField {
  return getPhysicalField(entities, base);
}

export function samplePhysicalSnapshotFrom(
  field: WeatherField,
  entities: WeatherEntity[],
  base: BaseConditions,
  cities: City[],
): SimulationSnapshot {
  return samplePhysicalSnapshot(field, entities, base, cities);
}


export interface RawPoint {
  pLow: number;
  tLow: number;
  qLow: number;
  wLow: number;
  pressureW: number;
  pHigh: number;
  wHigh: number;
  frontType: FrontType;
  frontLift: number;
  stability: number;
  /** Base + inversion warm-nose temperature at mid levels, °C. */
  midTemperature: number;
  /** Anomaly created by the inversion card, °C. */
  warmNose: number;
  deepLow: boolean;
}

export interface VerticalContribution {
  entity: WeatherEntity;
  influence: number;
  value: number;
  highValue: number;
}

interface EntityShape {
  rx: number;
  ry: number;
  cos: number;
  sin: number;
  phase: number;
}

const shapeCache = new Map<string, EntityShape>();

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function shapeFor(entity: WeatherEntity): EntityShape {
  // The cosmetic shape must be stable across clones and independent of the
  // generated id; otherwise identical placements get different wind fields.
  const seed = entity.seed ?? hashString(`${entity.type}:${entity.x.toFixed(1)}:${entity.y.toFixed(1)}:${entity.radius}`);
  // Only the jet's cache key depends on its axis; adding a suffix to every
  // entity would change the cosmetic seed of the whole campaign.
  const key =
    entity.type === 'jet'
      ? `${seed.toFixed(6)}:jet:${entity.radius}:${(entity.angle ?? JET_DEFAULT_ANGLE).toFixed(3)}`
      : `${seed.toFixed(6)}:${entity.type}:${entity.radius}`;
  const cached = shapeCache.get(key);
  if (cached) return cached;

  const seedA = hashString(`${key}:a`);
  const seedB = hashString(`${key}:b`);
  const isPressure =
    entity.type === 'coldHigh' ||
    entity.type === 'warmHigh' ||
    entity.type === 'coldLow' ||
    entity.type === 'warmLow';
  const isTroughOrRidge = entity.type === 'trough' || entity.type === 'ridge';
  const anisotropy = isPressure ? PRESSURE_ANISOTROPY : SURFACE_ANISOTROPY;
  // Storms are axisymmetric; a wobbling elliptical eye would be nonsense.
  // A jet is a band, not a blob: 3.2:1 along its own axis, so it crosses the
  // chart like a real jet streak instead of covering a circular patch.
  const aspect =
    entity.type === 'typhoon'
      ? 1
      : entity.type === 'jet'
        ? 3.2
        : isTroughOrRidge
          ? 2.8
          : 1 + (seedA * 2 - 1) * anisotropy;
  const rx = entity.radius * Math.sqrt(aspect);
  const ry = entity.radius / Math.sqrt(aspect);
  const rotation =
    entity.type === 'typhoon'
      ? 0
      : entity.type === 'jet'
        ? (entity.angle ?? JET_DEFAULT_ANGLE)
        : seedB * Math.PI * 2;
  const shape: EntityShape = {
    rx,
    ry,
    cos: Math.cos(rotation),
    sin: Math.sin(rotation),
    phase: seedA * Math.PI * 2,
  };
  shapeCache.set(key, shape);
  return shape;
}

function pointInPolygon(points: Array<{ x: number; y: number }>, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const xi = points[i].x;
    const yi = points[i].y;
    const xj = points[j].x;
    const yj = points[j].y;
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function distanceToOutline(points: Array<{ x: number; y: number }>, x: number, y: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const ax = points[j].x;
    const ay = points[j].y;
    const bx = points[i].x;
    const by = points[i].y;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSq)) : 0;
    best = Math.min(best, Math.hypot(x - (ax + dx * t), y - (ay + dy * t)));
  }
  return best;
}

export function influenceAt(
  entity: WeatherEntity,
  x: number,
  y: number,
  profile: 'surface' | 'pressure' = 'surface',
): number {
  if (entity.type === 'typhoon') {
    return typhoonProfile(Math.hypot(x - entity.x, y - entity.y), entity.radius, 0, 0).pressure;
  }
  if (entity.shape && entity.shape.length >= 3) {
    const localX = x - entity.x;
    const localY = y - entity.y;
    const pressureEntity =
      entity.type === 'coldHigh' ||
      entity.type === 'warmHigh' ||
      entity.type === 'coldLow' ||
      entity.type === 'warmLow';
    if (pressureEntity) {
      const metrics = shapeMetrics(entity);
      if (metrics) {
        const cos = Math.cos(metrics.angle);
        const sin = Math.sin(metrics.angle);
        const along = localX * cos + localY * sin;
        const cross = -localX * sin + localY * cos;
        const headWidth = Math.max(42, entity.radius * 0.56);
        const tailDistance = metrics.elongated
          ? Math.min(entity.radius * 1.5, metrics.majorRadius * 0.88)
          : 0;
        const head = Math.exp(
          -((along * along) / (2 * headWidth * headWidth) +
            (cross * cross) / (2 * headWidth * headWidth)),
        );
        const tailAlong = along - tailDistance;
        const tailWidth = headWidth * 0.86;
        const tail = Math.exp(
          -((tailAlong * tailAlong) / (2 * tailWidth * tailWidth) +
            (cross * cross) / (2 * tailWidth * tailWidth)),
        );
        return Math.min(1.05, head + 0.36 * tail);
      }
    }
    if (pointInPolygon(entity.shape, localX, localY)) return 1;
    const distance = distanceToOutline(entity.shape, localX, localY);
    return Math.exp(-SURFACE_FALLOFF * (distance / Math.max(20, entity.radius)) ** 2);
  }

  const dx = x - entity.x;
  const dy = y - entity.y;
  const shape = shapeFor(entity);
  const localX = dx * shape.cos + dy * shape.sin;
  const localY = -dx * shape.sin + dy * shape.cos;
  const normalized = (localX * localX) / (shape.rx * shape.rx) + (localY * localY) / (shape.ry * shape.ry);
  const theta = Math.atan2(localY / shape.ry, localX / shape.rx);
  const wobble =
    1 +
    INFLUENCE_WOBBLE *
      (Math.sin(theta * 3 + shape.phase) + 0.62 * Math.sin(theta * 5 - shape.phase * 1.7));
  const isPressure =
    entity.type === 'coldHigh' ||
    entity.type === 'warmHigh' ||
    entity.type === 'coldLow' ||
    entity.type === 'warmLow';
  const falloff = isPressure ? PRESSURE_FALLOFF : SURFACE_FALLOFF;
  const pressureNormalized =
    isPressure && profile === 'pressure' ? Math.pow(normalized, 0.5) : normalized;
  return Math.exp(-falloff * pressureNormalized * Math.max(0.7, wobble));
}

/** Approximate visual/field boundary point for one angle around the entity. */
export function influenceBoundaryPoint(
  entity: WeatherEntity,
  angle: number,
  scale = 1,
): { x: number; y: number } {
  const shape = shapeFor(entity);
  const wobble =
    1 +
    INFLUENCE_WOBBLE *
      (Math.sin(angle * 3 + shape.phase) + 0.62 * Math.sin(angle * 5 - shape.phase * 1.7));
  const localX = Math.cos(angle) * shape.rx * scale * Math.sqrt(Math.max(0.72, wobble));
  const localY = Math.sin(angle) * shape.ry * scale * Math.sqrt(Math.max(0.72, wobble));
  return {
    x: entity.x + localX * shape.cos - localY * shape.sin,
    y: entity.y + localX * shape.sin + localY * shape.cos,
  };
}

/** Land mask for surface friction. It follows the same outline as the chart. */
export function isLandAt(x: number, y: number): boolean {
  return isLandPoint(x, y);
}

export interface FrontDiagnosis {
  type: FrontType;
  lift: number;
}

/**
 * Background moisture supplied by a locked surface source.
 *
 * A locked source is the sea/wetland itself, not a card: a warm sea holds more
 * vapour than a cold one.  Saturation vapour density follows Clausius–Clapeyron,
 * so the local SST scales the authored strength; the level's reference SST maps
 * to 1.0, preserving the campaign calibration while making warm water wetter.
 */
function sourceMoistureAt(
  entity: WeatherEntity,
  base: BaseConditions,
  x: number,
  y: number,
): number {
  const surface = sampleSurface(base, x, y);
  const center = sampleSurface(base, entity.x, entity.y);
  // Reference is the source's own surface temperature: the authored strength
  // is exact at the centre, while warmer/colder water inside its footprint
  // supplies proportionally more/less vapour (Clausius–Clapeyron).
  const reference = saturationVapourDensity(center.sst);
  const local = saturationVapourDensity(surface.sst);
  const scale = Math.max(0.6, Math.min(1.5, local / Math.max(1e-6, reference)));
  return entity.strength * scale;
}

/**
 * Low-level T and q built directly from the thermodynamic cards.
 *
 * θe = T + 273.15 + 2.5·q (K) is constructed here, not read from
 * PointWeather: `buildPointWeather` calls `frontAt`, so using the finished
 * point would close a cycle.  Only the cards that feed `sampleRaw`'s
 * tLow/qLow are used, so both samplers see the same column.
 */
function lowLevelTQAt(
  entities: WeatherEntity[],
  base: BaseConditions,
  x: number,
  y: number,
): { t: number; q: number } {
  let t = base.T;
  let q = base.Q;
  for (const entity of entities) {
    if (
      entity.type !== 'coldAir' &&
      entity.type !== 'warmAir' &&
      entity.type !== 'wet' &&
      entity.type !== 'typhoon'
    ) {
      continue;
    }
    const influence =
      entity.type === 'typhoon'
        ? pressureInfluence(entity, x, y, pressureOrientationFor(entity, entities))
        : influenceAt(entity, x, y);
    if (influence < 0.001) continue;
    if (entity.type === 'coldAir') t -= entity.strength * influence;
    else if (entity.type === 'warmAir') t += entity.strength * influence;
    else if (entity.type === 'wet') {
      q += (entity.locked ? sourceMoistureAt(entity, base, x, y) : entity.strength) * influence;
    }
    else {
      const distance = Math.hypot(x - entity.x, y - entity.y);
      const theta = Math.atan2(y - entity.y, x - entity.x);
      const profile = typhoonProfile(distance, entity.radius, theta, (entity.seed ?? 0) * Math.PI * 2);
      q += entity.strength * TYPHOON_MOISTURE_PER_HPA * profile.band;
      t += entity.strength * TYPHOON_WARM_CORE_PER_HPA * profile.pressure;
    }
  }
  return { t, q };
}

interface FrontFieldSample {
  /** Dry thermal gradient (K/km): the front normal points toward warm air. */
  gxT: number;
  gyT: number;
  /** |∇θe| (K/km): front intensity, heat and moisture folded together. */
  gradient: number;
}

/** ±8 km finite difference of the low-level θe and T fields. */
function frontFieldAt(
  entities: WeatherEntity[],
  base: BaseConditions,
  x: number,
  y: number,
): FrontFieldSample {
  const eps = kmToPx(diagnosticKm('temperatureGradient', base), base);
  const kmPerPx = kmPerPixel(base);
  const east = lowLevelTQAt(entities, base, Math.min(MAP_SIZE, x + eps), y);
  const west = lowLevelTQAt(entities, base, Math.max(0, x - eps), y);
  const south = lowLevelTQAt(entities, base, x, Math.min(MAP_SIZE, y + eps));
  const north = lowLevelTQAt(entities, base, x, Math.max(0, y - eps));
  const gxT = (east.t - west.t) / (2 * eps * kmPerPx);
  const gyT = (south.t - north.t) / (2 * eps * kmPerPx);
  const gxQ = (east.q - west.q) / (2 * eps * kmPerPx);
  const gyQ = (south.q - north.q) / (2 * eps * kmPerPx);
  const gx = gxT + 2.5 * gxQ;
  const gy = gyT + 2.5 * gyQ;
  return { gxT, gyT, gradient: Math.hypot(gx, gy) };
}

/** |∇θe| at a point (K/km). Shared by `frontAt` and the occlusion ageing. */
export function frontThetaEGradient(
  entities: WeatherEntity[],
  base: BaseConditions,
  x: number,
  y: number,
): number {
  return frontFieldAt(entities, base, x, y).gradient;
}

// ---------------------------------------------------------------------------
// SPRINT-3A / T4 · jet core speed from the thermal wind
// ---------------------------------------------------------------------------
/**
 * |∇T| in K/km on the SAME ±8 km, km-normalised stencil as `frontFieldAt`
 * (the single thermal-front sampler behind `frontAt`).  Pure dry temperature
 * gradient: a moisture-only gradient must NOT manufacture a jet out of a
 * thermally flat field.
 */
export function thermalGradientAt(
  entities: WeatherEntity[],
  base: BaseConditions,
  x: number,
  y: number,
): number {
  const field = frontFieldAt(entities, base, x, y);
  return Math.hypot(field.gxT, field.gyT);
}

/**
 * Scalar thermal-wind approximation of ∂V/∂z = −(g/fT) k×∇T integrated
 * over a fixed layer depth: V_jet = COEFF · |∇T|.  `frontFieldAt` already
 * divides by 2·eps·kmPerPixel with eps = kmToPx(diagnosticKm(...), base),
 * so ∇T is in K/km and chart-independent; the coefficient is therefore the
 * 1000 km baseline value (scaleNorm = 1000/domainScale = 1 there, exactly
 * the SPRINT-2B-R normalisation idea).  No card ⇒ no thermal gradient ⇒ 0.
 */
export function jetCoreSpeedAt(
  entities: WeatherEntity[],
  base: BaseConditions,
  x: number,
  y: number,
): number {
  return JET_THERMAL_WIND_COEFF * thermalGradientAt(entities, base, x, y);
}

/** The card supplies only position / axis / strength: a gain and a ceiling. */
export function jetCoreSpeedFor(
  entities: WeatherEntity[],
  base: BaseConditions,
  entity: WeatherEntity,
  x: number,
  y: number,
): number {
  const thermal = jetCoreSpeedAt(entities, base, x, y);
  const gain = Math.max(0, entity.strength) / 3;
  const cap = JET_MAX_CORE_PER_TIER * Math.max(0, entity.strength);
  return Math.min(thermal * gain, cap);
}

/**
 * Shared occlusion process gate.  An occlusion is a chase, not a placement:
 * a cold/warm low must have held its air-mass pair for FRONT_OCCLUSION_ROUNDS
 * rounds (frontAge, carried on the entity by cloneEntities) and the sample
 * point must be within FRONT_OCCLUSION_REACH low radii of it.
 *
 * `frontAt` (analytic) and `buildPhysicalPointWeather` / `samplePhysicalGrid`
 * (SWE) both call this, so enabling physics:'swe' does not silently disable
 * process-based occlusion.  The SWE temperature-field classifier itself is
 * left untouched: it has no notion of front age.
 */
function occlusionAt(entities: WeatherEntity[], x: number, y: number): boolean {
  for (const low of entities) {
    if (low.type !== 'coldLow' && low.type !== 'warmLow') continue;
    if ((low.frontAge ?? 0) < FRONT_OCCLUSION_ROUNDS) continue;
    if (Math.hypot(x - low.x, y - low.y) > low.radius * FRONT_OCCLUSION_REACH) continue;
    return true;
  }
  return false;
}

/**
 * The single front diagnosis.  Everything that used to be decided by the
 * occluded curve, the cyclone curve, the cold/warm pair strength gap and the
 * thermal-gradient fallback is now this one field function:
 *
 *   overlap      = max over cold×warm pairs of influence_cold · influence_warm
 *   Δθe          = coldStrength + warmStrength   (K, latent parts cancel)
 *   |∇θe|        = |∇(T + 2.5q)| over ±8 km    (K/km)
 *   sub-grid     = Δθe / FRONT_CONTRAST_LENGTH_KM · overlap  (stacked blobs)
 *   signal       = max(|∇θe|, sub-grid); below FRONT_GRADIENT_THRESHOLD = none
 *   movement     = wind·n̂ + FRONT_DENSITY_CURRENT·(cold−warm),
 *                  n̂ = ∇T/|∇T| (warm-ward); |movement| < STATIONARY_SPEED
 *                  is stationary, positive cold, negative warm
 *   lift         = FRONT_SEMANTICS[type].lift · shape · overlap^exp · signal/FULL
 *
 * An occlusion is a process, not a placement: a low that has held a cold/warm
 * pair with a sustained cold-side θe gradient for FRONT_OCCLUSION_ROUNDS
 * rounds (frontAge on the entity) reports 'occluded' with stationary×0.8 lift.
 */
export function frontAt(
  entities: WeatherEntity[],
  base: BaseConditions,
  x: number,
  y: number,
  wind: WindVector,
): FrontDiagnosis {
  // A front needs both air masses.  Most charts have neither, so avoid the
  // four-point θe stencil on every grid cell before doing any work.
  let hasCold = false;
  let hasWarm = false;
  for (const entity of entities) {
    if (entity.type === 'coldAir') hasCold = true;
    else if (entity.type === 'warmAir') hasWarm = true;
    if (hasCold && hasWarm) break;
  }
  if (!hasCold || !hasWarm) return { type: 'none', lift: 0 };

  let overlap = 0;
  let coldStrength = 0;
  let warmStrength = 0;
  for (const cold of entities) {
    if (cold.type !== 'coldAir') continue;
    const coldInfluence = influenceAt(cold, x, y);
    if (coldInfluence < 0.001) continue;
    for (const warm of entities) {
      if (warm.type !== 'warmAir') continue;
      const pairOverlap = coldInfluence * influenceAt(warm, x, y);
      if (pairOverlap > overlap) {
        overlap = pairOverlap;
        coldStrength = cold.strength;
        warmStrength = warm.strength;
      }
    }
  }
  if (overlap < FRONT_OVERLAP_MIN) return { type: 'none', lift: 0 };

  const field = frontFieldAt(entities, base, x, y);
  // When the two blobs sit on the same centre the ±8 km difference vanishes
  // at their common extremum.  Estimate the unresolved θe jump from the
  // parcel contrast spread over a frontal width, weighted by the overlap.
  const parcelContrast =
    ((coldStrength + warmStrength) * overlap) / FRONT_CONTRAST_LENGTH_KM;
  const gradient = Math.max(field.gradient, parcelContrast);
  if (gradient < FRONT_GRADIENT_THRESHOLD) return { type: 'none', lift: 0 };
  const gradFactor = Math.min(1, gradient / FRONT_GRADIENT_FULL);

  // Cold front has caught the warm front: the parent low has aged ≥2 rounds.
  // The SWE path calls the SAME gate, so an occlusion is a process on both
  // engines instead of a diagnosis the physical branch cannot express.
  if (occlusionAt(entities, x, y)) {
    return {
      type: 'occluded',
      lift: FRONT_SEMANTICS.occluded.lift * gradFactor,
    };
  }

  // Front movement = wind advection along the front normal plus the density
  // current of the denser air mass undercutting the warmer one.
  //
  // Unit derivation (SPRINT-2B-R / C-2).  `gradientWindAt` differences pLow
  // over 2*eps *pixels* (eps is a km window converted with kmToPx) and applies
  // the fixed WIND_GRADIENT_SCALE (hPa/px -> m/s).  For one and the same
  // physical pressure field the pixel gradient is
  //     dpdx [hPa/px] = G [hPa/km] * kmPerPixel(base) = G * domainScale/1000,
  // so the reported wind [m/s] scales with domainScale/1000.  Meanwhile
  // FRONT_STATIONARY_SPEED and FRONT_DENSITY_CURRENT are absolute m/s values.
  // Comparing a raw pixel-calibrated wind with those thresholds made the same
  // theta-e front read ~0.94 m/s on a 100 km chart and ~22.9 m/s on a 2000 km
  // chart, flipping `stationary` into `cold`.
  //
  // Normalise ONLY the advective term to the 1000 km baseline on which
  // WIND_GRADIENT_SCALE was tuned:
  //     scaleNorm = 1000 / domainScale = 1 / kmPerPixel(base)
  // (identical whenever domainScale is set, because kmPerPixel = domain/1000).
  // At domainScale === 1000 the factor is exactly 1, so the campaign baseline
  // is numerically unchanged.  Bases WITHOUT domainScale keep factor 1 as
  // well: their WIND_GRADIENT_SCALE was calibrated on the legacy 0.576 km/px
  // chart, and re-normalising them would re-tune already-solved levels for no
  // physical gain.
  //
  // The density-current term is deliberately NOT normalised: coldStrength and
  // warmStrength are physical degrees Celsius (chart-independent) and
  // FRONT_DENSITY_CURRENT is already m/s per degree, i.e. an absolute speed
  // with the same dimensions as FRONT_STATIONARY_SPEED.  Only the wind term
  // inherits the pixel calibration and needs the conversion.
  const frontDomain = base.domainScale && base.domainScale > 0 ? base.domainScale : 1000;
  const scaleNorm = 1000 / frontDomain;
  const thermalGradient = Math.hypot(field.gxT, field.gyT);
  const windAlong =
    thermalGradient > 1e-6
      ? ((wind.x * field.gxT + wind.y * field.gyT) / thermalGradient) * scaleNorm
      : 0;
  const movement =
    windAlong + FRONT_DENSITY_CURRENT * (coldStrength - warmStrength);
  const difference = coldStrength - warmStrength;
  const steepness = clamp(
    Math.abs(difference) / Math.max(1, coldStrength + warmStrength),
    0,
    1,
  );
  let type: Exclude<FrontType, 'none' | 'occluded'>;
  if (Math.abs(movement) < FRONT_STATIONARY_SPEED) type = 'stationary';
  else type = movement > 0 ? 'cold' : 'warm';
  const shape = 0.55 + 0.45 * steepness;
  const exponent = type === 'cold' ? 1.08 : type === 'warm' ? 0.82 : 0.98;
  const lift = FRONT_SEMANTICS[type].lift * shape * Math.pow(overlap, exponent) * gradFactor;
  return { type, lift };
}

function hasOpposingPressure(entity: WeatherEntity, entities: WeatherEntity[]): boolean {
  const isLow = entity.type === 'coldLow' || entity.type === 'warmLow';
  for (const other of entities) {
    if (other.id === entity.id) continue;
    if (
      other.type !== 'coldHigh' &&
      other.type !== 'warmHigh' &&
      other.type !== 'coldLow' &&
      other.type !== 'warmLow'
    ) {
      continue;
    }
    const otherLow = other.type === 'coldLow' || other.type === 'warmLow';
    if (otherLow === isLow) continue;
    if (Math.hypot(other.x - entity.x, other.y - entity.y) <= entity.radius * 4.2) return true;
  }
  return false;
}

interface TerrainSample {
  height: number;
  hx: number;
  hy: number;
  slope: number;
}

const terrainSampleCache = new Map<string, TerrainSample>();
let terrainWindCache = new Map<number, WindVector>();
/**
 * Cold-pool field cache. `windAt` adds the cold-pool outflow, so each wind
 * sample needs the pool gradient, and neighbouring samples share most of their
 * stencil.  Memoised per 2 px cell and dropped with the rest of the per-sample
 * caches whenever a snapshot is rebuilt.
 */
let coldPoolCache = new Map<number, number>();

/**
 * Position-only cache keys cannot notice that a card's strength changed (the
 * moisture budget does this every round) or that a pressure pair rotated, so a
 * stale pool could silently cancel the outflow.  A signature of the mutable
 * entity state is checked on every cache read instead of widening every key.
 */
function entityCacheSignature(entities: WeatherEntity[]): number {
  let hash = 2166136261;
  // Land/sea and the coastal thermal step depend on the chart prototype, so a
  // map switch must invalidate per-sample caches even when no card moved.
  const mapId = getActiveMap().id;
  for (let i = 0; i < mapId.length; i += 1) {
    hash = Math.imul(hash ^ mapId.charCodeAt(i), 16777619);
  }
  for (const entity of entities) {
    for (let i = 0; i < entity.type.length; i += 1) {
      hash = Math.imul(hash ^ entity.type.charCodeAt(i), 16777619);
    }
    hash = Math.imul(hash ^ Math.round(entity.strength * 1000), 16777619);
    hash = Math.imul(hash ^ Math.round(entity.x * 100), 16777619);
    hash = Math.imul(hash ^ Math.round(entity.y * 100), 16777619);
    hash = Math.imul(hash ^ Math.round(entity.radius * 100), 16777619);
    hash = Math.imul(hash ^ Math.round((entity.angle ?? 0) * 1000), 16777619);
    hash = Math.imul(hash ^ (entity.inversionMode === 'stable' ? 1 : 0), 16777619);
    // A maturing front changes wLow and therefore the cold-pool field.
    hash = Math.imul(hash ^ (entity.frontAge ?? 0), 16777619);
    if (entity.shape) {
      hash = Math.imul(hash ^ entity.shape.length, 16777619);
      for (const point of entity.shape) {
        hash = Math.imul(hash ^ Math.round(point.x * 100), 16777619);
        hash = Math.imul(hash ^ Math.round(point.y * 100), 16777619);
      }
    }
  }
  return hash >>> 0;
}

let cacheEntitySignature = 0;

function clearPerSampleCaches(): void {
  terrainWindCache = new Map();
  coldPoolCache = new Map();
  cacheEntitySignature = 0;
  // Every field build starts a new derived-value epoch for pressure.ts.
  bumpPressurePass();
}

/**
 * Public reset for callers that sample an already-built snapshot, e.g. tests
 * and hover diagnostics reading `after.entities` directly.  `simulateRound`
 * calls it once at entry; `buildPointWeather` / `buildGrid` keep their own
 * per-snapshot clears.
 */
export function resetFieldCaches(): void {
  clearPerSampleCaches();
}

function ensureCacheState(entities: WeatherEntity[]): void {
  const signature = entityCacheSignature(entities);
  if (signature === cacheEntitySignature) return;
  clearPerSampleCaches();
  cacheEntitySignature = signature;
}

function terrainSampleAt(
  x: number,
  y: number,
  profile: BaseConditions['terrainProfile'] = 'default',
): TerrainSample {
  const key = `${profile}:${Math.round(x * 4)}:${Math.round(y * 4)}`;
  const cached = terrainSampleCache.get(key);
  if (cached) return cached;
  const heightRaw = elevationAt(x, y, profile);
  const eps = 64;
  const hE = elevationAt(x + eps, y, profile);
  const hW = elevationAt(x - eps, y, profile);
  const hS = elevationAt(x, y + eps, profile);
  const hN = elevationAt(x, y - eps, profile);
  // Broad five-point low-pass: the terrain pressure field must not carry
  // mountain-edge harmonics into the 2 hPa isobars.
  const height = (heightRaw * 4 + hE + hW + hS + hN) / 8;
  const hx = (hE - hW) / (2 * eps);
  const hy = (hS - hN) / (2 * eps);
  const sample = { height, hx, hy, slope: Math.hypot(hx, hy) };
  if (terrainSampleCache.size > 200000) terrainSampleCache.clear();
  terrainSampleCache.set(key, sample);
  return sample;
}

/** Large-scale wind used only for the terrain pressure perturbation. */
function terrainWindAt(
  entities: WeatherEntity[],
  base: BaseConditions,
  x: number,
  y: number,
): WindVector {
  ensureCacheState(entities);
  const key = Math.round(x / 18) * 4096 + Math.round(y / 18);
  const cached = terrainWindCache.get(key);
  if (cached) return cached;
  const eps = 10;
  const east = pressureAt(entities, base, Math.min(MAP_SIZE, x + eps), y, influenceAt);
  const west = pressureAt(entities, base, Math.max(0, x - eps), y, influenceAt);
  const south = pressureAt(entities, base, x, Math.min(MAP_SIZE, y + eps), influenceAt);
  const north = pressureAt(entities, base, x, Math.max(0, y - eps), influenceAt);
  const wind = windVectorFromGradient(
    (east - west) / (2 * eps),
    (south - north) / (2 * eps),
    base.hemisphere,
    1,
  );
  terrainWindCache.set(key, wind);
  return wind;
}

/**
 * Apply the terrain pressure perturbation to the diagnostic pressure field:
 * windward ridging / lee troughing, plus the daytime land-sea thermal contrast.
 * This used to be computed and then discarded; it is now part of pLow so the
 * isobars, the gradient wind and the station pressure all see the same field.
 */
function terrainPressureAt(
  entities: WeatherEntity[],
  base: BaseConditions,
  x: number,
  y: number,
  pressure: number,
): number {
  if (!base.hasTerrain) return pressure;
  let result = pressure;
  const { height, hx, hy, slope } = terrainSampleAt(x, y, base.terrainProfile);
  const heightMask = smoothstep(60, 200, height);
  const slopeMask = smoothstep(0.04, 0.14, slope);
  if (heightMask > 0 && slopeMask > 0) {
    const wind = terrainWindAt(entities, base, x, y);
    if (wind.speed > 0.3) {
      const upslope = (wind.x * hx + wind.y * hy) / (wind.speed * slope);
      const amplitude = heightMask * slopeMask;
      if (upslope > 0) {
        result += TERRAIN_WINDWARD_P * Math.tanh(upslope * 1.2) * amplitude;
      } else {
        result -= TERRAIN_LEE_P * Math.tanh(-upslope * 1.2) * amplitude;
      }
    }
  }

  // Smooth, wide land/sea thermal transition. A hard 26 px clamp put a slope
  // discontinuity on every coastline crossing, which printed wiggles on the
  // isobars; tanh spreads the same 1 hPa contrast over ~100 px.
  const coastal = Math.tanh(signedCoastDistance(x, y) / 55);
  const daytime = base.timeOfDay !== 'night';
  result += (daytime ? -coastal : coastal) * TERRAIN_THERMAL_P;
  return result;
}

function sampleRaw(
  entities: WeatherEntity[],
  base: BaseConditions,
  x: number,
  y: number,
  front: FrontDiagnosis = { type: 'none', lift: 0 },
): RawPoint {
  // Station temperature is no longer uniform: it carries a latitude + altitude
  // correction from the same surface field the renderer draws.  Entity effects
  // (air masses, warm core, cold pool) are added on top of this baseline.
  let tLow = base.T + surfaceTemperatureCorrection(base, x, y);
  let qLow = base.Q;
  let wLow = 0;
  let pressureW = 0;
  let pHigh = 0;
  let wHigh = 0;
  let stability = 0;
  let deepLow = false;
  let typhoonLift = 0;
  let midDelta = 0;

  for (const entity of entities) {
    let influence = influenceAt(entity, x, y);
    if (
      entity.type === 'coldHigh' ||
      entity.type === 'warmHigh' ||
      entity.type === 'coldLow' ||
      entity.type === 'warmLow' ||
      entity.type === 'typhoon'
    ) {
      // Keep the vertical-motion / front influence consistent with the
      // pressure field: pressureAt() always uses the pressure profile.
      influence = pressureInfluence(entity, x, y, pressureOrientationFor(entity, entities));
    }
    if (influence < 0.001) continue;

    switch (entity.type) {
      case 'coldHigh':
      case 'warmHigh':
        pressureW -= entity.strength * HIGH_SINK_PER_HPA * influence;
        wLow = pressureW;
        break;
      case 'coldLow':
      case 'warmLow':
        pressureW += entity.strength * LOW_LIFT_PER_HPA * influence;
        wLow = pressureW;
        if (entity.type === 'coldLow' && influence > 0.1) deepLow = true;
        break;
      case 'typhoon': {
        const distance = Math.hypot(x - entity.x, y - entity.y);
        const theta = Math.atan2(y - entity.y, x - entity.x);
        const profile = typhoonProfile(distance, entity.radius, theta, (entity.seed ?? 0) * Math.PI * 2);
        // The storm is a weak surface low; its vertical motion comes from the
        // eyewall ring, not from the generic LOW_LIFT_PER_HPA rule.
        pressureW += entity.strength * 0.02 * influence;
        typhoonLift +=
          entity.strength * TYPHOON_LIFT_PER_HPA * profile.ring -
          entity.strength * TYPHOON_EYE_SINK_PER_HPA * profile.eye;
        // A tropical cyclone carries its own moisture in the spiral bands.
        qLow += entity.strength * TYPHOON_MOISTURE_PER_HPA * profile.band;
        tLow += entity.strength * TYPHOON_WARM_CORE_PER_HPA * profile.pressure;
        wHigh += entity.strength * TYPHOON_HIGH_DIVERGENCE_PER_HPA * profile.pressure;
        pHigh += entity.strength * 0.35 * profile.pressure;
        break;
      }
      case 'coldAir':
        tLow -= entity.strength * influence;
        break;
      case 'warmAir':
        tLow += entity.strength * influence;
        break;
      case 'wet':
        qLow += (entity.locked ? sourceMoistureAt(entity, base, x, y) : entity.strength) * influence;
        break;
      case 'inversion':
        stability +=
          (entity.inversionMode === 'stable' ? -1 : 1) * entity.strength * influence;
        // A stable "warm above cold" layer is exactly the warm nose that
        // turns snow into freezing rain.
        midDelta +=
          (entity.inversionMode === 'stable' ? 1 : -1) *
          entity.strength *
          MID_LAYER_TEMPERATURE_GAIN *
          influence;
        break;
      case 'trough':
        pHigh -= TROUGH_HIGH_P_DROP * entity.strength * influence;
        wHigh += TROUGH_HIGH_LIFT * entity.strength * influence;
        break;
      case 'ridge':
        pHigh += RIDGE_HIGH_P_GAIN * entity.strength * influence;
        wHigh -= RIDGE_HIGH_SINK * entity.strength * influence;
        break;
      case 'jet': {
        // T4: the jet's core speed is a thermal-wind response, not a card
        // constant.  A thermally flat column (∇T = 0) cannot spin up a jet,
        // so neither the mean ascent nor the four-quadrant forcing appears.
        const core = jetCoreSpeedFor(entities, base, entity, x, y);
        const response = core / JET_REFERENCE_CORE_SPEED;
        wHigh += JET_HIGH_W * response * entity.strength * influence;
        // Four-quadrant jet dynamics: left exit and right entrance diverge
        // (ascent), right exit and left entrance converge (subsidence).  This
        // is what lets a jet trigger a surface low instead of only steering it.
        const axis = entity.angle ?? JET_DEFAULT_ANGLE;
        const along = (x - entity.x) * Math.cos(axis) + (y - entity.y) * Math.sin(axis);
        const across = -(x - entity.x) * Math.sin(axis) + (y - entity.y) * Math.cos(axis);
        const exit = along > 0;
        const left = across < 0;
        const divergent = (exit && left) || (!exit && !left);
        wHigh +=
          (divergent ? 1 : -1) *
          JET_EXIT_LIFT *
          response *
          entity.strength *
          influence *
          Math.min(1, Math.abs(along) / Math.max(1, entity.radius));
        break;
      }
    }

    if (entity.type === 'coldHigh' || entity.type === 'warmHigh') {
      if (entity.depth === 'shallow') {
        pHigh += entity.strength * SHALLOW_HIGH_P_GAIN * influence;
        wHigh -= entity.strength * SHALLOW_HIGH_W * influence;
      } else {
        pHigh += entity.strength * HIGH_P_GAIN * influence;
        wHigh -= entity.strength * HIGH_W_SINK_PER_HPA * influence;
      }
    } else if (entity.type === 'coldLow' || entity.type === 'warmLow') {
      if (entity.depth === 'shallow') {
        pHigh += entity.strength * SHALLOW_HIGH_P_GAIN * 0.5 * influence;
        wHigh += entity.strength * SHALLOW_HIGH_W * influence;
      } else {
        pHigh -= entity.strength * HIGH_P_GAIN * influence;
        wHigh += entity.strength * HIGH_W_LIFT_PER_HPA * influence;
      }
    }
  }

  // Eyewall ascent / eye subsidence is applied after the loop so a later
  // pressure card cannot overwrite it through the legacy `wLow = pressureW`.
  wLow += typhoonLift;

  for (const entity of entities) {
    if (!entity.shape) continue;
    const metrics = shapeMetrics(entity);
    if (!metrics || (!metrics.isTrough && !metrics.isRidge)) continue;
    const influence = influenceAt(entity, x, y);
    if (influence < 0.04) continue;
    const dx = x - entity.x;
    const dy = y - entity.y;
    const cos = Math.cos(metrics.angle);
    const sin = Math.sin(metrics.angle);
    const along = dx * cos + dy * sin;
    const across = -dx * sin + dy * cos;
    if (Math.abs(along) > entity.radius * 1.15 || Math.abs(across) > 26) continue;
    wLow += (metrics.isTrough ? SHAPE_FEATURE_LIFT : -SHAPE_FEATURE_LIFT) * Math.min(1, influence * 1.8);
  }

  // Front diagnosis is injected by the caller: `frontAt` is the only entry,
  // and `sampleRaw` must not call it because `windAt` (which supplies the
  // wind to `frontAt`) samples this very function for its gradients.
  wLow += front.lift;

  return {
    pLow: terrainPressureAt(
      entities,
      base,
      x,
      y,
      pressureAt(entities, base, x, y, influenceAt),
    ),
    tLow,
    qLow,
    wLow: Math.max(-MAX_VERTICAL_VELOCITY, Math.min(MAX_VERTICAL_VELOCITY, wLow)),
    pressureW: Math.max(-MAX_VERTICAL_VELOCITY, Math.min(MAX_VERTICAL_VELOCITY, pressureW)),
    pHigh: highPressureAt(entities, x, y),
    wHigh: Math.max(-MAX_VERTICAL_VELOCITY, Math.min(MAX_VERTICAL_VELOCITY, wHigh)),
    frontType: front.type,
    frontLift: front.lift,
    stability,
    midTemperature: base.T + midDelta,
    warmNose: midDelta,
    deepLow,
  };
}

export function verticalContributions(
  entities: WeatherEntity[],
  x: number,
  y: number,
): VerticalContribution[] {
  const contributions: VerticalContribution[] = [];
  for (const entity of entities) {
    if (
      entity.type !== 'coldHigh' &&
      entity.type !== 'warmHigh' &&
      entity.type !== 'coldLow' &&
      entity.type !== 'warmLow'
    ) {
      continue;
    }
    const influence = hasOpposingPressure(entity, entities)
      ? influenceAt(entity, x, y)
      : pressureInfluence(entity, x, y, pressureOrientationFor(entity, entities));
    if (influence < 0.01) continue;
    const isLow = entity.type === 'coldLow' || entity.type === 'warmLow';
    const value = isLow
      ? entity.strength * LOW_LIFT_PER_HPA * influence
      : -entity.strength * HIGH_SINK_PER_HPA * influence;
    const highValue =
      entity.depth === 'shallow'
        ? entity.strength * SHALLOW_HIGH_W * influence * (isLow ? 1 : -1)
        : isLow
          ? entity.strength * HIGH_W_LIFT_PER_HPA * influence
          : -entity.strength * HIGH_W_SINK_PER_HPA * influence;
    contributions.push({ entity, influence, value, highValue });
  }
  return contributions.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
}

/**
 * `towardDeg` follows the internal screen convention: 0° = east, 90° = south
 * (atan2(vy, vx), +y is south). The compass is north-based and clockwise, so a
 * +90° conversion is required before indexing COMPASS.
 */
function compassBearingOfToward(towardDeg: number): number {
  return (((towardDeg + 90) % 360) + 360) % 360;
}

function compassBearingOfFrom(towardDeg: number): number {
  return (((towardDeg + 270) % 360) + 360) % 360;
}

export function compassLabelFromToward(towardDeg: number): string {
  const bearing = compassBearingOfToward(towardDeg);
  return COMPASS[Math.round(bearing / 45) % 8];
}

function windFromVector(vx: number, vy: number, maxSpeed: number): WindVector {
  const speed = Math.min(maxSpeed, Math.hypot(vx, vy));
  if (speed < 0.05) {
    return {
      x: 0,
      y: 0,
      speed: 0,
      towardDeg: 0,
      fromDeg: 0,
      fromLabel: '静风',
      beaufort: 0,
    };
  }
  const ux = vx / Math.hypot(vx, vy);
  const uy = vy / Math.hypot(vx, vy);
  const towardDeg = ((Math.atan2(uy, ux) * 180) / Math.PI + 360) % 360;
  const fromDeg = compassBearingOfFrom(towardDeg);
  return {
    x: ux * speed,
    y: uy * speed,
    speed,
    towardDeg,
    fromDeg,
    fromLabel: COMPASS[Math.round(fromDeg / 45) % 8],
    beaufort: beaufortFromSpeed(speed),
  };
}

export function windVectorFromGradient(
  dpdx: number,
  dpdy: number,
  hemisphere: Hemisphere = 'N',
  friction = 1,
  crossIsobarDeg = 90 - CORIOLIS_DEFLECTION_DEG,
): WindVector {
  const hx = -dpdx;
  const hy = -dpdy;
  const gradientMagnitude = Math.hypot(hx, hy);
  const speed = Math.min(MAX_WIND_SPEED, gradientMagnitude * WIND_GRADIENT_SCALE * friction);

  if (speed < 0.05 || gradientMagnitude < 0.000001) {
    return {
      x: 0,
      y: 0,
      speed: 0,
      towardDeg: 0,
      fromDeg: 0,
      fromLabel: '静风',
      beaufort: 0,
    };
  }

  const directionX = hx / gradientMagnitude;
  const directionY = hy / gradientMagnitude;
  const deflection = ((90 - crossIsobarDeg) * Math.PI) / 180;
  const sign = hemisphere === 'N' ? 1 : -1;
  const vx = directionX * Math.cos(deflection * sign) - directionY * Math.sin(deflection * sign);
  const vy = directionX * Math.sin(deflection * sign) + directionY * Math.cos(deflection * sign);
  const towardDeg = ((Math.atan2(vy, vx) * 180) / Math.PI + 360) % 360;
  const fromDeg = compassBearingOfFrom(towardDeg);
  const fromLabel = COMPASS[Math.round(fromDeg / 45) % 8];

  return {
    x: vx * speed,
    y: vy * speed,
    speed,
    towardDeg,
    fromDeg,
    fromLabel,
    beaufort: beaufortFromSpeed(speed),
  };
}

export function beaufortFromSpeed(speed: number): number {
  const limits = [0.3, 1.6, 3.4, 5.5, 8, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
  let level = 0;
  for (const limit of limits) {
    if (speed >= limit) level += 1;
  }
  return level;
}

function terrainWindVector(
  wind: WindVector,
  x: number,
  y: number,
  base: BaseConditions,
): WindVector {
  if (!base.hasTerrain) return wind;
  const height = elevationAt(x, y, base.terrainProfile);
  if (height < 100) return wind;
  const eps = 8;
  const hx =
    (elevationAt(x + eps, y, base.terrainProfile) -
      elevationAt(x - eps, y, base.terrainProfile)) /
    (2 * eps);
  const hy =
    (elevationAt(x, y + eps, base.terrainProfile) -
      elevationAt(x, y - eps, base.terrainProfile)) /
    (2 * eps);
  const slope = Math.hypot(hx, hy);
  if (slope < 0.08 || wind.speed < 0.05) return wind;
  const nx = hx / slope;
  const ny = hy / slope;
  const into = wind.x * nx + wind.y * ny;
  let vx = wind.x;
  let vy = wind.y;

  if (into > 0) {
    const side = base.hemisphere === 'N' ? 1 : -1;
    const tx = -ny * side;
    const ty = nx * side;
    vx = vx - nx * into * 0.55 + tx * into * 0.42;
    vy = vy - ny * into * 0.55 + ty * into * 0.42;
  } else {
    vx *= 1.06;
    vy *= 1.06;
  }
  return windFromVector(vx, vy, MAX_WIND_SPEED);
}

export type SurfaceKind = 'sea' | 'land' | 'mountain';

export function surfaceKindAt(base: BaseConditions, x: number, y: number): SurfaceKind {
  if (base.hasTerrain && elevationAt(x, y, base.terrainProfile) > 100) return 'mountain';
  return isLandAt(x, y) ? 'land' : 'sea';
}

/** Strongest surface wind on a ring around a pressure centre, m/s. */
export function maxWindAround(
  entities: WeatherEntity[],
  base: BaseConditions,
  entity: WeatherEntity,
): number {
  const ratio = entity.type === 'typhoon' ? 0.45 : 0.7;
  const radius = entity.radius * ratio;
  let best = 0;
  for (let index = 0; index < 8; index += 1) {
    const angle = (index / 8) * Math.PI * 2;
    const wind = windAt(
      entities,
      base,
      Math.max(0, Math.min(MAP_SIZE, entity.x + Math.cos(angle) * radius)),
      Math.max(0, Math.min(MAP_SIZE, entity.y + Math.sin(angle) * radius)),
    );
    if (wind.speed > best) best = wind.speed;
  }
  return best;
}

export function crossIsobarAngleFor(surface: SurfaceKind): number {
  if (surface === 'sea') return CROSS_ISOBAR_SEA_DEG;
  if (surface === 'land') return CROSS_ISOBAR_LAND_DEG;
  return CROSS_ISOBAR_MOUNTAIN_DEG;
}

/**
 * Roughness → surface drag, continuously.
 *
 * The discrete sea/land/mountain classes stay as the fallback so stages 3–6
 * are untouched.  Surface levels instead interpolate between the sea and
 * mountain anchors in log10(z0), which lets a plain, a forest and a ridge all
 * differ without inventing a new class.
 */
export function frictionProfileFor(
  base: BaseConditions,
  x: number,
  y: number,
): { angle: number; friction: number } {
  const surface = surfaceKindAt(base, x, y);
  if (!base.surface) {
    const friction = base.hasTerrain
      ? surface === 'mountain'
        ? MOUNTAIN_FRICTION
        : surface === 'land'
          ? LAND_FRICTION
          : 1
      : BASE_FRICTION;
    return { angle: crossIsobarAngleFor(surface), friction };
  }

  const roughness = sampleSurface(base, x, y).roughness;
  const lo = Math.log10(0.0002);
  const hi = Math.log10(0.5);
  const t = Math.max(0, Math.min(1, (Math.log10(Math.max(roughness, 1e-6)) - lo) / (hi - lo)));
  const angle =
    CROSS_ISOBAR_SEA_DEG + t * (CROSS_ISOBAR_MOUNTAIN_DEG - CROSS_ISOBAR_SEA_DEG);
  const seaFriction = base.hasTerrain ? 1 : BASE_FRICTION;
  const landFriction = base.hasTerrain ? MOUNTAIN_FRICTION : BASE_FRICTION;
  return { angle, friction: seaFriction + t * (landFriction - seaFriction) };
}

/**
 * Pressure-gradient wind before any cold-pool outflow.
 *
 * Kept separate because the cold pool is derived from the rain, which is
 * derived from the moisture flux, which is derived from the wind: letting the
 * outflow back into the flux sampler would close that loop. The moisture
 * transport that feeds a storm is the pressure-driven flow; the outflow is a
 * surface consequence of the rain it produces.
 */
function gradientWindAt(
  entities: WeatherEntity[],
  base: BaseConditions,
  x: number,
  y: number,
): WindVector {
  const eps = kmToPx(diagnosticKm('temperatureAdvection', base), base);
  const east = sampleRaw(entities, base, Math.min(MAP_SIZE, x + eps), y).pLow;
  const west = sampleRaw(entities, base, Math.max(0, x - eps), y).pLow;
  const south = sampleRaw(entities, base, x, Math.min(MAP_SIZE, y + eps)).pLow;
  const north = sampleRaw(entities, base, x, Math.max(0, y - eps)).pLow;
  const dpdx = (east - west) / (2 * eps);
  const dpdy = (south - north) / (2 * eps);
  const { friction, angle } = frictionProfileFor(base, x, y);
  return terrainWindVector(
    windVectorFromGradient(dpdx, dpdy, base.hemisphere, friction, angle),
    x,
    y,
    base,
  );
}

export function windAt(
  entities: WeatherEntity[],
  base: BaseConditions,
  x: number,
  y: number,
): WindVector {
  if (isPhysicalBase(base)) {
    const sample = getPhysicalField(entities, base).sampleScreen(x, y);
    return windFromVector(sample.u, -sample.v, MAX_REPORTED_WIND);
  }
  const wind = gradientWindAt(entities, base, x, y);
  // The cold pool is a real surface wind: cold air runs down its own thickness
  // gradient, so the gust front under a downburst shows up in every diagnostic
  // that reads the wind field (shear, convergence, moisture drift, HUD arrows).
  const outflow = coldPoolOutflow(entities, base, x, y);
  if (outflow.vx === 0 && outflow.vy === 0) return wind;
  return windFromVector(wind.x + outflow.vx, wind.y + outflow.vy, MAX_WIND_SPEED);
}

export function highWindAt(
  entities: WeatherEntity[],
  base: BaseConditions,
  x: number,
  y: number,
): WindVector {
  const eps = kmToPx(diagnosticKm('highWind', base), base);
  const east = sampleRaw(entities, base, Math.min(MAP_SIZE, x + eps), y).pHigh;
  const west = sampleRaw(entities, base, Math.max(0, x - eps), y).pHigh;
  const south = sampleRaw(entities, base, x, Math.min(MAP_SIZE, y + eps)).pHigh;
  const north = sampleRaw(entities, base, x, Math.max(0, y - eps)).pHigh;
  const dpdx = (east - west) / (2 * eps);
  const dpdy = (south - north) / (2 * eps);
  const baseVector = windVectorFromGradient(
    dpdx * 0.32,
    dpdy * 0.32,
    base.hemisphere,
    1,
  );
  let vx = baseVector.x;
  let vy = baseVector.y;
  const thermalCore = entities.some((entity) => entity.type === 'jet')
    ? jetCoreSpeedAt(entities, base, x, y)
    : 0;
  for (const entity of entities) {
    if (entity.type !== 'jet') continue;
    const influence = influenceAt(entity, x, y);
    if (influence < 0.01) continue;
    const angle = entity.angle ?? JET_DEFAULT_ANGLE;
    const core = Math.min(
      thermalCore * (Math.max(0, entity.strength) / 3),
      JET_MAX_CORE_PER_TIER * Math.max(0, entity.strength),
    );
    const force = core * influence * JET_STEERING_SCALE;
    vx += force * Math.cos(angle);
    vy += force * Math.sin(angle);
  }
  const speedScale = vx === 0 && vy === 0 ? 1 : Math.min(1, MAX_HIGH_WIND_SPEED / Math.max(1, Math.hypot(vx, vy)));
  return windFromVector(vx * speedScale, vy * speedScale, MAX_HIGH_WIND_SPEED);
}

/** Combined low-level wind + upper-level steering vector for moisture drift. */
export function motionWindAt(
  entities: WeatherEntity[],
  base: BaseConditions,
  x: number,
  y: number,
): WindVector {
  if (isPhysicalBase(base)) return windAt(entities, base, x, y);
  const low = windAt(entities, base, x, y);
  const high = highWindAt(entities, base, x, y);
  return windFromVector(low.x + STEERING_FACTOR * high.x, low.y + STEERING_FACTOR * high.y, MAX_WIND_SPEED);
}

function applyInversion(wLow: number, stability: number): number {
  if (wLow <= 0) return wLow;
  if (stability > 0.04) return wLow * INVERSION_UNSTABLE_MULTIPLIER;
  if (stability < -0.04) return wLow * INVERSION_STABLE_MULTIPLIER;
  return wLow;
}

function orographicLift(
  x: number,
  y: number,
  wind: WindVector,
  base: BaseConditions,
): number {
  const height = elevationAt(x, y, base.terrainProfile);
  if (height < 120 || wind.speed < 0.3) return 0;
  const eps = 6;
  const hx =
    (elevationAt(x + eps, y, base.terrainProfile) -
      elevationAt(x - eps, y, base.terrainProfile)) /
    (2 * eps);
  const hy =
    (elevationAt(x, y + eps, base.terrainProfile) -
      elevationAt(x, y - eps, base.terrainProfile)) /
    (2 * eps);
  const slope = Math.hypot(hx, hy);
  if (slope < 0.15) return 0;
  const ux = wind.x / wind.speed;
  const uy = wind.y / wind.speed;
  const upslope = (ux * hx + uy * hy) / slope;
  return clamp(upslope * OROGRAPHIC_LIFT * Math.min(1, height / 900), -2, 2);
}

function convectiveLevel(w: number): number {
  if (w >= 10) return 3;
  if (w >= 8) return 2;
  if (w >= 5) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// SPRINT-3A / T2 · one cloud-top function for BOTH engines
// ---------------------------------------------------------------------------
export interface CloudTopProfile {
  /** Vertical velocity in game units (W). */
  w: number;
  /** Surface temperature, °C. */
  surfaceT: number;
  /** Surface vapour density, g/m³. */
  surfaceQ: number;
  /** Mid-level temperature including the inversion warm nose, °C. */
  midT: number;
  /** Inversion-created warm-nose anomaly, °C. */
  warmNose: number;
}

/**
 * Cloud top (km) from a three-level equivalent-potential-temperature sounding.
 *
 * θe(z) in K, with the 273.15 K offset cancelling in every difference:
 *   surface  θe_s = T + 2.5·q
 *   mid      θe_m = midT + 2.5·q·0.55          (warm nose lives in midT)
 *   upper    θe_h = (T − 6.5·6 km) + 2.5·q·0.25 (standard lapse rate)
 *
 * The W-driven kinematic top 2 + 0.8·W is stretched by the θe lapse
 * (θe_s − θe_h, i.e. potential instability) and capped by a mid-level warm
 * nose.  The result can never sit below the 0 °C level T/6.5 km, which is
 * the physical floor for a raining convective cloud.  W >= 10 still reaches
 * cloudTop >= 10 km, so the hail gate stays reachable; the W >= 8
 * thunderstorm gate never reads cloudTop and is unaffected.
 */
export function cloudTopFromProfile(profile: CloudTopProfile): number {
  const w = Math.max(0, profile.w);
  const q = Math.max(0, profile.surfaceQ);
  const thetaESurface = profile.surfaceT + CLOUD_TOP_THETA_E_LATENT * q;
  const thetaEMid =
    profile.midT + CLOUD_TOP_THETA_E_LATENT * q * CLOUD_TOP_MID_Q_FRACTION;
  const thetaEHigh =
    profile.surfaceT -
    CLOUD_TOP_LAPSE_RATE * CLOUD_TOP_HIGH_Z_KM +
    CLOUD_TOP_THETA_E_LATENT * q * CLOUD_TOP_HIGH_Q_FRACTION;
  const instability = clamp(
    (thetaESurface - thetaEHigh) / CLOUD_TOP_THETA_E_DROP_REFERENCE,
    0,
    1.5,
  );
  const warmNoseCap = clamp(
    (thetaEMid - thetaESurface + Math.max(0, profile.warmNose)) /
      CLOUD_TOP_THETA_E_DROP_REFERENCE,
    0,
    1,
  );
  const convectiveTop =
    (2 + 0.8 * w) *
    (1 + CLOUD_TOP_THETA_E_GAIN * instability) *
    (1 - CLOUD_TOP_WARM_NOSE_GAIN * warmNoseCap);
  // 0 °C level: surface T divided by the standard lapse rate.
  const freezingLevel = clamp(
    profile.surfaceT / CLOUD_TOP_LAPSE_RATE,
    0,
    CLOUD_TOP_MAX_KM,
  );
  return clamp(
    Math.max(convectiveTop, freezingLevel),
    0,
    CLOUD_TOP_MAX_KM,
  );
}

function hazardFor(
  W: number,
  cloudTop: number,
  tLow: number,
  qLow: number,
  qSat: number,
  wind: WindVector,
  stability: number,
  deepLow: boolean,
  land: boolean,
  rainRate: number,
  warmNose: number,
): HazardType {
  // Hail is a strong-updraft phenomenon. The deep-low branch still requires a
  // genuinely cold low-level air mass (the original "cold air is present"
  // signal), while the instability branch allows warm-season hail without a
  // -5°C surface. This keeps the level logic and removes the old "only cold
  // surface can hail" rule.
  if (W >= 10 && cloudTop >= 10 && (stability > 0.05 || (deepLow && tLow <= -5))) return 'hail';
  if (W >= 8) return 'thunderstorm';
  // Freezing rain: liquid aloft (warm nose), sub-zero at the surface.
  if (
    rainRate > 0.01 &&
    tLow <= FREEZING_RAIN_SURFACE_T &&
    warmNose >= FREEZING_RAIN_WARM_NOSE &&
    baseMidEnough(tLow, warmNose)
  ) {
    return 'freezingRain';
  }
  if (W <= 0.5 && qLow >= qSat * 0.93 && wind.beaufort <= 2 && stability < -0.05) return 'fog';
  if (qLow < 5 && wind.beaufort >= 4 && land) return 'dust';
  return 'none';
}

function baseMidEnough(tLow: number, warmNose: number): boolean {
  // The warm nose must lift the mid-level parcel above freezing while the
  // surface stays sub-zero; an already-warm base alone is not enough.
  return tLow + warmNose >= FREEZING_RAIN_MID_T;
}

function angularDifference(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function shearAt(
  entities: WeatherEntity[],
  base: BaseConditions,
  x: number,
  y: number,
): number {
  const eps = kmToPx(diagnosticKm('shear', base), base);
  const samples = [
    windAt(entities, base, x + eps, y),
    windAt(entities, base, x, y + eps),
    windAt(entities, base, x - eps, y),
    windAt(entities, base, x, y - eps),
  ];
  let max = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const a = samples[index];
    const b = samples[(index + 1) % samples.length];
    if (a.speed < 0.4 || b.speed < 0.4) continue;
    max = Math.max(max, angularDifference(a.towardDeg, b.towardDeg));
  }
  return max;
}

function drylineAt(
  entities: WeatherEntity[],
  base: BaseConditions,
  x: number,
  y: number,
): number {
  const eps = kmToPx(diagnosticKm('dryline', base), base);
  const east = sampleRaw(entities, base, Math.min(MAP_SIZE, x + eps), y).qLow;
  const west = sampleRaw(entities, base, Math.max(0, x - eps), y).qLow;
  const south = sampleRaw(entities, base, x, Math.min(MAP_SIZE, y + eps)).qLow;
  const north = sampleRaw(entities, base, x, Math.max(0, y - eps)).qLow;
  // g/m³ per km, matching the threshold's physical units.
  return (
    (Math.abs(east - west) + Math.abs(south - north)) /
    (4 * eps * kmPerPixel(base))
  );
}

function convergenceAt(
  entities: WeatherEntity[],
  base: BaseConditions,
  x: number,
  y: number,
): number {
  const eps = kmToPx(diagnosticKm('convergence', base), base);
  const east = windAt(entities, base, Math.min(MAP_SIZE, x + eps), y);
  const west = windAt(entities, base, Math.max(0, x - eps), y);
  const south = windAt(entities, base, x, Math.min(MAP_SIZE, y + eps));
  const north = windAt(entities, base, x, Math.max(0, y - eps));
  const du = (east.x - west.x) / (2 * eps * kmPerPixel(base));
  const dv = (south.y - north.y) / (2 * eps * kmPerPixel(base));
  return -(du + dv);
}

/**
 * Moisture-flux convergence at a point, g/(m³·s).
 *
 * Rain is fed by transported moisture, not by the local stock, so the sampler
 * differences the vapour flux q·v over a ±MOISTURE_FLUX_KM window: the flux
 * entering minus the flux leaving is what the column can condense.  Convergence
 * (positive) rains harder, divergence (negative) dries the column out, which is
 * the mechanism behind a lee-side rain shadow.
 *
 * Screen y grows southwards, so +y is the southern flux component. The window
 * is a physical length: on a 500 km chart it still resolves ~8 km instead of the
 * old per-pixel accident.
 */
export function moistureFluxConvergenceAt(
  entities: WeatherEntity[],
  base: BaseConditions,
  x: number,
  y: number,
): number {
  const eps = kmToPx(MOISTURE_FLUX_KM, base);
  const epsMetres = MOISTURE_FLUX_KM * 1000;
  const fluxToward = (px: number, py: number, axis: 'x' | 'y'): number => {
    const wind = gradientWindAt(entities, base, px, py);
    const moisture = sampleRaw(entities, base, px, py).qLow;
    return moisture * (axis === 'x' ? wind.x : wind.y);
  };
  const east = fluxToward(Math.min(MAP_SIZE, x + eps), y, 'x');
  const west = fluxToward(Math.max(0, x - eps), y, 'x');
  const south = fluxToward(x, Math.min(MAP_SIZE, y + eps), 'y');
  const north = fluxToward(x, Math.max(0, y - eps), 'y');
  const divergence =
    (east - west) / (2 * epsMetres) + (south - north) / (2 * epsMetres);
  return -divergence;
}

/**
 * Cold pool from the raw (wind-free) thermodynamic sample, °C.
 *
 * `windAt` reads the cold-pool gradient for the outflow term, so the cold-pool
 * field must not itself call `windAt` -- that would be a cascade.  It is
 * therefore evaluated from the wind-free part of the vertical motion
 * (pressure systems plus the authored cold/warm pair fronts), which is what
 * organises a cold pool in this model; the thermal-front and orographic terms
 * add a few percent of lift and would make the field circular.
 */
function coldPoolFromRaw(raw: RawPoint): number {
  const W = clamp(
    raw.wLow + HIGH_LEVEL_COUPLING * raw.wHigh,
    -MAX_VERTICAL_VELOCITY,
    MAX_VERTICAL_VELOCITY,
  );
  const rain = precipitationRate(raw.tLow, raw.qLow, W);
  return coldPoolCooling(rain, raw.tLow, raw.qLow);
}

/** Cached cold-pool field sample; see `coldPoolCache`. */
function coldPoolFieldAt(
  entities: WeatherEntity[],
  base: BaseConditions,
  x: number,
  y: number,
): number {
  ensureCacheState(entities);
  const key = Math.round(x / 2) * 4096 + Math.round(y / 2);
  const cached = coldPoolCache.get(key);
  if (cached !== undefined) return cached;
  const value = coldPoolFromRaw(sampleRaw(entities, base, x, y));
  if (coldPoolCache.size > 200000) coldPoolCache.clear();
  coldPoolCache.set(key, value);
  return value;
}

/**
 * Cold-pool outflow, m/s.
 *
 * Cold air spreads down its own thickness gradient, away from the coldest
 * column: the gust front under a downburst.  The vector is -∇(coldPool) scaled
 * by COLD_POOL_OUTFLOW and clipped to MAX_COLD_POOL_OUTFLOW, so a stacked
 * rain column can produce a 4 m/s outflow but never a gale.
 */
function coldPoolOutflow(
  entities: WeatherEntity[],
  base: BaseConditions,
  x: number,
  y: number,
): { vx: number; vy: number } {
  const eps = kmToPx(COLD_POOL_KM, base);
  const east = coldPoolFieldAt(entities, base, Math.min(MAP_SIZE, x + eps), y);
  const west = coldPoolFieldAt(entities, base, Math.max(0, x - eps), y);
  const south = coldPoolFieldAt(entities, base, x, Math.min(MAP_SIZE, y + eps));
  const north = coldPoolFieldAt(entities, base, x, Math.max(0, y - eps));
  if (east === west && south === north) return { vx: 0, vy: 0 };
  const gx = (east - west) / (2 * COLD_POOL_KM);
  const gy = (south - north) / (2 * COLD_POOL_KM);
  let vx = -gx * COLD_POOL_OUTFLOW;
  let vy = -gy * COLD_POOL_OUTFLOW;
  const magnitude = Math.hypot(vx, vy);
  if (magnitude > MAX_COLD_POOL_OUTFLOW) {
    const scale = MAX_COLD_POOL_OUTFLOW / magnitude;
    vx *= scale;
    vy *= scale;
  }
  return { vx, vy };
}

/**
 * Four-quadrant air-mass identity from equivalent potential temperature.
 *
 * θe = θ + 2.5·q (K) folds heat and vapour into one conservative tracer;
 * splitting it back into its dry and latent parts gives the polar/tropical
 * and continental/maritime axes.  Warm+moist is mT, warm+dry cT, cold+moist
 * mP, cold+dry cP, and a column close to the ambient θe stays neutral.
 * `PointWeather.thetaE` is the same quantity, so the value shown on the HUD
 * is now the value that classifies the air mass instead of a display-only
 * diagnostic.
 */
function classifyAirMass(thetaE: number, q: number, base: BaseConditions): AirMass {
  // θe = θ + 2.5·q: the vapour part is the continental/maritime axis, and
  // the dry part recovered from θe is the polar/tropical axis.  Both are
  // measured against the ambient column so all four quadrants stay reachable;
  // using θe directly for the thermal axis would put every moist polar column
  // on the warm side, because +40 g/m³ alone adds 100 K to θe.
  const vapourAnomaly = q - base.Q;
  const thermalAnomaly = thetaE - 2.5 * q - (base.T + 273.15);
  const thetaEAnomaly = thermalAnomaly + 2.5 * vapourAnomaly;
  const neutral =
    Math.abs(thetaEAnomaly) < AIR_MASS_THETA_E_NEUTRAL_K &&
    Math.abs(vapourAnomaly) <= AIR_MASS_MOIST_ANOMALY;
  if (neutral) return 'neutral';
  const moist = vapourAnomaly > AIR_MASS_MOIST_ANOMALY;
  if (thermalAnomaly > 0) return moist ? 'mT' : 'cT';
  return moist ? 'mP' : 'cP';
}

// ---------------------------------------------------------------------------
// SPRINT-3A / T5 · latent-heat -> Ekman-pumping closure
// ---------------------------------------------------------------------------
/**
 * `pLow` is ABSOLUTE pressure in hPa, so a surface low is a MINIMUM and the
 * 2-D Laplacian is POSITIVE at its centre:
 *
 *     ∇²pLow = (pE + pW + pS + pN − 4pC) / h_km²   [hPa/km²]
 *
 * Writing P for the pressure DEFICIT D = base.P − pLow (low pressure =
 * positive, the convention used in the brief), ∇²D = −∇²pLow, so the
 * requested max(0, −∇²P) is exactly max(0, +∇²pLow).  Geostrophic
 * vorticity ζg = ∇²p/(ρf) and Ekman pumping w ∝ ζg, which is why only the
 * positive (cyclonic) part is kept: an anticyclonic high must not be
 * rewarded with ascent.
 *
 * The curvature is expressed on the fixed EKMAN_APERTURE_KM baseline, so the
 * same physical low gives the same W lift on a 100 km and a 2000 km chart.
 * The result is clamped to [0, EKMAN_MAX_LIFT], the explicit guard against
 * runaway rain → latent heating → deeper low → more lift.
 */
export function ekmanLiftFromCurvature(
  center: number,
  east: number,
  west: number,
  south: number,
  north: number,
  apertureKm: number,
): number {
  const h = Math.max(1e-6, apertureKm);
  const laplacian = (east + west + south + north - 4 * center) / (h * h);
  const deficitCurvature = Math.max(0, laplacian);
  const bulge = deficitCurvature * EKMAN_APERTURE_KM * EKMAN_APERTURE_KM;
  return Math.min(EKMAN_MAX_LIFT, EKMAN_LIFT * bulge);
}

/** Physical aperture (km) of the Ekman stencil on this chart. */
export function ekmanApertureKm(base: BaseConditions): number {
  const hPx = kmToPx(diagnosticKm('convergence', base), base);
  // Physical length of the stencil.  When domainScale is set,
  // kmPerPixel = domainScale/1000 = 1/scaleNorm, i.e. this is exactly the
  // SPRINT-2B-R hPx / (1000/domainScale) normalisation; at the 1000 km
  // baseline scaleNorm === 1 and 1 px === 1 km, so it is exactly 22 km.
  // Bases without domainScale fall back to the legacy 0.576 km/px chart,
  // where kmToPx already picked the pixel count for the same 22 km.
  return hPx * kmPerPixel(base);
}

/** Station sampler: five pLow samples on the shared km aperture. */
export function ekmanLiftAt(
  entities: WeatherEntity[],
  base: BaseConditions,
  x: number,
  y: number,
): number {
  const hPx = kmToPx(diagnosticKm('convergence', base), base);
  const pLowAt = (px: number, py: number): number => {
    const cx = clamp(px, 0, MAP_SIZE);
    const cy = clamp(py, 0, MAP_SIZE);
    return terrainPressureAt(
      entities,
      base,
      cx,
      cy,
      pressureAt(entities, base, cx, cy, influenceAt),
    );
  };
  return ekmanLiftFromCurvature(
    pLowAt(x, y),
    pLowAt(x + hPx, y),
    pLowAt(x - hPx, y),
    pLowAt(x, y + hPx),
    pLowAt(x, y - hPx),
    ekmanApertureKm(base),
  );
}

/** Is there an actual moisture source influencing this column? */
function hasMoistureSource(entities: WeatherEntity[], x: number, y: number): boolean {
  for (const entity of entities) {
    if (entity.type !== 'wet' && entity.type !== 'typhoon') continue;
    if (influenceAt(entity, x, y) > 0.05) return true;
  }
  return false;
}

export function buildPointWeather(
  entities: WeatherEntity[],
  base: BaseConditions,
  x: number,
  y: number,
): PointWeather {
  if (isPhysicalBase(base)) {
    return buildPhysicalPointWeather(getPhysicalField(entities, base), entities, base, x, y);
  }
  clearPerSampleCaches();
  const wind = windAt(entities, base, x, y);
  const front = frontAt(entities, base, x, y, wind);
  const raw = sampleRaw(entities, base, x, y, front);
  const windHigh = highWindAt(entities, base, x, y);
  const eps = kmToPx(diagnosticKm('temperatureAdvection', base), base);
  const tEast = sampleRaw(entities, base, Math.min(MAP_SIZE, x + eps), y).tLow;
  const tWest = sampleRaw(entities, base, Math.max(0, x - eps), y).tLow;
  const tSouth = sampleRaw(entities, base, x, Math.min(MAP_SIZE, y + eps)).tLow;
  const tNorth = sampleRaw(entities, base, x, Math.max(0, y - eps)).tLow;
  const advectedTemperature =
    raw.tLow + clamp(
      -(wind.x * ((tEast - tWest) / (2 * eps * kmPerPixel(base))) +
        wind.y * ((tSouth - tNorth) / (2 * eps * kmPerPixel(base)))) *
        TEMPERATURE_ADVECTION,
      -2.5,
      2.5,
    );
  const pressureSupport = clamp(0.3 + Math.max(0, raw.wHigh) / 4, 0.3, 1.25);
  const pressureDelta = raw.pressureW > 0 ? raw.pressureW * (pressureSupport - 1) : 0;
  const shear = shearAt(entities, base, x, y);
  const dryline = drylineAt(entities, base, x, y);
  const convergence = convergenceAt(entities, base, x, y);
  const drylineForcing = convergence > DRYLINE_CONVERGENCE_THRESHOLD || raw.wLow > 0.05;
  const drylineLift =
    dryline > DRYLINE_THRESHOLD && drylineForcing ? DRYLINE_LIFT : 0;
  const lineLift = (shear > SHEAR_THRESHOLD_DEG ? SHEAR_LIFT : 0) + drylineLift;
  const wLow = applyInversion(
    raw.wLow +
      pressureDelta +
      lineLift +
      (base.hasTerrain ? orographicLift(x, y, wind, base) : 0),
    raw.stability,
  );
  const W = Math.max(
    -MAX_VERTICAL_VELOCITY,
    Math.min(
      MAX_VERTICAL_VELOCITY,
      wLow + HIGH_LEVEL_COUPLING * raw.wHigh + ekmanLiftAt(entities, base, x, y),
    ),
  );
  // Rain is fed by the moisture flux that converges on this column, not by the
  // stock that happens to sit on it: a windward slope converges and rains, a
  // lee slope diverges and keeps only a fraction. The multiplier is NOT 1 for
  // a calm column: zero convergence gives about 0.543, i.e. a static moist
  // column rains roughly half as much. Only a column converging at
  // MOISTURE_FLUX_REFERENCE keeps the legacy rate (multiplier 1).
  const fluxConvergence = moistureFluxConvergenceAt(entities, base, x, y);
  const qSat = saturationVapourDensity(advectedTemperature);
  let R = precipitationRateFromFlux(advectedTemperature, raw.qLow, W, fluxConvergence);
  // The background moisture field is a reservoir with no bottom: convergence
  // can keep pulling from it forever.  Without a real source (a wet air mass or
  // a typhoon's own supply) the column can only drizzle out its own water.
  if (!hasMoistureSource(entities, x, y)) R = Math.min(R, BACKGROUND_RAIN_CAP_MM);
  const rain24h = R * 8;
  const cloud = clamp(28 + Math.max(0, W) * 7 + (raw.qLow / Math.max(1, qSat)) * 30, 0, 100);
  const relativeHumidity = clamp((raw.qLow / Math.max(0.1, qSat)) * 100, 0, 100);
  // Evaporative cooling: rain falling through subsaturated air chills the
  // downdraft and builds the cold pool that drives gust fronts and downbursts.
  // It is evaluated from the wind-free column so it can feed the wind field
  // without a cascade, and it is not re-fed into qSat or R (no fixed point).
  const coldPool = coldPoolFromRaw(raw);
  const surfaceTemperature = advectedTemperature - coldPool;
  const cloudTop = cloudTopFromProfile({
    w: W,
    surfaceT: surfaceTemperature,
    surfaceQ: raw.qLow,
    midT: raw.midTemperature,
    warmNose: raw.warmNose,
  });
  const dewPoint = surfaceTemperature - (100 - relativeHumidity) * 0.18;
  const hazard = hazardFor(
    W,
    cloudTop,
    advectedTemperature,
    raw.qLow,
    qSat,
    wind,
    raw.stability,
    raw.deepLow,
    isLandAt(x, y),
    R,
    raw.warmNose,
  );
  let visibility = 30;
  if (R > 0.01) visibility -= Math.min(24, R * 3.2);
  if (hazard === 'fog') visibility = Math.min(visibility, 0.8);
  if (hazard === 'dust') visibility = Math.min(visibility, 4);
  if (hazard === 'hail') visibility = Math.min(visibility, 12);
  if (hazard === 'freezingRain') visibility = Math.min(visibility, 6);
  const thetaE = advectedTemperature + 273.15 + 2.5 * raw.qLow;

  return {
    pLow: raw.pLow,
    tLow: surfaceTemperature,
    qLow: raw.qLow,
    wLow,
    pHigh: raw.pHigh,
    wHigh: raw.wHigh,
    W,
    P: raw.pLow,
    T: surfaceTemperature,
    Q: raw.qLow,
    R,
    qSat,
    cloud,
    cloudTop,
    visibility,
    dewPoint,
    thetaE,
    coldPool,
    rain24h,
    rainGrade: rainGradeFrom24h(rain24h),
    wind,
    windHigh,
    precipitationType:
      hazard === 'hail'
        ? 'hail'
        : hazard === 'freezingRain'
          ? 'freezingRain'
          : precipitationType(advectedTemperature, R),
    frontType: front.type,
    frontLift: front.lift,
    stability: raw.stability,
    midTemperature: raw.midTemperature,
    vorticity: 0,
    hazard,
    airMass: classifyAirMass(thetaE, raw.qLow, base),
    shear,
    dryline,
    convection: convectiveLevel(W),
  };
}

/**
 * Pressure-only sampling at an arbitrary resolution. The full weather grid is
 * kept at GRID_N for interactive performance (wind/t/q/w/rain are expensive);
 * isobars and axes use this field so their source data is genuinely sampled at
 * the contour resolution instead of being bilinearly upsampled from 89×89.
 */
export function buildPressureField(
  entities: WeatherEntity[],
  base: BaseConditions,
  n: number,
  size = MAP_SIZE,
  highLayer = false,
): PressureGrid {
  if (isPhysicalBase(base) && !highLayer) {
    return samplePhysicalPressure(getPhysicalField(entities, base), n, size);
  }
  const spacing = size / (n - 1);
  const values = new Float32Array(n * n);
  clearPerSampleCaches();
  for (let j = 0; j < n; j += 1) {
    const y = j * spacing;
    for (let i = 0; i < n; i += 1) {
      const x = i * spacing;
      values[j * n + i] = highLayer
        ? highPressureAt(entities, x, y)
        : terrainPressureAt(entities, base, x, y, pressureAt(entities, base, x, y, influenceAt));
    }
  }
  return { n, spacing, values };
}

export function buildGrid(
  entities: WeatherEntity[],
  base: BaseConditions,
  n: number,
  size = MAP_SIZE,
): SampleGrid {
  if (isPhysicalBase(base)) {
    return samplePhysicalGrid(getPhysicalField(entities, base), entities, base, n, size);
  }
  clearPerSampleCaches();
  const spacing = size / (n - 1);
  // T5: the pLow grid already owns the pressure field, so the grid path reads
  // its curvature directly instead of re-sampling the whole column.  Round
  // the shared km aperture to whole cells; the physical length (not the pixel
  // count) is passed to the same closure the station sampler uses.
  const ekmanPx = kmToPx(diagnosticKm('convergence', base), base);
  const ekmanStep = Math.max(1, Math.round(ekmanPx / spacing));
  const ekmanGridApertureKm = ekmanStep * spacing * kmPerPixel(base);
  const count = n * n;
  const pLow = new Float32Array(count);
  const tLow = new Float32Array(count);
  const qLow = new Float32Array(count);
  const wLow = new Float32Array(count);
  const pHigh = new Float32Array(count);
  const wHigh = new Float32Array(count);
  const pressureW = new Float32Array(count);
  const r = new Float32Array(count);
  const uLow = new Float32Array(count);
  const vLow = new Float32Array(count);
  const uHigh = new Float32Array(count);
  const vHigh = new Float32Array(count);
  const stability = new Float32Array(count);
  const tAdvected = new Float32Array(count);
  // Front diagnosis actually used by this grid, encoded with the shared
  // FrontTypeCode table.  The analytic path used to leave frontType unset,
  // which made grid <-> station agreement impossible to assert.
  const frontType = new Uint8Array(count);

  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const point = sampleRaw(entities, base, i * spacing, j * spacing);
      const index = j * n + i;
      pLow[index] = point.pLow;
      tLow[index] = point.tLow;
      qLow[index] = point.qLow;
      wLow[index] = point.wLow;
      pHigh[index] = point.pHigh;
      wHigh[index] = point.wHigh;
      pressureW[index] = point.pressureW;
      stability[index] = point.stability;
    }
  }

  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const index = j * n + i;
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(n - 1, i + 1);
      const j0 = Math.max(0, j - 1);
      const j1 = Math.min(n - 1, j + 1);
      const dxLow = (pLow[j * n + i1] - pLow[j * n + i0]) / ((i1 - i0) * spacing);
      const dyLow = (pLow[j1 * n + i] - pLow[j0 * n + i]) / ((j1 - j0) * spacing);
      const x = i * spacing;
      const y = j * spacing;
      const surface = surfaceKindAt(base, x, y);
      const lowWind = windVectorFromGradient(
        dxLow,
        dyLow,
        base.hemisphere,
        base.hasTerrain
          ? surface === 'mountain'
            ? MOUNTAIN_FRICTION
            : surface === 'land'
              ? LAND_FRICTION
              : 1
          : BASE_FRICTION,
        crossIsobarAngleFor(surface),
      );
      const adjustedLowWind = terrainWindVector(lowWind, x, y, base);
      uLow[index] = adjustedLowWind.x;
      vLow[index] = adjustedLowWind.y;

      const dxHigh = (pHigh[j * n + i1] - pHigh[j * n + i0]) / ((i1 - i0) * spacing);
      const dyHigh = (pHigh[j1 * n + i] - pHigh[j0 * n + i]) / ((j1 - j0) * spacing);
      const high = windVectorFromGradient(dxHigh * 0.32, dyHigh * 0.32, base.hemisphere, 1);
      let hvx = high.x;
      let hvy = high.y;
      // T4: thermal-wind core from the low-level T grid already sampled in
      // the first sweep.  Dividing the grid spacing by kmPerPixel gives |∇T|
      // in K/km, so the same coefficient applies on every chart width (the
      // 1000 km baseline has scaleNorm = 1).  No extra column sampling.
      const gxTGrid =
        (tLow[j * n + i1] - tLow[j * n + i0]) /
        ((i1 - i0) * spacing * kmPerPixel(base));
      const gyTGrid =
        (tLow[j1 * n + i] - tLow[j0 * n + i]) /
        ((j1 - j0) * spacing * kmPerPixel(base));
      const gridThermalCore =
        JET_THERMAL_WIND_COEFF * Math.hypot(gxTGrid, gyTGrid);
      for (const entity of entities) {
        if (entity.type !== 'jet') continue;
        const influence = influenceAt(entity, i * spacing, j * spacing);
        if (influence < 0.01) continue;
        const jetAngle = entity.angle ?? JET_DEFAULT_ANGLE;
        const core = Math.min(
          gridThermalCore * (Math.max(0, entity.strength) / 3),
          JET_MAX_CORE_PER_TIER * Math.max(0, entity.strength),
        );
        const jetForce = core * influence * JET_STEERING_SCALE;
        hvx += jetForce * Math.cos(jetAngle);
        hvy += jetForce * Math.sin(jetAngle);
      }
      const highWind = windFromVector(hvx, hvy, MAX_HIGH_WIND_SPEED);
      uHigh[index] = highWind.x;
      vHigh[index] = highWind.y;
    }
  }

  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const index = j * n + i;
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(n - 1, i + 1);
      const j0 = Math.max(0, j - 1);
      const j1 = Math.min(n - 1, j + 1);
      const dTdx = (tLow[j * n + i1] - tLow[j * n + i0]) / ((i1 - i0) * spacing);
      const dTdy = (tLow[j1 * n + i] - tLow[j0 * n + i]) / ((j1 - j0) * spacing);
      const advection = -(uLow[index] * dTdx + vLow[index] * dTdy) * TEMPERATURE_ADVECTION;
      // Compute from the unmodified tLow and apply after the sweep; updating
      // tLow in place made later cells see already-advected upstream values
      // (a Gauss-Seidel bias).
      const advectedTemperature = tLow[index] + clamp(advection, -2.5, 2.5);
      tAdvected[index] = advectedTemperature;

      const wind = windFromVector(uLow[index], vLow[index], MAX_WIND_SPEED);
      const x = i * spacing;
      const y = j * spacing;
      // Same single diagnosis as the station sampler; the grid wind is the
      // diagnostic gradient wind (the station additionally adds cold-pool
      // outflow).  Front lift belongs in wLow before inversion/rain, exactly
      // where the old pair/cyclone/occluded branches injected it.
      const diagnosis = frontAt(entities, base, x, y, wind);
      const wLowWithFront = wLow[index] + diagnosis.lift;
      frontType[index] = frontTypeCode(diagnosis.type);
      const support = clamp(0.3 + Math.max(0, wHigh[index]) / 4, 0.3, 1.25);
      const pressureDelta = pressureW[index] > 0 ? pressureW[index] * (support - 1) : 0;
      const neighbors = [
        windFromVector(uLow[j * n + i1], vLow[j * n + i1], MAX_WIND_SPEED),
        windFromVector(uLow[j1 * n + i], vLow[j1 * n + i], MAX_WIND_SPEED),
        windFromVector(uLow[j * n + i0], vLow[j * n + i0], MAX_WIND_SPEED),
        windFromVector(uLow[j0 * n + i], vLow[j0 * n + i], MAX_WIND_SPEED),
      ];
      let shear = 0;
      for (let k = 0; k < neighbors.length; k += 1) {
        const a = neighbors[k];
        const b = neighbors[(k + 1) % neighbors.length];
        if (a.speed < 0.4 || b.speed < 0.4) continue;
        shear = Math.max(shear, angularDifference(a.towardDeg, b.towardDeg));
      }
      const dryline =
        (Math.abs(qLow[j * n + i1] - qLow[j * n + i0]) + Math.abs(qLow[j1 * n + i] - qLow[j0 * n + i])) /
        (2 * spacing);
      const du = (uLow[j * n + i1] - uLow[j * n + i0]) / ((i1 - i0) * spacing);
      const dv = (vLow[j1 * n + i] - vLow[j0 * n + i]) / ((j1 - j0) * spacing);
      const convergence = -(du + dv);
      const drylineForcing = convergence > DRYLINE_CONVERGENCE_THRESHOLD || wLowWithFront > 0.05;
      const drylineLift =
        dryline > DRYLINE_THRESHOLD && drylineForcing ? DRYLINE_LIFT : 0;
      const lineLift = (shear > SHEAR_THRESHOLD_DEG ? SHEAR_LIFT : 0) + drylineLift;
      const adjustedLow = applyInversion(wLowWithFront + pressureDelta + lineLift + (base.hasTerrain ? orographicLift(x, y, wind, base) : 0), stability[index]);
      const ei = Math.min(n - 1, i + ekmanStep);
      const wi = Math.max(0, i - ekmanStep);
      const sj = Math.min(n - 1, j + ekmanStep);
      const nj = Math.max(0, j - ekmanStep);
      const ekman = ekmanLiftFromCurvature(
        pLow[index],
        pLow[j * n + ei],
        pLow[j * n + wi],
        pLow[sj * n + i],
        pLow[nj * n + i],
        ekmanGridApertureKm,
      );
      const W = clamp(adjustedLow + HIGH_LEVEL_COUPLING * wHigh[index] + ekman, -MAX_VERTICAL_VELOCITY, MAX_VERTICAL_VELOCITY);
      wLow[index] = adjustedLow;
      // Moisture-flux convergence from the wind/moisture arrays already on the
      // grid: one cell either side, converted to metres so the multiplier means
      // the same thing on a 500 km and a 2000 km chart.
      const metresPerCell = spacing * kmPerPixel(base) * 1000;
      const fluxEast = qLow[j * n + i1] * uLow[j * n + i1];
      const fluxWest = qLow[j * n + i0] * uLow[j * n + i0];
      const fluxSouth = qLow[j1 * n + i] * vLow[j1 * n + i];
      const fluxNorth = qLow[j0 * n + i] * vLow[j0 * n + i];
      const fluxConvergence = -(
        (fluxEast - fluxWest + fluxSouth - fluxNorth) /
        (2 * metresPerCell)
      );
      const gridRain = precipitationRateFromFlux(
        advectedTemperature,
        qLow[index],
        W,
        fluxConvergence,
      );
      // Same dry-column cap as the station sampler, so the painted rain field
      // and the judged rainfall agree.
      r[index] = hasMoistureSource(entities, i * spacing, j * spacing)
        ? gridRain
        : Math.min(gridRain, BACKGROUND_RAIN_CAP_MM);
    }
  }
  tLow.set(tAdvected);

  // Cold pool: the downdraft cools the surface, and the cold air then spreads
  // down its own thickness gradient.  Derived from the rain field just computed
  // so the painted temperature field carries the same downburst the station
  // sampler reports, and the arrows carry its outflow.
  const coldPool = new Float32Array(count);
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const index = j * n + i;
      const pool = coldPoolCooling(r[index], tLow[index], qLow[index]);
      coldPool[index] = pool;
      tLow[index] -= pool;
    }
  }
  const kmPerCell = spacing * kmPerPixel(base);
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const index = j * n + i;
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(n - 1, i + 1);
      const j0 = Math.max(0, j - 1);
      const j1 = Math.min(n - 1, j + 1);
      const gx = (coldPool[j * n + i1] - coldPool[j * n + i0]) / ((i1 - i0) * kmPerCell);
      const gy = (coldPool[j1 * n + i] - coldPool[j0 * n + i]) / ((j1 - j0) * kmPerCell);
      let outflowX = -gx * COLD_POOL_OUTFLOW;
      let outflowY = -gy * COLD_POOL_OUTFLOW;
      const magnitude = Math.hypot(outflowX, outflowY);
      if (magnitude > MAX_COLD_POOL_OUTFLOW) {
        const scale = MAX_COLD_POOL_OUTFLOW / magnitude;
        outflowX *= scale;
        outflowY *= scale;
      }
      const combined = windFromVector(
        uLow[index] + outflowX,
        vLow[index] + outflowY,
        MAX_WIND_SPEED,
      );
      uLow[index] = combined.x;
      vLow[index] = combined.y;
    }
  }

  // The rendered field stays diagnostic: the analytic pressure field and the
  // gradient wind derived from it. The shallow-water solver is an experimental
  // module (see docs/浅水物理核心.md); it must not overwrite this field until it
  // is non-dimensionalised, balanced and spun up. The previous runtime writeback
  // produced 2-3x too-strong, radially directed winds.

  return {
    n,
    size,
    spacing,
    pLow,
    tLow,
    qLow,
    wLow,
    pHigh,
    wHigh,
    r,
    uLow,
    vLow,
    uHigh,
    vHigh,
    frontType,
  };
}

export function interpolateGrid(
  grid: SampleGrid,
  values: Float32Array,
  x: number,
  y: number,
): number {
  const gx = Math.max(0, Math.min(grid.n - 1, x / grid.spacing));
  const gy = Math.max(0, Math.min(grid.n - 1, y / grid.spacing));
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(grid.n - 1, x0 + 1);
  const y1 = Math.min(grid.n - 1, y0 + 1);
  const tx = gx - x0;
  const ty = gy - y0;
  const a = values[y0 * grid.n + x0];
  const b = values[y0 * grid.n + x1];
  const c = values[y1 * grid.n + x0];
  const d = values[y1 * grid.n + x1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/**
 * Relative vorticity magnitude from the rendered low-level wind grid.
 *
 * The analytic wind field is already sampled at GRID_N, so this is cheap and
 * keeps the station diagnostic consistent with the arrows the player sees.
 * Units: 10⁻⁴ s⁻¹.
 */
export function vorticityFromGrid(
  grid: SampleGrid,
  x: number,
  y: number,
  kmPerPixel: number,
): number {
  const eps = Math.max(4, grid.spacing * 0.6);
  const metres = 2 * eps * Math.max(1e-6, kmPerPixel) * 1000;
  const southU = interpolateGrid(grid, grid.uLow, x, Math.min(MAP_SIZE, y + eps));
  const northU = interpolateGrid(grid, grid.uLow, x, Math.max(0, y - eps));
  const eastV = interpolateGrid(grid, grid.vLow, Math.min(MAP_SIZE, x + eps), y);
  const westV = interpolateGrid(grid, grid.vLow, Math.max(0, x - eps), y);
  // Grid v points south (screen positive), so the physical sign is flipped;
  // goals only use the magnitude.
  const dvdx = (eastV - westV) / metres;
  const dudy = (southU - northU) / metres;
  return Math.abs(dvdx - dudy) * 1e4;
}

/** Upgrade a severe storm to a tornado when rotation reaches supercell levels. */
export function applyRotationHazard(weather: PointWeather): void {
  if (weather.hazard === 'hail' || weather.hazard === 'freezingRain') return;
  if (
    weather.W >= 10 &&
    weather.shear >= TORNADO_SHEAR &&
    weather.vorticity >= TORNADO_VORTICITY
  ) {
    weather.hazard = 'tornado';
  }
}


