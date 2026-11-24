import assert from 'node:assert/strict';
import { CAMPAIGN_STAGES, LEVELS, cloneLevel, getLevel } from '../src/config/levels';
import {
  CONTENT_SCALE,
  CLOUD_TOP_LAPSE_RATE,
  EKMAN_APERTURE_KM,
  EKMAN_MAX_LIFT,
  GRID_N,
  GRID_SPACING,
  MAP_SIZE,
  MOISTURE_FLUX_REFERENCE,
} from '../src/config/constants';
import {
  buildGrid,
  buildPointWeather,
  cloudTopFromProfile,
  crossIsobarAngleFor,
  ekmanApertureKm,
  ekmanLiftAt,
  frontAt,
  influenceAt,
  jetCoreSpeedAt,
  jetCoreSpeedFor,
  surfaceKindAt,
  thermalGradientAt,
  windAt,
} from '../src/logic/field';
import { cloneEntities, createEntity as createEntityRaw } from '../src/logic/entities';
import { evaluateGoal } from '../src/logic/goal';
import {
  buildPressureGrid,
  pressureInfluence,
  pressureProfileFor,
} from '../src/logic/pressure';
import { moistureFluxFactor } from '../src/logic/precipitation';
import { simulateRound } from '../src/logic/weather';
import type { BaseConditions, GoalContext, WeatherEntity, WeatherRecord } from '../src/logic/types';

// Authored test coordinates are in the original 800-unit chart; the level data
// is scaled to the 1000-unit world, so test entities are scaled to match.
const S = CONTENT_SCALE;
let activeDomainScale = 1000;
const createEntity = (
  type: Parameters<typeof createEntityRaw>[0],
  x: number,
  y: number,
  strength?: number,
  options?: Parameters<typeof createEntityRaw>[4],
): WeatherEntity => {
  const scaledOptions = options
    ? {
        ...options,
        domainScale: options.domainScale ?? activeDomainScale,
        radius: options.radius !== undefined ? options.radius * S : undefined,
        shape: options.shape
          ? options.shape.map((point) => ({ x: point.x * S, y: point.y * S }))
          : undefined,
      }
    : undefined;
  return createEntityRaw(type, x * S, y * S, strength, scaledOptions);
};

const A = { x: 286, y: 322 };
const B = { x: 486, y: 428 };
const C = { x: 412, y: 632 };
const AX = A.x * S;
const AY = A.y * S;
const PX = 400 * S;
const PY = 400 * S;

function cityOf(levelNumber: number, id: string): { x: number; y: number } {
  const city = getLevel(levelNumber - 1).cities.find((item) => item.id === id);
  return city ? { x: city.x, y: city.y } : id === 'B' ? B : id === 'C' ? C : A;
}

function solve(
  levelNumber: number,
  build: (initial: WeatherEntity[]) => WeatherEntity[],
  maxRounds = 1,
  mutate?: (entities: WeatherEntity[], round: number) => WeatherEntity[],
) {
  const level = getLevel(levelNumber - 1);
  activeDomainScale = level.base.domainScale ?? 1000;
  let entities = build(cloneEntities(level.initialEntities));
  const history: WeatherRecord[] = [];
  for (let round = 1; round <= maxRounds; round += 1) {
    if (round > 1 && mutate) entities = mutate(entities, round);
    const simulation = simulateRound(entities, level.base, level.cities);
    entities = cloneEntities(simulation.after.entities);
    history.push({ round, cities: simulation.after.cities, entities: simulation.after.entities });
    const evaluation = evaluateGoal(level, simulation.after, { history });
    if (evaluation.passed) {
      return { level, entities, rounds: round, evaluation };
    }
  }
  const last = simulateRound(entities, level.base, level.cities);
  const finalEvaluation = evaluateGoal(level, last.after, { history });
  if (finalEvaluation.passed) {
    return { level, entities, rounds: maxRounds, evaluation: finalEvaluation };
  }
  return {
    level,
    entities,
    rounds: maxRounds,
    failed: finalEvaluation,
  };
}

const failures: string[] = [];

function pass(
  levelNumber: number,
  build: (initial: WeatherEntity[]) => WeatherEntity[],
  rounds = 1,
  mutate?: (entities: WeatherEntity[], round: number) => WeatherEntity[],
) {
  const result = solve(levelNumber, build, rounds, mutate);
  if (result.failed) {
    failures.push(`Level ${levelNumber} should be solvable: ${result.failed.detail}`);
  }
}

function fail(levelNumber: number, entities: WeatherEntity[], rounds = 1): void {
  const level = getLevel(levelNumber - 1);
  activeDomainScale = level.base.domainScale ?? 1000;
  const history: WeatherRecord[] = [];
  let current = cloneEntities(entities);
  for (let round = 1; round <= rounds; round += 1) {
    const simulation = simulateRound(current, level.base, level.cities);
    current = cloneEntities(simulation.after.entities);
    history.push({ round, cities: simulation.after.cities, entities: simulation.after.entities });
  }
  const simulation = simulateRound(current, level.base, level.cities);
  const context: GoalContext = { history };
  const evaluation = evaluateGoal(level, simulation.after, context);
  if (evaluation.passed) {
    failures.push(`Level ${levelNumber} failure state must not pass`);
  }
}

// --- T5 mechanism lock (SPRINT-3A): pressure curvature feeds W ---
// Placed before the level sweep so the reverse injection EKMAN_LIFT = 0
// turns the suite red immediately instead of after a full 72-level run.
// The five-point station stencil, the shared closure and the 1000 km
// baseline aperture are all pinned here.
{
  const ekBase: BaseConditions = {
    P: 1012, T: 22, Q: 7.4, latitude: 35, hemisphere: 'N', domainScale: 1000,
  };
  const ekX = 500;
  const ekY = 500;
  const weakLow = createEntityRaw('coldLow', ekX, ekY, 5, { id: 'ek-weak' });
  const deepLow = createEntityRaw('coldLow', ekX, ekY, 20, { id: 'ek-deep' });
  const lift5 = ekmanLiftAt([weakLow], ekBase, ekX, ekY);
  const lift20 = ekmanLiftAt([deepLow], ekBase, ekX, ekY);
  assert.ok(lift20 > 0.1, `T5: a 20 hPa low must pump measurable W (got ${lift20.toFixed(4)})`);
  assert.ok(
    lift20 > lift5 + 0.2,
    `T5: 20 hPa low must add more W than 5 hPa low (${lift20.toFixed(4)} vs ${lift5.toFixed(4)})`,
  );
  assert.ok(lift20 <= EKMAN_MAX_LIFT && lift5 >= 0, 'T5: lift must stay positive and capped');
  assert.equal(ekmanLiftAt([deepLow], ekBase, ekX, ekY), lift20, 'T5: closure must be deterministic');
  assert.ok(
    Math.abs(ekmanApertureKm(ekBase) - EKMAN_APERTURE_KM) < 1e-9,
    'T5: 1000 km baseline aperture must be numerically unchanged (22 km)',
  );
  // A high is an anticyclone: max(0, -∇²D) must not reward it with ascent.
  const ekHigh = createEntityRaw('warmHigh', ekX, ekY, 20, { id: 'ek-high' });
  assert.equal(ekmanLiftAt([ekHigh], ekBase, ekX, ekY), 0, 'T5: a surface high must not gain Ekman lift');
  // The station W actually carries the closure.
  assert.ok(
    buildPointWeather([deepLow], ekBase, ekX, ekY).W >
      buildPointWeather([weakLow], ekBase, ekX, ekY).W,
    'T5: station W must carry the pressure-curvature increment',
  );
}

// --- T4 mechanism lock (SPRINT-3A): jet core from the thermal wind ---
// Reverse injection JET_THERMAL_WIND_COEFF = 0 must turn this red: the
// resolved front would then produce zero core speed.
{
  const jetBase: BaseConditions = {
    P: 1012, T: 22, Q: 7.4, latitude: 35, hemisphere: 'N', domainScale: 1000,
  };
  const jetX = 500;
  const jetY = 500;
  const jet = createEntityRaw('jet', jetX, jetY, 3, { id: 't4-jet' });
  const flat = [jet, createEntityRaw('wet', jetX, jetY, 40, { id: 't4-wet' })];
  assert.equal(
    thermalGradientAt(flat, jetBase, jetX, jetY), 0,
    'T4: a moisture-only field has no dry thermal gradient',
  );
  assert.equal(
    jetCoreSpeedAt(flat, jetBase, jetX, jetY), 0,
    'T4: ∇T = 0 must not manufacture a jet',
  );
  assert.equal(
    jetCoreSpeedFor(flat, jetBase, jet, jetX, jetY), 0,
    'T4: a strength-3 card must not create wind from a thermally flat field',
  );
  // Same placement, increasing |∇T| -> monotonically increasing core speed.
  const cores: number[] = [];
  for (const strength of [2, 5, 10, 20]) {
    const column = [
      jet,
      createEntityRaw('coldAir', jetX - 60, jetY, strength, { id: 't4-cold' }),
      createEntityRaw('warmAir', jetX + 60, jetY, strength / 2, { id: 't4-warm' }),
    ];
    cores.push(jetCoreSpeedAt(column, jetBase, jetX, jetY));
  }
  for (let k = 1; k < cores.length; k += 1) {
    assert.ok(
      cores[k] > cores[k - 1] + 1e-6,
      `T4: core speed must grow with |∇T| (${cores.map((v) => v.toFixed(3)).join(' -> ')})`,
    );
  }
  assert.ok(cores[cores.length - 1] > 1, 'T4: a resolved thermal front must spin up a jet');
}

