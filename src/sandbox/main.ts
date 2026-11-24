/**
 * V2 物理沙盒 · 页面入口
 *
 * 独立的 sandbox.html：不读 VOLUME1、不改 v2.html/main.ts，只通过
 * 公共的 SimulationClient / MapView / Frame 契约运行自定义 LevelDef。
 */
import type {
  CardAction,
  Frame,
  LevelDef,
  Tier,
} from '../v2/core/types';
import { SimulationClient } from '../v2/sim/client';
import { MapView, type MapLayers } from '../v2/ui/mapView';
import { RECIPE_LABELS } from '../v2/sim/engine';
import { phaseLabel } from '../v2/physics/phase';
import { REFERENCE_PRESSURE_HPA } from '../v2/physics/thermo';
import {
  DOMAIN_OPTIONS,
  MAP_ASPECT_OPTIONS,
  PRESETS,
  TERRAIN_OPTIONS,
  buildSandboxLevel,
  configFromPreset,
  defaultConfig,
  type SandboxConfig,
} from './scenarios';

const byId = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少 DOM：#${id}`);
  return el as T;
};

const presetSelect = byId<HTMLSelectElement>('preset');
const presetNote = byId<HTMLParagraphElement>('preset-note');
const terrainSelect = byId<HTMLSelectElement>('terrain');
const domainSelect = byId<HTMLSelectElement>('domain');
const mapAspectSelect = byId<HTMLSelectElement>('map-aspect');
const roundsInput = byId<HTMLInputElement>('rounds');
const baseTempInput = byId<HTMLInputElement>('base-temp');
const sstInput = byId<HTMLInputElement>('sst');
const humidityInput = byId<HTMLInputElement>('humidity');
const soilInput = byId<HTMLInputElement>('soil');
const windUInput = byId<HTMLInputElement>('wind-u');
const windVInput = byId<HTMLInputElement>('wind-v');
const timeInput = byId<HTMLInputElement>('time-of-day');
const lowInput = byId<HTMLInputElement>('low');
const highInput = byId<HTMLInputElement>('high');
const wetInput = byId<HTMLInputElement>('wet');
const coolInput = byId<HTMLInputElement>('cool');
const warmInput = byId<HTMLInputElement>('warm');
const jetInput = byId<HTMLInputElement>('jet');
const persistInput = byId<HTMLInputElement>('persist');
const lowKind = byId<HTMLSelectElement>('low-kind');
const lowTierSelect = byId<HTMLSelectElement>('low-tier');
const wetTierSelect = byId<HTMLSelectElement>('wet-tier');
const injectKind = byId<HTMLSelectElement>('inject-kind');
const applyRunButton = byId<HTMLButtonElement>('apply-run');
const applyResetButton = byId<HTMLButtonElement>('apply-reset');
const stepButton = byId<HTMLButtonElement>('step');
const physicsCheckButton = byId<HTMLButtonElement>('physics-check');
const injectButton = byId<HTMLButtonElement>('inject');
const playButton = byId<HTMLButtonElement>('play');
const timeline = byId<HTMLInputElement>('timeline');
const clock = byId<HTMLDivElement>('clock');
const runState = byId<HTMLSpanElement>('run-state');
const mapTag = byId<HTMLSpanElement>('map-tag');
const mapRegion = byId<HTMLElement>('map-region');
const mapStamp = byId<HTMLDivElement>('map-stamp');
const mapWrap = byId<HTMLDivElement>('map-wrap');
const mapCanvas = byId<HTMLCanvasElement>('map-canvas');
const metricsEl = byId<HTMLDivElement>('metrics');
const recipeChips = byId<HTMLDivElement>('recipe-chips');
const recipeCount = byId<HTMLSpanElement>('recipe-count');
const checksEl = byId<HTMLDivElement>('checks');
const profileCanvas = byId<HTMLCanvasElement>('profile');
const profileValues = byId<HTMLDivElement>('profile-values');
const seriesCanvas = byId<HTMLCanvasElement>('series');
const toastEl = byId<HTMLDivElement>('toast');

let config: SandboxConfig = defaultConfig();
let sim: SimulationClient | null = null;
let level: LevelDef | null = null;
let map: MapView | null = null;
let frames: Frame[] = [];
let viewIndex = 0;
let busy = false;
let playing = false;
let activePresetId = 'warm-rain';
let playTimer: number | null = null;
let runToken = 0;
let toastTimer = 0;

const MAP_LAYERS: MapLayers = {
  pressure: true,
  wind: true,
  cloud: true,
  rain: true,
  temp: false,
  terrain: true,
};

const EXPECTATIONS: Record<
  string,
  { label: string; test: (frame: Frame) => { pass: boolean; actual: string } }[]
