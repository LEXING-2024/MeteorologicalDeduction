/**
 * The physical weather field: cards -> initial mass/heat/moisture field ->
 * shallow-water spin-up -> sampled pressure, wind, temperature, fronts and
 * vertical motion.
 *
 * This is an experimental forecast/sandbox engine.  Playable levels use the
 * deterministic analytic field in `field.ts`; only a level with
 * `base.physics === 'swe'` is routed through this class.
 *
 * All prognostic fields are Float64; `buildGrid()` is the only place that
 * converts to Float32 for rendering, exactly as the design document requires.
 */

import { MAP_SIZE } from '../../../src/config/constants';
import type { BaseConditions, WeatherEntity } from '../../../src/logic/types';
import { ShallowWaterSolver, type ShallowWaterOptions } from '../ShallowWaterSolver';
import {
  PHYSICS,
  depthToPressureHpa,
  pressureHpaToDepth,
  temperatureToDepth,
} from './constants';
import {
  FRONT_COLD,
  FRONT_NONE,
  FRONT_STATIONARY,
  FRONT_WARM,
  advectScalarSL,
  ascentToGameW,
  classifyFronts,
  clamp,
  computeConvergenceLift,
  computeGradient,
  computeTerrainLift,
  computeVorticity,
  frontTypeName,
  sampleField,
  type FrontTypeCode,
} from './thermal';

export interface WeatherFieldOptions extends ShallowWaterOptions {
  /** Base pressure/temperature/moisture of the level. */
  base?: BaseConditions;
  /** Initialise the wind geostrophically (default true). */
  balanced?: boolean;
  /** Couple temperature anomalies to the free surface (default true). */
  thermalCoupling?: boolean;
}

export interface FrontSample {
  type: 'none' | 'cold' | 'warm' | 'stationary';
  /** 0..1, from the |grad T| threshold to a fully developed front. */
  strength: number;
  /** |grad T| in K / 100 km. */
  gradientK100: number;
  /** Thermal advection in K/h; negative is warm advection. */
  advectionKh: number;
}

export interface FieldSample {
  xMetres: number;
  yMetres: number;
  pressureHpa: number;
  heightMetres: number;
  temperatureC: number;
  moisture: number;
  stability: number;
  elevationMetres: number;
  /** Eastward wind, m/s. */
  u: number;
  /** Northward wind, m/s. */
  v: number;
  speed: number;
  /** Meteorological direction the wind comes FROM, clockwise from north. */
  fromDeg: number;
  divergence: number;
  /** Relative vorticity at the sample point, s^-1. */
  vorticity: number;
  /** -H * divergence, m/s (positive = convergence ascent). */
  wConvergence: number;
  /** Boundary-layer Ekman pumping, m/s (positive in a cyclone). */
  wEkman: number;
  /** V . grad(z), m/s (positive on a windward slope). */
  wTerrain: number;
  /** Composed physical ascent, m/s. */
  wTotal: number;
  /** Composed ascent in the 0-14 game index. */
  wGame: number;
  front: FrontSample;
}

export interface FieldGrid {
  n: number;
  spacing: number;
  pressureHpa: Float32Array;
  heightMetres: Float32Array;
  temperatureC: Float32Array;
  moisture: Float32Array;
  uScreen: Float32Array;
  vScreen: Float32Array;
  speed: Float32Array;
  wGame: Float32Array;
  wTerrain: Float32Array;
  divergence: Float32Array;
  frontStrength: Float32Array;
  frontType: Uint8Array;
}

export interface BalanceReport {
  /** max |vorticity| / f inside the sponge-free interior. */
  rossby: number;
  /** Initial maximum wind speed, m/s. */
  maxSpeed: number;
  /** Non-empty when the initial state is strongly ageostrophic. */
  warning: string;
}

const DEFAULT_BASE: BaseConditions = {
  P: PHYSICS.basePressureHpa,
  T: 22,
  Q: 7.4,
  latitude: 45,
  hemisphere: 'N',
};

export class WeatherField {
  public readonly solver: ShallowWaterSolver;
  public readonly base: BaseConditions;
  public temperature: Float64Array;
  public moisture: Float64Array;
  public readonly stability: Float64Array;
  /** Parameterised upper-level ascent forcing from trough/ridge/jet cards, m/s. */
  public readonly upperForcing: Float64Array;
  public readonly thermalCoupling: boolean;

  public temperatureNext: Float64Array;
  public moistureNext: Float64Array;

