import {
  CARD_HOTKEYS,
  CARD_META,
  CARD_STRENGTHS,
  CARD_UNLOCK,
  CARD_VARIANTS,
  ENTITY_META,
} from '../config/constants';
import type { CardType, EntityType, LevelDefinition } from '../logic/types';

interface DeckCallbacks {
  onSelect: (type: CardType) => void;
  onStrength: (type: CardType, strength: number) => void;
  onVariant: (type: CardType, entityType: EntityType) => void;
  onDragStart: (type: CardType) => void;
  onDragEnd: () => void;
  onLocked: (type: CardType) => void;
}

const GROUND_CARDS: CardType[] = ['H', 'L', 'air', 'moisture'];
const UPPER_CARDS: CardType[] = ['trough', 'ridge', 'inversion', 'jet'];

function strengthLabel(type: CardType, strength: number): string {
  switch (type) {
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

function hotkeyFor(type: CardType): string {
  const entry = Object.entries(CARD_HOTKEYS).find(([, value]) => value === type);
  return entry ? entry[0] : '';
}

function cardIcon(type: CardType, variant?: EntityType): string {
  const meta = CARD_META[type];
  const glyph = variant ? ENTITY_META[variant].glyph : meta.glyph;
  const arrow = type === 'H' || type === 'L' ? '<i class="symbol-arrow"></i>' : '';
  return `<span class="weather-symbol ${type}"><span>${glyph}</span>${arrow}</span>`;
}

export class Deck {
  private container: HTMLElement;
  private callbacks: DeckCallbacks;
  private level: LevelDefinition | null = null;
  private activeType: CardType | null = null;
  private strengths: Record<CardType, number> = {
    H: 10,
    L: 10,
    air: -10,
    moisture: 40,
    trough: 2,
    ridge: 2,
    inversion: 1,
    jet: 2,
  };
  private variants: Partial<Record<CardType, EntityType>> = {
    H: 'warmHigh',
    L: 'coldLow',
  };
  private strengthTiers: Partial<Record<CardType, number[]>> = {};
  private running = false;

  constructor(container: HTMLElement, callbacks: DeckCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.container.addEventListener('click', this.handleClick);
    this.container.addEventListener('keydown', this.handleKeyDown);
    this.container.addEventListener('dragstart', this.handleDragStart);
    this.container.addEventListener('dragend', this.handleDragEnd);
    this.container.addEventListener('input', this.handleStrengthInput);
    this.container.addEventListener('change', this.handleStrengthChange);
  }

  setStrengths(strengths: Record<CardType, number>): void {
    this.strengths = { ...strengths };
    this.refreshChips();
  }

  setStrengthTiers(tiers: Partial<Record<CardType, number[]>>): void {
    this.strengthTiers = { ...tiers };
  }

  setVariants(variants: Partial<Record<CardType, EntityType>>): void {
    this.variants = { ...this.variants, ...variants };
    this.refreshVariantButtons();
  }

  getVariant(card: CardType): EntityType | undefined {
    return this.variants[card];
  }

  setActive(type: CardType | null): void {
    this.activeType = type;
    for (const card of this.container.querySelectorAll<HTMLElement>('.weather-card')) {
      const cardType = card.dataset.type as CardType | undefined;
      const isActive = Boolean(cardType && cardType === type);
      card.classList.toggle('active', isActive);
      card.setAttribute('aria-pressed', String(isActive));
    }
  }

  setRunning(running: boolean): void {
    this.running = running;
    for (const card of this.container.querySelectorAll<HTMLElement>('.weather-card')) {
      const locked = card.classList.contains('locked');
      card.setAttribute('draggable', !locked && !running ? 'true' : 'false');
    }
    for (const chip of this.container.querySelectorAll<HTMLButtonElement>('.variant-chip')) {
      const card = chip.closest<HTMLElement>('.weather-card');
      chip.disabled = running || Boolean(card?.classList.contains('locked'));
    }
  }

  render(level: LevelDefinition): void {
    this.level = level;
    this.refresh();
  }

  private refresh(): void {
    if (!this.level) return;
    this.container.scrollTop = 0;
    this.container.innerHTML = `
      ${this.groupMarkup('地面系统', 'P / T / Q / W', GROUND_CARDS)}
      ${this.groupMarkup('高空环境', '槽 · 层结 · 急流', UPPER_CARDS)}
    `;
    this.refreshChips();
    this.refreshVariantButtons();
  }

  private groupMarkup(title: string, subtitle: string, cards: CardType[]): string {
    return `
      <div class="deck-group">
        <div class="deck-group-head">
          <strong>${title}</strong>
          <span>${subtitle}</span>
        </div>
        ${cards.map((card) => this.cardMarkup(card)).join('')}
      </div>
    `;
  }

  private cardMarkup(type: CardType): string {
    const level = this.level;
    if (!level) return '';
    const meta = CARD_META[type];
    const unlocked = level.allowedCards.includes(type);
    const active = this.activeType === type && unlocked;
    const strengths = this.strengthTiers[type] ?? CARD_STRENGTHS[type];
    const activeStrength = this.strengths[type];
    const unlockLevel = CARD_UNLOCK[type];
    const isNew = type === level.focusCard && unlockLevel === level.index;
    const hasSurfaceSource = level.initialEntities.some((entity) => entity.type === 'wet');
    const sourceReplaced = hasSurfaceSource && type === 'moisture' && !unlocked;
    const lockText = sourceReplaced
      ? '本关水汽由地图地表源供水'
      : level.index >= unlockLevel
        ? '本关不可用'
        : `第 ${unlockLevel} 关解锁`;
    const variant = this.variants[type];
    const variantMeta = variant ? ENTITY_META[variant] : undefined;
    const selectedEntity = variant ?? '';
    const effect = variantMeta?.effect ?? meta.effect;
    const disabled = !unlocked || this.running;

    // One continuous slider instead of three discrete chips: the card keeps the
    // authored physical range, but the player is no longer forced onto 5/10/20.
    const min = strengths[0];
    const max = strengths[strengths.length - 1];
    const step = strengths.length > 1 ? Math.max(1, Math.min(...strengths.slice(1).map((v, i) => v - strengths[i]))) : 1;
    const slider = `<input class="strength-slider" type="range" min="${min}" max="${max}" step="${step}" value="${activeStrength}" data-card="${type}" aria-label="${meta.name}强度" ${disabled ? 'disabled' : ''}>`;

    const variantChoices = CARD_VARIANTS[type]
      ?.map((entityType) => {
        const entity = ENTITY_META[entityType];
        return `<button class="variant-chip${variant === entityType ? ' active' : ''}" type="button" data-card="${type}" data-variant="${entityType}" ${disabled ? 'disabled' : ''}><b>${entity.name}</b><small>${entity.depthLabel}</small></button>`;
      })
      .join('');

    const lockMarkup = `<span class="card-lock-note lock-glyph"><svg viewBox="0 0 10 10" aria-hidden="true"><rect x="1.6" y="4.3" width="6.8" height="4.8" rx="1"/><path d="M3.1 4.3V3.2a1.9 1.9 0 0 1 3.8 0v1.1"/></svg>${lockText}</span>`;

    return `
      <article
        class="weather-card card-${type}${active ? ' active' : ''}${unlocked ? '' : ' locked'}${isNew ? ' focus' : ''}"
        data-type="${type}"
        data-entity="${selectedEntity}"
        style="--card-accent: ${variantMeta?.cssColor ?? meta.cssColor}"
        draggable="${!disabled ? 'true' : 'false'}"
        role="button"
        tabindex="0"
        aria-pressed="${active ? 'true' : 'false'}"
        aria-disabled="${unlocked ? 'false' : 'true'}"
        title="${unlocked ? `${meta.name}：${effect}` : lockText}"
      >
        <div class="card-topline">
          <span class="card-hotkey">${hotkeyFor(type) ? `快捷键 ${hotkeyFor(type)}` : '高空环境'}</span>
          ${variantMeta ? `<span class="card-depth">${variantMeta.depthLabel}</span>` : ''}
        </div>
        ${cardIcon(type, variant)}
        <div class="card-copy">
          <div class="card-title-row">
            <h3>${meta.name}</h3>
            <span>${meta.unit}</span>
          </div>
          <p class="card-effect">${effect}</p>
          ${variantChoices ? `<div class="variant-row">${variantChoices}</div>` : ''}
        </div>
        <div class="strength-row">
          ${unlocked ? slider : ''}
          ${unlocked ? `<output class="strength-readout" data-card="${type}">${strengthLabel(type, activeStrength)}</output>` : lockMarkup}
        </div>
      </article>
    `;
  }

  private refreshChips(): void {
    for (const slider of this.container.querySelectorAll<HTMLInputElement>('.strength-slider')) {
      const card = slider.dataset.card as CardType | undefined;
      if (!card) continue;
      slider.value = String(this.strengths[card]);
      const readout = this.container.querySelector<HTMLElement>(`.strength-readout[data-card="${card}"]`);
      if (readout) readout.textContent = strengthLabel(card, this.strengths[card]);
    }
    for (const card of this.container.querySelectorAll<HTMLElement>('.weather-card')) {
      const type = card.dataset.type as CardType | undefined;
      if (type) card.classList.toggle('active', type === this.activeType);
    }
  }

  private refreshVariantButtons(): void {
    for (const chip of this.container.querySelectorAll<HTMLButtonElement>('.variant-chip')) {
      const card = chip.dataset.card as CardType | undefined;
      const variant = chip.dataset.variant as EntityType | undefined;
      if (!card || !variant) continue;
      chip.classList.toggle('active', this.variants[card] === variant);
      const article = chip.closest<HTMLElement>('.weather-card');
      if (article) {
        const selected = this.variants[card] ?? variant;
        const entity = ENTITY_META[selected];
        article.dataset.entity = selected;
        if (entity) {
          article.style.setProperty('--card-accent', entity.cssColor);
          const copy = article.querySelector<HTMLElement>('.card-effect');
          if (copy) copy.textContent = entity.effect;
          const depth = article.querySelector<HTMLElement>('.card-depth');
          if (depth) depth.textContent = entity.depthLabel;
        }
      }
    }
  }

  /**
   * Cards are focusable buttons, not just draggable articles: the game has to
   * be playable without a pointer.  Enter/Space selects the focused card; the
   * chips inside keep their own native button behaviour.
   */
  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target as HTMLElement;
    if (target.closest('button')) return;
    const card = target.closest<HTMLElement>('.weather-card');
    if (!card) return;
    const type = card.dataset.type as CardType | undefined;
    if (!type) return;
    event.preventDefault();
    if (card.classList.contains('locked')) {
      this.callbacks.onLocked(type);
      return;
    }
    if (this.running) return;
    this.callbacks.onSelect(type);
  };

  private handleClick = (event: Event): void => {
    const target = event.target as HTMLElement;
    const card = target.closest<HTMLElement>('.weather-card');
    if (!card) return;
    const type = card.dataset.type as CardType | undefined;
    if (!type) return;
    if (card.classList.contains('locked')) {
      this.callbacks.onLocked(type);
      return;
    }
    if (this.running) return;

    if (target.closest('.strength-slider')) return;

    const variant = target.closest<HTMLButtonElement>('.variant-chip');
    if (variant) {
      const entityType = variant.dataset.variant as EntityType | undefined;
      if (entityType) {
        this.variants[type] = entityType;
        this.refreshVariantButtons();
        this.callbacks.onVariant(type, entityType);
      }
      return;
    }

    this.callbacks.onSelect(type);
  };

  /** Live readout while dragging; the field itself only rebuilds on release. */
  private handleStrengthInput = (event: Event): void => {
    const input = event.target as HTMLInputElement;
    if (!input.classList.contains('strength-slider')) return;
    const card = input.dataset.card as CardType | undefined;
    if (!card) return;
    const readout = this.container.querySelector<HTMLElement>(`.strength-readout[data-card="${card}"]`);
    if (readout) readout.textContent = strengthLabel(card, Number(input.value));
  };

  private handleStrengthChange = (event: Event): void => {
    const input = event.target as HTMLInputElement;
    if (!input.classList.contains('strength-slider')) return;
    const card = input.dataset.card as CardType | undefined;
    if (!card || this.running) return;
    const strength = Number(input.value);
    if (Number.isFinite(strength)) this.callbacks.onStrength(card, strength);
  };

  private handleDragStart = (event: DragEvent): void => {
    const target = event.target as HTMLElement;
    const card = target.closest<HTMLElement>('.weather-card');
    if (!card) return;
    const type = card.dataset.type as CardType | undefined;
    if (!type || card.classList.contains('locked') || this.running) {
      event.preventDefault();
      return;
    }
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('text/plain', type);
    }
    this.callbacks.onDragStart(type);
  };

  private handleDragEnd = (): void => {
    this.callbacks.onDragEnd();
  };
}
