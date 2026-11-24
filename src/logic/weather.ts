import {
  GRID_N,
  ISOBAR_GRID_N,
  PREVIEW_GRID_N,
  MAP_SIZE,
  TYPHOON_BETA_DRIFT_KM,
  TYPHOON_COLD_SEA_DECAY,
  TYPHOON_INTENSIFY_STEP,
  TYPHOON_LAND_DECAY,
  TYPHOON_MAX_DRIFT_KM,
  TYPHOON_MAX_STRENGTH,
  TYPHOON_MIN_SST,
  TYPHOON_MIN_STRENGTH,
  TYPHOON_DEFAULT_RADIUS_KM,
  WARM_CORE_RAIN_THRESHOLD,
  WARM_CORE_ROUNDS_FOR_TYPHOON,
  LATENT_HPA_PER_MM,
  MAX_LATENT_HPA_PER_ROUND,
  MIN_WET_STRENGTH,
  MOISTURE_CONSUMPTION_PER_MM,
  HIGH_CUTOFF_INFLUENCE,
  HIGH_CUTOFF_MIN_STRENGTH,
  HIGH_CUTOFF_RATE_PER_HPA,
  FRONT_GRADIENT_THRESHOLD,
  FRONT_OCCLUSION_COLD_MASSES,
} from '../config/constants';
import {
  MAX_WET_DRIFT_KM,
  WET_DRIFT_KM_PER_MS,
  kmPerPixel,
  pxPerKm,
} from '../config/scale';
import {
  advancePhysicalField,
  applyRotationHazard,
  buildGrid,
  buildPointWeather,
  buildPressureField,
  commitPhysicalField,
  computePhysicalSnapshot,
  frontThetaEGradient,
  highWindAt,
  influenceAt,
  isPhysicalBase,
  motionWindAt,
  physicalFieldFor,
  resetFieldCaches,
  samplePhysicalSnapshotFrom,
  vorticityFromGrid,
  windAt,
} from './field';
import { cloneEntities, mergeSameType } from './entities';
import { isLandPoint, setActiveMap } from './geography';
import { saturationVapourDensity } from './precipitation';
import { evaporationFlux, sampleSurface } from './surface';
import { cachedPrognosticRound, isPrognosticBase, prognosticRound } from './prognostic/round';
import type {
  BaseConditions,
  City,
  PointWeather,
  RunSimulation,
  SourceWaterState,
  SampleGrid,
  SimulationSnapshot,
  SnapshotQuality,
  WeatherEntity,
  WetMotion,
} from './types';

/** Cheap identity check for "is this snapshot a picture of this exact board". */
function sameBoard(a: WeatherEntity[], b: WeatherEntity[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (
      left.id !== right.id ||
      left.type !== right.type ||
      Math.abs(left.x - right.x) > 0.05 ||
      Math.abs(left.y - right.y) > 0.05 ||
      Math.abs(left.strength - right.strength) > 1e-6 ||
      Math.abs(left.radius - right.radius) > 1e-6
    ) {
      return false;
    }
  }
  return true;
}

/** Stage-1 v2: air masses drift slower than moisture plumes. */
const AIR_DRIFT_KM_PER_MS = WET_DRIFT_KM_PER_MS * 0.45;
const MAX_AIR_DRIFT_KM = 90;