  private readonly heightSeed: Float64Array;
  private readonly gradientX: Float64Array;
  private readonly gradientY: Float64Array;
  private readonly terrainGradientX: Float64Array;
  private readonly terrainGradientY: Float64Array;
  private readonly frontStrength: Float64Array;
  private readonly frontType: Uint8Array;
  private readonly frontAdvection: Float64Array;
  private readonly divergence: Float64Array;
  private readonly vorticity: Float64Array;
  private readonly wConvergence: Float64Array;
  private readonly wTerrain: Float64Array;
  private diagnosticsDirty = true;
  private initialised = false;
  /** Balance diagnostics from the last commit. */
  public balance: BalanceReport = { rossby: 0, maxSpeed: 0, warning: '' };

  public constructor(options: WeatherFieldOptions = {}) {
    const base = { ...DEFAULT_BASE, ...(options.base ?? {}) };
    this.base = base;
    this.thermalCoupling = options.thermalCoupling ?? true;
    const { base: _base, balanced, thermalCoupling, ...solverOptions } = options;
    void _base;
    void balanced;
    void thermalCoupling;
    this.solver = new ShallowWaterSolver({
      ...solverOptions,
      hemisphere: base.hemisphere,
      basePressureHpa: base.P,
    });
    const cells = this.solver.cells;
    this.temperature = new Float64Array(cells);
    this.temperatureNext = new Float64Array(cells);
    this.moisture = new Float64Array(cells);
    this.moistureNext = new Float64Array(cells);
    this.stability = new Float64Array(cells);
    this.upperForcing = new Float64Array(cells);
    this.heightSeed = new Float64Array(cells);
    this.gradientX = new Float64Array(cells);
    this.gradientY = new Float64Array(cells);
    this.terrainGradientX = new Float64Array(cells);
    this.terrainGradientY = new Float64Array(cells);
    this.frontStrength = new Float64Array(cells);
    this.frontType = new Uint8Array(cells);
    this.frontAdvection = new Float64Array(cells);
    this.divergence = new Float64Array(cells);
    this.vorticity = new Float64Array(cells);
    this.wConvergence = new Float64Array(cells);
    this.wTerrain = new Float64Array(cells);
    this.resetThermodynamics();
  }

  public get n(): number {
    return this.solver.n;
  }

  public get dx(): number {
    return this.solver.dx;
  }

  public get domainMetres(): number {
    return this.solver.domainMetres;
  }

  public get timeSeconds(): number {
    return this.solver.timeSeconds;
  }

  /** Terrain height in metres at the chart's cell centres. */
  public setTerrain(terrain: Float64Array | Float32Array): void {
    this.solver.setTerrain(terrain);
    this.diagnosticsDirty = true;
  }

  /** Build a terrain field from a physical callback (x east, y north, metres). */
  public setTerrainFromCallback(
    elevation: (xMetres: number, yMetres: number) => number,
  ): void {
    const n = this.solver.n;
    const dx = this.solver.dx;
    const terrain = new Float64Array(n * n);
    for (let j = 0; j < n; j += 1) {
      const y = (j + 0.5) * dx;
      for (let i = 0; i < n; i += 1) {
        const value = elevation((i + 0.5) * dx, y);
        terrain[j * n + i] = Number.isFinite(value) && value > 0 ? value : 0;
      }
    }
    this.setTerrain(terrain);
  }

  public getTerrain(): Float64Array {
    return this.solver.getTerrain();
  }

  /** Reset temperature, moisture, stability and upper forcing to the base state. */
  public resetThermodynamics(): void {
    this.temperature.fill(this.base.T);
    this.moisture.fill(this.base.Q);
    this.stability.fill(0);
    this.upperForcing.fill(0);
    this.temperatureNext.fill(this.base.T);
    this.moistureNext.fill(this.base.Q);
  }

