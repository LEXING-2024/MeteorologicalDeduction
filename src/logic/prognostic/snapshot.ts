/**
 * Prognostic → campaign snapshot adapter (P4 prerequisite).
 *
 * The renderer, the goal evaluator and the station panel all read
 * `SimulationSnapshot`.  This module turns a `WeatherField` sample grid into
 * that shape, so a level can be judged without changing its presentation code.
 *
 * Not every diagnostic has a prognostic source yet (shear, dryline, hazards);
 * those are filled with neutral values and listed in the P4 migration notes.
 */

import { MAP_SIZE } from '../../config/constants';
import { precipitationRate, precipitationType, rainGradeFrom24h, saturationVapourDensity } from '../precipitation';
import type {
  City,
  FrontType,
  PointWeather,
  SampleGrid,
  SimulationSnapshot,
  WeatherEntity,
  WindVector,
} from '../types';
import type { FieldSample, FieldGrid, WeatherField } from '../../../experiments/swe/physics/WeatherField';

// Small formatting helpers stay local so this module never imports field.ts
// (field.ts imports the prognostic round, which would close a cycle).
const COMPASS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];

function beaufortFromSpeed(speed: number): number {
  const limits = [0.3, 1.6, 3.4, 5.5, 8, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
  let level = 0;
  for (const limit of limits) if (speed >= limit) level += 1;
  return level;
}

function compassLabelFromToward(towardDeg: number): string {
  const bearing = (((towardDeg + 90) % 360) + 360) % 360;
  return COMPASS[Math.round(bearing / 45) % 8];
}

/** Simple cloud-top estimate until the prognostic cloud scheme lands. */
function cloudTopEstimate(wGame: number): number {
  return Math.max(0, Math.min(12, 1.2 + Math.max(0, wGame) * 0.65));
}

function windFromSample(sample: FieldSample): WindVector {
  const towardDeg = ((Math.atan2(-sample.v, sample.u) * 180) / Math.PI + 360) % 360;
  const fromDeg = sample.fromDeg;
  return {
    x: sample.u,
    y: -sample.v,
    speed: sample.speed,
    towardDeg,
    fromDeg,
    fromLabel: compassLabelFromToward(towardDeg),
    beaufort: beaufortFromSpeed(sample.speed),
  };
}

export function pointWeatherFromSample(sample: FieldSample, baseT: number): PointWeather {
  const qSat = saturationVapourDensity(sample.temperatureC);
  const W = sample.wGame;
  const R = precipitationRate(sample.temperatureC, sample.moisture, W);
  const relativeHumidity = Math.max(0, Math.min(1, sample.moisture / Math.max(0.1, qSat)));
  const dewPoint = sample.temperatureC - (1 - relativeHumidity) * 20;
  const cloud = Math.max(0, Math.min(100, 28 + Math.max(0, W) * 7 + relativeHumidity * 30));
  const cloudTop = cloudTopEstimate(W);
  const wind = windFromSample(sample);
  const frontType: FrontType = sample.front.strength >= 0.35 ? (sample.front.type as FrontType) : 'none';
  return {
    pLow: sample.pressureHpa,
    tLow: sample.temperatureC,
    qLow: sample.moisture,
    pHigh: sample.pressureHpa,
    wHigh: W,
    wLow: W,
    W,
    P: sample.pressureHpa,
    T: sample.temperatureC,
    Q: sample.moisture,
    R,
    qSat,
    cloud,
    cloudTop,
    visibility: 20,
    dewPoint,
    thetaE: sample.temperatureC + 2.5 * sample.moisture,
    coldPool: 0,
    rain24h: R * 8,
    rainGrade: rainGradeFrom24h(R * 8),
    wind,
    windHigh: wind,
    precipitationType: precipitationType(sample.temperatureC, R),
    frontType,
    frontLift: sample.front.strength * 2,
    stability: sample.stability,
    midTemperature: baseT,
    vorticity: sample.vorticity * 1e4,
    hazard: 'none',
    airMass: 'neutral',
    shear: 0,
    dryline: 0,
    convection: W > 8 ? 1 : 0,
  };
}

export function buildPrognosticSnapshot(
  field: WeatherField,
  entities: WeatherEntity[],
  cities: City[],
): SimulationSnapshot {
  const n = field.n;
  const source: FieldGrid = field.buildGrid(n, true);
  const cells = n * n;
  const rain = new Float32Array(cells);
  for (let i = 0; i < cells; i += 1) {
    rain[i] = precipitationRate(source.temperatureC[i], source.moisture[i], source.wGame[i]);
  }
  const grid: SampleGrid = {
    n,
    size: MAP_SIZE,
    spacing: MAP_SIZE / n,
    pLow: source.pressureHpa,
    tLow: source.temperatureC,
    qLow: source.moisture,
    wLow: source.wGame,
    pHigh: source.pressureHpa,
    wHigh: source.wGame,
    r: rain,
    uLow: source.uScreen,
    vLow: source.vScreen,
    uHigh: source.uScreen,
    vHigh: source.vScreen,
    frontStrength: source.frontStrength,
    frontType: source.frontType,
  };

  const station: Record<string, PointWeather> = {};
  for (const city of cities) {
    station[city.id] = pointWeatherFromSample(field.sampleScreen(city.x, city.y), field.base.T);
  }
  return { entities, grid, cities: station };
}
