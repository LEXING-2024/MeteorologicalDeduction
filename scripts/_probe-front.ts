// Temporary probe for SPRINT-2B frontAt design. Deleted after verification.
import { CONTENT_SCALE, MAP_SIZE } from '../src/config/constants';
import { createEntity } from '../src/logic/entities';
import { buildPointWeather, influenceAt, windAt } from '../src/logic/field';
import { getLevel } from '../src/config/levels';
import type { WeatherEntity, BaseConditions } from '../src/logic/types';

const S = CONTENT_SCALE;
const A = { x: 286 * S, y: 322 * S };
let domainScale = 1000;
const E = (type: Parameters<typeof createEntity>[0], x: number, y: number, strength: number, id: string) =>
  createEntity(type, x * S, y * S, strength, { id, domainScale });

function fields(entities: WeatherEntity[], base: BaseConditions, x: number, y: number) {
  let t = base.T;
  let q = base.Q;
  let tEast = base.T, tWest = base.T, tSouth = base.T, tNorth = base.T;
  let qEast = base.Q, qWest = base.Q, qSouth = base.Q, qNorth = base.Q;
  const eps = 8;
  const sample = (px: number, py: number) => {
    let tt = base.T, qq = base.Q;
    for (const e of entities) {
      if (e.type !== 'coldAir' && e.type !== 'warmAir' && e.type !== 'wet') continue;
      const inf = influenceAt(e, px, py);
      if (inf < 0.001) continue;
      if (e.type === 'coldAir') tt -= e.strength * inf;
      else if (e.type === 'warmAir') tt += e.strength * inf;
      else qq += e.strength * inf;
    }
    return { t: tt, q: qq };
  };
  const c = sample(x, y);
  t = c.t; q = c.q;
  tEast = sample(Math.min(MAP_SIZE, x + eps), y).t;
  tWest = sample(Math.max(0, x - eps), y).t;
  tSouth = sample(x, Math.min(MAP_SIZE, y + eps)).t;
  tNorth = sample(x, Math.max(0, y - eps)).t;
  qEast = sample(Math.min(MAP_SIZE, x + eps), y).q;
  qWest = sample(Math.max(0, x - eps), y).q;
  qSouth = sample(x, Math.min(MAP_SIZE, y + eps)).q;
  qNorth = sample(x, Math.max(0, y - eps)).q;
  const gxT = (tEast - tWest) / (2 * eps), gyT = (tSouth - tNorth) / (2 * eps);
  const gxQ = (qEast - qWest) / (2 * eps), gyQ = (qSouth - qNorth) / (2 * eps);
  const gx = gxT + 2.5 * gxQ, gy = gyT + 2.5 * gyQ;
  const coldInf = Math.max(0, ...entities.filter(e => e.type === 'coldAir').map(e => influenceAt(e, x, y)));
  const warmInf = Math.max(0, ...entities.filter(e => e.type === 'warmAir').map(e => influenceAt(e, x, y)));
  const coldStr = entities.filter(e => e.type === 'coldAir').reduce((m, e) => Math.max(m, e.strength), 0);
  const warmStr = entities.filter(e => e.type === 'warmAir').reduce((m, e) => Math.max(m, e.strength), 0);
  return { t, q, gradT: Math.hypot(gxT, gyT), gradQ: Math.hypot(gxQ, gyQ), grad: Math.hypot(gx, gy), gx, gy, gxT, gyT, coldInf, warmInf, overlap: coldInf * warmInf, coldStr, warmStr };
}

const cases: Array<[string, WeatherEntity[], number]> = [
  ['L20 stacked cold10 warm5 wet40', [E('coldAir', 286, 322, 10, 'cold'), E('warmAir', 286, 322, 5, 'warm'), E('wet', 286, 322, 40, 'wet')], 20],
  ['L23 stacked cold10 warm10 wet20', [E('coldAir', 286, 322, 10, 'cold'), E('warmAir', 286, 322, 10, 'warm'), E('wet', 286, 322, 20, 'wet')], 23],
  ['L8 offset cold10@-50 warm5@+50 H east L west 3wet', [
    E('coldAir', 286 - 50, 322, 10, 'cold'), E('warmAir', 286 + 50, 322, 5, 'warm'),
    E('wet', 286, 322, 40, 'wa'), E('wet', 286, 322, 40, 'wb'), E('wet', 286, 322, 40, 'wc'),
    E('warmHigh', 286 + 220, 322, 10, 'high-east'), E('coldLow', 286 - 220, 322, 10, 'low-west'),
  ], 8],
  ['L9 offset cold5@-50 warm10@+50 H nw L se wet20', [
    E('coldAir', 286 - 50, 322, 5, 'cold'), E('warmAir', 286 + 50, 322, 10, 'warm'), E('wet', 286, 322, 20, 'wet'),
    E('warmHigh', 286 - 220, 322 - 220, 10, 'high-nw'), E('coldLow', 286 + 220, 322 + 220, 10, 'low-se'),
  ], 9],
  ['L10 offset cold10@-60 warm10@+60 wet40', [
    E('coldAir', 286 - 60, 322, 10, 'cold'), E('warmAir', 286 + 60, 322, 10, 'warm'), E('wet', 286, 322, 40, 'wet'),
  ], 10],
  ['L39 initial', getLevel(38).initialEntities.map((e) => ({ ...e })), 39],
];

for (const [name, entities, levelNo] of cases) {
  const base = getLevel(levelNo - 1).base;
  domainScale = base.domainScale ?? 1000;
  const f = fields(entities, base, A.x, A.y);
  const wind = windAt(entities, base, A.x, A.y);
  const w = buildPointWeather(entities, base, A.x, A.y);
  const n = f.gradT > 1e-6 ? (wind.x * f.gxT + wind.y * f.gyT) / f.gradT : 0;
  console.log(name);
  console.log(`  OLD: type=${w.frontType} lift=${w.frontLift.toFixed(2)} W=${w.W.toFixed(2)} R=${w.R.toFixed(3)} rain24h=${w.rain24h.toFixed(1)} T=${w.T.toFixed(1)}`);
  console.log(`  gradT=${f.gradT.toFixed(5)} gradQ=${f.gradQ.toFixed(5)} gradThetaE=${f.grad.toFixed(5)} overlap=${f.overlap.toFixed(3)} coldStr=${f.coldStr} warmStr=${f.warmStr}`);
  console.log(`  wind=(${wind.x.toFixed(2)},${wind.y.toFixed(2)}) speed=${wind.speed.toFixed(2)} windAlongThermal=${n.toFixed(3)}`);
}
