/**
 * Shared chart geography.
 *
 * The outline is deliberately coarse: this is a synoptic-scale weather chart,
 * not a topographic map.  Drawing code and surface physics read the same
 * definition so land and sea never disagree.
 *
 * Every level names a map prototype through `base.mapId`.  A prototype owns the
 * coastline, the closed land polygon and the relief hills, so two levels can
 * show genuinely different geography instead of recolouring one shared chart.
 */

import { CONTENT_SCALE } from '../config/constants';

export interface GeoPoint {
  x: number;
  y: number;
}

export type MapId = 'east-sea' | 'west-sea' | 'inland-plain' | 'coastal-range' | 'bay-delta';

export interface MapHill {
  x: number;
  y: number;
  rx: number;
  ry: number;
  seed: number;
}

export interface MapDefinition {
  id: MapId;
  label: string;
  /** Open coastline used for the stroke; null on a fully inland chart. */
  coast: GeoPoint[] | null;
  /** Closed land polygon used by the land/sea mask and the fill. */
  land: GeoPoint[];
  /** Decorative relief, also the visual cue for orographic levels. */
  hills: MapHill[];
}

/** Authored points are in the original 800-unit chart; scale them once. */
function cs(points: Array<[number, number]>): GeoPoint[] {
  return points.map(([x, y]) => ({ x: x * CONTENT_SCALE, y: y * CONTENT_SCALE }));
}

function hill(x: number, y: number, rx: number, ry: number, seed: number): MapHill {
  return {
    x: x * CONTENT_SCALE,
    y: y * CONTENT_SCALE,
    rx: rx * CONTENT_SCALE,
    ry: ry * CONTENT_SCALE,
    seed,
  };
}

/**
 * Land to the west, open sea to the east.  This is the original campaign chart
 * and stays the default for every stage that does not name a map.
 */
const EAST_SEA_COAST = cs([
  [520, -80],
  [566, 20],
  [610, 96],
  [590, 178],
  [622, 260],
  [596, 344],
  [616, 428],
  [578, 508],
  [534, 584],
  [488, 656],
  [438, 722],
  [384, 770],
  [320, 820],
]);

/**
 * Sea to the west, land to the east.  Used by the first coastal lessons so the
 * moisture source sits offshore and the city sits inland, which is the causal
 * chain the stage is teaching.
 */
const WEST_SEA_COAST = cs([
  [252, -80],
  [238, 40],
  [276, 150],
  [244, 250],
  [270, 360],
  [240, 470],
  [268, 560],
  [246, 660],
  [288, 770],
  [330, 880],
]);

/** West sea plus a mountain belt east of the coastal city: windward / lee pair. */
const RANGE_COAST = cs([
  [236, -80],
  [262, 80],
  [222, 200],
  [258, 320],
  [214, 430],
  [250, 540],
  [226, 640],
  [272, 760],
  [316, 880],
]);

/** Sea in the south-east, land in the north-west: a bay / delta chart. */
const BAY_COAST = cs([
  [940, -40],
  [820, 90],
  [852, 210],
  [740, 320],
  [780, 440],
  [660, 540],
  [700, 660],
  [580, 750],
  [620, 860],
  [520, 920],
]);

function westLand(coast: GeoPoint[]): GeoPoint[] {
  return [...coast, ...cs([[940, 920], [940, -140]])];
}

function eastLand(coast: GeoPoint[]): GeoPoint[] {
  return [...cs([[-140, -140]]), ...coast, ...cs([[-140, 920]])];
}

function northWestLand(coast: GeoPoint[]): GeoPoint[] {
  return [...cs([[-140, -140], [940, -140]]), ...coast, ...cs([[-140, 920]])];
}

const MAPS: Record<MapId, MapDefinition> = {
  'east-sea': {
    id: 'east-sea',
    label: '东岸海',
    coast: EAST_SEA_COAST,
    land: eastLand(EAST_SEA_COAST),
    // The campaign's original relief decoration, kept so the older terrain
    // lessons (sea breeze, valley breeze, lake-effect snow) look unchanged.
    hills: [hill(126, 227, 115, 63, 1.2), hill(214, 438, 126, 54, 2.7),
      hill(353, 566, 86, 38, 4.1), hill(108, 600, 82, 39, 5.2)],
  },
  'west-sea': {
    id: 'west-sea',
    label: '西岸海',
    coast: WEST_SEA_COAST,
    land: westLand(WEST_SEA_COAST),
    hills: [],
  },
  'inland-plain': {
    id: 'inland-plain',
    label: '内陆平原',
    coast: null,
    land: cs([[-140, -140], [940, -140], [940, 940], [-140, 940]]),
    hills: [],
  },
  'coastal-range': {
    id: 'coastal-range',
    label: '山地海岸',
    coast: RANGE_COAST,
    land: westLand(RANGE_COAST),
    hills: [hill(570, 430, 72, 205, 3.4), hill(610, 660, 66, 120, 5.1)],
  },
  'bay-delta': {
    id: 'bay-delta',
    label: '海湾三角洲',
    coast: BAY_COAST,
    land: northWestLand(BAY_COAST),
    hills: [],
  },
};

/** Chart used when a level does not declare one (stages 2–6 today). */
export const DEFAULT_MAP_ID: MapId = 'east-sea';

let activeMap: MapDefinition = MAPS[DEFAULT_MAP_ID];

export function getMap(id?: string): MapDefinition {
  return (id && MAPS[id as MapId]) || MAPS[DEFAULT_MAP_ID];
}

export function setActiveMap(id?: string): void {
  activeMap = getMap(id);
}

export function getActiveMap(): MapDefinition {
  return activeMap;
}

export function pointInPolygon(x: number, y: number, polygon: GeoPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    const straddles = a.y > y !== b.y > y;
    if (straddles && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

export function isLandPoint(x: number, y: number): boolean {
  return pointInPolygon(x, y, activeMap.land);
}

/**
 * Signed distance to the coastline in pixels: positive on land, negative at
 * sea.  Used to spread the land/sea thermal pressure step over a narrow
 * coastal zone instead of a hard one-pixel jump.  Inland charts have no coast,
 * so the distance is reported as far inland.
 */
export function signedCoastDistance(x: number, y: number): number {
  const coast = activeMap.coast;
  if (!coast) return 4000;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < coast.length - 1; i += 1) {
    const a = coast[i];
    const b = coast[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared > 0
      ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lengthSquared))
      : 0;
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    best = Math.min(best, Math.hypot(x - px, y - py));
  }
  return isLandPoint(x, y) ? best : -best;
}
