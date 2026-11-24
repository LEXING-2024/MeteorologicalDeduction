import { MAP_KM_PER_PX, MAP_SIZE } from '../config/constants';
import { frontLabel } from './fronts';
import { typhoonCategory, typhoonCategoryName } from './typhoon';
import type {
  City,
  ConditionEvaluation,
  GoalContext,
  GoalEvaluation,
  GoalTarget,
  HazardType,
  LevelDefinition,
  PointWeather,
  SimulationSnapshot,
  WeatherCondition,
  WeatherEntity,
  WeatherRecord,
} from './types';

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function cityLabel(level: LevelDefinition, cityId: string): string {
  return level.cities.find((item) => item.id === cityId)?.name ?? cityId;
}

function hazardLabel(hazard: Exclude<HazardType, 'none'>): string {
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
  }
}

function getWeather(cities: Record<string, PointWeather>, cityId: string): PointWeather | undefined {
  return cities[cityId];
}

function distanceToCityKm(
  entity: WeatherEntity,
  level: LevelDefinition,
  cityId: string,
): number {
  const city = level.cities.find((item) => item.id === cityId);
  if (!city) return Number.POSITIVE_INFINITY;
  const kmPerPx = level.base.domainScale
    ? level.base.domainScale / MAP_SIZE
    : MAP_KM_PER_PX;
  return Math.hypot(entity.x - city.x, entity.y - city.y) * kmPerPx;
}

export function conditionTargetLabel(
  condition: WeatherCondition,
  level: LevelDefinition,
): string {
  const city = cityLabel(level, condition.cityId);
  switch (condition.kind) {
    case 'vertical':
      return `${city} 综合 W > ${(condition.minW ?? 0).toFixed(2)}`;
    case 'highVertical':
      if (condition.maxW !== undefined) {
        return `${city} 高层 W ≤ ${condition.maxW.toFixed(2)}`;
      }
      return `${city} 高层 W > ${(condition.minW ?? 0).toFixed(2)}`;
    case 'hazard':
      return `${city} 出现${hazardLabel(condition.hazard ?? 'thunderstorm')}`;
    case 'dry':
      return `${city} R ≤ ${(condition.maxR ?? 0.5).toFixed(2)} mm`;
    case 'pressureTendency':
      return `${city} 气压变化 ≥ ${(condition.minDeltaP ?? 0).toFixed(1)} hPa`;
    case 'temperatureChange':
      return `${city} 温度变化 ≤ ${(condition.maxDeltaT ?? 0).toFixed(1)}℃`;
    case 'windShift':
      return `${city} 风向变化 ≥ ${(condition.minWindShift ?? 0).toFixed(0)}°`;
    case 'visibility':
      return `${city} 能见度 ≤ ${(condition.maxVisibility ?? 0).toFixed(1)} km`;
    case 'airMass':
      return `${city} ${condition.airMass ?? 'neutral'} 气团`;
    case 'wind':
      return `${city} 来自${condition.fromDirs?.join('/') ?? '任意'}风 ≥ ${(condition.minSpeed ?? 0).toFixed(1)} m/s`;
    case 'shear':
      return `${city} 风向切变 ≥ ${(condition.minShear ?? 0).toFixed(0)}°`;
    case 'dryline':
      return `${city} 干线强度 ≥ ${(condition.minDryline ?? 0).toFixed(2)}`;
    case 'moisture':
      return `${city} Q ≥ ${(condition.minQ ?? 0).toFixed(1)} g/m³`;
    case 'rain':
      if (condition.min24h !== undefined && condition.max24h !== undefined) {
        return `${city} 24 小时 ${condition.min24h.toFixed(0)}–${condition.max24h.toFixed(0)} mm`;
      }
      if (condition.min24h !== undefined) return `${city} 24 小时 ≥ ${condition.min24h.toFixed(0)} mm`;
      if (condition.max24h !== undefined) return `${city} 24 小时 ≤ ${condition.max24h.toFixed(0)} mm`;
      return `${city} R > ${(condition.minR ?? 0).toFixed(2)} mm`;
    case 'clear':
      return `${city} R = 0`;
    case 'temperature':
      if (condition.minT !== undefined) return `${city} T > ${condition.minT.toFixed(1)}°C`;
      return `${city} T < ${(condition.maxT ?? 0).toFixed(1)}°C`;
    case 'pressure':
      if (condition.minP !== undefined && condition.maxP !== undefined) {
        return `${city} P ${condition.minP.toFixed(0)}–${condition.maxP.toFixed(0)} hPa`;
      }
      if (condition.minP === undefined && condition.maxP !== undefined) {
        return `${city} P ≤ ${condition.maxP.toFixed(0)} hPa`;
      }
      return `${city} P ≥ ${(condition.minP ?? 0).toFixed(0)} hPa`;
    case 'stability':
      if (condition.maxStability !== undefined && condition.minStability === undefined) {
        return `${city} 层结稳定（< ${condition.maxStability.toFixed(2)}）`;
      }
      return `${city} 层结不稳定（> ${(condition.minStability ?? 0).toFixed(2)}）`;
    case 'front':
      return `${city} ${frontLabel(condition.frontType ?? 'stationary')}`;
    case 'rotation':
      return `${city} 旋转强度 ≥ ${(condition.minVorticity ?? 0).toFixed(0)} ×10⁻⁴ s⁻¹`;
    case 'typhoon': {
      const category = typhoonCategoryName(condition.minCategory ?? 0);
      if (condition.maxDistanceKm !== undefined) {
        return `台风中心距 ${city} ≤ ${condition.maxDistanceKm.toFixed(0)} km`;
      }
      return `台风强度 ≥ ${category}级`;
    }
    case 'advect':
      return `水汽进入 ${city} 目标区`;
  }
}

