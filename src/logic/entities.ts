import {
  CARD_ENTITY_TYPE,
  CARD_VARIANTS,
  DEFAULT_LAYER_BY_TYPE,
  DEFAULT_VARIANT,
  DEPTH_BY_TYPE,
  defaultEntityRadius,
  ENTITY_META,
  ENTITY_STRENGTHS,
  INVERSION_LABEL,
  JET_DEFAULT_ANGLE,
  MAX_ENTITY_RADIUS,
  MIN_ENTITY_RADIUS,
  MAP_SIZE,
} from '../config/constants';
import { typhoonCategoryLabel } from './typhoon';
import type {
  CardType,
  EntityType,
  InversionMode,
  LevelDefinition,
  MapLayer,
  WeatherEntity,
} from './types';

let entityCounter = 0;

function stableSeed(type: EntityType, x: number, y: number, strength: number, radius: number): number {
  let hash = 2166136261;
  const key = `${type}:${x.toFixed(1)}:${y.toFixed(1)}:${strength}:${radius.toFixed(1)}`;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

export function createEntity(
  type: EntityType,
  x: number,
  y: number,
  strength = ENTITY_STRENGTHS[type][1] ?? ENTITY_STRENGTHS[type][0],
  options: {
    id?: string;
    radius?: number;
    locked?: boolean;
    note?: string;
    layer?: MapLayer;
    shape?: Array<{ x: number; y: number }>;
    angle?: number;
    inversionMode?: InversionMode;
    /** Level domain width in km; used for the default pressure radius. */
    domainScale?: number;
  } = {},
): WeatherEntity {
  entityCounter += 1;
  const radius = options.radius ?? defaultEntityRadius(type, options.domainScale);
  return {
    id: options.id ?? `${type}-${Date.now().toString(36)}-${entityCounter}`,
    seed: stableSeed(type, x, y, strength, radius),
    type,
    depth: DEPTH_BY_TYPE[type],
    layer: options.layer ?? DEFAULT_LAYER_BY_TYPE[type],
    x,
    y,
    strength,
    maxStrength: strength,
    radius,
    angle:
      type === 'jet' ? (options.angle ?? JET_DEFAULT_ANGLE) : options.angle,
    inversionMode: type === 'inversion' ? (options.inversionMode ?? 'unstable') : options.inversionMode,
    locked: options.locked,
    note: options.note,
    shape: options.shape ? options.shape.map((point) => ({ ...point })) : undefined,
  };
}

export function cloneEntity(entity: WeatherEntity): WeatherEntity {
  return {
    ...entity,
    shape: entity.shape ? entity.shape.map((point) => ({ ...point })) : undefined,
  };
}

/**
 * Change the influence radius while keeping the edited outline proportional.
 * The pressure extreme at the centre is untouched, so a larger radius only
 * spreads the same gradient over a wider area.
 */
export function resizeEntity(
  entity: WeatherEntity,
  radius: number,
  minRadius = MIN_ENTITY_RADIUS,
): boolean {
  if (!Number.isFinite(radius)) return false;
  const next = Math.max(minRadius, Math.min(MAX_ENTITY_RADIUS, radius));
  if (Math.abs(next - entity.radius) < 0.01) return false;
  const factor = next / Math.max(1, entity.radius);
  if (entity.shape) {
    entity.shape = entity.shape.map((point) => ({
      x: point.x * factor,
      y: point.y * factor,
    }));
  }
  entity.radius = next;
  return true;
}

/**
 * Merge systems of the same type that sit almost on top of each other.
 *
 * Two lows at the same point are not a 40 hPa low; they are one larger low.
 * Only pairs sitting within 8 % of the smaller radius merge -- essentially the
 * same point -- so ordinary neighbours still superpose as before.  Strength keeps the deeper centre plus
 * half of the second, and the footprint grows by area.
 */
export function mergeSameType(entities: WeatherEntity[]): WeatherEntity[] {
  const merged: WeatherEntity[] = [];
  for (const entity of entities) {
    if (entity.type === 'typhoon') {
      merged.push(entity);
      continue;
    }
    const mate = merged.find(
      (other) =>
        other.type === entity.type &&
        Math.hypot(other.x - entity.x, other.y - entity.y) <
          0.08 * Math.min(other.radius, entity.radius),
    );
    if (!mate) {
      merged.push(entity);
      continue;
    }
    const high = Math.max(mate.strength, entity.strength);
    const low = Math.min(mate.strength, entity.strength);
    mate.strength = high + 0.5 * low;
    mate.radius = Math.min(MAX_ENTITY_RADIUS, Math.hypot(mate.radius, entity.radius));
    mate.x = (mate.x + entity.x) / 2;
    mate.y = (mate.y + entity.y) / 2;
  }
  return merged;
}

export function cloneEntities(entities: WeatherEntity[]): WeatherEntity[] {
  return entities.map(cloneEntity);
}

export function clampPosition(x: number, y: number, margin = 30): { x: number; y: number } {
  return {
    x: Math.max(margin, Math.min(MAP_SIZE - margin, x)),
    y: Math.max(margin, Math.min(MAP_SIZE - margin, y)),
  };
}

export function entityAt(
  entities: WeatherEntity[],
  x: number,
  y: number,
  hitRadius = 28,
  layer?: MapLayer,
): WeatherEntity | null {
  let best: WeatherEntity | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const entity of entities) {
    if (layer && entity.layer !== layer) continue;
    const distance = Math.hypot(entity.x - x, entity.y - y);
    if (distance <= hitRadius && distance < bestDistance) {
      best = entity;
      bestDistance = distance;
    }
  }

  return best;
}

