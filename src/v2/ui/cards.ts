/**
 * V2 · 要素卡定义（卷一）。
 *
 * 卡片不是收集品，而是对大气的一种“源 / 汇 / 异常”注入。
 * 卷一开放气压与低空急流，因此这里只描述这两类。
 */

import type { CardKind, CardVariant, LevelDef, Tier } from '../core/types';

export type CardFamily = 'low' | 'high' | 'jet';

export interface CardSpec {
  key: string;
  kind: CardKind;
  variant: CardVariant;
  name: string;
  family: CardFamily;
  thermal: 'warm' | 'cold' | 'neutral';
  subtitle: string;
  detail: string;
  glyph: string;
}

export const PRESSURE_CARDS: CardSpec[] = [
  {
    key: 'coldLow',
    kind: 'pressure',
    variant: 'coldLow',
    name: '冷低压',
    family: 'low',
    thermal: 'cold',
    subtitle: '冷性气旋',
    detail: '低层辐合上升，云层厚而稳定，降水效率偏低。',
    glyph: 'L',
  },
  {
    key: 'warmLow',
    kind: 'pressure',
    variant: 'warmLow',
    name: '暖低压',
    family: 'low',
    thermal: 'warm',
    subtitle: '暖性气旋',
    detail: '暖核抬升更强，对流旺盛，降水效率高。',
    glyph: 'L',
  },
  {
    key: 'warmHigh',
    kind: 'pressure',
    variant: 'warmHigh',
    name: '暖高压',
    family: 'high',
    thermal: 'warm',
    subtitle: '暖性反气旋',
    detail: '下沉气流控制，云被压散，近地面风向外辐散。',
    glyph: 'H',
  },
  {
    key: 'coldHigh',
    kind: 'pressure',
    variant: 'coldHigh',
    name: '冷高压',
    family: 'high',
    thermal: 'cold',
    subtitle: '冷性反气旋',
    detail: '干冷空气下沉，天空晴朗，夜间降温更明显。',
    glyph: 'H',
  },
];

export const WIND_CARDS: CardSpec[] = [
  {
    key: 'lowJet',
    kind: 'wind',
    variant: 'lowJet',
    name: '低空急流',
    family: 'jet',
    thermal: 'neutral',
    subtitle: '动量注入',
    detail: '沿指定方向注入一条狭长强风带，用来搬运或引导系统。',
    glyph: '≫',
  },
];

const KIND_ORDER: CardKind[] = ['pressure', 'wind'];

export function cardsForLevel(level: LevelDef): CardSpec[] {
  const all = [...PRESSURE_CARDS, ...WIND_CARDS];
  return KIND_ORDER.filter((kind) => level.available.includes(kind)).flatMap((kind) =>
    all.filter((card) => card.kind === kind),
  );
}

export function cardByKey(key: string): CardSpec | undefined {
  return [...PRESSURE_CARDS, ...WIND_CARDS].find((card) => card.key === key);
}

export function tierLabel(tier: Tier): string {
  return ['I', 'II', 'III'][tier - 1] ?? 'II';
}

const DIRECTIONS: { deg: number; label: string; arrow: string }[] = [
  { deg: 0, label: '北', arrow: '↑' },
  { deg: 45, label: '东北', arrow: '↗' },
  { deg: 90, label: '东', arrow: '→' },
  { deg: 135, label: '东南', arrow: '↘' },
  { deg: 180, label: '南', arrow: '↓' },
  { deg: 225, label: '西南', arrow: '↙' },
  { deg: 270, label: '西', arrow: '←' },
  { deg: 315, label: '西北', arrow: '↖' },
];

export function windDirections(): typeof DIRECTIONS {
  return DIRECTIONS;
}

export function directionLabel(deg: number): string {
  const normalized = ((deg % 360) + 360) % 360;
  let best = DIRECTIONS[0];
  let bestDiff = 999;
  for (const dir of DIRECTIONS) {
    const diff = Math.min(
      Math.abs(dir.deg - normalized),
      360 - Math.abs(dir.deg - normalized),
    );
    if (diff < bestDiff) {
      bestDiff = diff;
      best = dir;
    }
  }
  return best.label;
}
