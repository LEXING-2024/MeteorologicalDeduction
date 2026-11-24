/**
 * M3 · 30 个配方与空间形态识别。
 *
 * 设计锚点：docs/V2/03 §8.2。
 * 这些标签只用于判题/回看，不是收集品；玩家看不到“配方图鉴”。
 *
 * 当前模式仍是 2D 两层 QG。这里把文档中的条件落到现有可诊断量：
 * - w 在引擎内是 cm/s，物理阈值需显式换算；
 * - 850 hPa 温度用地面温度 + 标准减温率估计（见 physics/phase.ts）；
 * - 台风/湖效应雪等需要海温、地温、垂直结构的配方，使用场景 SST、
 *   地面温度与历史趋势做“可解释代理”，不伪造不存在的层。
 */
import type { CardAction, Frame, FrameMorphology, SceneDef } from '../core/types';
import { Grid } from '../core/grid';
import type { SceneFields } from '../scene/scene';
import { analyzeMorphology } from './morphology';

export interface RecipeContext {
  scene: SceneDef;
  frame: Frame;
  history: Frame[];
  fields: SceneFields;
  actions: CardAction[];
  morph: FrameMorphology;
}

interface RecipeDef {
  id: string;
  label: string;
  test: (ctx: RecipeContext) => boolean;
}

function hasCard(ctx: RecipeContext, kind: string, variant?: string): boolean {
  return ctx.actions.some(
    (action) => action.kind === kind && (!variant || action.variant === variant),
  );
}

function terrainKind(ctx: RecipeContext): string {
  return ctx.scene.terrain.kind;
}

function isMountain(ctx: RecipeContext): boolean {
  const kind = terrainKind(ctx);
  return (
    kind === 'mountainCoast' ||
    kind === 'ridge' ||
    kind === 'pass' ||
    kind === 'plateau' ||
    kind === 'island' ||
    kind === 'valley'
  );
}

function localHour(ctx: RecipeContext): number {
  return ((ctx.scene.timeOfDay + ctx.frame.hour) % 24 + 24) % 24;
}

function maxUrban(ctx: RecipeContext): number {
  let max = 0;
  for (const value of ctx.fields.urban) max = Math.max(max, value);
  return max;
}

function lowCenter(ctx: RecipeContext): Frame['centers'][number] | undefined {
  const lows = ctx.frame.centers.filter((center) => center.type === 'L');
  return lows.reduce<Frame['centers'][number] | undefined>(
    (best, center) => (!best || center.value < best.value ? center : best),
    undefined,
  );
}

function lowCenterAt(frame: Frame): Frame['centers'][number] | undefined {
  const lows = frame.centers.filter((center) => center.type === 'L');
  return lows.reduce<Frame['centers'][number] | undefined>(
    (best, center) => (!best || center.value < best.value ? center : best),
    undefined,
  );
}

/** 最近一个不早于 `hoursAgo` 的历史帧；没有则返回最早帧。 */
function pastFrame(ctx: RecipeContext, hoursAgo: number): Frame | undefined {
  const target = ctx.frame.hour - hoursAgo;
  let best: Frame | undefined;
  for (const frame of ctx.history) {
    if (frame.hour <= ctx.frame.hour) {
      if (!best || frame.hour >= best.hour) best = frame;
      if (frame.hour >= target && (!best || frame.hour > best.hour)) {
        // 选最接近目标、且不早于目标的那一帧。
        if (best === undefined || frame.hour < best.hour) best = frame;
      }
    }
  }
  return best;
}

/** 降水质心移速（km/h）；用于静止锋/锢囚锋。 */
function rainCentroidSpeed(ctx: RecipeContext): number {
  const prev = ctx.history[ctx.history.length - 1];
  if (!prev) return 0;
  const dt = Math.max(1, ctx.frame.hour - prev.hour);
  const a = ctx.frame.stats;
  const b = prev.stats;
  if (a.maxRain < 0.1 || b.maxRain < 0.1) return 0;
  return Math.hypot(a.rainCentroidXKm - b.rainCentroidXKm, a.rainCentroidYKm - b.rainCentroidYKm) / dt;
}

/** 低压中心 24 h 加深（hPa）；历史不足时按已有跨度线性外推。 */
function deepening24(ctx: RecipeContext): number {
  const prev = pastFrame(ctx, 24) ?? ctx.history[0];
  if (!prev) return 0;
  const dt = Math.max(1, ctx.frame.hour - prev.hour);
  return (prev.stats.minP - ctx.frame.stats.minP) * (24 / dt);
}

