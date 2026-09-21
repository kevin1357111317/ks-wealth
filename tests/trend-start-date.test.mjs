import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { filterTrendRowsFrom } from '../trend-core.js';

test('trend start filter keeps September 1 and later rows', () => {
  const rows = [
    { recorded_on: '2026-08-31', total_twd: 1 },
    { recorded_on: '2026-09-01', total_twd: 2 },
    { recorded_on: '2026-09-02', total_twd: 3 },
  ];

  assert.deepEqual(filterTrendRowsFrom(rows, '2026-09-01'), rows.slice(1));
  assert.deepEqual(filterTrendRowsFrom(rows), rows);
});

test('family and wife trends start on September 1 while husband keeps full history', async () => {
  const source = await readFile(new URL('../app-v3.js', import.meta.url), 'utf8');

  assert.match(source, /NET_WORTH_TREND_START = Object\.freeze\(\{\s*family: '2026-09-01',\s*wife: '2026-09-01',\s*\}\)/);
  assert.match(source, /filterTrendRowsFrom\(rows, NET_WORTH_TREND_START\.family\)/);
  assert.match(source, /filterTrendRowsFrom\(rows, NET_WORTH_TREND_START\[ownerScope\]\)/);
  assert.doesNotMatch(source, /husband: '2026-09-01'/);
});