// --- T2 mechanism lock (SPRINT-3A): one θe-profile cloud top for both engines ---
// Reverse injection CLOUD_TOP_THETA_E_LATENT = 0 removes the moisture term
// from the three-level sounding and must turn the "moister raises the top"
// assertion red.
{
  const t2Base: BaseConditions = {
    P: 1012, T: 22, Q: 7.4, latitude: 35, hemisphere: 'N', domainScale: 1000,
  };
  const t2Entities = [
    createEntityRaw('coldLow', 500, 500, 20, { id: 't2-low' }),
    createEntityRaw('wet', 500, 500, 40, { id: 't2-wet' }),
  ];
  const analytic = buildPointWeather(t2Entities, t2Base, 500, 500);
  const swe = buildPointWeather(t2Entities, { ...t2Base, physics: 'swe' }, 500, 500);
  // Both engines must route cloudTop through the single exported function:
  // rebuilding it from the reported column reproduces the value exactly.
  const analyticRebuilt = cloudTopFromProfile({
    w: analytic.W,
    surfaceT: analytic.T,
    surfaceQ: analytic.Q,
    midT: analytic.midTemperature,
    warmNose: analytic.midTemperature - t2Base.T,
  });
  const sweRebuilt = cloudTopFromProfile({
    w: swe.W,
    surfaceT: swe.T,
    surfaceQ: swe.Q,
    midT: swe.midTemperature,
    warmNose: 0,
  });
  assert.ok(
    Math.abs(analytic.cloudTop - analyticRebuilt) < 1e-9,
    'T2: analytic cloudTop must come from cloudTopFromProfile',
  );
  assert.ok(
    Math.abs(swe.cloudTop - sweRebuilt) < 1e-9,
    'T2: SWE cloudTop must come from the same cloudTopFromProfile',
  );
  assert.ok(
    analytic.cloudTop >= analytic.T / CLOUD_TOP_LAPSE_RATE - 1e-6,
    'T2: analytic cloud top must not sink below the 0 °C level',
  );
  assert.ok(
    swe.cloudTop >= swe.T / CLOUD_TOP_LAPSE_RATE - 1e-6,
    'T2: SWE cloud top must not sink below the 0 °C level',
  );
  const t2Profile = { w: 10, surfaceT: 22, surfaceQ: 7.4, midT: 22, warmNose: 0 };
  const t2Reference = cloudTopFromProfile(t2Profile);
  assert.ok(
    t2Reference >= 10,
    `T2: W = 10 must keep hail reachable (cloudTop ${t2Reference.toFixed(2)} km)`,
  );
  assert.ok(
    cloudTopFromProfile({ ...t2Profile, surfaceQ: 24 }) > t2Reference + 0.1,
    'T2: a moister θe sounding must raise the cloud top',
  );
  assert.ok(
    cloudTopFromProfile({ ...t2Profile, midT: 30, warmNose: 8 }) < t2Reference - 0.1,
    'T2: a mid-level warm nose must cap the cloud top',
  );
  assert.ok(
    cloudTopFromProfile({ ...t2Profile, w: 0 }) >=
      t2Profile.surfaceT / CLOUD_TOP_LAPSE_RATE - 1e-6,
    'T2: even W = 0 must respect the 0 °C floor',
  );
}

assert(LEVELS.length >= 50, 'At least 50 levels are playable.');
assert.equal(CAMPAIGN_STAGES.find((stage) => stage.stage === 6)?.first, 51, 'Stage 6 starts at level 51.');
assert.equal(CAMPAIGN_STAGES.length, 6);
assert.deepEqual(cloneLevel(getLevel(0)).allowedCards, ['L']);
for (let index = 14; index <= 23; index += 1) {
  assert.deepEqual(
    getLevel(index - 1).allowedCards,
    ['H', 'L', 'air'],
    `Level ${index} should expose the surface-source deck (no moisture card)`,
  );
}
for (const index of [24, 25]) {
  assert.deepEqual(getLevel(index - 1).allowedCards, ['H', 'L'], `Level ${index} uses pressure cards only`);
}
for (let index = 26; index <= 29; index += 1) {
  assert.deepEqual(
    getLevel(index - 1).allowedCards,
    ['H', 'L', 'air', 'moisture'],
    `Level ${index} should expose all ground cards`,
  );
  assert.equal(getLevel(index - 1).stage, 3, `Level ${index} should belong to stage 3`);
}
for (let index = 30; index <= 45; index += 1) {
  const level = getLevel(index - 1);
  assert.equal(level.stage, 4, `Level ${index} should belong to stage 4`);
  for (const card of ['trough', 'ridge', 'inversion', 'jet'] as const) {
    assert.ok(level.allowedCards.includes(card), `Level ${index} should expose ${card}`);
  }
}
for (let index = 46; index <= 50; index += 1) {
  assert.equal(getLevel(index - 1).stage, 5, `Level ${index} should belong to stage 5`);
}
for (let index = 51; index <= 72; index += 1) {
  assert.equal(getLevel(index - 1).stage, 6, `Level ${index} should belong to stage 6`);
}

// Stage-1 v2: fixed surface sources, advected air masses, process goals.
const E1 = (type: Parameters<typeof createEntityRaw>[0], x: number, y: number, strength: number, id: string) =>
  createEntityRaw(type, x, y, strength, { id, domainScale: 1000 });
const C1 = (levelNumber: number, id: string) => cityOf(levelNumber, id);

pass(1, () => {
  // Level 1 runs on the prognostic engine: the card needs a synoptic radius or
  // the geostrophic adjustment deepens the low by tens of hPa in three hours.
  const a = C1(1, 'A');
  return [createEntityRaw('coldLow', a.x, a.y, 10, { id: 'lift', domainScale: 1000, radius: 480 })];
});

// Dual-track: level 1 is migrated to the prognostic engine, but the analytic
// fallback must still solve it so a rollback is always possible.
{
  const analyticLevel = cloneLevel(getLevel(0));
  analyticLevel.base.physics = 'analytic';
  const a = C1(1, 'A');
  const simulation = simulateRound(
    [createEntityRaw('coldLow', a.x, a.y, 10, { id: 'lift', domainScale: 1000 })],
    analyticLevel.base,
    analyticLevel.cities,
  );
  const evaluation = evaluateGoal(analyticLevel, simulation.after, {
    history: [{ round: 1, cities: simulation.after.cities, entities: simulation.after.entities }],
  });
  assert.ok(evaluation.passed, 'L1 analytic fallback must still pass');
}

pass(2, (initial) => [
  ...initial,
  createEntityRaw('warmHigh', 220, 500, 10, { id: 'h', domainScale: 1000, radius: 480 }),
  createEntityRaw('coldLow', 520, 360, 10, { id: 'l', domainScale: 1000, radius: 480 }),
]);
pass(3, (initial) => [
  ...initial,
  createEntityRaw('coldLow', 320, 430, 10, { id: 'lift', domainScale: 1000, radius: 480 }),
]);
pass(4, (initial) => [
  ...initial,
  createEntityRaw('warmHigh', C1(4, 'A').x, C1(4, 'A').y, 20, { id: 'subsidence', domainScale: 1000, radius: 480 }),
]);
pass(5, (initial) => [
  ...initial,
  // Moisture now has to reach B inside the round: low NW of the source, high SE.
  createEntityRaw('warmHigh', 700, 600, 20, { id: 'west-high', domainScale: 1000, radius: 480 }),
  createEntityRaw('coldLow', 400, 300, 20, { id: 'east-low', domainScale: 1000, radius: 480 }),
]);
pass(6, (initial) => {
  const a = C1(6, 'A');
  return [...initial, createEntityRaw('coldAir', a.x + 60, a.y + 60, 20, { id: 'cold', domainScale: 1000, radius: 300 })];
});
pass(7, (initial) => {
  const a = C1(7, 'A');
  return [...initial, createEntityRaw('warmAir', a.x + 60, a.y - 60, 10, { id: 'warm', domainScale: 1000, radius: 300 })];
});
pass(8, (initial) => [
  ...initial,
  createEntityRaw('coldAir', 290, 420, 20, { id: 'cold', domainScale: 1000, radius: 300 }),
  createEntityRaw('warmAir', 370, 420, 5, { id: 'warm', domainScale: 1000, radius: 300 }),
  createEntityRaw('warmHigh', 110, 420, 10, { id: 'high-west', domainScale: 1000, radius: 480 }),
  createEntityRaw('coldLow', 530, 420, 10, { id: 'low-east', domainScale: 1000, radius: 480 }),
]);
pass(9, (initial) => [
  ...initial,
  // Prognostic warm front: weaker cards keep the peak rain inside 30 mm/24h.
  createEntityRaw('coldAir', C1(9, 'A').x - 40, C1(9, 'A').y, 10, { id: 'cold', domainScale: 1000, radius: 300 }),
  createEntityRaw('warmAir', C1(9, 'A').x + 40, C1(9, 'A').y, 5, { id: 'warm', domainScale: 1000, radius: 300 }),
  createEntityRaw('warmHigh', C1(9, 'A').x - 220, C1(9, 'A').y, 10, { id: 'high-west', domainScale: 1000, radius: 480 }),
  createEntityRaw('coldLow', C1(9, 'A').x + 220, C1(9, 'A').y, 10, { id: 'low-east', domainScale: 1000, radius: 480 }),
]);
pass(10, (initial) => [
  ...initial,
  // Prognostic stationary front: equal air masses at ±40 px stay stalled.
  createEntityRaw('coldAir', C1(10, 'A').x - 40, C1(10, 'A').y, 10, { id: 'cold', domainScale: 1000, radius: 300 }),
  createEntityRaw('warmAir', C1(10, 'A').x + 40, C1(10, 'A').y, 10, { id: 'warm', domainScale: 1000, radius: 300 }),
]);
pass(11, (initial) => [
  ...initial,
  E1('warmHigh', C1(11, 'A').x, C1(11, 'A').y - 220, 10, 'high-north'),
  E1('coldLow', C1(11, 'A').x, C1(11, 'A').y + 220, 10, 'low-south'),
]);
pass(12, (initial) => [
  ...initial,
  E1('warmAir', C1(12, 'A').x, C1(12, 'A').y, 10, 'warm'),
  E1('coldLow', C1(12, 'A').x + 120, C1(12, 'A').y, 10, 'lift'),
]);
pass(13, (initial) => [
  ...initial,
  E1('warmHigh', 220, 560, 10, 'steer-high'),
  E1('coldLow', 560, 320, 10, 'steer-low'),
]);
fail(2, []);
fail(3, []);
fail(4, cloneEntities(getLevel(3).initialEntities));
fail(5, []);
fail(6, []);
fail(7, []);
fail(8, []);
fail(9, []);
fail(10, []);
fail(11, []);
fail(12, []);
fail(13, []);

