/**
 * V2 · 卷一「气压与风」（1–12）。
 * 设计锚点：docs/V2/04 §6 卷一、§7.1。
 *
 * 卷一同时开放气压与风（低空急流）：
 *  1–2 建立升降直觉；3 起引入风，讲“气压梯度生风”；
 *  4–12 覆盖地转偏向、系统尺度、强度档位、双系统、平流、
 *  阻挡、热力性质、摩擦角与综合读图。
 */

import type {
  CardAction,
  CardKind,
  GoalCheck,
  LevelDef,
  MapDesign,
  SceneDef,
  SiteDef,
  TerrainDef,
} from '../core/types';

const DOMAIN_KM = 640;
const N = 256;

function scene(over: Partial<SceneDef> & { terrain?: Partial<TerrainDef> }): SceneDef {
  const terrain: TerrainDef = {
    kind: 'plain',
    baseHeightM: 60,
    reliefM: 22,
    cityRoughness: 0.8,
    ...over.terrain,
  };
  const { terrain: _ignored, ...rest } = over;
  void _ignored;
  return {
    domainKm: DOMAIN_KM,
    n: N,
    centerLat: 30,
    centerLon: 112,
    baseTempC: 22,
    sstC: 27,
    soil: 0.45,
    bgWindU: 0,
    bgWindV: 0,
    bgHumidity: 8,
    timeOfDay: 8,
    sites: [],
    ...rest,
    terrain,
  };
}

function site(id: string, name: string, xKm: number, yKm: number, population = 100, marine = false): SiteDef {
  return { id, name, xKm, yKm, population, marine };
}

function check(
  id: string,
  label: string,
  metric: string,
  op: '>=' | '<=' | 'between',
  value: number,
  windowH: [number, number],
  options: Partial<GoalCheck> = {},
): GoalCheck {
  return { id, label, at: 'domain', metric, op, value, windowH, ...options };
}

function cityCheck(
  id: string,
  label: string,
  siteId: string,
  metric: string,
  op: '>=' | '<=' | 'between',
  value: number,
  windowH: [number, number],
  options: Partial<GoalCheck> = {},
): GoalCheck {
  return { id, label, at: 'city', siteId, metric, op, value, windowH, ...options };
}

function action(
  id: string,
  kind: CardKind,
  variant: CardAction['variant'],
  tier: 1 | 2 | 3,
  xKm: number,
  yKm: number,
  hour: number,
  directionDeg = 90,
): CardAction {
  return { id, kind, variant, tier, xKm, yKm, hour, directionDeg };
}

const PRESSURE_ONLY: CardKind[] = ['pressure'];
const PRESSURE_WIND: CardKind[] = ['pressure', 'wind'];

