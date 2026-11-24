import Phaser from 'phaser';
import {
  COLORS,
  ENTITY_META,
  ISOBAR_GRID_N,
  MAP_KM_PER_PX,
  MAP_SIZE,
  minPressureRadiusKm,
  PREVIEW_ISOBAR_GRID_N,
  RAIN_TEXTURE_SIZE,
  TEMPERATURE_TEXTURE_SIZE,
  WEATHER_COLORS,
} from '../config/constants';
import {
  buildPointWeather,
  buildPressureField,
  frontAt,
  influenceBoundaryPoint,
  interpolateGrid,
  windAt,
} from '../logic/field';
import { clampPosition, createEntity, resizeEntity } from '../logic/entities';
import { buildSurfaceField, sampleSurface } from '../logic/surface';
import type {
  EntityType,
  LevelDefinition,
  MapLayer,
  PointWeather,
  RunSimulation,
  SampleGrid,
  SimulationSnapshot,
  WeatherEntity,
} from '../logic/types';
import { buildContourCurves, smoothContourPoints } from '../render/isobarCurves';
import { traceContours, type IsobarLine } from '../render/isobars';
import { paintRainLayer } from '../render/rain';
import { drawBasemap, drawTerrainRelief } from '../render/basemap';
import { elevationAt } from '../render/terrain';
import { REAL_TERRAIN } from '../config/realTerrain';
import { buildFrontVisuals } from '../render/fronts';
import { shapeMetrics } from '../logic/shape';
import { typhoonCategoryLabel } from '../logic/typhoon';
import { buildPressureGrid, upsamplePressureGrid, tracePressureAxis } from '../logic/pressure';
import type { PressureGrid } from '../logic/pressure';
import {
  drawArrowHead,
  drawCross,
  drawDashedCircle,
  drawDashedLine,
  smoothClosedPoints,
  pathFromPoints,
} from '../render/drawing';

export interface HoverPayload {
  x: number;
  y: number;
  weather: PointWeather;
  clientX: number;
  clientY: number;
}

export interface SceneCallbacks {
  onHover: (payload: HoverPayload | null) => void;
  onPlace: (x: number, y: number) => void;
  onEntityClick: (entityId: string, button: 'left' | 'right') => void;
  onEntityDrag: (entityId: string, x: number, y: number, done: boolean) => void;
  onShapeChange: (entityId: string, shape?: Array<{ x: number; y: number }>) => void;
  onRadiusChange: (entityId: string, radius: number) => void;
  onCityClick: (cityId: string) => void;
  onBackgroundClick: () => void;
  onViewChange?: (state: { zoom: number; canReset: boolean; canZoomIn: boolean }) => void;
}

interface RunCallbacks {
  onPhase: (phase: number) => void;
  onComplete: () => void;
}

interface RunState {
  simulation: RunSimulation;
  elapsed: number;
  phase: number;
  callbacks: RunCallbacks;
  completed: boolean;
}

interface DragState {
  entityId: string;
  offsetX: number;
  offsetY: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
}

interface PanState {
  startX: number;
  startY: number;
  centerX: number;
  centerY: number;
  moved: boolean;
}

interface EntityLabel {
  glyph: Phaser.GameObjects.Text;
  value: Phaser.GameObjects.Text;
}

interface EntityVisual {
  x: number;
  y: number;
  scale: number;
  primary: boolean;
  groupSize: number;
  caption: string;
}

interface CityLabel {
  name: Phaser.GameObjects.Text;
  data: Phaser.GameObjects.Text;
}

const RUN_PHASE_MS = 650;
const MIN_VIEW_ZOOM = 1;
const MAX_VIEW_ZOOM = 2.5;
const TEXT_FONT = 'JetBrains Mono, Roboto Mono, Consolas, monospace';
const SANS_FONT = 'Noto Sans SC, Microsoft YaHei UI, Microsoft YaHei, sans-serif';

const TERRAIN_STOPS: Array<[number, [number, number, number]]> = [
  [0, [46, 107, 79]],
  [300, [111, 143, 76]],
  [800, [194, 162, 74]],
  [1500, [154, 106, 69]],
  [2500, [122, 91, 75]],
  [3200, [232, 238, 241]],
];

function hypsometricColor(height: number): [number, number, number] {
  const h = Math.max(0, Math.min(3200, height));
  for (let i = 0; i < TERRAIN_STOPS.length - 1; i += 1) {
    const [startH, start] = TERRAIN_STOPS[i];
    const [endH, end] = TERRAIN_STOPS[i + 1];
    if (h <= endH) {
      const t = (h - startH) / Math.max(1, endH - startH);
      return [
        start[0] + (end[0] - start[0]) * t,
        start[1] + (end[1] - start[1]) * t,
        start[2] + (end[2] - start[2]) * t,
      ];
    }
  }
  return TERRAIN_STOPS[TERRAIN_STOPS.length - 1][1];
}

export class GameScene extends Phaser.Scene {
  readyCallback?: () => void;

  private callbacks: SceneCallbacks | null = null;
  private level: LevelDefinition | null = null;
  private entities: WeatherEntity[] = [];
  private snapshot: SimulationSnapshot | null = null;
  public readonly legendState = {
    isobar: false,
    features: false,
    terrain: false,
    temperature: false,
    wind: false,
    rain: false,
    front: false,
  };
  private selectedEntityId: string | null = null;
  private shapingEnabled = false;
  private editingEntityId: string | null = null;
  private editNodeDrag: { index: number } | null = null;
  private editGraphics!: Phaser.GameObjects.Graphics;
  private handleGraphics!: Phaser.GameObjects.Graphics;
  private stretchState: { entityId: string; angle: number; minor: number } | null = null;
  private radiusState: { entityId: string } | null = null;
  private radiusGraphics!: Phaser.GameObjects.Graphics;
  private shapeFeatureGraphics!: Phaser.GameObjects.Graphics;
  private shapeFeatureLabels = new Map<string, Phaser.GameObjects.Text>();
  private lastEntityClick: { id: string; at: number } | null = null;
  private lastNodeClick: { index: number; at: number } | null = null;
  private selectedCityId = 'A';
  private activePlacement: { type: EntityType; strength: number; layer: MapLayer } | null = null;
  private ghostPoint: { x: number; y: number } | null = null;
  private dragState: DragState | null = null;
  private panState: PanState | null = null;
  private baseZoom = 1;
  private scaleBarElement: HTMLElement | null = null;
  private scaleLabelElement: HTMLElement | null = null;
  private viewZoom = 1;
  private animationSpeed = 1;
  private centerX = 400;
  private centerY = 400;

  private currentLayer: MapLayer = 'low';

  private baseGraphics!: Phaser.GameObjects.Graphics;
  /** Sea-surface temperature colour field over the water. */
  private sstGraphics!: Phaser.GameObjects.Graphics;
  private terrainGraphics!: Phaser.GameObjects.Graphics;
  private terrainImage!: Phaser.GameObjects.Image;
  private terrainTexture!: Phaser.Textures.CanvasTexture;
  private rainImage!: Phaser.GameObjects.Image;
  private rainTexture!: Phaser.Textures.CanvasTexture;
  private temperatureImage!: Phaser.GameObjects.Image;
  private temperatureTexture!: Phaser.Textures.CanvasTexture;
  private isobarGraphics!: Phaser.GameObjects.Graphics;
  private rainContourGraphics!: Phaser.GameObjects.Graphics;
  private frontGraphics!: Phaser.GameObjects.Graphics;
  private windGraphics!: Phaser.GameObjects.Graphics;
  private targetGraphics!: Phaser.GameObjects.Graphics;
  private motionGraphics!: Phaser.GameObjects.Graphics;
  /** Pressure-change overlay: where the player's analysis moved the field. */
  private deltaGraphics!: Phaser.GameObjects.Graphics;
  private entityGraphics!: Phaser.GameObjects.Graphics;
  private otherEntityGraphics!: Phaser.GameObjects.Graphics;
  private cityGraphics!: Phaser.GameObjects.Graphics;
  private ghostGraphics!: Phaser.GameObjects.Graphics;

  private entityLabels = new Map<string, EntityLabel>();
  private entityVisuals = new Map<string, EntityVisual>();
  private cityLabels = new Map<string, CityLabel>();
  private staticTexts: Phaser.GameObjects.Text[] = [];
  private isobarLabels = new Map<number, Phaser.GameObjects.Text>();
  private coordinateLabels: Phaser.GameObjects.Text[] = [];

  private running = false;
  private run: RunState | null = null;
  /**
   * Rendering follows the field quality: while the player drags, only the
   * cheap layers (isobars, wind, entities) are repainted and the expensive
   * 384² temperature/rain textures keep their previous frame.
   */
  private renderQuality: 'full' | 'preview' = 'full';
  /**
   * Layer switches.  The chart is dense; letting the player mute isobars or the
   * wind barbs is the difference between "a wall of lines" and being able to
   * see the rain band or the temperature tongue.
   */
  private deltaBaseline: SimulationSnapshot | null = null;
  private fieldVisibility: Record<'isobar' | 'wind' | 'rain' | 'temperature' | 'source' | 'sst', boolean> = {
    isobar: true,
    wind: true,
    rain: true,
    temperature: true,
    source: true,
    sst: false,
  };
  private temperatureImageData: ImageData | null = null;

  constructor() {
    super({ key: 'GameScene' });
  }

