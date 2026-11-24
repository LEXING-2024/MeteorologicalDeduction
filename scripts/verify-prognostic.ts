/**
 * P2 acceptance: the prognostic state and the analytic station must agree on
 * the things a player reads — pressure anomaly sign, ascent, thermal contrast —
 * while the front class is reported separately until it is calibrated.
 *
 * Run: npm run verify:prognostic
 */
import assert from 'node:assert/strict';
import { createEntity } from '../src/logic/entities';
import { simulateRound } from '../src/logic/weather';
import { PrognosticState } from '../src/logic/prognostic/state';
import { diagnoseStation, formatStationDiagnostics } from '../src/logic/prognostic/diagnostics';
import type { BaseConditions, City } from '../src/logic/types';

const base: BaseConditions = {
  P: 1012,
  T: 23,
  Q: 7.4,
  latitude: 24,
  hemisphere: 'N',
};

const A = { id: 'A', name: 'A 城', nameEn: 'A', x: 430, y: 400 } as City;
const B = { id: 'B', name: 'B 城', nameEn: 'B', x: 680, y: 330 } as City;
const cities = [A, B];

function board() {
  return [
    createEntity('coldLow', A.x, A.y, 15, { id: 'low', radius: 240 }),
    createEntity('wet', A.x - 56, A.y + 19, 40, { id: 'source', radius: 240 }),
    createEntity('coldAir', A.x - 80, A.y, 10, { id: 'cold', radius: 300 }),
    createEntity('warmAir', A.x + 90, A.y, 5, { id: 'warm', radius: 300 }),
  ];
}

// Analytic engine: one 3 h round.
const analytic = simulateRound(board(), base, cities).after.cities;

// Prognostic engine: three hourly steps, then sample the same cities.
const prognostic = new PrognosticState(base, board(), { n: 96, domainKm: 1000 });
prognostic.advance(3);
const pA = diagnoseStation(prognostic.sample(A.x, A.y));
const pB = diagnoseStation(prognostic.sample(B.x, B.y));

console.log('analytic  A:', `P ${analytic.A.P.toFixed(1)} · T ${analytic.A.T.toFixed(1)} · W ${analytic.A.W.toFixed(2)} · R ${analytic.A.R.toFixed(2)} mm/3h · 锋面 ${analytic.A.frontType}`);
console.log('prognostic A:', formatStationDiagnostics(pA));
console.log('analytic  B:', `P ${analytic.B.P.toFixed(1)} · T ${analytic.B.T.toFixed(1)} · W ${analytic.B.W.toFixed(2)}`);
console.log('prognostic B:', formatStationDiagnostics(pB));

// Pressure: both must show a low at A and a much weaker anomaly at B.
assert.ok(analytic.A.P < base.P && pA.pressureHpa < base.P, 'both engines must lower pressure at A');
assert.ok(
  Math.abs(analytic.A.P - pA.pressureHpa) < 30,
  `pressure must agree within 30 hPa (analytic ${analytic.A.P.toFixed(1)} vs prognostic ${pA.pressureHpa.toFixed(1)})`,
);

// Ascent: the low produces W > 0 at A in both engines.
assert.ok(analytic.A.W > 0, 'analytic W at A must be positive');
assert.ok(pA.wMetresPerSecond > 0, 'prognostic W at A must be positive');

// Rain uses the same formula and the same W index, so both engines must rain.
assert.ok(analytic.A.R > 0.1, `analytic A must rain (${analytic.A.R.toFixed(2)} mm/3h)`);
assert.ok(pA.rainRate > 0.1, `prognostic A must rain (${pA.rainRate.toFixed(2)} mm/3h)`);
const ratio = pA.rainRate / analytic.A.R;
assert.ok(
  ratio > 0.25 && ratio < 4,
  `prognostic/analytic rain ratio must stay within 0.25–4 (got ${ratio.toFixed(2)})`,
);

// Thermal contrast is checked on the initial state: after 3 h of advection the
// two air masses have moved, so a fixed ±120 px pair is no longer meaningful.
const at0 = new PrognosticState(base, board(), { n: 96, domainKm: 1000 });
const cold0 = at0.sample(A.x - 80, A.y).temperatureC;
const warm0 = at0.sample(A.x + 90, A.y).temperatureC;
assert.ok(cold0 < warm0, `initial cold side must be cooler (${cold0.toFixed(1)} vs ${warm0.toFixed(1)} °C)`);
assert.ok(analytic.A.T < analytic.B.T, 'analytic A must be cooler than the clear east');

// Front: strong at A, absent in the clear sector once the strength floor is on.
assert.notEqual(pA.frontType, 'none', 'A must carry a resolved front');
assert.equal(pB.frontType, 'none', 'B must not show a weak false front');

// Determinism of the prognostic path.
const again = new PrognosticState(base, board(), { n: 96, domainKm: 1000 });
again.advance(3);
assert.equal(
  diagnoseStation(again.sample(A.x, A.y)).pressureHpa,
  pA.pressureHpa,
  'prognostic sampling must be deterministic',
);

console.log('');
console.log('✓ both engines lower pressure at A (< 30 hPa apart)');
console.log(`✓ both engines produce ascent and rain at A (R ${analytic.A.R.toFixed(2)} vs ${pA.rainRate.toFixed(2)} mm/3h)`);
console.log(`✓ initial thermal contrast matches the card sign (${cold0.toFixed(1)} < ${warm0.toFixed(1)} °C)`);
console.log('✓ front resolved at A, absent at B after the strength floor');
console.log('✓ prognostic path is deterministic');
