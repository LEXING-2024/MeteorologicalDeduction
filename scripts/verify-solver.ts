/**
 * Numerical verification of the rebuilt shallow-water core.
 *
 * Run with:  npm run verify:solver
 *
 * Checks, in order:
 *   1. grid / physical mapping / Float64 storage
 *   2. 20 hPa over 1000 km -> 15-20 m/s geostrophic wind (the P0 acceptance)
 *   3. Coriolis circulation sign (NH low = cyclonic)
 *   4. 3 h closed-basin integration stays finite and CFL bounded
 *   5. exact mass conservation without the sponge
 *   6. sponge mass bookkeeping + boundary damping
 *   7. determinism
 *   8. buffer reuse (no per-step allocation of the prognostic arrays)
 *   9. performance
 */

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { ShallowWaterSolver } from '../experiments/swe/ShallowWaterSolver';
import { sampleField } from '../experiments/swe/physics/thermal';
import { pressureHpaToDepth } from '../experiments/swe/physics/constants';

const DOMAIN_KM = 1000;
const N = 256;
const GRAVITY = 9.8;
const F0 = 1e-4;

function centeredGaussian(n: number, amplitude: number, sigma: number): Float64Array {
  const domain = DOMAIN_KM * 1000;
  const dx = domain / n;
  const h = new Float64Array(n * n);
  const cx = (n * dx) / 2;
  const cy = (n * dx) / 2;
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const x = (i + 0.5) * dx - cx;
      const y = (j + 0.5) * dx - cy;
      h[j * n + i] = -amplitude * Math.exp(-(x * x + y * y) / (2 * sigma * sigma));
    }
  }
  return h;
}

function crossDomainRamp(n: number, amplitude: number): Float64Array {
  const domain = DOMAIN_KM * 1000;
  const dx = domain / n;
  const h = new Float64Array(n * n);
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const x = (i + 0.5) * dx;
      h[j * n + i] = -amplitude * ((2 * x) / domain - 1);
    }
  }
  return h;
}

function edgeLow(n: number, amplitude: number, sigma: number): Float64Array {
  const domain = DOMAIN_KM * 1000;
  const dx = domain / n;
  const h = new Float64Array(n * n);
  const cx = 120_000;
  const cy = domain / 2;
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const x = (i + 0.5) * dx - cx;
      const y = (j + 0.5) * dx - cy;
      h[j * n + i] = -amplitude * Math.exp(-(x * x + y * y) / (2 * sigma * sigma));
    }
  }
  return h;
}

function massInvariantError(solver: ShallowWaterSolver, initialMass: number): number {
  return Math.abs(solver.totalHeight() + solver.spongeMassRemoved - initialMass);
}

function sameArray(a: Float64Array, b: Float64Array): boolean {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k += 1) if (a[k] !== b[k]) return false;
  return true;
}

console.log('== numerical shallow-water checks ==');
const solver = new ShallowWaterSolver({ n: N, domainKm: DOMAIN_KM, spongeCells: 10 });
assert.ok(solver.dx > 3800 && solver.dx < 4000, `unexpected dx ${solver.dx}`);
assert.equal(solver.spongeCells, 10);
assert.ok(solver.h instanceof Float64Array, 'h must be Float64Array');
assert.ok(solver.u instanceof Float64Array, 'u must be Float64Array');
assert.ok(solver.v instanceof Float64Array, 'v must be Float64Array');
const exported = solver.exportForRendering();
assert.ok(exported.pressureHpa instanceof Float32Array, 'render export must be Float32Array');
assert.equal(exported.pressureHpa.length, N * N);
console.log('grid', {
  n: N,
  dxMetres: Number(solver.dx.toFixed(2)),
  domainKm: solver.domainKm,
  f: solver.f,
});

