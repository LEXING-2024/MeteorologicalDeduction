import {
  TYPHOON_CATEGORY_LABELS,
  TYPHOON_CATEGORY_THRESHOLDS,
  TYPHOON_EYEWALL_CENTER,
  TYPHOON_EYEWALL_WIDTH,
  TYPHOON_EYE_FRACTION,
  TYPHOON_PRESSURE_FALLOFF,
  TYPHOON_PRESSURE_POWER,
} from '../config/constants';

/**
 * Tropical cyclones are not just "a deeper low".
 *
 * A real storm has a warm core, a calm eye, a ring of eyewall ascent and two
 * spiral rainbands.  The game needs the same structure, otherwise a player can
 * not learn why the eye is clear while the eyewall floods the coast.
 *
 * All profiles are functions of q = r / R, so they scale with the storm radius.
 */
export interface TyphoonProfile {
  /** Normalised pressure deficit, 1 at the centre. */
  pressure: number;
  /** Eyewall ascent (0..1). */
  ring: number;
  /** Eye subsidence (0..1). */
  eye: number;
  /** Spiral-band moisture supply (0..1). */
  band: number;
}

export function typhoonCategory(strength: number): 0 | 1 | 2 | 3 {
  const value = Math.abs(strength);
  if (value >= TYPHOON_CATEGORY_THRESHOLDS[2]) return 3;
  if (value >= TYPHOON_CATEGORY_THRESHOLDS[1]) return 2;
  if (value >= TYPHOON_CATEGORY_THRESHOLDS[0]) return 1;
  return 0;
}

export function typhoonCategoryLabel(strength: number): string {
  return TYPHOON_CATEGORY_LABELS[typhoonCategory(strength)];
}

export function typhoonCategoryName(category: number): string {
  const index = Math.max(0, Math.min(3, Math.floor(category)));
  return TYPHOON_CATEGORY_LABELS[index];
}

/** Central pressure implied by the authored deficit, hPa. */
export function typhoonCentralPressure(strength: number, basePressure = 1012): number {
  return basePressure - Math.abs(strength);
}

/**
 * Maximum sustained wind from the pressure deficit, m/s.
 *
 * Atkinson-Holliday (1977): V(kt) = 6.7 * (1010 - Pc)^0.644.  The old linear
 * `10 + 1.05 * strength` claimed 62 m/s for a 962 hPa storm; the wind-pressure
 * relation gives 42 m/s, which is what the 962 hPa contour actually supports.
 */
export function typhoonMaxWind(strength: number, basePressure = 1012): number {
  const deficit = Math.max(0, basePressure - typhoonCentralPressure(strength, basePressure));
  // The relation is calibrated against 1010 hPa, two hPa below this model's
  // 1012 hPa base, so the effective deepening is (strength - 2).
  const effective = Math.max(1, deficit - 2);
  const knots = 6.7 * Math.pow(effective, 0.644);
  return knots * 0.514444;
}

export function typhoonProfile(
  distance: number,
  radius: number,
  theta: number,
  phase: number,
): TyphoonProfile {
  const q = distance / Math.max(20, radius);
  const pressure = Math.exp(-TYPHOON_PRESSURE_FALLOFF * Math.pow(q, TYPHOON_PRESSURE_POWER));

  const ringWidth = TYPHOON_EYEWALL_WIDTH;
  const ring = Math.exp(-(((q - TYPHOON_EYEWALL_CENTER) / ringWidth) ** 2));
  const eye = Math.exp(-((q / TYPHOON_EYE_FRACTION) ** 2));

  // Two logarithmic spiral arms.  The phase is seeded by the entity, so the
  // bands are stable across frames but differ between storms.
  const spiral =
    0.62 + 0.38 * Math.cos(2 * theta + 2.6 * Math.log(Math.max(0.18, q)) + phase);
  const band = Math.exp(-(((q - 0.48) / 0.42) ** 2)) * spiral;

  return {
    pressure,
    ring: Math.min(1, ring),
    eye: Math.min(1, eye),
    band: Math.max(0, Math.min(1, band)),
  };
}