> = {
  'warm-rain': [
    {
      label: '有液态降水',
      test: (frame) => ({
        pass: (max(frame.rainRate) ?? 0) > 0.2,
        actual: `${format(max(frame.rainRate), 2)} mm/h`,
      }),
    },
    {
      label: 'PW 达到暖湿量级',
      test: (frame) => ({
        pass: (frame.stats.meanPwMm ?? 0) >= 25,
        actual: `${format(frame.stats.meanPwMm, 1)} mm`,
      }),
    },
    {
      label: '850 hPa 位于零上',
      test: (frame) => ({
        pass: (frame.stats.meanT850 ?? -99) > 0,
        actual: `${format(frame.stats.meanT850)}℃`,
      }),
    },
  ],
  'cold-snow': [
    {
      label: '有固态降雪',
      test: (frame) => ({
        pass: (max(frame.snowRate) ?? 0) > 0.02,
        actual: `${format(max(frame.snowRate), 2)} mm/h`,
      }),
    },
    {
      label: '无液态雨',
      test: (frame) => ({
        pass: (max(frame.rainRate) ?? 1) < 0.02,
        actual: `${format(max(frame.rainRate), 2)} mm/h`,
      }),
    },
    {
      label: '850 hPa 位于零下',
      test: (frame) => ({
        pass: (frame.stats.meanT850 ?? 99) < 0,
        actual: `${format(frame.stats.meanT850)}℃`,
      }),
    },
  ],
  'lake-snow': [
    {
      label: '湖面下风向有雪',
      test: (frame) => ({
        pass: (max(frame.snowRate) ?? 0) > 0.02,
        actual: `${format(max(frame.snowRate), 2)} mm/h`,
      }),
    },
    {
      label: '湖效应水汽抬升',
      test: (frame) => ({
        pass: (frame.stats.maxW ?? 0) > 5,
        actual: `${format(frame.stats.maxW)} cm/s`,
      }),
    },
  ],
  convective: [
    {
      label: 'CAPE 代理 > 2000',
      test: (frame) => ({
        pass: (frame.stats.capeMean ?? 0) > 2000,
        actual: `${format(frame.stats.capeMean, 0)} J/kg`,
      }),
    },
    {
      label: '强上升运动 > 40 cm/s',
      test: (frame) => ({
        pass: (frame.stats.maxW ?? 0) > 40,
        actual: `${format(frame.stats.maxW)} cm/s`,
      }),
    },
    {
      label: '冰雹份额（冷环境门槛）',
      test: (frame) => ({
        pass: (max(frame.hailRate) ?? 0) > 0.01,
        actual: `${format(max(frame.hailRate), 2)} mm/h`,
      }),
    },
  ],
  'hailstorm': [
    {
      label: '冷性对流 CAPE > 2500',
      test: (frame) => ({
        pass: (frame.stats.capeMean ?? 0) > 2500,
        actual: `${format(frame.stats.capeMean, 0)} J/kg`,
      }),
    },
    {
      label: '强上升运动 > 120 cm/s',
      test: (frame) => ({
        pass: (frame.stats.maxW ?? 0) >= 120,
        actual: `${format(frame.stats.maxW)} cm/s`,
      }),
    },
    {
      label: '出现冰雹份额',
      test: (frame) => ({
        pass: (max(frame.hailRate) ?? 0) > 0.01,
        actual: `${format(max(frame.hailRate), 2)} mm/h`,
      }),
    },
  ],
  typhoon: [
    {
      label: '低压中心 < 990 hPa',
      test: (frame) => ({
        pass: REFERENCE_PRESSURE_HPA + frame.stats.minP < 990,
        actual: `${format(REFERENCE_PRESSURE_HPA + frame.stats.minP, 0)} hPa`,
      }),
    },
    {
      label: '最大风 ≥ 15 m/s',
      test: (frame) => ({
        pass: (frame.stats.maxWind ?? 0) >= 15,
        actual: `${format(frame.stats.maxWind)} m/s`,
      }),
    },
    {
      label: '暖核（850 hPa > 0℃）',
      test: (frame) => ({
        pass: (frame.stats.meanT850 ?? -99) > 0,
        actual: `${format(frame.stats.meanT850)}℃`,
      }),
    },
  ],
  dust: [
    {
      label: '基本无降水',
      test: (frame) => ({
        pass: (max(frame.precipRate) ?? 0) < 0.05,
        actual: `${format(max(frame.precipRate), 2)} mm/h`,
      }),
    },
    {
      label: '背景比湿低',
      test: (frame) => ({
        pass: (frame.stats.meanQ ?? 99) < 6,
        actual: `${format(frame.stats.meanQ, 2)} g/kg`,
      }),
    },
    {
      label: '地面风 >= 8 m/s',
      test: (frame) => ({
        pass: (frame.stats.maxWind ?? 0) >= 8,
        actual: `${format(frame.stats.maxWind)} m/s`,
      }),
    },
  ],
  'sea-breeze': [
    {
      label: '风向有日变化转向',
      test: (frame) => ({
        pass: (frame.morphology?.maxWindDirShiftDeg ?? 0) > 15,
        actual: `${format(frame.morphology?.maxWindDirShiftDeg, 1)}°`,
      }),
    },
    {
      label: '出现辐合',
      test: (frame) => ({
        pass: (frame.morphology?.maxConvergence ?? 0) > 0,
        actual: `${format((frame.morphology?.maxConvergence ?? 0) * 1e5, 1)} 1e-5/s`,
      }),
    },
  ],
  'basin-fog': [
    {
      label: '夜间最低温 ≤ 基准 - 2K',
      test: (frame) => {
        const base = level?.scene.baseTempC ?? 0;
        return {
          pass: (frame.stats.minTemp ?? base) <= base - 2,
          actual: `${format(frame.stats.minTemp)}℃（基准 ${format(base)}℃）`,
        };
      },
    },
    {
      label: '近地风速 < 6 m/s',
      test: (frame) => ({
        pass: (frame.stats.maxWind ?? 99) < 6,
        actual: `${format(frame.stats.maxWind)} m/s`,
      }),
    },
  ],
  valley: [
    {
      label: '山谷风配方被识别',
      test: (frame) => ({
        pass: frame.recipes.includes('valleyBreeze'),
        actual: frame.recipes.includes('valleyBreeze') ? 'valleyBreeze 命中' : `未命中（${frame.recipes.length} 个配方）`,
      }),
    },
  ],
  front: [
    {
      label: '锋生率 > 1e-5',
      test: (frame) => ({
        pass: (frame.stats.frontogenesisMax ?? 0) > 1e-5,
        actual: sci(frame.stats.frontogenesisMax),
      }),
    },
    {
      label: '雨带拉长 > 1.5:1',
      test: (frame) => ({
        pass: (frame.morphology?.rainElongation ?? 0) > 1.5,
        actual: `${format(frame.morphology?.rainElongation, 2)}:1`,
      }),
    },
  ],
  'cold-rain': [
    {
      label: '地面 < 0℃ 且出现冻雨/雪',
      test: (frame) => ({
        pass:
          (max(frame.freezingRainRate) ?? 0) > 0.01 || (max(frame.snowRate) ?? 0) > 0.01,
        actual: `冻雨 ${format(max(frame.freezingRainRate), 2)} / 雪 ${format(max(frame.snowRate), 2)} mm/h`,
      }),
    },
  ],
};

