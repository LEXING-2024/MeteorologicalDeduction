/**
 * V2 物理沙盒 · 场景构造器
 *
 * 这里只依赖 V2 的公共数据契约（SceneDef / LevelDef / CardAction），
 * 不引用任何关卡、不修改 VOLUME1，也不向原 12 关写一行。
 */
import type {
  CardAction,
  LevelDef,
  SceneDef,
  TerrainDef,
  TerrainKind,
  Tier,
} from '../v2/core/types';

export interface SandboxConfig {
  domainKm: number;
  terrain: TerrainKind;
  /** 地图画幅：width / height；1 方形，4/3 横版，3/4 竖版。 */
  mapAspect: number;
  baseTempC: number;
  sstC: number;
  soil: number;
  humidity: number;
  windU: number;
  windV: number;
  timeOfDay: number;
  rounds: number;
  low: boolean;
  lowTier: Tier;
  lowWarm: boolean;
  high: boolean;
  wet: boolean;
  wetTier: Tier;
  cool: boolean;
  warm: boolean;
  jet: boolean;
  /** 每一回合重放场景卡，模拟持续强迫而不是一次脉冲。 */
  persist: boolean;
}

export interface SandboxPreset {
  id: string;
  label: string;
  note: string;
  config: Omit<SandboxConfig, 'lowTier' | 'wetTier' | 'persist' | 'domainKm' | 'mapAspect'> & {
    lowTier?: Tier;
    wetTier?: Tier;
    persist?: boolean;
    domainKm?: number;
    mapAspect?: number;
  };
}

export const DOMAIN_OPTIONS: { value: number; label: string }[] = [
  { value: 240, label: '局地 · 240 km' },
  { value: 480, label: '中等 · 480 km' },
  { value: 960, label: '大型 · 960 km' },
  { value: 1920, label: '宏观 · 1920 km' },
];

export const TERRAIN_OPTIONS: { value: TerrainKind; label: string }[] = [
  { value: 'plain', label: '平原' },
  { value: 'coast', label: '海岸' },
  { value: 'mountainCoast', label: '山海交界' },
  { value: 'basin', label: '盆地' },
  { value: 'valley', label: '山谷' },
  { value: 'pass', label: '隘口' },
  { value: 'ridge', label: '山脊' },
  { value: 'plateau', label: '高原' },
  { value: 'island', label: '岛屿' },
  { value: 'lake', label: '湖面' },
  { value: 'delta', label: '三角洲' },
];

export const MAP_ASPECT_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: '方形 1:1' },
  { value: 4 / 3, label: '横版 4:3' },
  { value: 16 / 9, label: '宽幅 16:9' },
];

/** 默认画幅：海岸/高原用横版，河谷与平原用宽幅，岛屿/盆地用方形。 */
export function defaultAspectFor(kind: TerrainKind): number {
  switch (kind) {
    case 'coast':
    case 'mountainCoast':
    case 'delta':
      return 4 / 3;
    case 'valley':
      return 1;
    case 'ridge':
    case 'pass':
      return 4 / 3;
    case 'island':
    case 'basin':
    case 'lake':
      return 1;
    default:
      return 16 / 9;
  }
}

function paletteFor(config: SandboxConfig) {
  if (config.baseTempC <= 0) return 'boreal' as const;
  if (config.humidity <= 5 && config.baseTempC >= 28) return 'arid' as const;
  if (config.terrain === 'coast' || config.terrain === 'mountainCoast' || config.terrain === 'delta') {
    return 'coastal' as const;
  }
  if (config.terrain === 'ridge' || config.terrain === 'pass' || config.terrain === 'plateau') {
    return 'alpine' as const;
  }
  if (config.baseTempC >= 26 && config.humidity >= 13) return 'tropical' as const;
  if (config.terrain === 'lake' || config.terrain === 'basin') return 'wetland' as const;
  return 'temperate' as const;
}

