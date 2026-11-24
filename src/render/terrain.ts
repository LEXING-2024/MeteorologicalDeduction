import { CONTENT_SCALE, MAP_SIZE } from '../config/constants';
import { REAL_TERRAIN } from '../config/realTerrain';
import type { TerrainProfile } from '../logic/types';

interface TerrainPeak {
  x: number;
  y: number;
  amplitude: number;
  rx: number;
  ry: number;
  rotation: number;
}

const DEFAULT_PEAKS: TerrainPeak[] = [
  { x: 116, y: 214, amplitude: 2380, rx: 120, ry: 76, rotation: -0.28 },
  { x: 205, y: 390, amplitude: 1480, rx: 178, ry: 66, rotation: 0.18 },
  { x: 104, y: 582, amplitude: 1260, rx: 94, ry: 58, rotation: 0.58 },
  { x: 354, y: 554, amplitude: 860, rx: 94, ry: 44, rotation: -0.5 },
  { x: 457, y: 174, amplitude: 720, rx: 142, ry: 90, rotation: 0.12 },
  { x: 280, y: 680, amplitude: 520, rx: 130, ry: 54, rotation: 0.4 },
];

// Approximate case topography. These are deliberately simple ridge/peak
// proxies, not survey DEMs: the goal is the right side of the chart, the right
// upslope/lee and a believable scale for each historical case.
const TAIWAN_PEAKS: TerrainPeak[] = [
  { x: 620, y: 180, amplitude: 2600, rx: 95, ry: 150, rotation: -0.08 },
  { x: 680, y: 360, amplitude: 3200, rx: 85, ry: 180, rotation: 0.04 },
  { x: 650, y: 550, amplitude: 3000, rx: 90, ry: 165, rotation: -0.04 },
  { x: 600, y: 720, amplitude: 2200, rx: 105, ry: 145, rotation: 0.08 },
];

const SONGXIAN_PEAKS: TerrainPeak[] = [
  { x: 180, y: 300, amplitude: 1900, rx: 150, ry: 78, rotation: -0.2 },
  { x: 220, y: 520, amplitude: 1700, rx: 160, ry: 72, rotation: 0.18 },
  { x: 140, y: 700, amplitude: 1250, rx: 130, ry: 62, rotation: 0.4 },
  { x: 500, y: 790, amplitude: 900, rx: 120, ry: 52, rotation: 0.05 },
];

const LINGUI_PEAKS: TerrainPeak[] = [
  { x: 220, y: 300, amplitude: 720, rx: 82, ry: 55, rotation: 0.2 },
  { x: 380, y: 420, amplitude: 880, rx: 72, ry: 50, rotation: -0.3 },
  { x: 300, y: 620, amplitude: 650, rx: 92, ry: 60, rotation: 0.4 },
  { x: 620, y: 700, amplitude: 520, rx: 100, ry: 55, rotation: 0.1 },
];

const GOLMUD_PEAKS: TerrainPeak[] = [
  { x: 120, y: 820, amplitude: 3300, rx: 220, ry: 90, rotation: 0.08 },
  { x: 450, y: 850, amplitude: 3000, rx: 250, ry: 100, rotation: 0.02 },
  { x: 850, y: 700, amplitude: 2800, rx: 180, ry: 120, rotation: 0.2 },
  { x: 100, y: 200, amplitude: 2500, rx: 150, ry: 82, rotation: 0.1 },
];

const ZHENGZHOU_PEAKS: TerrainPeak[] = [
  { x: 160, y: 220, amplitude: 1550, rx: 130, ry: 80, rotation: -0.2 },
  { x: 120, y: 700, amplitude: 1350, rx: 150, ry: 70, rotation: 0.3 },
  { x: 300, y: 820, amplitude: 1050, rx: 120, ry: 60, rotation: 0.1 },
];

const PROFILES: Record<TerrainProfile, TerrainPeak[]> = {
  default: DEFAULT_PEAKS,
  taiwan: TAIWAN_PEAKS,
  songxian: SONGXIAN_PEAKS,
  lingui: LINGUI_PEAKS,
  golmud: GOLMUD_PEAKS,
  zhengzhou: ZHENGZHOU_PEAKS,
};

for (const peaks of Object.values(PROFILES)) {
  for (const peak of peaks) {
    peak.x *= CONTENT_SCALE;
    peak.y *= CONTENT_SCALE;
    peak.rx *= CONTENT_SCALE;
    peak.ry *= CONTENT_SCALE;
  }
}

const decodedTerrain = new Map<string, Int16Array>();

function realHeights(profile: TerrainProfile): Int16Array | null {
  const terrain = REAL_TERRAIN[profile];
  if (!terrain) return null;
  const cached = decodedTerrain.get(profile);
  if (cached) return cached;
  const binary = atob(terrain.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const heights = new Int16Array(terrain.n * terrain.n);
  for (let i = 0; i < heights.length; i += 1) {
    heights[i] = view.getInt16(i * 2, true);
  }
  decodedTerrain.set(profile, heights);
  return heights;
}

/** Terrain height in metres, used by the orographic and friction physics. */
export function elevationAt(
  x: number,
  y: number,
  profile: TerrainProfile = 'default',
): number {
  const real = realHeights(profile);
  if (real) {
    const terrain = REAL_TERRAIN[profile];
    const n = terrain.n;
    const fx = Math.max(0, Math.min(n - 1, (x / MAP_SIZE) * (n - 1)));
    const fy = Math.max(0, Math.min(n - 1, (y / MAP_SIZE) * (n - 1)));
    const i0 = Math.floor(fx);
    const j0 = Math.floor(fy);
    const i1 = Math.min(n - 1, i0 + 1);
    const j1 = Math.min(n - 1, j0 + 1);
    const rawX = fx - i0;
    const rawY = fy - j0;
    // Smoothstep interpolation removes the visible 2 px cell edges that plain
    // bilinear sampling leaves in hillshade and hypsometric bands.
    const tx = rawX * rawX * (3 - 2 * rawX);
    const ty = rawY * rawY * (3 - 2 * rawY);
    const a = real[j0 * n + i0];
    const b = real[j0 * n + i1];
    const c = real[j1 * n + i0];
    const d = real[j1 * n + i1];
    const value = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    return Math.max(0, value);
  }
  const peaks = PROFILES[profile] ?? DEFAULT_PEAKS;
  let height = 0;
  for (const peak of peaks) {
    const dx = x - peak.x;
    const dy = y - peak.y;
    const cos = Math.cos(peak.rotation);
    const sin = Math.sin(peak.rotation);
    const lx = dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;
    const d2 = (lx * lx) / (peak.rx * peak.rx) + (ly * ly) / (peak.ry * peak.ry);
    height += peak.amplitude * Math.exp(-1.7 * d2);
  }
  // Keep the physical field smooth; the rendered mountains come from basemap.ts.
  return Math.max(0, height);
}
