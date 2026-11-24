import Phaser from 'phaser';
import { COLORS, MAP_SIZE } from '../config/constants';
import { DEFAULT_MAP_ID, getMap, type GeoPoint, type MapDefinition } from '../logic/geography';
import { pathFromPoints, smoothClosedPoints, smoothOpenPoints } from './drawing';

/**
 * Draw the chart base: deep water, the level's land mass and its coastline.
 * Relief, cities and weather overlays are separate layers.  The outline comes
 * from the level's map prototype, so a delta chart and an inland chart no
 * longer share one coastline.
 */
export function drawBasemap(
  graphics: Phaser.GameObjects.Graphics,
  map: MapDefinition = getMap(DEFAULT_MAP_ID),
): void {
  graphics.clear();

  graphics.fillStyle(COLORS.sea, 1);
  graphics.fillRect(-200, -200, MAP_SIZE + 400, MAP_SIZE + 400);

  if (map.coast) {
    const coast = smoothOpenPoints(map.coast, 28);
    // Close the land through the polygon corners so the fill always reaches
    // the chart edges without rounding off the map corners.
    const land: GeoPoint[] = [];
    for (const point of map.land) land.push(point);
    // Fill the authored polygon, but stroke the smoothed line so the coast
    // reads as a chart line rather than a polygon edge.
    graphics.fillStyle(COLORS.land, 1);
    pathFromPoints(graphics, land, true);
    graphics.fillPath();

    graphics.lineStyle(1.1, COLORS.coast, 0.62);
    pathFromPoints(graphics, coast, false);
    graphics.strokePath();
  } else {
    // Fully inland chart: one land mass, no coastline.
    graphics.fillStyle(COLORS.land, 1);
    pathFromPoints(graphics, map.land, true);
    graphics.fillPath();
  }

  graphics.lineStyle(1, COLORS.coast, 0.3);
  graphics.strokeRect(0.5, 0.5, MAP_SIZE - 1, MAP_SIZE - 1);
}

function terrainRing(hill: MapDefinition['hills'][number], scale: number): GeoPoint[] {
  const points: GeoPoint[] = [];
  const count = 72;
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2;
    const wobble =
      1 +
      Math.sin(angle * 3 + hill.seed) * 0.09 +
      Math.sin(angle * 5 - hill.seed * 0.7) * 0.035;
    points.push({
      x: hill.x + Math.cos(angle) * hill.rx * scale * wobble,
      y: hill.y + Math.sin(angle) * hill.ry * scale * wobble,
    });
  }
  return smoothClosedPoints(points, 2);
}

/**
 * Terrain decoration: dark mountain masses with three elevation rings.  The
 * hills belong to the map prototype, so a coastal-range chart draws its own
 * ridge instead of the old fixed decoration.
 */
export function drawTerrainRelief(
  graphics: Phaser.GameObjects.Graphics,
  map: MapDefinition = getMap(DEFAULT_MAP_ID),
): void {
  graphics.clear();
  if (!map.hills.length) return;

  graphics.fillStyle(COLORS.mountainBase, 0.96);
  for (const hill of map.hills) {
    pathFromPoints(graphics, terrainRing(hill, 1), true);
    graphics.fillPath();
  }

  for (const scale of [1, 0.76, 0.52]) {
    for (const hill of map.hills) {
      graphics.lineStyle(1, COLORS.mountainLine, scale === 1 ? 0.18 : 0.1);
      pathFromPoints(graphics, terrainRing(hill, scale), true);
      graphics.strokePath();
    }
  }
}
