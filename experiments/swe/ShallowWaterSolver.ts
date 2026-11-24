/**
 * Rotating shallow-water core on a plane Arakawa C-grid.
 *
 * This module is deliberately free of DOM, Phaser and module-level mutable
 * state.  Everything lives inside the instance, so it can run in Node tests or
 * inside a Web Worker unchanged.
 *
 * Coordinate frame
 * ----------------
 * x points east, y points north, and grid row j = 0 is the SOUTHERN edge.
 * This is a right-handed physical frame; screen-space consumers must flip the
 * rows (the renderer uses y downwards).  Keeping the solver in a right-handed
 * frame makes the Coriolis sign, the geostrophic relation and the vorticity all
 * agree with textbook meteorology, which avoids the class of sign bugs that
 * plagued the previous experimental implementation.
 *
 * Layout
 * ------
 *   h[j*n + i]              cell centre            (x=(i+0.5)dx, y=(j+0.5)dx)
 *   u[j*(n+1) + i]          east face              (x=i*dx,       y=(j+0.5)dx)
 *   v[j*n + i]              north face             (x=(i+0.5)dx,  y=j*dx)
 *   zeta[j*(n+1) + i]       corner                 (x=i*dx,       y=j*dx)
 *
 * Closed boundaries set the normal face velocities to zero.  A Rayleigh sponge
 * layer in the outermost `spongeCells` cells damps u, v and the transient part
 * of the free surface (the deviation from the initial balanced state) so
 * gravity waves leave the domain instead of reflecting.
 *
 * The time integration is a forward-backward explicit scheme: momentum is
 * advanced with the old heights, then continuity is advanced with the new
 * velocities.  `advance(seconds)` splits the requested physical time into
 * CFL-safe substeps, so a caller can use the nominal 10 s weather step while
 * the solver keeps the gravity-wave CFL bounded.
 */

import { PHYSICS } from './physics/constants';

export type Hemisphere = 'N' | 'S';

export interface ShallowWaterOptions {
  /** Cells per side.  Default 256. */
  n?: number;
  /** Physical side length of the chart, km.  Default 1000. */
  domainKm?: number;
  /** Chart reference pressure used by exportForRendering(), hPa.  Default 1012. */
  basePressureHpa?: number;
  /** Coriolis parameter magnitude, s^-1.  Default 1e-4. */
  f0?: number;
  /** Northern or southern hemisphere.  Default 'N'. */
  hemisphere?: Hemisphere;
  /** Gravitational acceleration, m/s^2.  Default 9.8. */
  gravity?: number;
  /** Equivalent mean depth, m.  Default 8000. */
  meanDepth?: number;
  /** Rayleigh sponge width in cells.  Default 10. */
  spongeCells?: number;
  /** Rayleigh damping time scale at the wall, s.  Default 150. */
  spongeTimeScale?: number;
  /**
   * What the sponge relaxes the free surface towards.  'initial' preserves the
   * balanced mean boundary pressure and absorbs only the transient waves;
   * 'zero' forces the edge pressure anomaly to zero (stronger, can suck a
   * static anomaly out of the domain).  Default 'initial'.
   */
  spongeReference?: 'initial' | 'zero';
  /** Explicit Laplacian viscosity, m^2/s.  Default 800. */
  viscosity?: number;
  /** Depth floor, m.  Default 50. */
  minDepth?: number;
  /** CFL target.  Default 0.5. */
  cflLimit?: number;
  /** Largest internal substep, s.  Default 10. */
  maxSubstepSeconds?: number;
  /** Speed cap applied by initializeGeostrophic(), m/s.  Default 120. */
  maxInitialSpeed?: number;
  /**
   * Weight of the 1-2-1 Shapiro filter applied to the free surface after every
   * substep (scaled by dt / 10 s).  It is extremely scale selective: it damps
   * 2dx noise strongly and a 300 km synoptic feature essentially not at all.
   * Default 0.03.
   */
  smoothing?: number;
}

export interface SolverStats {
  timeSeconds: number;
  substeps: number;
  lastDt: number;
  lastCfl: number;
  maxSpeed: number;
  meanSpeed: number;
  maxHeight: number;
  minHeight: number;
  massHeight: number;
  spongeMassRemoved: number;
  finite: boolean;
}

const DEFAULT_N = 256;
const DEFAULT_DOMAIN_KM = 1000;

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return value;
}

export class ShallowWaterSolver {
  public readonly n: number;
  public readonly cells: number;
  public readonly uCount: number;
  public readonly vCount: number;
  public readonly cornerCount: number;
  public readonly dx: number;
  public readonly domainMetres: number;
  public readonly f: number;
  public readonly gravity: number;
  public readonly meanDepth: number;
  public readonly spongeCells: number;
  public readonly spongeTimeScale: number;
  public readonly spongeReference: 'initial' | 'zero';
  public readonly viscosity: number;
  public readonly minDepth: number;
  public readonly cflLimit: number;
  public readonly maxSubstepSeconds: number;
  public readonly maxInitialSpeed: number;
  public readonly smoothing: number;
  public readonly basePressureHpa: number;

