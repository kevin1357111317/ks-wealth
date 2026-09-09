import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHealthInsights, buildHealthModel } from '../health-core.js';

const reports = [
  { id: 'older', owner_scope: 'wife', checkup_year: 2024 },
  { id: 'latest', owner_scope: 'wife', checkup_year: 2025 },
];
const metrics = [
  { checkup_id: 'older', metric_key: 'mcv', value_numeric: 88, status: 'normal' },
  { checkup_id: 'latest', metric_key: 'mcv', value_numeric: 70, status: 'low' },
  { checkup_id: 'latest', metric_key: 'hemoglobin', value_numeric: 11, status: 'low' },
  { checkup_id: 'latest', metric_key: 'rbc', value_numeric: 6, status: 'high' },
];

test('health history is grouped by owner and ordered for trends', () => {
  const model = buildHealthModel(reports, metrics, 'wife');
  assert.equal(model.latest.checkup_year, 2025);
  assert.deepEqual(model.series('mcv').map(point => point.year), [2024, 2025]);
  assert.equal(buildHealthModel(reports, metrics, 'husband').latest, null);
});

test('abnormal red-cell pattern creates a preconception follow-up, not a diagnosis', () => {
  const insights = buildHealthInsights(buildHealthModel(reports, metrics, 'wife'), 'wife');
  assert.match(insights[0].title, /釐清/);
  assert.match(insights[0].body, /可能/);
  assert.match(insights[0].action, /未證實缺鐵前不要自行/);
});

