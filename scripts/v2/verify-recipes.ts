/**
 * 30 个配方的检测器触发矩阵。
 *
 * 目的：证明每个 RECIPE_DEFS 的 `test` 不是永远为 false 的死代码，而是
 * 都能被一组可解释的 Frame / Scene / Morphology 驱动为 true。
 *
 * 这不是“30 个关卡实景”——12 关主线仍只覆盖其中一部分；矩阵只负责
 * 检测器级验收，场景代理仍按 recipes.ts 注释的边界执行。
 */
import type {
  CardAction,
  Frame,
  FrameMorphology,
  FrameStats,
  SceneDef,
} from '../../src/v2/core/types';
import { Simulation } from '../../src/v2/sim/engine';
import { VOLUME1 } from '../../src/v2/levels/vol1';
import { RECIPE_DEFS } from '../../src/v2/diag/recipes';
import type { SceneFields } from '../../src/v2/scene/scene';
import type { RecipeContext } from '../../src/v2/diag/recipes';

const baseSim = new Simulation(VOLUME1[0]);
const baseFrame = baseSim.currentFrame();
const baseScene = VOLUME1[0].scene;

const emptyMorph: FrameMorphology = {
  rainCoverage: 0,
  rainAreaKm2: 0,
  rainElongation: 0,
  rainAxisDeg: 0,
  rainLengthKm: 0,
  rainWidthKm: 0,
  minW: 0,
  maxW: 0,
  minWind: 0,
  maxWind: 0,
  maxRh: 0,
  minRh: 0,
  frontStrength: 0,
  maxWarmAdvection: 0,
  maxColdAdvection: 0,
  maxConvergence: 0,
  maxWindDirShiftDeg: 0,
  maxWindShear: 0,
  urbanHeatK: 0,
  centerWarmCoreK: 0,
  eyeCloud: 1,
  eyewallWind: 0,
};

const baseMorph: FrameMorphology = {
  ...emptyMorph,
  rainCoverage: 0.12,
  rainAreaKm2: 1000,
  rainElongation: 2,
  rainAxisDeg: 90,
  rainLengthKm: 100,
  rainWidthKm: 50,
  minW: -20,
  maxW: 30,
  minWind: 1,
  maxWind: 15,
  maxRh: 96,
  minRh: 30,
  frontStrength: 2,
  maxWarmAdvection: 0.2,
  maxColdAdvection: -0.2,
  maxConvergence: 3e-5,
  maxWindDirShiftDeg: 90,
  maxWindShear: 6,
  urbanHeatK: 2,
  centerWarmCoreK: 3,
  eyeCloud: 0.1,
  eyewallWind: 40,
};

function fieldsWithLand(): SceneFields {
  const n = baseScene.n;
  const land = new Float64Array(n * n).fill(1);
  const urban = new Float64Array(n * n).fill(0.4);
  const zero = new Float64Array(n * n);
  return {
    height: zero,
    land,
    roughness: zero,
    urban,
    sst: zero,
    slopeX: zero,
    slopeY: zero,
  };
}

function makeFrame(
  hour: number,
  stats: Partial<FrameStats>,
  centers: Frame['centers'] = [
    { type: 'L', xKm: 50, yKm: 50, value: -20, radiusKm: 60, closedIsobars: 3 },
    { type: 'H', xKm: 150, yKm: 150, value: 12, radiusKm: 70, closedIsobars: 2 },
  ],
): Frame {
  return {
    ...baseFrame,
    hour,
    round: hour / 3,
    timeOfDay: baseScene.timeOfDay + hour,
    stats: { ...baseFrame.stats, ...stats },
    centers,
    sites: Object.fromEntries(
      Object.entries(baseFrame.sites).map(([id, site]) => [id, { ...site }]),
    ),
  } as Frame;
}

function makeCtx(
  stats: Partial<FrameStats> = {},
  morph: Partial<FrameMorphology> = {},
  scenePatch: Partial<SceneDef> = {},
  actions: CardAction[] = [],
  history: Frame[] = [makeFrame(0, baseFrame.stats)],
  frameHour = 9,
): RecipeContext {
  const scene: SceneDef = {
    ...baseScene,
    baseTempC: 20,
    sstC: 28,
    soil: 0.5,
    terrain: { ...baseScene.terrain, kind: 'plain' },
    timeOfDay: 12,
    ...scenePatch,
  };
  return {
    scene,
    frame: makeFrame(frameHour, stats),
    history,
    fields: fieldsWithLand(),
    actions,
    morph: { ...baseMorph, ...morph },
  };
}

type Case = RecipeContext;

