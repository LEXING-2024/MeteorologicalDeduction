import {
  CARD_HOTKEYS,
  CARD_META,
  CARD_STRENGTHS,
  CARD_UNLOCK,
  cardStrengthTiers,
  ENTITY_META,
  ENTITY_RADIUS_MAX_KM,
  ENTITY_RADIUS_MIN_KM,
  entityStrengthTiers,
  minPressureRadiusKm,
  MAP_KM_PER_PX,
  MAP_SIZE,
} from '../config/constants';
import {
  CAMPAIGN_STAGES,
  CAMPAIGN_TOTAL,
  CAMPAIGN_UNLOCK_GATE,
  LEVELS,
  PLAYABLE_LEVELS,
  cloneLevel,
} from '../config/levels';
import {
  cardEntityType,
  cloneEntities,
  createEntity,
  entityLayerForCard,
  entityStrengthLabel,
  formatEntityStrength,
  mergeSameType,
  resizeEntity,
} from '../logic/entities';
import { compassLabelFromToward, invalidatePhysicalField, maxWindAround, windAt } from '../logic/field';
import { setActiveMap } from '../logic/geography';
import { evaporationFlux, sampleSurface, surfaceLatitudeAt } from '../logic/surface';
import { saturationVapourDensity } from '../logic/precipitation';
import { frontLabel } from '../logic/fronts';
import { evaluateConsistency } from '../logic/consistency';
import {
  MAX_ENTITY_FRACTION,
  SHAPING_MIN_STAGE,
  WARM_CORE_ROUNDS_FOR_TYPHOON,
} from '../config/constants';
import { REAL_TERRAIN, hasRealTerrain, loadRealTerrain } from '../config/realTerrain';
import { typhoonCategoryName, typhoonMaxWind } from '../logic/typhoon';
import { evaluateGoal } from '../logic/goal';
import { buildReport } from '../logic/report';
import type {
  CardType,
  EntityType,
  GoalEvaluation,
  Hemisphere,
  LevelDefinition,
  MapLayer,
  PointWeather,
  RunSimulation,
  SimulationSnapshot,
  WeatherCondition,
  WeatherEntity,
  WeatherRecord,
  WetMotion,
} from '../logic/types';
import { computeSnapshot, simulateRound } from '../logic/weather';
import type { GameScene, HoverPayload } from '../scenes/GameScene';
import { Deck } from '../ui/deck';
import { LogPanel } from '../ui/logPanel';

interface HistoryEntry {
  entities: WeatherEntity[];
  round: number;
}

interface RoundResult {
  simulation: RunSimulation;
  evaluation: GoalEvaluation;
}

const STORAGE_KEY = 'aerosphere.completed-levels.v2';
const STARS_KEY = 'aerosphere.stars.v1';
const LEVEL_TOTAL = CAMPAIGN_TOTAL;

function $(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element;
}