  /** Physical time integrated so far, s. */
  public timeSeconds = 0;
  /** Number of internal substeps taken. */
  public substepCount = 0;
  /** Actual duration of the last substep, s. */
  public lastDt = 0;
  /** The CFL number of the last substep. */
  public lastCfl = 0;
  /** Net free-surface mass change caused by the sponge, in h-cell units. */
  public spongeMassRemoved = 0;

  /** Current free-surface height (pressure anomaly) at cell centres, m. */
  public get h(): Float64Array {
    return this.hCur;
  }
  /** Current east-west velocity at east faces, m/s. */
  public get u(): Float64Array {
    return this.uCur;
  }
  /** Current north-south velocity at north faces, m/s. */
  public get v(): Float64Array {
    return this.vCur;
  }

  private hCur: Float64Array;
  private uCur: Float64Array;
  private vCur: Float64Array;
  private hNxt: Float64Array;
  private uNxt: Float64Array;
  private vNxt: Float64Array;

  private readonly terrain: Float64Array;
  private readonly zeta: Float64Array;
  private readonly kinetic: Float64Array;
  private readonly depthU: Float64Array;
  private readonly depthV: Float64Array;
  private readonly wField: Float64Array;
  private readonly divField: Float64Array;
  private readonly div32: Float32Array;
  private readonly uCell: Float64Array;
  private readonly vCell: Float64Array;
  /**
   * Free-surface state the sponge relaxes towards.  Damping towards zero would
   * suck a static pressure anomaly out of the domain and accelerate air into
   * the wall; damping towards the initial balanced state absorbs the transient
   * gravity waves while preserving the mean boundary pressure.
   */
  private readonly hReference: Float64Array;

  // Sparse sponge lookup tables: only the border cells are visited.
  private readonly spongeCellIndex: Int32Array;
  private readonly spongeCellGamma: Float64Array;
  private readonly spongeUIndex: Int32Array;
  private readonly spongeUGamma: Float64Array;
  private readonly spongeVIndex: Int32Array;
  private readonly spongeVGamma: Float64Array;

  private waveSpeed = 0;

  constructor(options: ShallowWaterOptions = {}) {
    const n = options.n ?? DEFAULT_N;
    if (!Number.isInteger(n) || n < 8) {
      throw new Error('n must be an integer >= 8');
    }
    const domainKm = positive(options.domainKm ?? DEFAULT_DOMAIN_KM, 'domainKm');
    const f0 = Number.isFinite(options.f0 ?? PHYSICS.coriolis)
      ? Math.abs(options.f0 ?? PHYSICS.coriolis)
      : PHYSICS.coriolis;
    const hemisphere = options.hemisphere ?? 'N';
    const gravity = positive(options.gravity ?? PHYSICS.gravity, 'gravity');
    const meanDepth = positive(options.meanDepth ?? PHYSICS.meanDepth, 'meanDepth');
    const minDepth = positive(options.minDepth ?? PHYSICS.minDepth, 'minDepth');
    const cflLimit = options.cflLimit ?? PHYSICS.cflLimit;
    if (!Number.isFinite(cflLimit) || cflLimit <= 0 || cflLimit > 1.5) {
      throw new Error('cflLimit must be in (0, 1.5]');
    }
    const viscosity = Math.max(0, options.viscosity ?? PHYSICS.viscosity);
    const maxSubstepSeconds = positive(
      options.maxSubstepSeconds ?? PHYSICS.maxSubstepSeconds,
      'maxSubstepSeconds',
    );
    const spongeTimeScale = positive(
      options.spongeTimeScale ?? PHYSICS.spongeTimeScale,
      'spongeTimeScale',
    );
    const requestedSponge = options.spongeCells ?? PHYSICS.spongeCells;
    if (!Number.isInteger(requestedSponge) || requestedSponge < 0 || requestedSponge * 2 >= n) {
      throw new Error('spongeCells must be a non-negative integer < n / 2');
    }

    this.n = n;
    this.cells = n * n;
    this.uCount = n * (n + 1);
    this.vCount = (n + 1) * n;
    this.cornerCount = (n + 1) * (n + 1);
    this.domainMetres = domainKm * 1000;
    this.dx = this.domainMetres / n;
    this.f = hemisphere === 'N' ? f0 : -f0;
    this.gravity = gravity;
    this.meanDepth = meanDepth;
    this.spongeCells = requestedSponge;
    this.spongeTimeScale = spongeTimeScale;
    this.spongeReference = options.spongeReference ?? 'initial';
    this.viscosity = viscosity;
    this.minDepth = minDepth;
    this.cflLimit = cflLimit;
    this.maxSubstepSeconds = maxSubstepSeconds;
    this.maxInitialSpeed = positive(options.maxInitialSpeed ?? PHYSICS.maxInitialSpeed, 'maxInitialSpeed');
    const smoothing = options.smoothing ?? PHYSICS.smoothing;
    if (!Number.isFinite(smoothing) || smoothing < 0 || smoothing >= 0.5) {
      throw new Error('smoothing must be in [0, 0.5)');
    }
    this.smoothing = smoothing;
    this.basePressureHpa = positive(
      options.basePressureHpa ?? PHYSICS.basePressureHpa,
      'basePressureHpa',
    );

    this.hCur = new Float64Array(this.cells);
    this.uCur = new Float64Array(this.uCount);
    this.vCur = new Float64Array(this.vCount);
    this.hNxt = new Float64Array(this.cells);
    this.uNxt = new Float64Array(this.uCount);
    this.vNxt = new Float64Array(this.vCount);
    this.terrain = new Float64Array(this.cells);
    this.zeta = new Float64Array(this.cornerCount);
    this.kinetic = new Float64Array(this.cells);
    this.depthU = new Float64Array(this.uCount);
    this.depthV = new Float64Array(this.vCount);
    this.wField = new Float64Array(this.cells);
    this.divField = new Float64Array(this.cells);
    this.div32 = new Float32Array(this.cells);
    this.uCell = new Float64Array(this.cells);
    this.vCell = new Float64Array(this.cells);
    this.hReference = new Float64Array(this.cells);

    const sponge = this.buildSponge();
    this.spongeCellIndex = sponge.cellIndex;
    this.spongeCellGamma = sponge.cellGamma;
    this.spongeUIndex = sponge.uIndex;
    this.spongeUGamma = sponge.uGamma;
    this.spongeVIndex = sponge.vIndex;
    this.spongeVGamma = sponge.vGamma;
  }

