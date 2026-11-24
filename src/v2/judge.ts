/**
 * V2 · 判题。
 * 设计锚点：docs/V2/03 §9、§11、§13。
 *
 * 只输出「达成 / 未通过」与断点诊断；没有星级、评分、成功语。
 * 判定对象是过程链 + 空间形态 + 结果兜底，不是预设步骤。
 */

import type {
  CheckResult,
  CitySample,
  Frame,
  GoalCheck,
  JudgeResult,
  LevelDef,
  SpatialTest,
} from './core/types';
import { Grid } from './core/grid';
import {
  centerDisplacement,
  centerTrack,
  circulationSign,
  distanceKm,
  maxRainRadius,
  minCenterSeparation,
} from './diag/diagnostics';
import { RECIPE_LABELS } from './sim/engine';
import { REFERENCE_PRESSURE_HPA } from './physics/thermo';

function siteValue(site: CitySample, metric: string): number {
  switch (metric) {
    case 'p':
      return site.p;
    case 't2m':
      return site.t2m;
    case 'q':
      return site.q;
    case 'rh':
      return site.rh;
    case 'cc':
      return site.cc;
    case 'clearUnderHigh':
      // 「高压晴空」必须真的在高压底下：没有高压时天空本来就晴，
      // 不能算这条过程成立。
      return site.p >= 2 ? site.cc : Number.NaN;
    case 'precipRate':
      return site.precipRate;
    case 'precipAcc':
      return site.precipAcc;
    case 'wind10':
      return site.wind10;
    case 'windDir':
      return site.windDir;
    case 'w':
      return site.w;
    case 'divergence':
      return site.divergence;
    case 'crossAngle':
      return site.crossAngle;
    default:
      return 0;
  }
}

function domainValue(frame: Frame, metric: string): number {
  const s = frame.stats;
  switch (metric) {
    case 'minP':
      return s.minP;
    case 'maxP':
      return s.maxP;
    case 'maxW':
      return s.maxW;
    case 'maxCloud':
      return s.maxCloud;
    case 'maxRain':
      return s.maxRain;
    case 'maxAcc':
      return s.maxAcc;
    case 'maxWind':
      return s.maxWind;
    case 'meanQ':
      return s.meanQ;
    case 'rainRadiusKm':
      return s.rainRadiusKm;
    case 'maxRainRadiusKm':
      return maxRainRadius([frame]);
    case 'lowCount':
      return frame.centers.filter((c) => c.type === 'L').length;
    case 'highCount':
      return frame.centers.filter((c) => c.type === 'H').length;
    case 'closedIsobarCount':
      return frame.centers.reduce((sum, c) => sum + c.closedIsobars, 0);
    default:
      return 0;
  }
}

function scalarValue(frame: Frame, check: GoalCheck): number {
  if (check.at === 'domain') return domainValue(frame, check.metric);
  if (check.at === 'windward' || check.at === 'leeward') {
    if (check.metric === 'precipAcc') {
      return check.at === 'windward' ? frame.stats.windwardRain : frame.stats.leewardRain;
    }
    if (check.metric === 'precipRate') {
      // 迎风 / 背风没有逐帧率，用累计量近似。
      return check.at === 'windward' ? frame.stats.windwardRain : frame.stats.leewardRain;
    }
    return domainValue(frame, check.metric);
  }
  const site = frame.sites[check.siteId ?? ''];
  return site ? siteValue(site, check.metric) : 0;
}

