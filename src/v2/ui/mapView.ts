/**
 * V2 · 天气图渲染与交互。
 *
 * 底图（分层设色 + 晕渲 + 矢量海岸线）只在换关时生成一次；
 * 每一帧再叠加等压线、风矢、云、降水、H/L 与站点。
 * 所有矢量层都按屏幕分辨率绘制，缩放后仍然清晰。
 */

import { clamp, hash2, smoothstep } from '../core/grid';
import type { Grid } from '../core/grid';
import type { Frame, MapDesign, MapPalette, SceneDef } from '../core/types';
import type { SceneFields } from '../scene/scene';
import {
  absolutePressureHpa,
  apparentTemperatureC,
  relativeHumidity,
} from '../physics/thermo';
import { dominantPhase, phaseLabel } from '../physics/phase';

export interface MapLayers {
  pressure: boolean;
  wind: boolean;
  cloud: boolean;
  rain: boolean;
  temp: boolean;
  terrain: boolean;
}

export interface MapGhost {
  /** 兼容字段：落点由 setGhostPoint / 指针决定，这里不再携带坐标。 */
  xKm?: number;
  yKm?: number;
  family: 'low' | 'high' | 'jet';
  label: string;
  directionDeg?: number;
}

export interface HoverInfo {
  xKm: number;
  yKm: number;
  /** 实际海平面气压（hPa），不是距平。 */
  p: number;
  /** 实际 2 m 气温（°C）。 */
  t: number;
  /** 体感温度（°C，含风寒/蒸发冷却）。 */
  apparent: number;
  /** 局地温度平流，K/h；负值为冷平流。 */
  tempAdvectionKPerH: number;
  rh: number;
  wind: number;
  cc: number;
  rain: number;
  /** 当前格点占优相态（雨/雨夹雪/雪/冻雨/冰雹）。 */
  phase: string;
  /** 整层可降水量，mm。 */
  pwMm: number;
  /** 850 / 500 hPa 层温，℃；旧帧缺省时为 NaN。 */
  t850: number;
  t500: number;
  screenX: number;
  screenY: number;
}

export interface MapCallbacks {
  onCanvasClick?: (xKm: number, yKm: number) => void;
  onHover?: (info: HoverInfo | null) => void;
}

type RGB = [number, number, number];

interface MapPaletteSpec {
  ramp: readonly (readonly [number, number, number, number])[];
  deep: RGB;
  shelf: RGB;
  /** 低地植被染色强度，0–1。 */
  vegetation: number;
  /** 植被染色偏向（会与地形色相乘）。 */
  plant: RGB;
  /** 常年雪线；低于 2600 的色板也能出现高山雪。 */
  snowLine: number;
  /** 陡坡裸岩色。 */
  rock: RGB;
}

const MAP_PALETTES: Record<MapPalette, MapPaletteSpec> = {
  temperate: {
    ramp: [
      [0, 56, 80, 60],
      [80, 64, 88, 64],
      [200, 74, 100, 68],
      [500, 96, 124, 74],
      [900, 118, 138, 90],
      [1400, 140, 146, 100],
      [2200, 172, 172, 136],
      [3200, 204, 202, 180],
    ],
    deep: [5, 15, 27],
    shelf: [16, 52, 64],
    vegetation: 0.22,
    plant: [32, 76, 44],
    snowLine: 2500,
    rock: [142, 146, 136],
  },
  coastal: {
    ramp: [
      [0, 38, 58, 48],
      [90, 44, 68, 52],
      [260, 54, 88, 58],
      [600, 82, 118, 70],
      [1100, 116, 142, 86],
      [1700, 148, 158, 108],
      [2500, 180, 184, 150],
      [3400, 210, 212, 190],
    ],
    deep: [4, 16, 28],
    shelf: [14, 62, 76],
    vegetation: 0.34,
    plant: [22, 78, 46],
    snowLine: 2800,
    rock: [138, 146, 138],
  },
  arid: {
    ramp: [
      [0, 76, 62, 40],
      [100, 102, 82, 50],
      [300, 132, 102, 60],
      [700, 156, 126, 76],
      [1200, 174, 148, 96],
      [1900, 194, 172, 128],
      [2700, 210, 192, 158],
      [3500, 224, 212, 190],
    ],
    deep: [8, 16, 22],
    shelf: [28, 50, 52],
    vegetation: 0.08,
    plant: [78, 82, 38],
    snowLine: 3300,
    rock: [176, 158, 130],
  },
  alpine: {
    ramp: [
      [0, 26, 42, 38],
      [90, 34, 52, 46],
      [260, 48, 66, 56],
      [650, 76, 90, 76],
      [1200, 108, 116, 100],
      [1900, 144, 150, 138],
      [2600, 178, 184, 184],
      [3400, 218, 222, 226],
    ],
    deep: [3, 12, 22],
    shelf: [16, 42, 58],
    vegetation: 0.12,
    plant: [32, 62, 46],
    snowLine: 2100,
    rock: [166, 170, 176],
  },
  tropical: {
    ramp: [
      [0, 38, 74, 48],
      [90, 44, 86, 52],
      [280, 54, 102, 58],
      [700, 64, 108, 54],
      [1200, 90, 124, 64],
      [1900, 118, 136, 76],
      [2700, 156, 160, 104],
      [3500, 196, 192, 150],
    ],
    deep: [3, 20, 33],
    shelf: [12, 72, 82],
    vegetation: 0.42,
    plant: [16, 92, 36],
    snowLine: 4200,
    rock: [150, 146, 126],
  },
  boreal: {
    ramp: [
      [0, 24, 40, 38],
      [90, 30, 52, 46],
      [280, 42, 68, 56],
      [700, 62, 88, 68],
      [1200, 88, 106, 84],
      [1900, 122, 132, 112],
      [2700, 158, 162, 148],
      [3500, 196, 198, 194],
    ],
    deep: [4, 14, 26],
    shelf: [14, 46, 60],
    vegetation: 0.28,
    plant: [26, 64, 44],
    snowLine: 1900,
    rock: [150, 156, 152],
  },
  wetland: {
    ramp: [
      [0, 46, 70, 54],
      [80, 52, 78, 58],
      [240, 62, 92, 62],
      [600, 80, 110, 70],
      [1100, 104, 126, 80],
      [1700, 122, 138, 94],
      [2400, 154, 160, 122],
      [3200, 190, 194, 164],
    ],
    deep: [5, 18, 28],
    shelf: [12, 56, 66],
    vegetation: 0.34,
    plant: [22, 74, 38],
    snowLine: 3200,
    rock: [148, 154, 142],
  },
};

function paletteOf(design: MapDesign | undefined): MapPaletteSpec {
  return MAP_PALETTES[design?.palette ?? 'temperate'];
}

/** 实际气温色带（固定刻度，避免同一色在不同关卡代表不同温度）。 */
const TEMP_RAMP: readonly (readonly [number, number, number, number])[] = [
  [-20, 44, 66, 132],
  [-5, 54, 96, 170],
  [5, 62, 138, 194],
  [12, 88, 188, 195],
  [18, 208, 208, 150],
  [24, 236, 178, 98],
  [30, 236, 128, 80],
  [36, 238, 88, 72],
];

function ramp(stops: readonly (readonly [number, number, number, number])[], value: number): RGB {
  if (value <= stops[0][0]) return [stops[0][1], stops[0][2], stops[0][3]];
  const last = stops[stops.length - 1];
  if (value >= last[0]) return [last[1], last[2], last[3]];
  for (let i = 1; i < stops.length; i += 1) {
    const [v1, r1, g1, b1] = stops[i - 1];
    const [v2, r2, g2, b2] = stops[i];
    if (value <= v2) {
      const k = v2 === v1 ? 0 : (value - v1) / (v2 - v1);
      return [r1 + (r2 - r1) * k, g1 + (g2 - g1) * k, b1 + (b2 - b1) * k];
    }
  }
  return [last[1], last[2], last[3]];
}

function windColor(speed: number): string {
  if (speed < 4) return 'rgba(150,171,185,0.5)';
  if (speed < 10) return 'rgba(197,216,226,0.7)';
  if (speed < 18) return 'rgba(228,237,242,0.86)';
  if (speed < 28) return 'rgba(236,190,118,0.92)';
  return 'rgba(230,132,108,0.96)';
}

function hashNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, y: number, seed: number): number {
  return (
    hashNoise(x, y, seed) * 0.56 +
    hashNoise(x * 2.13, y * 2.13, seed + 17) * 0.28 +
    hashNoise(x * 4.31, y * 4.31, seed + 41) * 0.16
  );
}

function precipColor(rate: number, phase: string): RGB {
  if (phase === 'snow') {
    const t = clamp(rate / 16, 0, 1);
    return [220 - 30 * t, 238 - 18 * t, 255 - 8 * t];
  }
  if (phase === 'sleet') return [206, 196, 255];
  if (phase === 'freezingRain') return [246, 168, 206];
  if (phase === 'hail') return [255, 232, 170];
  const stops: readonly (readonly [number, number, number, number])[] = [
    [0.1, 104, 214, 168],
    [1.5, 70, 190, 116],
    [4, 88, 178, 240],
    [9, 60, 110, 226],
    [18, 156, 99, 228],
    [40, 196, 86, 176],
  ];
  return ramp(stops, rate);
}

// ── 等值线追踪 ───────────────────────────────────────────────────────────

interface Contour {
  value: number;
  points: { x: number; y: number }[];
}