  /** Physical side length in km. */
  public get domainKm(): number {
    return this.domainMetres / 1000;
  }

  /** Set the terrain height at cell centres, in metres above sea level. */
  public setTerrain(terrain: Float64Array | Float32Array): void {
    if (terrain.length !== this.cells) {
      throw new Error(`terrain must have ${this.cells} values`);
    }
    for (let k = 0; k < this.cells; k += 1) {
      const value = terrain[k];
      this.terrain[k] = Number.isFinite(value) && value > 0 ? value : 0;
    }
  }

  /** Read the current terrain field (do not mutate). */
  public getTerrain(): Float64Array {
    return this.terrain;
  }

  /**
   * Replace the free-surface height and reset the clock.  Velocities are set
   * to zero unless supplied.
   */
  public setInitialHeight(
    height: Float64Array,
    velocityU?: Float64Array,
    velocityV?: Float64Array,
  ): void {
    if (height.length !== this.cells) {
      throw new Error(`height must have ${this.cells} values`);
    }
    this.hCur.set(height);
    this.hReference.set(height);
    this.hNxt.fill(0);
    if (velocityU && velocityV) {
      this.setVelocity(velocityU, velocityV);
    } else {
      this.uCur.fill(0);
      this.vCur.fill(0);
    }
    this.timeSeconds = 0;
    this.substepCount = 0;
    this.lastDt = 0;
    this.lastCfl = 0;
    this.spongeMassRemoved = 0;
    this.waveSpeed = 0;
  }

  /** Replace the face velocities without touching the height field. */
  public setVelocity(velocityU: Float64Array, velocityV: Float64Array): void {
    if (velocityU.length !== this.uCount || velocityV.length !== this.vCount) {
      throw new Error('velocity arrays have the wrong length');
    }
    this.uCur.set(velocityU);
    this.vCur.set(velocityV);
    this.enforceClosedBoundaries(this.uCur, this.vCur);
  }

  /** Convert a pressure anomaly in hPa to the initial height field. */
  public setInitialPressureHpa(pressureHpa: Float64Array): void {
    if (pressureHpa.length !== this.cells) {
      throw new Error(`pressureHpa must have ${this.cells} values`);
    }
    const height = new Float64Array(this.cells);
    const scale = 100 / (PHYSICS.airDensity * this.gravity);
    for (let k = 0; k < this.cells; k += 1) height[k] = pressureHpa[k] * scale;
    this.setInitialHeight(height);
  }