  create(): void {
    this.cameras.main.setBackgroundColor(COLORS.seaDeep);
    this.cameras.main.setRoundPixels(false);

    this.baseGraphics = this.add.graphics().setDepth(0);
    this.sstGraphics = this.add.graphics().setDepth(0.4);
    this.terrainGraphics = this.add.graphics().setDepth(0.6);
    this.createTerrainTexture();
    this.createTemperatureTexture();
    this.createRainTexture();
    this.isobarGraphics = this.add.graphics().setDepth(3);
    this.rainContourGraphics = this.add.graphics().setDepth(3.1);
    this.windGraphics = this.add.graphics().setDepth(4);
    this.frontGraphics = this.add.graphics().setDepth(4.5);
    this.targetGraphics = this.add.graphics().setDepth(5);
    this.motionGraphics = this.add.graphics().setDepth(6);
    this.deltaGraphics = this.add.graphics().setDepth(5.6);
    this.entityGraphics = this.add.graphics().setDepth(7);
    this.otherEntityGraphics = this.add.graphics().setDepth(6.8).setAlpha(0.28);
    this.cityGraphics = this.add.graphics().setDepth(8);
    this.ghostGraphics = this.add.graphics().setDepth(9);
    this.editGraphics = this.add.graphics().setDepth(10);
    this.handleGraphics = this.add.graphics().setDepth(10.5);
    this.radiusGraphics = this.add.graphics().setDepth(10.4);
    this.shapeFeatureGraphics = this.add.graphics().setDepth(4.6);

    this.scaleBarElement = document.getElementById('scale-bar');
    this.scaleLabelElement = document.getElementById('scale-label');
    this.scale.on('resize', this.handleResize, this);
    this.handleResize();

    this.input.on('pointermove', this.handlePointerMove, this);
    this.input.on('pointerdown', this.handlePointerDown, this);
    this.input.on('pointerup', this.handlePointerUp, this);
    this.input.on('gameout', this.handleGameOut, this);
    this.game.canvas.addEventListener('mouseleave', this.handleCanvasLeave);
    this.game.canvas.addEventListener('wheel', this.handleWheel, { passive: false });
    window.addEventListener('pointerup', this.handleWindowPointerUp);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.game.canvas.removeEventListener('mouseleave', this.handleCanvasLeave);
      this.game.canvas.removeEventListener('wheel', this.handleWheel);
      window.removeEventListener('pointerup', this.handleWindowPointerUp);
    });

    this.readyCallback?.();
  }

  update(_time: number, delta: number): void {
    if (!this.running || !this.run) return;
    this.updateRun(delta);
  }

  setCallbacks(callbacks: SceneCallbacks): void {
    this.callbacks = callbacks;
  }

  setShapingEnabled(enabled: boolean): void {
    this.shapingEnabled = enabled;
    if (!enabled) {
      this.editingEntityId = null;
      this.editGraphics.clear();
    }
  }

  setLevel(level: LevelDefinition): void {
    this.stopRun();
    this.level = level;
    this.editingEntityId = null;
    this.editNodeDrag = null;
    this.stretchState = null;
    this.radiusState = null;
    this.clearLabels();
    this.entities = [];
    this.snapshot = null;
    this.selectedEntityId = null;
    this.selectedCityId = 'A';
    this.activePlacement = null;
    this.ghostPoint = null;
    this.dragState = null;

    this.isobarGraphics.clear();
    this.rainContourGraphics.clear();
    this.windGraphics.clear();
    this.frontGraphics.clear();
    this.motionGraphics.clear();
    this.entityGraphics.clear();
    this.otherEntityGraphics.clear();
    this.cityGraphics.clear();
    this.ghostGraphics.clear();
    this.handleGraphics.clear();
    this.radiusGraphics.clear();
    this.rainImage.setAlpha(0);
    drawBasemap(this.baseGraphics);
    this.terrainGraphics.setVisible(Boolean(level.hasTerrain));
    this.drawTerrain();
    this.createMapLabels();
    this.drawTargets();
    this.createCityLabels();

    this.entityLabels.clear();
    this.clearIsobarLabels();
    this.currentLayer = 'low';
    this.updateScaleBar();
  }

  setLayer(layer: MapLayer): void {
    this.currentLayer = layer;
    if (this.snapshot && !this.running) {
      this.renderAll();
      this.drawCities(this.snapshot);
    }
    this.updateCursor();
  }

  setState(
    snapshot: SimulationSnapshot,
    entities: WeatherEntity[],
    selectedEntityId: string | null,
    selectedCityId: string,
    quality: 'full' | 'preview' = 'full',
  ): void {
    if (this.running) return;
    this.snapshot = snapshot;
    this.entities = entities;
    this.selectedEntityId = selectedEntityId;
    this.selectedCityId = selectedCityId;
    this.renderQuality = quality;
    this.renderAll();
  }

  setSelectedEntity(entityId: string | null): void {
    this.selectedEntityId = entityId;
    this.radiusState = null;
    if (!this.running) {
      this.drawEntities(this.entities);
      this.drawStretchHandle();
      this.drawRadiusHandles();
    }
  }

  setFieldVisible(field: 'isobar' | 'wind' | 'rain' | 'temperature' | 'source' | 'sst', visible: boolean): void {
    this.fieldVisibility[field] = visible;
    if (!this.running && this.snapshot) this.renderAll();
  }

  getFieldVisible(field: 'isobar' | 'wind' | 'rain' | 'temperature' | 'source' | 'sst'): boolean {
    return this.fieldVisibility[field];
  }

  setSelectedCity(cityId: string): void {
    this.selectedCityId = cityId;
    if (this.snapshot && !this.running) this.drawCities(this.snapshot);
  }

  setActivePlacement(type: EntityType | null, strength?: number, layer: MapLayer = 'low'): void {
    if (!type) {
      this.activePlacement = null;
      this.ghostPoint = null;
      this.ghostGraphics.clear();
      this.updateCursor();
      return;
    }
    this.activePlacement = { type, strength: strength ?? 0, layer };
    this.updateCursor();
    this.drawGhost();
  }

  setPlacementStrength(strength: number): void {
    if (this.activePlacement) {
      this.activePlacement.strength = strength;
      this.drawGhost();
    }
  }

  /**
   * Keyboard placement.  Selecting a card with the keyboard parks the ghost at
   * the chart centre (or at the last cursor position), then the arrow keys walk
   * it and Enter drops it.  Without this the map is pointer-only.
   */
  nudgeGhost(dx: number, dy: number): boolean {
    if (!this.activePlacement) return false;
    const base = this.ghostPoint ?? { x: MAP_SIZE / 2, y: MAP_SIZE / 2 };
    this.ghostPoint = {
      x: Math.max(0, Math.min(MAP_SIZE, base.x + dx)),
      y: Math.max(0, Math.min(MAP_SIZE, base.y + dy)),
    };
    this.drawGhost();
    return true;
  }

  placeGhost(): boolean {
    if (!this.activePlacement) return false;
    const point = this.ghostPoint ?? { x: MAP_SIZE / 2, y: MAP_SIZE / 2 };
    this.callbacks?.onPlace(point.x, point.y);
    return true;
  }

  updatePlacementFromClient(clientX: number, clientY: number): boolean {
    if (!this.activePlacement) return false;
    const world = this.clientToWorld(clientX, clientY);
    if (!world) {
      this.ghostPoint = null;
      this.ghostGraphics.clear();
      return false;
    }
    this.ghostPoint = world;
    this.drawGhost();
    return true;
  }

  clearGhost(): void {
    this.ghostPoint = null;
    this.ghostGraphics.clear();
    if (!this.running) this.drawFronts(this.entities, this.snapshot?.grid, this.level?.base.T);
  }

  hideHover(): void {
    this.callbacks?.onHover(null);
  }

  /**
   * Snapshot taken just before the player's last edit.  The 3-hour step itself
   * barely moves the pressure field; almost all of the change the player sees
   * came from what they just placed, so that is the baseline worth diffing
   * against.
   */
  setDeltaBaseline(snapshot: SimulationSnapshot | null): void {
    this.deltaBaseline = snapshot;
  }

  playRun(simulation: RunSimulation, callbacks: RunCallbacks): void {
    this.exitShapeEdit();
    this.stopRun();
    this.running = true;
    this.run = {
      simulation,
      elapsed: 0,
      phase: -1,
      callbacks,
      completed: false,
    };
    this.entities = simulation.before.entities;
    this.snapshot = simulation.before;
    this.selectedEntityId = null;
    this.ghostPoint = null;
    this.ghostGraphics.clear();
    this.rainImage.setAlpha(0);
    this.renderWeather(simulation.before);
    this.rainContourGraphics.setAlpha(0);
    this.drawEntities(simulation.before.entities);
    this.drawCities(simulation.before);
    this.enterRunPhase(0);
  }

  skipRun(): void {
    if (!this.running || !this.run) return;
    this.finishRun();
  }

  stopRun(): void {
    this.running = false;
    this.run = null;
    this.motionGraphics.clear();
    this.rainImage.setAlpha(1);
    this.rainContourGraphics.setAlpha(1);
  }

  worldToClient(worldX: number, worldY: number): { x: number; y: number } {
    const camera = this.cameras.main;
    const rect = this.game.canvas.getBoundingClientRect();
    const view = camera.worldView;
    const gameX = (worldX - view.x) * camera.zoom;
    const gameY = (worldY - view.y) * camera.zoom;
    const scaleX = rect.width / this.scale.width;
    const scaleY = rect.height / this.scale.height;
    return {
      x: rect.left + gameX * scaleX,
      y: rect.top + gameY * scaleY,
    };
  }

  clientToWorld(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.game.canvas.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      return null;
    }
    const gameX = ((clientX - rect.left) / rect.width) * this.scale.width;
    const gameY = ((clientY - rect.top) / rect.height) * this.scale.height;
    const world = this.cameras.main.getWorldPoint(gameX, gameY);
    if (world.x < 0 || world.x > MAP_SIZE || world.y < 0 || world.y > MAP_SIZE) return null;
    return { x: world.x, y: world.y };
  }

  private handleResize(): void {
    const width = this.scale.width;
    const height = this.scale.height;
    // Cover the whole frame; the map can be panned/zoomed inside it.
    this.baseZoom = Math.max(width, height) / MAP_SIZE;
    this.applyCamera();
    this.rainImage?.setDisplaySize(MAP_SIZE, MAP_SIZE);
  }

  private applyCamera(): void {
    const camera = this.cameras.main;
    const zoom = this.baseZoom * this.viewZoom;
    camera.setZoom(zoom);

    const halfWidth = camera.width / (2 * zoom);
    const halfHeight = camera.height / (2 * zoom);
    if (halfWidth >= MAP_SIZE / 2) {
      this.centerX = MAP_SIZE / 2;
    } else {
      this.centerX = Math.max(halfWidth, Math.min(MAP_SIZE - halfWidth, this.centerX));
    }
    if (halfHeight >= MAP_SIZE / 2) {
      this.centerY = MAP_SIZE / 2;
    } else {
      this.centerY = Math.max(halfHeight, Math.min(MAP_SIZE - halfHeight, this.centerY));
    }
    camera.centerOn(this.centerX, this.centerY);
    this.updateCursor();
    this.updateScaleBar();
    this.callbacks?.onViewChange?.({
      zoom: this.viewZoom,
      canReset: this.viewZoom > MIN_VIEW_ZOOM + 0.001,
      canZoomIn: this.viewZoom < MAX_VIEW_ZOOM - 0.001,
    });
  }

  /**
   * Screen-space scale bar. The map is 1000 world units wide; the physical width
   * is the level's domainScale (1000 km for Stage 1, 576 km for the legacy
   * stages). The bar length uses the current zoom so it stays truthful after
   * zooming, and snaps to a readable round distance.
   */
  private updateScaleBar(): void {
    const bar = this.scaleBarElement;
    const label = this.scaleLabelElement;
    const holder = bar?.parentElement;
    if (!bar || !label || !holder) return;

    const rect = this.game.canvas.getBoundingClientRect();
    const cssSpan = Math.max(1, Math.max(rect.width || 1, rect.height || 1));
    const domainKm = this.level?.base.domainScale ?? MAP_SIZE * MAP_KM_PER_PX;
    const zoom = Math.max(0.1, this.viewZoom);
    const pxPerKm = (cssSpan * zoom) / Math.max(1, domainKm);
    const candidates = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
    let picked = candidates[0];
    let found = false;
    let closest = candidates[0];
    let closestError = Number.POSITIVE_INFINITY;
    for (const value of candidates) {
      const length = value * pxPerKm;
      if (length >= 70 && length <= 180) {
        picked = value;
        found = true;
      }
      const error = Math.abs(length - 120);
      if (error < closestError) {
        closestError = error;
        closest = value;
      }
    }
    if (!found) picked = closest;

    const length = picked * pxPerKm;
    holder.style.width = `${length.toFixed(1)}px`;
    bar.style.width = '100%';
    label.textContent = `${picked} km`;
  }

  public zoomIn(): void {
    this.setViewZoom(this.viewZoom * 1.25);
  }

  /** Pan the camera by a screen-space offset (used by keyboard view controls). */
  public panBy(screenDx: number, screenDy: number): void {
    const zoom = this.baseZoom * this.viewZoom;
    this.centerX += screenDx / zoom;
    this.centerY += screenDy / zoom;
    this.applyCamera();
  }

  public zoomOut(): void {
    this.setViewZoom(this.viewZoom / 1.25);
  }

  public setAnimationSpeed(speed: number): void {
    this.animationSpeed = Math.max(0.5, Math.min(3, speed));
  }

  public resetView(): void {
    this.viewZoom = 1;
    this.centerX = MAP_SIZE / 2;
    this.centerY = MAP_SIZE / 2;
    this.applyCamera();
  }

  private setViewZoom(value: number, anchor?: { gameX: number; gameY: number; worldX: number; worldY: number }): void {
    const next = Math.max(MIN_VIEW_ZOOM, Math.min(MAX_VIEW_ZOOM, value));
    if (Math.abs(next - this.viewZoom) < 0.001) return;

    const camera = this.cameras.main;
    const worldCenterX = anchor?.worldX ?? this.centerX;
    const worldCenterY = anchor?.worldY ?? this.centerY;
    const gameX = anchor?.gameX ?? camera.width / 2;
    const gameY = anchor?.gameY ?? camera.height / 2;

    this.viewZoom = next;
    const newZoom = this.baseZoom * this.viewZoom;
    this.centerX = worldCenterX - (gameX - camera.width / 2) / newZoom;
    this.centerY = worldCenterY - (gameY - camera.height / 2) / newZoom;
    this.applyCamera();
  }

  private handleWheel = (event: WheelEvent): void => {
    if (!this.level) return;
    event.preventDefault();
    const canvas = this.game.canvas;
    const rect = canvas.getBoundingClientRect();
    const gameX = ((event.clientX - rect.left) / rect.width) * this.scale.width;
    const gameY = ((event.clientY - rect.top) / rect.height) * this.scale.height;
    const camera = this.cameras.main;
    const world = camera.getWorldPoint(gameX, gameY);
    const factor = Math.exp(-event.deltaY * 0.0014);
    this.setViewZoom(this.viewZoom * factor, {
      gameX,
      gameY,
      worldX: world.x,
      worldY: world.y,
    });
  };

  private updateCursor(): void {
    const cursor = this.activePlacement
      ? 'crosshair'
      : this.panState
        ? 'grabbing'
        : this.viewZoom > MIN_VIEW_ZOOM + 0.001
          ? 'grab'
          : 'default';
    if (this.game?.canvas) this.game.canvas.style.cursor = cursor;
  }

  private createRainTexture(): void {
    if (this.textures.exists('rain-layer')) {
      this.rainTexture = this.textures.get('rain-layer') as Phaser.Textures.CanvasTexture;
    } else {
      const texture = this.textures.createCanvas(
        'rain-layer',
        RAIN_TEXTURE_SIZE,
        RAIN_TEXTURE_SIZE,
      );
      if (!texture) throw new Error('Unable to create the precipitation layer.');
      this.rainTexture = texture;
      this.rainTexture.setFilter(Phaser.Textures.FilterMode.LINEAR);
    }
    this.rainImage = this.add
      .image(0, 0, 'rain-layer')
      .setOrigin(0, 0)
      .setDisplaySize(MAP_SIZE, MAP_SIZE)
      .setAlpha(0)
      .setDepth(2);
  }

  private createTerrainTexture(): void {
    const size = 1024;
    if (this.textures.exists('terrain-layer')) {
      this.terrainTexture = this.textures.get('terrain-layer') as Phaser.Textures.CanvasTexture;
    } else {
      const texture = this.textures.createCanvas('terrain-layer', size, size);
      if (!texture) throw new Error('Unable to create the terrain layer.');
      this.terrainTexture = texture;
    }
    this.terrainTexture.setFilter(Phaser.Textures.FilterMode.LINEAR);
    this.terrainImage = this.add
      .image(0, 0, 'terrain-layer')
      .setOrigin(0, 0)
      .setDisplaySize(MAP_SIZE, MAP_SIZE)
      .setDepth(0.55)
      .setAlpha(0);
  }

  private paintRealTerrain(profile: NonNullable<LevelDefinition['base']['terrainProfile']>): void {
    const texture = this.terrainTexture;
    const context = texture.context;
    const size = 1024;
    // Reuse the scratch buffer: this runs on every field change and a fresh
    // 384² ImageData is 590 kB of garbage per repaint.
    if (!this.temperatureImageData || this.temperatureImageData.width !== size) {
      this.temperatureImageData = context.createImageData(size, size);
    }
    const image = this.temperatureImageData;
    const data = image.data;
    const real = REAL_TERRAIN[profile];
    for (let py = 0; py < size; py += 1) {
      const y = ((py + 0.5) / size) * MAP_SIZE;
      for (let px = 0; px < size; px += 1) {
        const x = ((px + 0.5) / size) * MAP_SIZE;
        const height = elevationAt(x, y, profile);
        const index = (py * size + px) * 4;
        if (height <= 0) {
          data[index] = 6;
          data[index + 1] = 12;
          data[index + 2] = 18;
          data[index + 3] = 255;
          continue;
        }
        const east = elevationAt(Math.min(MAP_SIZE, x + 2), y, profile);
        const south = elevationAt(x, Math.min(MAP_SIZE, y + 2), profile);
        const shade = Math.max(-1.6, Math.min(1.6, (height - (east + south) / 2) / 120));
        const light = Math.max(0.5, Math.min(1.45, 1 + shade * 0.45));
        const [baseR, baseG, baseB] = hypsometricColor(height);
        let r = baseR * light;
        let g = baseG * light;
        let b = baseB * light;
        // Fixed 250 m contour bands.
        const contour =
          Math.floor(height / 250) !== Math.floor(east / 250) ||
          Math.floor(height / 250) !== Math.floor(south / 250);
        if (contour) {
          r *= 0.58;
          g *= 0.6;
          b *= 0.6;
        }
        data[index] = Math.max(0, Math.min(255, r));
        data[index + 1] = Math.max(0, Math.min(255, g));
        data[index + 2] = Math.max(0, Math.min(255, b));
        data[index + 3] = 255;
      }
    }
    context.clearRect(0, 0, size, size);
    context.putImageData(image, 0, 0);
    texture.refresh();
    this.terrainImage.setAlpha(real ? 1 : 0);
  }

  private createTemperatureTexture(): void {
    if (this.textures.exists('temperature-layer')) {
      this.temperatureTexture = this.textures.get('temperature-layer') as Phaser.Textures.CanvasTexture;
      this.temperatureTexture.setFilter(Phaser.Textures.FilterMode.LINEAR);
    } else {
      const texture = this.textures.createCanvas(
        'temperature-layer',
        TEMPERATURE_TEXTURE_SIZE,
        TEMPERATURE_TEXTURE_SIZE,
      );
      if (!texture) throw new Error('Unable to create the temperature layer.');
      this.temperatureTexture = texture;
      this.temperatureTexture.setFilter(Phaser.Textures.FilterMode.LINEAR);
    }
    this.temperatureImage = this.add
      .image(0, 0, 'temperature-layer')
      .setOrigin(0, 0)
      .setDisplaySize(MAP_SIZE, MAP_SIZE)
      .setDepth(1.6);
  }

  private paintTemperature(grid: SampleGrid, entities: WeatherEntity[]): void {
    if (!this.level) return;
    const texture = this.temperatureTexture;
    const context = texture.context;
    const size = TEMPERATURE_TEXTURE_SIZE;
    const airMasses = entities.filter(
      (entity) => entity.type === 'coldAir' || entity.type === 'warmAir',
    );
    if (airMasses.length === 0) {
      context.clearRect(0, 0, size, size);
      texture.refresh();
      return;
    }
    // Reuse the scratch buffer: this runs on every field change and a fresh
    // 384² ImageData is 590 kB of garbage per repaint.
    if (!this.temperatureImageData || this.temperatureImageData.width !== size) {
      this.temperatureImageData = context.createImageData(size, size);
    }
    const image = this.temperatureImageData;
    const data = image.data;

    for (let py = 0; py < size; py += 1) {
      const y = (py / (size - 1)) * MAP_SIZE;
      for (let px = 0; px < size; px += 1) {
        const x = (px / (size - 1)) * MAP_SIZE;
        const windX = interpolateGrid(grid, grid.uLow, x, y);
        const windY = interpolateGrid(grid, grid.vLow, x, y);
        const speed = Math.hypot(windX, windY);
        const ux = speed > 0.05 ? windX / speed : 1;
        const uy = speed > 0.05 ? windY / speed : 0;
        const shift = Math.min(46, speed * 2.8);
        const stretch = 1 + Math.min(1.05, speed / 8);

        let coldAnomaly = 0;
        let warmAnomaly = 0;
        for (const entity of airMasses) {
          const dx = x - (entity.x + ux * shift);
          const dy = y - (entity.y + uy * shift);
          const along = dx * ux + dy * uy;
          const cross = -dx * uy + dy * ux;
          const radial = Math.hypot(along / stretch, cross / 0.72);
          const visualRadius = entity.radius * 0.72;
          if (radial >= visualRadius) continue;
          const normalized = radial / visualRadius;
          const falloff = (1 - normalized * normalized) ** 1.35;
          if (entity.type === 'coldAir') coldAnomaly += entity.strength * falloff;
          else warmAnomaly += entity.strength * falloff;
        }
        let anomaly = warmAnomaly - coldAnomaly;
        if (coldAnomaly > 0.15 && warmAnomaly > 0.15) {
          const dominant = Math.max(coldAnomaly, warmAnomaly);
          if (Math.abs(coldAnomaly - warmAnomaly) > dominant * 0.35) {
            anomaly = (warmAnomaly >= coldAnomaly ? dominant : -dominant) * 1.12;
          }
        }

        const index = (py * size + px) * 4;
        if (Math.abs(anomaly) < 0.9) {
          data[index + 3] = 0;
          continue;
        }
        const warm = anomaly > 0;
        const intensity = Math.min(1, Math.abs(anomaly) / 8);
        const alpha = 9 + intensity * 30;
        data[index] = warm ? 218 : 91;
        data[index + 1] = warm ? 124 : 145;
        data[index + 2] = warm ? 108 : 217;
        data[index + 3] = alpha;
      }
    }
    context.putImageData(image, 0, 0);
    texture.refresh();
  }

  private handleGameOut(): void {
    if (this.running) return;
    this.callbacks?.onHover(null);
  }

  private handleCanvasLeave = (): void => {
    if (this.running) return;
    this.callbacks?.onHover(null);
    if (!this.dragState) {
      this.ghostPoint = null;
      this.ghostGraphics.clear();
    }
  };

  private pointerWorld(pointer: Phaser.Input.Pointer): { x: number; y: number } | null {
    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    if (world.x < 0 || world.x > MAP_SIZE || world.y < 0 || world.y > MAP_SIZE) return null;
    return { x: world.x, y: world.y };
  }

  private handlePointerMove(pointer: Phaser.Input.Pointer): void {
    if (!this.level) return;

    if (this.running) {
      this.callbacks?.onHover(null);
      return;
    }

    if (this.panState && pointer.isDown) {
      const dx = pointer.x - this.panState.startX;
      const dy = pointer.y - this.panState.startY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this.panState.moved = true;
      if (this.panState.moved) {
        const zoom = this.baseZoom * this.viewZoom;
        this.centerX = this.panState.centerX - dx / zoom;
        this.centerY = this.panState.centerY - dy / zoom;
        this.applyCamera();
        this.callbacks?.onHover(null);
        this.updateCursor();
        return;
      }
    }

    const world = this.pointerWorld(pointer);
    if (!world) {
      this.callbacks?.onHover(null);
      return;
    }

    if (this.radiusState) {
      this.updateRadius(world);
      return;
    }

    if (this.stretchState) {
      this.updateStretch(world);
      return;
    }

    if (this.editNodeDrag) {
      const entity = this.editingEntity();
      if (entity?.shape) {
        entity.shape[this.editNodeDrag.index] = { x: world.x - entity.x, y: world.y - entity.y };
        this.callbacks?.onShapeChange(entity.id, entity.shape.map((point) => ({ ...point })));
        this.drawShapeEditOverlay();
        return;
      }
    }

    if (this.dragState && pointer.isDown) {
      const target = clampPosition(world.x - this.dragState.offsetX, world.y - this.dragState.offsetY);
      if (
        Math.abs(target.x - this.dragState.startX) > 2 ||
        Math.abs(target.y - this.dragState.startY) > 2
      ) {
        this.dragState.moved = true;
      }
      this.dragState.lastX = target.x;
      this.dragState.lastY = target.y;
      if (this.dragState.moved) {
        this.callbacks?.onEntityDrag(this.dragState.entityId, target.x, target.y, false);
      }
    }

    if (this.activePlacement) {
      this.ghostPoint = world;
      this.drawGhost();
    }

    const weather = buildPointWeather(this.entities, this.level.base, world.x, world.y);
    const fallback = this.worldToClient(world.x, world.y);
    const event = pointer.event as MouseEvent | undefined;
    this.callbacks?.onHover({
      x: world.x,
      y: world.y,
      weather,
      clientX: event?.clientX ?? fallback.x,
      clientY: event?.clientY ?? fallback.y,
    });
  }

  private defaultShape(entity: WeatherEntity): Array<{ x: number; y: number }> {
    const points: Array<{ x: number; y: number }> = [];
    const radius = entity.radius * 0.82;
    for (let i = 0; i < 12; i += 1) {
      const angle = (i / 12) * Math.PI * 2;
      points.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    }
    return points;
  }

  private editingEntity(): WeatherEntity | null {
    if (!this.editingEntityId) return null;
    return this.entities.find((entity) => entity.id === this.editingEntityId) ?? null;
  }

  private beginShapeEdit(entity: WeatherEntity): void {
    if (!this.shapingEnabled || entity.locked) return;
    this.dragState = null;
    this.editingEntityId = entity.id;
    const shape = entity.shape && entity.shape.length >= 3 ? entity.shape : this.defaultShape(entity);
    entity.shape = shape;
    this.callbacks?.onShapeChange(entity.id, shape.map((point) => ({ ...point })));
    this.drawStretchHandle();
    this.drawRadiusHandles();
  }

  private exitShapeEdit(): void {
    this.editingEntityId = null;
    this.editNodeDrag = null;
    this.stretchState = null;
    this.lastNodeClick = null;
    this.editGraphics.clear();
    this.drawStretchHandle();
    this.drawRadiusHandles();
  }

  private nearbyNode(world: { x: number; y: number }): { entity: WeatherEntity; index: number } | null {
    const entity = this.editingEntity();
    if (!entity?.shape) return null;
    for (let index = 0; index < entity.shape.length; index += 1) {
      const point = entity.shape[index];
      if (Math.hypot(world.x - (entity.x + point.x), world.y - (entity.y + point.y)) <= 11) {
        return { entity, index };
      }
    }
    return null;
  }

  private addShapeNode(entity: WeatherEntity, world: { x: number; y: number }): void {
    if (!entity.shape) return;
    const local = { x: world.x - entity.x, y: world.y - entity.y };
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < entity.shape.length; i += 1) {
      const a = entity.shape[i];
      const b = entity.shape[(i + 1) % entity.shape.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lengthSq = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((local.x - a.x) * dx + (local.y - a.y) * dy) / lengthSq));
      const distance = Math.hypot(local.x - (a.x + dx * t), local.y - (a.y + dy * t));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    entity.shape.splice(best + 1, 0, local);
    this.callbacks?.onShapeChange(entity.id, entity.shape.map((point) => ({ ...point })));
  }

  private drawShapeEditOverlay(): void {
    this.editGraphics.clear();
    const entity = this.editingEntity();
    if (!entity?.shape) return;
    const points = entity.shape.map((point) => ({ x: entity.x + point.x, y: entity.y + point.y }));
    if (points.length < 3) return;

    this.editGraphics.fillStyle(0x63d4df, 0.055);
    this.editGraphics.lineStyle(1.2, 0x8fe4ec, 0.8);
    this.editGraphics.beginPath();
    this.editGraphics.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) this.editGraphics.lineTo(points[i].x, points[i].y);
    this.editGraphics.closePath();
    this.editGraphics.fillPath();
    this.editGraphics.strokePath();

    const minX = Math.min(...points.map((point) => point.x));
    const maxX = Math.max(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxY = Math.max(...points.map((point) => point.y));
    this.editGraphics.lineStyle(0.55, 0x8fe4ec, 0.16);
    for (let x = Math.ceil(minX / 20) * 20; x <= maxX; x += 20) {
      this.editGraphics.lineBetween(x, minY, x, maxY);
    }
    for (let y = Math.ceil(minY / 20) * 20; y <= maxY; y += 20) {
      this.editGraphics.lineBetween(minX, y, maxX, y);
    }

    if (this.editNodeDrag) {
      const point = points[this.editNodeDrag.index];
      this.editGraphics.lineStyle(0.9, 0x8fe4ec, 0.5);
      this.editGraphics.lineBetween(entity.x, entity.y, point.x, point.y);
    }

    for (const point of points) {
      this.editGraphics.fillStyle(0x071118, 0.95);
      this.editGraphics.fillCircle(entity.x + (point.x - entity.x), entity.y + (point.y - entity.y), 5.5);
      this.editGraphics.lineStyle(1.4, 0x9deff4, 0.95);
      this.editGraphics.strokeCircle(point.x, point.y, 5.5);
      this.editGraphics.lineStyle(3, 0x63d4df, 0.18);
      this.editGraphics.strokeCircle(point.x, point.y, 9);
    }
  }

  private stretchRadius(entity: WeatherEntity, angle: number): number {
    if (!entity.shape || entity.shape.length < 3) return entity.radius * 0.85;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let radius = 0;
    for (const point of entity.shape) {
      radius = Math.max(radius, Math.abs(point.x * cos + point.y * sin));
    }
    return radius || entity.radius * 0.85;
  }

  private stretchHandlePoint(
    entity: WeatherEntity,
    direction = 1,
  ): { x: number; y: number } {
    const metrics = shapeMetrics(entity);
    const angle = (metrics?.angle ?? 0) + (direction < 0 ? Math.PI : 0);
    const radius = this.stretchRadius(entity, metrics?.angle ?? 0);
    return {
      x: entity.x + Math.cos(angle) * radius,
      y: entity.y + Math.sin(angle) * radius,
    };
  }

  private isPressureCenter(entity: WeatherEntity): boolean {
    return (
      entity.type === 'coldLow' ||
      entity.type === 'warmLow' ||
      entity.type === 'coldHigh' ||
      entity.type === 'warmHigh' ||
      entity.type === 'typhoon'
    );
  }

  private radiusHandleHalf(entity: WeatherEntity): number {
    return Math.max(30, entity.radius * 0.7);
  }

  private radiusHandlePoints(entity: WeatherEntity): Array<{ x: number; y: number }> {
    const half = this.radiusHandleHalf(entity);
    return [
      { x: entity.x - half, y: entity.y - half },
      { x: entity.x + half, y: entity.y - half },
      { x: entity.x - half, y: entity.y + half },
      { x: entity.x + half, y: entity.y + half },
    ];
  }

  private drawRadiusHandles(): void {
    this.radiusGraphics.clear();
    if (this.running || this.editingEntityId || !this.selectedEntityId) return;
    const entity = this.entities.find((item) => item.id === this.selectedEntityId);
    if (!entity || entity.locked || !this.isPressureCenter(entity)) return;

    const color = 0x8fd8e5;
    const dragging = this.radiusState?.entityId === entity.id;
    drawDashedCircle(
      this.radiusGraphics,
      entity.x,
      entity.y,
      entity.radius,
      color,
      dragging ? 0.3 : 0.12,
      1,
      64,
    );

    const half = this.radiusHandleHalf(entity);
    const left = entity.x - half;
    const top = entity.y - half;
    const size = half * 2;
    const alpha = dragging ? 0.3 : 0.14;
    drawDashedLine(this.radiusGraphics, left, top, left + size, top, color, alpha, 5, 5, 0.8);
    drawDashedLine(this.radiusGraphics, left + size, top, left + size, top + size, color, alpha, 5, 5, 0.8);
    drawDashedLine(this.radiusGraphics, left + size, top + size, left, top + size, color, alpha, 5, 5, 0.8);
    drawDashedLine(this.radiusGraphics, left, top + size, left, top, color, alpha, 5, 5, 0.8);

    for (const point of this.radiusHandlePoints(entity)) {
      this.radiusGraphics.fillStyle(0x071319, 0.96);
      this.radiusGraphics.fillCircle(point.x, point.y, 4.4);
      this.radiusGraphics.lineStyle(1.1, color, dragging ? 0.95 : 0.7);
      this.radiusGraphics.strokeCircle(point.x, point.y, 4.4);
    }
  }

  private beginRadiusDrag(world: { x: number; y: number }): boolean {
    if (this.running || this.editingEntityId || !this.selectedEntityId) return false;
    const entity = this.entities.find((item) => item.id === this.selectedEntityId);
    if (!entity || entity.locked || !this.isPressureCenter(entity)) return false;
    const hit = this.radiusHandlePoints(entity).some(
      (point) => Math.hypot(world.x - point.x, world.y - point.y) <= 13,
    );
    if (!hit) return false;
    this.radiusState = { entityId: entity.id };
    this.drawRadiusHandles();
    return true;
  }

  private minRadiusPxFor(entity: WeatherEntity): number {
    const domain = this.level?.base.domainScale;
    const kmPerPx = domain ? domain / MAP_SIZE : MAP_KM_PER_PX;
    return minPressureRadiusKm(entity.strength) / kmPerPx;
  }

  private updateRadius(world: { x: number; y: number }): void {
    if (!this.radiusState) return;
    const entity = this.entities.find((item) => item.id === this.radiusState!.entityId);
    if (!entity) return;
    const dx = world.x - entity.x;
    const dy = world.y - entity.y;
    const half = this.radiusHandleHalf(entity);
    const next = (Math.max(Math.abs(dx), Math.abs(dy)) / Math.max(1, half)) * entity.radius;
    if (resizeEntity(entity, next, this.minRadiusPxFor(entity))) {
      this.callbacks?.onRadiusChange?.(entity.id, entity.radius);
    }
    this.drawStretchHandle();
    this.drawRadiusHandles();
  }

  private drawStretchHandle(): void {
    this.handleGraphics.clear();
    if (!this.shapingEnabled || this.running || this.editingEntityId || !this.selectedEntityId) return;
    const entity = this.entities.find((item) => item.id === this.selectedEntityId);
    if (!entity || entity.locked) return;
    if (
      entity.type !== 'coldLow' &&
      entity.type !== 'warmLow' &&
      entity.type !== 'coldHigh' &&
      entity.type !== 'warmHigh'
    ) {
      return;
    }
    const color = 0x7fe0e6;
    for (const direction of [1, -1] as const) {
      const point = this.stretchHandlePoint(entity, direction);
      this.handleGraphics.lineStyle(0.8, color, 0.34);
      this.handleGraphics.lineBetween(entity.x, entity.y, point.x, point.y);
      this.handleGraphics.fillStyle(0x071319, 0.96);
      this.handleGraphics.fillCircle(point.x, point.y, 6);
      this.handleGraphics.lineStyle(1.2, color, 0.9);
      this.handleGraphics.strokeCircle(point.x, point.y, 6);
      this.handleGraphics.lineStyle(1, color, 0.9);
      this.handleGraphics.lineBetween(point.x - 10, point.y, point.x - 6, point.y);
      this.handleGraphics.lineBetween(point.x + 6, point.y, point.x + 10, point.y);
      this.handleGraphics.lineBetween(point.x, point.y - 10, point.x, point.y - 6);
      this.handleGraphics.lineBetween(point.x, point.y + 6, point.x, point.y + 10);
      this.handleGraphics.fillStyle(color, 0.8);
      this.handleGraphics.fillCircle(point.x, point.y, 1.5);
    }
    this.handleGraphics.fillStyle(0x071319, 0.5);
    this.handleGraphics.fillCircle(entity.x, entity.y, 2);
    if (!this.handleGraphics) return;
  }

  private beginStretch(world: { x: number; y: number }): boolean {
    if (!this.shapingEnabled || this.running || !this.selectedEntityId) return false;
    const entity = this.entities.find((item) => item.id === this.selectedEntityId);
    if (!entity) return false;
    if (
      entity.type !== 'coldLow' &&
      entity.type !== 'warmLow' &&
      entity.type !== 'coldHigh' &&
      entity.type !== 'warmHigh'
    ) {
      return false;
    }
    const metrics = shapeMetrics(entity);
    const pointA = this.stretchHandlePoint(entity, 1);
    const pointB = this.stretchHandlePoint(entity, -1);
    if (
      Math.hypot(world.x - pointA.x, world.y - pointA.y) > 14 &&
      Math.hypot(world.x - pointB.x, world.y - pointB.y) > 14
    ) {
      return false;
    }
    this.stretchState = {
      entityId: entity.id,
      angle: metrics?.angle ?? 0,
      minor: metrics?.minorRadius ?? entity.radius * 0.6,
    };
    return true;
  }

  private updateStretch(world: { x: number; y: number }): void {
    if (!this.stretchState) return;
    const entity = this.entities.find((item) => item.id === this.stretchState!.entityId);
    if (!entity) return;
    const dx = world.x - entity.x;
    const dy = world.y - entity.y;
    const cos = Math.cos(this.stretchState.angle);
    const sin = Math.sin(this.stretchState.angle);
    const radiusX = Math.max(entity.radius * 0.45, Math.abs(dx * cos + dy * sin));
    const radiusY = Math.max(28, Math.min(entity.radius * 0.9, this.stretchState.minor));
    const points: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 24; i += 1) {
      const angle = (i / 24) * Math.PI * 2;
      const x = Math.cos(angle) * radiusX;
      const y = Math.sin(angle) * radiusY;
      points.push({
        x: x * cos - y * sin,
        y: x * sin + y * cos,
      });
    }
    entity.shape = points;
    this.callbacks?.onShapeChange(entity.id, points);
    this.drawStretchHandle();
  }

  private handlePointerDown(pointer: Phaser.Input.Pointer): void {
    if (!this.level) return;

    if (this.running) {
      this.skipRun();
      return;
    }

    const world = this.pointerWorld(pointer);
    if (!world) return;

    const rightClick = pointer.button === 2 || pointer.rightButtonDown();
    const hit = this.entitiesAt(world.x, world.y)[0] ?? null;

    if (!rightClick && this.beginRadiusDrag(world)) return;
    if (!rightClick && this.beginStretch(world)) return;

    if (this.editingEntityId) {
      const editing = this.editingEntity();
      if (!editing) {
        this.exitShapeEdit();
      } else if (rightClick) {
        this.addShapeNode(editing, world);
        return;
      } else {
        const node = this.nearbyNode(world);
        if (node) {
          const now = performance.now();
          if (this.lastNodeClick?.index === node.index && now - this.lastNodeClick.at < 350 && editing.shape && editing.shape.length > 4) {
            editing.shape.splice(node.index, 1);
            this.lastNodeClick = null;
            this.callbacks?.onShapeChange(editing.id, editing.shape.map((point) => ({ ...point })));
            return;
          }
          this.lastNodeClick = { index: node.index, at: now };
          this.editNodeDrag = { index: node.index };
          return;
        }
        const centerDistance = Math.hypot(world.x - editing.x, world.y - editing.y);
        if (centerDistance < 18) {
          const now = performance.now();
          if (this.lastEntityClick?.id === editing.id && now - this.lastEntityClick.at < 350) {
            editing.shape = undefined;
            this.exitShapeEdit();
            this.callbacks?.onShapeChange(editing.id, undefined);
            return;
          }
        }
        if (!hit) {
          this.exitShapeEdit();
          this.callbacks?.onBackgroundClick();
          return;
        }
      }
    }

    if (rightClick) {
      if (hit) this.callbacks?.onEntityClick(hit.id, 'right');
      else this.callbacks?.onBackgroundClick();
      return;
    }

    if (this.activePlacement) {
      this.callbacks?.onPlace(world.x, world.y);
      return;
    }

    if (hit) {
      if (this.shapingEnabled && !hit.locked) {
        const now = performance.now();
        if (this.lastEntityClick?.id === hit.id && now - this.lastEntityClick.at < 350) {
          this.callbacks?.onBackgroundClick();
          this.beginShapeEdit(hit);
          this.lastEntityClick = null;
          return;
        }
        this.lastEntityClick = { id: hit.id, at: now };
      }
      this.callbacks?.onEntityClick(hit.id, 'left');
      if (!hit.locked) {
        this.dragState = {
          entityId: hit.id,
          offsetX: world.x - hit.x,
          offsetY: world.y - hit.y,
          startX: hit.x,
          startY: hit.y,
          lastX: hit.x,
          lastY: hit.y,
          moved: false,
        };
      }
      return;
    }

    const city = this.hitCity(world.x, world.y);
    if (city) {
      this.callbacks?.onCityClick(city);
      return;
    }

    this.panState = {
      startX: pointer.x,
      startY: pointer.y,
      centerX: this.centerX,
      centerY: this.centerY,
      moved: false,
    };
    this.updateCursor();
  }

  private handleWindowPointerUp = (): void => {
    if (this.panState || this.dragState || this.editNodeDrag || this.stretchState || this.radiusState) {
      this.handlePointerUp();
    }
  };

  private handlePointerUp(): void {
    if (this.radiusState) {
      this.radiusState = null;
      this.drawStretchHandle();
      this.drawRadiusHandles();
      return;
    }
    if (this.stretchState) {
      this.stretchState = null;
      this.drawStretchHandle();
      return;
    }
    if (this.editNodeDrag) {
      this.editNodeDrag = null;
      this.drawShapeEditOverlay();
      return;
    }
    if (this.panState) {
      const pan = this.panState;
      this.panState = null;
      this.updateCursor();
      if (!pan.moved) this.callbacks?.onBackgroundClick();
      return;
    }
    if (!this.dragState) return;
    const drag = this.dragState;
    this.dragState = null;
    if (drag.moved) {
      this.callbacks?.onEntityDrag(drag.entityId, drag.lastX, drag.lastY, true);
    }
  }

  private entitiesAt(x: number, y: number): WeatherEntity[] {
    return this.entities
      .filter((entity) => entity.layer === this.currentLayer)
      .map((entity) => {
        const visual = this.entityVisuals.get(entity.id);
        const centerX = visual?.x ?? entity.x;
        const centerY = visual?.y ?? entity.y;
        return {
          entity,
          distance: Math.hypot(centerX - x, centerY - y),
          hitRadius: visual?.primary === false ? 16 : 27,
        };
      })
      .filter((item) => item.distance <= item.hitRadius)
      .sort((a, b) => a.distance - b.distance)
      .map((item) => item.entity);
  }

  private hitCity(x: number, y: number): string | null {
    if (!this.level) return null;
    for (const city of this.level.cities) {
      if (Math.hypot(city.x - x, city.y - y) <= 24) return city.id;
    }
    return null;
  }

  private renderAll(): void {
    if (!this.snapshot) return;
    this.renderWeather(this.snapshot);
    this.drawEntities(this.entities);
    this.drawCities(this.snapshot);
    this.drawGhost();
    this.drawShapeEditOverlay();
    this.drawStretchHandle();
    this.drawRadiusHandles();
  }

  /** Blend two 0xRRGGBB colours; used by the SST ramp. */
  private static lerpColor(a: number, b: number, t: number): number {
    const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
    const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
    const r = Math.round(ar + (br - ar) * t);
    const g = Math.round(ag + (bg - ag) * t);
    const blue = Math.round(ab + (bb - ab) * t);
    return (r << 16) | (g << 8) | blue;
  }

  /** SST colour field over the water (8°C deep blue → 26°C teal → 32°C amber). */
  private drawSstField(): void {
    const graphics = this.sstGraphics;
    graphics.clear();
    if (!this.fieldVisibility.sst || !this.level?.base.surface) return;
    const field = buildSurfaceField(this.level.base);
    const step = MAP_SIZE / field.n;
    for (let j = 0; j < field.n; j += 1) {
      for (let i = 0; i < field.n; i += 1) {
        const index = j * field.n + i;
        if (field.land[index]) continue;
        const temp = Math.max(8, Math.min(32, field.sst[index]));
        const colour = temp < 26
          ? GameScene.lerpColor(0x123a56, 0x1f8a86, (temp - 8) / 18)
          : GameScene.lerpColor(0x1f8a86, 0xc06a3a, (temp - 26) / 6);
        graphics.fillStyle(colour, 0.62);
        graphics.fillRect(i * step, j * step, step + 1, step + 1);
      }
    }
  }

  private renderWeather(snapshot: SimulationSnapshot): void {
    this.snapshot = snapshot;
    const grid = snapshot.grid;
    // Mid and high are both upper-air environment views: only the surface
    // layer owns a pressure analysis with rain, temperature and fronts.  The
    // old mid view drew the surface chart with the rain switched off, which
    // told the player a 700 hPa chart existed when it did not.
    const highLayer = this.currentLayer !== 'low';
    this.legendState.features = false;
    this.legendState.temperature = false;
    this.legendState.wind = false;
    this.legendState.rain = false;
    this.legendState.front = false;
    this.legendState.terrain = this.level?.base.hasTerrain ?? false;
    let hasRain = false;
    for (const value of grid.r) {
      if (value >= 0.1) {
        hasRain = true;
        break;
      }
    }
    this.legendState.rain = hasRain;
    const show = this.fieldVisibility;
    this.drawSstField();
    if (show.isobar) {
      this.drawIsobars(highLayer);
    } else {
      this.isobarGraphics.clear();
      this.setIsobarLabelsVisible(false);
    }
    const preview = this.renderQuality === 'preview';
    if (this.currentLayer === 'low') {
      if (!preview && show.rain) this.drawRainContours(grid);
      if (show.rain) {
        // keep contours cleared when the layer is muted
      } else {
        this.rainContourGraphics.clear();
      }
      if (show.wind) this.drawWind(grid);
      else this.windGraphics.clear();
      this.drawFronts(snapshot.entities, grid, this.level?.base.T);
      if (!preview) {
        // 384² per-pixel paints dominate the frame; while dragging they keep
        // their previous texture so the isobars and the card stay live.
        if (show.temperature) {
          this.paintTemperature(grid, snapshot.entities);
          this.temperatureImage.setAlpha(1);
        } else {
          this.temperatureImage.setAlpha(0);
        }
        this.legendState.temperature = snapshot.entities.some(
          (entity) => entity.type === 'coldAir' || entity.type === 'warmAir',
        );
        if (show.rain) {
          this.paintRain(grid);
          if (!this.running) this.rainImage.setAlpha(1);
        } else {
          this.rainImage.setAlpha(0);
        }
      }
    } else {
      this.rainContourGraphics.clear();
      this.frontGraphics.clear();
      this.rainImage.setAlpha(0);
      this.temperatureImage.setAlpha(0);
      if (show.wind) this.drawWind(grid);
      else this.windGraphics.clear();
    }
    this.drawCities(snapshot);
    if (!this.running) this.rainContourGraphics.setAlpha(this.currentLayer === 'low' ? 1 : 0);
  }

  private strokeSmoothContour(
    points: Array<{ x: number; y: number }>,
    graphics: Phaser.GameObjects.Graphics = this.isobarGraphics,
  ): void {
    if (points.length < 2) return;
    const first = points[0];
    const last = points[points.length - 1];
    const closed = points.length > 3 && Math.hypot(first.x - last.x, first.y - last.y) < 2;
    const trimmed = closed ? points.slice(0, -1) : points;
    if (trimmed.length < 2) return;
    const source = smoothContourPoints(trimmed, closed, 2);
    if (source.length < 2) return;
    const path = new Phaser.Curves.Path(source[0].x, source[0].y);
    const count = closed ? source.length : source.length - 1;
    for (let i = 0; i < count; i += 1) {
      const n = source.length;
      const p0 = closed ? source[(i - 1 + n) % n] : source[Math.max(0, i - 1)];
      const p1 = source[i];
      const p2 = closed ? source[(i + 1) % n] : source[i + 1];
      const p3 = closed ? source[(i + 2) % n] : source[Math.min(n - 1, i + 2)];
      path.cubicBezierTo(
        p2.x,
        p2.y,
        p1.x + (p2.x - p0.x) / 6,
        p1.y + (p2.y - p0.y) / 6,
        p2.x - (p3.x - p1.x) / 6,
        p2.y - (p3.y - p1.y) / 6,
      );
    }
    path.draw(graphics, 24);
  }

  private pressureAnalysis(highLayer: boolean): PressureGrid {
    if (!this.level) return buildPressureGrid([], { P: 1012, T: 22, Q: 7.4, latitude: 30, hemisphere: 'N' }, ISOBAR_GRID_N, highLayer);
    const isobarN = this.renderQuality === 'preview' ? PREVIEW_ISOBAR_GRID_N : ISOBAR_GRID_N;
    const weather = this.snapshot?.grid;
    if (weather) {
      if (!highLayer && weather.pressureFine && weather.pressureFineN) {
        const n = weather.pressureFineN;
        return { n, spacing: MAP_SIZE / (n - 1), values: weather.pressureFine };
      }
      if (highLayer) {
        // The high-layer pressure field is cheap enough to sample directly at
        // the contour resolution; it has no terrain perturbation to cache.
        return buildPressureField(this.entities, this.level.base, isobarN, MAP_SIZE, true);
      }
      return upsamplePressureGrid(
        weather.pLow,
        weather.n,
        weather.spacing,
        isobarN,
      );
    }
    return buildPressureGrid(this.entities, this.level.base, isobarN, highLayer);
  }

  private drawIsobars(highLayer = false): void {
    this.isobarGraphics.clear();
    if (!this.level) return;
    const analysis = this.pressureAnalysis(highLayer);
    const values = analysis.values;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const value of values) {
      if (!Number.isFinite(value)) continue;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }

    const levels: number[] = [];
    for (let level = Math.ceil(min / 2) * 2; level <= max; level += 2) levels.push(level);
    const unique = levels;
    const preview = this.renderQuality === 'preview';
    // Label placement needs the raw contour lines, which is a second marching
    // squares pass.  While dragging, the labels keep their last position and
    // the pass is skipped; pointer-up restores them on the full analysis.
    const lines = preview ? [] : traceContours(analysis, values, unique);
    this.legendState.isobar = lines.length > 0 || preview;
    // The base isobar is only a real synoptic divider when both a high and a
    // low are present. With a single system it is just the outer edge of the
    // compact support and used to produce a staircase; skip it in that case.
    const hasHigh = this.entities.some(
      (entity) => entity.type === 'coldHigh' || entity.type === 'warmHigh',
    );
    const hasLow = this.entities.some(
      (entity) => entity.type === 'coldLow' || entity.type === 'warmLow',
    );
    const drawBase = hasHigh && hasLow;
    const basePressure = this.level.base.P;
    const skipLevel = (level: number) =>
      !drawBase &&
      (highLayer ? Math.abs(level) < 0.01 : Math.abs(level - basePressure) < 0.01);
    const labelled = lines.filter(
      (line) => !skipLevel(line.level) && Math.abs(line.level % 4) < 0.01,
    );
    const curves = buildContourCurves(analysis, values, 2);
    for (const curve of curves) {
      if (curve.points.length < 2 || skipLevel(curve.level)) continue;
      if (curve.points.length < 5 && this.curveTouchesBorder(curve.points)) continue;
      const major = Math.abs(curve.level % 4) < 0.01;
      this.isobarGraphics.lineStyle(
        major ? 1.05 : 0.9,
        highLayer ? COLORS.highIsobar : COLORS.isobar,
        1,
      );
      this.strokeSmoothContour(curve.points);
    }
    if (preview) this.setIsobarLabelsVisible(false);
    else this.updateIsobarLabels(labelled, highLayer);
  }

  private setIsobarLabelsVisible(visible: boolean): void {
    for (const label of this.isobarLabels.values()) {
      if (label.visible !== visible) label.setVisible(visible);
    }
  }

  private curveTouchesBorder(points: Array<{ x: number; y: number }>): boolean {
    return points.some(
      (point) =>
        point.x <= 1 || point.y <= 1 || point.x >= MAP_SIZE - 1 || point.y >= MAP_SIZE - 1,
    );
  }

  private updateIsobarLabels(lines: IsobarLine[], highLayer = false): void {
    if (!this.level) return;
    const usedLevels = new Set<number>();
    const placed: Array<{ x: number; y: number }> = [];
    for (const city of this.level.cities) placed.push({ x: city.x, y: city.y });
    for (const entity of this.entities) placed.push({ x: entity.x, y: entity.y });

    for (const line of lines) {
      usedLevels.add(line.level);
      let best: { x: number; y: number; angle: number; score: number } | null = null;
      for (const segment of line.segments) {
        const x = (segment.x1 + segment.x2) / 2;
        const y = (segment.y1 + segment.y2) / 2;
        if (
          x < MAP_SIZE * 0.048 ||
          x > MAP_SIZE * 0.955 ||
          y < MAP_SIZE * 0.105 ||
          y > MAP_SIZE * 0.735
        ) {
          continue;
        }
        let minDistance = Number.POSITIVE_INFINITY;
        for (const point of placed) {
          minDistance = Math.min(minDistance, Math.hypot(point.x - x, point.y - y));
        }
        if (minDistance < 38) continue;
        const centerBias =
          Math.hypot(x - MAP_SIZE * 0.4, y - MAP_SIZE * 0.43) * 0.012;
        const score = minDistance - centerBias;
        if (!best || score > best.score) {
          let angle = Math.atan2(segment.y2 - segment.y1, segment.x2 - segment.x1);
          if (angle > Math.PI / 2) angle -= Math.PI;
          if (angle < -Math.PI / 2) angle += Math.PI;
          best = { x, y, angle, score };
        }
      }

      let label = this.isobarLabels.get(line.level);
      if (!best) {
        label?.setVisible(false);
        continue;
      }
      if (!label) {
        label = this.add
          .text(0, 0, '', {
            fontFamily: TEXT_FONT,
            fontSize: '11.5px',
            color: '#c4d0da',
            backgroundColor: 'rgba(8, 15, 22, 0.88)',
            padding: { left: 2, right: 2, top: 0, bottom: 0 },
          })
          .setOrigin(0.5)
          .setDepth(5.2)
          .setResolution(2);
        this.isobarLabels.set(line.level, label);
      }
      label
        .setText(`${highLayer && line.level > 0 ? '+' : ''}${Math.round(line.level)}`)
        .setPosition(best.x, best.y)
        .setRotation(best.angle)
        .setVisible(true);
      placed.push({ x: best.x, y: best.y });
    }

    for (const [level, label] of this.isobarLabels) {
      if (!usedLevels.has(level)) label.setVisible(false);
    }
  }

  private clearIsobarLabels(): void {
    for (const label of this.isobarLabels.values()) label.destroy();
    this.isobarLabels.clear();
  }

  private drawRainContours(grid: SampleGrid): void {
    this.rainContourGraphics.clear();
    let maxRain = 0;
    for (const value of grid.r) maxRain = Math.max(maxRain, value);
    const thresholds = [0.05, 0.35, 1.2, 3.5, 8, 15].filter((value) => value < maxRain);
    if (thresholds.length === 0) return;

    const rainLines = traceContours(grid, grid.r, thresholds);
    for (const line of rainLines) {
      const equivalent = line.level * 8;
      const color =
        equivalent < 10
          ? WEATHER_COLORS.rain
          : equivalent < 25
            ? WEATHER_COLORS.rainModerate
            : equivalent < 50
              ? WEATHER_COLORS.rainHeavy
              : equivalent < 100
                ? WEATHER_COLORS.rainStorm
                : WEATHER_COLORS.rainExtreme;
      const tint = (color[0] << 16) | (color[1] << 8) | color[2];
      this.rainContourGraphics.lineStyle(0.65, tint, 0.32);
      this.rainContourGraphics.beginPath();
      for (const segment of line.segments) {
        this.rainContourGraphics.moveTo(segment.x1, segment.y1);
        this.rainContourGraphics.lineTo(segment.x2, segment.y2);
      }
      this.rainContourGraphics.strokePath();
    }
  }

  private drawWind(grid: SampleGrid): void {
    this.windGraphics.clear();
    const n = grid.n;
    const highLayer = this.currentLayer !== 'low';
    const uValues = highLayer ? grid.uHigh : grid.uLow;
    const vValues = highLayer ? grid.vHigh : grid.vLow;
    const step = highLayer ? 5 : 6;
    const color = highLayer ? 0xa7c9dc : COLORS.wind;
    let drawn = 0;
    for (let j = 3; j < n - 1; j += step) {
      for (let i = 3; i < n - 1; i += step) {
        const index = j * n + i;
        const u = uValues[index];
        const v = vValues[index];
        const speed = Math.hypot(u, v);
        if (speed < 1.0) continue;
        const x = i * grid.spacing;
        const y = j * grid.spacing;
        const ux = u / speed;
        const uy = v / speed;
        const length = 11 + Math.min(12, speed * 0.45);
        const tailX = x - ux * length * 0.5;
        const tailY = y - uy * length * 0.5;
        const headX = x + ux * length * 0.5;
        const headY = y + uy * length * 0.5;
        this.windGraphics.lineStyle(0.9, color, 0.3 + Math.min(0.18, speed * 0.012));
        this.windGraphics.beginPath();
        this.windGraphics.moveTo(tailX, tailY);
        this.windGraphics.lineTo(headX, headY);
        this.windGraphics.strokePath();
        drawArrowHead(this.windGraphics, headX, headY, Math.atan2(uy, ux), 3.1, color, 0.36);
        drawn += 1;
      }
    }
    this.legendState.wind = drawn > 0;
  }

  private drawFronts(entities: WeatherEntity[], grid?: SampleGrid, baseT?: number): void {
    void grid;
    void baseT;
    const graphics = this.frontGraphics;
    graphics.clear();
    // The chart must show the front the station and the goal will report.
    // `frontAt` is that single diagnosis; the renderer only supplies geometry.
    const level = this.level;
    const diagnose = level
      ? (x: number, y: number) => {
          const diagnosis = frontAt(entities, level.base, x, y, windAt(entities, level.base, x, y));
          return diagnosis.type === 'none' ? null : diagnosis.type;
        }
      : undefined;
    const fronts = buildFrontVisuals(entities, diagnose);
    this.legendState.front = fronts.length > 0;
    const coldColor = 0x5f8fd7;
    const warmColor = 0xd7766a;
    const occludedColor = 0x9b7bd4;

    for (const front of fronts) {
      // The chart type must match the station/goal type. Both now use the
      // cold/warm strength difference (or the cyclone curve type); the old
      // local-wind override could draw a warm front while the station reported
      // a cold front and the goal failed.
      const displayType = front.type;

      if (displayType === 'stationary') {
        for (let i = 0; i < front.points.length - 1; i += 1) {
          const color = Math.floor(i / 4) % 2 === 0 ? coldColor : warmColor;
          graphics.lineStyle(1.4, color, 0.78);
          graphics.beginPath();
          graphics.moveTo(front.points[i].x, front.points[i].y);
          graphics.lineTo(front.points[i + 1].x, front.points[i + 1].y);
          graphics.strokePath();
        }
      } else {
        const color =
          displayType === 'cold'
            ? coldColor
            : displayType === 'warm'
              ? warmColor
              : occludedColor;
        graphics.lineStyle(1.55, color, 0.82);
        graphics.beginPath();
        graphics.moveTo(front.points[0].x, front.points[0].y);
        for (let i = 1; i < front.points.length; i += 1) {
          graphics.lineTo(front.points[i].x, front.points[i].y);
        }
        graphics.strokePath();
      }

      let index = front.cyclone ? 7 : 6;
      let gap = front.cyclone ? 5 : 8;
      let count = 0;
      while (index < front.points.length - 2) {
        const point = front.points[index];
        const tangentX = Math.cos(point.tangent);
        const tangentY = Math.sin(point.tangent);
        const drawTriangle =
          displayType === 'cold' ||
          (displayType === 'stationary' && count % 2 === 0) ||
          (displayType === 'occluded' && count % 2 === 0);
        const color =
          displayType === 'occluded'
            ? occludedColor
            : drawTriangle
              ? coldColor
              : warmColor;
        graphics.fillStyle(color, 0.92);
        graphics.lineStyle(0.7, 0x07111a, 0.85);

        if (drawTriangle) {
          graphics.fillTriangle(
            point.x + tangentX * 4.8,
            point.y + tangentY * 4.8,
            point.x - tangentX * 4.8,
            point.y - tangentY * 4.8,
            point.x + front.axisX * 9,
            point.y + front.axisY * 9,
          );
          graphics.strokeTriangle(
            point.x + tangentX * 4.8,
            point.y + tangentY * 4.8,
            point.x - tangentX * 4.8,
            point.y - tangentY * 4.8,
            point.x + front.axisX * 9,
            point.y + front.axisY * 9,
          );
        } else {
          const arcPoints: Array<{ x: number; y: number }> = [];
          const radius = 6;
          for (let step = 0; step <= 12; step += 1) {
            const theta = (step / 12) * Math.PI;
            arcPoints.push({
              x: point.x + tangentX * Math.cos(theta) * radius - front.axisX * Math.sin(theta) * radius,
              y: point.y + tangentY * Math.cos(theta) * radius - front.axisY * Math.sin(theta) * radius,
            });
          }
          graphics.beginPath();
          graphics.moveTo(arcPoints[0].x, arcPoints[0].y);
          for (let pointIndex = 1; pointIndex < arcPoints.length; pointIndex += 1) {
            graphics.lineTo(arcPoints[pointIndex].x, arcPoints[pointIndex].y);
          }
          graphics.closePath();
          graphics.fillPath();
          graphics.strokePath();
        }
        index += gap;
        if (front.cyclone) gap = Math.min(15, gap + 1);
        count += 1;
      }
    }
  }

  private paintRain(grid: SampleGrid): void {
    const context = this.rainTexture.context;
    paintRainLayer(context, grid, RAIN_TEXTURE_SIZE, RAIN_TEXTURE_SIZE);
    this.rainTexture.refresh();
    if (!this.run) this.rainImage.setAlpha(1);
  }

  private drawEntities(entities: WeatherEntity[]): void {
    const current = entities.filter((entity) => entity.layer === this.currentLayer);
    const others = entities.filter((entity) => entity.layer !== this.currentLayer);
    const currentVisuals = this.buildEntityVisuals(current);
    const otherVisuals = this.buildEntityVisuals(others);
    this.entityVisuals = new Map([...currentVisuals, ...otherVisuals]);

    this.entityGraphics.clear();
    this.otherEntityGraphics.clear();
    this.drawEntitySet(this.entityGraphics, current, currentVisuals);
    this.drawEntitySet(this.otherEntityGraphics, others, otherVisuals);
    this.updateEntityLabels(entities, this.entityVisuals);
    this.drawIsobarAxes();
  }

  private drawIsobarAxes(): void {
    this.shapeFeatureGraphics.clear();
    const active = new Set<string>();
    if (this.currentLayer !== 'low' || !this.level) {
      for (const label of this.shapeFeatureLabels.values()) label.setVisible(false);
      return;
    }

    const analysis = this.pressureAnalysis(false);
    const axes: Array<{
      kind: 'ridge' | 'trough';
      entityId: string;
      points: Array<{ x: number; y: number }>;
    }> = [];
    for (const entity of this.entities) {
      if (
        entity.type !== 'coldHigh' &&
        entity.type !== 'warmHigh' &&
        entity.type !== 'coldLow' &&
        entity.type !== 'warmLow'
      ) {
        continue;
      }
      const axis = tracePressureAxis(analysis, entity, this.level.base.P);
      if (axis) axes.push({ ...axis, entityId: entity.id });
    }
    this.legendState.features = axes.length > 0;
    const dash = (points: Array<{ x: number; y: number }>, color: number) => {
      const dashLength = 9;
      const gap = 6;
      let phase = 0;
      this.shapeFeatureGraphics.lineStyle(1, color, 0.38);
      for (let k = 1; k < points.length; k += 1) {
        const a = points[k - 1];
        const b = points[k];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const segment = Math.hypot(dx, dy);
        if (segment < 0.01) continue;
        let cursor = 0;
        while (cursor < segment) {
          const inDash = phase < dashLength;
          const remaining = inDash ? dashLength - phase : dashLength + gap - phase;
          const step = Math.min(remaining, segment - cursor);
          if (inDash) {
            const t0 = cursor / segment;
            const t1 = (cursor + step) / segment;
            this.shapeFeatureGraphics.lineBetween(
              a.x + dx * t0,
              a.y + dy * t0,
              a.x + dx * t1,
              a.y + dy * t1,
            );
          }
          cursor += step;
          phase = (phase + step) % (dashLength + gap);
        }
      }
    };

    axes.forEach((axis, index) => {
      const color = axis.kind === 'trough' ? 0x6bb7d6 : 0xd9a16b;
      dash(axis.points, color);
      const anchor = axis.points[axis.points.length - 1];
      const previous = axis.points[axis.points.length - 2] ?? axis.points[0];
      const tangentX = anchor.x - previous.x;
      const tangentY = anchor.y - previous.y;
      const tangentLength = Math.hypot(tangentX, tangentY) || 1;
      const normalX = -tangentY / tangentLength;
      const normalY = tangentX / tangentLength;
      const key = `isobar-axis-${axis.entityId}-${index}`;
      active.add(key);
      const labelX = Math.max(72, Math.min(688, anchor.x + normalX * 12));
      const labelY = Math.max(114, Math.min(698, anchor.y + normalY * 12));
      let label = this.shapeFeatureLabels.get(key);
      if (!label) {
        label = this.add
          .text(0, 0, '', {
            fontFamily: SANS_FONT,
            fontSize: '9.5px',
            color: '#d9edf2',
            backgroundColor: 'rgba(7, 15, 21, 0.82)',
            padding: { left: 3, right: 3, top: 1, bottom: 1 },
          })
          .setOrigin(0.5)
          .setDepth(8.2)
          .setResolution(2);
        this.shapeFeatureLabels.set(key, label);
      }
      label
        .setText(axis.kind === 'trough' ? '槽' : '脊')
        .setPosition(labelX, labelY)
        .setColor(axis.kind === 'trough' ? '#8ed4ea' : '#e6b17a')
        .setAlpha(0.62)
        .setVisible(true);
    });

    for (const [id, label] of this.shapeFeatureLabels) {
      if (!active.has(id)) label.setVisible(false);
    }
  }

  private drawEntitySet(
    graphics: Phaser.GameObjects.Graphics,
    entities: WeatherEntity[],
    visuals: Map<string, EntityVisual>,
  ): void {
    for (const entity of entities) {
      // Locked surface sources are part of the background field (their moisture
      // is derived from SST), not objects the player sees on the chart.
      if (entity.type === 'wet' && entity.locked) continue;
      const selected = entity.id === this.selectedEntityId && entity.layer === this.currentLayer;
      const color = this.entityColor(entity);
      if (selected) this.drawInfluenceArea(graphics, entity, selected, color);

      const visual = visuals.get(entity.id);
      if (!visual) continue;

      if (visual.primary) {
        if (entity.type === 'typhoon') {
          this.drawTyphoonSystem(graphics, entity, selected, visual.x, visual.y, color);
        } else if (
          entity.type === 'coldHigh' ||
          entity.type === 'warmHigh' ||
          entity.type === 'coldLow' ||
          entity.type === 'warmLow'
        ) {
          this.drawPressureSystem(graphics, entity, selected, visual.x, visual.y, color);
        } else if (entity.type === 'wet') {
          this.drawMoistureSystem(graphics, entity, selected, visual.x, visual.y);
        } else if (entity.type === 'trough' || entity.type === 'ridge' || entity.type === 'inversion' || entity.type === 'jet') {
          this.drawUpperSystem(graphics, entity, selected, visual.x, visual.y, color);
        } else {
          this.drawAirMass(graphics, entity, selected, visual.x, visual.y);
        }
      } else {
        this.drawMiniSystem(graphics, selected, visual.x, visual.y, color);
      }

      if (entity.type === 'wet' && !this.running) {
        this.drawDriftArrow(graphics, entity);
      }

      if (selected) {
        graphics.lineStyle(0.8, COLORS.target, 0.42);
        graphics.strokeCircle(visual.x, visual.y, visual.primary ? 28 : 16);
        drawCross(graphics, visual.x, visual.y - (visual.primary ? 35 : 20), 3, COLORS.target, 0.55);
      }
    }
  }

  private drawInfluenceArea(
    graphics: Phaser.GameObjects.Graphics,
    entity: WeatherEntity,
    selected: boolean,
    color: number,
  ): void {
    const outer: Array<{ x: number; y: number }> = [];
    const inner: Array<{ x: number; y: number }> = [];
    const segments = 72;
    for (let i = 0; i < segments; i += 1) {
      const angle = (i / segments) * Math.PI * 2;
      outer.push(influenceBoundaryPoint(entity, angle, 1));
      inner.push(influenceBoundaryPoint(entity, angle, 0.58));
    }

    pathFromPoints(graphics, smoothClosedPoints(outer, 2), true);
    graphics.fillStyle(color, selected ? 0.035 : 0.013);
    graphics.fillPath();
    graphics.lineStyle(selected ? 1.15 : 0.7, color, selected ? 0.45 : 0.19);
    graphics.strokePath();

    pathFromPoints(graphics, smoothClosedPoints(inner, 2), true);
    graphics.fillStyle(color, selected ? 0.04 : 0.015);
    graphics.fillPath();
    graphics.lineStyle(0.55, color, selected ? 0.24 : 0.08);
    graphics.strokePath();
  }

  private entityColor(entity: WeatherEntity): number {
    return ENTITY_META[entity.type].color;
  }

  private entityColorCss(entity: WeatherEntity): string {
    return ENTITY_META[entity.type].cssColor;
  }

  private buildEntityVisuals(entities: WeatherEntity[]): Map<string, EntityVisual> {
    const visuals = new Map<string, EntityVisual>();
    const visited = new Set<string>();
    const priority: Record<WeatherEntity['type'], number> = {
      typhoon: 0,
      coldHigh: 1,
      warmHigh: 2,
      coldLow: 3,
      warmLow: 4,
      coldAir: 5,
      warmAir: 6,
      wet: 7,
      trough: 8,
      ridge: 9,
      inversion: 10,
      jet: 11,
    };

    for (const entity of entities) {
      if (visited.has(entity.id)) continue;
      const group = entities.filter(
        (other) =>
          !visited.has(other.id) &&
          Math.hypot(other.x - entity.x, other.y - entity.y) <= 34,
      );
      for (const member of group) visited.add(member.id);
      group.sort((a, b) => priority[a.type] - priority[b.type]);

      const nearestCity = this.level?.cities
        .map((city) => ({
          city,
          distance: Math.hypot(city.x - entity.x, city.y - entity.y),
        }))
        .sort((a, b) => a.distance - b.distance)[0];
      const side =
        nearestCity && nearestCity.distance < 58 && nearestCity.city.labelSide === 'right'
          ? -1
          : 1;

      const caption = group
        .map((member) => this.entityCaptionToken(member))
        .join(' · ');

      group.forEach((member, index) => {
        if (index === 0) {
          visuals.set(member.id, {
            x: member.x,
            y: member.y,
            scale: 1,
            primary: true,
            groupSize: group.length,
            caption,
          });
          return;
        }

        const angle =
          side > 0
            ? -0.32 + (index - 1) * 0.78
            : Math.PI + 0.32 - (index - 1) * 0.78;
        const radius = 30;
        visuals.set(member.id, {
          x: member.x + Math.cos(angle) * radius,
          y: member.y + Math.sin(angle) * radius * 0.92,
          scale: 0.56,
          primary: false,
          groupSize: group.length,
          caption,
        });
      });
    }

    return visuals;
  }

  private drawPressureSystem(
    graphics: Phaser.GameObjects.Graphics,
    entity: WeatherEntity,
    selected: boolean,
    px: number,
    py: number,
    color: number,
  ): void {
    const isHigh = entity.type === 'coldHigh' || entity.type === 'warmHigh';
    const strongLow = !isHigh && Math.abs(entity.strength) >= 20;

    if (strongLow) {
      const top = py - 36;
      const left = px - 31;
      const right = px + 31;
      const bottom = py + 24;
      graphics.fillStyle(color, 0.045);
      graphics.fillTriangle(px, top, left, bottom, right, bottom);
      graphics.lineStyle(0.9, color, 0.25);
      graphics.strokeTriangle(px, top, left, bottom, right, bottom);

      graphics.fillStyle(0x0a121a, 0.94);
      graphics.fillTriangle(px, py - 23, px - 23, py + 18, px + 23, py + 18);
      graphics.lineStyle(selected ? 1.6 : 1.1, color, selected ? 1 : 0.82);
      graphics.strokeTriangle(px, py - 23, px - 23, py + 18, px + 23, py + 18);
    } else {
      graphics.fillStyle(color, 0.026);
      graphics.fillCircle(px, py, 31);
      graphics.fillStyle(color, 0.035);
      graphics.fillCircle(px, py, 23);

      graphics.fillStyle(0x0a121a, 0.92);
      graphics.fillCircle(px, py, 20);
      graphics.lineStyle(selected ? 1.6 : 1.1, color, selected ? 1 : 0.78);
      graphics.strokeCircle(px, py, 20);

      graphics.lineStyle(1, color, 0.46);
      graphics.beginPath();
      graphics.arc(px, py, 25, -Math.PI * 0.82, -Math.PI * 0.18, false);
      graphics.strokePath();
    }

    const arrowX = px + 15;
    const arrowY = py - 5;
    const direction = isHigh ? 1 : -1;
    graphics.lineStyle(1, color, 0.7);
    graphics.beginPath();
    graphics.moveTo(arrowX, arrowY);
    graphics.lineTo(arrowX, arrowY + 10 * direction);
    graphics.strokePath();
    drawArrowHead(
      graphics,
      arrowX,
      arrowY + 10 * direction,
      direction > 0 ? Math.PI / 2 : -Math.PI / 2,
      3.5,
      color,
      0.75,
    );
  }

  private drawTyphoonSystem(
    graphics: Phaser.GameObjects.Graphics,
    _entity: WeatherEntity,
    selected: boolean,
    px: number,
    py: number,
    color: number,
  ): void {
    const radius = 34;
    graphics.fillStyle(color, 0.035);
    graphics.fillCircle(px, py, radius + 7);
    graphics.lineStyle(0.8, color, 0.2);
    graphics.strokeCircle(px, py, radius);

    // Two logarithmic spiral bands.
    for (let arm = 0; arm < 2; arm += 1) {
      graphics.lineStyle(1.15, color, 0.62);
      graphics.beginPath();
      for (let step = 0; step <= 30; step += 1) {
        const t = step / 30;
        const angle = arm * Math.PI + t * Math.PI * 1.65;
        const r = 9 + t * (radius - 9);
        const x = px + Math.cos(angle) * r;
        const y = py + Math.sin(angle) * r * 0.92;
        if (step === 0) graphics.moveTo(x, y);
        else graphics.lineTo(x, y);
      }
      graphics.strokePath();
    }

    // Eyewall ring.
    graphics.lineStyle(selected ? 1.5 : 1.1, color, selected ? 0.95 : 0.75);
    graphics.strokeCircle(px, py, radius * 0.42);
    graphics.fillStyle(0x08111a, 0.92);
    graphics.fillCircle(px, py, 6);
    graphics.lineStyle(0.9, color, 0.9);
    graphics.strokeCircle(px, py, 6);
    graphics.fillStyle(color, 0.95);
    graphics.fillCircle(px, py, 1.7);
  }

  private drawMoistureSystem(
    graphics: Phaser.GameObjects.Graphics,
    entity: WeatherEntity,
    selected: boolean,
    px: number,
    py: number,
  ): void {
    const meta = ENTITY_META.wet;

    graphics.fillStyle(meta.color, 0.022);
    graphics.fillCircle(px, py, 30);
    graphics.fillStyle(0x071319, 0.82);
    graphics.fillCircle(px, py, 19);
    graphics.lineStyle(selected ? 1.5 : 1, meta.color, selected ? 0.95 : 0.72);
    graphics.strokeCircle(px, py, 19);

    if (entity.locked) {
      // A locked blob is a surface source, not a floating moisture patch:
      // upward arrows say "evaporation from this surface", matching the
      // water-budget ledger and the dashed source patch underneath.
      graphics.lineStyle(1, meta.color, 0.7);
      for (let i = -1; i <= 1; i += 1) {
        const x = px + i * 8;
        graphics.beginPath();
        graphics.moveTo(x, py + 7);
        graphics.lineTo(x, py - 7);
        graphics.strokePath();
        drawArrowHead(graphics, x, py - 7, -Math.PI / 2, 3.2, meta.color, 0.8);
      }
      return;
    }

    graphics.lineStyle(0.9, meta.color, 0.55);
    for (let i = -1; i <= 1; i += 1) {
      graphics.beginPath();
      graphics.moveTo(px - 8, py + 5 + i * 4);
      graphics.lineTo(px + 7, py + 3 + i * 4);
      graphics.strokePath();
    }
  }

  private drawDriftArrow(
    graphics: Phaser.GameObjects.Graphics,
    entity: WeatherEntity,
  ): void {
    if (!this.level) return;
    const wind = windAt(this.entities, this.level.base, entity.x, entity.y);
    if (wind.speed <= 0.4) return;
    const dx = wind.x / wind.speed;
    const dy = wind.y / wind.speed;
    const startX = entity.x + dx * 31;
    const startY = entity.y + dy * 31;
    const endX = entity.x + dx * 55;
    const endY = entity.y + dy * 55;
    drawDashedLine(graphics, startX, startY, endX, endY, ENTITY_META.wet.color, 0.5, 3, 3, 0.9);
    drawArrowHead(
      graphics,
      endX,
      endY,
      Math.atan2(dy, dx),
      4,
      ENTITY_META.wet.color,
      0.55,
    );
  }

  private drawMiniSystem(
    graphics: Phaser.GameObjects.Graphics,
    selected: boolean,
    px: number,
    py: number,
    color: number,
  ): void {
    graphics.fillStyle(0x08121a, 0.92);
    graphics.fillCircle(px, py, 11.5);
    graphics.lineStyle(selected ? 1.5 : 1, color, selected ? 1 : 0.72);
    graphics.strokeCircle(px, py, 11.5);
    graphics.lineStyle(0.7, color, 0.35);
    graphics.strokeCircle(px, py, 15);
  }

  private drawAirMass(
    graphics: Phaser.GameObjects.Graphics,
    entity: WeatherEntity,
    selected: boolean,
    px: number,
    py: number,
  ): void {
    const meta = ENTITY_META[entity.type];
    const isCold = entity.type === 'coldAir';

    graphics.fillStyle(meta.color, 0.028);
    graphics.fillCircle(px, py, 28);
    graphics.fillStyle(0x09131c, 0.86);
    graphics.fillCircle(px, py, 18);
    graphics.lineStyle(selected ? 1.5 : 1, meta.color, selected ? 0.95 : 0.68);
    graphics.strokeCircle(px, py, 18);

    if (isCold) {
      graphics.lineStyle(1, meta.color, 0.78);
      graphics.beginPath();
      graphics.moveTo(px, py - 9);
      graphics.lineTo(px + 8, py + 6);
      graphics.lineTo(px - 8, py + 6);
      graphics.closePath();
      graphics.strokePath();
    } else {
      graphics.lineStyle(1, meta.color, 0.78);
      graphics.beginPath();
      graphics.arc(px, py + 4, 9, Math.PI, 0, false);
      graphics.strokePath();
      graphics.beginPath();
      graphics.moveTo(px - 9, py + 4);
      graphics.lineTo(px + 9, py + 4);
      graphics.strokePath();
    }
  }

  private drawUpperSystem(
    graphics: Phaser.GameObjects.Graphics,
    entity: WeatherEntity,
    selected: boolean,
    px: number,
    py: number,
    color: number,
  ): void {
    const elongated = entity.type === 'trough' || entity.type === 'ridge';
    graphics.fillStyle(color, 0.035);
    if (elongated) {
      graphics.fillRoundedRect(px - 30, py - 13, 60, 26, 13);
      graphics.fillStyle(0x09131c, 0.9);
      graphics.fillRoundedRect(px - 23, py - 8, 46, 16, 8);
      graphics.lineStyle(selected ? 1.5 : 1, color, selected ? 0.95 : 0.72);
      graphics.strokeRoundedRect(px - 23, py - 8, 46, 16, 8);
    } else {
      graphics.fillCircle(px, py, 26);
      graphics.fillStyle(0x09131c, 0.9);
      graphics.fillCircle(px, py, 17);
      graphics.lineStyle(selected ? 1.5 : 1, color, selected ? 0.95 : 0.72);
      graphics.strokeCircle(px, py, 17);
    }

    if (entity.type === 'trough') {
      graphics.lineStyle(1.1, color, 0.82);
      graphics.beginPath();
      graphics.moveTo(px - 11, py - 5);
      graphics.lineTo(px - 3, py + 7);
      graphics.lineTo(px + 3, py - 3);
      graphics.lineTo(px + 11, py - 8);
      graphics.strokePath();
    } else if (entity.type === 'inversion') {
      graphics.lineStyle(0.9, color, 0.72);
      graphics.beginPath();
      graphics.moveTo(px - 10, py - 5);
      graphics.lineTo(px + 10, py - 5);
      graphics.moveTo(px - 10, py + 1);
      graphics.lineTo(px + 10, py + 1);
      graphics.moveTo(px - 10, py + 7);
      graphics.lineTo(px + 10, py + 7);
      graphics.strokePath();
    } else if (entity.type === 'ridge') {
      graphics.lineStyle(1.1, color, 0.82);
      graphics.beginPath();
      graphics.moveTo(px - 11, py + 7);
      graphics.lineTo(px - 4, py - 5);
      graphics.lineTo(px + 3, py + 3);
      graphics.lineTo(px + 11, py - 8);
      graphics.strokePath();
    } else {
      // Jet: draw the steering axis so the player can see where it points.
      const angle = entity.angle ?? 0.27;
      const half = 30;
      const dx = Math.cos(angle) * half;
      const dy = Math.sin(angle) * half;
      const nx = -Math.sin(angle) * 6;
      const ny = Math.cos(angle) * 6;
      graphics.lineStyle(1.1, color, 0.82);
      graphics.beginPath();
      graphics.moveTo(px - dx, py - dy);
      graphics.lineTo(px + dx, py + dy);
      graphics.moveTo(px - dx * 0.35 + nx, py - dy * 0.35 + ny);
      graphics.lineTo(px + dx * 0.65 + nx, py + dy * 0.65 + ny);
      graphics.strokePath();
      drawArrowHead(graphics, px + dx, py + dy, angle, 4.2, color, 0.9);
      drawArrowHead(graphics, px + dx * 0.65 + nx, py + dy * 0.65 + ny, angle, 3.4, color, 0.65);
    }
  }

  private updateEntityLabels(
    entities: WeatherEntity[],
    visuals: Map<string, EntityVisual>,
  ): void {
    const alive = new Set<string>();

    for (const entity of entities) {
      const visual = visuals.get(entity.id);
      if (!visual) continue;
      // Background sources have no on-map label.
      if (entity.type === 'wet' && entity.locked) continue;
      alive.add(entity.id);
      let labels = this.entityLabels.get(entity.id);
      if (!labels) {
        const glyph = this.add
          .text(0, 0, '', {
            fontFamily: TEXT_FONT,
            fontSize: '20px',
            fontStyle: 'bold',
            color: '#ffffff',
            stroke: '#050a0e',
            strokeThickness: 3,
          })
          .setOrigin(0.5)
          .setDepth(13)
          .setResolution(2);
        const value = this.add
          .text(0, 0, '', {
            fontFamily: TEXT_FONT,
            fontSize: '9.5px',
            color: '#a8becb',
            backgroundColor: 'rgba(7, 13, 19, 0.72)',
            stroke: '#050a0e',
            strokeThickness: 2,
            padding: { left: 3, right: 3, top: 1, bottom: 1 },
          })
          .setOrigin(0.5)
          .setDepth(13)
          .setResolution(2);
        labels = { glyph, value };
        this.entityLabels.set(entity.id, labels);
      }

      const meta = ENTITY_META[entity.type];
      const isSource = entity.type === 'wet' && entity.locked;
      const isCjk = !(
        entity.type === 'coldHigh' ||
        entity.type === 'warmHigh' ||
        entity.type === 'coldLow' ||
        entity.type === 'warmLow'
      );
      const layerAlpha = entity.layer === this.currentLayer ? 1 : 0.3;
      labels.glyph
        .setAlpha(layerAlpha)
        .setText(isSource ? '源' : meta.glyph)
        .setColor(this.entityColorCss(entity))
        .setFontFamily(isCjk ? SANS_FONT : TEXT_FONT)
        .setFontSize(visual.primary ? (isCjk ? 12 : 20) : isCjk ? 9.5 : 10.5)
        .setPosition(visual.x, visual.y - (isCjk ? 1 : 2));
      labels.value
        .setAlpha(layerAlpha)
        .setText(
          visual.primary
            ? visual.groupSize > 1
              ? visual.caption
              : isSource && this.level
                ? `${sampleSurface(this.level.base, entity.x, entity.y).land ? '湿地' : '海面'}蒸发`
                : `${this.entityValueLabel(entity)}${entity.locked ? ' 锁' : ''}`
            : '',
        )
        .setColor(entity.locked ? '#9aa59f' : '#b4c7d2')
        .setFontSize(visual.groupSize > 1 ? 9 : 9.5)
        .setPosition(visual.x, visual.y + (visual.groupSize > 1 ? 39 : 33))
        .setVisible(visual.primary);
    }

    for (const [id, labels] of this.entityLabels) {
      if (!alive.has(id)) {
        labels.glyph.destroy();
        labels.value.destroy();
        this.entityLabels.delete(id);
      }
    }
  }

  private entityCaptionToken(entity: WeatherEntity): string {
    const meta = ENTITY_META[entity.type];
    const strength = this.entityValueLabel(entity).replace(' ', '');
    return `${meta.glyph}${strength}`;
  }

  private entityValueLabel(entity: WeatherEntity): string {
    switch (entity.type) {
      case 'coldHigh':
      case 'warmHigh':
        return `+${entity.strength} hPa`;
      case 'coldLow':
      case 'warmLow':
        return `−${entity.strength} hPa`;
      case 'typhoon':
        return `−${entity.strength} hPa · ${typhoonCategoryLabel(entity.strength)}`;
      case 'coldAir':
        return `−${entity.strength}°C`;
      case 'warmAir':
        return `+${entity.strength}°C`;
      case 'wet':
        return `+${entity.strength} g/m³`;
      case 'trough':
        return `${['', '弱', '中', '强'][entity.strength] ?? entity.strength}槽`;
      case 'inversion':
        return entity.inversionMode === 'stable' ? '上暖下冷' : '上冷下暖';
      case 'ridge':
        return `${['', '弱', '中', '强'][entity.strength] ?? entity.strength}脊`;
      case 'jet':
        return `${['', '弱', '中', '强'][entity.strength] ?? entity.strength}急流`;
    }
  }

  private createCityLabels(): void {
    if (!this.level) return;
    this.cityLabels.clear();

    for (const city of this.level.cities) {
      const left = city.labelSide === 'left';
      const name = this.add
        .text(left ? city.x - 15 : city.x + 16, city.y - 8, city.name, {
          fontFamily: TEXT_FONT,
          fontSize: '10.5px',
          fontStyle: '500',
          color: '#dfe7eb',
          stroke: '#060b0f',
          strokeThickness: 3,
        })
        .setOrigin(left ? 1 : 0, 0.5)
        .setDepth(12)
        .setResolution(2);
      const data = this.add
        .text(left ? city.x - 24 : city.x + 29, city.y + 10, '', {
          fontFamily: TEXT_FONT,
          fontSize: '10.5px',
          color: '#a0b4c1',
          backgroundColor: 'rgba(7, 13, 19, 0.62)',
          stroke: '#060b0f',
          strokeThickness: 2,
          padding: { left: 2, right: 2, top: 0, bottom: 0 },
        })
        .setOrigin(left ? 1 : 0, 0.5)
        .setDepth(12)
        .setResolution(2);
      this.cityLabels.set(city.id, { name, data });
    }
  }

  private drawCities(snapshot: SimulationSnapshot): void {
    if (!this.level) return;
    const graphics = this.cityGraphics;
    graphics.clear();

    for (const city of this.level.cities) {
      const weather = snapshot.cities[city.id];
      const selected = city.id === this.selectedCityId;
      const isTarget = this.targetCityIds().includes(city.id);

      graphics.lineStyle(0.8, 0x94a3b8, 0.58);
      graphics.strokeCircle(city.x, city.y, 6.8);
      graphics.lineStyle(0.7, COLORS.city, 0.72);
      graphics.strokeCircle(city.x, city.y, 3.9);
      graphics.fillStyle(COLORS.city, 0.96);
      graphics.fillCircle(city.x, city.y, 1.8);
      graphics.lineStyle(0.65, 0x94a3b8, 0.38);
      graphics.beginPath();
      graphics.moveTo(city.x - 12, city.y);
      graphics.lineTo(city.x - 8, city.y);
      graphics.moveTo(city.x + 8, city.y);
      graphics.lineTo(city.x + 12, city.y);
      graphics.moveTo(city.x, city.y - 12);
      graphics.lineTo(city.x, city.y - 8);
      graphics.moveTo(city.x, city.y + 8);
      graphics.lineTo(city.x, city.y + 12);
      graphics.strokePath();

      if (selected) {
        graphics.lineStyle(0.8, COLORS.target, 0.62);
        graphics.strokeCircle(city.x, city.y, 14);
      }

      if (isTarget) {
        graphics.lineStyle(0.8, COLORS.target, 0.3);
        graphics.beginPath();
        graphics.arc(city.x, city.y, 20, -Math.PI * 0.85, -Math.PI * 0.15, false);
        graphics.strokePath();
      }

      const label = this.cityLabels.get(city.id);
      if (label && weather) {
        if (this.currentLayer === 'high') {
          label.data.setText(
            `高层 P ${weather.pHigh >= 0 ? '+' : ''}${weather.pHigh.toFixed(1)}  ·  W ${weather.wHigh >= 0 ? '+' : ''}${weather.wHigh.toFixed(2)}`,
          );
        } else {
          const temperature = `${weather.T.toFixed(1)}°C`;
          const rain = weather.R >= 0.01 ? `R ${weather.R.toFixed(1)}` : 'R 0.0';
          label.data.setText(`${temperature}  ·  ${rain}`);
        }
        label.name.setColor(selected ? '#f3fafb' : '#d5dde2');
        label.data.setColor(
          this.currentLayer === 'high'
            ? selected
              ? '#a7d1e0'
              : '#9fb1b8'
            : weather.R >= 0.05
              ? '#91c7b9'
              : selected
                ? '#aebdc2'
                : '#9aa9b0',
        );
      }
    }

    // Draw a soft precipitation halo around a raining city.
    for (const city of this.level.cities) {
      const weather = snapshot.cities[city.id];
      if (!weather || weather.R < 0.02 || this.currentLayer !== 'low') continue;
      graphics.fillStyle(0x72c8b2, 0.018);
      graphics.fillCircle(city.x, city.y, 22);
    }
  }

  private drawTerrain(): void {
    if (!this.level?.hasTerrain) {
      this.terrainGraphics.clear();
      this.terrainImage.setAlpha(0);
      return;
    }
    const profile = this.level.base.terrainProfile;
    if (profile && REAL_TERRAIN[profile]) {
      this.terrainGraphics.clear();
      this.paintRealTerrain(profile);
      return;
    }
    this.terrainImage.setAlpha(0);
    drawTerrainRelief(this.terrainGraphics);
  }

  private createMapLabels(): void {
    if (!this.level) return;
    // Three latitude ticks at 20 / 50 / 80 % of the chart height, so the
    // labels always span the map instead of bunching in its upper half.
    const positions = [MAP_SIZE * 0.2, MAP_SIZE * 0.5, MAP_SIZE * 0.8];
    for (const y of positions) {
      const text = this.add
        .text(17, y, '', {
          fontFamily: TEXT_FONT,
          fontSize: '9px',
          color: '#8a9a9d',
        })
        .setOrigin(0, 0.5)
        .setDepth(1.4)
        .setResolution(2);
      this.coordinateLabels.push(text);
    }
    const meridian = this.add
      .text(MAP_SIZE * 0.625, MAP_SIZE * 0.786, '东经 120°', {
        fontFamily: TEXT_FONT,
        fontSize: '9px',
        color: '#7b8d91',
      })
      .setOrigin(0, 0.5)
      .setDepth(1.4)
      .setResolution(2);
    this.coordinateLabels.push(meridian);
    this.updateCoordinateLabels();
  }

  private updateCoordinateLabels(): void {
    if (!this.level) return;
    const { latitude, hemisphere } = this.level.base;
    const suffix = hemisphere === 'N' ? 'N' : 'S';
    // A chart covers domainKm / 111 degrees of latitude; the ticks sit at
    // 20/50/80 %, i.e. +/-30 % of that span from the centre.
    const domainKm =
      this.level.base.domainScale ?? MAP_SIZE * MAP_KM_PER_PX;
    const halfSpan = (domainKm / 111) * 0.3;
    const values = [
      Math.min(89, Math.round(latitude + halfSpan)),
      latitude,
      Math.max(1, Math.round(latitude - halfSpan)),
    ];
    this.coordinateLabels.forEach((label, index) => {
      if (index < 3) label.setText(`${suffix === 'N' ? '北纬' : '南纬'} ${values[index]}°`);
    });
  }

  public refreshHemisphere(): void {
    this.updateCoordinateLabels();
  }

  private targetCityIds(): string[] {
    if (!this.level) return [];
    const target = this.level.target;
    if (
      target.kind === 'multi' ||
      target.kind === 'persistent' ||
      target.kind === 'persistentRain' ||
      target.kind === 'accumulatedRain' ||
      target.kind === 'sequence' ||
      target.kind === 'window'
    ) {
      return [
        ...new Set(
          target.conditions
            .filter((condition) => condition.kind !== 'advect')
            .map((condition) => condition.cityId),
        ),
      ];
    }
    return [target.cityId];
  }

  private drawTargets(): void {
    if (!this.level) return;
    const graphics = this.targetGraphics;
    graphics.clear();

    const targetIds = this.targetCityIds();
    const targetCities = this.level.cities.filter((city) => targetIds.includes(city.id));
    if (targetCities.length === 0) return;

    const target = this.level.target;
    const advectTarget =
      target.kind === 'advect'
        ? this.level.cities.find((city) => city.id === target.cityId)
        : undefined;
    const advectRadius = target.kind === 'advect' ? (target.maxDistance ?? 72) : 0;
    if (advectTarget && target.kind === 'advect') {
      graphics.lineStyle(0.8, COLORS.target, 0.42);
      const dashCount = 40;
      const step = (Math.PI * 2) / dashCount;
      for (let i = 0; i < dashCount; i += 1) {
        graphics.beginPath();
        graphics.arc(advectTarget.x, advectTarget.y, advectRadius, i * step, i * step + step * 0.48, false);
        graphics.strokePath();
      }
      graphics.fillStyle(COLORS.target, 0.02);
      graphics.fillCircle(advectTarget.x, advectTarget.y, advectRadius);
    }

    for (const targetCity of targetCities) {
      const gap = this.level.target.kind === 'advect' ? 26 : 43;
      const bracket = 10;
      graphics.lineStyle(1, COLORS.target, 0.55);
      for (const [sx, sy] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ]) {
        const x = targetCity.x + sx * gap;
        const y = targetCity.y + sy * gap;
        graphics.beginPath();
        graphics.moveTo(x, y + sy * -bracket);
        graphics.lineTo(x, y);
        graphics.lineTo(x + sx * -bracket, y);
        graphics.strokePath();
      }
    }

    if (advectTarget && target.kind === 'advect') {
      const label = this.add
        .text(advectTarget.x, advectTarget.y + advectRadius + 14, '目标区', {
          fontFamily: TEXT_FONT,
          fontSize: '8px',
          color: '#8fc2cb',
          stroke: '#060b0f',
          strokeThickness: 3,
          letterSpacing: 1,
        })
        .setOrigin(0.5)
        .setDepth(11)
        .setResolution(2);
      this.staticTexts.push(label);
    }

    if (this.level.guide) {
      const guide = this.level.guide;
      drawDashedLine(
        graphics,
        guide.from.x,
        guide.from.y,
        guide.to.x,
        guide.to.y,
        COLORS.target,
        0.3,
        8,
        7,
        1,
      );
      const angle = Math.atan2(guide.to.y - guide.from.y, guide.to.x - guide.from.x);
      drawArrowHead(graphics, guide.to.x, guide.to.y, angle, 9, COLORS.target, 0.42);

      const midX = (guide.from.x + guide.to.x) / 2;
      const midY = (guide.from.y + guide.to.y) / 2;
      const guideLabel = this.add
        .text(midX + 8, midY - 13, guide.label, {
          fontFamily: SANS_FONT,
          fontSize: '9px',
          color: '#7ca7b0',
          backgroundColor: 'rgba(7, 14, 19, 0.7)',
          padding: { left: 4, right: 4, top: 2, bottom: 2 },
        })
        .setDepth(11)
        .setResolution(2);
      this.staticTexts.push(guideLabel);
    }
  }

  private drawGhost(): void {
    const graphics = this.ghostGraphics;
    graphics.clear();
    if (!this.activePlacement || !this.ghostPoint || !this.level) return;
    const meta = ENTITY_META[this.activePlacement.type];
    const ghostEntity = createEntity(
      this.activePlacement.type,
      this.ghostPoint.x,
      this.ghostPoint.y,
      this.activePlacement.strength,
      {
        id: `ghost-${this.activePlacement.type}`,
        layer: this.activePlacement.layer,
        domainScale: this.level.base.domainScale,
      },
    );
    const points: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 60; i += 1) {
      points.push(influenceBoundaryPoint(ghostEntity, (i / 60) * Math.PI * 2, 1));
    }
    pathFromPoints(graphics, smoothClosedPoints(points, 2), true);
    graphics.fillStyle(meta.color, 0.03);
    graphics.fillPath();
    graphics.lineStyle(1.1, meta.color, 0.5);
    graphics.strokePath();

    graphics.fillStyle(meta.color, 0.08);
    graphics.fillCircle(this.ghostPoint.x, this.ghostPoint.y, 19);
    graphics.lineStyle(1.1, meta.color, 0.92);
    graphics.strokeCircle(this.ghostPoint.x, this.ghostPoint.y, 19);
    drawCross(graphics, this.ghostPoint.x, this.ghostPoint.y, 27, meta.color, 0.45);

    const city = this.hitCity(this.ghostPoint.x, this.ghostPoint.y);
    if (city) {
      graphics.lineStyle(1, COLORS.target, 0.65);
      graphics.strokeCircle(this.ghostPoint.x, this.ghostPoint.y, 33);
    }

    if (
      this.activePlacement &&
      (this.activePlacement.type === 'coldAir' ||
        this.activePlacement.type === 'warmAir' ||
        this.activePlacement.type === 'coldLow' ||
        this.activePlacement.type === 'warmLow')
    ) {
      this.drawFronts([...this.entities, ghostEntity]);
    }
  }

  private enterRunPhase(phase: number): void {
    const run = this.run;
    if (!run) return;
    run.phase = phase;
    run.callbacks.onPhase(phase);

    if (phase === 1) {
      this.rainImage.setAlpha(0);
      this.rainContourGraphics.setAlpha(0);
      // The chart still shows the analysis the player built; the overlay says
      // where that analysis moved the pressure field.  Swapping to the result
      // here is what made the "process" feel like a cut to the answer.
      this.renderPressureDelta(this.deltaBaseline ?? run.simulation.before, run.simulation.after);
      this.drawEntities(run.simulation.after.entities);
    } else if (phase === 2) {
      this.deltaGraphics.clear();
      this.rainImage.setAlpha(0);
      this.rainContourGraphics.setAlpha(0);
      this.renderWeather(run.simulation.after);
      this.rainContourGraphics.setAlpha(0);
      this.drawEntities(run.simulation.after.entities);
    }
  }

  private updateRun(delta: number): void {
    const run = this.run;
    if (!run) return;
    run.elapsed += delta;

    const phaseMs = RUN_PHASE_MS / this.animationSpeed;
    if (run.elapsed >= phaseMs * 3) {
      this.finishRun();
      return;
    }

    const phase = Math.min(2, Math.floor(run.elapsed / phaseMs));
    if (phase !== run.phase) this.enterRunPhase(phase);

    const local = (run.elapsed - phase * phaseMs) / phaseMs;

    if (phase === 0) {
      const eased = this.easeInOut(local);
      const display = this.interpolatedEntities(run, eased);
      this.drawEntities(display);
      this.drawWindFlow(run, local);
      this.drawWetTrail(run, display, local);
    } else if (phase === 1) {
      this.motionGraphics.clear();
      this.drawVerticalMotion(run, local);
      this.drawWetTrail(run, run.simulation.after.entities, 1);
    } else {
      this.motionGraphics.clear();
      const alpha = this.easeOutCubic(local);
      this.rainImage.setAlpha(alpha);
      this.rainContourGraphics.setAlpha(alpha);
      if (alpha > 0.9) {
        this.rainImage.setAlpha(1);
        this.rainContourGraphics.setAlpha(1);
      }
    }
  }

  private drawWindFlow(run: RunState, progress: number): void {
    const grid = run.simulation.before.grid;
    const n = grid.n;
    this.motionGraphics.clear();
    const phase = progress * 34;
    for (let j = 3; j < n - 1; j += 6) {
      for (let i = 3; i < n - 1; i += 6) {
        const index = j * n + i;
        const u = this.currentLayer === 'high' ? grid.uHigh[index] : grid.uLow[index];
        const v = this.currentLayer === 'high' ? grid.vHigh[index] : grid.vLow[index];
        const speed = Math.hypot(u, v);
        if (speed < 0.8) continue;
        const x = i * grid.spacing;
        const y = j * grid.spacing;
        const ux = u / speed;
        const uy = v / speed;
        const travel = ((phase + i * 4.2 + j * 7.1) % 30) - 15;
        const length = 5.5;
        const sx = x + ux * travel;
        const sy = y + uy * travel;
        this.motionGraphics.lineStyle(0.9, 0x9bc0cf, 0.3);
        this.motionGraphics.beginPath();
        this.motionGraphics.moveTo(sx, sy);
        this.motionGraphics.lineTo(sx + ux * length, sy + uy * length);
        this.motionGraphics.strokePath();
      }
    }
  }

  private drawWetTrail(
    run: RunState,
    display: WeatherEntity[],
    progress: number,
  ): void {
    const beforeById = new Map(run.simulation.before.entities.map((entity) => [entity.id, entity]));
    for (const entity of display) {
      if (entity.type !== 'wet') continue;
      const before = beforeById.get(entity.id);
      if (!before) continue;
      if (Math.hypot(before.x - entity.x, before.y - entity.y) < 0.5) continue;
      this.motionGraphics.lineStyle(0.9, 0x68cbd1, 0.26);
      this.motionGraphics.beginPath();
      this.motionGraphics.moveTo(before.x, before.y);
      this.motionGraphics.lineTo(entity.x, entity.y);
      this.motionGraphics.strokePath();
      this.motionGraphics.fillStyle(0x68cbd1, 0.45);
      this.motionGraphics.fillCircle(entity.x, entity.y, 2);
      const p = Math.min(1, progress);
      this.motionGraphics.fillStyle(0x8fd8e5, 0.12 + p * 0.12);
      this.motionGraphics.fillCircle(entity.x, entity.y, 24 + p * 5);
    }
  }

  /**
   * Where did the player's analysis move the pressure field?
   *
   * A 3-hour diagnostic step barely changes the field by itself; almost all of
   * the delta comes from what the player just placed.  Drawing it during the
   * wind phase turns "press space and read the answer" into "watch your edit
   * propagate": warm triangles = pressure rose, cool = pressure fell.
   */
  private renderPressureDelta(before: RunSimulation['before'], after: RunSimulation['after']): void {
    const graphics = this.deltaGraphics;
    graphics.clear();
    const a = after.grid.pLow;
    const b = before.grid.pLow;
    if (a.length !== b.length) return;
    const n = after.grid.n;
    const step = Math.max(4, Math.round(n / 14));
    for (let j = step; j < n - step; j += step) {
      for (let i = step; i < n - step; i += step) {
        const index = j * n + i;
        const delta = a[index] - b[index];
        const magnitude = Math.abs(delta);
        if (magnitude < 0.45) continue;
        const x = i * after.grid.spacing;
        const y = j * after.grid.spacing;
        const size = Math.min(9, 3.4 + magnitude * 0.9);
        const color = delta > 0 ? 0xe0a15a : 0x6ca8df;
        const alpha = Math.min(0.7, 0.28 + magnitude * 0.08);
        graphics.fillStyle(color, alpha);
        if (delta > 0) {
          graphics.fillTriangle(x, y - size, x - size * 0.72, y + size * 0.66, x + size * 0.72, y + size * 0.66);
        } else {
          graphics.fillTriangle(x, y + size, x - size * 0.72, y - size * 0.66, x + size * 0.72, y - size * 0.66);
        }
      }
    }
  }

  private drawVerticalMotion(run: RunState, progress: number): void {
    const entities = run.simulation.after.entities;
    for (const entity of entities) {
      if (
        entity.type !== 'coldHigh' &&
        entity.type !== 'warmHigh' &&
        entity.type !== 'coldLow' &&
        entity.type !== 'warmLow'
      ) {
        continue;
      }
      const isLow = entity.type === 'coldLow' || entity.type === 'warmLow';
      const color = isLow ? ENTITY_META.coldLow.color : ENTITY_META.coldHigh.color;
      for (let k = 0; k < 6; k += 1) {
        const angle = (k / 6) * Math.PI * 2 + 0.4;
        const radius = 45;
        const cx = entity.x + Math.cos(angle) * radius;
        const cy = entity.y + Math.sin(angle) * radius * 0.66;
        const cycle = (progress + k / 6) % 1;
        const dy = isLow ? -1 : 1;
        const length = 15;
        const startY = cy + dy * (cycle * 30 - 15);
        const alpha = Math.sin(Math.PI * cycle) * 0.72;
        if (alpha <= 0.02) continue;
        this.motionGraphics.lineStyle(1.2, color, alpha);
        this.motionGraphics.beginPath();
        this.motionGraphics.moveTo(cx, startY);
        this.motionGraphics.lineTo(cx, startY + dy * length);
        this.motionGraphics.strokePath();
        drawArrowHead(
          this.motionGraphics,
          cx,
          startY + dy * length,
          dy > 0 ? Math.PI / 2 : -Math.PI / 2,
          4,
          color,
          alpha,
        );
      }
    }
  }

  private interpolatedEntities(run: RunState, progress: number): WeatherEntity[] {
    const afterById = new Map(run.simulation.after.entities.map((entity) => [entity.id, entity]));
    return run.simulation.before.entities.map((entity) => {
      const after = afterById.get(entity.id);
      if (!after || entity.type !== 'wet') return { ...entity };
      return {
        ...entity,
        x: entity.x + (after.x - entity.x) * progress,
        y: entity.y + (after.y - entity.y) * progress,
      };
    });
  }

  private finishRun(): void {
    const run = this.run;
    if (!run || run.completed) return;
    run.completed = true;
    this.running = false;
    this.run = null;
    this.snapshot = run.simulation.after;
    this.entities = run.simulation.after.entities;
    this.motionGraphics.clear();
    this.deltaGraphics.clear();
    this.rainImage.setAlpha(1);
    this.rainContourGraphics.setAlpha(1);
    this.renderWeather(run.simulation.after);
    this.drawEntities(run.simulation.after.entities);
    this.drawCities(run.simulation.after);
    run.callbacks.onComplete();
  }

  private easeInOut(value: number): number {
    return value < 0.5 ? 2 * value * value : 1 - Math.pow(-2 * value + 2, 2) / 2;
  }

  private easeOutCubic(value: number): number {
    return 1 - Math.pow(1 - value, 3);
  }

  private clearLabels(): void {
    for (const label of this.entityLabels.values()) {
      label.glyph.destroy();
      label.value.destroy();
    }
    this.entityLabels.clear();
    for (const label of this.cityLabels.values()) {
      label.name.destroy();
      label.data.destroy();
    }
    this.cityLabels.clear();
    for (const text of this.staticTexts) text.destroy();
    this.staticTexts = [];
    for (const text of this.coordinateLabels) text.destroy();
    this.coordinateLabels = [];
  }
}