// Stage-2 levels each ship their own city layout, so solutions address the
// level's own cities instead of three global constants.
const cityAt = (levelNumber: number, id: string): { x: number; y: number } => {
  const city = getLevel(levelNumber - 1).cities.find((item) => item.id === id);
  return { x: (city?.x ?? 0) / S, y: (city?.y ?? 0) / S };
};

// Levels 14–18: combinations, warm high, multi-round.
pass(14, (initial) => {
  const a = cityAt(14, 'A');
  const b = cityAt(14, 'B');
  return [
    ...initial,
    createEntity('coldLow', a.x, a.y, 20, { id: 'low' }),
    createEntity('warmHigh', b.x, b.y, 10, { id: 'high' }),
  ];
});
pass(15, (initial) => {
  const a = cityAt(15, 'A');
  const b = cityAt(15, 'B');
  return [
    ...initial,
    createEntity('coldAir', a.x, a.y, 10, { id: 'cold' }),
    createEntity('warmAir', a.x, a.y, 5, { id: 'warm' }),
    createEntity('warmHigh', b.x + 120, b.y + 40, 20, { id: 'high' }),
  ];
});
pass(16, (initial) => {
  const b = cityAt(16, 'B');
  return [
    ...initial,
    createEntity('warmHigh', b.x, b.y, 20, { id: 'warm-high' }),
    createEntity('warmAir', b.x, b.y, 10, { id: 'warm' }),
  ];
});
pass(
  17,
  (initial) => {
    const a = cityAt(17, 'A');
    return [
      ...initial,
      createEntity('coldAir', a.x, a.y, 10, { id: 'cold' }),
      createEntity('warmAir', a.x, a.y, 10, { id: 'warm' }),
    ];
  },
  3,
);
{
  const level = getLevel(17);
  const a = cityAt(18, 'A');
  const history: WeatherRecord[] = [];
  let entities = [createEntity('warmHigh', a.x, a.y, 10, { id: 'high' })];
  let simulation = simulateRound(entities, level.base, level.cities);
  history.push({ round: 1, cities: simulation.after.cities });
  let evaluation = evaluateGoal(level, simulation.after, { history });
  assert.equal(evaluation.holding, true, 'Level 18 first round should hold after clear sky');
  entities = [
    ...cloneEntities(getLevel(17).initialEntities),
    createEntity('coldLow', a.x, a.y, 10, { id: 'low' }),
  ];
  simulation = simulateRound(entities, level.base, level.cities);
  history.push({ round: 2, cities: simulation.after.cities });
  evaluation = evaluateGoal(level, simulation.after, { history });
  assert.equal(evaluation.passed, true, 'Level 18 clear → rain sequence should pass');
}

// Levels 19–25: stage-two combinations and new lines.
pass(19, (initial) => {
  const a = cityAt(19, 'A');
  const b = cityAt(19, 'B');
  const c = cityAt(19, 'C');
  return [
    ...initial,
    // Re-solved for the unified frontAt: the C-city H/L pair drives a strong
    // cross-front wind at A, so the cold air mass needs a 15°C push to keep the
    // cold front advancing (10°C made it stationary).  Target unchanged.
    createEntity('coldAir', a.x, a.y, 15, { id: 'cold' }),
    createEntity('warmAir', a.x, a.y, 5, { id: 'warm' }),
    createEntity('coldLow', a.x, a.y, 10, { id: 'low-a' }),
    createEntity('warmHigh', b.x, b.y, 20, { id: 'high-b' }),
    createEntity('warmHigh', c.x + 140, c.y, 20, { id: 'high-east' }),
    createEntity('coldLow', c.x - 140, c.y, 20, { id: 'low-west' }),
  ];
});
pass(20, (initial) => {
  const a = cityAt(20, 'A');
  return [
    ...initial,
    createEntity('coldAir', a.x, a.y, 10, { id: 'cold' }),
    createEntity('warmAir', a.x, a.y, 5, { id: 'warm' }),
  ];
});
pass(21, (initial) => {
  const a = cityAt(21, 'A');
  return [
    ...initial,
    // 切变线要同时满足"风向切变 ≥30°"、10–80 mm/24h 与 P ≥ 1008：
    // 图上 ±90 px（授权坐标 ±72）、强度 5，配合冷暖气团才既保留切变又不压破气压。
    createEntity('warmHigh', a.x - 72, a.y, 5, { id: 'high' }),
    createEntity('coldLow', a.x + 72, a.y, 5, { id: 'low' }),
    createEntity('coldAir', a.x, a.y, 10, { id: 'cold' }),
    createEntity('warmAir', a.x, a.y, 5, { id: 'warm' }),
  ];
});
pass(22, (initial) => {
  const a = cityAt(22, 'A');
  return [
    ...initial,
    createEntity('coldAir', a.x, a.y, 10, { id: 'cold' }),
    createEntity('warmAir', a.x, a.y, 5, { id: 'warm' }),
  ];
});
pass(
  23,
  (initial) => {
    const a = cityAt(23, 'A');
    return [
      ...initial,
      createEntity('coldAir', a.x, a.y, 10, { id: 'cold' }),
      createEntity('warmAir', a.x, a.y, 10, { id: 'warm' }),
    ];
  },
  2,
);
// 海陆风：第 1 回合低压在东侧（风从西北来），第 2 回合把它搬到西侧，
// 风向反转为东南风——这才是"海风/陆风"的日循环，而不是摆一次就交卷。
pass(
  24,
  () => {
    const b = cityAt(24, 'B');
    return [createEntity('coldLow', b.x + 120, b.y, 20, { id: 'sea-breeze-low' })];
  },
  2,
  () => {
    const b = cityAt(24, 'B');
    return [createEntity('coldLow', b.x - 120, b.y, 20, { id: 'land-breeze-low' })];
  },
);
pass(
  25,
  () => {
    const a = cityAt(25, 'A');
    return [createEntity('coldLow', a.x + 120, a.y, 20, { id: 'valley-breeze-low' })];
  },
  2,
  () => {
    const a = cityAt(25, 'A');
    return [createEntity('coldLow', a.x - 120, a.y, 20, { id: 'slope-breeze-low' })];
  },
);

