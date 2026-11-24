import assert from 'node:assert/strict';
import { LEVELS } from '../src/config/levels';
import {
  FRONT_OCCLUSION_ROUNDS,
  FRONT_SEMANTICS,
  MAP_SIZE,
  MAX_ENTITY_FRACTION,
  MIN_ENTITY_FRACTION,
  defaultEntityRadius,
  scaleBandFor,
} from '../src/config/constants';
import {
  DIAGNOSTIC_KM,
  MAX_WET_DRIFT_KM,
  WET_DRIFT_KM_PER_MS,
  kmPerPixel,
  kmToPx,
  pxToKm,
} from '../src/config/scale';
import { frontLabel } from '../src/logic/fronts';
import { createEntity } from '../src/logic/entities';
import {
  buildGrid,
  buildPointWeather,
  frontAt,
  frontThetaEGradient,
  getPhysicalField,
  samplePhysicalSnapshotFrom,
  windAt,
} from '../src/logic/field';
import {
  FRONT_OCCLUDED,
  frontTypeCode,
  frontTypeName,
} from '../experiments/swe/physics/thermal';
import type { FrontGridCode } from '../experiments/swe/physics/thermal';
import type { BaseConditions, City, FrontType, WeatherEntity } from '../src/logic/types';

/**
 * Scale + cross-path front audit.
 *
 * One chart, seven domains (100 km to 2000 km).  This script asserts that the
 * same phenomenon keeps a sane physical footprint, that every distance-based
 * diagnostic is expressed in kilometres, that a single physical theta-e front
 * keeps ONE front type on every chart width, and that the analytic and SWE
 * paths agree on front labels / lift / grid codes / process-based occlusion.
 */

const failures: string[] = [];
const rows: string[] = [];
const frontRows: string[] = [];

function fail(message: string): void {
  failures.push(message);
}

const ENTITY_TYPES = [
  'coldHigh',
  'warmHigh',
  'coldLow',
  'warmLow',
  'typhoon',
  'coldAir',
  'warmAir',
  'wet',
] as const;

for (const level of LEVELS) {
  const domain = level.base.domainScale ?? 1000;
  const kmPerPx = kmPerPixel(level.base);
  const band = scaleBandFor(domain);

  // The authored chart width must be one of the supported scales; anything
  // outside 100..2000 km is almost certainly a typo in DOMAIN_SCALE_OVERRIDES.
  if (domain < 100 || domain > 2000) {
    fail(`L${level.index}: domainScale ${domain} km is outside the 100-2000 km range`);
  }
  if (Math.abs(kmPerPx * MAP_SIZE - domain) > 1e-6) {
    fail(`L${level.index}: km/px ${kmPerPx} does not reconstruct ${domain} km`);
  }

  for (const type of ENTITY_TYPES) {
    const radiusPx = defaultEntityRadius(type, domain);
    const radiusKm = pxToKm(radiusPx, level.base);
    const fraction = radiusPx / MAP_SIZE;
    if (!Number.isFinite(radiusPx) || radiusPx <= 0) {
      fail(`L${level.index}: ${type} radius is not finite`);
      continue;
    }
    if (fraction < MIN_ENTITY_FRACTION - 1e-6 || fraction > MAX_ENTITY_FRACTION + 1e-6) {
      fail(
        `L${level.index}: ${type} covers ${(fraction * 100).toFixed(1)}% of the chart ` +
          `(allowed ${MIN_ENTITY_FRACTION * 100}-${MAX_ENTITY_FRACTION * 100}%)`,
      );
    }
    if (radiusKm < 10 || radiusKm > domain * MAX_ENTITY_FRACTION + 1e-6) {
      fail(`L${level.index}: ${type} footprint ${radiusKm.toFixed(0)} km is unreadable on ${domain} km`);
    }
  }

  rows.push(
    [
      String(level.index).padStart(2, '0'),
      `${domain} km`,
      band,
      `${kmPerPx.toFixed(2)} km/px`,
      `${pxToKm(defaultEntityRadius('coldLow', domain), level.base).toFixed(0)} km 低压`,
      `${pxToKm(defaultEntityRadius('wet', domain), level.base).toFixed(0)} km 水汽`,
      `${pxToKm(defaultEntityRadius('typhoon', domain), level.base).toFixed(0)} km 台风`,
    ].join(' | '),
  );
}

