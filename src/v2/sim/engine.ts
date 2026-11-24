/**
 * V2 · 时间步进模拟。
 * 设计锚点：docs/V2/01 §4、§11。
 *
 * 玩家每回合可放置任意多张要素卡（对气压 / 温度 / 湿度 / 风的源汇注入），
 * 再主动推进 3 小时；现象（云、雨、风、系统移动）由状态演化产生。
 * 确定性：无随机数；同一棋盘重跑逐位一致。
 */

import { clamp, Grid, smoothstep } from '../core/grid';
import type {
  CardAction,
  CardKind,
  CardVariant,
  CitySample,
  Frame,
  FrameStats,
  LevelDef,
  SceneDef,
} from '../core/types';
import { advect } from '../physics/advection';
import { computeWind, type WindResult } from '../physics/wind';
import {
  TwoLayerQG,
  advectTwoLayerPV,
  invertTwoLayer,
} from '../physics/qgTwoLayer';
import { apparentTemperatureC, relativeHumidity, saturationMixingRatio } from '../physics/thermo';
import { dominantPhase, partitionPrecipitation } from '../physics/phase';
import { LayerThermo } from '../physics/layers';
import { computeLocalForcing, createLocalForcing, type LocalForcing } from '../physics/local';
import {
  WaterLedger,
  capeProxy,
  coldPoolStep,
  ekmanSuction,
  latentHeatingK,
  omegaFromW,
  qVectorFrontogenesis,
  qVectorFrontogenesisField,
  radiationHeating,
  surfaceFlux,
  upperJetForcing,
} from '../physics/m2';
import { buildScene, humidityBackgroundCap, initialHumidity, initialTemperature, type SceneFields } from '../scene/scene';
import { crossIsobarAngle, detectCenters, rainArea } from '../diag/diagnostics';
import { detectRecipes, RECIPE_LABELS } from '../diag/recipes';

export { detectRecipes, RECIPE_LABELS };

const DT_SECONDS = 60;
const STEPS_PER_HOUR = 60;
export const HOURS_PER_ROUND = 3;

const TAU_PRESSURE_H = 26;
const TAU_WIND_H = 12;
const TAU_TEMP_H = 11;
/** 每 30 分钟做一次位涡→流函数反演；中间只平流 q。 */
const QG_INVERT_EVERY = 30;
const K_PRECIP = 9.0;
const CLOUD_FALL_RATE = 0.55;
const CLOUD_SCALE = 0.4;
/** 云水自动转化阈值：薄云先存着，超过阈值才形成降水（Kessler 型暖云方案）。 */
const CLOUD_AUTOCONVERT = 0.032;
/** 抬升凝结的相对湿度门槛；参考 Sundqvist 型临界 RH 方案，5 km 格距下允许次网格云量。 */
const COND_RH_ONSET = 0.70;
const COND_RH_FULL = 0.94;
/** 陆地蒸散的目标相对湿度，避免把每块陆地都补到饱和。 */
const LAND_TARGET_RH = 0.68;
/** 抬升造成的 RH 增量（cm/s → 0–0.26），补偿未显式求解的绝热冷却。 */
const LIFT_RH_GAIN = 0.26;
/** 6.3 潜热有效云水率：QG 格点对凝结加热非常敏感，按模式标定折算。 */
const LATENT_EFFECTIVE_FRACTION = 0.00005;

/**
 * 低空急流的形状：沿流向拉长、横向收窄。
 * 之前两个方向都用 5σ / 6σ，急流实际是一个比横向还宽的团块，
 * 既看不出“急流”，也无法用一条窄带引导低压。
 */
export const JET_ALONG_FACTOR = 5.0;
export const JET_ACROSS_FACTOR = 1.6;

export interface ActionReport {
  ok: boolean;
  reason?: string;
}

export interface PlacementRule {
  ok: boolean;
  reason?: string;
}

function windDirectionDeg(u: number, v: number): number {
  return (Math.atan2(-u, -v) * 180) / Math.PI + 360;
}

/** 卡的强度定义（docs/V2/03 §3）。 */
export const TIER_VALUES: Record<CardKind, [number, number, number]> = {
  pressure: [10, 15, 20],
  temperature: [5, 8, 12],
  moisture: [3, 6, 9],
  wind: [20, 30, 40],
  pv: [1.5, 2.5, 4],
};

export function variantSign(variant: CardVariant): number {
  switch (variant) {
    case 'warmLow':
    case 'coldLow':
      return -1;
    case 'warmHigh':
    case 'coldHigh':
      return 1;
    case 'coldShallow':
    case 'coldDeep':
    case 'dry':
      return -1;
    case 'warmShallow':
    case 'warmDeep':
    case 'wet':
      return 1;
    case 'lowJet':
    case 'jetEntry':
    case 'jetExit':
    case 'trough':
      return -1;
    case 'ridge':
      return 1;
    default:
      return 1;
  }
}

export class Simulation {
  readonly level: LevelDef;
  readonly scene: SceneDef;
  readonly grid: Grid;
  readonly fields: SceneFields;

  private pressure: Float64Array;
  private temperature: Float64Array;
  private humidity: Float64Array;
  /** 湿度气候背景：由初始温—湿场生成，用于缓回归和开放边界。 */
  private humidityBg: Float64Array;
  /** 固定背景锚点（不被平流）。 */
  private fixedP: Float64Array;
  private fixedT: Float64Array;
  private pressureTotal: Float64Array;
  private tempTotal: Float64Array;
  private cloud: Float64Array;
  private precipRate: Float64Array;
  private precipAcc: Float64Array;
  /** 分相降水率 / 累计，单位 mm/h、mm（水当量）。 */
  private rainRate: Float64Array;
  private sleetRate: Float64Array;
  private snowRate: Float64Array;
  private freezingRainRate: Float64Array;
  private hailRate: Float64Array;
  private rainAcc: Float64Array;
  private sleetAcc: Float64Array;
  private snowAcc: Float64Array;
  private freezingRainAcc: Float64Array;
  private hailAcc: Float64Array;
  /** 单层湿度经 5 层廓线积分得到的 PW（mm）。 */
  private pwMm: Float64Array;
  /** 850/700/500/300 hPa 的独立温湿层；相态/PW 直接消费。 */
  private readonly layers: LayerThermo;
  private forcingU: Float64Array;
  private forcingV: Float64Array;

  private u: Float64Array;
  private v: Float64Array;
  private ug: Float64Array;
  private vg: Float64Array;
  private ua: Float64Array;
  private va: Float64Array;
  private up: Float64Array;
  private vp: Float64Array;
  private w: Float64Array;
  private divergence: Float64Array;

