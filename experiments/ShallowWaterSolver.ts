/**
 * Shallow Water Equations Solver - Moved from main logic to experiments
 * This is a complex physics simulation that's not needed for core gameplay
 * Only loaded when specifically requested for advanced weather modeling
 */

export interface ShallowWaterGrid {
  width: number;
  height: number;
  h: number[][]; // Height/depth field
  u: number[][]; // x-velocity field
  v: number[][]; // y-velocity field
  g: number;     // Gravitational acceleration
}

export interface ShallowWaterConfig {
  gridSize: number;
  dt: number;      // Time step
  g: number;       // Gravity
  boundary: 'reflect' | 'periodic' | 'open';
  windStress?: boolean;
  bottomFriction?: boolean;
}

export class ShallowWaterSolver {
  private grid: ShallowWaterGrid;
  private config: Required<ShallowWaterConfig>;
  private time = 0;

  constructor(config: ShallowWaterConfig) {
    this.config = {
      ...config,
      gridSize: config.gridSize ?? 64,
      dt: config.dt ?? 0.01,
      g: config.g ?? 9.81,
      boundary: config.boundary ?? 'reflect',
      windStress: config.windStress ?? false,
      bottomFriction: config.bottomFriction ?? false,
    };

    this.grid = this.initializeGrid();
  }

  /**
   * Initialize the grid with default values
   */
  private initializeGrid(): ShallowWaterGrid {
    const { gridSize } = this.config;
    
    return {
      width: gridSize,
      height: gridSize,
      h: Array(gridSize).fill(0).map(() => Array(gridSize).fill(1.0)), // 1m depth by default
      u: Array(gridSize).fill(0).map(() => Array(gridSize).fill(0.0)), // No initial velocity
      v: Array(gridSize).fill(0).map(() => Array(gridSize).fill(0.0)),
      g: this.config.g,
    };
  }

  /**
   * Set initial conditions for the simulation
   */
  public setInitialConditions(
    height: number[][],
    velocityX?: number[][],
    velocityY?: number[][]
  ): void {
    const { gridSize } = this.config;
    
    if (height.length !== gridSize || height[0].length !== gridSize) {
      throw new Error('Height field dimensions must match grid size');
    }

    // Copy height field
    for (let i = 0; i < gridSize; i++) {
      for (let j = 0; j < gridSize; j++) {
        this.grid.h[i][j] = Math.max(0.1, height[i][j]); // Ensure minimum depth
      }
    }

    // Copy velocity fields if provided
    if (velocityX && velocityY) {
      for (let i = 0; i < gridSize; i++) {
        for (let j = 0; j < gridSize; j++) {
          this.grid.u[i][j] = velocityX[i][j] || 0;
          this.grid.v[i][j] = velocityY[i][j] || 0;
        }
      }
    }
  }

  /**
   * Add a disturbance to the water surface
   */
  public addDisturbance(
    centerX: number,
    centerY: number,
    radius: number,
    amplitude: number
  ): void {
    const { gridSize } = this.config;
    
    for (let i = 0; i < gridSize; i++) {
      for (let j = 0; j < gridSize; j++) {
        const distance = Math.sqrt(
          Math.pow(i - centerX, 2) + Math.pow(j - centerY, 2)
        );
        
        if (distance <= radius) {
          const factor = Math.cos((distance / radius) * Math.PI / 2);
          this.grid.h[i][j] += amplitude * factor;
        }
      }
    }
  }

  /**
   * Add wind stress forcing
   */
  public addWindStress(
    windX: number[][],
    windY: number[][],
    dragCoefficient: number = 0.001
  ): void {
    if (!this.config.windStress) return;

    const { gridSize } = this.config;
    
    for (let i = 0; i < gridSize; i++) {
      for (let j = 0; j < gridSize; j++) {
        // Wind stress acts on surface velocity
        const stressX = dragCoefficient * windX[i][j] * Math.sqrt(this.grid.h[i][j]);
        const stressY = dragCoefficient * windY[i][j] * Math.sqrt(this.grid.h[i][j]);
        
        this.grid.u[i][j] += stressX * this.config.dt;
        this.grid.v[i][j] += stressY * this.config.dt;
      }
    }
  }

  /**
   * Add bottom friction
   */
  public addBottomFriction(
    frictionCoefficient: number = 0.01
  ): void {
    if (!this.config.bottomFriction) return;

    const { gridSize } = this.config;
    
    for (let i = 0; i < gridSize; i++) {
      for (let j = 0; j < gridSize; j++) {
        const speed = Math.sqrt(this.grid.u[i][j] ** 2 + this.grid.v[i][j] ** 2);
        if (speed > 0) {
          const friction = frictionCoefficient * speed / this.grid.h[i][j];
          this.grid.u[i][j] *= Math.max(0, 1 - friction * this.config.dt);
          this.grid.v[i][j] *= Math.max(0, 1 - friction * this.config.dt);
        }
      }
    }
  }