function labelsFor(config: SandboxConfig) {
  const labels: { u: number; v: number; text: string; kind: 'region' | 'range' | 'water' | 'pass' | 'plain' }[] = [];
  switch (config.terrain) {
    case 'coast':
    case 'delta':
      labels.push({ u: 0.78, v: 0.5, text: '近岸水域', kind: 'water' });
      labels.push({ u: 0.36, v: 0.7, text: '沿岸平原', kind: 'plain' });
      break;
    case 'mountainCoast':
      labels.push({ u: 0.38, v: 0.68, text: '海岸山脉', kind: 'range' });
      labels.push({ u: 0.82, v: 0.42, text: '近岸水域', kind: 'water' });
      break;
    case 'basin':
      labels.push({ u: 0.2, v: 0.8, text: '盆缘', kind: 'range' });
      labels.push({ u: 0.56, v: 0.46, text: '盆底', kind: 'plain' });
      break;
    case 'valley':
      labels.push({ u: 0.5, v: 0.5, text: '谷底', kind: 'water' });
      labels.push({ u: 0.18, v: 0.72, text: '坡面', kind: 'range' });
      break;
    case 'pass':
      labels.push({ u: 0.5, v: 0.46, text: '隘口', kind: 'pass' });
      labels.push({ u: 0.5, v: 0.82, text: '山脊', kind: 'range' });
      break;
    case 'ridge':
      labels.push({ u: 0.5, v: 0.55, text: '主脊', kind: 'range' });
      break;
    case 'plateau':
      labels.push({ u: 0.5, v: 0.55, text: '高原面', kind: 'plain' });
      break;
    case 'island':
      labels.push({ u: 0.5, v: 0.5, text: '岛峰', kind: 'range' });
      labels.push({ u: 0.8, v: 0.2, text: '外海', kind: 'water' });
      break;
    case 'lake':
      labels.push({ u: 0.5, v: 0.5, text: '湖面', kind: 'water' });
      labels.push({ u: 0.8, v: 0.26, text: '湖滨', kind: 'plain' });
      break;
    default:
      labels.push({ u: 0.34, v: 0.74, text: '平原', kind: 'plain' });
      labels.push({ u: 0.66, v: 0.32, text: '河渠', kind: 'water' });
      break;
  }
  return labels;
}

export function terrainDef(kind: TerrainKind): TerrainDef {
  switch (kind) {
    case 'coast':
      return { kind, axisXKm: 30, axisDeg: 90, baseHeightM: 180 };
    case 'mountainCoast':
      return {
        kind,
        axisXKm: 20,
        axisDeg: 90,
        ridgeHeightM: 1400,
        ridgeWidthKm: 38,
        ridgeOffsetKm: 18,
        baseHeightM: 120,
      };
    case 'basin':
      return {
        kind,
        basinRadiusKm: 54,
        basinDepthM: 520,
        baseHeightM: 700,
        ridgeHeightM: 300,
      };
    case 'valley':
      return {
        kind,
        valleyHalfWidthKm: 24,
        valleyWallWidthKm: 8,
        ridgeHeightM: 1000,
        baseHeightM: 450,
      };
    case 'pass':
      return {
        kind,
        axisXKm: 0,
        axisDeg: 90,
        ridgeHeightM: 900,
        ridgeWidthKm: 32,
        baseHeightM: 600,
      };
    case 'ridge':
      return {
        kind,
        axisXKm: 0,
        axisDeg: 0,
        ridgeHeightM: 1250,
        ridgeWidthKm: 40,
        baseHeightM: 400,
      };
    case 'plateau':
      return {
        kind,
        plateauHeightM: 1600,
        plateauEdgeKm: 44,
        baseHeightM: 600,
      };
    case 'island':
      return { kind, islandRadiusKm: 34, baseHeightM: 0 };
    case 'lake':
      return { kind, lakeRadiusKm: 30, baseHeightM: 220 };
    case 'delta':
      return { kind, axisXKm: 10, axisDeg: 90, baseHeightM: 80 };
    default:
      return { kind: 'plain', baseHeightM: 200 };
  }
}

