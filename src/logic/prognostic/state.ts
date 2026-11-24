/**
 * Prognostic state (P1).
 *
 * Thin, stable wrapper around the shallow-water weather field that already
 * lives in `experiments/swe`.  Nothing here rewrites the physics: it fixes the
 * grid (96² by default), the time step and the sampling API so P2–P4 can build
 * diagnostics, a timeline and per-level migration on one seam.
 *
 * The wrapper is imported by scripts and (later) by forecast levels only, so
 * the campaign bundle does not pull the solver in.
 */

import { WeatherField, type FieldSample } from '../../../experiments/swe/physics/WeatherField';
import { sampleSurface } from '../surface';
import type { BaseConditions, WeatherEntity } from '../types';

export interface PrognosticOptions {
  /** Cells per side.  Default 96 (one cell ≈ 10.4 km on a 1000 km chart). */
  n?: number;
  /** Physical side length of the chart, km.  Default 1000. */
  domainKm?: number;
  /** Weather time step, seconds.  Default 10. */
  dtSeconds?: number;
  thermalCoupling?: boolean;
  balanced?: boolean;
  /** Boundary sponge width.  Default 0: a closed, mass-conserving chart. */
  spongeCells?: number;
  viscosity?: number;
  smoothing?: number;
}

export interface PrognosticStation {
  hour: number;
  x: number;
  y: number;
  pressureHpa: number;
  temperatureC: number;
  moisture: number;
  windSpeed: number;
  windFromDeg: number;
  wTotal: number;
  wConvergence: number;
  wEkman: number;
  frontType: string;
  frontStrength: number;
}

export interface PrognosticCheckpoint {
  hour: number;
  height: Float64Array;
  u: Float64Array;
  v: Float64Array;
  temperature: Float64Array;
  moisture: Float64Array;
  stability: Float64Array;
}

export interface PrognosticSnapshot {
  hour: number;
  stations: Record<string, PrognosticStation>;
  massDrift: number;
}

export const PROGNOSTIC_DEFAULTS = {
  n: 96,
  domainKm: 1000,
  dtSeconds: 10,
} as const;

export class PrognosticState {
  public readonly field: WeatherField;
  public readonly dtSeconds: number;
  public readonly options: Required<Pick<PrognosticOptions, 'n' | 'domainKm' | 'dtSeconds'>>;

  private hour = 0;
  private readonly mass0: number;
  private readonly history: PrognosticSnapshot[] = [];
  private readonly checkpoints: PrognosticCheckpoint[] = [];

  constructor(base: BaseConditions, entities: WeatherEntity[], options: PrognosticOptions = {}) {
    this.options = {
      n: options.n ?? PROGNOSTIC_DEFAULTS.n,
      domainKm: options.domainKm ?? PROGNOSTIC_DEFAULTS.domainKm,
      dtSeconds: options.dtSeconds ?? PROGNOSTIC_DEFAULTS.dtSeconds,
    };
    this.dtSeconds = this.options.dtSeconds;
    this.field = new WeatherField({
      n: this.options.n,
      domainKm: this.options.domainKm,
      base,
      thermalCoupling: options.thermalCoupling ?? true,
      balanced: options.balanced ?? true,
      spongeCells: options.spongeCells ?? 0,
      cflLimit: 0.5,
      smoothing: options.smoothing ?? 0.05,
      viscosity: options.viscosity ?? 1200,
    });
    if (base.hasTerrain) {
      // Feed the drawn ridge into the solver so orographic lift exists at all;
      // without this the terrain levels see a flat world.
      const n = this.options.n;
      const terrain = new Float64Array(n * n);
      const step = 1000 / n;
      for (let j = 0; j < n; j += 1) {
        for (let i = 0; i < n; i += 1) {
          terrain[j * n + i] = sampleSurface(base, (i + 0.5) * step, (j + 0.5) * step).elevation;
        }
      }
      this.field.setTerrain(terrain);
    }
    this.field.loadEntities(entities, { balanced: options.balanced ?? true });
    this.mass0 = this.totalMass();
    this.checkpoints.push(this.capture());
  }

  public get base(): BaseConditions {
    return this.field.base;
  }

  /** Full grid state at the current hour, for seek / intervention. */
  public capture(): PrognosticCheckpoint {
    return {
      hour: this.hour,
      height: new Float64Array(this.field.solver.h),
      u: new Float64Array(this.field.solver.u),
      v: new Float64Array(this.field.solver.v),
      temperature: new Float64Array(this.field.temperature),
      moisture: new Float64Array(this.field.moisture),
      stability: new Float64Array(this.field.stability),
    };
  }

