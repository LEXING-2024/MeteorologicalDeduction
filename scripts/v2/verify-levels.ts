/**
 * V2 · 卷一关卡验证。
 *
 * 1. 每关用 demoActions 跑完整回合，判题必须通过；
 * 2. 同一关不放任何卡片，判题必须不通过（防止「空解白给」）；
 * 3. 失败时打印每条判据、末帧统计与站点读数。
 *
 * 运行：npm run verify:v2
 */

import { Simulation } from '../../src/v2/sim/engine';
import { judge } from '../../src/v2/judge';
import { VOLUME1 } from '../../src/v2/levels/vol1';
import type { LevelDef } from '../../src/v2/core/types';

type RunResult = {
  pass: boolean;
  detail: string;
  ms: number;
  sim: Simulation;
};

function runWithDemo(level: LevelDef): RunResult {
  const started = performance.now();
  const sim = new Simulation(level);
  let guard = 0;
  while (!sim.isFinished && guard < 20) {
    guard += 1;
    const next = level.demoActions.find((a) => a.hour === sim.currentHour);
    if (next) {
      const report = sim.place(next);
      if (!report.ok) {
        return { pass: false, detail: `放置失败：${report.reason}`, ms: 0, sim };
      }
    }
    sim.advanceRound();
  }
  const result = judge(level, sim.allFrames);
  return {
    pass: result.pass,
    detail: result.detail,
    ms: performance.now() - started,
    sim,
  };
}

function runEmpty(level: LevelDef): { pass: boolean; detail: string } {
  const sim = new Simulation(level);
  sim.runToEnd();
  const result = judge(level, sim.allFrames);
  return { pass: result.pass, detail: result.detail };
}

const errorCount: string[] = [];

for (const level of VOLUME1) {
  const demo = runWithDemo(level);
  const empty = runEmpty(level);

  const demoMark = demo.pass ? '✅' : '❌';
  const emptyMark = empty.pass ? '❌' : '✅';
  console.log(
    `${demoMark} 第 ${String(level.id).padStart(2, '0')} 关 ${level.title} · ${demo.ms.toFixed(0)} ms · ${demo.detail}`,
  );

  if (!demo.pass) {
    errorCount.push(`第 ${level.id} 关 demo 解未通过`);
    for (const check of judge(level, demo.sim.allFrames).checks) {
      console.log(
        `   ${check.ok ? '   ·' : '   ✗'} ${check.label}: ${format(check.value)} @ ${check.atHour ?? '-'}h  ${check.detail ?? ''}`,
      );
    }
    printFrame(demo.sim.currentFrame());
  }

  if (empty.pass) {
    errorCount.push(`第 ${level.id} 关 空解被判通过`);
    console.log(`${emptyMark} 第 ${String(level.id).padStart(2, '0')} 关空解被误判为通过：${empty.detail}`);
  }
}

console.log(
  errorCount.length === 0
    ? '\n卷一全部通过：12/12 关 demo 解成立，空解全部判负。'
    : `\n${errorCount.length} 项未通过：\n  - ${errorCount.join('\n  - ')}`,
);
process.exit(errorCount.length === 0 ? 0 : 1);

function format(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '—';
}

function printFrame(frame: ReturnType<Simulation['currentFrame']>): void {
  console.log(
    `   末帧: minP=${frame.stats.minP.toFixed(1)} maxP=${frame.stats.maxP.toFixed(1)} ` +
      `maxW=${frame.stats.maxWind.toFixed(1)} rainR=${frame.stats.rainRadiusKm.toFixed(0)}km centers=` +
      frame.centers
        .map((c) => `${c.type}${c.value.toFixed(0)}@${c.xKm.toFixed(0)},${c.yKm.toFixed(0)}`)
        .join(' '),
  );
  for (const [id, s] of Object.entries(frame.sites)) {
    console.log(
      `   站点${id}: p=${format(s.p)} cc=${s.cc.toFixed(2)} acc=${s.precipAcc.toFixed(2)} ` +
        `w=${s.wind10.toFixed(1)} cross=${Number.isFinite(s.crossAngle) ? `${s.crossAngle.toFixed(1)}°` : '—'}`,
    );
  }
}