// Levels 26–29: the four pressure-system types and their depth.
pass(26, (initial) => [
  ...initial,
  createEntity('coldHigh', A.x, A.y, 20, { id: 'cold-high' }),
]);
fail(26, [
  ...cloneEntities(getLevel(25).initialEntities),
  createEntity('warmHigh', A.x, A.y, 20, { id: 'warm-high' }),
]);
// A strong low elsewhere clears A (it advects the moisture away) and lifts the
// upper layer, so it used to satisfy "clear + high W" without any high at all.
fail(26, [
  ...cloneEntities(getLevel(26).initialEntities),
  createEntity('coldLow', B.x, B.y, 20, { id: 'decoy-low' }),
]);
fail(26, [
  ...cloneEntities(getLevel(25).initialEntities),
  createEntity('coldHigh', A.x, A.y, 5, { id: 'weak-high' }),
]);
pass(27, (initial) => [
  ...initial,
  createEntity('warmHigh', A.x, A.y, 20, { id: 'warm-high' }),
]);
fail(27, [
  ...cloneEntities(getLevel(26).initialEntities),
  createEntity('coldHigh', A.x, A.y, 20, { id: 'cold-high' }),
]);
fail(27, [
  ...cloneEntities(getLevel(26).initialEntities),
  createEntity('warmHigh', A.x, A.y, 10, { id: 'weak-warm-high' }),
]);
pass(28, () => [
  createEntity('coldLow', A.x, A.y, 20, { id: 'cold-low' }),
  createEntity('coldAir', A.x, A.y, 10, { id: 'cold-air' }),
  createEntity('wet', A.x, A.y, 20, { id: 'wet' }),
]);
fail(28, [
  createEntity('coldLow', A.x, A.y, 20, { id: 'cold-low' }),
  createEntity('wet', A.x, A.y, 20, { id: 'wet' }),
]);
fail(28, [
  createEntity('warmLow', A.x, A.y, 20, { id: 'warm-low' }),
  createEntity('coldAir', A.x, A.y, 10, { id: 'cold-air' }),
  createEntity('wet', A.x, A.y, 20, { id: 'wet' }),
]);
pass(29, () => [
  createEntity('warmLow', A.x, A.y, 20, { id: 'warm-low' }),
  createEntity('coldAir', A.x, A.y, 10, { id: 'cold-air' }),
  createEntity('warmAir', A.x, A.y, 5, { id: 'warm-air' }),
]);
fail(29, [createEntity('warmLow', A.x, A.y, 20, { id: 'warm-low' })]);
fail(29, [
  createEntity('coldLow', A.x, A.y, 20, { id: 'cold-low' }),
  createEntity('coldAir', A.x, A.y, 10, { id: 'cold-air' }),
  createEntity('warmAir', A.x, A.y, 5, { id: 'warm-air' }),
]);
// Adding moisture must break the dry-thunderstorm condition in the same round.
fail(29, [
  createEntity('warmLow', A.x, A.y, 20, { id: 'warm-low' }),
  createEntity('coldAir', A.x, A.y, 10, { id: 'cold-air' }),
  createEntity('warmAir', A.x, A.y, 5, { id: 'warm-air' }),
  createEntity('wet', A.x, A.y, 20, { id: 'wet' }),
]);

// Stage 4: upper-air environment and mesoscale.
pass(30, (initial) => [...initial, createEntity('trough', A.x, A.y, 2, { id: 'trough' })]);
// T5 re-solve (SPRINT-3A): pressure-curvature lift adds ~0.12 W at the low
// centre, taking R from 0.30 to 0.34 mm/3h.  A stable mid-level cap restores
// the dry column (R = 0) without touching the level's R <= 0.30 target.
pass(31, (initial) => [
  ...initial,
  createEntity('ridge', A.x, A.y, 3, { id: 'ridge' }),
  createEntity('inversion', A.x, A.y, 2, {
    id: 'dry-cap',
    inversionMode: 'stable',
  }),
]);
pass(32, (initial) => [...initial, createEntity('inversion', A.x, A.y, 2, { id: 'unstable' })]);
pass(33, (initial) => [
  ...initial,
  createEntity('inversion', A.x, A.y, 2, { id: 'stable', inversionMode: 'stable' }),
]);
// T4 re-solve (SPRINT-3A): a jet now needs a real |∇T| to exist, and a
// moisture-only chart is thermally flat.  A modest cold/warm pair across the
// A city gives the thermal wind something to integrate; target unchanged.
pass(34, (initial) => [
  ...initial,
  createEntity('jet', A.x, A.y, 3, { id: 'jet' }),
  createEntity('coldAir', A.x - 60, A.y, 10, { id: 't4-cold' }),
  createEntity('warmAir', A.x + 60, A.y, 5, { id: 't4-warm' }),
]);
pass(35, (initial) => [
  ...initial,
  createEntity('coldLow', B.x, B.y, 10, { id: 'cell-b' }),
  createEntity('wet', B.x, B.y, 20, { id: 'wet-b' }),
]);
pass(36, (initial) => [
  ...initial,
  createEntity('coldLow', A.x, A.y, 20, { id: 'low' }),
  createEntity('coldAir', A.x - 50, A.y, 10, { id: 'cold' }),
  createEntity('warmAir', A.x + 50, A.y, 5, { id: 'warm' }),
]);
pass(37, (initial) => [
  ...initial,
  createEntity('warmHigh', A.x - 100, A.y, 20, { id: 'high' }),
  createEntity('coldLow', A.x + 100, A.y, 20, { id: 'low' }),
  createEntity('wet', A.x, A.y - 60, 40, { id: 'wet-north-a' }),
  createEntity('wet', A.x, A.y - 60, 40, { id: 'wet-north-b' }),
]);
pass(38, (initial) => [
  ...initial,
  // 阵风锋 = 冷池 + 抬升 + 水汽 + 一团被推挤的暖气：只放低压不再够。
  createEntity('coldLow', A.x, A.y, 20, { id: 'low' }),
  createEntity('wet', A.x, A.y, 40, { id: 'wet' }),
  createEntity('warmAir', A.x + 60, A.y, 5, { id: 'warm' }),
]);
pass(39, (initial) => [...initial, createEntity('wet', A.x, A.y, 40, { id: 'wet' })], 2);
pass(40, (initial) => [
  ...initial,
  createEntity('wet', A.x, A.y, 40, { id: 'wet' }),
  createEntity('coldAir', A.x - 50, A.y, 10, { id: 'cold' }),
  createEntity('warmAir', A.x + 50, A.y, 5, { id: 'warm' }),
]);
// T4 re-solve (SPRINT-3A): a typhoon centre is a warm-core extremum, so
// |∇T| vanishes there and a single jet cannot steer it.  Two jet cards plus
// two environmental cold/warm pairs keep a resolved baroclinic zone along
// the whole track; the round-3 jet withdrawal is unchanged, target untouched.
pass(
  41,
  (initial) => [
    ...initial,
    createEntity('jet', 576, 512, 3, { id: 'jet', layer: 'high', angle: -2.6 }),
    createEntity('jet', 656, 576, 3, { id: 'jet-2', layer: 'high', angle: -2.6 }),
    createEntity('coldAir', 606, 576, 20, { id: 't4-cold-a' }),
    createEntity('warmAir', 706, 576, 10, { id: 't4-warm-a' }),
    createEntity('coldAir', 500, 480, 20, { id: 't4-cold-b' }),
    createEntity('warmAir', 600, 480, 10, { id: 't4-warm-b' }),
  ],
  3,
  (entities, round) => (round === 3 ? entities.filter((entity) => entity.type !== 'jet') : entities),
);
pass(42, (initial) => [
  ...initial,
  createEntity('inversion', A.x, A.y, 2, { id: 'warm-nose', inversionMode: 'stable', layer: 'mid' }),
  createEntity('coldLow', A.x, A.y, 10, { id: 'low' }),
  createEntity('wet', A.x, A.y, 40, { id: 'wet' }),
]);
pass(43, (initial) => [
  ...initial,
  createEntity('inversion', A.x, A.y, 2, { id: 'stable', inversionMode: 'stable' }),
]);
pass(44, (initial) => [
  ...initial,
  createEntity('inversion', A.x, A.y, 2, { id: 'stable', inversionMode: 'stable' }),
]);
pass(45, (initial) => [...initial, createEntity('coldAir', A.x, A.y, 10, { id: 'cold' })]);

// Stage 5: real cases.
// T4 re-solve (SPRINT-3A): the jet needs an environmental temperature
// gradient, so the level adds a second jet and a cold/warm pair on the
// typhoon track.  Same cards as the rain-shadow lock below.
pass(
  46,
  (initial) => [
    ...initial,
    createEntity('jet', 620, 470, 3, { id: 'jet', layer: 'high', angle: 2.9 }),
    createEntity('jet', 680, 448, 3, { id: 'jet-2', layer: 'high', angle: 2.9 }),
    createEntity('coldAir', 630, 448, 20, { id: 't4-cold' }),
    createEntity('warmAir', 730, 448, 10, { id: 't4-warm' }),
  ],
  3,
);
pass(
  47,
  (initial) => [...initial],
  2,
  (_entities, round) =>
    round === 2
      ? [
          createEntity('coldHigh', A.x - 100, A.y, 20, { id: 'high' }),
          createEntity('coldAir', A.x, A.y, 20, { id: 'cold' }),
          createEntity('coldAir', A.x, A.y, 10, { id: 'cold2' }),
          createEntity('coldLow', A.x + 100, A.y, 20, { id: 'low' }),
        ]
      : [],
);
// A weak low east of the city widens the pressure gradient. Under the new
// physics the cold pool damps the ambient wind at the pool centre, so the
// synoptic gradient has to carry a little more of the 6 m/s target (the hint
// already asks for H/L to pull the gradient tight).
pass(48, (initial) => [
  ...initial,
  createEntity('coldLow', A.x, A.y, 20, { id: 'low' }),
  createEntity('coldLow', A.x, A.y, 20, { id: 'low2' }),
  createEntity('warmHigh', A.x - 100, A.y, 20, { id: 'high' }),
  createEntity('coldAir', A.x, A.y, 10, { id: 'cold' }),
  createEntity('wet', A.x, A.y, 40, { id: 'wet' }),
  createEntity('coldLow', A.x + 120, A.y, 5, { id: 'east-low' }),
]);
pass(49, () => [
  createEntity('warmHigh', A.x - 200, A.y, 20, { id: 'high' }),
  createEntity('coldLow', A.x + 200, A.y, 20, { id: 'low' }),
  createEntity('warmHigh', A.x - 100, A.y, 20, { id: 'high2' }),
  createEntity('coldLow', A.x + 100, A.y, 20, { id: 'low2' }),
]);
// The cold air mass sits further west than the card hint suggests: at 60 km it
// cools A city itself, and a colder column holds less vapour, so the third-round
// total lands just under the 240 mm target. 150 km keeps the cold pool/thickness
// gradient (and the hint's intent) without capping the moisture supply.
pass(50, (initial) => [
  ...initial,
  createEntity('coldLow', A.x, A.y, 20, { id: 'low' }),
  createEntity('wet', A.x, A.y, 40, { id: 'wet' }),
  createEntity('wet', A.x, A.y, 40, { id: 'wet2' }),
  createEntity('coldAir', A.x - 150, A.y, 10, { id: 'cold' }),
], 3);