  /**
   * Apply boundary conditions
   */
  private applyBoundaryConditions(): void {
    const { boundary } = this.config;
    
    switch (boundary) {
      case 'reflect':
        this.applyReflectiveBoundaries();
        break;
      case 'periodic':
        this.applyPeriodicBoundaries();
        break;
      case 'open':
        this.applyOpenBoundaries();
        break;
    }
  }

  private applyReflectiveBoundaries(): void {
    const { gridSize } = this.config;
    
    // Reflect horizontal boundaries
    for (let j = 0; j < gridSize; j++) {
      this.grid.u[0][j] = -this.grid.u[1][j];    // Top
      this.grid.u[gridSize - 1][j] = -this.grid.u[gridSize - 2][j]; // Bottom
      this.grid.v[0][j] = this.grid.v[1][j];      // Top
      this.grid.v[gridSize - 1][j] = this.grid.v[gridSize - 2][j]; // Bottom
    }
    
    // Reflect vertical boundaries
    for (let i = 0; i < gridSize; i++) {
      this.grid.u[i][0] = this.grid.u[i][1];      // Left
      this.grid.u[i][gridSize - 1] = this.grid.u[i][gridSize - 2]; // Right
      this.grid.v[i][0] = -this.grid.v[i][1];    // Left
      this.grid.v[i][gridSize - 1] = -this.grid.v[i][gridSize - 2]; // Right
    }
  }

  private applyPeriodicBoundaries(): void {
    const { gridSize } = this.config;
    
    // Wrap around boundaries
    for (let i = 0; i < gridSize; i++) {
      this.grid.u[i][0] = this.grid.u[i][gridSize - 1];
      this.grid.u[i][gridSize - 1] = this.grid.u[i][0];
      this.grid.v[i][0] = this.grid.v[i][gridSize - 1];
      this.grid.v[i][gridSize - 1] = this.grid.v[i][0];
    }
    
    for (let j = 0; j < gridSize; j++) {
      this.grid.u[0][j] = this.grid.u[gridSize - 1][j];
      this.grid.u[gridSize - 1][j] = this.grid.u[0][j];
      this.grid.v[0][j] = this.grid.v[gridSize - 1][j];
      this.grid.v[gridSize - 1][j] = this.grid.v[0][j];
    }
  }

  private applyOpenBoundaries(): void {
    // Simple radiation boundary conditions
    const { gridSize } = this.config;
    const c = Math.sqrt(this.config.g * 1.0); // Wave speed
    
    // Left boundary
    for (let j = 0; j < gridSize; j++) {
      this.grid.u[0][j] = this.grid.u[1][j];
      this.grid.v[0][j] = this.grid.v[1][j];
      this.grid.h[0][j] = this.grid.h[1][j] - (this.config.dt / c) * this.grid.g * (this.grid.h[1][j] - this.grid.h[0][j]);
    }
    
    // Right boundary
    for (let j = 0; j < gridSize; j++) {
      this.grid.u[gridSize - 1][j] = this.grid.u[gridSize - 2][j];
      this.grid.v[gridSize - 1][j] = this.grid.v[gridSize - 2][j];
      this.grid.h[gridSize - 1][j] = this.grid.h[gridSize - 2][j] - (this.config.dt / c) * this.grid.g * (this.grid.h[gridSize - 2][j] - this.grid.h[gridSize - 1][j]);
    }
    
    // Top and bottom boundaries (similar)
    for (let i = 0; i < gridSize; i++) {
      this.grid.u[i][0] = this.grid.u[i][1];
      this.grid.v[i][0] = this.grid.v[i][1];
      this.grid.h[i][0] = this.grid.h[i][1] - (this.config.dt / c) * this.grid.g * (this.grid.h[i][1] - this.grid.h[i][0]);
      
      this.grid.u[i][gridSize - 1] = this.grid.u[i][gridSize - 2];
      this.grid.v[i][gridSize - 1] = this.grid.v[i][gridSize - 2];
      this.grid.h[i][gridSize - 1] = this.grid.h[i][gridSize - 2] - (this.config.dt / c) * this.grid.g * (this.grid.h[i][gridSize - 2] - this.grid.h[i][gridSize - 1]);
    }
  }