/** 需要跨帧计算的聚合量。 */
function aggregateValue(check: GoalCheck, frames: readonly Frame[], level: LevelDef): number {
  const window = frames.length > 0 ? frames : [];
  switch (check.metric) {
    case 'lowDisplacementKm': {
      const track = centerTrack(window, 'L');
      if (track.length < 2) return 0;
      let max = 0;
      for (const point of track) {
        max = Math.max(max, centerDisplacement(track[0], point));
      }
      return max;
    }
    case 'highDisplacementKm': {
      const track = centerTrack(window, 'H');
      if (track.length < 2) return 0;
      let max = 0;
      for (const point of track) {
        max = Math.max(max, centerDisplacement(track[0], point));
      }
      return max;
    }
    case 'deflectAngle': {
      const track = centerTrack(window, 'L');
      if (track.length < 4) return 0;
      // 前 2 段定「初始航向」，后 2 段定「末段航向」。用中点会把
      // 「先被高压推开、再绕行」的转向整个丢掉。
      const first = track[0];
      const early = track[Math.min(2, track.length - 1)];
      const late = track[Math.max(0, track.length - 3)];
      const last = track[track.length - 1];
      const v1x = early.xKm - first.xKm;
      const v1y = early.yKm - first.yKm;
      const v2x = last.xKm - late.xKm;
      const v2y = last.yKm - late.yKm;
      const s1 = Math.hypot(v1x, v1y);
      const s2 = Math.hypot(v2x, v2y);
      if (s1 < 5 || s2 < 5) return 0;
      const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (s1 * s2)));
      return (Math.acos(cos) * 180) / Math.PI;
    }
    case 'blockDistanceKm': {
      const lows = centerTrack(window, 'L');
      const highs = centerTrack(window, 'H');
      if (lows.length === 0 || highs.length === 0) return Infinity;
      let min = Infinity;
      for (const low of lows) {
        for (const high of highs) {
          min = Math.min(min, centerDisplacement(low, high));
        }
      }
      return min;
    }
    case 'minCenterSepKm': {
      // 只统计“低压—高压”这类异性系统之间的距离；同一低压被急流
      // 撕成两个极值点属于诊断碎片，不应算成两个系统互相干扰。
      let min = Infinity;
      for (const frame of window) {
        const all = frame.centers;
        for (let a = 0; a < all.length; a += 1) {
          for (let b = a + 1; b < all.length; b += 1) {
            if (all[a].type === all[b].type) continue;
            min = Math.min(min, centerDisplacement(all[a], all[b]));
          }
        }
      }
      return min === Infinity ? 0 : min;
    }
    case 'monotonicRain': {
      const last = window[window.length - 1];
      const a = last.sites['A']?.precipAcc ?? 0;
      const b = last.sites['B']?.precipAcc ?? 0;
      const c = last.sites['C']?.precipAcc ?? 0;
      return a <= b && b <= c && c > 0.25 ? 1 : 0;
    }
    case 'warmColdRatio': {
      const last = window[window.length - 1];
      const a = last.sites['A']?.precipAcc ?? 0;
      const b = Math.max(last.sites['B']?.precipAcc ?? 0, 0.05);
      return a / b;
    }
    case 'rainNearSite': {
      let best = 0;
      let bestDist = Infinity;
      for (const frame of window) {
        if (frame.stats.rainRadiusKm > best) {
          best = frame.stats.rainRadiusKm;
          const site = level.scene.sites.find((s) => s.id === check.siteId);
          if (site) {
            bestDist = Math.hypot(
              frame.stats.rainCentroidXKm - site.xKm,
              frame.stats.rainCentroidYKm - site.yKm,
            );
          }
        }
      }
      return bestDist === Infinity ? Infinity : bestDist;
    }
    case 'lowNearSite': {
      let bestDist = Infinity;
      for (const frame of window) {
        const low = frame.centers.find((c) => c.type === 'L');
        const site = level.scene.sites.find((s) => s.id === check.siteId);
        if (low && site) {
          bestDist = Math.min(bestDist, distanceKm(low.xKm, low.yKm, site.xKm, site.yKm));
        }
      }
      return bestDist === Infinity ? Infinity : bestDist;
    }
    case 'doubleLowOutcome': {
      let separated = false;
      for (const frame of window) {
        const lows = frame.centers.filter((c) => c.type === 'L');
        if (lows.length >= 2 && minCenterSeparation(frame.centers, 'L') >= 80) {
          separated = true;
          break;
        }
      }
      const last = window[window.length - 1];
      const merged =
        !!last &&
        last.centers.some(
          (c) => c.type === 'L' && Math.abs(c.value) >= 14 && c.radiusKm >= 55,
        );
      return separated || merged ? 1 : 0;
    }
    case 'ccw': {
      const grid = new Grid(level.scene.domainKm, level.scene.n);
      let max = 0;
      for (const frame of window) {
        const low = frame.centers.find((c) => c.type === 'L');
        if (!low) continue;
        max = Math.max(max, circulationSign(low, frame.u, frame.v, grid));
      }
      return max;
    }
    default:
      return 0;
  }
}

const AGGREGATE_METRICS = new Set([
  'lowDisplacementKm',
  'highDisplacementKm',
  'deflectAngle',
  'blockDistanceKm',
  'minCenterSepKm',
  'monotonicRain',
  'warmColdRatio',
  'rainNearSite',
  'lowNearSite',
  'doubleLowOutcome',
  'ccw',
]);

