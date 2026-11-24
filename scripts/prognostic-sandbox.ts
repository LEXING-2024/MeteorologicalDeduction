/**
 * P1 sandbox: run one prognostic chart end-to-end.
 *
 * It does not touch any level.  The point is to prove the seam works:
 *   entities -> WeatherState -> 6 hourly steps -> station diagnostics.
 * Run with `npm run prognostic:sandbox`.
 */
import assert from 'node:assert/strict';
import { createEntity } from '../src/logic/entities';
import { PrognosticState } from '../src/logic/prognostic/state';
import type { BaseConditions } from '../src/logic/types';

const base: BaseConditions = {
  P: 1012,
  T: 23,
  Q: 7.4,
  latitude: 24,
  hemisphere: 'N',
};

const A = { x: 430, y: 400 };
const B = { x: 680, y: 330 };
const C = { x: 560, y: 650 };
const points = { A, B, C };

function board() {
  // Prognostic cards need synoptic radii: 20 hPa inside 180 km is Rossby > 30
  // and the geostrophic initialisation is meaningless.  15 hPa over 240 px is
  // the smallest setup that stays balanced and still produces ascent.
  return [
    createEntity('coldLow', A.x, A.y, 15, { id: 'low', radius: 240 }),
    createEntity('wet', A.x - 56, A.y + 19, 40, { id: 'source', radius: 240 }),
    createEntity('coldAir', A.x - 80, A.y, 10, { id: 'cold', radius: 300 }),
    createEntity('warmAir', A.x + 90, A.y, 5, { id: 'warm', radius: 300 }),
  ];
}

function run(): PrognosticState {
  const state = new PrognosticState(base, board(), { n: 96, domainKm: 1000 });
  return state;
}

const state = run();
const startMass = state.totalMass();
console.log('P1 prognostic sandbox · 96² · 1000 km · dt 10 s');
console.log(`initial mass ${startMass.toFixed(3)} · cells ${state.options.n}²`);
console.log('');
console.log('hour |   A P   A W    A Q |   B P   B W |   C P   C W | mass drift | front(A)');

for (let hour = 1; hour <= 6; hour += 1) {
  state.advance(1);
  const snap = state.snapshot(points);
  const a = snap.stations.A;
  const b = snap.stations.B;
  const c = snap.stations.C;
  console.log(
    `${String(hour).padStart(4)} | ${a.pressureHpa.toFixed(1)} ${a.wTotal.toFixed(3).padStart(6)} ${a.moisture.toFixed(1).padStart(5)} | ` +
      `${b.pressureHpa.toFixed(1)} ${b.wTotal.toFixed(3).padStart(6)} | ` +
      `${c.pressureHpa.toFixed(1)} ${c.wTotal.toFixed(3).padStart(6)} | ` +
      `${(snap.massDrift * 100).toFixed(3)}% | ${a.frontType} ${a.frontStrength.toFixed(2)}`,
  );
}

const final = state.snapshots[state.snapshots.length - 1];
assert.ok(Number.isFinite(final.stations.A.pressureHpa), 'station pressure must be finite');
assert.ok(final.stations.A.pressureHpa < base.P, 'the low must lower pressure at A');
assert.ok(final.stations.A.wTotal > 0, 'the low must produce ascent at A');
assert.ok(final.massDrift < 0.001, `mass drift over 6 h must stay below 0.1 % (got ${(final.massDrift * 100).toFixed(3)} %)`);

// Determinism: a second identical run must reproduce the third hour exactly.
const a2 = run();
a2.advance(3);
const s2 = a2.snapshot(points);
const first = run();
first.advance(3);
const s1 = first.snapshot(points);
for (const id of ['A', 'B', 'C'] as const) {
  assert.equal(
    s1.stations[id].pressureHpa,
    s2.stations[id].pressureHpa,
    `determinism: ${id} pressure must be identical`,
  );
  assert.equal(s1.stations[id].wTotal, s2.stations[id].wTotal, `determinism: ${id} W must be identical`);
}

console.log('');
console.log('✓ 6 hourly steps completed');
console.log('✓ low centre lowers pressure and produces ascent');
console.log(`✓ mass drift ${(final.massDrift * 100).toFixed(3)} % (< 0.1 %, closed domain)`);
console.log('✓ two identical runs agree exactly at hour 3');