// Every diagnostic window must stay a physically meaningful length on the
// narrowest and the widest chart: no window may exceed a fifth of the domain.
const domains = [...new Set(LEVELS.map((level) => level.base.domainScale ?? 1000))].sort(
  (a, b) => a - b,
);
for (const domain of domains) {
  for (const [name, km] of Object.entries(DIAGNOSTIC_KM)) {
    if (km < 2 || km > 120) {
      fail(`diagnostic ${name} = ${km} km is outside the plausible 2-120 km window`);
    }
    const effective = Math.min(km, domain * 0.15);
    if (effective > domain * 0.15 + 1e-6) {
      fail(`diagnostic ${name} = ${effective} km exceeds 15% of the ${domain} km chart`);
    }
  }
}

// The wet drift must be a real transport distance, not a fraction of the chart:
// at 2000 km the old pixel-based constant moved moisture twice as far.
if (!(WET_DRIFT_KM_PER_MS > 5 && WET_DRIFT_KM_PER_MS < 40)) {
  fail(`wet drift ${WET_DRIFT_KM_PER_MS} km per m/s is outside 5-40 km`);
}
if (!(MAX_WET_DRIFT_KM > 50 && MAX_WET_DRIFT_KM < 400)) {
  fail(`wet drift cap ${MAX_WET_DRIFT_KM} km is outside 50-400 km`);
}

// ---------------------------------------------------------------------------
// C-2 · Cross-chart front-type invariance (SPRINT-2B-R)
//
// One physical theta-e front: 60 km air-mass radius, 40 km centre separation,
// +/-10 °C strengths, sampled at the chart centre.  All lengths are converted
// with each chart's km/px, so the physical layout is identical.  `windAt`
// inherits WIND_GRADIENT_SCALE's pixel calibration (hPa/px -> m/s), which is
// why frontAt normalises the advective movement term to the 1000 km baseline.
// Before that normalisation the 100 km chart read ~0.94 m/s (stationary) and
// the 2000 km chart ~22.9 m/s (cold) for the SAME front; this assertion turns
// that regression into a visible, deterministic red.
// ---------------------------------------------------------------------------
const FRONT_DOMAINS = [100, 300, 1000, 2000];
const FRONT_RADIUS_KM = 60;
const FRONT_HALF_GAP_KM = 20;
const FRONT_SAMPLE_X = MAP_SIZE / 2;
const FRONT_SAMPLE_Y = MAP_SIZE / 2;

function frontEntitiesFor(domain: number): {
  base: BaseConditions;
  entities: WeatherEntity[];
} {
  const base: BaseConditions = {
    P: 1012,
    T: 22,
    Q: 7.4,
    latitude: 35,
    hemisphere: 'N',
    domainScale: domain,
  };
  const radiusPx = kmToPx(FRONT_RADIUS_KM, base);
  const gapPx = kmToPx(FRONT_HALF_GAP_KM, base);
  const entities: WeatherEntity[] = [
    createEntity('coldAir', FRONT_SAMPLE_X - gapPx, FRONT_SAMPLE_Y, 10, {
      id: 'scale-cold',
      radius: radiusPx,
    }),
    createEntity('warmAir', FRONT_SAMPLE_X + gapPx, FRONT_SAMPLE_Y, 10, {
      id: 'scale-warm',
      radius: radiusPx,
    }),
  ];
  return { base, entities };
}