function sites(domainKm: number) {
  return [
    { id: 'A', name: '观测 A', xKm: domainKm * 0.38, yKm: domainKm * 0.52, population: 0.8 },
    { id: 'B', name: '观测 B', xKm: domainKm * 0.66, yKm: domainKm * 0.34, population: 0.35 },
    { id: 'C', name: '观测 C', xKm: domainKm * 0.24, yKm: domainKm * 0.72, population: 0.1 },
  ];
}

export function sceneFromConfig(
  config: SandboxConfig,
  domainKm = config.domainKm,
  n = 128,
): SceneDef {
  return {
    domainKm,
    n,
    centerLat: 30,
    centerLon: 114,
    baseTempC: config.baseTempC,
    sstC: config.sstC,
    soil: config.soil,
    bgWindU: config.windU,
    bgWindV: config.windV,
    bgHumidity: config.humidity,
    timeOfDay: config.timeOfDay,
    terrain: terrainDef(config.terrain),
    map: {
      aspect: config.mapAspect,
      palette: paletteFor(config),
      region: `${TERRAIN_OPTIONS.find((item) => item.value === config.terrain)?.label ?? '平原'} · ${domainKm} km`,
      labels: labelsFor(config),
      riverStyle:
        config.terrain === 'plain'
          ? paletteFor(config) === 'arid'
            ? 'dry'
            : paletteFor(config) === 'temperate' && config.humidity <= 8
              ? 'canal'
              : 'network'
          : undefined,
      rivers: 'auto',
    },
    sites: sites(domainKm),
  };
}

function makeAction(
  id: string,
  kind: CardAction['kind'],
  variant: CardAction['variant'],
  tier: Tier,
  xKm: number,
  yKm: number,
  hour = 0,
  directionDeg?: number,
): CardAction {
  return { id, kind, variant, tier, xKm, yKm, hour, directionDeg };
}

export function buildSandboxLevel(config: SandboxConfig): LevelDef {
  const scene = sceneFromConfig(config);
  const domain = scene.domainKm;
  const preset: CardAction[] = [];
  if (config.low) {
    preset.push(
      makeAction(
        'preset-low',
        'pressure',
        config.lowWarm ? 'warmLow' : 'coldLow',
        config.lowTier,
        domain * 0.5,
        domain * 0.52,
      ),
    );
  }
  if (config.high) {
    preset.push(
      makeAction('preset-high', 'pressure', 'coldHigh', 2, domain * 0.76, domain * 0.28),
    );
  }
  if (config.wet) {
    preset.push(
      makeAction('preset-wet', 'moisture', 'wet', config.wetTier, domain * 0.5, domain * 0.52),
    );
  }
  if (config.cool) {
    preset.push(
      makeAction('preset-cool', 'temperature', 'coldShallow', 3, domain * 0.5, domain * 0.52),
    );
  }
  if (config.warm) {
    preset.push(
      makeAction('preset-warm', 'temperature', 'warmShallow', 3, domain * 0.5, domain * 0.52),
    );
  }
  if (config.jet) {
    preset.push(
      makeAction('preset-jet', 'wind', 'lowJet', 3, domain * 0.2, domain * 0.5, 0, 70),
    );
  }

  return {
    id: 9000,
    volume: 0,
    title: '物理沙盒',
    teaching: '这里不是关卡，只用可调场景验证物理场。',
    scale: 'M',
    scene,
    rounds: Math.max(1, Math.round(config.rounds)),
    available: ['pressure', 'temperature', 'moisture', 'wind', 'pv'],
    preset,
    chain: [],
    fallback: [],
    spatial: [],
    hints: [],
    demoActions: [],
  };
}

