/**
 * Physical constants for the rebuilt bottom-layer weather engine.
 *
 * The chart is treated as a physical square domain.  A large-scale level uses
 * domainKm = 1000 and a 256 x 256 grid, so dx ~= 3.9 km, exactly the scale of a
 * synoptic chart.  Horizontal distances, velocities and layer thicknesses are
 * real SI quantities; only the vertical velocity handed to the game HUD is
 * rescaled (see GAME_W_* below), because W is a gameplay index, not a height
 * tendency in metres per second.
 *
 * Reference values follow a standard-atmosphere-like air column:
 *   rho0 = 1.225 kg/m^3, g = 9.8 m/s^2, f0 = 1e-4 s^-1 (mid-latitude),
 *   H0   = 8000 m (equivalent depth of the barotropic mode).
 */

export const PHYSICS = {
  /** Gravitational acceleration, m/s^2. */
  gravity: 9.8,
  /** Mid-latitude Coriolis parameter, s^-1 (positive in the northern hemisphere). */
  coriolis: 1e-4,
  /** Equivalent mean depth of the atmospheric layer, m. */
  meanDepth: 8000,
  /** Air density used for the hydrostatic pressure <-> depth mapping, kg/m^3. */
  airDensity: 1.225,
  /** Chart reference pressure, hPa. */
  basePressureHpa: 1012,
  /** Reference temperature of the layer used by the thermal thickness coupling, K. */
  referenceTemperatureK: 285,
  /** Depth of the layer whose mean temperature anomaly maps to a thickness anomaly, m. */
  thermalLayerDepth: 2000,
  /** Hard floor on the fluid depth, m. */
  minDepth: 50,
  /** Default explicit CFL target.  Below the 2-D forward-backward stability bound. */
  cflLimit: 0.5,
  /** 1-2-1 Shapiro filter weight on the free surface, per nominal 10 s step. */
  smoothing: 0.03,
  /** Explicit Laplacian viscosity on the face velocities, m^2/s. */
  viscosity: 800,
  /** Number of border cells in the absorbing sponge layer. */
  spongeCells: 10,
  /** Rayleigh damping time scale at the wall, s. */
  spongeTimeScale: 150,
  /** Largest internal substep, s.  10 s is the nominal external weather step. */
  maxSubstepSeconds: 10,
  /** Safety cap applied to a geostrophically initialised wind, m/s. */
  maxInitialSpeed: 120,
  /** Map width in pixels used by the chart. */
  mapSize: 1000,
  /** Default large-scale domain, km. */
  defaultDomainKm: 1000,
  /** Default grid size. */
  defaultGridN: 256,
  /** Game HUD vertical-velocity scale: 1 m/s of ascent -> this many W units. */
  gameWPerMetrePerSecond: 24,
  /** Extra W units per K/10km of temperature gradient at a front. */
  gameWPerFrontGradient: 2.2,
  /**
   * Boundary-layer Ekman pumping: ascent per unit Rossby number (zeta / f).
   * A cyclonic low has zeta/f > 0 and therefore rises; an anticyclone sinks.
   * 0.16 m/s per unit Ro reproduces the old "L centre = lift" teaching scale
   * (a 10 hPa low is about +0.2 m/s, a 20 hPa low about +0.4 m/s) while the
   * free-atmosphere divergence itself stays physical.
   */
  ekmanAscentPerRossby: 0.16,
  /** Maximum |W| shown to the player. */
  gameWMax: 14,
  /** |grad T| at which a frontal zone starts to count, K/100 km. */
  frontGradientThreshold: 1.2,
  /** |grad T| of a fully developed front, K/100 km. */
  frontGradientStrong: 5.0,
  /** Smoothing half-width (grid cells) of the front detection stencil. */
  frontSmoothCells: 1,
} as const;

export const HPA_TO_PA = 100;

/** Convert a pressure anomaly in hPa to an equivalent free-surface depth in m. */
export function pressureHpaToDepth(pressureHpa: number): number {
  return (pressureHpa * HPA_TO_PA) / (PHYSICS.airDensity * PHYSICS.gravity);
}

/** Convert a free-surface depth in m to a pressure anomaly in hPa. */
export function depthToPressureHpa(depthMetres: number): number {
  return (depthMetres * PHYSICS.airDensity * PHYSICS.gravity) / HPA_TO_PA;
}

/**
 * Static (hydrostatic) thickness response to a layer-mean temperature anomaly.
 *
 * For a layer of depth D whose mean temperature changes by dT, the surface
 * pressure anomaly is dp = -rho g D dT / T, i.e. the equivalent depth anomaly
 * is -D dT / T.  A warm anomaly therefore lowers the surface pressure and a
 * cold anomaly raises it, which is the sign the design document asks for.
 */
export function temperatureToDepth(
  deltaCelsius: number,
  referenceKelvin: number = PHYSICS.referenceTemperatureK,
): number {
  return -(PHYSICS.thermalLayerDepth / referenceKelvin) * deltaCelsius;
}

/** Game HUD vertical velocity from a physical ascent rate in m/s. */
export function verticalVelocityToGameIndex(ascentMetresPerSecond: number): number {
  return ascentMetresPerSecond * PHYSICS.gameWPerMetrePerSecond;
}

/** Standard atmosphere pressure at a given elevation, hPa (for terrain QC). */
export function pressureAtElevation(elevationMetres: number): number {
  return PHYSICS.basePressureHpa * Math.pow(1 - (2.25577e-5 * elevationMetres), 5.25588);
}

/** One domain configuration.  dx follows from the grid and the physical size. */
export interface DomainScale {
  /** Physical side length of the square chart, km. */
  domainKm: number;
  /** Grid size per side. */
  gridN: number;
  /** Cell size, m. */
  dx: number;
  /** Cell size, km. */
  dxKm: number;
  /** Number of sponge cells. */
  spongeCells: number;
}

/** Build a domain scale, clamping the sponge to a sane fraction of the grid. */
export function domainScale(domainKm: number, gridN: number, spongeCells = PHYSICS.spongeCells): DomainScale {
  if (!Number.isFinite(domainKm) || domainKm <= 0) {
    throw new Error('domainKm must be a positive finite number');
  }
  if (!Number.isInteger(gridN) || gridN < 8) {
    throw new Error('gridN must be an integer >= 8');
  }
  const dx = (domainKm * 1000) / gridN;
  const sponge = Math.max(0, Math.min(Math.floor(gridN / 4), Math.floor(spongeCells)));
  return { domainKm, gridN, dx, dxKm: dx / 1000, spongeCells: sponge };
}
