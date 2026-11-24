import type { RealTerrainData } from './terrainTypes';

export type { RealTerrainData } from './terrainTypes';

/*
 * Real-case topography, loaded on demand.
 *
 * Each 512x512 DEM is ~700 kB of encoded elevation, and only the five case
 * levels (46-50) ever read one.  Keeping them as static imports put 3.4 MB into
 * the bundle every player downloaded before level 1; they now live in
 * per-profile chunks that are fetched when a case level is selected.
 *
 * The registry stays synchronous for the physics: `elevationAt()` runs inside
 * the sampling loop, so `GameController` awaits `loadRealTerrain()` before it
 * starts the level and the field never sees a missing tile.
 */
export const REAL_TERRAIN: Record<string, RealTerrainData> = {};

const LOADERS: Record<string, () => Promise<{ default: RealTerrainData }>> = {
  taiwan: () => import('./terrain/taiwan'),
  songxian: () => import('./terrain/songxian'),
  lingui: () => import('./terrain/lingui'),
  golmud: () => import('./terrain/golmud'),
  zhengzhou: () => import('./terrain/zhengzhou'),
};

export function hasRealTerrain(profile: string | undefined | null): boolean {
  return Boolean(profile && profile in LOADERS);
}

export async function loadRealTerrain(profile: string | undefined | null): Promise<void> {
  if (!profile || REAL_TERRAIN[profile]) return;
  const loader = LOADERS[profile];
  if (!loader) return;
  const module = await loader();
  REAL_TERRAIN[profile] = module.default;
}