  private tTmp: Float64Array;
  private qTmp: Float64Array;
  private tempDiff: Float64Array;
  private wEkman: Float64Array;
  private wUpper: Float64Array;
  private wCold: Float64Array;
  private wSmooth: Float64Array;
  /** M2 七项局地模块的附加风/垂直速度/温湿倾向。 */
  private localForcing: LocalForcing;
  /** 边界 w 缓入因子（构造时算一次，只存边界格，避免每步全图扫描）。 */
  private edgeWIndex: Int32Array;
  private edgeWValue: Float64Array;
  private edgeWFactorCells: number;
  /** 每 30 min 更新一次的 Q 矢量锋生率与温度平滑场。 */
  private frontogenesisField: Float64Array;
  private tempSmooth: Float64Array;
  private readonly ledger = new WaterLedger();
  private coldPoolMax = 0;
  /** 背景比湿上限，防止干场景被地表蒸散补成湿场景。 */
  private readonly humidityCap: number;

  private wind: WindResult;
  /** 两层 QG 底层：位涡平流 + 正压/斜压模反演。 */
  private qg: TwoLayerQG;

  private hour = 0;
  private round = 0;
  private subSteps = 0;
  private actionsThisRound = 0;
  private readonly applied: CardAction[] = [];
  private readonly frames: Frame[] = [];

  constructor(level: LevelDef) {
    this.level = level;
    this.scene = level.scene;
    this.humidityCap = humidityBackgroundCap(level.scene);
    this.grid = new Grid(level.scene.domainKm, level.scene.n);
    this.fields = buildScene(level.scene, this.grid);
    const size = this.grid.n * this.grid.n;

    this.pressure = new Float64Array(size);
    this.temperature = initialTemperature(this.fields);
    this.fixedP = new Float64Array(size);
    this.fixedT = new Float64Array(size);
    this.pressureTotal = new Float64Array(size);
    this.tempTotal = new Float64Array(size);
    this.humidity = initialHumidity(level.scene, this.fields);
    this.humidityBg = this.humidity.slice();
    this.cloud = new Float64Array(size);
    this.precipRate = new Float64Array(size);
    this.precipAcc = new Float64Array(size);
    this.rainRate = new Float64Array(size);
    this.sleetRate = new Float64Array(size);
    this.snowRate = new Float64Array(size);
    this.freezingRainRate = new Float64Array(size);
    this.hailRate = new Float64Array(size);
    this.rainAcc = new Float64Array(size);
    this.sleetAcc = new Float64Array(size);
    this.snowAcc = new Float64Array(size);
    this.freezingRainAcc = new Float64Array(size);
    this.hailAcc = new Float64Array(size);
    this.pwMm = new Float64Array(size);
    this.forcingU = new Float64Array(size);
    this.forcingV = new Float64Array(size);

    this.u = new Float64Array(size);
    this.v = new Float64Array(size);
    this.ug = new Float64Array(size);
    this.vg = new Float64Array(size);
    this.ua = new Float64Array(size);
    this.va = new Float64Array(size);
    this.up = new Float64Array(size);
    this.vp = new Float64Array(size);
    this.w = new Float64Array(size);
    this.divergence = new Float64Array(size);

    this.tTmp = new Float64Array(size);
    this.qTmp = new Float64Array(size);
    this.tempDiff = new Float64Array(size);
    this.wEkman = new Float64Array(size);
    this.wUpper = new Float64Array(size);
    this.wCold = new Float64Array(size);
    this.wSmooth = new Float64Array(size);
    this.localForcing = createLocalForcing(size);
    const coastLevel =
      level.scene.terrain.kind === 'coast' ||
      level.scene.terrain.kind === 'mountainCoast';
    this.edgeWFactorCells = coastLevel ? 20 : 16;
    const edgeIndex: number[] = [];
    const edgeValue: number[] = [];
    for (let j = 0; j < this.grid.n; j += 1) {
      for (let i = 0; i < this.grid.n; i += 1) {
        const dEdge = Math.min(i, j, this.grid.n - 1 - i, this.grid.n - 1 - j);
        if (dEdge >= this.edgeWFactorCells) continue;
        const t = dEdge / this.edgeWFactorCells;
        const t2 = t * t;
        const t4 = t2 * t2;
        edgeIndex.push(j * this.grid.n + i);
        edgeValue.push(coastLevel ? t4 * t4 : t4);
      }
    }
    this.edgeWIndex = Int32Array.from(edgeIndex);
    this.edgeWValue = Float64Array.from(edgeValue);
    this.frontogenesisField = new Float64Array(size);
    this.tempSmooth = new Float64Array(size);

    this.wind = {
      u: this.u,
      v: this.v,
      ug: this.ug,
      vg: this.vg,
      ua: this.ua,
      va: this.va,
      up: this.up,
      vp: this.vp,
      w: this.w,
      divergence: this.divergence,
    };

    // 预置背景强迫（不占回合，随流场演化）。
    for (const preset of level.preset ?? []) {
      this.addImpulse(
        preset,
        this.pressure,
        this.temperature,
        this.humidity,
        this.forcingU,
        this.forcingV,
      );
    }
    // 固定背景锚点：不被平流，用于阻挡高压等。
    for (const fixed of level.fixed ?? []) {
      this.addImpulse(fixed, this.fixedP, this.fixedT);
    }

    // 四层热力结构：初始化在预置强迫之后，保证 850/700/500/300 层
    // 看到的是实际注入后的地面温度/水汽，而不是初始气候场。
    this.layers = new LayerThermo({
      grid: this.grid,
      sceneBaseTempC: this.scene.baseTempC,
      heightM: this.fields.height,
      tempAnomaly: this.temperature,
      qSurface: this.humidity,
      size,
    });

    // 文档 §5 的底层：两层流函数 + 位涡，气压由反演得到。
    this.qg = new TwoLayerQG(this.grid, level.scene.centerLat);
    this.qg.resetFromPressure(this.pressure);
    this.ledger.reset(this.humidity, this.cloud);

    this.frames.push(this.captureFrame());
  }

  get currentHour(): number {
    return this.hour;
  }

  get currentRound(): number {
    return this.round;
  }

  get rounds(): number {
    return this.level.rounds;
  }

  get actionsUsed(): number {
    return this.applied.length;
  }

  get allFrames(): readonly Frame[] {
    return this.frames;
  }

  get isFinished(): boolean {
    return this.round >= this.level.rounds;
  }

