import assert from 'node:assert/strict';
import { CAMPAIGN_STAGES, LEVELS } from '../src/config/levels';
import { kmPerPixel } from '../src/config/scale';
import { createEntity } from '../src/logic/entities';
import { computePhysicalSnapshot, vorticityFromGrid } from '../src/logic/field';
import { evaluateGoal } from '../src/logic/goal';
import { buildReport } from '../src/logic/report';
import { computeSnapshot } from '../src/logic/weather';
import type { BaseConditions, City } from '../src/logic/types';

const base: BaseConditions = {
  P: 1012,
  T: 22,
  Q: 7.4,
  latitude: 35,
  hemisphere: 'N',
};

// Regression: SWE stations used to hardcode vorticity:0, making rotation goals
// unsatisfiable on that engine and disagreeing with the rendered wind field.
{
  const sweBase: BaseConditions = { ...base, physics: 'swe' };
  const entities = [createEntity('coldLow', 400, 400, 20, { id: 'fix-low' })];
  const cities: City[] = [
    { id: 'A', name: 'A 城', nameEn: 'A', x: 470, y: 400 },
  ];
  const snapshot = computePhysicalSnapshot(entities, sweBase, cities);
  const expected = vorticityFromGrid(
    snapshot.grid,
    cities[0].x,
    cities[0].y,
    kmPerPixel(sweBase),
  );
  assert.ok(expected > 0, 'test board should produce measurable rotation');
  assert.equal(
    snapshot.cities.A.vorticity,
    expected,
    'SWE station vorticity must be sampled from the same grid the map draws',
  );
}

// Regression: the report used to print ">= 40" while the physics and level
// targets use 4-6 (a 10x mismatch that teaches a threshold the game never uses).
{
  const rotationLevel = LEVELS.find((level) => {
    const target = level.target as { conditions?: { kind: string }[] };
    return target.conditions?.some((condition) => condition.kind === 'rotation');
  });
  assert.ok(rotationLevel, 'expected at least one rotation level');
  const target = rotationLevel.target as {
    conditions?: { kind: string; minVorticity?: number }[];
  };
  const expectedThreshold = target.conditions?.find((c) => c.kind === 'rotation')?.minVorticity ?? 4;

  const before = computeSnapshot(
    rotationLevel.initialEntities,
    rotationLevel.base,
    rotationLevel.cities,
    'preview',
  );
  const after = computeSnapshot(
    rotationLevel.initialEntities,
    rotationLevel.base,
    rotationLevel.cities,
    'full',
  );
  const evaluation = evaluateGoal(rotationLevel, after);
  const report = buildReport(rotationLevel, { before, after, motions: [] }, evaluation);
  const entry = report.stages.flatMap((stage) => stage.entries).find((item) => item.label === '中层与旋转');
  assert.ok(entry, 'missing rotation diagnostic in report');
  assert.ok(
    entry.text.includes(`≥${expectedThreshold}`),
    `expected rotation threshold ≥${expectedThreshold}, got: ${entry.text}`,
  );
  assert.ok(!entry.text.includes('≥40'), 'stale 40x mesocyclone threshold reappeared');
}

// Regression: stage metadata must describe the real 72-level campaign.
{
  const stage6 = CAMPAIGN_STAGES.find((stage) => stage.stage === 6);
  assert.ok(stage6, 'missing stage 6');
  assert.equal(stage6.first, 51);
  assert.equal(stage6.last, LEVELS.length, 'stage 6 must cover through the last level');
}

console.log('consistency fixes verified');
