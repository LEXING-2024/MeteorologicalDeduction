/**
 * V2 · 核心类型。
 *
 * 设计锚点：docs/V2/01 §3、03 §2、04 §6。
 * 词汇是气象的，不是卡牌收集的：玩家只注入“源 / 汇 / 异常”，
 * 现象由模拟演化产生。V2 不修改 V1 任何文件。
 */

export type Scale = 'S' | 'M' | 'L';

export type TerrainKind =
  | 'plain'
  | 'coast'
  | 'mountainCoast'
  | 'basin'
  | 'valley'
  | 'pass'
  | 'ridge'
  | 'plateau'
  | 'island'
  | 'lake'
  | 'delta';

/** 地图底色风格：同一地形也能因气候/区域不同而有明显视觉差异。 */
export type MapPalette =
  | 'temperate'
  | 'coastal'
  | 'arid'
  | 'alpine'
  | 'tropical'
  | 'boreal'
  | 'wetland';

/** 地图上的地名/地貌注记，坐标为域内 0–1 归一化位置（左下为 0,0）。 */
export interface MapLabel {
  u: number;
  v: number;
  text: string;
  kind?: 'region' | 'range' | 'water' | 'pass' | 'plain';
}

/**
 * 纯视觉地图设计，不参与物理。用于让关卡/沙盒拥有“对应这张图”的
 * 配色、画幅与注记，而不是所有地图共用一套绿色底图。
 */
export interface MapDesign {
  /** 画幅宽高比（width / height）；1 为方形，4/3 为横版，3/4 为竖版。 */
  aspect?: number;
  palette?: MapPalette;
  /** 图幅名，如“江汉平原 · 480 km”。 */
  region?: string;
  labels?: MapLabel[];
  /** 是否绘制自动河流；默认按地形自动。 */
  rivers?: 'auto' | 'none';
  /** 河网风格：平原也可以有运河、干河床、辫状水系等不同构图。 */
  riverStyle?: 'network' | 'canal' | 'dry' | 'mountain' | 'coast' | 'valley' | 'lake' | 'island';
}

export type CardKind = 'pressure' | 'temperature' | 'moisture' | 'wind' | 'pv';

export type CardVariant =
  | 'warmLow'
  | 'coldLow'
  | 'warmHigh'
  | 'coldHigh'
  | 'coldShallow'
  | 'coldDeep'
  | 'warmShallow'
  | 'warmDeep'
  | 'wet'
  | 'dry'
  | 'lowJet'
  | 'jetEntry'
  | 'jetExit'
  | 'trough'
  | 'ridge';

export type Tier = 1 | 2 | 3;

export interface TerrainDef {
  kind: TerrainKind;
  /** 海岸 / 山脊轴线位置（km，沿轴法向测量）。 */
  axisXKm?: number;
  /** 轴线相对正东的转角（度，逆时针为正）。 */
  axisDeg?: number;
  ridgeHeightM?: number;
  ridgeWidthKm?: number;
  /** 山脉/山脊相对海岸或轴线的偏移（km）。 */
  ridgeOffsetKm?: number;
  basinRadiusKm?: number;
  basinDepthM?: number;
  valleyHalfWidthKm?: number;
  valleyWallWidthKm?: number;
  lakeRadiusKm?: number;
  plateauHeightM?: number;
  plateauEdgeKm?: number;
  islandRadiusKm?: number;
  baseHeightM?: number;
  /** 城市粗糙度（m）。 */
  cityRoughness?: number;
  /** 地形起伏的细微差异（确定性噪声幅度，m）。 */
  reliefM?: number;
}

export interface SiteDef {
  id: string;
  name: string;
  xKm: number;
  yKm: number;
  population: number;
  /** 海上站点（平台 / 浮标），用于摩擦角等海上读数。 */
  marine?: boolean;
}

export interface SceneDef {
  domainKm: number;
  /** 每边格点数。V2 目标 128。 */
  n: number;
  centerLat: number;
  centerLon: number;
  baseTempC: number;
  sstC: number;
  soil: number;
  /** 背景风（m/s，向东 / 向北为正）。 */
  bgWindU: number;
  bgWindV: number;
  /** 背景比湿（g/kg）。 */
  bgHumidity: number;
  /** 模拟开始的本地小时（0–23）。 */
  timeOfDay: number;
  terrain: TerrainDef;
  sites: SiteDef[];
  /** 视觉地图设计（配色 / 画幅 / 注记），不参与物理。 */
  map?: MapDesign;
}