  currentFrame(): Frame {
    return this.frames[this.frames.length - 1];
  }

  frameAt(hour: number): Frame {
    const h = clamp(Math.round(hour), 0, this.frames.length - 1);
    return this.frames[h];
  }

  /**
   * 把当前物理场写回“当前小时”的帧。
   * 放置卡后只改场、不推进时间；若不刷新，UI 仍显示放卡前的旧帧，
   * 看起来就像点击放置没有生效。
   */
  refreshCurrentFrame(): Frame {
    const frame = this.captureFrame();
    if (this.frames.length === 0) {
      this.frames.push(frame);
    } else {
      this.frames[this.frames.length - 1] = frame;
    }
    return frame;
  }

  /** 放置约束检查（不改变状态）。 */
  canPlace(action: CardAction): PlacementRule {
    if (!this.level.available.includes(action.kind)) {
      return { ok: false, reason: '本关不开放这类要素' };
    }
    if (this.isFinished) return { ok: false, reason: '本关回合已用完' };
    if (action.hour !== this.hour) return { ok: false, reason: '只能在本回合开始时放置' };
    if (
      action.xKm < 0 ||
      action.yKm < 0 ||
      action.xKm > this.scene.domainKm ||
      action.yKm > this.scene.domainKm
    ) {
      return { ok: false, reason: '超出场景范围' };
    }
    return { ok: true };
  }

  /** 放置一张卡并注入初值（不推进时间）。 */
  place(action: CardAction): ActionReport {
    const rule = this.canPlace(action);
    if (!rule.ok) return { ok: false, reason: rule.reason };
    this.tempDiff.set(this.temperature);
    // 记录注入前的湿度，用于把温度/水汽异常同步到 850/700/500/300 层。
    this.qTmp.set(this.humidity);
    const changesMoisture =
      action.kind === 'moisture' || action.variant === 'warmLow';
    let qBefore = 0;
    if (changesMoisture) {
      for (let k = 0; k < this.humidity.length; k += 1) qBefore += this.humidity[k];
    }
    this.addImpulse(
      action,
      this.pressure,
      this.temperature,
      this.humidity,
      this.forcingU,
      this.forcingV,
    );
    this.applied.push(action);
    this.actionsThisRound += 1;
    // 把地面注入异常按层结权重同步到四层温湿场；温度卡也会改变 850 hPa
    // 温度，从而直接影响后续相态判别，而不是只改 2 m 温度。
    for (let k = 0; k < this.temperature.length; k += 1) {
      this.tTmp[k] = this.temperature[k] - this.tempDiff[k];
      this.qTmp[k] = this.humidity[k] - this.qTmp[k];
    }
    this.layers.syncFromSurface(this.tTmp, this.qTmp);
    // 放置的卡进入流函数初值，下一回合从新的位涡场开始演化。
    this.qg.resetFromPressure(this.pressure);
    if (action.kind === 'temperature') {
      for (let k = 0; k < this.temperature.length; k += 1) {
        this.tempDiff[k] = this.temperature[k] - this.tempDiff[k];
      }
      this.qg.addTemperature(this.tempDiff);
    } else if (action.kind === 'moisture') {
      let qAfter = 0;
      for (let k = 0; k < this.humidity.length; k += 1) qAfter += this.humidity[k];
      this.ledger.addMoisture(qAfter - qBefore);
    } else if (changesMoisture) {
      let qAfter = 0;
      for (let k = 0; k < this.humidity.length; k += 1) qAfter += this.humidity[k];
      this.ledger.addMoisture(qAfter - qBefore);
    }
    this.refreshCurrentFrame();
    return { ok: true };
  }

  /** 推进一个回合（3 小时），返回本回合新增的帧。 */
  advanceRound(): Frame[] {
    if (this.isFinished) return [];
    const created: Frame[] = [];
    for (let s = 0; s < STEPS_PER_HOUR * HOURS_PER_ROUND; s += 1) {
      this.step();
      this.subSteps += 1;
      if (this.subSteps % STEPS_PER_HOUR === 0) {
        this.hour += 1;
        this.frames.push(this.captureFrame());
        created.push(this.frames[this.frames.length - 1]);
      }
    }
    this.subSteps = 0;
    this.round += 1;
    this.actionsThisRound = 0;
    return created;
  }

  /** 跳过本回合（不放置卡）。 */
  skipRound(): Frame[] {
    return this.advanceRound();
  }

  runToEnd(): Frame[] {
    const created: Frame[] = [];
    while (!this.isFinished) created.push(...this.advanceRound());
    return created;
  }

  private addImpulse(
    action: CardAction,
    pTarget: Float64Array,
    tTarget: Float64Array,
    qTarget?: Float64Array,
    fuTarget?: Float64Array,
    fvTarget?: Float64Array,
  ): void {
    const sigma = this.sigmaFor(action.kind);
    const amp = TIER_VALUES[action.kind][action.tier - 1];
    const sign = variantSign(action.variant);
    const n = this.grid.n;
    const dir = ((action.directionDeg ?? 90) * Math.PI) / 180;
    const dirU = Math.sin(dir);
    const dirV = Math.cos(dir);
    const alongSigma = action.kind === 'wind' ? sigma * JET_ALONG_FACTOR : sigma;
    const acrossSigma = action.kind === 'wind' ? sigma * JET_ACROSS_FACTOR : sigma;
    const radius =
      action.kind === 'wind'
        ? alongSigma * 2.2 + acrossSigma
        : Math.max(alongSigma, acrossSigma) * 3;

    for (let j = 0; j < n; j += 1) {
      for (let i = 0; i < n; i += 1) {
        const dx = this.grid.xKm(i) - action.xKm;
        const dy = this.grid.yKm(j) - action.yKm;
        if (Math.abs(dx) > radius || Math.abs(dy) > radius) continue;
        // 沿风向旋转坐标，形成狭长的低空急流。
        const along = dx * dirU + dy * dirV;
        const across = -dx * dirV + dy * dirU;
        const shaped = Math.exp(
          -(along * along) / (2 * alongSigma * alongSigma) -
            (across * across) / (2 * acrossSigma * acrossSigma),
        );
        const k = this.grid.idx(i, j);
        if (action.kind === 'pressure') {
          pTarget[k] += sign * amp * shaped;
          // 热力性质：暖低压 / 冷低压、暖高压 / 冷高压。
          const thermal =
            action.variant === 'warmLow' || action.variant === 'warmHigh'
              ? 1
              : action.variant === 'coldLow' || action.variant === 'coldHigh'
                ? -1
                : 0;
          if (thermal !== 0) {
            tTarget[k] += thermal * action.tier * 1.6 * shaped;
          }
          // 暖低压不是“干热低压”：暖核同时携带更高的 θe / 水汽。
          // 只加温度会把饱和比湿抬高、反而把 RH 压低，和暖低压对流的
          // 教学点相反；这里补一层与强度档位成正比的水汽。
          if (action.variant === 'warmLow' && qTarget) {
            qTarget[k] += action.tier * 1.2 * shaped;
          }
        } else if (action.kind === 'temperature') {
          tTarget[k] += sign * amp * shaped;
        } else if (action.kind === 'moisture' && qTarget) {
          qTarget[k] += sign * amp * shaped;
        } else if (action.kind === 'wind' && fuTarget && fvTarget) {
          fuTarget[k] += amp * dirU * shaped;
          fvTarget[k] += amp * dirV * shaped;
        }
      }
    }
  }

