import type {
  CardType,
  EntityDepth,
  EntityType,
  FrontType,
  InversionMode,
  MapLayer,
} from '../logic/types';

export const MAP_SIZE = 1000;
/** Internal sampling grid: roughly one sample every 9 map pixels. */
export const GRID_SPACING = 9;
export const GRID_N = Math.floor(MAP_SIZE / GRID_SPACING) + 1;
/**
 * Isobar/axis source grid. This is sampled directly with pressureAt at 256×256,
 * not bilinearly upsampled from GRID_N; the full weather grid stays at GRID_N.
 */
export const ISOBAR_GRID_N = 256;
/**
 * Interaction grid.  While the player drags a card or an influence radius the
 * field is rebuilt on every animation frame, so the analysis runs on a coarse
 * grid and the 256² isobar field is replaced by an upsample of it.  The full
 * grid is restored on pointer-up, which is the state the player judges and the
 * state the goal is evaluated on.
 */
export const PREVIEW_GRID_N = 48;
/** Upsampled isobar resolution used while interacting. */
export const PREVIEW_ISOBAR_GRID_N = 128;
/**
 * Legacy chart scale for stages 2–3: 576 km across the full 1000 px map.
 * Stage 1 uses its own `domainScale = 1000` and derives km/px from that.
 */
export const MAP_KM_PER_PX = 0.576;
/**
 * Authored level/geography coordinates live in the original 800-unit chart.
 * The render/logic world is now 1000 units, so all authored content is scaled
 * by this factor once at module load to keep its physical layout unchanged.
 */
export const CONTENT_SCALE = MAP_SIZE / 800;
/** Editable influence range for pressure centres. The global floor is small;
 *  a strength-dependent shield is applied per pressure card. */
export const ENTITY_RADIUS_MIN_KM = 15;
export const ENTITY_RADIUS_MAX_KM = 500;
export const MIN_ENTITY_RADIUS = ENTITY_RADIUS_MIN_KM / MAP_KM_PER_PX;
export const MAX_ENTITY_RADIUS = ENTITY_RADIUS_MAX_KM / MAP_KM_PER_PX;
export const RAIN_TEXTURE_SIZE = 384;
export const TEMPERATURE_TEXTURE_SIZE = 384;
export const SHAPE_FEATURE_LIFT = 2;
/**
 * Shape editing ("捏形") unlocks with the first combination stage.
 *
 * This used to be a per-level `allowShaping` flag that no level ever set while
 * the controller silently enabled the feature for `stage >= 2`: dead data plus
 * a hidden rule.  The gate is now one explicit constant, and the deck hint and
 * the manual both read from it.
 */
export const SHAPING_MIN_STAGE = 2;

export const COLORS = {
  page: 0x080d13,
  // Chart palette v2: readable deep-blue water and vegetated land instead of
  // near-black grey.  Kept dark enough for bright isobars/rain to stay legible.
  sea: 0x0a2638,
  seaDeep: 0x061a28,
  land: 0x27382f,
  landAlt: 0x2d4035,
  landHigh: 0x384a3b,
  mountainHigh: 0x5c5342,
  mountainBase: 0x3e3527,
  mountainLine: 0xffffff,
  water: 0x1d4a5c,
  coast: 0x6f9bad,
  coastGlow: 0x4fc3f7,
  coastFaint: 0x24414f,
  isobar: 0xa9bcc9,
  highIsobar: 0xc6d4de,
  wind: 0xc2d4df,
  city: 0x4fc3f7,
  cityMuted: 0xb9c6cd,
  target: 0x8fd8e5,
  text: 0xdbe6ed,
  textMuted: 0x7890a2,
} as const;

export const BASE_PRESSURE = 1012;
/**
 * Weak large-scale pressure tilt (hPa across the whole chart). A perfectly flat
 * background makes the base isobar non-unique and produces staircase contours
 * at the edge of every system's compact support; a gentle synoptic tilt gives
 * the 1012 hPa isobar a single, smooth path without affecting the wind.
 */
export const SYNOPTIC_TILT_HPA = 1.2;
export const BASE_TEMPERATURE = 22;
export const BASE_MOISTURE = 7.4;

export const PRESSURE_FALLOFF = 1.2;
export const SURFACE_FALLOFF = 2.1;
export const PRESSURE_ANISOTROPY = 0.16;
export const SURFACE_ANISOTROPY = 0.2;
export const INFLUENCE_WOBBLE = 0.055;

export const LOW_LIFT_PER_HPA = 0.48;
export const HIGH_SINK_PER_HPA = 0.62;
export const MAX_VERTICAL_VELOCITY = 14;

/** hPa per pixel -> m/s. Deliberately tuned for legible synoptic-scale motion. */
export const WIND_GRADIENT_SCALE = 155 / CONTENT_SCALE;
export const CORIOLIS_DEFLECTION_DEG = 38;
/** Surface wind cross-isobar angle (degrees from the isobars). */
export const CROSS_ISOBAR_SEA_DEG = 18;
export const CROSS_ISOBAR_LAND_DEG = 30;
export const CROSS_ISOBAR_MOUNTAIN_DEG = 38;
export const MAX_WIND_SPEED = 28;
export const MAX_HIGH_WIND_SPEED = 42;
export const LAND_FRICTION = 0.7;
export const WET_DRIFT_PX_PER_MS = 15 * CONTENT_SCALE;
export const MAX_WET_DRIFT = 190 * CONTENT_SCALE;
export const STEERING_FACTOR = 0.55;