  /**
   * Discrete geostrophic initialisation from the current height field.
   *
   * The streamfunction psi = (g/f) h is placed on cell corners and differenced
   * onto the C-grid faces, so the resulting wind is discretely non-divergent
   * (apart from the closed boundary).  The signs follow the right-handed frame:
   * u = -d psi / dy, v = +d psi / dx.
   *
   * Starting a pressure anomaly from rest would radiate almost all of it as
   * gravity waves, because the domain (1000 km) is much smaller than the
   * external Rossby radius (sqrt(gH)/f ~ 2800 km).  Balanced initialisation is
   * the standard NWP answer to that problem and keeps the first forecast frame
   * physically meaningful.
   */
  public initializeGeostrophic(): void {
    const n = this.n;
    const cn = n + 1;
    const h = this.hCur;
    if (this.f === 0) {
      this.uCur.fill(0);
      this.vCur.fill(0);
      return;
    }
    const gOverF = this.gravity / this.f;
    const psi = new Float64Array(this.cornerCount);
    for (let j = 0; j <= n; j += 1) {
      const j0 = j > 0 ? j - 1 : 0;
      const j1 = j < n ? j : n - 1;
      const row0 = j0 * n;
      const row1 = j1 * n;
      for (let i = 0; i <= n; i += 1) {
        const i0 = i > 0 ? i - 1 : 0;
        const i1 = i < n ? i : n - 1;
        psi[j * cn + i] =
          0.25 *
          (h[row0 + i0] + h[row0 + i1] + h[row1 + i0] + h[row1 + i1]) *
          gOverF;
      }
    }

    const u = this.uCur;
    const v = this.vCur;
    for (let j = 0; j < n; j += 1) {
      const rowU = j * (n + 1);
      u[rowU] = 0;
      u[rowU + n] = 0;
      const south = j * cn;
      const north = (j + 1) * cn;
      for (let i = 1; i < n; i += 1) {
        u[rowU + i] = -(psi[north + i] - psi[south + i]) / this.dx;
      }
    }
    for (let j = 0; j <= n; j += 1) {
      const rowV = j * n;
      if (j === 0 || j === n) {
        for (let i = 0; i < n; i += 1) v[rowV + i] = 0;
        continue;
      }
      const row = j * cn;
      for (let i = 0; i < n; i += 1) {
        v[rowV + i] = (psi[row + i + 1] - psi[row + i]) / this.dx;
      }
    }

    let maxSpeed = 0;
    for (let k = 0; k < this.uCount; k += 1) {
      const speed = Math.abs(u[k]);
      if (speed > maxSpeed) maxSpeed = speed;
    }
    for (let k = 0; k < this.vCount; k += 1) {
      const speed = Math.abs(v[k]);
      if (speed > maxSpeed) maxSpeed = speed;
    }
    if (maxSpeed > this.maxInitialSpeed) {
      const scale = this.maxInitialSpeed / maxSpeed;
      for (let k = 0; k < this.uCount; k += 1) u[k] *= scale;
      for (let k = 0; k < this.vCount; k += 1) v[k] *= scale;
    }
  }

  /**
   * Advance the physical clock by `seconds`, splitting the interval into
   * CFL-safe substeps.  No allocation happens inside this method.
   */
  public advance(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    let remaining = seconds;
    let guard = 0;
    // The guard only exists to convert a pathological configuration into a
    // bounded loop instead of a hang.  1e6 substeps at 0.01 s is 2.8 hours.
    while (remaining > 1e-9 && guard < 1_000_000) {
      const dtStable = this.stableDt();
      const dt = Math.min(remaining, this.maxSubstepSeconds, dtStable);
      if (!(dt > 0)) break;
      this.substep(dt);
      remaining -= dt;
      guard += 1;
    }
  }