  private sigmaFor(kind: CardKind): number {
    const d = this.scene.domainKm;
    // 系统半径不能跟地图一起无限放大，否则 960/1920 km 的大图上
    // 一个低压仍会铺满全图。小域按原来的 d/6 等比例，大域用固定上限。
    if (kind === 'pressure') return Math.min(d / 6, 80);
    if (kind === 'temperature') return Math.min(d / 12, 45);
    if (kind === 'moisture') return Math.min(d / 10, 60);
    if (kind === 'wind') return Math.min(d / 20, 28);
    return d / 10;
  }

  private step(): void {
    const dtH = DT_SECONDS / 3600;
    this.ledger.beginStep(this.humidity, this.cloud);
    const tod =
      (this.scene.timeOfDay + this.hour + this.subSteps / STEPS_PER_HOUR) % 24;

    // 总场 = 动态场 + 固定锚点。风与诊断读总场，平流只作用于动态场。
    for (let k = 0; k < this.pressure.length; k += 1) {
      this.pressureTotal[k] = this.pressure[k] + this.fixedP[k];
      this.tempTotal[k] = this.temperature[k] + this.fixedT[k];
    }

    computeWind(
      this.scene,
      this.fields,
      this.grid,
      this.pressureTotal,
      this.tempTotal,
      tod,
      this.forcingU,
      this.forcingV,
      this.wind,
    );
    computeLocalForcing(
      this.scene,
      this.fields,
      this.grid,
      this.temperature,
      this.u,
      this.v,
      tod,
      this.localForcing,
    );
    for (let k = 0; k < this.u.length; k += 1) {
      this.u[k] += this.localForcing.du[k];
      this.v[k] += this.localForcing.dv[k];
    }

    // 6.5 Ekman 抽吸 + 6.10 急流入口/出口强迫 + 6.8 冷池前沿抬升。
    ekmanSuction(this.u, this.v, this.fields.roughness, this.grid, this.scene.centerLat, this.wEkman);
    upperJetForcing(this.forcingU, this.forcingV, this.grid, this.scene.centerLat, this.wUpper);
    this.coldPoolMax = 0;
    const n = this.grid.n;
    const coldTmp = { coolingKPerH: 0, buoyancy: 0, gustSpeed: 0, liftCmS: 0 };
    for (let k = 0; k < this.w.length; k += 1) {
      const cold = coldPoolStep(this.precipRate[k], this.temperature[k], dtH, coldTmp);
      this.wCold[k] = cold.liftCmS;
      this.coldPoolMax = Math.max(this.coldPoolMax, cold.gustSpeed);
      this.w[k] = clamp(
        this.w[k] +
          0.12 * (this.wEkman[k] + this.wUpper[k] + this.wCold[k]) +
          this.localForcing.w[k],
        -90,
        220,
      );
    }

    // 边界缓冲因子在构造时已按关卡地形算好，这里只遍历边界格。
    for (let m = 0; m < this.edgeWIndex.length; m += 1) {
      this.w[this.edgeWIndex[m]] *= this.edgeWValue[m];
    }
    const coastLevel = this.edgeWFactorCells === 20;

    // 海岸/海岸山脉关卡海陆风与地形强迫更强，近边 w 脊更窄更高；
    // 其它关卡不需要额外的边界去棘刺。
    // 边界 Dirichlet 反演会在近边留下格点尺度正负交替的 w（棋盘噪声）。
    // 用“邻域均值去棘刺”只替换偏离邻域均值过大的格点，成本远低于排序
    // 中值滤波，也不会把边界噪声扩成新的极值。
    if (coastLevel) {
      this.wSmooth.set(this.w);
      for (let j = 0; j < n; j += 1) {
        for (let i = 0; i < n; i += 1) {
          const dEdge = Math.min(i, j, n - 1 - i, n - 1 - j);
          if (dEdge >= 22) continue;
          const k = j * n + i;
          let sum = 0;
          let count = 0;
          for (let dj = -1; dj <= 1; dj += 1) {
            for (let di = -1; di <= 1; di += 1) {
              if (di === 0 && dj === 0) continue;
              const ii = Math.min(n - 1, Math.max(0, i + di));
              const jj = Math.min(n - 1, Math.max(0, j + dj));
              sum += this.wSmooth[jj * n + ii];
              count += 1;
            }
          }
          const avg = sum / count;
          if (Math.abs(this.w[k] - avg) > 6) this.w[k] = avg;
        }
      }
    }

    // 气压是慢流形：在两层 QG 底层上平流位涡，再反演两层流函数/气压。
    advectTwoLayerPV(this.qg, DT_SECONDS, this.ua, this.va);
    if ((this.subSteps + 1) % QG_INVERT_EVERY === 0) {
      qVectorFrontogenesisField(this.tempTotal, this.u, this.v, this.grid, this.frontogenesisField);
      const n = this.grid.n;
      for (let j = 0; j < n; j += 1) {
        for (let i = 0; i < n; i += 1) {
          let sum = 0;
          let count = 0;
          for (let dj = -1; dj <= 1; dj += 1) {
            for (let di = -1; di <= 1; di += 1) {
              const jj = j + dj;
              const ii = i + di;
              if (ii < 0 || ii >= n || jj < 0 || jj >= n) continue;
              sum += this.temperature[jj * n + ii];
              count += 1;
            }
          }
          this.tempSmooth[j * n + i] = sum / Math.max(count, 1);
        }
      }
      if (!this.qg.isBarotropic()) {
        // 6.1 温度场持续向斜压模松弛（仅斜压态启用，避免正压关卡退化）。
        this.qg.nudgeBaroclinicity(
          this.tempTotal,
          400,
          (DT_SECONDS * QG_INVERT_EVERY) / 3600 / 6,
        );
      }
      invertTwoLayer(this.qg, DT_SECONDS * QG_INVERT_EVERY, TAU_PRESSURE_H);
      this.qg.pressureInto(this.pressure);
    }
    advect(this.temperature, this.u, this.v, DT_SECONDS, this.grid, this.tTmp);
    let qBeforeAdvect = 0;
    for (let k = 0; k < this.humidity.length; k += 1) qBeforeAdvect += this.humidity[k];
    advect(this.humidity, this.u, this.v, DT_SECONDS, this.grid, this.qTmp);
    let qAfterAdvect = 0;
    for (let k = 0; k < this.qTmp.length; k += 1) qAfterAdvect += this.qTmp[k];
    this.ledger.addBoundary(qAfterAdvect - qBeforeAdvect);
    const swapT = this.temperature;
    this.temperature = this.tTmp;
    this.tTmp = swapT;
    const swapQ = this.humidity;
    this.humidity = this.qTmp;
    this.qTmp = swapQ;

    const windDecay = Math.exp(-dtH / TAU_WIND_H);
    const tempDecay = Math.exp(-dtH / TAU_TEMP_H);

    for (let j = 0; j < n; j += 1) {
      for (let i = 0; i < n; i += 1) {
        const k = this.grid.idx(i, j);
        const isLand = this.fields.land[k] > 0.5;
        const urban = this.fields.urban[k];
        const speed = Math.hypot(this.u[k], this.v[k]);
        // M2 局地模块的温湿倾向。
        this.temperature[k] += this.localForcing.dTemp[k] * dtH;
        const localQ = this.localForcing.dQ[k] * dtH;
        if (localQ !== 0) {
          this.humidity[k] = Math.max(0, this.humidity[k] + localQ);
          if (localQ > 0) this.ledger.addEvaporation(localQ);
          else this.ledger.addBoundary(localQ);
        }
        const tempAbs = this.scene.baseTempC + this.temperature[k];
        const qBefore = this.humidity[k];

        // 6.7 锋生：把 Q 矢量锋生率折算成局地温度梯度锐化。
        // 只在锋生区放大“格点相对 3×3 平滑场”的异常，不额外制造暖/冷中心。
        const frontogenesis = this.frontogenesisField[k];
        if (frontogenesis > 0) {
          this.temperature[k] +=
            0.4 * frontogenesis * dtH * (this.temperature[k] - this.tempSmooth[k]);
        }

        if (isLand) {
          // 6.12 辐射日变化（陆地）：保留短波/长波量级，但用可玩的
          // 日变化曲线标定，避免把 3 小时回合烘得过热。
          const solar = Math.max(0, Math.sin(((tod - 6) / 12) * Math.PI));
          const heating = solar * (0.6 + 1.1 * urban) - 0.1 - 0.28 * urban * (1 - solar);
          const rad = radiationHeating(
            this.scene.baseTempC + this.temperature[k],
            clamp(this.cloud[k] / CLOUD_SCALE, 0, 1),
            tod,
            true,
            urban,
            this.scene.centerLat,
          );
          // 90% 可玩日变化曲线 + 10% 物理辐射收支。
          this.temperature[k] += (0.9 * heating + 0.1 * rad) * dtH;
          const qs = saturationMixingRatio(this.scene.baseTempC + this.temperature[k]);
          // 蒸散把陆地补向 68% RH，而不是一路补到饱和；干土/坡地更慢。
          const target = Math.min(LAND_TARGET_RH * qs, this.humidityCap);
          if (this.humidity[k] < target) {
            this.humidity[k] += 0.038 * clamp(this.scene.soil, 0.05, 1) * (target - this.humidity[k]) * dtH;
          }
        } else {
          // 海面：SST 锚定温度，6.4 蒸发随风速与饱和水汽压差增长。
          this.temperature[k] += (0 - this.temperature[k]) * Math.min(1, dtH / 1.5);
          const flux = surfaceFlux(
            speed,
            tempAbs,
            this.humidity[k],
            this.fields.sst[k],
            false,
            0,
            dtH,
          );
          this.humidity[k] += flux.evaporation;
          this.temperature[k] += flux.sensibleHeating * dtH;
        }

        const fluxDelta = this.humidity[k] - qBefore;
        if (fluxDelta > 0) this.ledger.addEvaporation(fluxDelta);
        else if (fluxDelta < 0) this.ledger.addBoundary(fluxDelta);

        // 向气候背景湿度缓慢回归：背景不是全场一个 8 g/kg，而是
        // 由初始温—湿场（海温、海拔、土壤）决定的空间分布。
        const bgBefore = this.humidity[k];
        this.humidity[k] += (this.humidityBg[k] - this.humidity[k]) * (dtH / 48);
        const bgDelta = this.humidity[k] - bgBefore;
        if (bgDelta > 0) this.ledger.addEvaporation(bgDelta);
        else if (bgDelta < 0) this.ledger.addBoundary(bgDelta);

        // 边界数值海绵只由 computeWind 的 w 缓入层处理。
        // 抬升凝结：先算环境 RH，再叠加“抬升导致的绝热冷却”RH 增量。
        // 薄云且 RH 不够时只加云、不产生降水，避免小雨铺满全图。
        const wPos = Math.max(this.w[k], 0);
        const qsNow = saturationMixingRatio(tempAbs);
        const rhNow = qsNow > 1e-6 ? this.humidity[k] / qsNow : 0;
        const liftRh = rhNow + LIFT_RH_GAIN * clamp(wPos / 28, 0, 1);
        const saturationFactor = smoothstep(COND_RH_ONSET, COND_RH_FULL, liftRh);
        const liftFactor = smoothstep(0.8, 10, wPos);
        const condensed = Math.min(
          this.humidity[k] * 0.9,
          0.0032 * wPos * this.humidity[k] * dtH * saturationFactor * liftFactor,
        );
        this.humidity[k] -= condensed;
        this.cloud[k] += condensed;

        // 6.3 凝结潜热：L_v·C/(ρ c_p)，这里 C 已折成每 kg 空气的凝结量。
        // QG 格点对“凝结→升温→更强上升”的正反馈非常敏感，用极小有效
        // 云水率折算；全量潜热会把 L5 雨区吹大、并让 L10 暖冷比失守。
        this.temperature[k] += LATENT_EFFECTIVE_FRACTION * latentHeatingK(condensed);

        // 过饱和 / 蒸发。
        const qsAbs = saturationMixingRatio(this.scene.baseTempC + this.temperature[k]);
        if (this.humidity[k] > qsAbs) {
          const excess = this.humidity[k] - qsAbs;
          this.humidity[k] = qsAbs;
          this.cloud[k] += excess;
        } else if (this.cloud[k] > 0) {
          // 云水蒸发缓慢： otherwise 未饱和空气会瞬间清空云。
          const evap = Math.min(this.cloud[k], (qsAbs - this.humidity[k]) * 0.02 * dtH);
          this.cloud[k] -= evap;
          this.humidity[k] += evap;
        }

        // 降水：云水先要积累到自动转化阈值；超过阈值的部分才下落。
        // 暖核效率更高，冷核以层云为主、降水效率低。
        // 暖核降水效率高、冷核以层云为主。注意效率只按“冷/暖核”
        // 分档，不再随温度异常连续变小：否则同是冷低，强档反而因为
        // 冷核更冷而比弱档少雨，破坏 L6 的三档单调性。
        const warmCore = this.temperature[k] > 0.5;
        const efficiency = warmCore
          ? clamp(0.9 + 0.35 * this.temperature[k], 0.9, 2.2)
          : 0.28;
        const convertible = Math.max(0, this.cloud[k] - CLOUD_AUTOCONVERT);
        const fall = Math.min(convertible, convertible * CLOUD_FALL_RATE * dtH);
        this.cloud[k] -= fall;
        const rate = (fall / dtH) * K_PRECIP * efficiency;
        const amount = fall * K_PRECIP * efficiency;
        this.precipRate[k] = rate;
        this.precipAcc[k] += amount;

        // 相态分配：总降水率不变，按地面温度 / 850 hPa 估计温度 /
        // 上升强度 / CAPE 拆成互斥的雨、雨夹雪、雪、冻雨、冰雹。
        // 分相比例之和严格为 1，保证水汽账本与总累计不重复计量。
        // 绝大多数格点不降水，先判 rate 再算 CAPE/平流，避免无谓的
        // 饱和水汽压 exp、梯度计算与对象分配（性能热点）。
        let rainFrac = 0;
        let sleetFrac = 0;
        let snowFrac = 0;
        let freezingRainFrac = 0;
        let hailFrac = 0;
        if (rate > 1e-4) {
          const localAdvection =
            -(
              this.u[k] * this.grid.dfdx(this.temperature, i, j) +
              this.v[k] * this.grid.dfdy(this.temperature, i, j)
            ) * 3600;
          const phase = partitionPrecipitation({
            tempC: tempAbs,
            qGkg: this.humidity[k],
            wCmS: this.w[k],
            capeJkg: capeProxy(tempAbs, this.humidity[k], 0),
            precipRate: rate,
            t850C: this.layers.t850[k],
            warmAdvectionKPerH: localAdvection,
          });
          rainFrac = phase.rain;
          sleetFrac = phase.sleet;
          snowFrac = phase.snow;
          freezingRainFrac = phase.freezingRain;
          hailFrac = phase.hail;
        }
        this.rainRate[k] = rate * rainFrac;
        this.sleetRate[k] = rate * sleetFrac;
        this.snowRate[k] = rate * snowFrac;
        this.freezingRainRate[k] = rate * freezingRainFrac;
        this.hailRate[k] = rate * hailFrac;
        this.rainAcc[k] += amount * rainFrac;
        this.sleetAcc[k] += amount * sleetFrac;
        this.snowAcc[k] += amount * snowFrac;
        this.freezingRainAcc[k] += amount * freezingRainFrac;
        this.hailAcc[k] += amount * hailFrac;
        this.temperature[k] -= 0.1 * rate * dtH;
        this.ledger.addRain(fall);

        // 6.8 冷池：降水蒸发冷却，负浮力驱动阵风锋。
        const cold = coldPoolStep(rate, this.scene.baseTempC + this.temperature[k], dtH, coldTmp);
        this.temperature[k] -= 0.35 * cold.coolingKPerH * dtH;
        this.coldPoolMax = Math.max(this.coldPoolMax, cold.gustSpeed);

        this.temperature[k] *= tempDecay;
        this.forcingU[k] *= windDecay;
        this.forcingV[k] *= windDecay;

        const beforeWater = this.humidity[k] + this.cloud[k];
        this.humidity[k] = clamp(this.humidity[k], 0, 45);
        this.cloud[k] = clamp(this.cloud[k], 0, 12);
        // 数值上限截断会移除水汽/云水；记入账本的边界/截断项。
        const afterWater = this.humidity[k] + this.cloud[k];
        this.ledger.addClamp(afterWater - beforeWater);
        // 2 m 温度异常上限 +8 K：焚风、辐射与城市热岛可以叠加，
        // 但不允许把夏季低地推到 47℃这种非物理读数。
        this.temperature[k] = clamp(this.temperature[k], -30, 8);
        this.pressure[k] = clamp(this.pressure[k], -45, 45);
      }
    }

    // 四层热力场每 10 分钟推进一次：平流 + 弱层结松弛 + 单柱绝热调整。
    // 10 分钟而不是每分钟，避免 4 层 × 1.6 万格的平流成为新热点；
    // 对 3 小时回合，层温/层湿的时间分辨率仍足够判相态与 PW。
    if (this.subSteps % 10 === 0) {
      this.layers.step(
        this.u,
        this.v,
        this.w,
        DT_SECONDS * 10,
        this.scene.baseTempC,
        this.temperature,
        this.humidity,
      );
    }

    // 开放边界：最外 2 格接背景湿度和无云，避免钳制把水汽/云水堆在
    // 边界上形成整圈直线云雨。只处理边界两圈，内区云雨保留。
    for (let j = 0; j < n; j += 1) {
      for (let i = 0; i < n; i += 1) {
        if (i >= 2 && j >= 2 && i < n - 2 && j < n - 2) continue;
        const k = j * n + i;
        const qOld = this.humidity[k];
        const cOld = this.cloud[k];
        // 开放边界：入流空气按“当前边界温度 + 72% RH”给定水汽，
        // 不能直接塞回初始 q——否则边界一降温就会过饱和，整条边生云下雨。
        const qsEdge = saturationMixingRatio(this.scene.baseTempC + this.temperature[k]);
        const edgeRh = this.fields.land[k] > 0.5 ? 0.68 : 0.74;
        const qEdge = Math.min(this.humidityBg[k], edgeRh * qsEdge);
        this.humidity[k] = qEdge;
        this.cloud[k] = 0;
        this.precipRate[k] = 0;
        this.rainRate[k] = 0;
        this.sleetRate[k] = 0;
        this.snowRate[k] = 0;
        this.freezingRainRate[k] = 0;
        this.hailRate[k] = 0;
        this.ledger.addBoundary(qEdge - qOld - cOld);
      }
    }
    this.ledger.endStep(this.humidity, this.cloud);
  }