/** High-level response to a surface pressure system's depth. */
export const HIGH_P_GAIN = 0.9;
export const HIGH_W_LIFT_PER_HPA = 0.2;
export const HIGH_W_SINK_PER_HPA = 0.18;
export const SHALLOW_HIGH_P_GAIN = 0.04;
export const SHALLOW_HIGH_W = 0.006;

/** Upper-air environment adjustments. */
export const TROUGH_HIGH_P_DROP = 7;
export const TROUGH_HIGH_LIFT = 0.75;
export const TROUGH_DEEPEN = 0.25;
export const RIDGE_HIGH_P_GAIN = 6;
export const RIDGE_HIGH_SINK = 0.9;
export const SHEAR_LIFT = 1;
export const SHEAR_THRESHOLD_DEG = 15;
export const DRYLINE_LIFT = 1;
/** g/m³ per pixel; scale by the chart content scale so the physical contrast is unchanged. */
export const DRYLINE_THRESHOLD = 0.12 / CONTENT_SCALE;
/** Minimum low-level convergence for a moisture gradient to lift a dryline. */
export const DRYLINE_CONVERGENCE_THRESHOLD = 0.02;
export const BASE_FRICTION = 0.85;
export const JET_HIGH_W = 0.35;
/** Four-quadrant jet exit/entrance forcing, per strength unit. */
export const JET_EXIT_LIFT = 0.6;
export const JET_STEERING = 3.4;
/** Legacy jet steering vector (east-southeast). Kept as the default axis. */
export const JET_DEFAULT_ANGLE = Math.atan2(0.25, 0.9);
export const JET_STEERING_SCALE = Math.hypot(0.9, 0.25);
export const INVERSION_UNSTABLE_MULTIPLIER = 1.5;
export const INVERSION_STABLE_MULTIPLIER = 0.5;

export const RAIN_COEFFICIENT = 0.045;
export const RAIN_SATURATION_FRACTION = 0.72;
/**
 * Q is a moisture-supply index, not an in-situ vapour density. The effective
 * condensation supply is capped at this multiple of qSat so a blob can no
 * longer rain out 14x its saturation value. The cap is deliberately generous
 * so the supply-index gameplay (stacking wet areas) still works.
 */
export const MOISTURE_SUPPLY_CAP = 4;

/**
 * Moisture-flux convergence gate (T1).
 *
 * Rain is fed by the convergence of the water-vapour flux, not by the local
 * stock: air that converges carries moisture in and rains, air that diverges
 * (lee side, subsidence cap) dries out. The flux q·v is differenced over a
 * ±8 km window at every sample point and divided by q, which turns the result
 * into a pure kinematic convergence (s⁻¹) that does not double-dip on the
 * moisture card.
 *
 * MOISTURE_FLUX_REFERENCE is the convergence that counts as an "ordinary"
 * rain-making column, i.e. the value the multiplier is centred on. It was
 * calibrated on the campaign's own rain cores, which sit between 3.6e-5 and
 * 1.2e-4 s⁻¹ (typhoon eyewall at the top, a stacked cold/warm pair front at
 * the bottom); 8e-5 s⁻¹ is the median. This is also the lower end of the
 * synoptic moisture convergence that sustains real rainfall (1e-5..1e-4 s⁻¹),
 * so the constant is a physical scale, not a per-chart fudge factor.
 */
export const MOISTURE_FLUX_REFERENCE = 8e-5;
/**
 * Half-width of the moisture-flux divergence window, km. 8 km resolves a
 * windward slope from its lee side while staying wider than the 34 km-wide
 * frontal trough perturbation, so the metric sees the synoptic flow.
 */
export const MOISTURE_FLUX_KM = 8;
/** Asymptotic response of the rain multiplier to normalised convergence. */
export const MOISTURE_FLUX_GAIN = 0.6;

/** Evaporative cooling: °C per mm/3h of rain in dry air, and its cap. */
export const COLD_POOL_PER_MM = 0.55;
export const MAX_COLD_POOL = 6;
/**
 * Share of the cold-pool cooling that survives in saturated air. A
 * precipitation-loaded downdraft stays negatively buoyant even at 100 % RH
 * (melting and water loading do not need subsaturation), so the end of the
 * old "dry air only" gate is this floor instead of zero. Without it the pool
 * was mathematically unreachable: rain requires Q > 0.72 qSat, which is
 * already 72 % RH.
 */
export const COLD_POOL_BASE_FRACTION = 0.35;
/** Half-width of the cold-pool gradient window, km. */
export const COLD_POOL_KM = 8;
/**
 * Cold-pool outflow: m/s per °C/km of cold-pool gradient. A 6 °C pool with a
 * 40 km edge is 0.15 °C/km, which gives ~3 m/s -- the gust front of a
 * single-cell downburst. Capped at MAX_COLD_POOL_OUTFLOW so a stack of wet
 * cards cannot produce a hurricane out of a cold pool alone.
 */