const cases: Record<string, Case> = {
  upwardRain: makeCtx({ maxRain: 0.5, meanQ: 10 }),
  clearSubsidence: makeCtx({ maxRain: 0, maxCloud: 0.1 }, { minW: -20 }),
  coldFront: makeCtx({ maxRain: 0.2, maxWind: 5 }),
  warmFront: makeCtx({ maxRain: 0.2, maxCloud: 0.5 }),
  stationaryFront: makeCtx({ maxRain: 0.2, maxWind: 5 }),
  occludedFront: makeCtx({ maxRain: 0.2, maxWind: 5 }),
  extratropicalCyclone: makeCtx(
    { minP: -10, maxRain: 0.2, maxWind: 5 },
    {},
    {},
    [],
    [makeFrame(0, { minP: 0, maxRain: 0.2 })],
  ),
  orographicRain: makeCtx(
    { maxRain: 0.3, windwardRain: 3, leewardRain: 0.5 },
    {},
    { terrain: { ...baseScene.terrain, kind: 'mountainCoast' } },
  ),
  rainShadow: makeCtx(
    { maxRain: 0.3, windwardRain: 4, leewardRain: 0.2 },
    {},
    { terrain: { ...baseScene.terrain, kind: 'ridge' } },
  ),
  foehn: makeCtx({ maxTemp: 25, maxWind: 5 }, { minRh: 40 }, {
    terrain: { ...baseScene.terrain, kind: 'ridge' },
  }),
  basinColdPool: makeCtx({ minTemp: 16, coldPoolMax: 0.5 }, {}, {
    terrain: { ...baseScene.terrain, kind: 'basin' },
  }),
  basinFog: makeCtx({}, { maxRh: 96, minWind: 1 }, {
    terrain: { ...baseScene.terrain, kind: 'basin' },
    timeOfDay: 22,
  }),
  valleyBreeze: makeCtx(
    {},
    {},
    { terrain: { ...baseScene.terrain, kind: 'valley' }, timeOfDay: 6 },
    [],
    [
      makeFrame(0, baseFrame.stats),
      makeFrame(3, baseFrame.stats),
    ],
    7,
  ),
  gapWind: makeCtx({ maxWind: 12 }, {}, {
    terrain: { ...baseScene.terrain, kind: 'pass' },
    bgWindU: 2,
  }),
  seaBreeze: makeCtx({ maxWind: 5 }, {}, {
    terrain: { ...baseScene.terrain, kind: 'coast' },
    timeOfDay: 12,
  }, [], [makeFrame(0, baseFrame.stats)], 0),
  seaBreezeFront: makeCtx(
    { maxRain: 0.3 },
    { maxConvergence: 3e-5 },
    { terrain: { ...baseScene.terrain, kind: 'coast' }, timeOfDay: 12 },
    [],
    [makeFrame(0, baseFrame.stats)],
    0,
  ),
  urbanHeatIsland: makeCtx(
    { maxTemp: 22, maxCloud: 0.2 },
    { urbanHeatK: 2 },
    { timeOfDay: 20 },
  ),
  urbanThunderstorm: makeCtx(
    { maxRain: 0.4, capeMean: 900 },
    { urbanHeatK: 1.5 },
    { timeOfDay: 14 },
    [],
    [makeFrame(0, baseFrame.stats)],
    0,
  ),
  lakeEffectSnow: makeCtx(
    { minTemp: -14, maxSnowRate: 0.3 },
    {},
    { terrain: { ...baseScene.terrain, kind: 'lake' }, sstC: 1 },
  ),
  typhoon: makeCtx({ minP: -25, maxWind: 20 }, { centerWarmCoreK: 3 }),
  typhoonEye: makeCtx({ minP: -25, maxWind: 20 }, { centerWarmCoreK: 3, eyeCloud: 0.1, eyewallWind: 40 }),
  typhoonLandfall: makeCtx(
    { minP: -25, maxWind: 20 },
    { centerWarmCoreK: 3 },
    {},
    [],
    [makeFrame(0, { minP: -12, maxWind: 25 })],
  ),
  typhoonOrographicRain: makeCtx(
    { minP: -25, maxWind: 20, maxRain: 20 },
    { centerWarmCoreK: 3 },
    { terrain: { ...baseScene.terrain, kind: 'island' } },
  ),
  extratropicalTransition: makeCtx(
    { minP: -25, maxWind: 20, minTemp: 12 },
    { centerWarmCoreK: 3, maxColdAdvection: -0.3 },
  ),
  freezingRain: makeCtx({ maxFreezingRainRate: 0.1 }),
  snowstorm: makeCtx({ maxSnowRate: 2, maxSnowAcc: 12 }),
  hail: makeCtx({ maxHailRate: 0.1 }),
  squallLine: makeCtx(
    { maxRain: 1, coldPoolMax: 2 },
    { rainElongation: 3, maxWindShear: 6 },
  ),
  dustStorm: makeCtx({ maxWind: 12, maxRain: 0 }, { maxRh: 40 }, { soil: 0.1 }),
  heatWaveColdWave: makeCtx(
    { maxTemp: 38 },
    {},
    {},
    [],
    [
      makeFrame(0, { maxTemp: 37 }),
      makeFrame(3, { maxTemp: 37 }),
    ],
    9,
  ),
};

// 补两处依赖字段的细节：
// - 冷锋/锢囚锋需要低压中心；
// - 海风锋/山谷风等的 timeOfDay 已在 scenePatch 里设置。
cases.typhoonLandfall.fields.land.fill(1);
cases.valleyBreeze.history[0].sites.A.windDir = 10;
cases.valleyBreeze.history[1].sites.A.windDir = 170;
cases.valleyBreeze.frame.sites.A.windDir = 170;

let failed = 0;
for (const recipe of RECIPE_DEFS) {
  const ctx = cases[recipe.id];
  if (!ctx) {
    console.log(`❌ ${recipe.id} · 矩阵缺场景`);
    failed += 1;
    continue;
  }
  const ok = recipe.test(ctx);
  console.log(`${ok ? '✅' : '❌'} ${recipe.id} · ${recipe.label}`);
  if (!ok) failed += 1;
}

if (failed > 0) {
  console.error(`配方触发矩阵失败 ${failed}/${RECIPE_DEFS.length} 项。`);
  process.exit(1);
}
console.log(`配方触发矩阵全部通过：${RECIPE_DEFS.length}/${RECIPE_DEFS.length} 个检测器可触发。`);