function moveSystems(
  entities: WeatherEntity[],
  base: BaseConditions,
  beforeEntities: WeatherEntity[],
): { moved: WeatherEntity[]; motions: WetMotion[] } {
  const moved = cloneEntities(entities);
  const motions: WetMotion[] = [];
  const kmPerPx = kmPerPixel(base);

  for (const entity of moved) {
    const isAir = base.advectAir === true && (entity.type === 'coldAir' || entity.type === 'warmAir');
    if (entity.type !== 'wet' && entity.type !== 'typhoon' && !isAir) continue;
    if (base.fixedSources === true && entity.locked && entity.type === 'wet') {
      motions.push({
        entityId: entity.id,
        fromX: entity.x,
        fromY: entity.y,
        toX: entity.x,
        toY: entity.y,
        wind: windAt(beforeEntities, base, entity.x, entity.y),
        steering: highWindAt(beforeEntities, base, entity.x, entity.y),
        distance: 0,
      });
      continue;
    }
    const wind = isAir
      ? windAt(beforeEntities, base, entity.x, entity.y)
      : motionWindAt(beforeEntities, base, entity.x, entity.y);
    const steering = highWindAt(beforeEntities, base, entity.x, entity.y);

    if (isAir) {
      const fromX = entity.x;
      const fromY = entity.y;
      if (wind.speed >= 0.35) {
        const driftKm = Math.min(MAX_AIR_DRIFT_KM, wind.speed * AIR_DRIFT_KM_PER_MS);
        const drift = driftKm * pxPerKm(base);
        entity.x = Math.max(35, Math.min(MAP_SIZE - 35, entity.x + (wind.x / wind.speed) * drift));
        entity.y = Math.max(35, Math.min(MAP_SIZE - 35, entity.y + (wind.y / wind.speed) * drift));
      }
      motions.push({
        entityId: entity.id,
        fromX,
        fromY,
        toX: entity.x,
        toY: entity.y,
        wind,
        steering,
        distance: Math.hypot(entity.x - fromX, entity.y - fromY) * kmPerPx,
      });
      continue;
    }

    if (entity.type === 'wet') {
      if (wind.speed < 0.08) {
        motions.push({
          entityId: entity.id,
          fromX: entity.x,
          fromY: entity.y,
          toX: entity.x,
          toY: entity.y,
          wind,
          steering,
          distance: 0,
        });
        continue;
      }

      // Drift is authored in km per 3 h round, then converted to this chart's
      // pixels.  A 2000 km chart used to double the physical drift because the
      // old constant was in pixels.
      const driftKm = Math.min(MAX_WET_DRIFT_KM, wind.speed * WET_DRIFT_KM_PER_MS);
      const drift = driftKm * pxPerKm(base);
      const ux = wind.x / wind.speed;
      const uy = wind.y / wind.speed;
      const fromX = entity.x;
      const fromY = entity.y;
      entity.x = Math.max(35, Math.min(MAP_SIZE - 35, entity.x + ux * drift));
      entity.y = Math.max(35, Math.min(MAP_SIZE - 35, entity.y + uy * drift));

      motions.push({
        entityId: entity.id,
        fromX,
        fromY,
        toX: entity.x,
        toY: entity.y,
        wind,
        steering,
        distance: Math.hypot(entity.x - fromX, entity.y - fromY) * kmPerPx,
      });
      continue;
    }

    // A tropical cyclone is steered by the deep-layer flow plus beta drift.
    // Three hours of 10 m/s steering is ~108 km; the cap keeps a single
    // round from teleporting the storm across the chart.
    const fromX = entity.x;
    const fromY = entity.y;
    const steerKm = Math.min(
      TYPHOON_MAX_DRIFT_KM,
      wind.speed * 3 * 3600 * 0.001,
    );
    const ux = wind.speed > 0.05 ? wind.x / wind.speed : 0;
    const uy = wind.speed > 0.05 ? wind.y / wind.speed : 0;
    // Beta drift: NW in the northern hemisphere, SW in the southern.
    const betaSign = base.hemisphere === 'N' ? -1 : 1;
    const betaX = -0.707;
    const betaY = betaSign * 0.707;
    const dxKm = ux * steerKm + betaX * TYPHOON_BETA_DRIFT_KM;
    const dyKm = uy * steerKm + betaY * TYPHOON_BETA_DRIFT_KM;
    entity.x = Math.max(35, Math.min(MAP_SIZE - 35, entity.x + dxKm / kmPerPx));
    entity.y = Math.max(35, Math.min(MAP_SIZE - 35, entity.y + dyKm / kmPerPx));
    motions.push({
      entityId: entity.id,
      fromX,
      fromY,
      toX: entity.x,
      toY: entity.y,
      wind,
      steering,
      distance: Math.hypot(entity.x - fromX, entity.y - fromY) * kmPerPx,
    });
  }

  return { moved, motions };
}

