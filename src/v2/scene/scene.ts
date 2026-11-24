/**
 * V2 · 场景生成。
 * 设计锚点：docs/V2/02 §3、05 §2。
 *
 * 每关的地形不再是“一张共用海岸线”，而是由 TerrainDef 决定的
 * 参数化场景：平原、海岸、盆地、山脊、高原、岛屿。
 * 所有噪声都是确定性的（hash2），同一关每次生成逐位一致。
 */

import { clamp, gaussian2D, hash2, smoothstep, type Grid } from '../core/grid';
import { saturationMixingRatio } from '../physics/thermo';
import type { SceneDef, TerrainDef } from '../core/types';

export interface SceneFields {
  /** 地形高度（m）。 */
  height: Float64Array;
  /** 1 = 陆，0 = 海。 */
  land: Float64Array;
  /** 粗糙度（m）。 */
  roughness: Float64Array;
  /** 城市比例（0–1）。 */
  urban: Float64Array;
  /** 海温（℃），陆地为 0。 */
  sst: Float64Array;
  /** 陆地子午线方向（用于渲染坡向）。 */
  slopeX: Float64Array;
  slopeY: Float64Array;
}

interface Rotated {
  /** 沿轴坐标（km）。 */
  along: number;
  /** 垂直轴坐标（km，正向为“陆侧”）。 */
  across: number;
}

/**
 * 轴线约定：axisDeg 是“陆侧”法向量的方向（从东逆时针）。
 * axisX 是轴线到域中心的沿法向距离（km），负值表示中心在陆侧。
 */
function rotate(
  xKm: number,
  yKm: number,
  cx: number,
  cy: number,
  axisDeg: number,
): Rotated {
  const rad = (axisDeg * Math.PI) / 180;
  const dx = xKm - cx;
  const dy = yKm - cy;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { along: -dx * sin + dy * cos, across: dx * cos + dy * sin };
}

function wiggle(yKm: number, seed: number): number {
  return (
    Math.sin(yKm * 0.045 + seed * 1.7) * 9 +
    Math.sin(yKm * 0.13 + seed * 4.3) * 3.5 +
    // 低频弯折让海岸线不是一条正弦线，仍有确定性。
    Math.sin(yKm * 0.011 + seed * 2.1) * 14
  );
}

