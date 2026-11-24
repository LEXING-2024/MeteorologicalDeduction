/**
 * V2 · 卷一入口。
 *
 * 直接操作：选一张要素卡 → 在地图上点落点 → 自动演化 3 小时。
 * 判题只看过程链是否成立，不显示星级或分数。
 */

import './ui/v2.css';
import type {
  CardAction,
  Frame,
  JudgeResult,
  LevelDef,
  Tier,
} from './core/types';
import { VOLUME1 } from './levels';
import {
  HOURS_PER_ROUND,
  RECIPE_LABELS,
  TIER_VALUES,
} from './sim/engine';
import { SimulationClient } from './sim/client';
import { judge } from './judge';
import { REFERENCE_PRESSURE_HPA } from './physics/thermo';
import { phaseLabel } from './physics/phase';
import {
  MapView,
  type HoverInfo,
  type MapGhost,
  type MapLayers,
} from './ui/mapView';
import {
  cardsForLevel,
  directionLabel,
  tierLabel,
  windDirections,
  type CardSpec,
} from './ui/cards';

// ── DOM ────────────────────────────────────────────────────────────────────

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少界面元素 #${id}`);
  return element as T;
}

const mapCanvas = byId<HTMLCanvasElement>('map-canvas');
const mapStage = byId<HTMLDivElement>('map-stage');
const mapScaleBar = byId<HTMLElement>('map-scale-bar');
const mapScaleLabel = byId<HTMLElement>('map-scale-label');
const mapRegionLabel = byId<HTMLElement>('map-region-label');
const mapReadout = byId<HTMLDivElement>('map-readout');
const mapTag = byId<HTMLDivElement>('map-tag');
const historyChip = byId<HTMLDivElement>('history-chip');
const placementToast = byId<HTMLDivElement>('placement-toast');
const deckEmpty = byId<HTMLDivElement>('deck-empty');
const terrainLegendTitle = byId<HTMLSpanElement>('terrain-legend-title');
const tempLegendRange = byId<HTMLSpanElement>('temp-legend-range');
const readoutPos = byId<HTMLElement>('readout-pos');
const readoutP = byId<HTMLElement>('readout-p');
const readoutT = byId<HTMLElement>('readout-t');
const readoutApparent = byId<HTMLElement>('readout-apparent');
const readoutWind = byId<HTMLElement>('readout-wind');
const readoutRain = byId<HTMLElement>('readout-rain');
const readoutCloud = byId<HTMLElement>('readout-cloud');
const readoutPhase = byId<HTMLElement>('readout-phase');
const readoutPw = byId<HTMLElement>('readout-pw');
const readoutAdvection = byId<HTMLElement>('readout-advection');
const readoutT850 = byId<HTMLElement>('readout-t850');
const readoutT500 = byId<HTMLElement>('readout-t500');

/**
 * 地图始终铺满舞台，不再按宽高比退回设计画幅、在四周留黑边。
 * 画幅只用于窄屏下给舞台定高；画布本身由 CSS 撑满舞台。
 */
function fitMapCanvas(aspect: number): void {
  const safeAspect = Number.isFinite(aspect) && aspect > 0.2 ? aspect : 1;
  mapStage.style.setProperty('--map-aspect', String(safeAspect));
  mapCanvas.style.removeProperty('width');
  mapCanvas.style.removeProperty('height');
  mapCanvas.style.removeProperty('aspect-ratio');
  mapCanvas.dataset.mapFit = 'cover';
}

function renderMapScale(km: number, _px: number): void {
  mapScaleBar.title = `比例尺 ${km} km`;
  mapScaleLabel.textContent = `${km} km`;
}

const levelTitleEl = byId<HTMLHeadingElement>('level-title');
const levelKicker = byId<HTMLSpanElement>('level-kicker');
const briefTitleEl = byId<HTMLHeadingElement>('brief-title');
const teachingEl = byId<HTMLParagraphElement>('level-teaching');
const sceneEl = byId<HTMLParagraphElement>('level-scene');
const sceneChipsEl = byId<HTMLDivElement>('scene-chips');
const scaleChip = byId<HTMLSpanElement>('level-scale');
const topProgress = byId<HTMLSpanElement>('top-progress');
const goalStatus = byId<HTMLSpanElement>('goal-status');
const goalList = byId<HTMLUListElement>('goal-list');
const hintList = byId<HTMLOListElement>('hint-list');
const hintCount = byId<HTMLSpanElement>('hint-count');
const hintButton = byId<HTMLButtonElement>('btn-hint');
const logList = byId<HTMLOListElement>('log-list');

const clockHour = byId<HTMLSpanElement>('clock-hour');
const clockLocal = byId<HTMLSpanElement>('clock-local');
const timelineTrack = byId<HTMLDivElement>('timeline-track');
const timelineNote = byId<HTMLSpanElement>('timeline-note');
const timelineScrub = byId<HTMLInputElement>('timeline-scrub');
const playButton = byId<HTMLButtonElement>('btn-play');
const speedButton = byId<HTMLButtonElement>('btn-speed');
const roundPips = byId<HTMLDivElement>('round-pips');
const roundInfo = byId<HTMLSpanElement>('round-info');
const roundSub = byId<HTMLSpanElement>('round-sub');
const advanceButton = byId<HTMLButtonElement>('btn-advance');
const skipButton = byId<HTMLButtonElement>('btn-skip');
const prevButton = byId<HTMLButtonElement>('btn-prev-level');
const nextButton = byId<HTMLButtonElement>('btn-next-level');

const deckHint = byId<HTMLSpanElement>('deck-hint');
const cardGrid = byId<HTMLDivElement>('card-grid');
const windDirBlock = byId<HTMLDivElement>('wind-dir');
const windDirGrid = byId<HTMLDivElement>('wind-dir-grid');
const windDirLabel = byId<HTMLElement>('wind-dir-label');

const stationList = byId<HTMLDivElement>('station-list');
const stationHour = byId<HTMLElement>('station-hour');
const diagGrid = byId<HTMLDivElement>('diag-grid');
const recipeList = byId<HTMLDivElement>('recipe-list');

const levelDrawer = byId<HTMLDivElement>('level-drawer');
const levelGrid = byId<HTMLDivElement>('level-grid');
const drawerProgress = byId<HTMLSpanElement>('drawer-progress');
const helpModal = byId<HTMLDivElement>('help-modal');
const resultModal = byId<HTMLDivElement>('result-modal');
const resultBadge = byId<HTMLSpanElement>('result-badge');
const resultTitle = byId<HTMLHeadingElement>('result-title');
const resultDetail = byId<HTMLParagraphElement>('result-detail');
const resultChecks = byId<HTMLUListElement>('result-checks');
const resultRecipes = byId<HTMLDivElement>('result-recipes');
const resultNext = byId<HTMLButtonElement>('btn-result-next');

const toastEl = byId<HTMLDivElement>('toast');

// ── 状态 ───────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'weather-v2-vol1-progress-v1';
const LAST_KEY = 'weather-v2-vol1-last-v1';

interface LogEntry {
  hour: number;
  text: string;
}

interface Selection {
  card: CardSpec;
  tier: Tier;
  directionDeg: number;
}