export const COLD_POOL_OUTFLOW = 20;
export const MAX_COLD_POOL_OUTFLOW = 4;
/** g/m³ of supply removed per mm of rain, and the floor a wet card can reach. */
export const MOISTURE_CONSUMPTION_PER_MM = 0.35;

/**
 * Rain a column can wring out of the *background* moisture alone, mm/3h.
 *
 * Without a moisture source (a wet air mass, a typhoon's own supply) the
 * precipitable water in a 1 km column is only a few millimetres; a pressure
 * minimum can drizzle it out but cannot sustain a deluge.  Before this cap a
 * single 20 hPa low produced 235 mm/24h over a dry column, which is what made
 * "one card → thunderstorm" feel magical.
 */
export const BACKGROUND_RAIN_CAP_MM = 1.6;
export const MIN_WET_STRENGTH = 5;
/**
 * Condensation heating: hPa of deepening per mm/3h of rain at the centre.
 * 50 mm/24h (~6 mm/3h) gives about 0.3 hPa per round, which is the right order
 * for a mature cyclone and small enough not to destabilise the level economy.
 */
export const LATENT_HPA_PER_MM = 0.05;
export const MAX_LATENT_HPA_PER_ROUND = 3;

// ---------------------------------------------------------------------------
// SPRINT-3A / T5 · latent-heat -> Ekman-pumping closure
// ---------------------------------------------------------------------------
/**
 * Game-unit W added per hPa of pressure-DEFICIT curvature measured on the
 * 22 km baseline aperture.  `applyMoistureBudget` already closes the first
 * half of the loop (R -> deeper low); this closes the second half
 * (deeper low -> stronger pressure curvature -> more ascent -> more R).
 * Kept deliberately small so the loop needs several rounds to amplify.
 */
export const EKMAN_LIFT = 0.3;
/** Hard ceiling on the W increment (game units); caps the positive feedback. */
export const EKMAN_MAX_LIFT = 2;
/**
 * Baseline aperture in km.  Equals DIAGNOSTIC_KM.convergence on the 1000 km
 * chart (1 km/px), so `scaleNorm = 1000/domainScale` is exactly 1 there.
 */
export const EKMAN_APERTURE_KM = 22;

// ---------------------------------------------------------------------------
// SPRINT-3A / T4 · jet core speed from the thermal wind
// ---------------------------------------------------------------------------
/**
 * m/s of jet-core wind per K/km of low-level thermal gradient.  Scalar form
 * of ∂V/∂z = −(g/fT) k×∇T integrated over a fixed layer depth.  Calibrated
 * so a resolved synoptic front (|∇T| ≈ 0.08 K/km) gives the legacy ~9.5 m/s
 * core on the 1000 km baseline.
 */
export const JET_THERMAL_WIND_COEFF = 120;
/** Core speed (m/s) the legacy JET_HIGH_W / JET_EXIT_LIFT response was tuned on. */
export const JET_REFERENCE_CORE_SPEED = 9.5;
/** Ceiling per strength tier (m/s): the card caps a hot gradient, never creates wind. */
export const JET_MAX_CORE_PER_TIER = 4;

// ---------------------------------------------------------------------------
// SPRINT-3A / T2 · three-level θe sounding for the cloud top
// ---------------------------------------------------------------------------
/** Standard tropospheric lapse rate, K/km; also sets the 0 °C level height. */
export const CLOUD_TOP_LAPSE_RATE = 6.5;
/** Latent part of θe, K per g/m³ (same 2.5 K/(g/m³) as the front diagnosis). */
export const CLOUD_TOP_THETA_E_LATENT = 2.5;
/** Height of the upper θe level, km. */
export const CLOUD_TOP_HIGH_Z_KM = 6;
/** Fraction of surface vapour surviving at mid / upper levels. */
export const CLOUD_TOP_MID_Q_FRACTION = 0.55;
export const CLOUD_TOP_HIGH_Q_FRACTION = 0.25;
/** θe drop (K) that counts as a fully unstable column. */
export const CLOUD_TOP_THETA_E_DROP_REFERENCE = 60;
/** How strongly the θe lapse stretches the W-driven cloud top. */
export const CLOUD_TOP_THETA_E_GAIN = 0.35;
/** How strongly a mid-level warm nose caps the cloud top. */
export const CLOUD_TOP_WARM_NOSE_GAIN = 0.4;
/** Hard ceiling so a hot/moist column cannot grow an infinite cloud. */
export const CLOUD_TOP_MAX_KM = 16;
export const TEMPERATURE_ADVECTION = 1.1;
export const THERMAL_PRESSURE_COEFF = 0.3;
/**
 * Antagonistic filling: a low whose centre sits inside a high's influence
 * belt loses this many hPa per hPa of the blocking high each round.  Only the
 * strongest overlapping high acts, and a low never fills below the floor.
 * This is the real "cut-off low" mechanism behind level 56.
 */