function tierValue(value: string, fallback: Tier): Tier {
  const n = Number(value);
  return (n === 1 || n === 2 || n === 3 ? n : fallback) as Tier;
}

function setStatus(text: string, live = false): void {
  runState.textContent = text;
  runState.classList.toggle('live', live);
}

function toast(message: string): void {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 2600);
}

function format(value: number | undefined, digits = 1): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(Math.max(0, Math.min(6, digits)));
}

function sci(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return value.toExponential(2);
}

function mean(values: Float32Array | Float64Array | undefined): number {
  if (!values || values.length === 0) return Number.NaN;
  let sum = 0;
  let count = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    sum += value;
    count += 1;
  }
  return count ? sum / count : Number.NaN;
}

function max(values: Float32Array | Float64Array | undefined): number {
  if (!values || values.length === 0) return Number.NaN;
  let out = -Infinity;
  for (const value of values) if (Number.isFinite(value)) out = Math.max(out, value);
  return out;
}

function allFinite(values: Float32Array | Float64Array | undefined): boolean {
  if (!values || values.length === 0) return false;
  for (const value of values) if (!Number.isFinite(value)) return false;
  return true;
}

function aspectLabel(aspect: number): string {
  if (Math.abs(aspect - 1) < 0.02) return '1:1';
  if (Math.abs(aspect - 4 / 3) < 0.05) return '4:3';
  if (Math.abs(aspect - 16 / 9) < 0.1) return '16:9';
  if (Math.abs(aspect - 3 / 4) < 0.05) return '3:4';
  return `${aspect.toFixed(2)}:1`;
}

/** 让画布按设计画幅完整放进地图容器，不拉伸、不裁切。 */
function fitMapCanvas(aspect: number): void {
  const rect = mapWrap.getBoundingClientRect();
  const boxW = Math.floor(rect.width);
  const boxH = Math.floor(rect.height);
  if (boxW < 10 || boxH < 10) return;
  let width = boxW;
  let height = width / aspect;
  if (height > boxH) {
    height = boxH;
    width = height * aspect;
  }
  mapCanvas.style.width = `${Math.max(1, Math.round(width))}px`;
  mapCanvas.style.height = `${Math.max(1, Math.round(height))}px`;
  mapCanvas.style.aspectRatio = String(aspect);
}

function syncOutputs(): void {
  byId('domain-out').textContent = `${config.domainKm} km`;
  byId('map-aspect-out').textContent = aspectLabel(config.mapAspect);
  byId('rounds-out').textContent = String(config.rounds);
  byId('base-temp-out').textContent = `${config.baseTempC.toFixed(1)}℃`;
  byId('sst-out').textContent = `${config.sstC.toFixed(1)}℃`;
  byId('humidity-out').textContent = `${config.humidity.toFixed(1)} g/kg`;
  byId('soil-out').textContent = config.soil.toFixed(2);
  byId('wind-u-out').textContent = config.windU.toFixed(1);
  byId('wind-v-out').textContent = config.windV.toFixed(1);
  byId('time-of-day-out').textContent = `${String(Math.round(config.timeOfDay)).padStart(2, '0')}:00`;
  applyRunButton.textContent = `应用并跑 ${config.rounds * 3}h`;
}

function syncFormFromConfig(): void {
  presetSelect.value = PRESETS.find((preset) => {
    const c = configFromPreset(preset);
    return (
      c.terrain === config.terrain &&
      c.baseTempC === config.baseTempC &&
      c.sstC === config.sstC &&
      c.humidity === config.humidity &&
      c.low === config.low &&
      c.wet === config.wet
    );
  })?.id ?? '';
  terrainSelect.value = config.terrain;
  domainSelect.value = String(config.domainKm);
  mapAspectSelect.value = String(config.mapAspect);
  roundsInput.value = String(config.rounds);
  baseTempInput.value = String(config.baseTempC);
  sstInput.value = String(config.sstC);
  humidityInput.value = String(config.humidity);
  soilInput.value = String(config.soil);
  windUInput.value = String(config.windU);
  windVInput.value = String(config.windV);
  timeInput.value = String(config.timeOfDay);
  lowInput.checked = config.low;
  highInput.checked = config.high;
  wetInput.checked = config.wet;
  coolInput.checked = config.cool;
  warmInput.checked = config.warm;
  jetInput.checked = config.jet;
  persistInput.checked = config.persist;
  lowKind.value = config.lowWarm ? 'warm' : 'cold';
  lowTierSelect.value = String(config.lowTier);
  wetTierSelect.value = String(config.wetTier);
  syncOutputs();
}