let level: LevelDef;
let levelIndex = 0;
let sim: SimulationClient;
let map: MapView | null = null;
let currentMapAspect = 1;
let frames: readonly Frame[] = [];
let viewIndex = 0;
let selected: Selection | null = null;
let selectedStation: string | null = null;
let hintLevel = 1;
let busy = false;
let resultShown = false;
let logs: LogEntry[] = [];
let animToken = 0;
let toastTimer = 0;
let progress: Record<string, boolean> = loadProgress();
let deckKey = '';
let judgeKey = '';
let judgeCache: JudgeResult | null = null;
let focusBeforeModal: HTMLElement | null = null;
let playTimer: number | null = null;
let playing = false;
let playSpeed = 1;

const layers: MapLayers = {
  pressure: true,
  wind: true,
  cloud: true,
  rain: true,
  temp: true,
  terrain: true,
};

// ── 工具 ───────────────────────────────────────────────────────────────────

function loadProgress(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === true) out[key] = true;
    }
    return out;
  } catch {
    return {};
  }
}

function saveProgress(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // 浏览器禁用本地存储时不影响游戏。
  }
}

function passedCount(): number {
  return VOLUME1.filter((item) => progress[String(item.id)]).length;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function advectionLabel(value: number): string {
  if (!Number.isFinite(value)) return '平流 --';
  if (Math.abs(value) < 0.05) return '无明显温度平流';
  return `${value < 0 ? '冷平流' : '暖平流'} ${Math.abs(value).toFixed(1)}℃/h`;
}

function fixed(value: number, digits = 1): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '--';
}

function compact(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '--';
  if (Math.abs(value) >= 1e5) return `${(value / 1e5).toFixed(2)}e5`;
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return value.toFixed(0);
}