function $button(id: string): HTMLButtonElement {
  return $(id) as HTMLButtonElement;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function hazardText(hazard: WeatherCondition['hazard']): string {
  switch (hazard) {
    case 'hail':
      return '冰雹';
    case 'thunderstorm':
      return '雷暴';
    case 'fog':
      return '雾';
    case 'dust':
      return '沙尘';
    case 'tornado':
      return '龙卷';
    case 'freezingRain':
      return '冻雨';
    default:
      return '高影响天气';
  }
}



/** Escape values produced by goal evaluation before injecting them into a
 *  template string.  Sprint 3B renders `actual` / `target` / `detail` verbatim;
 *  some of those strings contain `<` or `>` (e.g. "W > 0.15"). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Letter code for the 8-point (45°) compass bucket of a `towardDeg` vector.
 *  Screen convention: 0° = east, +y = south.  The Chinese label always comes
 *  from `compassLabelFromToward` in field.ts, so the UI never invents a second
 *  direction vocabulary. */
function eightPointCode(towardDeg: number): string {
  const bearing = (((towardDeg + 90) % 360) + 360) % 360;
  const codes = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return codes[Math.round(bearing / 45) % 8];
}

type CausalSlotKey = 'source' | 'transport' | 'moisture' | 'lift' | 'duration';

interface CausalSlot {
  key: CausalSlotKey;
  name: string;
  state: 'ok' | 'missing' | 'na';
  label: string;
  actual: string;
  target: string;
  progress: number;
  detail: string;
  extra: number;
}

const MOISTURE_KINDS = new Set<WeatherCondition['kind']>([
  'moisture', 'rain', 'advect', 'dry', 'visibility',
]);

const LIFT_KINDS = new Set<WeatherCondition['kind']>([
  'vertical', 'highVertical', 'front', 'shear', 'dryline', 'rotation',
  'hazard', 'pressure', 'wind', 'pressureTendency', 'temperature',
  'airMass', 'clear', 'typhoon', 'windShift', 'temperatureChange',
]);

/** Number of observation rounds a target spans (0 for single-round goals). */
function targetRounds(target: LevelDefinition['target']): number {
  if ('rounds' in target) return target.rounds;
  if (target.kind === 'sequence') return target.conditions.length;
  // v4.x window targets carry a round range instead of `rounds`.  Treating
  // them as 0 used to hide the timeline on exactly the process levels that
  // need it most.
  if (target.kind === 'window') return Math.max(1, target.toRound - target.fromRound + 1);
  // hourWindow samples inside one 3-hour round; show one cell per sampled hour.
  if (target.kind === 'hourWindow') {
    return Math.max(1, Math.floor((target.toHour - target.fromHour) / 3) + 1);
  }
  return 0;
}

/**
 * UI-only grouping: map `GoalEvaluation.conditionResults` onto the three
 * causal slots (水汽 / 抬升 / 持续时间).  Pure function, deliberately kept in
 * `src/app/GameController.ts` (not `src/logic/**`).  It never authors a
 * diagnostic sentence — every displayed string is taken verbatim from the
 * evaluation or from the level target.
 */
function conditionSlots(
  evaluation: GoalEvaluation,
  level: LevelDefinition,
  entities: WeatherEntity[],
  snapshot: SimulationSnapshot | null,
): CausalSlot[] {
  const results = evaluation.conditionResults ?? [];
  const fromConditions = (
    key: CausalSlotKey,
    name: string,
    kinds: Set<WeatherCondition['kind']>,
  ): CausalSlot => {
    const matched = results.filter((item) => kinds.has(item.condition.kind));
    if (matched.length === 0) {
      return {
        key, name, state: 'na', label: name, actual: '本关不考核此项',
        target: '—', progress: 0, detail: '', extra: 0,
      };
    }
    const primary = matched.find((item) => !item.passed) ?? matched[0];
    return {
      key,
      name,
      state: primary.passed ? 'ok' : 'missing',
      label: primary.label,
      actual: primary.actual,
      target: primary.target,
      progress: clamp(primary.progress, 0, 1),
      detail: primary.detail,
      extra: matched.length - 1,
    };
  };

  const requiredRounds = targetRounds(level.target);
  const duration: CausalSlot = requiredRounds > 0
    ? {
        key: 'duration',
        name: '持续时间',
        state: evaluation.passed || evaluation.holding ? 'ok' : 'missing',
        label: '持续时间',
        actual: evaluation.actual,
        target: evaluation.target,
        progress: clamp(evaluation.progress, 0, 1),
        detail: evaluation.detail,
        extra: 0,
      }
    : {
        key: 'duration', name: '持续时间', state: 'na', label: '持续时间',
        actual: '本关不考核此项', target: '—', progress: 0, detail: '', extra: 0,
      };

  // Surface levels add the two upstream links (source -> transport) so the
  // panel shows the same four-step chain the mechanics actually use.
  const boardSlots: CausalSlot[] = [];
  if (level.base.fixedSources || level.base.surface) {
    const sources = entities.filter((entity) => entity.type === 'wet' && entity.locked);
    const primarySource = sources[0];
    const sourceSample = primarySource
      ? sampleSurface(level.base, primarySource.x, primarySource.y)
      : null;
    const sourceWind = primarySource
      ? windAt(entities, level.base, primarySource.x, primarySource.y).speed
      : 0;
    const sourceFlux = sourceSample
      ? evaporationFlux(level.base.Q, sourceSample, sourceWind, saturationVapourDensity)
      : 0;
    boardSlots.push({
      key: 'source',
      name: '水汽源',
      state: sources.length > 0 ? 'ok' : 'missing',
      label: sources.length > 0 ? `${sources.length} 个地表源区` : '未找到地表源区',
      actual: sources.length > 0 ? sources.map((item) => item.note || '源区').join('、') : '无',
      target: '至少需要 1 个源区',
      progress: sources.length > 0 ? 1 : 0,
      detail: sourceSample
        ? `${sourceSample.land ? '湿地' : '海面'} ${sourceSample.sst.toFixed(1)}°C · 风速 ${sourceWind.toFixed(1)} m/s → 蒸发补给 ${sourceFlux.toFixed(2)} g/m³·回合`
        : '地表蒸发供水',
      extra: 0,
    });
    const city = level.cities[0];
    const speed = city ? (snapshot?.cities[city.id]?.wind.speed ?? 0) : 0;
    boardSlots.push({
      key: 'transport',
      name: '输送',
      state: speed >= 0.2 ? 'ok' : 'na',
      label: speed >= 0.2 ? `${speed.toFixed(1)} m/s 的近地面风` : '近地面风微弱',
      actual: `${speed.toFixed(1)} m/s`,
      target: '随风输送至下游',
      progress: Math.min(1, speed / 5),
      detail: '水汽沿低层风平流，决定雨带落区',
      extra: 0,
    });
  }

  return [
    ...boardSlots,
    fromConditions('moisture', '水汽', MOISTURE_KINDS),
    fromConditions('lift', '抬升', LIFT_KINDS),
    duration,
  ];
}

function shortConditionLabel(condition: WeatherCondition, level: LevelDefinition): string {
  const city = level.cities.find((item) => item.id === condition.cityId)?.name ?? condition.cityId;  switch (condition.kind) {
    case 'rain': {
      if (condition.min24h !== undefined) {
        if (condition.min24h >= 50) return `${city} 暴雨`;
        if (condition.min24h >= 25) return `${city} 大雨`;
        if (condition.min24h >= 10) return `${city} 中雨`;
        return `${city} 小雨`;
      }
      if (condition.max24h !== undefined) return `${city} 小雨`;
      return `${city} 降雨`;
    }
    case 'clear':
      return `${city} 晴`;
    case 'dry':
      return `${city} 无降水`;
    case 'front':
      return `${city} ${frontLabel(condition.frontType ?? 'stationary')}`;
    case 'pressure':
      if (condition.minP === undefined && condition.maxP !== undefined) {
        return `${city} P ≤ ${condition.maxP.toFixed(0)} hPa`;
      }
      return `${city} P ≥ ${(condition.minP ?? 0).toFixed(0)} hPa`;
    case 'temperature':
      return condition.minT !== undefined
        ? `${city} T > ${condition.minT.toFixed(0)}°C`
        : `${city} T < ${(condition.maxT ?? 0).toFixed(0)}°C`;
    case 'vertical':
      return `${city} 综合 W > ${(condition.minW ?? 0).toFixed(2)}`;
    case 'highVertical':
      return condition.maxW !== undefined
        ? `${city} 高层 W ≤ ${condition.maxW.toFixed(2)}`
        : `${city} 高层 W > ${(condition.minW ?? 0).toFixed(2)}`;
    case 'rotation':
      return `${city} 旋转 ≥ ${(condition.minVorticity ?? 0).toFixed(0)}`;
    case 'typhoon':
      return condition.maxDistanceKm !== undefined
        ? `台风距 ${city} ≤ ${condition.maxDistanceKm.toFixed(0)} km`
        : `台风强度 ≥ ${typhoonCategoryName(condition.minCategory ?? 0)}级`;
    case 'hazard':
      return `${city} ${hazardText(condition.hazard)}`;
    case 'airMass':
      return `${city} ${condition.airMass ?? 'neutral'} 气团`;
    case 'wind':
      return `${city} 来自${condition.fromDirs?.join('/') ?? ''}风`;
    case 'shear':
      return `${city} 切变 ≥ ${(condition.minShear ?? 0).toFixed(0)}°`;
    case 'dryline':
      return `${city} 干线 ≥ ${(condition.minDryline ?? 0).toFixed(2)}`;
    case 'moisture':
      return `${city} Q ≥ ${(condition.minQ ?? 0).toFixed(0)} g/m³`;
    case 'advect':
      return `水汽进入 ${city}`;
    case 'pressureTendency':
      return `${city} ΔP ≥ ${(condition.minDeltaP ?? 0).toFixed(1)} hPa`;
    case 'temperatureChange':
      return `${city} ΔT ≤ ${(condition.maxDeltaT ?? 0).toFixed(1)}℃`;
    case 'windShift':
      return `${city} 风向变化 ≥ ${(condition.minWindShift ?? 0).toFixed(0)}°`;
    case 'visibility':
      return `${city} 能见度 ≤ ${(condition.maxVisibility ?? 0).toFixed(1)} km`;
    case 'stability':
      return condition.maxStability !== undefined && condition.minStability === undefined
        ? `${city} 层结稳定`
        : `${city} 层结不稳定`;
  }
}

function formatGoalTarget(level: LevelDefinition): string {
  const target = level.target;
  if (target.kind === 'persistentRain') {
    const cities = [
      ...new Set(target.conditions.map((condition) => condition.cityId)),
    ].map((id) => level.cities.find((city) => city.id === id)?.name ?? id);
    const front = target.conditions.find((condition) => condition.kind === 'front');
    const frontName = frontLabel(front?.frontType ?? 'stationary');
    return `${cities.join('/')} ${frontName}小雨 · 连续 ${target.rounds} 回合`;
  }
  if (target.kind === 'accumulatedRain') {
    const city = level.cities.find((item) => item.id === target.conditions[0]?.cityId)?.name ?? 'A 城';
    return `${city}静止锋 · 连续 ${target.rounds} 回合 · 累计 ≥ ${target.min24h.toFixed(0)} mm（24 小时等效）`;
  }
  if (target.kind === 'sequence') {
    return target.conditions.map((condition) => shortConditionLabel(condition, level)).join(' → ');
  }
  if (target.kind === 'multi' || target.kind === 'persistent') {
    const byCity = new Map<string, WeatherCondition[]>();
    for (const condition of target.conditions) {
      const list = byCity.get(condition.cityId) ?? [];
      list.push(condition);
      byCity.set(condition.cityId, list);
    }
    return [...byCity.entries()]
      .map(([cityId, conditions]) => {
        const city = level.cities.find((item) => item.id === cityId)?.name ?? cityId;
        const rain = conditions.find((condition) => condition.kind === 'rain');
        const front = conditions.find((condition) => condition.kind === 'front');
        const clear = conditions.some((condition) => condition.kind === 'clear');
        if (clear) {
          const extras = conditions
            .filter((condition) => condition.kind !== 'clear')
            .map((condition) => shortConditionLabel(condition, level).replace(`${city} `, ''));
          return `${city} 晴${extras.length > 0 ? ` · ${extras.join(' + ')}` : ''}`;
        }
        if (rain && front) {
          const intensity = (rain.min24h ?? 0) >= 50 ? '暴雨' : (rain.max24h ?? 0) <= 25 ? '小雨' : '降雨';
          const frontName = frontLabel(front.frontType ?? 'stationary');
          return `${city} ${frontName}${intensity}`;
        }
        return `${city} ${conditions
          .map((condition) => shortConditionLabel(condition, level).replace(`${city} `, ''))
          .join(' + ')}`;
      })
      .join(' · ');
  }
  if (target.kind === 'window') {
    const city = primaryTargetCity(level);
    const cityName = level.cities.find((item) => item.id === city)?.name ?? city;
    return `${cityName} 第 ${target.fromRound}–${target.toRound} 回合${target.mode === 'all' ? '均' : '任一回合'}满足条件`;
  }
  if (target.kind === 'hourWindow') {
    const city = level.cities.find((item) => item.id === target.cityId)?.name ?? target.cityId;
    return `${city} 第 ${target.fromHour}–${target.toHour} 小时满足条件`;
  }
  switch (target.kind) {
    case 'vertical':
      return `${level.cities.find((city) => city.id === target.cityId)?.name ?? ''} 综合 W > ${(target.minW ?? 0).toFixed(2)}`;
    case 'highVertical':
      return `${level.cities.find((city) => city.id === target.cityId)?.name ?? ''} ${
        target.maxW !== undefined
          ? `高层 W ≤ ${target.maxW.toFixed(2)}`
          : `高层 W > ${(target.minW ?? 0).toFixed(2)}`
      }`;
    case 'hazard':
      return `${level.cities.find((city) => city.id === target.cityId)?.name ?? ''} ${hazardText(target.hazard)}`;
    case 'airMass':
      return `${level.cities.find((city) => city.id === target.cityId)?.name ?? ''} ${target.airMass ?? 'neutral'} 气团`;
    case 'wind':
      return `${level.cities.find((city) => city.id === target.cityId)?.name ?? ''} 来自${target.fromDirs?.join('/') ?? ''}风 ≥ ${(target.minSpeed ?? 0).toFixed(1)} m/s`;
    case 'shear':
      return `${level.cities.find((city) => city.id === target.cityId)?.name ?? ''} 切变 ≥ ${(target.minShear ?? 0).toFixed(0)}°`;
    case 'dryline':
      return `${level.cities.find((city) => city.id === target.cityId)?.name ?? ''} 干线 ≥ ${(target.minDryline ?? 0).toFixed(2)}`;
    case 'rotation':
      return `${level.cities.find((city) => city.id === target.cityId)?.name ?? ''} 旋转强度 ≥ ${(target.minVorticity ?? 0).toFixed(0)} ×10⁻⁴ s⁻¹`;
    case 'stability':
      return target.maxStability !== undefined && target.minStability === undefined
        ? `${level.cities.find((city) => city.id === target.cityId)?.name ?? ''} 层结稳定`
        : `${level.cities.find((city) => city.id === target.cityId)?.name ?? ''} 层结不稳定`;
    case 'typhoon': {
      const city = level.cities.find((item) => item.id === target.cityId)?.name ?? '';
      return target.maxDistanceKm !== undefined
        ? `台风中心距 ${city} ≤ ${target.maxDistanceKm.toFixed(0)} km`
        : `台风强度 ≥ ${typhoonCategoryName(target.minCategory ?? 0)}级`;
    }
    case 'moisture':
      return `${level.cities.find((city) => city.id === target.cityId)?.name ?? ''} Q ≥ ${(target.minQ ?? 0).toFixed(0)} g/m³`;
    case 'rain': {
      const city = level.cities.find((item) => item.id === target.cityId)?.name ?? '';
      if (target.min24h !== undefined) return `${city} 24 小时 ≥ ${target.min24h.toFixed(0)} mm`;
      if (target.max24h !== undefined) return `${city} 24 小时 ≤ ${target.max24h.toFixed(0)} mm`;
      return `${city} R > ${(target.minR ?? 0).toFixed(2)} mm`;
    }
    case 'clear':
      return `${level.cities.find((city) => city.id === target.cityId)?.name ?? ''} R = 0`;
    case 'dry': {
      const city = level.cities.find((item) => item.id === target.cityId)?.name ?? '';
      return `${city} R ≤ ${(target.maxR ?? 0.5).toFixed(2)} mm`;
    }
    case 'advect': {
      const city = level.cities.find((item) => item.id === target.cityId);
      const kmPerPx = level.base.domainScale
        ? level.base.domainScale / MAP_SIZE
        : MAP_KM_PER_PX;
      return `距${city?.name ?? target.cityId} ≤ ${((target.maxDistance ?? 72) * kmPerPx).toFixed(0)} km`;
    }
    case 'temperature': {
      const city = level.cities.find((city) => city.id === target.cityId)?.name ?? '';
      return target.minT !== undefined
        ? `${city} T > ${target.minT.toFixed(1)}°C`
        : `${city} T < ${(target.maxT ?? 0).toFixed(1)}°C`;
    }
    case 'pressure': {
      const name = level.cities.find((city) => city.id === target.cityId)?.name ?? '';
      if (target.minP === undefined && target.maxP !== undefined) {
        return `${name} P ≤ ${target.maxP.toFixed(0)} hPa`;
      }
      return `${name} P ≥ ${(target.minP ?? 0).toFixed(0)} hPa`;
    }
    case 'front':
      return `${level.cities.find((city) => city.id === target.cityId)?.name ?? ''} ${frontLabel(target.frontType ?? 'stationary')}`;
    case 'pressureTendency':
      return `${level.cities.find((city) => city.id === target.cityId)?.name ?? ''} ΔP ≥ ${(target.minDeltaP ?? 0).toFixed(1)} hPa`;
    case 'temperatureChange':
      return `${level.cities.find((city) => city.id === target.cityId)?.name ?? ''} ΔT ≤ ${(target.maxDeltaT ?? 0).toFixed(1)}℃`;
    case 'windShift':
      return `${level.cities.find((city) => city.id === target.cityId)?.name ?? ''} 风向变化 ≥ ${(target.minWindShift ?? 0).toFixed(0)}°`;
    case 'visibility':
      return `${level.cities.find((city) => city.id === target.cityId)?.name ?? ''} 能见度 ≤ ${(target.maxVisibility ?? 0).toFixed(1)} km`;
  }
}

function primaryTargetCity(level: LevelDefinition): string {
  const target = level.target;
  if (target.kind === 'advect') return target.cityId;
  if (
    target.kind === 'multi' ||
    target.kind === 'persistent' ||
    target.kind === 'persistentRain' ||
    target.kind === 'accumulatedRain' ||
    target.kind === 'sequence' ||
    target.kind === 'window'
  ) {
    return target.conditions.find((condition) => condition.kind !== 'advect')?.cityId ?? 'A';
  }
  return target.cityId;
}

function createWeatherIcon(weather: PointWeather): { html: string; className: string } {
  if (weather.hazard === 'tornado') {
    return {
      className: 'weather-snow',
      html: `<svg viewBox="0 0 40 40" aria-hidden="true">
        <path d="M9 8h22l-6 7H13l-4 3h16l-5 5H14l-2 3h8l-4 4"/>
        <path d="M20 30c0 3-3 4-4 6"/>
      </svg>`,
    };
  }
  if (weather.hazard === 'freezingRain') {
    return {
      className: 'weather-snow',
      html: `<svg viewBox="0 0 40 40" aria-hidden="true">
        <path d="M10.5 21.5h19a5.3 5.3 0 0 0 .3-10.5 7.3 7.3 0 0 0-13.9-1.5 5.9 5.9 0 0 0-5.4 12Z"/>
        <path d="M14 26v6M20 26v6M26 26v6M12 29h4M18 29h4M24 29h4"/>
      </svg>`,
    };
  }
  if (weather.hazard === 'hail') {
    return {
      className: 'weather-rain',
      html: `<svg viewBox="0 0 40 40" aria-hidden="true">
        <path d="M10.5 22.5h19a5.3 5.3 0 0 0 .3-10.5 7.3 7.3 0 0 0-13.9-1.5 5.9 5.9 0 0 0-5.4 12Z"/>
        <circle cx="15" cy="28" r="1.8"/><circle cx="21" cy="32" r="1.8"/><circle cx="27" cy="27" r="1.8"/>
      </svg>`,
    };
  }
  if (weather.hazard === 'fog') {
    return {
      className: 'weather-cloud',
      html: `<svg viewBox="0 0 40 40" aria-hidden="true">
        <path d="M11 22h18M8 27h24M12 32h18" stroke-width="2" stroke-linecap="round"/>
      </svg>`,
    };
  }
  if (weather.R >= 0.02) {
    if (weather.precipitationType === 'snow') {
      return {
        className: 'weather-snow',
        html: `<svg viewBox="0 0 40 40" aria-hidden="true">
          <path d="M11 23.5h18a5.2 5.2 0 0 0 .4-10.4 7.1 7.1 0 0 0-13.6-1.8A5.8 5.8 0 0 0 11 23.5Z"/>
          <path d="M14 29v5M20 29v5M26 29v5M12.5 31.5l3 2M22.5 29.5l3 2M17.5 33.5l3-2M23.5 31.5l3-2"/>
        </svg>`,
      };
    }
    return {
      className: 'weather-rain',
      html: `<svg viewBox="0 0 40 40" aria-hidden="true">
        <path d="M10.5 22.5h19a5.3 5.3 0 0 0 .3-10.5 7.3 7.3 0 0 0-13.9-1.5 5.9 5.9 0 0 0-5.4 12Z"/>
        <path d="m14 27-1.5 5M20 27l-1.5 5M26 27l-1.5 5"/>
      </svg>`,
    };
  }
  if (weather.W < -0.15) {
    return {
      className: 'weather-clear',
      html: `<svg viewBox="0 0 40 40" aria-hidden="true">
        <circle cx="20" cy="20" r="6.5"/>
        <path d="M20 7v4M20 29v4M7 20h4M29 20h4M10.8 10.8l2.8 2.8M26.4 26.4l2.8 2.8M29.2 10.8l-2.8 2.8M13.6 26.4l-2.8 2.8"/>
      </svg>`,
    };
  }
  if (weather.W > 0.05 || weather.Q > 12) {
    return {
      className: 'weather-cloud',
      html: `<svg viewBox="0 0 40 40" aria-hidden="true">
        <path d="M9.5 24h20a5.5 5.5 0 0 0 .1-11 7.5 7.5 0 0 0-14.1-1.4A6 6 0 0 0 9.5 24Z"/>
        <path d="M14 28.5h12" opacity=".45"/>
      </svg>`,
    };
  }
  return {
    className: 'weather-clear',
    html: `<svg viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="6.5"/>
      <path d="M20 7v4M20 29v4M7 20h4M29 20h4M10.8 10.8l2.8 2.8M26.4 26.4l2.8 2.8M29.2 10.8l-2.8 2.8M13.6 26.4l-2.8 2.8"/>
    </svg>`,
  };
}

export class GameController {
  /** Single owner for window/document listeners so destroy() can detach them. */
  private readonly globalListeners = new AbortController();
  private scene: GameScene | null = null;
  private level: LevelDefinition | null = null;
  private levelIndex = 0;
  private shapingOverride = false;
  private entities: WeatherEntity[] = [];
  private snapshot: SimulationSnapshot | null = null;
  private activeCard: CardType | null = null;
  private strengths: Record<CardType, number> = {
    H: 10,
    L: 10,
    air: -10,
    moisture: 40,
    trough: 2,
    ridge: 2,
    inversion: 1,
    jet: 2,
  };
  private variants: Partial<Record<CardType, EntityType>> = {
    H: 'warmHigh',
    L: 'coldLow',
  };
  private currentLayer: MapLayer = 'low';
  private selectedEntityId: string | null = null;
  private selectedCityId = 'A';
  private round = 0;
  private history: HistoryEntry[] = [];
  /**
   * Placement-level undo.  `history` only rewinds whole rounds, so a misplaced
   * card used to be unrecoverable without restarting the level.
   */
  private editHistory: WeatherEntity[][] = [];
  private lastEditAt = 0;
  private resetArmedAt = 0;
  private levelToken = 0;
  private weatherHistory: WeatherRecord[] = [];
  private result: RoundResult | null = null;
  private running = false;
  private completed = new Set<number>();
  private stars = new Map<number, number>();
  private refreshQueued = false;
  private queuedQuality: 'full' | 'preview' = 'full';
  private radiusFullTimer = 0;
  private fullRefreshTimer = 0;
  /** State right before the last placement/drag, used for the ΔP overlay. */
  private preEditSnapshot: SimulationSnapshot | null = null;
  private dragCardType: CardType | null = null;
  private cardDragInProgress = false;
  private toastTimer = 0;
  private popoverEntityId: string | null = null;
  private animationSpeed = 1;
  /**
   * Qualitative preview keeps the pre-run panel from acting as an oracle:
   * it names the missing necessary condition instead of printing the measured
   * value and "条件满足 · 待运行".  Learners can switch to the exact readout in
   * settings.
   */
  private precisePreview = false;

  private deck: Deck;
  private log: LogPanel;

  private brandHome = $button('brand-home');
  private homeScreen = $('home-screen');
  private homeProgress = $('home-progress');
  private homeStart = $button('home-start');
  private homeContinue = $button('home-continue');
  private homeSettings = $button('home-settings');
  private homeLink = $button('home-link');
  private settingsPanel = $('settings-panel');
  private settingsClose = $button('settings-close');
  private resetProgress = $button('reset-progress');
  private speedButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.settings-options button:not([data-preview])'));
  private previewButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-preview]'));
  private fieldButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-legend-toggle]'));
  private campaignButton = $button('campaign-button');
  private campaignOverlay = $('campaign-overlay');
  private campaignStages = $('campaign-stages');
  private campaignClose = $button('campaign-close');
  private undoButton = $button('undo-button');
  private resetButton = $button('reset-button');
  private runButton = $button('run-button');
  private runLabel = $('run-label');
  private levelRail = $('level-rail');
  private headerCode = $('header-code');
  private headerName = $('header-name');
  private headerStage = $('header-stage');
  private deckList = $('deck-list');
  private deckShapingHint = $('deck-shaping-hint');
  private mapFrame = $('map-frame');
  private mapTimestamp = $('map-timestamp');
  private mapTitle = $('map-title');
  private mapLegend = $('map-legend');
  private hemisphereLat = $('hemisphere-lat');
  private hemisphereLabel = $('hemisphere-label');
  private hemisphereToggle = $button('hemisphere-toggle');
  private layerControl = $('layer-control');
  private layerButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#layer-control button'));
  // UI v2: lifecycle badges and readouts for the v4.x logic layer.
  private levelModeBadge = $('level-mode-badge');
  private budgetBadge = $('budget-badge');
  private hourlyStrip = $('hourly-strip');
  private hourlyTrack = $('hourly-track');
  private hourlyNote = $('hourly-note');
  private surfaceStrip = $('surface-strip');
  private surfaceKind = $('surface-kind');
  private surfaceSst = $('surface-sst');
  private surfaceRoughness = $('surface-roughness');
  private surfaceEvap = $('surface-evap');
  private surfaceWater = $('surface-water');
  private surfaceLat = $('surface-lat');
  private surfaceElev = $('surface-elev');
  private resultStars = $('result-stars');
  private placementTip = $('placement-tip');
  private placementGlyph = $('placement-glyph');
  private placementName = $('placement-name');
  private placementStrength = $('placement-strength');
  private cancelPlacement = $button('cancel-placement');
  private runProgress = $('run-progress');
  private runStep = $('run-step');
  private runPhase = $('run-phase');
  private runPhaseDetail = $('run-phase-detail');
  private skipPhase = $button('skip-phase');
  private runPips = Array.from(document.querySelectorAll<HTMLElement>('.run-pips i'));
  private resultBanner = $('result-banner');
  private resultMark = $('result-mark');
  private resultKicker = $('result-kicker');
  private resultTitle = $('result-title');
  private resultText = $('result-text');
  private resultPrimary = $button('result-primary');
  private resultSecondary = $button('result-secondary');
  private hoverTooltip = $('hover-tooltip');
  private objectiveCode = $('objective-code');
  private objectiveTitle = $('objective-title');
  private objectiveDetail = $('objective-detail');
  private goalTarget = $('goal-target');
  private goalMeterFill = $('goal-meter-fill');
  private goalState = $('goal-state');
  private goalActual = $('goal-actual');
  private levelBrief = $('level-brief');
  private lockedNotice = $('locked-notice');
  private levelHint = $('level-hint');
  private hintToggle = $button('hint-toggle');
  private solutionToggle = $button('solution-toggle');
  private levelSolution = $('level-solution');
  private analysisPanel = document.querySelector<HTMLElement>('.analysis-panel');
  private panelTabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.panel-tab'));
  private solutionArmed = false;
  private lastStars = 0;
  private goalReadout = document.querySelector<HTMLElement>('.goal-readout');
  private objectiveCard = document.querySelector<HTMLElement>('.objective-card');
  private stationTabs = $('station-tabs');
  private stationLetter = $('station-letter');
  private stationName = $('station-name');
  private stationWeatherIcon = $('station-weather-icon');
  private stationAirMass = $('station-air-mass');
  private stationTemp = $('station-temp');
  private metricPressure = $('metric-pressure');
  private metricMoisture = $('metric-moisture');
  private metricVertical = $('metric-vertical');
  private metricRain = $('metric-rain');
  private metricMoistureNote = $('metric-moisture-note');
  private goalConsistencyValue = $('goal-consistency-value');
  private goalConsistencyNote = $('goal-consistency-note');
  private metricHighPressure = $('metric-high-pressure');
  private metricHighVertical = $('metric-high-vertical');
  private windNeedle = $('wind-needle');
  private stationWind = $('station-wind');
  private stationBeaufort = $('station-beaufort');
  private rainEquivalent = $('station-rain-equivalent');
  private rainGrade = $('station-rain-grade');
  private stationFront = $('station-front');
  private stationFrontLift = $('station-front-lift');
  private entityPopover = $('entity-popover');
  private goalTimeline = $('goal-timeline');
  private timelineToggle = $button('timeline-toggle');
  private timelineSummary = $('timeline-summary');
  private timelineTrack = $('timeline-track');
  private goalCausalCheck = $('goal-causal-check');
  private causalSummary = $('causal-summary');
  private causalToggle = $button('causal-toggle');
  private causalSlots = $('causal-slots');
  private manualOverlay = $('manual-overlay');
  private manualButton = $button('manual-button');
  private manualClose = $button('manual-close');
  private homeManual = $button('home-manual');
  private manualReturnFocus: HTMLElement | null = null;
  private toast = $('toast');
  private stageComplete = $('stage-complete');
  private stageCompleteKicker = $('stage-complete-kicker');
  private stageCompleteTitle = $('stage-complete-title');
  private stageCompleteCopy = $('stage-complete-copy');
  private stageCompleteCount = $('stage-complete-count');
  private stageReplay = $button('stage-replay');
  private stageClose = $button('stage-close');

  private get mapKmPerPixel(): number {
    return this.level?.base.domainScale
      ? this.level.base.domainScale / MAP_SIZE
      : MAP_KM_PER_PX;
  }

  private minRadiusPxFor(entity: WeatherEntity): number {
    return minPressureRadiusKm(entity.strength) / this.mapKmPerPixel;
  }

  private applyStrengthTiers(): void {
    if (!this.level) return;
    const tiers: Partial<Record<CardType, number[]>> = {};
    for (const card of Object.keys(CARD_STRENGTHS) as CardType[]) {
      const values = cardStrengthTiers(card, this.level.base.domainScale);
      if (values.length === 0) continue;
      tiers[card] = values;
      if (!values.includes(this.strengths[card])) {
        this.strengths[card] = values[Math.min(1, values.length - 1)];
      }
    }
    this.deck.setStrengthTiers(tiers);
  }

  constructor() {
    this.deck = new Deck(this.deckList, {
      onSelect: (type) => this.selectCard(type),
      onStrength: (type, strength) => this.chooseStrength(type, strength),
      onVariant: (type, entityType) => this.chooseVariant(type, entityType),
      onDragStart: (type) => this.beginCardDrag(type),
      onDragEnd: () => this.endCardDrag(),
      onLocked: (type) => this.handleLockedCard(type),
    });
    this.log = new LogPanel();
    this.loadCompleted();
    this.loadStars();
    this.loadSettings();
  }

  start(scene: GameScene): void {
    this.scene = scene;
    this.scene.setCallbacks({
      onHover: (payload) => this.handleHover(payload),
      onPlace: (x, y) => this.placeAt(x, y),
      onEntityClick: (id, button) => this.handleEntityClick(id, button),
      onEntityDrag: (id, x, y, done) => this.handleEntityDrag(id, x, y, done),
      onShapeChange: (id, shape) => this.handleShapeChange(id, shape),
      onRadiusChange: (id, radius) => this.changeEntityRadius(id, radius),
      onCityClick: (id) => this.selectCity(id),
      onBackgroundClick: () => this.clearSelection(),
    });
    this.bindUi();
    this.renderLevelRail();

    this.shapingOverride = new URLSearchParams(window.location.search).get('shaping') === '1';
    const rawLevel = new URLSearchParams(window.location.search).get('level');
    const hasLevelParam = rawLevel !== null;
    const requested = rawLevel === null ? Number.NaN : Number(rawLevel);
    const firstIncomplete = LEVELS.find((level) => !this.completed.has(level.index));
    const requestedIndex = Number.isFinite(requested)
      ? clamp(requested - 1, 0, LEVEL_TOTAL - 1)
      : firstIncomplete
        ? firstIncomplete.index - 1
        : 0;
    this.startLevel(requestedIndex);
    this.scene.setAnimationSpeed(this.animationSpeed);
    this.syncSpeedButtons();
    if (hasLevelParam) this.hideHome();
    else this.showHome();
  }

  private bindUi(): void {
    this.runButton.addEventListener('click', () => {
      this.runButton.blur();
      if (this.running) this.scene?.skipRun();
      else this.runRound();
    });
    this.homeStart.addEventListener('click', () => {
      this.hideHome();
      this.openCampaign();
    });
    this.homeContinue.addEventListener('click', () => this.hideHome());
    this.homeSettings.addEventListener('click', () => this.openSettings());
    this.homeLink.addEventListener('click', () => this.showHome());
    this.brandHome.addEventListener('click', () => this.showHome());
    this.settingsClose.addEventListener('click', () => this.closeSettings());
    this.settingsPanel.addEventListener('click', (event) => {
      if (event.target === this.settingsPanel) this.closeSettings();
    });
    for (const button of this.speedButtons) {
      button.addEventListener('click', () => {
        const speed = Number(button.dataset.speed);
        if (!Number.isFinite(speed)) return;
        this.animationSpeed = speed;
        this.scene?.setAnimationSpeed(speed);
        this.syncSpeedButtons();
        this.saveSettings();
      });
    }
    // The legend itself is the layer switch: click an item to toggle its layer.
    for (const button of this.fieldButtons) {
      button.addEventListener('click', () => {
        const field = button.dataset.legendToggle as 'isobar' | 'wind' | 'rain' | 'temperature' | 'source' | 'sst';
        if (!field) return;
        const next = !(this.scene?.getFieldVisible(field) ?? true);
        this.scene?.setFieldVisible(field, next);
        this.updateLegend();
      });
    }
    for (const button of this.previewButtons) {
      button.addEventListener('click', () => {
        this.precisePreview = button.dataset.preview === 'exact';
        this.syncPreviewButtons();
        this.saveSettings();
        if (this.snapshot) this.updateGoalPreview();
      });
    }
    this.resetProgress.addEventListener('click', () => this.resetCampaign());
    this.campaignButton.addEventListener('click', () => this.openCampaign());
    this.campaignClose.addEventListener('click', () => this.closeCampaign());
    this.campaignOverlay.addEventListener('click', (event) => {
      if (event.target === this.campaignOverlay) this.closeCampaign();
    });
    this.manualButton.addEventListener('click', () => {
      this.manualButton.blur();
      this.openManual(this.manualButton);
    });
    this.homeManual.addEventListener('click', () => {
      this.homeManual.blur();
      this.openManual(this.homeManual);
    });
    this.manualClose.addEventListener('click', () => this.closeManual());
    this.manualOverlay.addEventListener('click', (event) => {
      if (event.target === this.manualOverlay) this.closeManual();
    });
    this.campaignStages.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const node = target.closest<HTMLElement>('.campaign-level');
      if (!node) return;
      const index = Number(node.dataset.level);
      if (!Number.isFinite(index)) return;
      if (node.classList.contains('placeholder')) {
        this.showToast(`第 ${index} 关「${node.dataset.name ?? ''}」正在制作中，当前开放第 1～${LEVEL_TOTAL} 关。`, 'warn');
        return;
      }
      if (node.classList.contains('locked')) {
        this.showToast(
          index > CAMPAIGN_UNLOCK_GATE
            ? `先完成第 ${CAMPAIGN_UNLOCK_GATE} 关，解锁后续全部关卡。`
            : `先完成第 ${index - 1} 关，再进入本关。`,
          'warn',
        );
        return;
      }
      this.closeCampaign();
      this.startLevel(index - 1);
    });
    this.hintToggle.addEventListener('click', () => {
      const expanded = this.hintToggle.getAttribute('aria-expanded') === 'true';
      this.levelHint.hidden = expanded;
      this.hintToggle.setAttribute('aria-expanded', String(!expanded));
      this.hintToggle.textContent = expanded ? '显示提示' : '收起提示';
    });
    this.solutionToggle.addEventListener('click', () => this.revealSolution());
    for (const tab of this.panelTabs) {
      tab.addEventListener('click', () => this.setPanelView(tab.dataset.panel === 'station' ? 'station' : 'goal'));
    }
    this.undoButton.addEventListener('click', () => this.undo());
    this.resetButton.addEventListener('click', () => this.resetLevel());
    this.cancelPlacement.addEventListener('click', () => this.clearPlacement());
    this.skipPhase.addEventListener('click', () => this.scene?.skipRun());
    this.resultPrimary.addEventListener('click', () => this.handleResultPrimary());
    this.resultSecondary.addEventListener('click', () => this.handleResultSecondary());
    this.stageReplay.addEventListener('click', () => {
      this.hideStageComplete();
      this.startLevel(0);
    });
    this.stageClose.addEventListener('click', () => this.hideStageComplete());
    this.hemisphereToggle.addEventListener('click', () => {
      if (!this.level || this.running) {
        if (this.running) this.showToast('推演进行中，无法切换半球。', 'warn');
        return;
      }
      this.setHemisphere(this.level.base.hemisphere === 'N' ? 'S' : 'N');
    });
    for (const button of this.layerButtons) {
      button.addEventListener('click', () => {
        const layer = button.dataset.layer as MapLayer | undefined;
        if (layer) {
          this.setLayer(layer);
          this.showToast(layer === 'high' ? '已切换到高空层：显示高层 P/W 距平与高空风。' : layer === 'mid' ? '已切换到中层：显示中层环境。' : '已切换到低空层：显示地面天气与降水。');
        }
      });
    }

    this.levelRail.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const node = target.closest<HTMLElement>('.level-node');
      if (!node) return;
      const index = Number(node.dataset.level);
      if (!Number.isFinite(index)) return;
      if (this.running) {
        this.showToast('推演正在进行，完成或跳过后再切换关卡。', 'warn');
        return;
      }
      if (index === this.levelIndex) return;
      if (!this.isLevelUnlocked(index + 1)) {
        this.showToast(`先完成第 ${index} 关，再进入第 ${index + 1} 关。`, 'warn');
        return;
      }
      this.startLevel(index);
    });

    this.stationTabs.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const button = target.closest<HTMLButtonElement>('.station-tab');
      if (!button) return;
      const id = button.dataset.city;
      if (id) this.selectCity(id);
    });

    this.entityPopover.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target.closest('[data-action="close"]')) {
        this.hideEntityPopover();
        return;
      }
      if (target.closest('[data-action="remove"]')) {
        if (this.popoverEntityId) this.removeEntity(this.popoverEntityId);
        return;
      }
      const strengthButton = target.closest<HTMLButtonElement>('.popover-strength');
      if (strengthButton && this.popoverEntityId) {
        const strength = Number(strengthButton.dataset.strength);
        if (Number.isFinite(strength)) this.changeEntityStrength(this.popoverEntityId, strength);
        return;
      }
      const radiusButton = target.closest<HTMLButtonElement>('[data-radius-step]');
      if (radiusButton && this.popoverEntityId) {
        const stepKm = Number(radiusButton.dataset.radiusStep);
        const entity = this.entities.find((item) => item.id === this.popoverEntityId);
        if (Number.isFinite(stepKm) && entity) {
          this.changeEntityRadius(entity.id, entity.radius + stepKm / this.mapKmPerPixel);
        }
        return;
      }
      const rotateButton = target.closest<HTMLButtonElement>('[data-rotate]');
      if (rotateButton && this.popoverEntityId) {
        const entity = this.entities.find((item) => item.id === this.popoverEntityId);
        const deltaDeg = Number(rotateButton.dataset.rotate);
        if (entity && !entity.locked && Number.isFinite(deltaDeg)) {
          entity.angle = ((entity.angle ?? 0) + (deltaDeg * Math.PI) / 180) % (Math.PI * 2);
          this.markFieldModified();
          this.refreshField(true);
          this.openEntityPopover(entity);
        }
        return;
      }
    });

    this.entityPopover.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      if (!target.matches('[data-role="radius-slider"]') || !this.popoverEntityId) return;
      const km = Number(target.value);
      if (Number.isFinite(km)) {
        this.changeEntityRadius(this.popoverEntityId, km / this.mapKmPerPixel);
      }
    });

    // The only two new interactive elements in Sprint 3B are native buttons.
    // Enter reaches them through the normal Tab order; `handleKeyDown` is
    // deliberately untouched (§6.5 P0-2 / §7.3).
    this.timelineToggle.addEventListener('click', () => {
      const expand = this.timelineTrack.hidden;
      this.timelineTrack.hidden = !expand;
      this.timelineToggle.setAttribute('aria-expanded', String(expand));
      this.timelineToggle.textContent = expand ? '收起刻度' : '展开刻度';
    });
    this.causalToggle.addEventListener('click', () => {
      const expand = this.causalSlots.hidden;
      this.causalSlots.hidden = !expand;
      this.causalToggle.setAttribute('aria-expanded', String(expand));
      this.causalToggle.textContent = expand ? '收起' : '展开';
    });

    this.mapFrame.addEventListener('contextmenu', (event) => event.preventDefault());
    this.mapFrame.addEventListener('pointerdown', (event) => {
      if (!this.running) return;
      const target = event.target as HTMLElement;
      if (target.closest('button')) return;
      this.scene?.skipRun();
    });
    this.mapFrame.addEventListener('dragover', (event) => this.handleDragOver(event));
    this.mapFrame.addEventListener('dragenter', (event) => {
      if (this.dragCardType) event.preventDefault();
    });
    this.mapFrame.addEventListener('dragleave', (event) => this.handleDragLeave(event));
    this.mapFrame.addEventListener('drop', (event) => this.handleDrop(event));

    const listenerOptions = { signal: this.globalListeners.signal };
    window.addEventListener('keydown', (event) => this.handleKeyDown(event), listenerOptions);
    window.addEventListener(
      'resize',
      () => {
        if (this.popoverEntityId) this.hideEntityPopover();
      },
      listenerOptions,
    );
  }

  /**
   * Detach the global listeners owned by this controller.  Without this, a
   * rebuilt controller (HMR, embedding the game twice) keeps handling keys and
   * resizes from the discarded instance.
   */
  destroy(): void {
    this.globalListeners.abort();
    this.scene = null;
  }

  /**
   * Case levels need their DEM before the first field build, and the DEM is a
   * separately fetched chunk.  `startLevel` stays synchronous for callers; the
   * async part is guarded by a token so a fast level switch cannot be
   * overwritten by a slower load that finished late.
   */
  private startLevel(index: number): void {
    const target = clamp(index, 0, LEVEL_TOTAL - 1);
    const profile = LEVELS[target]?.base.terrainProfile;
    const token = ++this.levelToken;
    if (hasRealTerrain(profile) && !REAL_TERRAIN[profile!]) {
      this.showToast('正在加载案例地形…');
      void loadRealTerrain(profile)
        .catch(() => undefined)
        .then(() => {
          if (token === this.levelToken) this.beginLevel(target);
        });
      return;
    }
    this.beginLevel(target);
  }

  private beginLevel(index: number): void {
    if (this.fullRefreshTimer) {
      window.clearTimeout(this.fullRefreshTimer);
      this.fullRefreshTimer = 0;
    }
    if (this.radiusFullTimer) {
      window.clearTimeout(this.radiusFullTimer);
      this.radiusFullTimer = 0;
    }
    this.closeCampaign();
    this.closeManual();
    this.hideHome();
    this.running = false;
    this.scene?.stopRun();
    this.levelIndex = clamp(index, 0, LEVEL_TOTAL - 1);
    this.level = cloneLevel(LEVELS[this.levelIndex]);
    // Preview fields are built outside simulateRound, so the chart prototype
    // must be selected here as well.
    setActiveMap(this.level.base.mapId);
    this.entities = cloneEntities(this.level.initialEntities);
    invalidatePhysicalField();
    this.round = 0;
    this.history = [];
    this.editHistory = [];
    this.preEditSnapshot = null;
    this.weatherHistory = [];
    this.result = null;
    this.activeCard = null;
    this.selectedEntityId = null;
    this.selectedCityId = primaryTargetCity(this.level);
    this.refreshQueued = false;
    this.hideEntityPopover();
    this.hideResult();
    this.hideTooltip();
    this.hideStageComplete();

    this.currentLayer = 'low';
    this.scene?.setLevel(this.level);
    const shapingEnabled = this.shapingOverride || this.level.stage >= SHAPING_MIN_STAGE;
    this.scene?.setShapingEnabled(shapingEnabled);
    this.deckShapingHint.hidden = !shapingEnabled;
    this.scene?.setLayer(this.currentLayer);
    this.scene?.resetView();
    this.updateLayerUi();
    this.scene?.refreshHemisphere();
    this.refreshField(true);

    this.applyStrengthTiers();
    this.deck.render(this.level);
    this.deck.setStrengths(this.strengths);
    this.deck.setVariants(this.variants);
    this.deck.setActive(null);
    this.deck.setRunning(false);
    this.updatePlacementUi();
    this.updateHeader();
    this.updateLevelBadges();
    this.updateBrief();
    this.updateHemisphereUi();
    this.setObjectiveTone('preview');
    this.renderStationTabs();
    this.updateStation();
    this.updateTimestamp();
    this.updateRunButton();
    this.updateUndoButton();
    this.renderLevelRail();
    this.log.setIdle(this.level);
    this.hideResult();
    this.runProgress.hidden = true;
    document.title = `${this.level.name} · 气象推演`;
    const url = new URL(window.location.href);
    url.searchParams.set('level', String(this.level.index));
    window.history.replaceState(null, '', url);
  }

  private refreshField(immediate = false, quality: 'full' | 'preview' = 'full'): void {
    if (!this.level || !this.scene || this.running) return;
    if (!immediate && this.refreshQueued) {
      // A queued frame is only replaced by a request of the same or lower
      // quality; upgrading preview → full has to run again.
      if (this.queuedQuality === 'full' || quality === 'preview') return;
    }
    const compute = (runQuality: 'full' | 'preview') => {
      this.refreshQueued = false;
      if (!this.level || !this.scene || this.running) return;
      const snapshot = computeSnapshot(this.entities, this.level.base, this.level.cities, runQuality);
      this.snapshot = snapshot;
      this.scene.setState(
        snapshot,
        this.entities,
        this.selectedEntityId,
        this.selectedCityId,
        runQuality,
      );
      this.updateLegend();
      this.updateStation();
      this.updateBudgetBadge();
      this.updateGoalPreview();
      this.updateTimestamp();
      this.updateUndoButton();
      if (runQuality === 'full') this.updateConsistency();
    };

    if (immediate) {
      compute(quality);
    } else {
      this.refreshQueued = true;
      this.queuedQuality = quality;
      window.requestAnimationFrame(() => compute(this.queuedQuality));
    }
  }

  /**
   * Upgrade the displayed field to full quality once the player is idle.
   *
   * The full analysis costs 150–380 ms on late levels; running it inside the
   * pointer-up handler froze the end of every drag.  The preview frame is
   * already on screen, the goal readout is sampled per city (not from the
   * coarse grid), and `simulateRound` always rebuilds at full quality — so the
   * upgrade is purely a fidelity refresh and can wait for an idle window.
   */
  private scheduleFullRefresh(): void {
    if (this.fullRefreshTimer) return;
    const run = () => {
      this.fullRefreshTimer = 0;
      if (!this.running) this.refreshField(true, 'full');
    };
    this.fullRefreshTimer = window.setTimeout(() => {
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(run, { timeout: 240 });
      } else {
        run();
      }
    }, 40);
  }

  /**
   * Read-only physics audit.  The goal asks whether the weather happened;
   * this asks whether it could have happened, and names the law that broke.
   */
  private updateConsistency(): void {
    if (!this.level) return;
    const report = evaluateConsistency(this.entities, this.level.base, this.snapshot);
    this.goalConsistencyValue.textContent = String(report.score);
    this.goalConsistencyValue.dataset.tone =
      report.score >= 90 ? 'good' : report.score >= 75 ? 'warn' : 'bad';
    const failed = report.checks.filter((check) => !check.passed);
    this.goalConsistencyNote.textContent = failed.length
      ? failed[0].label
      : '符合物理约束';
    this.goalConsistencyNote.style.color = failed.length ? '#d8a15e' : '';
    this.goalConsistencyValue.parentElement?.setAttribute(
      'title',
      report.checks
        .map((check) => `${check.passed ? '✓' : '✗'} ${check.label}：${check.detail}`)
        .join('\n'),
    );
  }

  private selectCard(type: CardType): void {
    if (!this.level || this.running) return;
    if (!this.level.allowedCards.includes(type)) {
      this.handleLockedCard(type);
      return;
    }
    if (this.activeCard === type) {
      this.clearPlacement();
      return;
    }

    this.activeCard = type;
    this.selectedEntityId = null;
    this.scene?.setSelectedEntity(null);
    this.hideEntityPopover();
    this.ensurePlacementLayer();
    this.updatePlacementUi();
  }

  /**
   * v4.2: the air card is a signed temperature knob (cold < 0, warm > 0) and
   * the moisture card is independent.  No dual-knob popover remains, so the
   * preview simply maps the signed strength onto a cold/warm air entity.
   */
  private airPreviewType(): EntityType {
    return this.strengths.air < 0 ? 'coldAir' : 'warmAir';
  }

  private nudgeSelectedStrength(direction: number): void {
    const entity = this.entities.find((item) => item.id === this.selectedEntityId);
    if (!entity || entity.locked || !this.level) return;
    const tiers = entityStrengthTiers(entity.type, this.level.base.domainScale);
    const index = tiers.indexOf(entity.strength);
    const next = tiers[Math.max(0, Math.min(tiers.length - 1, (index < 0 ? 0 : index) + direction))];
    if (next === undefined || next === entity.strength) return;
    this.changeEntityStrength(entity.id, next);
  }

  private chooseStrength(type: CardType, strength: number): void {
    if (!this.level || this.running) return;
    if (!this.level.allowedCards.includes(type)) return;
    const tiers = cardStrengthTiers(type, this.level.base.domainScale);
    if (!tiers.includes(strength)) return;
    this.strengths[type] = strength;
    this.deck.setStrengths(this.strengths);
    if (this.activeCard !== type) {
      this.activeCard = type;
      this.selectedEntityId = null;
      this.scene?.setSelectedEntity(null);
      this.hideEntityPopover();
    }
    this.ensurePlacementLayer();
    this.updatePlacementUi();
  }

  private chooseVariant(type: CardType, entityType: EntityType): void {
    if (!this.level || this.running) return;
    if (!this.level.allowedCards.includes(type)) return;
    this.variants[type] = entityType;
    this.deck.setVariants(this.variants);
    this.activeCard = type;
    this.selectedEntityId = null;
    this.scene?.setSelectedEntity(null);
    this.hideEntityPopover();
    this.ensurePlacementLayer();
    this.updatePlacementUi();
  }

  private ensurePlacementLayer(): void {
    if (!this.level || !this.activeCard) return;
    if (!this.level.layers || this.level.layers.length <= 1) {
      this.setLayer('low', false);
      return;
    }
    const target = entityLayerForCard(this.activeCard, this.level);
    if (this.currentLayer !== target) this.setLayer(target, false);
  }

  private updatePlacementUi(): void {
    if (!this.activeCard) {
      this.placementTip.hidden = true;
      this.mapFrame.classList.remove('is-placing');
      this.deck.setActive(null);
      this.scene?.setActivePlacement(null);
      return;
    }

    const card = this.activeCard;
    const cardMeta = CARD_META[card];
    const entityType = card === 'air' ? this.airPreviewType() : cardEntityType(card, this.variants);
    const entityMeta = ENTITY_META[entityType];
    const strength = this.strengths[card];
    const layer = this.level ? entityLayerForCard(card, this.level) : 'low';
    this.placementTip.hidden = false;
    this.mapFrame.classList.add('is-placing');
    this.placementGlyph.textContent = entityMeta.glyph;
    this.placementName.textContent = `${cardMeta.name} · ${entityMeta.name}`;
    this.placementStrength.textContent = formatEntityStrength(entityType, strength);
    this.deck.setActive(card);
    this.scene?.setActivePlacement(entityType, strength, layer);
  }

  private clearPlacement(): void {
    this.activeCard = null;
    this.updatePlacementUi();
  }

  private placeAt(x: number, y: number, type = this.activeCard): void {
    if (!this.level || this.running || !type) return;
    if (!this.level.allowedCards.includes(type)) {
      this.handleLockedCard(type);
      return;
    }
    this.pushEdit(true);
    const entityType = type === 'air' ? this.airPreviewType() : cardEntityType(type, this.variants);
    const layer = entityLayerForCard(type, this.level);
    const entity = createEntity(entityType, x, y, this.strengths[type], {
      layer,
      inversionMode: entityType === 'inversion' ? (this.strengths[type] === 2 ? 'stable' : 'unstable') : undefined,
      domainScale: this.level.base.domainScale,
    });
    if (this.isPressureCenter(entity)) {
      const prognosticFloor = this.level.base.physics === 'prognostic' ? 480 : 0;
      const minRadius = Math.max(this.minRadiusPxFor(entity), prognosticFloor);
      if (entity.radius < minRadius) resizeEntity(entity, minRadius, minRadius);
    } else if (
      this.level.base.physics === 'prognostic' &&
      this.level.base.thermalCoupling === false &&
      (entity.type === 'coldAir' || entity.type === 'warmAir') &&
      entity.radius < 300
    ) {
      resizeEntity(entity, 300, 300);
    }
    entity.x = clamp(entity.x, 28, MAP_SIZE - 28);
    entity.y = clamp(entity.y, 28, MAP_SIZE - 28);
    this.entities.push(entity);
    this.entities = mergeSameType(this.entities);
    this.selectedEntityId = null;
    this.scene?.setSelectedEntity(null);
    this.markFieldModified();
    this.refreshField(false, 'preview');
    this.scheduleFullRefresh();
    this.scene?.clearGhost();
    if (this.cardDragInProgress) {
      this.cardDragInProgress = false;
      this.clearPlacement();
    }
  }

  private beginCardDrag(type: CardType): void {
    if (!this.level || this.running) return;
    if (!this.level.allowedCards.includes(type)) return;
    this.cardDragInProgress = true;
    this.dragCardType = type;
    this.activeCard = type;
    this.selectedEntityId = null;
    this.scene?.setSelectedEntity(null);
    this.hideEntityPopover();
    this.ensurePlacementLayer();
    this.updatePlacementUi();
  }

  private endCardDrag(): void {
    this.dragCardType = null;
    this.cardDragInProgress = false;
    this.scene?.clearGhost();
    if (this.activeCard) {
      this.clearPlacement();
    }
  }

  private handleDragOver(event: DragEvent): void {
    if (!this.dragCardType || !this.scene || this.running) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    this.scene.updatePlacementFromClient(event.clientX, event.clientY);
  }

  private handleDragLeave(event: DragEvent): void {
    const related = event.relatedTarget as Node | null;
    if (related && this.mapFrame.contains(related)) return;
    this.scene?.clearGhost();
  }

  private handleDrop(event: DragEvent): void {
    if (!this.level || !this.scene || this.running) return;
    event.preventDefault();
    const transferred = event.dataTransfer?.getData('text/plain') as CardType | undefined;
    const type = transferred || this.dragCardType;
    this.dragCardType = null;
    this.cardDragInProgress = false;
    this.scene.clearGhost();
    if (!type) {
      this.clearPlacement();
      return;
    }
    const point = this.scene.clientToWorld(event.clientX, event.clientY);
    if (point) {
      this.activeCard = type;
      this.ensurePlacementLayer();
      this.placeAt(point.x, point.y, type);
      this.clearPlacement();
    } else {
      this.clearPlacement();
    }
  }

  private handleLockedCard(type: CardType): void {
    const unlock = CARD_UNLOCK[type];
    const name = CARD_META[type].name;
    this.showToast(
      this.level && this.level.index >= unlock
        ? `本关不提供${name}牌。`
        : `第 ${unlock} 关解锁${name}牌。`,
      'warn',
    );
  }

  private handleEntityClick(id: string, button: 'left' | 'right'): void {
    if (!this.level || this.running) return;
    const entity = this.entities.find((item) => item.id === id);
    if (!entity) return;

    if (button === 'right') {
      this.removeEntity(id);
      return;
    }

    this.activeCard = null;
    this.updatePlacementUi();
    this.selectedEntityId = id;
    this.scene?.setSelectedEntity(id);
    this.openEntityPopover(entity);
    this.hideTooltip();
  }

  private handleEntityDrag(id: string, x: number, y: number, done: boolean): void {
    if (this.running) return;
    const entity = this.entities.find((item) => item.id === id);
    if (!entity || entity.locked) return;
    this.pushEdit();
    entity.x = clamp(x, 28, MAP_SIZE - 28);
    entity.y = clamp(y, 28, MAP_SIZE - 28);
    this.selectedEntityId = id;
    this.markFieldModified();
    this.hideEntityPopover();
    if (done) {
      this.refreshField(false, 'preview');
      this.scheduleFullRefresh();
      this.openEntityPopover(entity);
    } else {
      this.refreshField(false, 'preview');
    }
  }

  private removeEntity(id: string): void {
    if (!this.level || this.running) return;
    const entity = this.entities.find((item) => item.id === id);
    if (!entity) return;
    if (entity.locked) {
      this.showToast('初始场系统已锁定，不能移除。', 'warn');
      return;
    }
    this.pushEdit(true);
    this.entities = this.entities.filter((item) => item.id !== id);
    if (this.selectedEntityId === id) this.selectedEntityId = null;
    this.scene?.setSelectedEntity(null);
    this.hideEntityPopover();
    this.markFieldModified();
    this.refreshField(true);
  }

  private changeEntityStrength(id: string, strength: number): void {
    if (this.running) return;
    const entity = this.entities.find((item) => item.id === id);
    if (!entity) return;
    if (entity.locked) {
      this.showToast('初始场系统已锁定，不能修改强度。', 'warn');
      return;
    }
    const tiers = entityStrengthTiers(entity.type, this.level?.base.domainScale);
    if (!tiers.includes(strength)) return;
    this.pushEdit(true);
    entity.strength = strength;
    if (entity.type === 'inversion') entity.inversionMode = strength === 2 ? 'stable' : 'unstable';
    if (this.isPressureCenter(entity)) {
      const minRadius = this.minRadiusPxFor(entity);
      resizeEntity(entity, Math.max(entity.radius, minRadius), minRadius);
    }
    this.markFieldModified();
    this.refreshField(true);
    this.openEntityPopover(entity);
  }

  private isPressureCenter(entity: WeatherEntity): boolean {
    return (
      entity.type === 'coldLow' ||
      entity.type === 'warmLow' ||
      entity.type === 'coldHigh' ||
      entity.type === 'warmHigh' ||
      entity.type === 'typhoon'
    );
  }

  private changeEntityRadius(id: string, radius: number): void {
    if (this.running) return;
    const entity = this.entities.find((item) => item.id === id);
    if (!entity) return;
    if (entity.locked) {
      this.showToast('初始场系统已锁定，不能修改范围。', 'warn');
      return;
    }
    if (!this.isPressureCenter(entity)) return;
    this.pushEdit();
    resizeEntity(entity, radius, this.minRadiusPxFor(entity));
    this.markFieldModified();
    // Resizing fires on every pointer move: preview now, full analysis once the
    // player pauses, so the radius handle stays attached to the cursor.
    this.refreshField(false, 'preview');
    this.updateRadiusControls(entity);
    if (this.radiusFullTimer) window.clearTimeout(this.radiusFullTimer);
    this.radiusFullTimer = window.setTimeout(() => {
      this.radiusFullTimer = 0;
      this.scheduleFullRefresh();
    }, 180);
  }

  private updateRadiusControls(entity: WeatherEntity): void {
    const km = Math.round(entity.radius * this.mapKmPerPixel);
    const value = this.entityPopover.querySelector<HTMLElement>('[data-role="radius-value"]');
    if (value) value.textContent = `${km} km`;
    const slider = this.entityPopover.querySelector<HTMLInputElement>('[data-role="radius-slider"]');
    if (slider) {
      slider.min = String(
        this.isPressureCenter(entity) ? minPressureRadiusKm(entity.strength) : ENTITY_RADIUS_MIN_KM,
      );
      if (document.activeElement !== slider) slider.value = String(km);
    }
  }

  private openEntityPopover(entity: WeatherEntity): void {
    const point = this.scene?.worldToClient(entity.x, entity.y);
    if (!point) return;
    const meta = ENTITY_META[entity.type];
    const choices = entityStrengthTiers(entity.type, this.level?.base.domainScale)
      .map(
        (strength) => `
          <button class="popover-strength${entity.strength === strength ? ' active' : ''}" type="button" data-strength="${strength}" ${entity.locked ? 'disabled' : ''}>
            ${formatEntityStrength(entity.type, strength)}
          </button>
        `,
      )
      .join('');

    const radiusKm = Math.round(entity.radius * this.mapKmPerPixel);
    // Read-only derived value: what the current field actually produces on a
    // ring around the centre.  The player sets pressure; the wind follows.
    const fieldWind =
      this.isPressureCenter(entity) && this.level
        ? maxWindAround(this.entities, this.level.base, entity)
        : null;
    // Tropical cyclones are a phase of a warm-core low, not a card.  The panel
    // shows how far the transition has progressed.
    const sst = this.level ? (this.level.base.sst ?? this.level.base.T + 1) : 0;
    const warmCoreLabel =
      entity.type === 'typhoon'
        ? '已形成'
        : entity.type === 'warmLow'
          ? sst < 26.5
            ? `海温不足（${sst.toFixed(1)}°C）`
            : (entity.warmCoreRounds ?? 0) > 0
              ? `形成中 ${entity.warmCoreRounds}/${WARM_CORE_ROUNDS_FOR_TYPHOON}`
              : '未形成（需在暖海面持续降水）'
          : null;
    const editableRadius = this.isPressureCenter(entity);
    const radiusMinKm = editableRadius ? minPressureRadiusKm(entity.strength) : ENTITY_RADIUS_MIN_KM;
    // The slider must never offer a footprint wider than the chart itself.
    const radiusMaxKm = Math.min(
      ENTITY_RADIUS_MAX_KM,
      Math.round((this.level?.base.domainScale ?? 1000) * MAX_ENTITY_FRACTION),
    );
    const radiusControl = editableRadius
      ? `
      <div class="popover-range popover-primary">
        <div class="popover-range-head">
          <span>影响半径</span>
          <b data-role="radius-value">${radiusKm} km</b>
        </div>
        <div class="popover-range-row">
          <button class="popover-step" type="button" data-radius-step="-10" aria-label="缩小范围" ${entity.locked ? 'disabled' : ''}>−</button>
          <input class="popover-slider" type="range" min="${radiusMinKm}" max="${radiusMaxKm}" step="1" value="${radiusKm}" data-role="radius-slider" aria-label="影响半径" ${entity.locked ? 'disabled' : ''}>
          <button class="popover-step" type="button" data-radius-step="10" aria-label="放大范围" ${entity.locked ? 'disabled' : ''}>＋</button>
        </div>
      </div>`
      : '';
    const angleDeg = ((((entity.angle ?? 0) * 180) / Math.PI) % 360 + 360) % 360;
    const angleControl =
      entity.type === 'jet'
        ? `
      <div class="popover-range popover-primary">
        <div class="popover-range-head">
          <span>急流轴向</span>
          <b data-role="angle-value">${compassLabelFromToward(angleDeg)} ${Math.round(angleDeg)}°</b>
        </div>
        <div class="popover-range-row">
          <button class="popover-step" type="button" data-rotate="-22.5" aria-label="逆时针旋转" ${entity.locked ? 'disabled' : ''}>↺</button>
          <button class="popover-step" type="button" data-rotate="22.5" aria-label="顺时针旋转" ${entity.locked ? 'disabled' : ''}>↻</button>
        </div>
      </div>`
        : '';
    // Sprint 3B · A 只读预报对照：4 个只读量，无 input / button / 方位按钮组。
    const diagnostics = this.diagnosticMarkup(entity);
    this.entityPopover.innerHTML = `
      <div class="popover-head">
        <div class="popover-glyph" style="color:${meta.cssColor};border-color:${meta.cssColor}55">${meta.glyph}</div>
        <div class="popover-ident">
          <strong>${meta.name} · ${entityStrengthLabel(entity)}</strong>
          <span>${entity.id.startsWith('bg-') || entity.id === 'wet-source' ? '初始场系统' : '玩家放置系统'}</span>
        </div>
        <button class="popover-close" type="button" data-action="close" aria-label="关闭">×</button>
      </div>
      <div class="popover-stats">
        <span>横坐标 <b>${entity.x.toFixed(0)}</b></span>
        <span>纵坐标 <b>${entity.y.toFixed(0)}</b></span>
        ${
          this.isPressureCenter(entity)
            ? `<span>中心气压 <b>${(this.level?.base.P ?? 1012) - entity.strength * (entity.type === 'coldLow' || entity.type === 'warmLow' || entity.type === 'typhoon' ? 1 : -1)} hPa</b></span>`
            : ''
        }
        ${
          entity.type === 'typhoon'
            ? `<span>风压关系 <b>${typhoonMaxWind(entity.strength).toFixed(0)} m/s</b></span>`
            : ''
        }
        ${fieldWind !== null ? `<span>${entity.type === 'typhoon' ? '眼墙风速' : '最大风速'} <b>${fieldWind.toFixed(0)} m/s</b></span>` : ''}
        ${warmCoreLabel ? `<span>暖心结构 <b>${warmCoreLabel}</b></span>` : ''}
        ${editableRadius ? '' : `<span>影响半径 <b>${radiusKm} km</b></span>`}
      </div>
      ${diagnostics}
      ${radiusControl}
      ${angleControl}
      <details class="popover-advanced">
        <summary>进阶 · 所在层 / 结构</summary>
        <div class="popover-layer">
          <span>所在层 <b>${entity.layer === 'low' ? '低空' : entity.layer === 'mid' ? '中层' : '高空'}</b></span>
          <span>结构 <b>${entity.depth === 'shallow' ? '浅薄' : entity.depth === 'deep' ? '深厚' : '环境场'}</b></span>
        </div>
      </details>
      <div class="popover-label">${entity.type === 'inversion' ? '层结类型' : entity.type === 'trough' || entity.type === 'jet' ? '强度档位' : '强度档位'}</div>
      <div class="popover-strengths popover-primary">${choices}</div>
      ${
        entity.locked
          ? `<div class="popover-locked"><svg viewBox="0 0 10 10" aria-hidden="true"><rect x="1.6" y="4.3" width="6.8" height="4.8" rx="1"/><path d="M3.1 4.3V3.2a1.9 1.9 0 0 1 3.8 0v1.1"/></svg>初始场系统：位置、强度与范围均锁定</div>`
          : `<div class="popover-actions"><button class="popover-remove" type="button" data-action="remove">移除系统</button></div>`
      }
    `;
    this.entityPopover.hidden = false;
    this.popoverEntityId = entity.id;

    const rect = this.entityPopover.getBoundingClientRect();
    let left = point.x + 22;
    if (left + rect.width > window.innerWidth - 10) left = point.x - rect.width - 22;
    let top = point.y - rect.height / 2;
    top = clamp(top, 70, window.innerHeight - rect.height - 12);
    left = clamp(left, 10, window.innerWidth - rect.width - 10);
    this.entityPopover.style.left = `${left}px`;
    this.entityPopover.style.top = `${top}px`;
  }

  /** Read-only lookup into the last completed run.  No state is written. */
  private motionOf(entityId: string): WetMotion | undefined {
    return this.result?.simulation.motions.find((motion) => motion.entityId === entityId);
  }

  /**
   * B · A 只读预报对照.  Four read-only figures derived from already-computed
   * data: RunSimulation.motions (km), weatherHistory (pLow), entity.radius.
   * Every insufficient-data path renders an explanatory string, never 0 / 0.0.
   */
  private diagnosticMarkup(entity: WeatherEntity): string {
    const fixedSystem =
      entity.type === 'coldLow' || entity.type === 'warmLow' ||
      entity.type === 'coldHigh' || entity.type === 'warmHigh';
    const movingSystem = entity.type === 'wet' || entity.type === 'typhoon';
    const motion = this.motionOf(entity.id);

    let speedText = '不适用';
    let speedTitle = '该实体不随引导气流平移。';
    let directionText = '不适用';
    let directionTitle = '该实体不参与 8 方位引导方向显示。';
    let speedData = ' data-diagnostic="speed"';
    if (fixedSystem) {
      speedText = '固定系统 · 不随流移动';
      directionText = '固定系统 · 不随流移动';
      speedTitle = '确定性诊断场：高 / 低压中心固定，不随时间自由演变（F27）。不显示 0 km/h 或假方向。';
      directionTitle = speedTitle;
    } else if (entity.type === 'jet') {
      speedTitle = '急流轴向由现有 22.5° 档控件表达，不重复显示引导移速 / 方向。';
      directionTitle = speedTitle;
    } else if (movingSystem) {
      if (!motion) {
        speedText = this.round === 0 ? '等待首回合推演' : '本回合暂无位移记录';
        directionText = speedText;
        speedTitle = '尚无本回合 RunSimulation.motions 记录；按降级通则不插值、不显示 0 值。';
        directionTitle = speedTitle;
      } else {
        const kmPerHour = motion.distance / 3;
        speedText = `${kmPerHour.toFixed(0)} km/h`;
        speedTitle =
          `v = WetMotion.distance(${motion.distance.toFixed(3)} km) / 3 h = ${kmPerHour.toFixed(3)} km/h` +
          `（面板按整数显示 ${kmPerHour.toFixed(0)}）。` +
          'distance 已是 km，不乘任何像素系数、不复用 WIND_GRADIENT_SCALE（F29）。';
        speedData =
          ` data-diagnostic="speed" data-distance-km="${motion.distance.toFixed(3)}"` +
          ` data-hours="3" data-value-kmh="${kmPerHour.toFixed(3)}"`;
        directionText = `${compassLabelFromToward(motion.wind.towardDeg)} ${eightPointCode(motion.wind.towardDeg)}`;
        directionTitle =
          `8 方位 45° 档，取自 WetMotion.wind.towardDeg = ${motion.wind.towardDeg.toFixed(1)}°；` +
          '风矢量（m/s）与位移（km）不混用。';
      }
    }

    // C1 (team-lead adjudicated): keep the rolling 4-sample window
    // history[n-1] − history[n-4] — it spans 3 rounds × 3 h = 9 h.  A true 12 h
    // window would need 5 records and would stay degraded forever because the
    // current 50 levels cap out at 3/4 rounds.  Do NOT borrow the standard
    // standard 12-hour tendency label: label/unit/title/aria all say 9h / 3×3h.
    const history = this.weatherHistory;
    const n = history.length;
    const cityId = this.selectedCityId;
    let tendencyText: string;
    let tendencyTitle: string;
    if (n < 4) {
      tendencyText = `样本不足 ${n}/4 · 需再运行 ${4 - n} 回合（3 回合窗口）`;
      tendencyTitle = `weatherHistory 仅 ${n} 条记录（需 4）；按降级通则不插值、不显示 0.0。3 回合 × 3h = 9h 窗口。`;
    } else {
      const nowP = history[n - 1].cities[cityId]?.pLow;
      const pastP = history[n - 4].cities[cityId]?.pLow;
      if (nowP === undefined || pastP === undefined) {
        tendencyText = '—';
        tendencyTitle = '所选城市缺少 pLow 记录（3 回合 × 3h = 9h 窗口）。';
      } else {
        const delta = nowP - pastP;
        tendencyText = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} hPa/9h`;
        tendencyTitle =
          `ΔP₉ = pLow(now) − pLow(now−4) = ${nowP.toFixed(2)} − ${pastP.toFixed(2)} ` +
          `（weatherHistory[${n - 1}] / [${n - 4}]，cityId=${cityId}；3 回合 × 3h = 9h 窗口）。`;
      }
    }

    let r7Text: string;
    let r7Title: string;
    if (!this.isPressureCenter(entity)) {
      r7Text = '不适用 · 非气压中心';
      r7Title = '仅气压中心 / 台风显示有效风圈半径；与可编辑影响半径无关。';
    } else if (!this.level) {
      r7Text = '—';
      r7Title = '尺度未就绪。';
    } else {
      const band = entity.type === 'typhoon' ? 0.45 : 0.70;
      const sampleKm = entity.radius * band * this.mapKmPerPixel;
      const r7 = 1.7 * sampleKm;
      r7Text = `≈ ${r7.toFixed(0)} km`;
      r7Title =
        `标称近似 R₇ ≈ 1.7 × [radius × ${band} × mapKmPerPixel] = 1.7 × ${sampleKm.toFixed(1)} km；` +
        '采样环带为 maxWindAround 的固定环带，非真实 RMW。';
    }

    const row = (label: string, value: string, title: string, data: string, aria?: string): string =>
      `<div class="popover-diagnostic"${data}>` +
      `<span>${label}</span><b title="${escapeHtml(title)}"${aria ? ` aria-label="${escapeHtml(aria)}"` : ''}>${escapeHtml(value)}</b></div>`;

    return `
      <div class="popover-diagnostics" aria-label="只读预报对照">
        ${row('引导移速', speedText, speedTitle, speedData)}
        ${row('引导方向', directionText, directionTitle, ' data-diagnostic="direction"')}
        ${row('9h 变压', tendencyText, tendencyTitle, ` data-diagnostic="tendency" data-samples="${n}" data-needed="4" data-window-rounds="3" data-window-hours="9"`, `${tendencyText} · 3 回合 × 3h = 9h 窗口`)}
        ${row('有效风圈半径 R₇', r7Text, r7Title, ' data-diagnostic="r7"')}
      </div>`;
  }

  /** Prognostic levels sample every hour inside a round; expose those samples. */
  private updateHourlyStrip(cityId: string): void {
    if (!this.level || this.level.base.physics !== 'prognostic') return;
    const samples = this.snapshot?.hourly?.[cityId];
    if (!samples?.length) {
      this.hourlyNote.textContent = '等待预报计算';
      this.hourlyTrack.innerHTML = '';
      return;
    }
    const maxR = Math.max(...samples.map((sample) => sample.R));
    this.hourlyNote.textContent = `${samples.length} 个小时样本 · 峰值用于判题`;
    this.hourlyTrack.innerHTML = samples
      .map((sample) => {
        const peak = maxR > 0 && sample.R >= maxR ? ' is-peak' : '';
        return `<div class="hourly-cell${peak}">
          <span>${sample.hour} h</span>
          <b>${sample.P.toFixed(0)}</b>
          <small>W ${sample.W.toFixed(1)} · R ${sample.R.toFixed(1)}</small>
        </div>`;
      })
      .join('');
  }

  /**
   * D · read-only timeline.  Pure render: reads round / level.target /
   * weatherHistory / conditionResults; never writes history or weatherHistory,
   * never calls simulateRound.  Collapsed by default to protect the 1366×768
   * right column (R6 / §7.7).
   */
  private renderTimeline(evaluation: GoalEvaluation): void {
    if (!this.level) return;
    const requiredRounds = targetRounds(this.level.target);
    if (requiredRounds <= 1) {
      // Single-round levels: no cross-round observation to show (§7.5 D-⑤).
      this.goalTimeline.hidden = true;
      this.timelineTrack.hidden = true;
      return;
    }
    this.goalTimeline.hidden = false;
    const horizon = clamp(requiredRounds + 1, 4, 6);
    const expanded = !this.timelineTrack.hidden;

    const lastRecord = this.weatherHistory[this.weatherHistory.length - 1];
    const lastPLow = lastRecord?.cities[this.selectedCityId]?.pLow;
    const currentNote = lastPLow !== undefined
      ? `已推演 ${this.round} 回合 · ${this.selectedCityId} 城 ${lastPLow.toFixed(1)} hPa`
      : `已推演 ${this.round} 回合`;

    const cells: string[] = [
      `<div class="timeline-cell timeline-cell--current" aria-current="step">
        <span class="timeline-step" aria-label="当前回合">当前</span>
        <b class="timeline-hour">第 ${this.round * 3} 小时</b>
        <span class="timeline-note">${escapeHtml(currentNote)}</span>
      </div>`,
    ];

    const results = evaluation.conditionResults ?? [];
    for (let step = 1; step <= horizon; step += 1) {
      const absoluteHour = (this.round + step) * 3;
      const condition = results[this.round + step - 1];
      const covered = step > requiredRounds;
      let note: string;
      let tone: string;
      if (covered) {
        note = '目标已覆盖';
        tone = 'muted';
      } else if (condition) {
        note = condition.target || condition.label;
        tone = condition.passed ? 'good' : condition.actual === '未运行' ? 'muted' : 'warn';
      } else {
        note = evaluation.target;
        tone = 'muted';
      }
      cells.push(
        `<div class="timeline-cell timeline-cell--future" data-tone="${tone}" data-step="${step}" data-hour="${absoluteHour}">
          <span class="timeline-step">+${step * 3}h</span>
          <b class="timeline-hour">第 ${absoluteHour} 小时</b>
          <span class="timeline-note">${escapeHtml(note)}</span>
        </div>`,
      );
    }

    this.timelineTrack.innerHTML = cells.join('');
    this.timelineTrack.hidden = !expanded;
    this.timelineToggle.setAttribute('aria-expanded', String(expanded));
    this.timelineToggle.textContent = expanded ? '收起刻度' : '展开刻度';
    this.timelineSummary.textContent =
      `当前 第 ${this.round * 3} 小时 · 未来 ${horizon} 回合只读预览（+3h…+${horizon * 3}h）`;

    for (const cell of Array.from(
      this.timelineTrack.querySelectorAll<HTMLElement>('.timeline-cell--future'),
    )) {
      cell.addEventListener('pointerenter', () => this.showTimelineGhost(cell));
      cell.addEventListener('pointerleave', () => this.hideTooltip());
    }
  }

  /**
   * §4.3 ghost preview: static linear extrapolation of the last run's motion.
   * Reuses #hover-tooltip (position: fixed).  Hard boundary: no simulateRound,
   * no entity / weatherHistory writes, no refreshField / evaluateConsistency.
   */
  private showTimelineGhost(cell: HTMLElement): void {
    if (this.running || !this.level) return;
    const step = Number(cell.dataset.step ?? '1');
    const motion = this.result?.simulation.motions[0];
    const copy = motion
      ? `若引导气流持续，水汽约向 ${compassLabelFromToward(motion.wind.towardDeg)} 位移 ` +
        `${(motion.distance * step).toFixed(0)} km（+${step * 3}h 线性外推，非推演结果）。`
      : '暂无位移样本，无法外推（不造数据）。';
    this.hoverTooltip.classList.add('timeline-ghost');
    this.hoverTooltip.innerHTML =
      `<div class="hover-tooltip-head"><b>外推示意 · 非推演结果</b><span>+${step * 3}h</span></div>` +
      `<p class="ghost-copy">${escapeHtml(copy)}</p>`;
    this.hoverTooltip.hidden = false;
    const rect = cell.getBoundingClientRect();
    const width = 230;
    let left = rect.right + 8;
    if (left + width > window.innerWidth - 8) left = rect.left - width - 8;
    this.hoverTooltip.style.left = `${Math.max(8, left)}px`;
    this.hoverTooltip.style.top = `${Math.max(8, Math.min(rect.top, window.innerHeight - 90))}px`;
  }

  /**
   * E · causal chain.  Three slots consume evaluation.conditionResults
   * verbatim; the one-line summary is exactly report.recommendation (D3).
   */
  private renderCausalCheck(evaluation: GoalEvaluation, recommendation: string): void {
    if (!this.level) return;
    const previewing = !this.result;
    if ((evaluation.passed || evaluation.holding) && !previewing) {
      // §5.5-1/2: never misreport an in-progress or passed goal as missing.
      this.goalCausalCheck.hidden = false;
      this.causalSummary.textContent = evaluation.passed
        ? '✓ 目标达成 · 因果链各环均已满足'
        : '… 持续条件达成 · 暂不诊断缺项';
      this.causalSlots.hidden = true;
      this.causalSlots.innerHTML = '';
      this.causalToggle.hidden = true;
      this.causalToggle.setAttribute('aria-expanded', 'false');
      return;
    }

    const slots = conditionSlots(evaluation, this.level, this.entities, this.snapshot);
    const missing = slots.filter((slot) => slot.state === 'missing');
    this.causalSummary.textContent = previewing
      ? '按当前棋盘诊断 · 运行后判定'
      : missing.length
        ? `缺 ${missing.length} 项：${missing.map((slot) => slot.name).join('、')}`
        : '因果链各环已满足 · 详见下方差值';
    this.goalCausalCheck.hidden = false;
    this.causalToggle.hidden = false;
    this.causalToggle.textContent = '收起';
    this.causalToggle.setAttribute('aria-expanded', 'true');
    this.causalSlots.hidden = false;

    const rows = slots.map((slot) => {
      const flagText = slot.state === 'ok' ? '✓ 达成' : slot.state === 'na' ? '— 不考核' : '✗ 未达成';
      const flagLabel = slot.state === 'ok' ? '达成' : slot.state === 'na' ? '本关不考核此项' : '未达成';
      const meter = slot.state === 'na' ? 0 : Math.round(slot.progress * 100);
      const values = slot.state === 'na'
        ? '<span class="causal-na">本关不考核此项</span>'
        : `<span>当前 <b>${escapeHtml(slot.actual)}</b></span><span>目标 <b>${escapeHtml(slot.target)}</b></span>`;
      const detail = slot.state === 'na'
        ? ''
        : `<p class="causal-slot-detail">${escapeHtml(slot.detail)}` +
          `${slot.extra > 0 ? ` · 另有 ${slot.extra} 项` : ''}</p>`;
      return `
        <div class="causal-slot" data-state="${slot.state}">
          <div class="causal-slot-head">
            <span class="causal-slot-name">${slot.name}</span>
            <span class="causal-slot-flag" aria-label="${flagLabel}">${flagText}</span>
          </div>
          <div class="causal-slot-label">${escapeHtml(slot.label)}</div>
          <div class="causal-slot-values">${values}</div>
          <div class="causal-slot-meter"><i style="width:${meter}%"></i></div>
          ${detail}
        </div>`;
    }).join('');

    this.causalSlots.innerHTML = `${rows}
      ${recommendation ? `<p class="causal-recommendation">${escapeHtml(recommendation)}</p>` : ''}`;
  }

  private hideCausalCheck(): void {
    this.goalCausalCheck.hidden = true;
    this.causalSummary.textContent = '';
    this.causalSlots.hidden = true;
    this.causalSlots.innerHTML = '';
    this.causalToggle.hidden = true;
    this.causalToggle.setAttribute('aria-expanded', 'false');
    this.causalToggle.textContent = '展开';
  }

  private hideEntityPopover(): void {
    this.entityPopover.hidden = true;
    this.popoverEntityId = null;
  }

  private handleShapeChange(entityId: string, shape?: Array<{ x: number; y: number }>): void {
    const entity = this.entities.find((item) => item.id === entityId);
    if (!entity) return;
    this.pushEdit();
    entity.shape = shape ? shape.map((point) => ({ ...point })) : undefined;
    this.refreshField();
  }

  private clearSelection(): void {
    this.hideEntityPopover();
    this.selectedEntityId = null;
    this.scene?.setSelectedEntity(null);
    this.clearPlacement();
    this.hideTooltip();
  }

  private setHemisphere(hemisphere: Hemisphere): void {
    if (!this.level || this.running) {
      if (this.running) this.showToast('推演进行中，无法切换半球。', 'warn');
      return;
    }
    if (this.level.base.hemisphere === hemisphere) return;
    this.level.base.hemisphere = hemisphere;
    this.statusToastForHemisphere(hemisphere);
    this.markFieldModified();
    this.scene?.refreshHemisphere();
    this.refreshField(true);
    this.updateHemisphereUi();
    this.hideEntityPopover();
  }

  private updateHemisphereUi(): void {
    if (!this.level) return;
    const { hemisphere, latitude } = this.level.base;
    this.hemisphereLat.textContent = `${latitude}°`;
    this.hemisphereLabel.textContent = hemisphere === 'N' ? '北半球' : '南半球';
    this.hemisphereToggle.title =
      hemisphere === 'N'
        ? '当前为北半球，风向右偏；点击切换为南半球'
        : '当前为南半球，风向左偏；点击切换为北半球';
  }

  private setLayer(layer: MapLayer, redraw = true): void {
    if (!this.level) return;
    if (this.level.layers && !this.level.layers.includes(layer)) return;
    this.currentLayer = layer;
    this.scene?.setLayer(layer);
    this.updateLayerUi();
    if (this.activeCard && entityLayerForCard(this.activeCard, this.level) !== layer) {
      this.clearPlacement();
    }
    if (redraw) {
      this.updateStation();
      this.hideTooltip();
    }
  }

  private updateLayerUi(): void {
    if (!this.level) return;
    const layers = this.level.layers ?? [];
    this.layerControl.hidden = layers.length <= 1;
    this.layerButtons.forEach((button) => {
      const layer = button.dataset.layer as MapLayer;
      button.hidden = !layers.includes(layer);
      button.classList.toggle('active', layer === this.currentLayer);
      button.disabled = this.running;
    });
    this.mapTitle.textContent = this.currentLayer === 'high' ? '高空距平图' : this.currentLayer === 'mid' ? '中层天气图' : '地面天气图';
    this.layerControl.title = this.level.layerNote ?? '';
    this.updateLegend();
  }

  private setPanelView(view: 'goal' | 'station'): void {
    if (!this.analysisPanel) return;
    this.analysisPanel.dataset.view = view;
    this.analysisPanel.scrollTop = 0;
    for (const tab of this.panelTabs) {
      const active = tab.dataset.panel === view;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    }
    if (view === 'station') this.updateStation();
  }

  private revealSolution(): void {
    if (!this.level?.solution) {
      this.showToast('本关没有参考解法。', 'warn');
      return;
    }
    if (!this.solutionArmed) {
      this.solutionArmed = true;
      this.solutionToggle.textContent = '确认显示解法';
      this.showToast('再点一次确认显示解法。', 'warn');
      return;
    }
    this.levelSolution.textContent = this.level.solution;
    this.levelSolution.hidden = false;
    this.solutionToggle.textContent = '已显示解法';
    this.solutionToggle.setAttribute('aria-expanded', 'true');
    this.solutionToggle.disabled = true;
    this.levelHint.hidden = false;
    this.hintToggle.setAttribute('aria-expanded', 'true');
    this.hintToggle.textContent = '收起提示';
  }

  private updateLegend(): void {
    const state = this.scene?.legendState;
    const hasSource = this.level?.initialEntities.some((entity) => entity.type === 'wet') ?? false;
    const toggleFields = new Set(['isobar', 'wind', 'rain', 'temperature', 'source', 'sst']);
    this.mapLegend.querySelectorAll<HTMLElement>('[data-legend]').forEach((item) => {
      const key = item.dataset.legend ?? '';
      const enabled = key === 'source'
        ? this.scene?.getFieldVisible('source') ?? true
        : this.scene?.getFieldVisible(key as 'isobar' | 'wind' | 'rain' | 'temperature') ?? true;
      const hasFeature = key === 'source'
        ? hasSource
        : key === 'sst'
          ? Boolean(this.level?.base.surface)
          : Boolean(state && (state as unknown as Record<string, boolean>)[key]);
      if (toggleFields.has(key)) {
        // Toggleable legend items stay visible (dimmed when off) so the player
        // can click them again to restore the layer.
        item.hidden = false;
        item.classList.toggle('is-off', !enabled || !hasFeature);
        item.setAttribute('aria-pressed', String(Boolean(enabled)));
      } else {
        item.hidden = !hasFeature;
      }
    });
  }

  private statusToastForHemisphere(hemisphere: Hemisphere): void {
    this.showToast(
      hemisphere === 'N'
        ? '已切换到北半球：风矢向右偏转，水汽输送方向随之改变。'
        : '已切换到南半球：风矢向左偏转，水汽输送方向随之改变。',
    );
  }

  private selectCity(id: string): void {
    if (!this.level || this.running) return;
    if (!this.level.cities.some((city) => city.id === id)) return;
    this.selectedCityId = id;
    this.scene?.setSelectedCity(id);
    this.renderStationTabs();
    this.updateStation();
    this.hideEntityPopover();
    this.hideTooltip();
  }

  private handleHover(payload: HoverPayload | null): void {
    if (this.running) {
      this.hideTooltip();
      return;
    }
    if (!payload) {
      this.hideTooltip();
      return;
    }

    this.renderTooltip(payload);
  }

  private renderTooltip(payload: HoverPayload): void {
    const weather = payload.weather;
    const toward = compassLabelFromToward(weather.wind.towardDeg);
    this.hoverTooltip.classList.remove('timeline-ghost');
    this.hoverTooltip.innerHTML = `
      <div class="hover-tooltip-head">
        <span>场点观测</span>
        <b>横 ${payload.x.toFixed(0)} · 纵 ${payload.y.toFixed(0)}</b>
      </div>
      <div class="hover-grid">
        <div><span>低层 P</span><strong>${weather.pLow.toFixed(1)}</strong></div>
        <div><span>低层 T</span><strong>${weather.tLow.toFixed(1)}°</strong></div>
        <div><span>水汽供应</span><strong>${weather.qLow.toFixed(1)}</strong></div>
        <div><span>低层 W</span><strong>${weather.wLow >= 0 ? '+' : ''}${weather.wLow.toFixed(2)}</strong></div>
        <div><span>高层 P</span><strong>${weather.pHigh >= 0 ? '+' : ''}${weather.pHigh.toFixed(1)}</strong></div>
        <div><span>高层 W</span><strong>${weather.wHigh >= 0 ? '+' : ''}${weather.wHigh.toFixed(2)}</strong></div>
        <div><span>综合 W</span><strong>${weather.W >= 0 ? '+' : ''}${weather.W.toFixed(2)}</strong></div>
        <div><span>降水 R</span><strong>${weather.R.toFixed(2)}</strong></div>
      </div>
      <div class="hover-wind">
        气团 ${weather.airMass === 'neutral' ? '未定' : weather.airMass} · θe ${weather.thetaE.toFixed(0)} K · 切变 ${weather.shear.toFixed(0)}° · 干线 ${weather.dryline.toFixed(2)}<br>
        ${weather.wind.speed > 0.2 ? `低层${weather.wind.fromLabel}风 ${weather.wind.speed.toFixed(1)} m/s · 去向${toward}` : '低层静风'}
        ${weather.windHigh.speed > 0.2 ? ` · 高层 ${weather.windHigh.speed.toFixed(1)} m/s` : ''}
        ${weather.hazard !== 'none' ? ` · ${hazardText(weather.hazard)}` : ''}
        ${weather.frontType !== 'none' ? ` · ${frontLabel(weather.frontType)} +${weather.frontLift.toFixed(1)}` : ''}
        ${weather.coldPool >= 0.4 ? ` · 冷池 −${weather.coldPool.toFixed(1)}°C` : ''}
        ${
          weather.qLow > weather.qSat * 4
            ? '<br><span class="hover-cap">水汽已超过供给上限（4×饱和），继续加湿不会再增强降水</span>'
            : ''
        }
      </div>
    `;
    this.hoverTooltip.hidden = false;
    const width = 230;
    const height = 196;
    let left = payload.clientX + 17;
    let top = payload.clientY + 17;
    if (left + width > window.innerWidth - 8) left = payload.clientX - width - 16;
    if (top + height > window.innerHeight - 8) top = payload.clientY - height - 12;
    this.hoverTooltip.style.left = `${Math.max(8, left)}px`;
    this.hoverTooltip.style.top = `${Math.max(8, top)}px`;
  }

  private hideTooltip(): void {
    this.hoverTooltip.hidden = true;
    this.hoverTooltip.classList.remove('timeline-ghost');
  }

  private runRound(): void {
    if (!this.level || this.running || !this.scene) return;
    this.clearPlacement();
    this.selectedEntityId = null;
    this.scene.setSelectedEntity(null);
    this.hideEntityPopover();
    this.hideTooltip();
    this.hideResult();

    const level = this.level;
    const roundEntities = cloneEntities(this.entities);
    this.history.push({ entities: cloneEntities(this.entities), round: this.round });
    this.round += 1;
    this.running = true;
    this.result = null;
    this.deck.setRunning(true);
    this.updateLayerUi();
    this.undoButton.disabled = true;
    this.runButton.disabled = true;
    this.runButton.classList.add('is-running');
    this.runLabel.textContent = '推演中';
    this.runProgress.hidden = false;
    this.log.setRunning();
    this.showRunPhase(0);
    this.objectiveState('running');
    this.setObjectiveTone('running');

    // Let the "推演中" state paint before the three-hour physical spin-up.
    window.setTimeout(() => {
      if (!this.running || !this.scene) return;
      const simulation = simulateRound(roundEntities, level.base, level.cities);
      if (!this.running) return;
      this.scene.setDeltaBaseline(this.preEditSnapshot);
      this.scene.playRun(simulation, {
        onPhase: (phase) => this.showRunPhase(phase),
        onComplete: () => this.completeRun(simulation),
      });
    }, 32);
  }

  private showRunPhase(phase: number): void {
    const labels = [
      ['诊断视角 1 / 3', '风与输送', '气压梯度驱动空气，水汽与气团随风平移'],
      ['诊断视角 2 / 3', '垂直运动', '低压抬升、高压下沉，检查上升速度 W'],
      ['诊断视角 3 / 3', '凝结降水', '水汽越过饱和阈值后转成降水'],
    ];
    const [step, title, detail] = labels[phase] ?? labels[0];
    this.runStep.textContent = step;
    this.runPhase.textContent = title;
    this.runPhaseDetail.textContent = detail;
    this.runPips.forEach((pip, index) => {
      pip.classList.toggle('active', index === phase);
      pip.classList.toggle('done', index < phase);
    });
  }

  private completeRun(simulation: RunSimulation): void {
    if (!this.level) return;
    this.running = false;
    this.entities = cloneEntities(simulation.after.entities);
    this.snapshot = simulation.after;
    this.deck.setRunning(false);
    this.updateLayerUi();
    this.runButton.disabled = false;
    this.runButton.classList.remove('is-running');
    this.runProgress.hidden = true;
    this.updateUndoButton();
    this.updateTimestamp();

    this.scene?.setState(
      simulation.after,
      this.entities,
      null,
      this.selectedCityId,
    );

    const record: WeatherRecord = {
      round: this.round,
      cities: simulation.after.cities,
      entities: simulation.after.entities,
    };
    this.weatherHistory.push(record);
    this.editHistory = [];
    const evaluation = evaluateGoal(this.level, simulation.after, {
      history: this.weatherHistory,
    });
    const report = buildReport(this.level, simulation, evaluation);
    this.result = { simulation, evaluation };

    this.updateStation();
    this.applyGoalResult(evaluation);
    this.log.showReport(report, evaluation, this.level, !evaluation.passed && !evaluation.holding);
    this.lastStars = this.computeStars();
    this.showResult(evaluation, report.recommendation);

    if (evaluation.passed) {
      this.markComplete(this.level.index, this.lastStars);
      this.renderLevelRail();
    }
    this.updateRunButton();
  }

  private applyGoalResult(evaluation: GoalEvaluation): void {
    if (!this.goalReadout) return;
    this.goalReadout.classList.remove('passed', 'failed', 'holding', 'qualitative');
    this.goalReadout.classList.add(
      evaluation.passed ? 'passed' : evaluation.holding ? 'holding' : 'failed',
    );
    this.renderTimeline(evaluation);
    this.goalMeterFill.style.width = `${Math.round(evaluation.progress * 100)}%`;
    this.goalState.textContent = evaluation.passed
      ? '目标达成'
      : evaluation.holding
        ? '持续条件达成'
        : '目标未达成';
    this.goalActual.textContent = evaluation.actual;
    this.setObjectiveTone(evaluation.passed ? 'passed' : evaluation.holding ? 'holding' : 'failed');
    this.objectiveCard?.classList.remove('is-passed', 'is-failed', 'is-holding');
    this.objectiveCard?.classList.add(
      evaluation.passed ? 'is-passed' : evaluation.holding ? 'is-holding' : 'is-failed',
    );
  }

  private setObjectiveTone(
    tone: 'preview' | 'running' | 'passed' | 'failed' | 'holding',
  ): void {
    const colors = {
      preview: '#e5eef4',
      running: '#dce7ee',
      passed: '#8ee0c4',
      failed: '#e0a15a',
      holding: '#8fd8e5',
    };
    this.objectiveTitle.style.color = colors[tone];
    this.objectiveTitle.style.transition = 'color 220ms ease';
  }

  private objectiveState(state: 'preview' | 'running' | 'passed' | 'failed'): void {
    if (state === 'running') {
      if (this.goalReadout) this.goalReadout.classList.remove('passed', 'failed', 'holding');
      this.goalState.textContent = '推演中';
      this.goalActual.textContent = '计算中';
      return;
    }
    if (!this.snapshot || !this.level) return;
    if (state === 'passed' || state === 'failed') return;
    this.updateGoalPreview();
  }

  private updateGoalPreview(): void {
    const level = this.level;
    if (!level || !this.snapshot || !this.goalReadout) return;
    const evaluation = evaluateGoal(level, this.snapshot, {
      history: this.weatherHistory,
    });
    this.goalReadout.classList.remove('passed', 'failed', 'holding');
    this.goalMeterFill.style.width = `${Math.round(evaluation.progress * 100)}%`;
    const showHolding = Boolean(evaluation.holding && this.weatherHistory.length > 0);
    this.goalReadout.classList.toggle('qualitative', !this.precisePreview);
    if (this.precisePreview) {
      this.goalState.textContent = evaluation.passed
        ? '条件满足 · 待运行'
        : showHolding
          ? '持续中 · 待下一回合'
          : '等待运行';
      this.goalActual.textContent = evaluation.actual;
    } else {
      // No verdict before the run: name what is still missing, nothing more.
      const missing = (evaluation.conditionResults ?? [])
        .filter((item) => !item.passed)
        .map((item) => shortConditionLabel(item.condition, level))
        .slice(0, 2);
      this.goalState.textContent = evaluation.passed
        ? '趋势有利 · 待运行'
        : showHolding
          ? '持续中 · 待下一回合'
          : '尚未满足';
      this.goalActual.textContent = evaluation.passed
        ? '运行后判定'
        : missing.length
          ? `缺少：${missing.join('、')}`
          : '运行后判定';
    }
    this.objectiveCard?.classList.remove('is-passed', 'is-failed', 'is-holding');
    this.renderTimeline(evaluation);
    // One section now teaches and diagnoses: before the run it still shows the
    // four links and which ones are currently missing, so the removed static
    // "推演顺序" card has no unique information left.
    if (!this.result) this.renderCausalCheck(evaluation, '');
  }

  private updateRunButton(): void {
    if (this.running) return;
    this.runButton.disabled = false;
    this.runButton.classList.remove('is-running');
    if (this.result?.evaluation.passed) {
      this.runLabel.textContent = '再运行一回合';
    } else if (this.result?.evaluation.holding) {
      this.runLabel.textContent = '运行下一回合';
    } else if (this.round > 0) {
      this.runLabel.textContent = '运行下一回合';
    } else {
      this.runLabel.textContent = '运行推演';
    }
  }

  private showResult(evaluation: GoalEvaluation, recommendation: string): void {
    this.resultBanner.hidden = false;
    this.mapFrame.classList.add('has-result');
    this.resultBanner.classList.toggle('failed', !evaluation.passed && !evaluation.holding);
    this.resultBanner.classList.toggle('holding', Boolean(evaluation.holding));
    this.resultMark.textContent = evaluation.passed ? '✓' : evaluation.holding ? '…' : '!';
    this.resultKicker.textContent = evaluation.passed
      ? '推演完成'
      : evaluation.holding
        ? '条件持续中'
        : '推演未达成';
    this.resultTitle.textContent = evaluation.passed
      ? '目标达成'
      : evaluation.holding
        ? '持续条件达成'
        : '目标未达成';
    this.resultText.textContent = evaluation.passed
      ? evaluation.detail
      : evaluation.holding
        ? evaluation.detail
        : recommendation;
    this.resultStars.hidden = !evaluation.passed;
    if (evaluation.passed) {
      this.resultStars.innerHTML =
        [0, 1, 2]
          .map((index) => {
            const earned = index < this.lastStars;
            return `<span class="${earned ? 'on' : ''}">${earned ? '★' : '☆'}</span>`;
          })
          .join('') + `<em>${this.lastStars}/3</em>`;
    }

    if (evaluation.passed) {
      this.resultPrimary.textContent =
        this.levelIndex >= LEVEL_TOTAL - 1 ? '查看阶段总结' : '进入下一关';
      this.resultSecondary.textContent = '下一回合';
      this.resultSecondary.hidden = false;
    } else if (evaluation.holding) {
      this.resultPrimary.textContent = '继续调整';
      this.resultSecondary.hidden = true;
    } else {
      this.resultPrimary.textContent = '展开复盘';
      this.resultSecondary.textContent = '继续调整';
      this.resultSecondary.hidden = false;
    }
    this.renderCausalCheck(evaluation, recommendation);
  }

  private hideResult(): void {
    this.resultBanner.hidden = true;
    this.mapFrame.classList.remove('has-result');
    this.resultBanner.classList.remove('failed', 'holding');
    this.hideCausalCheck();
    // The causal chain now lives permanently in the panel; restore its
    // pre-run teaching state instead of leaving an empty gap.
    if (this.level && this.snapshot) this.updateGoalPreview();
  }

  private handleResultPrimary(): void {
    if (!this.result) {
      this.hideResult();
      return;
    }
    if (this.result.evaluation.passed) {
      if (this.levelIndex >= LEVEL_TOTAL - 1) {
        this.hideResult();
        this.showStageComplete();
      } else {
        this.hideResult();
        this.startLevel(this.levelIndex + 1);
      }
    } else if (this.result.evaluation.holding) {
      this.hideResult();
    } else {
      this.hideResult();
      this.log.expand();
    }
  }

  private handleResultSecondary(): void {
    if (!this.result) {
      this.hideResult();
      return;
    }
    const wasPassed = this.result.evaluation.passed;
    this.hideResult();
    if (wasPassed) {
      this.runRound();
    }
  }

  private markFieldModified(): void {
    if (this.result) {
      this.result = null;
      this.hideResult();
      this.log.setDirty();
      this.updateRunButton();
    }
    if (this.goalReadout) this.goalReadout.classList.remove('passed', 'failed', 'holding');
    this.objectiveCard?.classList.remove('is-passed', 'is-failed', 'is-holding');
    this.setObjectiveTone('preview');
  }

  /**
   * Snapshot the board before a player edit.  Continuous gestures (dragging a
   * card, sliding a radius) collapse into one entry via a short debounce, so
   * one Ctrl+Z undoes one gesture instead of one pointer event.
   */
  private pushEdit(force = false): void {
    // The first edit of a gesture defines the "before" state for the ΔP view.
    if (this.snapshot) this.preEditSnapshot = this.snapshot;
    const now = performance.now();
    if (!force && now - this.lastEditAt < 500) {
      this.lastEditAt = now;
      return;
    }
    this.lastEditAt = now;
    this.editHistory.push(cloneEntities(this.entities));
    if (this.editHistory.length > 50) this.editHistory.shift();
  }

  private undo(): void {
    if (this.running) {
      this.showToast('推演正在进行，无法回退。', 'warn');
      return;
    }
    const previousEdit = this.editHistory.pop();
    if (previousEdit) {
      this.entities = previousEdit;
      // The cached SWE field and the ΔP baseline are keyed to the board.  undo()
      // used to restore entities without invalidating either, so hover/station
      // samples and the pressure-delta view could show the pre-undo board.
      invalidatePhysicalField();
      this.preEditSnapshot = null;
      this.selectedEntityId = null;
      this.activeCard = null;
      this.scene?.setSelectedEntity(null);
      this.hideEntityPopover();
      this.markFieldModified();
      this.updatePlacementUi();
      this.refreshField(true);
      this.updateUndoButton();
      this.showToast('已撤销上一步操作。');
      return;
    }
    this.undoRound();
  }

  private undoRound(): void {
    if (this.running) {
      this.showToast('推演正在进行，无法回退。', 'warn');
      return;
    }
    this.editHistory = [];
    const previous = this.history.pop();
    if (!previous) {
      this.showToast('已经回到本关最初状态。', 'warn');
      return;
    }
    this.entities = cloneEntities(previous.entities);
    this.round = previous.round;
    this.weatherHistory = this.weatherHistory.slice(0, previous.round);
    this.result = null;
    invalidatePhysicalField();
    this.selectedEntityId = null;
    this.activeCard = null;
    this.scene?.setSelectedEntity(null);
    this.hideEntityPopover();
    this.hideResult();
    this.updatePlacementUi();
    this.deck.setStrengths(this.strengths);
    this.refreshField(true);
    this.updateTimestamp();
    this.setObjectiveTone('preview');
    this.log.setIdle(this.level!);
    this.updateRunButton();
    this.updateUndoButton();
    this.showToast(`已回退到第 ${this.round + 1} 回合开始前。`);
  }

  private resetLevel(): void {
    if (this.running) {
      this.showToast('推演正在进行，无法重开。', 'warn');
      return;
    }
    this.startLevel(this.levelIndex);
    this.showToast('本关已重开，所有玩家系统已清除。');
  }

  /** Badges that explain which engine and which rules the current level uses. */
  private updateLevelBadges(): void {
    if (!this.level) return;
    const prognostic = this.level.base.physics === 'prognostic';
    this.levelModeBadge.hidden = !prognostic;
    this.levelModeBadge.textContent = '预报场 · 逐小时';
    this.hourlyStrip.hidden = !prognostic;
    this.surfaceStrip.hidden = !this.level.base.surface;
    this.budgetBadge.hidden = !this.level.entityBudget;
    this.updateBudgetBadge();
  }

  private updateBudgetBadge(): void {
    if (!this.level?.entityBudget) return;
    const used = this.entities.filter((entity) => !entity.locked).length;
    this.budgetBadge.textContent = `系统 ${used}/${this.level.entityBudget}`;
    this.budgetBadge.classList.toggle('is-full', used >= this.level.entityBudget);
  }

  private updateHeader(): void {
    if (!this.level) return;
    this.headerCode.textContent = `第 ${String(this.level.index).padStart(2, '0')} 关`;
    this.headerStage.textContent =
      CAMPAIGN_STAGES.find((stage) => stage.stage === this.level!.stage)?.title.split(' · ')[1] ??
      '基础系统';
    this.headerName.textContent = this.level.name;
    this.objectiveCode.textContent = `第 ${this.level.index} 关 / 共 ${LEVEL_TOTAL} 关`;
    this.objectiveTitle.textContent = this.level.objective;
    this.objectiveDetail.textContent = this.level.objectiveDetail;
    this.goalTarget.textContent = formatGoalTarget(this.level);
    this.levelBrief.textContent = this.level.brief;
    this.levelHint.textContent = this.level.hint;
    this.levelSolution.hidden = true;
    this.levelSolution.textContent = '';
    this.solutionArmed = false;
    this.solutionToggle.disabled = !this.level.solution;
    this.solutionToggle.textContent = this.level.solution ? '显示解法' : '本关暂无解法';
    this.solutionToggle.setAttribute('aria-expanded', 'false');
    if (this.level.lockedNotice) {
      this.lockedNotice.hidden = false;
      const copy = this.lockedNotice.querySelector('span');
      if (copy) copy.textContent = this.level.lockedNotice;
    } else {
      this.lockedNotice.hidden = true;
    }
  }

  private updateBrief(): void {
    if (!this.level) return;
    this.objectiveTitle.textContent = this.level.objective;
    this.objectiveDetail.textContent = this.level.objectiveDetail;
    this.goalTarget.textContent = formatGoalTarget(this.level);
    this.levelBrief.textContent = this.level.brief;
    this.levelHint.textContent = this.level.hint;
    this.levelSolution.hidden = true;
    this.levelSolution.textContent = '';
    this.solutionArmed = false;
    this.solutionToggle.disabled = !this.level.solution;
    this.solutionToggle.textContent = this.level.solution ? '显示解法' : '本关暂无解法';
    this.solutionToggle.setAttribute('aria-expanded', 'false');
  }

  private updateTimestamp(): void {
    const date = new Date(2026, 5, 18, 14, 0);
    date.setHours(date.getHours() + this.round * 3);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    this.mapTimestamp.textContent = `第 ${this.round * 3} 小时 · ${year}-${month}-${day} ${hour}:00`;
  }

  private updateStation(): void {
    if (!this.level || !this.snapshot) return;
    const city = this.level.cities.find((item) => item.id === this.selectedCityId) ?? this.level.cities[0];
    const weather = this.snapshot.cities[city.id];
    if (!weather) return;
    const icon = createWeatherIcon(weather);
    const toward = compassLabelFromToward(weather.wind.towardDeg);

    this.stationLetter.textContent = city.id;
    this.stationName.textContent = city.name.replace(/^[A-Z]\s*/, '') || city.name;
    this.stationWeatherIcon.className = `station-weather-icon ${icon.className}`;
    this.stationWeatherIcon.innerHTML = icon.html;
    this.stationTemp.textContent = weather.T.toFixed(1);
    this.stationAirMass.textContent = weather.airMass === 'neutral' ? '未定' : weather.airMass;
    this.metricPressure.textContent = weather.P.toFixed(1);
    this.metricMoisture.textContent = weather.Q.toFixed(1);
    // Show the true saturation ratio instead of hiding supersaturation behind
    // a clamped 100 %.  Q is a supply index, so exceeding qSat is normal once
    // several moisture cards are stacked -- the player should see it.
    const satRatio = weather.qSat > 0.1 ? (weather.Q / weather.qSat) * 100 : 100;
    this.metricMoistureNote.textContent =
      satRatio >= 105
        ? `g/m³ · 过饱和 ${(satRatio / 100).toFixed(1)}×`
        : `g/m³ · 湿度 ${satRatio.toFixed(0)}%`;
    this.metricVertical.textContent = `${weather.W >= 0 ? '+' : ''}${weather.W.toFixed(2)}`;
    this.metricRain.textContent = weather.R.toFixed(2);
    this.metricHighPressure.textContent = `${weather.pHigh >= 0 ? '+' : ''}${weather.pHigh.toFixed(1)}`;
    this.metricHighVertical.textContent = `${weather.wHigh >= 0 ? '+' : ''}${weather.wHigh.toFixed(2)}`;

    // v4.x surface ledger: the map, the physics and this readout now all read
    // the same land/sea/SST/roughness field and the same water budget.
    const surface = sampleSurface(this.level.base, city.x, city.y);
    this.surfaceKind.textContent = surface.land
      ? surface.elevation >= 300 ? '山地' : surface.elevation >= 50 ? '丘陵' : '陆地'
      : '海面';
    this.surfaceSst.textContent = surface.sst.toFixed(1);
    this.surfaceLat.textContent = surfaceLatitudeAt(this.level.base, city.y).toFixed(1);
    this.surfaceElev.textContent = Math.round(surface.elevation).toString();
    this.surfaceRoughness.textContent =
      surface.roughness < 0.001 ? surface.roughness.toFixed(4) : surface.roughness.toFixed(2);
    const ledger = this.result?.simulation.water ?? [];
    this.surfaceEvap.textContent = ledger.reduce((sum, item) => sum + item.evaporated, 0).toFixed(2);
    this.surfaceWater.textContent = ledger.reduce((sum, item) => sum + item.end, 0).toFixed(1);

    const windLabel = weather.wind.speed < 0.2 ? '静风' : `${weather.wind.fromLabel}风`;
    this.stationWind.innerHTML = `${windLabel} <em>${weather.wind.speed.toFixed(1)} m/s</em>`;
    this.stationBeaufort.textContent =
      weather.wind.speed < 0.2
        ? '0 级 · 气压梯度微弱'
        : `${weather.wind.beaufort} 级 · 来向${weather.wind.fromLabel} · 吹向${toward}`;
    this.windNeedle.style.transform = `rotate(${weather.wind.towardDeg + 90}deg)`;
    this.rainEquivalent.innerHTML = `${weather.rain24h.toFixed(1)} <small>mm</small>`;
    this.rainGrade.textContent = weather.rainGrade;
    this.rainGrade.style.color =
      weather.rain24h >= 25 ? '#9fcce7' : weather.rain24h >= 0.1 ? '#9ccab5' : '#6f8b98';

    const frontNames = {
      none: '无锋面',
      cold: '冷锋',
      warm: '暖锋',
      stationary: '准静止锋',
      occluded: '锢囚锋',
    };
    this.stationFront.textContent = frontNames[weather.frontType];
    this.stationFront.className = `front-value ${weather.frontType}`;
    this.stationFrontLift.textContent =
      weather.frontType === 'none'
        ? '抬升指数 +0.00'
        : `锋面抬升指数 +${weather.frontLift.toFixed(2)}`;

    this.stationTabs.querySelectorAll<HTMLButtonElement>('.station-tab').forEach((button) => {
      button.classList.toggle('active', button.dataset.city === city.id);
    });
    this.updateHourlyStrip(city.id);
  }

  private renderStationTabs(): void {
    if (!this.level) return;
    this.stationTabs.innerHTML = this.level.cities
      .map(
        (city) => `
          <button class="station-tab${city.id === this.selectedCityId ? ' active' : ''}" type="button" data-city="${city.id}">
            <b>${city.id}</b>${city.name.replace(/^[A-Z]\s*/, '') || city.name}
          </button>
        `,
      )
      .join('');
  }

  private renderLevelRail(): void {
    this.levelRail.innerHTML = PLAYABLE_LEVELS.map((level, index) => {
      const active = index === this.levelIndex;
      const complete = this.completed.has(level.index);
      return `
        <button
          class="level-node stage-${level.stage}${index === 13 ? ' phase-start' : ''}${active ? ' active' : ''}"
          type="button"
          data-level="${index}"
          data-stage="${level.stage}"
          title="第 ${level.index} 关 · ${level.name}${complete ? ' · 已完成' : ''}"
          ${active ? 'aria-current="step"' : ''}
        >
          <span>${String(level.index).padStart(2, '0')}</span>
          ${complete ? '<i></i>' : ''}
        </button>
      `;
    }).join('');
  }

  private loadCompleted(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        for (const value of parsed) {
          if (typeof value === 'number') this.completed.add(value);
        }
      }
    } catch {
      // A blocked localStorage should never prevent the game from running.
    }
  }

  private loadStars(): void {
    try {
      const raw = localStorage.getItem(STARS_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          const level = Number(key);
          if (Number.isFinite(level) && typeof value === 'number' && value >= 1 && value <= 3) {
            this.stars.set(level, value);
          }
        }
      }
    } catch {
      // Star display is cosmetic; a blocked localStorage must not break play.
    }
  }

  private saveStars(): void {
    try {
      localStorage.setItem(STARS_KEY, JSON.stringify(Object.fromEntries(this.stars)));
    } catch {
      // Ignore storage failures.
    }
  }

  private computeStars(): number {
    // Three stars for a first-round solve, two when extra rounds were needed,
    // one when the solution was revealed (matches the hint-card promise).
    if (this.solutionArmed) return 1;
    return this.round > 0 ? 2 : 3;
  }

  private markComplete(levelNumber: number, stars: number): void {
    this.completed.add(levelNumber);
    this.stars.set(levelNumber, Math.max(this.stars.get(levelNumber) ?? 0, stars));
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.completed]));
      this.saveStars();
    } catch {
      // Ignore storage failures; completion state still lives in memory.
    }
  }

  private showHome(): void {
    if (this.running) {
      this.showToast('推演进行中，完成后再返回首页。', 'warn');
      return;
    }
    this.closeSettings();
    document.title = '气象推演';
    this.homeScreen.hidden = false;
    const count = PLAYABLE_LEVELS.filter((level) => this.completed.has(level.index)).length;
    this.homeProgress.innerHTML = `已开放 ${LEVEL_TOTAL} 关 · 已完成 <b>${count}</b> / ${LEVEL_TOTAL}`;
    this.homeContinue.hidden = count === 0 || count >= LEVEL_TOTAL;
    this.homeContinue.textContent = '继续关卡';
    this.homeContinue.disabled = count >= LEVEL_TOTAL;
  }

  private hideHome(): void {
    this.homeScreen.hidden = true;
  }

  private openSettings(): void {
    this.settingsPanel.hidden = false;
    this.syncSpeedButtons();
    this.syncPreviewButtons();
  }

  private closeSettings(): void {
    this.settingsPanel.hidden = true;
  }

  private syncPreviewButtons(): void {
    // Layer toggles are bound exactly once in bindUi().  Re-registering them
    // here used to add a new listener on every openSettings()/preview click,
    // so a single click flipped visibility N times and layers appeared broken.
    for (const button of this.previewButtons) {
      const exact = button.dataset.preview === 'exact';
      button.classList.toggle('active', exact === this.precisePreview);
    }
  }

  private syncSpeedButtons(): void {
    for (const button of this.speedButtons) {
      button.classList.toggle('active', Number(button.dataset.speed) === this.animationSpeed);
    }
  }

  private resetCampaign(): void {
    this.completed.clear();
    this.stars.clear();
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(STARS_KEY);
    } catch {
      // Ignore unavailable storage.
    }
    this.renderLevelRail();
    this.renderCampaign();
    this.homeProgress.innerHTML = `已开放 ${LEVEL_TOTAL} 关 · 已完成 <b>0</b> / ${LEVEL_TOTAL}`;
    this.settingsPanel.hidden = true;
    this.startLevel(0);
    this.showHome();
    this.showToast('进度已重置，从第 1 关重新开始。');
  }

  private loadSettings(): void {
    try {
      const raw = localStorage.getItem('aerosphere.settings.v1');
      if (!raw) return;
      const parsed = JSON.parse(raw) as { speed?: unknown; precisePreview?: unknown };
      if (typeof parsed.speed === 'number' && parsed.speed >= 0.5 && parsed.speed <= 3) {
        this.animationSpeed = parsed.speed;
      }
      if (typeof parsed.precisePreview === 'boolean') this.precisePreview = parsed.precisePreview;
    } catch {
      // Ignore unavailable storage.
    }
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(
        'aerosphere.settings.v1',
        JSON.stringify({ speed: this.animationSpeed, precisePreview: this.precisePreview }),
      );
    } catch {
      // Ignore unavailable storage.
    }
  }

  private isLevelUnlocked(index: number): boolean {
    if (index > LEVEL_TOTAL) return false;
    if (index <= CAMPAIGN_UNLOCK_GATE) {
      return index === 1 || this.completed.has(index - 1) || this.completed.has(index);
    }
    // Finishing the stage-1 gate opens the whole remaining campaign; a level
    // you already cleared stays replayable.
    return this.completed.has(CAMPAIGN_UNLOCK_GATE) || this.completed.has(index);
  }

  private openCampaign(): void {
    this.renderCampaign();
    this.campaignOverlay.hidden = false;
    this.campaignOverlay.setAttribute('aria-hidden', 'false');
    this.hideEntityPopover();
  }

  private closeCampaign(): void {
    this.campaignOverlay.hidden = true;
    this.campaignOverlay.setAttribute('aria-hidden', 'true');
  }

  private openManual(trigger: HTMLElement = this.manualButton): void {
    if (!this.manualOverlay.hidden) return;
    this.manualReturnFocus = trigger;
    this.manualOverlay.hidden = false;
    this.manualOverlay.setAttribute('aria-hidden', 'false');
    this.hideEntityPopover();
    this.hideTooltip();
    this.manualClose.focus({ preventScroll: true });
  }

  private closeManual(): void {
    if (this.manualOverlay.hidden) return;
    this.manualOverlay.hidden = true;
    this.manualOverlay.setAttribute('aria-hidden', 'true');
    const target = this.manualReturnFocus;
    this.manualReturnFocus = null;
    if (target && target.isConnected && target.offsetParent !== null) {
      target.focus({ preventScroll: true });
    } else {
      this.manualButton.focus({ preventScroll: true });
    }
  }

  private renderCampaign(): void {
    const names = new Map<number, string>();
    for (const level of PLAYABLE_LEVELS) names.set(level.index, level.name);
    const currentNumber = this.levelIndex + 1;

    this.campaignStages.innerHTML = CAMPAIGN_STAGES.map((stage) => {
      const implemented = PLAYABLE_LEVELS.filter(
        (level) => level.index >= stage.first && level.index <= stage.last,
      );
      const completed = implemented.filter((level) => this.completed.has(level.index)).length;
      const entries: string[] = [];
      for (let index = stage.first; index <= stage.last; index += 1) {
        const level = PLAYABLE_LEVELS.find((item) => item.index === index);
        const name = names.get(index) ?? `第 ${index} 关`;
        if (!level) {
          entries.push(`
            <button class="campaign-level placeholder" type="button" data-level="${index}" data-name="${name}">
              <span class="num">${String(index).padStart(2, '0')}</span>
              <span class="name">${name}</span>
              <span class="state">制作中</span>
            </button>
          `);
          continue;
        }
        const isCurrent = index === currentNumber;
        const unlocked = this.isLevelUnlocked(index);
        const isCompleted = this.completed.has(index);
        const earned = this.stars.get(index) ?? 0;
        const stars = isCompleted && earned
          ? `<span class="campaign-stars" aria-label="${earned} 星">${'★'.repeat(earned)}${'☆'.repeat(3 - earned)}</span>`
          : '';
        entries.push(`
          <button class="campaign-level${isCompleted ? ' completed' : ''}${isCurrent ? ' current' : ''}${unlocked ? '' : ' locked'}" type="button" data-level="${index}" data-name="${name}">
            <span class="num">${String(index).padStart(2, '0')}</span>
            <span class="name">${name}</span>
            <span class="state">${isCompleted ? '已完成' : isCurrent ? '当前关' : unlocked ? '可进入' : '未解锁'}</span>
            ${stars}
          </button>
        `);
      }
      return `
        <section class="campaign-stage">
          <div class="campaign-stage-head">
            <strong>${stage.title}</strong>
            <span>${stage.range} · ${
              implemented.length > 0 ? `${completed}/${implemented.length} 已完成` : '后续开放'
            }</span>
          </div>
          <div class="campaign-grid">${entries.join('')}</div>
        </section>
      `;
    }).join('');
  }

  private showStageComplete(): void {
    const completedCount = PLAYABLE_LEVELS.filter((level) => this.completed.has(level.index)).length;
    this.stageCompleteCount.textContent = String(completedCount).padStart(2, '0');
    if (completedCount >= LEVEL_TOTAL) {
      this.stageCompleteKicker.textContent = '全部关卡完成';
      this.stageCompleteTitle.textContent = '战役通关';
      this.stageCompleteCopy.textContent = `全部 ${LEVEL_TOTAL} 关已完成。可以重玩任意关卡，冲击更优的物理一致性评分。`;
    } else {
      this.stageCompleteKicker.textContent = '本关完成';
      this.stageCompleteTitle.textContent = '本关推演完成';
      this.stageCompleteCopy.textContent = `已完成 ${completedCount} / ${LEVEL_TOTAL} 关。可通过顶栏“关卡”返回关卡总览，补齐剩余关卡。`;
    }
    this.stageComplete.hidden = false;
    this.stageComplete.setAttribute('aria-hidden', 'false');
  }

  private hideStageComplete(): void {
    this.stageComplete.hidden = true;
    this.stageComplete.setAttribute('aria-hidden', 'true');
  }

  private updateUndoButton(): void {
    this.undoButton.disabled = this.running || (this.history.length === 0 && this.editHistory.length === 0);
    this.undoButton.title =
      this.editHistory.length > 0
        ? '撤销上一步操作（Ctrl+Z）'
        : '撤销上一回合（Ctrl+Z）';
  }

  private showToast(message: string, tone: 'warn' | 'normal' = 'normal'): void {
    window.clearTimeout(this.toastTimer);
    this.toast.textContent = message;
    this.toast.className = `toast${tone === 'warn' ? ' warn' : ''}`;
    requestAnimationFrame(() => this.toast.classList.add('visible'));
    this.toastTimer = window.setTimeout(() => {
      this.toast.classList.remove('visible');
    }, 2300);
  }

  private handleKeyDown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    if (!this.manualOverlay.hidden) {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.closeManual();
      }
      return;
    }
    if (!this.level) return;

    if (!this.settingsPanel.hidden) {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.closeSettings();
      }
      return;
    }
    if (!this.homeScreen.hidden) return;
    if (!this.campaignOverlay.hidden && event.key !== 'Escape') return;
    if (!this.stageComplete.hidden && event.key !== 'Escape') return;

    if (event.key === 'Escape') {
      event.preventDefault();
      if (!this.settingsPanel.hidden) {
        this.closeSettings();
        return;
      }
      if (!this.campaignOverlay.hidden) {
        this.closeCampaign();
        return;
      }
      if (!this.stageComplete.hidden) {
        this.hideStageComplete();
        return;
      }
      if (this.running) {
        this.scene?.skipRun();
        return;
      }
      if (this.activeCard) {
        this.clearPlacement();
        return;
      }
      if (!this.entityPopover.hidden) {
        this.hideEntityPopover();
        return;
      }
      this.clearSelection();
      return;
    }

    if (event.code === 'Space') {
      event.preventDefault();
      if (event.repeat) return;
      if (!this.stageComplete.hidden) return;
      if (this.running) {
        this.scene?.skipRun();
      } else {
        this.runRound();
      }
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      this.undo();
      return;
    }

    if (event.ctrlKey || event.metaKey || event.altKey) return;

    if (event.key.toLowerCase() === 'r') {
      event.preventDefault();
      // Restarting throws away every placement and the round stack, so it asks
      // for a second press instead of firing on a mistyped key.
      const now = performance.now();
      if (this.resetArmedAt && now - this.resetArmedAt < 3000) {
        this.resetArmedAt = 0;
        this.resetLevel();
      } else {
        this.resetArmedAt = now;
        this.showToast('再按一次 R 确认重开本关（3 秒内有效，Ctrl+Z 可撤销操作）。', 'warn');
      }
      return;
    }

    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (!this.selectedEntityId) return;
      event.preventDefault();
      this.removeEntity(this.selectedEntityId);
      return;
    }

    // Keyboard placement: arrows walk the ghost, Enter drops it.
    if (this.activeCard && !this.running) {
      const step = event.shiftKey ? 40 : 12;
      const delta: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const move = delta[event.key];
      if (move) {
        event.preventDefault();
        this.scene?.nudgeGhost(move[0], move[1]);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        this.scene?.placeGhost();
        return;
      }
    }

    // Strength of the selected system: + / − walk the tier list without
    // opening the popover, so a whole analysis can be tuned from the keyboard.
    if (
      this.selectedEntityId &&
      !this.running &&
      (event.key === '+' || event.key === '=' || event.key === '-' || event.key === '_')
    ) {
      event.preventDefault();
      this.nudgeSelectedStrength(event.key === '+' || event.key === '=' ? 1 : -1);
      return;
    }

    // Keyboard view controls: arrows pan, +/- zoom, 0 resets.  Arrow keys are
    // consumed by ghost placement above while a card is selected, so the two
    // modes never fight over the same input.
    if (!this.activeCard && !this.running) {
      const step = event.shiftKey ? 120 : 60;
      const pan: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const move = pan[event.key];
      if (move) {
        event.preventDefault();
        this.scene?.panBy(move[0], move[1]);
        return;
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        this.scene?.zoomIn();
        return;
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        this.scene?.zoomOut();
        return;
      }
      if (event.key === '0') {
        event.preventDefault();
        this.scene?.resetView();
        return;
      }
    }

    const type = CARD_HOTKEYS[event.key];
    if (type) {
      event.preventDefault();
      if (!this.level.allowedCards.includes(type)) {
        this.handleLockedCard(type);
      } else {
        this.selectCard(type);
      }
    }
  }
}