/** 平滑值噪声：给地形提供有连续坡面的丘陵，而不是逐格跳变。 */
function smoothNoise2D(x: number, y: number, seed: number): number {
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

/** 多尺度地形起伏（km 波长），幅度归一化到约 [-1, 1]。 */
function rollingRelief(xKm: number, yKm: number, seed: number): number {
  const broad = (smoothNoise2D(xKm / 115, yKm / 115, seed + 7) - 0.5) * 2;
  const medium = (smoothNoise2D(xKm / 43, yKm / 43, seed + 31) - 0.5) * 2;
  const fine = (smoothNoise2D(xKm / 17, yKm / 17, seed + 67) - 0.5) * 2;
  return broad * 0.56 + medium * 0.28 + fine * 0.12;
}

export function buildScene(scene: SceneDef, grid: Grid): SceneFields {
  const n = grid.n;
  const size = n * n;
  const height = new Float64Array(size);
  const land = new Float64Array(size);
  const roughness = new Float64Array(size);
  const urban = new Float64Array(size);
  const sst = new Float64Array(size);
  const slopeX = new Float64Array(size);
  const slopeY = new Float64Array(size);

  const terrain: TerrainDef = scene.terrain;
  const kind = terrain.kind;
  const cx = scene.domainKm / 2;
  const cy = scene.domainKm / 2;
  const axisDeg = terrain.axisDeg ?? 0;
  const base = terrain.baseHeightM ?? 60;
  const relief = terrain.reliefM ?? 24;
  const ridgeH = terrain.ridgeHeightM ?? 1600;
  const ridgeW = terrain.ridgeWidthKm ?? 60;
  const ridgeOffset = terrain.ridgeOffsetKm ?? 80;
  const valleyHalf = terrain.valleyHalfWidthKm ?? 40;
  const valleyWall = terrain.valleyWallWidthKm ?? 70;
  const axisX = terrain.axisXKm ?? 0;
  const seed = (scene.centerLon % 37) + scene.centerLat * 0.13;

  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const k = grid.idx(i, j);
      const x = grid.xKm(i);
      const y = grid.yKm(j);
      const rot = rotate(x, y, cx, cy, axisDeg);
      const across = rot.across + wiggle(rot.along, seed) * (kind === 'plain' ? 0.4 : 1);
      const r = Math.hypot(x - cx, y - cy);
      // 网格粒噪声只保留很小的细碎起伏；主起伏改成有连续坡面的多尺度丘陵。
      const grain = (hash2(i, j, seed | 0) - 0.5) * 0.34;
      const rolling = rollingRelief(x, y, seed | 0);
      const noise = (grain + rolling * 0.9) * relief;

      let h = base;
      let isLand = 1;

      if (kind === 'coast') {
        const coast = axisX + wiggle(rot.along, seed + 2) * 0.6;
        isLand = across >= coast ? 1 : 0;
        if (isLand) {
          const inland = clamp((across - coast) / 120, 0, 1);
          // 海岸平原不是一块平板：向内陆抬升并叠低丘，给海岸线一点纵深。
          h = base + 150 * smoothstep(0, 1, inland) + noise * 0.8;
        } else {
          h = 0;
        }
      } else if (kind === 'mountainCoast') {
        // 海岸山脉：平直海岸线 + 内陆一条与海岸平行的山脊。
        const coast = axisX + wiggle(rot.along, seed + 2) * 0.55;
        isLand = across >= coast ? 1 : 0;
        if (isLand) {
          const inland = across - coast;
          const ridge = ridgeH * Math.exp(-((inland - ridgeOffset) ** 2) / (2 * ridgeW * ridgeW));
          // 山脉背后接一块高原面：海—海岸山脉—高原的层次，
          // 让“高原”也在卷一的地图上出现，而不是只有山脊。
          const plateau =
            300 *
            smoothstep(
              ridgeOffset + ridgeW * 1.8,
              ridgeOffset + ridgeW * 3.6,
              inland,
            );
          h =
            base +
            70 * smoothstep(0, 1, clamp(inland / 140, 0, 1)) +
            ridge +
            plateau +
            noise * 0.4;
        } else {
          h = 0;
        }
      } else if (kind === 'delta') {
        // 三角洲：低平海岸 + 数条向陆延伸的分流水道。
        const coast = axisX + wiggle(rot.along, seed + 2) * 0.8;
        isLand = across >= coast ? 1 : 0;
        const inland = across - coast;
        if (isLand) {
          const channel =
            inland > 0 &&
            inland < 220 &&
            Math.abs(Math.sin(rot.along * 0.035 + seed * 1.7)) < 0.13;
          if (channel) {
            isLand = 0;
            h = 0;
          } else {
            h = base + 25 * smoothstep(0, 1, clamp(inland / 180, 0, 1)) + noise * 0.35;
          }
        } else {
          h = 0;
        }
      } else if (kind === 'basin') {
        const R = terrain.basinRadiusKm ?? 150;
        const depth = terrain.basinDepthM ?? 260;
        const rim = (terrain.ridgeHeightM ?? 500) * 0.5;
        h =
          base +
          rim * smoothstep(R * 0.75, R * 1.6, r) -
          depth * Math.exp(-(r * r) / (2 * (R * 0.55) * (R * 0.55))) +
          noise * 0.4;
      } else if (kind === 'valley') {
        // V 形谷：中央低地，两侧山壁；沿 axisDeg 方向延伸。
        const d = Math.abs(across - axisX);
        const wall = smoothstep(valleyHalf, valleyHalf + valleyWall, d);
        h = base + ridgeH * wall + noise * 0.35;
      } else if (kind === 'pass') {
        // 两山夹一通道：两条平行山脊，中间留出狭管。
        const d = Math.abs(Math.abs(across - axisX) - ridgeOffset);
        h = base + ridgeH * Math.exp(-(d * d) / (2 * ridgeW * ridgeW)) + noise * 0.4;
      } else if (kind === 'lake') {
        // 内陆湖：圆形水面，四周缓坡；湖面不参与陆面摩擦。
        const R = terrain.lakeRadiusKm ?? terrain.islandRadiusKm ?? 80;
        const lakeX = cx + axisX;
        const lakeR = Math.hypot(x - lakeX, y - cy);
        isLand = lakeR > R ? 1 : 0;
        h = isLand
          ? base + 45 * smoothstep(R, R + 35, lakeR) + noise * 0.35
          : 0;
      } else if (kind === 'ridge') {
        h =
          base +
          ridgeH * Math.exp(-(across * across) / (2 * ridgeW * ridgeW)) +
          noise * 0.6;
      } else if (kind === 'plateau') {
        const R = terrain.plateauEdgeKm ?? 200;
        const step = terrain.plateauHeightM ?? 700;
        h = base + step * (1 - smoothstep(R * 0.72, R, r)) + noise * 0.35;
      } else if (kind === 'island') {
        const R = terrain.islandRadiusKm ?? 170;
        isLand = r <= R ? 1 : 0;
        h = isLand
          ? base +
            (terrain.ridgeHeightM ?? 1400) *
              Math.exp(-(r * r) / (2 * (R * 0.42) * (R * 0.42))) +
            noise * 0.4
          : 0;
      } else {
        h = base + noise;
      }

      height[k] = Math.max(0, h);
      land[k] = isLand;
    }
  }

  // 坡度（用于渲染与地形抬升）。
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const k = grid.idx(i, j);
      slopeX[k] = grid.dfdx(height, i, j);
      slopeY[k] = grid.dfdy(height, i, j);
    }
  }

  // 城市冠层。
  const cityRadius = 14;
  const cityRough = terrain.cityRoughness ?? 0.8;
  for (const site of scene.sites) {
    if (site.marine) continue;
    const peak = clamp(site.population / 600, 0.15, 1);
    for (let j = 0; j < n; j += 1) {
      for (let i = 0; i < n; i += 1) {
        const dx = grid.xKm(i) - site.xKm;
        const dy = grid.yKm(j) - site.yKm;
        if (Math.abs(dx) > cityRadius * 3 || Math.abs(dy) > cityRadius * 3) continue;
        const value = peak * gaussian2D(dx, dy, cityRadius);
        const k = grid.idx(i, j);
        if (value > urban[k]) urban[k] = value;
      }
    }
  }

  // 粗糙度与海温。
  for (let k = 0; k < size; k += 1) {
    if (land[k] < 0.5) {
      roughness[k] = 1e-4;
      const i = k % n;
      const j = (k / n) | 0;
      sst[k] = scene.sstC + Math.sin(i * 0.11 + j * 0.07 + seed) * 0.8;
    } else {
      const mountain = clamp((height[k] - 900) / 1400, 0, 1);
      const baseRough =
        kind === 'ridge' || kind === 'mountainCoast'
          ? 0.16
          : kind === 'valley' || kind === 'pass'
            ? 0.12
            : kind === 'basin'
              ? 0.05
              : kind === 'plateau'
                ? 0.09
                : 0.04;
      roughness[k] =
        baseRough * (1 - mountain) + 0.5 * mountain + urban[k] * cityRough;
    }
  }

  return { height, land, roughness, urban, sst, slopeX, slopeY };
}

