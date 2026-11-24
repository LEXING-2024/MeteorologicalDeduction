/**
 * State → diagnostic adapters (P2).
 *
 * The prognostic solver speaks metres, kelvin and m/s; the HUD speaks hPa, °C,
 * g/m³ and the 0–14 W index.  This module is the single translation layer so a
 * forecast level, a verify script and the station panel can never drift apart.
 */

import type { FieldSample } from '../../../experiments/swe/physics/WeatherField';
import { precipitationRate } from '../precipitation';
import type { FrontType } from '../types';

export interface StationDiagnostics {
  pressureHpa: number;
  temperatureC: number;
  moistureGm3: number;
  wMetresPerSecond: number;
  /** Same 0–14 index the campaign station panel uses. */
  wGame: number;
  /** Rain in mm per 3 h round, same formula as the analytic station. */
  rainRate: number;
  /** 24 h equivalent (R × 8), same convention as the station panel. */
  rain24h: number;
  windSpeed: number;
  /** Meteorological direction the wind comes FROM, clockwise from north. */
  windFromDeg: number;
  frontType: FrontType;
  frontStrength: number;
}

/**
 * Weak temperature gradients classify as fronts far too easily in the raw
 * solver output (a 0.2-strength "front" appears in the clear sector).  The
 * campaign only shows a front once it is unambiguous, so the adapter applies
 * the same idea with a strength floor.
 */
const FRONT_STRENGTH_FLOOR = 0.35;

export function diagnoseStation(sample: FieldSample): StationDiagnostics {
  const rainRate = precipitationRate(sample.temperatureC, sample.moisture, sample.wGame);
  return {
    pressureHpa: sample.pressureHpa,
    temperatureC: sample.temperatureC,
    moistureGm3: sample.moisture,
    wMetresPerSecond: sample.wTotal,
    // Use the solver's own 0–14 mapping so both engines share one index.
    wGame: sample.wGame,
    rainRate,
    rain24h: rainRate * 8,
    windSpeed: sample.speed,
    windFromDeg: sample.fromDeg,
    frontType: (sample.front.strength >= FRONT_STRENGTH_FLOOR ? sample.front.type : 'none') as FrontType,
    frontStrength: sample.front.strength,
  };
}

/** Compact one-line formatting shared by scripts and (later) the timeline UI. */
export function formatStationDiagnostics(d: StationDiagnostics): string {
  return (
    `P ${d.pressureHpa.toFixed(1)} hPa · T ${d.temperatureC.toFixed(1)} °C · ` +
    `Q ${d.moistureGm3.toFixed(1)} g/m³ · W ${d.wMetresPerSecond.toFixed(2)} m/s (${d.wGame.toFixed(1)} index) · ` +
    `R ${d.rainRate.toFixed(2)} mm/3h (${d.rain24h.toFixed(0)} mm/24h) · ` +
    `风 ${d.windSpeed.toFixed(1)} m/s/${d.windFromDeg.toFixed(0)}° · 锋面 ${frontLabel(d.frontType)}`
  );
}

function frontLabel(type: FrontType): string {
  switch (type) {
    case 'cold':
      return '冷锋';
    case 'warm':
      return '暖锋';
    case 'stationary':
      return '准静止锋';
    case 'occluded':
      return '锢囚锋';
    default:
      return '无';
  }
}
