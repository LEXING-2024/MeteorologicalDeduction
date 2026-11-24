/**
 * Physical acceptance tests for the rebuilt bottom layer.
 *
 * Run with:  npm run verify:solver-physical
 *
 * Covers:
 *   1. 20 hPa / 1000 km -> 15-20 m/s (the P0 acceptance number)
 *   2. hydrostatic temperature -> pressure coupling (cold high / warm low)
 *   3. semi-Lagrangian temperature advection
 *   4. physical front extraction (cold / warm / stationary)
 *   5. orographic lift W_terrain = V . grad(z)
 *   6. full card -> field -> 2 h spin-up integration
 *   7. multi-scale domains (300 / 200 / 50 km) remain CFL bounded
 */

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { ShallowWaterSolver } from '../experiments/swe/ShallowWaterSolver';
import { WeatherField } from '../experiments/swe/physics/WeatherField';
import {
  advectScalarSL,
  type FrontTypeCode,
} from '../experiments/swe/physics/thermal';
import {
  depthToPressureHpa,
  pressureHpaToDepth,
  temperatureToDepth,
} from '../experiments/swe/physics/constants';
import type { WeatherEntity } from '../src/logic/types';

function card(
  type: WeatherEntity['type'],
  x: number,
  y: number,
  strength: number,
  radius = 160,
): WeatherEntity {
  return {
    id: `${type}-${x}-${y}-${strength}`,
    type,
    depth: 'none',
    layer: 'low',
    x,
    y,
    strength,
    radius,
  };
}

function gaussian(n: number, domain: number, amplitude: number, sigma: number): Float64Array {
  const dx = domain / n;
  const h = new Float64Array(n * n);
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const x = (i + 0.5) * dx - domain / 2;
      const y = (j + 0.5) * dx - domain / 2;
      h[j * n + i] = -amplitude * Math.exp(-(x * x + y * y) / (2 * sigma * sigma));
    }
  }
  return h;
}

console.log('== physical engine checks ==');

// ------------------------------------------------- 1. 20 hPa conversion
const domainMetres = 1_000_000;
const conversion = new ShallowWaterSolver({ n: 256, domainKm: 1000 });
const ramp = new Float64Array(256 * 256);
const rampAmplitude = pressureHpaToDepth(10);
for (let j = 0; j < 256; j += 1) {
  for (let i = 0; i < 256; i += 1) {
    const x = (i + 0.5) * conversion.dx;
    ramp[j * 256 + i] = -rampAmplitude * ((2 * x) / domainMetres - 1);
  }
}
conversion.setInitialHeight(ramp);
conversion.initializeGeostrophic();
const conversionSpeed = conversion.maxSpeed();
assert.ok(
  conversionSpeed >= 15 && conversionSpeed <= 20,
  `20 hPa / 1000 km -> ${conversionSpeed.toFixed(2)} m/s`,
);
console.log('1. 20 hPa / 1000 km', {
  speed: Number(conversionSpeed.toFixed(2)),
  expected: '15-20',
  pass: true,
});

// ---------------------------------------------- 2. thermal -> pressure
const coldDepth = temperatureToDepth(-10, 295.15);
const warmDepth = temperatureToDepth(10, 295.15);
const coldHpa = depthToPressureHpa(coldDepth);
assert.ok(coldDepth > 0 && warmDepth < 0, 'cold must raise pressure, warm must lower it');
assert.ok(coldHpa > 8 && coldHpa < 8.3, `thermal depth scale ${coldHpa}`);

const base = { P: 1012, T: 22, Q: 7.4, latitude: 45, hemisphere: 'N' as const };
const coldField = new WeatherField({ n: 128, domainKm: 1000, base });
coldField.loadEntities([card('coldAir', 400, 400, 10)]);
const coldCentre = coldField.sampleScreen(400, 400);
assert.ok(Math.abs(coldCentre.temperatureC - 12) < 0.05, 'cold card temperature');
assert.ok(Math.abs(coldCentre.pressureHpa - (1012 + coldHpa)) < 0.15, 'cold card pressure');
const coldEast = coldField.sampleScreen(550, 400);
assert.ok(coldEast.v < 0, 'a NH thermal high must be anticyclonic');

const warmField = new WeatherField({ n: 128, domainKm: 1000, base });
warmField.loadEntities([card('warmAir', 400, 400, 10)]);
const warmCentre = warmField.sampleScreen(400, 400);
assert.ok(Math.abs(warmCentre.temperatureC - 32) < 0.05, 'warm card temperature');
assert.ok(Math.abs(warmCentre.pressureHpa - (1012 - coldHpa)) < 0.15, 'warm card pressure');
const warmEast = warmField.sampleScreen(550, 400);
assert.ok(warmEast.v > 0, 'a NH thermal low must be cyclonic');
console.log('2. temperature -> pressure', {
  coldDepth: Number(coldDepth.toFixed(2)),
  coldPressureHpa: Number(coldCentre.pressureHpa.toFixed(2)),
  warmPressureHpa: Number(warmCentre.pressureHpa.toFixed(2)),
  pass: true,
});

