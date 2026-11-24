/**
 * V2 · M2 七项局地模块验收。
 * 运行：npx tsx scripts/v2/verify-local.ts
 *
 * 海陆风与狭管在 wind.ts；这里验证其余五项纯函数的符号、
 * 量级与单调性，防止局地模块只写标签不产生物理效果。
 */

import {
  coldAirDamLift,
  foehnTendency,
  lakeEffectFlux,
  urbanHeatTendency,
  valleyWindSpeed,
} from '../../src/v2/physics/local';

let failed = 0;
function report(ok: boolean, name: string, detail: string): void {
  console.log(`${ok ? '✅' : '❌'} ${name} · ${detail}`);
  if (!ok) failed += 1;
}

// 7.2 山谷风
const dayValley = valleyWindSpeed(1, 1);
const nightValley = valleyWindSpeed(-1, 0);
report(dayValley > 0.5, '山谷风 · 白天暖坡向上', `v=${dayValley.toFixed(2)} m/s`);
report(nightValley < 0, '山谷风 · 夜间冷坡向下', `v=${nightValley.toFixed(2)} m/s`);
report(Math.abs(valleyWindSpeed(0, 1)) < 1e-6, '山谷风 · 无温差无风', 'v=0');

// 7.3 城市热岛
const urbanDay = urbanHeatTendency(1, 1);
const urbanNight = urbanHeatTendency(1, 0);
report(urbanNight > urbanDay && urbanDay > 0, '城市热岛 · 夜间更强', `夜=${urbanNight.toFixed(3)} K/h，昼=${urbanDay.toFixed(3)} K/h`);

// 7.5 湖效应
const lakeStrong = lakeEffectFlux(20, 6);
const lakeWeak = lakeEffectFlux(3, 6);
report(lakeStrong.q > 0 && lakeStrong.w > 0, '湖效应 · 冷空气过暖湖产生水汽/抬升', `q=${lakeStrong.q.toFixed(2)} g/kg/h，w=${lakeStrong.w.toFixed(2)} cm/s`);
report(lakeWeak.q === 0 && lakeWeak.w === 0, '湖效应 · 温差不足不触发', 'q=w=0');

// 7.6 冷空气坝
const damLift = coldAirDamLift(-4, 500, 100);
const damNoCold = coldAirDamLift(0, 500, 100);
report(damLift > 0 && damNoCold === 0, '冷空气坝 · 冷池越山溢流抬升', `w=${damLift.toFixed(2)} cm/s`);

// 7.7 焚风
const foehn = foehnTendency(0.2);
const noFoehn = foehnTendency(-0.1);
report(foehn.dTemp > 1 && foehn.dQ < 0, '焚风 · 背风增温变干', `dT=${foehn.dTemp.toFixed(2)} K/h，dq=${foehn.dQ.toFixed(2)}`);
report(noFoehn.dTemp === 0 && noFoehn.dQ === 0, '焚风 · 迎风不触发', 'dT=dq=0');

console.log(failed === 0 ? '\n七项局地模块验收全部通过。' : `\n${failed} 项未通过。`);
process.exit(failed === 0 ? 0 : 1);