// Stage 6: high-difficulty combinations.
pass(51, (initial) => [
  ...initial,
  createEntity('coldLow', B.x, B.y, 10, { id: 'low-b' }),
  createEntity('wet', B.x, B.y, 40, { id: 'wet-b' }),
  createEntity('coldLow', C.x, C.y, 10, { id: 'low-c' }),
  createEntity('wet', C.x, C.y, 40, { id: 'wet-c' }),
]);
pass(52, (initial) => [
  ...initial,
  createEntity('wet', A.x, A.y, 40, { id: 'wet' }),
  createEntity('coldAir', A.x - 50, A.y, 10, { id: 'cold' }),
  createEntity('warmAir', A.x + 50, A.y, 5, { id: 'warm' }),
]);
pass(53, () => [
  createEntity('wet', A.x, A.y, 40, { id: 'wet-a' }),
  createEntity('wet', B.x, B.y, 40, { id: 'wet-b' }),
  createEntity('wet', C.x, C.y, 40, { id: 'wet-c' }),
  createEntity('coldLow', A.x, A.y, 10, { id: 'low-a' }),
  createEntity('coldLow', B.x, B.y, 10, { id: 'low-b' }),
  createEntity('coldLow', C.x, C.y, 10, { id: 'low-c' }),
]);
pass(54, (initial) => [
  ...initial,
  // 初始场清空后，A 城的雨要自己搭：两个低压把 W 顶住，两张水汽
  // 沿上风铺开补上被 B/C 高压抽干的辐合；高压只压住 B、C，不能压死 A。
  createEntity('coldLow', A.x, A.y, 20, { id: 'low-a' }),
  createEntity('coldLow', A.x, A.y, 20, { id: 'low-b' }),
  createEntity('wet', A.x, A.y, 40, { id: 'wet-a' }),
  createEntity('wet', A.x - 30, A.y, 40, { id: 'wet-b' }),
  createEntity('warmHigh', B.x, B.y, 20, { id: 'high-b' }),
  createEntity('warmHigh', C.x, C.y, 20, { id: 'high-c' }),
]);
// A warm low raining over a 30 °C sea becomes a tropical cyclone after two
// rounds; no typhoon card is used anywhere. The storm needs one round more than
// the four-round budget to walk its eyewall onto B city, so the last round adds
// a jet that steers it northwest instead of waiting (same lesson as level 46).
pass(
  55,
  () => [
    createEntity('warmLow', 608, 512, 20, { id: 'seed-low' }),
    createEntity('wet', 608, 512, 40, { id: 'seed-wet' }),
  ],
  4,
  (entities, round) =>
    round === 4
      ? [
          ...entities,
          createEntity('jet', 560, 470, 3, { id: 'steer', layer: 'high', angle: -2.356 }),
        ]
      : entities,
);
pass(56, (initial) => [
  ...initial,
  createEntity('warmHigh', A.x, A.y, 20, { id: 'high' }),
  createEntity('ridge', A.x, A.y, 3, { id: 'ridge' }),
]);
pass(57, () => [
  createEntity('wet', A.x, A.y, 40, { id: 'wet-a' }),
  createEntity('wet', B.x, B.y, 40, { id: 'wet-b' }),
  createEntity('wet', C.x, C.y, 40, { id: 'wet-c' }),
  createEntity('coldLow', A.x, A.y, 10, { id: 'low-a' }),
  createEntity('coldLow', B.x, B.y, 10, { id: 'low-b' }),
  createEntity('coldLow', C.x, C.y, 10, { id: 'low-c' }),
]);
pass(58, () => [
  createEntity('coldAir', A.x, A.y, 20, { id: 'cold' }),
  createEntity('warmAir', B.x, B.y, 20, { id: 'warm' }),
]);
pass(59, (initial) => [
  ...initial,
  // 初始场清空后要自己搭出"A 城暴雨、B 城晴"的对比：两个低压叠深，
  // 两张水汽沿上风铺开，B 城用高压压住。
  createEntity('coldLow', A.x, A.y, 20, { id: 'low-a' }),
  createEntity('coldLow', A.x, A.y, 20, { id: 'low-b' }),
  createEntity('wet', A.x, A.y, 40, { id: 'wet-a' }),
  createEntity('wet', A.x - 30, A.y, 40, { id: 'wet-b' }),
  createEntity('warmHigh', B.x, B.y, 20, { id: 'high' }),
]);
pass(60, () => [
  createEntity('coldLow', (A.x + B.x) / 2, (A.y + B.y) / 2, 20, { id: 'low' }),
  createEntity('warmHigh', A.x - 100, A.y, 20, { id: 'high-a' }),
  createEntity('warmHigh', B.x + 100, B.y, 20, { id: 'high-b' }),
]);
pass(61, () => [
  createEntity('coldLow', A.x, A.y, 20, { id: 'low-a' }),
  createEntity('wet', A.x, A.y, 40, { id: 'wet-a' }),
  createEntity('wet', B.x, B.y, 40, { id: 'wet-b' }),
  createEntity('inversion', B.x, B.y, 2, { id: 'inv', inversionMode: 'stable' }),
  createEntity('warmHigh', B.x, B.y, 20, { id: 'high-b' }),
  createEntity('warmHigh', C.x - 100, C.y, 20, { id: 'high-c' }),
  createEntity('coldLow', C.x + 100, C.y, 20, { id: 'low-c' }),
]);
pass(
  62,
  () => [
    createEntity('coldLow', A.x, A.y, 20, { id: 'low' }),
    createEntity('wet', A.x, A.y, 40, { id: 'wet' }),
  ],
  3,
  (entities, round) =>
    round === 3 ? entities.filter((entity) => entity.type !== 'coldLow') : entities,
);
pass(63, () => [
  createEntity('wet', A.x, A.y, 40, { id: 'wet-a' }),
  createEntity('wet', B.x, B.y, 40, { id: 'wet-b' }),
  createEntity('wet', C.x, C.y, 40, { id: 'wet-c' }),
  createEntity('coldLow', A.x, A.y, 10, { id: 'low-a' }),
  createEntity('coldLow', B.x, B.y, 10, { id: 'low-b' }),
  createEntity('coldLow', C.x, C.y, 10, { id: 'low-c' }),
]);
// A wide moisture field, not a stack on one point: the middle city sits in the
// strongest steering flow, so a single blob blows off before the round ends.
pass(64, () => [
  createEntity('wet', A.x, A.y, 40, { id: 'wet-a' }),
  createEntity('wet', B.x, B.y, 40, { id: 'wet-b1' }),
  createEntity('wet', B.x + 72, B.y - 72, 40, { id: 'wet-b2' }),
  createEntity('wet', B.x - 72, B.y + 72, 40, { id: 'wet-b3' }),
  createEntity('wet', C.x, C.y, 40, { id: 'wet-c' }),
  createEntity('coldLow', A.x, A.y, 20, { id: 'low-a' }),
  createEntity('coldLow', B.x, B.y, 20, { id: 'low-b' }),
  createEntity('coldLow', C.x, C.y, 20, { id: 'low-c' }),
]);
pass(65, (initial) => [
  ...initial,
  createEntity('warmHigh', A.x, A.y, 20, { id: 'high' }),
  createEntity('coldLow', B.x, B.y, 20, { id: 'low' }),
  createEntity('wet', B.x, B.y, 40, { id: 'wet' }),
]);
pass(66, (initial) => [...initial, createEntity('warmHigh', A.x, A.y, 20, { id: 'high' })], 2);
pass(67, () => [
  createEntity('coldLow', A.x, A.y, 20, { id: 'low' }),
  createEntity('wet', A.x, A.y, 40, { id: 'wet' }),
]);
pass(68, () => [
  createEntity('warmHigh', A.x, A.y, 20, { id: 'high' }),
  createEntity('warmAir', A.x, A.y, 20, { id: 'warm' }),
]);
pass(69, (initial) => [
  ...initial,
  createEntity('coldLow', A.x, A.y, 20, { id: 'low-a' }),
  createEntity('coldLow', A.x + 20, A.y + 10, 20, { id: 'low-b' }),
  createEntity('coldAir', A.x - 35, A.y, 10, { id: 'cold' }),
  createEntity('warmAir', A.x + 35, A.y, 5, { id: 'warm' }),
]);
pass(70, (initial) => [
  ...initial,
  // 湖泊效应需要冷空气"过湖"：低压偏到东侧，A 城才有 5 m/s 以上的西北风。
  createEntity('coldLow', A.x + 80, A.y, 20, { id: 'low' }),
  createEntity('wet', A.x, A.y, 40, { id: 'wet' }),
]);
pass(71, () => [
  createEntity('coldLow', A.x, A.y, 20, { id: 'low' }),
  createEntity('wet', A.x, A.y, 40, { id: 'wet-a' }),
  createEntity('wet', A.x, A.y, 40, { id: 'wet-b' }),
]);
pass(72, () => [
  createEntity('warmHigh', A.x - 100, A.y, 20, { id: 'high' }),
  createEntity('coldLow', A.x + 100, A.y, 20, { id: 'low' }),
]);