function formatClock(timeOfDay: number): string {
  const normalized = ((timeOfDay % 24) + 24) % 24;
  const h = Math.floor(normalized);
  const m = Math.floor((normalized - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function currentFrame(): Frame {
  return frames[Math.min(viewIndex, frames.length - 1)];
}

function isLatest(): boolean {
  return viewIndex >= frames.length - 1;
}

function terrainName(levelDef: LevelDef): string {
  switch (levelDef.scene.terrain.kind) {
    case 'coast':
      return '海岸丘陵';
    case 'mountainCoast':
      return '海岸山脉·高原';
    case 'basin':
      return '盆地';
    case 'valley':
      return '山谷';
    case 'pass':
      return '山口通道';
    case 'ridge':
      return '山脊';
    case 'plateau':
      return '高原';
    case 'island':
      return '海岛';
    case 'lake':
      return '内陆湖';
    case 'delta':
      return '三角洲';
    default:
      return '平原';
  }
}

function terrainStory(levelDef: LevelDef): string {
  switch (levelDef.scene.terrain.kind) {
    case 'coast':
      return '海岸线斜穿场景，近岸浅海、丘陵与海陆热力差异共同改变地面风。';
    case 'mountainCoast':
      return '海岸山脉迎风抬升、背风形成雨影，山脉背后接一块高原面。';
    case 'basin':
      return '四周高、中心低的地形让冷空气容易在底部堆积。';
    case 'valley':
      return 'V 形谷地引导山谷风，谷底与坡面的日变化不同。';
    case 'pass':
      return '两山夹一通道，狭管效应会改变风速与风向。';
    case 'ridge':
      return '一条山脊横贯场景，迎风坡与背风坡的对比是读数重点。';
    case 'plateau':
      return '中部高原抬高了地面，气流爬坡会改变云雨分布。';
    case 'island':
      return '岛屿被海面包围，摩擦、海风与地形共同塑造风场。';
    case 'lake':
      return '内陆湖与周围陆地热力差异明显，湖陆风会周期性转向。';
    case 'delta':
      return '低平三角洲与水网提供充足水汽，海岸线附近容易成云致雨。';
    default:
      return '平原上有连续缓丘与浅谷，便于把注意力放在气压与风的关系上。';
  }
}

function scaleText(scale: LevelDef['scale']): string {
  if (scale === 'S') return 'S · 小尺度';
  if (scale === 'L') return 'L · 大尺度';
  return 'M · 中尺度';
}

function cardAccent(card: CardSpec): string {
  if (card.family === 'low') return '#7ccce4';
  if (card.family === 'high') return '#e2b07a';
  return '#b7dbe8';
}

function selectionGhost(): MapGhost | null {
  if (!selected || !isLatest() || sim.isFinished) return null;
  return {
    family: selected.card.family,
    label: `${selected.card.name} · ${tierLabel(selected.tier)}`,
    directionDeg: selected.directionDeg,
  };
}

/** 选卡后的默认落点：优先第一个城市，否则图面中心。 */
function defaultGhostPoint(): { xKm: number; yKm: number } {
  const site = level.scene.sites[0];
  if (site) return { xKm: site.xKm, yKm: site.yKm };
  return {
    xKm: level.scene.domainKm / 2,
    yKm: level.scene.domainKm / 2,
  };
}

/** 判题结果按「关卡 + 帧数」缓存：一帧内多处渲染不必重复判。 */
function currentJudge(): JudgeResult {
  const key = `${level.id}:${frames.length}`;
  if (judgeCache && judgeKey === key) return judgeCache;
  judgeKey = key;
  judgeCache = judge(level, frames);
  return judgeCache;
}

function toast(message: string): void {
  toastEl.textContent = message;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true;
  }, 2200);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function syncModalBody(): void {
  const open =
    !levelDrawer.hidden || !helpModal.hidden || !resultModal.hidden;
  document.body.classList.toggle('is-modal-open', open);
}

// ── 关卡生命周期 ───────────────────────────────────────────────────────────

function startLevel(index: number): void {
  animToken += 1;
  stopPlayback();
  levelIndex = Math.max(0, Math.min(VOLUME1.length - 1, index));
  level = VOLUME1[levelIndex];
  if (sim) sim.destroy();
  sim = new SimulationClient(level);
  frames = [sim.initialFrame];
  viewIndex = 0;
  selected = null;
  selectedStation = null;
  hintLevel = 1;
  busy = false;
  resultShown = false;
  deckKey = '';
  judgeKey = '';
  judgeCache = null;
  logs = [{ hour: 0, text: '进入关卡，读取初始场。' }];

  closeResult();
  closeDrawer();
  closeHelp();

  if (map) map.destroy();
  const mapAspect = level.scene.map?.aspect ?? 1;
  currentMapAspect = mapAspect;
  mapRegionLabel.textContent = level.scene.map?.region ?? '—';
  mapRegionLabel.title = level.scene.map?.region ?? '';
  fitMapCanvas(mapAspect);
  map = new MapView(mapCanvas, level.scene, sim.grid, sim.fields, {
    onCanvasClick: onCanvasClick,
    onHover: onHover,
    onScaleChange: renderMapScale,
  });
  map.setHistory(frames);
  map.setLayers(layers);
  map.setSelectedStation(null);
  map.setFrame(currentFrame());
  map.setGhost(null);

  try {
    window.localStorage.setItem(LAST_KEY, String(level.id));
  } catch {
    // 忽略存储失败。
  }

  map.resize();
  renderStatic();
  renderFrame();
  requestAnimationFrame(() => {
    if (!map) return;
    fitMapCanvas(currentMapAspect);
    map.resize(true);
  });
}

function advanceRoundInternal(auto: boolean, force = false): void {
  if ((!force && busy) || !sim || sim.isFinished) return;
  stopPlayback();
  busy = true;
  if (selected) {
    selected = null;
    map?.setGhost(null);
  }
  const from = frames.length - 1;
  const token = ++animToken;
  renderFrame();

  void (async () => {
    try {
      await sim.ready();
      await sim.advanceRound();
    } catch (error) {
      if (token === animToken) {
        busy = false;
        toast(`模拟失败：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (token !== animToken) return;

    frames = [...sim.allFrames];
    map?.setHistory(frames);
    const to = frames.length - 1;
    renderFrame();

    for (let index = from + 1; index <= to; index += 1) {
      await delay(auto ? 300 : 360);
      if (token !== animToken) return;
      viewIndex = index;
      renderFrame();
    }
    busy = false;
    if (!sim.isFinished) {
      logs.push({
        hour: sim.currentHour,
        text: `第 ${sim.currentRound} 回合演化完成 · 最低气压 ${fixed(
          REFERENCE_PRESSURE_HPA + currentFrame().stats.minP,
          0,
        )} hPa · 气温 ${fixed(currentFrame().stats.minTemp, 1)}–${fixed(
          currentFrame().stats.maxTemp,
          1,
        )}℃。`,
      });
      renderFrame();
    } else {
      finalizeLevel();
    }
  })();
}

function finalizeLevel(): void {
  if (!sim || resultShown) return;
  viewIndex = frames.length - 1;
  busy = false;
  const result = currentJudge();
  if (result.pass) {
    progress[String(level.id)] = true;
    saveProgress();
    renderLevelGrid();
    renderTopProgress();
  }
  renderFrame();
  openResult(result);
}

// ── 放置与选择 ─────────────────────────────────────────────────────────────

function onCanvasClick(xKm: number, yKm: number): void {
  if (busy) return;
  if (!isLatest()) {
    toast('正在回看历史；回到最右端后再放置。');
    return;
  }
  if (!selected) {
    pickStation(xKm, yKm);
    return;
  }
  placeAt(xKm, yKm);
}

async function placeAt(xKm: number, yKm: number): Promise<void> {
  if (!selected || busy || !isLatest() || sim.isFinished) return;
  const choice = selected;
  const action: CardAction = {
    id: `user-${Date.now()}`,
    kind: choice.card.kind,
    variant: choice.card.variant,
    tier: choice.tier,
    xKm,
    yKm,
    hour: sim.currentHour,
    directionDeg: choice.card.kind === 'wind' ? choice.directionDeg : undefined,
  };
  const placedHour = sim.currentHour;
  const placedRound = sim.currentRound;
  stopPlayback();
  busy = true;
  let report: Awaited<ReturnType<SimulationClient['place']>>;
  try {
    report = await sim.place(action);
  } catch (error) {
    busy = false;
    toast(`模拟失败：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!report.ok) {
    busy = false;
    toast(report.reason ?? '无法在这里放置。');
    return;
  }
  logs.push({
    hour: placedHour,
    text: `第 ${placedRound + 1} 回合 · 放置${choice.card.name} ${tierLabel(
      choice.tier,
    )} 于 ${Math.round(xKm)}, ${Math.round(yKm)} km。`,
  });
  selected = null;
  map?.setGhost(null);
  busy = false;
  frames = [...sim.allFrames];
  viewIndex = frames.length - 1;
  map?.setHistory(frames);
  renderFrame();
  deckHint.textContent = '已投放；可继续放卡，或点“推进”结束本回合';
}

/** 键盘微调落点（选卡状态下）。 */
function nudgeGhost(dxKm: number, dyKm: number): void {
  if (!selected) return;
  const current = map?.getGhostPoint() ?? defaultGhostPoint();
  const domain = level.scene.domainKm;
  const next = {
    xKm: Math.min(domain, Math.max(0, current.xKm + dxKm)),
    yKm: Math.min(domain, Math.max(0, current.yKm + dyKm)),
  };
  map?.setGhostPoint(next);
}

/** 回车 / 空格：在 ghost 落点放置当前卡。 */
function placeAtGhost(): boolean {
  if (!selected || busy || sim.isFinished || !isLatest()) return false;
  const point = map?.getGhostPoint() ?? defaultGhostPoint();
  placeAt(point.xKm, point.yKm);
  return true;
}

function pickStation(xKm: number, yKm: number): void {
  let nearest: string | null = null;
  let distance = 34;
  for (const site of level.scene.sites) {
    const d = Math.hypot(site.xKm - xKm, site.yKm - yKm);
    if (d < distance) {
      distance = d;
      nearest = site.id;
    }
  }
  selectedStation = nearest;
  map?.setSelectedStation(nearest);
  renderFrame();
}

function onHover(info: HoverInfo | null): void {
  updateReadout(info);
}

function selectCard(card: CardSpec): void {
  if (busy || sim.isFinished || !isLatest()) {
    toast('当前不能放置：请先回到最新小时。');
    return;
  }
  if (selected?.card.key === card.key) {
    selected = null;
  } else {
    selected = {
      card,
      tier: 2,
      directionDeg: selected?.directionDeg ?? 90,
    };
    revealMapOnNarrow();
  }
  map?.setGhost(selectionGhost());
  if (selected && !map?.getGhostPoint()) {
    map?.setGhostPoint(defaultGhostPoint());
  }
  renderFrame();
}

function revealMapOnNarrow(): void {
  if (window.innerWidth > 1080) return;
  const rect = mapStage.getBoundingClientRect();
  if (rect.top < 8 || rect.bottom > window.innerHeight - 8) {
    mapStage.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function setTier(cardKey: string, tier: Tier): void {
  if (busy || sim.isFinished || !isLatest()) return;
  const card = cardsForLevel(level).find((item) => item.key === cardKey);
  if (!card) return;
  if (selected?.card.key === card.key) {
    selected = { ...selected, tier };
  } else {
    selected = { card, tier, directionDeg: selected?.directionDeg ?? 90 };
  }
  map?.setGhost(selectionGhost());
  if (selected && !map?.getGhostPoint()) {
    map?.setGhostPoint(defaultGhostPoint());
  }
  renderFrame();
}

function setDirection(deg: number): void {
  if (!selected || selected.card.kind !== 'wind') return;
  selected = { ...selected, directionDeg: deg };
  map?.setGhost(selectionGhost());
  renderFrame();
}

// ── 渲染 · 静态 ────────────────────────────────────────────────────────────

function renderStatic(): void {
  levelKicker.textContent = `卷一 · 气压与风 · 第 ${String(level.id).padStart(2, '0')} 关`;
  levelTitleEl.textContent = level.title;
  briefTitleEl.textContent = `${String(level.id).padStart(2, '0')} · ${level.title}`;
  teachingEl.textContent = level.teaching;
  scaleChip.textContent = scaleText(level.scale);

  const bg = Math.hypot(level.scene.bgWindU, level.scene.bgWindV);
  const bgText = bg < 0.3 ? '静风背景' : `背景风 ${bg.toFixed(0)} m/s`;
  sceneEl.textContent = `${terrainStory(level)} ${bgText}。`;
  terrainLegendTitle.textContent = `高程 · ${terrainName(level)}`;

  const chips = [
    terrainName(level),
    `${level.scene.domainKm} km 域`,
    `5 km / 格`,
    `${level.rounds} 回合`,
    `${level.scene.sites.length} 站点`,
  ];
  sceneChipsEl.innerHTML = chips
    .map((text) => `<span class="scene-chip">${escapeHtml(text)}</span>`)
    .join('');

  renderHints();
  renderTopProgress();
  renderLevelGrid();
  buildTimeline();
  updateLevelNav();
  renderFrame();
}

function renderTopProgress(): void {
  topProgress.textContent = `已通过 ${passedCount()} / ${VOLUME1.length}`;
  drawerProgress.textContent = `已通过 ${passedCount()} / ${VOLUME1.length}`;
}

function updateLevelNav(): void {
  prevButton.disabled = levelIndex <= 0;
  nextButton.disabled = levelIndex >= VOLUME1.length - 1;
}

function renderHints(): void {
  const shown = level.hints.slice(0, hintLevel);
  hintList.innerHTML = shown
    .map(
      (hint, index) =>
        `<li class="hint-item"><span class="hint-index">${index + 1}</span><p>${escapeHtml(
          hint,
        )}</p></li>`,
    )
    .join('');
  hintCount.textContent = `${hintLevel} / ${level.hints.length}`;
  hintButton.disabled = hintLevel >= level.hints.length;
  hintButton.textContent =
    hintLevel >= level.hints.length ? '提示已全部展开' : '再提示一条';
}

function renderLevelGrid(): void {
  levelGrid.innerHTML = VOLUME1.map((item, index) => {
    const done = progress[String(item.id)] === true;
    const current = index === levelIndex;
    const state = done ? '已通过' : current ? '当前' : '待完成';
    return `
      <button class="level-card${current ? ' is-current' : ''}${done ? ' is-done' : ''}" type="button" data-level="${index}">
        <span class="level-num">${String(item.id).padStart(2, '0')}</span>
        <span class="level-copy">
          <b>${escapeHtml(item.title)}</b>
          <small>${escapeHtml(item.teaching)}</small>
        </span>
        <span class="level-state">${state}</span>
      </button>
    `;
  }).join('');
}

function buildDeckIfNeeded(): void {
  const key = [
    level.id,
    selected?.card.key ?? '-',
    selected?.tier ?? 0,
    selected?.directionDeg ?? 0,
    busy ? 1 : 0,
    sim.isFinished ? 1 : 0,
    isLatest() ? 1 : 0,
    frames.length,
  ].join('|');
  if (key === deckKey) return;
  deckKey = key;
  buildDeck();
}

function buildDeck(): void {
  const locked = busy || sim.isFinished || !isLatest();
  const tier = selected?.tier ?? 2;
  cardGrid.innerHTML = cardsForLevel(level)
    .map((card) => {
      const active = selected?.card.key === card.key;
      const value =
        card.kind === 'pressure'
          ? `${tierLabel(tier)} = ${TIER_VALUES.pressure[tier - 1]} hPa`
          : `${tierLabel(tier)} = ${TIER_VALUES.wind[tier - 1]} m/s`;
      const thermal =
        card.thermal === 'neutral'
          ? '<em class="thermal neutral">动量</em>'
          : `<em class="thermal ${card.thermal}">${card.thermal === 'warm' ? '暖' : '冷'}</em>`;
      return `
        <div class="card${active ? ' is-selected' : ''}${locked ? ' is-locked' : ''}" data-card="${card.key}" style="--accent:${cardAccent(
          card,
        )}">
          <button class="card-pick" type="button" data-pick="${card.key}" ${locked ? 'disabled' : ''}>
            <span class="card-glyph ${card.family}">${card.glyph}</span>
            <span class="card-copy">
              <span class="card-name">${escapeHtml(card.name)} ${thermal}</span>
              <span class="card-sub">${escapeHtml(card.subtitle)}</span>
            </span>
          </button>
          <div class="tier-row" role="group" aria-label="${escapeHtml(card.name)}强度">
            ${([1, 2, 3] as Tier[])
              .map(
                (t) =>
                  `<button class="tier-btn${
                    active && tier === t ? ' is-active' : ''
                  }" type="button" data-card-key="${card.key}" data-tier="${t}" ${
                    locked ? 'disabled' : ''
                  }>${tierLabel(t)}</button>`,
              )
              .join('')}
          </div>
          <span class="card-strength">${active ? value : ''}</span>
        </div>
      `;
    })
    .join('');

  if (selected) {
    deckHint.textContent = `${selected.card.name} · ${tierLabel(
      selected.tier,
    )} · 点地图`;
  } else if (busy) {
    deckHint.textContent = '演化中…';
  } else if (sim.isFinished) {
    deckHint.textContent = '本关结束';
  } else if (!isLatest()) {
    deckHint.textContent = '回看中';
  } else {
    deckHint.textContent = '选卡后点地图；可连续放多张，推进结束回合';
  }

  const showWind = !!selected && selected.card.kind === 'wind';
  windDirBlock.hidden = !showWind;
  if (showWind && selected) {
    windDirLabel.textContent = directionLabel(selected.directionDeg);
    windDirGrid.innerHTML = windDirections()
      .map(
        (dir) =>
          `<button type="button" class="dir-btn${
            selected && selected.directionDeg === dir.deg ? ' is-active' : ''
          }" data-dir="${dir.deg}" title="${dir.label}" aria-label="流向${dir.label}">${
            dir.arrow
          }</button>`,
      )
      .join('');
  }
}

function buildTimeline(): void {
  const total = level.rounds * HOURS_PER_ROUND;
  let html = '';
  for (let hour = 0; hour <= total; hour += 1) {
    const edge = hour % HOURS_PER_ROUND === 0;
    html += `<button class="tick${edge ? ' round-edge' : ''}" type="button" data-hour="${hour}" aria-label="第 ${hour} 小时">
      <span class="tick-dot"></span>
      <span class="tick-label">${edge ? `h+${hour}` : ''}</span>
    </button>`;
  }
  timelineTrack.innerHTML = html;
  timelineScrub.min = '0';
  timelineScrub.max = String(Math.max(0, frames.length - 1));
  timelineScrub.value = '0';
}

// ── 播放 / 倍速 / 拖动 ──────────────────────────────────────────────────────

function setViewIndex(index: number, clearSelection = false): void {
  const last = Math.max(0, frames.length - 1);
  viewIndex = Math.min(Math.max(0, index), last);
  if (clearSelection) {
    selected = null;
    map?.setGhost(null);
  }
  renderFrame();
}

function updatePlaybackUi(): void {
  playButton.textContent = playing ? '❚❚' : '▶';
  playButton.setAttribute('aria-label', playing ? '暂停播放' : '播放时间轴');
  playButton.classList.toggle('is-on', playing);
  speedButton.textContent = `${playSpeed}×`;
  speedButton.setAttribute('aria-label', `播放倍速 ${playSpeed} 倍`);
  timelineScrub.disabled = busy || frames.length <= 1;
  playButton.disabled = busy || frames.length <= 1;
}

function stopPlayback(): void {
  if (playTimer !== null) {
    window.clearInterval(playTimer);
    playTimer = null;
  }
  playing = false;
  updatePlaybackUi();
}

function startPlaybackTimer(): void {
  if (playTimer !== null) window.clearInterval(playTimer);
  playTimer = window.setInterval(() => {
    if (!playing) return;
    if (busy) {
      stopPlayback();
      return;
    }
    if (viewIndex >= frames.length - 1) {
      stopPlayback();
      return;
    }
    setViewIndex(viewIndex + 1);
  }, Math.round(620 / playSpeed));
}

function togglePlayback(): void {
  if (busy || frames.length <= 1) return;
  if (playing) {
    stopPlayback();
    return;
  }
  if (viewIndex >= frames.length - 1) setViewIndex(0);
  playing = true;
  updatePlaybackUi();
  startPlaybackTimer();
}

function cyclePlaybackSpeed(): void {
  playSpeed = playSpeed >= 4 ? 1 : playSpeed * 2;
  updatePlaybackUi();
  if (playing) startPlaybackTimer();
}

// ── 渲染 · 逐帧 ────────────────────────────────────────────────────────────

function renderFrame(): void {
  const frame = currentFrame();
  if (!frame) return;

  map?.setFrame(frame);
  map?.setHistory(frames);
  map?.setSelectedStation(selectedStation);
  map?.setGhost(selectionGhost());

  clockHour.textContent = `h+${frame.hour}`;
  clockLocal.textContent = formatClock(frame.timeOfDay);
  const dominant = phaseLabel(frame.stats.dominantPhase ?? 'none');
  mapTag.textContent = `海平面气压 ${Math.round(REFERENCE_PRESSURE_HPA + frame.stats.minP)}–${Math.round(
    REFERENCE_PRESSURE_HPA + frame.stats.maxP,
  )} hPa · 气温 ${fixed(frame.stats.minTemp, 0)}–${fixed(frame.stats.maxTemp, 0)}℃ · 降水 ${
    dominant === '—' ? '无' : dominant
  } · PW ${fixed(frame.stats.meanPwMm ?? 0, 0)} mm`;
  tempLegendRange.textContent = `${fixed(frame.stats.minTemp, 0)}–${fixed(frame.stats.maxTemp, 0)}℃`;
  historyChip.hidden = isLatest();
  timelineNote.textContent = isLatest() ? `当前 h+${frame.hour}` : `回看 h+${frame.hour}`;

  updateTimeline(frame);
  updateRoundPips();
  renderGoals();
  renderStations(frame);
  renderDiagnostics(frame);
  renderLogs();
  updateButtons(frame);
  buildDeckIfNeeded();
  placementToast.hidden = !(selected && isLatest() && !busy && !sim.isFinished);
  if (selected && !isLatest()) {
    placementToast.hidden = true;
  }
  deckEmpty.hidden = !(
    !selected &&
    sim.actionsUsed === 0 &&
    sim.currentHour === 0 &&
    !busy &&
    isLatest()
  );
}

function updateTimeline(frame: Frame): void {
  const ticks = timelineTrack.querySelectorAll<HTMLButtonElement>('.tick');
  ticks.forEach((tick) => {
    const hour = Number(tick.dataset.hour ?? '0');
    tick.classList.toggle('is-active', hour === frame.hour);
    tick.classList.toggle('is-past', hour < frame.hour);
    tick.disabled = busy || hour > frames.length - 1;
  });
  timelineScrub.max = String(Math.max(0, frames.length - 1));
  timelineScrub.value = String(Math.min(viewIndex, frames.length - 1));
  timelineScrub.disabled = busy || frames.length <= 1;
}

function updateRoundPips(): void {
  const current = sim.currentRound;
  let html = '';
  for (let round = 0; round < level.rounds; round += 1) {
    const state =
      sim.isFinished || round < current
        ? 'done'
        : round === current
          ? 'active'
          : 'pending';
    html += `<span class="round-pip ${state}" title="第 ${round + 1} 回合"><i>${
      round + 1
    }</i></span>`;
  }
  roundPips.innerHTML = html;
}

function renderGoals(): void {
  const result = currentJudge();
  const frame = currentFrame();
  const final = sim.isFinished;
  const checks = result.checks.filter((item) => item.required);
  goalList.innerHTML = checks
    .map((check) => {
      const definition = [...level.chain, ...level.fallback].find(
        (item) => item.id === check.id,
      );
      const spatialDef = level.spatial?.find((item) => item.id === check.id);
      const windowEnd =
        definition?.windowH[1] ??
        (spatialDef ? Math.max(...spatialDef.assertions.map((item) => item.windowH[1])) : 0);
      const windowStart =
        definition?.windowH[0] ??
        (spatialDef ? Math.min(...spatialDef.assertions.map((item) => item.windowH[0])) : 0);
      const inWindow = frame.hour >= windowStart;
      const state = check.ok
        ? 'ok'
        : final || frame.hour >= windowEnd
          ? 'fail'
          : 'pending';
      const detail = !inWindow ? '等待演化到该时间窗' : check.detail ?? '';
      const fallback = level.fallback.some((item) => item.id === check.id);
      return `<li class="goal ${state}${fallback ? ' is-fallback' : ''}">
        <span class="goal-state" aria-hidden="true">${
          state === 'ok' ? '✓' : state === 'fail' ? '×' : '·'
        }</span>
        <span class="goal-copy">
          <span class="goal-label">${escapeHtml(check.label)}${
            fallback ? '<em class="goal-tag">兜底</em>' : ''
          }</span>
          <span class="goal-detail">${escapeHtml(detail)}</span>
        </span>
      </li>`;
    })
    .join('');

  const failed = result.checks.some(
    (check) => check.required && !check.ok,
  );
  const okCount = checks.filter((check) => check.ok).length;
  goalStatus.className = `status-pill ${
    final ? (failed ? 'fail' : 'ok') : 'pending'
  }`;
  goalStatus.textContent = final
    ? failed
      ? '未通过'
      : '已通过'
    : `进行中 · ${okCount}/${checks.length}`;
}

function renderStations(frame: Frame): void {
  stationHour.textContent = String(frame.hour);
  const sites = level.scene.sites
    .map((site) => frame.sites[site.id])
    .filter((site) => !!site);
  if (sites.length === 0) {
    stationList.innerHTML = '<p class="empty-note">本关没有站点。</p>';
    return;
  }
  stationList.innerHTML = sites
    .map((site) => {
      const active = selectedStation === site.id;
      const windRotation = (site.windDir + 180) % 360;
      const rain = site.precipAcc >= 10 ? site.precipAcc.toFixed(0) : site.precipAcc.toFixed(1);
      const phase = phaseLabel(site.phase);
      return `
        <button class="station${active ? ' is-active' : ''}" type="button" data-station="${site.id}">
          <span class="station-head">
            <span class="station-name">${escapeHtml(site.name)}${
              site.marine ? '<em class="marine-tag">海上</em>' : ''
            }</span>
            <span class="station-wind" style="transform: rotate(${windRotation}deg)" title="风向 ${Math.round(
              site.windDir,
            )}°">↑</span>
          </span>
          <span class="station-metrics">
            <span><em>气压</em><b>${fixed(REFERENCE_PRESSURE_HPA + site.p, 0)}</b><i>hPa</i></span>
            <span><em>气温</em><b>${site.t2m.toFixed(1)}</b><i>℃</i></span>
            <span><em>体感</em><b>${site.apparentC.toFixed(1)}</b><i>℃</i></span>
            <span><em>云量</em><b>${Math.round(site.cc * 100)}</b><i>%</i></span>
            <span><em>降水</em><b>${rain}</b><i>mm · ${phase}</i></span>
            <span><em>风速</em><b>${site.wind10.toFixed(1)}</b><i>m/s</i></span>
          </span>
          <span class="station-trends">
            <span class="trend-row"><em>气压</em><canvas class="station-spark" width="304" height="30" data-site="${site.id}" data-metric="pressure" aria-hidden="true"></canvas></span>
            <span class="trend-row"><em>降水</em><canvas class="station-spark" width="304" height="30" data-site="${site.id}" data-metric="acc" aria-hidden="true"></canvas></span>
            <span class="trend-row"><em>风速</em><canvas class="station-spark" width="304" height="30" data-site="${site.id}" data-metric="wind" aria-hidden="true"></canvas></span>
          </span>
          <span class="station-foot">${advectionLabel(site.tempAdvectionKPerH)} · 跨等压线 ${
            Number.isFinite(site.crossAngle) ? `${Math.round(site.crossAngle)}°` : '—'
          } · RH ${Math.round(site.rh)}% · PW ${fixed(site.pwMm, 0)} mm</span>
        </button>
      `;
    })
    .join('');
  drawStationSparks();
}

/** 站点三曲线：实际气压、累计降水、10 m 风速。 */
function drawStationSparks(): void {
  const points = frames.slice(0, viewIndex + 1);
  stationList.querySelectorAll<HTMLCanvasElement>('.station-spark').forEach((canvas) => {
    const id = canvas.dataset.site;
    const metric = canvas.dataset.metric ?? 'pressure';
    const ctx = canvas.getContext('2d');
    if (!id || !ctx) return;
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const series: number[] = [];
    for (const frame of points) {
      const site = frame.sites[id];
      if (!site) continue;
      if (metric === 'acc') series.push(site.precipAcc);
      else if (metric === 'wind') series.push(site.wind10);
      else series.push(REFERENCE_PRESSURE_HPA + site.p);
    }
    if (series.length === 0) return;

    const min = metric === 'pressure' ? Math.min(...series) : 0;
    const max = Math.max(...series, metric === 'pressure' ? min + 1 : 0.1);
    const span = Math.max(max - min, 0.4);
    const lo = metric === 'pressure' ? min - span * 0.08 : 0;
    const hi = max + span * 0.08;
    const inset = 6;
    const x = (index: number): number =>
      series.length === 1
        ? width / 2
        : inset + (index / (series.length - 1)) * (width - inset * 2);
    const y = (value: number): number =>
      inset + ((hi - value) / Math.max(hi - lo, 1e-6)) * (height - inset * 2);

    const color =
      metric === 'pressure'
        ? 'rgba(124, 204, 232, 0.92)'
        : metric === 'acc'
          ? 'rgba(105, 218, 165, 0.92)'
          : 'rgba(238, 190, 126, 0.92)';

    ctx.strokeStyle = 'rgba(157, 193, 212, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height - inset);
    ctx.lineTo(width, height - inset);
    ctx.stroke();

    if (metric === 'acc' && series.length > 1) {
      ctx.fillStyle = 'rgba(105, 218, 165, 0.12)';
      ctx.beginPath();
      ctx.moveTo(x(0), height - inset);
      series.forEach((value, index) => ctx.lineTo(x(index), y(value)));
      ctx.lineTo(x(series.length - 1), height - inset);
      ctx.closePath();
      ctx.fill();
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    series.forEach((value, index) => {
      const px = x(index);
      const py = y(value);
      if (index === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();

    const lastX = x(series.length - 1);
    const lastY = y(series[series.length - 1]);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(lastX, lastY, 2.2, 0, Math.PI * 2);
    ctx.fill();
  });
}

function renderDiagnostics(frame: Frame): void {
  const stats = frame.stats;
  const cells: { label: string; value: string; unit: string }[] = [
    { label: '最低气压', value: fixed(REFERENCE_PRESSURE_HPA + stats.minP, 0), unit: 'hPa' },
    { label: '最高气压', value: fixed(REFERENCE_PRESSURE_HPA + stats.maxP, 0), unit: 'hPa' },
    { label: '最大风速', value: fixed(stats.maxWind, 1), unit: 'm/s' },
    { label: '最大云量', value: String(Math.round(stats.maxCloud * 100)), unit: '%' },
    { label: '雨区半径', value: String(Math.round(stats.rainRadiusKm)), unit: 'km' },
    { label: '最大降水', value: fixed(stats.maxRain, 1), unit: 'mm/h' },
    {
      label: '可降水量',
      value: fixed(stats.meanPwMm ?? 0, 0),
      unit: `mm · max ${fixed(stats.maxPwMm ?? 0, 0)}`,
    },
    {
      label: '850 hPa 温度',
      value: fixed(stats.meanT850 ?? 0, 1),
      unit: `℃ · ${fixed(stats.minT850 ?? 0, 1)}–${fixed(stats.maxT850 ?? 0, 1)}`,
    },
    { label: '700 hPa 温度', value: fixed(stats.meanT700 ?? 0, 1), unit: '℃' },
    {
      label: '500 hPa 温度',
      value: fixed(stats.meanT500 ?? 0, 1),
      unit: `℃ · ${fixed(stats.minT500 ?? 0, 1)}–${fixed(stats.maxT500 ?? 0, 1)}`,
    },
    {
      label: '雨带形态',
      value: frame.morphology ? `${frame.morphology.rainElongation.toFixed(1)}:1` : '--',
      unit: frame.morphology ? `${Math.round(frame.morphology.rainAxisDeg)}°` : '',
    },
    { label: '降雪', value: fixed(stats.maxSnowRate ?? 0, 1), unit: 'mm/h' },
    { label: '水汽初值', value: compact(stats.waterStart), unit: '格·g/kg' },
    { label: '累计蒸发', value: compact(stats.waterEvaporated), unit: '格·g/kg' },
    { label: '累计降水', value: compact(stats.waterRained), unit: '格·g/kg' },
    { label: '当前水汽', value: compact(stats.waterEnd), unit: '格·g/kg' },
    { label: '边界修正', value: compact(stats.waterBoundary), unit: '格·g/kg' },
    {
      label: '水汽闭合',
      value: stats.waterClosure === undefined ? '--' : (stats.waterClosure * 100).toFixed(2),
      unit: '%',
    },
  ];
  diagGrid.innerHTML = cells
    .map(
      (cell) =>
        `<span class="diag-cell"><em>${cell.label}</em><b>${cell.value}</b><i>${cell.unit}</i></span>`,
    )
    .join('');

  const recipes = frame.recipes;
  const shown = recipes.slice(0, 10);
  recipeList.innerHTML =
    recipes.length === 0
      ? '<span class="recipe-empty">尚未识别到完整过程</span>'
      : shown
          .map(
            (id) =>
              `<span class="recipe-chip">${escapeHtml(
                RECIPE_LABELS[id] ?? id,
              )}</span>`,
          )
          .join('') +
        (recipes.length > shown.length
          ? `<span class="recipe-chip recipe-more">+${recipes.length - shown.length}</span>`
          : '');
}

function renderLogs(): void {
  const entries = logs.slice(-6);
  logList.innerHTML = entries
    .map(
      (entry) =>
        `<li class="log-item"><span class="log-hour">h+${entry.hour}</span><span>${escapeHtml(
          entry.text,
        )}</span></li>`,
    )
    .join('');
}

function updateButtons(frame: Frame): void {
  const finished = sim.isFinished;
  const latest = isLatest();
  // 结算后仍允许从任意回看位置打开结果。
  advanceButton.disabled = busy || (!latest && !finished);
  skipButton.disabled = busy || finished || !latest;
  advanceButton.textContent = busy
    ? '演化中…'
    : finished
      ? '查看结果'
      : `推进 ${HOURS_PER_ROUND} 小时`;
  skipButton.hidden = finished;
  const nextHour = Math.min(
    frame.hour + HOURS_PER_ROUND,
    level.rounds * HOURS_PER_ROUND,
  );
  roundInfo.textContent = finished
    ? `本关结束 · ${level.rounds} 回合`
    : `第 ${Math.min(sim.currentRound + 1, level.rounds)} / ${level.rounds} 回合`;
  roundSub.textContent = finished
    ? '过程判定已完成，可回看任意小时'
    : latest
      ? `下一段 h+${frame.hour} → h+${nextHour}`
      : `回看 h+${frame.hour}，操作已暂停`;
  updatePlaybackUi();
}

let readoutBox: { width: number; height: number } | null = null;

function updateReadout(info: HoverInfo | null): void {
  if (!info) {
    mapReadout.hidden = true;
    return;
  }
  mapReadout.hidden = false;
  // 结构只更新文本，不重建 innerHTML；固定宽度也避免每次移动触发回流。
  readoutPos.textContent = `${info.xKm.toFixed(0)}, ${info.yKm.toFixed(0)} km`;
  readoutP.textContent = info.p.toFixed(0);
  readoutT.textContent = info.t.toFixed(1);
  readoutApparent.textContent = info.apparent.toFixed(1);
  readoutWind.textContent = info.wind.toFixed(1);
  readoutRain.textContent = info.rain.toFixed(1);
  readoutCloud.textContent = Math.round(info.cc * 100).toString();
  readoutPhase.textContent = info.phase;
  readoutPw.textContent = info.pwMm.toFixed(0);
  readoutAdvection.textContent = advectionLabel(info.tempAdvectionKPerH);
  readoutT850.textContent = Number.isFinite(info.t850) ? info.t850.toFixed(1) : '—';
  readoutT500.textContent = Number.isFinite(info.t500) ? info.t500.toFixed(1) : '—';

  if (!readoutBox) {
    readoutBox = {
      width: mapReadout.offsetWidth || 214,
      height: mapReadout.offsetHeight || 108,
    };
  }
  const stageRect = mapStage.getBoundingClientRect();
  const canvasRect = mapCanvas.getBoundingClientRect();
  // HoverInfo.screenX/Y 是相对画布的坐标；地图按画幅居中时会存在左右留边，
  // 这里换算成相对地图舞台的坐标，卡片才不会偏离指针。
  const pointerX = info.screenX + (canvasRect.left - stageRect.left);
  const pointerY = info.screenY + (canvasRect.top - stageRect.top);
  let left = pointerX + 16;
  let top = pointerY + 16;
  if (left + readoutBox.width > stageRect.width - 8) {
    left = pointerX - readoutBox.width - 16;
  }
  if (top + readoutBox.height > stageRect.height - 8) {
    top = pointerY - readoutBox.height - 16;
  }
  left = Math.max(8, Math.min(left, stageRect.width - readoutBox.width - 8));
  top = Math.max(8, Math.min(top, stageRect.height - readoutBox.height - 8));
  mapReadout.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
}

// ── 弹层 ───────────────────────────────────────────────────────────────────

function rememberFocus(): void {
  focusBeforeModal =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

function restoreFocus(): void {
  if (focusBeforeModal && focusBeforeModal.isConnected) focusBeforeModal.focus();
  focusBeforeModal = null;
}

function openResult(result: JudgeResult): void {
  rememberFocus();
  resultShown = true;
  resultBadge.className = `result-badge ${result.pass ? 'ok' : 'fail'}`;
  resultBadge.textContent = result.pass ? '过程成立' : '过程未成立';
  resultTitle.textContent = result.pass
    ? `${String(level.id).padStart(2, '0')} · ${level.title}`
    : `${String(level.id).padStart(2, '0')} · 还差一点`;
  resultDetail.textContent = result.detail;
  resultChecks.innerHTML = result.checks
    .filter((check) => check.required)
    .map((check) => {
      const fallback = level.fallback.some((item) => item.id === check.id);
      return `<li class="${check.ok ? 'ok' : 'fail'}">
          <span class="check-mark" aria-hidden="true">${check.ok ? '✓' : '×'}</span>
          <span class="check-copy"><b>${escapeHtml(check.label)}${
            fallback ? '<em class="goal-tag">兜底</em>' : ''
          }</b><small>${escapeHtml(check.detail ?? '')}</small></span>
        </li>`;
    })
    .join('');
  resultRecipes.innerHTML =
    result.recipes.length === 0
      ? '<span class="recipe-empty">尚未识别到过程</span>'
      : result.recipes
          .map(
            (id) =>
              `<span class="recipe-chip">${escapeHtml(
                RECIPE_LABELS[id] ?? id,
              )}</span>`,
          )
          .join('');
  resultNext.disabled = levelIndex >= VOLUME1.length - 1;
  resultNext.textContent =
    levelIndex >= VOLUME1.length - 1 ? '已是最后一关' : '下一关';
  resultModal.hidden = false;
  syncModalBody();
  const review = byId<HTMLButtonElement>('btn-result-review');
  (resultNext.disabled ? review : resultNext).focus();
}

function closeResult(): void {
  resultModal.hidden = true;
  syncModalBody();
  restoreFocus();
}

function openDrawer(): void {
  rememberFocus();
  renderLevelGrid();
  levelDrawer.hidden = false;
  syncModalBody();
  levelDrawer.querySelector<HTMLButtonElement>('[data-close-drawer]')?.focus();
}

function closeDrawer(): void {
  levelDrawer.hidden = true;
  syncModalBody();
  restoreFocus();
}

function openHelp(): void {
  rememberFocus();
  helpModal.hidden = false;
  syncModalBody();
  helpModal.querySelector<HTMLButtonElement>('[data-close-help]')?.focus();
}

function closeHelp(): void {
  helpModal.hidden = true;
  syncModalBody();
  restoreFocus();
}

// ── 事件绑定 ───────────────────────────────────────────────────────────────

function bindEvents(): void {
  byId<HTMLButtonElement>('btn-open-levels').addEventListener('click', openDrawer);
  byId<HTMLButtonElement>('btn-open-help').addEventListener('click', openHelp);
  byId<HTMLButtonElement>('btn-reset-view').addEventListener('click', () => map?.resetView());

  const focusMapButton = byId<HTMLButtonElement>('btn-focus-map');
  focusMapButton.addEventListener('click', () => {
    const active = document.body.classList.toggle('v2-focus-map');
    focusMapButton.classList.toggle('is-on', active);
    focusMapButton.setAttribute('aria-pressed', active ? 'true' : 'false');
    focusMapButton.title = active ? '退出专注地图' : '专注地图';
    // 面板隐藏后画布尺寸变化，等布局稳定再重新 fit，否则投影会落在旧尺寸上。
    window.requestAnimationFrame(() => {
      fitMapCanvas(currentMapAspect);
      map?.resize(true);
    });
  });

  levelDrawer.querySelectorAll<HTMLElement>('[data-close-drawer]').forEach((element) => {
    element.addEventListener('click', closeDrawer);
  });
  helpModal.querySelectorAll<HTMLElement>('[data-close-help]').forEach((element) => {
    element.addEventListener('click', closeHelp);
  });

  levelGrid.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>('[data-level]');
    if (!button) return;
    startLevel(Number(button.dataset.level ?? '0'));
  });

  byId<HTMLButtonElement>('btn-hint').addEventListener('click', () => {
    if (hintLevel >= level.hints.length) return;
    hintLevel += 1;
    renderHints();
  });

  byId<HTMLDivElement>('layer-toggles').addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>('[data-layer]');
    if (!button) return;
    const key = button.dataset.layer as keyof MapLayers | undefined;
    if (!key) return;
    layers[key] = !layers[key];
    button.classList.toggle('is-on', layers[key]);
    map?.setLayers(layers);
  });

  advanceButton.addEventListener('click', () => {
    if (busy) return;
    if (sim.isFinished) {
      openResult(currentJudge());
      return;
    }
    if (selected) {
      toast('已选卡：请在地图上点落点，或按 Esc 取消选择。');
      return;
    }
    if (!isLatest()) {
      toast('正在回看历史；回到最右端后再推进。');
      return;
    }
    advanceRoundInternal(false);
  });

  skipButton.addEventListener('click', () => {
    if (busy || sim.isFinished || !isLatest()) return;
    selected = null;
    map?.setGhost(null);
    renderFrame();
    advanceRoundInternal(false);
  });

  cardGrid.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const tierButton = target.closest<HTMLButtonElement>('[data-tier]');
    if (tierButton) {
      const key = tierButton.dataset.cardKey;
      const tier = Number(tierButton.dataset.tier ?? '2') as Tier;
      if (key) setTier(key, tier);
      return;
    }
    const pick = target.closest<HTMLButtonElement>('[data-pick]');
    if (!pick) return;
    const card = cardsForLevel(level).find((item) => item.key === pick.dataset.pick);
    if (card) selectCard(card);
  });

  windDirGrid.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>('[data-dir]');
    if (!button) return;
    setDirection(Number(button.dataset.dir ?? '90'));
  });

  timelineTrack.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>('[data-hour]');
    if (!button || busy) return;
    const hour = Number(button.dataset.hour ?? '0');
    if (hour > frames.length - 1) return;
    stopPlayback();
    setViewIndex(hour, true);
  });

  timelineScrub.addEventListener('input', () => {
    if (busy) return;
    stopPlayback();
    setViewIndex(Number(timelineScrub.value), true);
  });

  playButton.addEventListener('click', () => {
    togglePlayback();
  });

  speedButton.addEventListener('click', () => {
    cyclePlaybackSpeed();
  });

  stationList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>('[data-station]');
    if (!button) return;
    selectedStation = button.dataset.station ?? null;
    map?.setSelectedStation(selectedStation);
    renderFrame();
  });

  prevButton.addEventListener('click', () => {
    if (levelIndex > 0) startLevel(levelIndex - 1);
  });
  nextButton.addEventListener('click', () => {
    if (levelIndex < VOLUME1.length - 1) startLevel(levelIndex + 1);
  });

  byId<HTMLButtonElement>('btn-result-review').addEventListener('click', closeResult);
  resultModal.querySelector('.modal-backdrop')?.addEventListener('click', closeResult);
  byId<HTMLButtonElement>('btn-result-retry').addEventListener('click', () => {
    startLevel(levelIndex);
  });
  resultNext.addEventListener('click', () => {
    if (levelIndex < VOLUME1.length - 1) startLevel(levelIndex + 1);
  });

  let mapFitRaf = 0;
  let mapFitTimer = 0;
  const refitMap = (): void => {
    if (mapFitRaf) {
      cancelAnimationFrame(mapFitRaf);
      mapFitRaf = 0;
    }
    if (mapFitTimer) {
      clearTimeout(mapFitTimer);
      mapFitTimer = 0;
    }
    fitMapCanvas(currentMapAspect);
    map?.resize(true);
  };
  const scheduleMapRefit = (): void => {
    if (mapFitRaf || mapFitTimer) return;
    mapFitRaf = requestAnimationFrame(refitMap);
    // 某些嵌入/后台场景 requestAnimationFrame 会被节流，定时器兜底保证仍能重算。
    mapFitTimer = window.setTimeout(refitMap, 90);
  };

  window.addEventListener('resize', scheduleMapRefit);
  window.visualViewport?.addEventListener('resize', scheduleMapRefit);
  document.addEventListener('fullscreenchange', scheduleMapRefit);
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(scheduleMapRefit);
    observer.observe(mapStage);
  }

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!resultModal.hidden) {
        closeResult();
      } else if (!helpModal.hidden) {
        closeHelp();
      } else if (!levelDrawer.hidden) {
        closeDrawer();
      } else if (selected) {
        selected = null;
        map?.setGhost(null);
        renderFrame();
      }
      return;
    }
    if (document.body.classList.contains('is-modal-open')) return;
    if (event.key === 'Enter') {
      if (selected) {
        event.preventDefault();
        placeAtGhost();
      }
      return;
    }
    if (event.key === ' ') {
      event.preventDefault();
      if (selected) {
        placeAtGhost();
      } else if (!busy && !sim.isFinished && isLatest()) {
        advanceRoundInternal(false);
      }
      return;
    }
    if (event.key.startsWith('Arrow') && selected) {
      event.preventDefault();
      const step = event.shiftKey ? 5 : 20;
      if (event.key === 'ArrowLeft') nudgeGhost(-step, 0);
      else if (event.key === 'ArrowRight') nudgeGhost(step, 0);
      else if (event.key === 'ArrowUp') nudgeGhost(0, step);
      else nudgeGhost(0, -step);
      return;
    }
    if (event.key.toLowerCase() === 'r') {
      map?.resetView();
      return;
    }
    if (/^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1;
      const cards = cardsForLevel(level);
      if (cards[index]) selectCard(cards[index]);
    }
  });
}

