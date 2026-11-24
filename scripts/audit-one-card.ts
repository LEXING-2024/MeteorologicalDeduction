import { LEVELS } from '../src/config/levels';
import { createEntity } from '../src/logic/entities';
import { simulateRound } from '../src/logic/weather';
import { evaluateGoal } from '../src/logic/goal';
import type { WeatherRecord } from '../src/logic/types';

const candidates: Array<{ label: string; build: (x: number, y: number, ds?: number) => any[] }> = [
  { label: 'L20', build: (x, y, ds) => [createEntity('coldLow', x, y, 20, { id: 'c-l20', domainScale: ds })] },
  { label: 'L10', build: (x, y, ds) => [createEntity('coldLow', x, y, 10, { id: 'c-l10', domainScale: ds })] },
  { label: 'H20', build: (x, y, ds) => [createEntity('warmHigh', x, y, 20, { id: 'c-h20', domainScale: ds })] },
  {
    label: '气团(-10,40)',
    build: (x, y, ds) => [
      createEntity('coldAir', x, y, 10, { id: 'c-c', domainScale: ds }),
      createEntity('wet', x, y, 40, { id: 'c-w', domainScale: ds }),
    ],
  },
];

const solvedByOne: Array<{ level: number; name: string; card: string; initial: number }> = [];
const failures: string[] = [];

for (const level of LEVELS) {
  let done = false;
  for (const candidate of candidates) {
    for (const city of level.cities) {
      const entities = level.initialEntities
        .slice()
        .concat(candidate.build(city.x, city.y, level.base.domainScale));
      try {
        const sim = simulateRound(entities, level.base, level.cities);
        const history: WeatherRecord[] = [
          { round: 1, cities: sim.after.cities, entities: sim.after.entities },
        ];
        const evaluation = evaluateGoal(level, sim.after, { history });
        if (evaluation.passed) {
          solvedByOne.push({
            level: level.index,
            name: level.name,
            card: `${candidate.label}@${city.id}`,
            initial: level.initialEntities.length,
          });
          done = true;
          break;
        }
      } catch (error) {
        failures.push(`L${level.index}: ${(error as Error).message}`);
      }
    }
    if (done) break;
  }
}

/*
 * 质量审计：只用一张卡、只用一回合，能不能把这一关过掉？
 *
 * 这是"很神"的量化指标：现象级关卡（温带气旋、气旋的一生、湖泊效应雪…）
 * 如果一张卡就能成立，说明判据只覆盖了一个必要条件。
 * 教程关（1–6、11、14、16）本来就该单卡可解，不在此列。
 *
 *   npm run audit:one-card
 *
 * 退出码始终为 0：它是一张体检表，不是门禁。
 */
console.log(`单卡可解 ${solvedByOne.length}/${LEVELS.length}`);
for (const row of solvedByOne) {
  const tag = row.initial > 0 ? `（初始场 ${row.initial}）` : '';
  console.log(`L${String(row.level).padStart(2, '0')} ${row.name}  ← ${row.card}${tag}`);
}
if (failures.length) console.log('errors', failures.slice(0, 3));