function evaluate(check: GoalCheck, frames: readonly Frame[], level: LevelDef): CheckResult {
  const required = check.required !== false;
  const inWindow = frames.filter(
    (frame) => frame.hour >= check.windowH[0] && frame.hour <= check.windowH[1],
  );

  if (inWindow.length === 0) {
    return {
      id: check.id,
      label: check.label,
      ok: false,
      required,
      value: NaN,
      atHour: null,
      detail: '时间窗内没有关键帧',
    };
  }

  if (AGGREGATE_METRICS.has(check.metric)) {
    const value = aggregateValue(check, inWindow, level);
    const ok = compare(value, check);
    return {
      id: check.id,
      label: check.label,
      ok,
      required,
      value,
      atHour: inWindow[inWindow.length - 1].hour,
      detail: aggregateDetail(check, value),
    };
  }

  let best = check.op === '<=' ? Infinity : -Infinity;
  let atHour: number | null = null;

  if (check.op === 'between') {
    const lo = check.value;
    const hi = check.value2 ?? check.value;
    let nearest = Infinity;
    let nearestValue = lo;
    for (const frame of inWindow) {
      const value = scalarValue(frame, check);
      const distance =
        value < lo ? lo - value : value > hi ? value - hi : 0;
      if (distance < nearest) {
        nearest = distance;
        nearestValue = value;
      }
      if (atHour === null && value >= lo && value <= hi) atHour = frame.hour;
    }
    best = nearestValue;
    return {
      id: check.id,
      label: check.label,
      ok: atHour !== null,
      required,
      value: best,
      atHour,
      detail: scalarDetail(check, best, atHour),
    };
  }

  for (const frame of inWindow) {
    const value = scalarValue(frame, check);
    if (check.op === '<=') {
      if (value < best) best = value;
      if (atHour === null && value <= check.value) atHour = frame.hour;
    } else {
      if (value > best) best = value;
      if (atHour === null && value >= check.value) atHour = frame.hour;
    }
  }
  const ok = compare(best, check);
  return {
    id: check.id,
    label: check.label,
    ok,
    required,
    value: best,
    atHour,
    detail: scalarDetail(check, best, atHour),
  };
}

function compare(value: number, check: GoalCheck): boolean {
  if (!Number.isFinite(value)) return false;
  if (check.op === '>=') return value >= check.value;
  if (check.op === '<=') return value <= check.value;
  return value >= check.value && value <= (check.value2 ?? check.value);
}

function scalarDetail(check: GoalCheck, value: number, atHour: number | null): string {
  const unit = metricUnit(check.metric);
  const pressure = isPressureMetric(check.metric);
  const asDisplay = (raw: number): string =>
    pressure ? `${(REFERENCE_PRESSURE_HPA + raw).toFixed(0)}` : `${raw}`;
  const target =
    check.op === 'between'
      ? `${asDisplay(check.value)}–${asDisplay(check.value2 ?? check.value)}`
      : `${check.op} ${asDisplay(check.value)}`;
  return `实测 ${formatValue(value, check.metric)}${unit}（目标 ${target}${unit}）` +
    (atHour !== null ? ` · 首次出现在第 ${atHour} 小时` : '');
}

function aggregateDetail(check: GoalCheck, value: number): string {
  const unit = metricUnit(check.metric);
  return `实测 ${formatValue(value, check.metric)}${unit}`;
}

function isPressureMetric(metric: string): boolean {
  return metric === 'p' || metric === 'minP' || metric === 'maxP';
}

function metricUnit(metric: string): string {
  if (isPressureMetric(metric)) return ' hPa';
  if (metric === 't2m') return ' ℃';
  if (metric === 'q' || metric === 'meanQ') return ' g/kg';
  if (metric === 'rh') return '%';
  if (metric === 'w') return ' cm/s';
  if (metric === 'precipRate') return ' mm/h';
  if (metric === 'precipAcc') return ' mm';
  if (metric === 'wind10') return ' m/s';
  if (metric === 'windDir' || metric === 'crossAngle' || metric === 'deflectAngle') return '°';
  if (metric.includes('Km') || metric.includes('Radius')) return ' km';
  return '';
}