// Failure states for stage 1 are declared in the stage-1 block above.
fail(19, (() => {
  const a = cityAt(19, 'A');
  return [
    createEntity('coldAir', a.x, a.y, 15, { id: 'old-cold' }),
    createEntity('warmAir', a.x, a.y, 5, { id: 'old-warm' }),
  ];
})());
fail(21, [createEntity('wet', A.x, A.y, 40, { id: 'wet' })]);
fail(22, (() => {
  const a = cityAt(22, 'A');
  return [
    createEntity('coldAir', a.x, a.y, 10, { id: 'old-cold' }),
    createEntity('warmAir', a.x, a.y, 5, { id: 'old-warm' }),
  ];
})());
fail(23, [
  createEntity('coldAir', A.x, A.y, 10, { id: 'cold' }),
  createEntity('warmAir', A.x, A.y, 10, { id: 'warm' }),
  createEntity('wet', A.x, A.y, 40, { id: 'wet' }),
], 2);
fail(24, []);
fail(25, []);

// --- T3 / R6 mechanism locks (Sprint 2B) ---
// Lock 1: one placement can have only ONE front type.  The station sampler
// must agree with the single `frontAt` diagnosis in both type and lift; a
// reintroduced geometry/curve/pair/thermal path that overrides it turns red.
// Lock 2: an occlusion is a chase across rounds, never an instant placement.
{
  const lockBase = getLevel(18).base;
  activeDomainScale = lockBase.domainScale ?? 1000;
  const stacked = [
    createEntity('coldAir', A.x, A.y, 10, { id: 'lock-cold' }),
    createEntity('warmAir', A.x, A.y, 5, { id: 'lock-warm' }),
    createEntity('wet', A.x, A.y, 40, { id: 'lock-wet' }),
  ];
  const cyclone = [
    createEntity('coldLow', 400, 400, 20, { id: 'lock-low' }),
    createEntity('coldAir', 320, 320, 10, { id: 'lock-cold' }),
    createEntity('warmAir', 480, 480, 5, { id: 'lock-warm' }),
  ];
  const occludedGeometry = cloneEntities(getLevel(38).initialEntities);
  const placements: Array<{ name: string; entities: WeatherEntity[]; x: number; y: number }> = [
    { name: 'stacked cold/warm', entities: stacked, x: AX, y: AY },
    { name: 'cyclone geometry', entities: cyclone, x: 400 * S, y: 400 * S },
    { name: 'occluded geometry', entities: occludedGeometry, x: AX, y: AY },
  ];
  for (const placement of placements) {
    const wind = windAt(placement.entities, lockBase, placement.x, placement.y);
    const diagnosis = frontAt(placement.entities, lockBase, placement.x, placement.y, wind);
    const repeated = frontAt(placement.entities, lockBase, placement.x, placement.y, wind);
    const weather = buildPointWeather(placement.entities, lockBase, placement.x, placement.y);
    assert.equal(repeated.type, diagnosis.type, `${placement.name}: frontAt must return one stable type`);
    assert.ok(
      Math.abs(repeated.lift - diagnosis.lift) < 1e-9,
      `${placement.name}: frontAt must return one stable lift`,
    );
    assert.equal(
      weather.frontType,
      diagnosis.type,
      `${placement.name}: the station front type must come only from frontAt (no second judgement path)`,
    );
    assert.ok(
      Math.abs(weather.frontLift - diagnosis.lift) < 1e-9,
      `${placement.name}: the station front lift must come only from frontAt`,
    );
  }
  const geomWind = windAt(occludedGeometry, lockBase, AX, AY);
  assert.notEqual(
    frontAt(occludedGeometry, lockBase, AX, AY, geomWind).type,
    'occluded',
    'occluded geometry must not force an occlusion before the fronts have aged',
  );

  const level39 = getLevel(38);
  activeDomainScale = level39.base.domainScale ?? 1000;
  const chasing = [
    ...cloneEntities(level39.initialEntities),
    createEntity('wet', A.x, A.y, 40, { id: 'lock-wet' }),
  ];
  const round1 = simulateRound(chasing, level39.base, level39.cities);
  assert.notEqual(
    round1.after.cities.A.frontType,
    'occluded',
    'round 1 with an unchanged placement must not be occluded',
  );
  assert.equal(
    round1.after.entities.find((entity) => entity.type === 'coldLow')?.frontAge,
    1,
    'round 1 must age the chasing front exactly once',
  );
  const round2 = simulateRound(cloneEntities(round1.after.entities), level39.base, level39.cities);
  assert.equal(
    round2.after.cities.A.frontType,
    'occluded',
    'the cold front must catch the warm front by round 2',
  );
  assert.equal(
    round2.after.entities.find((entity) => entity.type === 'coldLow')?.frontAge,
    2,
    'round 2 must mature the occlusion',
  );
  // frontAge carried on the entity is the ONLY occlusion gate; reverting to
  // the old compass-placement rule would make both of these red.
  const aged = chasing.map((entity) =>
    entity.type === 'coldLow' ? { ...entity, frontAge: 2 } : entity,
  );
  assert.equal(buildPointWeather(aged, level39.base, AX, AY).frontType, 'occluded');
  assert.notEqual(buildPointWeather(chasing, level39.base, AX, AY).frontType, 'occluded');
}

// Double-layer and depth rules (legacy analytic field; stage 2–3 diagnostics).
{
  const level = getLevel(13);
  const base = { ...level.base, physics: undefined, domainScale: undefined };
  const deepHigh = createEntity('warmHigh', A.x, A.y, 20, { id: 'deep-high' });
  const shallowHigh = createEntity('coldHigh', A.x, A.y, 20, { id: 'shallow-high' });
  const deepLow = createEntity('coldLow', A.x, A.y, 20, { id: 'deep-low' });
  const shallowLow = createEntity('warmLow', A.x, A.y, 20, { id: 'shallow-low' });
  assert.equal(deepHigh.depth, 'deep');
  assert.equal(shallowHigh.depth, 'shallow');
  assert.equal(deepLow.depth, 'deep');
  assert.equal(shallowLow.depth, 'shallow');
  const high = buildPointWeather([deepHigh], base, AX, AY);
  const shallow = buildPointWeather([shallowHigh], base, AX, AY);
  assert.ok(high.pHigh > shallow.pHigh + 5);
  assert.ok(high.wHigh < -1);
  assert.ok(Math.abs(shallow.wHigh) < 0.5);
  const low = buildPointWeather([deepLow], base, AX, AY);
  const warmLow = buildPointWeather([shallowLow], base, AX, AY);
  assert.ok(low.wHigh > 1);
  assert.ok(Math.abs(warmLow.wHigh) < 0.5);
  assert.ok(low.W > warmLow.W + 2, 'Deep low must support stronger combined ascent');
  const grid = buildGrid([deepHigh], base, GRID_N);
  assert.equal(grid.pLow.length, GRID_N * GRID_N);
  assert.equal(grid.pHigh.length, GRID_N * GRID_N);
  assert.equal(grid.wLow.length, GRID_N * GRID_N);
  assert.equal(GRID_N, Math.floor(MAP_SIZE / GRID_SPACING) + 1);
}

// Trough deepening, ridge suppression, stratification, air mass and shear.
{
  const level = getLevel(0);
  const low = createEntity('coldLow', A.x, A.y, 20, { id: 'low' });
  const trough = createEntity('trough', A.x, A.y, 2, { id: 'trough', layer: 'high' });
  const ridge = createEntity('ridge', A.x, A.y, 2, { id: 'ridge', layer: 'high' });
  const base = buildPointWeather([low], level.base, AX, AY);
  const deepened = buildPointWeather([low, trough], level.base, AX, AY);
  const suppressed = buildPointWeather([low, ridge], level.base, AX, AY);
  assert.ok(deepened.pLow < base.pLow, 'Trough should deepen a surface low');
  assert.ok(suppressed.wHigh < deepened.wHigh, 'Ridge should suppress high-level lift');

  const unstable = createEntity('inversion', A.x, A.y, 1, { id: 'unstable', inversionMode: 'unstable' });
  const stable = createEntity('inversion', A.x, A.y, 1, { id: 'stable', inversionMode: 'stable' });
  const warm = createEntity('warmHigh', 700, 700, 20, { id: 'warm-high' });
  assert.ok(
    buildPointWeather([low, warm, unstable], level.base, AX, AY).W >
      buildPointWeather([low, warm, stable], level.base, AX, AY).W,
    'Unstable stratification should amplify ascent',
  );

  const mT = createEntity('warmAir', 286, 322, 10, { id: 'warm' });
  const wet = createEntity('wet', 286, 322, 40, { id: 'wet' });
  assert.equal(buildPointWeather([mT, wet], getLevel(11).base, 286 * S, 322 * S).airMass, 'mT');
}