function readConfigFromForm(): SandboxConfig {
  return {
    domainKm: Number(domainSelect.value),
    terrain: terrainSelect.value as SandboxConfig['terrain'],
    mapAspect: Number(mapAspectSelect.value),
    baseTempC: Number(baseTempInput.value),
    sstC: Number(sstInput.value),
    soil: Number(soilInput.value),
    humidity: Number(humidityInput.value),
    windU: Number(windUInput.value),
    windV: Number(windVInput.value),
    timeOfDay: Number(timeInput.value),
    rounds: Number(roundsInput.value),
    low: lowInput.checked,
    lowTier: tierValue(lowTierSelect.value, 3),
    lowWarm: lowKind.value === 'warm',
    high: highInput.checked,
    wet: wetInput.checked,
    wetTier: tierValue(wetTierSelect.value, 2),
    cool: coolInput.checked,
    warm: warmInput.checked,
    jet: jetInput.checked,
    persist: persistInput.checked,
  };
}

function currentFrame(): Frame | null {
  return frames.length ? frames[Math.min(viewIndex, frames.length - 1)] : null;
}

function stopPlayback(): void {
  if (playTimer !== null) window.clearInterval(playTimer);
  playTimer = null;
  playing = false;
  playButton.textContent = '▶';
}

function setViewIndex(index: number): void {
  if (!frames.length) return;
  viewIndex = Math.max(0, Math.min(frames.length - 1, Math.round(index)));
  timeline.value = String(viewIndex);
  renderCurrent();
}

function setFrames(next: Frame[]): void {
  frames = next;
  viewIndex = Math.max(0, frames.length - 1);
  timeline.min = '0';
  timeline.max = String(Math.max(0, frames.length - 1));
  timeline.value = String(viewIndex);
  renderCurrent();
}

function renderCurrent(): void {
  const frame = currentFrame();
  if (!frame) return;
  map?.setHistory(frames);
  map?.setFrame(frame);
  const stats = frame.stats;
  const pressureMin = REFERENCE_PRESSURE_HPA + stats.minP;
  const pressureMax = REFERENCE_PRESSURE_HPA + stats.maxP;
  const dominant = phaseLabel(stats.dominantPhase ?? 'none');
  mapTag.textContent = `${pressureMin.toFixed(0)}–${pressureMax.toFixed(0)} hPa · ${dominant}`;
  mapStamp.textContent = `h+${frame.hour} · ${format(stats.maxWind, 1)} m/s · ${frame.recipes.length} recipes`;
  clock.textContent = `h+${frame.hour} · ${String(Math.round(frame.timeOfDay) % 24).padStart(2, '0')}:00`;
  playButton.textContent = playing ? '❚❚' : '▶';
  renderMetrics(frame);
  renderRecipes(frame);
  renderProfile(frame);
  renderSeries();
}

function renderMetrics(frame: Frame): void {
  const s = frame.stats;
  const t2mMean = (() => {
    const anomaly = mean(frame.temp);
    return Number.isFinite(anomaly) && level ? level.scene.baseTempC + anomaly : Number.NaN;
  })();
  const cards: { label: string; value: string; note: string; hot?: boolean }[] = [
    { label: '海平面气压', value: `${format(REFERENCE_PRESSURE_HPA + s.minP, 0)}–${format(REFERENCE_PRESSURE_HPA + s.maxP, 0)} hPa`, note: 'L / H 极值' },
    { label: '地面温度', value: `${format(t2mMean)}℃`, note: `${format(s.minTemp)}–${format(s.maxTemp)}℃` },
    { label: '850 hPa', value: `${format(s.meanT850)}℃`, note: `${format(s.minT850)}–${format(s.maxT850)}℃`, hot: true },
    { label: '700 hPa', value: `${format(s.meanT700)}℃`, note: '中层' },
    { label: '500 hPa', value: `${format(s.meanT500)}℃`, note: `${format(s.minT500)}–${format(s.maxT500)}℃`, hot: true },
    { label: '300 hPa', value: `${format(s.meanT300)}℃`, note: '高层' },
    { label: '可降水量', value: `${format(s.meanPwMm, 0)} mm`, note: `max ${format(s.maxPwMm, 0)} mm` },
    { label: '最大降水', value: `${format(s.maxRain)} mm/h`, note: `雨区 ${format(s.rainRadiusKm, 0)} km` },
    { label: '降雪 / 冰雹', value: `${format(s.maxSnowRate)} / ${format(s.maxHailRate)}`, note: 'mm/h，水当量', hot: (s.maxSnowRate ?? 0) > 0 },
    { label: '最大风 / 最大 w', value: `${format(s.maxWind)} m/s`, note: `${format(s.maxW)} cm/s`, hot: (s.maxWind ?? 0) > 12 },
    { label: 'CAPE 平均', value: `${format(s.capeMean, 0)} J/kg`, note: `冷池 ${format(s.coldPoolMax ?? 0)} K` },
    { label: '锋区 / 雨带', value: `${sci(s.frontogenesisMax)} · ${format(frame.morphology?.rainElongation, 2)}:1`, note: `覆盖 ${format(frame.morphology?.rainCoverage, 2)}` },
    { label: '水汽闭合', value: `${format(s.waterClosure ?? 0, 2)}%`, note: `残差 ${sci(s.waterUnaccounted)}` },
  ];
  metricsEl.innerHTML = cards
    .map(
      (card) => `<div class="metric">
        <small>${card.label}</small>
        <strong class="${card.hot ? 'hot' : ''}">${card.value}</strong>
        <em>${card.note}</em>
      </div>`,
    )
    .join('');
}