  public restore(checkpoint: PrognosticCheckpoint): void {
    const { solver } = this.field;
    solver.setInitialHeight(
      new Float64Array(checkpoint.height),
      new Float64Array(checkpoint.u),
      new Float64Array(checkpoint.v),
    );
    this.field.setTemperature(new Float64Array(checkpoint.temperature));
    this.field.setMoisture(new Float64Array(checkpoint.moisture));
    this.field.setStability(new Float64Array(checkpoint.stability));
    this.hour = checkpoint.hour;
    this.field.refreshDiagnostics();
  }

  /** Jump to a whole hour, replaying forward from the nearest checkpoint. */
  public seek(hour: number): void {
    const target = Math.max(0, Math.round(hour));
    if (target === this.hour) return;
    if (target < this.hour) {
      let best = this.checkpoints[0];
      for (const checkpoint of this.checkpoints) {
        if (checkpoint.hour <= target && checkpoint.hour >= best.hour) best = checkpoint;
      }
      this.restore(best);
    }
    this.advance(target - this.hour);
  }

  /**
   * Apply cards on top of the current state (P3 intervention).  The entities are
   * loaded into a scratch field so their anomaly can be added without resetting
   * the evolved chart.
   */
  public intervene(entities: WeatherEntity[]): void {
    const scratch = new WeatherField({
      n: this.options.n,
      domainKm: this.options.domainKm,
      base: this.base,
      thermalCoupling: true,
      balanced: false,
      spongeCells: 0,
      cflLimit: 0.5,
      smoothing: 0.05,
      viscosity: 1200,
    });
    scratch.loadEntities(entities, { balanced: false });
    const h = this.field.solver.h;
    const dHeight = scratch.solver.h;
    const temperature = this.field.temperature;
    const moisture = this.field.moisture;
    const stability = this.field.stability;
    for (let i = 0; i < h.length; i += 1) {
      h[i] += dHeight[i];
      temperature[i] += scratch.temperature[i] - this.base.T;
      moisture[i] += scratch.moisture[i] - this.base.Q;
      stability[i] += scratch.stability[i];
    }
    this.field.solver.setInitialHeight(
      new Float64Array(h),
      new Float64Array(this.field.solver.u),
      new Float64Array(this.field.solver.v),
    );
    this.field.refreshDiagnostics();
    // The evolved future no longer exists after an intervention.
    for (let i = this.checkpoints.length - 1; i >= 0; i -= 1) {
      if (this.checkpoints[i].hour > this.hour) this.checkpoints.splice(i, 1);
    }
  }

  public get timeHours(): number {
    return this.hour;
  }

  public get snapshots(): readonly PrognosticSnapshot[] {
    return this.history;
  }

  /** Total free-surface mass proxy (sum of h). */
  public totalMass(): number {
    return this.field.solver.totalHeight();
  }

  /** Relative mass drift since initialisation. */
  public massDrift(): number {
    return Math.abs(this.totalMass() - this.mass0) / Math.max(1e-9, Math.abs(this.mass0));
  }

  /** Advance by whole hours, one hour at a time so callers can snapshot. */
  public advance(hours: number): void {
    if (!Number.isFinite(hours) || hours <= 0) return;
    for (let h = 0; h < hours; h += 1) {
      this.field.run(3600, this.dtSeconds);
      this.hour += 1;
      this.checkpoints.push(this.capture());
    }
  }

  public sample(x: number, y: number): FieldSample {
    return this.field.sampleScreen(x, y);
  }

  public station(_id: string, x: number, y: number): PrognosticStation {
    const sample = this.sample(x, y);
    return {
      hour: this.hour,
      x,
      y,
      pressureHpa: sample.pressureHpa,
      temperatureC: sample.temperatureC,
      moisture: sample.moisture,
      windSpeed: sample.speed,
      windFromDeg: sample.fromDeg,
      wTotal: sample.wTotal,
      wConvergence: sample.wConvergence,
      wEkman: sample.wEkman,
      frontType: sample.front.type,
      frontStrength: sample.front.strength,
    };
  }

  public snapshot(points: Record<string, { x: number; y: number }>): PrognosticSnapshot {
    const stations: Record<string, PrognosticStation> = {};
    for (const [id, point] of Object.entries(points)) {
      stations[id] = this.station(id, point.x, point.y);
    }
    const snap: PrognosticSnapshot = {
      hour: this.hour,
      stations,
      massDrift: this.massDrift(),
    };
    this.history.push(snap);
    return snap;
  }
}