/**
 * Warm-core lows become tropical cyclones.
 *
 * A shallow warm low that keeps raining over a warm sea is exactly how a
 * tropical depression forms; after two such rounds it is promoted to a
 * typhoon entity, keeping its strength and growing to storm size.  This keeps
 * the tropical cyclone out of the deck: it is a phase, not a card.
 */
function evolveWarmCores(entities: WeatherEntity[], base: BaseConditions): void {
  const sst = base.sst ?? base.T + 1;
  for (const entity of entities) {
    if (entity.type !== 'warmLow') continue;
    const overSea = !isLandPoint(entity.x, entity.y);
    const warmEnough = sst >= TYPHOON_MIN_SST;
    const weather = buildPointWeather(entities, base, entity.x, entity.y);
    const convecting = overSea && warmEnough && weather.R >= WARM_CORE_RAIN_THRESHOLD;
    entity.warmCoreRounds = convecting ? (entity.warmCoreRounds ?? 0) + 1 : 0;
    if (entity.warmCoreRounds >= WARM_CORE_ROUNDS_FOR_TYPHOON) {
      entity.type = 'typhoon';
      entity.depth = 'deep';
      entity.layer = 'low';
      entity.radius = Math.max(entity.radius, TYPHOON_DEFAULT_RADIUS_KM / kmPerPixel(base));
      entity.warmCoreRounds = 0;
    }
  }
}

/**
 * Per-round intensity change. A storm over warm water with a warm core
 * intensifies; landfall and cold water weaken it. This is what makes a
 * "build a typhoon" sequence possible without scripting the result.
 */
/**
 * Rain consumes the moisture that produced it, and condensation warms the
 * column that produced the rain.  Both are applied after the round has been
 * sampled, so the round the player just watched is unaffected; the effect
 * shows up in the next round, which is exactly how a real column behaves.
 */
/**
 * Rain over a source's footprint.  Sampling five points instead of only the
 * centre stops a source from looking dry just because the rain band sits a few
 * kilometres downstream.
 */
function rainOverFootprint(
  entities: WeatherEntity[],
  base: BaseConditions,
  entity: WeatherEntity,
): number {
  const offsets: Array<[number, number]> = [[0, 0], [0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]];
  let sum = 0;
  for (const [fx, fy] of offsets) {
    const point = buildPointWeather(
      entities,
      base,
      entity.x + fx * entity.radius,
      entity.y + fy * entity.radius,
    );
    sum += point.R;
  }
  return sum / offsets.length;
}

/**
 * End-of-round water budget for moisture sources.
 *
 * Without `base.surface` this keeps the legacy behaviour: rain simply consumes
 * the card.  With `surface: true` the source is a small reservoir that is
 * refilled by sea/wetland evaporation (wind × saturation deficit, capped) and
 * drained by rain over its footprint.  Everything is applied after the round
 * has been sampled, so the weather the player just watched never changes.
 */