/**
 * 初始湿度：按“温度—饱和比湿—相对湿度”生成，而不是全场同一个 q。
 *
 * 参考 SpeedyWeather 的 ConstantRelativeHumidity 初始场思路：
 * 热带海面 RH 约 72%，低地陆地 58–68%，高原/山地随海拔降低；
 * 再叠一层连续的干湿斑块，避免初始场像一块均匀湿海绵。
 * 这样环境湿度仍在成云阈值以下，云雨由局地抬升触发。
 */
/**
 * 背景比湿是场景的“气候上限”，不是初始场的唯一值：
 * 允许地形/温度造成 1.5 倍的局地增湿，但不允许比背景干湿设定无限偏湿。
 */
export function humidityBackgroundCap(scene: SceneDef): number {
  return scene.bgHumidity > 0 ? clamp(scene.bgHumidity * 1.5, 0.6, 30) : 30;
}

export function initialHumidity(scene: SceneDef, fields: SceneFields): Float64Array {
  const q = new Float64Array(fields.land.length);
  const n = Math.round(Math.sqrt(fields.land.length));
  const dx = scene.domainKm / n;
  const seed = (scene.centerLon % 37) + scene.centerLat * 0.13;
  const bgCap = humidityBackgroundCap(scene);

  for (let k = 0; k < q.length; k += 1) {
    const i = k % n;
    const j = (k / n) | 0;
    const xKm = (i + 0.5) * dx;
    const yKm = (j + 0.5) * dx;
    const isLand = fields.land[k] > 0.5;
    const heightKm = fields.height[k] / 1000;
    const tC = isLand ? scene.baseTempC - 6.5 * heightKm : scene.sstC;

    // 海面按海温饱和，陆地按地面气温饱和；再乘相对湿度。
    const qs = saturationMixingRatio(tC);
    let rh: number;
    if (!isLand) {
      rh = 0.71 + rollingRelief(xKm, yKm, seed + 101) * 0.035;
    } else {
      const soil = clamp(scene.soil, 0, 1);
      // 低地更湿，高处更干；土壤湿度提供 6–8 个百分点的差异。
      const elevDry = smoothstep(0.35, 2.2, heightKm) * 0.16;
      const patch = rollingRelief(xKm, yKm, seed + 137) * 0.055;
      rh = 0.53 + soil * 0.17 - elevDry + patch;
    }
    rh = clamp(rh, 0.34, 0.82);
    q[k] = clamp(Math.min(qs * rh, bgCap), 0.6, 30);
  }
  return q;
}

/** 初始温度：海拔每升高 1 km 降温 6.5 K。 */
export function initialTemperature(fields: SceneFields): Float64Array {
  const t = new Float64Array(fields.land.length);
  for (let k = 0; k < t.length; k += 1) {
    t[k] = -0.0065 * fields.height[k];
  }
  return t;
}