export interface CardAction {
  id: string;
  kind: CardKind;
  variant: CardVariant;
  tier: Tier;
  /** 落点，km（域内）。 */
  xKm: number;
  yKm: number;
  /** 放置时的小时（必须是某回合起点）。 */
  hour: number;
  /** 风向（从北顺时针的流向，度）。仅风卡使用。 */
  directionDeg?: number;
}

export type GoalAt = 'city' | 'domain' | 'windward' | 'leeward';

/**
 * 目标判据。`metric` 是诊断量编号，见 diag/metrics.ts。
 * `op: 'between'` 时用 value / value2 表示闭区间。
 */
export interface GoalCheck {
  id: string;
  label: string;
  at: GoalAt;
  siteId?: string;
  metric: string;
  op: '>=' | '<=' | 'between';
  value: number;
  value2?: number;
  windowH: [number, number];
  /** 默认 true；false 只用于复盘，不作为通过门槛。 */
  required?: boolean;
}

/**
 * M3 空间断言。`metric` 取 FrameMorphology 的字段名（如
 * rainElongation / rainCoverage / frontStrength / maxWindDirShiftDeg）。
 * 与 GoalCheck 的区别：它在时间窗内取最优帧，而不是逐帧极值。
 */
export interface SpatialAssertion {
  id: string;
  label: string;
  metric: string;
  op: '>=' | '<=' | 'between';
  value: number;
  value2?: number;
  windowH: [number, number];
}

/**
 * 一组空间断言。至少一条 required 断言成立，才认为该空间形态成立。
 * 关卡可把它与 chain / fallback 并列；没有 spatial 的关卡行为不变。
 */
export interface SpatialTest {
  id: string;
  label: string;
  assertions: SpatialAssertion[];
  required?: boolean;
}

export interface LevelDef {
  id: number;
  volume: number;
  title: string;
  /** 一句话教学点。 */
  teaching: string;
  scale: Scale;
  scene: SceneDef;
  rounds: number;
  available: CardKind[];
  /** 关卡预置的背景强迫（不占玩家回合，会随流场演化）。 */
  preset?: CardAction[];
  /** 固定背景锚点：不被平流，每回合保持原位（用于阻挡高压等）。 */
  fixed?: CardAction[];
  /** 原始内容域边长（km）；渲染域外扩时用于定位真实内容边界。 */
  contentDomainKm?: number;
  /** 因果链：主体判定。 */
  chain: GoalCheck[];
  /** 结果兜底：防止过程成立但结果离谱。 */
  fallback: GoalCheck[];
  /** M3 空间形态断言（可选；与 chain/fallback 并列计入判题）。 */
  spatial?: SpatialTest[];
  /** 三级提示，逐级展开。 */
  hints: string[];
  /** 已知可用的参考操作，用于验证脚本与内部审计。 */
  demoActions: CardAction[];
  /** 参考解用卡数（仅内部审计，不展示）。 */
  optimalCards?: number;
}

export type PrecipPhase = 'none' | 'rain' | 'sleet' | 'snow' | 'freezingRain' | 'hail';

export interface CitySample {
  id: string;
  name: string;
  xKm: number;
  yKm: number;
  marine: boolean;
  p: number;
  t2m: number;
  /** 体感温度（含风寒/蒸发冷却，仅显示）。 */
  apparentC: number;
  /** 风对气温的局地平流，K/h；负值为冷平流。 */
  tempAdvectionKPerH: number;
  q: number;
  rh: number;
  cc: number;
  /** 总降水率（mm/h，水当量）。 */
  precipRate: number;
  /** 总累计降水（mm，水当量）。 */
  precipAcc: number;
  /** 当前站点占优的降水相态。 */
  phase: PrecipPhase;
  rainRate: number;
  sleetRate: number;
  snowRate: number;
  freezingRainRate: number;
  hailRate: number;
  snowAcc: number;
  hailAcc: number;
  /** 站点整层可降水量（mm）。 */
  pwMm: number;
  /** 站点所在格点的 850 / 500 hPa 温度（℃）。 */
  t850?: number;
  t500?: number;
  wind10: number;
  windDir: number;
  w: number;
  divergence: number;
  /** 风与等压线夹角（度），海上小、陆地大。 */
  crossAngle: number;
}

export interface PressureCenter {
  type: 'L' | 'H';
  xKm: number;
  yKm: number;
  /** 中心异常值（hPa，L 为负）。 */
  value: number;
  /** 等效半径（km）。 */
  radiusKm: number;
  /** 闭合等压线数量。 */
  closedIsobars: number;
}