export const HIGH_CUTOFF_RATE_PER_HPA = 0.1;
export const HIGH_CUTOFF_INFLUENCE = 0.3;
export const HIGH_CUTOFF_MIN_STRENGTH = 2;
/**
 * Air-mass classification (R5): the thermal axis is the equivalent potential
 * temperature anomaly θe − θe(ambient), and the moisture axis is the vapour
 * anomaly q − base.Q.  The neutral band matches the legacy rule
 * (|ΔT| < 1.2 °C and |Δq| < 3 g/m³ ⇒ |Δθe| < ~8.7 K).
 */
export const AIR_MASS_THETA_E_NEUTRAL_K = 8;
export const AIR_MASS_MOIST_ANOMALY = 3;
export const OROGRAPHIC_LIFT = 2;
/** Surface pressure perturbation over terrain (hPa). */
export const TERRAIN_WINDWARD_P = 0.5;
export const TERRAIN_LEE_P = 0.5;
export const TERRAIN_THERMAL_P = 1.0;
export const MOUNTAIN_FRICTION = 0.4;
export const HIGH_LEVEL_COUPLING = 0.9;

/**
 * Frontal lifting maxima. The actual lift scales with the cold/warm strength
 * difference, so steep cold fronts stay concentrated while warm fronts spread.
 */
export const FRONT_LIFT = {
  cold: 6,
  warm: 3,
  stationary: 4.5,
} as const;
export const FRONT_STRENGTH_GAP = 5;
/**
 * θe-equivalent front thresholds, in K/km.  0.010368 K/km ~ 1 K/100 km is the
 * synoptic front criterion; 0.02592 saturates the frontal lift (~2.6 K/100 km,
 * a sharp front).  The diagnosed quantity is |∇(T + 2.5q)| with T in °C and q
 * in g/m³, i.e. an equivalent-potential-temperature gradient in K/km (the
 * latent 2.5 K per g/m³ term is included), NOT a plain °C/km thermal gradient.
 *
 * These replace the old per-pixel 0.018/0.045.  A per-pixel threshold becomes
 * K/km by DIVIDING by the legacy 0.576 km/px: 0.018/0.576 = 0.03125 K/km and
 * 0.045/0.576 = 0.078125 K/km.  Relative to the values below those are
 * 0.03125/0.010368 = 0.078125/0.02592 = 3.01× (= 1/0.576²) stricter, not
 * 1.74×: 1.74 = 1/0.576 is only the single px→km conversion factor, and the
 * old note both understated the ratio and treated it as the threshold ratio.
 */
export const FRONT_GRADIENT_THRESHOLD = 0.010368;
export const FRONT_GRADIENT_FULL = 0.02592;
/**
 * Single front diagnosis (`frontAt`).  A front exists only where a cold and a
 * warm air mass overlap; |∇θe| over a ±8 km stencil sets its intensity.  When
 * the two air masses are stacked at one point the central difference cannot
 * resolve the θe jump (∇→0 at the common centre), so the parcel contrast
 * Δθe/(frontal width) × overlap is used as the sub-grid closure.
 */
/** Minimum cold×warm influence product for a front to exist. */
export const FRONT_OVERLAP_MIN = 0.012;
/** Characteristic width used to turn a Δθe parcel contrast into K/km. */
export const FRONT_CONTRAST_LENGTH_KM = 320;
/**
 * Density-current push, m/s per °C of cold-minus-warm strength.  The front
 * moves with the low-level wind plus the denser air mass undercutting the
 * warmer one; this is the "cold front catches the warm front" mechanism.
 */
export const FRONT_DENSITY_CURRENT = 1.4;
/** |movement along ∇θe| below this is a stationary front (m/s). */
export const FRONT_STATIONARY_SPEED = 3.2;
/** Consecutive rounds of a cold front chasing a warm front before occlusion. */
export const FRONT_OCCLUSION_ROUNDS = 2;
/** Occlusion is reported within this many low radii of the parent low. */
export const FRONT_OCCLUSION_REACH = 1.2;
/** Distinct cold air masses that must wrap the low for an occlusion. */
export const FRONT_OCCLUSION_COLD_MASSES = 2;
/** Occluded lift is the stationary lift scaled by this factor. */
export const FRONT_OCCLUSION_LIFT = 0.8;

/**
 * Shared front semantics for BOTH diagnosis paths.  The analytic field owns
 * `frontAt`; the shallow-water experiment owns `classifyFronts` →
 * `frontTypeName`.  One table holds the Chinese label, the base game-unit lift
 * coefficient and the SWE grid code, so the two paths cannot drift into two
 * label sets or two lift scales.  `frontLabel()` (logic/fronts.ts) stays the
 * UI entry point and is locked to this table by an assertion in verify:scale.
 *
 * `code` mirrors `FrontTypeCode` in logic/physics/thermal.ts (0 none, 1 cold,
 * 2 warm, 3 stationary, 4 occluded).  It is spelled out here rather than
 * imported so the config layer never depends on the physics layer.
 */
export interface FrontSemantics {
  label: string;
  /** Base lift in game units, before shape / overlap / gradient scaling. */
  lift: number;
  /** SWE grid code, see FrontTypeCode. */
  code: 0 | 1 | 2 | 3 | 4;
}