function applyMoistureBudget(
  entities: WeatherEntity[],
  base: BaseConditions,
): SourceWaterState[] {
  const ledger: SourceWaterState[] = [];

  for (const entity of entities) {
    if (entity.type !== 'wet') continue;
    const weather = buildPointWeather(entities, base, entity.x, entity.y);

    if (!base.surface) {
      const loss = MOISTURE_CONSUMPTION_PER_MM * weather.R;
      if (loss > 0) {
        entity.strength = Math.max(MIN_WET_STRENGTH, entity.strength - loss);
      }
      continue;
    }

    const start = entity.strength;
    const footprintRain = rainOverFootprint(entities, base, entity);
    const rained = MOISTURE_CONSUMPTION_PER_MM * footprintRain;
    const sample = sampleSurface(base, entity.x, entity.y);
    const wind = windAt(entities, base, entity.x, entity.y);
    const evaporated = evaporationFlux(base.Q, sample, wind.speed, saturationVapourDensity);
    const cap = Math.max(MIN_WET_STRENGTH, entity.maxStrength ?? start);
    const raw = start + evaporated - rained;
    const end = Math.max(MIN_WET_STRENGTH, Math.min(cap, raw));
    entity.strength = end;
    ledger.push({
      entityId: entity.id,
      start,
      evaporated,
      rained,
      end,
      capped: Math.abs(end - raw) > 1e-9,
    });
  }

  for (const entity of entities) {
    if (entity.type !== 'coldLow' && entity.type !== 'warmLow' && entity.type !== 'typhoon') {
      continue;
    }
    const weather = buildPointWeather(entities, base, entity.x, entity.y);
    const gain = Math.min(
      MAX_LATENT_HPA_PER_ROUND,
      LATENT_HPA_PER_MM * weather.R,
    );
    if (gain > 0) {
      entity.strength = Math.min(TYPHOON_MAX_STRENGTH, entity.strength + gain);
    }
  }

  return ledger;
}

function evolveTyphoons(entities: WeatherEntity[], base: BaseConditions): void {
  for (const entity of entities) {
    if (entity.type !== 'typhoon') continue;
    const overSea = !isLandPoint(entity.x, entity.y);
    const sst = base.sst ?? base.T + 1;
    let delta = 0;
    if (!overSea) delta -= TYPHOON_LAND_DECAY;
    else if (sst >= TYPHOON_MIN_SST) delta += TYPHOON_INTENSIFY_STEP;
    else delta -= TYPHOON_COLD_SEA_DECAY;
    entity.strength = Math.max(
      TYPHOON_MIN_STRENGTH,
      Math.min(TYPHOON_MAX_STRENGTH, entity.strength + delta),
    );
  }
}

/**
 * Antagonistic filling of a low by a blocking high.
 *
 * A low whose centre lies inside a high's influence belt is cut off from its
 * moisture supply and fills: the high's subsidence is not just a local W
 * penalty, it erodes the low itself round after round.  Only the strongest
 * overlapping high acts, so a cluster of highs cannot erase a low in one go.
 * Tropical cyclones are excluded: they have their own warm-core life cycle.
 */
function applyHighCutoff(entities: WeatherEntity[]): void {
  const highs = entities.filter(
    (entity) => entity.type === 'coldHigh' || entity.type === 'warmHigh',
  );
  if (highs.length === 0) return;
  for (const low of entities) {
    if (low.type !== 'coldLow' && low.type !== 'warmLow') continue;
    let blockingStrength = 0;
    for (const high of highs) {
      if (influenceAt(high, low.x, low.y) <= HIGH_CUTOFF_INFLUENCE) continue;
      blockingStrength = Math.max(blockingStrength, high.strength);
    }
    if (blockingStrength <= 0) continue;
    low.strength = Math.max(
      HIGH_CUTOFF_MIN_STRENGTH,
      low.strength - HIGH_CUTOFF_RATE_PER_HPA * blockingStrength,
    );
  }
}

/**
 * Age the fronts attached to a low, one step per round.
 *
 * An occlusion is a process: the cold air has to wrap around the low and keep
 * a resolved cold-side θe gradient while the cold front chases the warm one.
 * We count consecutive rounds on the low entity itself (like warmCoreRounds),
 * so `cloneEntities` carries the state through undo, preview and the next
 * round.  Instant compass placement ("NW + SW cold, SE warm") is no longer a
 * diagnosis: the field must persist for FRONT_OCCLUSION_ROUNDS rounds.
 */