export function isUpperType(type: EntityType): boolean {
  return type === 'trough' || type === 'ridge' || type === 'inversion' || type === 'jet';
}

export function isGroundType(type: EntityType): boolean {
  return !isUpperType(type);
}

export function entityLayerForCard(card: CardType, level: LevelDefinition): MapLayer {
  if (!level.layers || level.layers.length <= 1) return 'low';
  if (card === 'trough' || card === 'jet') return 'high';
  if (card === 'inversion') return level.layers.includes('mid') ? 'mid' : 'high';
  return 'low';
}

export function cardEntityType(
  card: CardType,
  variants: Partial<Record<CardType, EntityType>> = {},
): EntityType {
  const variant = variants[card];
  if (variant && CARD_VARIANTS[card]?.includes(variant)) return variant;
  const fallback = DEFAULT_VARIANT[card];
  if (fallback) return fallback;
  return CARD_ENTITY_TYPE[card as Exclude<CardType, 'H' | 'L'>];
}

export function entityStrengthLabel(entity: WeatherEntity): string {
  switch (entity.type) {
    case 'coldHigh':
    case 'warmHigh':
      return `+${entity.strength} hPa`;
    case 'coldLow':
    case 'warmLow':
      return `−${entity.strength} hPa`;
    case 'typhoon':
      return `−${entity.strength} hPa · ${typhoonCategoryLabel(entity.strength)}`;
    case 'coldAir':
      return `−${entity.strength}°C`;
    case 'warmAir':
      return `+${entity.strength}°C`;
    case 'wet':
      return `+${entity.strength} g/m³`;
    case 'trough':
      return `${['', '弱', '中', '强'][entity.strength] ?? entity.strength}槽`;
    case 'ridge':
      return `${['', '弱', '中', '强'][entity.strength] ?? entity.strength}脊`;
    case 'inversion':
      return INVERSION_LABEL[entity.inversionMode ?? 'unstable'];
    case 'jet':
      return `${['', '弱', '中', '强'][entity.strength] ?? entity.strength}急流`;
  }
}

export function entityShortName(entity: WeatherEntity): string {
  return ENTITY_META[entity.type].name;
}

export function formatEntityStrength(type: EntityType, strength: number): string {
  const meta = ENTITY_META[type];
  switch (type) {
    case 'coldHigh':
    case 'warmHigh':
      return `+${strength} ${meta.unit}`;
    case 'coldLow':
    case 'warmLow':
      return `−${strength} ${meta.unit}`;
    case 'typhoon':
      return `−${strength} ${meta.unit} · ${typhoonCategoryLabel(strength)}`;
    case 'coldAir':
      return `−${strength}${meta.unit}`;
    case 'warmAir':
      return `+${strength}${meta.unit}`;
    case 'wet':
      return `+${strength} ${meta.unit}`;
    case 'trough':
    case 'ridge':
    case 'jet':
      return ['', '弱', '中', '强'][strength] ?? String(strength);
    case 'inversion':
      return strength === 2 ? '上暖下冷' : '上冷下暖';
  }
}

export function formatCardStrength(card: CardType, strength: number): string {
  switch (card) {
    case 'H':
      return `+${strength}`;
    case 'L':
      return `−${strength}`;
    case 'air':
      return `${strength < 0 ? '−' : '+'}${Math.abs(strength)}°C`;
    case 'moisture':
      return `+${strength}`;
    case 'trough':
    case 'ridge':
    case 'jet':
      return ['', '弱', '中', '强'][strength] ?? String(strength);
    case 'inversion':
      return strength === 2 ? '上暖下冷' : '上冷下暖';
  }
}