const RAW_VOLUME1: LevelDef[] = [
  // ── 1 ────────────────────────────────────────────────────────────────
  {
    id: 1,
    volume: 1,
    title: '一升一降',
    teaching: '低压中心空气上升，高压中心空气下沉。',
    scale: 'M',
    scene: scene({
      sites: [site('A', '山城', 300, 320, 220), site('B', '湖城', 520, 320, 180)],
      terrain: { kind: 'plain', baseHeightM: 80, reliefM: 30 },
    }),
    rounds: 3,
    available: PRESSURE_ONLY,
    chain: [
      check('low', '低压建立', 'minP', '<=', -8, [0, 9]),
      cityCheck('cloudA', 'A 城上升成云', 'A', 'cc', '>=', 0.5, [1, 9]),
      cityCheck('clearB', 'B 城高压晴空', 'B', 'clearUnderHigh', '<=', 0.2, [1, 9]),
      // 只看“B 城晴”会被空解骗过：不放高压，天空本来就是晴的。
      cityCheck('highB', 'B 城气压升高', 'B', 'p', '>=', 4, [1, 9]),
    ],
    fallback: [cityCheck('pA', 'A 城气压下降', 'A', 'p', '<=', -2, [0, 9])],
    spatial: [
      {
        id: 'rain-band',
        label: '雨带形态成立',
        assertions: [
          {
            id: 'rain-band-elongation',
            label: '雨带长宽比',
            metric: 'rainElongation',
            op: '>=',
            value: 1.1,
            windowH: [0, 9],
          },
          {
            id: 'rain-band-coverage',
            label: '雨带覆盖',
            metric: 'rainCoverage',
            op: '>=',
            value: 0.02,
            windowH: [0, 9],
          },
        ],
      },
    ],
    hints: [
      '低压不是“写上上升”，而是让空气自己辐合上升。',
      '把低压放在 A 城附近，把高压放在 B 城附近。',
      '高压控制下风向外散开，天空晴朗。',
    ],
    demoActions: [
      action('d1a', 'pressure', 'coldLow', 2, 300, 320, 0),
      action('d1b', 'pressure', 'warmHigh', 2, 520, 320, 3),
    ],
    optimalCards: 2,
  },

  // ── 2 ────────────────────────────────────────────────────────────────
  {
    id: 2,
    volume: 1,
    title: '高压之下',
    teaching: '高压下沉会压住云和降水。',
    scale: 'M',
    scene: scene({
      sites: [site('A', '平原城', 320, 320, 260)],
      terrain: { kind: 'plain', baseHeightM: 60, reliefM: 20 },
    }),
    rounds: 3,
    available: PRESSURE_ONLY,
    preset: [action('p2', 'pressure', 'coldLow', 1, 320, 320, 0)],
    chain: [
      check('high', '高压建立', 'maxP', '>=', 8, [0, 9]),
      cityCheck('clear', '城区云量压到 0.2 以下', 'A', 'cc', '<=', 0.2, [2, 9]),
      cityCheck('dry', '城区累计降水不超过 0.2 mm', 'A', 'precipAcc', '<=', 0.2, [0, 9]),
    ],
    fallback: [cityCheck('pA', '城区气压升高', 'A', 'p', '>=', 3, [0, 9])],
    hints: [
      '背景里已经有一个弱低压，天空正要变阴。',
      '高压的下沉气流会压制凝结。',
      '把高压放在城区，让下沉占据主导。',
    ],
    demoActions: [action('d2', 'pressure', 'warmHigh', 3, 320, 320, 0)],
    optimalCards: 1,
  },

  // ── 3 ────────────────────────────────────────────────────────────────
  {
    id: 3,
    volume: 1,
    title: '气压梯度生风',
    teaching: '气压差产生气压梯度力，梯度越大风越强。',
    scale: 'M',
    scene: scene({
      sites: [site('A', '风城', 320, 320, 150)],
      terrain: { kind: 'plain', baseHeightM: 70, reliefM: 24 },
    }),
    rounds: 3,
    available: PRESSURE_WIND,
    chain: [
      check('wind', '城区风速达到 5 m/s', 'maxWind', '>=', 5, [0, 9]),
      cityCheck('windA', 'A 城实测风速', 'A', 'wind10', '>=', 5, [0, 9]),
    ],
    fallback: [check('grad', '气压梯度足够', 'maxP', '>=', 12, [0, 9])],
    hints: [
      '风不是直接“放”出来的（本关的风卡是高空急流），先看气压梯度。',
      '一南一北两个系统能拉出最强的梯度。',
      '低压在北、高压在南，A 城会吹起偏东风。',
    ],
    demoActions: [
      action('d3a', 'pressure', 'coldLow', 3, 320, 210, 0),
      action('d3b', 'pressure', 'warmHigh', 3, 320, 430, 3),
    ],
    optimalCards: 2,
  },

  // ── 4 ────────────────────────────────────────────────────────────────
  {
    id: 4,
    volume: 1,
    title: '北半球的偏转',
    teaching: '地转偏向让北半球低压周围的风逆时针旋转。',
    scale: 'M',
    scene: scene({
      sites: [site('A', '环流城', 320, 320, 140)],
      terrain: { kind: 'plain', baseHeightM: 55, reliefM: 18 },
    }),
    rounds: 3,
    available: PRESSURE_WIND,
    chain: [
      check('low', '低压建立', 'minP', '<=', -8, [0, 9]),
      check('ccw', '低压周围呈逆时针环流', 'ccw', '>=', 0.8, [1, 9]),
    ],
    fallback: [cityCheck('windA', '城区有可测风', 'A', 'wind10', '>=', 2, [0, 9])],
    hints: [
      '北半球的地转偏向力总把风往右推。',
      '低压中心的风是逆时针往里旋的。',
      '把低压放在城区附近，观察风矢的旋转方向。',
    ],
    demoActions: [action('d4', 'pressure', 'coldLow', 2, 320, 240, 0)],
    optimalCards: 1,
  },

  // ── 5 ────────────────────────────────────────────────────────────────
  {
    id: 5,
    volume: 1,
    title: '低压的半径',
    teaching: '系统尺度决定雨区大小：太小的低压只能下小雨。',
    scale: 'M',
    scene: scene({
      sites: [site('A', '雨量城', 320, 320, 160)],
      terrain: { kind: 'plain', baseHeightM: 65, reliefM: 20 },
    }),
    rounds: 3,
    available: PRESSURE_ONLY,
    chain: [
      check('low', '低压建立', 'minP', '<=', -8, [0, 9]),
      check('radius', '雨区半径落在 60–120 km', 'rainRadiusKm', 'between', 60, [2, 9], {
        value2: 120,
      }),
      cityCheck('rainA', '城区出现降水', 'A', 'precipAcc', '>=', 1, [0, 9]),
    ],
    fallback: [cityCheck('cloudA', '城区成云', 'A', 'cc', '>=', 0.4, [1, 9])],
    hints: [
      '低压的影响范围由它的半径决定，而不是由中心强度单独决定。',
      '强度档位越大，螺旋雨带铺得越开。',
      '试一档中等强度，让雨区半径落在 60–120 km。',
    ],
    demoActions: [action('d5', 'pressure', 'coldLow', 2, 320, 320, 0)],
    optimalCards: 1,
  },

  // ── 6 ────────────────────────────────────────────────────────────────
  {
    id: 6,
    volume: 1,
    title: '三档强弱',
    teaching: '强度档位不是“更大数字”，而是不同的天气后果。',
    scale: 'M',
    scene: scene({
      sites: [
        site('A', '小城', 150, 320, 90),
        site('B', '中城', 320, 320, 120),
        site('C', '大城', 550, 320, 200),
      ],
      terrain: { kind: 'plain', baseHeightM: 60, reliefM: 20 },
    }),
    rounds: 3,
    available: PRESSURE_ONLY,
    chain: [
      check('mono', '三城雨量随档位单调递增', 'monotonicRain', '>=', 1, [0, 9]),
      cityCheck('rainA', 'A 城有雨', 'A', 'precipAcc', '>=', 0.3, [0, 9]),
      cityCheck('rainB', 'B 城有雨', 'B', 'precipAcc', '>=', 0.6, [0, 9]),
      cityCheck('rainC', 'C 城有雨', 'C', 'precipAcc', '>=', 1.2, [0, 9]),
    ],
    fallback: [check('lows', '至少两个低压', 'lowCount', '>=', 2, [0, 9])],
    hints: [
      '三档强度会带来三档完全不同的雨强。',
      '先放最强的，让它有更长时间发展。',
      '把强档放在 C 城、中档放在 B 城、弱档放在 A 城。',
    ],
    demoActions: [
      action('d6a', 'pressure', 'coldLow', 3, 550, 320, 0),
      action('d6b', 'pressure', 'coldLow', 2, 320, 320, 3),
      action('d6c', 'pressure', 'coldLow', 1, 150, 320, 6),
    ],
    optimalCards: 3,
  },

  // ── 7 ────────────────────────────────────────────────────────────────
  {
    id: 7,
    volume: 1,
    title: '两个低压',
    teaching: '两个低压会互相牵引：靠得太近合并，离得远则互旋。',
    scale: 'M',
    scene: scene({
      sites: [site('A', '双低压城', 320, 320, 130)],
      terrain: { kind: 'plain', baseHeightM: 58, reliefM: 18 },
    }),
    rounds: 4,
    available: PRESSURE_ONLY,
    chain: [
      check('double', '双低压合并或保持互旋', 'doubleLowOutcome', '>=', 1, [0, 12]),
    ],
    fallback: [check('low', '至少一个低压', 'lowCount', '>=', 1, [0, 12])],
    hints: [
      '两个低压的环流会互相影响。',
      '它们可能合并成一个更强的系统，也可能保持距离互旋。',
      '先放一个，再在 100 km 外放第二个，观察它们的运动。',
    ],
    demoActions: [
      action('d7a', 'pressure', 'coldLow', 2, 250, 320, 0),
      action('d7b', 'pressure', 'coldLow', 2, 390, 320, 3),
    ],
    optimalCards: 2,
  },

  // ── 8 ────────────────────────────────────────────────────────────────
  {
    id: 8,
    volume: 1,
    title: '系统随风走',
    teaching: '气压系统会被引导气流平流，风卡决定它往哪走。',
    scale: 'M',
    scene: scene({
      sites: [site('A', '轨迹城', 320, 320, 120)],
      terrain: { kind: 'plain', baseHeightM: 60, reliefM: 20 },
      bgWindU: 2,
    }),
    rounds: 4,
    available: PRESSURE_WIND,
    chain: [
      check('low', '低压建立', 'minP', '<=', -8, [0, 9]),
      check('move', '低压移动 ≥ 160 km', 'lowDisplacementKm', '>=', 160, [0, 12]),
    ],
    fallback: [cityCheck('windA', '城区有明显风', 'A', 'wind10', '>=', 4, [0, 9])],
    hints: [
      '低压自己不会走，它坐在引导气流里。',
      '低空急流是一条狭窄的强风带，把它放在低压下风方向。',
      '先放低压，再放急流，让它被风推着走；12 小时能挪过图面的四分之一。',
    ],
    demoActions: [
      action('d8a', 'pressure', 'coldLow', 2, 180, 320, 0),
      action('d8b', 'wind', 'lowJet', 3, 220, 320, 3, 90),
    ],
    optimalCards: 2,
  },

  // ── 9 ────────────────────────────────────────────────────────────────
  {
    id: 9,
    volume: 1,
    title: '高压阻挡',
    teaching: '高压像一堵墙：低压撞上它会减速、转向，而不是穿过去。',
    scale: 'M',
    scene: scene({
      sites: [site('A', '转向城', 320, 320, 110)],
      terrain: { kind: 'plain', baseHeightM: 62, reliefM: 20 },
      bgWindU: 0,
    }),
    rounds: 4,
    available: PRESSURE_WIND,
    fixed: [action('f9', 'pressure', 'warmHigh', 3, 450, 320, 0)],
    chain: [
      check('high', '高压建立', 'maxP', '>=', 10, [0, 12]),
      check('block', '低压没有穿过高压', 'blockDistanceKm', '>=', 55, [0, 12]),
      check('deflect', '低压路径偏转 ≥ 40°', 'deflectAngle', '>=', 40, [0, 12]),
    ],
    fallback: [check('low', '低压建立', 'minP', '<=', -6, [0, 12])],
    hints: [
      '图上已经有一个阻挡高压，它固定不动。',
      '用低空急流把低压推向高压，观察它绕开而不是穿过去。',
      '低压靠近高压时会被带着转向——这就是引导与阻挡。',
    ],
    demoActions: [
      action('d9a', 'pressure', 'coldLow', 2, 250, 320, 0),
      action('d9b', 'wind', 'lowJet', 1, 280, 320, 3, 90),
    ],
    optimalCards: 2,
  },

  // ── 10 ───────────────────────────────────────────────────────────────
  {
    id: 10,
    volume: 1,
    title: '暖低与冷低',
    teaching: '同样强度下，暖低压更容易触发对流，冷低压只铺层云。',
    scale: 'M',
    scene: scene({
      sites: [site('A', '暖低城', 140, 320, 140), site('B', '冷低城', 500, 320, 140)],
      terrain: { kind: 'basin', baseHeightM: 90, reliefM: 26, basinRadiusKm: 200, basinDepthM: 120 },
    }),
    rounds: 4,
    available: PRESSURE_ONLY,
    chain: [
      check('ratio', '暖低城降水至少是冷低城 2.5 倍', 'warmColdRatio', '>=', 2.5, [0, 12]),
      cityCheck('rainA', '暖低城出现对流性降水', 'A', 'precipAcc', '>=', 2, [0, 12]),
      cityCheck('cloudB', '冷低城维持层云', 'B', 'cc', '>=', 0.35, [0, 12]),
    ],
    fallback: [check('lows', '两个低压同时存在', 'lowCount', '>=', 2, [0, 12])],
    hints: [
      '暖低压有暖核，上升运动更强，水汽更容易凝结。',
      '冷低压的上升弱，通常只铺一层云。',
      '把暖低压放在 A 城，冷低压放在 B 城，比较两边的雨强。',
    ],
    demoActions: [
      action('d10a', 'pressure', 'warmLow', 3, 140, 320, 0),
      action('d10b', 'pressure', 'coldLow', 2, 500, 320, 3),
    ],
    optimalCards: 2,
  },

  // ── 11 ───────────────────────────────────────────────────────────────
  {
    id: 11,
    volume: 1,
    title: '摩擦角',
    teaching: '海上风几乎平行等压线，陆地风会斜穿等压线指向低压。',
    scale: 'M',
    scene: scene({
      sites: [
        site('M', '海上平台', 120, 320, 0, true),
        site('L', '内陆站', 380, 320, 60),
      ],
      terrain: { kind: 'coast', axisXKm: -110, axisDeg: 0, baseHeightM: 70, reliefM: 20 },
      bgWindU: 0.5,
    }),
    rounds: 4,
    available: PRESSURE_WIND,
    chain: [
      cityCheck('sea', '海上站点偏角 < 18°', 'M', 'crossAngle', '<=', 18, [0, 12]),
      cityCheck('land', '内陆站点偏角 > 24°', 'L', 'crossAngle', '>=', 24, [0, 12]),
    ],
    fallback: [cityCheck('windM', '海上有风', 'M', 'wind10', '>=', 2, [0, 12])],
    hints: [
      '海面光滑，风几乎沿着等压线吹。',
      '陆地粗糙，风会斜穿等压线，指向低压。',
      '在海岸西侧放一个低压，让气流同时经过海上和陆地。',
    ],
    demoActions: [action('d11', 'pressure', 'coldLow', 3, 250, 320, 0)],
    optimalCards: 1,
  },

  // ── 12 ───────────────────────────────────────────────────────────────
  {
    id: 12,
    volume: 1,
    title: '一张天气图',
    teaching: '三个系统共存时，要读出各自的位置、强度与影响范围。',
    scale: 'M',
    scene: scene({
      sites: [
        site('A', '低压城', 150, 320, 120),
        site('B', '高压城', 330, 210, 100),
        site('C', '风城', 490, 420, 140),
      ],
      terrain: { kind: 'plateau', baseHeightM: 120, reliefM: 30, plateauHeightM: 500, plateauEdgeKm: 230 },
    }),
    rounds: 4,
    available: PRESSURE_WIND,
    chain: [
      check('sep', '三系统互不干扰（间距 ≥ 100 km）', 'minCenterSepKm', '>=', 100, [0, 12]),
      check('low', '低压存在', 'lowCount', '>=', 1, [0, 12]),
      check('high', '高压存在', 'highCount', '>=', 1, [0, 12]),
      cityCheck('cloudA', 'A 城有云', 'A', 'cc', '>=', 0.4, [0, 12]),
      cityCheck('clearB', 'B 城晴朗', 'B', 'cc', '<=', 0.25, [0, 12]),
      cityCheck('windC', 'C 城有风', 'C', 'wind10', '>=', 4, [0, 12]),
    ],
    fallback: [check('wind', '全图最大风 ≥ 4 m/s', 'maxWind', '>=', 4, [0, 12])],
    hints: [
      '一张图上要同时读出低压、高压和风。',
      '系统之间保持距离，就不会互相吞并。',
      '低压放 A、高压放 B、风卡放在 C 城下风方向。',
    ],
    demoActions: [
      action('d12a', 'pressure', 'coldLow', 2, 150, 320, 0),
      action('d12b', 'pressure', 'warmHigh', 2, 330, 210, 3),
      action('d12c', 'wind', 'lowJet', 2, 490, 420, 6, 45),
    ],
    optimalCards: 3,
  },
];