function advanceFrontAge(entities: WeatherEntity[], base: BaseConditions): void {
  for (const low of entities) {
    if (low.type !== 'coldLow' && low.type !== 'warmLow') continue;
    let colds = 0;
    let warms = 0;
    for (const entity of entities) {
      if (entity.type !== 'coldAir' && entity.type !== 'warmAir') continue;
      if (influenceAt(entity, low.x, low.y) <= 0.15) continue;
      if (entity.type === 'coldAir') colds += 1;
      else warms += 1;
    }
    const coldSideGradient = frontThetaEGradient(entities, base, low.x, low.y);
    const chasing =
      colds >= FRONT_OCCLUSION_COLD_MASSES &&
      warms >= 1 &&
      coldSideGradient >= FRONT_GRADIENT_THRESHOLD;
    low.frontAge = chasing ? (low.frontAge ?? 0) + 1 : 0;
  }
}

export function computeSnapshot(
  entities: WeatherEntity[],
  base: BaseConditions,
  cities: City[],
  quality: SnapshotQuality = 'full',
  options: { isobars?: boolean } = {},
): SimulationSnapshot {

  if (isPrognosticBase(base)) {
    // computeSnapshot always describes the board the player is looking at,
    // i.e. hour 0 of the round.  Only simulateRound returns the 3 h result.
    const cached = cachedPrognosticRound(entities, base, cities);
    if (cached) return cached.before;
    if (quality === 'full') return prognosticRound(entities, base, cities).before;
    // Preview miss: stay responsive with the analytic field; the queued full
    // refresh replaces it with the prognostic snapshot.
  }
  if (isPhysicalBase(base)) {
    return computePhysicalSnapshot(entities, base, cities);
  }
  // While a card is being dragged the field is rebuilt every frame.  A coarse
  // grid plus the absence of the 256² isobar pass keeps the interaction inside
  // one frame; pointer-up restores the full analysis the goal is judged on.
  const gridN = quality === 'preview' ? PREVIEW_GRID_N : GRID_N;
  // The grid is needed first: the station vorticity diagnostic is read from
  // the same wind field the map draws, not from a second, divergent formula.
  const grid = buildGrid(entities, base, gridN);
  // The 256² analysis field exists only for the isobars.  When the player has
  // muted that layer it is pure cost (68–245 ms on a terrain chart), so it is
  // skipped; `pressureAnalysis` falls back to the interactive grid and a
  // re-enable triggers a fresh full refresh.
  if (quality === 'full' && (options.isobars ?? true)) {
    // Isobars/axes are contoured from a genuinely 256×256 pressure-only field,
    // not from a bilinear upsample of the interactive grid.
    grid.pressureFine = buildPressureField(entities, base, ISOBAR_GRID_N).values;
    grid.pressureFineN = ISOBAR_GRID_N;
  }

  const kmPerPx = kmPerPixel(base);
  const cityWeather: SimulationSnapshot['cities'] = {};
  for (const city of cities) {
    cityWeather[city.id] = sampleCityWeather(entities, base, city, grid, kmPerPx);
  }

  return {
    entities: cloneEntities(entities),
    grid,
    cities: cityWeather,
  };
}

/**
 * One station sample on top of an already-built grid.
 *
 * `buildPointWeather` alone cannot fill the rotation diagnostics (they live on
 * the grid), so every caller that needs a judged station goes through here.
 * Shared with the end-of-round "settled" sample, which must be the same kind of
 * reading as the judged one -- otherwise the panel and the report disagree.
 */
function sampleCityWeather(
  entities: WeatherEntity[],
  base: BaseConditions,
  city: City,
  grid: SampleGrid,
  kmPerPx: number,
): PointWeather {
  const weather = buildPointWeather(entities, base, city.x, city.y);
  weather.vorticity = vorticityFromGrid(grid, city.x, city.y, kmPerPx);
  applyRotationHazard(weather);
  return weather;
}

