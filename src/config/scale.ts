import { MAP_KM_PER_PX, MAP_SIZE } from './constants';

export { adaptRadiusKm } from './constants';

/**
 * One chart, six domain widths.
 *
 * Levels are authored anywhere between 100 km (one valley) and 2000 km (a
 * continental cold surge).  Every diagnostic that needs a physical distance --
 * a temperature gradient, a wind shear, a moisture drift -- must therefore be
 * expressed in kilometres and converted with the level's own scale.  Hard-coded
 * pixel distances silently change meaning when the chart does: 24 px is 24 km
 * on a 1000 km chart and 48 km on a 2000 km chart.
 *
 * This module is the single place where that conversion happens.
 */

export interface ScaleLike {
  domainScale?: number;
}

/** Kilometres represented by one map pixel on this chart. */
export function kmPerPixel(base?: ScaleLike | null): number {
  const domain = base?.domainScale;
  if (!domain || !Number.isFinite(domain) || domain <= 0) return MAP_KM_PER_PX;
  return domain / MAP_SIZE;
}

/** Map pixels per kilometre. */
export function pxPerKm(base?: ScaleLike | null): number {
  return 1 / kmPerPixel(base);
}

export function kmToPx(km: number, base?: ScaleLike | null): number {
  return km * pxPerKm(base);
}

export function pxToKm(px: number, base?: ScaleLike | null): number {
  return px * kmPerPixel(base);
}

/**
 * Diagnostic sampling distances, in kilometres.
 *
 * These are physical lengths, not pixels: a 24 km wind gradient means the same
 * thing on a valley chart and on a continental chart.  The 1000 km baseline was
 * tuned with 1 km/px, so these numbers double as the legacy pixel values there.
 */
export const DIAGNOSTIC_KM = {
  /** Half-window for the thermal front gradient. */
  temperatureGradient: 8,
  /** Half-window for temperature advection. */
  temperatureAdvection: 10,
  /** Half-window for the upper-air pressure gradient. */
  highWind: 12,
  /** Radius of the four-point wind shear ring. */
  shear: 24,
  /** Half-window for the moisture gradient. */
  dryline: 22,
  /** Half-window for the wind convergence. */
  convergence: 22,
} as const;

/**
 * Sampling window actually used on this chart: the physical standard, bounded
 * by 15 % of the domain so a valley chart resolves local gradients instead of
 * differencing across a quarter of the map.
 */
export function diagnosticKm(kind: keyof typeof DIAGNOSTIC_KM, base?: ScaleLike | null): number {
  const domain = base?.domainScale && base.domainScale > 0 ? base.domainScale : MAP_SIZE;
  return Math.min(DIAGNOSTIC_KM[kind], domain * 0.15);
}

/**
 * Moisture drift per 3 h round: 18.75 km per m/s of steering wind, capped at
 * 237.5 km.  The 1000 km chart used 18.75 px/m/s, which is the same thing at
 * 1 km/px; expressing it in km keeps a 2000 km chart from doubling the drift.
 */
export const WET_DRIFT_KM_PER_MS = 18.75;
export const MAX_WET_DRIFT_KM = 237.5;

/** Human-readable scale label for the UI. */
export function scaleLabel(domainScale?: number): string {
  const domain = domainScale && domainScale > 0 ? domainScale : MAP_SIZE;
  if (domain >= 600) return '天气尺度';
  if (domain >= 250) return '中尺度';
  return '局地尺度';
}