// ------------------------------------------------ 3. scalar advection
const advectionN = 128;
const advectionDx = domainMetres / advectionN;
const tracer = new Float64Array(advectionN * advectionN);
const tracerNext = new Float64Array(advectionN * advectionN);
const tracerU = new Float64Array(advectionN * advectionN);
const tracerV = new Float64Array(advectionN * advectionN);
const tracerSigma = 30_000;
for (let j = 0; j < advectionN; j += 1) {
  for (let i = 0; i < advectionN; i += 1) {
    const x = (i + 0.5) * advectionDx - domainMetres / 2;
    const y = (j + 0.5) * advectionDx - domainMetres / 2;
    tracer[j * advectionN + i] = 20 * Math.exp(-(x * x + y * y) / (2 * tracerSigma * tracerSigma));
  }
}
tracerU.fill(10);
tracerV.fill(0);
function centroid(field: Float64Array): number {
  let sum = 0;
  let weighted = 0;
  for (let j = 0; j < advectionN; j += 1) {
    for (let i = 0; i < advectionN; i += 1) {
      const value = field[j * advectionN + i];
      sum += value;
      weighted += value * ((i + 0.5) * advectionDx);
    }
  }
  return weighted / sum;
}
const centroidBefore = centroid(tracer);
let tracerA = tracer;
let tracerB = tracerNext;
for (let step = 0; step < 360; step += 1) {
  advectScalarSL(tracerA, tracerB, tracerU, tracerV, advectionN, advectionDx, 10);
  const swap = tracerA;
  tracerA = tracerB;
  tracerB = swap;
}
const centroidAfter = centroid(tracerA);
const displacement = centroidAfter - centroidBefore;
let peakAfter = 0;
for (let k = 0; k < tracerA.length; k += 1) peakAfter = Math.max(peakAfter, tracerA[k]);
assert.ok(Math.abs(displacement - 36_000) < 2500, `advection displacement ${displacement.toFixed(0)} m`);
assert.ok(peakAfter > 16, `advection diffused the peak to ${peakAfter.toFixed(1)}`);
console.log('3. semi-Lagrangian advection', {
  displacementKm: Number((displacement / 1000).toFixed(2)),
  expectedKm: 36,
  peakAfter: Number(peakAfter.toFixed(2)),
  pass: true,
});

// ----------------------------------------------- 4. front extraction
function frontCase(
  thermalGradientEast: boolean,
  wind: 'east' | 'west' | 'along',
): { type: FrontTypeCode; strength: number; advectionKh: number } {
  const n = 128;
  const field = new WeatherField({ n, domainKm: 1000, base });
  const dx = field.dx;
  const height = new Float64Array(n * n);
  const temperature = new Float64Array(n * n);
  const amplitude = pressureHpaToDepth(10);
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const x = (i + 0.5) * dx;
      const y = (j + 0.5) * dx;
      const alongX = (2 * x) / field.domainMetres - 1;
      const alongY = (2 * y) / field.domainMetres - 1;
      // h = -A * eta gives a positive v; h = +A * eta gives a negative v.
      if (wind === 'east') height[j * n + i] = -amplitude * alongY;
      else if (wind === 'west') height[j * n + i] = amplitude * alongY;
      else height[j * n + i] = -amplitude * alongX;
      temperature[j * n + i] = 22 + (thermalGradientEast ? 20 : -20) * alongX;
    }
  }
  field.setHeight(height);
  field.setTemperature(temperature);
  field.commit(true);
  const sample = field.sampleMetres(field.domainMetres / 2, field.domainMetres / 2);
  return {
    type: sample.front.type === 'cold' ? 1 : sample.front.type === 'warm' ? 2 : sample.front.type === 'stationary' ? 3 : 0,
    strength: sample.front.strength,
    advectionKh: sample.front.advectionKh,
  };
}
const coldFront = frontCase(true, 'east');
const warmFront = frontCase(true, 'west');
const stationary = frontCase(true, 'along');
assert.equal(coldFront.type, 1, 'east wind + east gradient should be a cold front');
assert.equal(warmFront.type, 2, 'west wind + east gradient should be a warm front');
assert.equal(stationary.type, 3, 'along-isotherm wind should be a stationary front');
assert.ok(coldFront.strength > 0.5 && warmFront.strength > 0.5, 'front strength');
console.log('4. front extraction', {
  cold: { type: coldFront.type, strength: Number(coldFront.strength.toFixed(2)), advectionKh: Number(coldFront.advectionKh.toFixed(2)) },
  warm: { type: warmFront.type, strength: Number(warmFront.strength.toFixed(2)), advectionKh: Number(warmFront.advectionKh.toFixed(2)) },
  stationary: { type: stationary.type, strength: Number(stationary.strength.toFixed(2)) },
  pass: true,
});

