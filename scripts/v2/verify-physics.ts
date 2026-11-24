/**
 * V2 · 物理不变量验证。
 *
 * 这些断言不依赖具体关卡数值，而是守住模型本身不能坏的性质：
 *   1. 决定性：同一关同一操作两次运行结果逐位一致；
 *   2. 环流：北半球低压周围必须是逆时针；
 *   3. 摩擦角：海上偏角明显小于内陆；
 *   4. 急流：沿流向拉长、横向收窄（长宽比 ≥ 2.5）；
 *   5. 静风：没有风时不存在「跨等压线角」（返回 NaN，而不是 0°）。
 *
 * 运行：npm run verify:v2
 */

import { JET_ACROSS_FACTOR, JET_ALONG_FACTOR, Simulation } from '../../src/v2/sim/engine';
import { circulationSign, crossIsobarAngle } from '../../src/v2/diag/diagnostics';
import { VOLUME1 } from '../../src/v2/levels/vol1';
import type { CardAction, LevelDef, SceneDef } from '../../src/v2/core/types';

let failures = 0;

function assert(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? '✅' : '❌'} ${name} · ${detail}`);
  if (!ok) failures += 1;
}

function runDemo(level: LevelDef): Simulation {
  const sim = new Simulation(level);
  let guard = 0;
  while (!sim.isFinished && guard < 20) {
    guard += 1;
    const next = level.demoActions.find((a) => a.hour === sim.currentHour);
    if (next) sim.place(next);
    sim.advanceRound();
  }
  return sim;
}

function sameFrame(a: ReturnType<Simulation['currentFrame']>, b: ReturnType<Simulation['currentFrame']>): boolean {
  const fields: Array<keyof ReturnType<Simulation['currentFrame']>> = [
    'pressure',
    'temp',
    'humidity',
    'cloud',
    'precipRate',
    'precipAcc',
    'u',
    'v',
    'w',
  ];
  for (const key of fields) {
    const left = a[key] as Float32Array;
    const right = b[key] as Float32Array;
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i += 1) {
      if (left[i] !== right[i]) return false;
    }
  }
  return true;
}

const baseScene = (patch: Partial<SceneDef>): SceneDef => ({
  domainKm: 640,
  n: 128,
  centerLat: 30,
  centerLon: 120,
  baseTempC: 22,
  sstC: 27,
  soil: 0.34,
  bgWindU: 2,
  bgWindV: 0,
  bgHumidity: 8,
  timeOfDay: 8,
  terrain: { kind: 'plain', baseHeightM: 60, reliefM: 20 },
  sites: [],
  ...patch,
});

// 1 · 决定性 ---------------------------------------------------------------
{
  const level = VOLUME1.find((l) => l.id === 4)!;
  const first = runDemo(level);
  const second = runDemo(level);
  const ok =
    first.allFrames.length === second.allFrames.length &&
    first.allFrames.every((frame, index) => sameFrame(frame, second.allFrames[index]));
  assert('决定性', ok, `${first.allFrames.length} 帧逐位一致`);
}

// 2 · 北半球气旋性环流 -------------------------------------------------------
{
  const level = VOLUME1.find((l) => l.id === 4)!;
  const sim = runDemo(level);
  const frame = sim.currentFrame();
  const low = frame.centers.find((c) => c.type === 'L');
  if (!low) {
    assert('气旋性环流', false, '末帧没有低压中心');
  } else {
    const sign = circulationSign(low, frame.u, frame.v, sim.grid);
    assert('气旋性环流', sign > 0.8, `切向风 ${sign.toFixed(2)} m/s（逆时针为正）`);
  }
}

// 3 · 摩擦角：海 < 陆（直接用 11 关的海岸场景） ------------------------------
{
  const level = VOLUME1.find((l) => l.id === 11)!;
  const sim = runDemo(level);
  const frame = sim.currentFrame();
  const sea = frame.sites.M.crossAngle;
  const land = frame.sites.L.crossAngle;
  assert(
    '摩擦角',
    Number.isFinite(sea) && Number.isFinite(land) && sea + 3 < land && land >= 20,
    `海上 ${Number.isFinite(sea) ? `${sea.toFixed(1)}°` : '—'} / 内陆 ${Number.isFinite(land) ? `${land.toFixed(1)}°` : '—'}`,
  );
}

// 4 · 急流形状：沿流向拉长、横向收窄 ----------------------------------------
{
  const scene = baseScene({ bgWindU: 0 });
  const level: LevelDef = {
    id: 902,
    volume: 0,
    title: '急流形状验证',
    teaching: '',
    scale: 'M',
    scene,
    rounds: 1,
    available: ['wind'],
    chain: [],
    fallback: [],
    hints: [],
    demoActions: [],
  };
  const sim = new Simulation(level);
  const jet: CardAction = {
    id: 'jet',
    kind: 'wind',
    variant: 'lowJet',
    tier: 3,
    xKm: 320,
    yKm: 320,
    hour: 0,
    directionDeg: 90,
  };
  sim.place(jet);
  sim.advanceRound();
  const frame = sim.currentFrame();
  const grid = sim.grid;
  const along = Math.abs(grid.sample(frame.u, 320 + 90, 320));
  const across = Math.abs(grid.sample(frame.u, 320, 320 + 90));
  const ratio = along / Math.max(across, 0.001);
  assert(
    '急流形状',
    ratio >= 2.5 && JET_ALONG_FACTOR / JET_ACROSS_FACTOR >= 2.5,
    `纵向 90 km ${along.toFixed(1)} m/s / 横向 90 km ${across.toFixed(1)} m/s，比值 ${ratio.toFixed(1)}（σ 比 ${(JET_ALONG_FACTOR / JET_ACROSS_FACTOR).toFixed(1)}）`,
  );
  assert('急流无越轨', Number.isFinite(along) && along <= 45, `中心风速 ${along.toFixed(1)} m/s`);
}

// 5 · 静风没有跨等压线角 -----------------------------------------------------
{
  const calm = crossIsobarAngle(0, 0, 3, 0);
  const perpendicular = crossIsobarAngle(3, 0, 0, 3);
  assert('静风夹角', Number.isNaN(calm), `静风返回 ${Number.isNaN(calm) ? 'NaN' : calm}`);
  assert('垂直夹角', Math.abs(perpendicular - 90) < 1, `正交风返回 ${perpendicular.toFixed(1)}°`);
}

console.log(failures === 0 ? '\n物理不变量全部守住。' : `\n${failures} 项物理断言失败。`);
process.exit(failures === 0 ? 0 : 1);