function angularDifference(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function evaluateCondition(
  condition: WeatherCondition,
  level: LevelDefinition,
  cities: Record<string, PointWeather>,
  entities: WeatherEntity[] = [],
  previous?: PointWeather,
): ConditionEvaluation {
  const city = cityLabel(level, condition.cityId);
  const target = conditionTargetLabel(condition, level);

  if (condition.kind === 'advect') {
    const entity = entities.find((item) => item.id === condition.entityId);
    const distance = entity ? distanceToCityKm(entity, level, condition.cityId) : Number.POSITIVE_INFINITY;
    const kmPerPx = level.base.domainScale
      ? level.base.domainScale / MAP_SIZE
      : MAP_KM_PER_PX;
    const targetKm = (condition.maxDistance ?? 72) * kmPerPx;
    const passed = distance <= targetKm;
    return {
      condition,
      passed,
      label: '水汽输送',
      actual: Number.isFinite(distance) ? `距 ${city} ${distance.toFixed(0)} km` : '水汽源丢失',
      target,
      progress: Number.isFinite(distance) ? clamp01(1 - distance / 200) : 0,
      detail: passed ? `水汽已进入 ${city} 目标区。` : `水汽仍在 ${city} 目标区外。`,
    };
  }

  if (condition.kind === 'typhoon') {
    const storms = entities.filter((item) => item.type === 'typhoon');
    const storm = storms.sort((a, b) => b.strength - a.strength)[0];
    const targetLabel = conditionTargetLabel(condition, level);
    if (!storm) {
      return {
        condition,
        passed: false,
        label: '台风',
        actual: '场上没有台风',
        target: targetLabel,
        progress: 0,
        detail: '需要在暖海面上放置一个台风系统。',
      };
    }
    const category = typhoonCategory(storm.strength);
    const minCategory = condition.minCategory ?? 0;
    const distanceKm =
      condition.cityId && level.cities.some((city) => city.id === condition.cityId)
        ? distanceToCityKm(storm, level, condition.cityId)
        : 0;
    const distance = condition.maxDistanceKm ?? Number.POSITIVE_INFINITY;
    const passed = category >= minCategory && distanceKm <= distance;
    const distanceText =
      condition.maxDistanceKm !== undefined
        ? `，距 ${cityLabel(level, condition.cityId)} ${distanceKm.toFixed(0)} km`
        : '';
    return {
      condition,
      passed,
      label: '台风',
      actual: `${typhoonCategoryName(category)}（−${storm.strength.toFixed(0)} hPa）${distanceText}`,
      target: targetLabel,
      progress: clamp01(
        Math.min(
          (category + 1) / Math.max(1, minCategory + 1),
          condition.maxDistanceKm !== undefined
            ? 1 - Math.max(0, distanceKm - condition.maxDistanceKm) / Math.max(1, condition.maxDistanceKm)
            : 1,
        ),
      ),
      detail: passed
        ? `台风已达到${typhoonCategoryName(category)}强度${distanceText}。`
        : `台风当前为${typhoonCategoryName(category)}${distanceText}，未满足目标。`,
    };
  }

  const weather = getWeather(cities, condition.cityId);
  if (!weather) {
    return {
      condition,
      passed: false,
      label: city,
      actual: '无观测',
      target,
      progress: 0,
      detail: `${city} 无可用观测。`,
    };
  }

  switch (condition.kind) {
    case 'vertical': {
      const minW = condition.minW ?? 0;
      const passed = weather.W > minW;
      return {
        condition,
        passed,
        label: `${city} 综合垂直速度`,
        actual: `低层 ${weather.wLow >= 0 ? '+' : ''}${weather.wLow.toFixed(2)} · 高层 ${weather.wHigh >= 0 ? '+' : ''}${weather.wHigh.toFixed(2)}`,
        target,
        progress: clamp01(weather.W / Math.max(0.7, minW * 4)),
        detail: passed
          ? `${city} 综合 W=${weather.W.toFixed(2)}，已形成净上升。`
          : `${city} 综合 W=${weather.W.toFixed(2)}，尚未形成上升。`,
      };
    }
    case 'airMass': {
      const expected = condition.airMass ?? 'neutral';
      const passed = weather.airMass === expected;
      return {
        condition,
        passed,
        label: `${city} 气团`,
        actual: `${weather.airMass}（T ${weather.T.toFixed(1)}°C / Q ${weather.Q.toFixed(1)}）`,
        target,
        progress: passed ? 1 : 0,
        detail: passed ? `${city} 已形成 ${expected} 气团。` : `${city} 当前为 ${weather.airMass} 气团。`,
      };
    }
    case 'wind': {
      const dirs = condition.fromDirs ?? [];
      const speed = condition.minSpeed ?? 0;
      const passed = weather.wind.speed >= speed && (dirs.length === 0 || dirs.includes(weather.wind.fromLabel));
      return {
        condition,
        passed,
        label: `${city} 风`,
        actual: `${weather.wind.fromLabel}风 ${weather.wind.speed.toFixed(1)} m/s`,
        target,
        progress: passed ? 1 : clamp01(weather.wind.speed / Math.max(1, speed)),
        detail: passed ? `${city} 风向与风速满足目标。` : `${city} 当前为${weather.wind.fromLabel}风 ${weather.wind.speed.toFixed(1)} m/s。`,
      };
    }
    case 'shear': {
      const minShear = condition.minShear ?? 0;
      const passed = weather.shear >= minShear;
      return {
        condition,
        passed,
        label: `${city} 风向切变`,
        actual: `切变 ${weather.shear.toFixed(0)}°`,
        target,
        progress: clamp01(weather.shear / Math.max(10, minShear)),
        detail: passed ? `${city} 附近存在明显风向切变。` : `${city} 风向切变不足。`,
      };
    }
    case 'dryline': {
      const minDryline = condition.minDryline ?? 0;
      const passed = weather.dryline >= minDryline;
      return {
        condition,
        passed,
        label: `${city} 干线`,
        actual: `干线 ${weather.dryline.toFixed(2)}`,
        target,
        progress: clamp01(weather.dryline / Math.max(0.02, minDryline)),
        detail: passed ? `${city} 位于干湿交界附近。` : `${city} 干湿对比不足。`,
      };
    }
    case 'stability': {
      const minStability = condition.minStability ?? Number.NEGATIVE_INFINITY;
      const maxStability = condition.maxStability ?? Number.POSITIVE_INFINITY;
      const passed = weather.stability >= minStability && weather.stability <= maxStability;
      return {
        condition,
        passed,
        label: `${city} 层结`,
        actual: `稳定度 ${weather.stability >= 0 ? '+' : ''}${weather.stability.toFixed(2)}`,
        target,
        progress: clamp01(0.5 + weather.stability * 4),
        detail: passed
          ? `${city} 层结符合目标。`
          : `${city} 层结为 ${weather.stability.toFixed(2)}，未进入目标区间。`,
      };
    }
    case 'rotation': {
      const minVorticity = condition.minVorticity ?? 0;
      const passed = weather.vorticity >= minVorticity;
      return {
        condition,
        passed,
        label: `${city} 旋转强度`,
        actual: `涡度 ${weather.vorticity.toFixed(0)} ×10⁻⁴ s⁻¹`,
        target,
        progress: clamp01(weather.vorticity / Math.max(1, minVorticity)),
        detail: passed
          ? `${city} 低层风场已经出现持续旋转，具备中气旋结构。`
          : `${city} 涡度 ${weather.vorticity.toFixed(0)}，旋转不足 ${minVorticity.toFixed(0)}；需要更强的风向切变与闭合环流。`,
      };
    }
    case 'highVertical': {
      const hasMin = condition.minW !== undefined;
      const hasMax = condition.maxW !== undefined;
      const minW = condition.minW ?? 0;
      const maxW = condition.maxW ?? 0;
      const passed =
        (!hasMin || weather.wHigh > minW) && (!hasMax || weather.wHigh <= maxW);
      return {
        condition,
        passed,
        label: `${city} 高层垂直速度`,
        actual: `高层 W ${weather.wHigh >= 0 ? '+' : ''}${weather.wHigh.toFixed(2)}`,
        target,
        progress: hasMax
          ? clamp01(1 - Math.max(0, weather.wHigh - maxW) / Math.max(1, maxW + 2))
          : clamp01(weather.wHigh / Math.max(0.5, minW * 4)),
        detail: passed
          ? `${city} 高层垂直运动符合目标。`
          : hasMax && weather.wHigh > maxW
            ? `${city} 高层 W=${weather.wHigh.toFixed(2)}，仍未压到 ${maxW.toFixed(2)} 以下。`
            : `${city} 高层上升不足。`,
      };
    }
    case 'hazard': {
      const expected = condition.hazard ?? 'thunderstorm';
      const passed = weather.hazard === expected;
      return {
        condition,
        passed,
        label: `${city} 高影响天气`,
        actual: weather.hazard === 'none' ? '无' : hazardLabel(weather.hazard),
        target,
        progress: passed ? 1 : 0,
        detail: passed
          ? `${city} 已出现${hazardLabel(expected)}。`
          : `${city} 当前为${weather.hazard === 'none' ? '一般天气' : hazardLabel(weather.hazard)}，尚未出现${hazardLabel(expected)}。`,
      };
    }
    case 'dry': {
      const maxR = condition.maxR ?? 0.5;
      const passed = weather.R <= maxR;
      return {
        condition,
        passed,
        label: `${city} 降水`,
        actual: `R ${weather.R.toFixed(2)} mm/3h`,
        target,
        progress: clamp01(1 - Math.max(0, weather.R - maxR) / Math.max(0.5, maxR * 3)),
        detail: passed
          ? `${city} 无有效地面降水。`
          : `${city} 已出现 ${weather.R.toFixed(2)} mm/3h 降水，不再是干雷暴。`,
      };
    }
    case 'pressureTendency': {
      if (!previous) {
        return {
          condition,
          passed: false,
          label: `${city} 气压变化`,
          actual: '需要上一回合',
          target,
          progress: 0,
          detail: `${city} 需要至少运行一回合后，才能比较气压变化。`,
        };
      }
      const delta = weather.pLow - previous.pLow;
      const min = condition.minDeltaP ?? 0;
      const passed = delta >= min;
      return {
        condition,
        passed,
        label: `${city} 气压变化`,
        actual: `ΔP ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} hPa`,
        target,
        progress: clamp01(delta / Math.max(0.5, min)),
        detail: passed
          ? `${city} 气压上升 ${delta.toFixed(1)} hPa。`
          : `${city} 气压变化 ${delta.toFixed(1)} hPa，尚未达到 ${min.toFixed(1)} hPa。`,
      };
    }
    case 'temperatureChange': {
      if (!previous) {
        return {
          condition,
          passed: false,
          label: `${city} 温度变化`,
          actual: '需要上一回合',
          target,
          progress: 0,
          detail: `${city} 需要至少运行一回合后，才能比较温度变化。`,
        };
      }
      const delta = weather.T - previous.T;
      const max = condition.maxDeltaT ?? 0;
      const passed = delta <= max;
      return {
        condition,
        passed,
        label: `${city} 温度变化`,
        actual: `ΔT ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}℃`,
        target,
        progress: clamp01(-delta / Math.max(0.5, -max)),
        detail: passed
          ? `${city} 降温 ${(-delta).toFixed(1)}℃。`
          : `${city} 温度变化 ${delta.toFixed(1)}℃，降温幅度不足。`,
      };
    }
    case 'windShift': {
      if (!previous) {
        return {
          condition,
          passed: false,
          label: `${city} 风向变化`,
          actual: '需要上一回合',
          target,
          progress: 0,
          detail: `${city} 需要至少运行一回合后，才能比较风向变化。`,
        };
      }
      const delta = angularDifference(weather.wind.fromDeg, previous.wind.fromDeg);
      const min = condition.minWindShift ?? 0;
      const passed = delta >= min;
      return {
        condition,
        passed,
        label: `${city} 风向变化`,
        actual: `Δ风向 ${delta.toFixed(0)}°`,
        target,
        progress: clamp01(delta / Math.max(1, min)),
        detail: passed
          ? `${city} 风向变化 ${delta.toFixed(0)}°。`
          : `${city} 风向变化仅 ${delta.toFixed(0)}°，尚未达到 ${min.toFixed(0)}°。`,
      };
    }
    case 'visibility': {
      const max = condition.maxVisibility;
      const min = condition.minVisibility;
      const passed = (max === undefined || weather.visibility <= max) && (min === undefined || weather.visibility >= min);
      return {
        condition,
        passed,
        label: `${city} 能见度`,
        actual: `${weather.visibility.toFixed(1)} km`,
        target,
        progress: max !== undefined ? clamp01(1 - Math.max(0, weather.visibility - max) / Math.max(1, max)) : 0.5,
        detail: passed ? `${city} 能见度满足目标。` : `${city} 能见度 ${weather.visibility.toFixed(1)} km，未达到目标。`,
      };
    }
    case 'moisture': {
      const minQ = condition.minQ ?? 0;
      const passed = weather.Q >= minQ;
      return {
        condition,
        passed,
        label: `${city} 水汽`,
        actual: `Q ${weather.Q.toFixed(1)} g/m³`,
        target,
        progress: clamp01(weather.Q / Math.max(1, minQ)),
        detail: passed ? `${city} 水汽含量已越过目标线。` : `${city} 仍缺少 ${(minQ - weather.Q).toFixed(1)} g/m³ 水汽。`,
      };
    }
    case 'rain': {
      const minR = condition.minR ?? 0.02;
      const passed =
        weather.R >= minR &&
        (condition.min24h === undefined || weather.rain24h >= condition.min24h) &&
        (condition.max24h === undefined || weather.rain24h <= condition.max24h);
      let progress = clamp01(weather.R / Math.max(0.4, minR * 3));
      if (condition.min24h !== undefined) {
        progress = clamp01(weather.rain24h / condition.min24h);
      } else if (condition.max24h !== undefined) {
        progress = clamp01(1 - Math.max(0, weather.rain24h - condition.max24h) / condition.max24h);
      }
      return {
        condition,
        passed,
        label: `${city} 降水`,
        actual: `R ${weather.R.toFixed(2)} mm/3h · 24 小时等效 ${weather.rain24h.toFixed(0)} mm`,
        target,
        progress,
        detail: passed
          ? `${city} 降水条件满足（${weather.rainGrade}）。`
          : `${city} 当前 ${weather.rainGrade}，未达到目标。`,
      };
    }
    case 'clear': {
      const passed = weather.R <= 0.001;
      return {
        condition,
        passed,
        label: `${city} 天气`,
        actual: `R ${weather.R.toFixed(2)} mm`,
        target,
        progress: clamp01(1 - weather.R / 2.4),
        detail: passed ? `${city} 已转晴。` : `${city} 仍有降水。`,
      };
    }
    case 'temperature': {
      const passed =
        (condition.minT === undefined || weather.T > condition.minT) &&
        (condition.maxT === undefined || weather.T < condition.maxT);
      let progress = 0.5;
      if (condition.minT !== undefined) {
        progress = clamp01((weather.T - level.base.T) / Math.max(0.1, condition.minT - level.base.T));
      } else if (condition.maxT !== undefined) {
        progress = clamp01((level.base.T - weather.T) / Math.max(0.1, level.base.T - condition.maxT));
      }
      return {
        condition,
        passed,
        label: `${city} 温度`,
        actual: `T ${weather.T.toFixed(1)}°C`,
        target,
        progress,
        detail: passed ? `${city} 温度已进入目标范围。` : `${city} 温度尚未进入目标范围。`,
      };
    }
    case 'pressure': {
      const minP = condition.minP ?? Number.NEGATIVE_INFINITY;
      const passed = weather.P >= minP && (condition.maxP === undefined || weather.P <= condition.maxP);
      return {
        condition,
        passed,
        label: `${city} 气压`,
        actual: `P ${weather.P.toFixed(1)} hPa`,
        target,
        progress:
          condition.minP !== undefined && condition.maxP !== undefined
            ? passed
              ? 1
              : clamp01(1 - Math.min(
                  Math.abs(weather.P - condition.minP),
                  Math.abs(weather.P - condition.maxP),
                ) / 12)
            : clamp01(weather.P / Math.max(1, minP)),
        detail: passed
          ? `${city} 气压落在目标区间。`
          : weather.P < minP
            ? `${city} 气压仍低于 ${minP.toFixed(0)} hPa。`
            : `${city} 气压已高于 ${(condition.maxP ?? 0).toFixed(0)} hPa 上限。`,
      };
    }
    case 'front': {
      const expected = condition.frontType ?? 'stationary';
      const passed = weather.frontType === expected;
      return {
        condition,
        passed,
        label: `${city} 锋面`,
        actual: weather.frontType === 'none' ? '无锋面' : frontLabel(weather.frontType),
        target,
        progress: passed ? 1 : 0,
        detail: passed ? `${city} 已形成目标锋面类型。` : `${city} 当前为${frontLabel(weather.frontType)}，尚未形成${frontLabel(expected)}。`,
      };
    }
  }
}

/**
 * Window target: judge a range of rounds instead of the last snapshot.
 * `any` = the event happened somewhere inside the window; `all` = it held for
 * the whole window (a duration / side-effect constraint).
 */
function evaluateWindow(
  target: Extract<LevelDefinition['target'], { kind: 'window' }>,
  level: LevelDefinition,
  history: WeatherRecord[],
): GoalEvaluation {
  const from = Math.max(1, Math.min(target.fromRound, target.toRound));
  const to = Math.max(target.fromRound, target.toRound);
  const hours = `${(from - 1) * 3}–${to * 3} 小时`;
  const label = `第 ${from}–${to} 回合（${hours}）`;
  const records = history.filter((record) => record.round >= from && record.round <= to);
  if (records.length === 0) {
    return {
      passed: false,
      holding: from > 1,
      actual: `尚未进入第 ${from} 回合`,
      target: label,
      progress: 0,
      detail: `目标窗口是第 ${from}–${to} 回合。`,
    };
  }

  const judged = records.map((record) => {
    const previous = history[history.indexOf(record) - 1];
    const evaluations = target.conditions.map((condition) =>
      evaluateCondition(
        condition,
        level,
        record.cities,
        record.entities ?? [],
        previous?.cities[condition.cityId],
      ),
    );
    return { record, evaluations, result: aggregate(evaluations, label) };
  });

  if ((target.mode ?? 'any') === 'all') {
    const merged = aggregate(judged.flatMap((item) => item.evaluations), label);
    return {
      ...merged,
      actual: `${label}：${merged.actual}`,
      detail: `${merged.detail}（窗口内每一回合都必须满足）`,
    };
  }

  const best = judged.reduce((a, b) => (b.result.progress > a.result.progress ? b : a));
  return {
    ...best.result,
    holding: judged.some((item) => item.result.passed) === false && judged.length < to - from + 1,
    actual: `${label} · 第 ${best.record.round} 回合：${best.result.actual}`,
    detail: `${best.result.detail}（窗口内任意一回合满足即可）`,
  };
}

function aggregate(
  evaluations: ConditionEvaluation[],
  target: string,
): GoalEvaluation {
  const passed = evaluations.length > 0 && evaluations.every((item) => item.passed);
  const progress =
    evaluations.length > 0
      ? evaluations.reduce((sum, item) => sum + item.progress, 0) / evaluations.length
      : 0;
  return {
    passed,
    actual: evaluations.map((item) => item.actual).join(' · ') || '暂无数据',
    target,
    progress,
    detail: evaluations.map((item) => item.detail).join(' '),
    conditionResults: evaluations,
  };
}

function lastRecords(history: WeatherRecord[], rounds: number): WeatherRecord[] {
  return history.slice(Math.max(0, history.length - rounds));
}

function currentConditionsPass(
  conditions: WeatherCondition[],
  level: LevelDefinition,
  record: WeatherRecord | undefined,
): boolean {
  if (!record) return false;
  return conditions.every(
    (condition) =>
      evaluateCondition(condition, level, record.cities, record.entities ?? []).passed,
  );
}

function evaluatePersistentRain(
  target: Extract<GoalTarget, { kind: 'persistentRain' }>,
  level: LevelDefinition,
  history: WeatherRecord[],
): GoalEvaluation {
  const records = lastRecords(history, target.rounds);
  const current = history[history.length - 1];
  const currentPass = currentConditionsPass(target.conditions, level, current);
  let consecutive = 0;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (currentConditionsPass(target.conditions, level, records[index])) consecutive += 1;
    else break;
  }
  const enough = records.length >= target.rounds;
  const passed = enough && consecutive >= target.rounds;
  const holding = !passed && currentPass;

  const targetText = target.conditions.map((item) => conditionTargetLabel(item, level)).join(' + ');
  const detail = passed
    ? `已连续 ${target.rounds} 回合满足降水条件。`
    : holding
      ? `本回合条件满足，连续记录 ${consecutive}/${target.rounds}。继续运行下一回合。`
      : `需要连续 ${target.rounds} 回合满足条件，当前连续 ${consecutive}/${target.rounds}。`;
  return {
    passed,
    holding,
    actual: `连续 ${consecutive}/${target.rounds} 回合`,
    target: targetText,
    progress: clamp01(consecutive / target.rounds),
    detail,
    conditionResults: target.conditions.map((condition) =>
      evaluateCondition(condition, level, current?.cities ?? {}),
    ),
  };
}