  /**
   * Load a set of cards into the field.  Pressure cards add pressure depth,
   * cold/warm cards add temperature (and, through the hydrostatic coupling, the
   * opposite-signed depth anomaly), wet cards add moisture, inversion cards add
   * static stability.  The wind is then initialised geostrophically and the
   * caller can run the spin-up.
   */
  public loadEntities(entities: WeatherEntity[], options: { balanced?: boolean } = {}): void {
    const n = this.solver.n;
    const dx = this.solver.dx;
    const domain = this.solver.domainMetres;
    const metresPerPixel = domain / MAP_SIZE;
    this.resetThermodynamics();
    this.heightSeed.fill(0);

    for (const entity of entities) {
      if (!entity) continue;
      const centreX = entity.x * metresPerPixel;
      const centreY = (MAP_SIZE - entity.y) * metresPerPixel;
      const radiusMetres = Math.max(5, entity.radius) * metresPerPixel;
      const sigma = Math.max(20_000, radiusMetres * 0.55);
      const cutoff = 3 * sigma;
      const cutoffSq = cutoff * cutoff;
      const i0 = Math.max(0, Math.floor((centreX - cutoff) / dx - 0.5));
      const i1 = Math.min(n - 1, Math.ceil((centreX + cutoff) / dx - 0.5));
      const j0 = Math.max(0, Math.floor((centreY - cutoff) / dx - 0.5));
      const j1 = Math.min(n - 1, Math.ceil((centreY + cutoff) / dx - 0.5));
      const invSigmaSq = 1 / (2 * sigma * sigma);
      const strength = Math.abs(entity.strength);
      if (!(strength > 0)) continue;

      for (let j = j0; j <= j1; j += 1) {
        const y = (j + 0.5) * dx - centreY;
        const row = j * n;
        for (let i = i0; i <= i1; i += 1) {
          const x = (i + 0.5) * dx - centreX;
          const distanceSq = x * x + y * y;
          if (distanceSq > cutoffSq) continue;
          const influence = Math.exp(-distanceSq * invSigmaSq);
          const index = row + i;
          switch (entity.type) {
            case 'coldHigh':
            case 'warmHigh':
              this.heightSeed[index] += pressureHpaToDepth(strength) * influence;
              break;
            case 'coldLow':
            case 'warmLow':
              this.heightSeed[index] -= pressureHpaToDepth(strength) * influence;
              break;
            case 'coldAir': {
              const deltaT = -strength * influence;
              this.temperature[index] += deltaT;
              if (this.thermalCoupling) {
                this.heightSeed[index] += temperatureToDepth(deltaT, this.base.T + 273.15);
              }
              break;
            }
            case 'warmAir': {
              const deltaT = strength * influence;
              this.temperature[index] += deltaT;
              if (this.thermalCoupling) {
                this.heightSeed[index] += temperatureToDepth(deltaT, this.base.T + 273.15);
              }
              break;
            }
            case 'wet':
              this.moisture[index] += strength * influence;
              break;
            case 'inversion':
              this.stability[index] +=
                (entity.inversionMode === 'stable' ? -1 : 1) * strength * influence;
              break;
            case 'trough':
              this.heightSeed[index] -= pressureHpaToDepth(0.6 * strength) * influence;
              this.upperForcing[index] += 0.06 * strength * influence;
              break;
            case 'ridge':
              this.heightSeed[index] += pressureHpaToDepth(0.6 * strength) * influence;
              this.upperForcing[index] -= 0.06 * strength * influence;
              break;
            case 'jet':
              this.upperForcing[index] += 0.04 * strength * influence;
              break;
            default:
              break;
          }
        }
      }
    }

    this.commit(options.balanced ?? true);
  }

  /**
   * Commit an already-built height field (metres) with the current temperature,
   * moisture and stability fields.  Useful for tests and for level scripts that
   * want to inject a non-Gaussian initial state.
   */
  public commit(balanced = true): void {
    this.solver.setInitialHeight(this.heightSeed);
    if (balanced) this.solver.initializeGeostrophic();
    this.solver.updateCellVelocity();
    this.initialised = true;
    this.diagnosticsDirty = true;
    const rossby = this.solver.maxRossbyNumber();
    const maxSpeed = this.solver.maxSpeed();
    this.balance = {
      rossby,
      maxSpeed,
      warning:
        rossby > 1
          ? `initial Rossby number ${rossby.toFixed(2)} > 1: geostrophic balance is not valid at this card amplitude/radius`
          : '',
    };
    this.refreshDiagnostics();
  }

  /** Directly set the seeder height field (metres, pressure anomaly). */
  public setHeight(height: Float64Array): void {
    if (height.length !== this.solver.cells) {
      throw new Error(`height must have ${this.solver.cells} values`);
    }
    this.heightSeed.set(height);
  }

  public setTemperature(temperature: Float64Array): void {
    if (temperature.length !== this.solver.cells) {
      throw new Error(`temperature must have ${this.solver.cells} values`);
    }
    this.temperature.set(temperature);
    this.diagnosticsDirty = true;
  }

