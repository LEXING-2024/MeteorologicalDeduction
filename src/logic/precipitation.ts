import {
  COLD_POOL_BASE_FRACTION,
  COLD_POOL_PER_MM,
  MAX_COLD_POOL,
  MOISTURE_FLUX_GAIN,
  MOISTURE_FLUX_REFERENCE,
  MOISTURE_SUPPLY_CAP,
  QSAT_TABLE,
  RAIN_COEFFICIENT,
  RAIN_GRADES,
  RAIN_SATURATION_FRACTION,
} from '../config/constants';

/** Floor for the moisture normaliser, g/m³; the base state is 7.4. */
const MOISTURE_FLOOR = 1;

export function saturationVapourDensity(temperature: number): number {
  if (temperature <= QSAT_TABLE[0][0]) return QSAT_TABLE[0][1];
  const last = QSAT_TABLE[QSAT_TABLE.length - 1];
  if (temperature >= last[0]) return last[1];

  for (let i = 0; i < QSAT_TABLE.length - 1; i += 1) {
    const [t0, q0] = QSAT_TABLE[i];
    const [t1, q1] = QSAT_TABLE[i + 1];
    if (temperature >= t0 && temperature <= t1) {
      const t = (temperature - t0) / (t1 - t0);
      return q0 + (q1 - q0) * t;
    }
  }

  return last[1];
}

/**
 * Three-hour rainfall accumulation in mm. Q is a moisture-supply index, but
 * the effective supply is capped at MOISTURE_SUPPLY_CAP * qSat: a blob of
 * 26 g/m³ at -14°C cannot hold 14x its saturation value and then rain it out.
 */
export function precipitationRate(temperature: number, moisture: number, verticalVelocity: number): number {
  if (verticalVelocity <= 0) return 0;
  const qSat = saturationVapourDensity(temperature);
  const effectiveMoisture = Math.min(moisture, qSat * MOISTURE_SUPPLY_CAP);
  const excess = Math.max(0, effectiveMoisture - qSat * RAIN_SATURATION_FRACTION);
  return RAIN_COEFFICIENT * verticalVelocity * excess;
}

/**
 * Rain multiplier from moisture-flux convergence, dimensionless.
 *
 * `convergenceRate` is the convergence of the vapour flux divided by the vapour
 * density, i.e. a pure kinematic convergence in s⁻¹ (see
 * `moistureFluxConvergenceAt`).  Normalising by q matters: with the raw flux the
 * multiplier would double-dip on the moisture card, because a bigger Q both
 * raises the rain rate linearly and inflates the factor.
 *
 * The response is centred on the campaign median (MOISTURE_FLUX_REFERENCE), so
 * an ordinary rain-making column keeps its legacy rate, a strongly convergent
 * band gains up to +60 %, and a divergent lee side or a subsidence cap loses up
 * to 60 %.  tanh saturates smoothly instead of clipping at the bounds.
 */
export function moistureFluxFactor(convergenceRate: number): number {
  const normalized = (convergenceRate - MOISTURE_FLUX_REFERENCE) / MOISTURE_FLUX_REFERENCE;
  const response = 1 + MOISTURE_FLUX_GAIN * Math.tanh(normalized);
  return Math.max(0.4, Math.min(1.6, response));
}

/** `precipitationRate` scaled by the moisture-flux convergence multiplier. */
export function precipitationRateFromFlux(
  temperature: number,
  moisture: number,
  verticalVelocity: number,
  fluxConvergence: number,
): number {
  const rate = fluxConvergence / Math.max(MOISTURE_FLOOR, moisture);
  return precipitationRate(temperature, moisture, verticalVelocity) * moistureFluxFactor(rate);
}

/**
 * Evaporative cooling of the downdraft, °C.
 *
 * Rain falling through subsaturated air chills it; rain falling out of a
 * saturated column still cools it through melting and water loading, which is
 * why the dryness term modulates a floor instead of gating the whole effect
 * (COLD_POOL_BASE_FRACTION).  The result feeds both the reported surface
 * temperature and the cold-pool outflow in the wind field.
 */
export function coldPoolCooling(rainRate: number, temperature: number, moisture: number): number {
  if (rainRate <= 0.01) return 0;
  const qSat = saturationVapourDensity(temperature);
  const relativeHumidity = Math.max(0, Math.min(1, moisture / Math.max(0.1, qSat)));
  const dryness = 1 - relativeHumidity;
  const cooling =
    COLD_POOL_PER_MM *
    rainRate *
    (COLD_POOL_BASE_FRACTION + (1 - COLD_POOL_BASE_FRACTION) * dryness);
  return Math.min(MAX_COLD_POOL, cooling);
}

export function rainGradeFrom24h(amount: number): string {
  if (amount < 0.1) return '无降水';
  for (const grade of RAIN_GRADES) {
    if (amount >= grade.min && amount < grade.max) return grade.name;
  }
  return '特大暴雨';
}

export function rainGradeColor(amount: number): [number, number, number] {
  if (amount < 0.1) return [10, 18, 28];
  for (const grade of RAIN_GRADES) {
    if (amount >= grade.min && amount < grade.max) {
      return [...grade.color] as [number, number, number];
    }
  }
  return [146, 46, 98];
}

export function precipitationType(temperature: number, rate: number): 'none' | 'rain' | 'snow' {
  if (rate < 0.01) return 'none';
  return temperature < 0 ? 'snow' : 'rain';
}
