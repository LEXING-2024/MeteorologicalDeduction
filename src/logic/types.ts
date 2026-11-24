export type EntityType =
  | 'coldHigh'
  | 'warmHigh'
  | 'coldLow'
  | 'warmLow'
  | 'typhoon'
  | 'coldAir'
  | 'warmAir'
  | 'wet'
  | 'trough'
  | 'inversion'
  | 'ridge'
  | 'jet';

/**
 * The ground cards plus the upper-air environment cards.
 *
 * `air` is the unified air-mass card: one card with two knobs (temperature and
 * moisture) that expands to the cold/warm and wet contributions the field
 * already understands.  The separate cold/warm/wet cards were retired in v3.7;
 * their entity types remain because fronts and the pressure trough are defined
 * by a cold/warm *dipole*, not by a single scalar.
 */
export type CardType =
  | 'H'
  | 'L'
  | 'air'
  | 'moisture'
  | 'trough'
  | 'inversion'
  | 'ridge'
  | 'jet';

export type EntityDepth = 'shallow' | 'deep' | 'none';
export type MapLayer = 'low' | 'mid' | 'high';
export type InversionMode = 'unstable' | 'stable';
export type Hemisphere = 'N' | 'S';
export type FrontType = 'none' | 'cold' | 'warm' | 'stationary' | 'occluded';
export type HazardType =
  | 'none'
  | 'fog'
  | 'dust'
  | 'hail'
  | 'thunderstorm'
  | 'tornado'
  | 'freezingRain';
export type AirMass = 'cP' | 'cT' | 'mP' | 'mT' | 'neutral';
export type TerrainProfile =
  | 'default'
  | 'taiwan'
  | 'songxian'
  | 'lingui'
  | 'golmud'
  | 'zhengzhou';

export interface ShapePoint {
  x: number;
  y: number;
}

export interface WeatherEntity {
  id: string;
  /**
   * Stable per-entity seed for the cosmetic shape/aspect hash. It must not be
   * derived from the generated id: otherwise two identical placements produce
   * different wind fields and the puzzle becomes non-deterministic.
   */
  seed?: number;
  type: EntityType;
  depth: EntityDepth;
  layer: MapLayer;
  x: number;
  y: number;
  /** Positive magnitude in hPa / °C / g/m³, or 1–3 for upper-air cards. */
  strength: number;
  /** Reservoir ceiling for a surface source; evaporation refills up to here. */
  maxStrength?: number;
  radius: number;
  /** Optional editable outline, relative to the entity center. */
  shape?: ShapePoint[];
  /** Jet axis direction (radians, screen convention: 0 = east, +y = south). */
  angle?: number;
  inversionMode?: InversionMode;
  /**
   * Consecutive rounds a warm-core low has spent raining over warm sea.
   * At the threshold it transitions into a tropical cyclone.
   */
  warmCoreRounds?: number;
  /**
   * Consecutive rounds a low has held a cold/warm air-mass pair with a
   * resolved cold-side θe gradient.  At FRONT_OCCLUSION_ROUNDS the cold front
   * has caught the warm front and `frontAt` reports an occluded front.
   * It lives on the entity so `cloneEntities` carries it between rounds.
   */
  frontAge?: number;
  /** Initial synoptic features cannot be moved or removed. */
  locked?: boolean;
  note?: string;
}