// ── 启动 ───────────────────────────────────────────────────────────────────

async function runDemo(): Promise<void> {
  if (!level.demoActions || level.demoActions.length === 0) return;
  try {
    await sim.ready();
    for (const action of level.demoActions) {
      const report = await sim.place(action);
      if (!report.ok) {
        console.warn('[v2] 演示动作放置失败', action, report);
        logs.push({
          hour: sim.currentHour,
          text: `演示中断：${report.reason ?? '放置失败'}`,
        });
        return;
      }
      await sim.advanceRound();
    }
    while (!sim.isFinished) await sim.advanceRound();
    frames = [...sim.allFrames];
    map?.setHistory(frames);
    viewIndex = frames.length - 1;
    judgeKey = '';
    logs.push({ hour: sim.currentHour, text: '演示解法已载入。' });
    renderFrame();
  } catch (error) {
    console.error('[v2] 演示失败', error);
  }
}

function initialLevelIndex(): number {
  let requested: number | null = null;
  try {
    const param = new URLSearchParams(window.location.search).get('level');
    if (param) requested = Number(param);
  } catch {
    requested = null;
  }
  if (requested !== null && Number.isFinite(requested)) {
    const direct = VOLUME1.findIndex((item) => item.id === requested);
    if (direct >= 0) return direct;
  }
  let last = 1;
  try {
    last = Number(window.localStorage.getItem(LAST_KEY) ?? '1');
  } catch {
    last = 1;
  }
  const found = VOLUME1.findIndex((item) => item.id === last);
  return found >= 0 ? found : 0;
}

bindEvents();
window.addEventListener('error', (event) => {
  const target = document.getElementById('level-teaching');
  if (target && !target.textContent) {
    target.textContent = `启动失败：${event.message}`;
  }
});
try {
  startLevel(initialLevelIndex());
  if (new URLSearchParams(window.location.search).has('demo')) {
    void runDemo();
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const target = document.getElementById('level-teaching');
  if (target) target.textContent = `启动失败：${message}`;
  console.error('[v2] 启动失败', error);
}