type Point = { x: number; y: number };
type Segment = { a: Point; b: Point; value: number };

function edgePoint(
  field: Float32Array | Float64Array,
  n: number,
  i0: number,
  j0: number,
  i1: number,
  j1: number,
  level: number,
): Point {
  const v0 = field[j0 * n + i0];
  const v1 = field[j1 * n + i1];
  const t = Math.abs(v1 - v0) < 1e-9 ? 0.5 : (level - v0) / (v1 - v0);
  return { x: i0 + (i1 - i0) * t, y: j0 + (j1 - j0) * t };
}

function segmentsForLevel(
  field: Float32Array | Float64Array,
  n: number,
  level: number,
): Segment[] {
  const out: Segment[] = [];
  for (let j = 0; j < n - 1; j += 1) {
    for (let i = 0; i < n - 1; i += 1) {
      const v0 = field[j * n + i];
      const v1 = field[j * n + i + 1];
      const v2 = field[(j + 1) * n + i + 1];
      const v3 = field[(j + 1) * n + i];
      let code = 0;
      if (v0 > level) code |= 1;
      if (v1 > level) code |= 2;
      if (v2 > level) code |= 4;
      if (v3 > level) code |= 8;
      if (code === 0 || code === 15) continue;

      const top = () => edgePoint(field, n, i, j, i + 1, j, level);
      const right = () => edgePoint(field, n, i + 1, j, i + 1, j + 1, level);
      const bottom = () => edgePoint(field, n, i, j + 1, i + 1, j + 1, level);
      const left = () => edgePoint(field, n, i, j, i, j + 1, level);

      switch (code) {
        case 1:
        case 14:
          out.push({ a: left(), b: top(), value: level });
          break;
        case 2:
        case 13:
          out.push({ a: top(), b: right(), value: level });
          break;
        case 3:
        case 12:
          out.push({ a: left(), b: right(), value: level });
          break;
        case 4:
        case 11:
          out.push({ a: right(), b: bottom(), value: level });
          break;
        case 6:
        case 9:
          out.push({ a: top(), b: bottom(), value: level });
          break;
        case 7:
        case 8:
          out.push({ a: left(), b: bottom(), value: level });
          break;
        case 5:
        case 10: {
          const mid = (v0 + v1 + v2 + v3) / 4;
          if (mid > level) {
            out.push({ a: left(), b: bottom(), value: level });
            out.push({ a: top(), b: right(), value: level });
          } else {
            out.push({ a: left(), b: top(), value: level });
            out.push({ a: right(), b: bottom(), value: level });
          }
          break;
        }
        default:
          break;
      }
    }
  }
  return out;
}

function key(point: Point): string {
  return `${Math.round(point.x * 8)}:${Math.round(point.y * 8)}`;
}

function chainSegments(segments: Segment[]): Point[][] {
  const buckets = new Map<string, number[]>();
  const used = new Uint8Array(segments.length);
  const push = (point: Point, index: number) => {
    const k = key(point);
    const list = buckets.get(k);
    if (list) list.push(index);
    else buckets.set(k, [index]);
  };
  segments.forEach((segment, index) => {
    push(segment.a, index);
    push(segment.b, index);
  });

  const lines: Point[][] = [];
  for (let start = 0; start < segments.length; start += 1) {
    if (used[start]) continue;
    used[start] = 1;
    const segment = segments[start];
    const forward: Point[] = [segment.a, segment.b];
    const backward: Point[] = [];

    const extend = (from: Point, into: Point[]) => {
      let cursor = from;
      for (let guard = 0; guard < 4096; guard += 1) {
        const list = buckets.get(key(cursor));
        if (!list) return;
        let nextIndex = -1;
        for (const index of list) {
          if (!used[index]) {
            nextIndex = index;
            break;
          }
        }
        if (nextIndex < 0) return;
        used[nextIndex] = 1;
        const next = segments[nextIndex];
        const other = key(next.a) === key(cursor) ? next.b : next.a;
        into.push(other);
        cursor = other;
      }
    };

    extend(segment.b, forward);
    extend(segment.a, backward);
    backward.reverse();
    lines.push([...backward, ...forward]);
  }
  return lines;
}

function traceContours(
  field: Float32Array | Float64Array,
  n: number,
  levels: number[],
): Contour[] {
  const out: Contour[] = [];
  for (const level of levels) {
    const segments = segmentsForLevel(field, n, level);
    if (segments.length === 0) continue;
    for (const points of chainSegments(segments)) {
      if (points.length >= 2) out.push({ value: level, points });
    }
  }
  return out;
}

function contourLevels(min: number, max: number, interval: number): number[] {
  const start = Math.ceil(min / interval) * interval;
  const levels: number[] = [];
  for (let v = start; v <= max + 1e-6; v += interval) levels.push(Number(v.toFixed(3)));
  return levels;
}

// ── 投影 ─────────────────────────────────────────────────────────────────

class Projection {
  width = 1;
  height = 1;
  readonly domainKm: number;
  private baseScale = 1;
  zoom = 1;
  panX = 0;
  panY = 0;

  constructor(domainKm: number) {
    this.domainKm = domainKm;
  }

  fit(width: number, height: number, cover = false): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    // 普通模式完整容纳整张图；专注模式按长边铺满，短边自然裁切，
    // 避免宽屏下地图缩在中间、两侧留出大片黑边。
    const basis = cover ? Math.max(this.width, this.height) : Math.min(this.width, this.height);
    this.baseScale = (basis * 0.96) / this.domainKm;
    this.reset();
  }

  reset(): void {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
  }

  get scale(): number {
    return this.baseScale * this.zoom;
  }

  toScreen(xKm: number, yKm: number): { x: number; y: number } {
    const scale = this.scale;
    return {
      x: this.width / 2 + this.panX + (xKm - this.domainKm / 2) * scale,
      y: this.height / 2 + this.panY - (yKm - this.domainKm / 2) * scale,
    };
  }

  toKm(x: number, y: number): { xKm: number; yKm: number } {
    const scale = this.scale;
    return {
      xKm: this.domainKm / 2 + (x - this.width / 2 - this.panX) / scale,
      yKm: this.domainKm / 2 - (y - this.height / 2 - this.panY) / scale,
    };
  }

  zoomAt(x: number, y: number, factor: number): void {
    const before = this.toKm(x, y);
    this.zoom = clamp(this.zoom * factor, 1, 5);
    const scale = this.scale;
    this.panX = x - this.width / 2 - (before.xKm - this.domainKm / 2) * scale;
    this.panY = y - this.height / 2 + (before.yKm - this.domainKm / 2) * scale;
    this.clampPan();
  }

  panBy(dx: number, dy: number): void {
    if (this.zoom <= 1.01 && !this.overflows()) return;
    this.panX += dx;
    this.panY += dy;
    this.clampPan();
  }

  private overflows(): boolean {
    return (
      this.domainKm * this.scale > this.width + 1 ||
      this.domainKm * this.scale > this.height + 1
    );
  }

  private clampPan(): void {
    if (this.zoom <= 1.01 && !this.overflows()) {
      this.panX = 0;
      this.panY = 0;
      return;
    }
    const mapPx = this.domainKm * this.scale;
    const halfExtraX = Math.max(0, (mapPx - this.width) / 2);
    const halfExtraY = Math.max(0, (mapPx - this.height) / 2);
    const capX = halfExtraX + 80;
    const capY = halfExtraY + 80;
    this.panX = clamp(this.panX, -capX, capX);
    this.panY = clamp(this.panY, -capY, capY);
  }
}

// ── 底图 ─────────────────────────────────────────────────────────────────

/** 海岸/湖岸的平滑场：对 0/1 陆海掩膜做几轮 1-2-1 模糊，避免格子级台阶。 */
function smoothCoastField(source: Float32Array | Float64Array, n: number): Float32Array {
  let a = Float32Array.from(source);
  let b = new Float32Array(n * n);
  const pass = (): void => {
    for (let j = 0; j < n; j += 1) {
      for (let i = 0; i < n; i += 1) {
        const im = i > 0 ? i - 1 : 0;
        const ip = i < n - 1 ? i + 1 : n - 1;
        b[j * n + i] = (a[j * n + im] + 2 * a[j * n + i] + a[j * n + ip]) / 4;
      }
    }
    for (let j = 0; j < n; j += 1) {
      const jm = j > 0 ? j - 1 : 0;
      const jp = j < n - 1 ? j + 1 : n - 1;
      for (let i = 0; i < n; i += 1) {
        a[j * n + i] = (b[jm * n + i] + 2 * b[j * n + i] + b[jp * n + i]) / 4;
      }
    }
  };
  for (let p = 0; p < 3; p += 1) pass();
  b = a;
  return b;
}

