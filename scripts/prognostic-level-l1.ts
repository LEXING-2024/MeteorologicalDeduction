/**
 * P4 pilot, step 2: judge level 1 from a prognostic snapshot.
 *
 * This is the first time a real level is evaluated against the new engine
 * without touching `simulateRound` or the level data: the adapter turns the
 * solver grid into the campaign snapshot, and the existing goal evaluator runs
 * unchanged.
 */
import assert from 'node:assert/strict';
import { getLevel } from '../src/config/levels';
import { createEntity } from '../src/logic/entities';
import { PrognosticState } from '../src/logic/prognostic/state';
import { buildPrognosticSnapshot } from '../src/logic/prognostic/snapshot';
import { evaluateGoal } from '../src/logic/goal';
import type { WeatherRecord } from '../src/logic/types';

const level = getLevel(0);
const A = level.cities.find((city) => city.id === 'A')!;
const entities = [createEntity('coldLow', A.x, A.y, 10, { id: 'lift', radius: 480 })];

const state = new PrognosticState(level.base, entities, { n: 96, domainKm: 1000 });
const before = buildPrognosticSnapshot(state.field, entities, level.cities);
console.log('before', `P ${before.cities.A.P.toFixed(1)} · W ${before.cities.A.W.toFixed(2)}`);

state.advance(3);
const after = buildPrognosticSnapshot(state.field, entities, level.cities);
const history: WeatherRecord[] = [{ round: 1, cities: after.cities, entities }];
const evaluation = evaluateGoal(level, after, { history });

console.log('after ', `P ${after.cities.A.P.toFixed(1)} · T ${after.cities.A.T.toFixed(1)} · W ${after.cities.A.W.toFixed(2)} · R ${after.cities.A.R.toFixed(2)}`);
console.log('goal  ', evaluation.passed ? 'PASS' : 'FAIL', '|', evaluation.actual);

assert.ok(evaluation.passed, `L1 must pass from a prognostic snapshot (${evaluation.actual})`);
assert.ok(after.cities.A.W > 0.15, 'L1 target W > 0.15 must hold');
assert.ok(Number.isFinite(after.cities.A.P) && after.cities.A.P < level.base.P, 'A must show the low');

console.log('');
console.log('✓ prognostic grid → SimulationSnapshot');
console.log('✓ existing goal evaluator passes L1 unchanged');
console.log('✓ one level can now be judged on the new engine without touching the old one');
