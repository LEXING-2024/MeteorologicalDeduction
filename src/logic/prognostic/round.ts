/**
 * Cached prognostic round (P4 wiring).
 *
 * A 3 h integration at 96² takes roughly a second, which is fine for the run
 * button and impossible for drag preview.  Results are cached by board
 * signature; preview calls only ever read the cache and fall back to the cheap
 * analytic field on a miss, then the scheduled full refresh upgrades it.
 */

import { PrognosticState } from './state';
import { buildPrognosticSnapshot } from './snapshot';
import { precipitationRate } from '../precipitation';
import type { BaseConditions, City, HourlyStationSample, SimulationSnapshot, WeatherEntity } from '../types';

export interface PrognosticRoundResult {
  before: SimulationSnapshot;
  after: SimulationSnapshot;
}

const CACHE_LIMIT = 6;
const cache = new Map<string, PrognosticRoundResult>();

export function isPrognosticBase(base: BaseConditions): boolean {
  return base.physics === 'prognostic';
}

function signature(entities: WeatherEntity[], base: BaseConditions): string {
  const head = [
    base.mapId ?? 'east-sea',
    base.P,
    base.T,
    base.Q,
    base.latitude,
    base.hemisphere,
    base.domainScale ?? 1000,
  ].join('|');
  const body = entities
    .map((entity) =>
      [
        entity.type,
        Math.round(entity.x * 10),
        Math.round(entity.y * 10),
        Math.round(entity.strength * 100),
        Math.round(entity.radius),
        entity.frontAge ?? 0,
      ].join(':'),
    )
    .join(';');
  return `${head}::${body}`;
}

/** Cached round, or undefined when this board has never been integrated. */
export function cachedPrognosticRound(
  entities: WeatherEntity[],
  base: BaseConditions,
  _cities: City[],
): PrognosticRoundResult | undefined {
  const key = signature(entities, base);
  const hit = cache.get(key);
  if (hit) return hit;
  return undefined;
}

export function prognosticRound(
  entities: WeatherEntity[],
  base: BaseConditions,
  cities: City[],
): PrognosticRoundResult {
  const key = signature(entities, base);
  const hit = cache.get(key);
  if (hit) return hit;

  const state = new PrognosticState(base, entities, {
    n: 96,
    domainKm: base.domainScale ?? 1000,
    thermalCoupling: base.thermalCoupling ?? true,
  });
  const before = buildPrognosticSnapshot(state.field, entities, cities);
  // Sample the stations every hour: a moisture plume can peak at hour 1 and be
  // gone by hour 3, so the end-of-round snapshot alone would miss the event.
  const hourly: Record<string, HourlyStationSample[]> = {};
  for (const city of cities) hourly[city.id] = [];
  for (let hour = 1; hour <= 3; hour += 1) {
    state.advance(1);
    for (const city of cities) {
      const sample = state.sample(city.x, city.y);
      hourly[city.id].push({
        hour,
        Q: sample.moisture,
        W: sample.wGame,
        R: precipitationRate(sample.temperatureC, sample.moisture, sample.wGame),
        P: sample.pressureHpa,
        T: sample.temperatureC,
        // Hourly event detection is more permissive than the HUD (0.35):
        // a front that crosses a city for one hour can peak near 0.29.
        frontType: (sample.front.strength >= 0.2 ? sample.front.type : 'none') as import('../types').FrontType,
      });
    }
  }
  const after = buildPrognosticSnapshot(state.field, entities, cities);
  after.hourly = hourly;

  const result = { before, after };
  cache.set(key, result);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return result;
}