// Isobar analysis field: anisotropic centres and shape-following contours.
{
  const level = getLevel(0);
  const high = createEntity('warmHigh', 400, 400, 20, { id: 'analysis-high' });
  const profile = pressureProfileFor(high);
  const along = pressureInfluence(
    high,
    PX + Math.cos(profile.angle) * 140 * S,
    PY + Math.sin(profile.angle) * 140 * S,
  );
  const across = pressureInfluence(
    high,
    PX - Math.sin(profile.angle) * 140 * S,
    PY + Math.cos(profile.angle) * 140 * S,
  );
  assert.ok(along > across * 1.25, 'Pressure influence must be anisotropic');

  const points = [];
  for (let i = 0; i < 24; i += 1) {
    const angle = (i / 24) * Math.PI * 2;
    points.push({ x: Math.cos(angle) * 150, y: Math.sin(angle) * 48 });
  }
  const shaped = createEntity('coldLow', 400, 400, 20, {
    id: 'analysis-shape',
    shape: points,
  });
  assert.ok(
    pressureInfluence(shaped, PX + 120 * S, PY) >
      pressureInfluence(shaped, PX, PY + 120 * S) * 2,
    'Edited outlines must produce shape-following isobars instead of rings',
  );

  const grid = buildPressureGrid([high], level.base, 65);
  assert.equal(grid.values.length, 65 * 65);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of grid.values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  assert.ok(max > level.base.P + 10 && min <= level.base.P, 'Analysis grid must contain the pressure centre');
}

// Surface-dependent cross-isobar angle.
assert.equal(crossIsobarAngleFor('sea'), 18);
assert.equal(crossIsobarAngleFor('land'), 30);
assert.equal(crossIsobarAngleFor('mountain'), 38);
{
  const terrain = getLevel(23);
  assert.equal(surfaceKindAt(terrain.base, 108 * S, 600 * S), 'mountain');
  assert.equal(surfaceKindAt(terrain.base, 286 * S, 322 * S), 'land');
  assert.equal(surfaceKindAt(terrain.base, 720 * S, 400 * S), 'sea');
}

// Terrain and placeholder metadata.
assert.equal(getLevel(10).hasTerrain, true);
assert.equal(getLevel(0).hasTerrain, undefined);
assert.equal(getLevel(23).hasTerrain, true);
assert.equal(getLevel(24).hasTerrain, true);

// Hemisphere-sensitive wind.
{
  const level = getLevel(4);
  const baseN = { ...level.base, hemisphere: 'N' as const };
  const baseS = { ...level.base, hemisphere: 'S' as const };
  const entities = [
    createEntity('warmHigh', 140, 340, 20, { id: 'high' }),
    createEntity('coldLow', 680, 370, 20, { id: 'low' }),
  ];
  const windN = simulateRound(entities, baseN, level.cities).before.cities.A.wind;
  const windS = simulateRound(entities, baseS, level.cities).before.cities.A.wind;
  assert.ok(Math.hypot(windN.x - windS.x, windN.y - windS.y) > 1);
  assert.ok(Math.abs(windN.towardDeg - windS.towardDeg) > 30);
}

// Tropical cyclone structure, intensity and steering.
{
  const level = getLevel(40);
  const storm = createEntity('typhoon', 680, 560, 50, { id: 'storm' });
  const eye = buildPointWeather([storm], level.base, 850, 700);
  const wall = buildPointWeather([storm], level.base, 925, 700);
  assert.ok(wall.W > eye.W + 2, 'eyewall ascent must exceed eye subsidence');
  assert.ok(wall.R > eye.R + 1, 'eyewall must rain while the eye stays clear');
  assert.ok(wall.Q > eye.Q + 2, 'spiral bands must carry more moisture than the eye');
  assert.equal(buildPointWeather([storm], level.base, 850, 700).hazard, 'none');

  const sea = simulateRound([storm], level.base, level.cities).after.entities[0];
  assert.ok(sea.strength > 50, 'a storm over warm sea must intensify');
  const landStorm = createEntity('typhoon', 360, 400, 50, { id: 'land-storm' });
  const land = simulateRound([landStorm], level.base, level.cities).after.entities[0];
  assert.ok(land.strength < 50, 'landfall must weaken a storm');

  const jet = createEntity('jet', 680, 560, 3, {
    id: 'steer-jet',
    layer: 'high',
    angle: 0,
  });
  const east = simulateRound([storm, jet], level.base, level.cities).after.entities.find(
    (entity) => entity.type === 'typhoon',
  )!;
  const westJet = { ...jet, id: 'steer-jet-w', angle: Math.PI };
  const west = simulateRound([storm, westJet], level.base, level.cities).after.entities.find(
    (entity) => entity.type === 'typhoon',
  )!;
  assert.ok(east.x > west.x, 'jet angle must steer the storm');
}

// Occluded front, freezing rain warm nose and tornado rotation.
{
  const occludedLevel = getLevel(38);
  const occludedCards = () => [
    ...cloneEntities(occludedLevel.initialEntities),
    createEntity('wet', A.x, A.y, 40, { id: 'wet' }),
  ];
  const firstRound = simulateRound(occludedCards(), occludedLevel.base, occludedLevel.cities);
  const first = firstRound.after.cities.A;
  // R6 mechanism: an occlusion is a chase, not a placement.  The very same
  // arrangement in round 1 must not be occluded.
  assert.notEqual(first.frontType, 'occluded', 'occlusion must not appear from geometry alone in round 1');
  const secondRound = simulateRound(
    cloneEntities(firstRound.after.entities),
    occludedLevel.base,
    occludedLevel.cities,
  );
  const occluded = secondRound.after.cities.A;
  assert.equal(occluded.frontType, 'occluded', 'the cold front must catch the warm front by round 2');
  assert.ok(occluded.frontLift > 1);

  const freezeLevel = getLevel(41);
  const surfaceCold = createEntity('coldAir', A.x, A.y, 5, { id: 'cold' });
  const low = createEntity('coldLow', A.x, A.y, 10, { id: 'low' });
  const wet = createEntity('wet', A.x, A.y, 40, { id: 'wet' });
  const warmNose = createEntity('inversion', A.x, A.y, 2, {
    id: 'nose',
    inversionMode: 'stable',
    layer: 'mid',
  });
  const snowOnly = buildPointWeather([surfaceCold, low, wet], freezeLevel.base, A.x * S, A.y * S);
  assert.notEqual(snowOnly.hazard, 'freezingRain', 'surface cold alone must not make freezing rain');
  const freezing = buildPointWeather(
    [surfaceCold, low, wet, warmNose],
    freezeLevel.base,
    A.x * S,
    A.y * S,
  );
  assert.equal(freezing.hazard, 'freezingRain');
  assert.equal(freezing.precipitationType, 'freezingRain');

  const tornadoLevel = getLevel(68);
  const tornado = simulateRound(
    [
      ...cloneEntities(tornadoLevel.initialEntities),
      createEntity('coldLow', A.x, A.y, 20, { id: 'low-a' }),
      createEntity('coldLow', A.x + 20, A.y + 10, 20, { id: 'low-b' }),
      createEntity('coldAir', A.x - 35, A.y, 10, { id: 'cold' }),
      createEntity('warmAir', A.x + 35, A.y, 5, { id: 'warm' }),
    ],
    tornadoLevel.base,
    tornadoLevel.cities,
  ).after.cities.A;
  assert.equal(tornado.hazard, 'tornado');
  assert.ok(tornado.vorticity >= 6);
}