export interface BaseConditions {
  P: number;
  T: number;
  Q: number;
  /** Absolute latitude band shown on the chart, in degrees. */
  latitude: number;
  hemisphere: Hemisphere;
  /** Terrain levels enable coasts, orographic lift and land/sea friction. */
  hasTerrain?: boolean;
  /** Approximate real-world terrain profile for case levels. */
  terrainProfile?: TerrainProfile;
  timeOfDay?: 'day' | 'night';
  /** Sea-surface temperature, °C. Tropical cyclones need >= 26.5 °C. */
  sst?: number;
  /**
   * Stage-1 v2 tutorial flag. When true, cold/warm air masses are advected by
   * the low-level wind between rounds, while pressure centres stay anchored.
   */
  advectAir?: boolean;
  /**
   * Stage-1 v2: locked moisture blobs represent fixed surface source zones
   * and do not drift. Unlocked moisture cards still drift with the wind.
   */
  fixedSources?: boolean;
  /**
   * Enable the surface field (SST / land / roughness) and the evaporation +
   * source-reservoir water budget.  Stages 1–2 opt in; older stages keep the
   * analytic behaviour untouched.
   */
  surface?: boolean;
  /** Disable hydrostatic coupling of temperature cards in the prognostic engine. */
  thermalCoupling?: boolean;
  /**
   * Chart prototype: coastline, land polygon and relief.  Rendering and the
   * surface physics both read it, so the map a player sees is the map the
   * solver uses.  Omitted levels fall back to the campaign's east-sea chart.
   */
  mapId?: string;
  /**
   * Physical side length of the chart, km.  Present on levels that run on the
   * shallow-water engine (Stage 1 for now).
   */
  domainScale?: number;
  /**
   * 'swe' runs the level on the shallow-water engine; omitted/'analytic' keeps
   * the legacy diagnostic field for levels that have not been re-calibrated.
   */
  physics?: 'analytic' | 'swe' | 'prognostic';
}

export interface City {
  id: string;
  name: string;
  nameEn: string;
  x: number;
  y: number;
  labelSide?: 'left' | 'right';
}

export interface WindVector {
  x: number;
  y: number;
  speed: number;
  /** Direction the air is travelling toward, degrees clockwise from east. */
  towardDeg: number;
  /** Meteorological "from" direction, degrees clockwise from north. */
  fromDeg: number;
  fromLabel: string;
  beaufort: number;
}

export interface PointWeather {
  /** Low-level pressure / temperature / moisture. */
  pLow: number;
  tLow: number;
  qLow: number;
  /** High-level pressure anomaly and vertical velocity. */
  pHigh: number;
  wHigh: number;
  /** Low-level vertical velocity before high-level support. */
  wLow: number;
  /** Combined vertical velocity used for precipitation. */
  W: number;
  /** Convenience aliases for the low-level fields. */
  P: number;
  T: number;
  Q: number;
  R: number;
  qSat: number;
  cloud: number;
  cloudTop: number;
  visibility: number;
  dewPoint: number;
  /** Equivalent potential temperature, K: the air-mass identity (heat + moisture). */
  thetaE: number;
  /** Evaporative cooling under precipitation, °C (positive magnitude). */
  coldPool: number;
  rain24h: number;
  rainGrade: string;
  wind: WindVector;
  windHigh: WindVector;
  precipitationType: 'none' | 'rain' | 'snow' | 'hail' | 'freezingRain';
  frontType: FrontType;
  frontLift: number;
  stability: number;
  /** Mid-level temperature, °C. A warm nose above a sub-zero surface makes freezing rain. */
  midTemperature: number;
  /** Local relative vorticity magnitude, 10⁻⁴ s⁻¹. */
  vorticity: number;
  hazard: HazardType;
  airMass: AirMass;
  /** Local wind-direction difference in degrees. */
  shear: number;
  /** Moisture-gradient strength across the point (g/m³ per pixel). */
  dryline: number;
  /** 0 none, 1 heavy rain, 2 thunderstorm, 3 hail (based on W). */
  convection: number;
  /** Physical-W decomposition (Stage 1 engine); optional for legacy fields. */
  wConvergence?: number;
  wEkman?: number;
  wTerrain?: number;
  wFront?: number;
  /** Pressure anomaly of the free surface, hPa. */
  pressureAnomaly?: number;
}

