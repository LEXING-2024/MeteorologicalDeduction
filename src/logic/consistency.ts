import { MAP_SIZE } from '../config/constants';
import type { BaseConditions, SimulationSnapshot, WeatherEntity } from './types';

/**
 * Physical consistency score.
 *
 * The goal system asks "did the weather happen"; this asks "could it happen".
 * Every check is a real constraint, so the score doubles as a teaching device:
 * a player who stacks three lows into 952 hPa, or puts a 940 hPa typhoon on a
 * 24 °C sea, loses points and is told exactly which law was broken.
 */

export interface ConsistencyCheck {
  id: string;
  label: string;
  passed: boolean;
  penalty: number;
  detail: string;
}

export interface ConsistencyReport {
  score: number;
  checks: ConsistencyCheck[];
}

/** Emanuel-style upper bound on intensity, expressed as a central pressure floor. */
export function typhoonPressureFloor(sst: number): number {
  if (sst >= 30) return 910;
  if (sst >= 28) return 940 - (30 - sst) * 15;
  if (sst >= 26.5) return 960 - (28 - sst) * (20 / 1.5);
  return 985 + (26.5 - sst) * 6;
}

function pressureFloorPenalty(pressure: number): number {
  if (pressure < 870) return Math.ceil((870 - pressure) / 5) * 15;
  if (pressure > 1085) return Math.ceil((pressure - 1085) / 5) * 10;
  return 0;
}

function angleBetweenDeg(a: number, b: number): number {
  return Math.abs((((a - b + 540) % 360) + 360) % 360 - 180);
}

function nearestTemperatureGradient(
  snapshot: SimulationSnapshot,
  x: number,
  y: number,
): { gx: number; gy: number } | null {
  const grid = snapshot.grid;
  const n = grid.n;
  if (!n) return null;
  const i = Math.max(1, Math.min(n - 2, Math.round(x / grid.spacing)));
  const j = Math.max(1, Math.min(n - 2, Math.round(y / grid.spacing)));
  const at = (ii: number, jj: number): number => grid.tLow[jj * n + ii];
  const gx = (at(i + 1, j) - at(i - 1, j)) / (2 * grid.spacing);
  const gy = (at(i, j + 1) - at(i, j - 1)) / (2 * grid.spacing);
  if (!Number.isFinite(gx) || !Number.isFinite(gy)) return null;
  return { gx, gy };
}

