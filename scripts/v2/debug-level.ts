/** 调试：逐帧打印某一关的推演过程。用法：npx tsx scripts/v2/debug-level.ts 8 */
import { Simulation } from '../../src/v2/sim/engine';
import { judge } from '../../src/v2/judge';
import { VOLUME1 } from '../../src/v2/levels/vol1';
import { ageostrophicRatio } from '../../src/v2/physics/wind';

const id = Number(process.argv[2] ?? 8);
const level = VOLUME1.find((l) => l.id === id);
if (!level) {
  console.error(`没有第 ${id} 关`);
  process.exit(1);
}
const sim = new Simulation(level);
let guard = 0;
while (!sim.isFinished && guard < 20) {
  guard += 1;
  const hour = sim.currentHour;
  const next = level.demoActions.find((a) => a.hour === hour);
  if (next) {
    const r = sim.place(next);
    console.log(`h${hour} 放置 ${next.kind}${next.variant} t${next.tier} @${next.xKm},${next.yKm} ${r.ok ? 'ok' : r.reason}`);
  }
  sim.advanceRound();
  const f = sim.currentFrame();
  console.log(
    `h${f.hour} minP=${f.stats.minP.toFixed(1)} maxP=${f.stats.maxP.toFixed(1)} maxW=${f.stats.maxW.toFixed(1)} rainR=${f.stats.rainRadiusKm.toFixed(0)} centers=${f.centers
      .map((c) => `${c.type}${c.value.toFixed(0)}@${c.xKm.toFixed(0)},${c.yKm.toFixed(0)}r${c.radiusKm.toFixed(0)}`)
      .join(' ')}`,
  );
  for (const [sid, s] of Object.entries(f.sites)) {
    const dxKm = 5;
    const i = Math.round(s.xKm / dxKm - 0.5);
    const j = Math.round(s.yKm / dxKm - 0.5);
    const k = j * 128 + i;
    const dpx = (f.pressure[k + 1] - f.pressure[k - 1]) / (2 * 5000);
    const dpy = (f.pressure[k + 128] - f.pressure[k - 128]) / (2 * 5000);
    const ug = -8.5e4 * dpy;
    const vg = 8.5e4 * dpx;
    const rough = sim.fields.roughness[k];
    const ratio = ageostrophicRatio(rough);
    const lap =
      (f.pressure[k + 1] +
        f.pressure[k - 1] +
        f.pressure[k + 128] +
        f.pressure[k - 128] -
        4 * f.pressure[k]) /
      (5000 * 5000);
    const wDiv = ratio * 8.5e4 * lap * 12000 * 100;
    console.log(
      `   ${sid}: p=${s.p.toFixed(1)} cc=${s.cc.toFixed(2)} acc=${s.precipAcc.toFixed(2)} w=${s.w.toFixed(1)} wDiv=${wDiv.toFixed(1)} lap=${lap.toExponential(2)} cross=${s.crossAngle.toFixed(1)} u=${f.u[k].toFixed(1)} v=${f.v[k].toFixed(1)} ug=${ug.toFixed(1)} vg=${vg.toFixed(1)} rough=${rough.toFixed(3)} ratio=${ratio.toFixed(2)}`,
    );
  }
}
const result = judge(level, sim.allFrames);
console.log(result.pass ? 'PASS' : 'FAIL', result.detail);
for (const c of result.checks) {
  console.log(`  ${c.ok ? '·' : '✗'} ${c.label}: ${c.value.toFixed(2)} @${c.atHour ?? '-'} ${c.detail ?? ''}`);
}
