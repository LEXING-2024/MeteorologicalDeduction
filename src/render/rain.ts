import { interpolateGrid } from '../logic/field';
import type { SampleGrid } from '../logic/types';

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rainColor(equivalent24h: number): [number, number, number] {
  if (equivalent24h < 10) return [161, 241, 141];
  if (equivalent24h < 25) return [61, 186, 61];
  if (equivalent24h < 50) return [96, 184, 255];
  if (equivalent24h < 100) return [0, 0, 255];
  if (equivalent24h < 250) return [250, 0, 250];
  return [128, 0, 64];
}

/**
 * One scratch buffer per canvas size.  The layer is repainted on every field
 * change, and allocating a fresh 384² ImageData each time (590 kB) was pure GC
 * pressure for an image that is overwritten in place anyway.
 */
let rainBuffer: ImageData | null = null;

export function paintRainLayer(
  context: CanvasRenderingContext2D,
  grid: SampleGrid,
  width: number,
  height: number,
): void {
  if (!rainBuffer || rainBuffer.width !== width || rainBuffer.height !== height) {
    rainBuffer = context.createImageData(width, height);
  }
  const image = rainBuffer;
  const data = image.data;
  data.fill(0);
  const mapSize = grid.size;

  let maxRain = 0;
  for (const value of grid.r) maxRain = Math.max(maxRain, value);
  if (maxRain * 8 < 0.1) {
    context.clearRect(0, 0, width, height);
    return;
  }

  for (let py = 0; py < height; py += 1) {
    const y = ((py + 0.5) / height) * mapSize;
    for (let px = 0; px < width; px += 1) {
      const x = ((px + 0.5) / width) * mapSize;
      const index = (py * width + px) * 4;
      const rain = interpolateGrid(grid, grid.r, x, y);
      const equivalent24h = rain * 8;

      if (rain <= 0.015 || equivalent24h < 0.1) {
        data[index + 3] = 0;
        continue;
      }

      const temperature = interpolateGrid(grid, grid.tLow, x, y);
      let color = rainColor(equivalent24h);
      if (temperature < 0) {
        color = [196, 224, 235];
      }

      const edgeFade = clamp01((equivalent24h - 0.1) / 1.5);
      const intensity = clamp01(rain / 6);
      const alpha = Math.round(8 + edgeFade * 17 + intensity * 22);

      data[index] = color[0];
      data[index + 1] = color[1];
      data[index + 2] = color[2];
      data[index + 3] = alpha;
    }
  }

  context.clearRect(0, 0, width, height);
  context.putImageData(image, 0, 0);
}