function buildTerrainCanvas(
  scene: SceneDef,
  fields: SceneFields,
  grid: Grid,
  coastField: Float32Array,
): HTMLCanvasElement {
  // 底图缓存一次生成、每帧只做一次 drawImage。1024² 让 800px 级地图
  // 在 2× DPR 下仍有足够细节，避免地形被放大成一团模糊绿斑。
  const res = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = res;
  canvas.height = res;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const image = ctx.createImageData(res, res);
  const data = image.data;
  const n = grid.n;
  const design = scene.map;
  const palette = paletteOf(design);
  const snowLine = palette.snowLine;

  // 近岸浅水：一次有限半径扫描，保持确定性。
  const shallow = new Float64Array(n * n);
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const k = grid.idx(i, j);
      if (fields.land[k] > 0.5) {
        shallow[k] = 0;
        continue;
      }
      let near = 7;
      for (let dj = -6; dj <= 6; dj += 1) {
        const jj = clamp(j + dj, 0, n - 1);
        for (let di = -6; di <= 6; di += 1) {
          const ii = clamp(i + di, 0, n - 1);
          if (fields.land[grid.idx(ii, jj)] > 0.5) {
            near = Math.min(near, Math.hypot(di, dj));
          }
        }
      }
      shallow[k] = 1 - near / 7;
    }
  }

  const seed = (scene.centerLon % 37) + scene.centerLat * 0.13;
  for (let py = 0; py < res; py += 1) {
    const yKm = ((py + 0.5) / res) * scene.domainKm;
    for (let px = 0; px < res; px += 1) {
      const xKm = ((px + 0.5) / res) * scene.domainKm;
      const land = grid.sample(coastField, xKm, yKm) > 0.5;
      const p = (py * res + px) * 4;
      if (land) {
        const h = grid.sample(fields.height, xKm, yKm);
        const sx = grid.sample(fields.slopeX, xKm, yKm);
        const sy = grid.sample(fields.slopeY, xKm, yKm);
        // 西北向斜射光。低丘坡度只有 0.005 左右，真实光照几乎看不出来，
        // 这里对坡度做夸张，并叠加多尺度地貌斑驳，让丘陵、盆地边缘和山脊可读。
        const macro = (fbm(xKm / 54, yKm / 54, (seed | 0) + 211) - 0.5) * 0.12;
        const steep = clamp((Math.hypot(sx, sy) - 0.004) / 0.03, 0, 1);
        const light = Math.tanh(sx * 120 + sy * 80) * (0.5 - steep * 0.28);
        const shade = clamp(1.02 - light + macro, 0.52, 1.2);
        const grain = (hash2(px, py, seed | 0) - 0.5) * 0.035;
        const mottle =
          (fbm(xKm / 92, yKm / 92, seed | 0) - 0.5) * 0.15 +
          (fbm(xKm / 31, yKm / 31, (seed | 0) + 61) - 0.5) * 0.075 +
          (fbm(xKm / 12, yKm / 12, (seed | 0) + 97) - 0.5) * 0.03;
        const base = ramp(palette.ramp, h);
        const tone = shade + grain + mottle;
        // 低地植被：不同气候区分别压出深绿、黄褐、青灰的底色。
        const veg =
          palette.vegetation *
          clamp(1 - h / 1400, 0, 1) *
          clamp((fbm(xKm / 24, yKm / 24, (seed | 0) + 131) - 0.38) * 1.8, 0, 1);
        data[p] = clamp(base[0] * tone + (palette.plant[0] - base[0]) * veg, 0, 255);
        data[p + 1] = clamp(base[1] * tone + (palette.plant[1] - base[1]) * veg, 0, 255);
        data[p + 2] = clamp(base[2] * tone + (palette.plant[2] - base[2]) * veg, 0, 255);
        // 低地森林斑块：让平原不是一整块均匀绿色。
        const forest =
          clamp((fbm(xKm / 13, yKm / 13, (seed | 0) + 171) - 0.48) * 3.2, 0, 1) *
          clamp(1 - h / 900, 0, 1) *
          0.5;
        if (forest > 0) {
          data[p] = clamp(data[p] + (16 - data[p]) * forest, 0, 255);
          data[p + 1] = clamp(data[p + 1] + (44 - data[p + 1]) * forest, 0, 255);
          data[p + 2] = clamp(data[p + 2] + (26 - data[p + 2]) * forest, 0, 255);
        }
        // 平原农区：低矮的田块纹理，让底图有“被经营过”的地理感。
        const flat = clamp(1 - h / 320, 0, 1);
        if (flat > 0.15 && h < 320) {
          const plot = hash2(Math.floor(xKm / 26), Math.floor(yKm / 19), (seed | 0) + 303) - 0.5;
          const field = flat * 0.22;
          data[p] = clamp(data[p] + plot * 24 * field, 0, 255);
          data[p + 1] = clamp(data[p + 1] + plot * 18 * field, 0, 255);
          data[p + 2] = clamp(data[p + 2] + plot * 7 * field, 0, 255);
        }
        // 高地加一点冷灰岩色，低地保留暖绿；让高原、山地与平原分层更清楚。
        const rocky = clamp((h - 1100) / 1500, 0, 1) * 0.22;
        data[p] = clamp(data[p] + rocky * 18, 0, 255);
        data[p + 1] = clamp(data[p + 1] + rocky * 16, 0, 255);
        data[p + 2] = clamp(data[p + 2] + rocky * 20, 0, 255);
        const cliff = clamp((steep - 0.15) / 0.85, 0, 1) * 0.42;
        if (cliff > 0) {
          data[p] = clamp(data[p] + (palette.rock[0] - data[p]) * cliff, 0, 255);
          data[p + 1] = clamp(data[p + 1] + (palette.rock[1] - data[p + 1]) * cliff, 0, 255);
          data[p + 2] = clamp(data[p + 2] + (palette.rock[2] - data[p + 2]) * cliff, 0, 255);
        }
        // 常年雪线：高山用冷白压顶，让山脊与高原一眼可辨。
        const snow = clamp((h - snowLine) / 420, 0, 1) * 0.85;
        if (snow > 0) {
          const snowNoise = (fbm(xKm / 18, yKm / 18, (seed | 0) + 157) - 0.5) * 0.06;
          data[p] = clamp(data[p] + (236 - data[p]) * (snow + snowNoise), 0, 255);
          data[p + 1] = clamp(data[p + 1] + (239 - data[p + 1]) * (snow + snowNoise), 0, 255);
          data[p + 2] = clamp(data[p + 2] + (242 - data[p + 2]) * (snow + snowNoise), 0, 255);
        }
      } else {
        const s = clamp(grid.sample(shallow, xKm, yKm), 0, 1);
        const k = Math.pow(s, 1.4);
        data[p] = palette.deep[0] + (palette.shelf[0] - palette.deep[0]) * k;
        data[p + 1] = palette.deep[1] + (palette.shelf[1] - palette.deep[1]) * k;
        data[p + 2] = palette.deep[2] + (palette.shelf[2] - palette.deep[2]) * k;
        const grain = (hash2(px, py, seed | 0) - 0.5) * 2.2;
        data[p] += grain;
        data[p + 1] += grain;
        data[p + 2] += grain;
      }
      data[p + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  drawLandformTint(ctx, scene, res);
  if (design?.rivers !== 'none') {
    drawRivers(ctx, scene, fields, grid, res);
  }
  return canvas;
}

/**
 * 在栅格底图上再压一层“地貌明暗”：河谷的谷底提亮、两侧坡面压暗，
 * 盆地压暗盆缘，隘口只留一条浅色通道。它只影响观感，不参与物理，
 * 目的是让每张图的构图和地形语义对得上，而不是所有关共用一张噪点底图。
 */
function drawLandformTint(ctx: CanvasRenderingContext2D, scene: SceneDef, res: number): void {
  const terrain = scene.terrain;
  const domain = scene.domainKm;
  const axis = ((terrain.axisDeg ?? 0) * Math.PI) / 180;
  const ax = Math.cos(axis);
  const ay = Math.sin(axis);
  const shift = (terrain.axisXKm ?? 0) / domain;
  const cx = res * 0.5 + ax * shift * res;
  const cy = res * 0.5 + ay * shift * res;
  const half = (p: number) => clamp(p, 0.02, 0.48);

  ctx.save();
  if (terrain.kind === 'valley' || terrain.kind === 'pass') {
    const floor = half((terrain.valleyHalfWidthKm ?? domain * 0.14) / domain);
    const wall = half((terrain.valleyWallWidthKm ?? domain * 0.09) / domain);
    const ramp = ctx.createLinearGradient(cx - ax * res * 0.5, cy - ay * res * 0.5, cx + ax * res * 0.5, cy + ay * res * 0.5);
    const edge = clamp(0.5 - floor - wall, 0.01, 0.98);
    const floor0 = clamp(0.5 - floor, 0.01, 0.98);
    const floor1 = clamp(0.5 + floor, 0.01, 0.98);
    const edge1 = clamp(0.5 + floor + wall, 0.01, 0.98);
    ramp.addColorStop(0, 'rgba(14,20,16,0.16)');
    ramp.addColorStop(edge, 'rgba(18,24,18,0.14)');
    ramp.addColorStop(floor0, 'rgba(176,188,132,0.07)');
    ramp.addColorStop(floor1, 'rgba(176,188,132,0.07)');
    ramp.addColorStop(edge1, 'rgba(18,24,18,0.14)');
    ramp.addColorStop(1, 'rgba(14,20,16,0.16)');
    ctx.fillStyle = ramp;
    ctx.fillRect(0, 0, res, res);
  } else if (terrain.kind === 'basin') {
    const radius = clamp((terrain.basinRadiusKm ?? domain * 0.3) / domain, 0.12, 0.46) * res;
    const rim = ctx.createRadialGradient(cx, cy, 0, cx, cy, res * 0.62);
    rim.addColorStop(0, 'rgba(160,172,124,0.04)');
    rim.addColorStop(clamp(radius / (res * 0.62), 0.1, 0.9), 'rgba(160,172,124,0.03)');
    rim.addColorStop(1, 'rgba(10,16,14,0.2)');
    ctx.fillStyle = rim;
    ctx.fillRect(0, 0, res, res);
  }
  ctx.restore();
}

/**
 * 自动河网：按地形类型与轴向生成 1–3 条河，碰到海/湖就停。
 * 这是纯视觉层，不影响物理；但能让平原、河谷、三角洲、海岸图幅
 * 不再长得一样。
 */
function drawRivers(
  ctx: CanvasRenderingContext2D,
  scene: SceneDef,
  fields: SceneFields,
  grid: Grid,
  res: number,
): void {
  const domain = scene.domainKm;
  const terrain = scene.terrain;
  const axisX = terrain.axisXKm ?? 0;
  const axis = ((terrain.axisDeg ?? 0) * Math.PI) / 180;
  const acrossX = Math.cos(axis);
  const acrossY = Math.sin(axis);
  // axisDeg 是“横跨”方向；岸线/谷轴沿垂直于它的方向延伸。
  const verticalLine = Math.abs(acrossX) >= Math.abs(acrossY);
  const style = scene.map?.riverStyle ?? terrain.kind;
  const paths: { u: number; v: number }[][] = [];
  const straight = (from: [number, number], to: [number, number]): { u: number; v: number }[] => {
    const pts: { u: number; v: number }[] = [];
    for (let s = 0; s <= 32; s += 1) {
      const t = s / 32;
      pts.push({ u: from[0] + (to[0] - from[0]) * t, v: from[1] + (to[1] - from[1]) * t });
    }
    return pts;
  };
  const line = (from: [number, number], to: [number, number], bends = 1): { u: number; v: number }[] => {
    const pts: { u: number; v: number }[] = [];
    const verticalSegment = Math.abs(to[1] - from[1]) > Math.abs(to[0] - from[0]);
    for (let s = 0; s <= 48; s += 1) {
      const t = s / 48;
      const nx = from[0] + (to[0] - from[0]) * t;
      const ny = from[1] + (to[1] - from[1]) * t;
      const wiggle = Math.sin(t * Math.PI * 2.8 + bends * 1.7) * 0.038 * Math.sin(Math.PI * t);
      pts.push({
        u: nx + (verticalSegment ? wiggle : 0),
        v: ny + (verticalSegment ? 0 : wiggle),
      });
    }
    return pts;
  };

  if (style === 'dry') {
    // 干旱区：短促、离散的干河床，不与全图主河连成一片。
    paths.push(line([0.04, 0.64], [0.22, 0.46], 2.6));
    paths.push(line([0.42, 0.96], [0.52, 0.72], 0.8));
    paths.push(line([0.68, 0.06], [0.84, 0.28], 1.9));
  } else if (style === 'canal') {
    // 农区/灌区：接近直角的输水渠，和自然河网区分开。
    paths.push(straight([0.02, 0.36], [0.98, 0.38]));
    paths.push(straight([0.32, 0.02], [0.32, 0.98]));
    paths.push(straight([0.68, 0.98], [0.68, 0.28]));
    paths.push(straight([0.32, 0.64], [0.68, 0.64]));
  } else if (terrain.kind === 'valley') {
    if (verticalLine) {
      const x = 0.5 + axisX / domain;
      paths.push(line([x - 0.035, 0.02], [x + 0.045, 0.98], 1.2));
    } else {
      const y = 0.5 + axisX / domain;
      paths.push(line([0.02, y + 0.04], [0.98, y - 0.03], 1.6));
    }
  } else if (terrain.kind === 'coast' || terrain.kind === 'mountainCoast' || terrain.kind === 'delta') {
    // 海岸线在 across = axisX 处；从内陆一侧画到海岸。
    if (verticalLine) {
      const coastX = 0.5 + axisX / domain;
      const inland = coastX > 0.5 ? -1 : 1;
      const start = coastX + inland * 0.34;
      const end = coastX - inland * 0.015;
      paths.push(line([start, 0.68], [end, 0.58], 1.1));
      paths.push(line([start + inland * 0.08, 0.36], [end, 0.46], 2.2));
      if (terrain.kind === 'delta') {
        paths.push(line([end, 0.46], [coastX - inland * 0.22, 0.28], 0.5));
      }
    } else {
      const coastY = 0.5 + axisX / domain;
      const inland = coastY > 0.5 ? -1 : 1;
      const start = coastY + inland * 0.34;
      const end = coastY - inland * 0.015;
      paths.push(line([0.66, start], [0.56, end], 1.1));
      paths.push(line([0.34, start + inland * 0.08], [0.44, end], 2.2));
      if (terrain.kind === 'delta') {
        paths.push(line([0.44, end], [0.28, coastY - inland * 0.22], 0.5));
      }
    }
  } else if (terrain.kind === 'lake') {
    paths.push(line([0.03, 0.56], [0.44, 0.5], 1.3));
    paths.push(line([0.96, 0.42], [0.57, 0.5], 2.1));
  } else if (terrain.kind === 'island') {
    paths.push(line([0.5, 0.5], [0.82, 0.16], 0.8));
    paths.push(line([0.5, 0.5], [0.18, 0.2], 1.9));
    paths.push(line([0.5, 0.5], [0.68, 0.92], 2.7));
  } else if (terrain.kind === 'ridge' || terrain.kind === 'pass') {
    const y = 0.5 + axisX / domain;
    paths.push(line([0.12, y + 0.12], [0.88, y + 0.02], 1.4));
  } else if (terrain.kind === 'plateau') {
    paths.push(line([0.04, 0.72], [0.92, 0.42], 1.8));
    paths.push(line([0.26, 0.98], [0.56, 0.5], 0.6));
  } else if (terrain.kind === 'basin') {
    paths.push(line([0.08, 0.78], [0.5, 0.52], 1.2));
  } else {
    // 平原：一条连贯主河 + 南北支流 + 两条短支流，读起来像水系而不是划痕。
    paths.push(line([0.02, 0.36], [0.98, 0.58], 1.3));
    paths.push(line([0.46, 0.98], [0.56, 0.62], 1.0));
    paths.push(line([0.26, 0.02], [0.38, 0.42], 2.4));
    paths.push(line([0.08, 0.96], [0.28, 0.58], 1.9));
    paths.push(line([0.9, 0.05], [0.66, 0.46], 2.6));
  }

  const land = (u: number, v: number): boolean =>
    grid.sample(fields.land, u * domain, v * domain) > 0.5;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const path of paths) {
    const drawable = path.filter((p) => land(p.u, p.v));
    if (drawable.length < 4) continue;
    const strokes: [string, number][] = [
      ['rgba(9,28,34,0.52)', 2.0],
      ['rgba(70,132,146,0.62)', 1.0],
    ];
    for (const [color, width] of strokes) {
      ctx.beginPath();
      for (let i = 0; i < drawable.length; i += 1) {
        const x = drawable[i].u * res;
        const y = drawable[i].v * res;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
    }
  }
  ctx.restore();
}

// ── MapView ──────────────────────────────────────────────────────────────

export class MapView {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly scene: SceneDef;
  private readonly grid: Grid;
  private readonly coastField: Float32Array;
  private readonly projection: Projection;
  private readonly callbacks: MapCallbacks;
  private terrain: HTMLCanvasElement;
  private readonly terrainContours: Contour[];

  private frame: Frame | null = null;
  private history: readonly Frame[] = [];
  private layers: MapLayers;
  private ghost: MapGhost | null = null;
  /** 落点：指针移动会更新它，键盘微调也直接改写它。 */
  private ghostPoint: { xKm: number; yKm: number } | null = null;
  private selectedStation: string | null = null;
  private pointerKm: { xKm: number; yKm: number } | null = null;
  private hoverScreen: { x: number; y: number } | null = null;

  private dpr = 1;
  private dirty = true;
  private rafId = 0;
  private dragging = false;
  private dragMoved = false;
  private lastPointer = { x: 0, y: 0 };

  private cloudCanvas: HTMLCanvasElement;
  private rainCanvas: HTMLCanvasElement;
  private tempCanvas: HTMLCanvasElement;
  private tempField64: Float64Array | null = null;
  private tempFieldFrame: Frame | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    scene: SceneDef,
    grid: Grid,
    fields: SceneFields,
    callbacks: MapCallbacks,
  ) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('画布不可用');
    this.ctx = ctx;
    this.scene = scene;
    this.grid = grid;
    this.coastField = smoothCoastField(fields.land, grid.n);
    this.callbacks = callbacks;
    this.projection = new Projection(scene.domainKm);
    this.terrain = buildTerrainCanvas(scene, fields, grid, this.coastField);
    let maxHeight = 0;
    for (let k = 0; k < fields.height.length; k += 1) {
      if (fields.height[k] > maxHeight) maxHeight = fields.height[k];
    }
    const contourStep = clamp(Math.round(maxHeight / 5 / 50) * 50, 40, 400);
    const contourLevels: number[] = [];
    for (let h = contourStep; h <= maxHeight + contourStep; h += contourStep) {
      contourLevels.push(h);
    }
    this.terrainContours = traceContours(fields.height, grid.n, contourLevels);
    this.cloudCanvas = document.createElement('canvas');
    this.rainCanvas = document.createElement('canvas');
    this.tempCanvas = document.createElement('canvas');
    this.cloudCanvas.width = this.cloudCanvas.height = grid.n;
    this.rainCanvas.width = this.rainCanvas.height = grid.n;
    this.tempCanvas.width = this.tempCanvas.height = grid.n;
    this.layers = { pressure: true, wind: true, cloud: true, rain: true, temp: false, terrain: true };
    this.bind();
    // 新关卡会复用同一块 canvas：尺寸没变时 resize() 会提前返回，
    // 必须强制重新 fit，否则新 Projection 的 width/height 仍是 1，
    // 地图会缩到左上角（用户看到的“右上角小块”）。
    this.resize(true);
  }

  setFrame(frame: Frame): void {
    this.frame = frame;
    this.dirty = true;
    // 新帧直接绘制，避免后台标签页或截图环境里 rAF 被推迟。
    this.draw();
  }

  setHistory(frames: readonly Frame[]): void {
    this.history = frames;
  }

  setLayers(layers: MapLayers): void {
    this.layers = layers;
    this.invalidate();
  }

  setGhost(ghost: MapGhost | null): void {
    this.ghost = ghost;
    if (!ghost) this.ghostPoint = null;
    this.canvas.style.cursor = ghost ? 'crosshair' : this.dragging ? 'grabbing' : 'grab';
    this.invalidate();
  }

  /** 键盘 / 默认落点：没有指针时也能显示 ghost。 */
  setGhostPoint(point: { xKm: number; yKm: number } | null): void {
    this.ghostPoint = point
      ? {
          xKm: clamp(point.xKm, 0, this.scene.domainKm),
          yKm: clamp(point.yKm, 0, this.scene.domainKm),
        }
      : null;
    if (this.ghost) this.invalidate();
  }

  getGhostPoint(): { xKm: number; yKm: number } | null {
    return this.ghostPoint ? { ...this.ghostPoint } : null;
  }

  setSelectedStation(id: string | null): void {
    this.selectedStation = id;
    this.invalidate();
  }

  resize(force = false): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(300, Math.round(rect.width));
    const height = Math.max(300, Math.round(rect.height));
    const same =
      this.canvas.width === Math.round(width * this.dpr) &&
      this.canvas.height === Math.round(height * this.dpr);
    if (same && !force) return;
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    const designedAspect = this.scene.map?.aspect;
    const cover =
      document.body.classList.contains('v2-focus-map') ||
      (typeof designedAspect === 'number' && Math.abs(designedAspect - 1) > 0.02);
    this.projection.fit(width, height, cover);
    if (this.frame) this.draw();
    else this.invalidate();
  }

  resetView(): void {
    this.projection.reset();
    this.invalidate();
  }

  invalidate(): void {
    this.dirty = true;
    if (document.hidden) {
      this.draw();
      return;
    }
    if (this.rafId) return;
    this.rafId = window.requestAnimationFrame(() => {
      this.rafId = 0;
      if (this.dirty) this.draw();
    });
  }

  destroy(): void {
    if (this.rafId) window.cancelAnimationFrame(this.rafId);
    this.unbind();
  }

  // ── 绘制 ────────────────────────────────────────────────────────────────

  private draw(): void {
    this.dirty = false;
    const frame = this.frame;
    if (!frame) return;
    const ctx = this.ctx;
    const width = this.canvas.width / this.dpr;
    const height = this.canvas.height / this.dpr;

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#060b10';
    ctx.fillRect(0, 0, width, height);

    this.drawRaster(ctx, this.terrain);
    this.drawCoastline(ctx);
    if (this.layers.terrain) this.drawTerrainContours(ctx);
    if (this.layers.temp) this.drawTemp(ctx, frame);
    this.drawGraticule(ctx, 0.55);
    this.drawMapLabels(ctx);
    if (this.layers.cloud) this.drawCloud(ctx, frame);
    if (this.layers.rain) this.drawRain(ctx, frame);
    if (this.layers.pressure) this.drawPressure(ctx, frame);
    if (this.layers.wind) this.drawWind(ctx, frame);
    this.drawTracks(ctx, frame);
    if (this.layers.pressure) this.drawCenters(ctx, frame);
    this.drawStations(ctx, frame);
    this.drawFrame(ctx);
    this.drawNeatline(ctx, width, height);
    if (this.ghost && (this.ghostPoint ?? this.pointerKm)) this.drawGhost(ctx);
    ctx.restore();
  }

  private drawRaster(ctx: CanvasRenderingContext2D, source: HTMLCanvasElement): void {
    const p0 = this.projection.toScreen(0, 0);
    const p1 = this.projection.toScreen(this.scene.domainKm, this.scene.domainKm);
    const w = p1.x - p0.x;
    const h = p0.y - p1.y;
    if (w <= 0 || h <= 0) return;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(p0.x, p0.y);
    ctx.scale(1, -1);
    ctx.drawImage(source, 0, 0, w, h);
    ctx.restore();
  }

  private drawNeatline(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const inset = 7.5;
    ctx.save();
    ctx.strokeStyle = 'rgba(148,198,198,0.28)';
    ctx.lineWidth = 1;
    ctx.strokeRect(inset, inset, width - inset * 2, height - inset * 2);
    ctx.strokeStyle = 'rgba(148,198,198,0.42)';
    const tick = 6;
    const corners: [number, number, number, number][] = [
      [inset, inset, 1, 1],
      [width - inset, inset, -1, 1],
      [inset, height - inset, 1, -1],
      [width - inset, height - inset, -1, -1],
    ];
    for (const [x, y, dx, dy] of corners) {
      ctx.beginPath();
      ctx.moveTo(x + dx * tick, y);
      ctx.lineTo(x, y);
      ctx.lineTo(x, y + dy * tick);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawTerrainContours(ctx: CanvasRenderingContext2D): void {
    if (this.terrainContours.length === 0) return;
    // 河谷靠地貌明暗和轴向注记表达；程序化等高线在长谷里会变成规则波纹，
    // 反而盖住谷底，所以只在山地、盆地和平原保留等高线。
    if (this.scene.terrain.kind === 'valley') return;
    const dx = this.scene.domainKm / this.grid.n;
    const zoom = this.projection.zoom;
    // 全图视角保持轻：等高线只作辅助，不能盖过地貌本身的明暗。
    const opacity = clamp(0.12 + (zoom - 1) * 0.16, 0.12, 0.38);
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const contour of this.terrainContours) {
      const major = contour.value % 500 === 0;
      ctx.strokeStyle = `rgba(22,44,34,${opacity * (major ? 1.15 : 0.6)})`;
      ctx.lineWidth = major ? 1.05 : 0.7;
      ctx.beginPath();
      contour.points.forEach((point, index) => {
        const s = this.projection.toScreen((point.x + 0.5) * dx, (point.y + 0.5) * dx);
        if (index === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawCoastline(ctx: CanvasRenderingContext2D): void {
    const contours = traceContours(this.coastField, this.grid.n, [0.5]);
    if (contours.length === 0) return;
    const dx = this.scene.domainKm / this.grid.n;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // 先压一圈暗线，再叠亮线：海岸线在浅水和深色陆地上都能读出来。
    ctx.strokeStyle = 'rgba(4,12,17,0.72)';
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    for (const contour of contours) {
      contour.points.forEach((point, index) => {
        const s = this.projection.toScreen((point.x + 0.5) * dx, (point.y + 0.5) * dx);
        if (index === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(150,202,216,0.66)';
    ctx.lineWidth = 1.3;
    ctx.stroke();
    ctx.restore();
  }

  private drawGraticule(ctx: CanvasRenderingContext2D, scale = 1): void {
    const scene = this.scene;
    const domain = scene.domainKm;
    const kmPerDeg = 111.32;
    const latSpan = domain / kmPerDeg;
    const lonSpan = latSpan / Math.max(0.25, Math.cos((scene.centerLat * Math.PI) / 180));
    const stepLat = latSpan > 4.5 ? 1 : 0.5;
    const stepLon = lonSpan > 5.5 ? 2 : 1;

    ctx.save();
    ctx.strokeStyle = `rgba(180,212,228,${0.055 * scale})`;
    ctx.fillStyle = `rgba(170,200,216,${0.62 * scale})`;
    ctx.lineWidth = 1;
    ctx.font = '10px "JetBrains Mono", monospace';
    const top = scene.centerLat + latSpan / 2;
    const firstLat = Math.ceil((top - latSpan) / stepLat) * stepLat;
    for (let lat = firstLat; lat <= top + 1e-6; lat += stepLat) {
      const yKm = domain / 2 + (lat - scene.centerLat) * kmPerDeg;
      if (yKm < 0 || yKm > domain) continue;
      const a = this.projection.toScreen(0, yKm);
      const b = this.projection.toScreen(domain, yKm);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.fillText(`${lat.toFixed(0)}°N`, a.x + 6, a.y - 4);
    }
    const left = scene.centerLon - lonSpan / 2;
    const firstLon = Math.ceil(left / stepLon) * stepLon;
    for (let lon = firstLon; lon <= scene.centerLon + lonSpan / 2; lon += stepLon) {
      const xKm =
        domain / 2 +
        (lon - scene.centerLon) * kmPerDeg * Math.cos((scene.centerLat * Math.PI) / 180);
      if (xKm < 0 || xKm > domain) continue;
      const a = this.projection.toScreen(xKm, 0);
      const b = this.projection.toScreen(xKm, domain);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** 地图设计注记：区域名、山脉、水系、隘口。只画在底图上，不遮挡天气层。 */
  private drawMapLabels(ctx: CanvasRenderingContext2D): void {
    const design = this.scene.map;
    if (!design) return;
    const domain = this.scene.domainKm;
    const width = this.canvas.width / this.dpr;
    const height = this.canvas.height / this.dpr;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const label of design.labels ?? []) {
      const s = this.projection.toScreen(label.u * domain, label.v * domain);
      if (s.x < 18 || s.x > width - 18 || s.y < 18 || s.y > height - 18) continue;
      const kind = label.kind ?? 'region';
      const color =
        kind === 'water'
          ? 'rgba(150,214,226,0.94)'
          : kind === 'pass'
            ? 'rgba(244,192,116,0.96)'
            : kind === 'range'
              ? 'rgba(228,234,224,0.9)'
              : 'rgba(214,222,210,0.88)';
      ctx.font =
        kind === 'range'
          ? 'italic 12.5px "Noto Serif SC", "Songti SC", serif'
          : '600 12.5px "Noto Sans SC", system-ui, sans-serif';
      ctx.fillStyle = color;
      // 先描一圈暗边再填字，避免文字直接落在绿色底图上时发虚。
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(4,11,15,0.62)';
      ctx.strokeText(label.text, s.x, s.y);
      ctx.fillText(label.text, s.x, s.y);
      if (kind === 'pass') {
        ctx.beginPath();
        ctx.moveTo(s.x - 3, s.y + 8);
        ctx.lineTo(s.x + 3, s.y + 8);
        ctx.lineTo(s.x, s.y + 12);
        ctx.closePath();
        ctx.fillStyle = 'rgba(240,186,108,0.55)';
        ctx.fill();
      } else if (kind === 'range') {
        ctx.strokeStyle = 'rgba(210,220,208,0.32)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(s.x - 12, s.y + 8);
        ctx.lineTo(s.x + 12, s.y + 8);
        ctx.stroke();
      }
    }
    // 图幅名放在底部中央，像一张天气图的图名。
    if (design.region) {
      ctx.textAlign = 'center';
      ctx.font = '600 11.5px "JetBrains Mono", "Noto Sans SC", monospace';
      ctx.fillStyle = 'rgba(208,224,226,0.78)';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(4,11,15,0.55)';
      ctx.strokeText(design.region, width / 2, height - 12);
      ctx.fillText(design.region, width / 2, height - 12);
    }
    ctx.restore();
  }

  private drawTemp(ctx: CanvasRenderingContext2D, frame: Frame): void {
    const n = this.grid.n;
    const c = this.tempCanvas.getContext('2d');
    if (!c) return;
    const field = new Float32Array(n * n);
    let min = Infinity;
    let max = -Infinity;
    for (let k = 0; k < n * n; k += 1) {
      field[k] = this.scene.baseTempC + frame.temp[k];
      if (field[k] < min) min = field[k];
      if (field[k] > max) max = field[k];
    }

    const image = c.createImageData(n, n);
    const data = image.data;
    for (let k = 0; k < n * n; k += 1) {
      const t = field[k];
      const color = ramp(TEMP_RAMP, t);
      const p = k * 4;
      data[p] = color[0];
      data[p + 1] = color[1];
      data[p + 2] = color[2];
      data[p + 3] = Math.round((0.05 + 0.07 * clamp((t - 5) / 25, 0, 1)) * 255);
    }
    c.putImageData(image, 0, 0);
    this.drawRaster(ctx, this.tempCanvas);

    // 温度层显示实际气温等温线；小温差时至少间隔 2℃，避免整张图铺满细线。
    const interval = max - min <= 10 ? 2 : 4;
    const contours = traceContours(field, n, contourLevels(min, max, interval));
    if (contours.length === 0) return;
    const dx = this.scene.domainKm / n;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const contour of contours) {
      const warm = contour.value >= 22;
      const cool = contour.value <= 10;
      ctx.strokeStyle = warm
        ? 'rgba(224,154,104,0.3)'
        : cool
          ? 'rgba(116,176,224,0.28)'
          : 'rgba(198,202,170,0.22)';
      ctx.lineWidth = Math.round(contour.value) % 8 === 0 ? 1.25 : 0.9;
      ctx.beginPath();
      contour.points.forEach((point, index) => {
        const s = this.projection.toScreen((point.x + 0.5) * dx, (point.y + 0.5) * dx);
        if (index === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      ctx.stroke();
    }

    ctx.font = '600 10.5px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const labeled = new Map<number, (typeof contours)[number]>();
    for (const contour of contours) {
      if (contour.points.length < 22) continue;
      const key = Math.round(contour.value);
      const current = labeled.get(key);
      if (!current || contour.points.length > current.points.length) labeled.set(key, contour);
    }
    for (const contour of labeled.values()) {
      const mid = Math.floor(contour.points.length / 2);
      const point = contour.points[mid];
      const s = this.projection.toScreen((point.x + 0.5) * dx, (point.y + 0.5) * dx);
      const text = `${Math.round(contour.value)}℃`;
      const w = ctx.measureText(text).width + 7;
      ctx.fillStyle = 'rgba(6,12,18,0.82)';
      ctx.fillRect(s.x - w / 2, s.y - 6, w, 12);
      ctx.fillStyle =
        contour.value >= 22
          ? 'rgba(238,190,150,0.9)'
          : contour.value <= 10
            ? 'rgba(170,212,240,0.9)'
            : 'rgba(220,224,202,0.88)';
      ctx.fillText(text, s.x, s.y + 0.4);
    }
    ctx.restore();
  }

  private drawCloud(ctx: CanvasRenderingContext2D, frame: Frame): void {
    const n = this.grid.n;
    const c = this.cloudCanvas.getContext('2d');
    if (!c) return;
    const image = c.createImageData(n, n);
    const data = image.data;
    for (let k = 0; k < n * n; k += 1) {
      const cc = clamp(frame.cloud[k] / 0.4, 0, 1);
      const p = k * 4;
      if (cc < 0.055) {
        data[p + 3] = 0;
        continue;
      }
      const alpha = Math.pow(cc, 1.35) * 0.36;
      const i = k % n;
      const j = (k / n) | 0;
      // 只做显示羽化：场本身不裁，靠近图边时渐隐，避免云区被切出一条直边。
      const feather = 0.16 + 0.84 * smoothstep(0, 7, Math.min(i, j, n - 1 - i, n - 1 - j));
      data[p] = 216;
      data[p + 1] = 228;
      data[p + 2] = 238;
      data[p + 3] = Math.round(alpha * feather * 255);
    }
    c.putImageData(image, 0, 0);
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    this.drawRaster(ctx, this.cloudCanvas);
    ctx.restore();
  }

  private drawRain(ctx: CanvasRenderingContext2D, frame: Frame): void {
    const n = this.grid.n;
    const c = this.rainCanvas.getContext('2d');
    if (!c) return;
    const image = c.createImageData(n, n);
    const data = image.data;
    let any = false;
    for (let k = 0; k < n * n; k += 1) {
      const rate = frame.precipRate[k];
      const p = k * 4;
      if (rate < 0.15) {
        data[p + 3] = 0;
        continue;
      }
      any = true;
      const phase = dominantPhase({
        rain: frame.rainRate?.[k] ?? rate,
        sleet: frame.sleetRate?.[k] ?? 0,
        snow: frame.snowRate?.[k] ?? 0,
        freezingRain: frame.freezingRainRate?.[k] ?? 0,
        hail: frame.hailRate?.[k] ?? 0,
      });
      const soft = clamp((rate - 0.15) / 1.1, 0, 1);
      const color = precipColor(rate, phase);
      const alpha = (0.12 + 0.5 * clamp(rate / 12, 0, 1)) * (0.3 + 0.7 * soft);
      const i = k % n;
      const j = (k / n) | 0;
      // 与云同理：雨区可以真实抵达图边，但显示在最后 7 格羽化，
      // 不会出现“贴边一刀切”的直线雨。
      const feather = 0.16 + 0.84 * smoothstep(0, 7, Math.min(i, j, n - 1 - i, n - 1 - j));
      data[p] = color[0];
      data[p + 1] = color[1];
      data[p + 2] = color[2];
      data[p + 3] = Math.round(alpha * feather * 255);
    }
    c.putImageData(image, 0, 0);
    if (any) this.drawRaster(ctx, this.rainCanvas);
  }

  private drawPressure(ctx: CanvasRenderingContext2D, frame: Frame): void {
    const n = this.grid.n;
    const dx = this.scene.domainKm / n;
    const levels = contourLevels(frame.stats.minP, frame.stats.maxP, 4);
    if (levels.length === 0) return;
    const contours = traceContours(frame.pressure, n, levels);

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const contour of contours) {
      const major = Math.round(contour.value) % 8 === 0;
      const color =
        contour.value <= 0
          ? `rgba(124,196,224,${major ? 0.72 : 0.42})`
          : `rgba(211,179,148,${major ? 0.66 : 0.38})`;
      ctx.strokeStyle = color;
      ctx.lineWidth = major ? 1.6 : 1;
      ctx.beginPath();
      contour.points.forEach((point, index) => {
        const s = this.projection.toScreen((point.x + 0.5) * dx, (point.y + 0.5) * dx);
        if (index === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      ctx.stroke();
    }

    // 每隔 8 hPa 标注一次；同一数值只标最长的一条，避免边界上
    // 多条同值等压线重复堆字。文字底下垫底色，避免与线条打结。
    ctx.font = '600 10.5px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const labeled = new Map<number, (typeof contours)[number]>();
    for (const contour of contours) {
      if (Math.round(contour.value) % 8 !== 0) continue;
      if (contour.points.length < 22) continue;
      const key = Math.round(contour.value);
      const current = labeled.get(key);
      if (!current || contour.points.length > current.points.length) labeled.set(key, contour);
    }
    for (const contour of labeled.values()) {
      const points = contour.points;
      const mid = Math.floor(points.length / 2);
      const p0 = points[mid];
      const p1 = points[Math.min(points.length - 1, mid + 2)];
      const s0 = this.projection.toScreen((p0.x + 0.5) * dx, (p0.y + 0.5) * dx);
      const s1 = this.projection.toScreen((p1.x + 0.5) * dx, (p1.y + 0.5) * dx);
      if (Math.hypot(s1.x - s0.x, s1.y - s0.y) < 0.01) continue;
      let angle = Math.atan2(s1.y - s0.y, s1.x - s0.x);
      if (angle > Math.PI / 2) angle -= Math.PI;
      if (angle < -Math.PI / 2) angle += Math.PI;
      const text = `${Math.round(absolutePressureHpa(contour.value))}`;
      ctx.save();
      ctx.translate(s0.x, s0.y);
      ctx.rotate(angle);
      const w = ctx.measureText(text).width + 6;
      ctx.fillStyle = 'rgba(6,12,18,0.82)';
      ctx.fillRect(-w / 2, -5.5, w, 11);
      ctx.fillStyle = contour.value <= 0 ? 'rgba(178,220,238,0.82)' : 'rgba(226,204,178,0.82)';
      ctx.fillText(text, 0, 0.4);
      ctx.restore();
    }
    ctx.restore();
  }

  private drawWind(ctx: CanvasRenderingContext2D, frame: Frame): void {
    const n = this.grid.n;
    const step = Math.max(4, Math.round(n / 18));
    ctx.save();
    ctx.lineCap = 'round';
    for (let j = Math.floor(step / 2); j < n; j += step) {
      for (let i = Math.floor(step / 2); i < n; i += step) {
        const k = this.grid.idx(i, j);
        const u = frame.u[k];
        const v = frame.v[k];
        const speed = Math.hypot(u, v);
        if (speed < 0.5) continue;
        const s = this.projection.toScreen(this.grid.xKm(i), this.grid.yKm(j));
        if (
          s.x < -20 ||
          s.y < -20 ||
          s.x > this.canvas.width / this.dpr + 20 ||
          s.y > this.canvas.height / this.dpr + 20
        ) {
          continue;
        }
        const len = 8 + Math.min(speed, 30) * 0.66;
        const angle = Math.atan2(v, u);
        const dx = Math.cos(angle);
        const dy = -Math.sin(angle);
        ctx.strokeStyle = windColor(speed);
        ctx.lineWidth = speed > 18 ? 2 : 1.4;
        ctx.beginPath();
        ctx.moveTo(s.x - dx * len * 0.5, s.y - dy * len * 0.5);
        ctx.lineTo(s.x + dx * len * 0.5, s.y + dy * len * 0.5);
        ctx.stroke();
        // 箭头
        const tipX = s.x + dx * len * 0.5;
        const tipY = s.y + dy * len * 0.5;
        const a = Math.atan2(dy, dx);
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - Math.cos(a - 0.45) * 5.6, tipY - Math.sin(a - 0.45) * 5.6);
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - Math.cos(a + 0.45) * 5.6, tipY - Math.sin(a + 0.45) * 5.6);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawTracks(ctx: CanvasRenderingContext2D, frame: Frame): void {
    const until = frame.hour;
    const lows: { x: number; y: number }[] = [];
    const highs: { x: number; y: number }[] = [];
    for (const f of this.history) {
      if (f.hour > until) break;
      const low = pickCenter(f, 'L');
      const high = pickCenter(f, 'H');
      if (low) lows.push(this.projection.toScreen(low.xKm, low.yKm));
      if (high) highs.push(this.projection.toScreen(high.xKm, high.yKm));
    }
    const draw = (points: { x: number; y: number }[], color: string) => {
      if (points.length < 2) return;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
      for (const point of points) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    };
    draw(lows, 'rgba(124,200,230,0.36)');
    draw(highs, 'rgba(226,178,124,0.3)');
  }

  private drawCenters(ctx: CanvasRenderingContext2D, frame: Frame): void {
    for (const center of frame.centers) {
      const s = this.projection.toScreen(center.xKm, center.yKm);
      const isLow = center.type === 'L';
      const color = isLow ? '#83cfe6' : '#e3b07a';
      const radiusPx = Math.min(
        (center.radiusKm * this.projection.scale) / 2,
        this.canvas.width / this.dpr / 2.4,
      );
      ctx.save();
      ctx.strokeStyle = isLow ? 'rgba(124,200,230,0.26)' : 'rgba(226,176,122,0.24)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 5]);
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(18, radiusPx), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = 'rgba(6,12,18,0.82)';
      ctx.beginPath();
      ctx.arc(s.x, s.y, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.3;
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '700 14px "Noto Sans SC", sans-serif';
      ctx.fillText(center.type, s.x, s.y + 0.5);

      const label = `${Math.round(absolutePressureHpa(center.value))} hPa`;
      ctx.font = '600 10.5px "JetBrains Mono", monospace';
      const w = ctx.measureText(label).width + 9;
      ctx.fillStyle = 'rgba(6,12,18,0.84)';
      this.roundRect(ctx, s.x - w / 2, s.y + 14, w, 14, 3);
      ctx.fill();
      ctx.fillStyle = 'rgba(218,232,240,0.92)';
      ctx.fillText(label, s.x, s.y + 21.2);
      ctx.restore();
    }
  }

  private drawStations(ctx: CanvasRenderingContext2D, frame: Frame): void {
    const width = this.canvas.width / this.dpr;
    const height = this.canvas.height / this.dpr;
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    for (const site of Object.values(frame.sites)) {
      const s = this.projection.toScreen(site.xKm, site.yKm);
      const selected = this.selectedStation === site.id;
      const color = site.marine ? '#8cc9de' : '#dbe8ef';
      ctx.save();
      if (selected) {
        ctx.strokeStyle = 'rgba(131,211,230,0.85)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 10.5, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (site.marine) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y - 5);
        ctx.lineTo(s.x + 5, s.y + 4);
        ctx.lineTo(s.x - 5, s.y + 4);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillStyle = 'rgba(7,13,19,0.92)';
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 4.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      const label = site.name;
      const value = `${Math.round(absolutePressureHpa(site.p))} hPa · ${site.t2m.toFixed(1)}℃`;
      ctx.font = '600 11.5px "Noto Sans SC", sans-serif';
      const nameW = ctx.measureText(label).width;
      ctx.font = '600 10.5px "JetBrains Mono", monospace';
      const valueW = ctx.measureText(value).width;
      const w = nameW + valueW + 19;
      const h = 19;
      const right = { x: s.x + 9, y: s.y - 21, w, h };
      const left = { x: s.x - w - 9, y: s.y - 21, w, h };
      const rightBelow = { x: s.x + 9, y: s.y + 10, w, h };
      const leftBelow = { x: s.x - w - 9, y: s.y + 10, w, h };
      const above = { x: s.x - w / 2, y: s.y - 35, w, h };
      const below = { x: s.x - w / 2, y: s.y + 13, w, h };
      const order =
        s.x > width * 0.68
          ? [left, right, leftBelow, rightBelow, above, below]
          : [right, left, rightBelow, leftBelow, above, below];
      const box =
        order.find(
          (candidate) =>
            candidate.x >= 4 &&
            candidate.y >= 4 &&
            candidate.x + candidate.w <= width - 4 &&
            candidate.y + candidate.h <= height - 4 &&
            !placed.some(
              (other) =>
                candidate.x < other.x + other.w + 2 &&
                candidate.x + candidate.w + 2 > other.x &&
                candidate.y < other.y + other.h + 2 &&
                candidate.y + candidate.h + 2 > other.y,
            ),
        ) ?? right;
      placed.push(box);

      const nearX = clamp(s.x, box.x, box.x + box.w);
      const nearY = clamp(s.y, box.y, box.y + box.h);
      if (Math.hypot(nearX - s.x, nearY - s.y) > 12) {
        ctx.strokeStyle = selected ? 'rgba(131,211,230,0.5)' : 'rgba(160,192,208,0.28)';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(nearX, nearY);
        ctx.stroke();
      }

      ctx.fillStyle = selected ? 'rgba(17,38,49,0.94)' : 'rgba(6,12,18,0.8)';
      ctx.strokeStyle = selected ? 'rgba(131,211,230,0.42)' : 'rgba(160,192,208,0.18)';
      ctx.lineWidth = 1;
      this.roundRect(ctx, box.x, box.y, box.w, box.h, 4);
      ctx.fill();
      ctx.stroke();

      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = '600 11.5px "Noto Sans SC", sans-serif';
      ctx.fillStyle = 'rgba(228,239,244,0.96)';
      ctx.fillText(label, box.x + 6, box.y + 9.5);

      ctx.font = '600 10.5px "JetBrains Mono", monospace';
      ctx.fillStyle = site.p <= -6 ? 'rgba(140,208,232,0.96)' : site.p >= 6 ? 'rgba(230,186,132,0.96)' : 'rgba(202,220,228,0.94)';
      ctx.fillText(value, box.x + 6 + nameW + 6, box.y + 9.5);
      ctx.restore();
    }
  }

  private drawFrame(ctx: CanvasRenderingContext2D): void {
    const a = this.projection.toScreen(0, this.scene.domainKm);
    const b = this.projection.toScreen(this.scene.domainKm, 0);
    const w = b.x - a.x;
    const h = b.y - a.y;
    ctx.save();
    ctx.strokeStyle = 'rgba(150,186,204,0.2)';
    ctx.lineWidth = 1;
    ctx.strokeRect(a.x + 0.5, a.y + 0.5, w - 1, h - 1);
    ctx.strokeStyle = 'rgba(160,198,214,0.5)';
    const tick = 9;
    const corners: [number, number, number, number][] = [
      [a.x, a.y, 1, 1],
      [b.x, a.y, -1, 1],
      [a.x, b.y, 1, -1],
      [b.x, b.y, -1, -1],
    ];
    for (const [x, y, sx, sy] of corners) {
      ctx.beginPath();
      ctx.moveTo(x + sx * tick, y);
      ctx.lineTo(x, y);
      ctx.lineTo(x, y + sy * tick);
      ctx.stroke();
    }

    // 比例尺
    const scale = this.projection.scale;
    const km = scale > 1.15 ? 100 : 200;
    const px = km * scale;
    const x0 = a.x + 16;
    const y0 = b.y - 18;
    ctx.strokeStyle = 'rgba(206,226,236,0.62)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + px, y0);
    ctx.moveTo(x0, y0 - 3);
    ctx.lineTo(x0, y0 + 3);
    ctx.moveTo(x0 + px, y0 - 3);
    ctx.lineTo(x0 + px, y0 + 3);
    ctx.stroke();
    ctx.fillStyle = 'rgba(204,222,230,0.8)';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${km} km`, x0, y0 - 4);
    ctx.restore();
  }

  private drawGhost(ctx: CanvasRenderingContext2D): void {
    const point = this.ghostPoint ?? this.pointerKm;
    if (!this.ghost || !point) return;
    const s = this.projection.toScreen(point.xKm, point.yKm);
    const sigmaKm = this.scene.domainKm / 6;
    const scale = this.projection.scale;
    const color =
      this.ghost.family === 'low'
        ? 'rgba(124,204,232,'
        : this.ghost.family === 'high'
          ? 'rgba(229,181,124,'
          : 'rgba(212,234,244,';
    ctx.save();
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = `${color}0.78)`;
    ctx.lineWidth = 1.3;

    if (this.ghost.family === 'jet') {
      const rad = (((this.ghost.directionDeg ?? 90) - 90) * Math.PI) / 180;
      const len = sigmaKm * 1.9 * scale;
      const wid = sigmaKm * 0.5 * scale;
      ctx.beginPath();
      ctx.ellipse(s.x, s.y, len, wid, rad, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      const dx = Math.cos(rad);
      const dy = Math.sin(rad);
      const tipX = s.x + dx * len * 0.62;
      const tipY = s.y + dy * len * 0.62;
      const tailX = s.x - dx * len * 0.62;
      const tailY = s.y - dy * len * 0.62;
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(tipX, tipY);
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - dx * 9 - dy * 5, tipY - dy * 9 + dx * 5);
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - dx * 9 + dy * 5, tipY - dy * 9 - dx * 5);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(s.x, s.y, sigmaKm * 1.45 * scale, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = `${color}0.14)`;
      ctx.fill();
      ctx.fillStyle = `${color}0.94)`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '700 17px "Noto Sans SC", sans-serif';
      ctx.fillText(this.ghost.family === 'low' ? 'L' : 'H', s.x, s.y + 0.5);
    }

    // 跟随指针的卡片标签
    ctx.setLineDash([]);
    ctx.font = '600 10.5px "Noto Sans SC", sans-serif';
    const text = this.ghost.label;
    const w = ctx.measureText(text).width + 14;
    const bx = s.x + 12;
    const by = s.y - 30;
    ctx.fillStyle = 'rgba(6,13,19,0.9)';
    ctx.strokeStyle = `${color}0.5)`;
    ctx.lineWidth = 1;
    this.roundRect(ctx, bx, by, w, 19, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = `${color}0.96)`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + 7, by + 9.7);
    ctx.restore();
  }

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): void {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  // ── 交互 ────────────────────────────────────────────────────────────────

  private bind(): void {
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('dblclick', this.onDoubleClick);
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
  }

  private unbind(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('dblclick', this.onDoubleClick);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
  }

  private localPoint(event: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    this.canvas.setPointerCapture(event.pointerId);
    this.dragging = true;
    this.dragMoved = false;
    this.lastPointer = this.localPoint(event);
    this.canvas.style.cursor = 'grabbing';
  };

  private onPointerMove = (event: PointerEvent): void => {
    const point = this.localPoint(event);
    const world = this.projection.toKm(point.x, point.y);
    this.pointerKm = {
      xKm: clamp(world.xKm, 0, this.scene.domainKm),
      yKm: clamp(world.yKm, 0, this.scene.domainKm),
    };
    this.hoverScreen = point;

    if (this.dragging) {
      const dx = point.x - this.lastPointer.x;
      const dy = point.y - this.lastPointer.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) this.dragMoved = true;
      if (this.dragMoved) {
        this.projection.panBy(dx, dy);
        this.lastPointer = point;
        this.invalidate();
      }
    }

    this.emitHover();
    if (this.ghost) {
      this.ghostPoint = { ...this.pointerKm };
      this.invalidate();
    }
  };

  private onPointerUp = (event: PointerEvent): void => {
    const point = this.localPoint(event);
    this.dragging = false;
    this.canvas.style.cursor = this.ghost ? 'crosshair' : 'grab';
    if (this.dragMoved) {
      this.dragMoved = false;
      return;
    }
    const world = this.projection.toKm(point.x, point.y);
    if (
      world.xKm < 0 ||
      world.yKm < 0 ||
      world.xKm > this.scene.domainKm ||
      world.yKm > this.scene.domainKm
    ) {
      return;
    }
    this.callbacks.onCanvasClick?.(world.xKm, world.yKm);
  };

  private onPointerLeave = (): void => {
    this.pointerKm = null;
    this.hoverScreen = null;
    this.canvas.style.cursor = this.ghost ? 'crosshair' : 'grab';
    this.callbacks.onHover?.(null);
    this.invalidate();
  };

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const point = this.localPoint(event);
    const factor = event.deltaY > 0 ? 0.88 : 1.12;
    this.projection.zoomAt(point.x, point.y, factor);
    this.invalidate();
  };

  private onDoubleClick = (): void => {
    this.projection.reset();
    this.invalidate();
  };

  private onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private emitHover(): void {
    const frame = this.frame;
    if (!frame || !this.pointerKm || !this.hoverScreen) return;
    const { xKm, yKm } = this.pointerKm;
    const u = this.grid.sample(frame.u, xKm, yKm);
    const v = this.grid.sample(frame.v, xKm, yKm);
    const windSpeed = Math.hypot(u, v);
    const t = this.scene.baseTempC + this.grid.sample(frame.temp, xKm, yKm);
    const q = this.grid.sample(frame.humidity, xKm, yKm);
    const rh = relativeHumidity(q, t);
    const n = this.grid.n;
    const ix = clamp(Math.floor(xKm / this.grid.dxKm), 0, n - 1);
    const iy = clamp(Math.floor(yKm / this.grid.dxKm), 0, n - 1);
    if (!this.tempField64 || this.tempField64.length !== frame.temp.length) {
      this.tempField64 = new Float64Array(frame.temp.length);
    }
    if (this.tempFieldFrame !== frame) {
      this.tempField64.set(frame.temp);
      this.tempFieldFrame = frame;
    }
    const tempAdvectionKPerH =
      -(
        u * this.grid.dfdx(this.tempField64, ix, iy) +
        v * this.grid.dfdy(this.tempField64, ix, iy)
      ) * 3600;
    this.callbacks.onHover?.({
      xKm,
      yKm,
      p: absolutePressureHpa(this.grid.sample(frame.pressure, xKm, yKm)),
      t,
      apparent: apparentTemperatureC(t, rh, windSpeed),
      tempAdvectionKPerH,
      rh,
      wind: windSpeed,
      cc: clamp(this.grid.sample(frame.cloud, xKm, yKm) / 0.4, 0, 1),
      rain: this.grid.sample(frame.precipRate, xKm, yKm),
      phase: phaseLabel(
        dominantPhase({
          rain: this.grid.sample(frame.rainRate, xKm, yKm),
          sleet: this.grid.sample(frame.sleetRate, xKm, yKm),
          snow: this.grid.sample(frame.snowRate, xKm, yKm),
          freezingRain: this.grid.sample(frame.freezingRainRate, xKm, yKm),
          hail: this.grid.sample(frame.hailRate, xKm, yKm),
        }),
      ),
      pwMm: this.grid.sample(frame.pwMm, xKm, yKm),
      t850: frame.layerT850 ? this.grid.sample(frame.layerT850, xKm, yKm) : Number.NaN,
      t500: frame.layerT500 ? this.grid.sample(frame.layerT500, xKm, yKm) : Number.NaN,
      screenX: this.hoverScreen.x,
      screenY: this.hoverScreen.y,
    });
  }
}

function pickCenter(frame: Frame, type: 'L' | 'H') {
  let best: Frame['centers'][number] | null = null;
  for (const center of frame.centers) {
    if (center.type !== type) continue;
    if (!best || Math.abs(center.value) > Math.abs(best.value)) best = center;
  }
  return best;
}