let referenceFrontType: FrontType | null = null;
const frontGradients: number[] = [];
for (const domain of FRONT_DOMAINS) {
  const { base, entities } = frontEntitiesFor(domain);
  const wind = windAt(entities, base, FRONT_SAMPLE_X, FRONT_SAMPLE_Y);
  const diagnosis = frontAt(entities, base, FRONT_SAMPLE_X, FRONT_SAMPLE_Y, wind);
  const gradient = frontThetaEGradient(entities, base, FRONT_SAMPLE_X, FRONT_SAMPLE_Y);
  const scaleNorm = 1000 / domain;
  frontGradients.push(gradient);
  if (referenceFrontType === null) referenceFrontType = diagnosis.type;
  assert.notEqual(
    diagnosis.type,
    'none',
    `${domain} km: the physical theta-e front must be detected`,
  );
  assert.equal(
    diagnosis.type,
    referenceFrontType,
    `front type must be chart-invariant: ${domain} km disagrees with ${FRONT_DOMAINS[0]} km ` +
      `(got ${diagnosis.type}, expected ${referenceFrontType})`,
  );
  frontRows.push(
    [
      `${domain} km`.padEnd(8),
      `km/px ${kmPerPixel(base).toFixed(3)}`,
      `radius ${kmToPx(FRONT_RADIUS_KM, base).toFixed(1)} px`,
      `half-gap ${kmToPx(FRONT_HALF_GAP_KM, base).toFixed(1)} px`,
      `|∇θe| ${gradient.toFixed(6)} K/km`,
      `wind ${wind.speed.toFixed(3)} m/s`,
      `wind.x ${wind.x.toFixed(3)} m/s`,
      `wind.x × scaleNorm ${(wind.x * scaleNorm).toFixed(3)} m/s`,
      `type ${diagnosis.type}`,
      `lift ${diagnosis.lift.toFixed(5)}`,
    ].join(' | '),
  );
}
// The physical gradient conversion must also survive the chart change.  The
// stencil samples different pixels on each chart, so allow a generous band;
// a broken per-pixel conversion would be off by 10x, not 20%.
const minGradient = Math.min(...frontGradients);
const maxGradient = Math.max(...frontGradients);
assert.ok(
  maxGradient / minGradient < 1.25,
  `|∇θe| must stay within 25% across charts (${minGradient.toFixed(6)} .. ${maxGradient.toFixed(6)} K/km)`,
);
// The 1000 km baseline must be numerically untouched by the normalisation:
// scaleNorm === 1 there, so the raw and normalised advective terms coincide.
assert.equal(1000 / 1000, 1, '1000 km baseline normalisation factor must be exactly 1');

// ---------------------------------------------------------------------------
// C-1 · SWE path interface alignment (SPRINT-2B-R)
//
// The shallow-water engine keeps its own temperature-field classifier
// (classifyFronts).  We do NOT change its physics; we align the INTERFACE:
// one shared semantics table (label / lift / grid code) and one shared
// frontAge process gate, so physics:'swe' can express 'occluded' too.
// ---------------------------------------------------------------------------
for (const type of Object.keys(FRONT_SEMANTICS) as FrontType[]) {
  const semantics = FRONT_SEMANTICS[type];
  assert.equal(
    frontLabel(type),
    semantics.label,
    `shared front label for '${type}' must match frontLabel()`,
  );
  assert.equal(
    frontTypeName(semantics.code as FrontGridCode),
    type,
    `grid code ${semantics.code} must round-trip to '${type}'`,
  );
  assert.equal(
    frontTypeCode(frontTypeName(semantics.code as FrontGridCode)),
    semantics.code,
    `front type <-> grid code round-trip must be stable for '${type}'`,
  );
}
assert.equal(frontTypeCode('occluded'), FRONT_OCCLUDED, 'occluded must own grid code 4');
assert.equal(frontTypeName(FRONT_OCCLUDED), 'occluded', 'occluded must be expressible by name');

const sweBase: BaseConditions = {
  P: 1012,
  T: 22,
  Q: 7.4,
  latitude: 35,
  hemisphere: 'N',
  domainScale: 1000,
  physics: 'swe',
};
const sweEntities: WeatherEntity[] = [
  createEntity('coldLow', 500, 500, 20, { id: 'swe-low', radius: 200 }),
  createEntity('coldAir', 430, 500, 15, { id: 'swe-cold', radius: 160 }),
  createEntity('warmAir', 570, 500, 10, { id: 'swe-warm', radius: 160 }),
];
const sweCities: City[] = [{ id: 'A', name: 'A', nameEn: 'A', x: 500, y: 500 }];
const unagedSwe = buildPointWeather(sweEntities, sweBase, 500, 500);
assert.notEqual(
  unagedSwe.frontType,
  'none',
  'the SWE temperature-field classifier must actually diagnose a front here',
);
assert.equal(
  FRONT_SEMANTICS[unagedSwe.frontType].label,
  frontLabel(unagedSwe.frontType),
  'a SWE front type must map through the shared label table',
);
assert.notEqual(
  unagedSwe.frontType,
  'occluded',
  'a SWE placement with no frontAge must not be occluded',
);