/**
 * One 3-hour round.
 *
 * Analytic levels move the moisture cards by the diagnostic steering wind and
 * rebuild the field.  Physical levels keep one shallow-water state for the
 * whole round: the "before" snapshot is its t=0 sample, the field is advanced
 * three hours, and the "after" snapshot is sampled from that evolved state.
 */
export function simulateRound(
  entities: WeatherEntity[],
  base: BaseConditions,
  cities: City[],
  /**
   * The snapshot the player is currently looking at.  Re-running the same board
   * used to recompute an identical "before" field (68–157 ms on a late chart)
   * just to throw it away one frame later; the caller may hand it in instead.
   * It is only trusted when it is a full-quality sample of exactly this board.
   */
  currentSnapshot?: SimulationSnapshot,
): RunSimulation {
  // The chart prototype has to be selected before any surface query runs, so
  // land/sea friction, coastal thermal step and orographic lift all read the
  // same geography as the renderer.
  setActiveMap(base.mapId);
  // Position-keyed field caches must not leak across rounds: every round
  // starts from a clean slate before any step mutates the entity state.
  resetFieldCaches();
  // Near-coincident systems of the same type are one larger system, not a
  // doubled amplitude.  This is the only place the merge is applied, so the
  // preview, the run and the verification all see the same field.
  //
  // Work on a clone: `mergeSameType` and the end-of-round budget mutate entity
  // objects in place, and callers (level definitions, audit/verify scripts,
  // undo snapshots) must not see a "before" board change underneath them.
  const normalized = mergeSameType(cloneEntities(entities));
  if (isPrognosticBase(base)) {
    const { before, after } = prognosticRound(normalized, base, cities);
    return { before, after, motions: [] };
  }
  if (isPhysicalBase(base)) {
    const field = physicalFieldFor(normalized, base);
    const before = samplePhysicalSnapshotFrom(field, normalized, base, cities);
    const { moved, motions } = moveSystems(normalized, base, before.entities);
    advancePhysicalField(field);
    advanceFrontAge(moved, base);
    const after = samplePhysicalSnapshotFrom(field, moved, base, cities);
    commitPhysicalField(moved, base, field);
    return { before, after, motions };
  }

  const reusable =
    currentSnapshot &&
    currentSnapshot.grid.n === GRID_N &&
    sameBoard(currentSnapshot.entities, normalized)
      ? currentSnapshot
      : null;
  const before = reusable ?? computeSnapshot(normalized, base, cities);
  const { moved, motions } = moveSystems(normalized, base, before.entities);
  // The storm evolves after it moves: warm water strengthens it, landfall and
  // cold water weaken it, so the next round starts from a different intensity.
  evolveWarmCores(moved, base);
  evolveTyphoons(moved, base);
  applyHighCutoff(moved);
  // Fronts age during the round, so the round-1 snapshot is still an ordinary
  // cold/warm front and the mature occlusion appears from round 2 onwards.
  advanceFrontAge(moved, base);
  const after = computeSnapshot(moved, base, cities);
  // The budget is spent after sampling: this round already happened, the next
  // one starts from a drier, slightly warmer column.  The report explains the
  // delta so a shrinking wet card never looks like a miscalculation.
  const water = applyMoistureBudget(moved, base);
  after.entities = cloneEntities(moved);
  // The card labels now show the settled strengths, so the panel has to read
  // the same column instead of the pre-budget one.  Judging still uses
  // `after.cities` (the weather that actually happened); `settledCities` is
  // only what the player sees from the next round onwards.  Without this the
  // HUD reported Q=29.7 while the wet card read +29.2, and the next repaint
  // silently dropped Q to 23.7.
  const settledKmPerPx = kmPerPixel(base);
  const settledCities: SimulationSnapshot['cities'] = {};
  for (const city of cities) {
    settledCities[city.id] = sampleCityWeather(
      moved,
      base,
      city,
      after.grid,
      settledKmPerPx,
    );
  }
  return { before, after, motions, settledCities, water: water.length ? water : undefined };
}