export const FRONT_SEMANTICS: Record<FrontType, FrontSemantics> = {
  none: { label: '无锋面', lift: 0, code: 0 },
  cold: { label: '冷锋', lift: FRONT_LIFT.cold, code: 1 },
  warm: { label: '暖锋', lift: FRONT_LIFT.warm, code: 2 },
  stationary: { label: '准静止锋', lift: FRONT_LIFT.stationary, code: 3 },
  occluded: {
    label: '锢囚锋',
    lift: FRONT_LIFT.stationary * FRONT_OCCLUSION_LIFT,
    code: 4,
  },
};

export const DEPTH_BY_TYPE: Record<EntityType, EntityDepth> = {
  coldHigh: 'shallow',
  warmHigh: 'deep',
  coldLow: 'deep',
  warmLow: 'shallow',
  typhoon: 'deep',
  coldAir: 'none',
  warmAir: 'none',
  wet: 'none',
  trough: 'none',
  inversion: 'none',
  ridge: 'none',
  jet: 'none',
};

export const DEFAULT_LAYER_BY_TYPE: Record<EntityType, MapLayer> = {
  coldHigh: 'low',
  warmHigh: 'low',
  coldLow: 'low',
  warmLow: 'low',
  typhoon: 'low',
  coldAir: 'low',
  warmAir: 'low',
  wet: 'low',
  trough: 'high',
  inversion: 'mid',
  ridge: 'high',
  jet: 'high',
};

export const ENTITY_RADIUS: Record<EntityType, number> = {
  // Pressure centres are authored in kilometres through `defaultEntityRadius`.
  // Cold/warm air masses and moisture also use a compact 160 km default; the
  // upper-air cards keep their existing chart-sized footprint.
  coldHigh: 180,
  warmHigh: 180,
  coldLow: 180,
  warmLow: 180,
  typhoon: 220,
  coldAir: 160,
  warmAir: 160,
  wet: 160,
  trough: 360,
  inversion: 360,
  ridge: 360,
  jet: 400,
};

/** Default radius of a surface pressure centre, in kilometres. */
export const PRESSURE_DEFAULT_RADIUS_KM = 180;
/** Default radius of cold/warm air masses and moisture, in kilometres. */
export const SURFACE_DEFAULT_RADIUS_KM = 160;

/**
 * Readable footprint bounds for any entity, as a fraction of the chart.
 * A 220 km typhoon is 22 % of a 1000 km chart but 220 % of a 100 km valley
 * chart; the latter has to be clamped or the storm covers the whole map.
 */
export const MIN_ENTITY_FRACTION = 0.06;
export const MAX_ENTITY_FRACTION = 0.32;

export function adaptRadiusKm(km: number, domainScale?: number): number {
  const domain = domainScale && domainScale > 0 ? domainScale : MAP_SIZE;
  return Math.min(domain * MAX_ENTITY_FRACTION, Math.max(domain * MIN_ENTITY_FRACTION, km));
}

export function isPressureCenterType(type: EntityType): boolean {
  return (
    type === 'coldHigh' ||
    type === 'warmHigh' ||
    type === 'coldLow' ||
    type === 'warmLow' ||
    type === 'typhoon'
  );
}

export function isLowPressureType(type: EntityType): boolean {
  return type === 'coldLow' || type === 'warmLow' || type === 'typhoon';
}

/** Typhoon cards are authored in kilometres like pressure centres. */
export const TYPHOON_DEFAULT_RADIUS_KM = 220;

export function isCompactSurfaceType(type: EntityType): boolean {
  return type === 'coldAir' || type === 'warmAir' || type === 'wet';
}

/**
 * Default influence radius in chart pixels. Surface systems are authored in
 * kilometres and converted with the level's domain scale, so 180 km pressure
 * centres and 160 km air/moisture blobs stay the same physical size whenever a
 * level changes its chart width.
 */
export function defaultEntityRadius(type: EntityType, domainScale = 1000): number {
  const domain = domainScale && domainScale > 0 ? domainScale : 1000;
  const kmPerPixel = Math.max(1e-6, domain / MAP_SIZE);
  const band = scaleBandFor(domainScale);
  const pressureKm = band === 'large' ? 180 : band === 'meso' ? 80 : 25;
  const surfaceKm = band === 'large' ? 160 : band === 'meso' ? 70 : 20;
  const typhoonKm =
    band === 'large' ? TYPHOON_DEFAULT_RADIUS_KM : band === 'meso' ? 120 : 45;
  // Footprints are clamped to a readable fraction of this chart, so the same
  // authored system never swallows a valley chart or vanishes on a continental
  // one.  At the 1000 km baseline every clamp is inactive.
  if (type === 'typhoon') return adaptRadiusKm(typhoonKm, domain) / kmPerPixel;
  if (isPressureCenterType(type)) return adaptRadiusKm(pressureKm, domain) / kmPerPixel;
  if (isCompactSurfaceType(type)) return adaptRadiusKm(surfaceKm, domain) / kmPerPixel;
  return ENTITY_RADIUS[type];
}