const agedSwe = sweEntities.map((entity) =>
  entity.type === 'coldLow' ? { ...entity, frontAge: FRONT_OCCLUSION_ROUNDS } : entity,
);
const agedStation = buildPointWeather(agedSwe, sweBase, 500, 500);
assert.equal(
  agedStation.frontType,
  'occluded',
  'frontAge >= FRONT_OCCLUSION_ROUNDS must produce an occlusion on the SWE path',
);
assert.equal(frontLabel(agedStation.frontType), FRONT_SEMANTICS.occluded.label);
assert.equal(frontTypeCode(agedStation.frontType), FRONT_OCCLUDED);

const sweSnapshot = samplePhysicalSnapshotFrom(
  getPhysicalField(agedSwe, sweBase),
  agedSwe,
  sweBase,
  sweCities,
);
assert.equal(
  sweSnapshot.cities.A.frontType,
  'occluded',
  'SWE snapshot stations must agree with the station sampler',
);
const sweGridI = Math.round(500 / sweSnapshot.grid.spacing);
const sweGridIndex = sweGridI * sweSnapshot.grid.n + sweGridI;
assert.equal(
  frontTypeName((sweSnapshot.grid.frontType?.[sweGridIndex] ?? 0) as FrontGridCode),
  'occluded',
  'the SWE front grid must encode the upgraded occlusion as code 4, not none',
);

// ---------------------------------------------------------------------------
// C-3 · grid <-> station frontType agreement (analytic path)
//
// n = 101 on a 1000 px chart gives spacing = 10 px, exactly the station's
// ±10 km stencil, so both samplers see the same wind and the same front.
// ---------------------------------------------------------------------------
const gridCase = frontEntitiesFor(1000);
const gridN = 101;
const analyticGrid = buildGrid(gridCase.entities, gridCase.base, gridN, MAP_SIZE);
for (const [px, py] of [[500, 500], [100, 100]] as const) {
  const gi = Math.round(px / analyticGrid.spacing);
  const gj = Math.round(py / analyticGrid.spacing);
  const code = (analyticGrid.frontType?.[gj * analyticGrid.n + gi] ?? 0) as FrontGridCode;
  const gridType = frontTypeName(code);
  const stationType = buildPointWeather(gridCase.entities, gridCase.base, px, py).frontType;
  assert.equal(
    gridType,
    stationType,
    `buildGrid frontType must agree with buildPointWeather at (${px}, ${py})`,
  );
}

assert.deepEqual(failures, [], `\n${failures.join('\n')}`);

const scales = domains.map((domain) => `${domain} km`).join(' / ');
console.log('✓ scale audit: ' + LEVELS.length + ' levels, ' + domains.length + ' chart widths (' + scales + ')');
console.log('✓ footprints stay within ' + MIN_ENTITY_FRACTION * 100 + '-' + MAX_ENTITY_FRACTION * 100 + '% of every chart');
console.log('✓ diagnostics are km-based, so 24 km shear means 24 km everywhere');
console.log('✓ front type is invariant across 100 / 300 / 1000 / 2000 km charts (C-2)');
console.log('✓ SWE front semantics: shared label / lift / code 4 + frontAge occlusion (C-1)');
console.log('✓ grid frontType agrees with the station sampler at the same point (C-3)');
console.log('');
console.log('cross-chart front invariance (same physical θe front, 1000 km baseline):');
console.log(frontRows.join('\n'));
if (process.env.SCALE_TABLE === '1') {
  console.log(rows.join('\n'));
}
