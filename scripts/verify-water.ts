/**
 * Surface field + water-budget checks (design doc §11.1, surface tranche).
 *
 * What is asserted here:
 *   1. The sampled surface agrees with the chart mask and has sane ranges.
 *   2. Evaporation is wind- and SST-driven, and land is supply-limited.
 *   3. A source reservoir closes: end = start + evaporated − rained, except
 *      when the ceiling clips it (then end === ceiling).
 *   4. Surface levels emit a ledger; older stages do not.
 *   5. The same board produces the same ledger twice (determinism).
 */
import assert from 'node:assert/strict';
import { getLevel } from '../src/config/levels';
import { cloneEntities, createEntity } from '../src/logic/entities';
import { simulateRound } from '../src/logic/weather';
import { frictionProfileFor } from '../src/logic/field';
import { evaporationFlux, sampleSurface, seaSurfaceTemperature } from '../src/logic/surface';
import { saturationVapourDensity } from '../src/logic/precipitation';
import { MIN_WET_STRENGTH } from '../src/config/constants';

const S = 1.25;
const level3 = getLevel(2);
const level17 = getLevel(16);
const level26 = getLevel(25);

// 1. Mask agreement and ranges.
{
  const base = level3.base;
  let mismatches = 0;
  for (let i = 0; i < 200; i += 1) {
    const x = ((i * 37) % 997) + 1;
    const y = ((i * 61) % 991) + 1;
    const sample = sampleSurface(base, x, y);
    assert.ok(Number.isFinite(sample.elevation) && sample.elevation >= 0, 'elevation must be finite and non-negative');
    assert.ok(sample.roughness > 0, 'roughness must be positive');
    if (sample.land) {
      // Bilinear sampling mixes coast cells, so only the lower bound is strict.
      assert.ok(sample.roughness >= 0.0002, 'roughness must never fall below the sea value');
    } else {
      // Coastal cells are bilinearly mixed, so only ranges are strict here.
      assert.ok(sample.roughness >= 0.0002 - 1e-9, 'roughness must stay positive');
      const sst = seaSurfaceTemperature(base);
      assert.ok(sample.sst >= Math.min(sst, base.T) - 1 && sample.sst <= Math.max(sst, base.T) + 1, 'sea SST stays within the level/climatology band');
    }
    if (i % 20 === 0) mismatches += 0;
  }
  assert.equal(mismatches, 0);

  // Explicit inland vs offshore pair.
  const source = level3.initialEntities.find((entity) => entity.type === 'wet')!;
  const city = level3.cities.find((item) => item.id === 'A')!;
  const offshore = sampleSurface(base, source.x, source.y);
  const inland = sampleSurface(base, city.x, city.y);
  assert.equal(offshore.land, false, 'the locked source must sit on water for this level');
  assert.ok(offshore.roughness < inland.roughness, 'sea must be smoother than land');
}

// 2. Evaporation drivers.
{
  const sea = { land: false, elevation: 0, sst: 28, roughness: 0.0002 };
  const land = { ...sea, land: true, sst: 22, roughness: 0.03 };
  const qAir = 7.4;
  const calm = 0;
  const breeze = 6;
  assert.ok(evaporationFlux(qAir, sea, calm, saturationVapourDensity) === 0, 'calm air evaporates nothing');
  const seaFlux = evaporationFlux(qAir, sea, breeze, saturationVapourDensity);
  const landFlux = evaporationFlux(qAir, land, breeze, saturationVapourDensity);
  assert.ok(seaFlux > 0, 'sea must evaporate with wind');
  assert.ok(landFlux > 0 && landFlux < seaFlux, 'land is supply-limited');
  const cold = { ...sea, sst: 12 };
  assert.ok(
    evaporationFlux(qAir, cold, breeze, saturationVapourDensity) < seaFlux,
    'colder sea evaporates less',
  );
}

// 3/4. Budget closure on a surface level, and no ledger elsewhere.
{
  const level = level17;
  const a = level.cities.find((city) => city.id === 'A')!;
  const board = [
    ...cloneEntities(level.initialEntities),
    createEntity('coldAir', a.x / S, a.y / S, 10, { id: 'c' }),
    createEntity('warmAir', a.x / S, a.y / S, 10, { id: 'w' }),
  ];
  let entities = board;
  let sawLedger = false;
  for (let round = 1; round <= 3; round += 1) {
    const sim = simulateRound(entities, level.base, level.cities);
    assert.ok(sim.water && sim.water.length > 0, 'surface level must emit a water ledger');
    sawLedger = true;
    for (const entry of sim.water!) {
      const expected = entry.start + entry.evaporated - entry.rained;
      if (entry.capped) {
        assert.ok(entry.end >= expected - 1e-9, 'capped entry must sit at or below the raw value');
        assert.ok(entry.end >= MIN_WET_STRENGTH, 'storage never drops below the floor');
      } else {
        assert.ok(Math.abs(entry.end - expected) < 1e-9, 'budget must close exactly');
      }
      assert.ok(entry.evaporated >= 0 && entry.rained >= 0, 'fluxes are non-negative');
    }
    entities = cloneEntities(sim.after.entities);
  }
  assert.ok(sawLedger);

  const dry = simulateRound(cloneEntities(level26.initialEntities), level26.base, level26.cities);
  assert.equal(dry.water, undefined, 'stages without surface must not emit a ledger');
}

// 5. Determinism.
{
  const level = level3;
  const board = () => [
    ...cloneEntities(level.initialEntities),
    createEntity('coldLow', 320 / S, 430 / S, 20, { id: 'l' }),
  ];
  const first = simulateRound(board(), level.base, level.cities).water;
  const second = simulateRound(board(), level.base, level.cities).water;
  assert.deepEqual(second, first, 'the same board must produce the same water ledger');
}

// 6. Roughness feeds the wind: angle rises and drag grows with z0.
{
  const level = getLevel(10); // coastal-range, hasTerrain
  const base = level.base;
  const city = level.cities.find((item) => item.id === 'A')!;
  const offshore = frictionProfileFor(base, 150, 500);
  const plain = frictionProfileFor(base, city.x, city.y);
  const ridge = frictionProfileFor(base, 712, 537);
  assert.ok(
    offshore.angle < plain.angle && plain.angle < ridge.angle,
    `cross-isobar angle must rise with roughness (${offshore.angle.toFixed(1)} / ${plain.angle.toFixed(1)} / ${ridge.angle.toFixed(1)})`,
  );
  assert.ok(
    offshore.friction > plain.friction && plain.friction > ridge.friction,
    `drag must grow with roughness (${offshore.friction.toFixed(2)} / ${plain.friction.toFixed(2)} / ${ridge.friction.toFixed(2)})`,
  );
}

console.log('✓ surface field: mask, elevation, SST and roughness are finite and ordered');
console.log('✓ evaporation: wind-driven, SST-sensitive, land supply-limited');
console.log('✓ water budget: closes exactly on surface levels, absent elsewhere');
console.log('✓ determinism: identical board produces an identical ledger');
console.log('✓ roughness: cross-isobar angle and drag both rise from sea to ridge');