export const ENTITY_STRENGTHS: Record<EntityType, number[]> = {
  coldHigh: [5, 10, 20],
  warmHigh: [5, 10, 20],
  coldLow: [5, 10, 20],
  warmLow: [5, 10, 20],
  typhoon: [20, 35, 50],
  coldAir: [5, 10, 15, 20],
  warmAir: [5, 10, 15, 20],
  wet: [20, 40],
  trough: [1, 2, 3],
  inversion: [1, 2],
  ridge: [1, 2, 3],
  jet: [1, 2, 3],
};

export const CARD_STRENGTHS: Record<CardType, number[]> = {
  H: [5, 10, 20],
  L: [5, 10, 20],
  /** Signed tiers come from `airCardTiers()` because they depend on the chart. */
  air: [],
  moisture: [20, 40],
  trough: [1, 2, 3],
  inversion: [1, 2],
  ridge: [1, 2, 3],
  jet: [1, 2, 3],
};

/**
 * Temperature tiers of the air-mass card, signed: negative is cold, positive
 * is warm.  Zero is deliberately absent -- an air card with no temperature
 * anomaly would place nothing, and the moisture it used to carry is now its own
 * card with its own drop point.
 */
export function airCardTiers(domainScale?: number): number[] {
  const magnitudes = AIR_TIERS[scaleBandFor(domainScale)];
  return [...magnitudes].reverse().map((value) => -value).concat(magnitudes);
}

/** Magnitudes only (entity popover, strength labels). */
export function airTemperatureTiers(domainScale?: number): number[] {
  return AIR_TIERS[scaleBandFor(domainScale)];
}

export type ScaleBand = 'large' | 'meso' | 'local';

/**
 * Current campaign levels use 1000 km (Stage 1) or the legacy 576 km chart;
 * both are treated as the large-scale band. Future 200/50 km levels resolve to
 * the meso/local bands automatically through `base.domainScale`.
 */
export function scaleBandFor(domainScale?: number): ScaleBand {
  const domain = domainScale ?? 1000;
  if (domain >= 500) return 'large';
  if (domain >= 100) return 'meso';
  return 'local';
}

const PRESSURE_TIERS: Record<ScaleBand, number[]> = {
  large: [5, 10, 20],
  meso: [2, 5, 10],
  local: [1, 2, 5],
};

const AIR_TIERS: Record<ScaleBand, number[]> = {
  large: [5, 10, 15, 20],
  meso: [2, 5, 8, 10],
  local: [2, 4, 6],
};

/** Strength chips offered by the deck for a card at this domain scale. */
export function cardStrengthTiers(card: CardType, domainScale?: number): number[] {
  if (card === 'H' || card === 'L') return PRESSURE_TIERS[scaleBandFor(domainScale)];
  if (card === 'air') return airCardTiers(domainScale);
  return CARD_STRENGTHS[card];
}

/** Strength chips offered by the entity popover at this domain scale. */
export function entityStrengthTiers(type: EntityType, domainScale?: number): number[] {
  if (
    type === 'coldHigh' ||
    type === 'warmHigh' ||
    type === 'coldLow' ||
    type === 'warmLow'
  ) {
    return PRESSURE_TIERS[scaleBandFor(domainScale)];
  }
  if (type === 'coldAir' || type === 'warmAir') {
    return AIR_TIERS[scaleBandFor(domainScale)];
  }
  return ENTITY_STRENGTHS[type];
}

/**
 * Burst-protection floor for pressure centres: at 20 hPa the UI radius must be
 * at least 130 km, at 10 hPa 80 km, at 5 hPa 40 km. Lower tiers interpolate
 * down to 15 km. The radius is a real field radius, not a display-only value.
 */
export function minPressureRadiusKm(strength: number): number {
  const value = Math.abs(strength);
  if (value >= 20) return 130;
  if (value >= 15) return 105;
  if (value >= 10) return 80;
  if (value >= 5) return 40;
  if (value >= 2) return 20;
  return 15;
}

export interface EntityMeta {
  name: string;
  unit: string;
  effect: string;
  depthLabel: string;
  color: number;
  cssColor: string;
  glyph: string;
}

