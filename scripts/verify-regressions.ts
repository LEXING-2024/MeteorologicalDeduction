import assert from 'node:assert/strict';
import { createEntity } from '../src/logic/entities';
import { LEVELS } from '../src/config/levels';
import {
  buildPointWeather,
  compassLabelFromToward,
  frontAt,
  windAt,
} from '../src/logic/field';
import { precipitationRate } from '../src/logic/precipitation';
import { buildPressureGrid, tracePressureAxis } from '../src/logic/pressure';
import { buildFrontVisuals } from '../src/render/fronts';
import type { BaseConditions } from '../src/logic/types';

const base: BaseConditions = { P: 1012, T: 22, Q: 7.4, latitude: 30, hemisphere: 'N' };

// Compass conversion: internal 0° is east, not north.
assert.equal(compassLabelFromToward(0), '东');
assert.equal(compassLabelFromToward(90), '南');
assert.equal(compassLabelFromToward(180), '西');
assert.equal(compassLabelFromToward(270), '北');

// The cosmetic shape must not depend on the generated entity id.
{
  const first = [createEntity('coldLow', 300, 300, 20, { id: 'first-id' })];
  const second = [createEntity('coldLow', 300, 300, 20, { id: 'second-id' })];
  const a = buildPointWeather(first, base, 420, 340);
  const b = buildPointWeather(second, base, 420, 340);
  assert.ok(Math.abs(a.P - b.P) < 1e-9, 'pressure depends on entity id');
  assert.ok(Math.abs(a.wind.x - b.wind.x) < 1e-9, 'wind depends on entity id');
  assert.ok(Math.abs(a.shear - b.shear) < 1e-9, 'shear depends on entity id');
}

// Terrain must perturb the pressure field (the old path computed and discarded it).
{
  const flat = base;
  const terrain = { ...base, hasTerrain: true, timeOfDay: 'day' as const };
  const a = buildPointWeather([], flat, 300, 300);
  const b = buildPointWeather([], terrain, 300, 300);
  assert.ok(Math.abs(a.P - b.P) > 0.5, 'terrain pressure perturbation is missing');
}

// One continuous ridge axis per pressure centre.
{
  const high = createEntity('warmHigh', 400, 400, 20, { id: 'ridge-high' });
  const grid = buildPressureGrid([high], base, 256);
  const axis = tracePressureAxis(grid, high, base.P);
  assert.ok(axis, 'expected a ridge axis for an elongated high');
  assert.equal(axis?.kind, 'ridge');
  assert.ok((axis?.points.length ?? 0) >= 6, 'ridge axis is too short');
}

// Cold-air supersaturation must not rain out 14x its saturation value.
{
  const rate = precipitationRate(-14, 26, 14);
  assert.ok(rate < 5, `supersaturated cold rain is too large: ${rate}`);
}

/*
 * A front on the chart must be the front the station reports.
 *
 * The renderer used to classify pairs by the raw cold/warm strength gap while
 * the station and the goal used frontAt() (wind advection + density current).
 * Two layouts where the two rules disagree are pinned here: equal air masses
 * under a strong pressure gradient, and a cold-dominant pair under a reversed
 * gradient.  If the renderer ever grows a second classification again, this
 * fails.
 */
{
  const at = { x: 286, y: 322 };
  const layouts: Array<{ label: string; entities: ReturnType<typeof createEntity>[] }> = [
    {
      label: '等强度冷/暖 5°C',
      entities: [
        createEntity('coldAir', at.x - 90, at.y, 5, { id: 'c1' }),
        createEntity('warmAir', at.x + 90, at.y, 5, { id: 'w1' }),
      ],
    },
    {
      label: '等强度 + 20 hPa H/L 对',
      entities: [
        createEntity('coldAir', at.x - 90, at.y, 5, { id: 'c2' }),
        createEntity('warmAir', at.x + 90, at.y, 5, { id: 'w2' }),
        createEntity('coldHigh', at.x - 260, at.y, 20, { id: 'h2' }),
        createEntity('coldLow', at.x + 260, at.y, 20, { id: 'l2' }),
      ],
    },
    {
      label: '冷 10 / 暖 5 + 反相 H/L 对',
      entities: [
        createEntity('coldAir', at.x - 90, at.y, 10, { id: 'c3' }),
        createEntity('warmAir', at.x + 90, at.y, 5, { id: 'w3' }),
        createEntity('coldHigh', at.x + 260, at.y, 20, { id: 'h3' }),
        createEntity('coldLow', at.x - 260, at.y, 20, { id: 'l3' }),
      ],
    },
  ];

  for (const layout of layouts) {
    const station = buildPointWeather(layout.entities, base, at.x, at.y);
    const visuals = buildFrontVisuals(layout.entities, (x, y) => {
      const diagnosis = frontAt(layout.entities, base, x, y, windAt(layout.entities, base, x, y));
      return diagnosis.type === 'none' ? null : diagnosis.type;
    });
    assert.ok(visuals.length > 0, `${layout.label}: no front drawn`);
    for (const visual of visuals) {
      assert.equal(
        visual.type,
        station.frontType,
        `${layout.label}: chart shows ${visual.type}, station reports ${station.frontType}`,
      );
    }
  }
}

/*
 * The air / moisture split.
 *
 * v4.2 retired the unified air card: temperature and moisture are two cards
 * with independent drop points.  The eight levels that used to gate the old
 * knobs are translated into card availability at load time, so these
 * assertions pin the translation and make sure no level still carries the
 * legacy gate (a half-migrated level would offer neither card).
 */
{
  for (const level of LEVELS) {
    assert.ok(
      level.allowedCards.includes(level.focusCard),
      `level ${level.index} focuses a card it does not allow`,
    );
  }
  const getLevel = (n: number) => LEVELS[n - 1];
  assert.ok(
    getLevel(2).allowedCards.includes('L') && !getLevel(2).allowedCards.includes('air'),
    'level 2 teaches wind-driven moisture from a fixed surface source',
  );
  assert.equal(getLevel(2).focusCard, 'L');
  assert.ok(
    getLevel(6).allowedCards.includes('air') && !getLevel(6).allowedCards.includes('moisture'),
    'level 6 introduces the temperature card only',
  );
  assert.ok(
    getLevel(6).allowedCards.includes('air') && !getLevel(6).allowedCards.includes('moisture'),
    'level 6 must not offer the moisture card',
  );
  assert.ok(
    getLevel(8).allowedCards.includes('air') && !getLevel(8).allowedCards.includes('moisture'),
    'level 8 uses a fixed moisture source and teaches front dynamics',
  );
  const windowLevel = getLevel(23);
  assert.equal(windowLevel.target.kind, 'window', 'level 23 uses the new round-window target');
  if (windowLevel.target.kind === 'window') {
    assert.equal(windowLevel.target.fromRound, 1);
    assert.equal(windowLevel.target.toRound, 2);
    assert.equal(windowLevel.target.mode, 'all');
  }
  for (const index of [14, 21, 23]) {
    assert.ok(
      !getLevel(index).allowedCards.includes('moisture'),
      `level ${index} runs on locked surface sources, so the moisture card stays out`,
    );
  }
  for (const index of [27, 31, 48]) {
    const level = getLevel(index);
    assert.ok(
      level.allowedCards.includes('air') && level.allowedCards.includes('moisture'),
      `level ${index} should offer both the air and the moisture card`,
    );
  }
}

console.log('regression checks passed');