function evaluatePersistent(
  target: Extract<GoalTarget, { kind: 'persistent' }>,
  level: LevelDefinition,
  history: WeatherRecord[],
): GoalEvaluation {
  const records = lastRecords(history, target.rounds);
  const current = history[history.length - 1];
  const currentPass = currentConditionsPass(target.conditions, level, current);
  let consecutive = 0;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (currentConditionsPass(target.conditions, level, records[index])) consecutive += 1;
    else break;
  }
  const enough = records.length >= target.rounds;
  const passed = enough && consecutive >= target.rounds;
  const holding = !passed && currentPass;
  const targetText = target.conditions
    .map((item) => conditionTargetLabel(item, level))
    .join(' + ');
  return {
    passed,
    holding,
    actual: `连续 ${consecutive}/${target.rounds} 回合`,
    target: `${targetText} · 连续 ${target.rounds} 回合`,
    progress: clamp01(consecutive / target.rounds),
    detail: passed
      ? `已连续 ${target.rounds} 回合维持目标状态。`
      : holding
        ? `本回合条件成立，连续记录 ${consecutive}/${target.rounds}。继续运行下一回合。`
        : `需要连续 ${target.rounds} 回合维持条件，当前连续 ${consecutive}/${target.rounds}。`,
    conditionResults: target.conditions.map((condition) =>
      evaluateCondition(
        condition,
        level,
        current?.cities ?? {},
        current?.entities ?? [],
      ),
    ),
  };
}