function windDirReversal(ctx: RecipeContext): boolean {
  const frames = [...ctx.history, ctx.frame];
  const dirs = new Map<string, number[]>();
  for (const frame of frames) {
    const hour = ((ctx.scene.timeOfDay + frame.hour) % 24 + 24) % 24;
    if (!(hour >= 6 && hour <= 10) && !(hour >= 13 && hour <= 18)) continue;
    for (const [id, site] of Object.entries(frame.sites)) {
      const list = dirs.get(id) ?? [];
      list.push(site.windDir);
      dirs.set(id, list);
    }
  }
  for (const values of dirs.values()) {
    if (values.length < 2) continue;
    let min = 999;
    let max = -999;
    for (const value of values) {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    const diff = Math.min(max - min, 360 - (max - min));
    if (diff >= 60) return true;
  }
  return false;
}

function centerOverLand(ctx: RecipeContext, frame = ctx.frame): boolean {
  const center = lowCenterAt(frame);
  if (!center) return false;
  const grid = new Grid(ctx.scene.domainKm, ctx.scene.n);
  return grid.sample(ctx.fields.land, center.xKm, center.yKm) > 0.5;
}

function windwardRatio(ctx: RecipeContext): number {
  const { windwardRain, leewardRain } = ctx.frame.stats;
  if (windwardRain < 0.02) return 0;
  return windwardRain / Math.max(leewardRain, 0.02);
}

function coldFrontTest(ctx: RecipeContext): boolean {
  return (
    ctx.morph.frontStrength >= 1 &&
    ctx.morph.maxWindDirShiftDeg >= 45 &&
    ctx.frame.stats.maxRain > 0.05
  );
}

function warmFrontTest(ctx: RecipeContext): boolean {
  // 没有真实的锋面坡度，使用暖平流 + 锋区 + 云雨作为代理。
  return (
    ctx.morph.maxWarmAdvection >= 0.12 &&
    ctx.morph.frontStrength >= 0.4 &&
    (ctx.frame.stats.maxCloud > 0.25 || ctx.frame.stats.maxRain > 0.03)
  );
}

function typhoonTest(ctx: RecipeContext): boolean {
  return (
    ctx.scene.sstC >= 26.5 &&
    ctx.frame.stats.minP <= -20 &&
    ctx.morph.centerWarmCoreK >= 2 &&
    ctx.frame.stats.maxWind >= 15
  );
}

/**
 * 30 个配方。顺序按文档编号；常见过程在前，便于侧栏只展示前几个。
 * 每个 test 都是纯诊断，不写回引擎状态。
 */
export const RECIPE_DEFS: readonly RecipeDef[] = [
  {
    id: 'upwardRain',
    label: '上升/降水',
    test: (ctx) =>
      ctx.morph.maxW >= 20 &&
      ctx.frame.stats.meanQ >= 8 &&
      ctx.frame.stats.maxRain > 0.1,
  },
  {
    id: 'clearSubsidence',
    label: '晴空/下沉',
    test: (ctx) =>
      ctx.morph.minW <= -10 &&
      ctx.frame.stats.maxCloud < 0.2 &&
      ctx.frame.stats.maxRain < 0.05,
  },
  {
    id: 'coldFront',
    label: '冷锋',
    test: (ctx) =>
      coldFrontTest(ctx) &&
      !!lowCenter(ctx) &&
      ctx.frame.stats.maxWind >= 4,
  },
  {
    id: 'warmFront',
    label: '暖锋',
    test: warmFrontTest,
  },
  {
    id: 'stationaryFront',
    label: '静止锋',
    test: (ctx) =>
      coldFrontTest(ctx) &&
      warmFrontTest(ctx) &&
      rainCentroidSpeed(ctx) < 5,
  },
  {
    id: 'occludedFront',
    label: '锢囚锋',
    test: (ctx) =>
      coldFrontTest(ctx) &&
      warmFrontTest(ctx) &&
      !!lowCenter(ctx) &&
      ctx.morph.maxWindDirShiftDeg >= 90 &&
      rainCentroidSpeed(ctx) < 8,
  },
  {
    id: 'extratropicalCyclone',
    label: '温带气旋',
    test: (ctx) =>
      !!lowCenter(ctx) &&
      ctx.frame.stats.minP <= -8 &&
      (coldFrontTest(ctx) || warmFrontTest(ctx)) &&
      deepening24(ctx) >= 10,
  },
  {
    id: 'orographicRain',
    label: '地形雨',
    test: (ctx) =>
      isMountain(ctx) &&
      ctx.frame.stats.maxRain > 0.15 &&
      windwardRatio(ctx) >= 2.5,
  },
  {
    id: 'rainShadow',
    label: '雨影',
    test: (ctx) =>
      isMountain(ctx) &&
      windwardRatio(ctx) >= 3 &&
      ctx.frame.stats.leewardRain < ctx.frame.stats.windwardRain * 0.33 &&
      ctx.frame.stats.maxRain > 0.15,
  },
  {
    id: 'foehn',
    label: '焚风',
    test: (ctx) =>
      isMountain(ctx) &&
      ctx.frame.stats.maxTemp - ctx.scene.baseTempC >= 3 &&
      ctx.morph.minRh <= 55 &&
      ctx.frame.stats.maxWind >= 4,
  },
  {
    id: 'basinColdPool',
    label: '盆地冷池',
    test: (ctx) =>
      terrainKind(ctx) === 'basin' &&
      ctx.frame.stats.minTemp <= ctx.scene.baseTempC - 2.5 &&
      (ctx.frame.stats.coldPoolMax ?? 0) > 0.2,
  },
  {
    id: 'basinFog',
    label: '盆地雾',
    test: (ctx) =>
      terrainKind(ctx) === 'basin' &&
      ctx.morph.maxRh >= 95 &&
      ctx.morph.minWind < 3 &&
      (localHour(ctx) >= 20 || localHour(ctx) <= 9),
  },
  {
    id: 'valleyBreeze',
    label: '山谷风',
    test: (ctx) => terrainKind(ctx) === 'valley' && windDirReversal(ctx),
  },
  {
    id: 'gapWind',
    label: '狭管大风',
    test: (ctx) =>
      terrainKind(ctx) === 'pass' &&
      ctx.frame.stats.maxWind >= 8 &&
      ctx.frame.stats.maxWind >= 1.5 * Math.max(Math.hypot(ctx.scene.bgWindU, ctx.scene.bgWindV), 1),
  },
  {
    id: 'seaBreeze',
    label: '海陆风',
    test: (ctx) =>
      (terrainKind(ctx) === 'coast' || terrainKind(ctx) === 'mountainCoast') &&
      localHour(ctx) >= 9 &&
      localHour(ctx) <= 18 &&
      ctx.frame.stats.maxWind >= 3,
  },
  {
    id: 'seaBreezeFront',
    label: '海风锋对流',
    test: (ctx) =>
      (terrainKind(ctx) === 'coast' || terrainKind(ctx) === 'mountainCoast') &&
      localHour(ctx) >= 11 &&
      localHour(ctx) <= 19 &&
      ctx.morph.maxConvergence >= 2e-5 &&
      ctx.frame.stats.maxRain > 0.2,
  },
  {
    id: 'urbanHeatIsland',
    label: '城市热岛',
    test: (ctx) =>
      maxUrban(ctx) > 0.2 &&
      ctx.morph.urbanHeatK >= 1.5 &&
      ctx.frame.stats.maxCloud < 0.35 &&
      (localHour(ctx) >= 20 || localHour(ctx) <= 6) &&
      ctx.frame.stats.maxTemp - ctx.scene.baseTempC >= 1.5,
  },
  {
    id: 'urbanThunderstorm',
    label: '热岛雷暴',
    test: (ctx) =>
      maxUrban(ctx) > 0.2 &&
      ctx.morph.urbanHeatK >= 1.2 &&
      (ctx.frame.stats.capeMean ?? 0) >= 800 &&
      ctx.frame.stats.maxRain > 0.3 &&
      localHour(ctx) >= 13 &&
      localHour(ctx) <= 19,
  },
  {
    id: 'lakeEffectSnow',
    label: '湖效应雪',
    test: (ctx) =>
      terrainKind(ctx) === 'lake' &&
      (ctx.frame.stats.maxSnowRate ?? 0) > 0.05 &&
      ctx.scene.sstC - ctx.frame.stats.minTemp >= 13,
  },
  {
    id: 'typhoon',
    label: '台风',
    test: typhoonTest,
  },
  {
    id: 'typhoonEye',
    label: '台风眼',
    test: (ctx) =>
      typhoonTest(ctx) &&
      ctx.morph.eyeCloud < 0.2 &&
      ctx.morph.eyewallWind >= 33,
  },
  {
    id: 'typhoonLandfall',
    label: '台风登陆衰减',
    test: (ctx) => {
      if (!typhoonTest(ctx) || !centerOverLand(ctx)) return false;
      const prev = ctx.history[ctx.history.length - 1];
      return !!prev && ctx.frame.stats.maxWind < prev.stats.maxWind - 1.5;
    },
  },
  {
    id: 'typhoonOrographicRain',
    label: '台风地形雨',
    test: (ctx) =>
      typhoonTest(ctx) &&
      (terrainKind(ctx) === 'island' ||
        terrainKind(ctx) === 'mountainCoast' ||
        terrainKind(ctx) === 'ridge') &&
      ctx.frame.stats.maxRain > 10,
  },
  {
    id: 'extratropicalTransition',
    label: '台风变性',
    test: (ctx) =>
      typhoonTest(ctx) &&
      ctx.frame.stats.minTemp <= ctx.scene.baseTempC - 5 &&
      ctx.morph.maxColdAdvection <= -0.2,
  },
  {
    id: 'freezingRain',
    label: '冻雨',
    test: (ctx) =>
      (ctx.frame.stats.maxFreezingRainRate ?? 0) > 0.02 ||
      (hasCard(ctx, 'temperature', 'coldShallow') &&
        (ctx.frame.stats.maxFreezingRainRate ?? 0) > 0.005),
  },
  {
    id: 'snowstorm',
    label: '暴雪',
    test: (ctx) =>
      (ctx.frame.stats.maxSnowAcc ?? 0) >= 10 ||
      (ctx.frame.stats.maxSnowRate ?? 0) >= 1.5,
  },
  {
    id: 'hail',
    label: '冰雹',
    test: (ctx) => (ctx.frame.stats.maxHailRate ?? 0) > 0.02,
  },
  {
    id: 'squallLine',
    label: '飑线',
    test: (ctx) =>
      (ctx.frame.stats.coldPoolMax ?? 0) >= 1.5 &&
      ctx.morph.rainElongation >= 2.5 &&
      ctx.morph.maxWindShear >= 4 &&
      ctx.frame.stats.maxRain > 0.5,
  },
  {
    id: 'dustStorm',
    label: '沙尘暴',
    test: (ctx) =>
      ctx.scene.soil <= 0.25 &&
      ctx.frame.stats.maxWind >= 10 &&
      ctx.frame.stats.maxRain < 0.1 &&
      ctx.morph.maxRh < 45,
  },
  {
    id: 'heatWaveColdWave',
    label: '热浪/寒潮',
    test: (ctx) => {
      const hot = ctx.frame.stats.maxTemp >= 35;
      const prev = pastFrame(ctx, 24);
      const coldWave =
        !!prev && prev.stats.maxTemp - ctx.frame.stats.maxTemp >= 8;
      if (!hot && !coldWave) return false;
      if (hot) {
        const recent = [...ctx.history, ctx.frame].filter(
          (frame) => ctx.frame.hour - frame.hour <= 24,
        );
        return recent.length >= 2 && recent.every((frame) => frame.stats.maxTemp >= 35);
      }
      return true;
    },
  },
];

export const RECIPE_LABELS: Record<string, string> = Object.fromEntries(
  RECIPE_DEFS.map((recipe) => [recipe.id, recipe.label]),
);

/**
 * 识别当前帧的所有配方。会顺手把形态诊断挂到 frame.morphology，
 * 避免 UI 和配方各算一遍。
 */
export function detectRecipes(
  scene: SceneDef,
  frame: Frame,
  history: readonly Frame[] = [],
  fields?: SceneFields,
  actions: readonly CardAction[] = [],
): string[] {
  if (!fields) return [];
  const morph = analyzeMorphology(scene, frame, fields);
  frame.morphology = morph;
  const ctx: RecipeContext = {
    scene,
    frame,
    history: [...history],
    fields,
    actions: [...actions],
    morph,
  };
  return RECIPE_DEFS.filter((recipe) => recipe.test(ctx)).map((recipe) => recipe.id);
}