  /**
   * Compatibility helper: run `numSteps` external steps of `dtSeconds` each.
   * Each step is internally split by the CFL condition.
   */
  public step(dtSeconds: number, numSteps = 1): void {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0 || !Number.isInteger(numSteps) || numSteps <= 0) {
      this.lastDt = 0;
      this.lastCfl = 0;
      return;
    }
    for (let s = 0; s < numSteps; s += 1) this.advance(dtSeconds);
  }

  /** Largest stable substep for the current state, s. */
  public stableDt(): number {
    const h = this.hCur;
    const terrain = this.terrain;
    let maxDepth = this.minDepth;
    for (let k = 0; k < this.cells; k += 1) {
      const depth = this.meanDepth + h[k] - terrain[k];
      if (depth > maxDepth) maxDepth = depth;
    }
    let maxFaceSpeed = 0;
    const u = this.uCur;
    for (let k = 0; k < this.uCount; k += 1) {
      const speed = Math.abs(u[k]);
      if (speed > maxFaceSpeed) maxFaceSpeed = speed;
    }
    const v = this.vCur;
    for (let k = 0; k < this.vCount; k += 1) {
      const speed = Math.abs(v[k]);
      if (speed > maxFaceSpeed) maxFaceSpeed = speed;
    }
    this.waveSpeed = Math.sqrt(this.gravity * maxDepth) + maxFaceSpeed;
    const gravityLimit = (this.cflLimit * this.dx) / Math.max(1e-6, this.waveSpeed);
    const rotationLimit = this.f !== 0 ? 0.9 / Math.abs(this.f) : Number.POSITIVE_INFINITY;
    return Math.min(gravityLimit, rotationLimit);
  }

  private substep(dt: number): void {
    this.computeVorticityAndKinetic();
    this.updateMomentum(dt);
    this.updateContinuity(dt);
    this.swapBuffers();
    if (this.spongeCellIndex.length > 0) this.applySponge(dt);
    if (this.smoothing > 0) this.applySmoothing(dt);
    this.timeSeconds += dt;
    this.substepCount += 1;
    this.lastDt = dt;
    this.lastCfl = (this.waveSpeed * dt) / this.dx;
  }

  private computeVorticityAndKinetic(): void {
    const n = this.n;
    const cn = n + 1;
    const dx = this.dx;
    const u = this.uCur;
    const v = this.vCur;
    const zeta = this.zeta;
    const kinetic = this.kinetic;

    for (let j = 0; j <= n; j += 1) {
      const vRow = j * n;
      const uRowNorth = j < n ? j * cn : (n - 1) * cn;
      const uRowSouth = j > 0 ? (j - 1) * cn : 0;
      const corRow = j * cn;
      for (let i = 0; i <= n; i += 1) {
        const iEast = i < n ? i : n - 1;
        const iWest = i > 0 ? i - 1 : 0;
        const vEast = v[vRow + iEast];
        const vWest = v[vRow + iWest];
        const uNorth = u[uRowNorth + i];
        const uSouth = u[uRowSouth + i];
        zeta[corRow + i] = (vEast - vWest - uNorth + uSouth) / dx;
      }
    }

    for (let j = 0; j < n; j += 1) {
      const rowU = j * (n + 1);
      const rowV = j * n;
      const rowVNorth = (j + 1) * n;
      const row = j * n;
      for (let i = 0; i < n; i += 1) {
        const ue = u[rowU + i + 1];
        const uw = u[rowU + i];
        const vn = v[rowVNorth + i];
        const vs = v[rowV + i];
        kinetic[row + i] = 0.25 * (ue * ue + uw * uw + vn * vn + vs * vs);
      }
    }
  }

  private updateMomentum(dt: number): void {
    const n = this.n;
    const cn = n + 1;
    const dx = this.dx;
    const invDx = 1 / dx;
    const invDx2 = 1 / (dx * dx);
    const g = this.gravity;
    const f0 = this.f;
    const visc = this.viscosity;
    const meanDepth = this.meanDepth;
    const minDepth = this.minDepth;
    const h = this.hCur;
    const u = this.uCur;
    const v = this.vCur;
    const uNxt = this.uNxt;
    const vNxt = this.vNxt;
    const zeta = this.zeta;
    const kinetic = this.kinetic;
    const depthU = this.depthU;
    const depthV = this.depthV;
    const terrain = this.terrain;

    // u faces (east-west velocity), interior columns only.
    for (let j = 0; j < n; j += 1) {
      const rowU = j * (n + 1);
      const rowV = j * n;
      const rowVNorth = (j + 1) * n;
      const row = j * n;
      const corRow = j * cn;
      const corRowNorth = (j + 1) * cn;
      const uSouthOffset = j > 0 ? -(n + 1) : 0;
      const uNorthOffset = j < n - 1 ? n + 1 : 0;
      for (let i = 1; i < n; i += 1) {
        const index = rowU + i;
        const cellRight = row + i;
        const cellLeft = row + i - 1;
        const hGradient = (h[cellRight] - h[cellLeft]) * invDx;
        const vAvg =
          0.25 * (v[rowV + i - 1] + v[rowV + i] + v[rowVNorth + i - 1] + v[rowVNorth + i]);
        const zetaAvg = 0.5 * (zeta[corRow + i] + zeta[corRowNorth + i]);
        const dk = (kinetic[cellRight] - kinetic[cellLeft]) * invDx;
        let lap = 0;
        if (visc > 0) {
          const uW = u[index - 1];
          const uE = i < n - 1 ? u[index + 1] : 0;
          const uS = u[index + uSouthOffset];
          const uN = u[index + uNorthOffset];
          lap = (uW + uE + uS + uN - 4 * u[index]) * invDx2;
        }
        uNxt[index] =
          u[index] + dt * (-g * hGradient + (f0 + zetaAvg) * vAvg - dk + visc * lap);
        const depth =
          meanDepth +
          0.5 * (h[cellLeft] + h[cellRight]) -
          0.5 * (terrain[cellLeft] + terrain[cellRight]);
        depthU[index] = depth > minDepth ? depth : minDepth;
      }
      uNxt[rowU] = 0;
      uNxt[rowU + n] = 0;
      depthU[rowU] = meanDepth;
      depthU[rowU + n] = meanDepth;
    }

    // v faces (north-south velocity), interior rows only.
    for (let j = 1; j < n; j += 1) {
      const rowV = j * n;
      const rowVCell = j * n;
      const rowVSouth = (j - 1) * n;
      const rowUSouth = (j - 1) * cn;
      const rowUNorth = j * cn;
      const corRow = j * cn;
      for (let i = 0; i < n; i += 1) {
        const index = rowV + i;
        const cellNorth = rowVCell + i;
        const cellSouth = rowVSouth + i;
        const hGradient = (h[cellNorth] - h[cellSouth]) * invDx;
        const uAvg =
          0.25 * (u[rowUSouth + i] + u[rowUSouth + i + 1] + u[rowUNorth + i] + u[rowUNorth + i + 1]);
        const zetaAvg = 0.5 * (zeta[corRow + i] + zeta[corRow + i + 1]);
        const dk = (kinetic[cellNorth] - kinetic[cellSouth]) * invDx;
        let lap = 0;
        if (visc > 0) {
          const vS = j > 0 ? v[index - n] : 0;
          const vN = j < n - 1 ? v[index + n] : 0;
          const vW = i > 0 ? v[index - 1] : v[index];
          const vE = i < n - 1 ? v[index + 1] : v[index];
          lap = (vS + vN + vW + vE - 4 * v[index]) * invDx2;
        }
        vNxt[index] =
          v[index] + dt * (-g * hGradient - (f0 + zetaAvg) * uAvg - dk + visc * lap);
        const depth =
          meanDepth +
          0.5 * (h[cellSouth] + h[cellNorth]) -
          0.5 * (terrain[cellSouth] + terrain[cellNorth]);
        depthV[index] = depth > minDepth ? depth : minDepth;
      }
    }
    this.enforceClosedBoundaries(uNxt, vNxt);
  }

  private updateContinuity(dt: number): void {
    const n = this.n;
    const dx = this.dx;
    const invDx = 1 / dx;
    const h = this.hCur;
    const hNxt = this.hNxt;
    const uNxt = this.uNxt;
    const vNxt = this.vNxt;
    const depthU = this.depthU;
    const depthV = this.depthV;
    const wField = this.wField;

    for (let j = 0; j < n; j += 1) {
      const row = j * n;
      const rowU = j * (n + 1);
      const rowV = j * n;
      const rowVNorth = (j + 1) * n;
      for (let i = 0; i < n; i += 1) {
        const fluxDiv =
          (depthU[rowU + i + 1] * uNxt[rowU + i + 1] -
            depthU[rowU + i] * uNxt[rowU + i] +
            depthV[rowVNorth + i] * vNxt[rowVNorth + i] -
            depthV[rowV + i] * vNxt[rowV + i]) *
          invDx;
        const index = row + i;
        hNxt[index] = h[index] - dt * fluxDiv;
        wField[index] = -fluxDiv;
      }
    }
  }

  private swapBuffers(): void {
    const hTmp = this.hCur;
    this.hCur = this.hNxt;
    this.hNxt = hTmp;
    const uTmp = this.uCur;
    this.uCur = this.uNxt;
    this.uNxt = uTmp;
    const vTmp = this.vCur;
    this.vCur = this.vNxt;
    this.vNxt = vTmp;
  }

  private enforceClosedBoundaries(u: Float64Array, v: Float64Array): void {
    const n = this.n;
    for (let j = 0; j < n; j += 1) {
      u[j * (n + 1)] = 0;
      u[j * (n + 1) + n] = 0;
    }
    for (let i = 0; i < n; i += 1) {
      v[i] = 0;
      v[n * n + i] = 0;
    }
  }

  private applySponge(dt: number): void {
    const h = this.hCur;
    const u = this.uCur;
    const v = this.vCur;
    const hIndex = this.spongeCellIndex;
    const hGamma = this.spongeCellGamma;
    let removed = 0;
    for (let k = 0; k < hIndex.length; k += 1) {
      const index = hIndex[k];
      const factor = 1 - Math.min(0.5, hGamma[k] * dt);
      const before = h[index];
      const reference = this.spongeReference === 'zero' ? 0 : this.hReference[index];
      const after = reference + (before - reference) * factor;
      h[index] = after;
      removed += before - after;
    }
    this.spongeMassRemoved += removed;
    const uIndex = this.spongeUIndex;
    const uGamma = this.spongeUGamma;
    for (let k = 0; k < uIndex.length; k += 1) {
      u[uIndex[k]] *= 1 - Math.min(0.5, uGamma[k] * dt);
    }
    const vIndex = this.spongeVIndex;
    const vGamma = this.spongeVGamma;
    for (let k = 0; k < vIndex.length; k += 1) {
      v[vIndex[k]] *= 1 - Math.min(0.5, vGamma[k] * dt);
    }
  }

  /**
   * One 1-2-1 Shapiro pass on the free surface.  The mirror boundaries make the
   * filter mass conserving.  It writes into the spare height buffer, so no
   * allocation and no extra copy are needed.
   */
  private applySmoothing(dt: number): void {
    const n = this.n;
    // Scale the filter with the substep so the damping per unit of physical
    // time stays constant when the CFL chooses a smaller dt.
    const alpha = Math.min(0.2, this.smoothing * (dt / 10));
    const h = this.hCur;
    const out = this.hNxt;
    for (let j = 0; j < n; j += 1) {
      const row = j * n;
      const rowSouth = j > 0 ? row - n : row;
      const rowNorth = j < n - 1 ? row + n : row;
      for (let i = 0; i < n; i += 1) {
        const index = row + i;
        const centre = h[index];
        const west = i > 0 ? h[index - 1] : centre;
        const east = i < n - 1 ? h[index + 1] : centre;
        const south = h[rowSouth + i];
        const north = h[rowNorth + i];
        out[index] = centre + alpha * (0.25 * (west + east + south + north) - centre);
      }
    }
    const hTmp = this.hCur;
    this.hCur = this.hNxt;
    this.hNxt = hTmp;
  }

  private buildSponge(): {
    cellIndex: Int32Array;
    cellGamma: Float64Array;
    uIndex: Int32Array;
    uGamma: Float64Array;
    vIndex: Int32Array;
    vGamma: Float64Array;
  } {
    const n = this.n;
    const s = this.spongeCells;
    const gammaMax = 1 / this.spongeTimeScale;
    const cellIndex: number[] = [];
    const cellGamma: number[] = [];
    const uIndex: number[] = [];
    const uGamma: number[] = [];
    const vIndex: number[] = [];
    const vGamma: number[] = [];
    if (s <= 0) {
      return {
        cellIndex: new Int32Array(0),
        cellGamma: new Float64Array(0),
        uIndex: new Int32Array(0),
        uGamma: new Float64Array(0),
        vIndex: new Int32Array(0),
        vGamma: new Float64Array(0),
      };
    }
    const gammaFor = (distance: number): number => {
      if (distance >= s) return 0;
      const t = 1 - distance / s;
      return gammaMax * t * t;
    };
    for (let j = 0; j < n; j += 1) {
      for (let i = 0; i < n; i += 1) {
        const distance = Math.min(i, n - 1 - i, j, n - 1 - j);
        const gamma = gammaFor(distance);
        if (gamma > 0) {
          cellIndex.push(j * n + i);
          cellGamma.push(gamma);
        }
      }
    }
    for (let j = 0; j < n; j += 1) {
      for (let i = 0; i <= n; i += 1) {
        const distance = Math.min(i, n - i, j, n - 1 - j);
        const gamma = gammaFor(distance);
        if (gamma > 0) {
          uIndex.push(j * (n + 1) + i);
          uGamma.push(gamma);
        }
      }
    }
    for (let j = 0; j <= n; j += 1) {
      for (let i = 0; i < n; i += 1) {
        const distance = Math.min(i, n - 1 - i, j, n - j);
        const gamma = gammaFor(distance);
        if (gamma > 0) {
          vIndex.push(j * n + i);
          vGamma.push(gamma);
        }
      }
    }
    return {
      cellIndex: Int32Array.from(cellIndex),
      cellGamma: Float64Array.from(cellGamma),
      uIndex: Int32Array.from(uIndex),
      uGamma: Float64Array.from(uGamma),
      vIndex: Int32Array.from(vIndex),
      vGamma: Float64Array.from(vGamma),
    };
  }

  /** Conservative divergence at cell centres, s^-1. */
  public getDivergence(): Float64Array {
    const n = this.n;
    const dx = this.dx;
    const invDx = 1 / dx;
    const u = this.uCur;
    const v = this.vCur;
    const out = this.divField;
    const out32 = this.div32;
    for (let j = 0; j < n; j += 1) {
      const row = j * n;
      const rowU = j * (n + 1);
      const rowV = j * n;
      const rowVNorth = (j + 1) * n;
      for (let i = 0; i < n; i += 1) {
        const div =
          (u[rowU + i + 1] - u[rowU + i] + v[rowVNorth + i] - v[rowV + i]) * invDx;
        out[row + i] = div;
        out32[row + i] = div;
      }
    }
    return out;
  }

  /** Divergence as Float32, for rendering (reuses an internal buffer). */
  public getDivergenceField(): Float32Array {
    this.getDivergence();
    return this.div32;
  }

  /** Free-surface tendency diagnosed by the last continuity update, m/s. */
  public getVerticalVelocity(): Float64Array {
    return this.wField;
  }

  /** Cell-centred wind components (arithmetic face averages), m/s. */
  public getCellVelocity(): { u: Float64Array; v: Float64Array } {
    this.updateCellVelocity();
    return { u: this.uCell, v: this.vCell };
  }

  /** Recompute the cell-centred wind in place (no allocation). */
  public updateCellVelocity(): void {
    const n = this.n;
    const u = this.uCur;
    const v = this.vCur;
    const uCell = this.uCell;
    const vCell = this.vCell;
    for (let j = 0; j < n; j += 1) {
      const row = j * n;
      const rowU = j * (n + 1);
      const rowV = j * n;
      const rowVNorth = (j + 1) * n;
      for (let i = 0; i < n; i += 1) {
        uCell[row + i] = 0.5 * (u[rowU + i] + u[rowU + i + 1]);
        vCell[row + i] = 0.5 * (v[rowV + i] + v[rowVNorth + i]);
      }
    }
  }

  /** Cell-centred eastward wind, m/s.  Call updateCellVelocity() first. */
  public get cellU(): Float64Array {
    return this.uCell;
  }

  /** Cell-centred northward wind, m/s.  Call updateCellVelocity() first. */
  public get cellV(): Float64Array {
    return this.vCell;
  }

  /** Total free-surface mass (sum of h), in h-cell units. */
  public totalHeight(): number {
    const h = this.hCur;
    let sum = 0;
    for (let k = 0; k < this.cells; k += 1) sum += h[k];
    return sum;
  }

  /** Absolute maximum of h, m. */
  public maxAbsHeight(): number {
    const h = this.hCur;
    let max = 0;
    for (let k = 0; k < this.cells; k += 1) {
      const value = Math.abs(h[k]);
      if (value > max) max = value;
    }
    return max;
  }

  /**
   * Maximum |vorticity| / |f| in the interior (the sponge ring is excluded,
   * because the closed-wall vorticity sheet is not a property of the weather
   * system).  A value near or above 1 means the initial state is ageostrophic
   * and the geostrophic balance is no longer a good approximation; card
   * amplitudes/radii should be chosen to keep it below roughly 1 for a stable,
   * readable spin-up.
   */
  public maxRossbyNumber(): number {
    if (this.f === 0) return 0;
    this.computeVorticityAndKinetic();
    const n = this.n;
    const margin = Math.min(this.spongeCells + 1, Math.floor(n / 4));
    let max = 0;
    for (let j = margin; j <= n - margin; j += 1) {
      const row = j * (n + 1);
      for (let i = margin; i <= n - margin; i += 1) {
        const value = Math.abs(this.zeta[row + i]);
        if (value > max) max = value;
      }
    }
    return max / Math.abs(this.f);
  }

  /** Maximum face speed, m/s. */
  public maxSpeed(): number {
    let max = 0;
    const u = this.uCur;
    for (let k = 0; k < this.uCount; k += 1) {
      const speed = Math.abs(u[k]);
      if (speed > max) max = speed;
    }
    const v = this.vCur;
    for (let k = 0; k < this.vCount; k += 1) {
      const speed = Math.abs(v[k]);
      if (speed > max) max = speed;
    }
    return max;
  }

  /** Speed on the closed boundary faces (must stay near zero). */
  public boundarySpeed(): number {
    const n = this.n;
    let max = 0;
    const u = this.uCur;
    for (let j = 0; j < n; j += 1) {
      const rowU = j * (n + 1);
      max = Math.max(max, Math.abs(u[rowU]), Math.abs(u[rowU + n]));
    }
    const v = this.vCur;
    for (let i = 0; i < n; i += 1) {
      max = Math.max(max, Math.abs(v[i]), Math.abs(v[n * n + i]));
    }
    return max;
  }

  public stats(): SolverStats {
    let maxSpeed = 0;
    let sumSpeed = 0;
    let count = 0;
    const u = this.uCur;
    for (let k = 0; k < this.uCount; k += 1) {
      const speed = Math.abs(u[k]);
      if (speed > maxSpeed) maxSpeed = speed;
      sumSpeed += speed;
      count += 1;
    }
    const v = this.vCur;
    for (let k = 0; k < this.vCount; k += 1) {
      const speed = Math.abs(v[k]);
      if (speed > maxSpeed) maxSpeed = speed;
      sumSpeed += speed;
      count += 1;
    }
    let maxHeight = -Infinity;
    let minHeight = Infinity;
    let massHeight = 0;
    let finite = true;
    const h = this.hCur;
    for (let k = 0; k < this.cells; k += 1) {
      const value = h[k];
      if (!Number.isFinite(value)) finite = false;
      if (value > maxHeight) maxHeight = value;
      if (value < minHeight) minHeight = value;
      massHeight += value;
    }
    return {
      timeSeconds: this.timeSeconds,
      substeps: this.substepCount,
      lastDt: this.lastDt,
      lastCfl: this.lastCfl,
      maxSpeed,
      meanSpeed: count > 0 ? sumSpeed / count : 0,
      maxHeight,
      minHeight,
      massHeight,
      spongeMassRemoved: this.spongeMassRemoved,
      finite,
    };
  }

  /** Pressure anomaly at a cell centre, hPa. */
  public pressureAnomalyHpa(i: number, j: number): number {
    const n = this.n;
    const ii = Math.max(0, Math.min(n - 1, i));
    const jj = Math.max(0, Math.min(n - 1, j));
    return (this.hCur[jj * n + ii] * PHYSICS.airDensity * this.gravity) / 100;
  }

  /**
   * Export the fields for the renderer / station sampler.
   *
   * By default the output is in screen orientation: row 0 is the north edge,
   * and `v` is positive south (the chart's y axis points down).  Pass
   * `{ flipY: false, screenV: false }` to get the solver's native frame.
   */
  public exportForRendering(
    options: { flipY?: boolean; screenV?: boolean } = {},
  ): {
    pressureHpa: Float32Array;
    height: Float32Array;
    u: Float32Array;
    v: Float32Array;
    w: Float32Array;
  } {
    const flipY = options.flipY ?? true;
    const screenV = options.screenV ?? true;
    const n = this.n;
    const pressure = new Float32Array(this.cells);
    const height = new Float32Array(this.cells);
    const uOut = new Float32Array(this.cells);
    const vOut = new Float32Array(this.cells);
    const wOut = new Float32Array(this.cells);
    const h = this.hCur;
    const u = this.uCur;
    const v = this.vCur;
    const w = this.wField;
    const densityGravity = (PHYSICS.airDensity * this.gravity) / 100;
    for (let js = 0; js < n; js += 1) {
      const je = flipY ? n - 1 - js : js;
      const rowE = je * n;
      const rowU = je * (n + 1);
      const rowV = je * n;
      const rowVNorth = (je + 1) * n;
      const rowOut = js * n;
      for (let i = 0; i < n; i += 1) {
        const index = rowOut + i;
        const source = rowE + i;
        height[index] = h[source];
        pressure[index] = this.basePressureHpa + h[source] * densityGravity;
        uOut[index] = 0.5 * (u[rowU + i] + u[rowU + i + 1]);
        const vNorm = 0.5 * (v[rowV + i] + v[rowVNorth + i]);
        vOut[index] = screenV ? -vNorm : vNorm;
        wOut[index] = w[source];
      }
    }
    return { pressureHpa: pressure, height, u: uOut, v: vOut, w: wOut };
  }
}
