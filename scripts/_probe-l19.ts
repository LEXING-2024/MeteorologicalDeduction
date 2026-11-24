// Temporary probe: replicate solve() for L19 re-solve candidates. Deleted after use.
import { CONTENT_SCALE } from '../src/config/constants';
import { getLevel } from '../src/config/levels';
import { cloneEntities, createEntity } from '../src/logic/entities';
import { simulateRound } from '../src/logic/weather';
import { evaluateGoal } from '../src/logic/goal';
import { frontAt, windAt } from '../src/logic/field';
import type { GoalContext, WeatherEntity, WeatherRecord } from '../src/logic/types';

const S = CONTENT_SCALE;
const A = { x: 286, y: 322 }, B = { x: 486, y: 428 }, C = { x: 412, y: 632 };
const level = getLevel(18);
const domainScale = level.base.domainScale ?? 1000;
const E = (type: Parameters<typeof createEntity>[0], x: number, y: number, strength: number, id: string) =>
  createEntity(type, x * S, y * S, strength, { id, domainScale });

function solve(label: string, build: () => WeatherEntity[]) {
  let entities = build();
  const history: WeatherRecord[] = [];
  const sim = simulateRound(entities, level.base, level.cities);
  entities = cloneEntities(sim.after.entities);
  history.push({ round: 1, cities: sim.after.cities, entities: sim.after.entities });
  let ev = evaluateGoal(level, sim.after, { history } as GoalContext);
  let result = ev.passed ? 'round1' : '';
  if (!ev.passed) {
    const last = simulateRound(entities, level.base, level.cities);
    ev = evaluateGoal(level, last.after, { history } as GoalContext);
    result = ev.passed ? 'final' : 'FAIL';
  }
  const w = sim.after.cities.A;
  const wind = windAt(build(), level.base, A.x * S, A.y * S);
  const f = frontAt(build(), level.base, A.x * S, A.y * S, wind);
  console.log(`${label}: ${result} A.front=${w.frontType} lift=${w.frontLift.toFixed(2)} rain24h=${w.rain24h.toFixed(1)} frontAt=${f.type} detail=${ev.detail}`);
}

const base = () => [
  E('coldAir', A.x, A.y, 10, 'cold'),
  E('warmAir', A.x, A.y, 5, 'warm'),
  E('coldLow', A.x, A.y, 10, 'low-a'),
  E('wet', A.x, A.y + 80, 40, 'wet'),
  E('warmHigh', B.x, B.y, 20, 'high-b'),
  E('warmHigh', C.x + 140, C.y, 20, 'high-east'),
  E('coldLow', C.x - 140, C.y, 20, 'low-west'),
];
solve('original', base);
solve('cold 15', () => { const e = base(); e[0] = E('coldAir', A.x, A.y, 15, 'cold'); return e; });
solve('cold 20', () => { const e = base(); e[0] = E('coldAir', A.x, A.y, 20, 'cold'); return e; });
solve('warm 2', () => { const e = base(); e[1] = E('warmAir', A.x, A.y, 2, 'warm'); return e; });
solve('offset cold15@-50 warm5@+50', () => { const e = base(); e[0] = E('coldAir', A.x - 50, A.y, 15, 'cold'); e[1] = E('warmAir', A.x + 50, A.y, 5, 'warm'); return e; });