// Screen orientation contract: default export is north-up (row 0 = north).
const orientation = new ShallowWaterSolver({ n: 64, domainKm: DOMAIN_KM });
const northBump = centeredGaussian(64, 0, 1);
northBump.fill(0);
for (let j = 0; j < 64; j += 1) {
  for (let i = 0; i < 64; i += 1) {
    const x = (i + 0.5) * orientation.dx - 250_000;
    const y = (j + 0.5) * orientation.dx - 750_000;
    northBump[j * 64 + i] = -83 * Math.exp(-(x * x + y * y) / (2 * 80_000 * 80_000));
  }
}
orientation.setInitialHeight(northBump);
const northUp = orientation.exportForRendering();
const native = orientation.exportForRendering({ flipY: false, screenV: false });
function deepestCell(field: Float32Array, n: number): number {
  let best = Number.POSITIVE_INFINITY;
  let bestIndex = 0;
  for (let k = 0; k < field.length; k += 1) {
    if (field[k] < best) {
      best = field[k];
      bestIndex = k;
    }
  }
  return Math.floor(bestIndex / n);
}
const northUpRow = deepestCell(northUp.pressureHpa, 64);
const nativeRow = deepestCell(native.pressureHpa, 64);
assert.ok(northUpRow < 24, `north-up export should put the northern low in the top half, got ${northUpRow}`);
assert.ok(nativeRow > 40, `native export should put the northern low in the bottom half, got ${nativeRow}`);
console.log('screen orientation', { northUpRow, nativeRow });

// ---------------------------------------------------------------- 2. 20 hPa
const rampAmplitude = pressureHpaToDepth(10); // +10 / -10 hPa = a 20 hPa difference
const ramp = crossDomainRamp(N, rampAmplitude);
solver.setInitialHeight(ramp);
solver.initializeGeostrophic();
const geostrophic = (GRAVITY / F0) * ((-2 * rampAmplitude) / (DOMAIN_KM * 1000));
const centreV = solver.v[(N >> 1) * N + (N >> 1)];
const centreU = solver.u[(N >> 1) * (N + 1) + (N >> 1)];
const initialSpeed = solver.maxSpeed();
assert.ok(initialSpeed >= 15 && initialSpeed <= 20, `20 hPa -> ${initialSpeed.toFixed(2)} m/s, expected 15-20`);
assert.ok(Math.abs(centreV - geostrophic) < 0.05, `centre v ${centreV} != geostrophic ${geostrophic}`);
assert.ok(Math.abs(centreU) < 1e-9, `ramp should have no u component, got ${centreU}`);
assert.ok(solver.maxRossbyNumber() < 0.05, 'a domain-scale ramp must be geostrophic');
console.log('20 hPa / 1000 km', {
  maxSpeed: Number(initialSpeed.toFixed(3)),
  centreV: Number(centreV.toFixed(3)),
  geostrophic: Number(geostrophic.toFixed(3)),
  rossby: Number(solver.maxRossbyNumber().toFixed(4)),
});

// The first 10 minutes of SWE integration must preserve the conversion.
solver.advance(600);
const afterTenMinutes = solver.maxSpeed();
assert.ok(afterTenMinutes >= 15 && afterTenMinutes <= 20, `10 min wind ${afterTenMinutes.toFixed(2)} left 15-20`);
console.log('after 10 min', { maxSpeed: Number(afterTenMinutes.toFixed(3)), cfl: Number(solver.lastCfl.toFixed(3)) });