export function evaluateConsistency(
  entities: WeatherEntity[],
  base: BaseConditions,
  snapshot: SimulationSnapshot | null,
): ConsistencyReport {
  const checks: ConsistencyCheck[] = [];
  const pressureCenters = entities.filter(
    (entity) =>
      entity.type === 'coldHigh' ||
      entity.type === 'warmHigh' ||
      entity.type === 'coldLow' ||
      entity.type === 'warmLow' ||
      entity.type === 'typhoon',
  );

  // 1. Absolute pressure bounds: 870 hPa is the observed world record.
  let boundPenalty = 0;
  for (const entity of pressureCenters) {
    const isLow =
      entity.type === 'coldLow' || entity.type === 'warmLow' || entity.type === 'typhoon';
    const centre = base.P + (isLow ? -1 : 1) * entity.strength;
    const penalty = pressureFloorPenalty(centre);
    if (penalty > 0) {
      boundPenalty += penalty;
      checks.push({
        id: `bound-${entity.id}`,
        label: '气压边界',
        passed: false,
        penalty,
        detail: `${entity.type} 中心 ${centre.toFixed(0)} hPa 超出 870–1085 hPa 的观测范围`,
      });
    }
  }
  if (boundPenalty === 0) {
    checks.push({
      id: 'bound',
      label: '气压边界',
      passed: true,
      penalty: 0,
      detail: '所有气压中心都在 870–1085 hPa 内',
    });
  }

  // 2. Typhoon intensity versus sea-surface temperature (MPI).
  const sst = base.sst ?? base.T + 1;
  const floor = typhoonPressureFloor(sst);
  let mpiPenalty = 0;
  for (const storm of entities.filter((entity) => entity.type === 'typhoon')) {
    const centre = base.P - storm.strength;
    if (centre < floor - 1) {
      const penalty = Math.ceil((floor - centre) / 5) * 15;
      mpiPenalty += penalty;
      checks.push({
        id: `mpi-${storm.id}`,
        label: '最大潜在强度',
        passed: false,
        penalty,
        detail: `海温 ${sst.toFixed(1)}°C 只支持到约 ${floor.toFixed(0)} hPa，当前 ${centre.toFixed(0)} hPa`,
      });
    }
  }
  if (mpiPenalty === 0) {
    checks.push({
      id: 'mpi',
      label: '最大潜在强度',
      passed: true,
      penalty: 0,
      detail: `海温 ${sst.toFixed(1)}°C，中心气压下限约 ${floor.toFixed(0)} hPa`,
    });
  }

  // 3. Thermal wind: a jet axis must run nearly parallel to the isotherms.
  let thermalPenalty = 0;
  for (const jet of entities.filter((entity) => entity.type === 'jet')) {
    if (!snapshot) continue;
    const gradient = nearestTemperatureGradient(snapshot, jet.x, jet.y);
    if (!gradient) continue;
    const gradientDeg =
      (Math.atan2(-gradient.gy, gradient.gx) * 180) / Math.PI + 90;
    const axisDeg = ((jet.angle ?? 0) * 180) / Math.PI;
    const deviation = Math.abs(90 - angleBetweenDeg(axisDeg, gradientDeg));
    if (deviation > 30) {
      const penalty = Math.min(30, Math.ceil((deviation - 30) / 15) * 10);
      thermalPenalty += penalty;
      checks.push({
        id: `thermal-${jet.id}`,
        label: '热成风',
        passed: false,
        penalty,
        detail: `急流轴与等温线夹角偏离 ${deviation.toFixed(0)}°，热成风不支持`,
      });
    }
  }
  if (thermalPenalty === 0) {
    checks.push({
      id: 'thermal',
      label: '热成风',
      passed: true,
      penalty: 0,
      detail: '急流轴与温度场相容',
    });
  }

  // 4. Moisture can saturate but not arbitrarily exceed saturation.
  let moisturePenalty = 0;
  if (snapshot) {
    for (const [cityId, weather] of Object.entries(snapshot.cities)) {
      const ratio = weather.qSat > 0.1 ? weather.qLow / weather.qSat : 1;
      if (ratio > 1.05) {
        const penalty = Math.min(20, Math.ceil((ratio - 1) * 10));
        moisturePenalty += penalty;
        checks.push({
          id: `moisture-${cityId}`,
          label: '水汽上限',
          passed: false,
          penalty,
          detail: `水汽达到饱和的 ${ratio.toFixed(1)} 倍，多余部分只能成云`,
        });
        break;
      }
    }
  }
  if (moisturePenalty === 0) {
    checks.push({
      id: 'moisture',
      label: '水汽上限',
      passed: true,
      penalty: 0,
      detail: '水汽未超过饱和上限',
    });
  }

  // 5. Same-type stacking: two identical systems should merge, not double.
  let stackPenalty = 0;
  for (let i = 0; i < entities.length; i += 1) {
    for (let j = i + 1; j < entities.length; j += 1) {
      const a = entities[i];
      const b = entities[j];
      if (a.type !== b.type) continue;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (distance < 0.08 * Math.min(a.radius, b.radius)) {
        stackPenalty += 10;
        checks.push({
          id: `stack-${a.id}-${b.id}`,
          label: '同类叠加',
          passed: false,
          penalty: 10,
          detail: `两个 ${a.type} 几乎重叠（${distance.toFixed(0)} px），会合并为一个更大的系统`,
        });
        break;
      }
    }
  }
  if (stackPenalty === 0) {
    checks.push({
      id: 'stack',
      label: '同类叠加',
      passed: true,
      penalty: 0,
      detail: '同类系统没有重叠',
    });
  }

  const penalty =
    boundPenalty + mpiPenalty + thermalPenalty + moisturePenalty + stackPenalty;
  return {
    score: Math.max(0, Math.min(100, 100 - penalty)),
    checks,
  };
}

/** Chart-scale guard used by the report: nothing may sit outside the frame. */
export function entitiesInsideChart(entities: WeatherEntity[]): boolean {
  return entities.every(
    (entity) =>
      entity.x >= 0 && entity.x <= MAP_SIZE && entity.y >= 0 && entity.y <= MAP_SIZE,
  );
}