  /**
   * Compute the right-hand side of the shallow water equations
   */
  private computeRHS(): {
    dhdt: number[][];
    dudt: number[][];
    dvdt: number[][]
  } {
    const { gridSize, g } = this.config;
    const dhdt = Array(gridSize).fill(0).map(() => Array(gridSize).fill(0));
    const dudt = Array(gridSize).fill(0).map(() => Array(gridSize).fill(0));
    const dvdt = Array(gridSize).fill(0).map(() => Array(gridSize).fill(0));

    // Compute spatial derivatives using finite differences
    for (let i = 1; i < gridSize - 1; i++) {
      for (let j = 1; j < gridSize - 1; j++) {
        // Height advection: -∇·(hu)
        const dhu_dx = (this.grid.h[i + 1][j] * this.grid.u[i + 1][j] - this.grid.h[i - 1][j] * this.grid.u[i - 1][j]) / 2;
        const dhv_dy = (this.grid.h[i][j + 1] * this.grid.v[i][j + 1] - this.grid.h[i][j - 1] * this.grid.v[i][j - 1]) / 2;
        dhdt[i][j] = -(dhu_dx + dhv_dy);

        // Momentum advection: -u·∇u (simplified to the cross-derivative term)
        const du_dy = (this.grid.u[i][j + 1] - this.grid.u[i][j - 1]) / 2;
        dudt[i][j] = -this.grid.u[i][j] * du_dy;

        // Momentum advection: -v·∇v (simplified to the cross-derivative term)
        const dv_dx = (this.grid.v[i + 1][j] - this.grid.v[i - 1][j]) / 2;
        dvdt[i][j] = -this.grid.v[i][j] * dv_dx;

        // Pressure gradient: -g∇h
        const dh_dx = (this.grid.h[i + 1][j] - this.grid.h[i - 1][j]) / 2;
        const dh_dy = (this.grid.h[i][j + 1] - this.grid.h[i][j - 1]) / 2;
        dudt[i][j] -= g * dh_dx;
        dvdt[i][j] -= g * dh_dy;
      }
    }

    return { dhdt, dudt, dvdt };
  }

  /**
   * Perform one time step of the simulation
   */
  public step(): void {
    const { dt } = this.config;
    
    // Compute right-hand side
    const { dhdt, dudt, dvdt } = this.computeRHS();

    // Update fields using Euler method
    const { gridSize } = this.config;
    for (let i = 0; i < gridSize; i++) {
      for (let j = 0; j < gridSize; j++) {
        this.grid.h[i][j] += dt * dhdt[i][j];
        this.grid.u[i][j] += dt * dudt[i][j];
        this.grid.v[i][j] += dt * dvdt[i][j];

        // Ensure minimum depth
        this.grid.h[i][j] = Math.max(0.1, this.grid.h[i][j]);
      }
    }

    // Apply boundary conditions
    this.applyBoundaryConditions();

    // Apply optional physics
    if (this.config.windStress) {
      // Would be called with external wind data
    }
    
    if (this.config.bottomFriction) {
      this.addBottomFriction();
    }

    this.time += dt;
  }

  /**
   * Run the simulation for a specified number of steps
   */
  public run(steps: number): void {
    for (let i = 0; i < steps; i++) {
      this.step();
    }
  }

  /**
   * Get current state of the simulation
   */
  public getState(): ShallowWaterGrid {
    return {
      ...this.grid,
      h: this.grid.h.map(row => [...row]), // Copy to prevent mutation
      u: this.grid.u.map(row => [...row]),
      v: this.grid.v.map(row => [...row]),
    };
  }

  /**
   * Get current time
   */
  public getTime(): number {
    return this.time;
  }

  /**
   * Reset the simulation
   */
  public reset(): void {
    this.grid = this.initializeGrid();
    this.time = 0;
  }

  /**
   * Clone the solver with new configuration
   */
  public clone(config?: Partial<ShallowWaterConfig>): ShallowWaterSolver {
    const newConfig = { ...this.config, ...config };
    const solver = new ShallowWaterSolver(newConfig);
    solver.grid = this.getState();
    solver.time = this.time;
    return solver;
  }

  /**
   * Create a visualization-friendly version of the data
   */
  public getVisualizationData(): {
    height: number[][];
    velocityMagnitude: number[][];
    energy: number[][];
  } {
    const { gridSize } = this.config;
    const velocityMagnitude = Array(gridSize).fill(0).map(() => Array(gridSize).fill(0));
    const energy = Array(gridSize).fill(0).map(() => Array(gridSize).fill(0));

    for (let i = 0; i < gridSize; i++) {
      for (let j = 0; j < gridSize; j++) {
        const u = this.grid.u[i][j];
        const v = this.grid.v[i][j];
        const h = this.grid.h[i][j];
        
        velocityMagnitude[i][j] = Math.sqrt(u * u + v * v);
        energy[i][j] = 0.5 * this.config.g * h * h + 0.5 * h * (u * u + v * v);
      }
    }

    return {
      height: this.grid.h.map(row => [...row]),
      velocityMagnitude,
      energy,
    };
  }
}

// Factory function for creating solvers with common configurations
export function createShallowWaterSolver(
  type: 'coarse' | 'medium' | 'fine' = 'medium',
  config?: Partial<ShallowWaterConfig>
): ShallowWaterSolver {
  const sizeMap = {
    coarse: 32,
    medium: 64,
    fine: 128,
  };

  const defaultConfig: ShallowWaterConfig = {
    gridSize: sizeMap[type],
    dt: 0.01,
    g: 9.81,
    boundary: 'reflect',
    windStress: false,
    bottomFriction: true,
  };

  return new ShallowWaterSolver({ ...defaultConfig, ...config });
}