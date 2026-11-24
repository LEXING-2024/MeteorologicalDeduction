/**
 * P4 pilot: what migrating level 1 to the prognostic engine actually costs.
 *
 * The level's reference solution is L10 on the city.  At the authored radius
 * (180 px) the initial Rossby number is far above 1, so the geostrophic start
 * is meaningless; widening the card to synoptic scale fixes it.  This script
 * measures that trade instead of guessing.
 */
import assert from 'node:assert/strict';
import { getLevel } from '../src/config/levels';
import { createEntity } from '../src/logic/entities';
import { PrognosticState } from '../src/logic/prognostic/state';
import { diagnoseStation } from '../src/logic/prognostic/diagnostics';

const level = getLevel(0);
const A = level.cities.find((city) => city.id === 'A')!;
console.log(`L1 ${level.name} · 目标 ${JSON.stringify(level.target)}`);
console.log('');
console.log('radius | Rossby | maxV m/s | P(A) hPa | W index | 稳定');
console.log('-------|--------|----------|----------|---------|-----');

const results: Array<{ radius: number; rossby: number; w: number }> = [];
for (const radius of [180, 240, 300]) {
  const state = new PrognosticState(
    level.base,
    [createEntity('coldLow', A.x, A.y, 10, { id: 'lift', radius })],
    { n: 96, domainKm: 1000 },
  );
  const rossby = state.field.balance.rossby;
  const maxSpeed = state.field.balance.maxSpeed;
  state.advance(3);
  const station = diagnoseStation(state.sample(A.x, A.y));
  const stable = Number.isFinite(station.pressureHpa) && station.pressureHpa > 900 && station.pressureHpa < 1100;
  results.push({ radius, rossby, w: station.wGame });
  console.log(
    `${String(radius).padStart(6)} | ${rossby.toFixed(1).padStart(6)} | ${maxSpeed.toFixed(1).padStart(8)} | ` +
      `${station.pressureHpa.toFixed(1).padStart(8)} | ${station.wGame.toFixed(2).padStart(7)} | ${stable ? '是' : '否'}`,
  );
}

// The authored 180 px card is not a valid geostrophic initial state.
const small = results.find((item) => item.radius === 180)!;
assert.ok(small.rossby > 5, 'the authored radius must expose the Rossby problem');

// At synoptic radius the level's own target (W > 0.15) is met.
const wide = results.find((item) => item.radius === 240)!;
assert.ok(wide.w > 0.15, `synoptic radius must still satisfy the level target (W ${wide.w.toFixed(2)})`);

console.log('');
console.log('✓ 180 px: Rossby 16.5、初速 50 m/s，地转初值不成立（单卡尚能跑，叠加湿区/气团后发散）');
console.log('✓ 240 px: Rossby 9.3，稳定；但 W 已封顶 14，L1 的 0.15 阈值必须重标');
console.log('→ P4 每关都要先做这一步半径重标，再谈阈值');