export interface SampleGrid {
  n: number;
  size: number;
  spacing: number;
  pLow: Float32Array;
  tLow: Float32Array;
  qLow: Float32Array;
  wLow: Float32Array;
  pHigh: Float32Array;
  wHigh: Float32Array;
  r: Float32Array;
  uLow: Float32Array;
  vLow: Float32Array;
  uHigh: Float32Array;
  vHigh: Float32Array;
  /** Physical front strength 0..1 from the shallow-water temperature field. */
  frontStrength?: Float32Array;
  /** 0 none, 1 cold, 2 warm, 3 stationary. */
  frontType?: Uint8Array;
  /** Convergence ascent (-H div V) and orographic ascent (V . grad z), m/s. */
  wConvergence?: Float32Array;
  wTerrain?: Float32Array;
  /**
   * True high-resolution pressure samples used for isobars/axes. This is a
   * pressure-only field sampled at pressureFineN, not an upsample of pLow.
   */
  pressureFine?: Float32Array;
  pressureFineN?: number;
}

export interface WetMotion {
  entityId: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  wind: WindVector;
  steering: WindVector;
  distance: number;
}

export interface HourlyStationSample {
  hour: number;
  Q: number;
  W: number;
  R: number;
  P: number;
  T: number;
  frontType: FrontType;
}

export interface SimulationSnapshot {
  entities: WeatherEntity[];
  grid: SampleGrid;
  cities: Record<string, PointWeather>;
  /** Prognostic rounds only: hourly station samples inside the round. */
  hourly?: Record<string, HourlyStationSample[]>;
}

/**
 * `preview` runs a coarse grid and skips the 256² isobar analysis.  It exists
 * so dragging a card can repaint inside one frame; every judged state is
 * sampled at `full`.
 */
export type SnapshotQuality = 'full' | 'preview';

export interface SourceWaterState {
  entityId: string;
  start: number;
  evaporated: number;
  rained: number;
  end: number;
  capped: boolean;
}

export interface RunSimulation {
  before: SimulationSnapshot;
  after: SimulationSnapshot;
  motions: WetMotion[];
  /** Per-source water budget for surface levels (omitted elsewhere). */
  water?: SourceWaterState[];
  /**
   * Station readings taken after the end-of-round moisture/latent-heat budget
   * was spent.  `after` is what the round is judged on (the weather that
   * happened); this is the state the next round starts from, and therefore the
   * one the panels must display so a wet card and its Q never disagree.
   */
  settledCities?: SimulationSnapshot['cities'];
}

export interface WeatherRecord {
  round: number;
  cities: Record<string, PointWeather>;
  /** Entity state after the round, needed for track/intensity conditions. */
  entities?: WeatherEntity[];
}

export interface GoalContext {
  history: WeatherRecord[];
}

export interface WeatherCondition {
  kind:
    | 'vertical'
    | 'moisture'
    | 'rain'
    | 'clear'
    | 'temperature'
    | 'pressure'
    | 'front'
    | 'advect'
    | 'highVertical'
    | 'airMass'
    | 'wind'
    | 'shear'
    | 'dryline'
    | 'hazard'
    | 'dry'
    | 'pressureTendency'
    | 'temperatureChange'
    | 'windShift'
    | 'visibility'
    | 'rotation'
    | 'stability'
    | 'typhoon';
  cityId: string;
  minW?: number;
  maxW?: number;
  hazard?: Exclude<HazardType, 'none'>;
  maxR?: number;
  minQ?: number;
  minR?: number;
  min24h?: number;
  max24h?: number;
  maxT?: number;
  minT?: number;
  minP?: number;
  maxP?: number;
  frontType?: Exclude<FrontType, 'none'>;
  airMass?: AirMass;
  fromDirs?: string[];
  minSpeed?: number;
  minShear?: number;
  minDryline?: number;
  /** Mesocyclone / tornado rotation threshold, in 10⁻⁴ s⁻¹. */
  minVorticity?: number;
  /** Stratification: > 0 unstable (parcels accelerate), < 0 stable. */
  minStability?: number;
  maxStability?: number;
  /** Minimum typhoon category: 0 tropical depression, 1 storm, 2 typhoon, 3 severe. */
  minCategory?: number;
  /** Distance from the typhoon centre to the city, km. */
  maxDistanceKm?: number;
  entityId?: string;
  maxDistance?: number;
  minDeltaP?: number;
  maxDeltaP?: number;
  minDeltaT?: number;
  maxDeltaT?: number;
  minWindShift?: number;
  minVisibility?: number;
  maxVisibility?: number;
}

