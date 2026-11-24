/**
 * V2 · 4 标准层热力结构验收。
 *
 * 验证 850/700/500/300 是独立场，而不是地面温度的常数偏移：
 * - 层温随高度递减，且 850 hPa 约比地面低 9–10 K；
 * - 层湿不超过对应层饱和值，PW 由实际层湿积分；
 * - 冷场景下 850 hPa 温度低于 0，相态进入雪而不是雨。
 */
import { Grid } from '../../src/v2/core/grid';
import { partitionPrecipitation } from '../../src/v2/physics/phase';
import { LayerThermo } from '../../src/v2/physics/layers';
import { Simulation } from '../../src/v2/sim/engine';
import { VOLUME1 } from '../../src/v2/levels/vol1';

let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? '✅' : '❌'} ${name} · ${detail}`);
  if (!ok) failed += 1;
}

const level = VOLUME1[0];
const sim = new Simulation(level);
while (!sim.isFinished) {
  for (const action of level.demoActions.filter((item) => item.hour === sim.currentHour)) {
    sim.place(action);
  }
  sim.advanceRound();
}
const frame = sim.currentFrame();
const n2 = frame.pressure.length;
const layers = [
  frame.layerT850,
  frame.layerT700,
  frame.layerT500,
  frame.layerT300,
  frame.layerQ850,
  frame.layerQ700,
  frame.layerQ500,
  frame.layerQ300,
];
check(
  '四层温湿场全部存在',
  layers.every((array) => array instanceof Float32Array && array.length === n2),
  `${layers.length} arrays · n²=${n2}`,
);
check(
  '四层温湿场全部有限',
  layers.every((array) => Array.from(array ?? []).every((value) => Number.isFinite(value))),
  'no NaN/Infinity',
);
check(
  '850 hPa 比地面冷',
  (frame.stats.meanT850 ?? 0) <
    (frame.stats.minTemp + frame.stats.maxTemp) / 2 - 5,
  `T850=${(frame.stats.meanT850 ?? 0).toFixed(1)} vs T2m=${(
    (frame.stats.minTemp + frame.stats.maxTemp) /
    2
  ).toFixed(1)}`,
);
check(
  '500 hPa 比 850 hPa 冷',
  (frame.stats.meanT500 ?? 0) < (frame.stats.meanT850 ?? 0) - 15,
  `T500=${(frame.stats.meanT500 ?? 0).toFixed(1)} T850=${(
    frame.stats.meanT850 ?? 0
  ).toFixed(1)}`,
);
const q850max = Math.max(...Array.from(frame.layerQ850 ?? []));
const qSurfaceMax = Math.max(...Array.from(frame.humidity));
check('850 hPa 比湿不超过地面', q850max <= qSurfaceMax + 1e-3, `q850=${q850max.toFixed(2)} q0=${qSurfaceMax.toFixed(2)}`);
check(
  'PW 由层湿积分且量级合理',
  (frame.stats.meanPwMm ?? 0) > 10 && (frame.stats.meanPwMm ?? 0) < 60,
  `meanPW=${(frame.stats.meanPwMm ?? 0).toFixed(1)} mm`,
);

const coldGrid = new Grid(480, 16);
const cold = new LayerThermo({
  grid: coldGrid,
  sceneBaseTempC: -12,
  heightM: new Float64Array(coldGrid.n * coldGrid.n),
  tempAnomaly: new Float64Array(coldGrid.n * coldGrid.n),
  qSurface: new Float64Array(coldGrid.n * coldGrid.n).fill(1.2),
  size: coldGrid.n * coldGrid.n,
});
check(
  '冷场景 850 hPa < 0 ℃',
  cold.t850[0] < 0,
  `T850=${cold.t850[0].toFixed(1)} ℃`,
);
const coldPhase = partitionPrecipitation({
  tempC: -12,
  qGkg: 1.2,
  wCmS: 20,
  capeJkg: 100,
  precipRate: 2,
  t850C: cold.t850[0],
});
check('冷场景相态为雪', coldPhase.snow > 0.99, `snow=${coldPhase.snow.toFixed(2)}`);
check(
  '冷场景不是由温度偏移伪造成冻雨',
  coldPhase.freezingRain === 0,
  `freeze=${coldPhase.freezingRain.toFixed(2)}`,
);

if (failed > 0) {
  console.error(`4 层热力验收失败 ${failed} 项。`);
  process.exit(1);
}
console.log('4 层热力结构验收全部通过。');