  private captureFrame(): Frame {
    for (let k = 0; k < this.pressure.length; k += 1) {
      this.pressureTotal[k] = this.pressure[k] + this.fixedP[k];
      this.tempTotal[k] = this.temperature[k] + this.fixedT[k];
      this.pwMm[k] = this.layers.precipitableWaterMm(k, this.humidity[k]);
    }
    const sites: Record<string, CitySample> = {};
    for (const site of this.scene.sites) {
      const p = this.grid.sample(this.pressureTotal, site.xKm, site.yKm);
      const tempAnom = this.grid.sample(this.tempTotal, site.xKm, site.yKm);
      const q = this.grid.sample(this.humidity, site.xKm, site.yKm);
      const qc = this.grid.sample(this.cloud, site.xKm, site.yKm);
      const rain = this.grid.sample(this.precipRate, site.xKm, site.yKm);
      const acc = this.grid.sample(this.precipAcc, site.xKm, site.yKm);
      const rainRateSample = this.grid.sample(this.rainRate, site.xKm, site.yKm);
      const sleetRateSample = this.grid.sample(this.sleetRate, site.xKm, site.yKm);
      const snowRateSample = this.grid.sample(this.snowRate, site.xKm, site.yKm);
      const freezingRainSample = this.grid.sample(
        this.freezingRainRate,
        site.xKm,
        site.yKm,
      );
      const hailRateSample = this.grid.sample(this.hailRate, site.xKm, site.yKm);
      const snowAccSample = this.grid.sample(this.snowAcc, site.xKm, site.yKm);
      const hailAccSample = this.grid.sample(this.hailAcc, site.xKm, site.yKm);
      const pwSample = this.grid.sample(this.pwMm, site.xKm, site.yKm);
      const t850Sample = this.grid.sample(this.layers.t850, site.xKm, site.yKm);
      const t500Sample = this.grid.sample(this.layers.t500, site.xKm, site.yKm);
      const u = this.grid.sample(this.u, site.xKm, site.yKm);
      const v = this.grid.sample(this.v, site.xKm, site.yKm);
      const ug = this.grid.sample(this.ug, site.xKm, site.yKm);
      const vg = this.grid.sample(this.vg, site.xKm, site.yKm);
      const w = this.grid.sample(this.w, site.xKm, site.yKm);
      const div = this.grid.sample(this.divergence, site.xKm, site.yKm);
      const t2m = this.scene.baseTempC + tempAnom;
      const rh = relativeHumidity(q, t2m);
      const windSpeed = Math.hypot(u, v);
      const sitePhase = dominantPhase({
        rain: rainRateSample,
        sleet: sleetRateSample,
        snow: snowRateSample,
        freezingRain: freezingRainSample,
        hail: hailRateSample,
      });
      // 风寒/湿热体感只用于显示；冷平流则给出风把冷/暖空气搬运到站点的速率。
      const n = this.grid.n;
      const ix = Math.min(n - 1, Math.max(0, Math.floor(site.xKm / this.grid.dxKm)));
      const iy = Math.min(n - 1, Math.max(0, Math.floor(site.yKm / this.grid.dxKm)));
      const tempAdvectionKPerH =
        -(
          u * this.grid.dfdx(this.tempTotal, ix, iy) +
          v * this.grid.dfdy(this.tempTotal, ix, iy)
        ) * 3600;
      sites[site.id] = {
        id: site.id,
        name: site.name,
        xKm: site.xKm,
        yKm: site.yKm,
        marine: !!site.marine,
        p,
        t2m,
        apparentC: apparentTemperatureC(t2m, rh, windSpeed),
        tempAdvectionKPerH,
        q,
        rh,
        cc: clamp(qc / CLOUD_SCALE, 0, 1),
        precipRate: rain,
        precipAcc: acc,
        phase: sitePhase,
        rainRate: rainRateSample,
        sleetRate: sleetRateSample,
        snowRate: snowRateSample,
        freezingRainRate: freezingRainSample,
        hailRate: hailRateSample,
        snowAcc: snowAccSample,
        hailAcc: hailAccSample,
        pwMm: pwSample,
        t850: t850Sample,
        t500: t500Sample,
        wind10: windSpeed,
        windDir: windDirectionDeg(u, v) % 360,
        w,
        divergence: div,
        crossAngle: crossIsobarAngle(u, v, ug, vg),
      };
    }

    const centers = detectCenters(this.pressureTotal, this.grid);
    const stats = this.buildStats();
    const frame: Frame = {
      hour: this.hour,
      round: this.round,
      timeOfDay: (this.scene.timeOfDay + this.hour) % 24,
      pressure: new Float32Array(this.pressureTotal),
      temp: new Float32Array(this.tempTotal),
      humidity: new Float32Array(this.humidity),
      cloud: new Float32Array(this.cloud),
      precipRate: new Float32Array(this.precipRate),
      precipAcc: new Float32Array(this.precipAcc),
      rainRate: new Float32Array(this.rainRate),
      sleetRate: new Float32Array(this.sleetRate),
      snowRate: new Float32Array(this.snowRate),
      freezingRainRate: new Float32Array(this.freezingRainRate),
      hailRate: new Float32Array(this.hailRate),
      rainAcc: new Float32Array(this.rainAcc),
      sleetAcc: new Float32Array(this.sleetAcc),
      snowAcc: new Float32Array(this.snowAcc),
      freezingRainAcc: new Float32Array(this.freezingRainAcc),
      hailAcc: new Float32Array(this.hailAcc),
      pwMm: new Float32Array(this.pwMm),
      layerT850: new Float32Array(this.layers.t850),
      layerT700: new Float32Array(this.layers.t700),
      layerT500: new Float32Array(this.layers.t500),
      layerT300: new Float32Array(this.layers.t300),
      layerQ850: new Float32Array(this.layers.q850),
      layerQ700: new Float32Array(this.layers.q700),
      layerQ500: new Float32Array(this.layers.q500),
      layerQ300: new Float32Array(this.layers.q300),
      u: new Float32Array(this.u),
      v: new Float32Array(this.v),
      w: new Float32Array(this.w),
      sites,
      centers,
      stats,
      recipes: [],
    };
    frame.recipes = detectRecipes(
      this.scene,
      frame,
      this.frames,
      this.fields,
      this.applied,
    );
    return frame;
  }