function evaluateAccumulatedRain(  target: Extract<GoalTarget, { kind: 'accumulatedRain' }>,
  level: LevelDefinition,
  history: WeatherRecord[],
): GoalEvaluation {
  const records = lastRecords(history, target.rounds);
  const current = history[history.length - 1];
  const currentPass = currentConditionsPass(target.conditions, level, current);

  let consecutive = 0;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (currentConditionsPass(target.conditions, level, records[index])) consecutive += 1;
    else break;
  }

  const usable = records.slice(Math.max(0, records.length - consecutive));
  const cityId = target.conditions.find((item) => item.kind === 'rain')?.cityId ?? 'A';
  const total = usable.reduce((sum, record) => sum + (record.cities[cityId]?.R ?? 0), 0);
  const equivalent = usable.length > 0 ? total * (24 / (usable.length * 3)) : 0;
  const enough = consecutive >= target.rounds;
  const passed = enough && equivalent >= target.min24h;
  const holding = !passed && currentPass;

  return {
    passed,
    holding,
    actual: `累计 ${total.toFixed(1)} mm · 24 小时等效 ${equivalent.toFixed(0)} mm`,
    target: `连续 ${target.rounds} 回合，累计 ≥ ${target.min24h.toFixed(0)} mm（24 小时等效）`,
    progress: clamp01(Math.min(consecutive / target.rounds, equivalent / Math.max(1, target.min24h))),
    detail: passed
      ? `${cityLabel(level, cityId)} 已连续 ${target.rounds} 回合降水，累计达到目标。`
      : holding
        ? `本回合满足降水条件，已连续 ${consecutive}/${target.rounds} 回合，24 小时等效 ${equivalent.toFixed(0)} mm。继续推演。`
        : `需要连续 ${target.rounds} 回合降水，当前连续 ${consecutive}/${target.rounds}，24 小时等效 ${equivalent.toFixed(0)} mm。`,
    conditionResults: target.conditions.map((condition) =>
      evaluateCondition(condition, level, current?.cities ?? {}),
    ),
  };
}