// ------------------------------------------------------- 3. Coriolis sign
function circulationAtEast(amplitude: number, hemisphere: 'N' | 'S' = 'N'): number {
  const local = new ShallowWaterSolver({ n: 128, domainKm: DOMAIN_KM, hemisphere });
  local.setInitialHeight(centeredGaussian(128, amplitude, 250_000));
  local.initializeGeostrophic();
  local.updateCellVelocity();
  const dx = local.dx;
  const x = local.domainMetres / 2 + 150_000;
  const y = local.domainMetres / 2;
  return sampleField(local.cellV, 128, dx, x, y);
}
const lowEastV = circulationAtEast(42.5);
const highEastV = circulationAtEast(-42.5);
const lowEastSouth = circulationAtEast(42.5, 'S');
assert.ok(lowEastV > 0, `NH low should be cyclonic (east side v > 0), got ${lowEastV}`);
assert.ok(highEastV < 0, `NH high should be anticyclonic (east side v < 0), got ${highEastV}`);
assert.ok(lowEastSouth < 0, `SH low should rotate the other way, got ${lowEastSouth}`);
console.log('coriolis sign', {
  lowEastV: Number(lowEastV.toFixed(2)),
  highEastV: Number(highEastV.toFixed(2)),
  lowEastSouth: Number(lowEastSouth.toFixed(2)),
});

// ---------------------------------------------- 4. 3 h closed-basin stability
const longRun = new ShallowWaterSolver({ n: N, domainKm: DOMAIN_KM, spongeCells: 10 });
longRun.setInitialHeight(centeredGaussian(N, 85, 300_000));
longRun.initializeGeostrophic();
const longInitialMass = longRun.totalHeight();
const performanceStart = performance.now();
longRun.step(10, 1080); // 3 h in 1080 external 10 s steps
const longElapsed = performance.now() - performanceStart;
const longStats = longRun.stats();
assert.ok(longStats.finite, '3 h run produced non-finite values');
assert.ok(longStats.maxSpeed < 40, `3 h max speed ${longStats.maxSpeed.toFixed(2)} m/s is too high`);
assert.ok(longRun.maxAbsHeight() < 400, `3 h height anomaly ${longRun.maxAbsHeight().toFixed(1)} m is too high`);
assert.ok(longRun.boundarySpeed() === 0, 'closed boundary normal velocity must be exactly zero');
assert.ok(longRun.lastCfl <= longRun.cflLimit + 0.02, `CFL ${longRun.lastCfl} exceeded ${longRun.cflLimit}`);
assert.ok(massInvariantError(longRun, longInitialMass) < 1e-4, 'sponge mass bookkeeping drifted');
console.log('3 h Gaussian low', {
  maxSpeed: Number(longStats.maxSpeed.toFixed(2)),
  maxHeight: Number(longRun.maxAbsHeight().toFixed(2)),
  lastDt: Number(longRun.lastDt.toFixed(2)),
  lastCfl: Number(longRun.lastCfl.toFixed(3)),
  substeps: longStats.substeps,
  massError: massInvariantError(longRun, longInitialMass),
  wallMs: Number(longElapsed.toFixed(0)),
});
assert.ok(longElapsed < 30_000, `3 h run took ${longElapsed.toFixed(0)} ms`);

// The 20 hPa ramp itself must survive 3 h without a boundary explosion.
const rampRun = new ShallowWaterSolver({ n: 128, domainKm: DOMAIN_KM });
rampRun.setInitialHeight(crossDomainRamp(128, rampAmplitude));
rampRun.initializeGeostrophic();
rampRun.advance(3 * 3600);
assert.ok(rampRun.stats().finite, '20 hPa ramp blew up');
assert.ok(rampRun.maxAbsHeight() < 200, `ramp height ${rampRun.maxAbsHeight().toFixed(1)} m`);
assert.ok(rampRun.boundarySpeed() === 0, 'ramp boundary velocity');
console.log('3 h 20 hPa ramp', {
  maxSpeed: Number(rampRun.maxSpeed().toFixed(2)),
  maxHeight: Number(rampRun.maxAbsHeight().toFixed(2)),
  finite: rampRun.stats().finite,
});