export const PRESETS: SandboxPreset[] = [
  {
    id: 'warm-rain',
    label: '暖性降水',
    note: '26℃ 湿空气 + 暖低压：验证雨、层云、PW 与雨带。',
    config: {
      terrain: 'plain',
      mapAspect: 4 / 3,
      baseTempC: 26,
      sstC: 28,
      soil: 0.45,
      humidity: 12,
      windU: 2,
      windV: 2,
      timeOfDay: 14,
      rounds: 8,
      low: true,
      lowWarm: true,
      high: false,
      wet: true,
      cool: false,
      warm: false,
      jet: false,
    },
  },
  {
    id: 'cold-snow',
    label: '冷性降雪',
    note: '-10℃ 地面：验证 850 hPa 负温与雪份额。',
    config: {
      terrain: 'plain',
      mapAspect: 1,
      baseTempC: -10,
      sstC: 2,
      soil: 0.6,
      humidity: 3.2,
      windU: 3,
      windV: 1,
      timeOfDay: 6,
      rounds: 8,
      low: true,
      lowWarm: false,
      high: false,
      wet: true,
      cool: false,
      warm: false,
      jet: false,
    },
  },
  {
    id: 'lake-snow',
    label: '湖效应雪',
    note: '冷空气过暖湖：验证湖面 q/w 注入与冷性降雪。',
    config: {
      terrain: 'lake',
      mapAspect: 4 / 3,
      baseTempC: -12,
      sstC: 4,
      soil: 0.35,
      humidity: 3.5,
      windU: 10,
      windV: 4,
      timeOfDay: 6,
      rounds: 8,
      low: true,
      lowWarm: false,
      high: false,
      wet: false,
      cool: false,
      warm: false,
      jet: false,
    },
  },
  {
    id: 'convective',
    label: '强对流',
    note: '30℃ 高湿 + 强暖低压：验证 CAPE、w、雨强与雷暴；本场地面 30℃，冰雹相态要求地面≤18℃，不会误报。',
    config: {
      terrain: 'plain',
      mapAspect: 1,
      baseTempC: 30,
      sstC: 30,
      soil: 0.4,
      humidity: 16,
      windU: 1,
      windV: 1,
      timeOfDay: 15,
      rounds: 8,
      low: true,
      lowWarm: true,
      high: false,
      wet: true,
      cool: false,
      warm: false,
      jet: false,
    },
  },
  {
    id: 'hailstorm',
    label: '雹暴（冷环境）',
    note: '15℃ 地面 + 强暖低压 + 湿空气：验证冷性对流冰雹份额；960 km 下关闭急流避免低压被推出场。',
    config: {
      terrain: 'plain',
      mapAspect: 16 / 9,
      baseTempC: 15,
      sstC: 22,
      soil: 0.5,
      humidity: 14,
      windU: 2,
      windV: 2,
      timeOfDay: 15,
      rounds: 8,
      low: true,
      lowWarm: true,
      high: false,
      wet: true,
      cool: false,
      warm: false,
      jet: false,
      persist: true,
    },
  },
  {
    id: 'typhoon',
    label: '台风',
    note: '暖海 + 深低压：深低压自身梯度即可生风，960 km 下关闭急流以免把中心推出场。',
    config: {
      terrain: 'island',
      baseTempC: 28,
      sstC: 30,
      soil: 0.2,
      humidity: 14,
      windU: 2,
      windV: 2,
      timeOfDay: 12,
      rounds: 8,
      low: true,
      lowWarm: true,
      high: false,
      wet: true,
      cool: false,
      warm: false,
      jet: false,
    },
  },
  {
    id: 'dust',
    label: '沙尘',
    note: '干土 + 强风：验证无降水、低 RH 与沙尘配方。',
    config: {
      terrain: 'plain',
      mapAspect: 16 / 9,
      baseTempC: 32,
      sstC: 26,
      soil: 0.1,
      humidity: 4,
      windU: 14,
      windV: 2,
      timeOfDay: 12,
      rounds: 8,
      low: false,
      lowWarm: false,
      high: true,
      wet: false,
      cool: false,
      warm: false,
      jet: false,
    },
  },
  {
    id: 'sea-breeze',
    label: '海陆风',
    note: '海岸 + 午后：验证海风、辐合与海风锋对流；当前低层温度异常弱，风向转向可能不显著。',
    config: {
      terrain: 'coast',
      baseTempC: 34,
      sstC: 20,
      soil: 0.65,
      humidity: 10,
      windU: 0.5,
      windV: 0,
      timeOfDay: 13,
      rounds: 8,
      low: false,
      lowWarm: false,
      high: false,
      wet: false,
      cool: false,
      warm: true,
      jet: false,
    },
  },
  {
    id: 'basin-fog',
    label: '盆地雾/冷池',
    note: '盆地 + 夜间静风：验证夜间降温与低层湿度；冷池用最低温代理，雾尚无独立诊断。',
    config: {
      terrain: 'basin',
      baseTempC: 8,
      sstC: 8,
      soil: 0.55,
      humidity: 9,
      windU: 0,
      windV: 0,
      timeOfDay: 22,
      rounds: 8,
      low: false,
      lowWarm: false,
      high: true,
      wet: false,
      cool: true,
      warm: false,
      jet: false,
      persist: false,
    },
  },
  {
    id: 'valley',
    label: '山谷风',
    note: '山谷 + 早晨：局地 480 km 验证坡面温差与风向反转。',
    config: {
      domainKm: 480,
      terrain: 'valley',
      baseTempC: 18,
      sstC: 18,
      soil: 0.5,
      humidity: 9,
      windU: 0,
      windV: 0,
      timeOfDay: 7,
      rounds: 8,
      low: false,
      lowWarm: false,
      high: false,
      wet: false,
      cool: false,
      warm: false,
      jet: false,
    },
  },
  {
    id: 'front',
    label: '锋面雨带',
    note: '冷低压 + 高压 + 湿空气：背景 U=12 验证锋区与雨带。',
    config: {
      terrain: 'plain',
      mapAspect: 16 / 9,
      baseTempC: 18,
      sstC: 22,
      soil: 0.5,
      humidity: 10,
      windU: 12,
      windV: 0,
      timeOfDay: 12,
      rounds: 8,
      low: true,
      lowWarm: false,
      high: true,
      wet: true,
      cool: false,
      warm: false,
      jet: true,
    },
  },
  {
    id: 'cold-rain',
    label: '冷雨/冻雨尝试',
    note: '-3℃ 地面 + 湿空气：验证冷性降水分配；当前层结没有暖鼻，若出雪而非冻雨，说明物理边界。',
    config: {
      terrain: 'plain',
      mapAspect: 4 / 3,
      baseTempC: -3,
      sstC: 2,
      soil: 0.5,
      humidity: 4,
      windU: 2,
      windV: 1,
      timeOfDay: 6,
      rounds: 8,
      low: true,
      lowWarm: false,
      high: false,
      wet: true,
      cool: false,
      warm: false,
      jet: false,
    },
  },
];

export function defaultConfig(): SandboxConfig {
  const p = PRESETS[0].config as SandboxConfig;
  return {
    ...p,
    domainKm: p.domainKm ?? 960,
    mapAspect: p.mapAspect ?? defaultAspectFor(p.terrain),
    lowTier: (p.lowTier ?? 3) as Tier,
    wetTier: (p.wetTier ?? 2) as Tier,
    persist: p.persist ?? true,
  };
}

export function configFromPreset(preset: SandboxPreset): SandboxConfig {
  const c = preset.config;
  return {
    ...defaultConfig(),
    ...c,
    domainKm: c.domainKm ?? 960,
    mapAspect: c.mapAspect ?? defaultAspectFor(c.terrain),
    lowTier: (c.lowTier ?? 3) as Tier,
    wetTier: (c.wetTier ?? 2) as Tier,
    persist: c.persist ?? true,
  };
}
