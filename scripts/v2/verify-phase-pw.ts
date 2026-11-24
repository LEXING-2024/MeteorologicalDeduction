/**
 * V2 · 降水相态 + PW 垂直积分验收。
 *
 * 不依赖 HTML：纯函数证明相态分配边界与 PW 量级，再用 L1 真实帧
 * 验证“分相之和 = 总降水”、站点相态、PW 统计上屏所需字段。
 */
import { partitionPrecipitation, dominantPhase, phaseLabel } from '../../src/v2/physics/phase';
import type { PrecipPhase } from '../../src/v2/core/types';
import { precipitableWaterMm } from '../../src/v2/physics/pw';
import { Simulation } from '../../src/v2/sim/engine';
import { VOLUME1 } from '../../src/v2/levels/vol1';

let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? '✅' : '❌'} ${name} · ${detail}`);
  if (!ok) failed += 1;
}

function runLevel1(): Simulation {
  const level = VOLUME1[0];
  const sim = new Simulation(level);
  while (!sim.isFinished) {
    for (const action of level.demoActions.filter((item) => item.hour === sim.currentHour)) {
      sim.place(action);
    }
    sim.advanceRound();
  }
  return sim;
}

// 1. 00 §8.5 的相态表
const warm = partitionPrecipitation({
  tempC: 12,
  qGkg: 10,
  wCmS: 30,
  capeJkg: 500,
  precipRate: 4,
});
check(
  '12 ℃ 为纯雨',
  warm.rain === 1 && warm.snow === 0 && warm.sleet === 0 && warm.hail === 0,
  `rain=${warm.rain.toFixed(2)}`,
);

const mixed = partitionPrecipitation({
  tempC: 1,
  qGkg: 10,
  wCmS: 30,
  capeJkg: 500,
  precipRate: 4,
});
check(
  '0–2 ℃ 为雨夹雪过渡带',
  mixed.sleet > 0.4 && mixed.rain > 0.4 && Math.abs(mixed.rain + mixed.sleet - 1) < 1e-6,
  `rain=${mixed.rain.toFixed(2)} sleet=${mixed.sleet.toFixed(2)}`,
);

const freezing = partitionPrecipitation({
  tempC: -3,
  qGkg: 10,
  wCmS: 30,
  capeJkg: 500,
  precipRate: 3,
  t850C: 4,
});
check(
  '地面 < 0 ℃、850 hPa > 0 ℃ 为冻雨',
  freezing.freezingRain > 0.99,
  `freeze=${freezing.freezingRain.toFixed(2)}`,
);

const snow = partitionPrecipitation({
  tempC: -15,
  qGkg: 5,
  wCmS: 20,
  capeJkg: 100,
  precipRate: 2,
  t850C: -8,
});
check('整层 < 0 ℃ 为雪', snow.snow > 0.99, `snow=${snow.snow.toFixed(2)}`);

const hail = partitionPrecipitation({
  tempC: 8,
  qGkg: 12,
  wCmS: 190,
  capeJkg: 3200,
  precipRate: 12,
  t850C: -2,
});
check(
  '强上升 + 高 CAPE 的冷性对流含冰雹份额',
  hail.hail > 0.01 && hail.hail < 0.05,
  `hail=${hail.hail.toFixed(3)}`,
);
check(
  '五相比例和为 1',
  [warm, mixed, freezing, snow, hail].every((p) => {
    const sum = p.rain + p.sleet + p.snow + p.freezingRain + p.hail;
    return Math.abs(sum - 1) < 1e-6;
  }),
  'all partitions sum=1',
);

const none = partitionPrecipitation({
  tempC: 20,
  qGkg: 8,
  wCmS: 10,
  capeJkg: 100,
  precipRate: 0,
});
check('无降水时相态为 none', dominantPhase(none) === 'none', phaseLabel(dominantPhase(none)));
check(
  '相态标签完整',
  ['none', 'rain', 'sleet', 'snow', 'freezingRain', 'hail'].every((id) =>
    phaseLabel(id as PrecipPhase).length > 0,
  ),
  'none/rain/sleet/snow/freezingRain/hail',
);

// 2. PW 量级与单调性
const dry = precipitableWaterMm(2, 20, 30);
const moist = precipitableWaterMm(10, 20, 70);
const wetter = precipitableWaterMm(16, 25, 80);
check('PW 干空气 < 10 mm', dry < 10, `dry=${dry.toFixed(1)} mm`);
check('PW 湿空气 10–40 mm', moist >= 10 && moist <= 40, `moist=${moist.toFixed(1)} mm`);
check('PW 随 q/RH 增大', wetter > moist, `${moist.toFixed(1)} → ${wetter.toFixed(1)} mm`);
check('PW 无负值/上限 100 mm', precipitableWaterMm(0, 20, 0) === 0 && wetter < 100, 'bounded');

// 3. 真实 L1 帧
const l1 = runLevel1();
const frame = l1.currentFrame();
const total = Array.from(frame.precipRate);
const phaseSum = Array.from(frame.rainRate).map((value, k) => {
  return (
    value +
    frame.sleetRate[k] +
    frame.snowRate[k] +
    frame.freezingRainRate[k] +
    frame.hailRate[k]
  );
});
const maxMismatch = Math.max(...total.map((value, k) => Math.abs(value - phaseSum[k])));
check('分相降水率之和 = 总降水率', maxMismatch < 1e-4, `max mismatch=${maxMismatch.toExponential(2)}`);

const site = Object.values(frame.sites)[0];
check('站点有相态字段', !!site && phaseLabel(site.phase).length > 0, site ? phaseLabel(site.phase) : 'missing');
check(
  '站点 PW 量级正确',
  !!site && site.pwMm > 5 && site.pwMm < 60,
  site ? `${site.pwMm.toFixed(1)} mm` : 'missing',
);
check(
  'PW 统计上屏',
  (frame.stats.meanPwMm ?? 0) > 5 && (frame.stats.maxPwMm ?? 0) >= (frame.stats.meanPwMm ?? 0),
  `mean=${(frame.stats.meanPwMm ?? 0).toFixed(1)} max=${(frame.stats.maxPwMm ?? 0).toFixed(1)} mm`,
);

if (failed > 0) {
  console.error(`相态/PW 验收失败 ${failed} 项。`);
  process.exit(1);
}
console.log('相态/PW 验收全部通过。');