  public setMoisture(moisture: Float64Array): void {
    if (moisture.length !== this.solver.cells) {
      throw new Error(`moisture must have ${this.solver.cells} values`);
    }
    this.moisture.set(moisture);
    this.diagnosticsDirty = true;
  }

  public setStability(stability: Float64Array): void {
    if (stability.length !== this.solver.cells) {
      throw new Error(`stability must have ${this.solver.cells} values`);
    }
    this.stability.set(stability);
    this.diagnosticsDirty = true;
  }

  /**
   * Run the spin-up.  The solver splits each `dtSeconds` weather step into
   * CFL-safe substeps; the temperature and moisture are advected once per
   * weather step with the resulting cell-centred wind.
   */
  public run(seconds: number, dtSeconds = 10): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) {
      throw new Error('dtSeconds must be positive');
    }
    const steps = Math.max(1, Math.round(seconds / dtSeconds));
    for (let step = 0; step < steps; step += 1) {
      this.solver.step(dtSeconds);
      this.solver.updateCellVelocity();
      advectScalarSL(
        this.temperature,
        this.temperatureNext,
        this.solver.cellU,
        this.solver.cellV,
        this.solver.n,
        this.solver.dx,
        dtSeconds,
      );
      const temperatureSwap = this.temperature;
      this.temperature = this.temperatureNext;
      this.temperatureNext = temperatureSwap;
      advectScalarSL(
        this.moisture,
        this.moistureNext,
        this.solver.cellU,
        this.solver.cellV,
        this.solver.n,
        this.solver.dx,
        dtSeconds,
      );
      const moistureSwap = this.moisture;
      this.moisture = this.moistureNext;
      this.moistureNext = moistureSwap;
    }
    this.diagnosticsDirty = true;
  }

  /** Recompute gradients, fronts, divergence and terrain lift. */
  public refreshDiagnostics(): void {
    const n = this.solver.n;
    const dx = this.solver.dx;
    this.solver.updateCellVelocity();
    const u = this.solver.cellU;
    const v = this.solver.cellV;
    const div = this.solver.getDivergence();
    this.divergence.set(div);
    computeVorticity(u, v, n, dx, this.vorticity);
    computeGradient(this.temperature, n, dx, this.gradientX, this.gradientY);
    classifyFronts(
      this.temperature,
      u,
      v,
      n,
      dx,
      this.gradientX,
      this.gradientY,
      this.frontStrength,
      this.frontType,
      this.frontAdvection,
    );
    computeTerrainLift(
      u,
      v,
      this.solver.getTerrain(),
      n,
      dx,
      this.terrainGradientX,
      this.terrainGradientY,
      this.wTerrain,
    );
    computeConvergenceLift(
      div,
      this.solver.meanDepth,
      this.solver.h,
      this.solver.getTerrain(),
      n,
      this.wConvergence,
    );
    this.diagnosticsDirty = false;
  }

  public sampleScreen(xPixels: number, yPixels: number): FieldSample {
    const scale = this.domainMetres / MAP_SIZE;
    return this.sampleMetres(xPixels * scale, (MAP_SIZE - yPixels) * scale);
  }

  public sampleMetres(xMetres: number, yMetres: number): FieldSample {
    if (this.diagnosticsDirty) this.refreshDiagnostics();
    const n = this.solver.n;
    const dx = this.solver.dx;
    const x = clamp(xMetres, 0, this.domainMetres);
    const y = clamp(yMetres, 0, this.domainMetres);
    const height = sampleField(this.solver.h, n, dx, x, y);
    const temperature = sampleField(this.temperature, n, dx, x, y);
    const moisture = sampleField(this.moisture, n, dx, x, y);
    const stability = sampleField(this.stability, n, dx, x, y);
    const elevation = sampleField(this.solver.getTerrain(), n, dx, x, y);
    const u = sampleField(this.solver.cellU, n, dx, x, y);
    const v = sampleField(this.solver.cellV, n, dx, x, y);
    const divergence = sampleField(this.divergence, n, dx, x, y);
    const vorticity = sampleField(this.vorticity, n, dx, x, y);
    const wConvergence = sampleField(this.wConvergence, n, dx, x, y);
    const wEkman =
      this.solver.f !== 0
        ? clamp((vorticity / this.solver.f) * PHYSICS.ekmanAscentPerRossby, -2, 2)
        : 0;
    const wTerrain = sampleField(this.wTerrain, n, dx, x, y);
    const frontStrength = sampleField(this.frontStrength, n, dx, x, y);
    const advectionKh = sampleField(this.frontAdvection, n, dx, x, y);
    const gradientK100 = Math.hypot(
      sampleField(this.gradientX, n, dx, x, y),
      sampleField(this.gradientY, n, dx, x, y),
    ) * 1e5;
    const nearestI = clamp(Math.floor(x / dx), 0, n - 1);
    const nearestJ = clamp(Math.floor(y / dx), 0, n - 1);
    const frontType = this.frontType[nearestJ * n + nearestI] as FrontTypeCode;

    const frontLift =
      frontStrength *
      (frontType === FRONT_COLD ? 0.22 : frontType === FRONT_WARM ? 0.13 : frontType === FRONT_STATIONARY ? 0.09 : 0);
    const upper = sampleField(this.upperForcing, n, dx, x, y);
    const rawAscent = wConvergence + wEkman + frontLift + upper;
    const stabilityAmplifier = stability > 0.04 ? 1.5 : stability < -0.04 ? 0.5 : 1;
    const amplified = rawAscent > 0 ? rawAscent * stabilityAmplifier : rawAscent;
    const wTotal = clamp(amplified + wTerrain, -2, 2);
    const speed = Math.hypot(u, v);
    const fromDeg = speed > 0.05 ? (Math.atan2(-u, -v) * 180) / Math.PI : 0;
    const pressureHpa = this.base.P + depthToPressureHpa(height);

    return {
      xMetres: x,
      yMetres: y,
      pressureHpa,
      heightMetres: height,
      temperatureC: temperature,
      moisture,
      stability,
      elevationMetres: elevation,
      u,
      v,
      speed,
      fromDeg: ((fromDeg % 360) + 360) % 360,
      divergence,
      vorticity,
      wConvergence,
      wEkman,
      wTerrain,
      wTotal,
      wGame: ascentToGameW(wTotal),
      front: {
        type: frontTypeName(frontType),
        strength: frontStrength,
        gradientK100,
        advectionKh,
      },
    };
  }

  /**
   * Sample the field onto a regular Float32 grid for rendering / the station
   * layer.  By default the grid is in screen orientation (row 0 north, v
   * positive south) so the existing chart code can consume it directly.
   */
  public buildGrid(n = this.solver.n, screenSpace = true): FieldGrid {
    if (this.diagnosticsDirty) this.refreshDiagnostics();
    const spacing = this.domainMetres / n;
    const count = n * n;
    const pressureHpa = new Float32Array(count);
    const heightMetres = new Float32Array(count);
    const temperatureC = new Float32Array(count);
    const moisture = new Float32Array(count);
    const uScreen = new Float32Array(count);
    const vScreen = new Float32Array(count);
    const speed = new Float32Array(count);
    const wGame = new Float32Array(count);
    const wTerrain = new Float32Array(count);
    const divergence = new Float32Array(count);
    const frontStrength = new Float32Array(count);
    const frontType = new Uint8Array(count);
    for (let j = 0; j < n; j += 1) {
      const y = screenSpace
        ? this.domainMetres - (j + 0.5) * spacing
        : (j + 0.5) * spacing;
      for (let i = 0; i < n; i += 1) {
        const x = (i + 0.5) * spacing;
        const sample = this.sampleMetres(x, y);
        const index = j * n + i;
        pressureHpa[index] = sample.pressureHpa;
        heightMetres[index] = sample.heightMetres;
        temperatureC[index] = sample.temperatureC;
        moisture[index] = sample.moisture;
        uScreen[index] = sample.u;
        vScreen[index] = screenSpace ? -sample.v : sample.v;
        speed[index] = sample.speed;
        wGame[index] = sample.wGame;
        wTerrain[index] = sample.wTerrain;
        divergence[index] = sample.divergence;
        frontStrength[index] = sample.front.strength;
        frontType[index] =
          sample.front.type === 'cold'
            ? FRONT_COLD
            : sample.front.type === 'warm'
              ? FRONT_WARM
              : sample.front.type === 'stationary'
                ? FRONT_STATIONARY
                : FRONT_NONE;
      }
    }
    return {
      n,
      spacing,
      pressureHpa,
      heightMetres,
      temperatureC,
      moisture,
      uScreen,
      vScreen,
      speed,
      wGame,
      wTerrain,
      divergence,
      frontStrength,
      frontType,
    };
  }

  public get ready(): boolean {
    return this.initialised;
  }
}