function evaluateSequence(
  target: Extract<GoalTarget, { kind: 'sequence' }>,
  level: LevelDefinition,
  history: WeatherRecord[],
): GoalEvaluation {
  const stepCount = target.conditions.length;
  let completed = 0;
  let failedIndex = -1;

  for (let index = 0; index < Math.min(stepCount, history.length); index += 1) {
    const condition = target.conditions[index];
    const passed = evaluateCondition(
      condition,
      level,
      history[index].cities,
      history[index].entities ?? [],
    ).passed;
    if (passed) completed += 1;
    else {
      failedIndex = index;
      break;
    }
  }

  const enough = history.length >= stepCount;
  const passed = enough && completed >= stepCount;
  const holding = !passed && completed === history.length && history.length < stepCount;
  const actual = `阶段 ${Math.min(completed, stepCount)}/${stepCount}`;

  return {
    passed,
    holding,
    actual,
    target: target.conditions.map((item) => conditionTargetLabel(item, level)).join(' → '),
    progress: clamp01(completed / stepCount),
    detail: passed
      ? '多回合天气序列已经完整出现。'
      : failedIndex >= 0
        ? `第 ${failedIndex + 1} 回合条件未达成，可使用 Ctrl+Z 回退后重新安排。`
        : holding
          ? `第 ${completed} 阶段已达成，完成下一回合的天气目标。`
          : `等待第 ${Math.min(completed + 1, stepCount)} 阶段。`,
    conditionResults: target.conditions.map((condition, index) => {
      const record = history[index];
      if (!record) {
        return {
          condition,
          passed: false,
          label: `阶段 ${index + 1}`,
          actual: '未运行',
          target: conditionTargetLabel(condition, level),
          progress: 0,
          detail: `第 ${index + 1} 回合尚未推演。`,
        };
      }
      return evaluateCondition(
        condition,
        level,
        record.cities,
        record.entities ?? [],
        index > 0 ? history[index - 1].cities[condition.cityId] : undefined,
      );
    }),
  };
}