export const ENTITY_META: Record<EntityType, EntityMeta> = {
  coldHigh: {
    name: '冷高压',
    unit: 'hPa',
    effect: '浅薄高压 · 低层下沉',
    depthLabel: '浅薄',
    color: 0x6caddf,
    cssColor: '#6caddf',
    glyph: 'H',
  },
  warmHigh: {
    name: '暖高压',
    unit: 'hPa',
    effect: '深厚高压 · 高层强下沉',
    depthLabel: '深厚',
    color: 0xd8a15e,
    cssColor: '#d8a15e',
    glyph: 'H',
  },
  coldLow: {
    name: '冷低压',
    unit: 'hPa',
    effect: '深厚低压 · 高层强上升',
    depthLabel: '深厚',
    color: 0x5d9bd5,
    cssColor: '#6ba6dd',
    glyph: 'L',
  },
  warmLow: {
    name: '暖低压',
    unit: 'hPa',
    effect: '浅薄低压 · 高层弱上升',
    depthLabel: '浅薄',
    color: 0xe0a15a,
    cssColor: '#e0a15a',
    glyph: 'L',
  },
  typhoon: {
    name: '台风',
    unit: 'hPa',
    effect: '暖心低压 · 眼墙上升 · 螺旋雨带',
    depthLabel: '深厚暖心',
    color: 0x9b7bd4,
    cssColor: '#a98ae0',
    glyph: '台',
  },
  coldAir: {
    name: '冷气团',
    unit: '°C',
    effect: '温度降低 · 密度升高',
    depthLabel: '地面',
    color: 0x5f8fd7,
    cssColor: '#6f9de0',
    glyph: '冷',
  },
  warmAir: {
    name: '暖气团',
    unit: '°C',
    effect: '温度升高 · 密度降低',
    depthLabel: '地面',
    color: 0xd7766a,
    cssColor: '#d98376',
    glyph: '暖',
  },
  wet: {
    name: '水汽',
    unit: 'g/m³',
    effect: '水汽升高 · 随风吹送',
    depthLabel: '地面',
    color: 0x58c5c8,
    cssColor: '#5ccbd0',
    glyph: '汽',
  },
  trough: {
    name: '高空槽',
    unit: '',
    effect: '槽前低压加深 · 高层抬升',
    depthLabel: '高空',
    color: 0x9a8be0,
    cssColor: '#a495e8',
    glyph: '槽',
  },
  ridge: {
    name: '高空脊',
    unit: '',
    effect: '脊前高层下沉 · 压制低压',
    depthLabel: '高空',
    color: 0xd5945c,
    cssColor: '#dda36b',
    glyph: '脊',
  },
  inversion: {
    name: '层结',
    unit: '',
    effect: '改变稳定度 · 放大或压制上升',
    depthLabel: '中层',
    color: 0x9fbf79,
    cssColor: '#a9c985',
    glyph: '结',
  },
  jet: {
    name: '急流',
    unit: '',
    effect: '高空强风 · 加速系统移动',
    depthLabel: '高空',
    color: 0x7cc7e8,
    cssColor: '#86d0ee',
    glyph: '急',
  },
};

export interface CardMeta {
  name: string;
  unit: string;
  effect: string;
  color: number;
  cssColor: string;
  glyph: string;
  group: 'weather' | 'upper';
}

export const CARD_META: Record<CardType, CardMeta> = {
  H: {
    name: '高压',
    unit: 'hPa',
    effect: '气压升高 · 空气下沉',
    color: 0x75a9d8,
    cssColor: '#7cafe0',
    glyph: 'H',
    group: 'weather',
  },
  L: {
    name: '低压',
    unit: 'hPa',
    effect: '气压降低 · 空气上升',
    color: 0xe0a15a,
    cssColor: '#e0a15a',
    glyph: 'L',
    group: 'weather',
  },
  air: {
    name: '气团',
    unit: '°C',
    effect: '冷热 · 单一落点',
    color: 0x6f9de0,
    cssColor: '#7fb0e6',
    glyph: '气',
    group: 'weather',
  },
  moisture: {
    name: '水汽',
    unit: 'g/m³',
    effect: '独立水汽源 · 可放在上风侧',
    color: 0x4fb3c9,
    cssColor: '#5fc0d6',
    glyph: '汽',
    group: 'weather',
  },
  trough: {
    name: '高空槽',
    unit: '',
    effect: '低压加深 · 高层抬升',
    color: 0x9a8be0,
    cssColor: '#a495e8',
    glyph: '槽',
    group: 'upper',
  },
  ridge: {
    name: '高空脊',
    unit: '',
    effect: '高层下沉 · 抑制低压',
    color: 0xd5945c,
    cssColor: '#dda36b',
    glyph: '脊',
    group: 'upper',
  },
  inversion: {
    name: '层结',
    unit: '',
    effect: '改变稳定度',
    color: 0x9fbf79,
    cssColor: '#a9c985',
    glyph: '结',
    group: 'upper',
  },
  jet: {
    name: '急流',
    unit: '',
    effect: '高空强风 · 引导系统',
    color: 0x7cc7e8,
    cssColor: '#86d0ee',
    glyph: '急',
    group: 'upper',
  },
};

export const CARD_VARIANTS: Partial<Record<CardType, EntityType[]>> = {
  H: ['coldHigh', 'warmHigh'],
  L: ['coldLow', 'warmLow'],
};

export const DEFAULT_VARIANT: Partial<Record<CardType, EntityType>> = {
  H: 'warmHigh',
  L: 'coldLow',
};

export const CARD_ENTITY_TYPE: Record<Exclude<CardType, 'H' | 'L'>, EntityType> = {
  /** The air card resolves per placement by the sign of its tier. */
  air: 'coldAir',
  moisture: 'wet',
  trough: 'trough',
  inversion: 'inversion',
  ridge: 'ridge',
  jet: 'jet',
};

export const CARD_UNLOCK: Record<CardType, number> = {
  L: 1,
  moisture: 2,
  H: 4,
  air: 6,
  trough: 30,
  ridge: 31,
  inversion: 32,
  jet: 34,
};

export const CARD_HOTKEYS: Record<string, CardType> = {
  '1': 'H',
  '2': 'L',
  '3': 'air',
  '4': 'moisture',
};