function renderRecipes(frame: Frame): void {
  const live = new Set(frame.recipes);
  recipeCount.textContent = `${live.size} / ${Object.keys(RECIPE_LABELS).length}`;
  recipeChips.innerHTML = Object.entries(RECIPE_LABELS)
    .map(
      ([id, label]) =>
        `<span class="chip${live.has(id) ? ' hit' : ''}" title="${id}">${label}</span>`,
    )
    .join('');
}

function prepareCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

function sample(field: Float32Array | undefined, xKm: number, yKm: number): number {
  if (!field || !sim) return Number.NaN;
  return sim.grid.sample(field, xKm, yKm);
}

function renderProfile(frame: Frame): void {
  const site = level?.scene.sites[0];
  if (!site) return;
  const x = site.xKm;
  const y = site.yKm;
  const t2m = level ? level.scene.baseTempC + sample(frame.temp, x, y) : Number.NaN;
  const levels = [
    { p: 1000, t: t2m, q: sample(frame.humidity, x, y) },
    { p: 850, t: sample(frame.layerT850, x, y), q: sample(frame.layerQ850, x, y) },
    { p: 700, t: sample(frame.layerT700, x, y), q: sample(frame.layerQ700, x, y) },
    { p: 500, t: sample(frame.layerT500, x, y), q: sample(frame.layerQ500, x, y) },
    { p: 300, t: sample(frame.layerT300, x, y), q: sample(frame.layerQ300, x, y) },
  ];
  const ctx = prepareCanvas(profileCanvas);
  if (!ctx) return;
  const rect = profileCanvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  const left = 36;
  const right = 26;
  const top = 12;
  const bottom = 22;
  const plotW = Math.max(1, w - left - right);
  const plotH = Math.max(1, h - top - bottom);
  const tMin = Math.min(-60, ...levels.map((item) => item.t).filter(Number.isFinite));
  const tMax = Math.max(10, ...levels.map((item) => item.t).filter(Number.isFinite));
  const yForP = (p: number): number => {
    const norm = (Math.log(p) - Math.log(1000)) / (Math.log(300) - Math.log(1000));
    return top + norm * plotH;
  };
  const xForT = (t: number): number => left + ((t - tMin) / Math.max(1, tMax - tMin)) * plotW;

  ctx.strokeStyle = 'rgba(143,178,176,.22)';
  ctx.lineWidth = 1;
  ctx.font = '10px Consolas, monospace';
  ctx.fillStyle = '#8fb2b0';
  for (const item of levels) {
    const yy = yForP(item.p);
    ctx.beginPath();
    ctx.moveTo(left, yy);
    ctx.lineTo(w - right, yy);
    ctx.stroke();
    ctx.fillText(String(item.p), 4, yy + 3);
  }
  for (let t = Math.ceil(tMin / 10) * 10; t <= tMax; t += 10) {
    const xx = xForT(t);
    ctx.beginPath();
    ctx.moveTo(xx, top);
    ctx.lineTo(xx, h - bottom);
    ctx.stroke();
    ctx.fillText(`${t}`, xx - 8, h - 6);
  }

  ctx.beginPath();
  levels.forEach((item, index) => {
    const xx = xForT(item.t);
    const yy = yForP(item.p);
    if (index === 0) ctx.moveTo(xx, yy);
    else ctx.lineTo(xx, yy);
  });
  ctx.strokeStyle = '#67d6c2';
  ctx.lineWidth = 2.2;
  ctx.stroke();
  levels.forEach((item) => {
    const xx = xForT(item.t);
    const yy = yForP(item.p);
    ctx.beginPath();
    ctx.arc(xx, yy, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = '#67d6c2';
    ctx.fill();
    ctx.fillStyle = '#e8f3ef';
    ctx.fillText(`${item.t.toFixed(1)}`, xx + 5, yy - 4);
  });

  const qMax = Math.max(1, ...levels.map((item) => item.q).filter(Number.isFinite));
  ctx.fillStyle = 'rgba(242,184,102,.28)';
  levels.forEach((item) => {
    const xx = w - right - (item.q / qMax) * 18;
    const yy = yForP(item.p);
    ctx.fillRect(xx, yy - 3, 16, 6);
  });
  ctx.fillStyle = '#f2b866';
  ctx.fillText('q', w - right - 20, top + 10);

  profileValues.innerHTML = levels
    .map(
      (item) =>
        `<span><b>${item.p}</b> ${format(item.t, 1)}℃ / ${format(item.q, 1)} g/kg</span>`,
    )
    .join('');
}

function renderSeries(): void {
  const ctx = prepareCanvas(seriesCanvas);
  if (!ctx || frames.length === 0 || !level) return;
  const rect = seriesCanvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  const left = 34;
  const right = 38;
  const top = 14;
  const bottom = 22;
  const plotW = Math.max(1, w - left - right);
  const plotH = Math.max(1, h - top - bottom);
  const t2m = frames.map((frame) => level!.scene.baseTempC + (mean(frame.temp) || 0));
  const t850 = frames.map((frame) => frame.stats.meanT850 ?? Number.NaN);
  const t500 = frames.map((frame) => frame.stats.meanT500 ?? Number.NaN);
  const pw = frames.map((frame) => frame.stats.meanPwMm ?? Number.NaN);
  const allT = [...t2m, ...t850, ...t500].filter(Number.isFinite);
  const tLo = Math.min(...allT, 0);
  const tHi = Math.max(...allT, 1);
  const pwHi = Math.max(...pw.filter(Number.isFinite), 1);
  const xFor = (index: number): number =>
    left + (frames.length <= 1 ? 0 : (index / (frames.length - 1)) * plotW);
  const yForT = (value: number): number =>
    top + (1 - (value - tLo) / Math.max(1, tHi - tLo)) * plotH;
  const yForPw = (value: number): number => top + (1 - value / pwHi) * plotH;

  ctx.strokeStyle = 'rgba(143,178,176,.2)';
  ctx.fillStyle = '#8fb2b0';
  ctx.font = '10px Consolas, monospace';
  for (let i = 0; i <= 4; i += 1) {
    const yy = top + (i / 4) * plotH;
    ctx.beginPath();
    ctx.moveTo(left, yy);
    ctx.lineTo(w - right, yy);
    ctx.stroke();
    ctx.fillText(`${Math.round(tHi - (i / 4) * (tHi - tLo))}`, 4, yy + 3);
  }

  const drawLine = (
    values: number[],
    color: string,
    yFn: (value: number) => number,
    dash: number[] = [],
  ): void => {
    ctx.beginPath();
    ctx.setLineDash(dash);
    values.forEach((value, index) => {
      if (!Number.isFinite(value)) return;
      const xx = xFor(index);
      const yy = yFn(value);
      if (index === 0) ctx.moveTo(xx, yy);
      else ctx.lineTo(xx, yy);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);
  };
  drawLine(t2m, '#f2b866', yForT);
  drawLine(t850, '#67d6c2', yForT);
  drawLine(t500, '#79b8ff', yForT);
  drawLine(pw, '#ff8ba7', yForPw, [4, 4]);

  ctx.fillStyle = '#f2b866';
  ctx.fillText('T2m', left, 10);
  ctx.fillStyle = '#67d6c2';
  ctx.fillText('T850', left + 38, 10);
  ctx.fillStyle = '#79b8ff';
  ctx.fillText('T500', left + 78, 10);
  ctx.fillStyle = '#ff8ba7';
  ctx.fillText(`PW ≤${pwHi.toFixed(0)}mm`, w - right - 54, 10);
}

function runChecks(): void {
  const frame = currentFrame();
  if (!frame || !level) {
    checksEl.innerHTML = '<div class="check-line"><span class="bad">✗ 没有帧</span><span>先运行场景</span></div>';
    return;
  }
  const items: { ok: boolean; label: string; detail: string }[] = [];
  const layerFields = [
    frame.layerT850,
    frame.layerT700,
    frame.layerT500,
    frame.layerT300,
    frame.layerQ850,
    frame.layerQ700,
    frame.layerQ500,
    frame.layerQ300,
  ];
  const layersOk = layerFields.every(allFinite);
  items.push({
    ok: layersOk,
    label: '4 标准层存在且有限',
    detail: layersOk ? '8 arrays finite' : '缺层/NaN',
  });
  const t850 = frame.stats.meanT850 ?? Number.NaN;
  const t2m = level.scene.baseTempC + mean(frame.temp);
  items.push({
    ok: Number.isFinite(t850) && t850 < t2m,
    label: '850 hPa 比地面冷',
    detail: `${format(t850)} < ${format(t2m)}℃`,
  });
  const t500 = frame.stats.meanT500 ?? Number.NaN;
  items.push({
    ok: Number.isFinite(t500) && t500 < t850,
    label: '500 hPa 比 850 hPa 冷',
    detail: `${format(t500)} < ${format(t850)}℃`,
  });
  const q850 = max(frame.layerQ850);
  const q0 = max(frame.humidity);
  items.push({
    ok: Number.isFinite(q850) && Number.isFinite(q0) && q850 <= q0 * 1.12,
    label: '850 hPa 比湿不超过地面',
    detail: `${format(q850, 2)} ≤ ${format(q0, 2)} g/kg`,
  });
  const pw = frame.stats.meanPwMm ?? mean(frame.pwMm);
  items.push({
    ok: Number.isFinite(pw) && pw > 0 && pw < 120,
    label: 'PW 五层积分有量级',
    detail: `${format(pw, 1)} mm`,
  });
  let phaseDiff = 0;
  for (let i = 0; i < frame.precipRate.length; i += 1) {
    const total = frame.precipRate[i];
    const sum =
      frame.rainRate[i] +
      frame.sleetRate[i] +
      frame.snowRate[i] +
      frame.freezingRainRate[i] +
      frame.hailRate[i];
    phaseDiff = Math.max(phaseDiff, Math.abs(total - sum));
  }
  items.push({
    ok: phaseDiff < 1e-4,
    label: '五相份额之和 = 总降水',
    detail: `max diff ${phaseDiff.toExponential(1)}`,
  });
  const morph = frame.morphology;
  items.push({
    ok: !!morph && Number.isFinite(morph.rainElongation) && Number.isFinite(morph.rainCoverage),
    label: '空间形态可诊断',
    detail: morph ? `${format(morph.rainElongation, 2)}:1 · ${format(morph.rainCoverage, 2)}` : '无 morphology',
  });
  const closure = frame.stats.waterClosure;
  items.push({
    ok: closure !== undefined && Math.abs(closure) < 0.01,
    label: '水汽账本闭合',
    detail: closure === undefined ? '无 closure' : `${closure.toFixed(3)}%`,
  });
  items.push({
    ok: frame.recipes.length >= 0,
    label: '配方识别可运行',
    detail: `${frame.recipes.length} 个命中`,
  });

  const expectationDefs = activePresetId ? EXPECTATIONS[activePresetId] ?? [] : [];
  const scenarioItems: { ok: boolean; label: string; detail: string }[] = [];
  for (const expectation of expectationDefs) {
    const result = expectation.test(frame);
    scenarioItems.push({ ok: result.pass, label: expectation.label, detail: result.actual });
  }

  const scenarioHtml = scenarioItems.length
    ? `<div class="check-group">场景断言 · ${activePresetId}</div>${scenarioItems
        .map(
          (item) =>
            `<div class="check-line${item.ok ? '' : ' scenario-fail'}"><span class="${item.ok ? 'ok' : 'bad'}">${item.ok ? '✓' : '✗'} ${item.label}</span><span>${item.detail}</span></div>`,
        )
        .join('')}`
    : '';
  checksEl.innerHTML =
    items
      .map(
        (item) =>
          `<div class="check-line"><span class="${item.ok ? 'ok' : 'bad'}">${item.ok ? '✓' : '✗'} ${item.label}</span><span>${item.detail}</span></div>`,
      )
      .join('') + scenarioHtml;

  const physicsPassed = items.filter((item) => item.ok).length;
  const scenarioPassed = scenarioItems.filter((item) => item.ok).length;
  const status = scenarioItems.length
    ? `物理 ${physicsPassed}/${items.length} · 场景 ${scenarioPassed}/${scenarioItems.length}`
    : `物理自检 ${physicsPassed}/${items.length}`;
  setStatus(status, physicsPassed === items.length && scenarioPassed === scenarioItems.length);
}

async function newSimulation(runAll: boolean): Promise<void> {
  stopPlayback();
  const token = ++runToken;
  busy = true;
  setStatus(runAll ? '启动中…' : '初始化…');
  try {
    sim?.destroy();
    map?.destroy();
    config = readConfigFromForm();
    syncOutputs();
    activePresetId = PRESETS.find((preset) => {
      const c = configFromPreset(preset);
      return (
        c.terrain === config.terrain &&
        c.baseTempC === config.baseTempC &&
        c.sstC === config.sstC &&
        c.soil === config.soil &&
        c.humidity === config.humidity &&
        c.windU === config.windU &&
        c.windV === config.windV &&
        c.timeOfDay === config.timeOfDay &&
        c.rounds === config.rounds &&
        c.low === config.low &&
        c.lowTier === config.lowTier &&
        c.lowWarm === config.lowWarm &&
        c.high === config.high &&
        c.wet === config.wet &&
        c.wetTier === config.wetTier &&
        c.cool === config.cool &&
        c.warm === config.warm &&
        c.jet === config.jet
      );
    })?.id ?? '';
    level = buildSandboxLevel(config);
    mapRegion.textContent = `${TERRAIN_OPTIONS.find((item) => item.value === config.terrain)?.label ?? '平原'} · ${config.domainKm} km`;
    const aspect = level.scene.map?.aspect ?? 1;
    fitMapCanvas(aspect);
    sim = new SimulationClient(level);
    frames = [sim.initialFrame];
    viewIndex = 0;
    map = new MapView(mapCanvas, level.scene, sim.grid, sim.fields, {});
    map.setLayers(MAP_LAYERS);
    map.setHistory(frames);
    timeline.min = '0';
    timeline.max = '0';
    timeline.value = '0';
    renderCurrent();
    await sim.ready();
    if (token !== runToken) return;
    busy = false;
    if (runAll) {
      await runAllRounds(token);
    } else {
      setStatus('已初始化', true);
    }
  } catch (error) {
    busy = false;
    const message = error instanceof Error ? error.message : String(error);
    toast(`启动失败：${message}`);
    setStatus('启动失败');
  }
}

async function refreshPersistentForcing(): Promise<void> {
  if (!sim || !level || !config.persist || sim.currentRound === 0) return;
  for (const [index, action] of (level.preset ?? []).entries()) {
    const report = await sim.place({
      ...action,
      id: `persist-${sim.currentRound}-${index}-${action.id}`,
      hour: sim.currentHour,
    });
    if (!report.ok) {
      toast(`持续强迫失败：${report.reason ?? action.variant}`);
      return;
    }
  }
}

async function runAllRounds(token: number): Promise<void> {
  if (!sim) return;
  busy = true;
  setStatus('24h 演化中…');
  try {
    while (!sim.isFinished) {
      await refreshPersistentForcing();
      if (token !== runToken) return;
      await sim.advanceRound();
      if (token !== runToken) return;
      setFrames([...sim.allFrames]);
    }
    setStatus('演化完成', true);
    runChecks();
  } catch (error) {
    toast(`演化失败：${error instanceof Error ? error.message : String(error)}`);
    setStatus('演化失败');
  } finally {
    busy = false;
  }
}

async function stepRound(): Promise<void> {
  if (!sim || busy || sim.isFinished) {
    if (sim?.isFinished) toast('已经跑完；可重置或增加回合。');
    return;
  }
  busy = true;
  setStatus('推进 3h…');
  try {
    await refreshPersistentForcing();
    await sim.advanceRound();
    setFrames([...sim.allFrames]);
    setStatus('已推进', true);
  } catch (error) {
    toast(`推进失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    busy = false;
  }
}

async function injectCard(): Promise<void> {
  if (!sim || !level || busy) return;
  if (sim.isFinished) {
    toast('本场景回合已用完；先重置。');
    return;
  }
  const variant = injectKind.value as CardAction['variant'];
  const kind: CardAction['kind'] =
    variant === 'wet' || variant === 'dry'
      ? 'moisture'
      : variant === 'lowJet'
        ? 'wind'
        : 'pressure';
  const action: CardAction = {
    id: `manual-${Date.now()}`,
    kind,
    variant,
    tier: 3,
    xKm: level.scene.domainKm * 0.5,
    yKm: level.scene.domainKm * 0.52,
    hour: sim.currentHour,
    directionDeg: kind === 'wind' ? 90 : undefined,
  };
  busy = true;
  setStatus('注入卡…');
  try {
    const report = await sim.place(action);
    if (!report.ok) {
      toast(report.reason ?? '注入失败');
      return;
    }
    setFrames([...sim.allFrames]);
    setStatus('已投放 · 可继续投放或推进', true);
  } catch (error) {
    toast(`注入失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    busy = false;
  }
}

function startPlayback(): void {
  if (!frames.length || playing) return;
  if (viewIndex >= frames.length - 1) viewIndex = 0;
  playing = true;
  playButton.textContent = '❚❚';
  playTimer = window.setInterval(() => {
    if (!playing) return;
    if (viewIndex >= frames.length - 1) {
      stopPlayback();
      return;
    }
    setViewIndex(viewIndex + 1);
  }, 500);
}

function bindControls(): void {
  presetSelect.innerHTML = PRESETS.map(
    (preset) => `<option value="${preset.id}">${preset.label}</option>`,
  ).join('');
  terrainSelect.innerHTML = TERRAIN_OPTIONS.map(
    (item) => `<option value="${item.value}">${item.label}</option>`,
  ).join('');
  domainSelect.innerHTML = DOMAIN_OPTIONS.map(
    (item) => `<option value="${item.value}">${item.label}</option>`,
  ).join('');
  mapAspectSelect.innerHTML = MAP_ASPECT_OPTIONS.map(
    (item) => `<option value="${item.value}">${item.label}</option>`,
  ).join('');

  presetSelect.addEventListener('change', () => {
    const preset = PRESETS.find((item) => item.id === presetSelect.value);
    if (!preset) return;
    const currentDomain = config.domainKm;
    config = configFromPreset(preset);
    // 地图尺度是独立设置：预设没有强制域时，保留用户刚选的尺度。
    if (preset.config.domainKm === undefined) config.domainKm = currentDomain;
    presetNote.textContent = preset.note;
    syncFormFromConfig();
    setStatus('预设已载入，待应用');
  });

  const inputs = [
    roundsInput,
    baseTempInput,
    sstInput,
    humidityInput,
    soilInput,
    windUInput,
    windVInput,
    timeInput,
  ];
  for (const input of inputs) {
    input.addEventListener('input', () => {
      config = readConfigFromForm();
      syncOutputs();
      setStatus('参数已变，待应用');
    });
  }
  for (const input of [lowInput, highInput, wetInput, coolInput, warmInput, jetInput, persistInput, lowKind, lowTierSelect, wetTierSelect, domainSelect, mapAspectSelect]) {
    input.addEventListener('change', () => {
      config = readConfigFromForm();
      syncOutputs();
      setStatus('参数已变，待应用');
    });
  }

  applyRunButton.addEventListener('click', () => void newSimulation(true));
  applyResetButton.addEventListener('click', () => void newSimulation(false));
  stepButton.addEventListener('click', () => void stepRound());
  physicsCheckButton.addEventListener('click', runChecks);
  injectButton.addEventListener('click', () => void injectCard());
  playButton.addEventListener('click', () => {
    if (playing) stopPlayback();
    else startPlayback();
  });
  timeline.addEventListener('input', () => {
    stopPlayback();
    setViewIndex(Number(timeline.value));
  });
  window.addEventListener('resize', () => {
    if (level) {
      fitMapCanvas(level.scene.map?.aspect ?? 1);
      map?.resize(true);
    }
    if (frames.length) renderProfile(frames[viewIndex]);
    renderSeries();
  });
}

function initialize(): void {
  bindControls();
  config = configFromPreset(PRESETS[0]);
  presetSelect.value = PRESETS[0].id;
  presetNote.textContent = PRESETS[0].note;
  syncFormFromConfig();
  void newSimulation(false);
}

initialize();