// ------------------------------------------- 5. exact mass conservation
const conservative = new ShallowWaterSolver({
  n: 128,
  domainKm: DOMAIN_KM,
  spongeCells: 0,
  smoothing: 0,
  viscosity: 0,
});
conservative.setInitialHeight(centeredGaussian(128, 60, 250_000));
conservative.initializeGeostrophic();
const conservativeMass = conservative.totalHeight();
conservative.advance(3 * 3600);
const relativeDrift = Math.abs((conservative.totalHeight() - conservativeMass) / conservativeMass);
assert.ok(relativeDrift < 1e-12, `exact mass conservation failed: ${relativeDrift}`);
console.log('closed-domain mass conservation', {
  relativeDrift,
  maxSpeed: Number(conservative.maxSpeed().toFixed(2)),
});

// ------------------------------------------------------ 6. sponge behaviour
const sponged = new ShallowWaterSolver({ n: 128, domainKm: DOMAIN_KM, spongeCells: 10 });
sponged.setInitialHeight(edgeLow(128, 85, 150_000));
sponged.initializeGeostrophic();
const spongedMass = sponged.totalHeight();
sponged.advance(3 * 3600);
const spongedStats = sponged.stats();
assert.ok(spongedStats.finite, 'sponged edge system blew up');
assert.equal(sponged.boundarySpeed(), 0);
assert.ok(Math.abs(spongedStats.spongeMassRemoved) > 1, 'sponge did nothing');
assert.ok(massInvariantError(sponged, spongedMass) < 1e-4, 'sponge mass bookkeeping');
console.log('sponge edge low', {
  maxSpeed: Number(spongedStats.maxSpeed.toFixed(2)),
  edgeHeight: Number(sponged.h[64 * 128].toFixed(2)),
  spongeMassChange: Number(spongedStats.spongeMassRemoved.toFixed(1)),
  massError: massInvariantError(sponged, spongedMass),
});

// ---------------------------------------------------------- 7. determinism
function runDeterministic(): ShallowWaterSolver {
  const local = new ShallowWaterSolver({ n: 128, domainKm: DOMAIN_KM });
  local.setInitialHeight(centeredGaussian(128, 85, 300_000));
  local.initializeGeostrophic();
  local.advance(3600);
  return local;
}
const detA = runDeterministic();
const detB = runDeterministic();
assert.ok(sameArray(detA.h, detB.h), 'h is not deterministic');
assert.ok(sameArray(detA.u, detB.u), 'u is not deterministic');
assert.ok(sameArray(detA.v, detB.v), 'v is not deterministic');
console.log('determinism', { h: true, u: true, v: true });

// ------------------------------------------------- 8. buffer reuse / GC
const allocTest = new ShallowWaterSolver({ n: 128, domainKm: DOMAIN_KM });
allocTest.setInitialHeight(centeredGaussian(128, 60, 250_000));
allocTest.initializeGeostrophic();
const heightRefs = new Set<Float64Array>();
const uRefs = new Set<Float64Array>();
const vRefs = new Set<Float64Array>();
const heapBefore = process.memoryUsage().heapUsed;
for (let step = 0; step < 30; step += 1) {
  allocTest.advance(10);
  heightRefs.add(allocTest.h);
  uRefs.add(allocTest.u);
  vRefs.add(allocTest.v);
}
const heapAfter = process.memoryUsage().heapUsed;
assert.ok(heightRefs.size <= 2, `height buffer churn: ${heightRefs.size}`);
assert.ok(uRefs.size <= 2, `u buffer churn: ${uRefs.size}`);
assert.ok(vRefs.size <= 2, `v buffer churn: ${vRefs.size}`);
assert.ok(heapAfter - heapBefore < 8 * 1024 * 1024, `heap grew ${(heapAfter - heapBefore) / 1e6} MB`);
console.log('buffer reuse', {
  heightBuffers: heightRefs.size,
  uBuffers: uRefs.size,
  vBuffers: vRefs.size,
  heapGrowthKb: Number(((heapAfter - heapBefore) / 1024).toFixed(1)),
});

console.log('== numerical checks passed ==');
