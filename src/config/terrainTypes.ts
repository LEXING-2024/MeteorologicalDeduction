/**
 * One DEM tile set, resampled to n×n and encoded as a string.
 *
 * The type lives in its own module so the generated terrain chunks can import
 * it without pulling the loader (and therefore the whole registry) back in.
 */
export interface RealTerrainData {
  west: number;
  east: number;
  south: number;
  north: number;
  n: number;
  widthKm: number;
  heightKm: number;
  data: string;
}