export interface FrameStats {
  minP: number;
  maxP: number;
  maxW: number;
  maxCloud: number;
  maxRain: number;
  maxAcc: number;
  maxWind: number;
  minTemp: number;
  maxTemp: number;
  meanQ: number;
  windwardRain: number;
  leewardRain: number;
  /** 降水掩膜等效半径（km）。 */
  rainRadiusKm: number;
  rainCentroidXKm: number;
  rainCentroidYKm: number;
  /** 分相降水极大值（mm/h，均为水当量）。 */
  maxRainRate?: number;
  maxSleetRate?: number;
  maxSnowRate?: number;
  maxFreezingRainRate?: number;
  maxHailRate?: number;
  maxSnowAcc?: number;
  maxHailAcc?: number;
  /** 整层可降水量（mm）。 */
  meanPwMm?: number;
  maxPwMm?: number;
  /** 4 标准层热力诊断（℃）。 */
  meanT850?: number;
  minT850?: number;
  maxT850?: number;
  meanT700?: number;
  meanT500?: number;
  minT500?: number;
  maxT500?: number;
  meanT300?: number;
  /** 当前全域占优的降水相态；无降水时为 none。 */
  dominantPhase?: PrecipPhase;
  /** 6.11 水汽四栏账本（单位：网格水汽总量）。 */
  waterStart?: number;
  waterEvaporated?: number;
  waterRained?: number;
  waterEnd?: number;
  waterClosure?: number;
  waterBoundary?: number;
  waterUnaccounted?: number;
  /** 6.12 / 6.7 / 6.8 诊断。 */
  omegaMean?: number;
  capeMean?: number;
  frontogenesisMax?: number;
  coldPoolMax?: number;
}

/**
 * M3 空间形态诊断。它只回答“雨带长什么样、锋区有多强”，
 * 不替代配方识别，也不进入判题数值门槛。
 */
export interface FrameMorphology {
  rainCoverage: number;
  rainAreaKm2: number;
  rainElongation: number;
  rainAxisDeg: number;
  rainLengthKm: number;
  rainWidthKm: number;
  minW: number;
  maxW: number;
  minWind: number;
  maxWind: number;
  maxRh: number;
  minRh: number;
  /** 最大 |∇T|，K/10 km。 */
  frontStrength: number;
  /** 最大暖平流 / 冷平流，K/h。 */
  maxWarmAdvection: number;
  maxColdAdvection: number;
  /** 最大辐合（-∇·V，1/s）。 */
  maxConvergence: number;
  /** 相邻格点风向最大转向（度）。 */
  maxWindDirShiftDeg: number;
  /** 最大风切变，m/s/10 km。 */
  maxWindShear: number;
  /** 城区相对郊区的平均热岛强度（K）。 */
  urbanHeatK: number;
  /** 低压中心暖核（中心实际气温减域平均，K）。 */
  centerWarmCoreK: number;
  /** 低压中心云量（0–1）与眼墙 20–60 km 最大风速（m/s）。 */
  eyeCloud: number;
  eyewallWind: number;
}

export interface Frame {
  hour: number;
  round: number;
  timeOfDay: number;
  pressure: Float32Array;
  temp: Float32Array;
  humidity: Float32Array;
  cloud: Float32Array;
  precipRate: Float32Array;
  precipAcc: Float32Array;
  /** 分相降水率与累计（mm/h、mm，均为水当量，分相之和等于总降水）。 */
  rainRate: Float32Array;
  sleetRate: Float32Array;
  snowRate: Float32Array;
  freezingRainRate: Float32Array;
  hailRate: Float32Array;
  rainAcc: Float32Array;
  sleetAcc: Float32Array;
  snowAcc: Float32Array;
  freezingRainAcc: Float32Array;
  hailAcc: Float32Array;
  /** 整层可降水量（mm）。 */
  pwMm: Float32Array;
  /** 850/700/500/300 hPa 独立温湿层；旧帧可不带。 */
  layerT850?: Float32Array;
  layerT700?: Float32Array;
  layerT500?: Float32Array;
  layerT300?: Float32Array;
  layerQ850?: Float32Array;
  layerQ700?: Float32Array;
  layerQ500?: Float32Array;
  layerQ300?: Float32Array;
  u: Float32Array;
  v: Float32Array;
  w: Float32Array;
  sites: Record<string, CitySample>;
  centers: PressureCenter[];
  stats: FrameStats;
  morphology?: FrameMorphology;
  recipes: string[];
}

export interface CheckResult {
  id: string;
  label: string;
  ok: boolean;
  required: boolean;
  value: number;
  atHour: number | null;
  detail?: string;
}

export interface JudgeResult {
  pass: boolean;
  checks: CheckResult[];
  failed: CheckResult[];
  recipes: string[];
  detail: string;
}
