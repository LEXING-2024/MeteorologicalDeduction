/**
 * V2 · 冷场景验收。
 *
 * 用一个不属于 12 关主线的临时冬季场景，验证 4 层热力 + 相态链路：
 * - 地面 -10 ℃、850 hPa < 0，降水必须是雪；
 * - 不应再出现“20–35 ℃ 卷一全是雨”的假象；
 * - 不修改 VOLUME1 的任何关卡。
 */
import type { LevelDef } from '../../src/v2/core/types';
import { Simulation } from '../../src/v2/sim/engine';
import { VOLUME1 } from '../../src/v2/levels/vol1';

let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? '✅' : '❌'} ${name} · ${detail}`);
  if (!ok) failed += 1;
}

const base = VOLUME1[0];
const cold: LevelDef = {
  ...base,
  id: 901,
  title: '冷场景验收',
  teaching: '冷性低压的降水应为雪。',
  scene: {
    ...base.scene,
    baseTempC: -10,
    sstC: -2,
    bgHumidity: 3.2,
  },
  spatial: [],
  chain: [],
  fallback: [],
  demoActions: base.demoActions,
};

const sim = new Simulation(cold);
while (!sim.isFinished) {
  for (const action of cold.demoActions.filter((item) => item.hour === sim.currentHour)) {
    sim.place(action);
  }
  sim.advanceRound();
}
const frame = sim.currentFrame();
const stats = frame.stats;
check('冷场景有降水', (stats.maxRain ?? 0) > 0.05, `maxRain=${(stats.maxRain ?? 0).toFixed(2)} mm/h`);
check('冷场景降水相态为雪', (stats.maxSnowRate ?? 0) > 0.02, `snow=${(stats.maxSnowRate ?? 0).toFixed(2)} mm/h`);
check('冷场景没有液态雨主导', (stats.maxRainRate ?? 0) <= (stats.maxSnowRate ?? 0) * 1.05, `rain=${(stats.maxRainRate ?? 0).toFixed(2)}`);
check(
  '冷场景 850 hPa 为负温',
  (stats.maxT850 ?? 0) < 0,
  `T850 max=${(stats.maxT850 ?? 0).toFixed(1)} ℃`,
);
const site = Object.values(frame.sites)[0];
check(
  '无降水站点不伪报相态',
  !site || site.precipRate > 0.02 || site.phase === 'none',
  site ? `${site.phase} · rain=${site.precipRate.toFixed(2)}` : 'missing',
);

if (failed > 0) {
  console.error(`冷场景验收失败 ${failed} 项。`);
  process.exit(1);
}
console.log('冷场景验收全部通过。');