  private buildStats(): FrameStats {
    const n = this.grid.n;
    let minP = Infinity;
    let maxP = -Infinity;
    let maxW = -Infinity;
    let maxCloud = 0;
    let maxRain = 0;
    let maxAcc = 0;
    let maxRainRate = 0;
    let maxSleetRate = 0;
    let maxSnowRate = 0;
    let maxFreezingRainRate = 0;
    let maxHailRate = 0;
    let maxSnowAcc = 0;
    let maxHailAcc = 0;
    let maxWind = 0;
    let minTemp = Infinity;
    let maxTemp = -Infinity;
    let qSum = 0;
    let omegaSum = 0;
    let capeSum = 0;
    let pwSum = 0;
    let maxPw = 0;
    let t850Sum = 0;
    let t700Sum = 0;
    let t500Sum = 0;
    let t300Sum = 0;
    let minT850 = Infinity;
    let maxT850 = -Infinity;
    let minT500 = Infinity;
    let maxT500 = -Infinity;
    const phaseSum = { rain: 0, sleet: 0, snow: 0, freezingRain: 0, hail: 0 };

    for (let k = 0; k < this.pressureTotal.length; k += 1) {
      minP = Math.min(minP, this.pressureTotal[k]);
      maxP = Math.max(maxP, this.pressureTotal[k]);
      maxW = Math.max(maxW, this.w[k]);
      maxCloud = Math.max(maxCloud, clamp(this.cloud[k] / CLOUD_SCALE, 0, 1));
      maxRain = Math.max(maxRain, this.precipRate[k]);
      maxAcc = Math.max(maxAcc, this.precipAcc[k]);
      maxRainRate = Math.max(maxRainRate, this.rainRate[k]);
      maxSleetRate = Math.max(maxSleetRate, this.sleetRate[k]);
      maxSnowRate = Math.max(maxSnowRate, this.snowRate[k]);
      maxFreezingRainRate = Math.max(maxFreezingRainRate, this.freezingRainRate[k]);
      maxHailRate = Math.max(maxHailRate, this.hailRate[k]);
      maxSnowAcc = Math.max(maxSnowAcc, this.snowAcc[k]);
      maxHailAcc = Math.max(maxHailAcc, this.hailAcc[k]);
      maxWind = Math.max(maxWind, Math.hypot(this.u[k], this.v[k]));
      minTemp = Math.min(minTemp, this.scene.baseTempC + this.tempTotal[k]);
      maxTemp = Math.max(maxTemp, this.scene.baseTempC + this.tempTotal[k]);
      qSum += this.humidity[k];
      omegaSum += omegaFromW(this.w[k]);
      capeSum += capeProxy(this.tempTotal[k], this.humidity[k], 0);
      pwSum += this.pwMm[k];
      maxPw = Math.max(maxPw, this.pwMm[k]);
      t850Sum += this.layers.t850[k];
      t700Sum += this.layers.t700[k];
      t500Sum += this.layers.t500[k];
      t300Sum += this.layers.t300[k];
      minT850 = Math.min(minT850, this.layers.t850[k]);
      maxT850 = Math.max(maxT850, this.layers.t850[k]);
      minT500 = Math.min(minT500, this.layers.t500[k]);
      maxT500 = Math.max(maxT500, this.layers.t500[k]);
      phaseSum.rain += this.rainRate[k];
      phaseSum.sleet += this.sleetRate[k];
      phaseSum.snow += this.snowRate[k];
      phaseSum.freezingRain += this.freezingRainRate[k];
      phaseSum.hail += this.hailRate[k];
    }

    const rain = rainArea(this.precipRate, this.grid);

    // 迎风 / 背风：按背景风方向划分。
    const bgU = this.scene.bgWindU;
    const bgV = this.scene.bgWindV;
    const bgSpeed = Math.hypot(bgU, bgV);
    let windwardSum = 0;
    let windwardCount = 0;
    let leewardSum = 0;
    let leewardCount = 0;
    if (bgSpeed > 0.2) {
      for (let j = 0; j < n; j += 1) {
        for (let i = 0; i < n; i += 1) {
          const k = this.grid.idx(i, j);
          const dot =
            (gridX(this.grid, i) - this.scene.domainKm / 2) * bgU +
            (gridY(this.grid, j) - this.scene.domainKm / 2) * bgV;
          if (dot < 0) {
            windwardSum += this.precipAcc[k];
            windwardCount += 1;
          } else {
            leewardSum += this.precipAcc[k];
            leewardCount += 1;
          }
        }
      }
    }

    return {
      minP,
      maxP,
      maxW,
      maxCloud,
      maxRain,
      maxAcc,
      maxWind,
      minTemp,
      maxTemp,
      maxRainRate,
      maxSleetRate,
      maxSnowRate,
      maxFreezingRainRate,
      maxHailRate,
      maxSnowAcc,
      maxHailAcc,
      meanPwMm: pwSum / this.pressure.length,
      maxPwMm: maxPw,
      meanT850: t850Sum / this.pressure.length,
      minT850,
      maxT850,
      meanT700: t700Sum / this.pressure.length,
      meanT500: t500Sum / this.pressure.length,
      minT500,
      maxT500,
      meanT300: t300Sum / this.pressure.length,
      dominantPhase: dominantPhase(phaseSum),
      meanQ: qSum / this.pressure.length,
      windwardRain: windwardCount > 0 ? windwardSum / windwardCount : 0,
      leewardRain: leewardCount > 0 ? leewardSum / leewardCount : 0,
      rainRadiusKm: rain.radiusKm,
      rainCentroidXKm: rain.centroidXKm,
      rainCentroidYKm: rain.centroidYKm,
      waterStart: this.ledger.start,
      waterEvaporated: this.ledger.evaporated,
      waterRained: this.ledger.rained,
      waterEnd: this.ledger.end,
      waterClosure: this.ledger.closure(),
      waterBoundary: this.ledger.boundary,
      waterUnaccounted: this.ledger.unaccounted,
      omegaMean: omegaSum / this.pressure.length,
      capeMean: capeSum / this.pressure.length,
      frontogenesisMax: qVectorFrontogenesis(this.tempTotal, this.u, this.v, this.grid),
      coldPoolMax: this.coldPoolMax,
    };
  }
}

function gridX(grid: Grid, i: number): number {
  return grid.xKm(i);
}
function gridY(grid: Grid, j: number): number {
  return grid.yKm(j);
}