export const INVERSION_LABEL: Record<InversionMode, string> = {
  unstable: '上冷下暖',
  stable: '上暖下冷',
};

// ---------------------------------------------------------------------------
// Tropical cyclone model
// ---------------------------------------------------------------------------
/** Eyewall radius as a fraction of the storm radius; the eye is calmer. */
export const TYPHOON_EYEWALL_CENTER = 0.34;
export const TYPHOON_EYEWALL_WIDTH = 0.22;
export const TYPHOON_EYE_FRACTION = 0.14;
/** Eyewall ascent, eye subsidence, moisture and warm-core strength per hPa. */
export const TYPHOON_LIFT_PER_HPA = 0.22;
export const TYPHOON_EYE_SINK_PER_HPA = 0.10;
export const TYPHOON_MOISTURE_PER_HPA = 1.2;
export const TYPHOON_WARM_CORE_PER_HPA = 0.055;
export const TYPHOON_HIGH_DIVERGENCE_PER_HPA = 0.075;
export const TYPHOON_HIGH_P_GAIN = 0.35;
/** Pressure profile: exp(-falloff * (r/R)^power), a broad warm-core low. */
export const TYPHOON_PRESSURE_POWER = 2.0;
export const TYPHOON_PRESSURE_FALLOFF = 2.2;
/** Per-round steering and beta drift, km. */
export const TYPHOON_BETA_DRIFT_KM = 35;
export const TYPHOON_MAX_DRIFT_KM = 100;
/** Per-round intensity change, hPa. */
export const TYPHOON_INTENSIFY_STEP = 10;
/**
 * Rounds a warm-core low must spend raining over warm sea before it becomes a
 * tropical cyclone. Two rounds is the shortest span that still reads as a
 * process rather than a switch.
 */
export const WARM_CORE_ROUNDS_FOR_TYPHOON = 2;
/** Rain rate a warm-core low needs to count as convecting, mm/3h. */
export const WARM_CORE_RAIN_THRESHOLD = 0.05;
export const TYPHOON_LAND_DECAY = 5;
export const TYPHOON_COLD_SEA_DECAY = 3;
export const TYPHOON_MIN_SST = 26.5;
export const TYPHOON_MIN_STRENGTH = 10;
export const TYPHOON_MAX_STRENGTH = 65;
/** Central-pressure deficits that separate TD / TS / TY / STY. */
export const TYPHOON_CATEGORY_THRESHOLDS = [25, 40, 55] as const;
export const TYPHOON_CATEGORY_LABELS = ['热带低压', '热带风暴', '台风', '强台风'] as const;

/** A stable inversion supplies a mid-level warm nose for freezing rain. */
export const MID_LAYER_TEMPERATURE_GAIN = 3.5;
export const FREEZING_RAIN_MID_T = 2.5;
/** Minimum inversion-created warm nose above the surface, °C. */
export const FREEZING_RAIN_WARM_NOSE = 3;
export const FREEZING_RAIN_SURFACE_T = 0.5;
/** Rotation threshold for a mesocyclone / tornado, 10⁻⁴ s⁻¹. */
export const MESOCYCLONE_VORTICITY = 4;
export const TORNADO_VORTICITY = 6;
export const TORNADO_SHEAR = 25;

/**
 * Saturation vapour density in g/m³, sampled every 5°C (WMO-style table).
 * Values are linearly interpolated by the temperature at each sample point.
 */
export const QSAT_TABLE: Array<[number, number]> = [
  [-15, 1.63],
  [-10, 2.36],
  [-5, 3.41],
  [0, 4.85],
  [5, 6.8],
  [10, 9.4],
  [15, 12.83],
  [20, 17.3],
  [25, 23.04],
  [30, 30.38],
  [35, 39.63],
  [40, 51.12],
];

/** GB/T 28592-2012, 24-hour precipitation grades. */
export const RAIN_GRADES = [
  { name: '小雨', min: 0.1, max: 10, color: [161, 241, 141] },
  { name: '中雨', min: 10, max: 25, color: [61, 186, 61] },
  { name: '大雨', min: 25, max: 50, color: [96, 184, 255] },
  { name: '暴雨', min: 50, max: 100, color: [0, 0, 255] },
  { name: '大暴雨', min: 100, max: 250, color: [250, 0, 250] },
  { name: '特大暴雨', min: 250, max: Number.POSITIVE_INFINITY, color: [128, 0, 64] },
] as const;

/** Exact GB/T 35968-2018 precipitation colour keys. */
export const WEATHER_COLORS = {
  rain: [161, 241, 141] as [number, number, number],
  rainModerate: [61, 186, 61] as [number, number, number],
  rainHeavy: [96, 184, 255] as [number, number, number],
  rainStorm: [0, 0, 255] as [number, number, number],
  rainExtreme: [250, 0, 250] as [number, number, number],
  rainSevere: [128, 0, 64] as [number, number, number],
  cold: [95, 143, 215] as [number, number, number],
  warm: [215, 118, 106] as [number, number, number],
  wet: [88, 197, 200] as [number, number, number],
};