export type GoalTarget =
  | WeatherCondition
  | { kind: 'multi'; conditions: WeatherCondition[] }
  | { kind: 'persistentRain'; conditions: WeatherCondition[]; rounds: number }
  | { kind: 'persistent'; conditions: WeatherCondition[]; rounds: number }
  | {
      kind: 'accumulatedRain';
      conditions: WeatherCondition[];
      rounds: number;
      min24h: number;
    }
  | { kind: 'sequence'; conditions: WeatherCondition[] }
  /**
   * Round-window target.  `any`: at least one round inside [fromRound, toRound]
   * satisfies every condition; `all`: every round in the window must satisfy
   * them.  Rounds are 3 h, so round r covers hours [(r-1)*3, r*3].
   */
  | {
      kind: 'window';
      fromRound: number;
      toRound: number;
      mode?: 'any' | 'all';
      conditions: WeatherCondition[];
    }
  /**
   * Hour-window target inside one prognostic round.  A plume can peak at hour
   * 1 and be gone by hour 3, so end-of-round sampling would miss it.
   */
  | {
      kind: 'hourWindow';
      cityId: string;
      fromHour: number;
      toHour: number;
      minQ?: number;
      minW?: number;
      minR?: number;
      maxR?: number;
      frontType?: FrontType;
    };

export interface ConditionEvaluation {
  condition: WeatherCondition;
  passed: boolean;
  label: string;
  actual: string;
  target: string;
  progress: number;
  detail: string;
}

export interface GoalEvaluation {
  passed: boolean;
  /** The current round satisfies the repeatable condition but the multi-round target is not complete. */
  holding?: boolean;
  actual: string;
  target: string;
  progress: number;
  detail: string;
  conditionResults?: ConditionEvaluation[];
}

export interface GuideArrow {
  from: { x: number; y: number };
  to: { x: number; y: number };
  label: string;
}

/**
 * Level-authored failure copy.  `missing` is used when the primary condition is
 * not met at all, `weak` when it is met but the magnitude is short.
 * `{R24}` / `{R}` are replaced with the measured rainfall.
 */
export interface FailureAdvice {
  missing: string;
  weak?: string;
}

export interface LevelDefinition {
  id: string;
  index: number;
  stage: 1 | 2 | 3 | 4 | 5 | 6;
  code: string;
  name: string;
  nameEn: string;
  concept: string;
  objective: string;
  objectiveDetail: string;
  brief: string;
  hint: string;
  /** Optional worked solution, revealed only after an explicit confirmation. */
  solution?: string;
  successNote: string;
  base: BaseConditions;
  cities: City[];
  initialEntities: WeatherEntity[];
  allowedCards: CardType[];
  /** Bespoke failure advice for levels whose usual mistake is predictable. */
  failureAdvice?: FailureAdvice;
  focusCard: CardType;
  target: GoalTarget;
  /** Terrain map and terrain physics; false uses the plain chart. */
  hasTerrain?: boolean;
  /**
   * Maximum number of placed systems (entities) the player may add on top of
   * the initial field.  A card counts as the systems it expands into, so the
   * unified air card uses two slots when both knobs are on.  This is the one
   * resource constraint in the game: it turns "add another card" into a choice.
   */
  entityBudget?: number;
  /** Only these levels expose the layer switch. */
  layers?: MapLayer[];
  layerNote?: string;
  lockedNotice?: string;
  guide?: GuideArrow;
}