export function evaluateGoal(
  level: LevelDefinition,
  snapshot: SimulationSnapshot,
  context: GoalContext = { history: [] },
): GoalEvaluation {
  const target = level.target;

  if (target.kind === 'multi') {
    const previousRecord =
      context.history.length >= 2 ? context.history[context.history.length - 2] : undefined;
    const evaluations = target.conditions.map((condition) =>
      evaluateCondition(
        condition,
        level,
        snapshot.cities,
        snapshot.entities,
        previousRecord?.cities[condition.cityId],
      ),
    );
    return aggregate(
      evaluations,
      target.conditions.map((condition) => conditionTargetLabel(condition, level)).join(' + '),
    );
  }

  if (target.kind === 'persistent') {
    const history = context.history.length > 0
      ? context.history
      : [{ round: 1, cities: snapshot.cities, entities: snapshot.entities }];
    return evaluatePersistent(target, level, history);
  }

  if (target.kind === 'persistentRain') {
    const history = context.history.length > 0
      ? context.history
      : [{ round: 1, cities: snapshot.cities, entities: snapshot.entities }];
    return evaluatePersistentRain(target, level, history);
  }

  if (target.kind === 'accumulatedRain') {
    const history = context.history.length > 0
      ? context.history
      : [{ round: 1, cities: snapshot.cities, entities: snapshot.entities }];
    return evaluateAccumulatedRain(target, level, history);
  }

  if (target.kind === 'sequence') {
    const history = context.history.length > 0
      ? context.history
      : [{ round: 1, cities: snapshot.cities, entities: snapshot.entities }];
    return evaluateSequence(target, level, history);
  }

  if (target.kind === 'hourWindow') {
    const city = cityLabel(level, target.cityId);
    const samples = (snapshot.hourly?.[target.cityId] ?? []).filter(
      (sample) => sample.hour >= target.fromHour && sample.hour <= target.toHour,
    );
    const label = `${city} ${target.fromHour}–${target.toHour} 小时`;
    // Each diagnostic has its own peak: the hour with the most moisture is not
    // necessarily the hour with the strongest rain or ascent.
    const maxQ = samples.reduce((best, sample) => Math.max(best, sample.Q), 0);
    const maxW = samples.reduce((best, sample) => Math.max(best, sample.W), Number.NEGATIVE_INFINITY);
    const maxR = samples.reduce((best, sample) => Math.max(best, sample.R), 0);
    const qOk = target.minQ === undefined || maxQ >= target.minQ;
    const wOk = target.minW === undefined || maxW >= target.minW;
    const rOk =
      (target.minR === undefined || maxR >= target.minR) &&
      (target.maxR === undefined || maxR <= target.maxR);
    const frontOk =
      target.frontType === undefined ||
      samples.some(
        (sample) =>
          sample.hour >= target.fromHour &&
          sample.hour <= target.toHour &&
          sample.frontType === target.frontType,
      );
    const passed = samples.length > 0 && qOk && wOk && rOk && frontOk;
    const parts: string[] = [];
    if (target.minQ !== undefined) parts.push(`Q ${maxQ.toFixed(1)} / ${target.minQ}`);
    if (target.minW !== undefined) parts.push(`W ${maxW.toFixed(1)} / ${target.minW}`);
    if (target.minR !== undefined) parts.push(`R ${maxR.toFixed(2)} / ${target.minR}`);
    if (target.maxR !== undefined) parts.push(`峰值 R ≤ ${target.maxR}`);
    if (target.frontType !== undefined) parts.push(`锋面 ${target.frontType}`);
    return {
      passed,
      actual: samples.length === 0 ? '本回合没有逐小时样本' : parts.join(' · '),
      target: label,
      progress: passed ? 1 : 0.4,
      detail: passed
        ? `${label}内出现了满足条件的时段。`
        : `${label}内没有达到阈值。`,
    };
  }

  if (target.kind === 'window') {
    const history = context.history.length > 0
      ? context.history
      : [{ round: 1, cities: snapshot.cities, entities: snapshot.entities }];
    return evaluateWindow(target, level, history);
  }

  const previousRecord =
    context.history.length >= 2 ? context.history[context.history.length - 2] : undefined;
  const result = evaluateCondition(
    target,
    level,
    snapshot.cities,
    snapshot.entities,
    previousRecord?.cities[target.cityId],
  );
  return {
    passed: result.passed,
    actual: result.actual,
    target: result.target,
    progress: result.progress,
    detail: result.detail,
    conditionResults: [result],
  };
}

export function cityById(level: LevelDefinition, id: string): City | undefined {
  return level.cities.find((city) => city.id === id);
}