/**
 * 卷一内容域：按关卡实际需要设定，不再全部共用 640 km。
 * 小图用于单系统教学，大图用于多系统/急流/阻挡。
 * 渲染时在内容域外再留出 50% 边缘（见 MAP_SCALE），卡片/系统本身
 * 不跟着放大，避免一个低压铺满整张图。
 */
const DOMAIN_BY_LEVEL: Record<number, number> = {
  1: 480,
  2: 400,
  3: 520,
  4: 560,
  5: 480,
  6: 720,
  7: 560,
  8: 760,
  9: 640,
  10: 600,
  11: 640,
  12: 880,
};

/** 每张地图的地形特色；参数按目标域的实际 km 给出。 */
const TERRAIN_BY_LEVEL: Record<number, Partial<TerrainDef>> = {
  1: { kind: 'plain', baseHeightM: 80, reliefM: 38, cityRoughness: 0.8 },
  2: { kind: 'basin', baseHeightM: 90, reliefM: 20, basinRadiusKm: 90, basinDepthM: 180, ridgeHeightM: 420 },
  3: { kind: 'pass', baseHeightM: 90, reliefM: 22, axisDeg: 0, ridgeOffsetKm: 150, ridgeWidthKm: 45, ridgeHeightM: 520 },
  4: { kind: 'valley', baseHeightM: 70, reliefM: 16, axisDeg: 0, axisXKm: 0, valleyHalfWidthKm: 120, valleyWallWidthKm: 80, ridgeHeightM: 480 },
  5: { kind: 'lake', baseHeightM: 80, reliefM: 20, axisXKm: -140, lakeRadiusKm: 80 },
  6: { kind: 'plain', baseHeightM: 65, reliefM: 26, cityRoughness: 0.8 },
  7: { kind: 'valley', baseHeightM: 75, reliefM: 18, axisDeg: 90, axisXKm: 0, valleyHalfWidthKm: 150, valleyWallWidthKm: 90, ridgeHeightM: 460 },
  8: { kind: 'pass', baseHeightM: 55, reliefM: 12, axisDeg: 90, ridgeOffsetKm: 240, ridgeWidthKm: 70, ridgeHeightM: 680 },
  9: { kind: 'ridge', baseHeightM: 70, reliefM: 18, ridgeHeightM: 1350, ridgeWidthKm: 58 },
  10: { kind: 'basin', baseHeightM: 90, reliefM: 26, basinRadiusKm: 190, basinDepthM: 150, ridgeHeightM: 520 },
  11: { kind: 'coast', baseHeightM: 70, reliefM: 20, axisXKm: -110, axisDeg: 0 },
  12: {
    kind: 'mountainCoast',
    baseHeightM: 100,
    reliefM: 24,
    axisXKm: -320,
    ridgeOffsetKm: 120,
    ridgeWidthKm: 48,
    ridgeHeightM: 640,
  },
};

