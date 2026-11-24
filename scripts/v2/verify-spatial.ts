/**
 * V2 · SpatialTest 判题验收。
 *
 * 用 L1 的 demo 帧验证：
 * 1) FrameMorphology 能作为一段 spatial 断言进入 judge；
 * 2) 雨带长宽比阈值能被时间窗内的最优帧判定；
 * 3) 无 morphology 的旧帧不会误通过。
 */
import { judge } from '../../src/v2/judge';
import type { LevelDef, SpatialTest } from '../../src/v2/core/types';
import { Simulation } from '../../src/v2/sim/engine';
import { VOLUME1 } from '../../src/v2/levels/vol1';

let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? '✅' : '❌'} ${name} · ${detail}`);
  if (!ok) failed += 1;
}

function run(level: LevelDef): Simulation {
  const sim = new Simulation(level);
  while (!sim.isFinished) {
    for (const action of level.demoActions.filter((item) => item.hour === sim.currentHour)) {
      sim.place(action);
    }
    sim.advanceRound();
  }
  return sim;
}

const spatial: SpatialTest[] = [
  {
    id: 'rain-band-shape',
    label: '雨带形态',
    assertions: [
      {
        id: 'rain-band-elongation',
        label: '雨带长宽比',
        metric: 'rainElongation',
        op: '>=',
        value: 1.1,
        windowH: [0, 9],
      },
      {
        id: 'rain-band-coverage',
        label: '雨带覆盖',
        metric: 'rainCoverage',
        op: '>=',
        value: 0.02,
        windowH: [0, 9],
      },
    ],
  },
];

const level: LevelDef = { ...VOLUME1[0], spatial };
const sim = run(level);
const result = judge(level, sim.allFrames);
const spatialCheck = result.checks.find((item) => item.id === 'rain-band-shape');
check('SpatialTest 进入判题', !!spatialCheck, spatialCheck ? 'found' : 'missing');
check('雨带形态断言通过', !!spatialCheck?.ok, spatialCheck?.detail ?? '—');
check(
  '判题结果包含空间检查',
  result.checks.some((item) => item.id === 'rain-band-elongation') === false &&
    result.checks.some((item) => item.id === 'rain-band-shape'),
  `${result.checks.length} checks`,
);

const noMorphology = sim.allFrames.map((frame) => ({ ...frame, morphology: undefined }));
const noSpatialResult = judge(level, noMorphology);
const noSpatialCheck = noSpatialResult.checks.find((item) => item.id === 'rain-band-shape');
check('无 morphology 不误通过', !!noSpatialCheck && !noSpatialCheck.ok, noSpatialCheck?.detail ?? '—');

if (failed > 0) {
  console.error(`SpatialTest 验收失败 ${failed} 项。`);
  process.exit(1);
}
console.log('SpatialTest 判题验收全部通过。');
