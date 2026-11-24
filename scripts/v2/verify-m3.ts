/**
 * V2 · M3 配方 / 空间形态验收。
 *
 * 设计锚点：03 §8.2（30 个配方）、§9.2（SpatialAssertion）。
 * 当前判题 DSL 还没有把空间断言接到关卡，本脚本先验证诊断层：
 * 30 个配方定义齐全、标签唯一、真实关卡能产出形态量、识别结果合法。
 */
import { RECIPE_DEFS, RECIPE_LABELS, detectRecipes } from '../../src/v2/diag/recipes';
import { analyzeMorphology } from '../../src/v2/diag/morphology';
import { Simulation } from '../../src/v2/sim/engine';
import { VOLUME1 } from '../../src/v2/levels/vol1';
import type { LevelDef } from '../../src/v2/core/types';

let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? '✅' : '❌'} ${name} · ${detail}`);
  if (!ok) failed += 1;
}

function runWithDemo(level: LevelDef): Simulation {
  const sim = new Simulation(level);
  let guard = 0;
  while (!sim.isFinished && guard < 20) {
    guard += 1;
    const next = level.demoActions.find((action) => action.hour === sim.currentHour);
    if (next) sim.place(next);
    sim.advanceRound();
  }
  return sim;
}

check('配方库共 30 个', RECIPE_DEFS.length === 30, `${RECIPE_DEFS.length} definitions`);
check(
  '配方标签唯一',
  new Set(RECIPE_DEFS.map((recipe) => recipe.label)).size === RECIPE_DEFS.length,
  `${Object.keys(RECIPE_LABELS).length} labels`,
);
check(
  '每个配方都有可执行 test',
  RECIPE_DEFS.every((recipe) => typeof recipe.test === 'function' && recipe.id.length > 0),
  'all callable',
);

const l1 = runWithDemo(VOLUME1[0]);
const frame = l1.currentFrame();
const morph = frame.morphology ?? analyzeMorphology(l1.scene, frame, l1.fields);
check(
  'L1 雨带形态有向异性',
  morph.rainElongation > 1 && morph.rainLengthKm > morph.rainWidthKm,
  `elong=${morph.rainElongation.toFixed(2)} len=${morph.rainLengthKm.toFixed(0)} width=${morph.rainWidthKm.toFixed(0)} km`,
);
check(
  'L1 锋区/风向切变可诊断',
  morph.frontStrength > 0.2 && morph.maxWindDirShiftDeg > 10,
  `front=${morph.frontStrength.toFixed(1)} K/10km dir=${morph.maxWindDirShiftDeg.toFixed(0)}°`,
);
check(
  'L1 配方识别包含上升/降水',
  frame.recipes.includes('upwardRain'),
  frame.recipes.join(',') || 'none',
);
check(
  '识别结果全部在标签表内',
  frame.recipes.every((id) => id in RECIPE_LABELS),
  `${frame.recipes.length} ids`,
);

// 多个真实场景的并集：保证配方不是只对 L1 硬编码。
const seen = new Set<string>(frame.recipes);
for (const index of [1, 4, 10, 11]) {
  const sim = runWithDemo(VOLUME1[index]);
  const f = sim.currentFrame();
  for (const recipe of f.recipes) seen.add(recipe);
  const m = f.morphology;
  check(
    `第 ${VOLUME1[index].id} 关形态量有限`,
    !!m &&
      Number.isFinite(m.rainElongation) &&
      Number.isFinite(m.frontStrength) &&
      Number.isFinite(m.maxConvergence),
    m
      ? `elong=${m.rainElongation.toFixed(2)} front=${m.frontStrength.toFixed(1)} conv=${m.maxConvergence.toExponential(1)}`
      : 'missing',
  );
  const detected = detectRecipes(sim.scene, f, sim.allFrames.slice(0, -1), sim.fields, []);
  check(
    `第 ${VOLUME1[index].id} 关重复识别稳定`,
    detected.join(',') === f.recipes.join(','),
    `frame=${f.recipes.length} recompute=${detected.length}`,
  );
}
check('跨场景至少识别 4 类过程', seen.size >= 4, `${seen.size} unique recipes`);

if (failed > 0) {
  console.error(`M3 验收失败 ${failed} 项。`);
  process.exit(1);
}
console.log(`M3 配方/形态验收全部通过（${seen.size} 类真实场景命中）。`);
