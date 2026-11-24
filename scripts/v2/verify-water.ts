/**
 * V2 · 6.11 水汽账本 + 边界雨带验收。
 * 运行：tsx scripts/v2/verify-water.ts
 *
 * 除了纯函数账本（verify-m2 6.11），这里跑真实关卡：
 * - L1 / L11 的 start+evap+boundary+clamp−rain−end 必须 < 2%；
 * - 边界不再裁掉云雨：只检查最外圈没有整圈“直线雨”，
 *   同时确认雨区能自然推进到真实内容域边缘。
 */

import { VOLUME1 } from '../../src/v2/levels/vol1';
import { Simulation } from '../../src/v2/sim/engine';

let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? '✅' : '❌'} ${name} · ${detail}`);
  if (!ok) failed += 1;
}

function runLevel(id: number): { sim: Simulation; frame: ReturnType<Simulation['currentFrame']> } {
  const level = VOLUME1.find((item) => item.id === id);
  if (!level) throw new Error(`missing level ${id}`);
  const sim = new Simulation(level);
  while (!sim.isFinished) {
    for (const action of level.demoActions.filter((item) => item.hour === sim.currentHour)) {
      sim.place(action);
    }
    sim.advanceRound();
  }
  return { sim, frame: sim.currentFrame() };
}

const lastFrames = new Map<number, ReturnType<Simulation['currentFrame']>>();
for (const id of [1, 11]) {
  const { frame } = runLevel(id);
  lastFrames.set(id, frame);
  const s = frame.stats;
  const closure = s.waterClosure ?? Infinity;
  check(
    `第 ${id} 关水汽闭合`,
    closure < 0.02,
    `start=${Math.round(s.waterStart ?? 0)} evap=${Math.round(
      s.waterEvaporated ?? 0,
    )} rain=${Math.round(s.waterRained ?? 0)} end=${Math.round(
      s.waterEnd ?? 0,
    )} boundary=${Math.round(s.waterBoundary ?? 0)} closure=${(closure * 100).toFixed(3)}%`,
  );
  check(
    `第 ${id} 关账本残差`,
    Math.abs(s.waterUnaccounted ?? 0) < 1e-3,
    `unaccounted=${(s.waterUnaccounted ?? 0).toExponential(2)}`,
  );
}

// 边界雨带：不再按“外 N 格湿格占比”限制，因为真实锋面本就可以压到图边。
// 这里只检查“成线”：某一圈同一条边上连续湿格不能几乎铺满整条边。
{
  const { sim } = runLevel(1);
  const frame = sim.allFrames.find((item) => item.hour === 6) ?? sim.currentFrame();
  const n = Math.round(Math.sqrt(frame.precipRate.length));

  const runsOnEdge = (d: number): { top: number; bottom: number; left: number; right: number } => {
    const longest = (values: number[]): number => {
      let best = 0;
      let run = 0;
      for (const value of values) {
        if (value > 0.1) {
          run += 1;
          best = Math.max(best, run);
        } else {
          run = 0;
        }
      }
      return best;
    };
    const top: number[] = [];
    const bottom: number[] = [];
    const left: number[] = [];
    const right: number[] = [];
    for (let i = d; i < n - d; i += 1) {
      top.push(frame.precipRate[d * n + i]);
      bottom.push(frame.precipRate[(n - 1 - d) * n + i]);
      left.push(frame.precipRate[i * n + d]);
      right.push(frame.precipRate[i * n + (n - 1 - d)]);
    }
    return {
      top: longest(top),
      bottom: longest(bottom),
      left: longest(left),
      right: longest(right),
    };
  };

  for (let d = 0; d <= 2; d += 1) {
    const edge = runsOnEdge(d);
    const len = n - 2 * d;
    const limit = Math.max(8, Math.floor(len * 0.35));
    const maxRun = Math.max(edge.top, edge.bottom, edge.left, edge.right);
    check(
      `边界第 ${d} 圈无铺满边`,
      maxRun <= limit,
      `最长连续湿格=${maxRun}/${len}（上限 ${limit}）`,
    );
  }
  for (let d = 3; d <= 9; d += 1) {
    const edge = runsOnEdge(d);
    const len = n - 2 * d;
    const limit = Math.max(12, Math.floor(len * 0.85));
    const maxRun = Math.max(edge.top, edge.bottom, edge.left, edge.right);
    check(
      `边界第 ${d} 圈无整条直线雨`,
      maxRun <= limit,
      `最长连续湿格=${maxRun}/${len}`,
    );
  }

  let interiorMax = 0;
  for (let k = 0; k < n * n; k += 1) interiorMax = Math.max(interiorMax, frame.precipRate[k]);
  check('内区仍有真实雨区', interiorMax > 1, `全图 max=${interiorMax.toFixed(2)} mm/h`);

  // 不再要求“雨必须离开边缘”，那同样是人为约束。改查两件事：
  // 1) 边界水汽没有被清零（有云有雨才有资格谈边界）；
  // 2) 在真实雨区本来就会压到图边的 L11，边缘仍能测到降水。
  // 显示层的羽化只影响绘制，不改动这里的物理场。
  let edgeQ = 0;
  let edgeCount = 0;
  for (let d = 0; d <= 2; d += 1) {
    for (let i = d; i < n - d; i += 1) {
      for (const k of [d * n + i, (n - 1 - d) * n + i, i * n + d, i * n + (n - 1 - d)]) {
        edgeQ += frame.humidity[k];
        edgeCount += 1;
      }
    }
  }
  check(
    '边界仍保有水汽（不是被整体清零）',
    edgeQ / Math.max(edgeCount, 1) > 3,
    `外 3 圈平均 q=${(edgeQ / Math.max(edgeCount, 1)).toFixed(2)} g/kg`,
  );

  const l11 = lastFrames.get(11);
  if (!l11) throw new Error('missing L11 frame');
  const l11Level = VOLUME1.find((item) => item.id === 11);
  if (!l11Level) throw new Error('missing L11 level');
  const contentKm = l11Level.contentDomainKm ?? l11Level.scene.domainKm;
  const gridKm = l11Level.scene.domainKm / n;
  const contentInset = Math.round((l11Level.scene.domainKm - contentKm) / 2 / gridKm);
  let l11NearEdgeMax = 0;
  // 渲染域外圈是刻意留白，雨区应到达“真实内容域”边而不是整张画布边。
  for (let d = Math.max(0, contentInset - 2); d <= contentInset + 3; d += 1) {
    for (let i = d; i < n - d; i += 1) {
      l11NearEdgeMax = Math.max(
        l11NearEdgeMax,
        l11.precipRate[d * n + i],
        l11.precipRate[(n - 1 - d) * n + i],
        l11.precipRate[i * n + d],
        l11.precipRate[i * n + (n - 1 - d)],
      );
    }
  }
  check(
    '真实雨区可以自然抵达内容区边缘（L11）',
    l11NearEdgeMax > 0.1,
    `内容边界第 ${contentInset - 2}–${contentInset + 3} 圈 max=${l11NearEdgeMax.toFixed(2)} mm/h`,
  );
}

// 地图差异化：至少 6 种尺寸、8 种地形原型。
{
  const domains = new Set(VOLUME1.map((level) => level.scene.domainKm));
  const kinds = new Set(VOLUME1.map((level) => level.scene.terrain.kind));
  check('地图尺寸有大小差异', domains.size >= 6, `${domains.size} 种尺寸`);
  check('地形原型有特色', kinds.size >= 8, `${kinds.size} 种：${[...kinds].join(', ')}`);
}

if (failed > 0) {
  console.error(`水汽/边界/地图验收失败 ${failed} 项。`);
  process.exit(1);
}
console.log('水汽账本、边界雨带与地图差异化验收全部通过。');