// --- v3.5 mechanics: moisture budget, latent heating, jet band ---
{
  const budgetLevel = getLevel(19);
  activeDomainScale = budgetLevel.base.domainScale ?? 1000;
  const units = [
    createEntity('wet', A.x, A.y, 40, { id: 'budget-wet' }),
    createEntity('coldLow', A.x, A.y, 20, { id: 'budget-low' }),
    createEntity('coldAir', A.x - 45, A.y, 10, { id: 'budget-cold' }),
    createEntity('warmAir', A.x + 45, A.y, 5, { id: 'budget-warm' }),
  ];
  const sim = simulateRound(units, budgetLevel.base, budgetLevel.cities);
  const wetAfter = sim.after.entities.find((entity) => entity.type === 'wet');
  const lowAfter = sim.after.entities.find((entity) => entity.type === 'coldLow');
  assert.ok(
    wetAfter && wetAfter.strength < 40,
    'rain must consume moisture: the wet card has to shrink after a rainy round',
  );
  assert.ok(
    lowAfter && lowAfter.strength > 20,
    'condensation heating must deepen a rainy low by a small amount',
  );

  // A warm low becomes a typhoon only over warm sea and only after two
  // raining rounds; on land it stays a warm low.
  const tropicalLevel = getLevel(54);
  activeDomainScale = tropicalLevel.base.domainScale ?? 1000;
  let seaEntities: WeatherEntity[] = [
    createEntity('warmLow', 608, 512, 20, { id: 'seed-sea' }),
    createEntity('wet', 608, 512, 40, { id: 'seed-wet' }),
  ];
  for (let round = 0; round < 2; round += 1) {
    seaEntities = cloneEntities(
      simulateRound(seaEntities, tropicalLevel.base, tropicalLevel.cities).after.entities,
    );
  }
  assert.equal(
    seaEntities.find((entity) => entity.id === 'seed-sea')?.type,
    'typhoon',
    'a warm low raining over a 30 °C sea for two rounds must become a typhoon',
  );

  let landEntities: WeatherEntity[] = [
    createEntity('warmLow', 420, 430, 20, { id: 'seed-land' }),
    createEntity('wet', 420, 430, 40, { id: 'land-wet' }),
  ];
  for (let round = 0; round < 3; round += 1) {
    landEntities = cloneEntities(
      simulateRound(landEntities, tropicalLevel.base, tropicalLevel.cities).after.entities,
    );
  }
  assert.equal(
    landEntities.find((entity) => entity.id === 'seed-land')?.type,
    'warmLow',
    'a warm low over land must not become a typhoon',
  );

  const jet = createEntity('jet', 500, 500, 3, { id: 'band-jet', angle: 0 });
  const along = influenceAt(jet, 500 + 300, 500);
  const across = influenceAt(jet, 500, 500 + 300);
  assert.ok(
    along > across * 1.5,
    `jet must be a band along its axis (along ${along.toFixed(2)} vs across ${across.toFixed(2)})`,
  );

  // --- T1 mechanism lock: the flux multiplier must not regress to a no-op ---
  // These three values pin the response curve itself, not a level outcome:
  // a calm column is damped, the campaign-median convergence is the neutral
  // point, and strong divergence hits the floor.  Reverting T1 to a constant
  // factor of 1 makes all three fail immediately.
  const calmFactor = moistureFluxFactor(0);
  assert.ok(
    calmFactor >= 0.5 && calmFactor <= 0.6,
    `moistureFluxFactor(0) must be around 0.543 (got ${calmFactor.toFixed(3)})`,
  );
  const referenceFactor = moistureFluxFactor(MOISTURE_FLUX_REFERENCE);
  assert.ok(
    Math.abs(referenceFactor - 1) <= 0.001,
    `moistureFluxFactor(REF) must be 1 (got ${referenceFactor.toFixed(3)})`,
  );
  const divergenceFactor = moistureFluxFactor(-1e-3);
  assert.ok(
    Math.abs(divergenceFactor - 0.4) <= 0.001,
    `moistureFluxFactor(-1e-3) must clamp to 0.4 (got ${divergenceFactor.toFixed(3)})`,
  );

  // --- T1 regression: rain shadow is a moisture-flux effect ---
  // Same cards as pass(46) above (one jet steers Herb onto the windward side);
  // keep the two in sync if that solution changes. A city sits in the lee of the
  // Central Range, where the vapour flux diverges, so its rain must collapse
  // relative to the windward B city instead of tracking the moisture stock.
  const shadowLevel = getLevel(45);
  activeDomainScale = shadowLevel.base.domainScale ?? 1000;
  let shadowEntities = [
    ...cloneEntities(shadowLevel.initialEntities),
    createEntity('jet', 620, 470, 3, { id: 'jet', layer: 'high', angle: 2.9 }),
    createEntity('jet', 680, 448, 3, { id: 'jet-2', layer: 'high', angle: 2.9 }),
    createEntity('coldAir', 630, 448, 20, { id: 't4-cold' }),
    createEntity('warmAir', 730, 448, 10, { id: 't4-warm' }),
  ];
  const shadowRates: { a: number; b: number }[] = [];
  for (let round = 1; round <= 3; round += 1) {
    const shadowSim = simulateRound(shadowEntities, shadowLevel.base, shadowLevel.cities);
    shadowEntities = cloneEntities(shadowSim.after.entities);
    shadowRates.push({ a: shadowSim.after.cities.A.R, b: shadowSim.after.cities.B.R });
  }
  const shadow = shadowRates[shadowRates.length - 1];
  assert.ok(
    shadow.a < shadow.b * 0.2,
    `level 46 rain shadow: lee A city must stay under 20% of windward B city (A.R ${shadow.a.toFixed(2)} vs B.R ${shadow.b.toFixed(2)} mm/3h)`,
  );

  // --- T6 regression: the cold pool reaches the surface temperature ---
  // Same cards as pass(20) above (a cold front that makes its own rain).
  // Evaporative downdraft cooling must be non-trivial, otherwise the pool is a
  // diagnostic that never touches the reported T or the wind field.
  const poolLevel = getLevel(16);
  activeDomainScale = poolLevel.base.domainScale ?? 1000;
  const poolA = cityAt(17, 'A');
  const poolWeather = simulateRound(
    [
      ...cloneEntities(poolLevel.initialEntities),
      createEntity('coldAir', poolA.x, poolA.y, 15, { id: 'pool-cold' }),
      createEntity('warmAir', poolA.x, poolA.y, 5, { id: 'pool-warm' }),
      createEntity('coldLow', poolA.x, poolA.y, 10, { id: 'pool-low' }),
    ],
    poolLevel.base,
    poolLevel.cities,
  ).after.cities.A;
  assert.ok(
    poolWeather.coldPool >= 1,
    `level 17 cold pool must cool the station by at least 1 °C (coldPool ${poolWeather.coldPool.toFixed(2)} °C, T ${poolWeather.T.toFixed(2)} °C, base T ${poolLevel.base.T} °C)`,
  );
}

/*
 * v4.1 · difficulty pilot (levels 14/16/21/27/31/48).
 *
 * Each of these boards used to clear its level by brute force: stack a bigger
 * low, drop a single high on the far city, or bury the city in moisture.  The
 * band conditions added to those levels must keep rejecting them.
 */
fail(14, [
  ...cloneEntities(getLevel(14).initialEntities),
  createEntity('coldLow', A.x, A.y, 20, { id: 'stack-low-1' }),
  createEntity('coldLow', A.x, A.y, 20, { id: 'stack-low-2' }),
  createEntity('wet', A.x, A.y, 40, { id: 'stack-wet' }),
  createEntity('warmHigh', B.x, B.y, 10, { id: 'stack-high' }),
]);
fail(16, [
  ...cloneEntities(getLevel(16).initialEntities),
  createEntity('warmHigh', B.x, B.y, 20, { id: 'overshoot-high' }),
]);
fail(21, [
  createEntity('coldLow', A.x, A.y, 20, { id: 'brute-low' }),
  createEntity('wet', A.x, A.y, 40, { id: 'brute-wet' }),
]);
fail(27, [
  ...cloneEntities(getLevel(27).initialEntities),
  createEntity('warmHigh', A.x, A.y, 20, { id: 'double-high-1' }),
  createEntity('warmHigh', A.x, A.y, 20, { id: 'double-high-2' }),
]);
fail(31, [
  ...cloneEntities(getLevel(31).initialEntities),
  createEntity('warmHigh', A.x, A.y, 20, { id: 'surface-high' }),
]);
fail(48, [
  ...cloneEntities(getLevel(48).initialEntities),
  createEntity('coldAir', A.x, A.y, 10, { id: 'no-wind' }),
]);

assert.deepEqual(failures, [], `\n${failures.join('\n')}`);

console.log('✓ levels 1–72 build and have verified solutions');
console.log('✓ levels 1–7 have alternate solutions');
console.log('✓ fronts, terrain, air mass, three-city, wind and line-feature goals verified');
console.log('✓ four pressure-system types, shallow/deep structure and hazards verified');
console.log('✓ all six stages are playable (campaign has no placeholder levels)');
console.log('✓ dual-layer depth, ridge/trough, stratification and hemisphere rules verified');
console.log('✓ stage 4 upper-air and mesoscale levels verified');
console.log('✓ stage 5 real cases and stage 6 combinations verified');
console.log('✓ typhoon eye/eyewall, landfall decay, jet steering, occluded front, freezing rain and tornado rotation verified');
console.log('✓ moisture budget, latent heating and jet-band geometry verified');
console.log('✓ warm-core low → tropical cyclone phase transition verified (sea yes, land no)');
console.log('✓ rain shadow: the lee city stays under 20% of the windward city (moisture-flux convergence)');
console.log('✓ single frontAt diagnosis and process-based occlusion locks verified');
console.log('✓ cold pool: a rainy station is cooled by ≥1 °C at the surface');
console.log('✓ T5 latent-heat closure: pressure curvature adds capped Ekman lift to W (20 hPa > 5 hPa)');
console.log('✓ T4 thermal wind: jet core speed derives from |∇T| and is zero on a flat field');
console.log('✓ T2 cloud top: one three-level θe profile drives both engines, floored at the 0 °C level');