// -------------------------------------------------- 5. terrain lift
const terrainField = new WeatherField({ n: 128, domainKm: 1000, base });
const terrainN = terrainField.n;
const terrainDx = terrainField.dx;
const terrain = new Float64Array(terrainN * terrainN);
for (let j = 0; j < terrainN; j += 1) {
  for (let i = 0; i < terrainN; i += 1) {
    const x = (i + 0.5) * terrainDx;
    terrain[j * terrainN + i] = 1200 * Math.exp(-(((x - domainMetres / 2) / 80_000) ** 2));
  }
}
terrainField.setTerrain(terrain);
const terrainHeight = new Float64Array(terrainN * terrainN);
for (let j = 0; j < terrainN; j += 1) {
  for (let i = 0; i < terrainN; i += 1) {
    const y = (j + 0.5) * terrainDx;
    terrainHeight[j * terrainN + i] = pressureHpaToDepth(10) * ((2 * y) / domainMetres - 1);
  }
}
terrainField.setHeight(terrainHeight);
terrainField.commit(true);
const windward = terrainField.sampleMetres(domainMetres / 2 + 50_000, domainMetres / 2);
const lee = terrainField.sampleMetres(domainMetres / 2 - 50_000, domainMetres / 2);
assert.ok(windward.wTerrain > 0.1, `windward lift ${windward.wTerrain}`);
assert.ok(lee.wTerrain < -0.1, `lee lift ${lee.wTerrain}`);
assert.ok(windward.elevationMetres > 500, 'terrain sampling');
console.log('5. terrain lift', {
  windwardW: Number(windward.wTerrain.toFixed(3)),
  leeW: Number(lee.wTerrain.toFixed(3)),
  elevation: Number(windward.elevationMetres.toFixed(0)),
  pass: true,
});

// -------------------------------------- 6. full card spin-up integration
const scenario = new WeatherField({ n: 128, domainKm: 1000, base });
scenario.loadEntities([
  card('coldAir', 250, 400, 10),
  card('warmAir', 550, 400, 10),
  card('coldHigh', 400, 560, 5),
  card('coldLow', 400, 240, 5),
]);
const scenarioStart = scenario.sampleScreen(400, 400);
const scenarioTimer = performance.now();
scenario.run(2 * 3600, 10);
const scenarioElapsed = performance.now() - scenarioTimer;
const scenarioEnd = scenario.sampleScreen(400, 400);
const grid = scenario.buildGrid(128);
assert.ok(scenario.solver.stats().finite, 'card scenario blew up');
assert.ok(grid.pressureHpa instanceof Float32Array, 'grid pressure must be Float32');
let maxFront = 0;
let maxW = 0;
for (let k = 0; k < grid.frontStrength.length; k += 1) {
  if (grid.frontStrength[k] > maxFront) maxFront = grid.frontStrength[k];
  maxW = Math.max(maxW, grid.wGame[k]);
}
assert.ok(maxFront > 0.5, `no front detected, max ${maxFront}`);
assert.ok(maxW > 3, `no meaningful ascent, max W ${maxW}`);
assert.ok(Math.abs(scenarioEnd.temperatureC - scenarioStart.temperatureC) > 0.2, 'temperature did not evolve');
assert.ok(Math.abs(scenarioEnd.pressureHpa - scenarioStart.pressureHpa) > 0.2, 'pressure did not evolve');
console.log('6. card spin-up', {
  centrePressure: [Number(scenarioStart.pressureHpa.toFixed(1)), Number(scenarioEnd.pressureHpa.toFixed(1))],
  centreTemperature: [Number(scenarioStart.temperatureC.toFixed(1)), Number(scenarioEnd.temperatureC.toFixed(1))],
  maxFront: Number(maxFront.toFixed(2)),
  maxW: Number(maxW.toFixed(2)),
  rossby: Number(scenario.balance.rossby.toFixed(2)),
  wallMs: Number(scenarioElapsed.toFixed(0)),
  pass: true,
});

// ------------------------------------------------ 7. multi-scale domains
for (const [domainKm, n, amplitude, sigmaMetres] of [
  [300, 128, 2, 60_000],
  [200, 128, 1.5, 40_000],
  [50, 64, 0.5, 10_000],
] as const) {
  const scaleSolver = new ShallowWaterSolver({ n, domainKm });
  scaleSolver.setInitialHeight(gaussian(n, domainKm * 1000, amplitude, sigmaMetres));
  scaleSolver.initializeGeostrophic();
  const start = performance.now();
  scaleSolver.advance(1800);
  const stats = scaleSolver.stats();
  assert.ok(stats.finite, `${domainKm} km domain blew up`);
  assert.ok(scaleSolver.lastCfl <= scaleSolver.cflLimit + 0.02, `${domainKm} km CFL`);
  assert.equal(scaleSolver.boundarySpeed(), 0, `${domainKm} km boundary`);
  console.log(`7. domain ${domainKm} km`, {
    n,
    dxMetres: Number(scaleSolver.dx.toFixed(0)),
    maxSpeed: Number(stats.maxSpeed.toFixed(1)),
    dt: Number(stats.lastDt.toFixed(2)),
    cfl: Number(stats.lastCfl.toFixed(3)),
    substeps: stats.substeps,
    wallMs: Number((performance.now() - start).toFixed(0)),
    pass: true,
  });
}

console.log('== physical checks passed ==');