const MAP_DESIGN_BY_LEVEL: Record<number, MapDesign> = {
  1: {
    aspect: 4 / 3,
    palette: 'wetland',
    region: '江汉平原 · 480 km',
    riverStyle: 'network',
    labels: [
      { u: 0.22, v: 0.82, text: '北部岗地', kind: 'plain' },
      { u: 0.68, v: 0.36, text: '汉水', kind: 'water' },
    ],
  },
  2: {
    aspect: 1,
    palette: 'temperate',
    region: '盆地试验场 · 400 km',
    labels: [
      { u: 0.18, v: 0.8, text: '盆缘山地', kind: 'range' },
      { u: 0.52, v: 0.52, text: '盆底', kind: 'plain' },
    ],
  },
  3: {
    aspect: 4 / 3,
    palette: 'temperate',
    region: '大别山隘口 · 520 km',
    rivers: 'none',
    labels: [
      { u: 0.18, v: 0.5, text: '西岭', kind: 'range' },
      { u: 0.5, v: 0.3, text: '隘口', kind: 'pass' },
    ],
  },
  4: {
    aspect: 1,
    palette: 'temperate',
    region: '南北向河谷 · 560 km',
    labels: [
      { u: 0.18, v: 0.5, text: '西坡', kind: 'range' },
      { u: 0.5, v: 0.62, text: '河谷', kind: 'water' },
      { u: 0.82, v: 0.5, text: '东坡', kind: 'range' },
    ],
  },
  5: {
    aspect: 4 / 3,
    palette: 'wetland',
    region: '湖区 · 480 km',
    labels: [
      { u: 0.32, v: 0.5, text: '湖面', kind: 'water' },
      { u: 0.72, v: 0.28, text: '湖滨平原', kind: 'plain' },
    ],
  },
  6: {
    aspect: 3 / 2,
    palette: 'temperate',
    region: '平原农区 · 720 km',
    riverStyle: 'canal',
    labels: [
      { u: 0.3, v: 0.7, text: '麦区', kind: 'plain' },
      { u: 0.62, v: 0.38, text: '河渠', kind: 'water' },
    ],
  },
  7: {
    aspect: 4 / 3,
    palette: 'temperate',
    region: '东西向河谷 · 560 km',
    riverStyle: 'valley',
    labels: [
      { u: 0.5, v: 0.28, text: '北坡', kind: 'range' },
      { u: 0.5, v: 0.64, text: '谷底', kind: 'water' },
      { u: 0.5, v: 0.82, text: '南坡', kind: 'range' },
    ],
  },
  8: {
    aspect: 3 / 2,
    palette: 'alpine',
    region: '高山隘口 · 760 km',
    rivers: 'none',
    labels: [
      { u: 0.5, v: 0.72, text: '山脊', kind: 'range' },
      { u: 0.5, v: 0.3, text: '隘口', kind: 'pass' },
    ],
  },
  9: {
    aspect: 1,
    palette: 'alpine',
    region: '山脊试验场 · 640 km',
    rivers: 'none',
    labels: [
      { u: 0.5, v: 0.5, text: '主脊', kind: 'range' },
      { u: 0.28, v: 0.7, text: '山麓', kind: 'plain' },
    ],
  },
  10: {
    aspect: 4 / 3,
    palette: 'arid',
    region: '内陆盆地 · 600 km',
    riverStyle: 'dry',
    labels: [
      { u: 0.2, v: 0.78, text: '盆缘', kind: 'range' },
      { u: 0.6, v: 0.44, text: '盐湖', kind: 'water' },
    ],
  },
  11: {
    aspect: 16 / 9,
    palette: 'coastal',
    region: '东部海岸 · 640 km',
    riverStyle: 'coast',
    labels: [
      { u: 0.2, v: 0.5, text: '近岸浅海', kind: 'water' },
      { u: 0.64, v: 0.58, text: '海岸平原', kind: 'plain' },
    ],
  },
  12: {
    aspect: 3 / 2,
    palette: 'coastal',
    region: '海岸山脉 · 880 km',
    riverStyle: 'coast',
    labels: [
      { u: 0.56, v: 0.7, text: '主脊', kind: 'range' },
      { u: 0.14, v: 0.4, text: '近岸浅海', kind: 'water' },
    ],
  },
};