function formatValue(value: number, metric: string): string {
  if (!Number.isFinite(value)) return '—';
  if (metric === 'monotonicRain') return value >= 1 ? '单调递增' : '未单调';
  if (metric === 'ccw') return value >= 0 ? '逆时针' : '顺时针';
  const digits =
    isPressureMetric(metric)
      ? 1
      : metric === 'q' || metric === 'meanQ'
        ? 1
        : metric === 'w'
          ? 0
          : 1;
  return isPressureMetric(metric)
    ? (REFERENCE_PRESSURE_HPA + value).toFixed(digits)
    : value.toFixed(digits);
}

function morphologyValue(frame: Frame, metric: string): number {
  const m = frame.morphology;
  if (!m) return Number.NaN;
  const value = (m as unknown as Record<string, unknown>)[metric];
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
}

function compareValue(value: number, op: SpatialTest['assertions'][number]['op'], a: number, b?: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (op === '>=') return value >= a;
  if (op === '<=') return value <= a;
  return value >= a && value <= (b ?? a);
}

/**
 * 空间断言：在各自时间窗内取最优帧（>= 取最大、<= 取最小、
 * between 取最接近区间），再与阈值比较。它与普通 GoalCheck 一样
 * 返回 CheckResult，因此结果弹窗/目标条可复用。
 */
function evaluateSpatial(test: SpatialTest, frames: readonly Frame[]): CheckResult {
  const required = test.required !== false;
  const details: string[] = [];
  let ok = true;
  let first = Number.NaN;
  let atHour: number | null = null;
  for (const assertion of test.assertions) {
    const window = frames.filter(
      (frame) => frame.hour >= assertion.windowH[0] && frame.hour <= assertion.windowH[1],
    );
    if (window.length === 0) {
      ok = false;
      details.push(`${assertion.label}：时间窗内没有关键帧`);
      continue;
    }
    let best = assertion.op === '<=' ? Infinity : -Infinity;
    let bestHour: number | null = null;
    if (assertion.op === 'between') {
      const lo = assertion.value;
      const hi = assertion.value2 ?? assertion.value;
      let nearest = Infinity;
      best = lo;
      for (const frame of window) {
        const value = morphologyValue(frame, assertion.metric);
        if (!Number.isFinite(value)) continue;
        const distance = value < lo ? lo - value : value > hi ? value - hi : 0;
        if (distance < nearest) {
          nearest = distance;
          best = value;
          bestHour = frame.hour;
        }
      }
      const pass = compareValue(best, assertion.op, lo, hi);
      ok = ok && pass;
      details.push(`${assertion.label}：${best.toFixed(2)}（目标 ${lo}–${hi}）`);
      if (!Number.isFinite(first)) first = best;
      if (bestHour !== null) atHour = bestHour;
    } else {
      for (const frame of window) {
        const value = morphologyValue(frame, assertion.metric);
        if (!Number.isFinite(value)) continue;
        if (assertion.op === '<=' ? value < best : value > best) {
          best = value;
          bestHour = frame.hour;
        }
      }
      const pass = compareValue(best, assertion.op, assertion.value);
      ok = ok && pass;
      details.push(
        `${assertion.label}：${Number.isFinite(best) ? best.toFixed(2) : '—'}（目标 ${
          assertion.op
        } ${assertion.value}）`,
      );
      if (!Number.isFinite(first)) first = best;
      if (bestHour !== null) atHour = atHour ?? bestHour;
    }
  }
  return {
    id: test.id,
    label: test.label,
    ok,
    required,
    value: first,
    atHour,
    detail: details.join(' · '),
  };
}

export function judge(level: LevelDef, frames: readonly Frame[]): JudgeResult {
  const checks = [...level.chain, ...level.fallback];
  const results = checks.map((check) => evaluate(check, frames, level));
  const spatialResults = (level.spatial ?? []).map((test) => evaluateSpatial(test, frames));
  const allResults = [...results, ...spatialResults];
  const failed = allResults.filter((result) => result.required && !result.ok);
  const pass = failed.length === 0;

  const recipes = new Set<string>();
  for (const frame of frames) for (const recipe of frame.recipes) recipes.add(recipe);
  const names = [...recipes].map((id) => RECIPE_LABELS[id] ?? id);

  const detail = pass
    ? `过程成立：${names.length > 0 ? names.join('、') : '目标判据全部满足'}`
    : `断在：${failed.map((result) => result.label).join('；')}`;

  return { pass, checks: allResults, failed, recipes: [...recipes], detail };
}
