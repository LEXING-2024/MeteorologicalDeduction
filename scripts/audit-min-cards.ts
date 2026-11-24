import { LEVELS } from '../src/config/levels';
import { createEntity } from '../src/logic/entities';
import { simulateRound } from '../src/logic/weather';
import { evaluateGoal } from '../src/logic/goal';
import type { WeatherRecord, WeatherEntity } from '../src/logic/types';

/*
 * 难度审计：这一关最少要几张卡、几回合？
 *
 * 单卡审计只看"一张卡能不能过"，会把"两张卡"的中等关也算成合理。这个脚本
 * 依次尝试 1/2/3/4 张卡的常用组合，报出每关的最少卡数，用来找"组合关其实
 * 一张卡就够"的漏洞。
 *
 *   npm run audit:min-cards
 */

type Placement = (city: { x: number; y: number }, ds?: number) => WeatherEntity[];

const E = (type: Parameters<typeof createEntity>[0], x: number, y: number, s: number, id: string, ds?: number) =>
  createEntity(type, x, y, s, { id, domainScale: ds });

const COMBOS: Array<{ label: string; cards: number; build: Placement }> = [
  { label: 'L20', cards: 1, build: (c, ds) => [E('coldLow', c.x, c.y, 20, 'a', ds)] },
  { label: 'H20', cards: 1, build: (c, ds) => [E('warmHigh', c.x, c.y, 20, 'a', ds)] },
  {
    label: '气团(-10,40)',
    cards: 1,
    build: (c, ds) => [E('coldAir', c.x, c.y, 10, 'a1', ds), E('wet', c.x, c.y, 40, 'a2', ds)],
  },
  {
    label: 'L20+水汽',
    cards: 2,
    build: (c, ds) => [E('coldLow', c.x, c.y, 20, 'b1', ds), E('wet', c.x, c.y, 40, 'b2', ds)],
  },
  {
    label: 'L20+H20(东侧)',
    cards: 2,
    build: (c, ds) => [E('coldLow', c.x, c.y, 20, 'c1', ds), E('warmHigh', c.x + 220, c.y, 20, 'c2', ds)],
  },
  {
    label: '冷+暖',
    cards: 2,
    build: (c, ds) => [E('coldAir', c.x - 60, c.y, 10, 'd1', ds), E('warmAir', c.x + 60, c.y, 5, 'd2', ds)],
  },
  {
    label: 'L20+水汽+高压',
    cards: 3,
    build: (c, ds) => [
      E('coldLow', c.x, c.y, 20, 'e1', ds),
      E('wet', c.x, c.y, 40, 'e2', ds),
      E('warmHigh', c.x + 220, c.y, 20, 'e3', ds),
    ],
  },
  {
    label: 'L20+水汽+冷+暖',
    cards: 4,
    build: (c, ds) => [
      E('coldLow', c.x, c.y, 20, 'f1', ds),
      E('wet', c.x, c.y, 40, 'f2', ds),
      E('coldAir', c.x - 50, c.y, 10, 'f3', ds),
      E('warmAir', c.x + 50, c.y, 5, 'f4', ds),
    ],
  },
];

const results: Array<{ level: number; stage: number; name: string; cards: number; combo: string; initial: number }> = [];
const failures: string[] = [];

for (const level of LEVELS) {
  const anchor = level.cities[0];
  let best: { cards: number; combo: string } | null = null;
  for (const combo of COMBOS) {
    if (best && combo.cards >= best.cards) continue;
    const entities = level.initialEntities
      .slice()
      .concat(combo.build(anchor, level.base.domainScale));
    try {
      const sim = simulateRound(entities, level.base, level.cities);
      const history: WeatherRecord[] = [{ round: 1, cities: sim.after.cities, entities: sim.after.entities }];
      if (evaluateGoal(level, sim.after, { history }).passed) {
        best = { cards: combo.cards, combo: combo.label };
      }
    } catch (error) {
      failures.push(`L${level.index}: ${(error as Error).message}`);
    }
  }
  results.push({
    level: level.index,
    stage: level.stage,
    name: level.name,
    cards: best?.cards ?? 0,
    combo: best?.combo ?? '未找到',
    initial: level.initialEntities.length,
  });
}

const byStage = new Map<number, { total: number; one: number; two: number }>();
for (const row of results) {
  const bucket = byStage.get(row.stage) ?? { total: 0, one: 0, two: 0 };
  bucket.total += 1;
  if (row.cards === 1) bucket.one += 1;
  if (row.cards === 2) bucket.two += 1;
  byStage.set(row.stage, bucket);
}

console.log('关卡  阶段  初始场  最少卡数  组合');
for (const row of results) {
  if (row.cards > 0 && row.cards <= 2 && row.stage >= 2) {
    console.log(
      `L${String(row.level).padStart(2, '0')}   ${row.stage}     ${row.initial}      ${row.cards}        ${row.combo}`,
    );
  }
}
console.log('\n按阶段统计（1 张卡 / 2 张卡 / 总数）');
for (const [stage, b] of [...byStage].sort((a, b) => a[0] - b[0])) {
  console.log(`阶段 ${stage}: ${b.one} / ${b.two} / ${b.total}`);
}
if (failures.length) console.log('errors', failures.slice(0, 3));