const KM_METRICS = new Set([
  'rainRadiusKm',
  'maxRainRadiusKm',
  'lowDisplacementKm',
  'highDisplacementKm',
  'blockDistanceKm',
  'minCenterSepKm',
]);

function scaleCheck(check: GoalCheck, f: number): GoalCheck {
  if (!KM_METRICS.has(check.metric)) return { ...check };
  const next: GoalCheck = { ...check, value: check.value * f };
  if (check.value2 !== undefined) next.value2 = check.value2 * f;
  return next;
}

function scaleAction(action: CardAction, f: number, offsetKm: number): CardAction {
  return {
    ...action,
    xKm: action.xKm * f + offsetKm,
    yKm: action.yKm * f + offsetKm,
  };
}

/** 内容域外再留 50% 边缘：地图变大，但卡片/系统半径不变。 */
const MAP_SCALE = 1.5;

function withDomain(level: LevelDef, contentKm: number, terrainOverride: Partial<TerrainDef>): LevelDef {
  const targetKm = contentKm * MAP_SCALE;
  const offsetKm = (targetKm - contentKm) / 2;
  const f = contentKm / 640;
  const terrain: TerrainDef = {
    ...level.scene.terrain,
    ...(level.scene.terrain.axisXKm !== undefined
      ? { axisXKm: level.scene.terrain.axisXKm * f }
      : {}),
    ...(level.scene.terrain.ridgeWidthKm !== undefined
      ? { ridgeWidthKm: level.scene.terrain.ridgeWidthKm * f }
      : {}),
    ...(level.scene.terrain.ridgeOffsetKm !== undefined
      ? { ridgeOffsetKm: level.scene.terrain.ridgeOffsetKm * f }
      : {}),
    ...(level.scene.terrain.basinRadiusKm !== undefined
      ? { basinRadiusKm: level.scene.terrain.basinRadiusKm * f }
      : {}),
    ...(level.scene.terrain.valleyHalfWidthKm !== undefined
      ? { valleyHalfWidthKm: level.scene.terrain.valleyHalfWidthKm * f }
      : {}),
    ...(level.scene.terrain.valleyWallWidthKm !== undefined
      ? { valleyWallWidthKm: level.scene.terrain.valleyWallWidthKm * f }
      : {}),
    ...(level.scene.terrain.lakeRadiusKm !== undefined
      ? { lakeRadiusKm: level.scene.terrain.lakeRadiusKm * f }
      : {}),
    ...(level.scene.terrain.plateauEdgeKm !== undefined
      ? { plateauEdgeKm: level.scene.terrain.plateauEdgeKm * f }
      : {}),
    ...(level.scene.terrain.islandRadiusKm !== undefined
      ? { islandRadiusKm: level.scene.terrain.islandRadiusKm * f }
      : {}),
    ...terrainOverride,
  };
  return {
    ...level,
    contentDomainKm: contentKm,
    scene: {
      ...level.scene,
      domainKm: targetKm,
      terrain,
      map: level.scene.map ?? MAP_DESIGN_BY_LEVEL[level.id],
      sites: level.scene.sites.map((s) => ({
        ...s,
        xKm: s.xKm * f + offsetKm,
        yKm: s.yKm * f + offsetKm,
      })),
    },
    preset: level.preset?.map((a) => scaleAction(a, f, offsetKm)),
    fixed: level.fixed?.map((a) => scaleAction(a, f, offsetKm)),
    demoActions: level.demoActions.map((a) => scaleAction(a, f, offsetKm)),
    chain: level.chain.map((c) => scaleCheck(c, f)),
    fallback: level.fallback.map((c) => scaleCheck(c, f)),
  };
}

export const VOLUME1: LevelDef[] = RAW_VOLUME1.map((level) =>
  withDomain(
    level,
    DOMAIN_BY_LEVEL[level.id] ?? 640,
    TERRAIN_BY_LEVEL[level.id] ?? {},
  ),
);

export const VOLUME1_INDEX = VOLUME1;

